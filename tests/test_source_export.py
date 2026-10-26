# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Auggie (@aug5thmusic).
# Additional permissions: see LICENSING.md at the source root.
"""Exercise public-export privacy boundaries without touching real data."""
import importlib.util
import hashlib
import json
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.parse import quote
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('source_export', ROOT / 'prepare_source.py')
export = importlib.util.module_from_spec(spec)
spec.loader.exec_module(export)


class SourceExportTests(unittest.TestCase):
    def fixture(self, root):
        files = ['LICENSE', 'LICENSING.md', 'README.md', 'prepare_source.py',
                 'prepare_release.py', 'public-source-files.json', 'app/index.html',
                 'app/build-info.json', 'launcher.cs', 'native-services.cs',
                 'runtime-setup.cs', 'window-placement.cs']
        for name in files:
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('Synthetic public fixture', encoding='utf-8')
        (root / 'LICENSE').write_text('GNU AFFERO GENERAL PUBLIC LICENSE', encoding='utf-8')
        (root / 'app/build-info.json').write_text('{"version":"0.0.0-test"}', encoding='utf-8')
        (root / 'public-source-files.json').write_text(json.dumps({'schemaVersion': 1, 'files': files}), encoding='utf-8')
        return files

    def test_export_excludes_unlisted_data_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            files = self.fixture(root)
            (root / 'private-score.pdf').write_bytes(b'PRIVATE SENTINEL')
            (root / 'unlisted-data').mkdir()
            (root / 'unlisted-data/items.json').write_bytes(b'PRIVATE SENTINEL')
            (root / 'unlisted-launcher.cmd').write_bytes(b'PRIVATE SENTINEL')
            result = export.export_source(Path('public-source/check'), root)
            with ZipFile(result['zip']) as archive:
                self.assertEqual(set(archive.namelist()), {'scorebrush/' + n for n in files} | {'scorebrush/SOURCE_MANIFEST.json'})
                self.assertNotIn(b'PRIVATE SENTINEL', b''.join(archive.read(n) for n in archive.namelist()))
                manifest = json.loads(archive.read('scorebrush/SOURCE_MANIFEST.json'))
                self.assertEqual(set(manifest['files']), set(files))
                self.assertNotIn('SOURCE_MANIFEST.json', manifest['files'])
                for name, row in manifest['files'].items():
                    content = archive.read('scorebrush/' + name)
                    self.assertEqual(row, {'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()})
            with self.assertRaises(FileExistsError):
                export.export_source(Path('public-source/check'), root)

    def test_bad_members_and_private_data_fail_before_output(self):
        for bad in ['../outside', 'app/../../outside', 'test-results/evidence.json',
                    'profiles/session.json', 'unlisted-launcher.cmd', 'unlisted-launcher.bat',
                    'app\\secret.txt', 'app/a:stream', 'app/secret.pem', '.env', '.env.local', 'README.md',
                    'SOURCE_MANIFEST.json']:
            with self.subTest(bad=bad), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                files = self.fixture(root)
                (root / 'public-source-files.json').write_text(json.dumps({'schemaVersion': 1, 'files': files + [bad]}), encoding='utf-8')
                with self.assertRaises(ValueError):
                    export.export_source(Path('public-source/check'), root)
                self.assertFalse((root / 'public-source/check').exists())

    def test_public_documentation_export_is_narrow_and_byte_exact(self):
        documentation = {
            'documentation/INSTALLATION.md': b'# Synthetic installation\n',
            'documentation/USER_GUIDE.md': b'# Synthetic user guide\n',
            'documentation/images/proofreading.png': b'\x89PNG\r\n\x1a\nSYNTHETIC PROOFREADING',
            'documentation/images/workflow.png': b'\x89PNG\r\n\x1a\nSYNTHETIC WORKFLOW',
        }
        reviewed = json.loads((ROOT / 'public-source-files.json').read_text(encoding='utf-8'))['files']
        self.assertEqual({n for n in reviewed if n.startswith('documentation/')}, set(documentation))
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            files = self.fixture(root)
            for name, content in documentation.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
                files.append(name)
            for name in ['documentation/private-report.md', 'documentation/images/unlisted.png', 'docs/private.md']:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b'PRIVATE SENTINEL')
            (root / 'public-source-files.json').write_text(json.dumps({'schemaVersion': 1, 'files': files}), encoding='utf-8')
            result = export.export_source(Path('public-source/check'), root)
            with ZipFile(result['zip']) as archive:
                self.assertEqual(set(archive.namelist()), {'scorebrush/' + n for n in files} | {'scorebrush/SOURCE_MANIFEST.json'})
                self.assertNotIn(b'PRIVATE SENTINEL', b''.join(archive.read(n) for n in archive.namelist()))
                for name, content in documentation.items():
                    self.assertEqual(archive.read('scorebrush/' + name), content)
                    self.assertEqual((Path(result['directory']) / name).read_bytes(), content)

    def test_generic_home_paths_fail_before_output(self):
        windows = '\\'.join(['Z:', 'Users', 'sample-user', 'workspace', 'score.ly'])
        unix = '/' + '/'.join(['home', 'sample-user', 'workspace'])
        mac = '/' + '/'.join(['Users', 'sample-user', 'workspace'])
        cases = [windows, windows.replace('\\', '/'), windows.swapcase(),
                 json.dumps(windows), 'file:///' + quote(windows.replace('\\', '/')),
                 windows.replace('\\', '&#92;'), unix, mac]
        for text in cases:
            with self.subTest(spelling=cases.index(text)), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                self.fixture(root)
                (root / 'README.md').write_text(text, encoding='utf-8')
                with self.assertRaisesRegex(ValueError, 'Private development path'):
                    export.export_source(Path('public-source/check'), root)
                self.assertFalse((root / 'public-source/check').exists())

    def test_exporter_patterns_are_safe_to_export(self):
        text = (ROOT / 'prepare_source.py').read_text(encoding='utf-8')
        self.assertFalse(export.private_development_path(text, ROOT))

    def test_reviewed_git_allowlist_tracks_only_payloads_and_generated_manifest(self):
        files = set(json.loads((ROOT / 'public-source-files.json').read_text(encoding='utf-8'))['files'])
        lines = (ROOT / '.gitignore').read_text(encoding='utf-8').splitlines()
        allowed = {line[2:] for line in lines if line.startswith('!/') and not line.endswith('/')}
        self.assertIn('*', lines)
        self.assertEqual(allowed, files | {'SOURCE_MANIFEST.json'})
        self.assertNotIn('SOURCE_MANIFEST.json', files)

    def test_first_party_line_endings_must_be_final_before_export(self):
        for content in [b'Synthetic\r\ntext\r\n', b'Synthetic\rtext\n']:
            with self.subTest(content=content), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                self.fixture(root)
                (root / 'README.md').write_bytes(content)
                with self.assertRaisesRegex(ValueError, 'must use LF before export'):
                    export.export_source(Path('public-source/check'), root)
                self.assertEqual((root / 'README.md').read_bytes(), content)
                self.assertFalse((root / 'public-source/check').exists())

    def test_pinned_materials_and_binary_bytes_are_not_normalized(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            files = self.fixture(root)
            preserved = {
                'LICENSE': b'GNU AFFERO GENERAL PUBLIC LICENSE\r\n',
                'THIRD_PARTY_NOTICES.md': b'Synthetic upstream notice\r\n',
                'licenses/example.txt': b'Synthetic upstream license\r\n',
                'app/vendor/example.js': b'// Synthetic pinned vendor\r\n',
                'third-party/example.txt': b'Synthetic pinned source\r\n',
                'app/branding/example.svg': b'<svg><!-- Synthetic artwork --></svg>\r\n',
                'design-assets/scorebrush-official/example.svg': b'<svg/>\r\n',
                'app/example.png': b'\x89PNG\r\n\x1a\n\x00\xff',
            }
            for name, content in preserved.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
                if name not in files:
                    files.append(name)
            (root / 'public-source-files.json').write_text(json.dumps({'schemaVersion': 1, 'files': files}), encoding='utf-8')
            result = export.export_source(Path('public-source/check'), root)
            with ZipFile(result['zip']) as archive:
                for name, content in preserved.items():
                    self.assertEqual(archive.read('scorebrush/' + name), content)
                    self.assertEqual((Path(result['directory']) / name).read_bytes(), content)

    def test_source_root_paths_are_detected_without_machine_literals(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.fixture(root)
            for text in [str(root / 'source.txt'), (root / 'source.txt').as_posix(),
                         json.dumps(str(root / 'source.txt')), (root / 'source.txt').as_uri()]:
                (root / 'README.md').write_text(text, encoding='utf-8')
                with self.assertRaisesRegex(ValueError, 'Private development path'):
                    export.export_source(Path('public-source/check'), root)
                self.assertFalse((root / 'public-source/check').exists())

    def test_additional_text_formats_keep_privacy_checks(self):
        for suffix in ['.map', '.svg', '.css', '.config', '.manifest', '.yaml']:
            with self.subTest(suffix=suffix), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                files = self.fixture(root)
                name = 'app/path' + suffix
                (root / name).write_text('/' + '/'.join(['home', 'sample-user', 'source']), encoding='utf-8')
                (root / 'public-source-files.json').write_text(json.dumps({'schemaVersion': 1, 'files': files + [name]}), encoding='utf-8')
                with self.assertRaisesRegex(ValueError, 'Private development path'):
                    export.export_source(Path('public-source/check'), root)
                self.assertFalse((root / 'public-source/check').exists())

    def test_public_placeholders_and_virtual_home_remain_usable(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.fixture(root)
            text = '%LOCALAPPDATA%/ScoreBrush/Standalone/WebView2\nhttps://github.com/aug5thmusic/scorebrush\n'
            text += 'HOME="' + '/' + '/'.join(['home', 'web_user']) + '"'
            (root / 'README.md').write_bytes(text.encode('utf-8'))
            result = export.export_source(Path('public-source/check'), root)
            with ZipFile(result['zip']) as archive:
                self.assertEqual(archive.read('scorebrush/README.md').decode(), text)
            nested = '/' + '/'.join(['home', 'web_user', 'private-workspace'])
            self.assertTrue(export.private_development_path(nested, root))

    def test_secret_markers_fail_before_output(self):
        markers = ['-----BEGIN ' + kind + 'PRIVATE KEY-----'
                   for kind in ['', 'RSA ', 'EC ', 'DSA ', 'OPENSSH ', 'ENCRYPTED ']]
        markers += ['gh' + kind + '_' + 'A' * 36 for kind in 'pousr']
        markers += ['github_' + 'pat_' + 'A' * 48]
        for index, marker in enumerate(markers):
            with self.subTest(marker=index), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                self.fixture(root)
                (root / 'README.md').write_text(marker, encoding='utf-8')
                with self.assertRaisesRegex(ValueError, 'Possible secret'):
                    export.export_source(Path('public-source/check'), root)
                self.assertFalse((root / 'public-source/check').exists())

    def test_redirected_source_and_output_components_fail(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.fixture(root)
            lstat = Path.lstat
            for redirected in [root / 'app', root / 'public-source']:
                with self.subTest(component=redirected.name):
                    def attributes(path, *args, **kwargs):
                        if path == redirected:
                            return SimpleNamespace(st_mode=stat.S_IFDIR, st_file_attributes=0x400)
                        return lstat(path, *args, **kwargs)
                    with patch.object(Path, 'lstat', attributes):
                        with self.assertRaisesRegex(ValueError, 'Redirected path'):
                            export.export_source(Path('public-source/check'), root)
                    self.assertFalse((root / 'public-source/check').exists())

    def test_output_cannot_escape(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.fixture(root)
            for path in ['outside', 'public-source/../outside', 'public-source']:
                with self.assertRaises(ValueError):
                    export.export_source(Path(path), root)

    def test_about_notice_matches_authoritative_files(self):
        spec = importlib.util.spec_from_file_location('license_notice', ROOT / 'tools/sync_license_notice.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertIn(module.notice(ROOT), (ROOT / 'app/index.html').read_text(encoding='utf-8'))


if __name__ == '__main__':
    unittest.main()
