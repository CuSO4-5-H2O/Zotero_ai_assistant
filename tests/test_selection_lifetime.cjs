const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
function fixture(){
 let text='original selection',closed=0,stop;const listeners={};
 const doc={activeElement:null,getSelection:()=>({toString:()=>text}),addEventListener:(name,f)=>(listeners[name]??=[]).push(f),removeEventListener:(name,f)=>listeners[name]=listeners[name].filter(x=>x!==f)};
 doc.defaultView={document:doc,frames:[],setTimeout,clearTimeout};const box={contains:n=>!!n?.inside,addEventListener:doc.addEventListener,removeEventListener:doc.removeEventListener},view={_selectionRanges:[{}]};
 const context={Set,Array,Promise};vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../zotero-plugin/translation.js'),'utf8'),context);
 stop=context.ResearchNotebookTranslation.selectionLifetime({doc,reader:{_internalReader:{_primaryView:view}}},box,()=>{closed++;stop();});
 return {doc,view,cancel:()=>stop.selectionCancelled(),setText:v=>text=v,closed:()=>closed,emit:async(name,target={})=>{for(const f of [...listeners[name]||[]])f({target});await Promise.resolve();}};
}
(async()=>{
 let f=fixture();await f.emit('pointerdown');await f.emit('pointerup');assert.equal(f.closed(),0,'outside interaction must not close a retained selection');
 await f.emit('scroll');assert.equal(f.closed(),0);
 const button={inside:true};f.doc.activeElement=button;await f.emit('pointerdown',button);f.setText('');f.view._selectionRanges=[];await f.emit('selectionchange');await f.emit('pointerup',button);assert.equal(f.closed(),0,'excerpt control must protect translation panel');
 f.doc.activeElement=null;await f.emit('selectionchange');assert.equal(f.closed(),1,'actual source-selection cancellation closes panel');
 f=fixture();await f.emit('pointerenter');f.setText('');f.view._selectionRanges=[];await f.emit('selectionchange');assert.equal(f.closed(),0,'hovering must protect popup even without focus');await f.emit('pointerleave');assert.equal(f.closed(),1,'leave checks pending cancellation');
 f=fixture();await f.emit('pointerenter');f.doc.activeElement={inside:true};f.cancel();assert.equal(f.closed(),0,'explicit native cancellation waits while hovered');await f.emit('pointerleave');assert.equal(f.closed(),1,'stale focus and native ranges must not keep cancelled popup open');
 f=fixture();f.setText('');await f.emit('selectionchange');assert.equal(f.closed(),0,'reader ranges remain valid even if DOM selection is empty');
 f.view._selectionRanges=[{collapsed:true}];await f.emit('keyup');assert.equal(f.closed(),1,'collapsed PDF caret is not a text selection');
 f=fixture();f.setText('');await f.emit('pointerup');assert.equal(f.closed(),0);f.view._selectionRanges=[{collapsed:true}];await new Promise(resolve=>setTimeout(resolve,100));assert.equal(f.closed(),1,'recheck after Zotero updates ranges after pointerup capture');
 console.log('PASS: retained selections survive outside clicks/scroll and excerpt controls; actual source cancellation closes; native range fallback and listener cleanup work.');
})().catch(e=>{console.error(e);process.exitCode=1;});
