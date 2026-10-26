# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Auggie (@aug5thmusic).
# Additional permissions: see LICENSING.md at the source root.
"""Metadata regression tests: no release ZIP, dependency download or app launch."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from build_info import load_build_info, native_metadata, validate_build_info, windows_version
import prepare_release

CASES = json.loads((ROOT/'tests/build-info-cases.json').read_text(encoding='utf-8'))
BUILD = load_build_info(ROOT)
TEMPLATE = (ROOT/'launcher.manifest').read_text(encoding='utf-8')
COMPILER = Path(os.environ.get('WINDIR', r'C:\Windows'))/'Microsoft.NET/Framework64/v4.0.30319/csc.exe'


class BuildInfoTests(unittest.TestCase):
    def test_shared_valid_versions_and_native_generation(self):
        for version, numeric in CASES['valid']:
            with self.subTest(version=version):
                info = {**BUILD, 'version': version}
                self.assertEqual(validate_build_info(info), info)
                self.assertEqual(windows_version(version), numeric)
                manifest, attributes = native_metadata(info, TEMPLATE)
                identity = ET.fromstring(manifest).find('{urn:schemas-microsoft-com:asm.v1}assemblyIdentity')
                self.assertEqual(identity.attrib['version'], numeric)
                self.assertEqual(identity.attrib['name'], 'ScoreBrush.Desktop')
                self.assertEqual(len(numeric.split('.')), 4)
                self.assertIn('[assembly:AssemblyVersion("'+numeric+'")]', attributes)
                self.assertIn('[assembly:AssemblyFileVersion("'+numeric+'")]', attributes)
                self.assertIn('[assembly:AssemblyInformationalVersion("'+version+'")]', attributes)
                self.assertIn('[assembly:AssemblyCopyright("Copyright (C) 2026 Auggie (@aug5thmusic).")]', attributes)
                self.assertIn('level="asInvoker"', manifest)

    def test_shared_invalid_versions(self):
        for version in [*CASES['invalid'], '9'*10000+'.0.0']:
            with self.subTest(version=str(version)[:100]):
                with self.assertRaisesRegex(ValueError, 'Invalid build information: version'):
                    windows_version(version)
                with self.assertRaisesRegex(ValueError, 'Invalid build information: version'):
                    native_metadata({**BUILD, 'version': version}, TEMPLATE)

    def test_shared_invalid_metadata(self):
        for info in CASES['invalidMetadata']:
            with self.subTest(info=info), self.assertRaisesRegex(ValueError, 'Invalid build information'):
                validate_build_info(info)

    def test_manifest_requires_numeric_placeholder(self):
        for template in [TEMPLATE.replace('@WINDOWS_VERSION@', '@VERSION@.0'), TEMPLATE+'@WINDOWS_VERSION@']:
            with self.assertRaisesRegex(ValueError, 'exactly one @WINDOWS_VERSION@'):
                native_metadata(BUILD, template)

    def test_missing_unreadable_and_invalid_metadata_fail_before_dependencies(self):
        with tempfile.TemporaryDirectory(prefix='scorebrush-metadata-') as temporary:
            root = Path(temporary)
            (root/'app').mkdir()
            (root/'launcher.manifest').write_text(TEMPLATE, encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'missing or unreadable'):
                load_build_info(root)
            for body in ['{', 'null', json.dumps({**BUILD, 'version': '0.1.0-beta.01'})]:
                (root/'app/build-info.json').write_text(body, encoding='utf-8')
                with patch.object(prepare_release, 'webview_files') as sdk:
                    with self.assertRaisesRegex(ValueError, '[Bb]uild information'):
                        prepare_release.launcher_bytes(root)
                    sdk.assert_not_called()
                with patch.object(prepare_release, 'release_files', return_value=[]), patch.object(prepare_release, 'acquire_bootstrapper') as bootstrapper:
                    with self.assertRaisesRegex(ValueError, '[Bb]uild information'):
                        prepare_release.prepare_release(root/'unused.zip', root)
                    bootstrapper.assert_not_called()
                    self.assertFalse((root/'unused.zip').exists())

    @unittest.skipUnless(COMPILER.is_file(), 'Existing Windows .NET Framework compiler unavailable')
    def test_compiled_windows_assembly_file_product_and_manifest(self):
        # A tiny console probe verifies actual Windows resources without WebView2.
        with tempfile.TemporaryDirectory(prefix='scorebrush-version-probe-') as temporary:
            work = Path(temporary)
            source = work/'Probe.cs'
            source.write_text('''using System;
using System.Diagnostics;
using System.Reflection;
class Probe {
  static void Main() {
    Assembly assembly=Assembly.GetExecutingAssembly();
    FileVersionInfo file=FileVersionInfo.GetVersionInfo(assembly.Location);
    Console.WriteLine(assembly.GetName().Version);
    Console.WriteLine(file.FileVersion);
    Console.WriteLine(file.ProductVersion);
    Console.WriteLine(file.LegalCopyright);
  }
}
''', encoding='utf-8')
            for version in [BUILD['version'], '1.2.3-beta.1+build.007', '65534.65534.65534-rc.1']:
                with self.subTest(version=version):
                    manifest, attributes = native_metadata({**BUILD, 'version': version}, TEMPLATE)
                    (work/'probe.manifest').write_text(manifest, encoding='utf-8')
                    (work/'AssemblyInfo.cs').write_text(attributes, encoding='utf-8')
                    exe = work/'Probe.exe'
                    result = subprocess.run([str(COMPILER), '/nologo', '/target:exe', '/platform:x64', '/win32manifest:'+str(work/'probe.manifest'), '/out:'+str(exe), str(source), str(work/'AssemblyInfo.cs')], capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
                    self.assertNotIn('warning', result.stdout.lower())
                    output = subprocess.check_output([str(exe)], text=True).splitlines()
                    self.assertEqual(output, [windows_version(version), windows_version(version), version,
                                              'Copyright (C) 2026 Auggie (@aug5thmusic).'])
                    self.assertIn(('version="'+windows_version(version)+'"').encode(), exe.read_bytes())
                    print('PASS Windows metadata probe: '+json.dumps(output), flush=True)


if __name__ == '__main__':
    unittest.main(verbosity=2)
