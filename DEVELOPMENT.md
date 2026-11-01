# Developing ScoreBrush

The application uses HTML, CSS and JavaScript modules under `app/`, hosted by
C# WinForms and WebView2. Python, Node.js and test servers are development tools;
the production application does not invoke them.

## Requirements

- Windows x64 with .NET Framework 4.8 or compatible 4.8.1 and its Framework64
  C# compiler, located below `%WINDIR%`.
- Python 3.10 or later for standard-library packaging scripts.
- Node.js 22 or later for checks and browser-test orchestration.
- Playwright and Microsoft Edge for browser tests.
- Shared Stable Evergreen WebView2 for native checks.

Checks do not install dependencies. If Playwright is not importable as
`playwright`, set `SCORE_DESK_PLAYWRIGHT` to an existing installation's
`index.mjs`. Set `SCORE_DESK_BROWSER_CHANNEL=msedge` for the supported runner.
Browser tests use fresh contexts and temporary loopback fixture servers.

## Checks

Run from the source root:

```powershell
node tests/check-local.mjs
node --test tests/private-boundary.test.mjs tests/folder-io.test.mjs tests/folder-workspace.test.mjs
node --test tests/native-folder.test.mjs tests/native-bridge.test.mjs tests/native-services.test.mjs
node --test tests/efficiency-integrity.test.mjs tests/storage-inputs.test.mjs tests/storage-evidence.test.mjs
python -B -m unittest discover -s tests -p test_source_export.py
python -B tools/check_third_party.py
$env:SCORE_DESK_BROWSER_CHANNEL='msedge'
node tests/browser-tests.mjs
```

Use the supported suite selection, not a glob of QA files. Use synthetic PDFs,
notes, folders and disposable profiles. Never test against real scores, clear
an existing profile, or reload an active review. Generated diagnostics and test
profiles are excluded from source exports and runtime packages.

For checkpoint, recovery, startup or migration changes, select the related tests:

```powershell
node --test tests/current-checkpoint.test.mjs tests/folder-recovery.test.mjs tests/database-presence.test.mjs tests/followup-serialization.test.mjs tests/project-history.test.mjs tests/project-directory.test.mjs tests/current-handoff.test.mjs
node tests/browser-tests.mjs --suites=startup-storage,recovery-edit,current-review,current-handoff,interrupted-save,interrupted-archive,folder-settings,project-entry,new-project-cancel
```

The native-services runner compiles a C# test executable with the existing
Framework compiler. Its disposable folders, profiles and junctions exercise
path/proof restrictions and grant recovery. It does not build the application
or open Explorer. `tests/native-folder-webview.test.mjs` verifies directory-handle
and proof behavior in real WebView2.

For compatibility testing, `SCOREBRUSH_LEGACY_PROJECT_DIRECTORY` can select an
unchanged earlier `app/project-directory.js` module. The migration test checks
that older readers reject unsupported archive formats before writing.

Performance measurements require matched synthetic workloads, consistent
profiles and runtime/viewport settings, sequential runs, and separate reporting
of instrumentation overhead. Keep diagnostic runs separate from timed samples.

## Windows package

`app/build-info.json` supplies the application version and build date. The full
SemVer is the informational version; Windows numeric versions map its core to
`major.minor.patch.0`. Create a `builds` directory, then run:

```powershell
python -B prepare_release.py builds/ScoreBrush-NEW-VERSION-Windows-x64.zip
python -B tests/test_release.py builds/ScoreBrush-NEW-VERSION-Windows-x64.zip
```

The builder refuses existing output files. It uses pinned Microsoft WebView2
SDK and bootstrapper downloads, cached under `.runtime/downloads`. Missing
archives are downloaded and checked before use; the bootstrapper also requires
its pinned Microsoft Authenticode signer. Packaging compiles the native host,
includes runtime assets and notices, and writes per-file hashes to `RELEASE.json`.
It does not install the downloaded components. The executable is unsigned.

The SDK version/hash are in `prepare_release.py`; bootstrapper provenance is in
`runtime-lock.json`. `SCOREBRUSH_BUILD_POWERSHELL` can select an existing PowerShell
for signature verification. Investigate changed download bytes before changing
pins. Calculate the final ZIP's SHA-256 after packaging and any signing step.
Never replace a distributed asset with different bytes under the same identity.

Verify the exact extracted executable using an explicitly disposable
`--test-data` profile. Keep the normal profile untouched. A successful build or
development test does not establish clean-machine, installation-policy or
security-product compatibility.

The dependency-source and notice audit is complete for the retained versions;
see [third-party/README.md](third-party/README.md) for evidence and reproducibility
limits. Before binary distribution, verify that the package includes the current
notices and exact matching Corresponding Source.

## Source export

`public-source-files.json` explicitly lists the source, tests, documentation,
artwork and dependency materials included in an export. Review additions before
adding them to that list and the corresponding `.gitignore` allowlist.
Keep first-party text in LF form before export; pinned upstream/license/artwork
bytes follow the exclusions in `.gitattributes`. The generated
`SOURCE_MANIFEST.json` is tracked separately and does not hash itself.

```powershell
python -B prepare_source.py public-source/scorebrush-source
```

The exporter creates a new directory, sibling ZIP and checksum file. It refuses
existing outputs, unsafe destinations, redirected paths and unlisted content.
`SOURCE_MANIFEST.json` records every exported payload's SHA-256 and size. Source
exporting does not build the executable or contact the network. Inspect the final
archive's contents, licenses and source correspondence before distribution.

## Storage and security

Keep `https://scorebrush.invalid`, `%LOCALAPPDATA%/ScoreBrush/Standalone/WebView2`
and database names stable. Native folder operations require an exact trusted
origin, validated schema, one-use proof and path/reparse checks. Preserve exact
revision identity, old render snapshots, decisions, folder bindings, atomic
READY/manifest validation and guarded closing.

Use shared Stable Evergreen WebView2. Preserve Windows policy and sandboxing;
do not request elevation, replace the runtime or use a browser channel as a
production fallback.

## Artwork

PNG and SVG sources are in `design-assets/scorebrush-official/`, with hashes in
`source-manifest.json`. Runtime assets are under `app/branding/`.
`tools/prepare_branding.py` uses Pillow to derive the Windows ICO from the complete
primary PNG and verify its frames. This optional tool is not required for an
ordinary application build.

## Review fixes, October 27, 2026

New Project now separates review ownership from input content hashes. New folder
projects use a project-scoped workspace key; existing saved keys, revision IDs,
input hashes, browser databases and profiles remain unchanged. Reopening a known
folder uses its retained workspace. Identical inputs in a second New Project do
not resume the first project's corrections or collect its handoff history.

Packages carrying explicit project ownership use `score-desk-package` version 2.
The current reader accepts legacy version 1 packages. Older readers reject version
2 rather than silently treating a scoped review as a shared content-key review.
Imports validate project ownership and parent links before using local history.
Returned tasks import as an ordinary baseline within their own project; they do
not impersonate a returned review's full decision state.

Backup, emergency recovery and task export share the importer's path, entry,
file and JSON limits. STORE ZIP preflight includes header bytes; the serialized
archive is checked again before offering a download or marking work protected.
Recovery accepts the exact installed-app task or folder-delivery projection of an archived task,
which restores older zero-finding rounds without relaxing arbitrary byte checks.
Interrupted baseline reopening and stale finished-PDF receipt detection have
regressions covering restart, preservation of existing reviews and explicit retry.

Viewer and folder-preview rendering use a uniform bounded scale: at most 32,768
CSS pixels per axis and 8,192 backing pixels per axis / 16 million total pixels.
Fit width can be smaller than 15 percent. Mark coordinates and original PDFs are
unchanged. Export rejects unsupported canvas dimensions before allocating them.
Historical strokes and numbered markers multiply the caller's opacity.

Native policy validation uses the effective WebView2 hive/application precedence
while retaining the Stable runtime and fixed-profile restrictions. Menu refresh
uses lightweight returned-state access, recent projects hydrate only the selected
handoff, and journal finding differences use ID maps instead of nested searches.
Project selection reserves its busy guard before loading that selected handoff.
Delayed hydration, failures and cancellation share the guarded cleanup path;
ordinary folder pickers still start synchronously from the user action.

Run the supported browser suite plus these named regression suites:

```powershell
node tests/browser-tests.mjs --suites=project-isolation,recent-project-selection,zero-finding-recovery,export-limits,finished-resume,pending-baseline,rendering-limits,folder-settings,application-shell
node --test tests/project-identity.test.mjs tests/recovery-project-identity.test.mjs tests/export-limits.test.mjs tests/recovery-task-variant.test.mjs tests/finished-pdf.test.mjs tests/project-history.test.mjs tests/pdf-rendering.test.mjs tests/annotation-opacity.test.mjs tests/runtime-policy.test.mjs
```

Use the existing Playwright installation and disposable Edge contexts described
above. Runtime-policy tests use synthetic registry readers and an already cached,
pinned SDK; they do not mutate registry policy or install dependencies. These are
source fixes; a distributable executable and clean-machine release verification
remain separate steps.

The `recent-project-selection` suite uses disposable browser contexts and synthetic
folders. It delays selected-project hydration, attempts competing menu actions and
repeated selection requests, and checks cancellation, error reporting, retry,
active-review preservation and synchronous picker activation.

### Known legacy recovery test limitations

These pre-existing failures are not passing acceptance checks for a candidate:

- `current-baseline-legacy`: the simulated r8/r9 interrupted session lacks the
  pending-baseline marker. Retry reaches a recovery conflict and preserves both
  sides, but cannot repair that session. This remains an open product limitation.
- `clean-resume`: its missing-history case expects automatic archive repair;
  checkpoint resume does not perform that repair. The supported `current-review`
  suite covers explicit output repair. The older expectation remains unresolved.
- `fast-resume`: an older fixture assumes ordinary edits leave an unused immutable
  annotation object. The fixture fails before exercising its intended scenario.

All three failed identically on the retained pre-fix source during the October 27
review. Preserve their evidence and report them separately from supported passing
suites; changing the candidate version does not resolve them.

### PDF.js 6 compatibility

The local candidate updates PDF.js to 6.4.299 with its matching worker, decoder,
font, CMap and ICC assets. See [DEPENDENCIES.md](DEPENDENCIES.md) and
[third-party/PDFJS_BUILD.md](third-party/PDFJS_BUILD.md) for release verification,
source provenance and remaining rebuild limitations.

PDF.js 6 removes document-level `destroy()` and viewport rectangle conversion.
ScoreBrush disposes documents through their public `loadingTask.destroy()` API;
an explicitly supplied shared worker remains owned by the application. Finding
outlines transform their two opposite corners with `convertToViewportPoint()`.
These compatibility changes do not rewrite PDF bytes or stored annotation points.

Run the default browser suite for brush, comparison, zoom, annotation, export and
backup coverage, plus the named `pdf-decoder`, `rendering-limits`,
`project-isolation`, `recent-project-selection`, `zero-finding-recovery`,
`current-review`, `recovery-edit`, `interrupted-save` and `interrupted-archive`
suites. Verify the exact extracted Windows candidate separately with an explicit
disposable `--test-data` profile. Passing source tests does not close outstanding
Windows release acceptance or update already distributed 0.1.0 binaries.
