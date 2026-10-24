"""Read-only Zotero metadata; PDFs remain in Zotero storage."""
import json
from pathlib import Path
import re
import unicodedata
import urllib.request
from urllib.parse import unquote, urlsplit

def normalized_title(value):
    return ''.join(c for c in unicodedata.normalize('NFKC',value).casefold() if c.isalnum())

def doi(value):
    return re.sub(r'^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)','',str(value).strip(),flags=re.I).rstrip('/').casefold()

class ZoteroStorage:
    def __init__(self, papers, storage):
        self.papers=papers
        self.storage=Path(storage).resolve()

    def register_parent(self,payload):
        if payload.get('attachment_key') and payload.get('path'):return self.register(payload)
        library=payload.get('library_id');key=payload.get('item_key');title=str(payload.get('title','')).strip()[:1000]
        if type(library)!=int or library<1 or not re.fullmatch('[A-Z0-9]{8}',str(key)) or not title:raise ValueError('Zotero 父条目信息无效')
        record_doi=doi(payload.get('doi',''))
        with self.papers.lock:
            ref=next((r for r in self.papers.refs.values() if r.get('zotero',{}).get('library_id')==library and r['zotero'].get('item_key')==key),None)
            if ref is None:ref=next((r for r in self.papers.refs.values() if record_doi and doi(r.get('url',''))==record_doi),None)
            if ref is None:
                pid=f'Z{library}_{key}';ref={'id':pid,'topic':0,'title':title,'author':str(payload.get('author',''))[:1000],'year':str(payload.get('year',''))[:40],'venue':str(payload.get('venue',''))[:300],'url':'https://doi.org/'+record_doi if record_doi else str(payload.get('url',''))[:2000],'type':'待核读','relation':'Zotero 文献','innovation':'尚未核读全文。','boundary':'仅保存题录不代表已取得或阅读全文。','access':'题录已保存，全文待获取'};self.papers.refs[pid]=ref
            if not ref.get('zotero',{}).get('path'):ref['zotero']={'library_id':library,'item_key':key,'attachment_key':'','path':''}
            self.papers.atomic(self.papers.root/'catalog.json',json.dumps(list(self.papers.refs.values()),ensure_ascii=False,indent=2))
            return {'id':ref['id'],'title':ref['title'],'attachment_key':ref['zotero'].get('attachment_key',''),'pdf_source':'题录已入库，全文待获取'}

    def valid_pdf(self, path, attachment_key):
        if not re.fullmatch('[A-Z0-9]{8}',str(attachment_key)):
            raise ValueError('无效的 Zotero 附件 key')
        file=Path(path).resolve()
        if not file.is_relative_to(self.storage) or file.parent.name!=attachment_key or file.suffix.lower()!='.pdf':
            raise ValueError('PDF 必须是配置的 Zotero storage 目录中的对应附件')
        if not file.is_file():raise ValueError('Zotero PDF 附件未下载或已移动，请先在 Zotero 中打开附件')
        with file.open('rb') as stream:
            if stream.read(5)!=b'%PDF-':raise ValueError('附件不是有效 PDF')
        return file

    def register(self, payload):
        att=str(payload.get('attachment_key',''))
        file=self.valid_pdf(payload.get('path',''),att)
        library=int(payload.get('library_id',1))
        parent=str(payload.get('item_key',att))
        if library<1 or not re.fullmatch('[A-Z0-9]{8}',parent):raise ValueError('Zotero 条目 key 不合法')
        title=str(payload.get('title') or file.stem).strip()[:1000]
        record_doi=doi(payload.get('doi',''))
        with self.papers.lock:
            matches=[r for r in self.papers.refs.values() if (record_doi and doi(r.get('url',''))==record_doi) or (normalized_title(r['title'])==normalized_title(title) and (not record_doi or not doi(r.get('url','')).startswith('10.') or doi(r.get('url',''))==record_doi))]
            existing=[r for r in self.papers.refs.values() if r.get('zotero',{}).get('library_id')==library and (r['zotero'].get('attachment_key')==att or r['zotero'].get('item_key')==parent)]
            ref=(existing or matches or [None])[0]
            if ref is None:
                pid=f'Z{library}_{att}'
                ref={'id':pid,'topic':0,'title':title,'author':str(payload.get('author','Zotero 文献'))[:1000],'year':str(payload.get('year',''))[:40],'venue':str(payload.get('venue',''))[:300],'url':('https://doi.org/'+record_doi if record_doi else str(payload.get('url',''))[:2000]),'type':'待核读','relation':'Zotero 文献','innovation':'尚未撰写；请依据论文全文记录关键创新。','boundary':'导入附件不代表已完成全文精读。','access':'直接读取 Zotero storage 的本地 PDF'}
                self.papers.refs[pid]=ref
            pid=ref['id']
            ref['zotero']={'library_id':library,'item_key':parent,'attachment_key':att,'path':str(file)}
            self.papers.atomic(self.papers.root/'catalog.json',json.dumps(list(self.papers.refs.values()),ensure_ascii=False,indent=2))
            self.papers.atomic(self.papers.folder(pid)/'zotero.json',json.dumps(ref['zotero'],ensure_ascii=False,indent=2))
            return {'id':pid,'title':ref['title'],'attachment_key':att,'pdf_source':'Zotero storage'}

    def sync_reports(self):
        rows=[]
        for start in range(0,20000,100):
            try:
                with urllib.request.urlopen('http://127.0.0.1:23119/api/users/0/items?limit=100&start='+str(start),timeout=8) as r:batch=json.load(r)
            except (OSError,ValueError):raise ValueError('无法访问 Zotero 本地 API，请确认 Zotero 已打开且允许本机应用访问资料库') from None
            if not isinstance(batch,list):raise ValueError('Zotero 本地 API 返回的数据格式不正确，未把它视为空资料库')
            rows.extend(batch)
            if len(batch)<100:break
        records=[x['data'] for x in rows if not x['data'].get('deleted')]
        parents={r['key']:r for r in records if r.get('itemType')!='attachment'}
        refs=list(self.papers.refs.values())
        matches=[];missing=[]
        for ref in refs:
            if ref.get('zotero'):continue
            rdoi=doi(ref.get('url',''))
            exact=[r for r in parents.values() if rdoi.startswith('10.') and doi(r.get('DOI',''))==rdoi]
            if not exact:exact=[r for r in parents.values() if normalized_title(r.get('title',''))==normalized_title(ref['title'])]
            candidates=[]
            for item in exact:
                attachments=[r for r in records if r.get('parentItem')==item['key'] and r.get('contentType')=='application/pdf']
                attachments.sort(key=lambda a:bool(re.search(r'supplement|supporting|appendix',a.get('title','')+' '+a.get('filename',''),re.I)))
                for att in attachments:
                    try:
                        with urllib.request.urlopen('http://127.0.0.1:23119/api/users/0/items/'+att['key']+'/file/view/url',timeout=5) as r:url=r.read().decode().strip()
                        path=unquote(urlsplit(url).path).lstrip('/')
                        self.valid_pdf(path,att['key']);candidates.append((item,att,path));break
                    except (OSError,ValueError):continue
            if not candidates:missing.append(ref['id']);continue
            item,att,path=candidates[0]
            creators=item.get('creators',[])
            author=', '.join(c.get('lastName') or c.get('name','') for c in creators[:3])
            result=self.register({'item_key':item['key'],'attachment_key':att['key'],'library_id':1,'path':path,'title':item.get('title',''),'doi':item.get('DOI',''),'author':author,'year':item.get('date',''),'venue':item.get('publicationTitle','')})
            matches.append(result)
        return {'linked':matches,'unmatched':missing,'storage':str(self.storage),'items_scanned':len(records)}
