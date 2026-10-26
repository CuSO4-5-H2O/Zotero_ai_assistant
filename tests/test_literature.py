import sys,tempfile,unittest,time,threading,json
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from server import atomic,Conflict,render_markdown,Handler
from literature import LiteratureService,crossref
from paper_library import PaperLibrary
from zotero_source import ZoteroStorage

CANDIDATE=dict(candidate_id='a'*24,title='Public research fixture',doi='10.1234/public.fixture',authors=[],year='2025',venue='Public',pdf_urls=[],source='Crossref')
class LiteratureTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.calls=[]
  def native(payload):
   self.calls.append(payload);return dict(ok=True,created=True,pdf_status='not_found',metadata={'library_id':1,'item_key':'ABCDEFGH','title':CANDIDATE['title'],'doi':CANDIDATE['doi']})
  self.native=native;self.service=LiteratureService(self.root/'runtime',atomic,native,lambda p:{'id':'Z1_'+p['item_key']})
 def tearDown(self):self.service.pool.shutdown(wait=True);self.tmp.cleanup()
 def wait(self,id):
  for _ in range(100):
   job=self.service.get(id)
   if job['status'] not in {'queued','running','cancelling'}:return job
   time.sleep(.01)
  self.fail('job did not terminate')
 def test_verified_candidates_only_and_truthful_counts(self):
  with self.assertRaises(ValueError):self.service.start(['forged'])
  with patch('literature.crossref',return_value=[CANDIDATE]):self.service.search('public fixture')
  result=self.wait(self.service.start([CANDIDATE['candidate_id']])['id'])
  self.assertEqual((result['status'],result['metadata_saved'],result['pdf_available'],result['pdf_downloaded']),('completed',1,0,0));self.assertEqual(len(self.calls),1)
  restarted=LiteratureService(self.root/'runtime',atomic,self.native,lambda p:{})
  try:self.assertEqual(restarted.get(result['id'])['rows'][0]['paper_id'],'Z1_ABCDEFGH')
  finally:restarted.pool.shutdown()
 def test_cancel_stops_following_items_and_active_task_dedup(self):
  started=threading.Event();release=threading.Event()
  def native(p):started.set();release.wait(2);return self.native(p)
  self.service.native=native;second={**CANDIDATE,'candidate_id':'b'*24,'doi':'10.1234/second'}
  with patch('literature.crossref',return_value=[CANDIDATE,second]):self.service.search('public fixtures')
  ids=[CANDIDATE['candidate_id'],second['candidate_id']];job=self.service.start(ids);self.assertTrue(started.wait(1));self.assertEqual(job['id'],self.service.start(ids)['id']);self.service.cancel(job['id']);release.set();result=self.wait(job['id']);self.assertEqual((result['status'],result['processed']),('cancelled',1))
 def test_parent_without_pdf_and_later_attachment_keep_one_note_id(self):
  papers=self.root/'papers';atomic(papers/'catalog.json','[]');library=PaperLibrary(papers,self.root/'source',atomic,Conflict,render_markdown);storage=ZoteroStorage(library,self.root/'storage')
  payload=dict(library_id=1,item_key='ABCDEFGH',title='Public paper',doi='10.1234/public')
  first=storage.register_parent(payload);self.assertIsNone(library.pdf(first['id']))
  (self.root/'zotero.sqlite').touch() # Isolated directory marker, never a real Zotero database.
  pdf=self.root/'storage/PDF23456/test.pdf';pdf.parent.mkdir(parents=True);pdf.write_bytes(b'%PDF-1.4\npublic test fixture\n%%EOF\n')
  second=storage.register_parent({**payload,'attachment_key':'PDF23456','path':str(pdf)});self.assertEqual(first['id'],second['id']);self.assertEqual(len(library.refs),1);self.assertEqual(library.pdf(first['id']),pdf.resolve())
 def test_input_bounds(self):
  for args in [('',1,None,None),('q',30,None,None),('q',1,2026,2020)]:
   with self.assertRaises(ValueError):crossref(*args)
 def test_new_frontend_module_is_served_by_authenticated_router(self):
  server=ThreadingHTTPServer(('127.0.0.1',0),Handler);server.key='public-test-only';thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
  try:
   req=urllib.request.Request('http://127.0.0.1:'+str(server.server_port)+'/literature-ui.js',headers={'Authorization':'Bearer public-test-only'})
   with urllib.request.urlopen(req) as response:self.assertEqual(response.status,200);self.assertIn('ResearchLiterature',response.read().decode())
  finally:server.shutdown();server.server_close();thread.join()
if __name__=='__main__':unittest.main()
