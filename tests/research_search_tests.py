from pathlib import Path
import sys,unittest,tempfile,pathlib,json,os,io
from unittest.mock import patch
from urllib.error import HTTPError
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import literature_providers as providers
from literature import LiteratureService

def atomic(path,text):
    path=pathlib.Path(path);path.parent.mkdir(parents=True,exist_ok=True);path.write_text(text,encoding='utf-8')

class SearchTests(unittest.TestCase):
    def test_encrypted_settings(self):
        with tempfile.TemporaryDirectory() as folder,patch.dict(os.environ,{},clear=True):
            settings=providers.SearchSettings(pathlib.Path(folder)/'settings.json',atomic)
            settings.save({'elicit_key':'test-key-never-show','default_provider':'elicit'})
            self.assertEqual(settings.key(),'test-key-never-show')
            self.assertNotIn('test-key-never-show',settings.path.read_text())
            self.assertNotIn('test-key-never-show',json.dumps(settings.public()))
            settings.save({'elicit_key':''});self.assertTrue(settings.public()['elicit_configured'])
            settings.save({'clear_elicit_key':True});self.assertFalse(settings.public()['elicit_configured'])
    def test_normalization_and_missing_identifiers(self):
        data={'papers':[{'title':'<b>Useful paper</b>','doi':'https://doi.org/10.1000/test','year':2025,'authors':['A Researcher'],'fullTextUrl':'https://example.org/paper.pdf','urls':['file:///private.pdf']},{'title':'No identifier'},{'title':'Preprint','urls':['https://arxiv.org/abs/2501.12345'],'year':2025}],'warnings':[{'message':'Test provider warning'}]}
        rows,warnings=providers.normalize_elicit(data,2024,2026)
        self.assertEqual(len(rows),2);self.assertEqual(rows[0]['doi'],'10.1000/test')
        self.assertEqual(rows[0]['title'],'Useful paper');self.assertEqual(rows[0]['pdf_urls'],['https://example.org/paper.pdf'])
        self.assertEqual(len(warnings),2)
    def test_elicit_v2_contract(self):
        seen=[]
        class Response(io.BytesIO):
            def __enter__(self):return self
            def __exit__(self,*args):self.close()
        def urlopen(req,timeout):
            seen.append(req);return Response(json.dumps({'papers':[]}).encode())
        with patch.object(providers.request,'urlopen',urlopen):providers.elicit_search('research question',5,2020,2026,'fake-key')
        self.assertEqual(seen[0].full_url,providers.ELICIT_ENDPOINT)
        body=json.loads(seen[0].data);self.assertEqual(body['filters'],{'minYear':2020,'maxYear':2026});self.assertEqual(body['searchMode'],'semantic')
        with patch.object(providers.request,'urlopen',side_effect=HTTPError(providers.ELICIT_ENDPOINT,403,'Forbidden',{},None)):
            with self.assertRaisesRegex(ValueError,'Elicit'):providers.elicit_search('research question',5,None,None,'fake-key')
    def test_combined_dedup_and_default_auto(self):
        a={'candidate_id':'same','doi':'10.1000/test','title':'Test','pdf_urls':[],'source':'Crossref'}
        b={**a,'source':'Elicit','pdf_urls':['https://example.org/p.pdf']}
        with tempfile.TemporaryDirectory() as folder:
            service=LiteratureService(folder,atomic,lambda data:None,lambda data:None)
            with patch('literature.crossref',return_value=[a]),patch.object(providers,'elicit_search',return_value=([b],[])),patch.object(service.settings,'key',return_value='fake-key'):
                result=service.search('test',provider='combined')
            self.assertEqual(len(result['results']),1);self.assertEqual(result['results'][0]['pdf_urls'],b['pdf_urls'])
            self.assertTrue((pathlib.Path(folder)/'candidates.json').exists())
            service.pool.shutdown(wait=True)
    def test_identifier_resolution(self):
        a={'candidate_id':'one','doi':'10.1000/test','title':'Test','pdf_urls':[]}
        with tempfile.TemporaryDirectory() as folder:
            service=LiteratureService(folder,atomic,lambda data:None,lambda data:None)
            with patch('literature.crossref',return_value=[a]) as search:
                result=service.search_identifiers('DO  - 10.1000/test\nhttps://doi.org/10.1000/test')
                self.assertEqual(search.call_count,1);self.assertEqual(len(result['results']),1)
            with self.assertRaises(ValueError):service.search_identifiers('no identifier')
            service.pool.shutdown(wait=True)

if __name__=='__main__':unittest.main(verbosity=2)
