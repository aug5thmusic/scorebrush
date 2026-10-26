# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Auggie (@aug5thmusic).
# Additional permissions: see LICENSING.md at the source root.
"""Create a Windows x64 ZIP with the verified Microsoft Evergreen bootstrapper."""
from __future__ import annotations
import argparse
import hashlib
from build_info import load_build_info, native_metadata
from io import BytesIO
import json
import os
import re
import uuid
from pathlib import Path
import struct
import subprocess
import tempfile
from urllib.request import urlopen
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parent
ROOT_FILES = ("README.md", "LICENSE", "LICENSING.md", "THIRD_PARTY_NOTICES.md", "DEPENDENCIES.md", "runtime-lock.json", "licenses/WebView2-Evergreen-LICENSE.txt", "licenses/WebView2-SDK-LICENSE.txt", "ScoreBrush.exe.config",
              "documentation/INSTALLATION.md", "documentation/USER_GUIDE.md",
              "documentation/images/proofreading.png", "documentation/images/workflow.png")
WEBVIEW_VERSION = "1.0.4258.31"
WEBVIEW_URL = f"https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/{WEBVIEW_VERSION}/microsoft.web.webview2.{WEBVIEW_VERSION}.nupkg"
WEBVIEW_SHA256 = "56f7f4b8bf9aee4b8efefbbdd4f67d5f74ebd1b100ed0806da71bf76af481aa9"


def webview_files(root: Path = ROOT) -> dict[str, bytes]:
    cache = root / '.runtime/downloads' / f'microsoft.web.webview2.{WEBVIEW_VERSION}.nupkg'
    if not cache.exists():
        with urlopen(WEBVIEW_URL, timeout=60) as response:
            data = response.read(32 * 1024 * 1024)
        if hashlib.sha256(data).hexdigest() != WEBVIEW_SHA256:
            raise ValueError('WebView2 SDK download does not match the pinned SHA-256.')
        cache.parent.mkdir(parents=True, exist_ok=True)
        with cache.open('xb') as stream:
            stream.write(data)
    data = cache.read_bytes()
    if hashlib.sha256(data).hexdigest() != WEBVIEW_SHA256:
        raise ValueError('WebView2 SDK cache does not match the pinned SHA-256.')
    with ZipFile(BytesIO(data)) as archive:
        return {name: archive.read(source) for name, source in {
            'Microsoft.Web.WebView2.Core.dll': 'lib/net462/Microsoft.Web.WebView2.Core.dll',
            'Microsoft.Web.WebView2.WinForms.dll': 'lib/net462/Microsoft.Web.WebView2.WinForms.dll',
            'WebView2Loader.dll': 'runtimes/win-x64/native/WebView2Loader.dll',
            'WebView2-LICENSE.txt': 'LICENSE.txt'}.items()}
LOCK = json.loads((ROOT / 'runtime-lock.json').read_text(encoding='utf-8'))
BOOTSTRAPPER = LOCK['bootstrapper']


def release_files(root: Path = ROOT) -> list[Path]:
    root = root.resolve()
    files = [root / name for name in ROOT_FILES]
    files.extend(path for path in (root / "app").rglob("*")
                 if path.is_file() and "qa" not in path.relative_to(root / "app").parts
                 and "__pycache__" not in path.parts)
    for path in files:
        if not path.is_file() or path.is_symlink() or not path.resolve().is_relative_to(root):
            raise ValueError(f"Missing or unsafe runtime file: {path}")
    return sorted(files, key=lambda path: path.relative_to(root).as_posix())


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def acquire_bootstrapper(cache: Path) -> Path:
    if not cache.exists():
        cache.parent.mkdir(parents=True, exist_ok=True)
        with urlopen(BOOTSTRAPPER['resolvedUrl'], timeout=60) as response:
            data = response.read(10 * 1024 * 1024)
        if hashlib.sha256(data).hexdigest() != BOOTSTRAPPER['sha256']:
            raise ValueError('Microsoft bootstrapper download changed; review provenance before refreshing the lock.')
        with cache.open('xb') as stream:
            stream.write(data)
    if digest(cache) != BOOTSTRAPPER['sha256'] or cache.stat().st_size != BOOTSTRAPPER['bytes']:
        raise ValueError('Microsoft bootstrapper does not match its pinned integrity record.')
    script = "$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath $args[0]; if($s.Status -ne 'Valid' -or $s.SignerCertificate.Thumbprint -ne '" + BOOTSTRAPPER['signerThumbprint'] + "' -or $s.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation'){throw 'Invalid Microsoft bootstrapper signature'}"
    import shutil
    shell = os.environ.get('SCOREBRUSH_BUILD_POWERSHELL') or shutil.which('pwsh') or 'powershell.exe'
    subprocess.run([shell, '-NoProfile', '-Command', "& {"+script+"} '"+str(cache).replace("'", "''")+"'"], check=True)
    return cache


def launcher_bytes(root: Path) -> bytes:
    manifest_text, attributes_text = native_metadata(load_build_info(root), (root/'launcher.manifest').read_text(encoding='utf-8'))
    compiler = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Microsoft.NET/Framework64/v4.0.30319/csc.exe"
    if not compiler.is_file():
        raise RuntimeError("Package creation requires the Windows .NET Framework compiler already included with Windows 10/11.")
    with tempfile.TemporaryDirectory(prefix="scorebrush-launcher-") as temporary:
        output = Path(temporary) / "ScoreBrush.exe"
        for name, content in webview_files(root).items():
            (Path(temporary) / name).write_bytes(content)
        manifest = Path(temporary) / 'launcher.manifest'
        manifest.write_text(manifest_text, encoding='utf-8')
        attributes = Path(temporary)/'AssemblyInfo.cs'
        attributes.write_text(attributes_text, encoding='utf-8')
        runtime_info = Path(temporary)/'RuntimePackage.cs'
        runtime_info.write_text('static class RuntimePackage { internal const string BootstrapperSHA256="'+BOOTSTRAPPER['sha256']+'"; internal const string BootstrapperSigner="'+BOOTSTRAPPER['signerThumbprint']+'"; }', encoding='utf-8')
        command = [str(compiler), "/nologo", "/codepage:65001", "/target:winexe", "/platform:x64", "/optimize+", "/debug-", "/win32manifest:"+str(manifest), "/win32icon:"+str(root/"app/branding/scorebrush.ico"), "/r:System.Windows.Forms.dll", "/r:System.Drawing.dll", "/r:System.Web.Extensions.dll", "/r:" + str(Path(temporary) / 'Microsoft.Web.WebView2.Core.dll'), "/r:" + str(Path(temporary) / 'Microsoft.Web.WebView2.WinForms.dll'), "/out:" + str(output), str(root / "launcher.cs"), str(root/'native-services.cs'), str(root/'runtime-setup.cs'),str(root/'window-placement.cs'), str(runtime_info), str(attributes)]
        command.insert(1, '/r:System.Security.dll')
        compiled = subprocess.run(command, capture_output=True, text=True)
        if compiled.returncode:
            raise RuntimeError(compiled.stdout + compiled.stderr)
        data = bytearray(output.read_bytes())
    # Normalize volatile metadata in this unsigned, PDB-free launcher only.
    source_hash = hashlib.sha256(b''.join((root/name).read_bytes() for name in ('launcher.cs','native-services.cs','runtime-setup.cs','window-placement.cs','runtime-lock.json','launcher.manifest','build_info.py','app/build-info.json','app/branding/scorebrush.ico'))).digest()
    pe = struct.unpack_from("<I", data, 0x3c)[0]
    struct.pack_into("<I", data, pe + 8, 0)
    metadata = data.index(b"BSJB")
    version_size = struct.unpack_from("<I", data, metadata + 12)[0]
    streams = metadata + 16 + version_size
    count = struct.unpack_from("<H", data, streams + 2)[0]
    cursor = streams + 4
    found = False
    for _ in range(count):
        offset, size = struct.unpack_from("<II", data, cursor)
        end = data.index(0, cursor + 8)
        name = bytes(data[cursor + 8:end])
        if name == b"#GUID":
            if size != 16:
                raise ValueError("Unexpected compiler GUID table; review deterministic normalization.")
            data[metadata + offset:metadata + offset + 16] = source_hash[:16]
            found = True
        cursor = (end + 4) & ~3
    if not found:
        raise ValueError("Compiler GUID table is missing.")
    # The Framework compiler also names its string-switch helper with a random
    # GUID. Normalize that fixed-width metadata name in our unsigned image.
    helper = b'<PrivateImplementationDetails>{' + str(uuid.UUID(bytes=source_hash[:16])).upper().encode('ascii') + b'}'
    data = re.sub(rb'<PrivateImplementationDetails>\{[0-9A-Fa-f-]{36}\}', helper, data)
    return bytes(data)


def prepare_release(output: Path, root: Path = ROOT, bootstrapper_cache: Path | None = None) -> int:
    root, output = root.resolve(), output.resolve()
    files = release_files(root)
    if output.is_relative_to(root / "app") or output in files:
        raise ValueError("Choose an output outside the app assets.")
    if output.exists():
        raise FileExistsError(output)
    build = load_build_info(root)
    bootstrapper = acquire_bootstrapper(bootstrapper_cache or root / '.runtime/downloads/MicrosoftEdgeWebview2Setup.exe')
    payloads = {path.relative_to(root).as_posix(): path for path in files}
    payloads['setup/MicrosoftEdgeWebview2Setup.exe'] = bootstrapper
    payloads['ScoreBrush.exe'] = launcher_bytes(root)
    payloads.update(webview_files(root))
    provenance = {**build, 'runtime': LOCK, 'launcher': 'Unsigned x64 Windows GUI; .NET Framework 4.8 supplied by supported Windows', 'platform': 'Windows 10 22H2 x64 / Windows 11 x64', 'origin': 'https://scorebrush.invalid', 'storage': '%LOCALAPPDATA%/ScoreBrush/Standalone/WebView2', 'webview2Sdk': {'version': WEBVIEW_VERSION, 'url': WEBVIEW_URL, 'sha256': WEBVIEW_SHA256, 'license': 'WebView2-LICENSE.txt'}, 'files': {name: digest(data) if isinstance(data, Path) else hashlib.sha256(data).hexdigest() for name,data in sorted(payloads.items())}}
    payloads['RELEASE.json'] = (json.dumps(provenance, indent=2, sort_keys=True)+'\n').encode('utf-8')
    date = tuple(map(int, build['buildDate'].split('-'))) + (0,0,0)
    with output.open("xb") as stream:
        try:
            with ZipFile(stream, "w", compression=ZIP_DEFLATED, compresslevel=6) as archive:
                for name, data in sorted(payloads.items()):
                    info = ZipInfo("ScoreBrush/" + name, date)
                    info.compress_type = ZIP_DEFLATED
                    info.external_attr = 0o100644 << 16
                    if isinstance(data, Path):
                        import shutil
                        with data.open('rb') as source, archive.open(info, 'w', force_zip64=True) as target:
                            shutil.copyfileobj(source, target, 1024*1024)
                    else:
                        archive.writestr(info, data, compresslevel=6)
        except BaseException:
            stream.close()
            output.unlink()
            raise
    return len(payloads)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="New ZIP path; existing files are never overwritten")
    parser.add_argument("--bootstrapper-cache", type=Path, help="Pinned Microsoft Evergreen bootstrapper for packaging")
    args = parser.parse_args()
    count = prepare_release(args.output, bootstrapper_cache=args.bootstrapper_cache)
    print(f"Packaged {count} runtime files: {args.output.resolve()}")
