const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const bytes=new Uint8Array(Buffer.from('test-update')),digest=crypto.createHash('sha256').update(bytes).digest('hex');
let release={id:'research-notebook@local.research',version:'1.3.1',file:'research-notebook-1.3.1.xpi',bytes:bytes.length,sha256:digest},installs=0,listener,report=[];
const install={addon:{id:release.id,version:'1.3.1',isCompatible:true,appDisabled:false},error:0,addListener:value=>listener=value,removeListener(){},cancel(){},async install(){installs++;listener.onInstallEnded();}};
const owner={id:release.id,version:'1.3.0',path:(...p)=>'E:/ResearchNotebook/'+p.join('/')};
const context={console,Uint8Array,Date,setInterval:()=>1,clearInterval(){},crypto:crypto.webcrypto,Services:{vc:{compare:(a,b)=>a.localeCompare(b,undefined,{numeric:true})}},Zotero:{File:{pathToFile:path=>path},logError(){}},IOUtils:{readJSON:async()=>release,read:async()=>bytes,writeJSON:async(path,value)=>report.push(value)},ChromeUtils:{importESModule:()=>({AddonManager:{getInstallForFile:async()=>install}})}};
vm.createContext(context);vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../zotero-plugin/updater.js'),'utf8'),context);
(async()=>{
 const updater=context.ResearchNotebookUpdater;updater.owner=owner;updater.active=true;
 const [a,b]=await Promise.all([updater.check(true),updater.check(true)]);assert.equal(a.state,'installed');assert.equal(b.state,'installed');assert.equal(installs,1);assert.equal(report.at(-1).state,'installed');
 owner.version='1.3.1';assert.equal((await updater.check()).state,'current');assert.equal(installs,1);
 owner.version='1.3.0';release={...release,sha256:'0'.repeat(64)};await assert.rejects(()=>updater.check(true),/校验失败/);assert.equal(installs,1);
 release={...release,sha256:digest,id:'wrong@plugin.local'};await assert.rejects(()=>updater.check(true),/描述不合法/);
 release={...release,id:owner.id};install.addon.isCompatible=false;await assert.rejects(()=>updater.check(true),/不兼容/);assert.equal(installs,1);
 updater.stop();assert.equal(updater.active,false);
 console.log('PASS: native AddonManager update after hash/ID/version/compatibility checks; concurrent requests deduplicated; downgrade skipped; tampering rejected; cleanup.');
})().catch(error=>{console.error(error);process.exitCode=1;});
