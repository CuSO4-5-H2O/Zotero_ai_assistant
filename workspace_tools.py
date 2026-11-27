"""Tools available to the library-wide assistant without an active document."""
import hashlib,json,time,uuid
from note_tools import tool,S

LIB={'library_id':{'type':'integer'},'item_key':S}
STRINGS={'type':'array','items':S}
WORKSPACE_TOOLS=[
 tool('search_zotero_library','检索整个 Zotero 个人资料库（不局限仓库已登记文献）。query 为空列出条目，支持分页和回收站；核实每条 PDF 在本机是否实际存在。',{'query':S,'start':{'type':'integer'},'limit':{'type':'integer'},'library_id':{'type':'integer'},'trash':{'type':'boolean'}},[]),
 tool('get_zotero_item','读取 Zotero 条目的完整题录、作者、标签、分类、附件本机状态和修改版本。返回 paper_id 后可读其原文与笔记。',LIB,['item_key']),
 tool('fetch_fulltext','实际获取原文 PDF 并存入 Zotero storage。适用于“找原文、获取全文、下载PDF、补取原文”；提供已核实 DOI 或 Zotero item_key，已有全文复用。返回后台任务，PDF是否取得用 literature_task 核实，不用网页链接代替下载。',{'dois':STRINGS,'item_keys':STRINGS,'pdf_urls_by_doi':{'type':'object','additionalProperties':STRINGS}},[]),
 tool('update_zotero_item','修改已读取的 Zotero 题录、作者、标签或分类，保留未指定字段。fields 只提供要改的字段；creators 是完整作者列表；用读取时版本。',
      {**LIB,'version':S,'fields':{'type':'object','additionalProperties':{'type':'string'}},'creators':{'type':'array','items':{'type':'object','properties':{'firstName':S,'lastName':S,'creatorType':S,'fieldMode':{'type':'integer'}},'required':['lastName'],'additionalProperties':False}},'add_tags':STRINGS,'remove_tags':STRINGS,'add_to_collections':STRINGS,'remove_from_collections':STRINGS},['item_key','version']),
 tool('trash_zotero_item','按用户明确要求将已读取的 Zotero 文献移入回收站，或 restore=true 恢复。不永久删除条目或PDF。', {**LIB,'version':S,'restore':{'type':'boolean'}},['item_key','version','restore']),
 tool('list_zotero_collections','读取 Zotero 分类名称、编号与父分类，用于按要求整理条目。',{'library_id':{'type':'integer'}},[]),
 tool('create_report','在独立报告区新建报告，笔记与报告保持分区。',{'title':S,'content':S,'folder':S,'tags':STRINGS},['title','content']),
 tool('update_report','修改已读取报告。提供其版本；仅改题名、分类、标签时省略content。替换正文前必须分段读完。',{'report_id':S,'version':S,'title':S,'folder':S,'tags':STRINGS,'content':S},['report_id','version']),
 tool('trash_report','按用户要求将已读取报告移入回收站或恢复，提供当前版本；不永久删除文件。',{'report_id':S,'version':S,'restore':{'type':'boolean'}},['report_id','version','restore'])]

def execute_workspace_tool(self,name,args):
    if name in {'search_zotero_library','get_zotero_item','list_zotero_collections'}:
        action={'search_zotero_library':'library_search','get_zotero_item':'library_get','list_zotero_collections':'library_collections'}[name]
        result=self.native({'action':action,**args})
        if name=='get_zotero_item' and result.get('ok'):
            self.library_reads[(result['library_id'],result['item_key'])]=result
        return result
    normalized={**args}
    if name=='create_report':normalized={**args,'folder':args.get('folder','调研报告'),'tags':args.get('tags',[])}
    signature=json.dumps([name,normalized],ensure_ascii=False,sort_keys=True)
    if signature in self.dedup:return self.dedup[signature]
    execution_key=hashlib.sha256((str(self.request_version)+'\0'+self.question+'\0'+signature).encode()).hexdigest()
    if self.request_version is not None:
        previous=next((r for r in self.logs() if r.get('execution_key')==execution_key),None)
        if previous:
            self.results.append(previous);return previous
    if self.writes>=8:raise ValueError('本轮最多修改8次，请分批处理')
    extra={}
    if name=='fetch_fulltext':
        if not self.literature:raise ValueError('原文获取服务尚未配置')
        result=self.literature.fulltext(args.get('dois'),args.get('item_keys'),args.get('pdf_urls_by_doi'));nid='literature:'+result['id'];title='原文 PDF 获取 · '+str(result['total'])+' 篇';version=result['id'];kind='literature';extra={'task_id':result['id'],'warnings':result.get('warnings',[])}
    elif name in {'update_zotero_item','trash_zotero_item'}:
        candidates=[r for (lib,key),r in self.library_reads.items() if key==args['item_key'] and (args.get('library_id') is None or args['library_id']==lib)]
        if len(candidates)!=1 or candidates[0]['version']!=args['version']:raise ValueError('请先读取唯一的目标 Zotero 条目，再使用其版本修改')
        before=candidates[0];result=self.native({'action':'library_update' if name=='update_zotero_item' else 'library_trash',**args,'library_id':before['library_id']})
        if not result.get('ok'):return result
        self.library_reads[(before['library_id'],before['item_key'])]=result
        title=result['metadata'].get('title','文献');nid='zotero:'+str(result['library_id'])+':'+result['item_key'];version=result['version'];kind='library'
    else:
        if not self.reports:raise ValueError('独立报告区未配置')
        if name=='create_report':result=self.reports.create(args['title'],args.get('folder','调研报告'),args.get('tags',[]),args['content'])
        else:
            rid=args['report_id'];before=self.report_reads.get(rid)
            if not before or before['version']!=args['version']:raise ValueError('请先读取目标报告，再使用该版本修改')
            with self.reports.lock:
                current=self.reports.get(rid)
                if current['version']!=args['version']:raise ValueError('报告已更新，请重新读取')
                if name=='update_report':
                    if 'content' in args and not before['complete']:raise ValueError('请先按 next_start 读完报告，再替换全文')
                    result=self.reports.save(rid,{**current,**{k:v for k,v in args.items() if k in {'title','folder','tags','content','version'}}})
                else:result=self.reports.trash(rid,restore=args['restore'])
            self.report_reads.pop(rid,None)
        title=result['title'];nid=result['id'];version=result['version'];kind='report'
    record={'ok':True,'action':name,'kind':kind,'title':title,'note_id':nid,'version':version,'paper_id':self.pid,'recoverable':name in {'trash_report','trash_zotero_item'},'id':uuid.uuid4().hex,'time':time.time(),'question':self.question,'execution_key':execution_key,**extra}
    self.writes+=1;self.log(record);self.results.append(record)
    response={**record,'result':result};self.dedup[signature]=response
    return response
