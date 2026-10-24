'use strict';
var ResearchChat=(()=>{
  const $=id=>document.getElementById(id),{api,paintMath}=ResearchUI;
  let paper=null,conversation={version:'0',messages:[]},run=0,controller=null,loading=false;
  const drafts=new Map();
  const base=pid=>pid==='workspace'?'/api/workspace':'/api/papers/'+pid;
  const actionNames={create_note:'已新建',update_note:'已编辑',delete_note:'已移入回收站',restore_note:'已恢复',create_project_file:'已新建文件',update_project_file:'已修改文件',trash_project_file:'已移入可恢复记录',restore_project_file:'已恢复文件',add_paper_tags:'已添加标签',remove_paper_tags:'已移除标签'};
  const status=(text,error=false)=>{$('chat-status').textContent=text;$('chat-status').classList.toggle('chat-error',error);};
  function stop(){run++;controller?.abort();controller=null;loading=false;$('send-chat').disabled=false;$('stop-chat').hidden=true;}
  function button(text,action){const b=document.createElement('button');b.type='button';b.textContent=text;b.onclick=action;return b;}
  function message(role,text,html,metadata){
    const item=document.createElement('section');item.className='chat-message '+role;
    const who=document.createElement('strong');who.textContent=role==='user'?'你':'AI 助手';
    const body=document.createElement('div');body.className=role==='assistant'?'chat-answer prose selectable':'chat-question';
    if(html){body.innerHTML=html;paintMath(body);}else body.textContent=text;
    item.append(who,body);
    if(role==='assistant'&&metadata){
      const tools=document.createElement('div');tools.className='chat-answer-tools';
      tools.append(button('复制回答',async()=>{try{await navigator.clipboard.writeText(text);status('回答已复制');}catch(_){status('请选中回答文字复制',true);}}));
      const pid=paper.id;
      const saveAnswer=button('追加到精读笔记',async()=>{saveAnswer.disabled=true;try{const data=await api('/api/papers/'+pid),reading=data.reading;await api('/api/papers/'+pid+'/reading',{version:reading.version,content:reading.content.trimEnd()+'\n\n## AI 问答\n\n'+(metadata.question?'**问题：** '+metadata.question+'\n\n':'')+text+'\n'});saveAnswer.textContent='已追加';status('已追加到 '+pid+' 精读笔记，旧内容保留在历史版本');document.dispatchEvent(new CustomEvent('research-chat-saved',{detail:{paper_id:pid}}));}catch(e){saveAnswer.disabled=false;status(e.message,true);}});
      if(pid!=='workspace')tools.append(saveAnswer);
      for(const page of metadata.cited_pages||[]){
        tools.append(button('PDF 第 '+page+' 页',async()=>{try{if(paper?.id!==pid)return;if(paper.zotero)await api('/api/zotero/action',{paper_id:pid,action:'open_pdf',page});else window.open('/api/papers/'+pid+'/pdf#page='+page,'_blank','noopener');}catch(e){status(e.message,true);}}));
      }
      item.append(tools);
    }
    $('chat-messages').append(item);return body;
  }
  function render(){
    $('chat-messages').replaceChildren();
    for(const m of conversation.messages)message(m.role,m.content,m.html,m.role==='assistant'?m:null);
    if(!conversation.messages.length){const p=document.createElement('p');p.className='chat-empty';p.textContent='从一个具体问题开始。你也可以点击上方问题，随后继续追问。';$('chat-messages').append(p);}
    renderActions();
  }
  function renderActions(){
    const rows=conversation.recent_actions||[];$('note-actions').hidden=!rows.length;$('note-action-list').replaceChildren();
    for(const row of rows.slice(-15).reverse()){
      const card=document.createElement('div');card.className='note-action-card';
      const label=document.createElement('span');label.textContent=actionNames[row.action]+' · '+row.title;
      card.append(label);if(!row.kind)card.append(button('打开笔记',()=>document.dispatchEvent(new CustomEvent('research-open-note',{detail:{note_id:row.note_id}}))));if(row.kind==='project'&&row.history_id){const b=button('复制恢复编号',()=>navigator.clipboard.writeText(row.history_id));card.append(b);}
      if(['delete_note','trash_project_file'].includes(row.action)&&[...rows].reverse().find(r=>r.note_id===row.note_id)?.id===row.id)card.append(button('恢复',async()=>{try{const data=await api(base(paper.id)+'/note-actions/restore',{action_id:row.id});conversation.recent_actions=data.recent_actions;renderActions();document.dispatchEvent(new CustomEvent('research-note-action',{detail:data}));status('笔记已恢复');}catch(e){status(e.message,true);}}));
      $('note-action-list').append(card);
    }
  }
  async function open(value,force=false){
    if(!value)value={id:'workspace'};$('chat-heading-title').textContent=value.id==='workspace'?'科研工作区助手':'与当前论文对话';for(const [i,b] of [...document.querySelectorAll('[data-question]')].entries()){b.textContent=value.id==='workspace'?b.dataset.workspaceLabel:b.dataset.originalLabel;b.dataset.question=value.id==='workspace'?b.dataset.workspaceQuestion:b.dataset.originalQuestion;}
    $('chat-form').hidden=false;
    if(paper?.id===value.id&&!force)return;
    if(paper)drafts.set(paper.id,$('chat-question').value);
    stop();paper={id:value.id,zotero:value.zotero};const current=run;loading=true;$('send-chat').disabled=true;
    $('chat-question').value=drafts.get(paper.id)||'';$('chat-messages').replaceChildren();status('正在载入这篇论文的对话…');
    try{const data=await api(base(paper.id)+'/chat');if(current!==run)return;conversation=data;render();status('对话已载入 · '+conversation.messages.filter(m=>m.role==='user').length+' 轮');}
    catch(e){if(current===run)status(e.message,true);}
    finally{if(current===run){loading=false;$('send-chat').disabled=false;}}
  }
  async function ask(event){
    event?.preventDefault();if(loading||!paper)return;
    const question=$('chat-question').value.trim();if(!question)return;
    const current=++run,pid=paper.id;controller=new AbortController();loading=true;$('send-chat').disabled=true;$('stop-chat').hidden=false;
    if(!conversation.messages.length)$('chat-messages').replaceChildren();
    message('user',question);const output=message('assistant','正在处理…');let text='',done=false,buffer='';
    status('正在准备所需上下文…');
    try{
      const response=await fetch(base(pid)+'/chat',{method:'POST',headers:{'Content-Type':'application/json','X-Notebook-Request':'1'},body:JSON.stringify({question,version:conversation.version,context_note:document.body.dataset.note||null}),signal:controller.signal});
      if(!response.ok){const error=await response.json();throw new Error(error.error||'请求失败');}
      const reader=response.body.getReader(),decoder=new TextDecoder();
      const consume=line=>{if(!line.trim()||current!==run)return;const event=JSON.parse(line);
        if(event.type==='error')throw new Error(event.error);
        if(event.type==='source'){status(event.notes_only?'正在处理任务…':'已读取 '+event.pages+' 页 PDF 文字层，其中 '+event.readable_pages+' 页有文字'+(event.source_changed?'；附件已更换，本次使用新上下文':'')+' · 正在回答…');if(event.notes_only)output.textContent='正在处理任务…';}
        if(event.type==='delta'){text+=event.text;output.textContent=text;}
        if(event.type==='phase'){text='';output.textContent=event.text;}
        if(event.type==='tool_status')status(({search_notes:'正在查找笔记',read_note:'正在读取笔记',create_note:'正在新建笔记',update_note:'正在编辑笔记',delete_note:'正在移入回收站',restore_note:'正在恢复笔记'}[event.name]||'正在处理任务')+'…');
        if(event.type==='tool_error')status(event.error,true);
        if(event.type==='note_action'){
          conversation.recent_actions=conversation.recent_actions||[];
          if(!conversation.recent_actions.some(r=>r.id===event.id))conversation.recent_actions.push(event);
          renderActions();status(actionNames[event.action]+' · '+event.title);document.dispatchEvent(new CustomEvent('research-note-action',{detail:event}));
        }
        if(event.type==='done'){done=true;conversation.version=event.version;}
      };
      while(true){const part=await reader.read();if(part.done)break;buffer+=decoder.decode(part.value,{stream:true});const lines=buffer.split('\n');buffer=lines.pop();for(const line of lines)consume(line);}
      buffer+=decoder.decode();if(buffer.trim())consume(buffer);
      if(current!==run)return;if(!done)throw new Error('回答连接中断，部分内容未保存');
      if($('chat-question').value.trim()===question){drafts.delete(pid);$('chat-question').value='';}conversation=await api(base(pid)+'/chat');if(current!==run)return;render();status('回答已保存到当前论文，可继续追问或追加到精读笔记');
    }catch(e){if(current===run){status(e.name==='AbortError'?'已停止，部分回答未保存':e.message,true);output.textContent=text||'本次未生成回答。';}}
    finally{if(current===run){controller=null;loading=false;$('send-chat').disabled=false;$('stop-chat').hidden=true;}}
  }
  $('chat-form').onsubmit=ask;
  $('stop-chat').onclick=()=>{stop();status('已停止；完整记录重新载入后可继续查看，部分回答未保存');};
  $('reload-chat').onclick=()=>open(paper,true);
  $('chat-question').oninput=()=>{if(paper)drafts.set(paper.id,$('chat-question').value);};
  $('chat-question').onkeydown=e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();ask();}};
  document.querySelectorAll('[data-question]').forEach((b,i)=>{b.dataset.originalQuestion=b.dataset.question;b.dataset.originalLabel=b.textContent;b.dataset.workspaceQuestion=['列出当前工程文件','整理仓库中最近的笔记','新建一篇“研究计划”笔记，记录当前课题目标、待验证问题和下一步实验。'][i];b.dataset.workspaceLabel=['查看工程文件','整理仓库笔记','新建研究计划'][i];});
  document.querySelectorAll('[data-question]').forEach(b=>b.onclick=()=>{$('chat-question').value=b.dataset.question;ask();});
  document.addEventListener('research-paper-change',e=>{if(paper?.id!==e.detail.id){stop();if(paper)drafts.set(paper.id,$('chat-question').value);paper=null;conversation={version:'0',messages:[]};$('chat-messages').replaceChildren();}});
  window.addEventListener('pagehide',stop);
  return {open};
})();
