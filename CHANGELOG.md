# Changelog

## 0.1.0 — 2026-10-26

Initial release for Windows x64.

- Compare source and transcription PDFs, annotate findings, and prepare a local
  handoff for an external AI tool.
- Review corrections against exact previous and new renderings, retaining
  decisions, numbered PDF versions and approved output.
- Save reviews locally and to connected folders, with portable backups,
  verified recovery and save checks before closing.
- Run locally with Microsoft's shared Stable Evergreen WebView2 Runtime;
  ScoreBrush has no accounts, telemetry or upload service.
- Include offline license notices and matching source. ScoreBrush's own work is
  licensed under AGPL-3.0-or-later with the additional permissions in
  [LICENSING.md](LICENSING.md); third-party materials retain their own terms.

The Windows executable is unsigned. ScoreBrush does not run an AI model or
compile LilyPond. Large PDFs and long histories can take time to load or save;
see [README.md](README.md) for requirements, usage and recovery limits.

