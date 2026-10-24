/* Streaming through Zotero's native XHR, as supported by the reader sandbox. */
var ResearchNotebookTranslation={
  dimensions(source,result,win){
    const length=Math.max(source.length,result.length*1.35),available=Math.max(180,(win?.innerWidth||1100)-40);
    const ideal=length<40?330:length<220?480:length<900?650:length<2400?780:900;
    return {width:Math.min(ideal,available),height:Math.max(110,Math.min(620,(win?.innerHeight||800)*.62))};
  },
  fit(box,output,source,result,win){
    const size=this.dimensions(source,result,win);if(!box.dataset?.manualSize)box.style.width=size.width+'px';box.style.maxWidth='calc(100vw - 24px)';
    return size;
  },
  floating(panel,handle,win,key,minWidth=300,minHeight=190){
    const prefs='extensions.researchnotebook.layout.'+key,doc=win.document;let moving=null;
    const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
    const apply=r=>{const width=clamp(r.width,Math.min(minWidth,win.innerWidth-16),win.innerWidth-16),height=clamp(r.height,Math.min(minHeight,win.innerHeight-16),win.innerHeight-16);Object.assign(panel.style,{width:width+'px',height:height+'px',left:clamp(r.left,8,win.innerWidth-width-8)+'px',top:clamp(r.top,8,win.innerHeight-height-8)+'px',right:'auto',bottom:'auto'});};
    const save=()=>{const r=panel.getBoundingClientRect();try{Zotero.Prefs.set(prefs,JSON.stringify({width:r.width,height:r.height,left:r.left,top:r.top}),true);}catch(_){}};
    try{const r=JSON.parse(Zotero.Prefs.get(prefs,true)||'null');if(r&&['width','height','left','top'].every(k=>Number.isFinite(r[k]))){apply(r);panel.dataset.manualSize='1';}}catch(_){}
    const move=e=>{if(!moving)return;let r={...moving.r},dx=e.clientX-moving.x,dy=e.clientY-moving.y,d=moving.direction;
      if(d==='move'){r.left+=dx;r.top+=dy;}else{if(d.includes('e'))r.width+=dx;if(d.includes('s'))r.height+=dy;if(d.includes('w')){r.width-=dx;r.left+=dx;}if(d.includes('n')){r.height-=dy;r.top+=dy;}}
      apply(r);panel.dataset.manualSize='1';e.preventDefault();e.stopPropagation();};
    const up=e=>{if(!moving)return;moving.target.releasePointerCapture?.(moving.pointer);moving=null;save();e?.stopPropagation();};
    const begin=(e,direction)=>{if(e.button!==0||direction==='move'&&e.target.closest('button,select,input,textarea'))return;const r=panel.getBoundingClientRect();moving={direction,x:e.clientX,y:e.clientY,r:{left:r.left,top:r.top,width:r.width,height:r.height},target:e.currentTarget,pointer:e.pointerId};e.currentTarget.setPointerCapture?.(e.pointerId);e.preventDefault();e.stopPropagation();};
    const drag=e=>begin(e,'move');handle.addEventListener('pointerdown',drag);handle.style.cursor='move';handle.style.userSelect='none';
    const grips=[];for(const d of ['n','e','s','w','ne','nw','se','sw']){const g=doc.createElementNS('http://www.w3.org/1999/xhtml','div');g.className='rn-resize-grip';g.setAttribute('aria-label','拖动调整窗口大小');g.style.cssText='position:absolute;z-index:6;touch-action:none;cursor:'+d+'-resize;';const corner=d.length===2;g.style.width=corner?'14px':d==='n'||d==='s'?'calc(100% - 24px)':'7px';g.style.height=corner?'14px':d==='w'||d==='e'?'calc(100% - 24px)':'7px';if(d.includes('n'))g.style.top='0';if(d.includes('s'))g.style.bottom='0';if(d.includes('w'))g.style.left='0';if(d.includes('e'))g.style.right='0';if(!corner){if(d==='n'||d==='s')g.style.left='12px';else g.style.top='12px';}g.addEventListener('pointerdown',e=>begin(e,d));panel.append(g);grips.push(g);}
    const resize=()=>{if(panel.style.display!=='none'&&!panel.hidden)apply(panel.getBoundingClientRect());};
    win.addEventListener('pointermove',move,true);win.addEventListener('pointerup',up,true);win.addEventListener('pointercancel',up,true);win.addEventListener('resize',resize);
    return {save,apply,reset(){panel.dataset.manualSize='';try{Zotero.Prefs.clear(prefs,true);}catch(_){}},dispose(){handle.removeEventListener('pointerdown',drag);win.removeEventListener('pointermove',move,true);win.removeEventListener('pointerup',up,true);win.removeEventListener('pointercancel',up,true);win.removeEventListener('resize',resize);grips.forEach(g=>g.remove());}};
  },
  subscribe(owner,text,target,onText,mode='translate'){
    const key=mode+'\0'+target+'\0'+text;let job=owner.translationJobs.get(key);
    if(!job){
      for(const [oldKey,old] of owner.translationJobs){if(owner.translationJobs.size<60)break;if(old.done)owner.translationJobs.delete(oldKey);}
      job={text:'',listeners:new Set(),done:false,xhr:null};owner.translationJobs.set(key,job);
      job.promise=(async()=>{
        let offset=0,buffer='',final=null;
        const consume=(response,finish=false)=>{
          buffer+=response.slice(offset);offset=response.length;
          const lines=buffer.split('\n');buffer=lines.pop();if(finish&&buffer.trim()){lines.push(buffer);buffer='';}
          for(const line of lines){if(!line.trim())continue;const event=JSON.parse(line);
            if(event.type==='error')throw new Error(event.error);
            if(event.type==='delta'){job.text+=event.text;for(const listener of job.listeners)listener(job.text);}
            if(event.type==='done'){final=event;job.text=event.text;for(const listener of job.listeners)listener(job.text);}
          }
        };
        try{
          const state=await owner.ensureService();
          if(!job.listeners.size)throw new Error('选文已切换');
          const response=await Zotero.HTTP.request('POST',`http://127.0.0.1:${state.port}/api/selection/stream`,{
            responseType:'text',timeout:120000,headers:{Authorization:'Bearer '+state.key,'X-Notebook-Request':'1','Content-Type':'application/json'},body:JSON.stringify({text,target,mode}),
            requestObserver(xhr){job.xhr=xhr;xhr.onprogress=()=>{try{consume(xhr.responseText);}catch(error){job.error=error;xhr.abort();}};}
          });
          if(job.error)throw job.error;consume(response.responseText||response.response||'',true);
          if(!final)throw new Error('译文未完整返回，请重试');job.done=true;return final;
        }catch(error){if(owner.translationJobs.get(key)===job)owner.translationJobs.delete(key);throw job.error||error;}
      })();
    }
    job.listeners.add(onText);if(job.text)onText(job.text);
    const cancel=()=>{job.listeners.delete(onText);Promise.resolve().then(()=>{if(!job.done&&!job.listeners.size){job.xhr?.abort();if(owner.translationJobs.get(key)===job)owner.translationJobs.delete(key);}});};
    return {promise:job.promise.finally(()=>job.listeners.delete(onText)),cancel};
  }
};
