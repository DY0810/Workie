import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';
import { z } from 'zod';
import { rewritePdfLines } from './pdf-lines.ts';

const MAX_BYTES = 10 * 1024 * 1024;
const PYTHON = resolve(dirname(fileURLToPath(import.meta.url)), 'transform.py');
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.uuid();
const format = z.enum(['pdf', 'docx']);
const anchor = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,80}$/), text: z.string().min(1).max(2000),
  kind: z.enum(['line', 'paragraph']), maxChars: z.number().int().positive().max(2000),
});
const inspection = z.strictObject({
  format, text: z.string().max(100_000), anchors: z.array(anchor).max(256),
  links: z.array(z.string().max(2048)).max(128), fonts: z.array(z.string().max(256)).max(64),
  fontDetails: z.array(z.string().max(512)).max(64), pageGeometry: z.array(z.string().max(256)).max(100),
  pageCount: z.number().int().positive().max(100),
});
export const TemplateManifestSchema = z.strictObject({
  version: z.literal(1), role: z.string().trim().min(1).max(100), format,
  sourceHash: hash, pageCount: z.number().int().positive().max(100),
  anchors: z.array(anchor).min(1).max(256), links: z.array(z.string().max(2048)).max(128),
  fonts: z.array(z.string().max(256)).max(64), fontDetails: z.array(z.string().max(512)).max(64),
  pageGeometry: z.array(z.string().max(256)).max(100), frozenTextHash: hash, textHash: hash,
});
export type TemplateManifest = z.infer<typeof TemplateManifestSchema>;
const STOPWORDS = new Set(['and', 'the', 'for', 'with', 'from', 'into', 'our', 'you', 'your', 'are', 'will', 'this', 'that', 'have', 'has', 'can', 'all', 'any', 'who', 'not', 'per', 'via']);
const words = (text: string) => new Set((text.toLowerCase().match(/[a-z][a-z0-9+#.]{2,}/g) ?? [])
  .map(word => word.replace(/\.+$/, '')).filter(word => !STOPWORDS.has(word)));
/**
 * The lines a posting's tailoring rewrites: of the resume's longest lines (its bullets), those sharing the most
 * words with the job description, so a backend role and an ML role rewrite different bullets. Ties keep the longer line.
 */
export function relevantAnchors<T extends { text: string; maxChars: number }>(anchors: readonly T[], jobDescription: string, count = 5, pool = 10) {
  const job = words(jobDescription), score = (anchor: T) => [...words(anchor.text)].filter(word => job.has(word)).length;
  return [...anchors].sort((a, b) => b.maxChars - a.maxChars).slice(0, pool)
    .map(anchor => ({ anchor, score: score(anchor) })).sort((a, b) => b.score - a.score || b.anchor.maxChars - a.anchor.maxChars)
    .slice(0, count).map(item => item.anchor);
}
export const TailorEvidenceSchema = z.strictObject({ id: uuid, confirmed: z.literal(true), excerpt: z.string().trim().min(1).max(1000) });
export const TailorEditSchema = z.strictObject({
  anchorId: z.string().regex(/^[a-z][a-z0-9-]{0,80}$/), replacement: z.string().trim().min(1).max(2000),
  evidenceIds: z.array(uuid).min(1).max(16),
});
export const TailorRequestSchema = z.strictObject({
  role: z.string().trim().min(1).max(100), masterHash: hash,
  evidence: z.array(TailorEvidenceSchema).max(256), edits: z.array(TailorEditSchema).min(1).max(64),
});
export type TailorRequest = z.infer<typeof TailorRequestSchema>;
export type TailoredArtifact = {
  bytes: Uint8Array; sha256: string; format: 'pdf' | 'docx'; manifest: TemplateManifest;
  checks: { pageCount: number; linksPreserved: boolean; frozenTextPreserved: boolean; anchorsFit: boolean };
};

export class DocumentRuntimeError extends Error {
  readonly code: string;
  constructor(code: string, message = code) { super(message); this.code = code; }
}

function digest(value: Uint8Array | string) {
  return createHash('sha256').update(value).digest('hex');
}

function normalized(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function formatForMime(mime: string) {
  if (mime === 'application/pdf') return 'pdf' as const;
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx' as const;
  throw new DocumentRuntimeError('UNSUPPORTED_DOCUMENT_FORMAT');
}

/** A redrawn line may add only an unembedded standard Times or Helvetica face; every original font stays. */
function sameFonts(result: readonly string[], original: readonly string[], redrawn: boolean) {
  if (!redrawn) return JSON.stringify(result) === JSON.stringify(original);
  const added = result.filter((line) => !original.includes(line));
  return original.every((line) => result.includes(line)) && result.length === original.length + added.length &&
    added.every((line) => /^(?:Times|Helvetica)-[A-Za-z]+ Type 1 WinAnsi no no no\b/.test(line));
}

function frozenTextHash(text: string, anchors: readonly z.infer<typeof anchor>[], replacements = new Map<string, string>()) {
  let result = text;
  for (const item of anchors) result = result.replace(replacements.get(item.id) ?? item.text, `[[${item.id}]]`);
  return digest(normalized(result));
}

async function privateTemp(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  await chmod(directory, 0o700);
  return directory;
}

async function python(request: Record<string, unknown>) {
  const executable = process.env.WORKIE_PYTHON?.trim() || 'python3';
  const payload = JSON.stringify(request);
  // A LaunchAgent's PATH stops at /usr/bin, and poppler (pdfinfo, pdftotext, pdffonts) lives in Homebrew's.
  const env = {
    NODE_ENV: 'production', PATH: [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(':'),
    PYTHONNOUSERSITE: '1', LC_ALL: 'C', LANG: 'C',
  } as NodeJS.ProcessEnv;
  return new Promise<Record<string, unknown>>((resolveResult, reject) => {
    const child = spawn(executable, [PYTHON], {
      cwd: dirname(PYTHON), stdio: ['pipe', 'pipe', 'pipe'] as const, env,
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new DocumentRuntimeError('DOCUMENT_TOOL_TIMEOUT')); }, 15_000);
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 64 * 1024) child.kill('SIGKILL'); else stdout.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { if (Buffer.concat(stderr).length < 16 * 1024) stderr.push(chunk); });
    child.once('error', (error) => { clearTimeout(timer); reject(new DocumentRuntimeError('DOCUMENT_TOOL_UNAVAILABLE', error.message)); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new DocumentRuntimeError('DOCUMENT_TRANSFORM_FAILED', Buffer.concat(stderr).toString('utf8').slice(0, 500))); return; }
      try { resolveResult(JSON.parse(Buffer.concat(stdout).toString('utf8'))); }
      catch { reject(new DocumentRuntimeError('DOCUMENT_TOOL_INVALID_OUTPUT')); }
    });
    child.stdin.end(payload);
  });
}

async function activePdfLinks(bytes: Uint8Array) {
  let document: PDFDocument;
  try {
    document = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    throw new DocumentRuntimeError('PDF_LINK_INSPECTION_FAILED', error instanceof Error ? error.message : 'invalid PDF');
  }
  const links: string[] = [];
  for (const page of document.getPages()) {
    const annotations = page.node.lookupMaybe(PDFName.Annots, PDFArray);
    if (!annotations) continue;
    for (let index = 0; index < annotations.size(); index += 1) {
      const annotation = annotations.lookupMaybe(index, PDFDict);
      if (!annotation || annotation.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() !== 'Link') continue;
      const action = annotation.lookupMaybe(PDFName.of('A'), PDFDict);
      if (!action || action.lookupMaybe(PDFName.of('S'), PDFName)?.decodeText() !== 'URI') continue;
      const uri = action.lookupMaybe(PDFName.of('URI'), PDFString, PDFHexString)?.decodeText();
      if (!uri || !(/^(?:https:\/\/|mailto:)/.test(uri)) || /[\u0000\r\n]/.test(uri)) {
        throw new DocumentRuntimeError('UNSAFE_PDF_LINK');
      }
      links.push(uri);
    }
  }
  return links;
}

async function inspectBytes(bytes: Uint8Array, fmt: 'pdf' | 'docx', directory: string) {
  const input = join(directory, `input.${fmt}`);
  await writeFile(input, bytes, { mode: 0o600, flag: 'wx' });
  const result = inspection.parse(await python({ operation: 'inspect', input, format: fmt }));
  return fmt === 'pdf' ? { ...result, links: await activePdfLinks(bytes) } : result;
}

export async function createTemplateManifest(bytesInput: Uint8Array, mime: string, role: string): Promise<TemplateManifest> {
  const bytes = Uint8Array.from(bytesInput);
  if (bytes.length < 1 || bytes.length > MAX_BYTES) throw new DocumentRuntimeError('DOCUMENT_SIZE_INVALID');
  const fmt = formatForMime(mime);
  const directory = await privateTemp('workie-document-inspect-');
  try {
    const result = await inspectBytes(bytes, fmt, directory);
    return TemplateManifestSchema.parse({
      version: 1, role: role.trim(), format: fmt, sourceHash: digest(bytes), pageCount: result.pageCount,
      anchors: result.anchors, links: result.links, fonts: result.fonts,
      fontDetails: result.fontDetails, pageGeometry: result.pageGeometry,
      frozenTextHash: frozenTextHash(result.text, result.anchors), textHash: digest(normalized(result.text)),
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function validateRequest(manifest: TemplateManifest, requestInput: unknown, sourceHash: string) {
  const request = TailorRequestSchema.parse(requestInput);
  if (request.masterHash !== sourceHash || request.masterHash !== manifest.sourceHash) {
    throw new DocumentRuntimeError('MASTER_HASH_MISMATCH');
  }
  if (request.role !== manifest.role) throw new DocumentRuntimeError('ROLE_MISMATCH');
  const evidence = new Set(request.evidence.filter((item) => item.confirmed).map((item) => item.id));
  const seen = new Set<string>();
  const byId = new Map(manifest.anchors.map((item) => [item.id, item]));
  const edits = request.edits.map((item) => {
    if (seen.has(item.anchorId)) throw new DocumentRuntimeError('DUPLICATE_EDIT');
    seen.add(item.anchorId);
    const target = byId.get(item.anchorId);
    if (!target) throw new DocumentRuntimeError('ANCHOR_NOT_FOUND');
    if (normalized(item.replacement) === normalized(target.text)) {
      throw new DocumentRuntimeError('NO_SUBSTANTIVE_EDIT');
    }
    if (item.replacement.length > target.maxChars || /[\r\n]/.test(item.replacement)) {
      throw new DocumentRuntimeError('EDIT_OVERFLOW');
    }
    if (item.evidenceIds.some((id) => !evidence.has(id))) throw new DocumentRuntimeError('UNCONFIRMED_EVIDENCE');
    return { anchorText: target.text, replacement: item.replacement, anchorId: target.id };
  });
  return { request, edits };
}

export async function tailorDocument(input: {
  bytes: Uint8Array; mime: string; manifest: TemplateManifest; request: unknown;
}): Promise<TailoredArtifact> {
  const bytes = Uint8Array.from(input.bytes);
  const manifest = TemplateManifestSchema.parse(input.manifest);
  const fmt = formatForMime(input.mime);
  if (fmt !== manifest.format) throw new DocumentRuntimeError('FORMAT_MISMATCH');
  const sourceHash = digest(bytes);
  const { edits } = validateRequest(manifest, input.request, sourceHash);
  const directory = await privateTemp('workie-document-tailor-');
  try {
    const source = join(directory, `master.${fmt}`), output = join(directory, `tailored.${fmt}`);
    await writeFile(source, bytes, { mode: 0o600, flag: 'wx' });
    let redrawn = false;
    try {
      await python({ operation: 'transform', input: source, output, format: fmt, edits });
    } catch (error) {
      // Most PDFs (LaTeX, Word, Google Docs) keep text as subset-font glyph ids that no byte edit can change.
      if (fmt !== 'pdf' || !(error instanceof DocumentRuntimeError) || error.code !== 'DOCUMENT_TRANSFORM_FAILED') throw error;
      const rewritten = await rewritePdfLines(bytes, edits).catch((cause: Error) => {
        throw new DocumentRuntimeError('DOCUMENT_TRANSFORM_FAILED', cause.message);
      });
      await writeFile(output, rewritten, { mode: 0o600 });
      redrawn = true;
    }
    const resultBytes = await readFile(output);
    if (resultBytes.length > MAX_BYTES) throw new DocumentRuntimeError('OUTPUT_TOO_LARGE');
    const result = await inspectBytes(resultBytes, fmt, directory);
    const outputFrozen = frozenTextHash(result.text, manifest.anchors, new Map(edits.map((edit) => [edit.anchorId, edit.replacement])));
    if (
      result.pageCount !== manifest.pageCount ||
      JSON.stringify(result.links) !== JSON.stringify(manifest.links) ||
      !sameFonts(result.fontDetails, manifest.fontDetails, redrawn) ||
      JSON.stringify(result.pageGeometry) !== JSON.stringify(manifest.pageGeometry) ||
      outputFrozen !== manifest.frozenTextHash
    ) {
      throw new DocumentRuntimeError('DOCUMENT_INVARIANT_FAILED');
    }
    for (const edit of edits) if (!normalized(result.text).includes(normalized(edit.replacement))) {
      throw new DocumentRuntimeError('EDIT_NOT_PRESENT');
    }
    const outputManifest = TemplateManifestSchema.parse({ ...manifest, textHash: digest(normalized(result.text)), frozenTextHash: outputFrozen });
    return { bytes: resultBytes, sha256: digest(resultBytes), format: fmt, manifest: outputManifest,
      checks: { pageCount: result.pageCount, linksPreserved: true, frozenTextPreserved: true, anchorsFit: true } };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
