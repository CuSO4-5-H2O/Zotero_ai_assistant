"""Read-only Zotero metadata; PDFs remain in Zotero storage."""
import base64
import json
import hashlib
from pathlib import Path
import re
import unicodedata
import uuid
import urllib.error
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
        storage=file.parent.parent
        data_dir=storage.parent
        codex=(self.storage/'codex').resolve()
        linked_codex=file.parent==codex and (codex.parent.parent/'zotero.sqlite').is_file()
        if not linked_codex and (storage.name.casefold()!='storage' or file.parent.name!=attachment_key
                or file.suffix.lower()!='.pdf' or not (data_dir/'zotero.sqlite').is_file()):
            raise ValueError('PDF 必须是当前 Zotero 数据目录 storage 中对应 key 的托管附件')
        if file.suffix.lower()!='.pdf':raise ValueError('附件必须是 PDF')
        if not file.is_file():raise ValueError('Zotero PDF 附件未下载或已移动，请先在 Zotero 中打开附件')
        with file.open('rb') as stream:
            if stream.read(5)!=b'%PDF-':raise ValueError('附件不是有效 PDF')
        # Zotero's active data directory can be changed by the user. Trust the
        # path returned by Zotero's native attachment API, not an old E: drive
        # default, and use that active storage directory for subsequent checks.
        self.storage=storage
        return file

    def _call_plugin(self, root, message, timeout=90):
        try:bridge=json.loads((Path(root)/'.runtime'/'zotero-bridge.json').read_text(encoding='utf-8'))
        except (OSError,ValueError):raise ValueError('请先在 Zotero 中安装并启用科研笔记仓库插件') from None
        message['bridge_token']=bridge['token']
        request=urllib.request.Request('http://127.0.0.1:23119/research-notebook/action',data=json.dumps(message).encode(),headers={'Content-Type':'application/json'},method='POST')
        try:
            with urllib.request.urlopen(request,timeout=timeout) as response:return json.load(response)
        except urllib.error.HTTPError as error:
            try:detail=json.load(error).get('error','Zotero 操作失败')
            except (ValueError,AttributeError):detail='Zotero 操作失败'
            raise ValueError(detail) from None
        except OSError:raise ValueError('Zotero 插件未就绪，请安装并启用新版插件') from None

    def import_uploaded_pdf(self, pid, payload, root):
        ref=self.papers.item(pid)
        data,pages=self.papers.decode_pdf_upload(payload)
        filename=Path(str(payload.get('filename','论文.pdf')).replace('\\','/')).name[:200] or '论文.pdf'
        if not filename.lower().endswith('.pdf'):filename+='.pdf'
        folder=Path(root)/'.runtime'/'pdf-imports';folder.mkdir(parents=True,exist_ok=True)
        source=folder/(pid+'-'+uuid.uuid4().hex+'.pdf');source.write_bytes(data)
        try:
            linked=ref.get('zotero') or {};library=linked.get('library_id',1)
            metadata={'title':ref.get('title',''),'doi':doi(ref.get('url','')),'url':ref.get('url',''),'author':ref.get('author',''),'year':ref.get('year',''),'venue':ref.get('venue',''),'library_id':library,'item_key':linked.get('item_key','')}
            result=self._call_plugin(root,{'action':'literature_attach_uploaded_pdf','paper_id':pid,'metadata':metadata,'source_path':str(source),'filename':filename})
            attachment=result.get('metadata')
            if not isinstance(attachment,dict):raise ValueError('Zotero 未返回托管 PDF 附件信息')
            registered=self.register(attachment)
            cache=self.papers.root/pid/'pages.json'
            if cache.exists():cache.unlink()
            managed=Path(attachment['path'])
            if managed.is_file():
                for local in (self.papers.root/pid).glob('*.pdf'):
                    try:
                        if local.is_file() and hashlib.sha256(local.read_bytes()).digest()==hashlib.sha256(managed.read_bytes()).digest():local.unlink()
                    except OSError:pass
            return {**registered,'ok':True,'pages':pages,'pdf_status':result.get('pdf_status','imported'),'storage':str(managed)}
        finally:
            try:source.unlink(missing_ok=True)
            except OSError:pass

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

    def sync_supplements(self, root):
        imported=reused=removed=0;left=[]
        for pid,ref in self.papers.refs.items():
            folder=self.papers.root/pid/'SI'
            if not folder.is_dir():continue
            files=[]
            for path in sorted(folder.glob('*.pdf')):
                try:
                    with path.open('rb') as stream:magic=stream.read(5)
                    if path.stat().st_size==0 or magic!=b'%PDF-':
                        left.append({'paper_id':pid,'file':path.name,'reason':'不是有效 PDF，保留原文件'});continue
                except OSError as error:
                    left.append({'paper_id':pid,'file':path.name,'reason':str(error)});continue
                files.append({'source_path':str(path.resolve()),'filename':path.name,'content_type':'application/pdf'})
            if not files:continue
            identifier=doi(ref.get('url',''))
            if not identifier.startswith('10.'):
                left.extend({'paper_id':pid,'file':Path(item['source_path']).name,'reason':'缺少 DOI，无法安全匹配 Zotero 父条目'} for item in files);continue
            try:
                result=self._call_plugin(root,{'action':'literature_attach_supplements','doi':identifier,'report_id':pid,'attachments':files})
                entries=[*result.get('imported',[]),*result.get('skipped',[])]
                by_name={Path(item['source_path']).name:Path(item['source_path']) for item in files}
                for entry in entries:
                    source=by_name.get(entry.get('filename',''));managed=entry.get('path')
                    if not source or not managed:continue
                    try:
                        attachment=self.valid_pdf(managed,entry.get('key',''))
                        same=hashlib.sha256(source.read_bytes()).digest()==hashlib.sha256(attachment.read_bytes()).digest()
                        if not same:
                            left.append({'paper_id':pid,'file':source.name,'reason':'storage 副本校验不一致，保留原文件'});continue
                        source.unlink();removed+=1
                        if entry in result.get('imported',[]):imported+=1
                        else:reused+=1
                    except (OSError,ValueError) as error:left.append({'paper_id':pid,'file':source.name,'reason':str(error)})
            except ValueError as error:
                left.extend({'paper_id':pid,'file':Path(item['source_path']).name,'reason':str(error)} for item in files)
        return {'imported':imported,'reused':reused,'local_copies_removed':removed,'left_in_project':left}

    def cleanup_duplicate_pdfs(self):
        removed=[]
        for path in self.papers.root.rglob('*.pdf'):
            if 'SI' in path.parts:continue
            pid=path.relative_to(self.papers.root).parts[0];ref=self.papers.refs.get(pid,{})
            linked=ref.get('zotero') or {};attachment_key=linked.get('attachment_key','')
            try:
                if not attachment_key:continue
                managed=self.valid_pdf(linked.get('path',''),attachment_key)
                if hashlib.sha256(path.read_bytes()).digest()==hashlib.sha256(managed.read_bytes()).digest():
                    path.unlink();removed.append({'paper_id':pid,'file':str(path)})
            except (OSError,ValueError):continue
        return removed

    def sync_unlinked_local_pdfs(self, root):
        imported=reused=removed=0;left=[]
        for pid,ref in list(self.papers.refs.items()):
            if (ref.get('zotero') or {}).get('attachment_key'):continue
            folder=self.papers.root/pid
            candidates=[]
            for path in sorted(folder.glob('*.pdf')):
                try:
                    with path.open('rb') as stream:magic=stream.read(5)
                    if path.stat().st_size and magic==b'%PDF-':candidates.append(path)
                    else:left.append({'paper_id':pid,'file':path.name,'reason':'不是有效 PDF，保留原文件'})
                except OSError as error:left.append({'paper_id':pid,'file':path.name,'reason':str(error)})
            if not candidates:continue
            unique={hashlib.sha256(path.read_bytes()).hexdigest():path for path in candidates}
            if len(unique)>1:
                left.extend({'paper_id':pid,'file':path.name,'reason':'同一文献存在多个不同 PDF，保留原文件以避免误关联'} for path in unique.values());continue
            source=next(iter(unique.values()))
            try:
                payload={'data':base64.b64encode(source.read_bytes()).decode('ascii'),'filename':source.name}
                result=self.import_uploaded_pdf(pid,payload,root)
                if result.get('pdf_status')=='imported':imported+=1
                else:reused+=1
                if not source.exists():removed+=1
            except (OSError,ValueError) as error:left.append({'paper_id':pid,'file':source.name,'reason':str(error)})
        return {'imported':imported,'reused':reused,'local_copies_removed':removed,'left_in_project':left}

    def sync_reports(self, root=None):
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
        supplements=self.sync_supplements(root) if root else {'imported':0,'reused':0,'local_copies_removed':0,'left_in_project':[]}
        local_pdfs=self.sync_unlinked_local_pdfs(root) if root else {'imported':0,'reused':0,'local_copies_removed':0,'left_in_project':[]}
        duplicate_pdfs=self.cleanup_duplicate_pdfs()
        return {'linked':matches,'unmatched':missing,'storage':str(self.storage),'items_scanned':len(records),'supplements':supplements,'local_pdfs':local_pdfs,'local_duplicate_pdfs_removed':len(duplicate_pdfs)}
