// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Append to a copy of the PDF.js 6.4.299 gulpfile.mjs, as described in
// PDFJS_BUILD.md. It uses the upstream functions without changing their options.

gulp.task("scorebrush-library", function scorebrushLibrary() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.writeFileSync(
    BUILD_DIR + "version.json",
    JSON.stringify({ version: "6.4.299", build: 299, commit: "d0991a0d5" })
  );
  const defines = { ...DEFINES, GENERIC: true, MINIFIED: true };
  const output = BUILD_DIR + "scorebrush-library/";
  return ordered([
    createMainBundle(defines).pipe(gulp.dest(output + "build")),
    createWorkerBundle(defines).pipe(gulp.dest(output + "build")),
    createCMapBundle().pipe(gulp.dest(output + "cmaps")),
    createICCBundle().pipe(gulp.dest(output + "iccs")),
    createStandardFontBundle().pipe(gulp.dest(output + "standard_fonts")),
    createWasmBundle({ includeQuickJS: false }).pipe(gulp.dest(output + "wasm")),
  ]);
});
