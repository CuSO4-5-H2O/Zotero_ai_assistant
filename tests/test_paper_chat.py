import sys,tempfile,unittest,json,zipfile
from pathlib import Path
from unittest.mock import Mock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from paper_chat import PaperChat,cited_pages
from release_cleanup import cleanup,PLUGIN_ID

def atomic(path,text):path.parent.mkdir(parents=True,exist_ok=True);path.write_text(text,encoding='utf-8')
class ChatTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.papers=Mock()
  self.papers.folder.side_effect=lambda pid:self.root/pid
  self.papers.item.return_value={'title':'Public test paper'}
  self.papers.pages.return_value={'status':'ready','source_signature':'original','pages':[{'number':1,'text':'Source FIRST. '*30},{'number':2,'text':'Source LAST. '*30}]}
  self.store=PaperChat(self.papers,atomic,lambda s:'<p>'+s+'</p>');self.ds=Mock();self.ds.chat_stream.side_effect=lambda messages:iter([{'type':'delta','text':'结论 [PDF 第 2 页] [PDF 第 999 页]'}, {'type':'done','text':'结论 [PDF 第 2 页] [PDF 第 999 页]','model':'test'}])
 def tearDown(self):self.tmp.cleanup()
 def ask(self,pid='D6',question='关键创新？'):
  return list(self.store.stream(pid,{'question':question,'version':self.store.get(pid)['version']},self.ds))
 def test_full_source_follow_up_and_page_bounds(self):
  self.assertEqual(cited_pages('见 [PDF 第 3–4 页] 和 [PDF 第 3、6 页]，排除 [PDF 第 999 页]',14),[3,4,6])
  done=self.ask()[-1];self.assertEqual(done['message']['cited_pages'],[2]);self.assertEqual(len(self.store.get('D6')['messages']),2)
  messages=self.ds.chat_stream.call_args.args[0];self.assertIn('Source FIRST',messages[0]['content']);self.assertIn('Source LAST',messages[0]['content'])
  self.ask(question='为什么？');self.assertEqual([m['role'] for m in self.ds.chat_stream.call_args.args[0]],['system','user','assistant','user'])
  self.assertEqual(len(PaperChat(self.papers,atomic,str).get('D6')['messages']),4)
 def test_selection_prompt_saved_and_followup_context(self):
  selected={'text':'public selected terminology','kind':'translation','page':2}
  list(self.store.stream('D6',{'question':'解释这段话','version':'0','selection_context':selected},self.ds))
  self.assertIn(selected['text'],self.ds.chat_stream.call_args.args[0][0]['content'])
  self.assertEqual(self.store.get('D6')['messages'][0]['selection_context'],selected)
  self.ask(question='继续解释')
  self.assertTrue(any(selected['text'] in m.get('content','') for m in self.ds.chat_stream.call_args.args[0] if m['role']=='user'))
 def test_invalid_selection_rejected_before_provider(self):
  for selected in [{'text':' '},{'text':'ok','kind':'unknown'},{'text':'ok','page':True}]:
   with self.assertRaises(ValueError):list(self.store.stream('D6',{'question':'解释','version':'0','selection_context':selected},self.ds))
  self.ds.chat_stream.assert_not_called();self.assertFalse(self.store.busy)
 def test_isolated_papers(self):
  self.ask();self.assertEqual(self.store.get('D7')['messages'],[])
 def test_failed_stream_not_saved_and_unlocks(self):
  def bad(messages):yield {'type':'delta','text':'partial'};raise ValueError('failed')
  self.ds.chat_stream.side_effect=bad
  with self.assertRaises(ValueError):self.ask()
  self.assertEqual(self.store.get('D6')['messages'],[]);self.assertFalse(self.store.busy)
 def test_cancel_unlocks(self):
  stream=self.store.stream('D6',{'question':'x','version':'0'},self.ds);next(stream);next(stream);stream.close();self.assertFalse(self.store.busy);self.assertFalse(self.store.path('D6').exists())
 def test_concurrent_and_stale_requests_rejected(self):
  stream=self.store.stream('D6',{'question':'x','version':'0'},self.ds);next(stream)
  with self.assertRaises(ValueError):self.ask()
  stream.close();self.ask()
  with self.assertRaises(ValueError):list(self.store.stream('D6',{'question':'x','version':'0'},self.ds))
 def test_missing_scanned_and_long_pdf(self):
  for pages in [{'status':'missing','pages':[]},{'status':'scanned','pages':[]},{'status':'ready','source_signature':'x','pages':[{'number':1,'text':'x'*180001}]}]:
   self.papers.pages.return_value=pages
   with self.assertRaises(ValueError):self.ask()
   self.assertFalse(self.store.busy)
  self.ds.chat_stream.assert_not_called()
 def test_changed_pdf_archives_history_and_resets_context(self):
  self.ask();self.papers.pages.return_value={**self.papers.pages.return_value,'source_signature':'changed'}
  events=self.ask();self.assertTrue(events[0]['source_changed']);self.assertEqual(len(self.ds.chat_stream.call_args.args[0]),2);self.assertTrue(list((self.root/'D6/chat-history').glob('*.json')))

class CleanupTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.profile=self.root/'profile';self.desktop=self.root/'desktop';self.desktop.mkdir()
  atomic(self.root/'.runtime/zotero-plugin-status.json',json.dumps({'plugin':PLUGIN_ID,'version':'1.4.0','loaded':True}))
  self.write(self.profile/'extensions'/(PLUGIN_ID+'.xpi'),'1.4.0')
 def tearDown(self):self.tmp.cleanup()
 def write(self,path,ver,plugin=PLUGIN_ID):
  path.parent.mkdir(parents=True,exist_ok=True)
  with zipfile.ZipFile(path,'w') as z:z.writestr('manifest.json',json.dumps({'version':ver,'applications':{'zotero':{'id':plugin}}}))
 def test_removes_only_older_verified_own_packages(self):
  old=self.root/'dist/research-notebook-1.3.0.xpi';new=self.root/'dist/research-notebook-1.4.0.xpi';other=self.root/'dist/research-notebook-1.2.0.xpi';future=self.root/'dist/research-notebook-1.5.0.xpi';desktop=self.desktop/'科研笔记仓库-Zotero插件-1.1.1.xpi'
  for path,ver,plugin in [(old,'1.3.0',PLUGIN_ID),(new,'1.4.0',PLUGIN_ID),(other,'1.2.0','other'),(future,'1.5.0',PLUGIN_ID),(desktop,'1.1.1',PLUGIN_ID)]:self.write(path,ver,plugin)
  self.assertEqual(len(cleanup(self.root,self.profile,'1.4.0',self.desktop)['removed']),2)
  self.assertFalse(old.exists());self.assertFalse(desktop.exists());self.assertTrue(all(p.exists() for p in [new,other,future,self.profile/'extensions'/(PLUGIN_ID+'.xpi')]))
 def test_requires_successfully_loaded_current_version(self):
  with self.assertRaises(ValueError):cleanup(self.root,self.profile,'1.3.0',self.desktop)
  self.write(self.profile/'extensions'/(PLUGIN_ID+'.xpi'),'1.1.1')
  with self.assertRaises(ValueError):cleanup(self.root,self.profile,'1.4.0',self.desktop)
if __name__=='__main__':unittest.main(verbosity=2)
