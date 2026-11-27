/* Local reader sources for books, chapters and saved Zotero annotations. */
var ResearchNotebookReading={
  supported(item){return ['application/pdf','application/epub+zip'].includes(item?.attachmentContentType);},
  async attachment(item){
    if(this.supported(item)&&item.isAttachment?.())return item;
    if(!item?.isRegularItem?.())return null;
    const best=await item.getBestAttachment();if(this.supported(best))return best;
    for(const id of item.getAttachments()){const a=await Zotero.Items.getAsync(id);if(!a.deleted&&this.supported(a))return a;}
    return null;
  },
  uri(att,annotation){
    const path=Zotero.URI.getLibraryPath(att.libraryID),scope=path.startsWith('groups/')?path:'library';
    return `zotero://${att.attachmentContentType==='application/epub+zip'?'open-epub':'open-pdf'}/${scope}/items/${att.key}`+(annotation?'?annotation='+annotation.key:'');
  },
  async annotations(data){
    const library=Number(data.library_id),key=data.all_attachments?data.item_key:(data.attachment_key||data.item_key);
    if(!Number.isInteger(library)||library<1||!/^[A-Z0-9]{8}$/.test(key||''))throw new Error('批注文献信息无效');
    const item=await Zotero.Items.getByLibraryAndKeyAsync(library,key);if(!item||item.deleted)throw new Error('文献已删除或不存在');
    let attachments=[];
    if(item.isAttachment?.()&&this.supported(item))attachments=[item];
    else if(item.isRegularItem?.())for(const id of item.getAttachments()){const a=await Zotero.Items.getAsync(id);if(!a.deleted&&this.supported(a))attachments.push(a);}
    for(const extra of [data.source_attachment_key,data.attachment_key]){
      if(!/^[A-Z0-9]{8}$/.test(extra||'')||attachments.some(a=>a.key===extra))continue;
      const a=await Zotero.Items.getByLibraryAndKeyAsync(library,extra);
      if(a&&!a.deleted&&this.supported(a)&&(!item.isRegularItem?.()||a.parentItemID===item.id))attachments.push(a);
    }
    let rows=[];
    for(const att of attachments){
      for(const a of att.getAnnotations?.()||[]){
        if(a.deleted)continue;
        let position={};try{position=JSON.parse(a.annotationPosition||'{}');}catch(_){}
        rows.push({key:a.key,attachment_key:att.key,type:a.annotationType,text:a.annotationText||'',comment:a.annotationComment||'',color:a.annotationColor||'',page_label:a.annotationPageLabel||'',page:Number.isInteger(position.pageIndex)?position.pageIndex+1:null,sort_index:a.annotationSortIndex||'',tags:(a.getTags?.()||[]).map(t=>t.tag),uri:this.uri(att,a)});
      }
    }
    rows.sort((a,b)=>(a.attachment_key+':'+a.sort_index).localeCompare(b.attachment_key+':'+b.sort_index));
    const start=data.start??0,limit=data.limit??200;
    if(!Number.isInteger(start)||start<0||!Number.isInteger(limit)||limit<1||limit>500)throw new Error('批注读取范围无效');
    return {ok:true,total:rows.length,annotations:rows.slice(start,start+limit),next_start:start+limit<rows.length?start+limit:null};
  },
  async list(owner,data){
    const win=Zotero.getMainWindow(),libraryID=Zotero.Libraries.userLibraryID;
    let ids;
    if(data.selected)ids=(win.ZoteroPane?.getSelectedItems?.()||[]).map(i=>i.id);
    else{
      if(typeof data.query!=='string'||!data.query.trim()||data.query.length>200)throw new Error('请提供题名、作者或关键词，或选中需要处理的文献');
      const search=new Zotero.Search();search.libraryID=libraryID;search.addCondition('deleted','false');search.addCondition('quicksearch-titleCreatorYear','contains',data.query.trim());ids=await search.search();
    }
    const start=data.start??0;if(!Number.isInteger(start)||start<0)throw new Error('起始位置无效');
    const records=[],seen=new Set();
    for(const id of ids){const i=await Zotero.Items.getAsync(id);if(!i||i.deleted||!(i.isRegularItem?.()||this.supported(i)))continue;const parent=i.parentItemID||i.id;if(!seen.has(parent)){seen.add(parent);records.push(i);}}
    const papers=[];for(const i of records.slice(start,start+20)){const record=await owner.registerSelected({ZoteroPane:{getSelectedItems:()=>[i]}});papers.push(record);}
    return {ok:true,papers,total:records.length,next_start:start+20<records.length?start+20:null};
  },
  async open(data){
    if(!Number.isInteger(data.library_id)||!/^[A-Z0-9]{8}$/.test(data.attachment_key||''))throw new Error('阅读器目标无效');
    const a=await Zotero.Items.getByLibraryAndKeyAsync(data.library_id,data.attachment_key);if(!a||a.deleted||!this.supported(a))throw new Error('没有找到 PDF 或 EPUB 原文');
    let location;
    if(typeof data.href==='string'&&data.href.length<=2000&&!/^[a-z]+:|^\/|\.\.\//i.test(data.href))location={href:data.href};
    else if(typeof data.cfi==='string'&&data.cfi.length<=2000&&/^epubcfi\(/.test(data.cfi))location={pageNumber:data.cfi};
    else if(Number.isInteger(data.page)&&data.page>0)location={pageIndex:data.page-1};
    else if(data.page!=null||data.href!=null||data.cfi!=null)throw new Error('章节位置无效');
    if(data.annotation_key){if(!/^[A-Z0-9]{8}$/.test(data.annotation_key))throw new Error('批注编号无效');location={annotationID:data.annotation_key};}
    await Zotero.Reader.open(a.id,location);return {ok:true};
  },
  async attachOCR(owner,data){
    if(!Number.isInteger(data.library_id)||!/^[A-Z0-9]{8}$/.test(data.attachment_key||''))throw new Error('OCR 来源附件无效');
    const source=await Zotero.Items.getByLibraryAndKeyAsync(data.library_id,data.attachment_key);
    if(!source||source.deleted||source.attachmentContentType!=='application/pdf')throw new Error('OCR 来源 PDF 不存在');
    if(typeof data.source_path!=='string'||!/^ocr-[a-f0-9]{32}\.pdf$/.test(PathUtils.filename(data.source_path)))throw new Error('OCR 文件名无效');
    const file=PathUtils.normalize(data.source_path),base=PathUtils.normalize(owner.path('.runtime','pdf-imports'));
    if(PathUtils.parent(file).toLowerCase()!==base.toLowerCase()||!await IOUtils.exists(file))throw new Error('OCR 文件不在临时导入目录');
    const stat=await IOUtils.stat(file),magic=await IOUtils.read(file,{maxBytes:5});
    if(!stat.size||stat.size>1024*1024*1024||String.fromCharCode(...magic)!=='%PDF-')throw new Error('OCR 副本无效或超过 1 GB');
    const parent=source.parentItemID?await Zotero.Items.getAsync(source.parentItemID):null;
    const attachment=await Zotero.Attachments.importFromFile({file,libraryID:source.libraryID,parentItemID:parent?.id,contentType:'application/pdf',title:(source.getField('title')||'扫描文献')+'（可选字 OCR）'});
    const path=await attachment.getFilePathAsync(),item=parent||source,field=(i,k)=>{try{return i?.getField(k)||'';}catch(_){return '';}};
    return {ok:true,metadata:{library_id:item.libraryID,item_key:item.key,attachment_key:attachment.key,source_attachment_key:source.key,path,title:field(item,'title')||'扫描文献',doi:field(parent,'DOI'),year:field(parent,'date'),author:parent?.getCreators().map(c=>c.lastName||c.name||'').join(', ')||''}};
  }
};
