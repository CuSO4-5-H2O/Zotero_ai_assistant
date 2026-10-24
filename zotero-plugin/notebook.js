'use strict';
var ResearchNotebookPlugin={
  id:'research-notebook@local.research', bundleRoot:null, windows:new Map(), docks:new Map(), starting:null,
  get root(){return Zotero.Prefs.get('extensions.researchnotebook.root',true)||this.bundleRoot||PathUtils.join(PathUtils.homeDir,'Zotero_ai_assistant');},
  path(...parts){return PathUtils.join(this.root,...parts);},
  async status(data){
    await IOUtils.writeJSON(this.path('.runtime','zotero-plugin-status.json'),{plugin:this.id,version:this.version||'1.6.0',zoteroVersion:Zotero.version,time:new Date().toISOString(),...data});
  },
  async start(data){
    this.version=data.version||'1.6.0';
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
    launch.addEventListener('click',()=>this.openPage(undefined,win).catch(error=>this.error(error,win)));
    const toolbar=doc.getElementById('zotero-items-toolbar')||doc.getElementById('zotero-toolbar');
    if(toolbar)toolbar.append(launch);else{launch.style.cssText+='position:fixed;bottom:12px;right:18px;z-index:2147482000;';doc.documentElement.append(launch);}nodes.push(launch);
    // The library toolbar belongs to an inactive deck while a PDF tab is selected.
    // Keep a separate launcher outside that deck, above both library and reader.
    const global=doc.createElementNS('http://www.w3.org/1999/xhtml','button');global.id='research-notebook-global-launch';global.textContent='科研仓库';global.title='打开仓库首页 · Ctrl + Alt + N';global.setAttribute('aria-label','打开科研仓库');global.style.cssText='position:fixed!important;right:24px!important;bottom:18px!important;top:auto!important;left:auto!important;z-index:2147483500!important;display:block!important;visibility:visible!important;box-sizing:border-box;margin:0;padding:9px 16px;border:1px solid #bdd5c8;border-radius:18px;background:#216b55;color:#fff;box-shadow:0 3px 15px #143c3533;font:600 12px system-ui;cursor:pointer;';global.addEventListener('click',()=>this.openPage(undefined,win).catch(error=>this.error(error,win)));doc.documentElement.append(global);nodes.push(global);
    const shortcut=e=>{if(e.ctrlKey&&e.altKey&&e.key.toLowerCase()==='n'){e.preventDefault();this.openPage(undefined,win).catch(error=>this.error(error,win));}};win.addEventListener('keydown',shortcut);nodes.push(()=>win.removeEventListener('keydown',shortcut));
    const action=(label,handler,id)=>{const item=doc.createXULElement('menuitem');item.id=id;item.setAttribute('label',label);item.addEventListener('command',()=>Promise.resolve(handler()).catch(error=>this.error(error,win)));return item;};
    const tools=doc.getElementById('menu_ToolsPopup');
    if(tools){
      const menu=doc.createXULElement('menu');menu.id='research-notebook-tools';menu.setAttribute('label','科研笔记仓库');
      const popup=doc.createXULElement('menupopup');
      popup.append(action('打开科研笔记仓库',()=>this.openPage(),'rn-open-vault'),action('精读当前选中文献',()=>this.openSelected(win),'rn-read-selected'),action('关联已收录文献与 Zotero PDF',()=>this.sync(win),'rn-sync-storage'));
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
        if(response.response.app==='research-notebook'&&response.response.version>=14)return state;
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
        next.browser.loadURI(Services.io.newURI(url),{triggeringPrincipal:Services.scriptSecurityManager.getSystemPrincipal()});return next;
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
    const att=await this.selectedAttachment(win,reader),path=await att.getFilePathAsync();
    if(!path)throw new Error('附件尚未下载，请先在 Zotero 中打开 PDF');
    const parent=att.parentItemID?Zotero.Items.get(att.parentItemID):att;
    const field=name=>{try{return parent.getField(name)||'';}catch(_){return '';}};
    const record=await this.request('/api/zotero/register',{library_id:att.libraryID,item_key:parent.key,attachment_key:att.key,path,title:field('title'),doi:field('DOI'),year:field('date'),venue:field('publicationTitle'),url:field('url'),author:parent.getCreators().map(c=>c.lastName||c.name||'').filter(Boolean).join(', ')});
    return record;
  },
  async openSelected(win,reader){
    const record=await this.registerSelected(win,reader);return this.openPage(record.id,reader?._window||win);
  },
  async addExcerpt(reader,annotation){
    const text=annotation?.text?.trim();if(!text)return;
    const win=reader?._window||Zotero.getMainWindow(),record=await this.registerSelected(win,reader),dock=await this.openPage(record.id,win,true);
    const att=Zotero.Items.get(reader.itemID),page=Number.isInteger(annotation.position?.pageIndex)?annotation.position.pageIndex+1:null;
    const path=Zotero.URI.getLibraryPath(att.libraryID),scope=path.startsWith('groups/')?path:'library';
    await this.request('/api/dock/publish',{channel:dock.channel,event:{type:'clip',paper_id:record.id,title:record.title,text,page,attachment_key:att.key,library_id:att.libraryID,source_uri:'zotero://open-pdf/'+scope+'/items/'+att.key+(page?'?page='+page:'')}});
  },
  async addTranslatedExcerpt(reader,annotation,text,kind='translation'){
    if(typeof text!=='string'||!text.trim()||text.length>12000)throw new Error('请先在译文中选中 1—12,000 字符');
    const win=reader?._window||Zotero.getMainWindow(),record=await this.registerSelected(win,reader),dock=await this.openPage(record.id,win,true),att=Zotero.Items.get(reader.itemID);
    const page=Number.isInteger(annotation?.position?.pageIndex)?annotation.position.pageIndex+1:null;
    const path=Zotero.URI.getLibraryPath(att.libraryID),scope=path.startsWith('groups/')?path:'library';
    return this.request('/api/dock/publish',{channel:dock.channel,event:{type:'clip',paper_id:record.id,title:record.title,text:text.trim(),page,attachment_key:att.key,library_id:att.libraryID,clip_kind:kind,autosave:true,source_uri:'zotero://open-pdf/'+scope+'/items/'+att.key+(page?'?page='+page:'')}});
  },
  async openSelectionWorkspace(reader,annotation,intent='edit',selectionKind='original'){
    const win=reader?._window||Zotero.getMainWindow(),record=await this.registerSelected(win,reader),dock=await this.openPage(record.id,win,true),att=Zotero.Items.get(reader.itemID);
    const page=Number.isInteger(annotation?.position?.pageIndex)?annotation.position.pageIndex+1:null;
    const path=Zotero.URI.getLibraryPath(att.libraryID),scope=path.startsWith('groups/')?path:'library';
    await this.request('/api/dock/publish',{channel:dock.channel,event:{type:'context',intent,selection_kind:selectionKind,paper_id:record.id,title:record.title,text:annotation?.text?.trim()||'',page,attachment_key:att.key,library_id:att.libraryID,source_uri:'zotero://open-pdf/'+scope+'/items/'+att.key+(page?'?page='+page:'')}});
    return dock;
  },
  async nativeAction(data){
    if(data.action==='ui_status')return this.uiStatus();
    if(!/^[A-Z0-9]{8}$/.test(data.attachment_key||'')||!Number.isInteger(data.library_id)||data.library_id<1)throw new Error('附件信息不合法');
    const att=await Zotero.Items.getByLibraryAndKeyAsync(data.library_id,data.attachment_key);
    if(!att?.isAttachment()||att.attachmentContentType!=='application/pdf')throw new Error('没有找到 PDF 附件');
    const parent=att.parentItemID?await Zotero.Items.getAsync(att.parentItemID):null;
    if(['get_tags','add_paper_tags','remove_paper_tags'].includes(data.action)){
      const item=parent||att;
      const snapshot=()=>({tags:item.getTags().map(t=>t.tag).sort(),version:JSON.stringify(item.getTags().map(t=>[t.tag,t.type||0]).sort())});
      if(data.action==='get_tags')return snapshot();
      if(!Array.isArray(data.tags)||!data.tags.length||data.tags.length>30||data.tags.some(t=>typeof t!=='string'||!t.trim()||t.length>80))throw new Error('标签格式不正确');
      await Zotero.DB.executeTransaction(async()=>{if(data.version!==snapshot().version)throw new Error('论文标签已变化，请重新读取');for(const tag of data.tags){if(data.action==='add_paper_tags')item.addTag(tag.trim());else item.removeTag(tag.trim());}await item.save();});
      return {ok:true,...snapshot()};
    }
    if(data.action==='open_pdf'){
      if(data.page!=null&&(!Number.isInteger(data.page)||data.page<1))throw new Error('PDF 页码不合法');
      await Zotero.Reader.open(att.id,data.page?{pageIndex:data.page-1}:undefined);return {ok:true};
    }
    if(data.action==='list_notes'){
      const notes=[];for(const id of (parent?.getNotes()||[]).slice(0,100)){const note=await Zotero.Items.getAsync(id);if(note&&!note.deleted)notes.push({key:note.key,title:note.getField('title'),html:note.getNote()});}return {notes};
    }
    if(data.action==='save_note'){
      if(typeof data.html!=='string'||!data.html.trim()||data.html.length>6_000_000)throw new Error('笔记内容不合法');
      const note=new Zotero.Item('note');note.libraryID=att.libraryID;if(parent)note.parentID=parent.id;
      note.setNote('<div data-schema-version="9">'+data.html+'</div>');await note.saveTx();return {ok:true,key:note.key};
    }
    throw new Error('未知的 Zotero 操作');
  },
  uiStatus(){
    const inspect=node=>{if(!node)return null;const r=node.getBoundingClientRect(),s=node.ownerDocument.defaultView.getComputedStyle(node);return {width:Math.round(r.width),height:Math.round(r.height),left:Math.round(r.left),top:Math.round(r.top),display:s.display,visibility:s.visibility,hidden:node.hidden===true};};
    return {version:this.version,windows:Zotero.getMainWindows().map(win=>{const d=win.document,dock=this.docks.get(win),browser=dock?.browser;let uri='';try{uri=browser?.browsingContext?.currentWindowGlobal?.documentURI?.spec||browser?.currentURI?.spec||'';}catch(_){}return {title:d.title,width:win.innerWidth,height:win.innerHeight,toolbar:inspect(d.getElementById('zotero-items-toolbar')),launch:inspect(d.getElementById('research-notebook-launch')),globalLaunch:inspect(d.getElementById('research-notebook-global-launch')),panel:inspect(dock?.panel),browser:inspect(browser),page:uri.split('?')[0],ready:browser?.contentDocument?.readyState||null};})};
  },
  async sync(win){const data=await this.request('/api/zotero/sync',{});Services.prompt.alert(win,'科研笔记仓库',`本次关联 ${data.linked.length} 篇报告文献。\nPDF 直接读取 Zotero storage，未复制或移动原附件。`);},
  readerToolbar(event){const button=event.doc.createElement('button');button.textContent='科研精读';button.title='使用当前 Zotero PDF 进入科研笔记仓库';button.addEventListener('click',()=>this.openSelected(Zotero.getMainWindow(),event.reader).catch(error=>this.error(error)));const home=event.doc.createElement('button');home.textContent='仓库';home.title='直接查看笔记和报告';home.addEventListener('click',()=>this.openPage().catch(error=>this.error(error)));event.append(button);event.append(home);},
  selectionPopup(event){
    const {doc,params,reader}=event,text=params.annotation?.text?.trim();if(doc.activeElement?.closest?.('.rn-auto-translation'))return;if(!text){this.selectionStates.get(reader)?.dispose?.();return;}
    this.selectionStates.get(reader)?.dispose?.();
    const state={run:0,timer:null};this.selectionStates.set(reader,state);
    const box=doc.createElement('section');box.className='rn-auto-translation';box.setAttribute('aria-label','选文翻译与总结');box.style.cssText='position:fixed;z-index:2147482000;top:22px;right:22px;height:300px;min-width:180px;min-height:190px;max-height:calc(100vh - 16px);white-space:normal;overflow:hidden;box-sizing:border-box;display:flex;flex-direction:column;border:1px solid #bed4c9;border-radius:12px;background:#fff;color:#24493e;box-shadow:0 14px 60px #143b3b35;font:13px system-ui;';
    const style=doc.createElement('style');style.textContent='.rn-auto-translation,.rn-auto-translation *{box-sizing:border-box}.rn-auto-translation .rn-actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 12px;font-size:12px;flex:none;border-top:1px solid #e0ebe5}.rn-auto-translation button,.rn-auto-translation select{font:inherit;border:0;background:transparent;color:inherit;cursor:pointer;padding:5px 7px;border-radius:5px}.rn-auto-translation button:hover{background:#e8f1eb}.rn-auto-translation .rn-edit-note{background:#237563;color:white}.rn-auto-translation textarea{user-select:text!important;-moz-user-select:text!important;cursor:text!important;}.rn-auto-translation button:disabled{opacity:.45}';
    const header=doc.createElement('header');header.style.cssText='display:flex;gap:6px;align-items:center;flex:none;background:#eff5f1;padding:8px 12px;';
    const title=doc.createElement('strong');title.textContent='选文翻译';title.style.cssText='font-size:12px;flex:1;';
    const output=doc.createElement('textarea');output.setAttribute('aria-label','译文，可直接编辑或复制');output.spellcheck=false;output.placeholder='正在翻译…';output.style.cssText='display:block;width:100%;flex:1;min-height:70px;white-space:pre-wrap;overflow:auto;line-height:1.85;font:15px/1.85 system-ui;padding:12px 16px;border:0;outline:0;resize:none;background:transparent;color:inherit;';
    const actions=doc.createElement('div');actions.className='rn-actions';
    const target=doc.createElement('select');target.setAttribute('aria-label','翻译目标语言');for(const name of ['简体中文','English']){const option=doc.createElement('option');option.value=name;option.textContent=name==='简体中文'?'中文':name;target.append(option);}
    const copy=doc.createElement('button');copy.textContent='复制';copy.disabled=true;
    const summary=doc.createElement('button');summary.textContent='总结';summary.title='总结当前选中的原文';
    const assistant=doc.createElement('button');assistant.textContent='✧';assistant.title='带着当前选文打开 AI 助手';assistant.setAttribute('aria-label','AI 助手');
    assistant.addEventListener('click',async()=>{const selected=ResearchNotebookTranslation.selectedText(output);const kind=selected?(mode==='summary'?'summary':'translation'):'original';assistant.disabled=true;try{await this.openSelectionWorkspace(reader,{...params.annotation,text:selected||text},'assistant',kind);}catch(error){hint.textContent=error.message;}finally{assistant.disabled=false;}});
    const translate=doc.createElement('button');translate.textContent='翻译';
    const note=doc.createElement('button');note.textContent='存入笔记';note.disabled=true;
    const excerpt=doc.createElement('button');excerpt.textContent='摘抄到笔记';excerpt.title='先在译文中选中文字，再摘抄到当前笔记';excerpt.disabled=true;
    const hint=doc.createElement('small');hint.textContent='可直接编辑 · 拖动边缘缩放';hint.style.cssText='padding:0 16px 6px;opacity:.6;flex:none;font-size:10px;';
    const edit=doc.createElement('button');edit.textContent='编辑笔记';edit.className='rn-edit-note';
    const create=doc.createElement('button');create.textContent='新建笔记';
    const reports=doc.createElement('button');reports.textContent='查看笔记';
    for(const [button,intent] of [[edit,'edit'],[create,'new'],[reports,'reports']])button.addEventListener('click',async()=>{try{await this.openSelectionWorkspace(reader,params.annotation,intent);}catch(error){hint.textContent=error.message;}});
    const close=doc.createElement('button');close.textContent='×';close.title='关闭译文';close.setAttribute('aria-label','关闭译文');close.style.marginLeft='auto';
    let translated='',mode='translate';
    const schedule=(next=mode)=>{
      mode=next;state.manualEdit=false;excerpt.disabled=true;state.subscription?.cancel();const run=++state.run;translated='';copy.disabled=note.disabled=true;copy.textContent='复制';output.value='';output.placeholder=mode==='summary'?'正在总结…':'正在翻译…';title.textContent=mode==='summary'?'选文总结':'选文翻译';hint.textContent='可直接编辑 · 拖动边缘缩放';
      state.pending=(async()=>{
        if(!this.active||state.run!==run)return;
        try{
          if(text.length>12000)throw new Error('选文过长，请分段选择');
          state.subscription=ResearchNotebookTranslation.subscribe(this,text,target.value,partial=>{if(this.active&&state.run===run&&box.isConnected!==false){translated=partial;if(!ResearchNotebookTranslation.selectedText(output))output.value=partial;copy.disabled=false;}},mode);
          const result=await state.subscription.promise;
          if(!this.active||state.run!==run||box.isConnected===false)return;
          if(result.truncated)throw new Error('译文未完整返回，请缩短选文后重试');
          translated=result.text;if(!ResearchNotebookTranslation.selectedText(output))output.value=translated;copy.disabled=note.disabled=false;
        }catch(error){if(this.active&&state.run===run){hint.textContent=error.message;output.placeholder='可重新点击翻译或总结';}}
      })();
    };
    target.addEventListener('change',()=>schedule('translate'));summary.addEventListener('click',()=>schedule('summary'));translate.addEventListener('click',()=>schedule('translate'));
    output.addEventListener('beforeinput',()=>{state.manualEdit=true;state.run++;state.subscription?.cancel();hint.textContent='手动编辑中 · 已停止自动覆盖';});
    output.addEventListener('input',()=>{translated=output.value;copy.disabled=note.disabled=!translated.trim();});
    const updateExcerpt=()=>{const selected=ResearchNotebookTranslation.selectedText(output);if(!selected&&!state.manualEdit&&translated&&output.value!==translated)output.value=translated;excerpt.disabled=!selected;excerpt.title=selected?'摘抄选中的 '+selected.length+' 字到当前笔记，并保留 PDF 来源':'先在译文中选中文字';};
    for(const type of ['select','selectionchange','mouseup','keyup','input'])output.addEventListener(type,updateExcerpt);
    excerpt.addEventListener('click',async()=>{const selected=ResearchNotebookTranslation.selectedText(output);if(!selected)return;excerpt.disabled=true;try{await this.addTranslatedExcerpt(reader,params.annotation,selected,mode==='summary'?'summary':'translation');hint.textContent='已发送所选内容，笔记浮窗将显示保存结果';}catch(error){hint.textContent=error.message;}finally{updateExcerpt();}});
    copy.addEventListener('click',()=>{const selected=output.value.slice(output.selectionStart,output.selectionEnd);Components.classes['@mozilla.org/widget/clipboardhelper;1'].getService(Components.interfaces.nsIClipboardHelper).copyString(selected||output.value);copy.textContent='已复制';});
    note.addEventListener('click',async()=>{note.disabled=true;try{const record=await this.registerSelected(reader?._window||Zotero.getMainWindow(),reader);await this.request('/api/notes',{title:(mode==='summary'?'选文总结':'翻译笔记')+' · '+record.id,folder:'文献笔记',tags:[record.id,mode==='summary'?'总结':'翻译'],content:'来源：['+record.title+'](/paper/'+record.id+')\n\n## 原文\n\n'+text+'\n\n## '+(mode==='summary'?'总结':'译文')+'\n\n'+output.value});note.textContent='已保存';}catch(error){hint.textContent=error.message;note.disabled=false;}});
    header.append(title,translate,summary,assistant,target,close);actions.append(edit,create,reports,copy,excerpt,note);box.append(style,header,output,hint,actions);(doc.body||doc.documentElement).append(box);
    ResearchNotebookTranslation.fit(box,output,text,'',doc.defaultView);
    const layout=ResearchNotebookTranslation.floating(box,header,doc.defaultView,'translation',300,190);
    for(const type of ['pointerdown','mousedown','mouseup','click','dblclick','keydown','keyup'])box.addEventListener(type,e=>e.stopPropagation());
    let stopLifetime=null,disposed=false;
    state.dispose=()=>{if(disposed)return;disposed=true;state.run++;state.subscription?.cancel();stopLifetime?.();layout.dispose();box.remove();this.selectionPanels.delete(state);doc.defaultView.removeEventListener('unload',state.dispose);};
    this.selectionPanels.add(state);doc.defaultView.addEventListener('unload',state.dispose,{once:true});close.addEventListener('click',state.dispose);
    // Translation must start even if optional lifecycle observation is unavailable.
    schedule();
    try{stopLifetime=ResearchNotebookTranslation.selectionLifetime(event,box,state.dispose);}catch(error){
      this.translationDiagnostics=(this.translationDiagnostics||[]).slice(-9);this.translationDiagnostics.push({stage:'lifecycle',error:String(error).slice(0,200)});Zotero.logError(error);
    }
  }
};



