'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const api = (path, body) => ResearchUI.api(path, body);
  const STORE = 'rn-metasurface-manual-v1';
  const data = {index:null,route:null,current:null,navRun:0,searchRun:0,cache:new Map(),searchTimer:null,saveTimer:null,printState:null};
  function rememberRecord(key,value){
    data.cache.delete(key);data.cache.set(key,value);
    const size=()=>[...data.cache.values()].reduce((n,row)=>n+Object.values(row).reduce((s,v)=>s+(typeof v==='string'?v.length*2:0),0),0);
    while(data.cache.size>6||size()>3*1024*1024)data.cache.delete(data.cache.keys().next().value);
  }
  let stored = {saved:[],checks:{},folds:{},last:null,titles:{},positions:{}};
  try {
    const value=JSON.parse(localStorage.getItem(STORE)||'null');
    if(value && typeof value==='object' && !Array.isArray(value)) {
      for(const key of ['checks','folds','titles','positions'])if(value[key] && typeof value[key]==='object' && !Array.isArray(value[key]))stored[key]=value[key];
      if(Array.isArray(value.saved))stored.saved=value.saved.filter(x=>typeof x==='string' && x.length<200).slice(0,1000);
      if(value.last && typeof value.last.route==='string')stored.last=value.last;
    }
  } catch (_) {}
  let storeUnavailable=false,toastTimer,noteContext=null,noteSaving=false;
  const array = value => Array.isArray(value)?value:[];
  const text = value => value==null?'':String(value);
  const asID = value => typeof value==='string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value);
  const keyOf = (kind,id) => kind+'/'+id;
  const node = (tag,className,content) => {const element=document.createElement(tag);if(className)element.className=className;if(content!=null)element.textContent=text(content);return element;};
  const button = (label,fn,className='manual-button') => {const b=node('button',className,label);b.type='button';b.addEventListener('click',fn);return b;};
  const routeLink = (kind,id,label,className='') => {const a=node('a',className,label);a.href='#/'+kind+(id?'/'+encodeURIComponent(id):'');return a;};
  const joinMeta = values => values.filter(x=>x!=null && text(x).trim()).map(text).join(' · ');
  const clip = (value,max=160) => text(value).slice(0,max)+(text(value).length>max?'…':'');

  function persist() {
    try {localStorage.setItem(STORE,JSON.stringify(stored));}
    catch (_) {if(!storeUnavailable){storeUnavailable=true;status('浏览器存储不可用，本次仍可阅读与搜索；进度暂不持久保存。');}}
  }
  function status(message) {$('manual-status').textContent=message;}
  function toast(message) {clearTimeout(toastTimer);$('manual-toast').textContent=message;$('manual-toast').hidden=false;toastTimer=setTimeout(()=>$('manual-toast').hidden=true,3200);}
  function fail(message,retry) {
    const box=$('manual-error');box.replaceChildren(node('span','',message));
    if(retry)box.append(button('重试',retry));box.hidden=false;status(message);
  }
  function clearError() {$('manual-error').hidden=true;}
  function rememberPosition() {
    if(!data.route || !['chapter','source','case'].includes(data.route.kind))return;
    stored.positions[keyOf(data.route.kind,data.route.id)]=Math.max(0,Math.round(window.scrollY));
    clearTimeout(data.saveTimer);data.saveTimer=setTimeout(persist,200);
  }
  window.addEventListener('scroll',rememberPosition,{passive:true});
  window.addEventListener('pagehide',()=>{clearTimeout(data.saveTimer);persist();});

  function evidenceBadge(record) {
    const level=typeof record?.evidence_level==='string'?record.evidence_level:'';
    if(record?.local_validation===true || level==='local_validated')return node('span','manual-badge verified','本地仿真结果');
    if(/infer|engineering|assumption/.test(level))return node('span','manual-badge warning','设计建议');
    // Negative statements such as paper_seed_not_native_accepted must never
    // become a positive "native development" badge through a substring match.
    if(!/^paper|not_native|not_local|unverified/.test(level) && /native|development|partial/.test(level))return node('span','manual-badge warning','本地仿真案例');
    return node('span','manual-badge neutral','文献案例');
  }
  function tagsRow(tags) {
    const row=node('div','manual-meta');
    for(const tag of array(tags).slice(0,9))row.append(node('span','manual-tag',tag));
    return row;
  }
  function savedToggle(kind,id,title) {
    const key=keyOf(kind,id),b=button('',()=>{
      const saved=stored.saved.includes(key);stored.saved=saved?stored.saved.filter(x=>x!==key):[...stored.saved,key];
      stored.titles[key]=title;persist();paint();renderSidebar();toast(saved?'已移除书签':'已加入我的书签');
    });
    function paint(){const saved=stored.saved.includes(key);b.textContent=saved?'★ 已加书签':'☆ 加入书签';b.setAttribute('aria-pressed',String(saved));}
    paint();return b;
  }

  // HTML is rendered on the authenticated local server; strip active markup and
  // untrusted URL schemes again before inserting paper or chapter content.
  function safeFragment(html) {
    const template=document.createElement('template');template.innerHTML=typeof html==='string'?html:'';
    for(const el of template.content.querySelectorAll('script,style,iframe,object,embed,base,meta,link,form,svg'))el.remove();
    for(const el of template.content.querySelectorAll('*')) {
      for(const attr of [...el.attributes]) {
        if(/^on/i.test(attr.name) || ['srcdoc','contenteditable','formaction','autofocus'].includes(attr.name.toLowerCase()))el.removeAttribute(attr.name);
      }
      if(el.tagName==='INPUT' && el.type!=='checkbox'){el.remove();continue;}
      if(el.tagName==='A') {
        const href=el.getAttribute('href')||'';
        if(href && !/^(?:https?:\/\/|#|\/(?!\/))/i.test(href))el.removeAttribute('href');
        el.removeAttribute('target');el.setAttribute('rel','noopener noreferrer');
      }
      if(el.tagName==='IMG') {
        const src=el.getAttribute('src')||'';
        if(!/^\/(?!\/)/.test(src)){el.remove();continue;}
        el.setAttribute('loading','lazy');
      }
    }
    return template.content;
  }
  function fillArticle(article,html,title) {
    const content=safeFragment(html);
    const heading=content.querySelector('h1');
    if(heading && title && heading.textContent.trim()===title.trim())heading.remove();
    article.replaceChildren(content);
    for(const table of article.querySelectorAll('table'))if(!table.parentElement.classList.contains('table-wrap')){const wrap=node('div','table-wrap');table.before(wrap);wrap.append(table);}
    ResearchUI.paintMath(article);
  }
  function page(title,eyebrow,summary) {
    const root=node('section','manual-page');
    if(eyebrow)root.append(node('p','manual-eyebrow',eyebrow));
    root.append(node('h1','',title));if(summary)root.append(node('p','manual-lead',summary));
    $('manual-view').replaceChildren(root);return root;
  }
  function empty(message) {return node('p','manual-empty',message);}
  function chapterCard(chapter) {
    const a=routeLink('chapter',chapter.id,null,'manual-card');a.append(node('strong','',chapter.title||chapter.id),node('p','',chapter.summary||''));
    a.append(tagsRow(chapter.tags));return a;
  }
  function sourceCard(source) {
    const a=routeLink('source',source.id,null,'manual-card');a.append(node('strong','',source.title||source.id));
    a.append(node('small','',joinMeta([source.year,source.doi])));
    const meta=node('div','manual-meta');
    if(source.has_pdf || source.zotero?.attachment_key)meta.append(node('span','manual-badge','Zotero PDF'));
    a.append(meta);if(source.snippet)a.append(node('p','',source.snippet));return a;
  }
  function caseCard(item) {
    const a=routeLink('case',item.id,null,'manual-card');a.append(node('strong','',item.title||item.name||item.id),node('p','',item.summary||item.description||''));
    const meta=tagsRow(item.tags);meta.append(evidenceBadge(item));a.append(meta);return a;
  }

  function renderSidebar() {
    if(!data.index)return;
    const chapters=array(data.index.chapters),topic=$('manual-topic').value,q=$('manual-chapter-filter').value.trim().toLocaleLowerCase();
    $('manual-chapter-count').textContent=chapters.length+' 章';
    const list=$('manual-chapter-list');list.replaceChildren();let lastGroup=null,count=0;
    for(const chapter of chapters) {
      if(topic && chapter.group!==topic && !array(chapter.tags).includes(topic))continue;
      if(q && ![chapter.title,chapter.summary,...array(chapter.tags)].join(' ').toLocaleLowerCase().includes(q))continue;
      const group=chapter.group||'仿真指南';if(group!==lastGroup){list.append(node('p','manual-chapter-group',group));lastGroup=group;}
      const a=routeLink('chapter',chapter.id,chapter.title||chapter.id,'manual-chapter-link');
      if(data.route?.kind==='chapter' && data.route.id===chapter.id)a.setAttribute('aria-current','page');
      if(stored.saved.includes(keyOf('chapter',chapter.id)))a.prepend(node('span','manual-chapter-star','★'));
      list.append(a);count++;
    }
    if(!count)list.append(empty('没有匹配的章节。'));
  }
  $('manual-topic').addEventListener('change',renderSidebar);$('manual-chapter-filter').addEventListener('input',renderSidebar);

  function renderHome() {
    const index=data.index,root=page(index.title||'超表面仿真手册','RESEARCH NOTEBOOK / ENGINEERING HANDBOOK',index.summary||'把研究需求转成可复查的几何、设置、实验与结果。先选场景，再沿操作步骤进入文献证据。');
    const exportBar=node('div','manual-toolbar'),exportLink=node('a','manual-button primary','导出整本手册');
    exportLink.href='/api/manual/export';exportLink.download='MetasurfaceSimulationManual.zip';
    exportBar.append(exportLink,node('small','manual-muted','Markdown 正文、参数案例和文献设计卡'));root.append(exportBar);
    const grid=node('div','manual-stat-grid');
    for(const [value,label] of [[array(index.chapters).length,'详细操作章节'],[array(index.sources).length,'关联文献与设计卡'],[array(index.cases).length,'参数化种子案例']]){const stat=node('div','manual-stat');stat.append(node('strong','',value),node('span','',label));grid.append(stat);}root.append(grid);
    if(stored.last?.route && /^#\/(?:chapter|source|case)\/[A-Za-z0-9_.-]+$/.test(stored.last.route)){
      const panel=node('div','manual-panel');panel.append(node('h2','','接着上次读'),node('p','',stored.last.title||'上次阅读位置'));
      const resume=node('a','manual-button','继续阅读');resume.href=stored.last.route;resume.dataset.resume='true';panel.append(resume);root.append(panel);
    }
    const notice=node('div','manual-panel manual-warning');notice.append(node('h2','','如何使用手册'),node('p','','从设计目标或遇到的问题进入章节，再结合案例的尺寸、材料和激励开展仿真。'));root.append(notice);
    root.append(node('h2','manual-section-label','从你要解决的问题开始'));
    const scenarios=node('div','manual-scenario-grid');
    const definitions=[['复现一篇论文','结构与参数核对 → 单元幅相 → 原尺寸阵列 → 原文对照',/需求|合同|复现/],['从场景设计结构','定量指标 → 结构路线 → 低成本基线 → 有界优化',/选型|机理|需求/],['修复现有工程','保留源工程 → 几何与端口审计 → 受控实验 → 前后对比',/优化流程|诊断|调试|几何/],['准备实物与测量','器件与偏置 → 公差 → 装配 → 校准与失效检查',/制造|实测|测量/]];
    for(const [title,desc,pattern] of definitions){const chapter=array(index.chapters).find(c=>pattern.test(c.title||''))||array(index.chapters)[0];const a=routeLink(chapter?'chapter':'chapters',chapter?.id,null,'manual-scenario');a.append(node('strong','',title),node('span','',desc));scenarios.append(a);}root.append(scenarios);
    root.append(node('h2','manual-section-label','操作指南'));
    const list=node('div','manual-card-grid');for(const c of array(index.chapters).slice(0,6))list.append(chapterCard(c));root.append(list,routeLink('chapters',null,'查看全部章节 →','manual-button quiet'));
    const panel=node('div','manual-panel');panel.append(node('h2','','如何使用这本手册'),node('p','','先阅读适用条件与激励约定，再设置几何、材料、端口和求解器。遇到异常，沿检查步骤定位变量，并打开关联论文核对页码或图号。'),node('p','','每章勾选属于个人工作记录；书签、折叠状态与继续阅读只写入浏览器，不会改变手册正文、论文设计卡或已有笔记。'));root.append(panel);
  }

  function renderChapters() {
    const root=page('按场景查操作方法','GUIDES','从基础设置到器件、馈电、阵列、制造与验证；每章包含操作顺序、诊断与文献案例。');
    const controls=node('div','manual-library-controls'),filter=node('input');filter.type='search';filter.placeholder='筛选章节标题、标签或摘要';filter.setAttribute('aria-label','筛选操作指南');
    const topic=node('select');topic.setAttribute('aria-label','选择指南专题');topic.append(new Option('全部专题',''));
    for(const g of [...new Set(array(data.index.chapters).map(x=>x.group).filter(Boolean))])topic.append(new Option(g,g));
    controls.append(filter,topic);root.append(controls);const list=node('div','manual-card-grid'),count=node('p','manual-count');root.append(count,list);
    const paint=()=>{list.replaceChildren();const q=filter.value.trim().toLocaleLowerCase(),items=array(data.index.chapters).filter(c=>(!topic.value||c.group===topic.value)&&(!q||[c.title,c.summary,...array(c.tags)].join(' ').toLocaleLowerCase().includes(q)));count.textContent=items.length+' 章';for(const c of items)list.append(chapterCard(c));if(!items.length)list.append(empty('没有符合条件的操作指南。'));};filter.oninput=paint;topic.onchange=paint;paint();
  }
  function renderLibrary(kind,onlySaved=false) {
    const isSources=kind==='source',items=isSources?array(data.index.sources):array(data.index.cases);
    const root=page(onlySaved?'我的书签':isSources?'文献证据库':'参数化案例库',isSources?'SOURCES / EVIDENCE':'CASES / PARAMETERS',onlySaved?'只保存阅读入口，原文和设计卡保留在各自位置。':isSources?'从设计卡进入论文原文、页码和关键图。':'查看案例的结构、材料、尺寸和激励，选择适合的设计进行仿真。');
    const controls=node('div','manual-library-controls'),filter=node('input');filter.type='search';filter.placeholder=isSources?'题名、DOI、结构或工程标签':'案例名称、结构或标签';filter.setAttribute('aria-label',isSources?'筛选文献证据':'筛选案例');
    const category=node('select');category.setAttribute('aria-label','按类别筛选');category.append(new Option('全部类别',''));for(const value of [...new Set(items.map(s=>s.category||s.primary_category||s.group).filter(Boolean))].sort())category.append(new Option(value,value));
    const pdf=node('select');pdf.setAttribute('aria-label','全文可用性');pdf.append(new Option('全部全文状态',''),new Option('已关联 PDF','pdf'));
    controls.append(filter,category);if(isSources)controls.append(pdf);root.append(controls);
    const count=node('p','manual-count'),list=node('div','manual-card-list'),more=node('div','manual-list-more');root.append(count,list,more);let limit=40;
    function paint(reset=true){if(reset)limit=40;list.replaceChildren();more.replaceChildren();const q=filter.value.trim().toLocaleLowerCase();const selected=items.filter(s=>(!onlySaved||stored.saved.includes(keyOf(kind,s.id)))&&(!category.value||(s.category||s.primary_category||s.group)===category.value)&&(!pdf.value||s.has_pdf||s.zotero?.attachment_key)&&(!q||[s.id,s.title,s.name,s.summary,s.doi,s.year,...array(s.tags)].join(' ').toLocaleLowerCase().includes(q)));count.textContent=selected.length+(isSources?' 篇文献':' 个案例');for(const item of selected.slice(0,limit))list.append(isSources?sourceCard(item):caseCard(item));if(selected.length>limit)more.append(button('加载更多（'+Math.min(limit,selected.length)+' / '+selected.length+'）',()=>{limit+=40;paint(false);}));if(!selected.length)list.append(empty('没有符合筛选条件的条目。'));}
    filter.oninput=()=>paint();category.onchange=()=>paint();pdf.onchange=()=>paint();paint();
  }
  function renderSaved() {
    const root=page('我的书签','MY WORKSPACE','书签与个人勾选只保存于当前浏览器，不修改论文和手册。');let count=0;
    for(const [kind,title,items,make] of [['chapter','操作指南',array(data.index.chapters),chapterCard],['case','参数案例',array(data.index.cases),caseCard],['source','文献证据',array(data.index.sources),sourceCard]]){
      const selected=items.filter(x=>stored.saved.includes(keyOf(kind,x.id)));if(!selected.length)continue;count+=selected.length;root.append(node('h2','manual-section-label',title));const list=node('div','manual-card-list');for(const item of selected)list.append(make(item));root.append(list);
    }
    if(!count)root.append(empty('打开任意章节、案例或文献后，点击“加入书签”即可收藏。'));
  }

  async function detail(kind,id) {
    const key=keyOf(kind,id);if(data.cache.has(key)){const cached=data.cache.get(key);data.cache.delete(key);data.cache.set(key,cached);return cached;}
    const response=await api('/api/manual/'+({chapter:'chapters',source:'sources',case:'cases'}[kind])+'/'+encodeURIComponent(id));rememberRecord(key,response);return response;
  }
  function toolbar(root,kind,item) {
    const bar=node('div','manual-toolbar');bar.append(savedToggle(kind,item.id,item.title||item.id));
    bar.append(button('新建实验笔记',()=>openNoteDialog(kind,item),'manual-button primary'));
    bar.append(button('复制当前内容',async()=>copyText(item.markdown||item.card_markdown||$('manual-view').innerText)));
    bar.append(button('打印当前页',printCurrent));root.append(bar);return bar;
  }
  function copyText(value) {
    const str=text(value);
    if(navigator.clipboard?.writeText)return navigator.clipboard.writeText(str).then(()=>toast('已复制')).catch(()=>fallbackCopy(str));
    return fallbackCopy(str);
  }
  function fallbackCopy(value) {
    const input=node('textarea');input.value=value;input.style.cssText='position:fixed;left:-10000px;top:0;';document.body.append(input);input.select();let success=false;try{success=document.execCommand('copy');}catch(_){}input.remove();toast(success?'已复制':'复制未完成，请选中内容后按 Ctrl+C。');return Promise.resolve();
  }
  function printCurrent() {
    data.printState=[...document.querySelectorAll('#manual-view details')].map(d=>[d,d.open]);for(const [d] of data.printState)d.open=true;window.print();
  }
  window.addEventListener('afterprint',()=>{for(const [d,open] of data.printState||[])d.open=open;data.printState=null;});
  function sourceLinks(ids) {
    const panel=node('div','manual-panel');panel.append(node('h2','','关联文献'));const links=node('div','manual-related-links');
    for(const raw of [...new Set(array(ids).map(x=>typeof x==='string'?x:x?.id).filter(asID))]){const source=array(data.index.sources).find(s=>s.id===raw);const a=routeLink('source',raw,source?raw+' · '+clip(source.title,48):raw);links.append(a);}if(!links.children.length)return null;panel.append(links);return panel;
  }
  function foldArticle(article,kind,id) {
    const headings=[...article.querySelectorAll('h2,h3')],toc=node('details','manual-toc');toc.open=false;const nav=node('nav');nav.setAttribute('aria-label','当前章节目录');toc.append(node('summary','','本章目录（'+headings.length+'）'),nav);
    const key=keyOf(kind,id);let sectionIndex=0;
    for(const [i,h] of headings.entries()){
      if(!h.id)h.id='manual-heading-'+i;
      const jump=button(h.textContent,()=>{const enclosing=h.closest('details');if(enclosing)enclosing.open=true;h.scrollIntoView({block:'start',behavior:'smooth'});},'');jump.dataset.depth=h.tagName.slice(1);nav.append(jump);
    }
    for(const h of [...article.children].filter(e=>e.tagName==='H2')) {
      const fold=node('details','manual-section'),summary=node('summary','',h.textContent),body=node('div','manual-section-body');const position=sectionIndex++;const stateKey=key+':'+position;
      const referenceChapter=kind==='chapter' && /^(31-decisions|32-diagnostics|33-parameters|34-comparison-a|35-comparison-b|36-rule-boundaries)$/.test(id);
      const defaultOpen=!(referenceChapter || (kind==='case' && /^原始记录/.test(h.textContent.trim())));
      fold.open=Object.prototype.hasOwnProperty.call(stored.folds,stateKey)?stored.folds[stateKey]!==false:defaultOpen;
      h.before(fold);fold.append(summary,body);h.classList.add('manual-sr-only');body.append(h);
      while(fold.nextElementSibling && fold.nextElementSibling.tagName!=='H2')body.append(fold.nextElementSibling);
      const actions=node('div','manual-section-actions');actions.append(button('复制这一节',()=>copyText(body.innerText.replace(/^复制这一节\s*/,''))));body.prepend(actions);
      fold.addEventListener('toggle',()=>{if(data.printState)return;stored.folds[stateKey]=fold.open;persist();});
    }
    for(const [i,input] of [...article.querySelectorAll('input[type=checkbox]')].entries()){
      const checkKey=key+':body:'+i;input.disabled=false;input.checked=checkKey in stored.checks?stored.checks[checkKey]===true:input.checked;
      input.addEventListener('change',()=>{stored.checks[checkKey]=input.checked;persist();});
      input.setAttribute('aria-label',input.closest('li')?.textContent.trim()||'正文工作项 '+(i+1));
    }
    return headings.length?toc:null;
  }
  function progressPanel(kind,id) {
    const panel=node('section','manual-panel manual-progress');panel.append(node('h2','','我的工作检查'),node('p','','根据当前任务勾选已完成的步骤。'));
    const labels=['已确认本方法适用的结构与工作条件','已核对激励、端口、参考面和材料','已记录网格、功率与目标指标的检查结果','已保存工程版本、来源和实际 RunID'];
    labels.forEach((label,i)=>{const key=keyOf(kind,id)+':progress:'+i,wrap=node('label'),check=node('input');check.type='checkbox';check.checked=stored.checks[key]===true;check.onchange=()=>{stored.checks[key]=check.checked;persist();};wrap.append(check,node('span','',label));panel.append(wrap);});return panel;
  }
  function renderChapter(item) {
    const meta=array(data.index.chapters).find(c=>c.id===item.id)||{},root=page(item.title||meta.title||item.id,meta.group||'操作指南',item.summary||meta.summary);
    root.append(tagsRow(item.tags||meta.tags));const bar=toolbar(root,'chapter',item);
    const title=item.title||meta.title||item.id;
    const article=node('article','prose manual-prose selectable');fillArticle(article,item.html||'',title);
    if(!article.children.length)article.append(node('p','','这一章节暂未提供可读正文，请稍后刷新。'));
    const toc=foldArticle(article,'chapter',item.id);if(toc)root.append(toc);
    bar.append(button('展开 / 收起全部',()=>{const sections=[...article.querySelectorAll('details.manual-section')],open=sections.some(x=>!x.open);for(const d of sections)d.open=open;}));
    root.append(article,progressPanel('chapter',item.id));const refs=sourceLinks(item.sources||meta.sources);if(refs)root.append(refs);
    const chapters=array(data.index.chapters),position=chapters.findIndex(c=>c.id===item.id),navigation=node('nav','manual-page-nav');navigation.setAttribute('aria-label','前后章节');
    if(position>0){const a=routeLink('chapter',chapters[position-1].id);a.append(node('small','','← 上一章'),node('span','',chapters[position-1].title));navigation.append(a);}else navigation.append(node('span'));
    if(position>=0 && position<chapters.length-1){const a=routeLink('chapter',chapters[position+1].id);a.append(node('small','','下一章 →'),node('span','',chapters[position+1].title));navigation.append(a);}root.append(navigation);
  }
  function renderSource(item) {
    const root=page(item.title||item.id,'文献精读','');
    root.append(node('p','manual-source-meta',joinMeta([item.year,item.author,item.venue])));
    if(item.doi){const line=node('p','manual-source-meta'),a=node('a','',item.doi);a.href='https://doi.org/'+encodeURIComponent(item.doi).replace(/%2F/gi,'/');line.append(node('span','','DOI：'),a);root.append(line);}
    toolbar(root,'source',item);
    const notice=node('p','manual-evidence-notice','输入页码可直接定位原文。');root.append(notice);
    const actions=node('div','manual-pdf-actions'),pageInput=node('input');pageInput.type='number';pageInput.min='1';pageInput.step='1';pageInput.placeholder='页码';pageInput.setAttribute('aria-label','打开 PDF 的页码（可选）');
    const hasPDF=item.has_pdf===true || !!item.zotero?.attachment_key;
    const open=button(hasPDF?'在 Zotero 打开 PDF':'尝试打开关联文献',async()=>{
      const raw=pageInput.value.trim(),pageNumber=raw?Number(raw):null;if(raw && (!Number.isInteger(pageNumber)||pageNumber<1)){toast('请输入正整数页码');pageInput.focus();return;}
      open.disabled=true;try{const result=await api('/api/manual/open-source',{id:item.id,...(pageNumber?{page:pageNumber}:{})});if(result.opened===false || result.ok===false)throw new Error(result.message||'未能打开 PDF；请检查 Zotero 是否运行及附件状态。');toast('已请求 Zotero 打开文献'+(pageNumber?' · 第 '+pageNumber+' 页':''));}catch(error){toast(error.message);}finally{open.disabled=false;}
    },'manual-button primary');actions.append(open,pageInput);root.append(actions);
    const article=node('article','prose manual-prose selectable');fillArticle(article,item.card_html||item.html||'',item.title||item.id);
    if(!article.children.length)article.append(node('p','','此来源暂未提供设计卡正文。'));const toc=foldArticle(article,'source',item.id);if(toc)root.append(toc);root.append(article);
    const related=array(data.index.chapters).filter(c=>array(c.sources).includes(item.id));if(related.length){root.append(node('h2','manual-section-label','在哪些章节使用了这篇论文'));const list=node('div','manual-card-list');for(const chapter of related)list.append(chapterCard(chapter));root.append(list);}
  }
  function parameterRows(parameters,prefix='') {
    const rows=[];if(!parameters || typeof parameters!=='object')return rows;
    const entries=Array.isArray(parameters)?parameters.map((v,i)=>[String(i+1),v]):Object.entries(parameters);
    for(const [key,value] of entries) {
      const name=prefix?prefix+'.'+key:key;
      if(value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).length<=12 && !('value' in value))rows.push(...parameterRows(value,name));
      else rows.push([name,value && typeof value==='object'?JSON.stringify(value):text(value)]);
    }
    return rows.slice(0,150);
  }
  function renderCase(item) {
    const root=page(item.title||item.name||item.id,'参数化案例 · '+item.id,item.summary||item.description||'');root.append(evidenceBadge(item));toolbar(root,'case',item);
    root.append(node('p','manual-evidence-notice','建模前检查材料、尺寸、端口和器件参数，补齐缺项后进行仿真。'));
    const params=item.parameters||item.model?.parameters||item.recipe?.parameters||item.metadata?.parameters;
    if(params){root.append(node('h2','manual-section-label','参数与层叠'));const wrap=node('div','manual-table-wrap'),table=node('table','manual-table'),head=node('thead'),tr=node('tr');tr.append(node('th','','参数 / 字段'),node('th','','值与单位（以原记录为准）'));head.append(tr);table.append(head);const body=node('tbody');for(const [key,value] of parameterRows(params)){const row=node('tr');row.append(node('td','',key),node('td','',value));body.append(row);}table.append(body);wrap.append(table);root.append(wrap);}
    const article=node('article','prose manual-prose selectable');fillArticle(article,item.html||item.card_html||'',item.title||item.name||item.id);
    if(!article.children.length){const known=[['适用条件',item.conditions||item.scope],['缺项与风险',item.missing||item.missing_or_uncertain||item.blockers],['优化变量',item.optimization_variables||item.editable_parameters],['激励与边界',item.excitation||item.simulation_settings]];for(const [title,value] of known)if(value){article.append(node('h2','',title),node('p','',typeof value==='string'?value:JSON.stringify(value,null,2)));}}
    const toc=foldArticle(article,'case',item.id);if(toc)root.append(toc);root.append(article,progressPanel('case',item.id));const refs=sourceLinks(item.sources||item.source_ids||(item.source_id?[item.source_id]:[]));if(refs)root.append(refs);
  }

  function renderCalculator() {
    const root=page('辅助计算','ANALYTICAL CHECKS','用于量纲、截止频率与波束方向的初步检查。结果不包含互耦、幅度、损耗、效率或有限尺寸效应。');
    const form=node('form','manual-calculator');form.addEventListener('submit',event=>event.preventDefault());
    function field(container,label,value,min,step='any'){const wrap=node('label','',label),input=node('input');input.type='number';input.value=value;input.step=step;if(min!=null)input.min=min;wrap.append(input);container.append(wrap);return input;}
    function section(title,formula,limit){const group=node('fieldset');group.append(node('legend','',title));const fields=node('div','manual-calc-fields'),output=node('output');output.setAttribute('aria-live','polite');group.append(fields,output,node('p','manual-calc-formula',formula),node('p','manual-calc-limit',limit));form.append(group);return {fields,output};}
    const wave=section('波长与电尺寸','λ₀(mm) = 299.792458 / f(GHz)；λd = λ₀ / √εr','λd 适用于均匀、各向同性、无磁且忽略损耗的介质；不是表面波或导波波长。');
    const frequency=field(wave.fields,'频率 / GHz',10,.000001),eps=field(wave.fields,'相对介电常数 εr',1,.000001),size=field(wave.fields,'结构尺寸 / mm',5,0);
    const diffraction=section('方形周期的首个空气衍射通道','fc(GHz) = 299.792458 / [p(mm) · (1 + |sin θi|)]','仅限空气入射与出射、方形晶格、入射面沿晶格主轴，计算最早开放的一阶通道；正入射 θi=0 时 fc=c/p。介质侧、高对称方向或非方格须重新枚举 Floquet 阶次。');
    const period=field(diffraction.fields,'周期 p / mm',12,.000001),angle=field(diffraction.fields,'入射角 θi / °',0,-89.999);angle.max='89.999';
    const phase=section('反射相位梯度的运动学方向','sin θr = sin θi − λ₀ Δφ / (360 p)','采用 exp(+jωt)、沿 +x 的复反射系数相位增加 Δφ、p 为相位步长间距，θ 由 +x 分量的符号定义。标量无限孔径近似；超出 |sin θr|≤1 表示该指定通道不传播，不保证无其他衍射波。');
    const pf=field(phase.fields,'频率 / GHz',10,.000001),pp=field(phase.fields,'相邻相位间距 p / mm',5,.000001),dp=field(phase.fields,'沿 +x 相位差 Δφ / °',45,null),pi=field(phase.fields,'入射角 θi / °',0,-89.999);pi.max='89.999';
    function number(input,{positive=false,nonnegative=false,angle=false}={}){const value=input.value.trim()?Number(input.value):NaN;if(!Number.isFinite(value)||(positive&&value<=0)||(nonnegative&&value<0)||(angle&&Math.abs(value)>=90))throw new Error('请输入有效数值'+(angle?'（角度绝对值小于90°）':''));return value;}
    function update(){
      try{const f=number(frequency,{positive:true}),er=number(eps,{positive:true}),s=number(size,{nonnegative:true}),lambda=299.792458/f;wave.output.textContent='λ₀ = '+lambda.toFixed(4)+' mm；λd = '+(lambda/Math.sqrt(er)).toFixed(4)+' mm；尺寸 / λ₀ = '+(s/lambda).toFixed(4);}catch(e){wave.output.textContent=e.message;}
      try{const p=number(period,{positive:true}),a=number(angle,{angle:true});diffraction.output.textContent='首级空气通道截止 ≈ '+(299.792458/(p*(1+Math.abs(Math.sin(a*Math.PI/180))))).toFixed(4)+' GHz';}catch(e){diffraction.output.textContent=e.message;}
      try{const f=number(pf,{positive:true}),p=number(pp,{positive:true}),delta=number(dp),a=number(pi,{angle:true}),s=Math.sin(a*Math.PI/180)-(299.792458/f)*delta/(360*p);phase.output.textContent=Math.abs(s)<=1?'θr ≈ '+(Math.asin(s)*180/Math.PI).toFixed(3)+'°；sin θr = '+s.toFixed(5):'指定反射通道不传播：sin θr = '+s.toFixed(5)+'，超出 [-1, 1]';}catch(e){phase.output.textContent=e.message;}
    }
    form.addEventListener('input',update);root.append(form);update();
    const sources=node('div','manual-panel');sources.append(node('h2','','计算后继续检查'),node('p','','波长只用于初选尺度；截止只判断通道是否可以传播；相位梯度只给出可能方向。实际幅相、交叉极化、功率、旁瓣和有限阵列响应仍需原生全波结果。'));root.append(sources);
  }

  function parseRoute() {
    const raw=location.hash||'#/home',path=raw.replace(/^#\/?/,'').split('?')[0],parts=path.split('/').filter(Boolean);let id;
    try{id=parts[1]?decodeURIComponent(parts[1]):null;}catch(_){return {kind:'home',id:null};}
    const kind=parts[0]||'home';
    if(['chapter','source','case'].includes(kind))return asID(id)&&parts.length===2?{kind,id}:{kind:'home',id:null};
    return ['home','chapters','sources','cases','calculator','saved'].includes(kind)&&parts.length===1?{kind,id:null}:{kind:'home',id:null};
  }
  let resumeRoute=null;
  async function route() {
    if(!data.index)return;
    rememberPosition();clearTimeout(data.saveTimer);persist();
    const current=parseRoute(),run=++data.navRun;data.route=current;data.current=null;clearError();$('manual-loading').hidden=true;
    for(const a of document.querySelectorAll('#manual-top-nav [data-view]')){const active=a.dataset.view===({chapter:'chapters',source:'sources',case:'cases'}[current.kind]||current.kind);if(active)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');}
    renderSidebar();$('manual-search-results').hidden=true;
    try {
      if(['chapter','source','case'].includes(current.kind)) {
        $('manual-view').replaceChildren(node('div','manual-loading','正在读取'+({chapter:'章节',source:'文献证据',case:'案例'}[current.kind])+'…'));
        const item=await detail(current.kind,current.id);if(run!==data.navRun)return;
        item.id=item.id||current.id;data.current=item;
        if(current.kind==='chapter')renderChapter(item);else if(current.kind==='source')renderSource(item);else renderCase(item);
        const title=item.title||item.name||item.id;stored.last={route:'#/'+current.kind+'/'+current.id,title,at:new Date().toISOString()};stored.titles[keyOf(current.kind,current.id)]=title;persist();document.title=title+' · 超表面仿真手册';
      }else {
        if(current.kind==='home')renderHome();else if(current.kind==='chapters')renderChapters();else if(current.kind==='sources')renderLibrary('source');else if(current.kind==='cases')renderLibrary('case');else if(current.kind==='saved')renderSaved();else renderCalculator();document.title='超表面仿真手册 · 科研笔记仓库';
      }
      if(run!==data.navRun)return;
      const key=keyOf(current.kind,current.id),position=resumeRoute===location.hash?stored.positions[key]||0:0;resumeRoute=null;
      requestAnimationFrame(()=>{if(run===data.navRun)window.scrollTo({top:position,behavior:'instant'});});
      status(current.kind==='chapter'?'来源、步骤与个人检查项已载入':'无需 AI 服务即可阅读');
    } catch(error) {
      if(run!==data.navRun)return;const root=page('这页暂未打开','LOCAL HANDBOOK',error.message);root.append(button('重新读取',()=>{data.cache.delete(keyOf(current.kind,current.id));route();}),routeLink('home',null,'回到手册概览','manual-button'));status('读取失败，请检查本地服务或稍后重试。');
    }
  }
  window.addEventListener('hashchange',route);
  document.addEventListener('click',event=>{
    const a=event.target.closest('a');if(!a || event.button!==0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)return;
    if(a.dataset.resume)resumeRoute=a.getAttribute('href');
    const href=a.getAttribute('href')||'';
    if(href.startsWith('#/')) {
      if(window.matchMedia('(max-width:700px)').matches)$('manual-nav-details').open=false;
      if(href===location.hash){event.preventDefault();route();}
    }
  });

  async function search() {
    const query=$('manual-search').value.trim(),run=++data.searchRun;$('manual-clear-search').hidden=!query;
    if(!query){$('manual-search-results').hidden=true;return;}
    $('manual-search-results').hidden=false;$('manual-search-heading').textContent='正在搜索“'+query+'”…';$('manual-search-items').replaceChildren();
    try {
      const response=await api('/api/manual/search?q='+encodeURIComponent(query));if(run!==data.searchRun)return;
      const groups=[['chapter','操作指南',array(response.chapters)],['case','参数案例',array(response.cases)],['source','文献证据',array(response.sources)]];let count=0;
      for(const [kind,label,items] of groups) {
        if(!items.length)continue;count+=items.length;$('manual-search-items').append(node('h3','',label+' · '+items.length));
        for(const item of items.slice(0,10)){
          if(!asID(item.id))continue;const link=routeLink(kind,item.id,null,'manual-search-result');link.append(node('strong','',item.title||item.id));
          if(item.snippet||item.summary)link.append(node('span','',clip(item.snippet||item.summary,220)));$('manual-search-items').append(link);
        }
      }
      $('manual-search-heading').textContent='“'+query+'” · '+count+' 个匹配';if(!count)$('manual-search-items').append(empty('未找到匹配。试试结构名、端口、边界、器件或异常现象。'));
    }catch(error){if(run===data.searchRun){$('manual-search-heading').textContent='搜索未完成';$('manual-search-items').replaceChildren(node('p','manual-muted',error.message),button('重试搜索',search));}}
  }
  $('manual-search').addEventListener('input',()=>{clearTimeout(data.searchTimer);data.searchRun++;$('manual-clear-search').hidden=!$('manual-search').value;if(!$('manual-search').value.trim()){$('manual-search-results').hidden=true;return;}data.searchTimer=setTimeout(search,180);});
  function closeSearch(clear=false){clearTimeout(data.searchTimer);data.searchRun++;$('manual-search-results').hidden=true;if(clear){$('manual-search').value='';$('manual-clear-search').hidden=true;}}
  $('manual-clear-search').onclick=()=>{closeSearch(true);$('manual-search').focus();};$('manual-close-search').onclick=()=>closeSearch();
  document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();$('manual-search').focus();$('manual-search').select();}if(event.key==='Escape'&&!$('manual-note-dialog').open)closeSearch();});

  function openNoteDialog(kind,item) {
    const title=item.title||item.name||item.id,selected=window.getSelection()?.toString().trim();noteContext={kind,id:item.id,title};
    const date=new Date().toLocaleDateString('zh-CN');$('manual-note-title').value=clip('仿真实验 · '+title,85).replace(/[<>:"/\\|?*]/g,' ');
    $('manual-note-body').value='# '+title+' · 实验记录\n\n日期：'+date+'\n\n手册入口：'+location.origin+'/manual#/'+kind+'/'+encodeURIComponent(item.id)+'\n\n'+(selected?'## 本次关注\n\n'+selected.slice(0,12000)+'\n\n':'')+'## 需求与验收指标\n\n- 工作频段、极化与入射条件：\n- 单元目标：\n- 有限阵列目标：\n- 锁定条件与求解预算：\n\n## 建模与仿真设置\n\n- 材料、层叠、尺寸与器件模型：\n- 激励、端口、参考面与功率约定：\n- 边界、求解器、网格与收敛：\n\n## 参数实验与异常\n\n| 版本 / RunID | 改动 | 物理依据 | 结果与下一步 |\n| --- | --- | --- | --- |\n| | | | |\n\n## 验证与交付\n\n- 几何检查：待做\n- 网格 / 模数 / 频率采样敏感性：待做\n- 功率与有限尺寸核验：待做\n- 原工程 / 工作副本 / 导出路径：\n- 论文证据与工程推断：\n';
    $('manual-note-status').textContent='';$('manual-note-status').className='';$('manual-note-submit').disabled=false;$('manual-note-dialog').showModal();$('manual-note-title').focus();
  }
  function closeNoteDialog(){if(!noteSaving)$('manual-note-dialog').close();}
  $('manual-note-close').onclick=closeNoteDialog;$('manual-note-cancel').onclick=closeNoteDialog;
  $('manual-note-dialog').addEventListener('cancel',event=>{if(noteSaving)event.preventDefault();});
  $('manual-note-form').addEventListener('submit',async event=>{
    event.preventDefault();if(noteSaving||!noteContext)return;const title=$('manual-note-title').value.trim(),content=$('manual-note-body').value;
    if(!title||!content.trim())return;noteSaving=true;$('manual-note-submit').disabled=true;$('manual-note-status').className='';$('manual-note-status').textContent='正在创建独立笔记…';
    try {
      const result=await api('/api/notes',{title,folder:'实验记录',tags:['超表面仿真',noteContext.id],content});
      $('manual-note-status').replaceChildren(node('span','','已创建，编号 '+result.id+'。'));
      if(asID(result.id))$('manual-note-status').append(button('在仓库查看',()=>{
        if(window.parent!==window)window.parent.postMessage({type:'research-manual-open-note',note_id:result.id},location.origin);
        else location.assign('/dock?pane=notes&note='+encodeURIComponent(result.id));
        $('manual-note-dialog').close();
      }));
      // A successful creation is immutable here. A second submit must be an
      // intentional new dialog, never a duplicate request from this form.
      noteContext=null;toast('实验笔记已创建');status('实验记录已保存到仓库，手册正文保持原样。');
    }catch(error){$('manual-note-status').className='error';$('manual-note-status').textContent=error.message;$('manual-note-submit').disabled=false;}
    finally{noteSaving=false;}
  });

  async function initialize() {
    clearError();$('manual-loading').hidden=false;$('manual-loading').textContent='正在读取手册…';
    try {
      const index=await api('/api/manual');data.index=index;
      index.chapters=array(index.chapters).filter(x=>asID(x.id));index.sources=array(index.sources).filter(x=>asID(x.id));index.cases=array(index.cases).filter(x=>asID(x.id));
      $('manual-version').textContent=index.version||'本地手册';$('manual-version').title=joinMeta([index.version,index.updated]);
      const topic=$('manual-topic');topic.replaceChildren(new Option('全部专题',''));for(const name of [...new Set(index.chapters.flatMap(c=>[c.group,...array(c.tags)]).filter(Boolean))])topic.append(new Option(name,name));
      if(window.matchMedia('(max-width:700px)').matches)$('manual-nav-details').open=false;
      await route();
    }catch(error){$('manual-loading').hidden=true;fail('无法读取本地手册：'+error.message,initialize);}
  }
  initialize();
})();
