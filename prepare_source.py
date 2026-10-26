# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Auggie (@aug5thmusic).
# Additional permissions: see LICENSING.md at the source root.
"""Export only reviewed public source to a new local directory and ZIP."""
from __future__ import annotations
import argparse
import hashlib
import html
import json
from pathlib import Path, PurePosixPath
import re
import stat
from urllib.parse import unquote
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parent
BLOCKED = {'.git', '.runtime', 'builds', 'test-results', 'public-source',
           'design-previews', '__pycache__', 'node_modules', 'profiles',
           '.scorebrush', '.score-desk', '.aws', '.ssh', '.codex', '.agents',
           'logs', 'backups'}
TEXT_SUFFIXES = {'.js', '.mjs', '.cs', '.py', '.md', '.json', '.html', '.txt',
                 '.yml', '.yaml', '.map', '.svg', '.xml', '.css', '.toml',
                 '.cfg', '.ini', '.config', '.manifest'}
BYTE_PRESERVED_PREFIXES = ('app/vendor/', 'third-party/', 'app/branding/',
                           'design-assets/scorebrush-official/', 'licenses/')
BYTE_PRESERVED_FILES = {'LICENSE', 'THIRD_PARTY_NOTICES.md'}


def first_party_text(name: str) -> bool:
    """Match the LF text policy, excluding pinned original materials."""
    path = PurePosixPath(name)
    return (not name.startswith(BYTE_PRESERVED_PREFIXES)
            and name not in BYTE_PRESERVED_FILES
            and (path.suffix.lower() in TEXT_SUFFIXES or not path.suffix))


def normalized_paths(text: str) -> str:
    """Normalize common text, JSON and file-URI path spellings for inspection."""
    return re.sub(r'[\\/]+', '/', html.unescape(unquote(text)))


def private_development_path(text: str, root: Path) -> bool:
    normalized = normalized_paths(text)
    source_root = normalized_paths(str(root.absolute())).rstrip('/')
    if source_root.casefold() in normalized.casefold():
        return True
    homes = re.finditer(r'(?:\b[A-Z]:/[U]sers/[^/\s\"\'<>]+|(?<![\w.])/(?:home|Users)/[^/\s\"\'<>]+)',
                        normalized, re.I)
    for match in homes:
        # Emscripten's fixed virtual HOME is not a host-machine directory.
        if match.group() == '/home/web_user' and normalized[match.end():match.end() + 1] != '/':
            continue
        return True
    return False


def ordinary_path(path: Path, boundary: Path) -> None:
    """Reject symlinks and Windows junctions on every existing path component."""
    path = path.absolute()
    boundary = boundary.absolute()
    if not path.is_relative_to(boundary):
        raise ValueError('Path is outside the source boundary')
    current = boundary
    for part in ('', *path.relative_to(boundary).parts):
        if part:
            current = current / part
        try:
            info = current.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError('Redirected path is not allowed: ' + str(current))


def payloads(root: Path) -> dict[str, bytes]:
    manifest_path = root / 'public-source-files.json'
    ordinary_path(manifest_path, root)
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    if manifest.get('schemaVersion') != 1 or not isinstance(manifest.get('files'), list):
        raise ValueError('Invalid reviewed source list')
    result, seen = {}, set()
    for name in manifest['files']:
        if not isinstance(name, str) or not name or '\\' in name or ':' in name:
            raise ValueError('Invalid source path')
        path = PurePosixPath(name)
        key = name.casefold()
        if (path.is_absolute() or path.as_posix() != name or '..' in path.parts
                or any(part.casefold() in BLOCKED for part in path.parts)
                or any(part.lower() == '.env' or part.lower().startswith('.env.') for part in path.parts)
                or any(part.endswith((' ', '.')) for part in path.parts)
                or key in seen or key == 'source_manifest.json'
                or path.suffix.lower() in {'.lnk', '.pfx', '.p12', '.pem', '.exe', '.dll', '.log', '.cmd', '.bat'}):
            raise ValueError('Unsafe, private or duplicate source path: ' + name)
        seen.add(key)
        file = root / name
        ordinary_path(file, root)
        if not file.is_file():
            raise ValueError('Reviewed source file is missing: ' + name)
        data = file.read_bytes()
        if file.suffix.lower() in TEXT_SUFFIXES or not file.suffix:
            text = data.decode('utf-8-sig')
            if private_development_path(text, root):
                raise ValueError('Private development path in ' + name)
            if re.search(r'-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}', text):
                raise ValueError('Possible secret in ' + name)
        if first_party_text(name) and b'\r' in data:
            raise ValueError('First-party text must use LF before export: ' + name)
        result[name] = data
    required = {'LICENSE', 'LICENSING.md', 'README.md', 'prepare_source.py',
                'prepare_release.py', 'public-source-files.json', 'app/index.html',
                'launcher.cs', 'native-services.cs', 'runtime-setup.cs', 'window-placement.cs'}
    if not required.issubset(result):
        raise ValueError('Source list omits required build/license files')
    if b'GNU AFFERO GENERAL PUBLIC LICENSE' not in result['LICENSE']:
        raise ValueError('AGPL license text missing')
    return result


def export_source(output: Path, root: Path = ROOT) -> dict:
    root = root.resolve()
    if not output.is_absolute():
        output = root / output
    # Check the lexical path and all components before resolving it.
    if '..' in output.parts or not output.absolute().is_relative_to(root / 'public-source'):
        raise ValueError('Choose a new directory inside public-source/')
    ordinary_path(output, root)
    output = output.resolve()
    if output == root / 'public-source':
        raise ValueError('Choose a named child of public-source/')
    archive = output.with_name(output.name + '.zip')
    checksum = output.with_name(output.name + '.zip.sha256')
    for path in (output, archive, checksum):
        ordinary_path(path, root)
        if path.exists():
            raise FileExistsError(path)
    data = payloads(root)
    build = json.loads(data['app/build-info.json'])
    manifest = {'schemaVersion': 1, 'status': 'local-public-source-preparation',
                'repository': 'https://github.com/aug5thmusic/scorebrush',
                'applicationVersion': build['version'],
                'license': 'AGPL-3.0-or-later', 'additionalPermissions': 'LICENSING.md',
                'files': {n: {'sha256': hashlib.sha256(b).hexdigest(), 'bytes': len(b)}
                          for n, b in sorted(data.items())}}
    data['SOURCE_MANIFEST.json'] = (json.dumps(manifest, indent=2) + '\n').encode()
    output.mkdir(parents=True, exist_ok=False)
    for name, content in sorted(data.items()):
        destination = output / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        ordinary_path(destination, output)
        with destination.open('xb') as stream:
            stream.write(content)
    with archive.open('xb') as stream, ZipFile(stream, 'w', compression=ZIP_DEFLATED) as zip_file:
        for name, content in sorted(data.items()):
            info = ZipInfo('scorebrush/' + name, (2026, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            zip_file.writestr(info, content)
    # Read back both representations. Failed exports are retained for diagnosis;
    # a retry must use a new output name rather than overwrite any evidence.
    with ZipFile(archive) as zip_file:
        if set(zip_file.namelist()) != {'scorebrush/' + name for name in data}:
            raise ValueError('Archive membership verification failed')
        for name, content in data.items():
            if (output / name).read_bytes() != content or zip_file.read('scorebrush/' + name) != content:
                raise ValueError('Export read-back failed: ' + name)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    with checksum.open('x', encoding='utf-8', newline='\n') as stream:
        stream.write(digest + '  ' + archive.name + '\n')
    return {'directory': str(output), 'zip': str(archive), 'sha256': digest,
            'payloadFiles': len(manifest['files'])}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    print(json.dumps(export_source(args.output), indent=2))
