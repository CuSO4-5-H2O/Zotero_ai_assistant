'use strict';
window.ResearchLiterature=(()=>{
  const $=id=>document.getElementById(id),{api}=ResearchUI;
  let results=[],watchRun=0,activeTask=null,checking=false;
  const say=(message,error=false)=>{$('literature-message').textContent=message;$('literature-message').classList.toggle('chat-error',error);};
  const selected=()=>[...document.querySelectorAll('[data-literature-candidate]:checked')].map(e=>e.dataset.literatureCandidate);
  function selectionChanged(){$('literature-import').disabled=!selected().length;$('literature-import').textContent='导入所选并获取 PDF'+(selected().length?'（'+selected().length+'）':'');}
  function renderResults(){
    const list=$('literature-results');list.replaceChildren();
    for(const paper of results){
      const row=document.createElement('div');row.className='literature-result';
      const check=document.createElement('input');check.type='checkbox';check.dataset.literatureCandidate=paper.candidate_id;check.setAttribute('aria-label','选择 '+paper.title);check.onchange=selectionChanged;
      const body=document.createElement('div'),label=document.createElement('label'),title=document.createElement('strong'),meta=document.createElement('p'),link=document.createElement('a');
      check.id='candidate-'+paper.candidate_id;label.htmlFor=check.id;title.textContent=paper.title;label.append(title);meta.className='small';meta.textContent=[paper.year,paper.author,paper.venue].filter(Boolean).join(' · ');link.href=paper.url;link.target='_blank';link.rel='noopener noreferrer';link.textContent=paper.doi;
      body.append(label,meta,link);if(paper.abstract){const detail=document.createElement('details'),summary=document.createElement('summary'),text=document.createElement('p');summary.textContent='查看来源摘要';text.textContent=paper.abstract;detail.append(summary,text);body.append(detail);}
      row.append(check,body);list.append(row);
    }
    $('literature-selection').hidden=!results.length;$('literature-select-all').checked=false;selectionChanged();
  }
  $('literature-form').onsubmit=async event=>{
    event.preventDefault();if(checking)return;checking=true;$('literature-search').disabled=true;say('正在检索学术题录…');
    try{const payload={query:$('literature-query').value.trim(),limit:Number($('literature-limit').value)};for(const [name,id] of [['from_year','literature-from'],['until_year','literature-until']])if($(id).value)payload[name]=Number($(id).value);
      const data=await api('/api/literature/search',payload);results=data.results;renderResults();say('找到 '+results.length+' 个候选 · Crossref 题录；请按相关性筛选，全文是否可用以入库任务为准。');
    }catch(e){say(e.message,true);}finally{checking=false;$('literature-search').disabled=false;}
  };
  $('literature-select-all').onchange=event=>{for(const c of document.querySelectorAll('[data-literature-candidate]'))c.checked=event.target.checked;selectionChanged();};
  $('literature-import').onclick=async()=>{
    const ids=selected();if(!ids.length)return;$('literature-import').disabled=true;
    try{const job=await api('/api/literature/import',{candidate_ids:ids,fetch_pdf:true});say('已启动后台入库，可继续使用助手。');watch(job.id);}catch(e){say(e.message,true);}finally{selectionChanged();}
  };
  function renderTask(job){
    $('literature-task').hidden=false;$('literature-task-heading').textContent=({'queued':'等待入库','running':'正在入库','cancelling':'正在停止后续导入','completed':'本次入库处理结束','cancelled':'已停止后续导入','interrupted':'任务已中断','failed':'任务中断'}[job.status]||job.status)+' · '+job.processed+'/'+job.total;
    $('literature-task-message').textContent=job.current_title?'当前文献：'+job.current_title:job.message;
    $('literature-task-counts').textContent='题录入库 '+job.metadata_saved+' · PDF 可用 '+job.pdf_available+' · 本次获取 '+job.pdf_downloaded;
    $('literature-stop').hidden=!['queued','running'].includes(job.status);const list=$('literature-task-results');list.replaceChildren();
    for(const row of job.rows){const card=document.createElement('div');card.className='literature-task-row';const label=document.createElement('span');label.textContent=row.title+' · '+(row.ok?({'existing':'已有 PDF，已复用','downloaded':'PDF 已获取','copied':'PDF 已复制入 storage','not_found':'题录已保存，全文未取得','not_requested':'仅保存题录'}[row.pdf_status]||'题录已保存'):'未完成：'+row.error);card.append(label);if(row.message){const small=document.createElement('small');small.textContent=row.message;card.append(small);}if(row.paper_id){const b=document.createElement('button');b.className='quiet';b.textContent='打开文献笔记';b.onclick=()=>document.dispatchEvent(new CustomEvent('research-open-paper',{detail:{paper_id:row.paper_id}}));card.append(b);}list.append(card);}
  }
  async function watch(id){
    const run=++watchRun;activeTask=id;localStorage.setItem('rn-literature-task',id);let loops=0;
    while(run===watchRun){try{const job=await api('/api/literature/tasks/'+id);if(run!==watchRun)return;renderTask(job);if(!['queued','running','cancelling'].includes(job.status)){document.dispatchEvent(new Event('research-library-changed'));return;}}catch(e){say(e.message,true);return;}
      if(++loops>=65){$('literature-task-message').textContent+='；任务继续在后台运行，点击“刷新进度”查看。';return;}await new Promise(resolve=>setTimeout(resolve,document.hidden?8000:1800));
    }
  }
  $('literature-stop').onclick=async()=>{if(!activeTask)return;try{renderTask(await api('/api/literature/tasks/'+activeTask+'/stop',{}));}catch(e){say(e.message,true);}};
  $('literature-refresh').onclick=()=>activeTask&&watch(activeTask);
  $('literature-recent').onclick=async()=>{try{const data=await api('/api/literature/tasks');const list=$('literature-recent-list');list.replaceChildren();list.hidden=false;for(const job of data){const b=document.createElement('button');b.className='result-card';b.textContent=new Date(job.created*1000).toLocaleString()+' · '+job.processed+'/'+job.total+' 篇 · '+job.message;b.onclick=()=>{list.hidden=true;watch(job.id);};list.append(b);}if(!data.length)list.textContent='暂无入库任务。';}catch(e){say(e.message,true);}};
  window.addEventListener('pagehide',()=>watchRun++);
  return {watch};
})();
