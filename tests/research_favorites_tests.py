from pathlib import Path
import unittest,tempfile,pathlib,sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from server import Vault,atomic
from favorites import Favorites
class FavoriteTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name)
  self.stars=Favorites(self.root/'vault'/'.stars.json',atomic)
  self.vault=Vault(self.root/'vault',seed=False);self.vault.favorites=self.stars
  self.reports=Vault(self.root/'reports',seed=False);self.reports.category='reports';self.reports.favorites=self.stars
 def tearDown(self):self.tmp.cleanup()
 def test_star_pins_without_changing_content_or_edit_version(self):
  old=self.vault.create('old note','test',[],'original content');new=self.vault.create('new note','test',[],'new content')
  before=self.vault.get(old['id']);self.stars.set('note',old['id'],True)
  self.assertEqual(self.vault.list()['notes'][0]['id'],old['id'])
  after=self.vault.get(old['id']);self.assertEqual(before['version'],after['version']);self.assertEqual(before['content'],after['content']);self.assertTrue(after['starred'])
  self.vault.save(old['id'],{**after,'content':'edited content'});self.assertTrue(self.vault.get(old['id'])['starred'])
  self.stars.set('note',old['id'],False);self.assertFalse(self.vault.get(old['id'])['starred'])
 def test_reports_and_papers_have_independent_scopes(self):
  report=self.reports.create('report','reports',[],'report body');self.stars.set('report',report['id'],True);self.stars.set('paper','A1',True)
  self.assertTrue(self.reports.list()['notes'][0]['starred']);self.assertFalse(self.stars.has('note',report['id']))
  restored=Favorites(self.stars.path,atomic);self.assertTrue(restored.has('report',report['id']));self.assertTrue(restored.has('paper','A1'))
 def test_search_and_restore_preserve_stars(self):
  note=self.vault.create('important','topic',[],'body');other=self.vault.create('other','topic',[],'other')
  self.stars.set('note',note['id'],True);self.assertEqual(len(self.vault.list('other')['notes']),1)
  self.vault.trash(note['id']);self.assertFalse(any(n['id']==note['id'] for n in self.vault.list()['notes']))
  self.vault.trash(note['id'],True);self.assertTrue(self.vault.get(note['id'])['starred'])
 def test_idempotent_and_validated(self):
  for _ in range(2):self.stars.set('note','a'*32,True)
  self.assertEqual(len(self.stars.snapshot()),1)
  for kind,item,value in [('note','bad',True),('report','a'*32,'true'),('unknown','a'*32,True)]:
   with self.assertRaises(ValueError):self.stars.set(kind,item,value)
if __name__=='__main__':unittest.main(verbosity=2)
