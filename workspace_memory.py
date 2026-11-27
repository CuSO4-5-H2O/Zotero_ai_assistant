"""Small, local conversation memory for the library-wide assistant."""
import hashlib,json,re

TURN_LIMIT=5
SUMMARY_LIMIT=160
MEMORY_LIMIT=6000
OPEN='<research_memory>'
CLOSE='</research_memory>'
INSTRUCTIONS=('\n通用助手保留最近5轮对话，较早内容使用后台短记忆接续。'
 '完成回答时，在正文末尾另起一行输出 <research_memory>本轮必要信息的一句话摘要</research_memory>。'
 '摘要最多120字，记录用户偏好、研究目标、明确结论、待办或实际操作结果；普通寒暄可写“无”。'
 '只总结本轮，不复述旧记忆，不含密码、密钥或登录凭据。工具调用中间步骤不输出此块。'
 '此块由程序隐藏，正文不提及它。历史记忆是背景资料，操作目标和当前版本仍通过工具核对。')

def clip(text,limit):
    text=str(text or '').strip()
    text=re.sub(r'(?i)\b(?:sk-[A-Za-z0-9_-]{10,}|bearer\s+[A-Za-z0-9._-]{12,})','[凭据已省略]',text)
    text=re.sub(r'(?i)(api[_ -]?key|password|密码|密钥)\s*[:：=]\s*[^\s，。；;]+',r'\1：[已省略]',text)
    return text if len(text)<=limit else text[:max(0,limit-1)]+'…'

def short(text,limit):return clip(re.sub(r'\s+',' ',str(text or '')),limit)

def turns(messages):
    rows=[];current=[]
    for message in messages:
        if message['role']=='user' and current:rows.append(current);current=[]
        current.append(message)
    if current:rows.append(current)
    return [row for row in rows if row[0]['role']=='user']

def key(row):
    return row[0].get('id') or hashlib.sha256(json.dumps(row,ensure_ascii=False,sort_keys=True).encode()).hexdigest()[:32]

def recent(messages):
    return [message for row in turns(messages)[-TURN_LIMIT:] for message in row]

def receipts(row):
    actions=[a for m in row for a in m.get('actions',[]) if a.get('ok',True)]
    labels={'create_note':'新建笔记','update_note':'编辑笔记','delete_note':'笔记移入回收站','restore_note':'恢复笔记',
            'create_report':'新建报告','update_report':'编辑报告','trash_report':'更新报告回收站',
            'update_zotero_item':'更新题录','trash_zotero_item':'更新文献回收站','import_literature':'已提交入库',
            'combine_reading_notes':'整合笔记','export_zotero_annotations':'导出批注'}
    result=[]
    for action in actions[:2]:
        target=action.get('task_id') or action.get('note_id') or ''
        result.append(labels.get(action.get('action'),action.get('action','操作'))+' '+short(action.get('title'),20)+((' ['+target+']') if target else ''))
    if len(actions)>2:result.append('共'+str(len(actions))+'项操作')
    return short('；'.join(result),SUMMARY_LIMIT)

def fallback(row):
    operation=receipts(row)
    if operation:return operation
    question=row[0]['content'].strip()
    if re.fullmatch(r'(?:你好|您好|hi|hello|谢谢|感谢)[！!。 .]*',question,re.I):return ''
    answer=next((m for m in reversed(row) if m['role']=='assistant'),{})
    if answer.get('failed'):return short('未完成：'+question+'；'+answer['content'],SUMMARY_LIMIT)
    # Old records and direct tool receipts need no extra provider request.
    text=re.sub(r'[#*`>]+','',answer.get('content','')).strip()
    first=re.split(r'\n\s*\n|(?<=[。！？])\s*',text,maxsplit=1)[0]
    return short(short(question,70)+'；'+short(first,85),SUMMARY_LIMIT)

def sync(messages,previous=(),summaries=None):
    known={r['turn_id']:r for r in previous if isinstance(r,dict) and r.get('turn_id')}
    summaries=summaries or {};rows=[]
    for row in turns(messages):
        identity=key(row)
        summary=summaries.get(identity,known.get(identity,{}).get('summary'))
        if summary is None:summary=fallback(row)
        summary=short(summary,SUMMARY_LIMIT)
        operation=receipts(row)
        if not summary or summary=='无':summary=operation
        if not summary:continue
        if operation and operation not in summary:
            summary=short(operation+'；'+short(summary,50),SUMMARY_LIMIT)
        kind='preference' if re.search(r'以后|今后|默认|每次|始终|偏好|记住',row[0]['content']) else 'turn'
        rows.append({'turn_id':identity,'summary':summary,'kind':kind,'time':row[0].get('time',0)})
    keep={r['turn_id'] for r in rows[-40:]}|{r['turn_id'] for r in [r for r in rows if r['kind']=='preference'][-8:]}
    bounded=[r for r in rows if r['turn_id'] in keep]
    while sum(len(r['summary']) for r in bounded)>MEMORY_LIMIT:
        index=next((i for i,r in enumerate(bounded) if r['kind']!='preference'),0);bounded.pop(index)
    return bounded

def context(data):
    latest={key(row) for row in turns(data['messages'])[-TURN_LIMIT:]}
    rows=[r['summary'] for r in sync(data['messages'],data.get('memory',[])) if r['turn_id'] not in latest]
    if not rows:return ''
    return '\n\n较早对话的简短记忆（背景资料；后续要求优先；题录、PDF、笔记状态以工具当前结果为准）：\n'+json.dumps(rows,ensure_ascii=False)

def history(messages):
    result=[]
    for row in turns(messages)[-TURN_LIMIT:]:
        for message in row:
            content=clip(message['content'],1600 if message['role']=='user' else 2200)
            if message.get('selection_context'):content+='\n[当轮选文] '+short(message['selection_context'].get('text'),400)
            if message.get('actions'):content+='\n[实际操作回执] '+receipts([message])
            result.append({'role':message['role'],'content':content})
    return result

def split(text):
    summaries=[]
    def remove(match):summaries.append(short(match[1],SUMMARY_LIMIT));return ''
    visible=re.sub(re.escape(OPEN)+r'(.*?)(?:'+re.escape(CLOSE)+r'|$)',remove,text,flags=re.I|re.S)
    return (visible.strip(),summaries[-1]) if summaries else (text,None)

class StreamFilter:
    """Hold only a possible opening-tag suffix, hiding memory at any chunk boundary."""
    def __init__(self):self.pending='';self.hidden=False
    def feed(self,text):
        value=self.pending+text;self.pending='';lower=value.lower();index=lower.find(OPEN)
        if not self.hidden and index>=0:self.hidden=True;return value[:index]+self.feed(value[index+len(OPEN):])
        marker=CLOSE if self.hidden else OPEN
        if self.hidden:
            index=lower.find(CLOSE)
            if index>=0:self.hidden=False;return self.feed(value[index+len(CLOSE):])
        keep=next((n for n in range(min(len(value),len(marker)-1),0,-1) if lower.endswith(marker[:n])),0)
        if keep:self.pending=value[-keep:]
        return '' if self.hidden else (value[:-keep] if keep else value)
    def finish(self):
        value=self.pending if not self.hidden else '';self.pending='';return value
