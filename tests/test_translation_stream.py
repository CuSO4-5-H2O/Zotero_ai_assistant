import json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from deepseek_client import DeepSeek,TranslationJSONStream
from server import atomic

class Response:
 def __init__(self,parts,reason='stop'):self.parts=parts;self.reason=reason;self.finished=False
 def __enter__(self):return self
 def __exit__(self,*args):pass
 def __iter__(self):
  for part in self.parts:
   yield ('data: '+json.dumps({'choices':[{'delta':{'content':part},'finish_reason':None}]})).encode()+b'\n\n'
  self.finished=True
  yield ('data: '+json.dumps({'choices':[{'delta':{},'finish_reason':self.reason}]})).encode()+b'\n\n'
  yield b'data: [DONE]\n\n'

class StreamingTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.path=Path(self.temp.name)/'settings.json';self.ds=DeepSeek(self.path,atomic)
  self.ds.save({'api_key':'test-only-not-real','model':'deepseek-flash'})
 def tearDown(self):self.temp.cleanup()
 def test_incremental_escape_and_only_translation(self):
  decoder=TranslationJSONStream();parts=['{"translation":"这是一段','译文\\uD83D','\\uDE00\\n含有\\"引号','\\"。","explanation":"do not show"}']
  self.assertEqual(''.join(decoder.feed(p) for p in parts),'这是一段译文😀\n含有"引号"。')
  self.assertTrue(decoder.ended)
 def test_first_delta_before_completion_and_persistent_cache(self):
  response=Response(['{"translation":"这是一段足够长的中文译文，用来检查流式显示','的效果与速度。"}'])
  with patch('urllib.request.urlopen',return_value=response) as call:
   generator=self.ds.translate_stream('A public paper sentence.','简体中文');first=next(generator)
   self.assertEqual(first['type'],'delta');self.assertFalse(response.finished)
   result=list(generator)[-1];self.assertEqual(result['type'],'done');self.assertNotIn('translation',result['text'])
   body=json.loads(call.call_args[0][0].data);self.assertTrue(body['stream']);self.assertEqual(body['thinking']['type'],'disabled')
  reopened=DeepSeek(self.path,atomic)
  with patch('urllib.request.urlopen',side_effect=AssertionError('Cached translation must not call provider')):
   cached=list(reopened.translate_stream('A public paper sentence.','简体中文'))
   self.assertEqual(len(cached),1);self.assertTrue(cached[0]['cached']);self.assertEqual(cached[0]['text'],result['text'])
 def test_truncated_output_not_cached(self):
  with patch('urllib.request.urlopen',return_value=Response(['{"translation":"未完整译文"}'],'length')):
   with self.assertRaisesRegex(ValueError,'完整返回'):list(self.ds.translate_stream('Hello','简体中文'))
  self.assertFalse(self.ds.translation_cache)
 def test_thinking_not_exposed(self):
  with patch('urllib.request.urlopen',return_value=Response(['{"translation":"<think>secret reasoning</think>译文"}'])):
   generator=self.ds.translate_stream('Hello','简体中文')
   with self.assertRaisesRegex(ValueError,'有效译文'):next(generator)
 def test_missing_key_and_invalid_input(self):
  for text,target in [('', '简体中文'),('x'*12001,'简体中文'),('hello','bad')]:
   with self.assertRaises(ValueError):list(self.ds.translate_stream(text,target))
 def test_chat_stream_displays_early_and_preserves_messages(self):
  response=Response(['第一段','第二段']);messages=[{'role':'system','content':'source'},{'role':'user','content':'question'}]
  with patch('urllib.request.urlopen',return_value=response) as call:
   stream=self.ds.chat_stream(messages);self.assertEqual(next(stream)['text'],'第一段');self.assertFalse(response.finished)
   self.assertEqual(list(stream)[-1]['text'],'第一段第二段');self.assertEqual(json.loads(call.call_args.args[0].data)['messages'],messages)
 def test_chat_truncation_rejected_and_cancel_releases_gate(self):
  with patch('urllib.request.urlopen',return_value=Response(['partial'],'length')):
   with self.assertRaisesRegex(ValueError,'完整返回'):list(self.ds.chat_stream([]))
  with patch('urllib.request.urlopen',return_value=Response(['partial','tail'])):
   stream=self.ds.chat_stream([]);next(stream);stream.close()
  self.assertTrue(self.ds.request_gate.acquire(blocking=False));self.assertTrue(self.ds.request_gate.acquire(blocking=False));self.ds.request_gate.release();self.ds.request_gate.release()

if __name__=='__main__':unittest.main(verbosity=2)
