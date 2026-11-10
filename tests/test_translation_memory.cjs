'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
let requests=[];
const context={Zotero:{HTTP:{async request(method,url,options){const xhr={onprogress:null};requests.push(xhr);options.requestObserver(xhr);return {responseText:JSON.stringify({type:'done',text:'translated'})+'\n'};}}}};
vm.createContext(context);vm.runInContext(fs.readFileSync('zotero-plugin/translation.js','utf8'),context);
const helper=context.ResearchNotebookTranslation;
(async()=>{
 const owner={translationJobs:new Map(),ensureService:async()=>({port:1,key:'fixture'})};
 for(let i=0;i<80;i++){
  const sub=helper.subscribe(owner,'source '+i,'Chinese',()=>{});
  await sub.promise;
  for(const job of owner.translationJobs.values()){assert.equal(job.xhr,null);assert.equal(job.listeners.size,0);}
 }
 assert.equal(owner.translationJobs.size,24);
 assert.ok(requests.every(xhr=>xhr.onprogress===null));
 for(let i=0;i<8;i++)owner.translationJobs.set('large'+i,{done:true,text:'x'.repeat(90000)});
 helper.trimCache(owner);
 assert.ok([...owner.translationJobs].reduce((s,[k,j])=>s+k.length+j.text.length,0)<=262144);
 console.log('PASS: completed requests and callbacks released; repeated translations bounded by count and character budget');
})().catch(e=>{console.error(e);process.exitCode=1;});
