'use strict';
const $ = id => document.getElementById(id);
const state = {doc:null, mode:'read', folder:'', trash:false, notes:[], folders:[], sequence:0, dirty:false, saving:null, blocked:false, searchRun:0, previewRun:0};
state.starredOnly=false;
const noteStarFilter=document.createElement('button');noteStarFilter.id='starred-only';noteStarFilter.className='star-filter';noteStarFilter.textContent='☆ 只看星标';noteStarFilter.setAttribute('aria-pressed','false');$('list-count').after(noteStarFilter);
noteStarFilter.onclick=()=>{state.starredOnly=!state.starredOnly;noteStarFilter.textContent=state.starredOnly?'★ 仅星标':'☆ 只看星标';noteStarFilter.setAttribute('aria-pressed',String(state.starredOnly));renderNotes();};
const editorStar=document.createElement('button');editorStar.id='star-note';editorStar.className='tool-button star-toggle';editorStar.disabled=true;$('history').before(editorStar);
function syncEditorStar(){const ready=typeof state.doc?.starred==='boolean';editorStar.textContent=!ready?'☆ 星标待启用':state.doc?.starred?'★ 已置顶':'☆ 星标';editorStar.disabled=!state.doc||state.doc.trashed||!ready;editorStar.setAttribute('aria-pressed',String(!!state.doc?.starred));}
async function setNoteStar(note){let result;try{result=await api('/api/favorites',{kind:'note',id:note.id,starred:!note.starred});}catch(error){if(error.status===404)throw new Error('星标功能需要重启本地科研笔记后台服务后启用；当前正文和草稿不受影响');throw error;}note.starred=result.starred;if(state.doc?.id===note.id){state.doc.starred=result.starred;syncEditorStar();}await refresh();}
editorStar.onclick=async()=>{if(!state.doc)return;editorStar.disabled=true;try{await setNoteStar(state.doc);}catch(error){toast(error.message);}finally{syncEditorStar();}};
syncEditorStar();
let saveTimer, previewTimer, searchTimer, toastTimer;
async function api(path, payload) {
  let response;
  try{response=await fetch(path, payload === undefined ? {} : {method:'POST', headers:{'Content-Type':'application/json','X-Notebook-Request':'1'}, body:JSON.stringify(payload)});}
  catch(_){throw new Error('暂时无法连接本地科研笔记服务；请保留当前窗口和修改，恢复连接后再保存');}
  const body = await response.json();
  if (!response.ok) {const error = new Error(body.error || '操作失败'); error.status = response.status; throw error;}
  return body;
}
function toast(text) {$('toast').textContent=text; $('toast').hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('toast').hidden=true,3500);}
function status(text, kind='') {$('save-status').textContent=text; $('save-status').className=kind;}
function tags(value) {return [...new Set(value.split(/[,，、;；]/).map(s=>s.trim().replace(/^#/, '')).filter(Boolean))];}
function snapshot() {return {title:$('note-title').value,folder:$('note-folder').value,tags:tags($('note-tags').value),content:$('editor').value,version:state.doc.version};}
function rememberDraft() {if(state.doc) localStorage.setItem('draft:'+state.doc.id,JSON.stringify({...snapshot(),sequence:state.sequence}));}
function dateLabel(value) {const d=new Date(value);return d.toLocaleDateString('zh-CN',{month:'2-digit',day:'2-digit'});}
function fillFolders(select, selected) {select.replaceChildren(...state.folders.map(folder=>{const o=document.createElement('option');o.value=o.textContent=folder;return o;}));select.value=selected || state.folders[0];}
function renderFolders(data) {
  const options=[{name:'全部文档',value:'',count:data.total,symbol:'▤'},...data.folders.map(name=>({name,value:name,count:data.counts[name]||0,symbol:'▱'})),{name:'回收站',value:'__trash',count:data.trash,symbol:'↶'}];
  $('folders').replaceChildren(...options.map(item=>{const button=document.createElement('button');button.className='folder'+((state.trash?item.value==='__trash':!item.value||item.value!=='__trash'&&state.folder===item.value)?' selected':'');if(!state.trash&&state.folder&&item.value==='')button.classList.remove('selected');button.dataset.folder=item.value;
    const symbol=document.createElement('span');symbol.className='folder-symbol';symbol.textContent=item.symbol;const name=document.createElement('span');name.textContent=item.name;const count=document.createElement('span');count.className='count';count.textContent=item.count;button.append(symbol,name,count);
    button.onclick=async()=>{if(!await persist())return;state.trash=item.value==='__trash';state.folder=state.trash?'':item.value;await refresh();document.querySelector('.workspace').classList.add('show-list');};return button;}));
}
function renderNotes() {
  const notes=state.notes.filter(n=>!state.starredOnly||n.starred);
  $('list-count').textContent=notes.length+' 篇';
  $('list-title').textContent=state.trash?'回收站':state.folder||'全部文档';
  if(!notes.length){const p=document.createElement('p');p.className='no-results';p.textContent=state.starredOnly?'没有匹配的星标笔记，点击笔记旁的 ☆ 可添加。':$('search').value?'没有找到匹配的笔记。可以换个关键词，或清空搜索。':state.trash?'回收站是空的。':'这个分类还没有笔记，点击“新建笔记”开始。';$('note-list').replaceChildren(p);return;}
  $('note-list').replaceChildren(...notes.map(note=>{const shell=document.createElement('div');shell.className='note-item-shell'+(note.starred?' is-starred':'');shell.dataset.starKey='note:'+note.id;const button=document.createElement('button');button.className='note-item'+(state.doc?.id===note.id?' active':'');button.dataset.noteId=note.id;
    const title=document.createElement('div');title.className='note-title';title.textContent=note.title;
    const excerpt=document.createElement('div');excerpt.className='note-excerpt';excerpt.textContent=note.excerpt;
    const bottom=document.createElement('div');bottom.className='note-bottom';const tag=document.createElement('span');tag.className='tag';tag.textContent=(note.starred?'★ 置顶 · ':'')+note.tags.map(t=>'#'+t).join(' ');const date=document.createElement('span');date.textContent=dateLabel(note.updated);bottom.append(tag,date);button.append(title,excerpt,bottom);button.onclick=()=>openNote(note.id);shell.append(button);if(!state.trash){const star=document.createElement('button');star.className='star-toggle';star.textContent=note.starred?'★':'☆';star.title=note.starred?'取消星标':'添加星标并置顶';star.setAttribute('aria-label',star.title+'：'+note.title);star.setAttribute('aria-pressed',String(!!note.starred));star.onclick=async event=>{event.stopPropagation();star.disabled=true;try{await setNoteStar(note);}catch(error){toast(error.message);}finally{star.disabled=false;}};shell.append(star);}return shell;}));
}
async function refresh() {
  const run=++state.searchRun;
  const params=new URLSearchParams({q:$('search').value.trim(),folder:state.folder,trash:state.trash?'1':'0'});
  const data=await api('/api/notes?'+params);
  if(run!==state.searchRun)return;
  state.notes=data.notes;state.folders=data.folders;renderFolders(data);renderNotes();
}
function updateCount() {$('word-count').textContent=$('editor').value.replace(/\s/g,'').length.toLocaleString()+' 字符';}
function setMode(mode) {
  state.mode=mode;$('panes').className='panes '+mode;
  document.querySelectorAll('[data-mode]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.mode===mode)));
  const editable=mode!=='read'&&!state.doc?.trashed;
  $('note-title').readOnly=!editable;$('note-tags').readOnly=!editable;$('note-folder').disabled=!editable;$('editor').readOnly=!!state.doc?.trashed;
  $('save').hidden=mode==='read'||!!state.doc?.trashed;
}
function populate(doc) {
  state.doc=doc;state.dirty=false;state.blocked=false;state.sequence=0;
  syncEditorStar();
  state.previousTitle=doc.title;
  $('empty-document').hidden=true;$('document-body').hidden=false;
  $('note-title').value=doc.title;$('note-tags').value=doc.tags.join(', ');fillFolders($('note-folder'),doc.folder);$('editor').value=doc.content;
  $('preview').innerHTML=doc.html;$('preview').classList.toggle('has-document-title',$('preview').querySelector('h1')?.textContent===doc.title);$('breadcrumb').textContent=doc.folder+' / '+(doc.source?'调研报告':'笔记');
  $('trash-note').textContent=doc.trashed?'恢复':'回收站';$('trash-note').title=doc.trashed?'恢复笔记':'移入回收站';
  $('history').disabled=false;$('trash-note').disabled=false;setMode(state.mode);updateCount();
  status('已保存 · '+new Date(doc.updated).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}),'saved');
  renderNotes();localStorage.setItem('research-note.active',doc.id);document.title=doc.title+' · 科研笔记仓库';
}
async function openNote(id) {
  if(!await persist())return;
  clearTimeout(saveTimer);clearTimeout(previewTimer);state.previewRun++;
  try {const doc=await api('/api/notes/'+id);populate(doc);document.body.dataset.note=id;$('preview').scrollTop=0;$('editor').scrollTop=0;document.querySelector('.workspace').classList.remove('show-list');
    const cached=localStorage.getItem('draft:'+id);if(cached){const draft=JSON.parse(cached);if(draft.version===doc.version&&draft.content!==doc.content){$('note-title').value=draft.title;$('note-tags').value=draft.tags.join(', ');$('note-folder').value=draft.folder;$('editor').value=draft.content;setMode('edit');changed();toast('已恢复上次未保存的草稿');}}
  } catch(error) {status(error.message,'error');toast(error.message);}
}
function changed() {
  if(!state.doc||state.doc.trashed)return;state.sequence++;state.dirty=true;state.blocked=false;rememberDraft();status('未保存');updateCount();
  clearTimeout(saveTimer);saveTimer=setTimeout(()=>persist(),1400);clearTimeout(previewTimer);previewTimer=setTimeout(preview,350);
}
async function preview() {const run=++state.previewRun;try {const result=await api('/api/preview',{content:$('editor').value});if(run===state.previewRun)$('preview').innerHTML=result.html;}catch(error){status('预览暂不可用；草稿已保留','error');}}
async function persist(force=false) {
  if(state.saving){await state.saving;return state.dirty?persist(force):!state.blocked;}
  if(!state.doc||!state.dirty)return true;
  if(state.blocked&&!force)return false;
  const seq=state.sequence,id=state.doc.id,payload=snapshot();status('正在保存…');
  let success=true;
  state.saving=(async()=>{try {
    const saved=await api('/api/notes/'+id,payload);
    if(state.doc?.id!==id)return;
    state.doc.version=saved.version;state.doc.updated=saved.updated;
    if(state.sequence===seq){state.doc=saved;state.dirty=false;state.blocked=false;localStorage.removeItem('draft:'+id);$('preview').innerHTML=saved.html;$('preview').classList.toggle('has-document-title',$('preview').querySelector('h1')?.textContent===saved.title);status('已保存 · '+new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}),'saved');document.title=saved.title+' · 科研笔记仓库';}
    else {rememberDraft();status('正在等待保存…');}
    await refresh();
  } catch(error){success=false;state.blocked=true;rememberDraft();status(error.message+'（草稿保留在当前窗口）','error');toast(error.message);}
  })();
  await state.saving;state.saving=null;
  if(success&&state.dirty)return persist(force);
  return success;
}
const templates={blank:title=>'# '+title+'\n\n',paper:title=>'# '+title+'\n\n## 文献信息\n\n作者：\n年份：\nDOI / 原文：\n\n## 研究问题\n\n## 关键创新\n\n## 核心方法与证据\n\n## 我的理解\n\n## 可以延伸的问题\n\n',idea:title=>'# '+title+'\n\n## 我想解决的问题\n\n## 已有工作的不足\n\n## 核心想法\n\n## 最小验证方案\n\n## 下一步\n\n- [ ] \n',experiment:title=>'# '+title+'\n\n## 实验目的\n\n## 条件与参数\n\n## 过程记录\n\n## 结果与观察\n\n## 数据位置\n\n## 下一步\n\n'};
async function newDialog(){if(!await persist())return;fillFolders($('new-category'),state.folder&&state.folder!=='调研报告'?state.folder:'我的笔记');$('new-title').value='';$('new-tags').value='';$('new-template').value='blank';$('new-dialog').showModal();$('new-title').focus();}
$('new-note').onclick=newDialog;$('empty-new').onclick=newDialog;
document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>$(button.dataset.close).close());
$('new-form').onsubmit=async event=>{event.preventDefault();const title=$('new-title').value.trim();if(!title)return;try{const doc=await api('/api/notes',{title,folder:$('new-category').value,tags:tags($('new-tags').value),content:templates[$('new-template').value](title)});$('new-dialog').close();state.folder=doc.folder;state.trash=false;$('search').value='';await refresh();populate(doc);setMode('edit');$('editor').focus();toast('笔记已创建');}catch(error){toast(error.message);}};
$('new-template').onchange=()=>{const folder={paper:'文献笔记',idea:'课题想法',experiment:'实验记录'}[$('new-template').value];if(folder)$('new-category').value=folder;};
$('new-folder').onclick=()=>{$('folder-name').value='';$('folder-dialog').showModal();$('folder-name').focus();};
$('folder-form').onsubmit=async event=>{event.preventDefault();try{if(!await persist())return;const result=await api('/api/folders',{name:$('folder-name').value.trim()});$('folder-dialog').close();state.folder=result.name;state.trash=false;await refresh();toast('分类已创建');}catch(error){toast(error.message);}};
document.querySelectorAll('[data-mode]').forEach(button=>button.onclick=async()=>{if(!state.doc)return;if(button.dataset.mode==='read'&&!await persist())return;setMode(button.dataset.mode);if(state.mode!=='read')$('editor').focus();});
$('editor').oninput=changed;$('note-tags').oninput=changed;$('note-folder').onchange=changed;
$('note-title').oninput=()=>{const first=$('editor').value.split('\n')[0];if(first==='# '+state.previousTitle)$('editor').value='# '+$('note-title').value+$('editor').value.slice(first.length);state.previousTitle=$('note-title').value;changed();};
$('save').onclick=async()=>{if(await persist(true))toast('已保存');};
$('search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>refresh().catch(e=>toast(e.message)),180);};
$('preview').onclick=event=>{const link=event.target.closest('[data-open]');if(link){event.preventDefault();if(link.dataset.open.startsWith('report:'))location.href='/dock?pane=reports';else openNote(link.dataset.open);}};
window.addEventListener('research-notes-changed',()=>refresh().catch(e=>toast(e.message)));
const appendedSelections=new Set();
document.addEventListener('research-append-selection',event=>{const detail=event.detail;if(state.doc?.id!==detail.note_id||state.doc.trashed)return;detail.handled=true;detail.promise=(async()=>{if(!appendedSelections.has(detail.operation_id)){$('editor').value=$('editor').value.trimEnd()+'\n\n'+detail.content;appendedSelections.add(detail.operation_id);changed();}clearTimeout(saveTimer);if(!await persist())throw new Error('选文已加入草稿，保存未成功，请处理保存提示后重试');return {id:state.doc.id,title:state.doc.title};})();});
window.addEventListener('focus',()=>refresh().catch(()=>{}));
$('export-vault').onclick=async()=>{if(!await persist())return;const a=document.createElement('a');a.href='/api/export';a.download='科研笔记仓库.zip';a.click();};
$('vault-location').onclick=async()=>{const info=await api('/api/info');$('vault-path').textContent=info.vault;$('info-dialog').showModal();};
$('history').onclick=async()=>{if(!state.doc||!await persist())return;try{const rows=await api('/api/notes/'+state.doc.id+'/history');$('history-list').replaceChildren();if(!rows.length){const p=document.createElement('p');p.className='muted';p.textContent='保存修改后，旧版本会出现在这里。';$('history-list').append(p);}
  for(const row of rows){const div=document.createElement('div');div.className='history-item';const label=document.createElement('span');label.textContent=new Date(row.time).toLocaleString('zh-CN');const small=document.createElement('small');small.textContent=row.characters.toLocaleString()+' 字符';label.append(small);const button=document.createElement('button');button.textContent='恢复这个版本';button.onclick=async()=>{if(!confirm('恢复这个版本？当前版本也会自动留存。'))return;try{const old=await api('/api/notes/'+state.doc.id+'/history/'+row.key);$('note-title').value=old.title;$('note-tags').value=old.tags.join(', ');$('note-folder').value=old.folder;$('editor').value=old.content;changed();if(await persist()){$('history-dialog').close();toast('历史版本已恢复');}}catch(error){toast(error.message);}};div.append(label,button);$('history-list').append(div);}$('history-dialog').showModal();
}catch(error){toast(error.message);}};
$('trash-note').onclick=async()=>{if(!state.doc||!await persist())return;const restore=state.doc.trashed;if(!restore&&!confirm('将这篇笔记移入回收站？之后可以恢复。'))return;try{await api('/api/notes/'+state.doc.id+(restore?'/restore':'/trash'),{});state.doc=null;state.dirty=false;await refresh();if(state.notes.length)await openNote(state.notes[0].id);else{$('document-body').hidden=true;$('empty-document').hidden=false;status('已保存','saved');}$('trash-note').textContent='回收站';toast(restore?'笔记已恢复':'笔记已移入回收站');}catch(error){toast(error.message);}};
window.addEventListener('keydown',event=>{if(event.ctrlKey&&event.key.toLowerCase()==='s'){event.preventDefault();persist(true).then(ok=>ok&&toast('已保存'));}if(event.ctrlKey&&event.key.toLowerCase()==='k'){event.preventDefault();document.querySelector('.workspace').classList.add('show-list');$('search').focus();}if(event.ctrlKey&&event.altKey&&event.key.toLowerCase()==='n'){event.preventDefault();newDialog();}if(event.target===$('editor')&&event.key==='Tab'){event.preventDefault();const el=$('editor');el.setRangeText('  ',el.selectionStart,el.selectionEnd,'end');changed();}});
window.addEventListener('beforeunload',event=>{if(state.dirty){rememberDraft();event.preventDefault();event.returnValue='';}});
async function boot(){try{await refresh();const active=localStorage.getItem('research-note.active');const first=state.notes.find(n=>n.id===active)||state.notes.find(n=>n.tags.includes('总览'))||state.notes[0];if(first)await openNote(first.id);else status('仓库已就绪');setMode('read');}catch(error){status('打开仓库失败：'+error.message,'error');toast(error.message);}}
boot();
