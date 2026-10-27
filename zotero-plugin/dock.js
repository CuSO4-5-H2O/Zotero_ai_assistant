/* A modeless panel owned by the existing Zotero window, without a new tab/window. */
var ResearchNotebookDock = {
  create(owner, win, channel) {
    const doc=win.document,html=name=>doc.createElementNS('http://www.w3.org/1999/xhtml',name);
    const panel=html('section');panel.id='research-notebook-dock';panel.setAttribute('aria-label','科研笔记浮窗');
    panel.style.cssText='position:fixed;z-index:2147483000;top:76px;right:22px;width:min(620px,calc(100vw - 32px));height:calc(100vh - 130px);min-width:340px;min-height:300px;max-width:calc(100vw - 16px);max-height:calc(100vh - 24px);display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;padding:0;margin:0;border:1px solid #d3e1dd;border-radius:12px;background:#fff;box-shadow:0 18px 70px #123c3c30;color:#284d47;';
    const handle=html('header');handle.style.cssText='display:flex;align-items:center;gap:10px;flex:none;min-height:34px;padding:4px 14px;background:#edf4f1;cursor:move;font:12px system-ui;user-select:none;';
    const label=html('span');label.textContent='科研笔记';label.style.cssText='flex:1;min-width:0;white-space:nowrap;font-weight:600;letter-spacing:.03em;';
    const close=html('button');close.textContent='×';close.title='收起浮窗，保留草稿';close.setAttribute('aria-label','收起科研笔记浮窗');close.style.cssText='border:0;background:transparent;color:inherit;font-size:20px;cursor:pointer;';
    const browser=doc.createXULElement('browser');browser.setAttribute('type','content');browser.setAttribute('flex','1');browser.setAttribute('disablehistory','true');browser.setAttribute('maychangeremoteness','true');browser.style.cssText='display:block;flex:1;width:100%;height:100%;min-height:0;border:0;';
    handle.append(label,close);panel.append(handle,browser);doc.documentElement.append(panel);
    const dock={panel,browser,channel,win,pid:null,cleanups:[],show(){panel.style.display='flex';const launcher=doc.getElementById('research-notebook-global-launch');if(launcher)launcher.style.display='none';win.focus();},hide(){panel.style.display='none';const launcher=doc.getElementById('research-notebook-global-launch');if(launcher)launcher.style.display='block';},dispose(){for(const cleanup of this.cleanups)cleanup();const launcher=doc.getElementById('research-notebook-global-launch');if(launcher)launcher.style.display='block';panel.remove();}};
    close.addEventListener('click',()=>dock.hide());
    const layout=ResearchNotebookTranslation.floating(panel,handle,win,'dock',340,300);dock.cleanups.push(()=>layout.dispose());
    const unload=()=>{dock.dispose();owner.docks.delete(win);};win.addEventListener('unload',unload,{once:true});dock.cleanups.push(()=>win.removeEventListener('unload',unload));
    return dock;
  }
};
