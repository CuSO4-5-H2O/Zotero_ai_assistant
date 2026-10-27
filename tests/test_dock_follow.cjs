const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
let selected='library',timer,events=[],opened=[],activeId=null,release;
const win={closed:false,Zotero_Tabs:{get selectedID(){return selected;}},setInterval(fn){timer=fn;return 1;},clearInterval(){timer=null;}};
const readers={one:{itemID:1},two:{itemID:2},three:{itemID:3}};
const ctx={Map,Services:{wm:{}},IOUtils:{exists:async()=>true},Zotero:{getMainWindow:()=>win,Reader:{getByTabID:id=>readers[id]||null,_readers:[]},Items:{getAsync:async id=>({attachmentContentType:id===3?'text/html':'application/pdf',getFilePathAsync:async()=>'/storage/file.pdf'})},logError:e=>{throw e;}}};
vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'../zotero-plugin/notebook.js'),'utf8'),ctx);
const plugin=ctx.ResearchNotebookPlugin;plugin.active=true;plugin.registerSelected=async(_win,r)=>{if(r.itemID===1&&release)await new Promise(res=>release=res);return {id:'A'+r.itemID};};plugin.request=async(_path,payload)=>events.push(payload.event);plugin.openSelected=async(_win,r)=>opened.push(r.itemID);plugin.openPage=async()=>opened.push('home');
const dock={panel:{style:{display:'flex'}},channel:'x',cleanups:[]};
(async()=>{
 await plugin.openActiveOrHome(win);assert.deepEqual(opened,['home']);selected='one';await plugin.openActiveOrHome(win);assert.deepEqual(opened,['home',1]);
 selected='library';plugin.followReader(win,dock);await timer();assert.equal(events.length,0);
 selected='one';await timer();assert.equal(events.length,1);assert.equal(events[0].paper_id,'A1');assert.equal(events[0].intent,'follow_reader');
 await timer();assert.equal(events.length,1,'same PDF is not repeatedly registered');
 selected='two';await timer();assert.equal(events.at(-1).paper_id,'A2');
 dock.panel.style.display='none';selected='one';await timer();assert.equal(events.length,2,'hidden dock does not navigate');dock.panel.style.display='flex';
 selected='three';await timer();assert.equal(events.length,2,'non-PDF reader is ignored');
 release=true;selected='one';const pending=timer();await new Promise(r=>setImmediate(r));selected='two';release();await pending;assert.equal(events.length,2,'slow response from previous reader must be discarded');await timer();assert.equal(events.at(-1).paper_id,'A2');
 dock.cleanups.forEach(f=>f());assert.equal(timer,null);console.log('PASS: active reader selection, automatic PDF follow, hidden dock, non-PDF, race and cleanup');
})().catch(error=>{console.error(error);process.exitCode=1;});
