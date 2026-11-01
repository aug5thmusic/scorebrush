# PDF.js and decoder source inputs

ScoreBrush bundles the modern minified PDF.js **6.4.299** library and worker,
build `d0991a0d5`, from release commit
`d0991a0d53f3bb3a7307e3b83f279c1d117aafb3`. They are installed as `pdf.mjs`
and `pdf.worker.mjs`. Ordinary packaging copies the pinned vendor files; it
does not rebuild these dependencies. An independent rebuild has not been performed.

## Library build

Extract `upstream-sources/pdfjs-6.4.299-source.tar.gz` and
`upstream-sources/pdfjs-6.4.299-library-inputs.tar.gz` into the same temporary
parent directory. Both use the `pdf.js-6.4.299/` root. The 520 supplied files
match their release Git blob IDs. The supplemental archive contains the
original `l10n/en-US/viewer.ftl`, read by the library Webpack configuration;
its MPL-2.0 source notice is retained. The separate viewer and test PDF corpus
are omitted. The main archive retains `src/`, `external/` library resources (excluding unused QuickJS), package/lock,
`pdfjs.config`, gulp entry point, license and authors.

The upstream `package.json` requires Node **>=22.22.3, >=24.15.0, or >=26.0**.
Use the supplied `package-lock.json` with `npm ci` in that extracted directory.
It pins Babel 8.0.6, babel-loader 10.1.1, Gulp 5.0.1, Gulp CLI 3.1.0,
Webpack 5.111.1, webpack-stream 7.0.0, terser-webpack-plugin 5.6.1 and
Terser 5.51.2. These are development tools, not ScoreBrush runtime installs.
No installation or dependency compilation was performed for this update.

To build the shipped library and auxiliary assets, concatenate upstream
`gulpfile.mjs`, a newline, and `build-support/pdfjs-library-task.mjs` into a
new `gulpfile.scorebrush.mjs` beside the original gulpfile. Then run:

```sh
npx --no-install gulp --gulpfile gulpfile.scorebrush.mjs scorebrush-library
```

The task calls upstream `createMainBundle` and `createWorkerBundle` with
`GENERIC`/`MINIFIED` defines and records the release version/build identity.
It copies the matching CMaps, ICC profile, fonts, WASM decoders and OpenJPEG
and JBIG2 JavaScript fallbacks. `createWasmBundle({ includeQuickJS: false })`
uses the upstream option to omit viewer-scripting assets that are not used
by the library/worker. ScoreBrush does not include the full viewer or its
scripting manager. No QuickJS reference occurs in either shipped bundle.

Output is under `build/scorebrush-library/`. Compare the resulting minified
bundles and assets against `vendor-inventory.json`; preserve any differences
and tool versions. The task and 182-file static relative import graph were
checked without performing a whole-library compilation.

## Decoder inputs

| Decoder | Retained source and preparation inputs | Toolchain information |
| --- | --- | --- |
| OpenJPEG 2.5.4 development revision | Wrapper `13eaf130b252d748560569fffb83fd9432597840`; OpenJPEG `8314119b067c0fc77834731168daaebd379fdb12`; complete source, buffer-stream patch, build scripts and Dockerfile | Emscripten C/C++, CMake and Make; `emscripten/emsdk:latest`. Original exact Emscripten version/container digest is not established. |
| JBIG2/CCITT | Wrapper `15f6f9357c5e5e30285eb83aa08e5fe1a16ab77a`; PDFium `bb1f9f71e7b15afdd5937adf8cfe5807522b882f`; 99 source/header/notice files, wrapper headers and build scripts | Emscripten C++20; `emscripten/emsdk:latest`. Original exact compiler version/container digest is not established. |
| qcms 0.3.0 | Wrapper `2ae4ee72334782928210ba4050e3e77d9b2d35be`; Cargo manifest/lock, bindings, wrapper and scripts; all 15 crates from that checked-in lock; supplemental actual-version sources below | Binary producer metadata identifies rustc `1.97.1 (8bab26f4f 2026-07-14)`, walrus `0.26.4`, wasm-bindgen `0.2.126`. Dockerfile uses `rust:latest`, unversioned tool installs and `cargo update`; original wasm-pack version and complete compilation lock are not established. |

All wrapper/source files match their recorded Git blobs. Decoder update
commits in PDF.js history associate the retained wrappers with the release.
PDFium selection follows the wrapper's compilation units and recursively
quoted includes. `emscripten.h` and standard C++ headers come from Emscripten;
PartitionAlloc and Skia branches are guarded by macros absent from this build.

The qcms wrapper's checked-in lock contains wasm-bindgen 0.2.100, whereas the
published binary identifies **0.2.126**. The original lock is retained as
upstream source evidence and is not represented as the binary's build lock.
`wasm-bindgen-0.2.126-source-inputs.tar.gz` supplies the actual version's
published source and all 19 registry entries from its published Cargo.lock,
verified by registry/lock SHA-256. `SOURCE-INDEX.json` records each input.
That supplemental lock is also not claimed to be the original qcms build lock.

`rust-src-1.97.1-source.tar.gz` preserves all file bytes from the official Rust
source component verified against its download SHA-256. It includes the
standard library, compiler-builtins, vendored dlmalloc 0.2.13 and original
notices. qcms WASM paths identify dlmalloc 0.2.13 and qcms 0.3.0. Packaged
runtime notices also retain Rust, wasm-bindgen and dlmalloc license texts.

The wrappers provide `node build.js --compile --output <directory>` and
Docker preparation instructions. For a controlled rebuild, preserve source
revisions, deliberately select a lock consistent with the recorded binary
versions, and pin compiler/container/tool versions. Such a build is a new
documented build, not proof of the original upstream environment. The upstream
qcms Dockerfile's unbounded `cargo update` is not a reproducible build command.

## Verification scope

Hash/source coverage establishes the retained inputs and notices, not a
byte-identical upstream rebuild. Original Emscripten/wasm-pack details and
the qcms compilation lock remain reproducibility limits. No new toolchain is
needed to package the pinned upstream files. `source-audit.json` records
technical source coverage; it does not certify legal compliance or public
release readiness.
