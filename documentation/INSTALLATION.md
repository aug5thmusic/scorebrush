# Installing ScoreBrush 0.1.0

[Back to README](../README.md) · [User guide](USER_GUIDE.md)

## Download and requirements

The intended publication links are the
[Windows x64 download](https://github.com/aug5thmusic/scorebrush/releases/download/v0.1.0/ScoreBrush-0.1.0-Windows-x64.zip)
and the [v0.1.0 release page](https://github.com/aug5thmusic/scorebrush/releases/tag/v0.1.0).
They target the planned release and may not be available yet.

ScoreBrush supports Windows 10 22H2 x64 and Windows 11 x64 with .NET Framework
4.8 or compatible 4.8.1. It uses Microsoft's shared **Stable Evergreen WebView2
Runtime**. Python, Node.js and a local web server are not needed to run it.

The release attachments are:

- `ScoreBrush-0.1.0-Windows-x64.zip`: the Windows application.
- `scorebrush-0.1.0.zip`: its exact matching source archive.
- `SHA256SUMS.txt`: checksums for those two attached ZIPs.

GitHub's automatic **Source code** archives are separately generated containers;
they are not the source ZIP identified in this checksum file. Matching source,
license terms and third-party notices accompany the release. See the
[dependency and source requirements](../DEPENDENCIES.md#source-requirements).

## Verify the download

Download the ZIPs and `SHA256SUMS.txt` from the official release. Open PowerShell
in the directory containing your downloads and calculate their SHA-256 hashes:

```powershell
Get-FileHash -LiteralPath '.\ScoreBrush-0.1.0-Windows-x64.zip' -Algorithm SHA256
Get-FileHash -LiteralPath '.\scorebrush-0.1.0.zip' -Algorithm SHA256
```

Compare each `Hash` with the matching filename in `SHA256SUMS.txt`. A match
confirms that the archive matches that checksum; it does not prove software
safety. If a hash differs, do not use that archive as the verified release.

## Extract and open

Extract the **entire** Windows ZIP into a writable local folder, then open
**ScoreBrush/ScoreBrush.exe**. Keep all extracted files together. Do not run the
executable from inside the ZIP.

The executable is unsigned, so Windows or your browser may show a reputation
warning. If Windows offers **More info → Run anyway**, use it only after
verifying the official download and choosing to trust it. Dialogs vary, and
Windows or organizational protections may prevent continuation.

An existing compatible WebView2 Runtime needs no setup or internet connection.
If it is missing, ScoreBrush verifies and starts the included official Microsoft
bootstrapper. Initial setup needs internet and requests no elevation; Windows
installation policies still apply. Errors offer **Retry** and **Close**.
Closing stops ScoreBrush's wait; Microsoft setup may finish in the background.
ScoreBrush does not replace an installed runtime or fall back to a browser
channel. See [dependency details](../DEPENDENCIES.md).

The first window opens maximized. Later launches remember its size and position.
Opening another copy focuses the running window. Choose **New Project** to
start, **Open Project** to reopen a saved folder or recent project, or
**Restore Backup** to import a backup ZIP.

## Closing and upgrading

Normal closing verifies pending local and folder saves. If saving fails,
ScoreBrush offers recovery choices instead of silently exiting. Keep the app
open while resolving a save warning; see [saving and recovery](USER_GUIDE.md#saving-and-backups).

Close the running window before moving or upgrading the extracted application.
Local review storage is separate from the application folder, under
`%LOCALAPPDATA%\ScoreBrush\Standalone\WebView2`. Preserve that profile and your
project folders or backups when upgrading. Do not remove a profile while a save
is pending. Deleting it removes the local work it contains.

## Local storage and connections

The internal address `https://scorebrush.invalid` maps directly to bundled
files. It identifies local storage and security boundaries; it is not a website.
ScoreBrush has no HTTP server, listening port, accounts, telemetry, upload
endpoint or AI API. Its Help menu repository link opens the default browser
only when clicked. WebView2 and its updater may contact Microsoft while online.

Your AI tool is separate. You decide whether to give it local files or upload a
handoff, and its own privacy terms apply. For score folders, backups and capacity
limits, read the [user guide](USER_GUIDE.md).
