# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Auggie (@aug5thmusic).
# Additional permissions: see LICENSING.md at the source root.
"""Check recorded dependency bytes offline, without extracting or running them."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import tarfile

ROOT = Path(__file__).resolve().parents[1]


def checked_path(base, name):
    relative = PurePosixPath(name)
    if relative.is_absolute() or '..' in relative.parts or '\\' in name:
        raise ValueError('Unsafe inventory path: ' + name)
    path = (base / name).resolve()
    if not path.is_relative_to(base.resolve()):
        raise ValueError('Redirected inventory path: ' + name)
    return path


def check_file(base, row, key):
    path = checked_path(base, row[key])
    data = path.read_bytes()
    if len(data) != row['bytes'] or hashlib.sha256(data).hexdigest() != row['sha256']:
        raise ValueError('Dependency bytes differ: ' + row[key])
    return path


def main():
    third_party = ROOT / 'third-party'
    inventory = json.loads((third_party / 'vendor-inventory.json').read_text(encoding='utf-8'))
    for row in inventory['files']:
        check_file(ROOT, row, 'file')
    provenance = json.loads((third_party / 'source-provenance.json').read_text(encoding='utf-8'))
    for row in provenance['sourceArchives']:
        path = check_file(third_party, row, 'archive')
        count = 0
        with tarfile.open(path, 'r:gz') as archive:
            for member in archive:
                name = PurePosixPath(member.name)
                if name.is_absolute() or '..' in name.parts:
                    raise ValueError('Unsafe archive member: ' + member.name)
                if member.isfile():
                    if len(archive.extractfile(member).read()) != member.size:
                        raise ValueError('Truncated archive member: ' + member.name)
                    count += 1
        if count != row['sourceFileCount']:
            raise ValueError('Source count differs: ' + row['component'])
    for row in provenance.get('bundledSourceFiles', []):
        check_file(third_party, row, 'file')
    audit = json.loads((third_party / 'source-audit.json').read_text(encoding='utf-8'))
    print(f"Verified {len(inventory['files'])} vendor files and {len(provenance['sourceArchives'])} source archives.")
    print('Source audit: ' + audit['status'] + '. See third-party/README.md.')


if __name__ == '__main__':
    main()
