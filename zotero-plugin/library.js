/* Zotero library access for the general assistant. Changes are version checked. */
var ResearchNotebookLibrary={
  navigate(data){
    if(this.navigation)return this.navigation.uri===data.uri?this.navigation.promise:Promise.reject(new Error('正在定位另一篇文献，请稍后重试'));
    const promise=this.navigateItem(data);this.navigation={uri:data.uri,promise};
    promise.finally(()=>{if(this.navigation?.promise===promise)this.navigation=null;}).catch(()=>{});return promise;
  },
  async navigateItem(data){
    if(typeof data.uri!=='string'||data.uri.length>2500)throw new Error('Zotero 链接无效');
    const match=/^zotero:\/\/(select|open-pdf|open-epub)\/(library|groups\/([1-9]\d*))\/items\/([A-Z0-9]{8})\/?(?:\?([^#]*))?$/i.exec(data.uri);
    if(!match)throw new Error('此 Zotero 链接不支持，请使用文献条目或原文链接');
    const operation=match[1].toLowerCase(),libraryID=match[3]?Zotero.Groups.getLibraryIDFromGroupID(Number(match[3])):Zotero.Libraries.userLibraryID;
    if(!libraryID||!Zotero.Libraries.get(libraryID))throw new Error('链接对应的 Zotero 资料库尚未同步到本机');
    const item=await Zotero.Items.getByLibraryAndKeyAsync(libraryID,match[4].toUpperCase());
    if(!item||item.deleted)throw new Error('该文献条目已删除或尚未同步到本机');
    const params=new URLSearchParams(match[5]||'');
    for(const [name] of params)if(!['page','annotation','cfi','sel'].includes(name)||params.getAll(name).length!==1)throw new Error('Zotero 链接的位置参数无效');
    const win=Zotero.getMainWindow();if(!win||win.closed||!win.ZoteroPane)throw new Error('请先打开 Zotero 主窗口');
    if(operation==='select'){
      if(params.size)throw new Error('条目定位链接不需要页码参数');
      if(!await win.ZoteroPane.selectItems([item.id],{inLibraryRoot:true}))throw new Error('未能选中文献条目，请重新打开 Zotero 文库');win.focus();
      if(!win.ZoteroPane.getSelectedItems().some(selected=>selected.id===item.id))throw new Error('文库未能选中该条目，请清除列表筛选后重试');
      return {ok:true,operation,selected:true,library_id:libraryID,item_key:item.key,title:item.getField('title')};
    }
    const attachment=await ResearchNotebookReading.attachment(item);
    if(!attachment||attachment.deleted)throw new Error('此文献还没有本地 PDF 或 EPUB 原文');
    const path=await attachment.getFilePathAsync();if(!path||!await IOUtils.exists(path))throw new Error('原文尚未下载到本机，请先下载附件');
    const location={};
    if(params.has('page')){const page=params.get('page');if(!/^[1-9]\d{0,5}$/.test(page))throw new Error('PDF 页码无效');location.pageIndex=Number(page)-1;}
    if(params.has('annotation')){
      const annotation=params.get('annotation');if(!/^[A-Z0-9]{8}$/.test(annotation))throw new Error('批注编号无效');
      const row=await Zotero.Items.getByLibraryAndKeyAsync(libraryID,annotation);if(!row||row.deleted||row.parentItemID!==attachment.id)throw new Error('原文中没有这条批注');location.annotationID=annotation;
    }
    if(params.has('cfi')||params.has('sel')){
      const cfi=params.has('cfi'),value=params.get(cfi?'cfi':'sel');if(!value||value.length>2000)throw new Error('电子书位置无效');
      location.position={type:cfi?'FragmentSelector':'CssSelector',...(cfi?{conformsTo:'http://www.idpf.org/epub/linking/cfi/epub-cfi.html'}:{}),value};
    }
    await Zotero.Reader.open(attachment.id,Object.keys(location).length?location:null,{openInWindow:false,allowDuplicate:false});
    return {ok:true,operation,library_id:libraryID,item_key:item.key,attachment_key:attachment.key,title:item.getField('title')};
  },
  eligible(item){return item?.isRegularItem?.()||(!item?.parentItemID&&item?.isAttachment?.()&&['application/pdf','application/epub+zip'].includes(item.attachmentContentType));},
  library(data){const id=data.library_id??Zotero.Libraries.userLibraryID;if(!Number.isInteger(id)||id<1||!Zotero.Libraries.get(id))throw new Error('Zotero 资料库不存在');return id;},
  version(item){return Zotero.Utilities.Internal.md5(JSON.stringify([item.toJSON(),!!item.deleted]));},
  async item(data){const lib=this.library(data);if(!/^[A-Z0-9]{8}$/.test(data.item_key||''))throw new Error('条目编号无效');const item=await Zotero.Items.getByLibraryAndKeyAsync(lib,data.item_key);if(!this.eligible(item))throw new Error('没有找到文献条目');return item;},
  async snapshot(item){
    const attachments=[];
    for(const id of item.isRegularItem?.()?item.getAttachments():[item.id]){
      const a=await Zotero.Items.getAsync(id);if(!a||a.deleted)continue;
      const row={key:a.key,title:a.getField('title'),content_type:a.attachmentContentType,link_mode:a.attachmentLinkMode,supplementary:typeof ResearchNotebookLiterature!=='undefined'&&ResearchNotebookLiterature.isSupplement(a),local_available:false};
      if(['application/pdf','application/epub+zip'].includes(a.attachmentContentType)){
        try{const path=await a.getFilePathAsync();if(path&&await IOUtils.exists(path)){const magic=await IOUtils.read(path,{maxBytes:5});row.local_available=a.attachmentContentType==='application/pdf'?String.fromCharCode(...magic)==='%PDF-':magic[0]===80&&magic[1]===75;}}catch(_){}
      }
      row.file_kind=row.local_available?(row.content_type==='application/pdf'?'local_pdf':'local_ebook'):a.attachmentLinkMode===Zotero.Attachments.LINK_MODE_LINKED_URL?'url_link':row.content_type==='application/pdf'?'missing_pdf':'other_attachment';
      attachments.push(row);
    }
    return {library_id:item.libraryID,item_key:item.key,version:this.version(item),deleted:!!item.deleted,metadata:item.toJSON(),attachments,has_local_pdf:attachments.some(a=>a.content_type==='application/pdf'&&a.local_available&&!a.supplementary),has_local_ebook:attachments.some(a=>a.content_type==='application/epub+zip'&&a.local_available)};
  },
  async search(data){
    const libraryID=this.library(data),query=data.query??'',start=data.start??0,limit=data.limit??20;
    if(typeof query!=='string'||query.length>300||!Number.isInteger(start)||start<0||!Number.isInteger(limit)||limit<1||limit>30||data.trash!==undefined&&typeof data.trash!=='boolean')throw new Error('检索参数无效');
    const search=new Zotero.Search();search.libraryID=libraryID;search.addCondition('deleted',data.trash?'true':'false');
    const doi=query.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i,'');
    if(/^10\.\d{4,9}\/[^\s<>]+$/i.test(doi))search.addCondition('DOI','is',doi);
    else if(query.trim()){search.addCondition('quicksearch-everything','contains',query.trim());search.addCondition('includeParents','true');}
    const records=[];for(const id of await search.search()){const item=await Zotero.Items.getAsync(id);if(this.eligible(item)&&!!item.deleted===!!data.trash)records.push(item);}
    records.sort((a,b)=>String(b.dateModified||'').localeCompare(String(a.dateModified||''))||a.key.localeCompare(b.key));
    const items=[];for(const item of records.slice(start,start+limit)){
      const snapshot=await this.snapshot(item),m=snapshot.metadata;
      snapshot.metadata=Object.fromEntries(['title','itemType','creators','date','DOI','ISBN','url','tags','collections'].filter(k=>m[k]!==undefined).map(k=>[k,m[k]]));snapshot.abstract_preview=(m.abstractNote||'').slice(0,700);items.push(snapshot);
    }
    return {ok:true,library_id:libraryID,total:records.length,items,next_start:start+limit<records.length?start+limit:null};
  },
  async get(owner,data){
    const item=await this.item(data),record=await this.snapshot(item);
    if(!item.deleted){
      try{
        const local=record.attachments.find(a=>a.local_available&&!a.supplementary);
        let paper;
        if(local){const a=await Zotero.Items.getByLibraryAndKeyAsync(item.libraryID,local.key);paper=await owner.registerSelected({ZoteroPane:{getSelectedItems:()=>[a]}});}
        else{const m=record.metadata;paper=await owner.request('/api/zotero/register',{library_id:item.libraryID,item_key:item.key,title:m.title||'未命名文献',doi:m.DOI||'',year:m.date||'',author:(m.creators||[]).map(c=>c.name||[c.firstName,c.lastName].filter(Boolean).join(' ')).join(', '),venue:m.publicationTitle||m.publisher||'',url:m.url||''});}
        record.paper_id=paper.id;
      }catch(error){record.repository_message=error.message;}
    }
    return {ok:true,...record};
  },
  async update(data){
    const item=await this.item(data);if(item.deleted)throw new Error('请先恢复回收站中的文献');if(this.version(item)!==data.version)throw new Error('Zotero 条目已变化，请重新读取再修改');
    if(!item.isEditable())throw new Error('该资料库为只读');
    const allowed=new Set(['title','date','DOI','url','abstractNote','publicationTitle','bookTitle','volume','issue','pages','publisher','place','ISBN','ISSN','language','extra','shortTitle','archive','archiveLocation','rights']);
    const fields=data.fields||{};if(!fields||Array.isArray(fields)||typeof fields!=='object'||Object.keys(fields).some(k=>!allowed.has(k)||typeof fields[k]!=='string'||fields[k].length>50000))throw new Error('题录字段无效');
    for(const field of Object.keys(fields))if(!Zotero.ItemFields.isValidForType(Zotero.ItemFields.getID(field),item.itemTypeID))throw new Error('当前条目类型不支持字段：'+field);
    if('title' in fields&&!fields.title.trim())throw new Error('标题不能为空');
    const tags={};for(const name of ['add_tags','remove_tags']){tags[name]=data[name]||[];if(!Array.isArray(tags[name])||tags[name].length>50||tags[name].some(t=>typeof t!=='string'||!t.trim()||t.length>100))throw new Error('标签格式无效');}
    const collections={};for(const name of ['add_to_collections','remove_from_collections']){
      const keys=data[name]||[];if(!Array.isArray(keys)||keys.length>40)throw new Error('分类参数无效');collections[name]=[];
      for(const key of keys){if(!/^[A-Z0-9]{8}$/.test(key))throw new Error('分类编号无效');const c=await Zotero.Collections.getByLibraryAndKeyAsync(item.libraryID,key);if(!c||c.deleted)throw new Error('分类不存在');collections[name].push(c.id);}
    }
    let creators;
    if(data.creators!==undefined){
      if(!Array.isArray(data.creators)||data.creators.length>100)throw new Error('作者列表无效');
      creators=data.creators.map(c=>{
        if(!c||typeof c!=='object'||typeof c.lastName!=='string'||!c.lastName.trim()||c.lastName.length>300||c.firstName!==undefined&&typeof c.firstName!=='string'||c.firstName?.length>300)throw new Error('作者姓名无效');
        const type=Zotero.CreatorTypes.getID(c.creatorType||'author');if(!type||!Zotero.CreatorTypes.isValidForItemType(type,item.itemTypeID))throw new Error('作者角色无效');
        return {firstName:c.firstName||'',lastName:c.lastName,fieldMode:c.fieldMode===1?1:0,creatorTypeID:type};
      });
    }
    await Zotero.DB.executeTransaction(async()=>{
      if(this.version(item)!==data.version)throw new Error('条目已变化，请重新读取');
      for(const [field,value] of Object.entries(fields))item.setField(field,value);
      if(creators)item.setCreators(creators);
      for(const tag of tags.add_tags)item.addTag(tag.trim());for(const tag of tags.remove_tags)item.removeTag(tag.trim());
      for(const id of collections.add_to_collections)item.addToCollection(id);for(const id of collections.remove_from_collections)item.removeFromCollection(id);
      await item.save();
    });
    return {ok:true,...await this.snapshot(item)};
  },
  async trash(data){
    const item=await this.item(data);if(typeof data.restore!=='boolean'||typeof data.version!=='string'||this.version(item)!==data.version)throw new Error('请先读取当前条目版本');
    if(!item.isEditable())throw new Error('该资料库为只读');
    item.deleted=!data.restore;await item.saveTx();return {ok:true,...await this.snapshot(item)};
  },
  collections(data){const libraryID=this.library(data);return {ok:true,collections:Zotero.Collections.getByLibrary(libraryID,true).filter(c=>!c.deleted).map(c=>({key:c.key,name:c.name,parent_key:c.parentKey||null}))};}
};
