'use strict';
window.ResearchUI = (() => {
  const $ = id => document.getElementById(id);
  async function api(path, payload) {
    let response;
    try{response=await fetch(path, payload === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json','X-Notebook-Request':'1'},body:JSON.stringify(payload)});}
    catch(error){const failure=new Error('暂时无法连接本地科研笔记服务；当前修改请保留在窗口中，连接恢复后再保存');failure.isTransportError=true;throw failure;}
    const body = await response.json();
    if (!response.ok){const error=new Error(body.error||'操作失败');error.status=response.status;throw error;}
    return body;
  }
  function foldReportSections(root) {
    for (const heading of root.querySelectorAll('h3')) {
      if (!heading.textContent.startsWith('展开｜') || heading.closest('details.research-fold')) continue;
      const box=document.createElement('details'),summary=document.createElement('summary'),body=document.createElement('div');
      box.className='research-fold';body.className='research-fold-body';summary.textContent=heading.textContent.slice(3).trim();
      heading.before(box);box.append(summary,body);
      let next=heading.nextElementSibling;
      while(next && !/^H[123]$/.test(next.tagName)) {const following=next.nextElementSibling;body.append(next);next=following;}
      heading.remove();
    }
  }
  function paintMath(root) {
    foldReportSections(root);
    root.querySelectorAll('.math-inline,.math-display').forEach(el => {
      if (el.dataset.rendered) return;
      try {katex.render(el.textContent,el,{displayMode:el.classList.contains('math-display'),throwOnError:false,trust:false,maxExpand:1000});el.dataset.rendered='1';} catch (_) {}
    });
  }
  async function openPaperPDF(pid,page=null,target=null) {
    const id=encodeURIComponent(pid),detail=await api('/api/papers/'+id);
    if(detail.zotero?.attachment_key){
      try{await api('/api/zotero/action',{paper_id:pid,action:'open_pdf',page});target?.close();return true;}
      catch(error){if(!detail.has_pdf)throw error;if(new URLSearchParams(location.search).get('host')==='zotero')throw error;}
    }
    if(!detail.has_pdf){target?.close();return false;}
    const url='/api/papers/'+id+'/pdf'+(page?'#page='+encodeURIComponent(page):'');
    if(target)target.location.href=url;else if(new URLSearchParams(location.search).get('host')==='zotero')window.open(url,'rn-pdf-'+pid,'popup,width=1100,height=850,resizable=yes,scrollbars=yes');else window.location.assign(url);
    return true;
  }
  new MutationObserver(records => {
    const roots=new Set();
    for (const record of records) for (const node of record.addedNodes) if (node.nodeType===1 && !node.closest('.katex')) roots.add(node.parentElement || node);
    for(const root of roots)paintMath(root);
  }).observe(document.body,{childList:true,subtree:true});
  paintMath(document.body);
  document.addEventListener('click',async event => {
    const link=event.target.closest('a[data-paper]');
    if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.button!==0) return;
    const page=Number(link.dataset.page)||null;
    if(new URLSearchParams(location.search).get('host')==='zotero'){
      event.preventDefault();try{if(!await openPaperPDF(link.dataset.paper,page))await api('/api/zotero/open',{paper_id:link.dataset.paper});}catch(error){alert(error.message);}return;
    }
    const popup=window.open('about:blank','paper-'+link.dataset.paper,'popup,width=1100,height=850,resizable=yes,scrollbars=yes');
    if(!popup)return;event.preventDefault();
    try{if(!await openPaperPDF(link.dataset.paper,page,popup))popup.location.href=link.href;}catch(_){popup.location.href=link.href;}
  });
  const ui=document.createElement('div');
  ui.innerHTML=`<dialog id="ds-dialog"><form id="ds-form"><header><h2>DeepSeek 设置</h2><button type="button" class="dialog-close" data-ds-close aria-label="关闭 DeepSeek 设置">×</button></header><p class="muted">用于选中文字翻译和论文辅助精读。选中文字后自动翻译，只发送当前选文；全文精读仍需点击。按 DeepSeek 账户计费。</p><label>API Key<input id="ds-key" type="password" autocomplete="off" placeholder="首次填写；留空保留已有密钥"></label><label>模型<input id="ds-model" value="deepseek-flash" required autocomplete="off"></label><p class="muted">服务地址固定为 api.deepseek.com。密钥使用当前 Windows 用户加密保存在本机，不进入仓库导出。</p><p id="ds-status" role="status"></p><footer><button id="ds-clear" type="button" class="secondary">清除已存密钥</button><button id="ds-test" type="button" class="secondary">保存并测试</button><button class="primary" type="submit">保存设置</button></footer></form></dialog>
  <section id="translation-panel" class="translation-panel compact-translation" hidden aria-label="选文译文"><header><select id="translation-target" aria-label="翻译目标语言"><option value="简体中文">中文</option><option value="English">English</option></select><button id="close-translation" aria-label="关闭译文" title="关闭 · Esc">×</button></header><div id="translation-loading" class="translation-loading" aria-label="正在翻译" hidden><i></i><i></i><i></i></div><p id="translation-status" role="status" hidden></p><textarea id="translation-result" class="translation-text" dir="auto" aria-label="译文，可直接编辑和复制" spellcheck="false"></textarea><footer><button id="translation-settings" title="翻译与摘抄设置" aria-label="翻译与摘抄设置">⚙</button><button id="summary-selection">总结</button><button id="translate-selection">翻译</button><button id="save-translation" title="仅摘录选中文字；请先选择文字。右键设置保存位置" disabled>摘录到笔记</button></footer></section>`;
  document.body.append(ui);
  let current=null,result=null,requestRun=0,selectionTimer,pointerDown=false,lastSelection='',translationSubscription=null,selectionMode='translate',savingSelectionNote=false,translationFocusProtected=true;
  const destinationUI=document.createElement('section');destinationUI.className='selection-note-destination';destinationUI.hidden=true;
  destinationUI.innerHTML='<label>保存到 <select id="selection-note-mode"><option value="auto">默认位置</option><option value="existing">选择已有笔记</option><option value="new">新建笔记（保存后设为默认）</option></select></label><div id="selection-note-picker" hidden><input id="selection-note-search" type="search" placeholder="搜索笔记标题或正文" aria-label="搜索保存目标笔记"><select id="selection-note-choice" aria-label="选择保存目标笔记"></select></div><input id="selection-note-title" hidden aria-label="新笔记标题" placeholder="新笔记标题"><small id="selection-note-hint" role="status"></small>';
  $('translation-panel').querySelector('footer').before(destinationUI);
  const closeDestination=document.createElement('button');closeDestination.type='button';closeDestination.textContent='完成';closeDestination.onclick=()=>{destinationUI.hidden=true;};destinationUI.append(closeDestination);
  const toggleNoteDestination=event=>{event.preventDefault();event.stopPropagation();destinationUI.hidden=!destinationUI.hidden;if(!destinationUI.hidden){updateNoteDestination();if($('selection-note-mode').value==='existing')searchDestinationNotes();placePopup(current?.rect);} };
  $('save-translation').addEventListener('contextmenu',toggleNoteDestination);
  $('save-translation').addEventListener('keydown',event=>{if(event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10'))toggleNoteDestination(event);});
  const noteDefaultsKey='rn-selection-note-default';
  function readNoteDefaults(){try{return JSON.parse(localStorage.getItem(noteDefaultsKey))||{};}catch(_){return {};}}
  function rememberNoteDefaults(value){try{localStorage.setItem(noteDefaultsKey,JSON.stringify({...readNoteDefaults(),...value}));}catch(_){}}
  const storedDefaults=readNoteDefaults();$('selection-note-mode').value=['auto','existing','new'].includes(storedDefaults.mode)?storedDefaults.mode:'auto';
  let destinationSearchRun=0,destinationSearchTimer;const selectionOperations=new Map();
  function selectionPaper(){return result?.selection.paper||current?.paper||document.body.dataset.paper||'';}
  function updateNoteDestination(){
    const mode=$('selection-note-mode').value,pid=selectionPaper(),last=readNoteDefaults();
    $('selection-note-picker').hidden=mode!=='existing';$('selection-note-title').hidden=mode!=='new';
    $('selection-note-hint').textContent=mode==='new'?'新建后会记住这篇笔记，后续可继续追加':mode==='existing'?'搜索并选择一篇已有笔记；报告不会列入保存目标':pid?'默认：本文献阅读笔记 · '+pid:document.body.dataset.note?'默认：当前打开的笔记':last.title?'默认：'+last.title:'默认：“我的摘录”（首次保存时创建）';
  }
  async function searchDestinationNotes(){
    const run=++destinationSearchRun,q=encodeURIComponent($('selection-note-search').value.trim()),last=readNoteDefaults(),selected=$('selection-note-choice').value||last.id;
    try{
      const [data,paperNotes]=await Promise.all([api('/api/notes?q='+q),api('/api/paper-notes?q='+q)]);if(run!==destinationSearchRun)return;
      const choices=$('selection-note-choice');choices.replaceChildren();const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='请选择目标笔记';choices.append(placeholder);
      const rows=[...(paperNotes||[]).map(n=>({id:'paper:'+n.id,title:n.title,folder:'文献阅读笔记'})),...(data.notes||[]).filter(n=>n.folder!=='调研报告'&&!n.trashed)];
      for(const note of rows){const option=document.createElement('option');option.value=note.id;option.textContent=note.title+' · '+note.folder;option.dataset.title=note.title;choices.append(option);}
      if(rows.some(n=>n.id===selected))choices.value=selected;
      if(!rows.length)$('selection-note-hint').textContent='没有匹配的笔记，可以选择“新建笔记”';
    }catch(error){$('selection-note-hint').textContent=error.message;}
  }
  $('selection-note-mode').onchange=()=>{rememberNoteDefaults({mode:$('selection-note-mode').value});updateNoteDestination();updateExcerptButton();$('save-translation').textContent='摘录到笔记';if($('selection-note-mode').value==='existing')searchDestinationNotes();};
  $('selection-note-search').oninput=()=>{clearTimeout(destinationSearchTimer);destinationSearchTimer=setTimeout(searchDestinationNotes,160);};
  $('selection-note-choice').onchange=()=>{const option=$('selection-note-choice').selectedOptions[0];if(option?.value){rememberNoteDefaults({id:option.value,title:option.dataset.title});updateExcerptButton();$('save-translation').textContent='摘录到笔记';}};
  updateNoteDestination();if($('selection-note-mode').value==='existing')searchDestinationNotes();

  async function appendSelectionNote(id,content){
    const operationKey=JSON.stringify([id,content]);if(!selectionOperations.has(operationKey))selectionOperations.set(operationKey,crypto.randomUUID());
    const event={note_id:id,content,operation_id:selectionOperations.get(operationKey),handled:false,promise:null};document.dispatchEvent(new CustomEvent('research-append-selection',{detail:event}));
    if(event.handled)return await event.promise;
    if(id.startsWith('paper:')){
      const pid=id.slice(6),doc=await api('/api/papers/'+pid);await api('/api/papers/'+pid+'/reading',{version:doc.reading.version,content:doc.reading.content.trimEnd()+'\n\n'+content});
      document.dispatchEvent(new CustomEvent('research-chat-saved',{detail:{paper_id:pid}}));return {id,title:'文献阅读笔记 · '+pid};
    }
    const doc=await api('/api/notes/'+id);if(doc.trashed||doc.folder==='调研报告')throw new Error('该目标不是可写入的笔记，请重新选择');
    const saved=await api('/api/notes/'+id,{version:doc.version,title:doc.title,folder:doc.folder,tags:doc.tags,content:doc.content.trimEnd()+'\n\n'+content});return {id:saved.id,title:saved.title};
  }
  async function saveSelectionNote(content,title){
    const mode=$('selection-note-mode').value,pid=selectionPaper();let id;
    if(mode==='new'){
      const note=await api('/api/notes',{title:$('selection-note-title').value.trim()||title,content,folder:'我的笔记',tags:pid?[pid]:[]});
      rememberNoteDefaults({mode:'existing',id:note.id,title:note.title});$('selection-note-mode').value='existing';$('selection-note-search').value='';updateNoteDestination();await searchDestinationNotes();$('selection-note-choice').value=note.id;return note;
    }
    if(mode==='existing'){id=$('selection-note-choice').value;if(!id)throw new Error('请在下拉框选择已有笔记，或改选“新建笔记”');}
    else if(pid)id='paper:'+pid;
    else id=document.body.dataset.note||readNoteDefaults().id;
    if(!id){
      const data=await api('/api/notes?q='+encodeURIComponent('我的摘录')),matches=data.notes.filter(n=>n.title==='我的摘录'&&n.folder==='我的笔记'&&!n.trashed);
      if(matches.length>1)throw new Error('有多篇“我的摘录”，请在已有笔记列表中选择保存目标');
      if(matches.length)id=matches[0].id;
      else{const note=await api('/api/notes',{title:'我的摘录',folder:'我的笔记',tags:[],content});rememberNoteDefaults({id:note.id,title:note.title});updateNoteDestination();return note;}
    }
    const saved=await appendSelectionNote(id,content);if(!pid||mode==='existing')rememberNoteDefaults({id:saved.id,title:saved.title});updateNoteDestination();return saved;
  }
  const translationCache=new Map(),translationJobs=new Map();
  async function openSettings() {
    try {const data=await api('/api/deepseek/settings');$('ds-key').value='';$('ds-model').value=data.model;$('ds-status').textContent=data.configured?'密钥已配置 · '+data.key_source:'尚未配置 API Key';$('ds-dialog').showModal();} catch(error) {alert(error.message);}
  }
  async function saveSettings() {
    const data=await api('/api/deepseek/settings',{api_key:$('ds-key').value,model:$('ds-model').value});
    $('ds-key').value='';$('ds-status').textContent=data.configured?'设置已保存，密钥已加密':'设置已保存，尚未配置密钥';return data;
  }
  document.querySelectorAll('[data-deepseek-settings]').forEach(button=>button.onclick=openSettings);
  $('ds-dialog').querySelector('[data-ds-close]').onclick=()=>{$('ds-key').value='';$('ds-dialog').close();};
  $('ds-dialog').addEventListener('close',()=>$('ds-key').value='');
  $('ds-form').onsubmit=async event=>{event.preventDefault();try{await saveSettings();}catch(error){$('ds-status').textContent=error.message;}};
  $('ds-test').onclick=async()=>{const button=$('ds-test');button.disabled=true;try{await saveSettings();$('ds-status').textContent='正在测试连接…';const data=await api('/api/deepseek/test',{});$('ds-status').textContent='连接成功 · '+data.model;}catch(error){$('ds-status').textContent=error.message;}finally{button.disabled=false;}};
  $('ds-clear').onclick=async()=>{try{const data=await api('/api/deepseek/settings',{clear_key:true,model:$('ds-model').value});$('ds-key').value='';$('ds-status').textContent=data.configured?'本地密钥已清除，仍检测到环境变量密钥':'已清除本地密钥';}catch(error){$('ds-status').textContent=error.message;}};
  function readSelection() {
    let text='',rect=null,source=document.title,paper=document.body.dataset.paper||'';
    const active=document.activeElement;
    if(active?.closest('#translation-panel,#ds-dialog'))return null;
    if(active?.matches('#editor,#reading-editor')&&active.selectionEnd>active.selectionStart){
      text=active.value.slice(active.selectionStart,active.selectionEnd);rect=active.getBoundingClientRect();
    }else{
      const selection=window.getSelection(),element=selection?.anchorNode?.parentElement,focus=selection?.focusNode?.parentElement;
      if(!selection||selection.isCollapsed||!element?.closest('.selectable,.prose,.pdf-page')||!focus?.closest('.selectable,.prose,.pdf-page')||element.closest('#translation-panel,#ds-dialog')||focus.closest('#translation-panel,#ds-dialog'))return null;
      text=selection.toString();const rects=selection.getRangeAt(0).getClientRects();rect=rects.length?rects[rects.length-1]:selection.getRangeAt(0).getBoundingClientRect();
      const page=element.closest('.pdf-page');if(page)source+=' · PDF 第 '+page.dataset.page+' 页';
    }
    text=text.trim();return text&&rect?{text,rect,source,paper}:null;
  }
  function placePopup(rect){
    const length=Math.max(current?.text.length||0,($('translation-result').value.length||0)*1.35),ideal=length<40?330:length<220?480:length<900?650:length<2400?780:900;
    const panel=$('translation-panel'),margin=14,width=Math.min(ideal,innerWidth-28);if(panel.dataset.manualSize)return;panel.style.width=width+'px';panel.style.bottom='auto';
    panel.style.left=Math.max(margin,Math.min(rect.left,innerWidth-width-margin))+'px';panel.style.right='auto';
    const height=Math.min(panel.offsetHeight,innerHeight-28),below=rect.bottom+10;
    panel.style.top=Math.max(margin,Math.min(below+height<=innerHeight-margin?below:rect.top-height-10,innerHeight-height-margin))+'px';
  }
  function dismissTranslation(){clearTimeout(selectionTimer);requestRun++;lastSelection='';translationSubscription?.cancel();$('translation-panel').hidden=true;}
  function translationProtected(){return $('translation-panel').matches(':hover')||translationFocusProtected&&document.activeElement?.closest('#translation-panel,#ds-dialog,#ai-settings');}
  function showError(message){$('translation-status').textContent=message;$('translation-status').hidden=false;}
  function scheduleSelection(){
    clearTimeout(selectionTimer);
    const selectedElement=window.getSelection()?.anchorNode?.parentElement;
    if(selectedElement?.closest('#translation-panel,#ds-dialog'))return;
    const selection=readSelection();
    if(!selection){if(!translationProtected())dismissTranslation();return;}
    const signature=selection.source+'\0'+selection.text;
    if(signature===lastSelection&&!$('translation-panel').hidden)return;
    requestRun++;lastSelection=signature;
    $('translation-panel').hidden=true;
    if(pointerDown)return;
    selectionTimer=setTimeout(()=>{
      const latest=readSelection();if(!latest||latest.source+'\0'+latest.text!==signature)return;
      current=latest;selectionMode='translate';$('translation-panel').hidden=false;placePopup(latest.rect);
      if(latest.text.length>12000){result=null;$('save-translation').disabled=true;$('translation-result').value='';$('translation-loading').hidden=true;showError('选文过长，请分段选择');placePopup(latest.rect);return;}
      translate();
    },0);
  }
  document.addEventListener('mousedown',event=>{if(event.target.closest?.('#translation-panel,#ds-dialog'))return;translationFocusProtected=false;pointerDown=true;});
  document.addEventListener('mouseup',event=>{pointerDown=false;if(!event.target.closest?.('#translation-panel,#ds-dialog'))scheduleSelection();});
  document.addEventListener('selectionchange',()=>{if(pointerDown){clearTimeout(selectionTimer);return;}if(translationProtected()||window.getSelection()?.anchorNode?.parentElement?.closest('#translation-panel'))return;if(!readSelection())dismissTranslation();});
  document.addEventListener('keyup',event=>{if(event.key==='Shift'||event.key.startsWith('Arrow'))scheduleSelection();});
  function subscribeTranslation(text,target,onText,mode='translate'){
    const key=mode+'\0'+target+'\0'+text;let job=translationJobs.get(key);
    if(!job){job={listeners:new Set(),text:'',controller:new AbortController(),done:false};translationJobs.set(key,job);
      job.promise=(async()=>{let buffer='',final=null;try{
        const response=await fetch('/api/selection/stream',{method:'POST',headers:{'Content-Type':'application/json','X-Notebook-Request':'1'},body:JSON.stringify({text,target,mode}),signal:job.controller.signal});
        if(!response.ok){const error=await response.json();throw new Error(error.error||'翻译请求失败');}
        const reader=response.body.getReader(),decoder=new TextDecoder();
        const consume=()=>{const lines=buffer.split('\n');buffer=lines.pop();for(const line of lines){if(!line.trim())continue;const event=JSON.parse(line);if(event.type==='error')throw new Error(event.error);if(event.type==='delta'){job.text+=event.text;for(const listener of job.listeners)listener(job.text);}if(event.type==='done'){final=event;job.text=event.text;for(const listener of job.listeners)listener(job.text);}}};
        while(true){const {value,done}=await reader.read();buffer+=decoder.decode(value||new Uint8Array(),{stream:!done});consume();if(done)break;}
        if(buffer.trim()){buffer+='\n';consume();}if(!final)throw new Error('译文未完整返回，请重试');job.done=true;translationCache.set(key,final);return final;
      }finally{if(translationJobs.get(key)===job)translationJobs.delete(key);}})();
    }
    job.listeners.add(onText);if(job.text)onText(job.text);
    return {promise:job.promise.finally(()=>job.listeners.delete(onText)),cancel(){job.listeners.delete(onText);Promise.resolve().then(()=>{if(!job.done&&!job.listeners.size)job.controller.abort();});}};
  }
  async function translate(){
    if(!current)return;
    const run=++requestRun,target=$('translation-target').value,selection={...current},cacheKey=selectionMode+'\0'+target+'\0'+selection.text;result=null;
    updateNoteDestination();
    $('translation-status').hidden=true;$('translation-result').value='';$('translation-loading').hidden=false;
    $('save-translation').textContent='摘录到笔记';$('save-translation').disabled=true;
    try{
      translationSubscription?.cancel();
      if(!translationCache.has(cacheKey))translationSubscription=subscribeTranslation(selection.text,target,partial=>{if(run!==requestRun)return;$('translation-loading').hidden=true;$('translation-result').value=partial;result={text:partial,selection,target,model:'DeepSeek'};placePopup(selection.rect);},selectionMode);
      const data=translationCache.get(cacheKey)||await translationSubscription.promise;
      if(translationCache.size>=60)translationCache.delete(translationCache.keys().next().value);translationCache.set(cacheKey,data);
      if(run!==requestRun)return;
      if(data.truncated)throw new Error('译文未完整返回，请缩短选文后重试');
      result={...data,selection,target};$('translation-result').value=data.text;
      updateExcerptButton();
    }catch(error){if(run===requestRun)showError(error.message);}
    finally{if(run===requestRun){$('translation-loading').hidden=true;placePopup(selection.rect);}}
  }
  $('translation-target').onchange=()=>{selectionMode='translate';translate();};
  $('summary-selection').onclick=()=>{selectionMode='summary';translate();};$('translate-selection').onclick=()=>{selectionMode='translate';translate();};
  $('close-translation').onclick=dismissTranslation;
  $('translation-settings').onclick=openSettings;
  function selectedTranslationText(){const output=$('translation-result');return output.value.slice(output.selectionStart,output.selectionEnd).trim();}
  function updateExcerptButton(){$('save-translation').disabled=savingSelectionNote||!result||!selectedTranslationText();}
  for(const type of ['select','selectionchange','mouseup','keyup'])$('translation-result').addEventListener(type,updateExcerptButton);
  $('save-translation').onclick=async()=>{
    const selected=selectedTranslationText();if(!result||savingSelectionNote||!selected)return;result.text=$('translation-result').value;const button=$('save-translation');savingSelectionNote=true;button.disabled=true;
    try {
      const excerpt=result.selection.text.slice(0,30).replace(/[\r\n]/g,' ');
      const title=(selectionMode==='summary'?'选文总结 · ':'翻译笔记 · ')+new Date().toLocaleDateString('zh-CN').replaceAll('/','-')+' · '+excerpt;
      const includeSource=await excerptMetadata();
      const quote=selected.trim().split(/\r?\n/).map(line=>'> '+line).join('\n');
      const content=includeSource?'## '+title+'\n\n来源：'+result.selection.source+(result.selection.paper?' · ['+result.selection.paper+'](/paper/'+result.selection.paper+')':'')+'\n\n### 原文\n\n'+result.selection.text+'\n\n### '+(selectionMode==='summary'?'总结':'译文（'+result.target+'）')+'\n\n'+quote+'\n\n> '+(result.model||'AI')+' 辅助处理，请对照原文。\n':quote;
      const saved=await saveSelectionNote(content,title);
      $('selection-note-hint').textContent='已保存到：'+saved.title;$('translation-status').textContent='已摘录到：'+saved.title;$('translation-status').hidden=false;window.dispatchEvent(new Event('research-notes-changed'));
    }catch(error){showError(error.message);}finally{savingSelectionNote=false;button.textContent='摘录到笔记';updateExcerptButton();}
  };
  $('translation-result').addEventListener('beforeinput',()=>{requestRun++;translationSubscription?.cancel();$('translation-loading').hidden=true;});
  $('translation-result').addEventListener('input',()=>{if(!result&&current)result={selection:{...current},target:$('translation-target').value,model:'用户编辑'};if(result)result.text=$('translation-result').value;updateExcerptButton();});
  document.addEventListener('research-ai-changed',()=>{translationCache.clear();dismissTranslation();});
  const panel=$('translation-panel');let drag=null;
  const checkTranslationLeave=()=>{if(!panel.hidden&&!translationProtected()&&!readSelection())dismissTranslation();};
  panel.addEventListener('pointerenter',()=>{translationFocusProtected=true;});
  panel.addEventListener('pointerleave',()=>{translationFocusProtected=false;queueMicrotask(checkTranslationLeave);});
  panel.addEventListener('focusout',()=>queueMicrotask(checkTranslationLeave));
  panel.addEventListener('pointerdown',e=>{const r=panel.getBoundingClientRect();if(e.clientX>r.right-22&&e.clientY>r.bottom-22)panel.dataset.manualSize='1';});
  panel.querySelector('header').addEventListener('pointerdown',e=>{if(e.target.closest('button,select'))return;const r=panel.getBoundingClientRect();drag={x:e.clientX,y:e.clientY,left:r.left,top:r.top};panel.dataset.manualSize='1';e.currentTarget.setPointerCapture(e.pointerId);e.preventDefault();});
  window.addEventListener('pointermove',e=>{if(!drag)return;panel.style.left=Math.max(8,Math.min(innerWidth-panel.offsetWidth-8,drag.left+e.clientX-drag.x))+'px';panel.style.top=Math.max(8,Math.min(innerHeight-panel.offsetHeight-8,drag.top+e.clientY-drag.y))+'px';});
  window.addEventListener('pointerup',()=>{drag=null;if(panel.dataset.manualSize){try{localStorage.setItem('rn-translation-size',JSON.stringify({width:panel.offsetWidth,height:panel.offsetHeight}));}catch(_){}}});
  try{const size=JSON.parse(localStorage.getItem('rn-translation-size'));if(size?.width&&size?.height){panel.style.width=Math.min(size.width,innerWidth-28)+'px';panel.style.height=Math.min(size.height,innerHeight-28)+'px';panel.dataset.manualSize='1';}}catch(_){}
  async function excerptMetadata(){return (await api('/api/notes/settings')).include_source===true;}
  return {api,paintMath,openSettings,openPaperPDF,excerptMetadata,appendSelectionNote};
})();
