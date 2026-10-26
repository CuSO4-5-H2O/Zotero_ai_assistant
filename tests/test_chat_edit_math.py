import sys,tempfile,unittest,json
from pathlib import Path
from unittest.mock import Mock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from paper_chat import PaperChat
from markdown_view import render_markdown
from assistant_rules import ASSISTANT_RULES

def atomic(p,s):p.parent.mkdir(parents=True,exist_ok=True);p.write_text(s,encoding='utf-8')
class Tests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.papers=Mock();self.papers.folder.side_effect=lambda pid:self.root/pid
  self.chat=PaperChat(self.papers,atomic,render_markdown)
  self.original={'version':'v1','messages':[{'id':str(i),'role':'user' if i%2==0 else 'assistant','content':str(i)} for i in range(4)],'source_signature':'pdf'}
  atomic(self.chat.path('D6'),json.dumps(self.original))
 def tearDown(self):self.tmp.cleanup()
 def test_delete_answer_removes_whole_turn_and_persists(self):
  d=self.chat.edit('D6',{'action':'delete_turn','message_id':'1','version':'v1'})
  self.assertEqual([m['id'] for m in d['messages']],['2','3']);self.assertTrue(d['can_undo']);self.assertNotIn('undo_key',d)
  self.assertEqual([m['id'] for m in self.chat.get('D6')['messages']],['2','3'])
  self.assertEqual(self.chat.get('D7')['messages'],[])
 def test_clear_undo_and_stale_version(self):
  d=self.chat.edit('D6',{'action':'clear','version':'v1'});self.assertEqual(d['messages'],[])
  with self.assertRaises(ValueError):self.chat.edit('D6',{'action':'undo','version':'v1'})
  d=self.chat.edit('D6',{'action':'undo','version':d['version']});self.assertEqual(d['messages'][0]['id'],'0');self.assertEqual(len(d['messages']),4)
 def test_undo_preserves_subsequent_turns(self):
  d=self.chat.edit('D6',{'action':'clear','version':'v1'})
  raw=self.chat.read('D6');raw['messages']=[{'id':'new-user','role':'user','content':'new question'},{'id':'new-ai','role':'assistant','content':'new answer'}];atomic(self.chat.path('D6'),json.dumps(raw))
  d=self.chat.edit('D6',{'action':'undo','version':d['version']})
  self.assertEqual(len(d['messages']),6);self.assertEqual(d['messages'][-1]['id'],'new-ai')
 def test_busy_invalid_and_traversal(self):
  self.chat.busy.add('D6')
  with self.assertRaises(ValueError):self.chat.edit('D6',{'action':'clear','version':'v1'})
  self.chat.busy.clear()
  for action in [{'action':'delete_turn','message_id':'missing'},{'action':'x'},{'action':'undo'}]:
   with self.assertRaises(ValueError):self.chat.edit('D6',{'version':'v1',**action})
 def test_formula_styles_and_code(self):
  for value in [r'$x_1=\frac{a}{b}$',r'\(x_1=\frac{a}{b}\)',r'\[\sum_n a_n\]',r'正文 \[\sum_n a_n\] 结束',r'$$\begin{aligned}a&=b\\c&=d\end{aligned}$$']:
   html=render_markdown(value);self.assertIn('class="math-',html);self.assertNotIn('<em>',html)
  self.assertIn(r'<code>\[x\]</code>',render_markdown(r'`\[x\]`'))
 def test_default_rules_attached_to_provider(self):
  self.papers.item.return_value={'title':'test'};self.papers.pages.return_value={'status':'ready','source_signature':'s','pages':[{'number':1,'text':'evidence'}]}
  provider=Mock();provider.chat_stream.return_value=iter([{'type':'done','text':'$x^2$','model':'test'}])
  list(self.chat.stream('D7',{'version':'0','question':'解释公式'},provider))
  self.assertIn(ASSISTANT_RULES,provider.chat_stream.call_args.args[0][0]['content'])
if __name__=='__main__':unittest.main(verbosity=2)
