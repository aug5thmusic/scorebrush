# Upstream source materials

These files are source material for inspection and modification. They are not
dependencies to install. Upstream licenses and copyright notices remain inside
the archives. `source-provenance.json` records their origins, hashes and the
scope of verification. `vendor-inventory.json` pins the bundled runtime files.

## Included sources

- PDF.js 5.6.205: `src/`, `external/`, license, authors, package/lock files and
  build entry point. All 502 selected files match their upstream Git blob IDs.
  The large test-PDF corpus and separate viewer application are omitted.
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
- `pdfjs-5.6.205-library-inputs.tar.gz` supplements the PDF.js archive with the
  original `l10n/en-US/viewer.ftl`, verified against the release Git blob. Its
  MPL-2.0 source notice is retained. [PDFJS_BUILD.md](PDFJS_BUILD.md) documents
  a library-only build task, retained scripts and toolchain information.
- OpenJPEG: the complete 2.5.4 source at commit
  `6c4a29b00211eb0430fa0e5e890f1ce5c80f409f`, plus PDF.js wrapper
  `b47d31b8355a3863ab37282ceeb5183f7ac2761c`, including its buffer-stream patch.
- JBIG2/CCITT: PDF.js wrapper `1e945e7552561c9b45e6d2c7d1a359ea82afc5b7`,
  plus 100 PDFium source/header/notice files at its pinned commit
  `0455e822ded1a5537d826703988e986a33d2d4a1`. The selection follows the wrapper's
  compilation units and their quoted includes. Every selected file matches its
  upstream Git blob ID. The partial transport archive is not redistributed.
  Emscripten supplies `emscripten.h`; PartitionAlloc and Skia includes are
  guarded by macros that this wrapper does not define.
- qcms: PDF.js wrapper `fc23a407f1ed9ccfea15875d27e0936dcc798a1f` and all 15
  registry source crates in its Cargo.lock, including qcms 0.3.0 and
  wasm-bindgen 0.2.100. Each crate matches its Cargo.lock SHA-256 checksum.

The wrapper revisions correspond to the decoder updates recorded in the
PDF.js release history. This is source provenance, not a claim that rebuilding
with those inputs has reproduced the shipped WASM bytes. Upstream Dockerfiles
use floating toolchain tags, and the qcms Dockerfile runs `cargo update`.
Rebuilders should preserve the supplied lock file and record their toolchain
versions instead of silently resolving newer inputs.

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
