import base64, io, json, tempfile, unittest
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from pypdf import PdfWriter
from pypdf.generic import NameObject, DictionaryObject, DecodedStreamObject
from server import atomic, Conflict, render_markdown, Handler
from types import SimpleNamespace
from unittest.mock import patch
from literature import crossref
from paper_library import PaperLibrary
from project_files import ProjectFiles

class ReleaseRegression(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
    def tearDown(self):self.tmp.cleanup()
    def test_port_scoped_sessions_and_legacy_reconnect(self):
        handler=object.__new__(Handler);handler.server=SimpleNamespace(server_port=12345,key='own-secret')
        handler.headers={'Cookie':'research_notebook_12345=own-secret; research_notebook_23456=other-secret; research_notebook=other-secret'}
        self.assertTrue(handler.authenticated())
        handler.headers={'Cookie':'research_notebook_12345=wrong; research_notebook=own-secret'}
        self.assertFalse(handler.authenticated())
        handler.headers={'Cookie':'research_notebook=own-secret'}
        self.assertTrue(handler.authenticated())
    def test_search_rejects_supplements_as_main_papers(self):
        class Response:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self,*args):return json.dumps({'message':{'items':[
                {'DOI':'10.1234/paper.s001','title':['Supplement'],'type':'component'},
                {'DOI':'10.1234/paper','title':['Main paper'],'type':'journal-article','issued':{'date-parts':[[None]]}}
            ]}}).encode()
        with patch('literature.request.urlopen',return_value=Response()):
            result=crossref('public fixture',5)
        self.assertEqual([r['doi'] for r in result],['10.1234/paper'])
        self.assertEqual(result[0]['year'],'')
    def test_empty_install_without_research_directory(self):
        lib=PaperLibrary(self.root/'papers',self.root/'absent-source',atomic,Conflict,render_markdown)
        self.assertEqual(lib.refs,{})
        self.assertEqual(json.loads((lib.root/'catalog.json').read_text()),[])
    def test_zotero_linked_pdf_extraction_and_reading_separation(self):
        writer=PdfWriter()
        for n in range(1,4):
            page=writer.add_blank_page(width=600,height=800)
            font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
            page[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):writer._add_object(font)})})
            stream=DecodedStreamObject();stream.set_data(('BT /F1 12 Tf 40 700 Td (Public regression page '+str(n)+' '+('Evidence text. '*30)+') Tj ET').encode())
            page[NameObject('/Contents')]=writer._add_object(stream)
        pdf=self.root/'storage'/'ABCD1234'/'paper.pdf';pdf.parent.mkdir(parents=True);writer.write(pdf)
        catalog=self.root/'papers'/'catalog.json'
        atomic(catalog,json.dumps([dict(id='A1',title='Public fixture',author='A',year='2026',venue='test',innovation='test',type='test',relation='test',access='full',boundary='test',zotero={'path':str(pdf),'attachment_key':'ABCD1234'})]))
        lib=PaperLibrary(catalog.parent,self.root/'absent',atomic,Conflict,render_markdown)
        pages=lib.pages('A1');self.assertEqual(len(pages['pages']),3)
        self.assertIn('page 3',pages['pages'][2]['text'])
        guide=lib.get('A1')['guide'];reading=lib.reading('A1')
        lib.save_reading('A1',{'version':reading['version'],'content':'Personal note'})
        self.assertEqual(lib.get('A1')['guide'],guide)
        with self.assertRaises(ValueError):lib.decode_pdf_upload({'data':base64.b64encode(b'not a PDF').decode()})
    def test_project_edit_conflict_trash_restore_and_image(self):
        project=ProjectFiles(self.root/'config'/'settings.json',atomic).bind()
        created=project.execute('create_project_file',{'path':'plan.md','content':'original'})
        read=project.read('plan.md')
        project.execute('update_project_file',{'path':'plan.md','version':read['version'],'content':'updated'})
        read=project.read('plan.md');project.path('plan.md').write_text('external','utf-8')
        with self.assertRaises(ValueError):project.execute('update_project_file',{'path':'plan.md','version':read['version'],'content':'overwrite'})
        read=project.read('plan.md');deleted=project.execute('trash_project_file',{'path':'plan.md','version':read['version']})
        project.execute('restore_project_file',{'path':'plan.md','history_id':deleted['history_id']})
        self.assertEqual(project.read('plan.md')['content'],'external')
        image=b'\x89PNG\r\n\x1a\nfixture'
        project.import_file('figures/figure.png',base64.b64encode(image).decode())
        self.assertEqual(project.path('figures/figure.png').read_bytes(),image)
        with self.assertRaises(ValueError):project.path('../outside.txt',True)

if __name__=='__main__':unittest.main()
