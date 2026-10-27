const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const win={Zotero_Tabs:{selectedID:'selected-pdf'}},attachment={id:71,key:'CURRENT1',attachmentContentType:'application/pdf',getFilePathAsync:async()=>'/storage/CURRENT1/paper.pdf'};
const reader={itemID:71,_internalReader:{_state:{primaryViewState:{pageIndex:4}}}};
let active=win,exists=true,registrations=[];
const context={Map,Services:{wm:{getMostRecentWindow:()=>active}},IOUtils:{exists:async()=>exists},Zotero:{getMainWindow:()=>win,Reader:{getByTabID:id=>id==='selected-pdf'?reader:null,_readers:[]},Items:{getAsync:async()=>attachment}}};
vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../zotero-plugin/notebook.js'),'utf8'),context);
const plugin=context.ResearchNotebookPlugin;plugin.registerSelected=async(win,r)=>{registrations.push(r.itemID);return {id:'A3',title:'Selected paper',zotero:{attachment_key:'CURRENT1'}};};
(async()=>{
 let result=await plugin.nativeAction({action:'current_reader'});assert(result.available);assert.equal(result.paper.id,'A3');assert.equal(result.page,5);assert.deepEqual(registrations,[71]);
 win.Zotero_Tabs.selectedID='library';result=await plugin.nativeAction({action:'current_reader'});assert(!result.available);assert.equal(registrations.length,1);
 const detached={itemID:72,_window:{},_internalReader:{_state:{primaryViewState:{pageIndex:8}}}};context.Zotero.Reader._readers=[reader,detached];active=detached._window;
 result=await plugin.nativeAction({action:'current_reader'});assert(result.available);assert.equal(result.page,9);assert.equal(registrations.at(-1),72);
 exists=false;await assert.rejects(()=>plugin.nativeAction({action:'current_reader'}),/本地文件不可用/);
 console.log('PASS: only active PDF tab or focused detached reader selected; real page index forwarded; library tab never guesses a stale PDF; missing file rejected.');
})().catch(e=>{console.error(e);process.exitCode=1;});
