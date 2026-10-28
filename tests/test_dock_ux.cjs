'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

// Self-contained demo data: no Zotero library, notes, credentials or AI API.
const web = path.join(__dirname, '..', 'web');
const mime = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2'};
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const relative = pathname === '/' ? 'dock.html' : pathname === '/vault' ? 'index.html' : pathname.startsWith('/paper/') ? 'paper.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(web, relative);
  if (!file.startsWith(path.resolve(web) + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end(); return; }
    res.writeHead(200, {'content-type': mime[path.extname(file)] || 'application/octet-stream'}).end(data);
  });
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless:true, ...(process.env.RN_BROWSER ? {executablePath:process.env.RN_BROWSER} : {})});
  try {
    const context = await browser.newContext({viewport:{width:380,height:720}});
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let content = '初始笔记', version = 1, failNextWrite = false, holdNextWrite = false, releaseWrite, signalHeld;
    const held = new Promise(resolve => {signalHeld=resolve;});
    const paper = () => ({id:'A11',title:'示例论文',author:'示例作者',year:'2026',venue:'',type:'示例',url:'',guide_html:'',has_pdf:false,starred:false,reading:{content,html:'<p>示例</p>',version:'v'+version}});
    const answer = '共同的测试文字。用于检查追加操作。';
    await context.route('**/api/**', async route => {
      const url = new URL(route.request().url()), method = route.request().method();
      const respond = json => route.fulfill({status:200,json});
      if (url.pathname === '/api/notes') return respond({folders:['我的笔记'],notes:[]});
      if (url.pathname === '/api/papers') return respond([paper()]);
      if (url.pathname === '/api/papers/A11') return respond(paper());
      if (url.pathname === '/api/papers/A11/chat') return respond({version:'1',messages:[{id:'answer1',role:'assistant',content:answer,html:'<p>'+answer+'</p>',question:'示例问题'}],recent_actions:[],can_undo:false});
      if (url.pathname === '/api/papers/A11/reading' && method === 'POST') {
        const data = route.request().postDataJSON();
        if (failNextWrite) { failNextWrite = false; return route.fulfill({status:503,json:{error:'模拟连接失败'}}); }
        if (holdNextWrite) { holdNextWrite=false; signalHeld(); await new Promise(resolve => {releaseWrite=resolve;}); }
        if (data.version !== 'v'+version) return route.fulfill({status:409,json:{error:'精读笔记已被修改'}});
        content = data.content; version++;
        return respond({version:'v'+version,content,html:'<p>已保存</p>'});
      }
      if (url.pathname === '/api/preview') {
        const text = route.request().postDataJSON().content || '';
        const html = text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('\n','<br>');
        return respond({html:'<p>'+html+'</p>'});
      }
      return route.fulfill({status:404,json:{error:'demo endpoint unavailable'}});
    });
    await page.goto('http://127.0.0.1:'+server.address().port+'/?paper=A11');
    await page.waitForFunction(() => document.querySelector('#context-badge')?.textContent.includes('A11'));

    // All seven sections and settings are visible in two rows at Zotero's minimum width.
    for (const width of [340,380,620]) {
      await page.setViewportSize({width,height:720});
      const layout = await page.locator('.dock-tabs').evaluate(nav => {
        const buttons = [...nav.querySelectorAll('button')].filter(b => getComputedStyle(b).display !== 'none');
        return {rows:new Set(buttons.map(b=>Math.round(b.getBoundingClientRect().top))).size, count:buttons.length,
          overflow:nav.scrollWidth > nav.clientWidth || buttons.some(b=>b.scrollWidth>b.clientWidth+1)};
      });
      assert.equal(layout.count, 8, 'seven navigation buttons and settings should be available');
      assert.equal(layout.rows, 2, 'navigation should take two rows at '+width+'px');
      assert.equal(layout.overflow, false, 'navigation must fit without horizontal clipping at '+width+'px');
    }
    await page.setViewportSize({width:380,height:720});
    if (process.env.RN_SCREENSHOT) await page.screenshot({path:process.env.RN_SCREENSHOT});

    await page.locator('[data-pane=assistant]').click();
    await page.waitForSelector('.chat-answer p');
    const excerpt = async () => {
      await page.evaluate(() => {
        const node=document.querySelector('.chat-answer p').firstChild,range=document.createRange();
        range.setStart(node,0); range.setEnd(node,4);
        const selection=window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        document.querySelector('.chat-answer p').dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
      });
      await page.locator('#chat-selection-excerpt').click();
      await page.waitForFunction(() => document.querySelector('#chat-selection-excerpt').hidden);
    };
    await excerpt();
    await excerpt();
    assert.equal((content.match(/> 共同的测/g) || []).length,2,'a new excerpt action should append even when text is identical');

    failNextWrite = true;
    await page.evaluate(() => {
      const node=document.querySelector('.chat-answer p').firstChild,range=document.createRange();
      range.setStart(node,8); range.setEnd(node,12);
      const selection=window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      document.querySelector('.chat-answer p').dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
    });
    await page.locator('#chat-selection-excerpt').click();
    await page.waitForFunction(() => document.querySelector('#chat-status').textContent.includes('保存未成功'));
    await page.locator('#chat-selection-excerpt').click();
    await page.waitForFunction(() => document.querySelector('#chat-selection-excerpt').hidden);
    assert.equal((content.match(/> 用于检查/g) || []).length,1,'retrying a failed save must not append twice');

    await page.locator('[data-pane=current]').click();
    await page.locator('#paper-edit-toggle').click();
    await page.locator('#reading-editor').fill(content+'\n\n尚未保存的用户草稿');
    await page.locator('[data-pane=assistant]').click();
    await page.getByRole('button',{name:'追加到本文献笔记'}).click();
    await page.waitForFunction(() => document.querySelector('#chat-status').textContent.includes('已追加'));
    assert(content.includes('尚未保存的用户草稿'), 'append must include the in-memory note draft');
    assert(content.includes(answer), 'append must include the full answer');
    assert.equal(await page.locator('#compare-conflict').isVisible(),false,'append must not create an avoidable conflict');
    await page.locator('[data-deepseek-settings]').first().click();
    assert(await page.locator('#ai-settings').isVisible(),'settings remains reachable from the compact navigation');
    await page.locator('#ai-close').click();

    // Standalone paper view must keep edits made while an excerpt save is in flight.
    const standalone=await context.newPage();
    await standalone.goto('http://127.0.0.1:'+server.address().port+'/paper/A11');
    await standalone.waitForFunction(() => document.querySelector('#paper-title')?.textContent === '示例论文');
    await standalone.locator('[data-tab=reading]').click();
    await standalone.locator('#toggle-reading-edit').click();
    holdNextWrite=true;
    const pending=standalone.evaluate(() => ResearchUI.appendSelectionNote('paper:A11','> 独立视图摘录'));
    await held;
    await standalone.locator('#reading-editor').fill('请求期间输入的新草稿');
    releaseWrite();
    await pending;
    assert.equal(await standalone.locator('#reading-editor').inputValue(),'请求期间输入的新草稿','a pending excerpt save must not replace later edits');
    assert((await standalone.locator('#reading-status').innerText()).includes('尚未保存'),'later edits must remain marked as unsaved');
    await standalone.locator('#save-reading').click();
    await standalone.waitForFunction(() => document.querySelector('#reading-status').textContent.includes('精读笔记已保存'));
    assert.equal(content,'请求期间输入的新草稿');

    // The separate warehouse editor also retries a failed append without duplicating it.
    const vaultContext=await browser.newContext({viewport:{width:1100,height:720}}),vault=await vaultContext.newPage();
    let vaultContent='原始仓库笔记',vaultVersion=1,vaultFail=true;
    const note=()=>({id:'demo',title:'示例笔记',folder:'我的笔记',tags:[],content:vaultContent,version:'v'+vaultVersion,
      updated:'2026-01-01T00:00:00Z',html:'<p>示例笔记</p>',starred:false,trashed:false,excerpt:'示例'});
    await vaultContext.route('**/api/**',async route=>{
      const url=new URL(route.request().url()),method=route.request().method();
      if(url.pathname==='/api/notes'&&method==='GET')return route.fulfill({json:{notes:[note()],folders:['我的笔记'],counts:{'我的笔记':1},total:1,trash:0}});
      if(url.pathname==='/api/notes/demo'&&method==='GET')return route.fulfill({json:note()});
      if(url.pathname==='/api/notes/demo'&&method==='POST'){
        if(vaultFail){vaultFail=false;return route.fulfill({status:503,json:{error:'模拟连接失败'}});}
        const data=route.request().postDataJSON();assert.equal(data.version,'v'+vaultVersion);vaultContent=data.content;vaultVersion++;
        return route.fulfill({json:note()});
      }
      if(url.pathname==='/api/preview')return route.fulfill({json:{html:'<p>示例</p>'}});
      return route.fulfill({status:404,json:{error:'demo endpoint unavailable'}});
    });
    await vault.goto('http://127.0.0.1:'+server.address().port+'/vault');
    await vault.waitForFunction(()=>document.querySelector('#editor')?.value==='原始仓库笔记');
    const tryAppend=()=>vault.evaluate(async()=>{try{await ResearchUI.appendSelectionNote('demo','> 仓库摘录');return 'ok';}catch(_){return 'failed';}});
    assert.equal(await tryAppend(),'failed');
    assert.equal(await tryAppend(),'ok');
    assert.equal((vaultContent.match(/> 仓库摘录/g)||[]).length,1,'retry should not duplicate the unsaved warehouse excerpt');
    assert.equal(await tryAppend(),'ok');
    assert.equal((vaultContent.match(/> 仓库摘录/g)||[]).length,2,'a later independent action may append the same excerpt');
    assert.deepEqual(errors,[]);
    console.log('PASS: compact dock, repeated and retried excerpts, draft-safe answer append, in-flight edits and warehouse retry');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => {console.error(error); server.close(); process.exitCode=1;});
