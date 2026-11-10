/* Original acquisition adapters. See docs/PDF获取机制与验收.md for inspected upstreams.
 * Sources supply candidates; Zotero owns networking, translators and attachment writes.
 */
var ResearchNotebookPDFSources={
  limitMs:180000,
  field(item,name){try{return String(item.getField(name)||'');}catch(_){return '';}},
  doi(value){const m=String(value||'').match(/10\.\d{4,9}\/[^\s<>"#]+/i);return m?m[0].replace(/[.,;]+$/,'').toLowerCase():'';},
  url(value,base){
    if(typeof value!=='string'||!value.trim())return null;
    try{
      const u=new URL(value,base);if(u.protocol==='http:')u.protocol='https:';
      const h=u.hostname.toLowerCase().replace(/^\[|\]$/g,'');
      if(u.protocol!=='https:'||u.username||u.password||!h.includes('.')||/(^|\.)(localhost|local|internal)$/.test(h)||h.includes(':')||/^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h))return null;
      u.hash='';return u.href;
    }catch(_){return null;}
  },
  identifiers(item,m={}){
    const extra=this.field(item,'extra'),url=this.field(item,'url')||m.url||'';
    const doi=this.doi(this.field(item,'DOI')||m.doi||extra.match(/^DOI:\s*(.+)$/im)?.[1]);
    const arxiv=(url.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+\/\d{7}(?:v\d+)?)/i)||extra.match(/^arxiv:\s*(\S+)/im))?.[1]?.replace(/\.pdf$/i,'')||'';
    const pmid=(extra.match(/^PMID:\s*(\d+)\b/im)||url.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/))?.[1]||'';
    const title=this.field(item,'title')||m.title||'',year=Number((this.field(item,'date')||String(m.year||'')).match(/\b(?:18|19|20)\d{2}\b/)?.[0])||null;
    return {doi:doi||(arxiv?'10.48550/arxiv.'+arxiv.replace(/v\d+$/,'').toLowerCase():''),arxiv,pmid,title,year};
  },
  normalize(value){return String(value||'').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu,'');},
  matches(ids,work){
    const found=this.doi(work.doi);if(ids.doi&&found)return ids.doi===found;
    if(ids.pmid&&String(work.ids?.pmid||'').match(/\d+$/)?.[0]===ids.pmid)return true;
    return this.normalize(ids.title).length>=8&&this.normalize(ids.title)===this.normalize(work.title||work.display_name)&&(!ids.year||!work.publication_year||Math.abs(ids.year-work.publication_year)<=1);
  },
  checkDeadline(deadline){if(Date.now()>=deadline){const e=new Error('本篇获取已达到时间上限');e.code='time_budget';throw e;}},
  describe(error){
    const status=Number(error?.status||error?.xmlhttp?.status)||0;
    const code=error?.code||([401,403,418].includes(status)?'access_denied':status===429?'rate_limited':status===404?'not_found':status>=500?'server_error':/timeout|timed out|超时/i.test(String(error))?'timeout':'network_error');
    const messages={access_denied:'来源拒绝访问，需要机构权限或浏览器验证',rate_limited:'来源限流，本次不重复请求',not_found:'来源无此条目',server_error:'来源服务器错误',timeout:'连接或响应超时',verification_required:'来源返回人机验证页，需要在正常浏览器中人工处理',time_budget:'本篇获取已达到时间上限',invalid_pdf:'未取得有效 PDF',invalid_url:'来源地址不可用'};
    return {status,code,message:messages[code]||'连接来源失败'};
  },
  record(trace,value){if(trace.requests.length<80)trace.requests.push(value);},
  method(trace,name){const value=String(name||trace.source).slice(0,100);if(!trace.methods.includes(value))trace.methods.push(value);},
  async request(url,type,trace,deadline,headers={}){
    this.checkDeadline(deadline);url=this.url(url);if(!url)throw Object.assign(new Error('invalid URL'),{code:'invalid_url'});
    const row={phase:'lookup',host:new URL(url).hostname,status:'requesting'};this.record(trace,row);const started=Date.now();
    try{
      const response=await Zotero.HTTP.request('GET',url,{responseType:type,timeout:Math.max(1,Math.min(30000,deadline-Date.now())),errorDelayMax:0,noRetryOnThrottle:true,successCodes:false,headers});
      row.status=response.status;row.ms=Date.now()-started;
      if(response.status<200||response.status>=300)throw Object.assign(new Error('HTTP '+response.status),{status:response.status});
      if(type==='document'){
        const doc=response.response||response.responseXML;
        if(/captcha|just a moment|access denied|robot|机器人|验证码|访问验证|安全验证|ロボット/i.test(doc?.title||''))throw Object.assign(new Error('verification page'),{code:'verification_required'});
      }
      return response;
    }catch(error){Object.assign(row,this.describe(error));row.ms=Date.now()-started;throw error;}
  },
  async openAlex(item,m,trace,deadline){
    const ids=this.identifiers(item,m),resolvers=[];
    if(ids.arxiv)resolvers.push({url:'https://arxiv.org/pdf/'+ids.arxiv,accessMethod:'arXiv（明确标识符）'});
    const select='id,doi,ids,title,publication_year,best_oa_location,primary_location,locations';
    const filters=[];if(ids.doi)filters.push('doi:'+encodeURIComponent(ids.doi));if(ids.pmid)filters.push('pmid:'+ids.pmid);
    if(ids.title.length>=8)filters.push('title.search:'+encodeURIComponent(ids.title.replace(/[,|(){}\[\]]/g,' ')));
    let work=null;
    for(const filter of filters){
      this.method(trace,filter.startsWith('title.')?'OpenAlex 严格题名核对':'OpenAlex 标识符核对');
      try{
        const response=await this.request('https://api.openalex.org/works?filter='+filter+'&select='+select+'&per-page=5','json',trace,deadline);
        const data=typeof response.response==='string'?JSON.parse(response.response):response.response;
        work=(data?.results||[]).find(row=>this.matches(ids,row));if(work)break;
      }catch(error){trace.message=this.describe(error).message;break;}
    }
    if(work){
      trace.work_id=String(work.id||'');
      const rank={publishedVersion:0,acceptedVersion:1,submittedVersion:2};
      const locations=[work.best_oa_location,work.primary_location,...(work.locations||[])].filter(Boolean).sort((a,b)=>(a.is_oa?0:100)+(rank[a.version]??3)*10-((b.is_oa?0:100)+(rank[b.version]??3)*10));
      const seen=new Set();
      // Keep direct PDF links ahead of landing pages so a blocked publisher does not hide a repository copy.
      for(const direct of [true,false])for(const row of locations){
        const url=this.url(direct?row.pdf_url:row.landing_page_url);if(!url||seen.has(url))continue;seen.add(url);
        resolvers.push({[direct?'url':'pageURL']:url,accessMethod:'OpenAlex / '+String(row.source?.display_name||row.version||'全文位置').slice(0,70)});
      }
    }
    return resolvers.slice(0,10);
  },
  configured(){
    const rows=[];
    for(const [pref,global] of [['findPDFs.resolvers',false],['extensions.researchnotebook.pdf.providers',true]]){
      try{const value=JSON.parse(Zotero.Prefs.get(pref,global)||'[]');rows.push(...(Array.isArray(value)?value:[value]));}catch(_){}
    }
    const seen=new Set();return rows.filter(r=>{
      if(!r||typeof r.url!=='string'||!this.url(r.url.replace(/\{doi\}/ig,'10.1234/test')))return false;
      const key=JSON.stringify([String(r.method||'GET').toUpperCase(),r.url,r.mode,r.selector,r.attribute,r.index,r.mappings]);
      if(seen.has(key))return false;seen.add(key);return true;
    }).slice(0,16);
  },
  jsonValues(data,selector){
    // Deliberately bounded JSON-path subset, with no evaluation of provider-supplied expressions.
    const tokens=String(selector||'$').replace(/^\.?\$\.?/,'').replace(/\[(\d+|\*)\]/g,'.$1').split('.').filter(Boolean);
    if(tokens.some(t=>!/^\w+$|^\*$/.test(t)||['__proto__','prototype','constructor'].includes(t)))throw new Error('Unsupported JSON selector');
    let values=[data];for(const key of tokens)values=values.flatMap(value=>key==='*'?(Array.isArray(value)?value:Object.values(value||{})):(value&&Object.prototype.hasOwnProperty.call(value,key)?[value[key]]:[])).slice(0,20);
    return values.flatMap(v=>Array.isArray(v)?v:[v]);
  },
  custom(item,m,trace,deadline){
    const ids=this.identifiers(item,m);if(!ids.doi)return [];
    return this.configured().map(provider=>async()=>{
      const name=String(provider.name||'自定义来源').slice(0,80);this.method(trace,name);
      if(String(provider.method||'GET').toUpperCase()!=='GET'){
        this.record(trace,{phase:'lookup',source:name,status:'unsupported',message:'此适配器仅支持 GET 解析器'});return [];
      }
      const url=this.url(provider.url.replace(/\{doi\}/ig,ids.doi));if(!url)return [];
      try{
        const json=String(provider.mode||'html').toLowerCase()==='json';
        const response=await this.request(url,json?'json':'document',trace,deadline);
        let values=[];
        if(json){
          const data=typeof response.response==='string'?JSON.parse(response.response):response.response;
          values=this.jsonValues(data,provider.selector).map(value=>typeof value==='string'?{url:value}:provider.mappings?{url:value?.[provider.mappings.url],pageURL:value?.[provider.mappings.pageURL]}:value);
        }else{
          const doc=response.response||response.responseXML;
          const nodes=provider.index!==undefined?[doc?.querySelectorAll(provider.selector||'#pdf')?.item(provider.index)]:Array.from(doc?.querySelectorAll(provider.selector||'#pdf')||[]);
          if(!nodes.some(Boolean))nodes.push(...Array.from(doc?.querySelectorAll('meta[name="citation_pdf_url"],embed[type="application/pdf"],object[type="application/pdf"]')||[]));
          values=nodes.filter(Boolean).map(node=>({url:node.getAttribute(provider.attribute||'src')||node.getAttribute('content')||node.getAttribute('data')||node.textContent}));
        }
        const resolved=values.map(value=>({url:this.url(value?.url,url),pageURL:this.url(value?.pageURL,url),referrer:url,accessMethod:name})).filter(r=>r.url||r.pageURL).slice(0,6);
        this.record(trace,{phase:'resolve',source:name,host:new URL(url).hostname,status:resolved.length?'resolved':'no_pdf_link',count:resolved.length});
        return resolved;
      }catch(error){this.record(trace,{phase:'resolve',source:name,host:new URL(url).hostname,...this.describe(error)});return [];}
    });
  },
  libgenMirrors(){
    let value;try{value=Zotero.Prefs.get('extensions.researchnotebook.pdf.libgenMirrors',true)||Zotero.Prefs.get('extensions.lgfetcher.mirrors',true);}catch(_){}
    if(value===false||value==='off')return [];
    const entries=value?String(value).split(/[\s,]+/):['https://libgen.li','https://libgen.la'];
    return [...new Set(entries.map(v=>this.url(v)).filter(Boolean))].slice(0,2);
  },
  async followDownload(url,trace,deadline,depth=0,seen=new Set()){
    url=this.url(url);if(!url||seen.has(url)||depth>3)return [];seen.add(url);
    if(/\.pdf(?:$|\?)|get\.php\?.*key=/i.test(url))return [{url,accessMethod:'LibGen / 明确匹配的文件'}];
    const response=await this.request(url,'document',trace,deadline),doc=response.response||response.responseXML;
    const nodes=Array.from(doc?.querySelectorAll('a[href],embed[src],iframe[src],meta[name="citation_pdf_url"]')||[]);
    for(const node of nodes){
      const next=this.url(node.getAttribute('href')||node.getAttribute('src')||node.getAttribute('content'),url);if(!next)continue;
      if(/\.pdf(?:$|\?)|get\.php\?.*key=/i.test(next))return [{url:next,referrer:url,accessMethod:'LibGen / 明确匹配的文件'}];
    }
    for(const node of nodes.filter(n=>/ads\.php|edition\.php|book\/index\.php|main\/|slow_download/i.test(n.getAttribute('href')||'')).slice(0,3)){
      const found=await this.followDownload(this.url(node.getAttribute('href'),url),trace,deadline,depth+1,seen);if(found.length)return found;
    }
    return [];
  },
  async libgen(item,m,trace,deadline){
    const ids=this.identifiers(item,m);if(!ids.doi)return [];
    for(const mirror of this.libgenMirrors()){
      this.method(trace,'LibGen DOI 检索 / '+new URL(mirror).hostname);
      try{
        const search=mirror.replace(/\/$/,'')+'/index.php?req='+encodeURIComponent(ids.doi)+'&res=25';
        const response=await this.request(search,'document',trace,deadline),doc=response.response||response.responseXML;
        for(const row of Array.from(doc?.querySelectorAll('table tr')||[]).slice(0,60)){
          const text=String(row.textContent||'');const anchors=Array.from(row.querySelectorAll('a[href]'));
          const dois=(text.match(/10\.\d{4,9}\/[^\s<>"#]+/ig)||[]).map(v=>this.doi(v));
          const exactDOI=dois.includes(ids.doi),exactTitle=anchors.some(a=>this.normalize(a.textContent)===this.normalize(ids.title));
          if(dois.length&&!exactDOI)continue;
          const rowYears=(text.match(/\b(?:18|19|20)\d{2}\b/g)||[]).map(Number);
          if(!exactDOI&&(!exactTitle||this.normalize(ids.title).length<8||(ids.year&&rowYears.length&&!rowYears.some(y=>Math.abs(y-ids.year)<=1))))continue;
          const detail=anchors.find(a=>/ads\.php|edition\.php|book\/index\.php|main\/|get\.php|\.pdf(?:$|\?)/i.test(a.getAttribute('href')||''));
          if(!detail)continue;
          const found=await this.followDownload(this.url(detail.getAttribute('href'),search),trace,deadline);if(found.length)return found;
        }
        this.record(trace,{phase:'match',host:new URL(mirror).hostname,status:'no_verified_match'});
      }catch(error){this.record(trace,{phase:'resolve',host:new URL(mirror).hostname,...this.describe(error)});}
    }
    return [];
  },
  wrapNative(resolvers,trace,deadline){
    return resolvers.map((resolver,index)=>typeof resolver==='function'?async()=>{
      this.checkDeadline(deadline);this.method(trace,'Zotero 开放全文查询 '+(index+1));
      try{return await resolver();}catch(error){this.record(trace,{phase:'resolve',...this.describe(error)});return [];}
    }:resolver);
  },
  async fetch(item,metadata={},options={}){
    const attempts=[],deadline=Date.now()+this.limitMs;let attachment=null,path='',sha256='',bytes=null,stageDeadline=deadline;
    const stages=[
      ['检索来源 PDF',()=>({resolvers:(metadata.pdf_urls||[]).map(url=>({url:this.url(url),accessMethod:'检索来源 PDF'})).filter(r=>r.url).slice(0,6)})],
      ['OpenAlex / arXiv',(trace)=>this.openAlex(item,metadata,trace,stageDeadline)],
      ['出版社 / Zotero 开放全文',trace=>this.wrapNative(Zotero.Attachments.getFileResolvers(item,['doi','url','oa']),trace,stageDeadline)],
      ['茉莉花 / 中文网页',()=>ResearchNotebookIntegrations.chineseResolvers(item)],
      ['已配置的扩展解析器',trace=>this.custom(item,metadata,trace,stageDeadline)],
      ['LibGen DOI 检索',trace=>this.libgen(item,metadata,trace,stageDeadline)]
    ];
    for(const [name,make] of stages){
      if(Date.now()>=deadline){attempts.push({source:name,status:'skipped',methods:[],requests:[],message:'本篇获取已达到时间上限'});break;}
      stageDeadline=Math.min(deadline,Date.now()+45000);
      const trace={source:name,status:'not_found',methods:[],requests:[]};attempts.push(trace);let directory;
      try{
        const produced=await make(trace),resolvers=Array.isArray(produced)?produced:produced.resolvers;
        if(!resolvers?.length){
          const issue=[...trace.requests].reverse().find(r=>r.message);
          trace.status=issue?'failed':trace.methods.length?'not_found':'skipped';trace.message=trace.message||issue?.message||produced.reason||'没有匹配的全文来源';continue;
        }
        directory=await Zotero.Attachments.createTemporaryStorageDirectory();
        const temp=PathUtils.join(directory.path,'fulltext.pdf');
        const result=await Zotero.Attachments.downloadFirstAvailableFile(resolvers,temp,{enforceFileType:true,shouldDisplayCaptcha:false,
          onAccessMethodStart:method=>this.method(trace,method),
          onBeforeRequest:url=>{this.checkDeadline(stageDeadline);if(!this.url(url))throw Object.assign(new Error('invalid URL'),{code:'invalid_url'});this.record(trace,{phase:'download',host:new URL(url).hostname,status:'requested'});},
          onRequestError:error=>{this.record(trace,{phase:'download',...this.describe(error)});return false;}
        });
        if(!result?.url||!await IOUtils.exists(temp)){
          const issue=[...trace.requests].reverse().find(r=>r.message);trace.message=issue?.message||'未解析到可下载 PDF';continue;
        }
        try{bytes=await ResearchNotebookLiterature.pdfBytes(temp);}catch(error){error.code='invalid_pdf';throw error;}sha256=ResearchNotebookLiterature.sha256(bytes);
        if(!options.bytesOnly){
          attachment=await Zotero.Attachments.importFromFile({file:temp,parentItemID:item.id,contentType:'application/pdf',title:'全文',fileBaseName:Zotero.Attachments.getFileBaseNameFromItem(item)});
          if(!attachment||attachment.parentItemID!==item.id)throw new Error('附件父项不一致');
          path=await attachment.getFilePathAsync();if(!path||!await IOUtils.exists(path))throw new Error('附件路径不可用');
        }
        trace.status='downloaded';trace.message='已取得并校验 PDF';trace.download_host=new URL(result.url).hostname;break;
      }catch(error){trace.status='failed';trace.message=this.describe(error).message;trace.error_code=this.describe(error).code;Zotero.logError(error);}
      finally{if(directory)try{await IOUtils.remove(directory.path,{recursive:true,ignoreAbsent:true});}catch(error){Zotero.logError(error);}}
    }
    const success=attempts.some(a=>a.status==='downloaded');if(!success){attachment=null;bytes=null;path='';sha256='';}
    const message=attempts.filter(a=>a.status!=='skipped'||a.requests.length).map(a=>a.source+'：'+(a.message||'未找到')).join('；')+(success?'':'。题录已保留；访问拒绝或验证页需在正常浏览器处理。');
    this.lastResult={time:new Date().toISOString(),item_key:item.key||'',doi:this.identifiers(item,metadata).doi,success,storage:options.bytesOnly?'verified_bytes':'managed_attachment',sha256,attempts,message};
    if(Zotero.ResearchNotebook?.path&&/^[A-Z0-9]{8}$/.test(item.key||''))try{
      const folder=Zotero.ResearchNotebook.path('.runtime','pdf-acquisition');await IOUtils.makeDirectory(folder,{ignoreExisting:true});
      await IOUtils.writeJSON(PathUtils.join(folder,item.key+'.json'),this.lastResult);
    }catch(error){Zotero.logError(error);}
    return {attachment,path,sha256,attempts,message,...(options.bytesOnly?{bytes}:{} )};
  }
};
