const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('E:/ResearchNotebook/web/shared.js','utf8').replace(/\r\n/g,'\n');
const match=source.match(/  function foldReportSections\(root\) \{[\s\S]*?\n  \}\n  function paintMath/);assert(match);
class Element{
 constructor(tag,text=''){this.tagName=tag.toUpperCase();this.textContent=text;this.children=[];this.parent=null;this.className='';this.open=false;}
 append(...items){for(const item of items){item.remove();item.parent=this;this.children.push(item);}}
 before(item){const parent=this.parent;item.remove();item.parent=parent;parent.children.splice(parent.children.indexOf(this),0,item);}
 remove(){if(this.parent){const i=this.parent.children.indexOf(this);if(i>=0)this.parent.children.splice(i,1);this.parent=null;}}
 get nextElementSibling(){if(!this.parent)return null;const items=this.parent.children;return items[items.indexOf(this)+1]||null;}
 closest(selector){if(selector!=='details.research-fold')return null;for(let p=this.parent;p;p=p.parent)if(p.tagName==='DETAILS'&&p.className==='research-fold')return p;return null;}
 querySelectorAll(selector){const out=[];const visit=n=>{for(const c of n.children){if(selector==='h3'&&c.tagName==='H3')out.push(c);visit(c);}};visit(this);return out;}
}
const context={document:{createElement:tag=>new Element(tag)}};vm.createContext(context);vm.runInContext(match[0].replace(/\n  function paintMath$/,''),context);
const root=new Element('article'),a=new Element('h3','展开｜C7 · 研究流程'),p=new Element('p','步骤'),h4=new Element('h4','结果'),q=new Element('p','数据'),b=new Element('h3','展开｜C18 · 反馈'),r=new Element('p','实验'),end=new Element('h2','下一章'),ordinary=new Element('h3','普通标题');root.append(a,p,h4,q,b,r,end,ordinary);
context.foldReportSections(root);assert.deepEqual(root.children.map(n=>n.tagName),['DETAILS','DETAILS','H2','H3']);assert.equal(root.children[0].children[0].textContent,'C7 · 研究流程');assert.equal(root.children[0].open,false);assert.deepEqual(root.children[0].children[1].children,[p,h4,q]);assert.equal(root.children[1].children[1].children[0],r);context.foldReportSections(root);assert.equal(root.children.length,4);
console.log('PASS: independent collapsed sections retain headings, body, next section and idempotence');
