# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Auggie (@aug5thmusic).
# Additional permissions: see LICENSING.md at the source root.
"""Synchronize the offline About notice from the authoritative license files."""
from pathlib import Path
import html
import re

ROOT = Path(__file__).resolve().parents[1]
START = '<!-- SCOREBRUSH-LEGAL-START -->'
END = '<!-- SCOREBRUSH-LEGAL-END -->'


def notice(root: Path = ROOT) -> str:
    sections = [('License and additional permissions', 'LICENSING.md'),
                ('GNU Affero General Public License', 'LICENSE'),
                ('Third-party notices', 'THIRD_PARTY_NOTICES.md')]
    return START + '\n' + '\n'.join(
        '<details class="legal-notice"><summary>' + html.escape(title) +
        '</summary><pre tabindex="0">' + html.escape((root / name).read_text(encoding='utf-8')) +
        '</pre></details>' for title, name in sections) + '\n' + END


def sync(root: Path = ROOT) -> None:
    path = root / 'app/index.html'
    text = path.read_text(encoding='utf-8')
    replacement = notice(root)
    if START in text:
        text, count = re.subn(re.escape(START) + r'.*?' + re.escape(END),
                             lambda _: replacement, text, flags=re.S)
        if count != 1:
            raise ValueError('Expected exactly one legal notice block')
    else:
        anchor = '<p id="sourceLinkStatus" role="status" hidden></p>'
        if text.count(anchor) != 1:
            raise ValueError('About dialog anchor missing or ambiguous')
        text = text.replace(anchor, anchor + '\n<p id="aboutLicense">Copyright © 2026 Auggie '
                            '(@aug5thmusic). Free software under AGPLv3 or later, '
                            'with the additional permissions below. No warranty.</p>\n' + replacement)
    path.write_text(text, encoding='utf-8', newline='\n')


if __name__ == '__main__':
    sync()
