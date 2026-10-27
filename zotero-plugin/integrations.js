/* Optional installed-plugin adapters. No third-party code or mirror lists are bundled. */
var ResearchNotebookIntegrations={
  normalize(value){return String(value||'').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu,'');},
  capabilities(){
    let custom=[];
    try{custom=JSON.parse(Zotero.Prefs.get('findPDFs.resolvers')||'[]').map(r=>String(r.name||'自定义来源').slice(0,80));}catch(_){}
    return {jasminum:{available:!!Zotero.Jasminum?.api?.requestDocument,recognition:typeof Zotero.Jasminum?.taskRunner?.createAndAddTask==='function'},
      custom_resolvers:[...new Set(custom)],linter:typeof Zotero.Linter?.hooks?.onLintInBatch==='function',
      easier_citation:typeof Zotero.ZoteroCitation?.api?.citeItems==='function',
      ethereal_reference:!!Zotero.ZoteroReference,ethereal_style:!!Zotero.ZoteroStyle,
      pipeline:['publisher_oa','jasminum_cnki','custom_resolvers']};
  },
  chineseURL(value){
    try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&/(^|\.)(cnki\.net|cnki\.com\.cn)$/.test(url.hostname)?url.href:null;}catch(_){return null;}
  },
  async chineseResolvers(item){
    const url=this.chineseURL(item.getField('url'));
    if(!url||!Zotero.Jasminum?.api?.requestDocument||!Zotero.Translate?.Web)return {resolvers:[],reason:'不适用：需要知网页面及已启用的茉莉花'};
    const doc=await Zotero.Jasminum.api.requestDocument(url,{timeout:20000});
    if(!doc||/captcha|just a moment|安全验证|访问验证|验证码/i.test(doc.title||''))return {resolvers:[],reason:'需要在正常浏览器中完成网站访问验证'};
    const translate=new Zotero.Translate.Web();translate.setDocument(doc);
    const translators=await translate.getTranslators(),selected=translators.find(t=>/CNKI|知网/i.test(t.label||''));
    if(!selected)return {resolvers:[],reason:'未找到适用于此页面的知网 translator'};
    translate.setTranslator(selected);
    // libraryID:false is critical: inspect translator output without creating duplicate parents.
    const rows=await translate.translate({libraryID:false,saveAttachments:false});
    const title=this.normalize(item.getField('title')),doi=String(item.getField('DOI')||'').toLowerCase();
    const match=(rows||[]).find(row=>{
      const candidateDOI=String(row.DOI||'').toLowerCase();
      if(doi&&candidateDOI&&doi!==candidateDOI)return false;
      return (doi&&candidateDOI===doi)||this.normalize(row.title)===title;
    });
    if(!match)return {resolvers:[],reason:'网页题名或 DOI 与原题录不符，未导入'};
    const resolvers=(match.attachments||[]).filter(a=>a.mimeType==='application/pdf'&&this.chineseURL(a.url)).slice(0,3)
      .map(a=>({url:a.url,referrer:url,accessMethod:'茉莉花 / 知网 translator'}));
    return {resolvers,reason:resolvers.length?'':'页面未提供可直接获取的 PDF；保留原题录'};
  },
  async fetchPDF(item,metadata){
    const attempts=[];let attachment=null,path='',sha256='';
    const stage=async(name,makeResolvers)=>{
      const trace={source:name,status:'not_found',methods:[]};attempts.push(trace);
      try{
        const produced=await makeResolvers(),resolvers=Array.isArray(produced)?produced:produced.resolvers;
        if(!resolvers?.length){trace.status='skipped';trace.message=produced.reason||'没有已配置来源';return false;}
        const result=await Zotero.Attachments.addFileFromURLs(item,resolvers,{onAccessMethodStart:method=>{
          const label=String(method||name).slice(0,80);if(!trace.methods.includes(label)&&trace.methods.length<24)trace.methods.push(label);
        }});
        if(result?.attachmentContentType!=='application/pdf')return false;
        const file=await result.getFilePathAsync();if(!file||!await IOUtils.exists(file))return false;
        const bytes=await ResearchNotebookLiterature.pdfBytes(file);
        if(result.parentItemID!==item.id)throw new Error('附件父项不一致');
        attachment=result;path=file;sha256=ResearchNotebookLiterature.sha256(bytes);trace.status='downloaded';return true;
      }catch(error){
        Zotero.logError(error);trace.status='failed';const status=error.status||error.xmlhttp?.status;
        trace.message=[401,403].includes(status)?'来源拒绝访问，需要机构权限或浏览器验证':status===429?'来源限流，未自动反复请求':status===404?'来源链接不存在':'此来源未返回有效 PDF';
        return false;
      }
    };
    if(typeof Zotero.Attachments.addFileFromURLs!=='function'||typeof Zotero.Attachments.getFileResolvers!=='function'){
      attempts.push({source:'Zotero 全文接口',status:'unavailable',message:'当前版本没有兼容的全文接口'});
    }else{
      const direct=(Array.isArray(metadata.pdf_urls)?metadata.pdf_urls:[]).slice(0,6)
        .filter(u=>typeof u==='string'&&/^https:\/\//i.test(u)).map(url=>({url,accessMethod:'检索来源 PDF'}));
      if(!await stage('出版社 / 开放全文',()=>[...direct,...Zotero.Attachments.getFileResolvers(item,['doi','url','oa'])])){
        if(!await stage('茉莉花 / 中文网页',()=>this.chineseResolvers(item))){
          await stage('已配置的扩展解析器',()=>Zotero.Attachments.getFileResolvers(item,['custom']));
        }
      }
    }
    const completed=attempts.filter(a=>a.status!=='skipped');
    const summary=completed.map(a=>a.source+(a.methods?.length?'（'+a.methods.slice(0,6).join('、')+'）':'')+'：'+(a.status==='downloaded'?'已取得':a.message||'未找到')).join('；');
    return {attachment,path,sha256,attempts,message:attachment?summary:summary+'。题录已保留，可补充全文链接或在出版社完成机构访问后重试。'};
  },
  async selected(win){
    const reader=Zotero.Reader?.getByTabID?.(win.Zotero_Tabs?.selectedID);
    const selected=reader?[await Zotero.Items.getAsync(reader.itemID)]:(win.ZoteroPane?.getSelectedItems?.()||[]);
    if(!selected.length)throw new Error('请先在 Zotero 文献列表中选择要处理的文献或附件');
    if(selected.length>20)throw new Error('每次最多处理 20 篇文献');
    return selected;
  },
  async run(owner,win,command,explicitItems){
    const raw=explicitItems||await this.selected(win),items=[];
    for(let item of raw){if(item.parentItemID)item=await Zotero.Items.getAsync(item.parentItemID);if(item?.isRegularItem()&&!item.deleted&&!items.some(i=>i.id===item.id))items.push(item);}
    if(command==='jasminum'){
      const runner=Zotero.Jasminum?.taskRunner;if(typeof runner?.createAndAddTask!=='function')throw new Error('请先启用茉莉花插件');
      const attachments=raw.filter(i=>i.isAttachment?.()&&!i.parentItemID&&i.attachmentContentType==='application/pdf');
      if(!attachments.length)throw new Error('请选择尚未关联父题录的中文 PDF 附件；已有题录不会被自动覆盖');
      for(const item of attachments)await runner.createAndAddTask(item,'attachment');
      return {ok:true,message:'已交给茉莉花处理；请以其识别结果和候选确认界面为准。'};
    }
    if(!items.length)throw new Error('请选择具有父题录的文献');
    if(command==='linter'){
      const hooks=Zotero.Linter?.hooks;if(typeof hooks?.onLintInBatch!=='function')throw new Error('请先启用 Linter 插件');
      await hooks.onLintInBatch('standard',items);return {ok:true,message:'已调用 Linter 标准规则；是否修改及具体结果请查看其处理报告。'};
    }
    if(command==='citation'){
      const api=Zotero.ZoteroCitation?.api;if(typeof api?.citeItems!=='function')throw new Error('请先启用 Easier Citation，并在桌面 Word 中建立 Zotero 引文会话');
      await api.citeItems(items);return {ok:true,message:'已交给 Easier Citation；请在 Word 中确认引文。'};
    }
    if(command!=='fetch')throw new Error('未知的文献工具');
    if(items.some(i=>i.libraryID!==Zotero.Libraries.userLibraryID))throw new Error('当前补取全文入口仅支持我的文库；群组文献请使用 Zotero 原生获取功能');
    const rows=[];
    for(const item of items){
      const result=await ResearchNotebookLiterature.save({metadata:{item_key:item.key,title:item.getField('title'),doi:item.getField('DOI'),url:item.getField('url')},fetch_pdf:true},owner.root);
      if(result.metadata?.path&&typeof owner.request==='function'){
        try{await owner.request('/api/zotero/register',result.metadata);}catch(error){Zotero.logError(error);result.message=(result.message||'PDF 已入库')+'；仓库列表同步暂未完成，可使用“关联报告与 Zotero 已有 PDF”刷新。';}
      }
      rows.push({title:item.getField('title'),item_key:item.key,pdf_status:result.pdf_status,message:result.message,acquisition_attempts:result.acquisition_attempts||[]});
    }
    const count=rows.filter(r=>['existing','downloaded','copied'].includes(r.pdf_status)).length;
    return {ok:true,rows,message:'已处理 '+rows.length+' 篇，PDF 可用 '+count+' 篇。\n'+rows.map(r=>r.title+'：'+(r.message||r.pdf_status)).join('\n')};
  }
};
