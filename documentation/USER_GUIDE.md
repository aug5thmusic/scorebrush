# Using ScoreBrush

[Back to README](../README.md) · [Installation and download verification](INSTALLATION.md)

## Open your three project files

Choose **New Project** and select an existing local folder containing:

- A **source PDF**: the printed or scanned music you are transcribing.
- A **transcription PDF**: the current engraved score you want to check.
- A **LilyPond `.ly` file**: the notation text used to create that engraving.

Assign each file to its role when prompted. **Open Project** opens a saved folder
or recent project. **Restore Backup** imports a backup ZIP. ScoreBrush helps you
review the transcription; your own AI tool or notation editor changes the
LilyPond file and creates the next PDF.

## Mark passages and write notes

In **Proofread**, choose **Draw** (`D`) and drag on the rendered score. The first
mark starts a finding and focuses its note. Further marks join the finding you
are editing. **New finding** (`N`) starts another finding, including one with a
note and no mark. Use **Brush** and **Color** to adjust marks.

Choose **Done**, or press `Enter` or `Shift+Enter` in the note, to finish editing.
**Done & next** (`Ctrl+Enter`) finishes the current finding and prepares another.
Pasted multiline notes keep their line breaks. Notes autosave after 1.5 seconds;
finishing a note or normally closing the app flushes pending changes. Wait for
**Saved to folder** before moving a connected project folder.

There are three finding types:

| Type | Purpose |
| --- | --- |
| **Correction** | Request a change to the transcription. |
| **Footnote** | Request an editorial footnote in the engraved score. |
| **Comment** | Keep an observation without requesting a score change. |

Comments remain in backups and the Comment log, outside correction-approval
counts. Source footnotes remain distinct from corrections.

## Navigate and undo

| Control | Action |
| --- | --- |
| **Navigate** (`V`) | Drag the rendered page to pan; click a mark to select its finding. |
| **Page** arrows or page number | Change the page in either PDF. |
| Zoom menu or `Ctrl+mouse wheel` | Zoom the PDF under the pointer; beyond 50–300% returns to **Fit width**. |
| `Ctrl+Z` | Undo an annotation and its marks together. |
| `Ctrl+Shift+Z` or `Ctrl+Y` | Redo the annotation edit. |
| **Hide marks** (`Ctrl+H`) | Hide or show marks. A new finding makes them visible. |
| **Help → Keyboard shortcuts** | Show the full shortcut reference. |

Editing a saved annotation has its own undo group. Shortcuts are suspended while
typing or during conflicting dialogs, loads or saves, apart from the note-editing
shortcuts described above.

Drag dividers, maximize either score, or collapse **Findings pane** for more room.
**View → Scroll between pages** optionally turns pages at their edges, at most
one page per wheel gesture. Draw mode and active dialogs suspend page turning.
**Help → Welcome & workflow guide** reopens the introduction without replacing
your active review.

## Send corrections and review the result

1. After **Saved to folder**, choose **Send to AI**, then **Copy prompt**. Paste
   the prompt into your own AI tool. Copying stays disabled until the current
   task is verified. The selectable prompt belongs to that saved task.
2. Have your external tool update the configured LilyPond and transcription PDF
   files. ScoreBrush does not run an AI model or compile LilyPond.
3. Choose **Load latest**. ScoreBrush saves pending notes, reads the new files,
   prepares a comparison and saves the new revision.
4. In **Review Changes**, compare each finding against the exact previous and
   new renderings. Choose **Looks correct** (`C`), **Still wrong** (`W`), or a
   source clarification. **Next** (`X`) changes selection without recording a
   decision. **Summary** shows remaining work or prepares the next round.

Viewing a comparison, scrolling or changing zoom never records approval. A
failed decision save remains available for retry. **Check printed source** opens
the corresponding numbered source page, limited to the available pages. Matching
page numbers help navigation; they do not establish a musical match.

ScoreBrush writes the folder handoff to `REVIEW_THIS.md` and `.scorebrush/`.
**Include project path for a local AI agent** adds only the verified project
path. For tools without local-file access, choose **Create ZIP / manual handoff**.
Sharing with an external service is a separate action you perform.

Individual-file projects can use **Workflow → Save AI task ZIP** and **Open AI
response**. On a fresh installation, open the original task ZIP before importing
its structured response so the exact original comparison is available.

## Versions and approved output

**Versions** contains unchanged PDF copies numbered from the initial
transcription filename. Each distinct loaded PDF receives a copy. A change to
notation text alone may share a PDF number while retaining its own revision
identity. **File → Open previous versions** opens that folder in Explorer.
Keep `.scorebrush` for findings, decisions and complete recovery history.

After every correction and footnote is approved and safely saved, **Latest**
contains the exact approved PDF. An unreviewed revision does not replace it.
Conflicting or externally edited files are preserved and reported. Earlier
renderings remain in Versions and project history.

**Open file location** opens the verified project folder in Explorer.
**Copy folder path** copies its verified path. If the folder moves or becomes
inaccessible, use **Connect working folder** to select the matching folder again;
saved reviews and decisions remain intact. Folder access is limited to local
Windows drive paths without redirected path components.

## Saving and backups

**Saved locally** means the review is stored in the application profile.
**Saved to folder** confirms the connected folder save. Use **File → Save backup**
for a portable ZIP containing the current files, findings and decisions. Keep
manual backups on a separate drive.

Connected folders store current edits in `.scorebrush/current-review.json` and
retain score-version archives in `.scorebrush/recovery/`. **Send to AI** prepares
a task tied to that exact review. Sending an unchanged review validates the
current files without republishing retained history. New renderings publish
completed reviews and update the project-root `History.json` index.

Move the **entire project folder**, including `.scorebrush` and `History.json`,
to recover on another computer. **Open Project** restores the retained review,
mark positions, decisions, revision identities, renderings and task/response
history. Recovery uses saved copies even when working files have changed;
**Load latest** compares those external changes afterward. History cannot
reconstruct external edits that were never captured or external LilyPond includes.

The application profile is stored separately from its extracted program files.
See [closing and upgrading](INSTALLATION.md#closing-and-upgrading) before moving
or replacing the application.

## Recovery warnings and storage limits

An unresolved save shows a warning and **Resolve**. Keep the app open and use
retry, reconnect or the offered recovery download. Different folder and local
histories are preserved for recovery instead of silently merged. A damaged
generation may fall back to a verified older one with a warning. A folder
containing only an AI task cannot reconstruct missing review decisions without
the original profile or a backup.

For path or permission errors, check folder access or move the **entire project
folder**, including `.scorebrush` and `History.json`, to a shorter local path.
Keep backups and do not edit individual recovery files.

Recovery shares unchanged files and keeps three complete generations plus the
history needed by the workspace. Its limits are 512 MiB / 5,000 unique objects,
5,000 retained review/evidence records and 1,000 task/response handoffs. Reaching
a limit preserves committed history and reports pending work. A full backup can
also exceed a capacity limit; an error is not a successful export.

Large PDFs and long histories can take time to load, save or recover. Wait for
verified saving before moving a folder or closing through recovery controls.
Use synthetic examples in bug reports and follow the
[security policy](https://github.com/aug5thmusic/scorebrush/blob/v0.1.0/SECURITY.md)
for private vulnerability reporting.
