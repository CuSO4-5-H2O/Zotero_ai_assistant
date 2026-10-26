from pathlib import Path
import sys,json,unittest,tempfile,pathlib,threading
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from chatgpt_client import ChatGPT
class Response:
 def __init__(self,events):self.events=events
 def __enter__(self):return self
 def __exit__(self,*a):pass
 def __iter__(self):return iter(('data: '+json.dumps(event)+'\n').encode() for event in self.events)
class StreamTests(unittest.TestCase):
 def client(self):
  c=ChatGPT(pathlib.Path(tempfile.gettempdir())/'unused-credentials',lambda *a:None)
  c.access=lambda account:('test-account','not-a-real-token')
  c.models=lambda **kwargs:[{'id':'fixture','reasoning_levels':['low']}]
  return c
 def run_stream(self,events):
  with patch('chatgpt_client.request.urlopen',return_value=Response(events)):
   return list(self.client().chat_stream([{'role':'user','content':'create note'}],tools=[{'type':'function','function':{'name':'create_note','parameters':{'type':'object','properties':{}}}}],model='fixture'))
 def test_tool_items_survive_empty_completed_output(self):
  reasoning={'id':'r','type':'reasoning','encrypted_content':'opaque','summary':[]}
  call={'id':'f','call_id':'call_1','type':'function_call','namespace':'notebook','name':'create_note','arguments':'{"title":"test","content":"test"}'}
  out=self.run_stream([{'type':'response.output_item.done','output_index':0,'item':reasoning},{'type':'response.output_item.done','output_index':1,'item':call},{'type':'response.completed','response':{'output':[]}}])[-1]
  self.assertEqual(out['tool_calls'][0]['function']['name'],'create_note');self.assertEqual(len(out['response_output']),2)
  replay=ChatGPT.body([{'role':'assistant','content':None,'_response_output':out['response_output']},{'role':'tool','tool_call_id':'call_1','content':'{"ok":true}'}],'fixture')
  self.assertEqual(replay['input'][0]['type'],'reasoning');self.assertEqual(replay['input'][-1]['type'],'function_call_output')
 def test_final_output_does_not_duplicate_streamed_call(self):
  call={'id':'f','call_id':'call_1','type':'function_call','name':'create_note','arguments':'{}'}
  out=self.run_stream([{'type':'response.output_item.done','output_index':0,'item':call},{'type':'response.completed','response':{'output':[call]}}])[-1]
  self.assertEqual(len(out['tool_calls']),1)
 def test_final_message_without_text_deltas(self):
  item={'id':'m','type':'message','content':[{'type':'output_text','text':'verified receipt'}]}
  out=self.run_stream([{'type':'response.output_item.done','output_index':0,'item':item},{'type':'response.completed','response':{'output':[]}}])[-1]
  self.assertEqual(out['text'],'verified receipt')
 def test_uncompleted_stream_cannot_execute_tool(self):
  with self.assertRaises(ValueError):self.run_stream([{'type':'response.output_item.done','output_index':0,'item':{'type':'function_call','name':'create_note','call_id':'x','arguments':'{}'}}])
if __name__=='__main__':unittest.main(verbosity=2)
