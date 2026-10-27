'use strict';
var ResearchNotebookPlugin={
  id:'research-notebook@local.research', bundleRoot:null, windows:new Map(), docks:new Map(), starting:null,
  get root(){return Zotero.Prefs.get('extensions.researchnotebook.root',true)||this.bundleRoot||PathUtils.join(PathUtils.homeDir,'Zotero_ai_assistant');},
  path(...parts){return PathUtils.join(this.root,...parts);},
  async status(data){
    await IOUtils.writeJSON(this.path('.runtime','zotero-plugin-status.json'),{plugin:this.id,version:this.version||'1.9.12',zoteroVersion:Zotero.version,time:new Date().toISOString(),...data});
  },
  async start(data){
    this.version=data.version||'1.9.12';
    this.active=true;this.selectionStates=new WeakMap();this.selectionTimers=new Set();this.translationJobs=new Map();this.selectionPanels=new Set();
    this.selectionHandler=this.selectionPopup.bind(this);
    this.toolbarHandler=this.readerToolbar.bind(this);
    Zotero.Reader.registerEventListener('renderTextSelectionPopup',this.selectionHandler,this.id);
    Zotero.Reader.registerEventListener('renderToolbar',this.toolbarHandler,this.id);
    this.bridgeToken=Array.from(crypto.getRandomValues(new Uint8Array(32))).map(n=>n.toString(16).padStart(2,'0')).join('');
    await IOUtils.writeJSON(this.path('.runtime','zotero-bridge.json'),{token:this.bridgeToken,plugin:this.id});
    const owner=this;
    this.endpoint=function(){};
    this.endpoint.prototype={supportedMethods:['POST'],supportedDataTypes:['application/json'],permitBookmarklet:false,
      async init(request){
        if(request.data?.bridge_token!==owner.bridgeToken)return [403,'application/json',JSON.stringify({error:'插件请求未授权'})];
        if(request.data.paper_id&&!/^(?:[A-D]\d{1,2}|Z\d+_[A-Z0-9]{8})$/.test(request.data.paper_id))return [400,'application/json',JSON.stringify({error:'文献编号不合法'})];
        try{await owner.openPage(request.data.paper_id);return [200,'application/json','{"ok":true}'];}
        catch(error){return [500,'application/json',JSON.stringify({error:error.message})];}
      }};
    Zotero.Server.Endpoints['/research-notebook/open']=this.endpoint;
    this.actionEndpoint=function(){};
    this.actionEndpoint.prototype={supportedMethods:['POST'],supportedDataTypes:['application/json'],permitBookmarklet:false,async init(request){
      if(request.data?.bridge_token!==owner.bridgeToken)return [403,'application/json',JSON.stringify({error:'插件请求未授权'})];
      try{return [200,'application/json',JSON.stringify(await owner.nativeAction(request.data))];}
      catch(error){return [400,'application/json',JSON.stringify({error:error.message})];}
    }};
    Zotero.Server.Endpoints['/research-notebook/action']=this.actionEndpoint;
    this.updateEndpoint=function(){};
    this.updateEndpoint.prototype={supportedMethods:['POST'],supportedDataTypes:['application/json'],permitBookmarklet:false,async init(request){
      if(request.data?.bridge_token!==owner.bridgeToken)return [403,'application/json',JSON.stringify({error:'插件请求未授权'})];
      ResearchNotebookUpdater.check(true).catch(error=>Zotero.logError(error));return [202,'application/json',JSON.stringify({queued:true})];
    }};
    Zotero.Server.Endpoints['/research-notebook/update']=this.updateEndpoint;
    for(const win of Zotero.getMainWindows())this.addWindow(win);
    Zotero.ResearchNotebook=this;
    await this.status({loaded:true,menuWindows:this.windows.size,readerHooks:true});
    try{
      const helper=Components.classes['@mozilla.org/process/util;1'].createInstance(Components.interfaces.nsIProcess);
      helper.init(Zotero.File.pathToFile(this.path('.runtime','python','pythonw.exe')));
      const args=[this.path('stage_zotero_update.py'),'--cleanup-only','--profile',Services.dirsvc.get('ProfD',Components.interfaces.nsIFile).path];
      helper.runwAsync(args,args.length,null,false);
    }catch(error){Zotero.logError(error);}
    ResearchNotebookUpdater.start(this);
  },
  stop(){
    ResearchNotebookUpdater.stop();
    for(const state of this.selectionPanels||[])state.dispose();this.selectionPanels?.clear();
    for(const job of this.translationJobs?.values()||[]){job.xhr?.abort();job.listeners?.clear();}this.translationJobs?.clear();
    this.active=false;for(const timer of this.selectionTimers||[])clearTimeout(timer);this.selectionTimers?.clear();
    Zotero.Reader.unregisterEventListener('renderTextSelectionPopup',this.selectionHandler);
    Zotero.Reader.unregisterEventListener('renderToolbar',this.toolbarHandler);
    for(const win of [...this.windows.keys()])this.removeWindow(win);
    for(const dock of this.docks.values())dock.dispose?.();this.docks.clear();
    if(Zotero.Server.Endpoints['/research-notebook/open']===this.endpoint)delete Zotero.Server.Endpoints['/research-notebook/open'];
    if(Zotero.Server.Endpoints['/research-notebook/action']===this.actionEndpoint)delete Zotero.Server.Endpoints['/research-notebook/action'];
    if(Zotero.Server.Endpoints['/research-notebook/update']===this.updateEndpoint)delete Zotero.Server.Endpoints['/research-notebook/update'];
    if(Zotero.ResearchNotebook===this)delete Zotero.ResearchNotebook;
  },
  addWindow(win){
    if(this.windows.has(win))return;
    const doc=win.document,nodes=[];
    const launch=doc.createElementNS('http://www.w3.org/1999/xhtml','button');launch.id='research-notebook-launch';launch.textContent='科研仓库';launch.title='打开科研笔记仓库 · Ctrl + Alt + N';launch.style.cssText='font:12px system-ui;padding:5px 10px;margin:0 7px;border:1px solid #b4cec1;border-radius:6px;background:#edf6ef;color:#225e48;cursor:pointer;white-space:nowrap;';
    launch.addEventListener('click',()=>this.openActiveOrHome(win).catch(error=>this.error(error,win)));
    const toolbar=doc.getElementById('zotero-items-toolbar')||doc.getElementById('zotero-toolbar');
    if(toolbar)toolbar.append(launch);else{launch.style.cssText+='position:fixed;bottom:12px;right:18px;z-index:2147482000;';doc.documentElement.append(launch);}nodes.push(launch);
    // The library toolbar belongs to an inactive deck while a PDF tab is selected.
    // Keep a separate launcher outside that deck, above both library and reader.
    const global=doc.createElementNS('http://www.w3.org/1999/xhtml','button');global.id='research-notebook-global-launch';global.textContent='科研仓库';global.title='打开科研仓库并关联当前 PDF · Ctrl + Alt + N';global.setAttribute('aria-label','打开科研仓库');global.style.cssText='position:fixed!important;right:24px!important;bottom:18px!important;top:auto!important;left:auto!important;z-index:2147483500!important;visibility:visible!important;box-sizing:border-box;margin:0;padding:9px 16px;border:1px solid #bdd5c8;border-radius:18px;background:#216b55;color:#fff;box-shadow:0 3px 15px #143c3533;font:600 12px system-ui;cursor:pointer;';global.addEventListener('click',()=>this.openActiveOrHome(win).catch(error=>this.error(error,win)));doc.documentElement.append(global);nodes.push(global);
    const shortcut=e=>{if(e.ctrlKey&&e.altKey&&e.key.toLowerCase()==='n'){e.preventDefault();this.openActiveOrHome(win).catch(error=>this.error(error,win));}};win.addEventListener('keydown',shortcut);nodes.push(()=>win.removeEventListener('keydown',shortcut));
    const action=(label,handler,id)=>{const item=doc.createXULElement('menuitem');item.id=id;item.setAttribute('label',label);item.addEventListener('command',()=>Promise.resolve(handler()).catch(error=>this.error(error,win)));return item;};
    const tools=doc.getElementById('menu_ToolsPopup');
    if(tools){
      const menu=doc.createXULElement('menu');menu.id='research-notebook-tools';menu.setAttribute('label','科研笔记仓库');
      const popup=doc.createXULElement('menupopup');
      popup.append(action('打开科研笔记仓库',()=>this.openPage(),'rn-open-vault'),action('精读当前选中文献',()=>this.openSelected(win),'rn-read-selected'),action('关联报告与 Zotero 已有 PDF',()=>this.sync(win),'rn-sync-storage'));
      for(const [command,label] of [['fetch','补取全文（多来源自动回退）'],['jasminum','茉莉花：识别所选中文 PDF 附件'],['linter','Linter：规范所选题录'],['citation','Easier Citation：引用到 Word']]){
        popup.append(action(label,async()=>{const result=await ResearchNotebookIntegrations.run(this,win,command);ResearchNotebookIntegrations.lastResult=result;if(command!=='citation')Services.prompt.alert(win,'文献工具',result.message);},'rn-integration-'+command));
      }
      popup.append(action('检查本地插件更新',async()=>{const result=await ResearchNotebookUpdater.check(true);Services.prompt.alert(win,'科研笔记仓库',result.state==='installed'?'已更新至 '+result.version:result.state==='current'?'已是本机最新版本 '+result.version:'暂无可用本地更新');},'rn-check-update'));
      menu.append(popup);tools.append(menu);nodes.push(menu);
    }
    const context=doc.getElementById('zotero-itemmenu');
    if(context){
      const sep=doc.createXULElement('menuseparator');const item=action('科研笔记仓库：精读此文献',()=>this.openSelected(win),'rn-context-read');context.append(sep,item);nodes.push(sep,item);
      const update=()=>{item.hidden=!win.ZoteroPane?.getSelectedItems?.().length;};context.addEventListener('popupshowing',update);nodes.push(()=>context.removeEventListener('popupshowing',update));
    }
    const tree=doc.getElementById('zotero-items-tree');
    if(tree){
      let clickRun=0;
      const openOnClick=event=>{
        if(event.button!==0||event.detail!==1||event.ctrlKey||event.metaKey||event.shiftKey||event.target.closest?.('button,input,select,[role="columnheader"],.twisty')||!event.target.closest?.('.row,[role="row"]'))return;
        const run=++clickRun;
        Promise.resolve().then(async()=>{const selected=win.ZoteroPane?.getSelectedItems?.()||[];if(!this.active||run!==clickRun||selected.length!==1)return;const item=selected[0];if(!(item.isRegularItem?.()||(item.isAttachment?.()&&item.attachmentContentType==='application/pdf')))return;try{await this.openSelected(win);}catch(error){Zotero.logError(error);}});
      };
      tree.addEventListener('click',openOnClick);nodes.push(()=>tree.removeEventListener('click',openOnClick));
    }
    this.windows.set(win,nodes);
  },
  removeWindow(win){for(const node of this.windows.get(win)||[])typeof node==='function'?node():node.remove();this.windows.delete(win);const dock=this.docks.get(win);if(dock){dock.dispose?.();this.docks.delete(win);}},
  error(error,win){Zotero.logError(error);Services.prompt.alert(win||Zotero.getMainWindow(),'科研笔记仓库',error.message||String(error));},
  async ensureService(){
    const check=async()=>{
      try{const state=await IOUtils.readJSON(this.path('.runtime','state.json'));
        const response=await Zotero.HTTP.request('GET',`http://127.0.0.1:${state.port}/health`,{responseType:'json',timeout:1200});
        if(response.response.app==='research-notebook'&&response.response.version>=17)return state;
      }catch(_){}return null;
    };
    let state=await check();if(state)return state;
    if(this.starting)return this.starting;
    this.starting=(async()=>{
      const file=Zotero.File.pathToFile(this.path('.runtime','python','pythonw.exe'));
      if(!file.exists())throw new Error('没有找到科研笔记仓库运行时，请检查 '+this.root);
      const process=Components.classes['@mozilla.org/process/util;1'].createInstance(Components.interfaces.nsIProcess);process.init(file);
      const args=[this.path('launcher.py'),'--service-only'];process.runwAsync(args,args.length,null,false);
      for(let i=0;i<60;i++){await Zotero.Promise.delay(200);const result=await check();if(result)return result;}
      throw new Error('本地笔记服务未能启动，请查看 '+this.path('.runtime','server.log'));
    })();
    try{return await this.starting;}finally{this.starting=null;}
  },
  async request(path,payload){
    const state=await this.ensureService();
    try{
      const xhr=await Zotero.HTTP.request(payload===undefined?'GET':'POST',`http://127.0.0.1:${state.port}${path}`,{responseType:'json',timeout:180000,headers:{Authorization:'Bearer '+state.key,'X-Notebook-Request':'1','Content-Type':'application/json'},...(payload===undefined?{}:{body:JSON.stringify(payload)})});
      return xhr.response;
    }catch(error){throw new Error(error.xmlhttp?.response?.error||error.message||'本地服务请求失败');}
  },
  activeReader(win){
    const selected=win?.Zotero_Tabs?.selectedID;
    const tabReader=selected?Zotero.Reader?.getByTabID?.(selected):null;
    if(tabReader)return tabReader;
    return (Zotero.Reader?._readers||[]).find(reader=>reader._window===win&&win!==Zotero.getMainWindow())||null;
  },
  async openActiveOrHome(win){
    const reader=this.activeReader(win);
    if(reader)return this.openSelected(win,reader);
    return this.openPage(undefined,win);
  },
  followReader(win,dock){
    let last=null,busy=false,run=0;
    const tick=async()=>{
      if(!this.active||win.closed||dock.panel.style.display==='none')return;
      const reader=this.activeReader(win),id=reader?.itemID;
      if(!id){last=null;run++;return;}
      if(id===last||busy)return;
      busy=true;const turn=++run;
      try{
        const item=await Zotero.Items.getAsync(id);
        if(item?.attachmentContentType!=='application/pdf')return;
        const file=await item.getFilePathAsync();if(!file||!await IOUtils.exists(file))return;
        const record=await this.registerSelected(win,reader);
        if(turn!==run||this.activeReader(win)?.itemID!==id||dock.panel.style.display==='none')return;
        await this.request('/api/dock/publish',{channel:dock.channel,event:{type:'paper',paper_id:record.id,intent:'follow_reader'}});
        dock.pid=record.id;last=id;
      }catch(error){Zotero.logError(error);}finally{busy=false;}
    };
    const timer=win.setInterval(tick,900);dock.cleanups.push(()=>{run++;win.clearInterval(timer);});
    tick();
  },
  async openPage(pid,host,preserveEditor=false){
    const state=await this.ensureService(),win=host||Zotero.getMainWindow();
    if(!win?.document)throw new Error('请先打开 Zotero 阅读窗口');
    let dock=this.docks.get(win);
    if(dock?.creating)dock=await dock.creating;
    if(!dock){
      const creating=(async()=>{
        const {channel}=await this.request('/api/dock/channel',{});
        if(!this.active||win.closed)throw new Error('科研笔记浮窗已关闭');
        const next=ResearchNotebookDock.create(this,win,channel);this.docks.set(win,next);
        const url=`http://127.0.0.1:${state.port}/?session=${encodeURIComponent(state.key)}&host=zotero&view=dock&channel=${channel}${pid?'&paper='+encodeURIComponent(pid):''}`;
        next.browser.loadURI(Services.io.newURI(url),{triggeringPrincipal:Services.scriptSecurityManager.getSystemPrincipal()});this.followReader(win,next);return next;
      })();this.docks.set(win,{creating});
      try{dock=await creating;}catch(error){this.docks.delete(win);throw error;}
    }
    dock.show();
    if(!pid)await this.request('/api/dock/publish',{channel:dock.channel,event:{type:'home'}});
    if(pid&&(!preserveEditor||!dock.pid)){await this.request('/api/dock/publish',{channel:dock.channel,event:{type:'paper',paper_id:pid}});dock.pid=pid;}
    await this.status({loaded:true,menuWindows:this.windows.size,readerHooks:true,lastOpenedPaper:pid||'home',floating:true});return dock;
  },
  async selectedAttachment(win,reader){
    let item=reader?Zotero.Items.get(reader.itemID):win.ZoteroPane.getSelectedItems()[0];
    if(!item)throw new Error('请先在 Zotero 中选中一篇文献或 PDF 附件');
    if(item.isAttachment()&&item.attachmentContentType==='application/pdf')return item;
    if(item.parentItemID)item=Zotero.Items.get(item.parentItemID);
    if(!item.isRegularItem())throw new Error('请选择文献条目或 PDF 附件');
    const attachment=await item.getBestAttachment();
    if(!attachment||attachment.attachmentContentType!=='application/pdf')throw new Error('这篇文献没有本地 PDF 附件，请先在 Zotero 中保存 PDF');
    return attachment;
  },
  async registerSelected(win,reader){
    let item=reader?Zotero.Items.get(reader.itemID):win.ZoteroPane.getSelectedItems()[0];
    if(!item)throw new Error('请先选择文献条目');
    let att=item.isAttachment?.()&&item.attachmentContentType==='application/pdf'?item:null;
    const parent=item.parentItemID?await Zotero.Items.getAsync(item.parentItemID):item;
    if(!att&&parent.isRegularItem?.()){const best=await parent.getBestAttachment();if(best?.attachmentContentType==='application/pdf')att=best;}
    if(!att&&!parent.isRegularItem?.())throw new Error('请选择文献或 PDF');
    const path=att?await att.getFilePathAsync():'';
    const field=name=>{try{return parent.getField(name)||'';}catch(_){return '';}};
    return this.request('/api/zotero/register',{library_id:parent.libraryID,item_key:parent.key,attachment_key:path?att.key:'',path:path||'',title:field('title'),doi:field('DOI'),year:field('date'),venue:field('publicationTitle'),url:field('url'),author:parent.getCreators().map(c=>c.lastName||c.name||'').filter(Boolean).join(', ')});
  },
  async openSelected(win,reader){
    const record=await this.registerSelected(win,reader);return this.openPage(record.id,reader?._window||win);
  },
  async addExcerpt(reader,annotation){
    const text=annotation?.text?.trim();if(!text)return;
    const win=reader?._window||Zotero.getMainWindow(),record=await this.registerSelected(win,reader),dock=await this.openPage(record.id,win,false);
    const att=Zotero.Items.get(reader.itemID),page=Number.isInteger(annotation.position?.pageIndex)?annotation.position.pageIndex+1:null;
    const path=Zotero.URI.getLibraryPath(att.libraryID),scope=path.startsWith('groups/')?path:'library';
    await this.request('/api/dock/publish',{channel:dock.channel,event:{type:'clip',paper_id:record.id,title:record.title,text,page,attachment_key:att.key,library_id:att.libraryID,source_uri:'zotero://open-pdf/'+scope+'/items/'+att.key+(page?'?page='+page:'')}});
  },
  async openVaultNote(noteId,host){
    const dock=await this.openPage(undefined,host);
    await this.request('/api/dock/publish',{channel:dock.channel,event:{type:'open_note',note_id:noteId}});
    return dock;
  },
  async noteExcerptMarkdown(record,reader,annotation,text,kind='translation'){
    let includeSource=false;try{includeSource=(await IOUtils.readJSON(this.path('.runtime','note-settings.json'))).include_source===true;}catch(_){}
    if(!includeSource)return '\n\n'+String(text).trim().split(/\r?\n/).map(line=>'> '+line).join('\n')+'\n';
    const att=Zotero.Items.get(reader.itemID),page=Number.isInteger(annotation?.position?.pageIndex)?annotation.position.pageIndex+1:null;
    const libraryPath=Zotero.URI.getLibraryPath(att.libraryID),scope=libraryPath.startsWith('groups/')?libraryPath:'library';
    const uri='zotero://open-pdf/'+scope+'/items/'+att.key+(page?'?page='+page:'');
    const title=(record.title||record.id).replace(/[\[\]]/g,'');
    const label=kind==='summary'?'选文总结':kind==='translation'?'译文':'原文摘录';
    const quote=String(text).trim().split(/\r?\n/).map(line=>'> '+line).join('\n');
    return '\n\n### '+label+(page?' · PDF 第 '+page+' 页':'')+'\n\n[来源：'+title+(page?' · PDF 第 '+page+' 页':'')+']('+uri+')\n\n'+quote+'\n';
  },
  async saveTextToTarget(reader,annotation,text,kind='translation'){
    if(typeof text!=='string'||!text.trim())throw new Error('没有可保存的内容');
    const target=Zotero.Prefs.get('extensions.researchnotebook.notes.defaultTarget',true)||'paper';
    if(target==='paper')return this.savePaperText(reader,annotation,text,kind);
    const win=reader?._window||Zotero.getMainWindow(),record=await this.registerSelected(win,reader);
    const addition=await this.noteExcerptMarkdown(record,reader,annotation,text,kind),noteId=Zotero.Prefs.get('extensions.researchnotebook.notes.defaultNoteId',true);
    if(target==='new'){
      const stamp=new Date().toISOString().slice(0,16).replace('T',' ');
      const note=await this.request('/api/notes',{title:'文献摘录 · '+record.id+' · '+stamp,folder:'文献笔记',tags:[record.id],content:addition.trim()});
      Zotero.Prefs.set('extensions.researchnotebook.notes.defaultNoteId',note.id,true);
      Zotero.Prefs.set('extensions.researchnotebook.notes.defaultTarget','existing',true);
      Zotero.Prefs.set('extensions.researchnotebook.notes.defaultNoteTitle',note.title,true);
      return {target:'new',note};
    }
    if(target!=='existing')throw new Error('默认保存位置无效，请重新选择');
    if(!/^[a-f0-9]{32}$/.test(noteId||''))throw new Error('请先搜索并选择一篇已有笔记');
    const dock=this.docks?.get(win);
    if(dock?.channel&&dock.browser?.isConnected!==false){
      const queued=await this.publishBackgroundExcerpt(dock,record,reader,annotation,text,kind,noteId);return {...queued,target:'existing',queued:true};
    }
    const current=await this.request('/api/notes/'+encodeURIComponent(noteId));
    if(current.trashed||current.folder==='调研报告')throw new Error('目标笔记已删除或属于报告，不能作为摘录目标');
    const updated=await this.request('/api/notes/'+encodeURIComponent(noteId),{version:current.version,content:(current.content||'').trimEnd()+addition,title:current.title,folder:current.folder,tags:current.tags||[]});
    return {target:'existing',note:updated};
  },
  async savePaperText(reader,annotation,text,kind='translation'){
    return this.addTranslatedExcerpt(reader,annotation,text,kind);
  },
  async publishBackgroundExcerpt(dock,record,reader,annotation,text,kind,noteId){
    const att=Zotero.Items.get(reader.itemID),page=Number.isInteger(annotation?.position?.pageIndex)?annotation.position.pageIndex+1:null;
    const path=Zotero.URI.getLibraryPath(att.libraryID),scope=path.startsWith('groups/')?path:'library';
    return this.request('/api/dock/publish',{channel:dock.channel,event:{type:'clip',background:true,paper_id:record.id,...(noteId?{note_id:noteId}:{}),title:record.title,text:text.trim(),page,attachment_key:att.key,library_id:att.libraryID,clip_kind:kind,autosave:true,source_uri:'zotero://open-pdf/'+scope+'/items/'+att.key+(page?'?page='+page:'')}});
  },
  async addTranslatedExcerpt(reader,annotation,text,kind='translation'){
    if(typeof text!=='string'||!text.trim()||text.length>12000)throw new Error('请先在译文中选中 1—12,000 字符');
    const win=reader?._window||Zotero.getMainWindow(),record=await this.registerSelected(win,reader),dock=this.docks?.get(win);
    // Existing editors merge their own drafts, but are never shown or focused.
    if(dock?.channel&&dock.browser?.isConnected!==false){const queued=await this.publishBackgroundExcerpt(dock,record,reader,annotation,text,kind);return {...queued,target:'paper',queued:true};}
    const doc=await this.request('/api/papers/'+record.id),addition=await this.noteExcerptMarkdown(record,reader,annotation,text,kind);
    await this.request('/api/papers/'+record.id+'/reading',{version:doc.reading.version,content:doc.reading.content.trimEnd()+addition});
    return {target:'paper',queued:false};
  },
  async openSelectionWorkspace(reader,annotation,intent='edit',selectionKind='original'){
    const win=reader?._window||Zotero.getMainWindow(),record=await this.registerSelected(win,reader),dock=await this.openPage(record.id,win,true),att=Zotero.Items.get(reader.itemID);
    const page=Number.isInteger(annotation?.position?.pageIndex)?annotation.position.pageIndex+1:null;
    const path=Zotero.URI.getLibraryPath(att.libraryID),scope=path.startsWith('groups/')?path:'library';
    await this.request('/api/dock/publish',{channel:dock.channel,event:{type:'context',intent,selection_kind:selectionKind,paper_id:record.id,title:record.title,text:annotation?.text?.trim()||'',page,attachment_key:att.key,library_id:att.libraryID,source_uri:'zotero://open-pdf/'+scope+'/items/'+att.key+(page?'?page='+page:'')}});
    return dock;
  },
  paperRating(item){
    const extra=item.getField('extra')||'',tags=item.getTags()||[],storage=Zotero.Prefs.get('extensions.zotero.zoterostyle.ratingColumn.storage',true)==='tag'?'tag':'extra';
    const legacy=tags.filter(({tag})=>/^⭐{1,5}$/u.test(tag)&&!Zotero.Tags.getColor(item.libraryID,tag));
    const match=extra.split(/\r?\n/).find(line=>line.startsWith('rate: ')),text=match?.slice(6).trim()||'',extraRating=/^[1-5]$/.test(text)?Number(text):0;
    const tagRating=legacy.length?Array.from(legacy[0].tag).length:0,rating=storage==='tag'&&tagRating?tagRating:extraRating||tagRating;
    return {rating,starred:rating>0,version:Zotero.Utilities.Internal.md5(JSON.stringify([extra,tags.map(t=>[t.tag,t.type||0]).sort(),storage]))};
  },
  async nativeAction(data){
    if(data.action==='current_reader'){
      const win=Zotero.getMainWindow(),tab=win?.Zotero_Tabs?.selectedID;
      let reader=tab?Zotero.Reader.getByTabID(tab):null;
      const active=Services.wm.getMostRecentWindow(null);
      const detached=(Zotero.Reader._readers||[]).find(r=>r._window===active&&r._window!==win);
      if(detached)reader=detached;
      if(!reader)return {ok:true,available:false,reason:'当前 Zotero 标签不是 PDF 阅读器'};
      const attachment=await Zotero.Items.getAsync(reader.itemID);
      if(attachment?.attachmentContentType!=='application/pdf')return {ok:true,available:false,reason:'当前阅读器不是 PDF'};
      const path=await attachment.getFilePathAsync();if(!path||!await IOUtils.exists(path))throw new Error('当前 Zotero PDF 附件的本地文件不可用');
      const record=await this.registerSelected(win,reader);
      const state=reader._internalReader?._state?.primaryViewState||reader._state?.primaryViewState;
      const index=state?.pageIndex??reader._internalReader?._primaryView?._pageIndex;
      return {ok:true,available:true,paper:record,attachment_key:attachment.key,page:Number.isInteger(index)?index+1:null};
    }
    if(data.action==='integration_capabilities')return {ok:true,version:this.version,...ResearchNotebookIntegrations.capabilities(),menus:[...this.windows.keys()].map(win=>({fetch:!!win.document.getElementById('rn-integration-fetch'),jasminum:!!win.document.getElementById('rn-integration-jasminum'),linter:!!win.document.getElementById('rn-integration-linter'),citation:!!win.document.getElementById('rn-integration-citation')}))};
    if(data.action==='integration_last_result')return ResearchNotebookIntegrations.lastResult||{ok:true,rows:[]};
    if(data.action==='literature_move_imports_to_storage')return ResearchNotebookLiterature.moveImportsToStorage();
    if(data.action==='literature_capabilities')return ResearchNotebookLiterature.capabilities();
    if(data.action==='literature_attach_uploaded_pdf')return ResearchNotebookLiterature.attachUploadedPDF(data,this.root);
    if(data.action==='literature_import')return ResearchNotebookLiterature.save(data,this.root);
    if(data.action==='literature_attach_supplements')return ResearchNotebookLiterature.attachSupplements(data,this.root);
    if(data.action==='layout_probe'){
      const win=Zotero.getMainWindow(),doc=win.document,pref='extensions.researchnotebook.layout.dock',previous=Zotero.Prefs.get(pref,true),native={x:win.screenX,y:win.screenY};let dock;
      try{dock=ResearchNotebookDock.create(this,win,'layout-probe');const panel=dock.panel,handle=panel.querySelector('header');const before=panel.getBoundingClientRect(),x=before.left+50,y=before.top+15;
        const mouse=(node,type,a,b)=>{const e=doc.createEvent('MouseEvent');e.initMouseEvent(type,true,true,win,0,0,0,a,b,false,false,false,false,0,null);node.dispatchEvent(e);return e.defaultPrevented;};
        const downPrevented=mouse(handle,'pointerdown',x,y);mouse(win,'pointermove',x-30,y+20);mouse(win,'pointerup',x-30,y+20);const after=panel.getBoundingClientRect();
        return {version:this.version,downPrevented,panelMoved:Math.abs(after.left-before.left)>5||Math.abs(after.top-before.top)>5,nativeWindowUnchanged:win.screenX===native.x&&win.screenY===native.y,noDrag:win.getComputedStyle(handle).getPropertyValue('-moz-window-dragging')};
      }finally{dock?.dispose();if(previous)Zotero.Prefs.set(pref,previous,true);else Zotero.Prefs.clear(pref,true);}
    }
    if(data.action==='translation_probe'){
      const reader=(Zotero.Reader._readers||[]).find(r=>r._internalReader?._primaryView?._iframeWindow);
      if(!reader)throw new Error('请先打开 PDF');
      const doc=reader._iframeWindow.document,host=doc.createElement('div');doc.body.append(host);
      const event={doc,reader,params:{annotation:{text:'A programmable metasurface controls electromagnetic waves.'}},append:node=>host.append(node)};
      const started=Date.now();let firstTextMs=null;
      try{
        this.selectionPopup(event);const state=this.selectionStates.get(reader),box=doc.querySelector('.rn-auto-translation'),output=box?.querySelector('textarea');
        const timer=Zotero.getMainWindow().setInterval(()=>{if(output?.value&&firstTextMs===null)firstTextMs=Date.now()-started;},20);
        try{await Promise.race([state.pending,new Promise((_,reject)=>Zotero.getMainWindow().setTimeout(()=>reject(new Error('probe timeout')),20000))]);}
        finally{Zotero.getMainWindow().clearInterval(timer);}
        const translated=!!output?.value,characters=output?.value?.length||0,completedMs=Date.now()-started;
        const originalAdd=this.saveTextToTarget;let captured=null,excerptEnabled=false;
        try{this.saveTextToTarget=async(_r,_a,value)=>{captured=value;return {target:'paper'};};output.setSelectionRange(0,2);const selected=doc.createEvent('Event');selected.initEvent('select',true,false);output.dispatchEvent(selected);const action=[...box.querySelectorAll('button')].find(b=>b.textContent==='摘录到笔记');excerptEnabled=!action.disabled;action.click();await new Promise(resolve=>Zotero.getMainWindow().setTimeout(resolve,40));}
        finally{this.saveTextToTarget=originalAdd;}
        const excerptSelectedOnly=captured===output.value.slice(0,2).trim();
        const originalOpen=this.openSelectionWorkspace;let assistantSelected=false,assistantOriginal=false;
        try{let context=null;this.openSelectionWorkspace=async(_reader,annotation,intent,kind)=>{context={text:annotation.text,intent,kind};};
          const assistant=box.querySelector('[aria-label="AI 助手"]');assistant.click();await new Promise(resolve=>Zotero.getMainWindow().setTimeout(resolve,40));assistantSelected=context?.intent==='assistant'&&context?.kind==='translation'&&context?.text===output.value.slice(0,2).trim();
          output.setSelectionRange(0,0);assistant.click();await new Promise(resolve=>Zotero.getMainWindow().setTimeout(resolve,40));assistantOriginal=context?.kind==='original'&&context?.text===event.params.annotation.text;
        }finally{this.openSelectionWorkspace=originalOpen;}


        output?.focus();host.remove();await new Promise(resolve=>Zotero.getMainWindow().setTimeout(resolve,40));
        const editableRetained=!!box?.isConnected;
        const pdfDoc=reader._internalReader._primaryView._iframeWindow.document;
        const outside=pdfDoc.createEvent('Event');outside.initEvent('pointerdown',true,false);pdfDoc.dispatchEvent(outside);
        await new Promise(resolve=>Zotero.getMainWindow().setTimeout(resolve,40));
        const outsideClosed=!box?.isConnected;state.dispose();
        doc.body.append(host);this.selectionPopup(event);const next=this.selectionStates.get(reader),nextBox=doc.querySelector('.rn-auto-translation');doc.activeElement?.blur?.();host.remove();
        await new Promise(resolve=>Zotero.getMainWindow().setTimeout(resolve,40));
        const selectionPopupClosed=!nextBox?.isConnected;next.dispose();
        return {version:this.version,translated,characters,firstTextMs,completedMs,editableRetained,outsideClosed,selectionPopupClosed,excerptEnabled,excerptSelectedOnly,assistantSelected,assistantOriginal,events:this.translationDiagnostics||[]};
      }finally{host.remove();this.selectionStates.get(reader)?.dispose?.();}
    }
    if(data.action==='translation_status'){
      let errors=[];try{errors=(Zotero.getErrors?.(true)||[]).map(String).filter(s=>/selectionLifetime|translation\.js|notebook\.js|MutationObserver|Illegal invocation|Permission denied/i.test(s)).slice(-6).map(s=>s.replace(/(https?:\/\/[^\s?]+)\?[^\s]*/g,'$1').slice(0,450));}catch(_){}
      return {version:this.version,panels:this.selectionPanels?.size||0,events:this.translationDiagnostics||[],errors,readers:(Zotero.Reader._readers||[]).map(r=>{const i=r._internalReader,v=i?._primaryView,w=v?._iframeWindow;return {id:r.itemID,internal:!!i,view:!!v,frame:!!w,selectionRanges:v?._selectionRanges?.length??null,popup:!!i?._state?.primaryViewSelectionPopup};})};
    }
    if(data.action==='ui_status')return this.uiStatus();
    if(data.action==='get_tags'&&data.rating_batch){
      if(!Array.isArray(data.rating_batch)||data.rating_batch.length>300)throw new Error('星标查询数量无效');
      const results=[];for(const ref of data.rating_batch){if(!Number.isInteger(ref.library_id)||ref.library_id<1||!/^[A-Z0-9]{8}$/.test(ref.item_key||'')||!/^([A-D]\d{1,2}|Z\d+_[A-Z0-9]{8})$/.test(ref.id||''))throw new Error('文献星标查询参数无效');
        const item=await Zotero.Items.getByLibraryAndKeyAsync(ref.library_id,ref.item_key);if(!item?.isRegularItem?.()||item.deleted){results.push({id:ref.id,available:false});continue;}results.push({id:ref.id,available:true,...this.paperRating(item)});
      }return {ok:true,ratings:results};
    }
    if(!Number.isInteger(data.library_id)||data.library_id<1)throw new Error('资料库信息不合法');
    let att,parent;
    if(/^[A-Z0-9]{8}$/.test(data.attachment_key||'')){
      att=await Zotero.Items.getByLibraryAndKeyAsync(data.library_id,data.attachment_key);
      if(!att?.isAttachment()||att.attachmentContentType!=='application/pdf')throw new Error('没有找到 PDF 附件');
      parent=att.parentItemID?await Zotero.Items.getAsync(att.parentItemID):null;
    }else if(/^[A-Z0-9]{8}$/.test(data.item_key||'')){
      parent=await Zotero.Items.getByLibraryAndKeyAsync(data.library_id,data.item_key);
      if(!parent?.isRegularItem()||parent.deleted)throw new Error('没有找到文献条目');att=parent;
    }else throw new Error('文献信息不合法');
    if(data.action==='get_tags'&&typeof data.rating_set==='boolean'){
      const item=parent||att;if(!item?.isRegularItem?.())throw new Error('星标需要关联 Zotero 文献条目');
      const before=this.paperRating(item);if(data.rating_version!==before.version)throw new Error('Zotero 星标已变化，请刷新后重试');
      if(data.rating_set===before.starred)return {ok:true,...before};
      await Zotero.DB.executeTransaction(async()=>{
        if(this.paperRating(item).version!==data.rating_version)throw new Error('Zotero 星标已变化，请刷新后重试');
        let extra=item.getField('extra')||'';const lines=extra.split(/\r?\n/),tags=item.getTags()||[];
        if(data.rating_set){
          if(lines.some(line=>line.startsWith('rate: ')))throw new Error('其他字段已有非标准 rate 值，未覆盖；请先在 Zotero Style 中检查评级');
          const storage=Zotero.Prefs.get('extensions.zotero.zoterostyle.ratingColumn.storage',true)==='tag'?'tag':'extra';
          if(storage==='tag'){if(Zotero.Tags.getColor(item.libraryID,'⭐'))throw new Error('⭐ 已用作彩色标签，请先在 Zotero Style 中设置评级');item.addTag('⭐');}
          else item.setField('extra',extra+(extra&&!extra.endsWith('\n')?'\n':'')+'rate: 1');
        }else{
          item.setField('extra',lines.filter(line=>!/^rate: [1-5]\s*$/.test(line)).join('\n'));
          for(const {tag} of tags)if(/^⭐{1,5}$/u.test(tag)&&!Zotero.Tags.getColor(item.libraryID,tag))item.removeTag(tag);
        }
        await item.save();
      });return {ok:true,...this.paperRating(item)};
    }
    if(['get_tags','add_paper_tags','remove_paper_tags'].includes(data.action)){
      const item=parent||att;
      const snapshot=()=>({tags:item.getTags().map(t=>t.tag).sort(),version:JSON.stringify(item.getTags().map(t=>[t.tag,t.type||0]).sort())});
      if(data.action==='get_tags')return snapshot();
      if(!Array.isArray(data.tags)||!data.tags.length||data.tags.length>30||data.tags.some(t=>typeof t!=='string'||!t.trim()||t.length>80))throw new Error('标签格式不正确');
      await Zotero.DB.executeTransaction(async()=>{if(data.version!==snapshot().version)throw new Error('论文标签已变化，请重新读取');for(const tag of data.tags){if(data.action==='add_paper_tags')item.addTag(tag.trim());else item.removeTag(tag.trim());}await item.save();});
      return {ok:true,...snapshot()};
    }
    if(data.action==='open_pdf'){
      if(!att?.isAttachment?.())throw new Error('本文献尚未取得 PDF，请先获取全文');
      if(data.page!=null&&(!Number.isInteger(data.page)||data.page<1))throw new Error('PDF 页码不合法');
      await Zotero.Reader.open(att.id,data.page?{pageIndex:data.page-1}:undefined);return {ok:true};
    }
    if(data.action==='list_notes'){
      const notes=[];for(const id of (parent?.getNotes()||[]).slice(0,100)){const note=await Zotero.Items.getAsync(id);if(note&&!note.deleted)notes.push({key:note.key,title:note.getField('title'),html:note.getNote()});}return {notes};
    }
    if(data.action==='save_note'){
      if(typeof data.html!=='string'||!data.html.trim()||data.html.length>6_000_000)throw new Error('笔记内容不合法');
      const pref='extensions.researchnotebook.paperNote.'+att.libraryID+'.'+(parent?.key||att.key),key=Zotero.Prefs.get(pref,true);let note=key?await Zotero.Items.getByLibraryAndKeyAsync(att.libraryID,key):null;
      if(note&&(!note.isNote()||(note.parentItemID||null)!==(parent?.id||null)||note.deleted))note=null;
      const before=note?Zotero.Utilities.Internal.md5(note.getNote()):null,last=Zotero.Prefs.get(pref+'.hash',true);
      if(note&&last&&before!==last)throw new Error('Zotero 中的本文献笔记已被编辑，请先载入对照后再导出，原内容未覆盖');
      if(!note){note=new Zotero.Item('note');note.libraryID=att.libraryID;if(parent)note.parentID=parent.id;}
      note.setNote('<div data-schema-version="9">'+data.html+'</div>');await note.saveTx();Zotero.Prefs.set(pref,note.key,true);Zotero.Prefs.set(pref+'.hash',Zotero.Utilities.Internal.md5(note.getNote()),true);return {ok:true,key:note.key,updated:!!before};
    }
    throw new Error('未知的 Zotero 操作');
  },
  uiStatus(){
    const inspect=node=>{if(!node)return null;const r=node.getBoundingClientRect(),s=node.ownerDocument.defaultView.getComputedStyle(node);return {width:Math.round(r.width),height:Math.round(r.height),left:Math.round(r.left),top:Math.round(r.top),display:s.display,visibility:s.visibility,hidden:node.hidden===true};};
    return {version:this.version,windows:Zotero.getMainWindows().map(win=>{const d=win.document,dock=this.docks.get(win),browser=dock?.browser;let uri='';try{uri=browser?.browsingContext?.currentWindowGlobal?.documentURI?.spec||browser?.currentURI?.spec||'';}catch(_){}return {title:d.title,width:win.innerWidth,height:win.innerHeight,toolbar:inspect(d.getElementById('zotero-items-toolbar')),launch:inspect(d.getElementById('research-notebook-launch')),globalLaunch:inspect(d.getElementById('research-notebook-global-launch')),panel:inspect(dock?.panel),browser:inspect(browser),page:uri.split('?')[0],ready:browser?.contentDocument?.readyState||null};})};
  },
  async sync(win){const data=await this.request('/api/zotero/sync',{}),extra=data.supplements||{},local=data.local_pdfs||{},removed=(extra.local_copies_removed||0)+(local.local_copies_removed||0)+(data.local_duplicate_pdfs_removed||0),left=[...(extra.left_in_project||[]),...(local.left_in_project||[])];Services.prompt.alert(win,'科研笔记仓库',`新增关联 ${data.linked.length} 篇文献。\nPDF 入库：${(extra.imported||0)+(local.imported||0)} 份新增，${(extra.reused||0)+(local.reused||0)} 份复用。\n已清理 ${removed} 份校验相同的仓库副本；未处理 ${left.length} 份（会保留原文件）。`);},
  readerToolbar(event){const button=event.doc.createElement('button');button.textContent='科研精读';button.title='使用当前 Zotero PDF 进入科研笔记仓库';button.addEventListener('click',()=>this.openSelected(Zotero.getMainWindow(),event.reader).catch(error=>this.error(error)));const home=event.doc.createElement('button');home.textContent='仓库';home.title='直接查看笔记和报告';home.addEventListener('click',()=>this.openPage().catch(error=>this.error(error)));event.append(button);event.append(home);},
  selectionPopup(event){
    const {doc,params,reader}=event,text=params.annotation?.text?.trim();if(!text){const state=this.selectionStates.get(reader);if(state?.selectionCancelled){state.selectionCancelled();return;}if(state?.box?.matches?.(':hover'))return;state?.dispose?.();return;}if(doc.activeElement?.closest?.('.rn-auto-translation'))return;
    const previous=this.selectionStates.get(reader),sourcePage=params.annotation?.position?.pageIndex;
    if(previous?.sourceText===text&&previous.sourcePage===sourcePage&&previous.box?.isConnected)return;
    this.selectionStates.get(reader)?.dispose?.();
    const state={run:0,timer:null,sourceText:text,sourcePage};this.selectionStates.set(reader,state);
    const box=doc.createElement('section');box.className='rn-auto-translation';box.setAttribute('aria-label','选文翻译与总结');box.style.cssText='position:fixed;z-index:2147482000;top:22px;right:22px;height:340px;min-width:180px;min-height:220px;max-height:calc(100vh - 16px);white-space:normal;overflow:hidden;box-sizing:border-box;display:flex;flex-direction:column;border:1px solid #bed4c9;border-radius:12px;background:#fff;color:#24493e;box-shadow:0 14px 60px #143b3b35;font:13px system-ui;';
    state.box=box;
    const style=doc.createElement('style');style.textContent='.rn-auto-translation,.rn-auto-translation *{box-sizing:border-box}.rn-auto-translation .rn-actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 12px;font-size:12px;flex:none;border-top:1px solid #e0ebe5}.rn-auto-translation button,.rn-auto-translation select{font:inherit;border:0;background:transparent;color:inherit;cursor:pointer;padding:5px 7px;border-radius:5px}.rn-auto-translation button:hover{background:#e8f1eb}.rn-auto-translation .rn-edit-note{background:#237563;color:white}.rn-auto-translation textarea{user-select:text!important;-moz-user-select:text!important;cursor:text!important;}.rn-auto-translation button:disabled{opacity:.45}';
    const header=doc.createElement('header');header.style.cssText='display:flex;gap:6px;align-items:center;flex:none;background:#eff5f1;padding:8px 12px;';
    const title=doc.createElement('strong');title.textContent='选文翻译';title.style.cssText='font-size:12px;flex:1;';
    const output=doc.createElement('textarea');output.setAttribute('aria-label','译文，可直接编辑或复制');output.spellcheck=false;output.placeholder='正在翻译…';output.style.cssText='display:block;width:100%;flex:1;min-height:70px;white-space:pre-wrap;overflow:auto;line-height:1.85;font:15px/1.85 system-ui;padding:12px 16px;border:0;outline:0;resize:none;background:transparent;color:inherit;';
    const actions=doc.createElement('div');actions.className='rn-actions';
    const target=doc.createElement('select');target.setAttribute('aria-label','翻译目标语言');for(const name of ['简体中文','English']){const option=doc.createElement('option');option.value=name;option.textContent=name==='简体中文'?'中文':name;target.append(option);}
    const summary=doc.createElement('button');summary.textContent='总结';summary.title='总结当前选中的原文';
    const assistant=doc.createElement('button');assistant.textContent='✧';assistant.title='带着当前选文打开 AI 助手';assistant.setAttribute('aria-label','AI 助手');
    assistant.addEventListener('click',async()=>{const selected=ResearchNotebookTranslation.selectedText(output);const kind=selected?(mode==='summary'?'summary':'translation'):'original';assistant.disabled=true;try{await this.openSelectionWorkspace(reader,{...params.annotation,text:selected||text},'assistant',kind);}catch(error){hint.textContent=error.message;}finally{assistant.disabled=false;}});
    const translate=doc.createElement('button');translate.textContent='翻译';
    const excerpt=doc.createElement('button');excerpt.textContent='摘录到笔记';excerpt.disabled=true;
    const destinationPanel=doc.createElement('section');destinationPanel.className='rn-note-destination';destinationPanel.hidden=true;
    const destinationRow=doc.createElement('div');destinationRow.style.cssText='display:flex;align-items:center;gap:8px;padding:5px 12px 2px;flex:none;';
    const destinationLabel=doc.createElement('small');destinationLabel.textContent='默认保存到';destinationLabel.style.cssText='font-size:10px;opacity:.7;white-space:nowrap;';
    const destination=doc.createElement('select');destination.setAttribute('aria-label','默认笔记保存位置');destination.style.cssText='min-width:0;flex:1;border:1px solid #dce9e1;border-radius:5px;padding:5px 7px;background:#fff;font:11px system-ui;color:inherit;';
    for(const [value,label] of [['paper','本文默认笔记'],['existing','其他已有笔记'],['new','新建笔记（保存后记住）']]){const option=doc.createElement('option');option.value=value;option.textContent=label;destination.append(option);}
    destination.value=Zotero.Prefs.get('extensions.researchnotebook.notes.defaultTarget',true)||'paper';
    if(!['paper','new','existing'].includes(destination.value))destination.value='paper';
    const notePicker=doc.createElement('div');notePicker.style.cssText='display:flex;gap:6px;padding:3px 12px 5px;flex:none;';notePicker.hidden=destination.value!=='existing';
    notePicker.style.display=notePicker.hidden?'none':'flex';
    const noteSearch=doc.createElement('input');noteSearch.type='search';noteSearch.placeholder='输入关键词搜索已有笔记';noteSearch.setAttribute('aria-label','搜索已有笔记');noteSearch.style.cssText='min-width:0;flex:1;border:1px solid #dce9e1;border-radius:5px;padding:5px 7px;font:11px system-ui;color:inherit;';
    const noteChoices=doc.createElement('select');noteChoices.size=3;noteChoices.setAttribute('aria-label','选择已有笔记');noteChoices.style.cssText='min-width:0;flex:1;max-width:55%;border:1px solid #dce9e1;border-radius:5px;padding:3px;background:#fff;font:10px system-ui;color:inherit;';
    let noteSearchRun=0,noteSearchTimer=null;
    const savedNoteId=Zotero.Prefs.get('extensions.researchnotebook.notes.defaultNoteId',true);
    const addNoteOption=(note,select=false)=>{const option=doc.createElement('option');option.value=note.id;option.textContent=(note.title||'未命名笔记')+' · '+(note.folder||'笔记');noteChoices.append(option);if(select)noteChoices.value=note.id;};
    const searchExistingNotes=async query=>{const run=++noteSearchRun,selected=Zotero.Prefs.get('extensions.researchnotebook.notes.defaultNoteId',true);try{const data=await this.request('/api/notes?q='+encodeURIComponent(query));if(run!==noteSearchRun)return;noteChoices.replaceChildren();const placeholder=doc.createElement('option');placeholder.value='';placeholder.textContent='请选择已有笔记';noteChoices.append(placeholder);for(const note of data.notes||[])if(note.folder!=='调研报告'&&!note.trashed)addNoteOption(note,note.id===selected);if(noteChoices.options.length===1)placeholder.textContent='没有匹配笔记，可改选新建笔记';}catch(error){if(run===noteSearchRun)hint.textContent=error.message;}};
    destination.addEventListener('change',()=>{Zotero.Prefs.set('extensions.researchnotebook.notes.defaultTarget',destination.value,true);notePicker.hidden=destination.value!=='existing';notePicker.style.display=notePicker.hidden?'none':'flex';if(destination.value==='existing'){noteSearch.value='';searchExistingNotes('');hint.textContent=savedNoteId?'已载入上次选择的笔记':'搜索或从列表选择已有笔记';}else hint.textContent='默认保存位置已更新';});
    noteSearch.addEventListener('input',()=>{clearTimeout(noteSearchTimer);noteSearchTimer=setTimeout(()=>searchExistingNotes(noteSearch.value),220);});
    noteChoices.addEventListener('change',()=>{if(noteChoices.value){Zotero.Prefs.set('extensions.researchnotebook.notes.defaultNoteId',noteChoices.value,true);Zotero.Prefs.set('extensions.researchnotebook.notes.defaultNoteTitle',noteChoices.selectedOptions[0]?.textContent||'',true);updateExcerpt();}});
    const hint=doc.createElement('small');hint.textContent='Ctrl+C 复制 · 右键“摘录到笔记”设置保存位置';hint.style.cssText='padding:0 16px 6px;opacity:.68;flex:none;font-size:10px;';
    const edit=doc.createElement('button');edit.textContent='打开笔记';edit.className='rn-edit-note';
    edit.addEventListener('click',async()=>{try{const mode=Zotero.Prefs.get('extensions.researchnotebook.notes.defaultTarget',true)||'paper',id=Zotero.Prefs.get('extensions.researchnotebook.notes.defaultNoteId',true);if(mode==='existing'&&/^[a-f0-9]{32}$/.test(id||''))await this.openVaultNote(id,reader?._window||Zotero.getMainWindow());else await this.openSelectionWorkspace(reader,params.annotation,'edit');}catch(error){hint.textContent=error.message;}});
    const doneDestination=doc.createElement('button');doneDestination.textContent='完成';doneDestination.addEventListener('click',()=>{destinationPanel.hidden=true;updateExcerpt();});
    const toggleDestination=event=>{event.preventDefault();event.stopPropagation();destinationPanel.hidden=!destinationPanel.hidden;if(!destinationPanel.hidden){destination.value=Zotero.Prefs.get('extensions.researchnotebook.notes.defaultTarget',true)||'paper';notePicker.hidden=destination.value!=='existing';notePicker.style.display=notePicker.hidden?'none':'flex';if(destination.value==='existing')searchExistingNotes(noteSearch.value);}ResearchNotebookTranslation.fit(box,output,text,output.value,doc.defaultView);};
    excerpt.addEventListener('contextmenu',toggleDestination);
    excerpt.addEventListener('keydown',event=>{if(event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10'))toggleDestination(event);});
    const close=doc.createElement('button');close.textContent='×';close.title='关闭译文';close.setAttribute('aria-label','关闭译文');close.style.marginLeft='auto';
    let translated='',mode='translate',savingExcerpt=false;
    const schedule=(next=mode)=>{
      mode=next;state.manualEdit=false;excerpt.disabled=true;state.subscription?.cancel();const run=++state.run;translated='';output.value='';output.placeholder=mode==='summary'?'正在总结…':'正在翻译…';title.textContent=mode==='summary'?'选文总结':'选文翻译';hint.textContent='Ctrl+C 复制 · 右键“摘录到笔记”设置保存位置';
      state.pending=(async()=>{
        if(!this.active||state.run!==run)return;
        try{
          if(text.length>12000)throw new Error('选文过长，请分段选择');
          state.subscription=ResearchNotebookTranslation.subscribe(this,text,target.value,partial=>{if(this.active&&state.run===run&&box.isConnected!==false){translated=partial;if(!ResearchNotebookTranslation.selectedText(output))output.value=partial;updateExcerpt();}},mode);
          const result=await state.subscription.promise;
          if(!this.active||state.run!==run||box.isConnected===false)return;
          if(result.truncated)throw new Error('译文未完整返回，请缩短选文后重试');
          translated=result.text;if(!ResearchNotebookTranslation.selectedText(output))output.value=translated;updateExcerpt();
        }catch(error){if(this.active&&state.run===run){hint.textContent=error.message;output.placeholder='可重新点击翻译或总结';}}
      })();
    };
    target.addEventListener('change',()=>schedule('translate'));summary.addEventListener('click',()=>schedule('summary'));translate.addEventListener('click',()=>schedule('translate'));
    output.addEventListener('beforeinput',()=>{state.manualEdit=true;state.run++;state.subscription?.cancel();hint.textContent='手动编辑中 · 已停止自动覆盖';});
    output.addEventListener('input',()=>{translated=output.value;});
    const updateExcerpt=()=>{const selected=ResearchNotebookTranslation.selectedText(output);if(!selected&&!state.manualEdit&&translated&&output.value!==translated)output.value=translated;excerpt.disabled=savingExcerpt||!selected.trim();const mode=Zotero.Prefs.get('extensions.researchnotebook.notes.defaultTarget',true)||'paper',where=mode==='paper'?'本文默认笔记':mode==='new'?'新建笔记':Zotero.Prefs.get('extensions.researchnotebook.notes.defaultNoteTitle',true)||'所选笔记';excerpt.title=(selected?'摘录选中的 '+selected.length+' 字':'请先选中要摘录的文字')+' → '+where+'；右键设置保存位置';};
    for(const type of ['select','selectionchange','mouseup','keyup','input'])output.addEventListener(type,updateExcerpt);
    excerpt.addEventListener('click',async()=>{const content=ResearchNotebookTranslation.selectedText(output).trim();if(!content||savingExcerpt)return;savingExcerpt=true;updateExcerpt();try{const saved=await this.saveTextToTarget(reader,params.annotation,content,mode==='summary'?'summary':'translation');hint.textContent=saved.queued?'摘录已提交，正在后台保存':saved.target==='paper'?'已保存到本文默认笔记':saved.target==='new'?'已新建笔记，后续摘录将继续追加':'已追加到所选笔记';destination.value=Zotero.Prefs.get('extensions.researchnotebook.notes.defaultTarget',true)||'paper';}catch(error){hint.textContent=error.message;}finally{savingExcerpt=false;updateExcerpt();}});
    header.append(title,translate,summary,assistant,target,close);actions.append(edit,excerpt);destinationPanel.append(destinationRow,notePicker,doneDestination);box.append(style,header,output,destinationPanel,hint,actions);destinationRow.append(destinationLabel,destination);notePicker.append(noteSearch,noteChoices);(doc.body||doc.documentElement).append(box);
    ResearchNotebookTranslation.fit(box,output,text,'',doc.defaultView);
    const layout=ResearchNotebookTranslation.floating(box,header,doc.defaultView,'translation',300,190);
    for(const type of ['pointerdown','mousedown','mouseup','click','dblclick','keydown','keyup'])box.addEventListener(type,e=>e.stopPropagation());
    let stopLifetime=null,disposed=false;
    state.dispose=()=>{if(disposed)return;disposed=true;state.run++;state.subscription?.cancel();stopLifetime?.();layout.dispose();box.remove();this.selectionPanels.delete(state);doc.defaultView.removeEventListener('unload',state.dispose);};
    this.selectionPanels.add(state);doc.defaultView.addEventListener('unload',state.dispose,{once:true});close.addEventListener('click',state.dispose);
    // Translation must start even if optional lifecycle observation is unavailable.
    schedule();
    try{stopLifetime=ResearchNotebookTranslation.selectionLifetime(event,box,state.dispose);state.selectionCancelled=()=>stopLifetime?.selectionCancelled?.();}catch(error){
      this.translationDiagnostics=(this.translationDiagnostics||[]).slice(-9);this.translationDiagnostics.push({stage:'lifecycle',error:String(error).slice(0,200)});Zotero.logError(error);
    }
  }
};



