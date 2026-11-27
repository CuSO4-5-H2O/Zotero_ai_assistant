'use strict';
// Shared humanities reading controls in the dock and standalone reader.
(() => {
  const {api,paintMath}=ResearchUI;
  const host=document.getElementById('paper-guide-workspace')||document.getElementById('guide-view');if(!host)return;
  let paper=null,run=0,watch=0,chapterData=null,loadedID=null;
  const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text)n.textContent=text;if(cls)n.className=cls;return n;};
  const oldGenerate=document.getElementById('generate-guide');if(oldGenerate)oldGenerate.hidden=true;
  const section=el('section',null,'reading-humanities');section.id='reading-humanities';
  const controls=el('div',null,'reading-tools'),generate=el('button','生成分章导读','accent'),ocr=el('button','扫描识别 OCR','quiet'),exportButton=el('button','导出划线与批注','quiet'),refresh=el('button','刷新目录','quiet'),cancel=el('button','取消任务','quiet');cancel.hidden=true;
  const status=el('p',null,'small');status.setAttribute('role','status');const outline=el('div',null,'reading-outline');
  const source=el('details'),sourceTitle=el('summary','阅读与复制原文'),textControls=el('div',null,'reading-tools'),previous=el('button','上一页/节','quiet'),next=el('button','下一页/节','quiet'),moreText=el('button','继续本页/节','quiet'),pageLabel=el('span'),original=el('pre',null,'reading-source selectable');original.tabIndex=0;original.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:1.9;user-select:text;max-height:65vh;overflow:auto;padding:12px;background:#f5f8f6;';
  textControls.append(previous,pageLabel,next,moreText);source.append(sourceTitle,textControls,original);controls.append(generate,ocr,exportButton,refresh,cancel);section.append(controls,status,outline,source);host.insertBefore(section,document.getElementById('paper-guide-content')||host.firstChild);
  const note=(message)=>{status.textContent=message;};
  async function current(){if(!paper?.id)throw new Error('请先在 Zotero 打开 PDF 或 EPUB，再点击科研精读');return paper.id;}
  async function jump(c){const id=await current();try{await api('/api/zotero/action',{action:'open_location',paper_id:id,...(c.location?.href?{href:c.location.href}:{page:c.start})});}catch(error){if(chapterData?.format==='pdf'&&new URLSearchParams(location.search).get('host')!=='zotero')window.open('/api/papers/'+encodeURIComponent(id)+'/pdf#page='+c.start,'_blank','noopener');else throw error;}}
  function renderChapters(data){outline.replaceChildren();chapterData=data;const rows=data.chapters||[];note(rows.length+' 个章节/阅读段 · '+data.pages+(data.format==='epub'?' 个 EPUB 正文节':' 页'));let shown=0;
    const add=()=>{for(const c of rows.slice(shown,shown+60)){
      const card=el('details',null,'reading-chapter'),title=el('summary'),label=el('span',c.title),button=el('button','跳到原文 ↗','quiet'),body=el('div',null,'prose selectable');button.type='button';button.onclick=e=>{e.preventDefault();e.stopPropagation();jump(c).catch(error=>note(error.message));};title.append(label,button);card.append(title,body);let rendered=false;
      card.addEventListener('toggle',async()=>{if(!card.open||rendered)return;rendered=true;if(c.summary){try{const preview=await api('/api/preview',{content:c.summary});if(card.isConnected){body.innerHTML=preview.html;paintMath(body);}}catch(error){body.textContent=error.message;}}else body.textContent='点击“生成分章导读”查看本章结构、核心观点、关键概念与论证。';});outline.append(card);
    }shown+=60;loadMore.hidden=shown>=rows.length;};const loadMore=el('button','加载更多章节','quiet');loadMore.onclick=()=>{loadMore.remove();add();outline.append(loadMore);};add();outline.append(loadMore);
  }
  async function load(){const turn=++run;try{const id=await current();note('正在读取章节目录…');const data=await api('/api/papers/'+encodeURIComponent(id)+'/chapters');if(turn!==run)return;loadedID=id;renderChapters(data);ocr.hidden=data.format==='epub';}catch(error){if(turn===run)note(error.message);}}
  async function update(value){if(!value?.id||value.id==='workspace')return;paper=value;loadedID=null;run++;watch++;cancel.hidden=true;generate.disabled=ocr.disabled=false;outline.replaceChildren();original.textContent='';textPage=1;textOffset=0;note('展开导读可查看目录、分章解读和原文。');}
  document.addEventListener('research-paper-change',event=>update(event.detail));
  document.addEventListener('click',event=>{if(event.target.closest?.('[data-pane="guide"],#show-guide,[data-tab="guide"]')&&paper?.id!==loadedID)load();});
  refresh.onclick=load;
  let jobID=null;
  async function start(kind){try{const id=await current();generate.disabled=ocr.disabled=true;const job=await api('/api/papers/'+encodeURIComponent(id)+'/reading-job',{kind});jobID=job.id;cancel.hidden=false;const turn=++watch;
    while(turn===watch){const state=await api('/api/reading/jobs/'+job.id);if(turn!==watch)return;note(state.message+' · '+state.processed+'/'+state.total);
      if(!['queued','running','cancelling'].includes(state.status)){
        cancel.hidden=true;if(state.status==='completed'){if(kind==='ocr'){paper=await api('/api/papers/'+id);document.dispatchEvent(new CustomEvent('research-paper-change',{detail:paper}));note('识别完成，原扫描件保留；点击“跳到原文”可打开可选字副本。');}await load();if(kind==='ocr')note('OCR 完成：可选字副本已存入 Zotero，原扫描件与批注保留。');}break;
      }await new Promise(resolve=>setTimeout(resolve,1500));
    }
  }catch(error){note(error.message);}finally{generate.disabled=ocr.disabled=false;}}
  const moreGenerate=document.getElementById('generate-reading');if(moreGenerate)moreGenerate.onclick=()=>start('chapters');
  generate.onclick=()=>start('chapters');ocr.onclick=()=>start('ocr');cancel.onclick=async()=>{try{if(jobID){await api('/api/reading/cancel',{task_id:jobID});note('正在取消，已完成内容保留。');}}catch(error){note(error.message);}};
  exportButton.onclick=async()=>{try{const id=await current();exportButton.disabled=true;const data=await api('/api/reading/export-annotations',{paper_ids:[id],versions:{[id]:paper.reading?.version}});const row=data.rows[0];if(!row.ok)throw new Error(row.error);note('已追加 '+row.added+' 条到本文献笔记；重复内容已跳过。');document.dispatchEvent(new CustomEvent('research-reading-updated',{detail:{id}}));}catch(error){note(error.message);}finally{exportButton.disabled=false;}};
  let textPage=1,textOffset=0,nextOffset=null;
  async function readText(){try{const id=await current();const data=await api('/api/papers/'+id+'/text?start='+textPage+'&offset='+textOffset);original.textContent=data.text||'本页未提取到文字，可先执行扫描识别 OCR。';pageLabel.textContent=textPage+'/'+data.total+(data.format==='epub'?' 节':' 页');nextOffset=data.next_offset;moreText.hidden=nextOffset===null;previous.disabled=textPage<=1;next.disabled=textPage>=data.total;}catch(error){note(error.message);}}
  source.addEventListener('toggle',()=>{if(source.open)readText();});previous.onclick=()=>{textPage=Math.max(1,textPage-1);textOffset=0;readText();};next.onclick=()=>{textPage++;textOffset=0;readText();};moreText.onclick=()=>{textOffset=nextOffset||0;readText();};
  const noteHost=document.getElementById('notes-search');
  if(noteHost){
    const batch=el('details'),summary=el('summary','批量文献笔记与划线'),tools=el('div',null,'reading-tools'),listButton=el('button','选择笔记','quiet'),combine=el('button','汇编所选笔记','quiet'),exportSelected=el('button','导出 Zotero 所选文献批注','quiet'),choices=el('div'),title=el('input'),batchStatus=el('p',null,'small');title.placeholder='汇编标题，如：近代史阅读摘记';title.setAttribute('aria-label','阅读汇编标题');const selected=new Map();
    tools.append(listButton,combine,exportSelected);batch.append(summary,title,tools,choices,batchStatus);noteHost.prepend(batch);
    listButton.onclick=async()=>{try{const query=encodeURIComponent(document.getElementById('note-query')?.value?.trim()||'');const [paperNotes,vault]=await Promise.all([api('/api/paper-notes?q='+query),api('/api/notes?q='+query)]);choices.replaceChildren();selected.clear();for(const row of [...paperNotes.map(r=>({...r,nid:'paper:'+r.id})),...vault.notes.map(r=>({...r,nid:r.id}))].slice(0,200)){const label=el('label'),check=el('input');check.type='checkbox';check.onchange=()=>check.checked?selected.set(row.nid,row.title):selected.delete(row.nid);label.style.cssText='display:flex;gap:8px;padding:6px;align-items:center;';label.append(check,document.createTextNode(row.title));choices.append(label);}batchStatus.textContent='每次最多汇编40篇；列表最多显示200条，可通过上方搜索缩小范围。';}catch(error){batchStatus.textContent=error.message;}};
    combine.onclick=async()=>{try{if(!selected.size)throw new Error('请先选择来源笔记');if(!title.value.trim())throw new Error('请填写汇编标题');combine.disabled=true;const versions={};for(const nid of selected.keys()){const doc=await api(nid.startsWith('paper:')?'/api/papers/'+nid.slice(6):'/api/notes/'+nid);versions[nid]=doc.reading?.version||doc.version;}const saved=await api('/api/reading/combine-notes',{note_ids:[...selected.keys()],versions,title:title.value.trim()});batchStatus.textContent='已生成独立汇编：'+saved.title+'；来源笔记保留。';document.dispatchEvent(new CustomEvent('research-open-note',{detail:{note_id:saved.id}}));}catch(error){batchStatus.textContent=error.message;}finally{combine.disabled=false;}};
    exportSelected.onclick=async()=>{try{exportSelected.disabled=true;const selected=await api('/api/zotero/action',{action:'list_readings',selected:true});if(selected.next_start!==null)throw new Error('所选超过20篇，请分批处理');const ids=selected.papers.map(p=>p.id);if(!ids.length)throw new Error('请先在 Zotero 文献列表中多选文献');const result=await api('/api/reading/export-annotations',{paper_ids:ids});batchStatus.textContent='已新增 '+result.added+' 条批注'+(result.ok?'':'；部分文献失败：'+result.rows.filter(r=>!r.ok).map(r=>r.error).join('；'));document.dispatchEvent(new CustomEvent('research-reading-updated',{detail:{ids}}));}catch(error){batchStatus.textContent=error.message;}finally{exportSelected.disabled=false;}};
  }
  window.addEventListener('pagehide',()=>{run++;watch++;});
  if(document.body.dataset.paper)api('/api/papers/'+encodeURIComponent(document.body.dataset.paper)).then(update).catch(error=>note(error.message));
})();
