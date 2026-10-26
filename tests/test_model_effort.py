import sys,tempfile,json,unittest
from pathlib import Path
from unittest.mock import Mock,patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from ai_service import AIService
from chatgpt_client import ChatGPT
from deepseek_client import DeepSeek

def atomic(p,s):p.parent.mkdir(parents=True,exist_ok=True);p.write_text(s,encoding='utf-8')
class Response:
 def __enter__(self):return self
 def __exit__(self,*args):pass
 def __iter__(self):
  yield ('data: '+json.dumps({'choices':[{'delta':{'reasoning_content':'internal reasoning'},'finish_reason':None}]})).encode()+b'\n'
  yield ('data: '+json.dumps({'choices':[{'delta':{'content':'public answer'},'finish_reason':'stop'}]})).encode()+b'\n'
  yield b'data: [DONE]\n'
class Tests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.ds=Mock();self.gpt=Mock();self.gpt.public.return_value={'active':'test-account'};self.ds.public.return_value={'model':'deepseek-flash'}
  self.gpt.models.return_value=[{'id':'model-a','reasoning_levels':['low','high'],'name':'A'}]
  self.ds.models.return_value=[{'id':'deepseek-flash','reasoning_levels':['none','low','high','max'],'name':'Flash'}]
  self.ai=AIService(self.root/'settings.json',atomic,self.ds,self.gpt)
 def tearDown(self):self.tmp.cleanup()
 def test_binding_freezes_model_effort_and_translation_independent(self):
  self.ai.save({'assistant':'chatgpt','model':'model-a','chatgpt_effort':'high'})
  bound=self.ai.bind();self.ai.save({'chatgpt_effort':'low'})
  self.gpt.chat_stream.return_value=iter([{'type':'done','text':'ok'}]);list(bound.chat_stream([{'role':'user','content':'hi'}]))
  self.assertEqual(self.gpt.chat_stream.call_args.args[-3:],('model-a','test-account','high'))
  self.assertEqual(self.ai.bind('translation').effort,'')
 def test_capabilities_and_validation(self):
  rows=self.ai.catalog()['models'];self.assertEqual({m['provider'] for m in rows},{'deepseek','chatgpt'})
  with self.assertRaises(ValueError):self.ai.save({'assistant':'chatgpt','model':'model-a','chatgpt_effort':'ultra'})
  self.assertFalse(self.ai.path.exists())
  data=self.ai.save({'assistant':'deepseek','deepseek_model':'deepseek-flash','deepseek_effort':'max'});self.assertEqual(data['deepseek_effort'],'max')
  with self.assertRaises(ValueError):self.ai.save({'deepseek_effort':'medium'})
 def test_responses_wire_format(self):
  body=ChatGPT.body([{'role':'user','content':'test'}],'model-a',effort='high');self.assertEqual(body['reasoning'],{'effort':'high'})
  self.assertNotIn('reasoning',ChatGPT.body([{'role':'user','content':'test'}],'model-a'))
 def test_deepseek_wire_format_and_no_reasoning_in_display(self):
  ds=DeepSeek(self.root/'deepseek.json',atomic);ds.save({'api_key':'test-only-not-real','model':'deepseek-flash'})
  with patch('urllib.request.urlopen',return_value=Response()) as request:
   events=list(ds.chat_stream([{'role':'user','content':'test'}],model_override='deepseek-v4-pro',effort='high'))
  body=json.loads(request.call_args.args[0].data);self.assertEqual(body['model'],'deepseek-v4-pro');self.assertEqual(body['thinking']['type'],'enabled');self.assertEqual(body['reasoning_effort'],'high');self.assertNotIn('temperature',body)
  self.assertNotIn('internal reasoning',json.dumps(events));self.assertEqual(events[-1]['text'],'public answer')
if __name__=='__main__':unittest.main(verbosity=2)
