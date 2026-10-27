/* Original adapter: Zotero owns all item and storage writes. */
var ResearchNotebookLiterature={
  pending:new Map(),
  get codexRoot(){return PathUtils.join(Zotero.DataDirectory.dir,'storage','codex');},
  targetDirectory(value,mode){
    if(value===undefined||value===null)return this.codexRoot;
    if(typeof value!=='string'||value.length>200||mode!=='linked_codex')throw new Error('目标子目录仅用于 linked_codex 模式');
    const parts=value.replace(/\\/g,'/').trim().split('/');
    if(parts.some(p=>!p||p==='.'||p==='..'||/[ .]$/.test(p)||/[<>:"|?*\x00-\x1f]/.test(p)||/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(p)))throw new Error('目标子目录必须是 storage/codex 内的相对路径');
    const result=PathUtils.join(this.codexRoot,...parts);if(!this.within(result,this.codexRoot))throw new Error('目标目录越界');return result;
  },
  async ensureTargetDirectory(target){
    const base=PathUtils.normalize(this.codexRoot),relative=PathUtils.normalize(target).slice(base.length).replace(/^[\\/]+/,'');let current=base;
    for(const part of ['',...relative.split(/[\\/]/).filter(Boolean)]){
      if(part)current=PathUtils.join(current,part);
      if(await IOUtils.exists(current)){if((await IOUtils.stat(current,{followSymlinks:false})).type!=='directory')throw new Error('目标目录不是普通目录，拒绝链接/文件路径');}
      else await IOUtils.makeDirectory(current,{ignoreExisting:true});
    }
  },
  within(file,base){const p=PathUtils.normalize(file).toLowerCase(),b=PathUtils.normalize(base).toLowerCase();return p.startsWith(b+(b.includes('\\')?'\\':'/'));},
  async pdfBytes(file){
    const info=await IOUtils.stat(file);if(info.type==='symlink'||info.size<20||info.size>64*1024*1024)throw new Error('PDF 大小或路径无效');
    const bytes=await IOUtils.read(file,{maxBytes:64*1024*1024});this.validatePDF(bytes);return bytes;
  },
  validatePDF(bytes){
    const head=String.fromCharCode(...bytes.slice(0,5)),tail=String.fromCharCode(...bytes.slice(-4096));
    if(head!=='%PDF-'||!tail.includes('%%EOF'))throw new Error('PDF 文件头或结束标记无效');
  },
  sha256(bytes){
    const hash=Components.classes['@mozilla.org/security/hash;1'].createInstance(Components.interfaces.nsICryptoHash);
    hash.init(hash.SHA256);hash.update(bytes,bytes.length);return [...hash.finish(false)].map(c=>c.charCodeAt(0).toString(16).padStart(2,'0')).join('');
  },
  async ensureCollection(item,name){
    const collections=Zotero.Collections.getByLibrary(item.libraryID);let c=collections.find(c=>c.name===name&&!c.deleted);
    if(!c){c=new Zotero.Collection();c.libraryID=item.libraryID;c.name=name;await c.saveTx();}
    if(!item.inCollection(c.id)){item.addToCollection(c.id);await item.saveTx();}
    return c;
  },
  async moveImportsToStorage(){
    const libraryID=Zotero.Libraries.userLibraryID,collections=Zotero.Collections.getByLibrary(libraryID,true).filter(c=>!c.deleted);
    const targets=collections.filter(c=>c.name==='storage'&&!c.parentID);
    if(targets.length!==1)throw new Error('需要唯一的顶层 storage 分类，未修改文献');
    const target=targets[0],sources=collections.filter(c=>c.name==='科研助手导入'),ids=new Set();
    for(const source of sources)for(const id of source.getChildItems(true))ids.add(id);
    let added=0,moved=0;const keys=[];
    await Zotero.DB.executeTransaction(async()=>{
      for(const id of ids){
        const item=await Zotero.Items.getAsync(id);if(!item?.isRegularItem()||item.deleted)continue;
        if(!item.inCollection(target.id)){item.addToCollection(target.id);added++;}
        for(const source of sources)if(item.inCollection(source.id))item.removeFromCollection(source.id);
        await item.save();moved++;keys.push(item.key);
      }
    });
    return {ok:true,target:{key:target.key,name:target.name},moved,added,item_keys:keys,source_keys:sources.map(c=>c.key)};
  },
  async linkedPDF(item,m,fetchPDF,targetDirectory=this.codexRoot){
    let validExistingPDF=false;
    for(const id of item.getAttachments()){
      const child=await Zotero.Items.getAsync(id);if(child?.deleted||child?.attachmentContentType!=='application/pdf')continue;
      const path=await child.getFilePathAsync();if(!path||!await IOUtils.exists(path))continue;
      try{const bytes=await this.pdfBytes(path),digest=this.sha256(bytes);validExistingPDF=true;if(m.expected_sha256&&digest!==m.expected_sha256.toLowerCase())continue;return {attachment:child,path,pdfStatus:'existing',sha256:digest,location_exception:!this.within(path,this.codexRoot)};}catch(_){/* damaged attachment is retained */}
    }
    if(m.expected_sha256&&validExistingPDF)throw new Error('source_conflict: 已有 PDF 均不匹配选定全文 SHA256；未复制或修改附件');
    let bytes=null,source=m.source_path||'',message='';
    if(source){
      if(typeof source!=='string'||!this.within(source,this.codexRoot)||!source.toLowerCase().endsWith('.pdf'))throw new Error('链接 PDF 必须位于当前 Zotero 数据目录的 storage/codex');
      bytes=await this.pdfBytes(source);
    }
    if(!bytes&&fetchPDF){
      for(const url of (m.pdf_urls||[]).slice(0,6)){
        if(typeof url!=='string'||!/^https:\/\//i.test(url))continue;
        try{const response=await Zotero.HTTP.request('GET',url,{responseType:'arraybuffer',timeout:60000});
          const incoming=new Uint8Array(response.response);if(incoming.length>64*1024*1024)throw new Error('PDF 过大');this.validatePDF(incoming);bytes=incoming;break;
        }catch(error){Zotero.logError(error);}
      }
    }
    if(!bytes)return {attachment:null,path:'',pdfStatus:fetchPDF?'not_found':'not_requested',message:'题录已保存；指定链接未取得有效 PDF，可补充开放全文地址后重试。'};
    const digest=this.sha256(bytes),path=source||PathUtils.join(targetDirectory,digest+'.pdf');
    if(m.expected_sha256&&digest!==m.expected_sha256.toLowerCase())throw new Error('source_conflict: 来源 PDF SHA256 与选定全文不一致');
    if(!source)await this.ensureTargetDirectory(targetDirectory);
    if(await IOUtils.exists(path)){const stored=await this.pdfBytes(path);if(this.sha256(stored)!==digest)throw new Error('目标 PDF 校验不一致，未覆盖');}
    else await IOUtils.write(path,bytes,{mode:'create',tmpPath:path+'.tmp'});
    const attachment=await Zotero.Attachments.linkFromFile({file:path,parentItemID:item.id,contentType:'application/pdf',title:m.title.slice(0,180)});
    if(!attachment)throw new Error('链接附件创建失败，PDF 已保留供重试');
    const actualPath=await attachment.getFilePathAsync();
    if(!actualPath||!await IOUtils.exists(actualPath))throw new Error('Zotero 未返回有效的链接附件路径');
    return {attachment,path:actualPath,pdfStatus:source?'linked':'downloaded',sha256:digest,location_exception:!this.within(actualPath,this.codexRoot),message};
  },
  capabilities(){return {ok:true,zotero:Zotero.version,attachment_modes:['default','linked_codex'],linked_root:this.codexRoot,integrations:ResearchNotebookIntegrations.capabilities(),addAvailableFile:typeof Zotero.Attachments.addAvailableFile==='function',addAvailablePDF:typeof Zotero.Attachments.addAvailablePDF==='function',addFileFromURLs:typeof Zotero.Attachments.addFileFromURLs==='function',getFileResolvers:typeof Zotero.Attachments.getFileResolvers==='function'};},
  async save(data,root){
    const m=data.metadata,mode=data.attachment_mode||'default';
    const validDOI=typeof m?.doi==='string'&&/^10\.\d{4,9}\/[^\s<>]+$/.test(m.doi),validArxiv=typeof m?.url==='string'&&/^https:\/\/arxiv\.org\/abs\/\d{4}\.\d{4,5}(?:v\d+)?$/.test(m.url);
    const validExisting=/^[A-Z0-9]{8}$/.test(m?.item_key||'');
    if(!m||(!validDOI&&!validArxiv&&!validExisting)||typeof m.title!=='string'||!m.title.trim()||m.title.length>1000||typeof data.fetch_pdf!=='boolean')throw new Error('文献导入参数无效');
    const name=data.collection_name==='科研助手导入'?'storage':data.collection_name||'storage';
    if(!['default','linked_codex'].includes(mode)||typeof name!=='string'||!name.trim()||name.length>120||/[\x00-\x1f]/.test(name))throw new Error('集合或附件模式无效');
    const targetDirectory=(mode==='default'&&(data.target_subdir===undefined||data.target_subdir===null))?undefined:this.targetDirectory(data.target_subdir,mode);
    if(mode==='linked_codex'&&m.expected_sha256!==undefined&&(typeof m.expected_sha256!=='string'||!/^[a-f0-9]{64}$/i.test(m.expected_sha256)))throw new Error('选定全文 SHA256 无效');
    if(validExisting){
      const existing=await Zotero.Items.getByLibraryAndKeyAsync(Zotero.Libraries.userLibraryID,m.item_key),title=s=>String(s||'').normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
      if(!existing?.isRegularItem()||existing.deleted||title(existing.getField('title'))!==title(m.title))throw new Error('已有文献编号或题名不匹配');
      if(m.doi&&existing.getField('DOI')&&m.doi.toLowerCase()!==existing.getField('DOI').toLowerCase())throw new Error('已有文献 DOI 不一致，未修改题录');
    }
    const key=(validExisting?'item:'+m.item_key:m.doi||m.url).toLowerCase();
    while(this.pending.has(key)){try{await this.pending.get(key);}catch(_){}}
    const operation=this.perform(m,data.fetch_pdf,root,{mode,name:name.trim(),targetDirectory});this.pending.set(key,operation);
    try{return await operation;}finally{this.pending.delete(key);}
  },
  async attachSupplements(data,root){
    const doi=typeof data?.doi==='string'?data.doi.trim():'';
    const files=Array.isArray(data?.attachments)?data.attachments:[];
    if(!/^10\.\d{4,9}\/[^\s<>]+$/i.test(doi)||files.length<1||files.length>40)throw new Error('补充材料导入参数无效');
    const libraryID=Zotero.Libraries.userLibraryID,search=new Zotero.Search();
    search.libraryID=libraryID;search.addCondition('deleted','false');search.addCondition('DOI','is',doi);
    const ids=await search.search();let item=null;
    for(const id of ids){const found=await Zotero.Items.getAsync(id);if(found?.isRegularItem()&&!found.deleted){item=found;break;}}
    if(!item)throw new Error('Zotero 中没有 DOI 为 '+doi+' 的文献条目，请先导入题录');
    const mode=data.attachment_mode||'default';
    if(!['default','linked_codex'].includes(mode))throw new Error('补充材料附件模式无效');
    const linkedCodex=mode==='linked_codex';
    const base=PathUtils.normalize(PathUtils.join(root,'vault','.papers')).toLowerCase();
    const boundary=base+(base.includes('\\')?'\\':'/'),codexBase=PathUtils.normalize(this.codexRoot).toLowerCase(),codexBoundary=codexBase+(codexBase.includes('\\')?'\\':'/');
    const allowed=new Set(['.pdf','.zip','.doc','.docx','.xls','.xlsx','.csv','.txt','.xml','.html','.mp4','.mov','.avi','.mp3','.wav','.png','.jpg','.jpeg','.tif','.tiff','.gif','.ppt','.pptx']);
    const existing=new Map();
    for(const id of item.getAttachments()){
      const child=await Zotero.Items.getAsync(id);if(!child?.isAttachment()||child.deleted)continue;
      existing.set(child.getField('title')||'',child);
    }
    const mediaTypes={'.pdf':'application/pdf','.zip':'application/zip','.csv':'text/csv','.txt':'text/plain','.xml':'application/xml','.html':'text/html','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.tif':'image/tiff','.tiff':'image/tiff','.gif':'image/gif','.mp4':'video/mp4','.mov':'video/quicktime','.avi':'video/x-msvideo','.mp3':'audio/mpeg','.wav':'audio/wav','.doc':'application/msword','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.xls':'application/vnd.ms-excel','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.ppt':'application/vnd.ms-powerpoint','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation'};
    const imported=[],skipped=[];
    for(const entry of files){
      if(typeof entry?.source_path!=='string'||typeof entry?.filename!=='string'||!entry.filename.trim())throw new Error('补充材料路径或文件名无效');
      const local=PathUtils.normalize(entry.source_path),lower=local.toLowerCase(),ext=(local.match(/\.[^.\\/]+$/)?.[0]||'').toLowerCase();
      const validLinkedExt=new Set(['.pdf','.doc','.docx','.xls','.xlsx','.csv','.txt','.xml','.zip','.mp4','.mov','.avi']);
      const validPath=linkedCodex?this.within(local,this.codexRoot)&&(lower.includes('\\si\\')||lower.includes('/si/'))&&validLinkedExt.has(ext):local.startsWith(boundary)&&(lower.includes('\\si\\')||lower.includes('/si/'))&&allowed.has(ext);
      if(!validPath||!await IOUtils.exists(local))throw new Error(linkedCodex?'链接补充材料必须位于 Zotero storage/codex/SI 子目录内':'补充材料必须位于仓库文献目录的 SI 子文件夹内');
      const info=await IOUtils.stat(local);if(!info.size||info.size>(linkedCodex?64:300)*1024*1024)throw new Error('补充材料文件大小无效');
      const title=`SI [${String(data.report_id||'文献').slice(0,24)}] ${entry.filename.trim().slice(0,180)}`;
      const contentType=typeof entry.content_type==='string'&&/^[\w.+-]+\/[\w.+-]+$/.test(entry.content_type)?entry.content_type:(mediaTypes[ext]||'application/octet-stream');
      if(linkedCodex){
        const readFile=async path=>{
          if((path.match(/\.[^.\\/]+$/)?.[0]||'').toLowerCase()==='.pdf')return this.pdfBytes(path);
          const bytes=await IOUtils.read(path,{maxBytes:64*1024*1024});if(!bytes.length)throw new Error('补充材料为空');
          const suffix=(path.match(/\.[^.\\/]+$/)?.[0]||'').toLowerCase();
          if(['.docx','.xlsx','.zip'].includes(suffix)&&String.fromCharCode(...bytes.slice(0,2))!=='PK')throw new Error('OpenXML/ZIP 补充材料格式无效');
          return bytes;
        };
        const bytes=await readFile(local),digest=this.sha256(bytes);let duplicate=null;
        for(const id of item.getAttachments()){
          const child=await Zotero.Items.getAsync(id);if(!child?.isAttachment()||child.deleted||child.attachmentContentType!==contentType)continue;
          const path=await child.getFilePathAsync();if(!path||!await IOUtils.exists(path))continue;
          try{if(this.sha256(await readFile(path))===digest){duplicate={child,path};break;}}catch(_){/* retain unreadable existing attachments */}
        }
        if(duplicate){skipped.push({filename:entry.filename,reason:'相同 SHA256 附件已存在；保留原附件路径',key:duplicate.child.key,path:duplicate.path,bytes:info.size,sha256:digest});continue;}
        const safeTitle=existing.has(title)?`${title.slice(0,165)} [${digest.slice(0,8)}]`:title;
        const attachment=await Zotero.Attachments.linkFromFile({file:local,parentItemID:item.id,contentType,title:safeTitle});
        if(!attachment)throw new Error('Zotero 未能创建链接补充附件：'+entry.filename);
        const storedPath=await attachment.getFilePathAsync();if(!storedPath||!await IOUtils.exists(storedPath))throw new Error('Zotero 未返回链接补充附件路径：'+entry.filename);
        if(this.sha256(await readFile(storedPath))!==digest)throw new Error('链接补充材料 SHA256 校验失败：'+entry.filename);
        imported.push({key:attachment.key,filename:entry.filename,path:storedPath,bytes:info.size,sha256:digest,linked:true});existing.set(safeTitle,attachment);continue;
      }
      if(existing.has(title)){
        const child=existing.get(title),path=await child.getFilePathAsync();
        let bytes=0;if(path&&await IOUtils.exists(path))bytes=(await IOUtils.stat(path)).size;
        skipped.push({filename:entry.filename,reason:'已存在',key:child.key,path:path||'',bytes});continue;
      }
      const attachment=await Zotero.Attachments.importFromFile({file:local,parentItemID:item.id,contentType,title});
      if(!attachment)throw new Error('Zotero 未能创建补充材料附件：'+entry.filename);
      const storedPath=await attachment.getFilePathAsync();
      imported.push({key:attachment.key,filename:entry.filename,path:storedPath,bytes:info.size});existing.set(title,attachment);
    }
    return {ok:true,doi,item_key:item.key,title:item.getField('title'),imported,skipped};
  },
  async attachUploadedPDF(data,root){
    const m=data?.metadata||{},pid=String(data?.paper_id||'');
    if(!/^(?:[A-D]\d{1,2}|Z\d+_[A-Z0-9]{8})$/.test(pid)||typeof m.title!=='string'||!m.title.trim()||m.title.length>1000)throw new Error('文献或 PDF 信息无效');
    if(typeof data.source_path!=='string'||typeof data.filename!=='string')throw new Error('PDF 导入路径或文件名无效');
    const local=PathUtils.normalize(data.source_path),base=PathUtils.normalize(PathUtils.join(root,'.runtime','pdf-imports')).toLowerCase();
    const boundary=base+(base.includes('\\')?'\\':'/');
    if(!local.toLowerCase().startsWith(boundary)||!local.toLowerCase().endsWith('.pdf')||!await IOUtils.exists(local))throw new Error('PDF 必须位于临时导入目录内');
    const info=await IOUtils.stat(local);if(!info.size||info.size>32_000_000)throw new Error('PDF 文件大小无效');
    const incoming=await IOUtils.read(local,{maxBytes:32_000_000});
    if(String.fromCharCode(...incoming.slice(0,5))!=='%PDF-')throw new Error('导入文件不是有效 PDF');
    const libraryID=Number.isInteger(m.library_id)&&m.library_id>0?m.library_id:Zotero.Libraries.userLibraryID;
    let item=null;
    if(/^[A-Z0-9]{8}$/.test(m.item_key||'')){
      item=await Zotero.Items.getByLibraryAndKeyAsync(libraryID,m.item_key);
      if(!item?.isRegularItem?.()||item.deleted)throw new Error('没有找到此文献对应的 Zotero 条目');
    }else{
      const identifier=typeof m.doi==='string'?m.doi.trim():'';
      const search=new Zotero.Search();search.libraryID=libraryID;search.addCondition('deleted','false');
      if(/^10\.\d{4,9}\/[^\s<>]+$/i.test(identifier))search.addCondition('DOI','is',identifier);
      else search.addCondition('title','is',m.title.trim());
      for(const id of await search.search()){const found=await Zotero.Items.getAsync(id);if(found?.isRegularItem()&&!found.deleted){item=found;break;}}
    }
    let created=false;
    if(!item){
      item=new Zotero.Item('journalArticle');item.libraryID=libraryID;item.setField('title',m.title.trim());
      if(/^10\.\d{4,9}\/[^\s<>]+$/i.test(m.doi||''))item.setField('DOI',m.doi.trim());
      if(typeof m.year==='string'&&m.year.trim())item.setField('date',m.year.slice(0,40));
      if(typeof m.venue==='string'&&m.venue.trim())item.setField('publicationTitle',m.venue.slice(0,300));
      if(typeof m.url==='string'&&/^https?:\/\//i.test(m.url))item.setField('url',m.url.slice(0,2000));
      item.addTag('科研助手导入');await item.saveTx();created=true;
    }
    await this.ensureCollection(item,'storage');
    let attachment=null,path='';
    for(const id of item.getAttachments()){
      const child=await Zotero.Items.getAsync(id);if(!child?.isAttachment()||child.deleted||child.attachmentContentType!=='application/pdf')continue;
      const existingPath=await child.getFilePathAsync();if(!existingPath||!await IOUtils.exists(existingPath))continue;
      if((await IOUtils.stat(existingPath)).size!==incoming.length)continue;
      const existing=await IOUtils.read(existingPath,{maxBytes:32_000_000});
      if(existing.length===incoming.length&&existing.every((byte,index)=>byte===incoming[index])){attachment=child;path=existingPath;break;}
    }
    let pdfStatus='existing';
    if(!attachment){
      attachment=await Zotero.Attachments.importFromFile({file:local,parentItemID:item.id,contentType:'application/pdf',title:data.filename.slice(0,200)});
      if(!attachment)throw new Error('Zotero 未能创建 PDF 附件');
      path=await attachment.getFilePathAsync();pdfStatus='imported';
    }
    if(!path||!await IOUtils.exists(path))throw new Error('Zotero 未返回已保存的 PDF 文件路径');
    const field=k=>{try{return item.getField(k)||'';}catch(_){return '';}};
    return {ok:true,created,pdf_status:pdfStatus,metadata:{library_id:item.libraryID,item_key:item.key,attachment_key:attachment.key,path,title:field('title'),doi:field('DOI'),year:field('date'),venue:field('publicationTitle')||field('proceedingsTitle'),url:field('url'),author:item.getCreators().map(a=>a.lastName||a.name||'').filter(Boolean).join(', ')}};
  },
  async perform(m,fetchPDF,root,options={mode:'default',name:'storage'}){
    const libraryID=Zotero.Libraries.userLibraryID;
    let item=m.item_key?await Zotero.Items.getByLibraryAndKeyAsync(libraryID,m.item_key):null;
    if(!item){
      const search=new Zotero.Search();search.libraryID=libraryID;search.addCondition('deleted','false');search.addCondition(m.doi?'DOI':'url','is',m.doi||m.url);
      for(const id of await search.search()){const found=await Zotero.Items.getAsync(id);if(found?.isRegularItem()&&!found.deleted){item=found;break;}}
    }
    if(!item){
      const titleSearch=new Zotero.Search();titleSearch.libraryID=libraryID;titleSearch.addCondition('deleted','false');titleSearch.addCondition('title','is',m.title.trim());
      const normalize=s=>String(s||'').normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
      for(const id of await titleSearch.search()){const found=await Zotero.Items.getAsync(id);if(found?.isRegularItem()&&!found.deleted&&normalize(found.getField('title'))===normalize(m.title)&&(!m.doi||!found.getField('DOI')||normalize(found.getField('DOI'))===normalize(m.doi))){item=found;break;}}
    }
    const created=!item;
    if(!item){
      item=new Zotero.Item(m.type==='proceedings-article'?'conferencePaper':'journalArticle');item.libraryID=libraryID;
      item.setField('title',m.title);if(m.doi)item.setField('DOI',m.doi);item.setField('url',m.doi?'https://doi.org/'+m.doi:m.url);
      if(m.year)item.setField('date',String(m.year));if(m.venue)item.setField(m.type==='proceedings-article'?'proceedingsTitle':'publicationTitle',m.venue);
      const authors=Array.isArray(m.authors)?m.authors.slice(0,40).filter(a=>typeof a.lastName==='string'&&a.lastName).map(a=>({firstName:String(a.firstName||'').slice(0,100),lastName:a.lastName.slice(0,160),creatorType:'author'})):[];
      if(authors.length)item.setCreators(authors);if(m.abstract)item.setField('abstractNote',String(m.abstract).slice(0,5000));item.addTag('科研助手导入');await item.saveTx();
    }
    await this.ensureCollection(item,options.name);
    if(options.mode==='linked_codex'){
      const linked=await this.linkedPDF(item,m,fetchPDF,options.targetDirectory),field=k=>{try{return item.getField(k)||'';}catch(_){return '';}};
      return {ok:true,created,pdf_status:linked.pdfStatus,message:linked.message||'',sha256:linked.sha256||'',location_exception:!!linked.location_exception,metadata:{library_id:libraryID,item_key:item.key,attachment_key:linked.attachment?.key||'',path:linked.path||'',title:field('title'),doi:field('DOI'),year:field('date'),venue:field('publicationTitle')||field('proceedingsTitle'),url:field('url'),author:item.getCreators().map(a=>a.lastName||a.name||'').filter(Boolean).join(', ')}};
    }
    let attachment=null,path=null,pdfStatus=fetchPDF?'not_found':'not_requested',message='',acquisitionAttempts=[],digest='';
    for(const id of item.getAttachments()){
      const a=await Zotero.Items.getAsync(id);if(a?.deleted||a?.attachmentContentType!=='application/pdf')continue;
      const file=await a.getFilePathAsync();if(file&&await IOUtils.exists(file)){
        try{await this.pdfBytes(file);attachment=a;path=file;pdfStatus='existing';break;}catch(error){Zotero.logError(error);}
      }
    }
    if(attachment&&![Zotero.Attachments.LINK_MODE_IMPORTED_FILE,Zotero.Attachments.LINK_MODE_IMPORTED_URL].includes(attachment.attachmentLinkMode)){
      attachment=await Zotero.Attachments.importFromFile({file:path,parentItemID:item.id,contentType:'application/pdf'});path=await attachment.getFilePathAsync();pdfStatus='copied';
    }
    if(!attachment&&m.source_path){
      const local=PathUtils.normalize(m.source_path),base=PathUtils.normalize(PathUtils.join(root,'vault','.papers'));
      const boundary=base.toLowerCase()+(base.includes('\\')?'\\':'/');
      if(!local.toLowerCase().startsWith(boundary)||!local.toLowerCase().endsWith('.pdf')||!await IOUtils.exists(local))throw new Error('本地 PDF 不属于已关联文献目录');
      const magic=await IOUtils.read(local,{maxBytes:5});if(String.fromCharCode(...magic)!=='%PDF-')throw new Error('本地文件不是 PDF');
      attachment=await Zotero.Attachments.importFromFile({file:local,parentItemID:item.id,contentType:'application/pdf'});path=await attachment.getFilePathAsync();pdfStatus='copied';
    }
    if(!attachment&&fetchPDF){
      const result=await ResearchNotebookIntegrations.fetchPDF(item,m);
      acquisitionAttempts=result.attempts;message=result.message;digest=result.sha256;
      if(result.attachment){attachment=result.attachment;path=result.path;pdfStatus='downloaded';}
    }
    const field=k=>{try{return item.getField(k)||'';}catch(_){return '';}};
    return {ok:true,created,pdf_status:pdfStatus,message,acquisition_attempts:acquisitionAttempts,sha256:digest,metadata:{library_id:libraryID,item_key:item.key,attachment_key:attachment?.key||'',path:path||'',title:field('title'),doi:field('DOI'),year:field('date'),venue:field('publicationTitle')||field('proceedingsTitle'),url:field('url'),author:item.getCreators().map(a=>a.lastName||a.name||'').filter(Boolean).join(', ')}};
  }
};
