"""Crossref/Elicit candidates and bounded, asynchronous Zotero import jobs."""
import hashlib,html,json,re,threading,time,uuid
from pathlib import Path
from urllib import request,parse,error
from concurrent.futures import ThreadPoolExecutor
from web_tools import public_url

def clean(value,limit=1500):
    return re.sub(r'\s+',' ',html.unescape(re.sub('<[^>]+>',' ',str(value or '')))).strip()[:limit]

def crossref(query,limit=10,from_year=None,until_year=None):
    if not isinstance(query,str) or not 1<=len(query.strip())<=300:raise ValueError('请输入1—300字符的题名、关键词或 DOI')
    if type(limit)!=int or not 1<=limit<=20:raise ValueError('每次检索1—20篇')
    filters=[]
    for value,kind in [(from_year,'from-pub-date'),(until_year,'until-pub-date')]:
        if value is not None:
            if type(value)!=int or not 1500<=value<=2100:raise ValueError('年份范围无效')
            filters.append(kind+':'+str(value)+('-01-01' if kind.startswith('from') else '-12-31'))
    if from_year and until_year and from_year>until_year:raise ValueError('开始年份不能晚于结束年份')
    doi=re.sub(r'^https?://(?:dx\.)?doi.org/','',query.strip(),flags=re.I)
    exact=bool(re.fullmatch(r'10\.\d{4,9}/\S+',doi))
    if not exact:
        filters.extend('type:'+kind for kind in ['journal-article','proceedings-article','posted-content','report','dissertation','book-chapter'])
    params={'query.bibliographic':query.strip(),'rows':limit}
    if filters:params['filter']=','.join(filters)
    url='https://api.crossref.org/works'+('/'+parse.quote(doi,safe='') if exact else '?'+parse.urlencode(params))
    req=request.Request(url,headers={'User-Agent':'ResearchNotebook/1.9 (Zotero literature import)','Accept':'application/json'})
    try:
        with request.urlopen(req,timeout=22) as response:
            raw=response.read(4_000_001)
            if len(raw)>4_000_000:raise ValueError('检索结果过大，请缩小检索范围')
            data=json.loads(raw)['message']
    except error.HTTPError as e:
        raise ValueError('Crossref 未找到该 DOI' if e.code==404 else '文献检索服务暂不可用，请稍后重试') from None
    except (OSError,KeyError,ValueError) as e:
        if isinstance(e,ValueError) and str(e).startswith('检索结果'):raise
        raise ValueError('未取得有效学术检索结果，请检查网络后重试') from None
    items=[data] if exact else data.get('items',[]);rows=[]
    for item in items:
        value=str(item.get('DOI','')).strip().lower();title=clean((item.get('title') or [''])[0],1000)
        if item.get('type') in {'component','dataset','peer-review'} or re.search(r'\.s\d{3,}$',value):
            if exact:raise ValueError('该 DOI 指向补充材料或非论文条目，请提供原论文 DOI')
            continue
        if not title or not re.fullmatch(r'10\.\d{4,9}/[^\s<>]+',value):continue
        date=next((item[k].get('date-parts',[]) for k in ['published','published-print','published-online','issued'] if item.get(k)),[])
        year=str(date[0][0] or '') if date and date[0] else ''
        if year.isdigit() and ((from_year and int(year)<from_year) or (until_year and int(year)>until_year)):continue
        authors=[{'firstName':clean(a.get('given'),100),'lastName':clean(a.get('family') or a.get('name'),160),'creatorType':'author'} for a in item.get('author',[])[:40] if a.get('family') or a.get('name')]
        pdfs=[]
        for link in item.get('link',[]):
            u=link.get('URL','');parts=parse.urlsplit(u)
            if link.get('content-type')=='application/pdf' and parts.scheme=='https' and parts.hostname and not parts.username and not parts.password:pdfs.append(u[:3000])
        rows.append({'candidate_id':hashlib.sha256(value.encode()).hexdigest()[:24],'doi':value,'title':title,'year':year,'venue':clean((item.get('container-title') or [''])[0],300),'authors':authors,'author':', '.join(a['lastName'] for a in authors[:4]),'url':'https://doi.org/'+value,'abstract':clean(item.get('abstract'),1400),'type':item.get('type','journal-article'),'pdf_urls':list(dict.fromkeys(pdfs))[:2],'source':'Crossref','source_url':url,'relevance':'关键词匹配候选，需按用户要求筛选；未读全文'})
    return rows

class LiteratureService:
    def __init__(self,root,atomic,native,register):
        self.root=Path(root);self.atomic=atomic;self.native=native;self.register=register
        self.lock=threading.RLock();self.pool=ThreadPoolExecutor(max_workers=1,thread_name_prefix='literature')
        path=self.root/'candidates.json';self.candidates=json.loads(path.read_text('utf-8')) if path.exists() else {}
        self.jobs={};self.busy=set();self.cache={}
        from literature_providers import SearchSettings
        self.settings=SearchSettings(self.root/'search-settings.json',atomic)
    def search(self,query,limit=10,from_year=None,until_year=None,provider=None):
        if not isinstance(query,str) or not 1<=len(query.strip())<=300:raise ValueError('请输入1—300字符的研究要求或 DOI')
        if type(limit)!=int or not 1<=limit<=20:raise ValueError('每次检索1—20篇')
        if any(v is not None and (type(v)!=int or not 1500<=v<=2100) for v in (from_year,until_year)):raise ValueError('年份范围无效')
        if from_year and until_year and from_year>until_year:raise ValueError('开始年份不能晚于结束年份')
        provider=provider or self.settings.public()['default_provider']
        if provider=='auto':provider='elicit' if self.settings.public()['elicit_configured'] else 'crossref'
        if provider not in {'crossref','elicit','combined'}:raise ValueError('检索来源无效')
        key=json.dumps([query,limit,from_year,until_year,provider],ensure_ascii=False)
        with self.lock:cached=self.cache.get(key)
        if cached and time.time()-cached[0]<300:return cached[1]
        from literature_providers import elicit_search
        warnings=[];rows=[]
        if provider=='combined':
            parts={}
            with ThreadPoolExecutor(max_workers=2) as pool:
                tasks=[('Crossref',pool.submit(crossref,query,limit,from_year,until_year)),('Elicit',pool.submit(elicit_search,query,limit,from_year,until_year,self.settings.key()))]
                for name,future in tasks:
                    try:
                        outcome=future.result()
                        if name=='Elicit':part,notes=outcome;warnings.extend(notes)
                        else:part=outcome
                        parts[name]=part
                    except ValueError as exc:warnings.append(str(exc))
            for index in range(max((len(part) for part in parts.values()),default=0)):
                for name in ('Elicit','Crossref'):
                    if index<len(parts.get(name,[])):rows.append(parts[name][index])
            if not rows:raise ValueError('；'.join(warnings) or '未取得检索结果')
        elif provider=='elicit':rows,warnings=elicit_search(query,limit,from_year,until_year,self.settings.key())
        else:rows=crossref(query,limit,from_year,until_year)
        unique={}
        for row in rows:
            old=unique.get(row['candidate_id'])
            if old:
                old['pdf_urls']=list(dict.fromkeys(old.get('pdf_urls',[])+row.get('pdf_urls',[])))[:6]
                if old['source']!=row['source']:old['source']='Crossref + Elicit'
            else:unique[row['candidate_id']]=row
        rows=list(unique.values())[:limit]
        with self.lock:
            for row in rows:self.candidates[row['candidate_id']]=row
            self.candidates=dict(list(self.candidates.items())[-1000:])
            self.atomic(self.root/'candidates.json',json.dumps(self.candidates,ensure_ascii=False))
            result={'ok':True,'query':query,'results':rows,'source':{'crossref':'Crossref','elicit':'Elicit','combined':'Crossref + Elicit'}[provider],'warnings':warnings,'destination':'storage','scope':'题录/可用摘要；不代表已读全文，PDF 获取结果以入库任务回执为准。'}
            self.cache[key]=(time.time(),result)
            return result
    def search_identifiers(self,text):
        if not isinstance(text,str) or not 1<=len(text)<=100000:raise ValueError('请粘贴含 DOI 的搜索结果，最多10万字符')
        dois=[]
        for value in re.findall(r'10\.\d{4,9}/[^\s<>"\u3000]+',text,re.I):
            value=value.rstrip('.,;').lower()
            while value.endswith(')') and value.count(')')>value.count('('):value=value[:-1]
            if value not in dois:dois.append(value)
        if not 1<=len(dois)<=20:raise ValueError('需要1—20个 DOI；可粘贴 Undermind/Elicit 导出的 DOI 列表或 RIS 文本')
        rows=[];warnings=[]
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures=[(doi,pool.submit(crossref,doi,1)) for doi in dois]
            for doi,future in futures:
                try:rows.extend(future.result())
                except ValueError as exc:warnings.append(doi+'：'+str(exc))
        with self.lock:
            for row in rows:self.candidates[row['candidate_id']]=row
            self.atomic(self.root/'candidates.json',json.dumps(self.candidates,ensure_ascii=False))
        return {'ok':True,'results':rows,'source':'DOI 核验','warnings':warnings,'destination':'storage'}
    def save(self,job):
        self.atomic(self.root/'jobs'/(job['id']+'.json'),json.dumps(job,ensure_ascii=False))
    def get(self,job_id):
        if not isinstance(job_id,str) or not re.fullmatch('[a-f0-9]{32}',job_id):raise ValueError('任务编号无效')
        with self.lock:
            if job_id not in self.jobs:
                path=self.root/'jobs'/(job_id+'.json')
                if not path.exists():raise ValueError('未找到入库任务')
                data=json.loads(path.read_text('utf-8'))
                if data['status'] in {'queued','running','cancelling'}:data['status']='interrupted';data['message']='服务重启导致任务中断；已保存的条目保留，可重新导入去重。'
                self.jobs[job_id]=data
            return json.loads(json.dumps(self.jobs[job_id]))
    def start(self,candidate_ids,fetch_pdf=True,collection_name=None,attachment_mode='default',target_subdir=None):
        if collection_name is not None and (not isinstance(collection_name,str) or not 1<=len(collection_name.strip())<=120 or any(ord(c)<32 for c in collection_name)):raise ValueError('集合名称无效')
        collection_name=collection_name.strip() if collection_name else None
        if not isinstance(attachment_mode,str) or attachment_mode not in {'default','linked_codex'}:raise ValueError('附件模式无效')
        if target_subdir is not None:
            if not isinstance(target_subdir,str) or len(target_subdir)>200:raise ValueError('目标子目录无效')
            target_subdir=target_subdir.replace('\\','/').strip()
            if not target_subdir or any(not part or part in {'.','..'} or part[-1:] in {' ','.'} or re.search(r'[<>:"|?*\x00-\x1f]',part) or re.fullmatch(r'(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?',part) for part in target_subdir.split('/')):raise ValueError('目标子目录必须是 storage/codex 内的相对路径')
            if attachment_mode!='linked_codex':raise ValueError('目标子目录仅用于 linked_codex 附件模式')
        if not isinstance(candidate_ids,list) or not 1<=len(candidate_ids)<=20 or any(not isinstance(i,str) for i in candidate_ids) or type(fetch_pdf)!=bool:raise ValueError('请选择1—20篇检索结果')
        ids=list(dict.fromkeys(candidate_ids))
        with self.lock:
            if any(i not in self.candidates for i in ids):raise ValueError('候选已过期或未经检索核验，请重新搜索；禁止凭空生成 DOI 入库')
            for job in self.jobs.values():
                if job['status'] in {'queued','running','cancelling'} and job['candidate_ids']==ids and job['fetch_pdf']==fetch_pdf and job.get('collection_name')==collection_name and job.get('attachment_mode','default')==attachment_mode and job.get('target_subdir')==target_subdir:return self.get(job['id'])
            if len(self.busy)>=3:raise ValueError('已有3个入库任务，请等待或停止后续导入')
            job={'id':uuid.uuid4().hex,'candidate_ids':ids,'fetch_pdf':fetch_pdf,'status':'queued','created':time.time(),'total':len(ids),'processed':0,'rows':[],'cancel_requested':False,'metadata_saved':0,'pdf_available':0,'pdf_downloaded':0,'message':'等待导入；PDF 将由 Zotero 写入 storage'}
            job.update(collection_name=collection_name,attachment_mode=attachment_mode,target_subdir=target_subdir)
            self.jobs[job['id']]=job;self.busy.add(job['id']);self.save(job)
            self.pool.submit(self.run,job['id'],[dict(self.candidates[i]) for i in ids]);return self.get(job['id'])
    def cancel(self,job_id):
        with self.lock:
            job=self.get(job_id)
            if job['status'] not in {'queued','running','cancelling'}:return job
            job=self.jobs[job_id];job['cancel_requested']=True;job['status']='cancelling';job['message']='不再导入后续文献；正在完成当前文献的请求。';self.save(job);return self.get(job_id)
    def recent(self):
        paths=sorted((self.root/'jobs').glob('*.json'),key=lambda p:p.stat().st_mtime,reverse=True)[:10]
        return [self.get(p.stem) for p in paths]
    def run(self,job_id,candidates):
        job=self.jobs[job_id]
        try:
            for candidate in candidates:
                with self.lock:
                    if job['cancel_requested']:break
                    job['status']='running';job['current_title']=candidate['title'];self.save(job)
                row={'candidate_id':candidate['candidate_id'],'title':candidate['title'],'doi':candidate['doi']}
                try:
                    metadata={**candidate,'pdf_urls':[]}
                    for url in candidate.get('pdf_urls',[]):
                        try:metadata['pdf_urls'].append(public_url(url))
                        except ValueError:pass
                    outcome=self.native({'action':'literature_import','metadata':metadata,'fetch_pdf':job['fetch_pdf'],'collection_name':job.get('collection_name'),'attachment_mode':job.get('attachment_mode','default'),'target_subdir':job.get('target_subdir')})
                    if not outcome.get('ok'):raise ValueError(outcome.get('error','Zotero 导入失败'))
                    record=self.register(outcome['metadata'])
                    row.update(ok=True,paper_id=record['id'],item_key=outcome['metadata']['item_key'],created=outcome['created'],pdf_status=outcome['pdf_status'],message=outcome.get('message',''),path=outcome['metadata'].get('path',''),location_exception=outcome.get('location_exception',False),sha256=outcome.get('sha256',''))
                except Exception as e:row.update(ok=False,error=str(e)[:350])
                with self.lock:
                    job['rows'].append(row);job['processed']=len(job['rows']);job['metadata_saved']=sum(bool(r.get('ok')) for r in job['rows']);job['pdf_available']=sum(r.get('pdf_status') in {'existing','downloaded','copied','linked'} for r in job['rows']);job['pdf_downloaded']=sum(r.get('pdf_status') in {'downloaded','copied','linked'} for r in job['rows']);self.save(job)
            with self.lock:
                job['status']='cancelled' if job['cancel_requested'] else 'completed';job.pop('current_title',None);job['message']='已处理 '+str(job['processed'])+' 篇；题录入库 '+str(job['metadata_saved'])+' 篇，PDF 可用 '+str(job['pdf_available'])+' 篇，本次获取 '+str(job['pdf_downloaded'])+' 篇。';self.save(job)
        except Exception:
            with self.lock:job['status']='failed';job['message']='任务中断，已保存的 Zotero 条目保留；可重新导入去重。';self.save(job)
        finally:
            with self.lock:self.busy.discard(job_id)
