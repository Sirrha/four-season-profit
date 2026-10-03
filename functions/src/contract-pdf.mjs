// contract-pdf.mjs — BID-1 DETERMINISTIC CANONICAL CONTRACT PDF (component B).
// Frozen contract only. Same (contractVersionId, frozenAt, snapshot, templateVersion, generatorVersion) => byte-identical
// PDF: no clock, no randomness, fixed metadata (dates derived from the immutable frozenAt), standard PDF fonts only
// (Helvetica/Helvetica-Bold, WinAnsi; no font program embedded, nothing downloaded), no object streams, no /ID.
// The page content is drawn from the canonical document model (contract-document.mjs) — the same semantic blocks the
// accepted preview paints. No signatures, no seals, no signed wording: section 14 reserves two empty signature areas
// (each well above BankID's 92x49 pt visual seal) and keeps Dato "—".
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { frozenContractDocument, sourceSnapshotSha256, sha256Hex } from './contract-document.mjs';

export const PDF_LIBRARY = 'pdf-lib@1.17.1';
export const GENERATOR_VERSION = 'sormena-contract-pdf/1.0.0+' + PDF_LIBRARY;
export const SEAL_MIN = Object.freeze({ width: 92, height: 49 });   // BankID WYSIWYS visual seal size (pt)
const A4 = [595.28, 841.89];
const M = { left: 50, right: 50, top: 46, bottom: 56 };
const INK = rgb(0.11, 0.13, 0.12), MUTED = rgb(0.38, 0.40, 0.39), RULE = rgb(0.82, 0.84, 0.83), GREEN = rgb(0.12, 0.40, 0.23);

// WinAnsi guard: a character the standard fonts cannot encode is mapped explicitly and REPORTED (never silently lost).
const MAP = { '‑': '-', '‐': '-', '−': '-', ' ': ' ', ' ': ' ', '​': '' };
function makeSafe(font, replacements) {
  return (text) => {
    let out = '';
    for (const ch of String(text == null ? '' : text)) {
      let c = ch;
      if (MAP[c] !== undefined) { replacements.push({ from: ch, to: MAP[c] }); c = MAP[c]; }
      try { font.encodeText(c); out += c; } catch (e) { replacements.push({ from: ch, to: '?' }); out += '?'; }
    }
    return out;
  };
}

export async function generateContractPdf(version) {
  const doc = frozenContractDocument(version);
  if (!doc.ok) return doc;
  const model = doc.model;
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const replacements = [];
  const safe = makeSafe(reg, replacements);
  const width = A4[0] - M.left - M.right;
  const pages = [];
  let page = null, y = 0;
  const textRuns = [];   // every string actually drawn, in order (coverage proof)
  const sealAreas = [];  // reserved empty signature areas (page index + rectangle, pt)

  const newPage = () => {
    page = pdf.addPage(A4); pages.push(page); y = A4[1] - M.top;
    if (pages.length > 1) { draw(model.header.contLine, M.left, y, 7.5, reg, MUTED); y -= 20; }
  };
  const ensure = (h) => { if (y - h < M.bottom) newPage(); };
  function draw(text, x, yy, size, font, color) {
    const s = safe(text);
    if (s === '') return;
    page.drawText(s, { x, y: yy, size, font, color: color || INK });
    textRuns.push(s);
  }
  function wrap(text, size, font, maxW) {
    const lines = [];
    for (const para of String(text == null ? '' : text).split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const cand = line ? line + ' ' + word : word;
        if (font.widthOfTextAtSize(safe(cand), size) <= maxW || !line) line = cand; else { lines.push(line); line = word; }
      }
      lines.push(line);
    }
    return lines;
  }
  function paragraph(text, size, font, color, x, maxW, lead) {
    for (const ln of wrap(text, size, font, maxW)) { ensure(lead); draw(ln, x, y, size, font, color); y -= lead; }
  }
  function rows(list) {
    const kw = 170;
    for (const [k, v] of list) {
      const vl = wrap(v, 8.8, bold, width - kw - 8);
      const kl = wrap(k, 8.5, reg, kw - 8);
      const h = Math.max(vl.length, kl.length) * 11 + 3.5;
      ensure(h);
      page.drawLine({ start: { x: M.left, y: y + 8.5 }, end: { x: M.left + width, y: y + 8.5 }, thickness: 0.5, color: RULE });
      let yy = y; for (const l of kl) { draw(l, M.left + 4, yy, 8.5, reg, MUTED); yy -= 11; }
      yy = y; for (const l of vl) { draw(l, M.left + kw, yy, 8.8, bold, INK); yy -= 11; }
      y -= h;
    }
    page.drawLine({ start: { x: M.left, y: y + 8.5 }, end: { x: M.left + width, y: y + 8.5 }, thickness: 0.5, color: RULE });
    y -= 4;
  }

  // ---- first page header ----
  newPage();
  draw(model.header.orgLine, M.left, y, 7.5, reg, MUTED); y -= 24;
  draw(model.header.title, M.left, y, 17, bold, GREEN); y -= 15;
  paragraph(model.header.subtitle, 9.5, reg, INK, M.left, width, 12); y -= 4;

  for (const b of model.body) {
    if (b.kind === 'pageBreak') { if (y < A4[1] - M.top - 30) newPage(); continue; }
    if (b.kind === 'parties') {
      const colW = (width - 16) / 2;
      const col = (cap, list, x) => { let yy = y; const out = [];
        out.push([cap, 8, bold, GREEN]); for (const r of list) for (const l of wrap(r[0] + ': ' + r[1], 8.8, reg, colW - 12)) out.push([l, 8.8, reg, INK]);
        return { lines: out, h: out.length * 11 + 10, x, yy }; };
      const a = col('ARBEIDSGIVER', b.employer, M.left), e = col('ARBEIDSTAKER', b.employee, M.left + colW + 16);
      const h = Math.max(a.h, e.h); ensure(h);
      for (const c of [a, e]) {
        page.drawRectangle({ x: c.x, y: y - h + 12, width: colW, height: h, borderColor: RULE, borderWidth: 0.7 });
        let yy = y; for (const [t, s, f, col2] of c.lines) { draw(t, c.x + 6, yy, s, f, col2); yy -= 11; }
      }
      y -= h + 2;
      continue;
    }
    if (b.kind === 'numbered') {
      ensure(34); y -= 4;
      draw(b.n, M.left, y, 10.5, bold, GREEN); draw(b.title, M.left + 22, y, 10.5, bold, INK); y -= 14;
      const clause = b.text ? () => { paragraph(b.text, 8.5, reg, INK, M.left, width, 10.8); y -= 2; } : null;
      if (clause && (b.textFirst || !b.rows)) clause();
      for (const li of b.bullets || []) { ensure(11); draw('•', M.left + 4, y, 8.5, reg, INK); paragraph(li, 8.5, reg, INK, M.left + 16, width - 16, 10.8); }
      if (b.rows) rows(b.rows);
      if (clause && !b.textFirst && b.rows) clause();
      continue;
    }
    if (b.kind === 'signatures') {
      rows([['Sted', b.place], ['Dato', b.date]]);
      // Two empty signature areas, side by side, each much larger than one BankID visual seal (92x49 pt).
      const boxW = (width - 16) / 2, boxH = 96;
      ensure(boxH + 30); y -= 6;
      for (const [i, side] of [b.left, b.right].entries()) {
        const x = M.left + i * (boxW + 16);
        draw(side.caption, x, y, 8, bold, GREEN);
        draw(side.name, x, y - 13, 9.5, bold, INK);
        page.drawRectangle({ x, y: y - 22 - boxH, width: boxW, height: boxH, borderColor: RULE, borderWidth: 0.7 });
        sealAreas.push({ page: pages.length, role: side.caption, x, y: y - 22 - boxH, width: boxW, height: boxH });
        draw('Signatur', x + 4, y - 22 - boxH - 11, 7.5, reg, MUTED);
      }
      y -= boxH + 44;
      continue;
    }
  }
  for (const t of model.provenanceNotes) { y -= 4; paragraph(t, 7.5, reg, MUTED, M.left, width, 10); }

  // ---- per-page footer (after layout, so page count is final) ----
  pages.forEach((p, i) => {
    page = p;
    p.drawLine({ start: { x: M.left, y: 44 }, end: { x: A4[0] - M.right, y: 44 }, thickness: 0.5, color: RULE });
    draw(model.footer.brand, M.left, 32, 7.5, reg, MUTED);
    const label = 'Side ' + (i + 1) + ' av ' + pages.length;
    draw(label, A4[0] - M.right - reg.widthOfTextAtSize(label, 7.5), 32, 7.5, reg, MUTED);
  });

  // ---- deterministic metadata (no clock): dates = the immutable frozenAt ----
  const frozenDate = new Date(version.frozenAt);
  const snapHash = sourceSnapshotSha256(version, GENERATOR_VERSION);
  const employerName = (version.snapshot.employer && version.snapshot.employer.name) || 'Arbeidsgiver';
  pdf.setTitle(safe('Ansettelsesavtale ' + version.contractVersionId));
  pdf.setAuthor(safe(employerName));
  pdf.setSubject(safe('Godkjent og frosset avtaleversjon - usignert kildedokument for elektronisk signering'));
  pdf.setKeywords([version.contractVersionId, String(version.templateVersion || ''), GENERATOR_VERSION, 'sourceSnapshotSha256:' + snapHash]);
  pdf.setProducer(GENERATOR_VERSION);
  pdf.setCreator('Sormena');
  pdf.setLanguage('nb-NO');
  pdf.setCreationDate(frozenDate);
  pdf.setModificationDate(frozenDate);
  const bytes = await pdf.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
  return {
    ok: true,
    bytes,
    textRuns,
    sealAreas,
    replacements,
    pageCount: pages.length,
    identity: {
      contractVersionId: version.contractVersionId,
      templateVersion: version.templateVersion || null,
      generatorVersion: GENERATOR_VERSION,
      sourceSnapshotSha256: snapHash,
      sourcePdfSha256: sha256Hex(bytes),
      byteLength: bytes.length,
    },
    model,
  };
}
