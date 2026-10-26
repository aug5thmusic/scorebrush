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
