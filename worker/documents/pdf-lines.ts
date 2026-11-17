/**
 * Rewrites whole text lines of a PDF whose text cannot be edited in place: LaTeX, Word and Google
 * Docs embed subset CID fonts, so a line's text is glyph ids, and a new word may use a glyph the
 * subset lacks. The line's glyphs are removed from the page content (its advance is kept, so the
 * rest of the text object stays put) and the replacement is drawn at the same baseline and size in
 * the nearest standard font, squeezed to the original width. Everything else on the page is
 * byte-for-byte the original content.
 */
import {
  PDFArray, PDFDict, PDFDocument, PDFFont, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, StandardFonts, decodePDFRawStream,
} from 'pdf-lib';

export type PdfLineEdit = { anchorText: string; replacement: string };

class PdfLineError extends Error {}
const fail = (message: string): never => { throw new PdfLineError(message); };

type Token =
  | { kind: 'num'; value: number } | { kind: 'name'; value: string } | { kind: 'str'; value: Uint8Array }
  | { kind: 'array'; value: Token[] } | { kind: 'dict' } | { kind: 'word'; value: string };
type Op = { op: string; operands: Token[]; start: number; end: number };

const WHITE = /[\0\t\n\f\r ]/;
const DELIM = /[()<>[\]{}/%]/;

/** PDF content-stream tokenizer: operands collect until an operator word ends the operation. */
function parse(content: string): Op[] {
  let i = 0;
  const skip = () => {
    while (i < content.length) {
      if (WHITE.test(content[i])) i++;
      else if (content[i] === '%') while (i < content.length && content[i] !== '\n' && content[i] !== '\r') i++;
      else break;
    }
  };
  const literal = () => {
    const out: number[] = [];
    let depth = 1;
    i++;
    while (i < content.length) {
      const c = content[i++];
      if (c === '\\') {
        const n = content[i++];
        const escaped: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
        if (n in escaped) out.push(escaped[n]);
        else if (/[0-7]/.test(n)) {
          let octal = n;
          while (octal.length < 3 && /[0-7]/.test(content[i])) octal += content[i++];
          out.push(parseInt(octal, 8) & 255);
        } else if (n === '\r') { if (content[i] === '\n') i++; } else if (n !== '\n') out.push(n.charCodeAt(0));
      } else if (c === '(') { depth++; out.push(40); } else if (c === ')') { if (--depth === 0) break; out.push(41); } else out.push(c.charCodeAt(0));
    }
    return Uint8Array.from(out);
  };
  const token = (): Token | null => {
    skip();
    const c = content[i];
    if (c === undefined) return null;
    if (c === '(') return { kind: 'str', value: literal() };
    if (c === '<' && content[i + 1] === '<') {
      let depth = 0;
      do {
        if (content.startsWith('<<', i)) { depth++; i += 2; } else if (content.startsWith('>>', i)) { depth--; i += 2; } else i++;
      } while (depth > 0 && i < content.length);
      return { kind: 'dict' };
    }
    if (c === '<') {
      const end = content.indexOf('>', i);
      if (end < 0) fail('unterminated hex string');
      let hex = content.slice(i + 1, end).replace(/\s+/g, '');
      if (hex.length % 2) hex += '0';
      i = end + 1;
      return { kind: 'str', value: Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16)) };
    }
    if (c === '[') {
      i++;
      const items: Token[] = [];
      for (skip(); content[i] !== ']'; skip()) {
        const item = token();
        if (!item) fail('unterminated array');
        items.push(item!);
      }
      i++;
      return { kind: 'array', value: items };
    }
    if (c === '/') {
      const start = ++i;
      while (i < content.length && !WHITE.test(content[i]) && !DELIM.test(content[i])) i++;
      return { kind: 'name', value: content.slice(start, i) };
    }
    const start = i;
    while (i < content.length && !WHITE.test(content[i]) && !DELIM.test(content[i])) i++;
    if (i === start) { i++; return { kind: 'word', value: c }; }
    const word = content.slice(start, i);
    return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(word) ? { kind: 'num', value: Number(word) } : { kind: 'word', value: word };
  };
  const ops: Op[] = [];
  let operands: Token[] = [], start = -1;
  for (skip(); i < content.length; skip()) {
    const at = i;
    const item = token();
    if (!item) break;
    if (start < 0) start = at;
    if (item.kind !== 'word' || ['true', 'false', 'null'].includes(item.value)) { operands.push(item); continue; }
    if (item.value === 'BI') fail('inline images are not supported');
    ops.push({ op: item.value, operands, start, end: i });
    operands = []; start = -1;
  }
  return ops;
}

type Matrix = [number, number, number, number, number, number];
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

type Font = { baseFont: string; twoByte: boolean; width(code: number): number; text(code: number): string };

function utf16(bytes: number[]) {
  let out = '';
  for (let k = 0; k + 1 < bytes.length; k += 2) out += String.fromCharCode((bytes[k] << 8) | bytes[k + 1]);
  return out;
}
const hexBytes = (hex: string) => (hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16));

function toUnicode(dict: PDFDict) {
  const map = new Map<number, string>();
  const stream = dict.lookupMaybe(PDFName.of('ToUnicode'), PDFStream);
  if (!(stream instanceof PDFRawStream)) return map;
  const cmap = Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, src, dst] of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(parseInt(src, 16), utf16(hexBytes(dst)));
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const [, lo, hi, dst, list] of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
      const from = parseInt(lo, 16), to = parseInt(hi, 16);
      if (to - from > 65_535) continue;
      const items = list ? [...list.matchAll(/<([0-9a-fA-F]+)>/g)].map((m) => m[1]) : null;
      for (let code = from; code <= to; code++) {
        if (items) { if (items[code - from]) map.set(code, utf16(hexBytes(items[code - from]))); continue; }
        const base = hexBytes(dst!);
        base[base.length - 1] += code - from;
        map.set(code, utf16(base));
      }
    }
  }
  return map;
}

function loadFont(dict: PDFDict): Font {
  const baseFont = dict.lookupMaybe(PDFName.of('BaseFont'), PDFName)?.decodeText() ?? '';
  const subtype = dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText();
  const unicode = toUnicode(dict);
  if (subtype === 'Type0') {
    const encoding = dict.lookupMaybe(PDFName.of('Encoding'), PDFName)?.decodeText();
    if (encoding !== 'Identity-H') fail(`unsupported CID encoding ${encoding}`);
    if (!unicode.size) fail('CID font without ToUnicode');
    const descendant = dict.lookup(PDFName.of('DescendantFonts'), PDFArray).lookup(0, PDFDict);
    const dw = descendant.lookupMaybe(PDFName.of('DW'), PDFNumber)?.asNumber() ?? 1000;
    const widths = new Map<number, number>();
    const w = descendant.lookupMaybe(PDFName.of('W'), PDFArray);
    for (let k = 0; w && k < w.size();) {
      const first = w.lookup(k, PDFNumber).asNumber();
      const next = w.lookup(k + 1);
      if (next instanceof PDFArray) {
        for (let j = 0; j < next.size(); j++) widths.set(first + j, next.lookup(j, PDFNumber).asNumber());
        k += 2;
      } else {
        const last = (next as PDFNumber).asNumber(), value = w.lookup(k + 2, PDFNumber).asNumber();
        for (let code = first; code <= last && code - first < 65_536; code++) widths.set(code, value);
        k += 3;
      }
    }
    return { baseFont, twoByte: true, width: (code) => widths.get(code) ?? dw, text: (code) => unicode.get(code) ?? '' };
  }
  if (subtype !== 'Type1' && subtype !== 'TrueType') fail(`unsupported font ${subtype}`);
  const first = dict.lookupMaybe(PDFName.of('FirstChar'), PDFNumber)?.asNumber();
  const widths = dict.lookupMaybe(PDFName.of('Widths'), PDFArray);
  if (first === undefined || !widths) fail('font without widths');
  return {
    baseFont, twoByte: false,
    width: (code) => (code >= first! && code - first! < widths!.size() ? widths!.lookup(code - first!, PDFNumber).asNumber() : 0),
    text: (code) => unicode.get(code) ?? String.fromCharCode(code),
  };
}

/** One shown string: where each glyph starts in user space, and how far the whole show advances. */
type Glyph = { text: string; x: number; y: number };
type Show = {
  op: Op; font: Font; fontName: string; size: number; scale: number; xscale: number; th: number;
  items: ({ kind: 'glyph'; bytes: number[]; tx: number } | { kind: 'kern'; value: number; tx: number })[];
  glyphs: Glyph[]; x: number; y: number; prefix: 'Tstar' | 'quote' | null; quote?: Token[];
};

function shows(ops: Op[], fonts: (name: string) => Font): Show[] {
  const out: Show[] = [];
  let ctm = IDENTITY;
  const stack: Matrix[] = [];
  let tm = IDENTITY, tlm = IDENTITY, fontName = '', size = 0, tc = 0, tw = 0, th = 1, tl = 0;
  const nums = (op: Op) => op.operands.map((t) => (t.kind === 'num' ? t.value : NaN));
  const nextLine = () => { tlm = multiply([1, 0, 0, 1, 0, -tl], tlm); tm = tlm; };
  for (const op of ops) {
    const n = nums(op);
    switch (op.op) {
      case 'q': stack.push(ctm); break;
      case 'Q': ctm = stack.pop() ?? IDENTITY; break;
      case 'cm': ctm = multiply(n as Matrix, ctm); break;
      case 'BT': tm = tlm = IDENTITY; break;
      case 'Tf': fontName = op.operands[0]?.kind === 'name' ? op.operands[0].value : ''; size = n[1]; break;
      case 'Tc': tc = n[0]; break;
      case 'Tw': tw = n[0]; break;
      case 'Tz': th = n[0] / 100; break;
      case 'TL': tl = n[0]; break;
      case 'Td': tlm = multiply([1, 0, 0, 1, n[0], n[1]], tlm); tm = tlm; break;
      case 'TD': tl = -n[1]; tlm = multiply([1, 0, 0, 1, n[0], n[1]], tlm); tm = tlm; break;
      case 'Tm': tlm = tm = n as Matrix; break;
      case 'T*': nextLine(); break;
      case 'Tj': case 'TJ': case "'": case '"': {
        let prefix: Show['prefix'] = null;
        if (op.op === "'") { nextLine(); prefix = 'Tstar'; }
        if (op.op === '"') { tw = n[0]; tc = n[1]; nextLine(); prefix = 'quote'; }
        const last = op.operands[op.operands.length - 1];
        const parts = last?.kind === 'array' ? last.value : last ? [last] : [];
        const font = fonts(fontName);
        const show: Show = { op, font, fontName, size, th, scale: 1, xscale: 1, items: [], glyphs: [], x: 0, y: 0, prefix,
          quote: op.op === '"' ? op.operands.slice(0, 2) : undefined };
        const origin = multiply(tm, ctm);
        if (Math.abs(origin[1]) > 1e-3 || Math.abs(origin[2]) > 1e-3) fail('rotated or skewed text');
        show.x = origin[4]; show.y = origin[5]; show.scale = Math.abs(origin[3]); show.xscale = Math.abs(origin[0]);
        for (const part of parts) {
          if (part.kind === 'num') {
            const tx = (-part.value / 1000) * size * th;
            show.items.push({ kind: 'kern', value: part.value, tx });
            tm = multiply([1, 0, 0, 1, tx, 0], tm);
          } else if (part.kind === 'str') {
            const bytes = [...part.value];
            const step = font.twoByte ? 2 : 1;
            for (let k = 0; k + step - 1 < bytes.length; k += step) {
              const code = step === 2 ? (bytes[k] << 8) | bytes[k + 1] : bytes[k];
              const tx = ((font.width(code) / 1000) * size + tc + (step === 1 && code === 32 ? tw : 0)) * th;
              const at = multiply(tm, ctm);
              show.glyphs.push({ text: font.text(code), x: at[4], y: at[5] });
              show.items.push({ kind: 'glyph', bytes: bytes.slice(k, k + step), tx });
              tm = multiply([1, 0, 0, 1, tx, 0], tm);
            }
          }
        }
        out.push(show);
        break;
      }
    }
  }
  return out;
}

/** The line as pdftotext would read it: a wide kern or a gap between shows reads as a space. */
function lineText(line: Show[]) {
  let text = '';
  for (const [index, show] of line.entries()) {
    if (index) text += ' ';
    for (const item of show.items) {
      if (item.kind === 'kern') { if (item.value < -150) text += ' '; continue; }
      const step = show.font.twoByte ? 2 : 1;
      text += show.font.text(step === 2 ? (item.bytes[0] << 8) | item.bytes[1] : item.bytes[0]);
    }
  }
  return text;
}

// pdftotext reads a zero-width space the page draws as nothing (a LaTeX bullet's spacing).
const squash = (value: string) => value.replace(/[\s​-‍⁠﻿]+/g, '');
const MARKER = /^[•·◦▪‣\-–—*]$/u;
const hex = (bytes: number[]) => `<${bytes.map((b) => b.toString(16).padStart(2, '0')).join('')}>`;

function standardFont(baseFont: string) {
  const bold = /bold|black|heavy|semibold/i.test(baseFont), italic = /italic|oblique/i.test(baseFont);
  if (/arial|helvetica|calibri|inter|roboto|sans|lato|open|source|avenir|futura|gill|segoe|verdana/i.test(baseFont)) {
    return bold && italic ? StandardFonts.HelveticaBoldOblique : bold ? StandardFonts.HelveticaBold
      : italic ? StandardFonts.HelveticaOblique : StandardFonts.Helvetica;
  }
  return bold && italic ? StandardFonts.TimesRomanBoldItalic : bold ? StandardFonts.TimesRomanBold
    : italic ? StandardFonts.TimesRomanItalic : StandardFonts.TimesRoman;
}

export async function rewritePdfLines(bytes: Uint8Array, edits: readonly PdfLineEdit[]): Promise<Uint8Array> {
  try {
    const document = await PDFDocument.load(bytes, { updateMetadata: false });
    const pending = new Map(edits.map((edit) => [squash(edit.anchorText), edit]));
    const embedded = new Map<string, PDFFont>();
    for (const page of document.getPages()) {
      if (!pending.size) break;
      const contents = page.node.Contents();
      const streams = contents instanceof PDFArray
        ? contents.asArray().map((ref) => document.context.lookup(ref)) : contents ? [contents as PDFRawStream] : [];
      if (!streams.every((stream) => stream instanceof PDFRawStream)) fail('unsupported content stream');
      const content = streams.map((stream) => Buffer.from(decodePDFRawStream(stream as PDFRawStream).decode()).toString('latin1')).join('\n');
      const resources = page.node.Resources();
      const fontDict = resources?.lookupMaybe(PDFName.of('Font'), PDFDict);
      const cache = new Map<string, Font>();
      const fonts = (name: string) => {
        if (!cache.has(name)) {
          const dict = fontDict?.lookupMaybe(PDFName.of(name), PDFDict);
          if (!dict) fail(`font ${name} not found`);
          cache.set(name, loadFont(dict!));
        }
        return cache.get(name)!;
      };
      const all = shows(parse(content), fonts);
      const lines: Show[][] = [];
      for (const show of all.filter((item) => item.glyphs.length)) {
        const line = lines.find((group) => Math.abs(group[0].y - show.y) < 1);
        if (line) line.push(show); else lines.push([show]);
      }
      const splices: { start: number; end: number; text: string }[] = [];
      const overlay: string[] = [];
      for (const line of lines) {
        line.sort((a, b) => a.x - b.x);
        const edit = pending.get(squash(lineText(line)));
        if (!edit) continue;
        // A bullet drawn from its own font is a run of its own; it stays, like an inline one below.
        const words = line.filter((item) => !item.glyphs.every((g) => MARKER.test(g.text) || !squash(g.text)));
        if (!words.length) fail('PDF line has no text to rewrite');
        // A leading label in another font ("Languages:" in bold) stays as drawn; the rewrite starts after it.
        const body = words.at(-1)!.font.baseFont;
        let labelRuns = 0;
        while (words[labelRuns].font.baseFont !== body) labelRuns++;
        if (words.slice(labelRuns).some((item) => item.font.baseFont !== body)) fail('PDF line mixes fonts');
        const label = squash(words.slice(0, labelRuns).flatMap((run) => run.glyphs.map((g) => g.text)).join(''));
        const show = words[labelRuns];
        const size = show.size * show.scale;
        // XeLaTeX draws each word as a run of its own: every run's glyphs go, and one line is drawn in their place.
        if (words.slice(labelRuns).some((item) => Math.abs(item.size * item.scale - size) > 0.01)) fail('PDF line mixes text sizes');
        let firstRemoved: Glyph | undefined, end = -Infinity;
        for (const [index, run] of words.slice(labelRuns).entries()) {
          // A leading bullet stays as drawn; only the words after it are rewritten.
          let keep = 0, glyph = 0;
          for (; index === 0 && keep < run.items.length; keep++) {
            if (run.items[keep].kind !== 'glyph') continue;
            if (!MARKER.test(run.glyphs[glyph].text)) break;
            glyph++;
          }
          const kept = run.items.slice(0, keep);
          const removed = run.items.slice(keep);
          firstRemoved ??= run.glyphs[glyph];
          const offset = kept.reduce((sum, item) => sum + item.tx, 0);
          const advance = removed.reduce((sum, item) => sum + item.tx, 0);
          const array = [...kept.map((item) => (item.kind === 'glyph' ? hex(item.bytes) : String(item.value))),
            String(Number(((-advance / (run.size * run.th)) * 1000).toFixed(3)))];
          const lead = run.prefix === 'Tstar' ? 'T* ' : run.prefix === 'quote'
            ? `${(run.quote![0] as { value: number }).value} Tw ${(run.quote![1] as { value: number }).value} Tc T* ` : '';
          splices.push({ start: run.op.start, end: run.op.end, text: `${lead}[${array.join(' ')}] TJ` });
          end = Math.max(end, run.x + (offset + advance) * run.xscale);
        }
        if (!firstRemoved) fail('PDF line has no text to rewrite');
        const start = firstRemoved!;

        const full = edit.replacement.replace(/^\s*[•·◦▪‣*]\s*/u, '').trim();
        if (!squash(full).startsWith(label)) fail('replacement changes the line label');
        let cut = 0;
        for (let seen = 0; seen < label.length; cut++) if (squash(full[cut])) seen++;
        const text = full.slice(cut).trim();
        const standard = standardFont(show.font.baseFont);
        if (!embedded.has(standard)) embedded.set(standard, await document.embedFont(standard));
        const font = embedded.get(standard)!;
        const room = end - start.x;
        const natural = font.widthOfTextAtSize(text, size);
        const squeeze = Math.min(100, (room / natural) * 100);
        if (squeeze < 80) fail('replacement does not fit its line');
        const key = page.node.newFontDictionary('WorkieLine', font.ref);
        overlay.push(`BT ${key} ${size.toFixed(3)} Tf ${squeeze.toFixed(2)} Tz 1 0 0 1 ${start.x.toFixed(3)} ${start.y.toFixed(3)} Tm 0 g ${font.encodeText(text)} Tj ET`);
        pending.delete(squash(edit.anchorText));
      }
      if (!splices.length) continue;
      let next = content;
      for (const splice of splices.sort((a, b) => b.start - a.start)) next = next.slice(0, splice.start) + splice.text + next.slice(splice.end);
      const stream = document.context.flateStream(Buffer.from(`q\n${next}\nQ\nq ${overlay.join(' ')} Q\n`, 'latin1'));
      page.node.set(PDFName.of('Contents'), document.context.register(stream) as PDFRef);
    }
    if (pending.size) fail('PDF anchor was not found');
    return await document.save({ useObjectStreams: false, updateFieldAppearances: false });
  } catch (error) {
    throw new PdfLineError(error instanceof Error ? error.message : 'PDF rewrite failed');
  }
}
