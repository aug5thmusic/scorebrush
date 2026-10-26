# Contributing to ScoreBrush

ScoreBrush is a local Windows application for reviewing music transcriptions.
Repository: https://github.com/aug5thmusic/scorebrush.

## Licensing contributions

Submit only material you have the right to contribute. By intentionally
submitting a contribution for inclusion, you agree to provide it under
AGPL-3.0-or-later with the additional permissions in [LICENSING.md](LICENSING.md).
Keep existing author notices. Identify third-party material, its source,
version and license; do not replace upstream notices with ScoreBrush notices.
No copyright assignment is requested.

## Working locally

See [DEVELOPMENT.md](DEVELOPMENT.md) for build requirements and supported checks.
Keep changes focused and explain the user-visible behavior and verification.
Use synthetic geometry-only PDFs, invented notes and disposable profiles.
Do not submit personal scores, transcription folders, browser profiles, logs
containing private paths, or screenshots of private work.

Preserve the stable virtual origin, storage names, revision identities, retained
renderings, folder bindings, save-before-close checks and validated handoffs.
Treat filenames, imported text, ZIP entries and AI responses as untrusted data.
Keep the native bridge narrow, origin-checked and schema-checked. Do not add
general shell execution or unrestricted filesystem access.

The app uses shared Stable Evergreen WebView2. Preserve Windows policy,
sandboxing, the verified bootstrapper and non-elevating setup behavior.
Do not replace it with a bundled full runtime or browser-channel fallback.

## Reporting issues

For ordinary bugs, include the exact version, Windows version, reproduction
steps, expected behavior and what happened. Prefer a small synthetic project.
Redact paths, filenames and screenshots before sharing. Use the repository issue template. See [SECURITY.md](SECURITY.md) for vulnerabilities.
