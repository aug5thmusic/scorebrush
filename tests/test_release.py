# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Auggie (@aug5thmusic).
# Additional permissions: see LICENSING.md at the source root.
"""Read-only verification of the actual supplied standalone ZIP."""
import hashlib, importlib.util, json, posixpath, re, struct, sys, tempfile, unittest
from pathlib import Path
from urllib.parse import unquote, urlsplit
from zipfile import ZipFile
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from build_info import load_build_info, validate_build_info
ZIP=Path(sys.argv.pop(1)).resolve() if len(sys.argv)>1 else None
spec=importlib.util.spec_from_file_location('release',ROOT/'prepare_release.py');release=importlib.util.module_from_spec(spec);spec.loader.exec_module(release)
class ReleaseTests(unittest.TestCase):
 def test_public_documentation_membership_is_explicit(self):
  expected={'documentation/INSTALLATION.md','documentation/USER_GUIDE.md','documentation/images/proofreading.png','documentation/images/workflow.png'}
  self.assertEqual({n for n in release.ROOT_FILES if n.startswith('documentation/')},expected)
  with tempfile.TemporaryDirectory(prefix='scorebrush-documentation-') as temporary:
   root=Path(temporary)
   for name in release.ROOT_FILES:
    path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'SYNTHETIC PUBLIC FIXTURE')
   for name in ['documentation/private-report.md','documentation/images/unlisted.png','docs/private.md']:
    path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'PRIVATE SENTINEL')
   selected={p.relative_to(root).as_posix() for p in release.release_files(root)}
   self.assertEqual(selected,set(release.ROOT_FILES))
 def test_packaged_documentation_links_and_images(self):
  with ZipFile(ZIP) as z:
   members=set(z.namelist())
   for document in ['README.md','LICENSING.md','documentation/INSTALLATION.md','documentation/USER_GUIDE.md']:
    text=z.read('ScoreBrush/'+document).decode('utf-8')
    targets=re.findall(r'\]\(([^)]+)\)',text)+re.findall(r'(?:href|src)=[\"\']([^\"\']+)[\"\']',text)
    for target in targets:
     url=urlsplit(target.strip('<>'))
     if url.scheme or url.netloc or not url.path:continue
     relative=posixpath.normpath(posixpath.join(posixpath.dirname(document),unquote(url.path)))
     self.assertFalse(relative.startswith('../') or relative.startswith('/'),(document,target))
     self.assertIn('ScoreBrush/'+relative,members,(document,target))
   for name in ['proofreading.png','workflow.png']:
    self.assertTrue(z.read('ScoreBrush/documentation/images/'+name).startswith(b'\x89PNG\r\n\x1a\n'),name)
 def test_manifest_and_source_identity(self):
  self.assertIsNotNone(ZIP,'Pass the final review ZIP')
  with ZipFile(ZIP) as z:
   m=json.loads(z.read('ScoreBrush/RELEASE.json'));names=z.namelist();self.assertEqual(len(names),len(set(names)))
   self.assertEqual(set(names),{'ScoreBrush/'+n for n in m['files']}|{'ScoreBrush/RELEASE.json'})
   for n,h in m['files'].items():
    self.assertEqual(hashlib.sha256(z.read('ScoreBrush/'+n)).hexdigest(),h,n)
    self.assertNotIn('/qa/',n);self.assertNotIn('..',Path(n).parts)
    self.assertTrue(n.startswith('app/') or n=='setup/MicrosoftEdgeWebview2Setup.exe' or n in {*release.ROOT_FILES,*release.webview_files(),'ScoreBrush.exe'},n)
   for path in release.release_files():self.assertEqual(z.read('ScoreBrush/'+path.relative_to(ROOT).as_posix()),path.read_bytes(),str(path))
   self.assertEqual(m['origin'],'https://scorebrush.invalid');self.assertEqual(validate_build_info(m)['version'],load_build_info(ROOT)['version']);self.assertEqual(m['buildDate'],load_build_info(ROOT)['buildDate'])
   self.assertEqual(m['runtime'],release.LOCK)
   self.assertFalse(any(n.startswith('ScoreBrush/runtime/') for n in names))
   self.assertEqual(hashlib.sha256(z.read('ScoreBrush/setup/MicrosoftEdgeWebview2Setup.exe')).hexdigest(),release.BOOTSTRAPPER['sha256'])
   self.assertFalse(any(n.lower().endswith(('python.exe','pythonw.exe','node.exe','stop scorebrush.exe','.py','.cmd')) for n in names))
 def test_gui_host_repeatable_and_manifest(self):
  first=release.launcher_bytes(ROOT);self.assertEqual(first,release.launcher_bytes(ROOT))
  with ZipFile(ZIP) as z:self.assertEqual(first,z.read('ScoreBrush/ScoreBrush.exe'))
  pe=struct.unpack_from('<I',first,0x3c)[0];self.assertEqual(struct.unpack_from('<H',first,pe+24+68)[0],2)
  self.assertIn(b'asInvoker',first);self.assertNotIn(b'requireAdministrator',first)
 def test_existing_output_and_app_directory_protected(self):
  with self.assertRaises(FileExistsError):release.prepare_release(ZIP)
  with self.assertRaises(ValueError):release.prepare_release(ROOT/'app/release.zip')
if __name__=='__main__':unittest.main(verbosity=2)
