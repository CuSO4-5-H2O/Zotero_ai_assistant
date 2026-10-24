import sys,tempfile,json,base64,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from server import Vault,atomic,Conflict,render_markdown
from paper_library import PaperLibrary
from paper_chat import PaperChat
from project_files import ProjectFiles
from research_tools import ResearchTools
from content_layout import separate
class Layout(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
  self.v=Vault(self.root/'vault',False);self.r=Vault(self.root/'reports',False);self.r.category='reports'
  source=self.root/'source';source.mkdir();atomic(source/'references.json',json.dumps([dict(id='A1',title='Public test',author='A',year='2026',venue='test',innovation='demo',type='test',relation='direct',access='test',boundary='test')]))
  atomic(self.v.root/'.papers/catalog.json',(source/'references.json').read_text('utf-8'))
  self.p=PaperLibrary(self.v.root/'.papers',source,atomic,Conflict,render_markdown)
  self.projects=ProjectFiles(self.root/'config'/'project-settings.json',atomic)
 def tearDown(self):self.tmp.cleanup()
 def test_migration_idempotence_content_and_separation(self):
  self.v.category='legacy';report=self.v.create('report','调研报告',[],'REPORT SENTINEL')
  self.v.create('翻译笔记 · A1', '文献笔记', [],'TRANSLATION SENTINEL')
  guide=self.p.guide('A1');self.p.save_reading('A1',{'version':self.p.reading('A1')['version'],'content':guide+'\nPERSONAL SENTINEL'})
  self.v.category='notes';result=separate(self.v,self.r,self.p,atomic,self.root/'backup')
  self.assertEqual(result,dict(reports=1,paper_notes=1,guides=1));self.assertEqual(self.r.get(report['id'])['content'],'REPORT SENTINEL')
  note=self.p.reading('A1')['content'];self.assertIn('PERSONAL SENTINEL',note);self.assertIn('TRANSLATION SENTINEL',note);self.assertNotIn(guide,note)
  self.assertEqual(len(self.v.list()['notes']),0);self.assertEqual(separate(self.v,self.r,self.p,atomic,self.root/'backup'),dict(reports=0,paper_notes=0,guides=0));self.assertEqual(self.p.reading('A1')['content'],note)
  with self.assertRaises(ValueError):self.v.create('bad','调研报告',[],'no')
 def test_assistant_append_delete_restore_and_project_archive(self):
  t=ResearchTools(self.v,self.p,'A1',atomic,'把它放进去',projects=self.projects)
  names={x['function']['name'] for x in t.tools};self.assertTrue({'web_search','read_web_page','append_note','delete_note','create_note'}<=names)
  doc=t.read('current_paper');self.assertTrue(t.execute('append_note',dict(note_id='current_paper',version=doc['version'],content='ORIGINAL'))['ok'])
  doc=t.read('current_paper');self.assertTrue(t.execute('append_note',dict(note_id='current_paper',version=doc['version'],content='NEW'))['ok']);self.assertEqual(self.p.reading('A1')['content'],'ORIGINAL\n\nNEW\n');self.assertEqual(self.v.list()['total'],0)
  doc=t.read('current_paper');self.assertTrue(t.execute('delete_note',dict(note_id='current_paper',version=doc['version']))['ok']);doc=t.read('current_paper');self.assertTrue(t.execute('restore_note',dict(note_id='current_paper',version=doc['version']))['ok'])
  chat=PaperChat(self.p,atomic,render_markdown,self.v,self.projects);atomic(chat.path('A1'),json.dumps({'version':'v','messages':[{'id':'u','role':'user','content':'ARCHIVE QUESTION'},{'id':'a','role':'assistant','content':'ARCHIVE ANSWER'}]}))
  result=chat.archive('A1',{'version':'v'});self.assertIn('ARCHIVE ANSWER',(self.projects.bind().root/result['title']).read_text('utf-8'));self.assertEqual(self.v.list()['total'],0)
  session=self.projects.bind();raw=b'public image data';session.import_file('images/test.png',base64.b64encode(raw).decode());self.assertEqual((session.root/'images/test.png').read_bytes(),raw)
  with self.assertRaises(ValueError):session.import_file('images/test.png',base64.b64encode(b'overwrite').decode())
  with self.assertRaises(ValueError):session.import_file('../escape.png','eA==')
if __name__=='__main__':unittest.main()
