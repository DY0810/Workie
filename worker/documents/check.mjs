import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { createTemplateManifest, DocumentRuntimeError, relevantAnchors, tailorDocument } from './runtime.ts';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF = 'application/pdf';
const evidence = () => ({ id: crypto.randomUUID(), confirmed: true, excerpt: 'Confirmed synthetic evidence.' });

function syntheticDocx(doubleSpace = false) {
  return zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Build APIs</w:t></w:r></w:p><w:p><w:r><w:t>Proven ${doubleSpace ? ' ' : ''}</w:t></w:r><w:r><w:t>facts</w:t></w:r></w:p></w:body></w:document>`),
  });
}

function syntheticPdf() {
  const bodies = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R /Annots [6 0 R] >>\nendobj\n',
  ];
  const stream = 'BT /F1 12 Tf 50 700 Td (Build APIs) Tj 0 -20 Td (Proven facts) Tj ET';
  bodies.push(`4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
  bodies.push('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');
  bodies.push('6 0 obj\n<< /Type /Annot /Subtype /Link /Rect [50 700 150 720] /A << /S /URI /URI (https://example.test/job) >> >>\nendobj\n');
  let output = '%PDF-1.4\n';
  const offsets = [0];
  for (const body of bodies) { offsets.push(output.length); output += body; }
  const xref = output.length;
  output += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, '0')} 00000 n \n`;
  output += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, 'ascii');
}

test('DOCX manifest and tailoring preserve frozen text and bind edits to confirmed evidence', async () => {
  const bytes = syntheticDocx(), manifest = await createTemplateManifest(bytes, DOCX, 'software engineering');
  const item = evidence();
  const result = await tailorDocument({ bytes, mime: DOCX, manifest, request: {
    role: 'software engineering', masterHash: manifest.sourceHash, evidence: [item],
    edits: [{ anchorId: manifest.anchors[0].id, replacement: 'Build SDKs', evidenceIds: [item.id] }],
  } });
  assert.notDeepEqual(Buffer.from(result.bytes), Buffer.from(bytes));
  assert.equal(result.checks.frozenTextPreserved, true);
  assert.equal(result.manifest.sourceHash, manifest.sourceHash);
  assert.equal(result.manifest.textHash.length, 64);
});

test('DOCX verification accepts preserved extra spaces in a reviewed replacement', async () => {
  const bytes = syntheticDocx(true), manifest = await createTemplateManifest(bytes, DOCX, 'role');
  const item = evidence();
  const result = await tailorDocument({ bytes, mime: DOCX, manifest, request: {
    role: 'role', masterHash: manifest.sourceHash, evidence: [item],
    edits: [{ anchorId: manifest.anchors[1].id, replacement: 'Known  facts', evidenceIds: [item.id] }],
  } });
  assert.equal(result.checks.frozenTextPreserved, true);
});

test('DOCX edits reject missing evidence, overflow and stale masters before invoking the tool', async () => {
  const bytes = syntheticDocx(), manifest = await createTemplateManifest(bytes, DOCX, 'role');
  const item = evidence();
  const base = { role: 'role', masterHash: manifest.sourceHash, evidence: [item], edits: [{ anchorId: manifest.anchors[0].id, replacement: 'A'.repeat(100), evidenceIds: [item.id] }] };
  await assert.rejects(tailorDocument({ bytes, mime: DOCX, manifest, request: base }), /EDIT_OVERFLOW/);
  await assert.rejects(tailorDocument({ bytes, mime: DOCX, manifest, request: { ...base, masterHash: 'a'.repeat(64) } }), /MASTER_HASH_MISMATCH/);
  await assert.rejects(tailorDocument({ bytes, mime: DOCX, manifest, request: { ...base, edits: [{ ...base.edits[0], replacement: 'Build SDKs', evidenceIds: [crypto.randomUUID()] }] } }), /UNCONFIRMED_EVIDENCE/);
  await assert.rejects(tailorDocument({ bytes, mime: DOCX, manifest, request: { ...base, edits: [{ ...base.edits[0], replacement: 'Build APIs' }] } }), /NO_SUBSTANTIVE_EDIT/);
});

test('fixed PDF editing preserves the exact byte width, page count and active link targets', async () => {
  const bytes = syntheticPdf(), manifest = await createTemplateManifest(bytes, PDF, 'software engineering');
  const item = evidence();
  const result = await tailorDocument({ bytes, mime: PDF, manifest, request: {
    role: 'software engineering', masterHash: manifest.sourceHash, evidence: [item],
    edits: [{ anchorId: manifest.anchors.find((item) => item.text === 'Build APIs').id, replacement: 'Build SDKs', evidenceIds: [item.id] }],
  } });
  assert.equal(result.checks.pageCount, 1);
  assert.deepEqual(result.manifest.links, ['https://example.test/job']);
  assert.notDeepEqual(Buffer.from(result.bytes), Buffer.from(bytes));
});

test('fixed PDF editing rejects geometry-changing replacements', async () => {
  const bytes = syntheticPdf(), manifest = await createTemplateManifest(bytes, PDF, 'role');
  const item = evidence();
  await assert.rejects(tailorDocument({ bytes, mime: PDF, manifest, request: {
    role: 'role', masterHash: manifest.sourceHash, evidence: [item],
    edits: [{ anchorId: manifest.anchors[0].id, replacement: 'Longer replacement', evidenceIds: [item.id] }],
  } }), (error) => error instanceof DocumentRuntimeError && error.code === 'EDIT_OVERFLOW');
});

test('parallel attempts use separate scratch directories and do not cross-read outputs', async () => {
  const bytes = syntheticDocx(), manifest = await createTemplateManifest(bytes, DOCX, 'role');
  const item = evidence();
  const request = { role: 'role', masterHash: manifest.sourceHash, evidence: [item], edits: [{ anchorId: manifest.anchors[0].id, replacement: 'Build SDKs', evidenceIds: [item.id] }] };
  const results = await Promise.all([tailorDocument({ bytes, mime: DOCX, manifest, request }), tailorDocument({ bytes, mime: DOCX, manifest, request })]);
  assert.equal(results[0].sha256, results[1].sha256);
});

test('a LaTeX PDF with subset CID fonts gets its bullet line rewritten in place', async () => {
  // latex-resume.tex, compiled with xelatex: the text is glyph ids, so the byte-level edit cannot apply.
  const bytes = await readFile(new URL('./fixtures/latex-resume.pdf', import.meta.url));
  const manifest = await createTemplateManifest(bytes, PDF, 'Product Designer');
  assert.ok(!manifest.anchors.some((item) => item.text.includes('Jun 2025')), 'a title with a right-aligned date is not rewritable');
  const target = manifest.anchors.find((item) => item.text.startsWith('• Designed'));
  const item = { ...evidence(), excerpt: target.text };
  const replacement = '• Designed patient onboarding in Figma, cutting drop-off for 20,000 people at three clinics.';
  const tailored = await tailorDocument({ bytes, mime: PDF, manifest, request: {
    masterHash: createHash('sha256').update(bytes).digest('hex'), role: 'Product Designer', evidence: [item],
    edits: [{ anchorId: target.id, replacement, evidenceIds: [item.id] }],
  } });
  const text = execFileSync('pdftotext', ['-layout', '-', '-'], { input: tailored.bytes }).toString();
  assert.match(text, /• Designed patient onboarding in Figma, cutting drop-off/);
  assert.doesNotMatch(text, /Designed onboarding flows/);
  assert.match(text, /• Built a design system with 40 components/, 'other lines are untouched');
  assert.deepEqual(tailored.checks, { pageCount: 1, linksPreserved: true, frozenTextPreserved: true, anchorsFit: true });
});

test('a posting rewrites the resume bullets that match it, not always the longest five', () => {
  const line = (id, text) => ({ id, text, kind: 'line', maxChars: text.length });
  const anchors = [
    line('name', 'Dong Yeop Lee'),
    line('ml', 'Trained PyTorch models on GPU clusters and evaluated inference latency for an embeddings service'),
    line('api', 'Built REST APIs in FastAPI and PostgreSQL behind AWS ECS with CI/CD migration gates for deploys'),
    line('web', 'Shipped a Next.js and React dashboard with TypeScript, Tailwind and Vitest component coverage'),
    line('data', 'Wrote resumable S3 archiving jobs for 37,000 PDFs with pandas reports and retry checkpoints'),
    line('infra', 'Ran Kubernetes and Docker builds in GitHub Actions and cut cold API latency from 516ms to 50ms'),
    line('sim', 'Built a special relativity simulator in Python with numerical marker updates and plots'),
  ];
  const ids = job => relevantAnchors(anchors, job, 2).map(anchor => anchor.id);
  assert.deepEqual(ids('Machine learning intern: PyTorch, GPU training, inference and embeddings on Kubernetes.'), ['ml', 'infra']);
  assert.deepEqual(ids('Frontend intern: React, Next.js, TypeScript and Tailwind, talking to REST APIs.'), ['web', 'api']);
  // The name line is never a bullet to rewrite, even when the posting shares none of the bullets' words.
  assert.ok(!relevantAnchors(anchors, 'Nothing in common', 5, 6).some(anchor => anchor.id === 'name'));
});
