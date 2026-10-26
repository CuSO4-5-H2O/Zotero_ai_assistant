"""Documented Elicit v2 search adapter; secrets stay on the local server."""
import base64
import hashlib
import json
import os
import re
from pathlib import Path
from urllib import request, error, parse
from deepseek_client import protect

ELICIT_ENDPOINT='https://elicit.com/api/v2/search/papers'

class SearchSettings:
    def __init__(self,path,atomic):self.path=Path(path);self.atomic=atomic
    def read(self):return json.loads(self.path.read_text('utf-8')) if self.path.exists() else {}
    def key(self):
        encrypted=self.read().get('elicit_key_encrypted')
        return protect(base64.b64decode(encrypted),True).decode() if encrypted else os.environ.get('ELICIT_API_KEY','')
    def public(self):
        data=self.read()
        return {'elicit_configured':bool(data.get('elicit_key_encrypted') or os.environ.get('ELICIT_API_KEY')),'default_provider':data.get('default_provider','auto'),'elicit_endpoint':ELICIT_ENDPOINT,'undermind_url':'https://www.undermind.ai/','destination':'storage'}
    def save(self,payload):
        if not isinstance(payload,dict) or set(payload)-{'elicit_key','clear_elicit_key','default_provider'}:raise ValueError('检索设置参数无效')
        data=self.read();key=payload.get('elicit_key','')
        if not isinstance(key,str) or len(key)>4000:raise ValueError('Elicit API Key 格式无效')
        if payload.get('clear_elicit_key'):data.pop('elicit_key_encrypted',None)
        elif key.strip():data['elicit_key_encrypted']=base64.b64encode(protect(key.strip().encode())).decode()
        if 'default_provider' in payload:
            if payload['default_provider'] not in {'auto','crossref','elicit','combined'}:raise ValueError('检索来源无效')
            data['default_provider']=payload['default_provider']
        self.atomic(self.path,json.dumps(data,ensure_ascii=False))
        return self.public()

def elicit_search(query,limit,from_year,until_year,key):
    if not key:raise ValueError('请在文献搜索的“检索服务设置”填写 Elicit API Key；Codex 连接账号不能自动用于本插件')
    body={'query':query,'maxResults':limit,'searchMode':'semantic','corpus':'elicit'}
    filters={k:v for k,v in [('minYear',from_year),('maxYear',until_year)] if v is not None}
    if filters:body['filters']=filters
    req=request.Request(ELICIT_ENDPOINT,data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+key,'Content-Type':'application/json','Accept':'application/json'},method='POST')
    try:
        with request.urlopen(req,timeout=65) as response:
            raw=response.read(8_000_001)
            if len(raw)>8_000_000:raise ValueError('Elicit 结果过大，请减少候选数')
            data=json.loads(raw)
    except error.HTTPError as exc:
        messages={401:'Elicit API Key 无效或已过期',402:'Elicit 额度不足',403:'Elicit API 权限不足，请确认账号套餐支持 API',429:'Elicit 请求限流，请稍后重试'}
        raise ValueError(messages.get(exc.code,'Elicit 请求失败（HTTP '+str(exc.code)+'）')) from None
    except (OSError,ValueError) as exc:
        if isinstance(exc,ValueError) and str(exc).startswith('Elicit 结果'):raise
        raise ValueError('Elicit 网络请求或响应格式异常，请稍后重试') from None
    return normalize_elicit(data,from_year,until_year)

def normalize_elicit(data,from_year=None,until_year=None):
    if not isinstance(data,dict) or not isinstance(data.get('papers'),list):raise ValueError('Elicit 未返回有效的 papers 列表')
    from literature import clean
    rows=[];skipped=0
    for paper in data['papers']:
        if not isinstance(paper,dict):skipped+=1;continue
        title=clean(paper.get('title'),1000);doi=re.sub(r'^https?://(?:dx\.)?doi.org/','',str(paper.get('doi') or ''),flags=re.I).strip().lower()
        if not re.fullmatch(r'10\.\d{4,9}/[^\s<>]+',doi):doi=''
        urls=paper.get('urls') if isinstance(paper.get('urls'),list) else []
        arxiv=next((u for u in urls if isinstance(u,str) and re.fullmatch(r'https://arxiv\.org/abs/\d{4}\.\d{4,5}(?:v\d+)?',u)),None)
        if not title or not (doi or arxiv):skipped+=1;continue
        year=str(paper.get('year') or '')
        if year.isdigit() and ((from_year and int(year)<from_year) or (until_year and int(year)>until_year)):continue
        authors=[{'firstName':'','lastName':clean(a,160),'creatorType':'author'} for a in (paper.get('authors') or [])[:40] if isinstance(a,str) and a.strip()]
        pdfs=[]
        for u in [paper.get('fullTextUrl'),*urls]:
            if not isinstance(u,str):continue
            p=parse.urlsplit(u)
            if p.scheme=='https' and p.hostname and not p.username and not p.password and (u==paper.get('fullTextUrl') or '.pdf' in p.path.lower()):pdfs.append(u[:3000])
        url='https://doi.org/'+doi if doi else arxiv
        rows.append({'candidate_id':hashlib.sha256((doi or url).encode()).hexdigest()[:24],'doi':doi,'title':title,'year':year,'venue':clean(paper.get('venue'),300),'authors':authors,'author':', '.join(a['lastName'] for a in authors[:4]),'url':url,'abstract':clean(paper.get('abstract'),1400),'type':'journal-article','pdf_urls':list(dict.fromkeys(pdfs))[:6],'source':'Elicit','source_url':ELICIT_ENDPOINT,'relevance':'Elicit 语义检索候选，未读全文'})
    warnings=[clean(w.get('message'),400) for w in data.get('warnings',[]) if isinstance(w,dict) and w.get('message')]
    if skipped:warnings.append(str(skipped)+' 条结果缺少可入库的 DOI/arXiv 编号或题名，未自动加入候选')
    return rows,warnings
