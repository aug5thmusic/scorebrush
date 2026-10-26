// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// PDF.js fetches decoder, font and CMap assets inside its worker. Absolute
// module-relative URLs keep those fetches independent of the worker’s folder
// and of the page URL used to open this local application.
const resource=path=>new URL('./vendor/'+path,import.meta.url).href;
export const pdfWorkerUrl=resource('pdf.worker.mjs');
export const pdfResourceUrls=Object.freeze({
  cMapUrl:resource('cmaps/'),
  standardFontDataUrl:resource('standard_fonts/'),
  wasmUrl:resource('wasm/'),
  iccUrl:resource('iccs/')
});
