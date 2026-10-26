# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Auggie (@aug5thmusic).
# Additional permissions: see LICENSING.md at the source root.
"""Validate the maintained build metadata and derive Windows version resources."""
import json
import re
from pathlib import Path

# Keep aligned with app/build-info.js; both run tests/build-info-cases.json.
_VERSION = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?')


def windows_version(version: str) -> str:
    match = _VERSION.fullmatch(version) if isinstance(version, str) else None
    # The assembly compiler requires components <= 65534 (stricter than Win32).
    if (not match or any(len(part) > 5 or int(part) > 65534 for part in match.group(1, 2, 3))
            or any(part.isdigit() and len(part) > 1 and part.startswith('0')
                   for part in (match.group(4) or '').split('.'))):
        raise ValueError('Invalid build information: version must be SemVer with core components from 0 to 65534.')
    return '.'.join(match.group(1, 2, 3)) + '.0'


def validate_build_info(info: dict) -> dict:
    if not isinstance(info, dict):
        raise ValueError('Invalid build information: expected a metadata object.')
    windows_version(info.get('version'))
    if not isinstance(info.get('buildDate'), str) or not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', info['buildDate']):
        raise ValueError('Invalid build information: buildDate must use YYYY-MM-DD.')
    return dict(info)


def load_build_info(root: Path) -> dict:
    try:
        info = json.loads((root / 'app/build-info.json').read_text(encoding='utf-8'))
    except (OSError, ValueError) as error:
        raise ValueError('Build information is missing or unreadable: app/build-info.json.') from error
    return validate_build_info(info)


def native_metadata(info: dict, template: str) -> tuple[str, str]:
    info = validate_build_info(info)
    numeric = windows_version(info['version'])
    if template.count('@WINDOWS_VERSION@') != 1:
        raise ValueError('Launcher manifest must contain exactly one @WINDOWS_VERSION@ placeholder.')
    manifest = template.replace('@WINDOWS_VERSION@', numeric)
    attributes = (
        'using System.Reflection;\n'
        '[assembly:AssemblyTitle("ScoreBrush")]\n'
        '[assembly:AssemblyProduct("ScoreBrush")]\n'
        '[assembly:AssemblyCopyright("Copyright (C) 2026 Auggie (@aug5thmusic).")]\n'
        f'[assembly:AssemblyVersion("{numeric}")]\n'
        f'[assembly:AssemblyFileVersion("{numeric}")]\n'
        f'[assembly:AssemblyInformationalVersion("{info["version"]}")]\n'
    )
    return manifest, attributes
