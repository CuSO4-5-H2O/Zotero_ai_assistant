import json,tempfile,unittest,subprocess,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from github_update import update
class GithubUpdateTests(unittest.TestCase):
 def git(self,cwd,*args):return subprocess.run(['git','-C',str(cwd),*args],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True).stdout.strip()
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.base=Path(self.temp.name);self.remote=self.base/'upstream.git';self.author=self.base/'author';self.client=self.base/'client'
  subprocess.run(['git','init','--bare',str(self.remote)],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  subprocess.run(['git','init','-b','main',str(self.author)],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  self.git(self.author,'config','user.name','Test');self.git(self.author,'config','user.email','test@example.invalid')
  (self.author/'requirements.txt').write_text('fixed\n');(self.author/'core.txt').write_text('v1\n');(self.author/'build_zotero_plugin.py').write_text("from pathlib import Path\nPath('built.txt').write_text('ok')\n")
  self.git(self.author,'add','.');self.git(self.author,'commit','-m','initial');self.git(self.author,'remote','add','origin',str(self.remote));self.git(self.author,'push','-u','origin','main')
  subprocess.run(['git','clone','--branch','main',str(self.remote),str(self.client)],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 def tearDown(self):self.temp.cleanup()
 def push(self,file,text):
  (self.author/file).write_text(text);self.git(self.author,'add',file);self.git(self.author,'commit','-m','update');self.git(self.author,'push')
 def test_fast_forward_preserves_private_files_and_builds(self):
  (self.client/'vault').mkdir();(self.client/'vault'/'private.md').write_text('my personal note');self.push('core.txt','v2\n')
  result=update(self.client,sys.executable,expected_origin=str(self.remote));self.assertEqual(result['state'],'updated');self.assertEqual((self.client/'core.txt').read_text(),'v2\n');self.assertEqual((self.client/'vault'/'private.md').read_text(),'my personal note');self.assertTrue((self.client/'built.txt').exists())
 def test_local_edits_prevent_update(self):
  (self.client/'core.txt').write_text('local edit');self.push('core.txt','v2\n');result=update(self.client,sys.executable,expected_origin=str(self.remote));self.assertEqual(result['state'],'local_changes');self.assertEqual((self.client/'core.txt').read_text(),'local edit')
 def test_dependency_change_prevents_partial_update(self):
  self.push('requirements.txt','different\n');result=update(self.client,sys.executable,expected_origin=str(self.remote));self.assertEqual(result['state'],'dependencies_changed');self.assertEqual((self.client/'requirements.txt').read_text(),'fixed\n')
 def test_unknown_origin_does_not_fetch(self):self.assertEqual(update(self.client,sys.executable)['state'],'unrecognized_origin')
 def test_build_failure_is_reported_and_repaired_before_start(self):
  self.push('build_zotero_plugin.py',"raise SystemExit('fixture failure')\n")
  result=update(self.client,sys.executable,expected_origin=str(self.remote));self.assertEqual(result['state'],'build_failed')
  status=self.client/'.runtime/github-update-status.json';status.parent.mkdir();status.write_text(json.dumps(result))
  (self.client/'build_zotero_plugin.py').write_text("from pathlib import Path\nPath('built.txt').write_text('repaired')\n")
  repaired=update(self.client,sys.executable,expected_origin=str(self.remote));self.assertEqual(repaired['state'],'local_changes');self.assertEqual((self.client/'built.txt').read_text(),'repaired')
if __name__=='__main__':unittest.main()
