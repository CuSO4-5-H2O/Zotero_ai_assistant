'use strict';
window.ResearchLiterature=(()=>{
  const $=id=>document.getElementById(id),{api}=ResearchUI;
  let results=[],paperIndex=[],watchRun=0,activeTask=null,checking=false;
  const options=document.createElement('div');options.className='literature-filters';
  options.innerHTML='<label>检索来源 <select id="literature-provider"><option value="auto">自动选择</option><option value="crossref">Crossref · 免费题录</option><option value="elicit">Elicit · 自然语言语义检索</option><option value="combined">Crossref + Elicit · 合并去重</option></select></label><label><input id="literature-autoimport" type="checkbox" checked>搜索后自动获取 PDF 并加入 storage</label>';
  $('literature-form').append(options);
  $('literature-query').placeholder='描述研究要求，或输入关键词 / DOI';
  const searchLabel=()=>{$('literature-search').textContent=$('literature-autoimport').checked?'搜索并入库':'搜索候选文献';};
  $('literature-autoimport').onchange=searchLabel;searchLabel();
  const settings=document.createElement('details');settings.className='literature-settings';
  settings.innerHTML='<summary>检索服务设置 / 外部搜索结果导入</summary><p class="small">目标为 Zotero 左侧 storage 分类；PDF 由 Zotero 托管。Elicit 使用你自己的 API Key，无法复用 Codex 中的账号连接。</p><form id="literature-settings-form"><label for="literature-elicit-key">Elicit API Key</label><div class="search-row"><input id="literature-elicit-key" type="password" autocomplete="off" placeholder="填写密钥；留空保留已有密钥"><button type="submit" class="quiet">加密保存设置</button><button id="literature-clear-key" type="button" class="quiet">清除本机密钥</button></div></form><p id="literature-provider-status" class="small" role="status"></p><p class="small"><a href="https://elicit.com/settings" target="_blank" rel="noopener noreferrer">Elicit 账号设置 ↗</a> · <a href="https://www.undermind.ai/" target="_blank" rel="noopener noreferrer">打开 Undermind 搜索 ↗</a></p><p class="small">Undermind 原生连接需要该插件独立的 OAuth 客户端注册。当前可先在网页搜索，再将结果中的 DOI 列表、CSV 的 DOI 列或 RIS 文本粘贴到下面（每批最多 20 篇）。</p><textarea id="literature-identifiers" rows="4" aria-label="外部搜索结果 DOI 或 RIS" placeholder="粘贴 Undermind / Elicit 结果中包含 DOI 的文本"></textarea><button id="literature-import-identifiers" type="button" class="quiet">核验 DOI 并按上方选项入库</button>';
  $('literature-form').after(settings);
  const settingsStatus=data=>{$('literature-provider-status').textContent=(data.elicit_configured?'Elicit 已配置':'Elicit 未配置；自动模式使用 Crossref')+' · 默认入库：storage';};
  api('/api/literature/settings').then(data=>{settingsStatus(data);$('literature-provider').value=data.default_provider;}).catch(error=>{$('literature-provider-status').textContent=error.message;});
  $('literature-settings-form').onsubmit=async event=>{event.preventDefault();try{const data=await api('/api/literature/settings',{elicit_key:$('literature-elicit-key').value,default_provider:$('literature-provider').value});$('literature-elicit-key').value='';settingsStatus(data);}catch(error){$('literature-provider-status').textContent=error.message;}};
  $('literature-clear-key').onclick=async()=>{try{settingsStatus(await api('/api/literature/settings',{clear_elicit_key:true}));$('literature-elicit-key').value='';}catch(error){$('literature-provider-status').textContent=error.message;}};
  const say=(message,error=false)=>{$('literature-message').textContent=message;$('literature-message').classList.toggle('chat-error',error);};
  const selected=()=>[...document.querySelectorAll('[data-literature-candidate]:checked')].map(e=>e.dataset.literatureCandidate);
  function selectionChanged(){$('literature-import').disabled=!selected().length;$('literature-import').textContent='导入所选并获取 PDF'+(selected().length?'（'+selected().length+'）':'');}
  function existingPaper(candidate){const doi=(candidate.doi||'').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i,'').replace(/^doi:\s*/i,'').replace(/\/$/,'').toLocaleLowerCase();if(doi)return paperIndex.find(ref=>String(ref.url||'').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i,'').replace(/^doi:\s*/i,'').replace(/\/$/,'').toLocaleLowerCase()===doi);const title=candidate.title?.normalize('NFKC').toLocaleLowerCase().trim();return title?paperIndex.find(ref=>ref.title?.normalize('NFKC').toLocaleLowerCase().trim()===title):null;}
  function renderResults(){
    const list=$('literature-results');list.replaceChildren();
    for(const paper of results){
      const row=document.createElement('div');row.className='literature-result';
      const check=document.createElement('input');check.type='checkbox';check.dataset.literatureCandidate=paper.candidate_id;check.setAttribute('aria-label','选择 '+paper.title);check.onchange=selectionChanged;
      const body=document.createElement('div'),label=document.createElement('label'),title=document.createElement('strong'),meta=document.createElement('p'),link=document.createElement('a');
      const existing=existingPaper(paper);check.id='candidate-'+paper.candidate_id;label.htmlFor=check.id;title.textContent=paper.title+(existing?' · 已在仓库':'');label.append(title);meta.className='small';meta.textContent=[paper.source,paper.year,paper.author,paper.venue].filter(Boolean).join(' · ');link.href=paper.url;link.target='_blank';link.rel='noopener noreferrer';link.textContent=paper.doi||'arXiv 原文';
      body.append(label,meta,link);if(paper.abstract){const detail=document.createElement('details'),summary=document.createElement('summary'),text=document.createElement('p');summary.textContent='查看来源摘要';text.textContent=paper.abstract;detail.append(summary,text);body.append(detail);}
      if(existing){check.disabled=!!existing.zotero?.attachment_key;const action=document.createElement('button');action.className='quiet';action.textContent=existing.zotero?.attachment_key?'打开已入库 PDF ↗':'已有题录 · 可勾选重试获取 PDF';action.onclick=async()=>{try{if(existing.zotero?.attachment_key)await ResearchUI.openPaperPDF(existing.id);else document.dispatchEvent(new CustomEvent('research-open-paper',{detail:{paper_id:existing.id}}));}catch(error){say(error.message,true);}};body.append(action);}
      row.append(check,body);list.append(row);
    }
    $('literature-selection').hidden=!results.length;$('literature-select-all').checked=false;selectionChanged();
  }
  $('literature-form').onsubmit=async event=>{
    event.preventDefault();if(checking)return;checking=true;$('literature-search').disabled=true;say('正在检索学术题录…');
    try{const payload={query:$('literature-query').value.trim(),limit:Number($('literature-limit').value),provider:$('literature-provider').value};for(const [name,id] of [['from_year','literature-from'],['until_year','literature-until']])if($(id).value)payload[name]=Number($(id).value);
      const [data,catalog]=await Promise.all([api('/api/literature/search',payload),api('/api/papers')]);await acceptResults(data,catalog);
    }catch(e){say(e.message,true);}finally{checking=false;$('literature-search').disabled=false;}
  };
  async function acceptResults(data,catalog){results=data.results;paperIndex=catalog;renderResults();say('找到 '+results.length+' 个候选 · '+data.source+'；全文获取结果见入库进度。'+(data.warnings?.length?' '+data.warnings.join('；'):''));if($('literature-autoimport').checked){const ids=results.filter(p=>!existingPaper(p)?.zotero?.attachment_key).map(p=>p.candidate_id);if(ids.length)await importCandidates(ids);}}
  async function importCandidates(ids){const job=await api('/api/literature/import',{candidate_ids:ids,fetch_pdf:true,collection_name:'storage'});watch(job.id);}
  $('literature-import-identifiers').onclick=async()=>{if(checking)return;checking=true;$('literature-import-identifiers').disabled=true;say('正在核验外部搜索结果的 DOI…');try{const [data,catalog]=await Promise.all([api('/api/literature/identifiers',{text:$('literature-identifiers').value}),api('/api/papers')]);await acceptResults(data,catalog);}catch(error){say(error.message,true);}finally{checking=false;$('literature-import-identifiers').disabled=false;}};
  $('literature-select-all').onchange=event=>{for(const c of document.querySelectorAll('[data-literature-candidate]'))if(!c.disabled)c.checked=event.target.checked;selectionChanged();};
  $('literature-import').onclick=async()=>{
    const ids=selected();if(!ids.length)return;$('literature-import').disabled=true;
    try{await importCandidates(ids);say('已启动后台入库，可继续使用助手。');}catch(e){say(e.message,true);}finally{selectionChanged();}
  };
  function renderTask(job){
    $('literature-task').hidden=false;$('literature-task-heading').textContent=({'queued':'等待入库','running':'正在入库','cancelling':'正在停止后续导入','completed':'本次入库处理结束','cancelled':'已停止后续导入','interrupted':'任务已中断','failed':'任务中断'}[job.status]||job.status)+' · '+job.processed+'/'+job.total;
    $('literature-task-message').textContent=job.current_title?'当前文献：'+job.current_title:job.message;
    $('literature-task-counts').textContent='题录入库 '+job.metadata_saved+' · PDF 可用 '+job.pdf_available+' · 本次获取 '+job.pdf_downloaded+' · 全文待获取 '+job.rows.filter(r=>r.ok&&r.pdf_status==='not_found').length;
    $('literature-stop').hidden=!['queued','running'].includes(job.status);const list=$('literature-task-results');list.replaceChildren();
    for(const row of job.rows){const card=document.createElement('div');card.className='literature-task-row';const label=document.createElement('span');label.textContent=row.title+' · '+(row.ok?({'existing':'已有 PDF，已复用','downloaded':'PDF 已获取并存入 storage','copied':'PDF 已导入 storage','not_found':'题录已保存，全文未取得','not_requested':'仅保存题录'}[row.pdf_status]||'题录已保存'):'未完成：'+row.error);card.append(label);if(row.message){const small=document.createElement('small');small.textContent=row.message;card.append(small);}if(row.paper_id){const actions=document.createElement('div');actions.className='result-actions';if(['existing','downloaded','copied'].includes(row.pdf_status)){const pdf=document.createElement('button');pdf.className='quiet';pdf.textContent='打开 PDF ↗';pdf.onclick=async()=>{try{await ResearchUI.openPaperPDF(row.paper_id);}catch(error){say(error.message,true);}};actions.append(pdf);}const note=document.createElement('button');note.className='quiet';note.textContent='精读笔记';note.onclick=()=>document.dispatchEvent(new CustomEvent('research-open-paper',{detail:{paper_id:row.paper_id}}));actions.append(note);card.append(actions);}list.append(card);}
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
