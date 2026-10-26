# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Auggie (@aug5thmusic).
# Additional permissions: see LICENSING.md at the source root.
"""Copy source artwork unchanged and derive only scaled Windows icon frames.

Development utility using the already available Pillow; never run by the app.
No crop, recolor, background removal, sharpening or geometry changes.
"""
from pathlib import Path
import hashlib
import json
import shutil
import struct
import uuid
from io import BytesIO
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'design-assets/scorebrush-official'
OUTPUT = ROOT / 'app/branding'
SIZES = (16, 20, 24, 28, 32, 40, 48, 56, 64, 72, 96, 128, 256)


def prepare():
    manifest = json.loads((SOURCE / 'source-manifest.json').read_text(encoding='utf-8'))
    OUTPUT.mkdir(exist_ok=True)
    for asset in manifest['assets']:
        original = SOURCE / asset['file']
        assert hashlib.sha256(original.read_bytes()).hexdigest() == asset['sha256'], original
        shutil.copyfile(original, OUTPUT / asset['file'])
    original = Image.open(SOURCE / 'scorebrush-app.png').convert('RGBA')
    assert original.size == (manifest['assets'][0]['width'], manifest['assets'][0]['height'])
    assert original.width == original.height
    frames = [original.resize((size, size), Image.Resampling.LANCZOS) for size in SIZES]
    # WinForms' Framework Icon.ToBitmap path requires bitmap frames at the
    # smaller sizes. Only the 256px frame is PNG-compressed, as Windows advises.
    payloads = []
    for size, frame in zip(SIZES, frames):
        encoded = BytesIO()
        frame.save(encoded, format='ICO', sizes=[(size, size)], bitmap_format='png' if size == 256 else 'bmp')
        data = encoded.getvalue()
        length, offset = struct.unpack_from('<II', data, 14)
        payloads.append(data[offset:offset + length])
    offset = 6 + 16 * len(SIZES)
    directory = bytearray(struct.pack('<HHH', 0, 1, len(SIZES)))
    for size, payload in zip(SIZES, payloads):
        directory.extend(struct.pack('<BBBBHHII', size % 256, size % 256, 0, 0, 1, 32, len(payload), offset))
        offset += len(payload)
    (OUTPUT / 'scorebrush.ico').write_bytes(directory + b''.join(payloads))
    ico = Image.open(OUTPUT / 'scorebrush.ico')
    assert ico.ico.sizes() == {(s, s) for s in SIZES}
    for size, expected in zip(SIZES, frames):
        assert ico.ico.getimage((size, size)).convert('RGBA').tobytes() == expected.tobytes()
    evidence = ROOT / ('.runtime/branding-' + uuid.uuid4().hex)
    evidence.mkdir(exist_ok=True)
    preview = Image.new('RGB', (900, 550), '#f5f5f7')
    draw = ImageDraw.Draw(preview)
    for index, size in enumerate(SIZES):
        x, y = 12 + (index % 7) * 118, 16 + (index // 7) * 235
        frame = ico.ico.getimage((size, size)).convert('RGBA')
        draw.text((x, y), f'{size}px', fill='#292c35')
        preview.paste(frame, (x, y + 22), frame)
        if size <= 48:
            enlarged = frame.resize((size * 3, size * 3), Image.Resampling.NEAREST)
            preview.paste(enlarged, (x, y + 80), enlarged)
    preview.save(evidence / 'icon-sizes.png')
    (evidence / 'derivation.json').write_text(json.dumps({'sourceSHA256': manifest['assets'][0]['sha256'], 'sizes': SIZES, 'icoSHA256': hashlib.sha256((OUTPUT / 'scorebrush.ico').read_bytes()).hexdigest(), 'method': 'Each full original image downsampled with Lanczos; 32-bit bitmap frames below 256px and a lossless PNG 256px frame; no other alteration.'}, indent=2), encoding='utf-8')
    print(OUTPUT / 'scorebrush.ico')
    print(evidence)


if __name__ == '__main__':
    prepare()
