'use strict';
const p$=id=>document.getElementById(id), {api:pApi,paintMath:pMath}=ResearchUI;
const paperId=location.pathname.split('/').pop();document.body.dataset.paper=paperId;
let paper, pageData, readingVersion, dirtyReading=false, editingReading=false, generationRun=false, readingSequence=0;
function setReading(value){p$('reading-editor').value=value.content;readingVersion=value.version;p$('paper-reading').innerHTML=value.html;pMath(p$('paper-reading'));dirtyReading=false;}
async function showTab(tab){
  document.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  ['guide','source','reading'].forEach(name=>p$(name+'-view').hidden=name!==tab);
  if(tab==='source')await loadPages();
}
async function loadPages(force=false){
  if(pageData&&!force)return;
  p$('source-message').textContent='正在读取 PDF 文字…';
  try {pageData=await pApi('/api/papers/'+paperId+'/pages');p$('source-message').textContent=pageData.message;
    p$('page-count').textContent=pageData.pages.length? pageData.pages.length+' 页':'';
    renderPages('');p$('page-links').replaceChildren();
    for(const page of pageData.pages){const button=document.createElement('button');button.textContent='第 '+page.number+' 页';button.onclick=async()=>{await showTab('source');p$('page-'+page.number)?.scrollIntoView({block:'start',behavior:'smooth'});};p$('page-links').append(button);}
  }catch(error){p$('source-message').textContent=error.message;pageData=null;}
}
function renderPages(query){
  const container=p$('paper-pages');container.replaceChildren();let matches=0;
  for(const page of pageData?.pages||[]){
    const article=document.createElement('article');article.className='pdf-page';article.id='page-'+page.number;article.dataset.page=page.number;
    const heading=document.createElement('h3');heading.textContent='PDF 第 '+page.number+' 页';
    const body=document.createElement('div');body.className='pdf-text';
    const text=page.text||'本页没有可提取文字，请查看原 PDF。';
    text.split('\n').forEach((line,i)=>{if(i)body.append(document.createTextNode('\n'));const span=document.createElement('span');span.className='pdf-line';if(query){let pos=0,index;const lower=line.toLocaleLowerCase(),q=query.toLocaleLowerCase();while((index=lower.indexOf(q,pos))!==-1){span.append(document.createTextNode(line.slice(pos,index)));const mark=document.createElement('mark');mark.textContent=line.slice(index,index+query.length);span.append(mark);matches++;pos=index+query.length;}span.append(document.createTextNode(line.slice(pos)));}else span.textContent=line;body.append(span);});
    article.append(heading,body);container.append(article);
  }
  p$('find-count').textContent=query?matches+' 处匹配':'';
  if(query)container.querySelector('mark')?.scrollIntoView({block:'center'});
}
p$('paper-find').oninput=()=>renderPages(p$('paper-find').value.trim());
document.querySelectorAll('[data-tab]').forEach(button=>button.onclick=()=>showTab(button.dataset.tab));
p$('import-pdf').onclick=()=>p$('pdf-input').click();
p$('pdf-input').onchange=async()=>{
  const file=p$('pdf-input').files[0];if(!file)return;
  if(file.size>32000000){p$('pdf-status').textContent='请选择 32 MB 以内的 PDF';return;}
  const button=p$('import-pdf');button.disabled=true;p$('pdf-status').textContent='正在导入 PDF…';
  try {const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file);});
    await pApi('/api/papers/'+paperId+'/upload',{data,filename:file.name});pageData=null;paper.has_pdf=true;p$('paper-pdf').hidden=false;p$('pdf-status').textContent='PDF 已导入。请核对题名与本篇文献匹配。';await showTab('source');
  }catch(error){p$('pdf-status').textContent=error.message||'PDF 导入失败';}finally{button.disabled=false;p$('pdf-input').value='';}
};
function modeReading(edit){editingReading=edit;p$('reading-editor').hidden=!edit;p$('paper-reading').hidden=edit;p$('save-reading').hidden=!edit&&!dirtyReading;p$('toggle-reading-edit').textContent=edit?'阅读预览':'编辑笔记';}
p$('toggle-reading-edit').onclick=async()=>{
  if(editingReading){const preview=await pApi('/api/preview',{content:p$('reading-editor').value});p$('paper-reading').innerHTML=preview.html;pMath(p$('paper-reading'));modeReading(false);}else modeReading(true);
};
p$('reading-editor').oninput=()=>{readingSequence++;dirtyReading=true;p$('reading-status').textContent='笔记尚未保存 · Ctrl S 保存';};
async function saveReading(){
  if(!paper)return false;
  const seq=readingSequence;p$('save-reading').disabled=true;
  try {const saved=await pApi('/api/papers/'+paperId+'/reading',{content:p$('reading-editor').value,version:readingVersion});readingVersion=saved.version;if(readingSequence===seq){setReading(saved);p$('reading-status').textContent='精读笔记已保存';}else{p$('reading-status').textContent='之前的修改已保存，刚输入的内容尚未保存';}return !dirtyReading;}catch(error){p$('reading-status').textContent=error.message+'；当前草稿保留';return false;}finally{p$('save-reading').disabled=false;}
}
p$('save-reading').onclick=saveReading;
p$('generate-reading').onclick=async()=>{
  if(generationRun)return;
  if(dirtyReading&&!await saveReading())return;
  generationRun=true;const button=p$('generate-reading');button.disabled=true;p$('reading-status').textContent='正在基于全文生成独立导读，请稍候…';
  try {const data=await pApi('/api/papers/'+paperId+'/analyze',{});
    if(data.truncated)throw new Error('导读未完整生成，未覆盖现有导读');
    const saved=await pApi('/api/papers/'+paperId+'/guide',{version:paper.guide_version,content:data.text});paper.guide_version=saved.version;
    p$('paper-guide').innerHTML=saved.html;pMath(p$('paper-guide'));await showTab('guide');
    p$('reading-status').textContent='导读已单独保存，个人文献笔记未改动';
  }catch(error){p$('reading-status').textContent=error.message;}finally{button.disabled=false;generationRun=false;}
};
window.addEventListener('keydown',event=>{if(event.ctrlKey&&event.key.toLowerCase()==='s'){event.preventDefault();saveReading();}});
window.addEventListener('beforeunload',event=>{if(dirtyReading){event.preventDefault();event.returnValue='';}});
(async()=>{try {paper=await pApi('/api/papers/'+paperId);p$('paper-id').textContent=paperId+(new URLSearchParams(location.search).get('host')==='zotero'?' / Zotero 文献精读':' / 独立精读窗口');p$('paper-title').textContent=paper.title;p$('paper-meta').textContent=paper.author+' · '+paper.year+' · '+paper.venue;p$('paper-badges').textContent=paper.type+'　·　'+(paper.has_pdf?(paper.pdf_source||'已有本地 PDF'):'全文待导入');p$('paper-original').href=paper.url;p$('paper-original').hidden=!/^https?:/.test(paper.url||'');p$('paper-pdf').href='/api/papers/'+paperId+'/pdf';p$('paper-pdf').hidden=!paper.has_pdf;if(paper.zotero){p$('import-pdf').hidden=true;p$('pdf-help').textContent='PDF 由 Zotero 管理，本页直接读取现有附件。选中文字后自动翻译，生成 AI 精读需单独点击。';p$('paper-pdf').textContent='在 Zotero 中打开 PDF ↗';p$('paper-pdf').href='zotero://open-pdf/library/items/'+paper.zotero.attachment_key;p$('pdf-status').textContent='直接使用 Zotero storage 附件';}p$('paper-guide').innerHTML=paper.guide_html;setReading(paper.reading);if(!paper.reading.content)p$('paper-reading').textContent='尚无文献笔记。可以在这里自行记录；AI 生成的导读会单独存放。';document.title=paperId+' · '+paper.title+' · 文献精读';pMath(p$('paper-guide'));}catch(error){p$('paper-title').textContent=error.message;}})();
