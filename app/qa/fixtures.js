// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Deterministic geometry-only test fixtures. These PDFs are created in memory;
// they contain no score transcription and are never checked into the repository.
const encode = value => new TextEncoder().encode(value);

function syntheticPdf(pages, label) {
  const objects = [null, '', ''];
  const pageIds = [];
  for (let page = 1; page <= pages; page++) {
    const id = objects.length, streamId = id + 1, fontId = id + 2;
    pageIds.push(id);
    const lines = ['0.65 G'];
    for (let system = 0; system < 5; system++) {
      for (let line = 0; line < 5; line++) {
        const y = 670 - system * 100 - line * 8;
        lines.push(`45 ${y} m 565 ${y} l S`);
      }
    }
    lines.push(`0 g BT /F1 16 Tf 45 745 Td (${label} - page ${page}) Tj ET`);
    lines.push('BT /F1 10 Tf 45 720 Td (Synthetic geometry for interface tests; no encoded music.) Tj ET');
    const stream = lines.join('\n') + '\n';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${streamId} 0 R >>`);
    objects.push(`<< /Length ${encode(stream).length} >>\nstream\n${stream}endstream`);
    objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  }
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages} >>`;
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (let id = 1; id < objects.length; id++) {
    offsets.push(encode(body).length);
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const start = encode(body).length;
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return new Blob([body], {type: 'application/pdf'});
}

export async function fixtureBlob(name) {
  if (name === 'score.ly') return new Blob(['% SYNTHETIC QA INPUT: no musical transcription.\n\\version "2.24.3"\n'], {type:'text/plain'});
  if (name === 'source.pdf') return syntheticPdf(1, 'SYNTHETIC SOURCE');
  if (name === 'rendered.pdf') return syntheticPdf(1, 'SYNTHETIC RENDER');
  if (name === 'multipage.pdf') return syntheticPdf(4, 'SYNTHETIC MULTIPAGE');
  throw new Error('Unknown synthetic fixture: ' + name);
}
