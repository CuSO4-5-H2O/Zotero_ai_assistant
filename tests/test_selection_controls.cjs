const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
class Element{
 constructor(tag){this.tag=tag;this.children=[];this.listeners={};this.attrs={};this.style={};this.textContent='';this.hidden=false;this.isConnected=true;this.selectionStart=this.selectionEnd=0;this._value='';}
 append(...children){for(const e of children){this.children.push(e);e.parent=this;}}
 setAttribute(k,v){this.attrs[k]=v;}addEventListener(k,f){(this.listeners[k]??=[]).push(f);}removeEventListener(){}
 replaceChildren(...c){this.children=[];this.append(...c);}remove(){this.isConnected=false;}
 get options(){return this.children;}get selectedOptions(){return this.children.filter(c=>c.value===this.value);}
 get value(){return this._value||(this.tag==='select'?this.children[0]?.value||'':'');}set value(v){this._value=v;}
 async emit(type,extra={}){const event={target:this,preventDefault(){},stopPropagation(){},...extra};await Promise.all((this.listeners[type]||[]).map(f=>f(event)));}
}
const preferences=new Map(),saved=[],body=new Element('body');
const doc={body,activeElement:null,createElement:tag=>new Element(tag),defaultView:{addEventListener(){},removeEventListener(){}}};
const context={Map,Set,WeakMap,Date,clearTimeout,setTimeout,Zotero:{Prefs:{get:key=>preferences.get(key),set:(key,value)=>preferences.set(key,value)},logError(){}},ResearchNotebookTranslation:{
 selectedText:out=>out.value.slice(out.selectionStart,out.selectionEnd),fit(){},floating:()=>({dispose(){}}),selectionLifetime:()=>()=>{},subscribe:()=>({cancel(){},promise:Promise.resolve({text:'full translation'})})}};
vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../zotero-plugin/notebook.js'),'utf8'),context);
const plugin=context.ResearchNotebookPlugin;Object.assign(plugin,{active:true,selectionStates:new WeakMap(),selectionPanels:new Set()});
plugin.request=async()=>({notes:[{id:'a'.repeat(32),title:'Target note',folder:'My notes'}]});
plugin.saveTextToTarget=async(r,a,text)=>{saved.push({text,target:preferences.get('extensions.researchnotebook.notes.defaultTarget')||'paper'});return {target:'paper'};};
function all(node){return [node,...node.children.flatMap(all)];}
(async()=>{
 const reader={};plugin.selectionPopup({doc,reader,params:{annotation:{text:'original text'}}});await plugin.selectionStates.get(reader).pending;
 const originalState=plugin.selectionStates.get(reader);plugin.selectionPopup({doc,reader,params:{annotation:{text:'original text'}}});assert.equal(plugin.selectionStates.get(reader),originalState,'duplicate native selection events must preserve the panel');
 const nodes=all(body),buttons=nodes.filter(e=>e.tag==='button'),button=buttons.find(e=>e.textContent==='摘录到笔记'),output=nodes.find(e=>e.tag==='textarea'),panel=nodes.find(e=>e.className==='rn-note-destination');
 assert(button&&button.disabled);assert(panel.hidden);for(const label of ['复制','加入本文笔记','新建笔记','查看报告'])assert(!buttons.some(b=>b.textContent===label),label);
 output.selectionStart=0;output.selectionEnd=4;await output.emit('select');assert(!button.disabled);await button.emit('click');assert.equal(saved.at(-1).text,'full');
 output.selectionStart=output.selectionEnd=0;await output.emit('select');assert(button.disabled);const count=saved.length;await button.emit('click');assert.equal(saved.length,count,'no selection must never save the full output');
 output.selectionStart=4;output.selectionEnd=5;await output.emit('select');assert(button.disabled);await button.emit('click');assert.equal(saved.length,count,'whitespace selection must not save');
 await button.emit('contextmenu');assert(!panel.hidden);
 const destination=nodes.find(n=>n.attrs['aria-label']==='默认笔记保存位置');destination.value='existing';await destination.emit('change');await Promise.resolve();
 const choices=nodes.find(n=>n.attrs['aria-label']==='选择已有笔记');choices.value='a'.repeat(32);await choices.emit('change');
 assert.equal(preferences.get('extensions.researchnotebook.notes.defaultNoteId'),'a'.repeat(32));assert(button.disabled);output.selectionStart=0;output.selectionEnd=4;await output.emit('select');await button.emit('click');assert.equal(saved.at(-1).target,'existing');
 const before=saved.length;await Promise.all([button.emit('click'),button.emit('click')]);assert.equal(saved.length,before+1);
 await button.emit('keydown',{key:'F10',shiftKey:true});assert(panel.hidden);
 const web=fs.readFileSync(path.join(__dirname,'../web/shared.js'),'utf8');assert(!web.includes('copy-translation'));assert(!web.includes('||result.text'));assert(web.includes('savingSelectionNote||!selected'));assert(web.includes('!selectedTranslationText()'));assert(web.includes("addEventListener('contextmenu',toggleNoteDestination)"));
 const settings=nodes.find(n=>n.attrs['aria-label']==='翻译设置'),settingsPanel=nodes.find(n=>n.attrs['aria-label']==='自动翻译设置');
 assert(settingsPanel.hidden);await settings.emit('click');assert(!settingsPanel.hidden);
 const disable=nodes.find(n=>n.textContent==='关闭窗口，不再自动翻译');await disable.emit('click');
 assert.equal(plugin.automaticTranslation(),false);assert.equal(plugin.selectionPanels.size,0);assert(!originalState.box.isConnected);
 const otherReader={};plugin.selectionPopup({doc,reader:otherReader,params:{annotation:{text:'new selection'}}});assert(!plugin.selectionStates.has(otherReader),'disabled automatic translation must not create a panel or send a request');
 plugin.setAutomaticTranslation(true);plugin.selectionPopup({doc,reader:otherReader,params:{annotation:{text:'new selection'}}});await plugin.selectionStates.get(otherReader).pending;
 const restored=plugin.selectionStates.get(otherReader);assert(restored.box.isConnected);
 await all(restored.box).find(n=>n.textContent==='关闭当前窗口').emit('click');assert(!restored.box.isConnected);assert(plugin.automaticTranslation(),'close current must not disable future translations');
 console.log('PASS: excerpt controls; settings; persistent disable blocks new panels; re-enable restores translation; close current preserves preference.');
})().catch(error=>{console.error(error);process.exitCode=1;});
