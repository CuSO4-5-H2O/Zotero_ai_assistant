import sys,tempfile,unittest,threading,json,hashlib
from pathlib import Path
from unittest.mock import Mock,patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from server import Vault,atomic,Conflict
from note_tools import NoteTools
from paper_chat import PaperChat
from deepseek_client import DeepSeek

class Papers:
 def __init__(self,root):self.root=root;self.lock=threading.RLock()
 def folder(self,pid):p=self.root/pid;p.mkdir(parents=True,exist_ok=True);return p
 def item(self,pid):return {'title':'Test paper'}
 def pages(self,pid):return {'status':'ready','source_signature':'same','pages':[{'number':1,'text':'PUBLIC PDF SENTINEL '*30}]}
 def reading(self,pid):
  p=self.folder(pid)/'reading.md';text=p.read_text(encoding='utf-8') if p.exists() else ''
  return {'content':text,'version':hashlib.sha256(text.encode()).hexdigest()}
 def save_reading(self,pid,payload):
  if payload['version']!=self.reading(pid)['version']:raise Conflict('conflict')
  atomic(self.folder(pid)/'reading.md',payload['content']);return self.reading(pid)

class NoteTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.vault=Vault(self.root/'vault',seed=False);self.papers=Papers(self.root/'papers');self.tools=NoteTools(self.vault,self.papers,'D6',atomic,'用户要求')
 def tearDown(self):self.tmp.cleanup()
 def call(self,name,**args):return self.tools.execute(name,args)
 def new(self):return self.call('create_note',title='测试笔记',content='原始内容')
 def test_create_edit_delete_restore_with_history(self):
  created=self.new();nid=created['note_id'];self.assertTrue(created['ok']);doc=self.call('read_note',note_id=nid)['note']
  edited=self.call('update_note',note_id=nid,version=doc['version'],content='更新内容');self.assertTrue(edited['ok']);self.assertEqual(self.vault.get(nid)['content'],'更新内容');self.assertTrue(self.vault.history(nid))
  doc=self.call('read_note',note_id=nid)['note'];removed=self.call('delete_note',note_id=nid,version=doc['version']);self.assertTrue(removed['ok']);self.assertTrue(self.vault.get(nid)['trashed'])
  doc=self.call('read_note',note_id=nid)['note'];restored=self.call('restore_note',note_id=nid,version=doc['version']);self.assertTrue(restored['ok']);self.assertFalse(self.vault.get(nid)['trashed']);self.assertEqual(self.vault.get(nid)['content'],'更新内容')
 def test_requires_read_and_rejects_external_conflict(self):
  nid=self.new()['note_id'];doc=self.vault.get(nid)
  self.assertFalse(self.call('delete_note',note_id=nid,version=doc['version'])['ok'])
  self.call('read_note',note_id=nid);self.vault.save(nid,{**doc,'content':'外部更新'})
  self.assertFalse(self.call('delete_note',note_id=nid,version=doc['version'])['ok']);self.assertFalse(self.vault.get(nid)['trashed'])
 def test_duplicate_write_deduplicated_and_bad_tools_rejected(self):
  self.new();self.new();self.assertEqual(self.vault.list()['total'],1)
  self.assertFalse(self.call('run_shell',cmd='bad')['ok']);self.assertFalse(self.call('read_note',note_id='../secret')['ok']);self.assertFalse(self.call('create_note',title='x',content='y',path='C:/secret')['ok'])
 def test_current_paper_soft_delete_restore(self):
  doc=self.call('read_note',note_id='current_paper')['note'];self.assertTrue(self.call('update_note',note_id='current_paper',version=doc['version'],content='原精读内容')['ok'])
  doc=self.call('read_note',note_id='current_paper')['note'];self.assertTrue(self.call('delete_note',note_id='current_paper',version=doc['version'])['ok']);self.assertEqual(self.papers.reading('D6')['content'],'')
  doc=self.call('read_note',note_id='current_paper')['note'];self.assertTrue(doc['trashed']);self.assertTrue(self.call('restore_note',note_id='current_paper',version=doc['version'])['ok']);self.assertEqual(self.papers.reading('D6')['content'],'原精读内容')
 def test_unique_search_combines_read_and_metadata_update_preserves_body(self):
  nid=self.new()['note_id'];found=self.call('search_notes',query='测试笔记')['note']
  self.assertEqual(found['content'],'原始内容');self.assertTrue(self.call('update_note',note_id=nid,version=found['version'],title='改名后')['ok']);self.assertEqual(self.vault.get(nid)['content'],'原始内容')
 def test_restore_action_from_durable_record(self):
  nid=self.new()['note_id'];doc=self.call('read_note',note_id=nid)['note'];self.call('delete_note',note_id=nid,version=doc['version']);record=self.tools.logs()[-1]
  store=PaperChat(self.papers,atomic,str,self.vault);result=store.restore_action('D6',record['id']);self.assertTrue(result['ok']);self.assertFalse(self.vault.get(nid)['trashed'])
 def test_retry_after_interruption_does_not_duplicate_created_note(self):
  first=NoteTools(self.vault,self.papers,'D6',atomic,'新建测试笔记','version0');created=first.execute('create_note',{'title':'重试测试','content':'body'})
  reopened=NoteTools(self.vault,self.papers,'D6',atomic,'新建测试笔记','version0');reused=reopened.execute('create_note',{'title':'重试测试','content':'body','folder':'文献笔记','tags':['D6']})
  self.assertEqual(created['note_id'],reused['note_id']);self.assertEqual(self.vault.list()['total'],1)
 def test_tool_loop_skips_pdf_and_extra_summary_call_for_simple_create(self):
  store=PaperChat(self.papers,atomic,str,self.vault);ds=Mock()
  self.papers.pages=Mock(side_effect=AssertionError('Pure note management must not parse PDF'))
  ds.chat_stream.return_value=iter([{'type':'done','text':'','model':'test','tool_calls':[{'id':'call_1','type':'function','function':{'name':'create_note','arguments':json.dumps({'title':'速度测试','content':'body'})}}]}])
  result=list(store.stream('D6',{'question':'新建笔记，标题速度测试，正文body','version':'0'},ds));self.assertEqual(result[-1]['type'],'done');self.assertEqual(ds.chat_stream.call_count,1);self.assertNotIn('PUBLIC PDF SENTINEL',ds.chat_stream.call_args.args[0][0]['content']);self.assertEqual(len(store.get('D6')['recent_actions']),1)
 def test_action_survives_provider_failure_and_normal_qa_has_no_tools(self):
  store=PaperChat(self.papers,atomic,str,self.vault);ds=Mock()
  first=iter([{'type':'done','text':'','model':'test','tool_calls':[{'id':'c','type':'function','function':{'name':'create_note','arguments':json.dumps({'title':'持久记录','content':'body'})}}]}])
  def fail():raise ValueError('provider failed');yield
  ds.chat_stream.side_effect=[first,fail()]
  with self.assertRaises(ValueError):list(store.stream('D6',{'question':'新建笔记并总结论文创新','version':'0'},ds))
  self.assertEqual(len(store.get('D6')['recent_actions']),1);self.assertEqual(store.get('D6')['messages'],[])
  ds.chat_stream.reset_mock();ds.chat_stream.side_effect=None;ds.chat_stream.return_value=iter([{'type':'done','text':'answer','model':'test'}]);list(store.stream('D6',{'question':'这篇论文的创新是什么？','version':'0'},ds));self.assertIn('tools',ds.chat_stream.call_args.kwargs)

class ToolStreamTests(unittest.TestCase):
 def test_split_function_call_is_assembled_before_execution(self):
  with tempfile.TemporaryDirectory() as folder:
   ds=DeepSeek(Path(folder)/'settings.json',atomic);ds.save({'api_key':'test-only','model':'deepseek-flash'})
   chunks=[{'choices':[{'delta':{'tool_calls':[{'index':0,'id':'call_1','type':'function','function':{'name':'create_note','arguments':'{"title":"test",'}}]},'finish_reason':None}]},{'choices':[{'delta':{'tool_calls':[{'index':0,'function':{'arguments':'"content":"body"}'}}]},'finish_reason':'tool_calls'}]}]
   class Response:
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def __iter__(self):return iter([*[(('data: '+json.dumps(x)+'\n').encode()) for x in chunks],b'data: [DONE]\n'])
   with patch('urllib.request.urlopen',return_value=Response()):
    result=list(ds.chat_stream([{'role':'user','content':'create note'}],tools=[{'type':'function'}]))[-1]
   self.assertEqual(json.loads(result['tool_calls'][0]['function']['arguments']),{'title':'test','content':'body'})
if __name__=='__main__':unittest.main(verbosity=2)
