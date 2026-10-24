/* Updates only this plugin from its explicitly configured local release directory. */
var ResearchNotebookUpdater = {
  owner:null,timer:null,busy:null,active:false,lastFailure:null,
  start(owner){
    this.owner=owner;this.active=true;
    this.timer=setInterval(()=>this.check().catch(error=>Zotero.logError(error)),300000);
    this.check().catch(error=>Zotero.logError(error));
  },
  stop(){this.active=false;if(this.timer)clearInterval(this.timer);this.timer=null;},
  async report(data){
    await IOUtils.writeJSON(this.owner.path('.runtime','plugin-update-status.json'),{time:new Date().toISOString(),from:this.owner.version,...data});
  },
  async check(manual=false){
    if(!this.active)return {state:'disabled'};
    if(this.busy)return this.busy;
    this.busy=this.perform(manual);
    try{return await this.busy;}finally{this.busy=null;}
  },
  async perform(manual){
    const owner=this.owner;let release;
    try{release=await IOUtils.readJSON(owner.path('dist','latest.json'));}
    catch(error){if(error.name==='NotFoundError'||error.becauseNoSuchFile)return {state:'no-release'};throw error;}
    if(release.id!==owner.id||!/^\d+\.\d+\.\d+$/.test(release.version||'')||release.file!=='research-notebook-'+release.version+'.xpi'||!/^[a-f0-9]{64}$/i.test(release.sha256||'')||!Number.isInteger(release.bytes)||release.bytes<1||release.bytes>5_000_000)throw new Error('本地插件更新描述不合法');
    if(Services.vc.compare(release.version,owner.version)<=0)return {state:'current',version:owner.version};
    const signature=release.version+':'+release.sha256;
    if(!manual&&this.lastFailure?.signature===signature&&Date.now()-this.lastFailure.time<600000)return {state:'retry-later'};
    try{
      const path=owner.path('dist',release.file),bytes=await IOUtils.read(path);
      if(bytes.length!==release.bytes)throw new Error('本地更新包大小不匹配');
      const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(n=>n.toString(16).padStart(2,'0')).join('');
      if(digest!==release.sha256.toLowerCase())throw new Error('本地更新包校验失败，已取消更新');
      if(!this.active)return {state:'disabled'};
      const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
      const install=await AddonManager.getInstallForFile(Zotero.File.pathToFile(path));
      if(!install?.addon||install.error||install.addon.id!==owner.id||install.addon.version!==release.version){install?.cancel?.();throw new Error('更新包的插件标识、版本或兼容性不匹配');}
      if(!install.addon.isCompatible||install.addon.appDisabled){install.cancel();throw new Error('本地更新包不兼容当前 Zotero');}
      await this.report({state:'installing',to:release.version,sha256:digest});
      await new Promise((resolve,reject)=>{
        const finish=error=>{install.removeListener(listener);error?reject(error):resolve();};
        const listener={onInstallEnded(){finish();},onInstallFailed(){finish(new Error('Zotero 安装更新失败（'+install.error+'）'));},onDownloadFailed(){finish(new Error('Zotero 读取更新包失败'));},onInstallCancelled(){finish(new Error('插件更新已取消'));}};
        install.addListener(listener);
        try{Promise.resolve(install.install()).catch(error=>finish(error));}catch(error){finish(error);}
      });
      this.lastFailure=null;await this.report({state:'installed',to:release.version,sha256:digest});return {state:'installed',version:release.version};
    }catch(error){this.lastFailure={signature,time:Date.now()};await this.report({state:'failed',to:release.version,error:error.message});throw error;}
  }
};
