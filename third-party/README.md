# Upstream source materials

These files are source material for inspection and modification. They are not
dependencies to install. Upstream licenses and copyright notices remain inside
the archives. `source-provenance.json` records their origins, hashes and the
scope of verification. `vendor-inventory.json` pins the bundled runtime files.

## Included sources

- PDF.js 6.4.299: `src/`, matching `external/` library resources, license,
  authors, package/lock, `pdfjs.config` and build entry point. All 520 selected
  files (including the supplemental Fluent input) match their release Git blobs.
  The large test-PDF corpus, separate viewer and unused QuickJS assets are omitted.
- PDF-lib 1.17.1 and JSZip 3.10.1: library sources and build configuration from
  their tags, excluding test/demo corpora. PDF-lib's source map retains all
  179 source contents; the matching unminified JSZip bundle is also included.
- `javascript-embedded-source-inputs-20261026.tar.gz` retains selected readable
  embedded modules, versioned package inputs and standalone license texts.
  Its `SOURCE-INDEX.json` identifies exact source-map/module comparisons and
  limitations. This is a selected source set, not an original registry archive.
- `standard-fonts-1.0.0-41a6440-source.tar.gz` retains all 42 files from
  release-associated revision `41a6440267de5456042c7bcbac5ec65065e2ef69`,
  including TypeScript, preparation scripts, configuration, locks, 14 Adobe
  AFMs, their original MustRead notice and three encoding tables. It also
  retains base64-arraybuffer 0.1.5 source and its MIT notice for the copied
  decoding helper. This supplies the preparation inputs excluded from the
  earlier selected embedded-source archive.
- `browser-pack-6.0.2-loader-source.tar.gz` retains the exact npm release's
  readable/generated preludes, generation/integration files and MIT notice.
  The generated prelude matches the retained JSZip bundle byte-for-byte;
  normalized complete syntax trees also match the readable source and the
  minified loader actually shipped.
- `notices/standard-font-data/` retains Adobe's original MustRead, the specific
  Unicode Symbol/Zapf Dingbats notice, Unicode License v3 for the matching
  CP1252 data, and the exact cited PDFKit MIT license for WinAnsi glyph names.
  The original inputs remain unchanged; THIRD_PARTY_NOTICES.md describes their
  upstream transformations and supplies the accompanying notices.
- `pdfjs-6.4.299-library-inputs.tar.gz` supplies the original
  `l10n/en-US/viewer.ftl`, verified against the release Git blob. Its MPL-2.0
  source notice is retained. [PDFJS_BUILD.md](PDFJS_BUILD.md) describes the
  library-only build task and the omission of unused viewer scripting assets.
- OpenJPEG: complete 2.5.4 development-revision source at
  `8314119b067c0fc77834731168daaebd379fdb12`, plus wrapper
  `13eaf130b252d748560569fffb83fd9432597840` and its buffer-stream patch.
- JBIG2/CCITT: wrapper `15f6f9357c5e5e30285eb83aa08e5fe1a16ab77a`, plus
  99 PDFium source/header/notice files at pinned commit
  `bb1f9f71e7b15afdd5937adf8cfe5807522b882f`. Every selected file matches its
  upstream Git blob. The selection follows compilation units and quoted
  includes; Emscripten supplies its own headers. PartitionAlloc/Skia branches
  are guarded by macros absent from the wrapper build.
- qcms: wrapper `2ae4ee72334782928210ba4050e3e77d9b2d35be` and all 15
  registry source crates from its checked-in Cargo.lock. That lock predates
  the actual binary's wasm-bindgen 0.2.126 and is not claimed to be its
  compilation lock. Supplemental `wasm-bindgen-0.2.126-source-inputs.tar.gz`
  supplies the published crate and all 19 registry entries from its own
  published lock, verified by registry/lock SHA-256. Source index retained.
- `rust-src-1.97.1-source.tar.gz`: complete official Rust source component,
  verified against its published SHA-256, with original file bytes retained.
  This matches qcms WASM producer metadata and includes standard-library,
  compiler-builtins and vendored dlmalloc 0.2.13 sources and notices.

All wrapper sources match their Git blobs. Decoder update commits in PDF.js
history associate those wrappers with the release. This is source provenance,
not proof of a byte-identical decoder rebuild. Original Emscripten/wasm-pack
versions and the exact qcms compilation lock remain unknown. Its Dockerfile
runs `cargo update`; retained actual-version source inputs are distinguished
from the outdated checked-in lock. See PDFJS_BUILD.md for rebuild limitations.

The three runtime JavaScript libraries and PDF.js auxiliary files were compared
with the matching npm distributions. Their bytes match. Ordinary ScoreBrush
builds use these bundled assets and require no JavaScript bundling step.

## Audit result and distribution verification

The dependency-source and notice audit in `source-audit.json` is complete for
the retained versions. No preferred-source or applicable-notice item remains
open. This is a technical coverage conclusion, not legal certification.

The standard-fonts revision is associated with version 1.0.0 by its version
commit, publication chronology, matching package files and generated output;
npm supplies no gitHead and no 1.0.0 tag attests a unique original build commit.
All 15 decoded JSON and compressed payloads regenerate exactly from the retained
inputs and occur in PDF-lib. Its three published runtime modules match PDF-lib's
source map exactly. The original TypeScript and published JavaScript also agree
across all retained font metrics and encoding mappings. The original TypeScript
2.9.2/ES5 build has not been reproduced.

Adobe's notice applies to the original 14 AFMs and accompanies them unchanged.
Unicode's specific Symbol/Zapf notice remains attached; its current data terms
cover the identical CP1252 mapping. The copied PDFKit name table and
base64-arraybuffer helper retain their own MIT notices. The package's MIT
license is not substituted for these underlying terms.

The browser-pack registry tarball matches both the JSZip release-lock SHA-1 and
registry SHA-512. Exact generated-prelude bytes and complete normalized syntax
trees connect its readable source to the shipped loader. The registry records
gitHead `d8f408fd1408ad1fbe02830792caa1354bf48188`; correspondence is verified
from the exact versioned package, without claiming independent Git-tree proof.

Readable pako modules, tslib helpers, UPNG, lie, immediate and setimmediate inputs
and their standalone notices are retained. JSZip's browser bundle substitutes a
small stub for readable-stream; readable-stream and its stream-support packages
are not embedded merely because they appear in a build lockfile.

PDF.js library input coverage and its supplemental build task were checked
statically, without installing build dependencies or compiling. The retained
decoder sources, patches, scripts and available compiler metadata are described
in PDFJS_BUILD.md. Exact original Emscripten/wasm-pack versions and byte-identical
rebuilds remain unverified reproducibility details; they are not independently
classified as missing covered source. General-purpose unmodified build tools
are distinct from the application and embedded runtime code.

Before binary distribution, package the current notices, check extracted vendor
files against the inventory and verify the exact matching source. Updating this
source snapshot does not update notices in an existing Windows ZIP.

The source snapshot can be checked offline with:

```powershell
python -B tools/check_third_party.py
```

This verifies stored hashes and archive readability and reports the source-audit
status. It does not certify release readiness.

The narrow permission in `LICENSING.md` addresses Microsoft WebView2 sources.
It does not exempt the open-source decoders or other bundled libraries.
