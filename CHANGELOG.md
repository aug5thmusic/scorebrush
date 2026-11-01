# Changelog

## 0.1.1 — 2026-11-01

- Export retained correction evidence as a Research ZIP with readable current
  and historical score files, exact revision mappings and an optional standalone
  reader. Shared historical assets and standard ZIP compression reduce duplicate
  data while preserving original objects, decisions and evidence.
- Update PDF.js and its matching worker/resources to 6.4.299, with refreshed
  dependency notices and matching source materials.
- Improve project-selection isolation, backup/recovery validation, export and
  rendering limits, and save efficiency as detailed in DEVELOPMENT.md.

Promotes the tested 0.1.1-rc.4 application without behavior changes. The maintainer
reported successful use on a couple of scores with no issues encountered.
The executable remains unsigned. Clean-Windows installation, missing-runtime
setup and enterprise-policy variations remain unverified. Known legacy recovery
limitations remain documented in DEVELOPMENT.md; this release does not resolve
the r8/r9 interrupted-session repair or older clean-resume/fast-resume test cases.

## 0.1.1-rc.4 — 2026-10-31 (local candidate)

- Share readable historical score files by exact asset identity, retaining every
  revision/role association and the separate convenient current role files.
- Compress Research ZIPs with standard DEFLATE where useful; retain STORE for
  entries that would exceed the existing expansion-ratio limit. Ordinary backup
  and AI-handoff exports keep their existing behavior.
- Validate shared mappings and continue reading earlier RC2/RC3 research exports.
  History, episodes, original objects, judgments and retained evidence are unchanged.

This local candidate retains the inherited release-acceptance limitations below.

## 0.1.1-rc.2 — 2026-10-31 (local candidate)

- Export retained correction evidence with exact assets and a standalone reader.
- Include the reader's license and additional permissions in research exports;
  preserve compatibility with earlier format-1 research archives.
- Correct new History coverage declarations while retaining legacy backup support.

This local candidate retains the inherited release-acceptance limitations below.

## 0.1.1-rc.1 — 2026-10-27 (local candidate)

- Reserve project selection before recent-project hydration, preserving the active
  review on failure or cancellation and preventing overlapping pickers.
- Update PDF.js and its matching worker/resources to 6.4.299; adapt document
  disposal and finding-outline transforms to its supported APIs.
- Include the October 27 project-isolation, backup/recovery, export-limit,
  rendering-limit and efficiency fixes documented in DEVELOPMENT.md.
- Refresh dependency notices, hashes and matching source materials. Existing
  distributed 0.1.0 binaries still require a verified published security update.

This candidate has not completed public-release acceptance. The documented r8/r9
interrupted-session repair, clean-resume and fast-resume limitations remain open.

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

