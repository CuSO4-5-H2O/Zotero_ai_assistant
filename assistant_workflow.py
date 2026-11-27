"""Bounded tool runs with duplicate suppression and resumable progress."""
import hashlib,json,re,time
from workspace_memory import short

READS={'search_notes','read_note','search_reports','read_report','search_papers','search_zotero_library','get_zotero_item','list_zotero_collections','web_search','read_web_page','search_literature','get_paper_tags','read_document_sections','read_document_pages','read_zotero_annotations','read_notes_batch','list_project_files','read_project_file','list_zotero_readings','literature_task'}
WRITES={'create_note','update_note','append_note','delete_note','restore_note','create_report','update_report','trash_report','update_zotero_item','trash_zotero_item','add_paper_tags','remove_paper_tags','create_project_file','update_project_file','trash_project_file','restore_project_file','export_zotero_annotations','combine_reading_notes','batch_manage_notes','import_literature','fetch_fulltext'}

def budget(question):
    if re.search(r'入库|下载|获取|批量|整合|汇编|import|download',question,re.I):return 32
    if re.search(r'查找|寻找|检索|搜索|文献|论文|原文|search|paper|literature',question,re.I):return 24
    return 12

class Workflow:
    def __init__(self,question,previous=None):
        self.question=question;self.limit=budget(question);self.cache={};self.completed=dict((previous or {}).get('completed_calls',{}));self.records=[];self.evidence=list((previous or {}).get('evidence',[]))[-12:]
        self.inherited=set(self.completed)
        self.errors=[];self.idle=0;self.fresh=False;self.characters=0;self.reason='';self.started=time.time()
    def begin(self):self.fresh=False
    def invalid(self,name,error):
        self.errors.append(error);self.records.append({'tool':name,'arguments':{},'ok':False,'cached':False,'ms':0,'error':error})
    def finish(self):self.idle=0 if self.fresh else self.idle+1
    def finishing(self,step):
        self.reason='tool_budget' if step>=self.limit or len(self.records)>=64 else 'repeated_calls' if self.idle>=3 else 'context_budget' if self.characters>180000 else ''
        return bool(self.reason)
    def signature(self,name,args,write=False):
        values={k:v for k,v in args.items() if not(write and k=='version')}
        return hashlib.sha256(json.dumps([name,values],ensure_ascii=False,sort_keys=True).encode()).hexdigest()
    def execute(self,kit,name,args):
        key=self.signature(name,args,name in WRITES);start=time.monotonic();cached=False
        if key in self.inherited and name in {'fetch_fulltext','import_literature'}:
            self.inherited.discard(key);record=self.completed[key];service=getattr(kit,'literature',None)
            try:job=service.get(record['task_id']) if service and record.get('task_id') else None
            except (ValueError,OSError):job={'status':'missing','pdf_available':0,'total':1}
            if isinstance(job,dict) and job.get('status') not in {'queued','running','cancelling'} and (job.get('status') in {'failed','cancelled','interrupted','missing'} or job.get('pdf_available',0)<job.get('total',0)):self.completed.pop(key)
        if name in WRITES and key in self.completed:
            result={**self.completed[key],'already_completed':True,'message':'此操作已完成，未重复执行。'};cached=True
        elif name in READS and key in self.cache:
            result={**self.cache[key],'cached':True,'message':'相同工具和参数的结果已在本轮返回；使用已有结果或更换查询，不必重复读取。'};cached=True
        else:
            result=kit.execute(name,args)
            if name in READS:self.cache[key]={'ok':bool(result.get('ok')),**({'error':result['error']} if result.get('error') else {})}
            if result.get('ok'):
                self.fresh=True;self.collect(result)
            if result.get('action') and result.get('ok'):
                self.cache.clear();self.completed[key]={k:v for k,v in result.items() if k in {'ok','action','kind','title','note_id','version','paper_id','id','task_id','recoverable'}}
        encoded=json.dumps(result,ensure_ascii=False);self.characters+=len(encoded)
        if not result.get('ok') and result.get('error') and not cached:self.errors.append(short(result['error'],180))
        safe={k:short(v,220) if isinstance(v,str) else v for k,v in args.items() if k in {'query','url','paper_id','note_id','report_id','item_key','start','count','task_id','operation'} and isinstance(v,(str,int,bool))}
        self.records.append({'tool':name,'arguments':safe,'ok':bool(result.get('ok')),'cached':cached,'ms':round((time.monotonic()-start)*1000),'error':short(result.get('error',''),180)})
        return result,cached
    def collect(self,result):
        values=[]
        for name in ['results','items','papers','reports','notes']:
            rows=result.get(name)
            if isinstance(rows,list):values.extend(r for r in rows[:6] if isinstance(r,dict))
        if result.get('url') or result.get('title'):values.append(result)
        for key in ['report','note']:
            if isinstance(result.get(key),dict):values.append(result[key])
        for row in values:
            m=row.get('metadata') if isinstance(row.get('metadata'),dict) else row
            title=m.get('title') or row.get('title');url=m.get('url') or row.get('url') or ''
            if not title and not url:continue
            entry={'title':short(title or url,140),'url':short(url,400)}
            if row.get('item_key'):entry.update(item_key=row['item_key'],has_local_pdf=bool(row.get('has_local_pdf')))
            if entry not in self.evidence:self.evidence.append(entry)
        self.evidence=self.evidence[-12:]
    def pending(self,actions):
        return {'question':short(self.question,1000),'evidence':self.evidence,'completed_calls':dict(list(self.completed.items())[-40:]),'completed_actions':[{k:r.get(k) for k in ['action','title','note_id','task_id']} for r in actions[-8:]],'last_errors':self.errors[-3:]}
    def fallback(self,actions):
        lines=[]
        if actions:
            lines=['已完成的操作：']+['- '+short(r.get('title') or r.get('action'),160)+(('；任务 '+r['task_id']) if r.get('task_id') else '') for r in actions[-8:]]
        if self.evidence:
            lines+=['','已取得的检索结果：']
            for row in self.evidence[-8:]:
                title=row['title'];url=row.get('url','');lines.append('- '+('['+title.replace('[','').replace(']','')+']('+url+')' if url.startswith(('https://','http://')) else title))
        if not lines:lines=['本轮检索暂未取得可核实的匹配结果。']
        if self.errors:lines+=['','查询反馈：'+'；'.join(dict.fromkeys(self.errors[-3:]))]
        return '\n'.join(lines).strip()+'\n\n进度已保留，发送“继续”可接着处理。'
    def save(self,path,atomic,status='running'):
        atomic(path,json.dumps({'question':short(self.question,1000),'started':self.started,'updated':time.time(),'status':status,'reason':self.reason,'limit':self.limit,'tool_calls':self.records,'evidence':self.evidence},ensure_ascii=False))
