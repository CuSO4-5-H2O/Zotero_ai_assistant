"""AI tools for local readings, annotations, long books and note compilations."""
import json,time,uuid
from note_tools import tool,S,NoteTools
from reading_notes import ReadingNotes

IDS={'type':'array','items':S,'minItems':1,'maxItems':40}
VERSIONS={'type':'object','additionalProperties':{'type':'string'}}
READER_TOOLS=[
 tool('get_reader_context','读取 Zotero 当前阅读文献和鼠标选文。保存的划线与批注用 read_zotero_annotations。',{},[]),
 tool('list_zotero_readings','从 Zotero 按题名或作者搜索文献与书籍，或读取用户在 Zotero 选中的多篇文献；将结果关联到科研仓库，返回 paper_id。',{'query':S,'selected':{'type':'boolean'},'start':{'type':'integer'}},[]),
 tool('read_zotero_annotations','读取文献保存的划线、高亮、下划线与批注，含颜色、标签和原文跳转；可分页。',{'paper_id':S,'start':{'type':'integer'},'limit':{'type':'integer','maximum':200}},['paper_id']),
 tool('export_zotero_annotations','按用户要求批量把 Zotero 划线和批注追加到各文献自己的阅读笔记，保留原笔记，重复导出不重复添加。',{'paper_ids':IDS},['paper_ids']),
 tool('read_document_sections','读取 PDF / EPUB 章节目录和位置，不需要完整原文进入模型上下文。',{'paper_id':S},['paper_id']),
 tool('read_document_pages','按页/EPUB节读取原文；长节按 offset 继续，完整返回页码和 next_offset。',{'paper_id':S,'start':{'type':'integer'},'count':{'type':'integer'},'offset':{'type':'integer'}},['paper_id']),
 tool('read_notes_batch','批量读取不同文献/仓库笔记。返回版本、正文片段及 next_start；长笔记按 start 继续读取。',{'note_ids':IDS,'start':{'type':'integer'},'max_chars':{'type':'integer'}},['note_ids']),
 tool('combine_reading_notes','按用户要求将多篇已读取笔记整合成独立汇编，原笔记保留。content 省略时按来源原文汇编；提供时保存AI按主题整合的正文。必须提供每篇来源版本。',{'note_ids':IDS,'versions':VERSIONS,'title':S,'content':S},['note_ids','versions','title'])]
READER_TOOLS.append(tool('batch_manage_notes','按用户明确要求批量追加相同内容、移入回收站或恢复笔记；每篇都要先读取，提供对应版本。删除可恢复。',{'note_ids':IDS,'versions':VERSIONS,'operation':{'type':'string','enum':['append','delete','restore']},'content':S},['note_ids','versions','operation']))

def execute_reader_tool(self,name,args):
    papers=getattr(self.papers,'papers',self.papers)
    def pid(value):
        value=self.pid if value=='current_paper' else value
        papers.item(value);return value
    if name=='get_reader_context':return self.native({'action':'current_reader'})
    if name=='list_zotero_readings':return self.native({'action':'list_readings',**args})
    service=ReadingNotes(papers,self.vault,self.native)
    if name=='read_zotero_annotations':return service.annotations(pid(args['paper_id']),args.get('start',0),args.get('limit',100))
    if name in {'read_document_sections','read_document_pages'}:
        doc=papers.pages(pid(args['paper_id']))
        if name=='read_document_sections':return {'ok':True,'format':doc.get('format'),'chapters':doc.get('chapters',[]),'pages':len(doc['pages'])}
        start=args.get('start',1);count=args.get('count',3);offset=args.get('offset',0)
        if any(type(v)!=int for v in [start,count,offset]) or start<1 or not 1<=count<=10 or offset<0:raise ValueError('原文读取范围无效')
        pages=[p for p in doc['pages'] if start<=p['number']<start+count]
        text='\n\n'.join(f"[{'EPUB 节' if doc.get('format')=='epub' else 'PDF 第'} {p['number']} 页]\n{p['text']}" for p in pages);end=min(len(text),offset+16000)
        return {'ok':True,'format':doc.get('format'),'start':start,'count':len(pages),'total_pages':len(doc['pages']),'text':text[offset:end],'next_offset':end if end<len(text) else None,'next_page':start+len(pages) if start+len(pages)<=len(doc['pages']) else None,'status':doc['status']}
    if name=='read_notes_batch':
        ids=args['note_ids'];start=args.get('start',0);maximum=args.get('max_chars',5000)
        if not isinstance(ids,list) or not 1<=len(ids)<=40 or any(not isinstance(n,str) for n in ids) or type(start)!=int or start<0 or type(maximum)!=int or not 500<=maximum<=16000:raise ValueError('批量笔记读取参数无效')
        if len(ids)*maximum>80000:raise ValueError('每批最多读取8万字符，请减少笔记数或 max_chars')
        rows=[]
        for nid in dict.fromkeys(ids):
            nid=self.canonical(nid)
            if nid.startswith('paper:'):d=papers.reading(nid[6:]);title=papers.item(nid[6:])['title']
            else:
                d=self.vault.get(nid);title=d['title']
                if d.get('trashed'):raise ValueError('来源笔记已在回收站')
            text=d['content'];end=min(len(text),start+maximum)
            rows.append({'note_id':nid,'title':title,'version':d['version'],'content':text[start:end],'total_characters':len(text),'next_start':end if end<len(text) else None})
        return {'ok':True,'notes':rows}
    if self.writes>=8:raise ValueError('本轮写入次数过多，请分批执行')
    if name=='batch_manage_notes':
        ids=args['note_ids'];versions=args['versions'];operation=args['operation']
        if not isinstance(ids,list) or not 1<=len(ids)<=40 or len(set(ids))!=len(ids) or not isinstance(versions,dict) or set(ids)!=set(versions) or operation not in {'append','delete','restore'}:raise ValueError('批量操作参数无效')
        if operation=='append' and (not isinstance(args.get('content'),str) or not args['content'].strip() or len(args['content'])>50000):raise ValueError('追加内容应为 1—5 万字符')
        rows=[]
        for nid in ids:
            kit=NoteTools(self.vault,self.papers,self.pid,self.atomic,self.question,self.request_version)
            try:
                doc=kit.read(nid)
                if doc['version']!=versions[nid]:raise ValueError('笔记版本已变化，请重新读取')
                action={'append':'update_note','delete':'delete_note','restore':'restore_note'}[operation]
                payload={'note_id':nid,'version':doc['version']}
                if operation=='append':payload['content']=doc['content'].rstrip()+'\n\n'+args['content']
                outcome=kit.execute(action,payload);rows.append({'note_id':nid,**outcome})
            except Exception as exc:rows.append({'note_id':nid,'ok':False,'error':str(exc)})
        result={'ok':all(r['ok'] for r in rows),'rows':rows};title='批量管理笔记 · '+str(sum(r['ok'] for r in rows))+'/'+str(len(rows));note_id='batch';version='batch'
    elif name=='export_zotero_annotations':
        result=service.export([pid(p) for p in args['paper_ids']]);title='划线与批注导出 · '+str(result['added'])+' 条';note_id='paper:'+self.pid;version='batch'
    elif name=='combine_reading_notes':
        result=service.combine(args['note_ids'],args['title'],args['versions'],args.get('content'));title=result['title'];note_id=result['id'];version=result['version']
    else:raise ValueError('未知阅读工具')
    record={'ok':result.get('ok',True),'action':name,'kind':'reading','title':title,'note_id':note_id,'version':version,'paper_id':self.pid,'recoverable':False,'id':uuid.uuid4().hex,'time':time.time(),'question':self.question}
    self.writes+=1;self.log(record);self.results.append(record)
    return {**record,'result':result}
