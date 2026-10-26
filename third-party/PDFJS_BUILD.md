# PDF.js and decoder source inputs

ScoreBrush bundles the modern minified PDF.js **5.6.205** library and worker,
identified upstream by build `ada343803`. They are installed as `pdf.mjs` and
`pdf.worker.mjs`. Ordinary ScoreBrush packaging copies the pinned vendor files;
it does not rebuild PDF.js or the decoders. The supplied inputs support source
inspection and modification. An independent rebuild has not been performed.

## Library build

Extract `upstream-sources/pdfjs-5.6.205-source.tar.gz` and then
`upstream-sources/pdfjs-5.6.205-library-inputs.tar.gz` into the same temporary
parent directory. Both use the `pdf.js-5.6.205/` root. The supplemental archive
contains the original `l10n/en-US/viewer.ftl`, which the generic library's
Webpack configuration reads. Its MPL-2.0 notice and license link are retained;
the file remains available in source form under those terms.

The upstream `package.json` requires Node **>=20.19.0, >=22.13.0, or >=24**.
Use the supplied `package-lock.json` with `npm ci` in that extracted directory.
It pins the build packages and their integrity values, including Babel 7.29.0,
babel-loader 10.1.1, Gulp 5.0.1, Gulp CLI 3.1.0, Webpack 5.105.4,
webpack-stream 7.0.0, terser-webpack-plugin 5.4.0 and Terser 5.46.0.
Dependencies are development tools, not a new ScoreBrush runtime installation.

To build only the shipped library and auxiliary assets, concatenate the
upstream `gulpfile.mjs`, a newline, and `build-support/pdfjs-library-task.mjs`
into a new `gulpfile.scorebrush.mjs` beside the original gulpfile. Then run,
from the extracted source directory:

```sh
npx --no-install gulp --gulpfile gulpfile.scorebrush.mjs scorebrush-library
```

This task calls the original `createMainBundle` and `createWorkerBundle` with
the same `GENERIC`/`MINIFIED` defines as upstream's minified target. It records
the release version/build identity explicitly, avoiding a dependency on Git
history. It copies the supplied CMaps, ICC profile, fonts and decoder outputs.
Output is under `build/scorebrush-library/`. The separate upstream viewer,
test corpora, sandbox and example PDFs are not inputs to these two bundles.
The task's syntax and source references were checked; its dependency-install
and compilation steps have not been executed here.

Compare resulting `build/scorebrush-library/build/pdf.min.mjs` and
`build/scorebrush-library/build/pdf.worker.min.mjs` with the corresponding
records in `vendor-inventory.json`. Preserve any differences and the tool
versions used; do not silently replace the pinned runtime files.

## Decoder inputs

| Decoder | Retained source and preparation inputs | Toolchain information |
| --- | --- | --- |
| OpenJPEG 2.5.4 | Wrapper `b47d31b8355a3863ab37282ceeb5183f7ac2761c`; OpenJPEG `6c4a29b00211eb0430fa0e5e890f1ce5c80f409f`; buffer-stream patch, `compile_lib.sh`, `compile.sh`, Dockerfile and build driver | Emscripten C/C++, CMake and Make; upstream image uses `emscripten/emsdk:latest`. Original exact Emscripten version is not recorded in the supplied binary or Dockerfile. |
| JBIG2/CCITT | Wrapper `1e945e7552561c9b45e6d2c7d1a359ea82afc5b7`; PDFium `0455e822ded1a5537d826703988e986a33d2d4a1`; selected compilation units/headers, wrapper build headers, `compile.sh`, Dockerfile and build driver | Emscripten C++20; upstream image uses `emscripten/emsdk:latest`. Original exact Emscripten version is not recorded in the supplied binary or Dockerfile. |
| qcms 0.3.0 | Wrapper `fc23a407f1ed9ccfea15875d27e0936dcc798a1f`; Cargo manifest/lock, Rust bindings, JavaScript wrapper, `compile.sh`, Dockerfile, build driver and all 15 registry source crates pinned by the lock | Shipped WASM producers identify rustc `1.87.0 (17067e9ac 2025-05-09)`, walrus `0.23.3` and wasm-bindgen `0.2.100`. The upstream Dockerfile uses `rust:latest`, unversioned wasm-pack/wasm-bindgen-cli installation and `cargo update`; original wasm-pack version is not established. |

The upstream wrappers provide `node build.js --compile --output <directory>`
and their Docker-based preparation commands. OpenJPEG's build first applies
its retained patch and builds a static library, then produces WASM and a
JavaScript fallback. JBIG2's compile script lists its PDFium translation units
and exports both JBIG2 and CCITT decoding. Its selected source includes the
referenced project headers; Emscripten and C++ standard headers come from the
compiler, and disabled PartitionAlloc/Skia branches are not compiled. qcms's
script invokes `wasm-pack build --target web --release` and copies its wrapper.

For a controlled rebuild, preserve the supplied source revisions and Cargo.lock,
choose and record fixed compiler/container/tool versions, and avoid the upstream
Dockerfile's unbounded `cargo update`. Such a build is a documented new build,
not proof of the original upstream build environment. No new toolchain or
decoder build is needed to package the existing pinned ScoreBrush assets.

## Verification scope

The release source, wrapper updates, checksummed crates, build scripts and
binary producer metadata identify the retained material. Source review and
hash comparison do not demonstrate a byte-identical upstream rebuild. Unknown
floating toolchain versions are a reproducibility limitation, not by themselves
a missing-source finding. General-purpose unmodified build tools are distinct
from covered application source and embedded runtime code. Retain the license
and copyright notices that apply to each component. See `source-audit.json`
for the overall source status and any outstanding component-specific gaps.
