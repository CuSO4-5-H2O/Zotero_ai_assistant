import sys,tempfile,unittest,importlib.util,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('notebook',str(Path(__file__).resolve().parents[1]/'server.py'))
nb=importlib.util.module_from_spec(spec);spec.loader.exec_module(nb)
class NotebookTest(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='research_notes_')
  self.v=nb.Vault(Path(self.temp.name),seed=False)
 def tearDown(self):self.temp.cleanup()
 def make(self):
  return self.v.create('低空链路研究','课题想法',['RIS','波束校准'],'# 低空链路研究\n\n预测跟踪与残余相位。')
 def payload(self,d,**kw):
  p={k:d[k] for k in ['title','folder','tags','content','version']};p.update(kw);return p
 def test_save_and_reload(self):
  d=self.make();s=self.v.save(d['id'],self.payload(d,content=d['content']+'\n\n新的实验思路。'))
  restarted=nb.Vault(self.v.root,seed=False)
  self.assertIn('新的实验思路',restarted.get(d['id'])['content']);self.assertNotEqual(d['version'],s['version'])
 def test_conflict_preserves_external_change(self):
  d=self.make();self.v.path(d).write_text('外部编辑',encoding='utf-8')
  with self.assertRaises(nb.Conflict):self.v.save(d['id'],self.payload(d,content='覆盖'))
  self.assertEqual(self.v.get(d['id'])['content'],'外部编辑')
 def test_history_and_restore(self):
  d=self.make();s=self.v.save(d['id'],self.payload(d,content='第二版'))
  h=self.v.history(d['id']);self.assertEqual(len(h),1)
  old=self.v.historical(d['id'],h[0]['key']);restored=self.v.save(d['id'],self.payload(s,content=old['content']))
  self.assertEqual(restored['content'],d['content']);self.assertEqual(len(self.v.history(d['id'])),2)
 def test_move_and_search(self):
  d=self.make();s=self.v.save(d['id'],self.payload(d,title='自适应波束',folder='实验记录'))
  self.assertFalse(self.v.path(d).exists());self.assertTrue(self.v.path(s).exists())
  self.assertEqual(len(self.v.list('预测 RIS','实验记录')['notes']),1)
 def test_trash_restore(self):
  d=self.make();self.v.trash(d['id']);self.assertEqual(self.v.list()['total'],0)
  self.assertEqual(len(self.v.list(trash=True)['notes']),1)
  r=self.v.trash(d['id'],restore=True);self.assertEqual(r['content'],d['content']);self.assertEqual(self.v.list()['total'],1)
 def test_renderer(self):
  s=nb.render_markdown('# 示例\n\n<script>alert(1)</script>\n\n[坏链接](javascript:alert(1))\n\n| a | b |\n|---|---|\n| c | d |')
  self.assertNotIn('<script>',s);self.assertNotIn('href=\"javascript:',s);self.assertIn('<table>',s)
 def test_paths(self):
  d=self.v.create('../不越界','../分类',[],'test')
  self.assertTrue(self.v.path(d).is_relative_to(self.v.root))
  with self.assertRaises(ValueError):self.v.path({'file':'../outside.md'})
 def test_two_views_conflict(self):
  a=self.make();b=self.v.get(a['id'])
  self.v.save(a['id'],self.payload(a,content='窗口A'))
  with self.assertRaises(nb.Conflict):self.v.save(b['id'],self.payload(b,content='窗口B'))
if __name__=='__main__':unittest.main(verbosity=2)
