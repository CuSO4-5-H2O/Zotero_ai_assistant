'use strict';
window.ResearchUI = (() => {
  const $ = id => document.getElementById(id);
  async function api(path, payload) {
    const response = await fetch(path, payload === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json','X-Notebook-Request':'1'},body:JSON.stringify(payload)});
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || '操作失败');
    return body;
  }
  function paintMath(root) {
    root.querySelectorAll('.math-inline,.math-display').forEach(el => {
      if (el.dataset.rendered) return;
      try {katex.render(el.textContent,el,{displayMode:el.classList.contains('math-display'),throwOnError:false,trust:false,maxExpand:1000});el.dataset.rendered='1';} catch (_) {}
    });
  }
  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) if (node.nodeType===1 && !node.closest('.katex')) paintMath(node.parentElement || node);
  }).observe(document.body,{childList:true,subtree:true});
  paintMath(document.body);
  document.addEventListener('click',async event => {
    const link=event.target.closest('a[data-paper]');
    if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.button!==0) return;
    if(new URLSearchParams(location.search).get('host')==='zotero'){
      event.preventDefault();try{await api('/api/zotero/open',{paper_id:link.dataset.paper});}catch(error){alert(error.message);}return;
    }
    const popup=window.open(link.href,'paper-'+link.dataset.paper,'popup,width=1280,height=920,resizable=yes,scrollbars=yes');
    if (popup) {event.preventDefault();popup.focus();}
  });
  const ui=document.createElement('div');
  ui.innerHTML=`<dialog id="ds-dialog"><form id="ds-form"><header><h2>DeepSeek 设置</h2><button type="button" class="dialog-close" data-ds-close aria-label="关闭 DeepSeek 设置">×</button></header><p class="muted">用于选中文字翻译和论文辅助精读。选中文字后自动翻译，只发送当前选文；全文精读仍需点击。按 DeepSeek 账户计费。</p><label>API Key<input id="ds-key" type="password" autocomplete="off" placeholder="首次填写；留空保留已有密钥"></label><label>模型<input id="ds-model" value="deepseek-flash" required autocomplete="off"></label><p class="muted">服务地址固定为 api.deepseek.com。密钥使用当前 Windows 用户加密保存在本机，不进入仓库导出。</p><p id="ds-status" role="status"></p><footer><button id="ds-clear" type="button" class="secondary">清除已存密钥</button><button id="ds-test" type="button" class="secondary">保存并测试</button><button class="primary" type="submit">保存设置</button></footer></form></dialog>
  <section id="translation-panel" class="translation-panel compact-translation" hidden aria-label="选文译文"><header><select id="translation-target" aria-label="翻译目标语言"><option value="简体中文">中文</option><option value="English">English</option></select><button id="close-translation" aria-label="关闭译文" title="关闭 · Esc">×</button></header><div id="translation-loading" class="translation-loading" aria-label="正在翻译" hidden><i></i><i></i><i></i></div><p id="translation-status" role="status" hidden></p><textarea id="translation-result" class="translation-text" dir="auto" aria-label="译文，可直接编辑和复制" spellcheck="false"></textarea><footer><button id="translation-settings" title="DeepSeek 设置" aria-label="DeepSeek 设置">⚙</button><button id="summary-selection">总结</button><button id="translate-selection">翻译</button><button id="copy-translation" disabled>复制</button><button id="save-translation" disabled>存为笔记</button></footer></section>`;
  document.body.append(ui);
  let current=null,result=null,requestRun=0,selectionTimer,pointerDown=false,lastSelection='',translationSubscription=null,selectionMode='translate';
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
  function showError(message){$('translation-status').textContent=message;$('translation-status').hidden=false;}
  function scheduleSelection(){
    clearTimeout(selectionTimer);
    const selectedElement=window.getSelection()?.anchorNode?.parentElement;
    if(selectedElement?.closest('#translation-panel,#ds-dialog'))return;
    const selection=readSelection();
    if(!selection){if(!document.activeElement?.closest('#translation-panel,#ds-dialog'))dismissTranslation();return;}
    const signature=selection.source+'\0'+selection.text;
    if(signature===lastSelection&&!$('translation-panel').hidden)return;
    requestRun++;lastSelection=signature;
    $('translation-panel').hidden=true;
    if(pointerDown)return;
    selectionTimer=setTimeout(()=>{
      const latest=readSelection();if(!latest||latest.source+'\0'+latest.text!==signature)return;
      current=latest;selectionMode='translate';$('translation-panel').hidden=false;placePopup(latest.rect);
      if(latest.text.length>12000){result=null;$('copy-translation').disabled=$('save-translation').disabled=true;$('translation-result').value='';$('translation-loading').hidden=true;showError('选文过长，请分段选择');placePopup(latest.rect);return;}
      translate();
    },0);
  }
  document.addEventListener('mousedown',event=>{if(event.target.closest?.('#translation-panel,#ds-dialog'))return;pointerDown=true;dismissTranslation();});
  document.addEventListener('mouseup',event=>{pointerDown=false;if(!event.target.closest?.('#translation-panel,#ds-dialog'))scheduleSelection();});
  document.addEventListener('selectionchange',()=>{if(pointerDown)clearTimeout(selectionTimer);});
  document.addEventListener('keyup',event=>{if(event.key==='Shift'||event.key.startsWith('Arrow'))scheduleSelection();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape')dismissTranslation();});
  document.addEventListener('scroll',event=>{if(!event.target.closest?.('#translation-panel'))dismissTranslation();},true);
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
    $('translation-status').hidden=true;$('translation-result').value='';$('translation-loading').hidden=false;
    $('copy-translation').textContent='复制';$('save-translation').textContent='存为笔记';$('copy-translation').disabled=$('save-translation').disabled=true;
    try{
      translationSubscription?.cancel();
      if(!translationCache.has(cacheKey))translationSubscription=subscribeTranslation(selection.text,target,partial=>{if(run!==requestRun)return;$('translation-loading').hidden=true;$('translation-result').value=partial;result={text:partial,selection,target,model:'DeepSeek'};$('copy-translation').disabled=false;placePopup(selection.rect);},selectionMode);
      const data=translationCache.get(cacheKey)||await translationSubscription.promise;
      if(translationCache.size>=60)translationCache.delete(translationCache.keys().next().value);translationCache.set(cacheKey,data);
      if(run!==requestRun)return;
      if(data.truncated)throw new Error('译文未完整返回，请缩短选文后重试');
      result={...data,selection,target};$('translation-result').value=data.text;
      $('copy-translation').disabled=$('save-translation').disabled=false;
    }catch(error){if(run===requestRun)showError(error.message);}
    finally{if(run===requestRun){$('translation-loading').hidden=true;placePopup(selection.rect);}}
  }
  $('translation-target').onchange=()=>{selectionMode='translate';translate();};
  $('summary-selection').onclick=()=>{selectionMode='summary';translate();};$('translate-selection').onclick=()=>{selectionMode='translate';translate();};
  $('close-translation').onclick=dismissTranslation;
  $('translation-settings').onclick=openSettings;
  $('copy-translation').onclick=async()=>{if(!result)return;try{await navigator.clipboard.writeText($('translation-result').value.slice($('translation-result').selectionStart,$('translation-result').selectionEnd)||$('translation-result').value);$('copy-translation').textContent='已复制';}catch(_){showError('可直接选中译文复制');}};
  $('save-translation').onclick=async()=>{
    if(!result)return;result.text=$('translation-result').value;const button=$('save-translation');button.disabled=true;
    try {
      const excerpt=result.selection.text.slice(0,30).replace(/[\r\n]/g,' ');
      const title=(selectionMode==='summary'?'选文总结 · ':'翻译笔记 · ')+new Date().toLocaleDateString('zh-CN').replaceAll('/','-')+' · '+excerpt;
      const content='# '+title+'\n\n来源：'+result.selection.source+(result.selection.paper?' · ['+result.selection.paper+'](/paper/'+result.selection.paper+')':'')+'\n\n## 原文\n\n'+result.selection.text+'\n\n## '+(selectionMode==='summary'?'总结':'译文（'+result.target+'）')+'\n\n'+result.text+'\n\n> DeepSeek '+result.model+' 辅助翻译，请对照原文。\n';
      await api('/api/notes',{title,folder:'文献笔记',tags:['翻译',...(result.selection.paper?[result.selection.paper]:[])],content});
      $('save-translation').textContent='已保存';window.dispatchEvent(new Event('research-notes-changed'));
    }catch(error){showError(error.message);button.disabled=false;}
  };
  $('translation-result').addEventListener('beforeinput',()=>{requestRun++;translationSubscription?.cancel();$('translation-loading').hidden=true;});
  $('translation-result').addEventListener('input',()=>{if(!result&&current)result={selection:{...current},target:$('translation-target').value,model:'用户编辑'};if(result)result.text=$('translation-result').value;$('copy-translation').disabled=$('save-translation').disabled=!result?.text?.trim();});
  document.addEventListener('research-ai-changed',()=>{translationCache.clear();dismissTranslation();});
  const panel=$('translation-panel');let drag=null;
  panel.addEventListener('pointerdown',e=>{const r=panel.getBoundingClientRect();if(e.clientX>r.right-22&&e.clientY>r.bottom-22)panel.dataset.manualSize='1';});
  panel.querySelector('header').addEventListener('pointerdown',e=>{if(e.target.closest('button,select'))return;const r=panel.getBoundingClientRect();drag={x:e.clientX,y:e.clientY,left:r.left,top:r.top};panel.dataset.manualSize='1';e.currentTarget.setPointerCapture(e.pointerId);e.preventDefault();});
  window.addEventListener('pointermove',e=>{if(!drag)return;panel.style.left=Math.max(8,Math.min(innerWidth-panel.offsetWidth-8,drag.left+e.clientX-drag.x))+'px';panel.style.top=Math.max(8,Math.min(innerHeight-panel.offsetHeight-8,drag.top+e.clientY-drag.y))+'px';});
  window.addEventListener('pointerup',()=>{drag=null;if(panel.dataset.manualSize){try{localStorage.setItem('rn-translation-size',JSON.stringify({width:panel.offsetWidth,height:panel.offsetHeight}));}catch(_){}}});
  try{const size=JSON.parse(localStorage.getItem('rn-translation-size'));if(size?.width&&size?.height){panel.style.width=Math.min(size.width,innerWidth-28)+'px';panel.style.height=Math.min(size.height,innerHeight-28)+'px';panel.dataset.manualSize='1';}}catch(_){}
  return {api,paintMath,openSettings};
})();
