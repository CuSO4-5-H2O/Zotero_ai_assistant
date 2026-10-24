/* Original adapter: Zotero owns all item and storage writes. */
var ResearchNotebookLiterature={
  pending:new Map(),
  capabilities(){return {ok:true,zotero:Zotero.version,addAvailableFile:typeof Zotero.Attachments.addAvailableFile==='function',addAvailablePDF:typeof Zotero.Attachments.addAvailablePDF==='function',addFileFromURLs:typeof Zotero.Attachments.addFileFromURLs==='function',getFileResolvers:typeof Zotero.Attachments.getFileResolvers==='function'};},
  async save(data){
    const m=data.metadata;
    if(!m||typeof m.doi!=='string'||!/^10\.\d{4,9}\/[^\s<>]+$/.test(m.doi)||typeof m.title!=='string'||!m.title.trim()||m.title.length>1000||typeof data.fetch_pdf!=='boolean')throw new Error('文献导入参数无效');
    const key=m.doi.toLowerCase();if(this.pending.has(key))return this.pending.get(key);
    const operation=this.perform(m,data.fetch_pdf);this.pending.set(key,operation);
    try{return await operation;}finally{this.pending.delete(key);}
  },
  async perform(m,fetchPDF){
    const libraryID=Zotero.Libraries.userLibraryID;
    const search=new Zotero.Search();search.libraryID=libraryID;search.addCondition('deleted','false');search.addCondition('DOI','is',m.doi);
    const ids=await search.search();let item=null;
    for(const id of ids){const found=await Zotero.Items.getAsync(id);if(found?.isRegularItem()&&!found.deleted){item=found;break;}}
    const created=!item;
    if(!item){
      item=new Zotero.Item(m.type==='proceedings-article'?'conferencePaper':'journalArticle');item.libraryID=libraryID;
      item.setField('title',m.title);item.setField('DOI',m.doi);item.setField('url','https://doi.org/'+m.doi);
      if(m.year)item.setField('date',String(m.year));if(m.venue)item.setField(m.type==='proceedings-article'?'proceedingsTitle':'publicationTitle',m.venue);
      const authors=Array.isArray(m.authors)?m.authors.slice(0,40).filter(a=>typeof a.lastName==='string'&&a.lastName).map(a=>({firstName:String(a.firstName||'').slice(0,100),lastName:a.lastName.slice(0,160),creatorType:'author'})):[];
      if(authors.length)item.setCreators(authors);if(m.abstract)item.setField('abstractNote',String(m.abstract).slice(0,5000));item.addTag('科研助手导入');await item.saveTx();
    }
    const collections=Zotero.Collections.getByLibrary(libraryID);let collection=collections.find(c=>c.name==='科研助手导入'&&!c.deleted);
    if(!collection){collection=new Zotero.Collection();collection.libraryID=libraryID;collection.name='科研助手导入';await collection.saveTx();}
    if(!item.inCollection(collection.id)){item.addToCollection(collection.id);await item.saveTx();}
    let attachment=null,path=null,pdfStatus=fetchPDF?'not_found':'not_requested',message='';
    for(const id of item.getAttachments()){
      const a=await Zotero.Items.getAsync(id);if(a?.deleted||a?.attachmentContentType!=='application/pdf')continue;
      const file=await a.getFilePathAsync();if(file&&await IOUtils.exists(file)){attachment=a;path=file;pdfStatus='existing';break;}
    }
    if(attachment&&![Zotero.Attachments.LINK_MODE_IMPORTED_FILE,Zotero.Attachments.LINK_MODE_IMPORTED_URL].includes(attachment.attachmentLinkMode)){
      attachment=await Zotero.Attachments.importFromFile({file:path,parentItemID:item.id,contentType:'application/pdf'});path=await attachment.getFilePathAsync();pdfStatus='copied';
    }
    if(!attachment&&fetchPDF){
      try{
        let result;
        if(typeof Zotero.Attachments.addFileFromURLs==='function'&&typeof Zotero.Attachments.getFileResolvers==='function'){
          const direct=(Array.isArray(m.pdf_urls)?m.pdf_urls:[]).slice(0,2).filter(u=>typeof u==='string'&&/^https:\/\//.test(u)).map(url=>({url,accessMethod:'Crossref PDF link'}));
          result=await Zotero.Attachments.addFileFromURLs(item,[...direct,...Zotero.Attachments.getFileResolvers(item)]);
        }else{const get=Zotero.Attachments.addAvailableFile||Zotero.Attachments.addAvailablePDF;if(!get)throw new Error('当前 Zotero 没有可用的全文接口');result=await get.call(Zotero.Attachments,item);}
        if(result?.attachmentContentType==='application/pdf'){const file=await result.getFilePathAsync();if(file&&await IOUtils.exists(file)){attachment=result;path=file;pdfStatus='downloaded';}}
        if(!attachment)message='题录已保存，未取得 PDF；可以稍后重试或在 Zotero 中获取全文。';
      }catch(error){Zotero.logError(error);message='题录已保存，全文获取未成功；请检查 Zotero 中的来源、登录或网络状态。';}
    }
    const field=k=>{try{return item.getField(k)||'';}catch(_){return '';}};
    return {ok:true,created,pdf_status:pdfStatus,message,metadata:{library_id:libraryID,item_key:item.key,attachment_key:attachment?.key||'',path:path||'',title:field('title'),doi:field('DOI'),year:field('date'),venue:field('publicationTitle')||field('proceedingsTitle'),url:field('url'),author:item.getCreators().map(a=>a.lastName||a.name||'').filter(Boolean).join(', ')}};
  }
};
