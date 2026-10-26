# Packaged dependencies

ScoreBrush supports Windows 10 22H2 x64 and Windows 11 x64. The .NET
Framework 4.8 (or compatible 4.8.1) and Windows desktop components come with those
systems. Extract into a writable local folder. The app is unsigned.

| Component | Distribution / license |
| --- | --- |
| ScoreBrush WinForms host | ScoreBrush.exe, ScoreBrush.exe.config; AGPL-3.0-or-later with the permissions in LICENSING.md; LICENSE |
| Microsoft WebView2 SDK 1.0.4258.31 | Core/WinForms assemblies and x64 WebView2Loader.dll; WebView2-LICENSE.txt |
| Microsoft Evergreen bootstrapper 1.3.299.15 | setup/MicrosoftEdgeWebview2Setup.exe, 1,876,736 bytes; licenses/WebView2-Evergreen-LICENSE.txt |
| Microsoft Evergreen WebView2 Runtime | Shared Windows installation discovered by the SDK; not included in this ZIP |
| PDF.js, PDF-lib, JSZip | app/vendor; PDFJS-LICENSE, PDF-LIB-LICENSE.md, JSZIP-LICENSE.md |
| PDF.js CMaps, standard fonts, ICC and WASM decoders | app/vendor/cmaps, standard_fonts, iccs, wasm; upstream licenses included |
| Sora and Bricolage Grotesque fonts | app/vendor/fonts; bundled OFL licenses |

RELEASE.json lists SHA-256 for every shipped file except itself. runtime-lock.json
records the official bootstrapper link, resolved Microsoft download URL, SHA-256,
Microsoft signer certificate and license source. Packaging checks Authenticode
trust and publisher. Before executing setup, the native host verifies the pinned
SHA-256, Windows WinVerifyTrust result (including revocation policy), and pinned
Microsoft signer while holding the file against replacement. No PowerShell,
Python, Node, or other helper is needed for production verification.

A compatible shared runtime starts immediately, without running or verifying the
bootstrapper and without requiring internet. Only a missing runtime starts
Microsoft's bootstrapper with /silent /install. This first-time download requires
internet. ScoreBrush requests no elevation; Microsoft documents that a normal
process attempts a per-user installation, which an existing machine-wide Edge
Updater may replace with a machine-wide installation. Windows policy still applies.
The app uses a native progress indicator, keeps the UI responsive, provides Retry
and Close after errors, and verifies runtime discovery again after setup exits.
An exit code alone never establishes success. Waiting is bounded to five minutes;
Retry reuses an outstanding installer rather than starting a second copy. Close
stops waiting; Microsoft setup may finish in the background. ScoreBrush does not
kill shared updater processes or modify/uninstall an installed runtime.

Discovery and initialization use ReleaseChannels.Stable and no executable-folder
argument. Edge/Chrome browser channels are not fallbacks. Conflicting WebView2
policies produce a clear error rather than being changed or bypassed. An installed
runtime that is too old is left alone; allow Microsoft's updater to finish or ask
an administrator. Details are retained in scorebrush-runtime.log in the app profile.
Normal operation has no application server/listener. App assets map locally at
https://scorebrush.invalid. Profile and database names remain unchanged.

Microsoft's Evergreen updater maintains the shared runtime. ScoreBrush adds no
updater service or scheduler and adopts runtime changes on normal restart; it
never force-reloads an active review. When refreshing the bundled bootstrapper,
maintainers download from the official link, verify Microsoft Authenticode trust,
review and update runtime-lock.json, then rebuild and test. Do not silently accept
a changed download hash. The application version and build date are recorded in
app/build-info.json.

Official guidance:
- https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution
- https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/working-with-local-content
- https://developer.microsoft.com/en-us/microsoft-edge/webview2/

Build/test tools (Python, Node, Playwright and the Windows Framework compiler)
are development-only and are not included or invoked by the app.

ScoreBrush has no telemetry, upload endpoint or online content dependency.
WebView2 and Microsoft's updater can contact Microsoft for updates, diagnostics
or security while online. Automatic WebView2 crash uploads are disabled with
IsCustomCrashReportingEnabled; the host sends no custom crash reports. SmartScreen,
sandboxing and Windows security settings remain enabled. Offline app operation
does not imply zero Microsoft runtime background traffic while online.
https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/data-privacy

See THIRD_PARTY_NOTICES.md for the component license inventory and LICENSING.md
for ScoreBrush’s grant and Microsoft WebView2 additional permission.

## Source requirements

The dependency-source and notice audit is complete for the retained versions.
The source export includes the original `@pdf-lib/standard-fonts` 1.0.0
TypeScript, preparation scripts, font/encoding
inputs and applicable Adobe, Unicode and inherited-code notices. The readable
browser-pack 6.0.2 loader and its MIT notice are retained and matched to JSZip's
embedded loader. `third-party/README.md` and `third-party/source-audit.json`
record the material, correspondence evidence and reproducibility limits.

Binary distribution requires a package containing these current notices and
verification against its matching source. A source-only notice update does not
update an existing Windows ZIP. Dependency-source readiness is a technical audit
conclusion, not legal certification or authorization to distribute.

The PDF.js library's selected source inputs and build task have been reviewed
statically. Decoder sources, patches, control scripts and available toolchain
information are retained. A dependency rebuild has not been performed; unknown
original compiler versions and byte-identical rebuilds are reproducibility
uncertainties, not automatic missing-source findings. Unmodified general-purpose
build tools are distinct from application source and embedded runtime code.

Preserve the notices required by each component's terms and supply exact matching
source with any binary distribution. Hash verification establishes integrity, not
source completeness or legal certification.
