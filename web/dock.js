'use strict';
(() => {
  const $=id=>document.getElementById(id),{api,paintMath}=ResearchUI;
  const query=new URLSearchParams(location.search),channel=query.get('channel');
  let paper=null,documentNote=null,mode='edit',pane='current',catalog=[],folders=[],navRun=0,previewRun=0,noteSearchRun=0,pendingClip=null,sequence=Number(sessionStorage.getItem('rn-dock-sequence:'+channel))||0,alive=true,generating=false,nativeExport=null,conflictState=null,newNoteContent='',reportSearchRun=0;
  const inserted=new Set();let trashView=false;
  let starredNotesOnly=false,starredReportsOnly=false,userNavigated=false,saveInFlight=null,autoSaveTimer=null;
  function starFilter(id,parent,action){const button=document.createElement('button');button.id=id;button.className='quiet star-filter';button.textContent='☆ 只看星标';button.setAttribute('aria-pressed','false');button.onclick=action;parent.append(button);return button;}
  function updateFilter(button,value){button.textContent=value?'★ 仅星标':'☆ 只看星标';button.setAttribute('aria-pressed',String(value));}
  const noteStarFilter=starFilter('notes-starred-only',$('notes-search').querySelector('.search-row'),()=>{starredNotesOnly=!starredNotesOnly;updateFilter(noteStarFilter,starredNotesOnly);searchNotes();});
  const reportStarFilter=starFilter('reports-starred-only',$('reports-search').querySelector('.search-row'),()=>{starredReportsOnly=!starredReportsOnly;updateFilter(reportStarFilter,starredReportsOnly);searchReports();});
  const currentStar=document.createElement('button');currentStar.id='document-star';currentStar.className='quiet star-toggle';currentStar.hidden=true;$('new-note-inline').before(currentStar);
  function documentKind(){return documentNote?.kind==='paper'?'paper':documentNote?.kind==='report'?'report':'note';}
  function syncCurrentStar(){currentStar.hidden=!documentNote;const ready=typeof documentNote?.starred==='boolean';currentStar.disabled=!ready;currentStar.textContent=!ready?'☆ 星标待启用':documentNote?.starred?'★ 已置顶':'☆ 星标置顶';currentStar.setAttribute('aria-pressed',String(!!documentNote?.starred));currentStar.title=!ready?'重启本地科研笔记后台服务后启用':documentNote?.starred?'取消星标置顶':'添加星标，置顶显示';}
  async function changeStar(note,kind){let saved;try{saved=await api('/api/favorites',{kind,id:note.id,starred:!note.starred});}catch(error){if(error.status===404)throw new Error('星标功能需要重启本地科研笔记后台服务后启用；当前正文和草稿不受影响');throw error;}note.starred=saved.starred;if(documentNote?.id===note.id&&documentKind()===kind){documentNote.starred=saved.starred;syncCurrentStar();}if(kind==='report')searchReports();else searchNotes();return saved;}
  currentStar.onclick=async()=>{if(!documentNote)return;currentStar.disabled=true;try{await changeStar(documentNote,documentKind());}catch(error){fail(error);}finally{currentStar.disabled=false;}};
  function starredCard(note,kind,subtitle,open){
    const shell=document.createElement('div');shell.className='starred-result'+(note.starred?' is-starred':'');shell.dataset.starKey=kind+':'+note.id;
    const main=card(note.title,(note.starred?'★ 置顶 · ':'')+subtitle);main.onclick=open;
    const star=document.createElement('button');star.className='star-toggle';star.textContent=note.starred?'★':'☆';star.disabled=typeof note.starred!=='boolean';star.title=star.disabled?'重启本地科研笔记后台服务后启用':note.starred?'取消星标':'添加星标并置顶';star.setAttribute('aria-label',star.title+'：'+note.title);star.setAttribute('aria-pressed',String(!!note.starred));
    star.onclick=async event=>{event.stopPropagation();star.disabled=true;try{await changeStar(note,kind);}catch(error){fail(error);}finally{star.disabled=false;}};
    shell.append(main,star);return shell;
  }
  function status(message,error=false){$('dock-status').textContent=message;document.querySelector('.dock-status').classList.toggle('error',error);}
  function fail(error){status(error.message||String(error),true);}
  function draftKey(key){return 'rn-dock-draft:'+key;}
  function recordDraft(){
    if(!documentNote)return;
    if(!dirty()){try{localStorage.removeItem(draftKey(documentNote.key));}catch(_){}return;}
    documentNote.content=$('reading-editor').value;
    if(documentNote.kind==='vault'){documentNote.title=$('document-title').value;documentNote.folder=$('document-folder').value;documentNote.tags=$('document-tags').value.split(/[,，]/).map(t=>t.trim()).filter(Boolean);}
    try{localStorage.setItem(draftKey(documentNote.key),JSON.stringify({content:documentNote.content,title:documentNote.title,folder:documentNote.folder,tags:documentNote.tags,baseVersion:documentNote.version}));}catch(_){status('草稿缓存空间不足，请及时保存',true);}
  }
  function dirty(){return documentNote&&($('reading-editor').value!==documentNote.savedContent||(documentNote.kind==='vault'&&($('document-title').value!==documentNote.savedTitle||$('document-folder').value!==documentNote.savedFolder||$('document-tags').value!==documentNote.savedTags)));}
  function schedulePaperSave(){clearTimeout(autoSaveTimer);if(documentNote?.kind==='paper')autoSaveTimer=setTimeout(()=>save(),800);}
  function changed(){recordDraft();nativeExport=null;$('export-zotero').disabled=!paper?.zotero;$('character-count').textContent=$('reading-editor').value.length+' 字';status(documentNote?.kind==='paper'?'正在等待自动保存 · 草稿已在本机保留':'未保存 · 草稿已在本机保留');schedulePaperSave();}
  function showPane(name){pane=name;document.body.dataset.paper=paper&&['current','guide','assistant'].includes(name)?paper.id:'';document.body.dataset.note=documentNote?.kind==='vault'&&['notes','assistant'].includes(name)?documentNote.id:'';$('projects-search').hidden=name!=='projects';if(name==='projects')loadProjects();$('chat-workspace').hidden=name!=='assistant';$('paper-context').hidden=!paper||!['current','assistant','guide'].includes(name);$('dock-empty').hidden=!(name==='current'&&!paper);$('editor-workspace').hidden=!documentNote||!((name==='current'&&documentNote.kind==='paper')||(name==='notes'&&documentNote.kind==='vault')||(name==='reports'&&documentNote.kind==='report'));if($('editor-workspace').hidden){$('character-count').textContent='';status(({notes:'仓库笔记 · 报告单独存放',reports:'独立报告',projects:'工程文件与 AI 对话归档',guide:'文献导读 · 独立于个人笔记',papers:'仓库文献',assistant:'AI 助手'}[name]||'请选择文献'));}else $('character-count').textContent=$('reading-editor').value.length+' 字';$('paper-guide-workspace').hidden=name!=='guide';if(name==='guide'){$('paper-guide-content').innerHTML=paper?.guide_html||'<p>请先选择一篇文献。</p>';paintMath($('paper-guide-content'));}if(name==='assistant')ResearchChat.open(paper);if(name==='assistant')$('excerpt-inbox').hidden=true;for(const b of document.querySelectorAll('[data-pane]'))b.setAttribute('aria-selected',String(b.dataset.pane===name));$('notes-search').hidden=name!=='notes';$('papers-search').hidden=name!=='papers';$('reports-search').hidden=name!=='reports';if(name==='notes')searchNotes();if(name==='papers')renderPapers();if(name==='reports')searchReports();}
  function showMode(next){mode=next;$('reading-editor').hidden=next!=='edit';$('dock-preview').hidden=next!=='preview';$('dock-guide').hidden=next!=='guide';$('mode-edit').setAttribute('aria-pressed',String(next==='edit'));$('mode-preview').setAttribute('aria-pressed',String(next==='preview'));$('show-guide').setAttribute('aria-pressed',String(next==='guide'));if(next==='preview')preview();if(next==='guide'){ $('dock-guide').innerHTML=paper?.guide_html||'<p>当前文献暂无导读。</p>';paintMath($('dock-guide'));}}
  async function preview(){const run=++previewRun,text=$('reading-editor').value;try{const data=await api('/api/preview',{content:text});if(run===previewRun&&text===$('reading-editor').value){$('dock-preview').innerHTML=data.html;paintMath($('dock-preview'));}}catch(error){fail(error);}}
  function fillFolders(select,value){select.replaceChildren();for(const name of folders){const option=document.createElement('option');option.value=name;option.textContent=name;select.append(option);}if(value&&!folders.includes(value)){const o=document.createElement('option');o.value=value;o.textContent=value;select.append(o);}select.value=value||'文献笔记';}
  function loadDocument(value){
    recordDraft();previewRun++;document.body.dataset.note=value.kind==='vault'?value.id:'';documentNote={...value,savedContent:value.content,savedTitle:value.title,savedFolder:value.folder,savedTags:(value.tags||[]).join(', ')};
    syncCurrentStar();
    let recovered=false;
    try{const draft=JSON.parse(localStorage.getItem(draftKey(value.key))||(value.kind==='report'?localStorage.getItem(draftKey('vault:'+value.id)):null));if(draft){recovered=draft.content!==value.content||draft.title!==value.title||draft.folder!==value.folder||JSON.stringify(draft.tags||[])!==JSON.stringify(value.tags||[]);if(recovered)documentNote={...documentNote,...draft,version:draft.baseVersion};}}catch(_){}
    $('editor-workspace').hidden=false;$('dock-empty').hidden=true;$('document-title').value=documentNote.title;$('document-title').readOnly=value.kind!=='vault';$('document-properties').hidden=value.kind!=='vault';$('document-kind').textContent=value.kind==='paper'?'本文献笔记 · '+value.id:value.kind==='report'?'独立报告':'独立笔记';
    fillFolders($('document-folder'),documentNote.folder);$('document-tags').value=(documentNote.tags||[]).join(', ');$('reading-editor').value=documentNote.content;$('character-count').textContent=documentNote.content.length+' 字';$('show-guide').hidden=value.kind!=='paper'||documentNote.id!==paper?.id;
    $('new-note-inline').hidden=value.kind==='report';$('generate-reading').hidden=value.kind!=='paper';$('zotero-notes').hidden=$('export-zotero').hidden=value.kind!=='paper';$('zotero-notes').disabled=$('export-zotero').disabled=!paper?.zotero;$('native-notes-list').hidden=true;nativeExport=null;showMode('edit');
    $('mode-edit').hidden=$('mode-preview').hidden=$('save-note').hidden=value.kind==='paper';$('paper-autosave-hint').hidden=$('paper-quick-entry').hidden=value.kind!=='paper';
    $('paper-entry').value=value.kind==='paper'?(localStorage.getItem('rn-paper-entry:'+value.id)||''):'';
    sessionStorage.setItem('rn-dock-document:'+channel,documentNote.key);
    $('compare-conflict').hidden=!(recovered&&documentNote.version!==value.version);
    status(recovered?(documentNote.version!==value.version?'恢复的草稿与仓库版本不同，请先对照历史版本':'已恢复上次未保存的草稿'):(value.kind==='report'?'报告已载入':'笔记已载入'));
    if(recovered&&value.kind==='paper'&&documentNote.version===value.version)schedulePaperSave();
  }
  async function openPaper(id){
    recordDraft();const run=++navRun;status('正在读取文献…');
    try{await flushPaperSave();if(run!==navRun)return;const value=await api('/api/papers/'+encodeURIComponent(id));if(run!==navRun)return;paper=value;document.dispatchEvent(new CustomEvent('research-paper-change',{detail:value}));sessionStorage.setItem('rn-dock-context:'+channel,id);document.body.dataset.paper=id;$('paper-context').hidden=false;$('context-badge').textContent=id+' · '+(value.zotero?.attachment_key?'Zotero PDF':value.has_pdf?'本地 PDF':'全文待导入');$('context-title').textContent=value.title;$('context-meta').textContent=[value.author,value.year,value.venue].filter(Boolean).join(' · ');$('open-pdf').hidden=!value.has_pdf;loadDocument({key:'paper:'+id,kind:'paper',id,title:'文献笔记 · '+id,content:value.reading.content,version:value.reading.version,starred:value.starred});showPane('current');}
    catch(error){if(run===navRun)fail(error);}
  }
  async function followPaper(id){
    if(paper?.id===id)return;
    if(['current','guide'].includes(pane)){
      const previous=pane;await openPaper(id);if(previous==='guide')showPane('guide');return;
    }
    const run=++navRun;
    const value=await api('/api/papers/'+encodeURIComponent(id));if(run!==navRun)return;
    paper=value;sessionStorage.setItem('rn-dock-context:'+channel,id);document.body.dataset.paper=['assistant'].includes(pane)?id:'';document.dispatchEvent(new CustomEvent('research-paper-change',{detail:value}));if(pane==='assistant'){ $('paper-context').hidden=false;$('context-badge').textContent=id+' · Zotero PDF';$('context-title').textContent=value.title;$('context-meta').textContent=[value.author,value.year,value.venue].filter(Boolean).join(' · ');$('open-pdf').hidden=!value.has_pdf;await ResearchChat.open(value); }status('已关联当前 PDF · '+id);
  }
  async function openReport(id){recordDraft();const run=++navRun;try{await flushPaperSave();if(run!==navRun)return;const report=await api('/api/reports/'+id);if(run!==navRun)return;loadDocument({...report,key:'report:'+id,kind:'report'});showPane('reports');showMode('preview');}catch(e){fail(e);}}
  async function openNote(id){recordDraft();const run=++navRun;try{await flushPaperSave();if(run!==navRun)return;const note=await api('/api/notes/'+id);if(run!==navRun)return;loadDocument({...note,key:'vault:'+note.id,kind:'vault'});if(note.folder==='调研报告')showMode('preview');$('editor-workspace').scrollIntoView({block:'start',behavior:'smooth'});}catch(error){if(run===navRun)fail(error);}}
  async function flushPaperSave(){clearTimeout(autoSaveTimer);if(saveInFlight)await saveInFlight;if(documentNote?.kind==='paper'&&dirty())await save();}
  async function save(){
    while(saveInFlight)await saveInFlight;
    if(!documentNote||!dirty())return true;
    const task=saveNow();saveInFlight=task;let success=false;
    try{success=await task;return success;}finally{if(saveInFlight===task)saveInFlight=null;if(success&&documentNote?.kind==='paper'&&dirty())schedulePaperSave();}
  }
  async function saveNow(){
    if(!documentNote||$('save-note').disabled)return false;recordDraft();const note=documentNote,content=$('reading-editor').value,key=note.key;const snapshot={...note,tags:[...(note.tags||[])]};$('save-note').disabled=true;
    try{
      const result=await api(note.kind==='paper'?'/api/papers/'+note.id+'/reading':note.kind==='report'?'/api/reports/'+note.id:'/api/notes/'+note.id,note.kind==='paper'?{version:note.version,content}:{version:note.version,content,title:note.title,folder:note.folder,tags:note.tags});
      if(documentNote?.key===key){documentNote.version=result.version;documentNote.savedContent=content;documentNote.savedTitle=snapshot.title;documentNote.savedFolder=snapshot.folder;documentNote.savedTags=snapshot.tags.join(', ');if(!dirty()){localStorage.removeItem(draftKey(key));status('已保存 · 历史版本已保留');}else{recordDraft();status('先前内容已保存，新增修改仍为草稿');}}
      else {try{const cached=JSON.parse(localStorage.getItem(draftKey(key)));if(cached?.content===content)localStorage.removeItem(draftKey(key));else if(cached){cached.baseVersion=result.version;localStorage.setItem(draftKey(key),JSON.stringify(cached));}}catch(_){}}
      if(documentNote?.key===key)$('compare-conflict').hidden=true;
      if(pane==='notes')searchNotes();return true;
    }catch(error){if(documentNote?.key===key&&/文件已被|精读笔记已被/.test(error.message))$('compare-conflict').hidden=false;fail(new Error(error.message+'；草稿已保留'));return false;}finally{$('save-note').disabled=false;}
  }
  function newNote(context){fillFolders($('create-folder'),'文献笔记');newNoteContent=context?.text?clipMarkdown(context):'';$('create-title').value=context?.text?'文献笔记 · '+context.paper_id+' · '+context.text.replace(/\s+/g,' ').slice(0,24):'';$('create-note-dialog').showModal();$('create-title').focus();}
  async function searchNotes(){
    const run=++noteSearchRun;
    try{
      const q=$('note-query').value.trim(),[data,paperNotes]=await Promise.all([api('/api/notes?trash='+(trashView?'1':'0')+'&q='+encodeURIComponent(q)),trashView?Promise.resolve([]):api('/api/paper-notes?q='+encodeURIComponent(q))]);
      if(run!==noteSearchRun)return;folders=data.folders;const list=$('notes-results');list.replaceChildren();
      const entries=[...paperNotes.map(n=>({...n,starKind:'paper'})),...data.notes.map(n=>({...n,starKind:'note'}))].filter(n=>!starredNotesOnly||n.starred).sort((a,b)=>Number(!!b.starred)-Number(!!a.starred));
      for(const note of entries.slice(0,100)){
        if(trashView){const row=card(note.title,'点击恢复');row.onclick=async()=>{try{await api('/api/notes/'+note.id+'/restore',{});searchNotes();status('笔记已恢复');}catch(error){fail(error);}};list.append(row);}
        else list.append(starredCard(note,note.starKind,note.starKind==='paper'?'本文献笔记 · '+note.id:note.folder+' · '+note.excerpt,()=>note.starKind==='paper'?openPaper(note.id):openNote(note.id)));
      }
      if(!entries.length)list.textContent=starredNotesOnly?'没有匹配的星标笔记，点击笔记旁的 ☆ 可添加。':'没有找到笔记，可以新建一篇。';
    }catch(error){if(run===noteSearchRun)fail(error);}
  }
  async function searchReports(){
    const run=++reportSearchRun;
    try{
      const data=await api('/api/reports?q='+encodeURIComponent($('report-query').value.trim()));if(run!==reportSearchRun)return;
      const list=$('reports-results');list.replaceChildren();const notes=data.notes.filter(n=>!starredReportsOnly||n.starred);
      for(const note of notes)list.append(starredCard(note,'report',note.excerpt,()=>openReport(note.id)));
      if(!notes.length)list.textContent=starredReportsOnly?'没有匹配的星标报告，点击报告旁的 ☆ 可添加。':'没有匹配的报告。';
    }catch(error){fail(error);}
  }
  function card(title,subtitle){const row=document.createElement('button');row.className='result-card';const strong=document.createElement('strong'),small=document.createElement('small');strong.textContent=title;small.textContent=subtitle;row.append(strong,small);return row;}
  let projectPath='',projectRun=0;
  async function loadProjects(){const run=++projectRun;try{const [setting,data]=await Promise.all([api('/api/projects/settings'),api('/api/projects/files?q='+encodeURIComponent($('project-query').value))]);if(run!==projectRun)return;$('project-location').textContent=setting.root;$('project-results').replaceChildren();for(const file of data.files){const row=card(file.path,Math.ceil(file.bytes/1024)+' KB'+(file.editable?' · 可读写文本':' · 文件信息'));row.onclick=async()=>{projectPath=file.path;$('project-ask').hidden=!file.editable;try{$('project-image').hidden=true;$('project-preview').hidden=true;const url='/api/projects/asset?path='+encodeURIComponent(file.path);$('project-download').href=url;$('project-download').hidden=false;if(/\.(png|jpe?g|gif|webp|bmp)$/i.test(file.path)){$('project-image').src=url;$('project-image').hidden=false;}if(!file.editable)return;const doc=await api('/api/projects/read',{path:file.path});$('project-preview').textContent=doc.content;$('project-preview').hidden=false;}catch(e){fail(e);}};$('project-results').append(row);}if(!data.files.length)$('project-results').textContent='当前工程目录中没有匹配文件。点击“工程目录”选择已有项目，或在 AI 助手中新建研究计划、脚本和数据表。';}catch(e){fail(e);}}
  $('project-import').onclick=()=>$('project-file-input').click();
  $('project-file-input').onchange=async event=>{const files=[...event.target.files];$('project-import').disabled=true;let imported=0;try{for(const file of files){if(file.size>20000000)throw new Error(file.name+' 超过20MB，请直接放入工程目录');const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=()=>reject(new Error('文件读取失败'));r.readAsDataURL(file);});await api('/api/projects/import',{path:file.name,data});imported++;}status('已导入 '+imported+' 个工程文件');}catch(e){status('已导入 '+imported+' 个；'+e.message,true);}finally{event.target.value='';$('project-import').disabled=false;loadProjects();}};
  $('project-query').oninput=loadProjects;$('project-settings-button').onclick=()=>ResearchUI.openAISettings();
  $('project-ask').onclick=()=>{showPane('assistant');ResearchChat.open(null);$('chat-question').value='请读取工程文件 '+projectPath+'，';$('chat-question').focus();};
  document.addEventListener('research-project-changed',()=>{projectPath='';$('project-image').hidden=true;$('project-download').hidden=true;$('project-preview').hidden=true;$('project-ask').hidden=true;if(pane==='projects')loadProjects();});
  document.addEventListener('research-open-paper',event=>openPaper(event.detail.paper_id));
  document.addEventListener('research-literature-task',event=>{showPane('papers');ResearchLiterature.watch(event.detail.task_id);});
  document.addEventListener('research-library-changed',()=>refreshPapers());
  async function refreshPapers(){try{catalog=await api('/api/papers');renderPapers();}catch(error){fail(error);}}
  let paperLimit=70;
  function renderPapers(reset=true){if(reset)paperLimit=70;const words=$('paper-query').value.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);const matches=catalog.filter(r=>words.every(w=>[r.id,r.title,r.author,r.year,r.url].join(' ').toLocaleLowerCase().includes(w)));$('papers-count').textContent=matches.length+' 篇文献 · 检索已收录的文献题录';const list=$('papers-results');list.replaceChildren();for(const ref of matches.slice(0,paperLimit)){const row=document.createElement('div');row.className='result-card paper-result';const main=document.createElement('button');main.className='paper-result-main';const title=document.createElement('strong'),meta=document.createElement('small');title.textContent=ref.title;meta.textContent=[ref.id,ref.year,ref.author,ref.zotero?.attachment_key?'PDF 已存 Zotero storage':ref.zotero?'Zotero 题录 · 全文待获取':'全文待关联'].filter(Boolean).join(' · ');main.append(title,meta);main.onclick=async()=>{try{if(!ref.zotero?.attachment_key||!await ResearchUI.openPaperPDF(ref.id))await openPaper(ref.id);}catch(error){fail(error);}};const actions=document.createElement('div');actions.className='result-actions';if(ref.zotero?.attachment_key){const pdf=document.createElement('button');pdf.className='quiet';pdf.textContent='打开 PDF ↗';pdf.onclick=async()=>{try{if(!await ResearchUI.openPaperPDF(ref.id))throw new Error('该文献尚无可打开的 PDF');}catch(error){fail(error);}};actions.append(pdf);}const note=document.createElement('button');note.className='quiet';note.textContent='精读笔记';note.onclick=()=>openPaper(ref.id);actions.append(note);row.append(main,actions);list.append(row);}if(matches.length>paperLimit){const more=document.createElement('button');more.className='quiet';more.textContent='加载更多（已显示 '+paperLimit+' / '+matches.length+'）';more.onclick=()=>{paperLimit+=70;renderPapers(false);};list.append(more);}if(!matches.length)list.textContent='没有匹配的文献。可在 Zotero 中对该论文点击「科研精读」收录。';}
  async function receiveClip(event){
    const clipID=channel+':'+event.sequence;if(inserted.has(clipID))return;
    if(event.background){
      const content=clipMarkdown(event,await ResearchUI.excerptMetadata());
      await ResearchUI.appendSelectionNote(event.note_id||'paper:'+event.paper_id,content);
      inserted.add(clipID);return;
    }
    pendingClip=event;pendingClip.clipID=clipID;$('excerpt-inbox').hidden=false;$('excerpt-text').textContent=event.text;$('excerpt-source').textContent=event.paper_id+(event.page?' · PDF 第 '+event.page+' 页':'');
    if(documentNote?.kind!=='paper'||documentNote.id!==event.paper_id)await openPaper(event.paper_id);
    if(!documentNote)return;showPane(documentNote.kind==='paper'?'current':'notes');
    const added=await insertClip();if(added&&event.autosave){const saved=await save();if(saved)status('选中内容已摘抄并保存');}
  }
  function clipMarkdown(clip,includeSource=false){
    if(!includeSource)return '\n\n'+clip.text.trim().split(/\r?\n/).map(line=>'> '+line).join('\n')+'\n';
    const ref=catalog.find(r=>r.id===clip.paper_id),title=clip.title||ref?.title||clip.paper_id;
    const uri=clip.source_uri||(clip.attachment_key?'zotero://open-pdf/library/items/'+clip.attachment_key+(clip.page?'?page='+clip.page:''):'');
    const source=uri?'[来源：'+title.replace(/[\[\]]/g,'')+(clip.page?' · PDF 第 '+clip.page+' 页':'')+']('+uri+')':'来源：'+clip.paper_id+(clip.page?' · PDF 第 '+clip.page+' 页':'');
    return '\n\n'+source+(clip.clip_kind==='translation'?'\n\n**译文摘抄**':clip.clip_kind==='summary'?'\n\n**总结摘抄**':'')+'\n\n'+clip.text.split(/\r?\n/).map(line=>'> '+line).join('\n')+'\n';
  }
  async function openContext(event){
    if(event.intent==='assistant'){if(paper?.id!==event.paper_id)await openPaper(event.paper_id);showPane('assistant');await ResearchChat.setSelection(paper,event);status('选文已带入 AI 助手，可直接提问');return;}
    if(event.intent==='reports'){showPane('reports');return;}
    if(paper?.id!==event.paper_id||documentNote?.kind!=='paper')await openPaper(event.paper_id);
    if(event.intent==='new'){newNote(event);return;}
    showPane('current');showMode('edit');$('reading-editor').focus();
    if(event.text){pendingClip={...event,clipID:channel+':'+event.sequence};$('excerpt-text').textContent=event.text;$('excerpt-source').textContent=event.paper_id+(event.page?' · PDF 第 '+event.page+' 页':'');$('excerpt-inbox').hidden=false;status('笔记已打开，可直接编辑；需要时插入当前选文');}
  }
  async function insertClip(){
    const clip=pendingClip;if(!clip||!documentNote||inserted.has(clip.clipID))return;
    const target=documentNote,includeSource=await ResearchUI.excerptMetadata();
    if(documentNote!==target||pendingClip!==clip||inserted.has(clip.clipID))return false;
    const text=clipMarkdown(clip,includeSource);
    $('reading-editor').value=$('reading-editor').value.trimEnd()+text;inserted.add(clip.clipID);pendingClip=null;$('excerpt-inbox').hidden=true;showMode('edit');changed();status('选文已加入笔记 · 待保存');$('reading-editor').focus();$('reading-editor').scrollTop=$('reading-editor').scrollHeight;return true;
  }
  async function nativeAction(action,extra={}){if(!paper?.zotero)throw new Error('当前文献尚未关联 Zotero PDF');return api('/api/zotero/action',{paper_id:paper.id,action,...extra});}
  async function showNativeNotes(){try{const result=await nativeAction('list_notes');const list=$('native-notes-list');list.replaceChildren();list.hidden=false;for(const note of result.notes){const parsed=new DOMParser().parseFromString(note.html,'text/html');parsed.querySelectorAll('br').forEach(e=>e.replaceWith('\n'));parsed.querySelectorAll('p,div,h1,h2,h3,li').forEach(e=>e.append('\n'));const text=parsed.body.textContent.trim();const row=card(note.title||'Zotero 笔记',text.slice(0,180));row.title='点击追加到当前草稿';row.onclick=()=>{$('reading-editor').value+='\n\n## '+(note.title||'Zotero 笔记')+'\n\n'+text+'\n';changed();showMode('edit');status('Zotero 笔记已追加到草稿，原笔记保留');};list.append(row);}if(!result.notes.length)list.textContent='这篇文献还没有 Zotero 子笔记。';}catch(error){fail(error);}}
  async function history(){if(!documentNote)return;const note=documentNote,key=note.key;try{const base=note.kind==='paper'?'/api/papers/'+note.id:note.kind==='report'?'/api/reports/'+note.id:'/api/notes/'+note.id;const rows=await api(base+'/history');if(documentNote?.key!==key)return;const list=$('history-results');list.replaceChildren();for(const row of rows){const button=card(row.time,row.characters+' 字符 · 点击载入为草稿');button.onclick=async()=>{try{const result=await api(base+'/history/'+row.key);if(documentNote?.key!==key)return;$('reading-editor').value=result.content;changed();showMode('edit');$('history-dialog').close();status('历史内容已载入为草稿，保存后更新');}catch(error){fail(error);}};list.append(button);}if(!rows.length)list.textContent='尚无历史版本。修改已保存的笔记后会自动保留。';$('history-dialog').showModal();}catch(error){fail(error);}}
  async function generate(){
    if(generating||!paper)return;const id=paper.id,version=paper.guide_version;generating=true;$('generate-guide').disabled=true;status('正在生成独立导读…');
    try{const result=await api('/api/papers/'+id+'/analyze',{});if(result.truncated)throw new Error('导读未完整生成，未覆盖现有导读');await api('/api/papers/'+id+'/guide',{version,content:result.text});if(paper?.id===id){const updated=await api('/api/papers/'+id);paper={...paper,...updated};showPane('guide');}status('导读已单独保存，文献笔记未改动');}catch(e){fail(e);}finally{generating=false;$('generate-guide').disabled=false;}
  }

  async function listen(){
    if(!channel)return;const abort=new AbortController();window.addEventListener('pagehide',()=>{alive=false;abort.abort();},{once:true});
    const indicator=document.createElement('span');indicator.id='dock-connection-status';indicator.setAttribute('role','status');indicator.hidden=true;document.querySelector('.dock-status').append(indicator);let failures=0;
    while(alive){
      const pending=new AbortController(),cancel=()=>pending.abort();abort.signal.addEventListener('abort',cancel,{once:true});const timeout=setTimeout(cancel,25000);
      try{
        const response=await fetch('/api/dock/events?channel='+encodeURIComponent(channel)+'&since='+sequence,{signal:pending.signal,cache:'no-store'});const data=await response.json();if(!response.ok)throw new Error(data.error||'选文通道暂未连接');
        if(data.reset)sequence=0;
        for(const event of data.events){userNavigated=true;if(event.type==='home'){showPane('notes');$('note-query').focus();}else if(event.type==='paper'){if(event.intent==='follow_reader')await followPaper(event.paper_id);else{if(paper?.id!==event.paper_id||documentNote?.kind!=='paper'||documentNote?.id!==event.paper_id)await openPaper(event.paper_id);showPane('current');showMode('edit');}}else if(event.type==='clip')await receiveClip(event);else if(event.type==='context')await openContext(event);else if(event.type==='open_note'){showPane('notes');await openNote(event.note_id);showPane('notes');}sequence=event.sequence;sessionStorage.setItem('rn-dock-sequence:'+channel,String(sequence));}
        sequence=Math.max(sequence,data.sequence);sessionStorage.setItem('rn-dock-sequence:'+channel,String(sequence));failures=0;indicator.hidden=true;
      }catch(error){
        if(!alive)return;recordDraft();failures++;indicator.hidden=false;indicator.textContent='正在重连 Zotero 选文通道…';
        const probe=new AbortController(),probeTimeout=setTimeout(()=>probe.abort(),3000);
        try{const response=await fetch('/health',{signal:probe.signal,cache:'no-store'});const health=await response.json();if(!response.ok||health.app!=='research-notebook')throw new Error();indicator.textContent='Zotero 选文通道正在重连；本地仓库可连接';}
        catch(_){indicator.textContent='本地服务暂未连接；当前修改请保留在窗口中，恢复后再保存';}
        finally{clearTimeout(probeTimeout);}
        await new Promise(resolve=>setTimeout(resolve,Math.min(8000,500*2**Math.min(failures,4))));
      }finally{clearTimeout(timeout);abort.signal.removeEventListener('abort',cancel);}
    }
  }
  document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'&&!document.querySelector('dialog[open]')){e.preventDefault();if(documentNote)save();}if((e.ctrlKey||e.metaKey)&&e.shiftKey&&e.key.toLowerCase()==='n'){e.preventDefault();newNote();}});
  document.querySelectorAll('[data-pane]').forEach(button=>button.onclick=()=>{userNavigated=true;if(button.dataset.pane==='current'&&paper&&(documentNote?.kind!=='paper'||documentNote?.id!==paper.id))openPaper(paper.id);else showPane(button.dataset.pane);});
  $('mode-edit').onclick=()=>showMode('edit');$('mode-preview').onclick=()=>showMode('preview');$('show-guide').onclick=()=>showPane('guide');$('generate-guide').onclick=generate;$('reading-editor').oninput=changed;$('reading-editor').addEventListener('keydown',event=>{if(documentNote?.kind==='paper'&&event.key==='Enter'&&!event.shiftKey&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.isComposing&&event.keyCode!==229){event.preventDefault();clearTimeout(autoSaveTimer);save();}});$('document-title').oninput=changed;$('document-folder').onchange=changed;$('document-tags').oninput=changed;$('save-note').onclick=save;
  $('paper-entry').oninput=()=>{if(documentNote?.kind==='paper')try{localStorage.setItem('rn-paper-entry:'+documentNote.id,$('paper-entry').value);}catch(_){status('快速输入草稿无法缓存，请及时提交',true);}};
  $('paper-entry').addEventListener('keydown',event=>{if(documentNote?.kind!=='paper'||event.key!=='Enter'||event.shiftKey||event.ctrlKey||event.metaKey||event.altKey||event.isComposing||event.keyCode===229)return;event.preventDefault();const input=$('paper-entry'),text=input.value.trim();if(!text)return;const editor=$('reading-editor');editor.value=editor.value.trimEnd()+(editor.value.trim()?'\n\n':'')+text+'\n';changed();input.value='';try{localStorage.removeItem('rn-paper-entry:'+documentNote.id);}catch(_){}clearTimeout(autoSaveTimer);save();});
  $('trash-notes').onclick=()=>{trashView=!trashView;$('trash-notes').textContent=trashView?'返回笔记':'回收站';$('trash-notes').setAttribute('aria-pressed',String(trashView));searchNotes();};
  $('new-note').onclick=$('new-note-inline').onclick=$('empty-new').onclick=newNote;$('cancel-create').onclick=()=>$('create-note-dialog').close();
  $('create-note-form').onsubmit=async event=>{event.preventDefault();try{await flushPaperSave();const note=await api('/api/notes',{title:$('create-title').value,folder:$('create-folder').value,tags:paper?[paper.id]:[],content:newNoteContent});$('create-note-dialog').close();newNoteContent='';pendingClip=null;$('excerpt-inbox').hidden=true;navRun++;loadDocument({...note,key:'vault:'+note.id,kind:'vault'});showPane('notes');$('reading-editor').focus();}catch(error){fail(error);}};
  let searchTimer;$('note-query').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(searchNotes,150);};$('paper-query').oninput=renderPapers;$('refresh-papers').onclick=refreshPapers;
  $('report-query').oninput=searchReports;
  $('insert-excerpt').onclick=()=>insertClip().catch(fail);$('discard-excerpt').onclick=()=>{pendingClip=null;$('excerpt-inbox').hidden=true;};$('history-button').onclick=history;$('close-history').onclick=()=>$('history-dialog').close();
  $('open-pdf').onclick=async()=>{try{await nativeAction('open_pdf');}catch(error){fail(error);}};$('zotero-notes').onclick=showNativeNotes;
  $('export-zotero').onclick=async()=>{if(nativeExport===$('reading-editor').value)return;const text=$('reading-editor').value,pid=paper?.id;$('export-zotero').disabled=true;try{await nativeAction('save_note',{content:'# '+$('document-title').value+'\n\n'+text});if(paper?.id===pid&&text===$('reading-editor').value)nativeExport=text;status('已保存为 Zotero 子笔记');}catch(error){fail(error);}finally{$('export-zotero').disabled=nativeExport===$('reading-editor').value||!paper?.zotero;}};
  $('copy-note').onclick=async()=>{try{await navigator.clipboard.writeText($('reading-editor').value);status('笔记已复制');}catch(_){status('请在编辑区选中内容后复制',true);}};
  $('compare-conflict').onclick=async()=>{
    if(!documentNote)return;const key=documentNote.key;
    try{const latest=documentNote.kind==='paper'?(await api('/api/papers/'+documentNote.id)).reading:await api((documentNote.kind==='report'?'/api/reports/':'/api/notes/')+documentNote.id);if(documentNote?.key!==key)return;conflictState={key,version:latest.version};$('remote-content').value=latest.content;$('local-content').value=$('reading-editor').value;$('conflict-dialog').showModal();}catch(error){fail(error);}
  };
  $('close-conflict').onclick=()=>$('conflict-dialog').close();
  $('keep-draft').onclick=async()=>{if(documentNote?.key!==conflictState?.key)return;documentNote.version=conflictState.version;recordDraft();$('conflict-dialog').close();await save();};
  $('generate-reading').onclick=()=>{$('ai-notice').hidden=false;generate();};
  window.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();save();}});
  window.addEventListener('pagehide',recordDraft);
  const appendedSelections=new Set();
  document.addEventListener('research-append-selection',event=>{
    const detail=event.detail,key=detail.note_id.startsWith('paper:')?detail.note_id:'vault:'+detail.note_id;
    if(!documentNote||documentNote.key!==key||documentNote.kind==='report')return;detail.handled=true;
    detail.promise=(async()=>{if(!appendedSelections.has(detail.operation_id)){$('reading-editor').value=$('reading-editor').value.trimEnd()+'\n\n'+detail.content;appendedSelections.add(detail.operation_id);changed();}if(!await save())throw new Error('选文已加入当前草稿，但保存未成功，请处理保存提示后重试');return {id:detail.note_id,title:documentNote.title};})();
  });
  document.addEventListener('research-open-note',event=>{const id=event.detail.note_id;if(id.startsWith('paper:'))openPaper(id.slice(6));else{showPane('notes');openNote(id);}});
  document.addEventListener('research-note-action',event=>{
    if(event.detail.kind==='project'){if(pane==='projects')loadProjects();return;}if(event.detail.kind==='tags')return;const id=event.detail.note_id,key=id.startsWith('paper:')?'paper:'+id.slice(6):'vault:'+id;
    if(documentNote?.key===key){if(dirty()){recordDraft();$('compare-conflict').hidden=true;status('AI 已更新此笔记；当前草稿保留，保存时请对照最新版本');if(event.detail.action!=='delete_note')$('compare-conflict').hidden=false;}else{documentNote=null;$('editor-workspace').hidden=true;}}
    if(pane==='notes')searchNotes();if(pane==='reports')searchReports();
  });
  document.addEventListener('research-chat-saved',event=>{if(documentNote?.kind==='paper'&&documentNote.id===event.detail.paper_id){if(!dirty())openPaper(event.detail.paper_id);else{$('compare-conflict').hidden=false;status('AI 回答已追加到仓库；当前草稿保留，请对照最新版本后保存');}}});
  document.addEventListener('click',event=>{const link=event.target.closest('a');if(!link)return;if(link.dataset.open){event.preventDefault();event.stopImmediatePropagation();if(link.dataset.open.startsWith('report:'))openReport(link.dataset.open.slice(7));else{showPane('notes');openNote(link.dataset.open);}return;}if(link.dataset.paper){event.preventDefault();event.stopImmediatePropagation();const ref=catalog.find(r=>r.id===link.dataset.paper);if(ref?.zotero?.attachment_key)ResearchUI.openPaperPDF(ref.id,Number(link.dataset.page)||null).catch(fail);else openPaper(link.dataset.paper);return;}if(link.href.startsWith('zotero://open-pdf/')){event.preventDefault();event.stopImmediatePropagation();const url=new URL(link.href),key=url.pathname.split('/').pop(),ref=catalog.find(r=>r.zotero?.attachment_key===key);if(ref)ResearchUI.openPaperPDF(ref.id,Number(url.searchParams.get('page'))||null).catch(fail);else status('该来源尚未关联，请在 Zotero 中打开原论文',true);}},true);
  // Start the reader bridge independently of catalog loading: a slow or failed
  // initial request must never prevent later Zotero tab changes from arriving.
  listen();
  (async()=>{try{const lastDocument=sessionStorage.getItem('rn-dock-document:'+channel),id=sessionStorage.getItem('rn-dock-context:'+channel)||query.get('paper');const data=await api('/api/notes');folders=data.folders;await refreshPapers();if(userNavigated)return;if(id)await openPaper(id);else{$('dock-empty').hidden=false;showPane('notes');status('已连接本地仓库');}if(userNavigated)return;if(lastDocument?.startsWith('report:')){await openReport(lastDocument.slice(7));}else if(lastDocument?.startsWith('vault:')){await openNote(lastDocument.slice(6));showPane('notes');}if(!userNavigated&&['reports','notes','papers','projects','assistant','guide'].includes(query.get('pane')))showPane(query.get('pane'));}catch(error){fail(error);}})();
})();



