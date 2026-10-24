'use strict';
(()=>{
  const {api}=ResearchUI,$=id=>document.getElementById(id);let timer=null,state=null,quickModels=[],quickBusy=false;
  const effortNames={none:'关闭推理 · 最快',minimal:'最轻',low:'低 · 快速',medium:'中 · 均衡',high:'高 · 深入',xhigh:'很高',max:'最高',ultra:'极限'};
  const host=document.createElement('div');host.innerHTML=`<dialog id="ai-settings" aria-label="AI 与工程设置"><header><h2>AI 与工程设置</h2><button id="ai-close" aria-label="关闭设置">×</button></header>
  <p class="small">助手与翻译可以分别选择服务。ChatGPT 使用你在官方页面允许的订阅额度；DeepSeek 按 API 账户计费。</p>
  <div class="ai-service-grid"><label>AI 助手<select id="ai-provider"><option value="deepseek">DeepSeek</option><option value="chatgpt">ChatGPT 订阅</option></select></label><label>划词翻译<select id="ai-translation"><option value="deepseek">DeepSeek</option><option value="chatgpt">ChatGPT 订阅</option></select></label></div>
  <section class="ai-account-card"><h3>ChatGPT</h3><label>账号<select id="ai-account" aria-label="ChatGPT 账号"></select></label><div class="ai-buttons"><button id="ai-login" class="primary">Continue with ChatGPT</button><button id="ai-add-account">添加账号</button><button id="ai-logout">退出此账号</button></div><label>可用模型<select id="ai-model" aria-label="ChatGPT 可用模型"><option value="">登录后加载模型</option></select></label><button id="ai-refresh-models">刷新模型</button><p id="ai-account-status" role="status" class="small"></p></section>
  <div class="ai-buttons"><button id="ai-deepseek">配置 DeepSeek API</button><a href="https://chatgpt.com/#settings" target="_blank" rel="noopener noreferrer">ChatGPT 用量与授权 ↗</a></div>
  <details class="ai-project-settings"><summary>工程目录</summary><p class="small">助手可读取、新建、编辑和恢复此目录内的文本、代码与数据文件。修改保留历史；CST 等二进制工程不直接改写。</p><label>当前工程目录<input id="project-root" placeholder="例如 E:\\我的科研工程" autocomplete="off"></label><button id="project-save">应用目录</button><p id="project-status" role="status" class="small"></p></details>
  <p id="ai-settings-status" role="status"></p><footer><button id="ai-save" class="primary">保存服务与模型</button></footer></dialog>`;document.body.append(host);
  const status=t=>$('ai-settings-status').textContent=t;
  function accounts(data){state=data;const c=data.chatgpt;$('ai-account').replaceChildren();const empty=document.createElement('option');empty.value='';empty.textContent='添加 ChatGPT 账号';$('ai-account').append(empty);for(const a of c.accounts){const o=document.createElement('option');o.value=a.id;o.textContent=a.label+' · '+a.suffix+(a.connected?'':' · 已退出');$('ai-account').append(o);}$('ai-account').value=c.active||'';$('ai-account-status').textContent=c.notice||'登录授权后显示当前账号可用的模型。';$('ai-logout').disabled=!c.accounts.find(a=>a.id===c.active)?.connected;}
  async function models(refresh=false){const previous=$('ai-model').value||state?.model;const rows=(await api('/api/ai/models'+(refresh?'?refresh=1':''))).models;$('ai-model').replaceChildren();for(const m of rows){const o=document.createElement('option');o.value=m.id;o.textContent=m.name;$('ai-model').append(o);}if(rows.some(m=>m.id===previous))$('ai-model').value=previous;if(!rows.length){const o=document.createElement('option');o.value='';o.textContent='此账号暂无可用模型';$('ai-model').append(o);}}
  function badge(data){const el=$('chat-provider');if(el)el.textContent=data.assistant==='chatgpt'?'ChatGPT · '+(data.model||'请选择模型'):'DeepSeek · '+(data.deepseek_model||data.deepseek.model);renderQuick(data);}
  async function load(){const data=await api('/api/ai/settings');accounts(data);badge(data);return data;}
  const quickHost=$('chat-provider')?.parentElement;
  if(quickHost){const row=document.createElement('div');row.className='chat-model-controls';row.innerHTML='<label>模型<select id="chat-model-select" aria-label="助手模型"><option>正在加载模型…</option></select></label><label>推理等级<select id="chat-effort-select" aria-label="助手推理等级"><option value="">默认</option></select></label><button id="chat-model-refresh" type="button" class="quiet" title="刷新可用模型">↻</button><small id="chat-model-status" role="status">下一次提问生效</small>';quickHost.after(row);}
  function selectedQuick(data=state){return quickModels.find(m=>m.provider===data?.assistant&&m.id===(data.assistant==='chatgpt'?data.model:data.deepseek_model||data.deepseek.model));}
  function fillEfforts(model,previous){
    const select=$('chat-effort-select');if(!select)return;select.replaceChildren();
    const defaultOption=document.createElement('option');defaultOption.value='';defaultOption.textContent='默认'+(model?.default_effort?'（'+(effortNames[model.default_effort]||model.default_effort)+'）':'');select.append(defaultOption);
    for(const level of model?.reasoning_levels||[]){const o=document.createElement('option');o.value=level;o.textContent=effortNames[level]||level;select.append(o);}
    select.value=(model?.reasoning_levels||[]).includes(previous)?previous:'';select.disabled=quickBusy||!model?.reasoning_levels?.length;
  }
  function renderQuick(data){
    const select=$('chat-model-select');if(!select||!data)return;select.replaceChildren();
    for(const provider of ['chatgpt','deepseek']){const group=document.createElement('optgroup');group.label=provider==='chatgpt'?'ChatGPT 订阅':'DeepSeek API';for(const model of quickModels.filter(m=>m.provider===provider)){const o=document.createElement('option');o.value=provider+':'+model.id;o.textContent=model.name;group.append(o);}if(group.children.length)select.append(group);}
    const selected=selectedQuick(data);if(selected)select.value=selected.provider+':'+selected.id;
    else {const o=document.createElement('option');o.value='';o.textContent=(data.assistant==='chatgpt'?data.model:data.deepseek_model||data.deepseek.model)||'请登录或配置 AI 服务';o.selected=true;o.disabled=true;select.prepend(o);}
    select.disabled=quickBusy||!quickModels.length;fillEfforts(selected,data[data.assistant+'_effort']);
  }
  async function loadQuick(refresh=false){if(!$('chat-model-select'))return;const button=$('chat-model-refresh');button.disabled=true;try{const data=await api('/api/ai/catalog'+(refresh?'?refresh=1':''));quickModels=data.models;renderQuick(state);$('chat-model-status').textContent=quickModels.length?'下一次提问生效':data.notices.join('；')||'请先配置 AI 服务';}catch(e){$('chat-model-status').textContent=e.message;}finally{button.disabled=false;}}
  async function saveQuick(changeModel){
    if(quickBusy)return;const value=$('chat-model-select').value,model=quickModels.find(m=>m.provider+':'+m.id===value);if(!model)return;
    if(changeModel)fillEfforts(model,state[model.provider+'_effort']);
    const payload={assistant:model.provider,[model.provider==='chatgpt'?'model':'deepseek_model']:model.id,[model.provider+'_effort']:$('chat-effort-select').value};
    quickBusy=true;ResearchUI.aiSaving=true;$('chat-model-select').disabled=$('chat-effort-select').disabled=true;$('chat-model-status').textContent='正在保存…';
    try{const data=await api('/api/ai/settings',payload);accounts(data);badge(data);$('chat-model-status').textContent='已保存 · 下一次提问生效';document.dispatchEvent(new Event('research-ai-changed'));}
    catch(e){$('chat-model-status').textContent=e.message;}
    finally{quickBusy=false;ResearchUI.aiSaving=false;renderQuick(state);}
  }
  if(quickHost){$('chat-model-select').onchange=()=>saveQuick(true);$('chat-effort-select').onchange=()=>saveQuick(false);$('chat-model-refresh').onclick=()=>loadQuick(true);}
  async function poll(){clearTimeout(timer);if(!$('ai-settings').open)return;try{const was=state?.chatgpt.pending,data=await load();if(data.chatgpt.pending)timer=setTimeout(poll,2000);else if(was){const active=data.chatgpt.accounts.find(a=>a.id===data.chatgpt.active);if(active?.sharing){await models();$('ai-provider').value='chatgpt';status('登录成功。选择模型后点击保存，即可切换助手。');}else status(data.chatgpt.notice);}}catch(e){status(e.message);}}
  async function open(){clearTimeout(timer);$('ai-settings').showModal();status('');try{const [data,project]=await Promise.all([load(),api('/api/projects/settings')]);$('ai-provider').value=data.assistant;$('ai-translation').value=data.translation;$('project-root').value=project.root;if(data.chatgpt.accounts.find(a=>a.id===data.chatgpt.active)?.sharing)await models();if(data.chatgpt.pending)poll();}catch(e){status(e.message);}}
  async function login(fresh=false){$('ai-login').disabled=true;status('正在打开 OpenAI 登录页…');try{const account=fresh?null:$('ai-account').value||null;await api('/api/ai/login',{account});await load();status('请在系统浏览器完成官方登录与授权，然后回到这里。');timer=setTimeout(poll,2000);}catch(e){status(e.message);}finally{$('ai-login').disabled=false;}}
  $('ai-login').onclick=()=>login();$('ai-add-account').onclick=()=>login(true);
  $('ai-account').onchange=async()=>{if(!$('ai-account').value)return;try{await api('/api/ai/account',{account:$('ai-account').value});await load();$('ai-model').replaceChildren();await models();await loadQuick(true);}catch(e){status(e.message);}};
  $('ai-logout').onclick=async()=>{try{await api('/api/ai/logout',{account:$('ai-account').value});await load();$('ai-model').replaceChildren();status('已退出。请重新登录或切换至 DeepSeek 后保存。');}catch(e){status(e.message);}};
  $('ai-refresh-models').onclick=()=>models(true).catch(e=>status(e.message));
  $('ai-save').onclick=async()=>{const button=$('ai-save');button.disabled=true;try{const data=await api('/api/ai/settings',{assistant:$('ai-provider').value,translation:$('ai-translation').value,model:$('ai-model').value,chatgpt_effort:(quickModels.find(m=>m.provider==='chatgpt'&&m.id===$('ai-model').value)?.reasoning_levels||[]).includes(state?.chatgpt_effort)?state.chatgpt_effort:''});accounts(data);badge(data);status('设置已保存，下次请求立即使用所选服务。');loadQuick();document.dispatchEvent(new Event('research-ai-changed'));}catch(e){status(e.message);}finally{button.disabled=false;}};
  $('project-save').onclick=async()=>{try{const data=await api('/api/projects/settings',{root:$('project-root').value});$('project-root').value=data.root;$('project-status').textContent='工程目录已应用';document.dispatchEvent(new Event('research-project-changed'));}catch(e){$('project-status').textContent=e.message;}};
  $('ai-deepseek').onclick=()=>{$('ai-settings').close();ResearchUI.openSettings();};
  $('ai-close').onclick=()=>$('ai-settings').close();$('ai-settings').addEventListener('close',()=>clearTimeout(timer));
  for(const b of document.querySelectorAll('[data-deepseek-settings]')){b.onclick=open;b.title='AI 与工程设置';}
  const ts=$('translation-settings');if(ts)ts.onclick=open;
  ResearchUI.openAISettings=open;load().then(()=>loadQuick()).catch(()=>{});
})();
