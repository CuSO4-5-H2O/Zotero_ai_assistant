"""Version-aware annotation export and cross-document reading-note collections."""
import hashlib,json,re,threading
from urllib.parse import quote

def annotation_markdown(row):
    identity='/'.join(str(row.get(k,'')) for k in ['attachment_key','key'])
    digest=hashlib.sha256(json.dumps([row.get('text',''),row.get('comment','')],ensure_ascii=False).encode()).hexdigest()[:12]
    marker='<!-- rn-annotation:'+identity+':'+digest+' -->'
    label='第 '+str(row['page'])+' 页' if row.get('page') else row.get('page_label') or '原文位置'
    text='\n'.join('> '+line for line in row.get('text','').splitlines())
    comment='\n\n批注：'+row['comment'] if row.get('comment') else ''
    tags=' · '.join(row.get('tags',[]))
    return marker+'\n'+text+comment+'\n\n['+label+']('+row['uri']+')'+(' · '+tags if tags else '')+'\n'

class ReadingNotes:
    def __init__(self,papers,vault,native):self.papers=papers;self.vault=vault;self.native=native;self.lock=threading.RLock()
    def ids(self,ids):
        if not isinstance(ids,list) or not 1<=len(ids)<=40 or any(not isinstance(pid,str) or pid not in self.papers.refs for pid in ids):raise ValueError('请选择 1—40 篇已关联的文献')
        return list(dict.fromkeys(ids))
    def annotations(self,pid,start=0,limit=200):
        if pid not in self.papers.refs:raise ValueError('请先搜索并选择文献')
        return self.native({'action':'get_annotations','paper_id':pid,'start':start,'limit':limit,'all_attachments':True})
    def export(self,ids,expected=None):
        ids=self.ids(ids);rows=[]
        for pid in ids:
            try:
                annotations=[];start=0
                while True:
                    response=self.annotations(pid,start)
                    if not response.get('ok',True):raise ValueError(response.get('error','读取批注失败'))
                    annotations.extend(response.get('annotations',[]));next_start=response.get('next_start')
                    if next_start is None:break
                    if next_start<=start or len(annotations)>10000:raise ValueError('批注数量过多，请分批导出')
                    start=next_start
                with self.papers.lock:
                    doc=self.papers.reading(pid)
                    if expected and pid in expected and expected[pid]!=doc['version']:raise ValueError('文献笔记已被编辑，请刷新后重试')
                    additions=[]
                    for a in annotations:
                        if not (a.get('text','').strip() or a.get('comment','').strip()):continue
                        entry=annotation_markdown(a)
                        if entry.split('\n',1)[0] not in doc['content']:additions.append(entry)
                    content=doc['content'].rstrip()
                    if additions:
                        content+='\n\n## Zotero 划线与批注\n\n'+'\n'.join(additions)
                        saved=self.papers.save_reading(pid,{'version':doc['version'],'content':content.lstrip()})
                    else:saved=doc
                rows.append({'paper_id':pid,'ok':True,'added':len(additions),'total':len(annotations),'version':saved['version']})
            except Exception as exc:rows.append({'paper_id':pid,'ok':False,'error':str(exc)})
        return {'ok':all(r['ok'] for r in rows),'rows':rows,'added':sum(r.get('added',0) for r in rows)}
    def combine(self,note_ids,title,expected,content=None):
        if not isinstance(note_ids,list) or not 1<=len(note_ids)<=40 or any(not isinstance(n,str) for n in note_ids):raise ValueError('请选择 1—40 篇笔记')
        if not isinstance(title,str) or not title.strip() or len(title)>160:raise ValueError('汇编标题无效')
        if not isinstance(expected,dict) or set(expected)!=set(note_ids):raise ValueError('请先读取每篇来源笔记，并提供全部版本')
        with self.papers.lock,self.vault.lock:
            docs=[]
            for nid in dict.fromkeys(note_ids):
                if nid.startswith('paper:'):
                    pid=nid[6:];ref=self.papers.item(pid);d=self.papers.reading(pid);name=ref['title'];url='/paper/'+quote(pid)
                elif re.fullmatch('[a-f0-9]{32}',nid):
                    d=self.vault.get(nid)
                    if d.get('trashed'):raise ValueError('来源笔记已在回收站')
                    name=d['title'];url='/?note='+nid
                else:raise ValueError('来源笔记编号无效')
                if d['version']!=expected[nid]:raise ValueError('来源笔记已变化：'+name+'，请重新读取')
                docs.append((nid,name,url,d))
            if content is not None and (not isinstance(content,str) or len(content)>300000):raise ValueError('整合内容应为 30 万字符以内的文字')
            body='# '+title+'\n\n'
            if content is not None:body+=content+'\n\n## 来源笔记\n\n'
            for nid,name,url,d in docs:
                body+=('### ' if content is None else '- ')+'['+name.replace('[','').replace(']','')+']('+url+')\n'
                if content is None:body+='\n'+d['content']+'\n\n'
            if len(body)>1_500_000:raise ValueError('笔记汇编超过 150 万字符，请分卷整合')
            # Stable source/version/content identity avoids duplicates on retry.
            signature=hashlib.sha256(json.dumps([title,expected,content],ensure_ascii=False,sort_keys=True).encode()).hexdigest()[:24]
            marker='<!-- rn-compilation:'+signature+' -->'
            for row in self.vault.list(title)['notes']:
                if marker in self.vault.get(row['id'])['content']:return {**self.vault.get(row['id']),'reused':True}
            return self.vault.create(title,'阅读汇编',['文献整合'],body+'\n'+marker)
