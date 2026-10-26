"""Official Sign in with ChatGPT; app-owned DPAPI credentials and Responses SSE."""
import base64, contextlib, hashlib, json, msvcrt, secrets, threading, time, uuid
from pathlib import Path
from urllib import request, parse, error
from deepseek_client import protect

ISSUER='https://auth.openai.com'
TOKEN=ISSUER+'/api/accounts/oauth/token'
RESOURCE='https://api.openai.com/v1'
SCOPE='openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'

def json_request(url,body=None,token=None,form=False):
    headers={'Accept':'application/json'}
    if token:headers['Authorization']='Bearer '+token
    if body is not None:
        headers['Content-Type']='application/x-www-form-urlencoded' if form else 'application/json'
        body=(parse.urlencode(body) if form else json.dumps(body)).encode()
    try:
        with request.urlopen(request.Request(url,data=body,headers=headers),timeout=25) as response:
            return json.loads(response.read(4_000_000) or b'{}')
    except error.HTTPError as e:
        try:
            data=json.loads(e.read(16000));code=data.get('error',{})
            if isinstance(code,dict):code=code.get('code') or code.get('type')
        except (ValueError,AttributeError):code=None
        raise ProviderError(code or 'http_'+str(e.code)) from None
    except (TimeoutError,error.URLError):raise ValueError('连接 OpenAI 超时，请检查网络后重试') from None

class ProviderError(ValueError):
    def __init__(self,code):
        self.code=str(code)
        message={'subscription_sharing_usage_limit_exceeded':'ChatGPT 订阅额度暂时用尽，请稍后重试或手动切换服务。',
          'subscription_sharing_usage_unavailable':'ChatGPT 订阅额度暂不可用，请在 ChatGPT 设置中检查授权。',
          'invalid_grant':'登录已失效，请重新使用 ChatGPT 登录。',
          'subscription_sharing_unsupported_capability':'当前账号或模型不支持本次请求的能力。',
          'http_401':'ChatGPT 登录已失效，请重新登录。',
          'http_403':'当前 ChatGPT 账号尚未允许此应用使用订阅，请检查官方授权。',
          'http_429':'ChatGPT 请求过于频繁或额度受限，请稍后重试。'}.get(self.code,'OpenAI 请求未完成（'+self.code[:90]+'），请重试或检查账号授权。')
        super().__init__(message)

class ChatGPT:
    def __init__(self,path,atomic):
        self.path=Path(path);self.atomic=atomic;self.lock=threading.RLock();self.pending=None;self.notice='';self.catalog={}
        self.jwks=None;self.gate=threading.BoundedSemaphore(2)
    @contextlib.contextmanager
    def transaction(self):
        # Serialize rotating refresh tokens across notebook processes.
        with self.lock:
            self.path.parent.mkdir(parents=True,exist_ok=True)
            with self.path.with_suffix('.lock').open('a+b') as f:
                f.seek(0);f.write(b'0');f.flush();f.seek(0)
                try:msvcrt.locking(f.fileno(),msvcrt.LK_LOCK,1)
                except OSError:raise ValueError('ChatGPT 会话正在更新，请稍后重试') from None
                try:yield
                finally:f.seek(0);msvcrt.locking(f.fileno(),msvcrt.LK_UNLCK,1)
    def read(self):
        if not self.path.exists():return {'host':'urn:uuid:'+str(uuid.uuid4()),'accounts':{},'active':None}
        return json.loads(protect(base64.b64decode(self.path.read_text('utf-8')),True))
    def write(self,data):self.atomic(self.path,base64.b64encode(protect(json.dumps(data).encode())).decode())
    def public(self):
        with self.transaction():
            data=self.read();active=data.get('active');accounts=[]
            for cid,a in data['accounts'].items():
                accounts.append({'id':cid,'label':a.get('email') or a.get('name') or 'ChatGPT 账号','suffix':cid[-6:],
                  'connected':bool(a.get('access_token')),'sharing':'chatgpt.tokens.use.direct' in a.get('scopes',[]) and bool(a.get('access_token'))})
            if self.pending and self.pending['expires']<time.time():self.pending=None;self.notice='登录已超时，请重试'
            return {'accounts':accounts,'active':active,'pending':bool(self.pending),'notice':self.notice}
    def begin(self,redirect_uri,account=None):
        if not __import__('re').fullmatch(r'http://127\.0\.0\.1:\d+/auth/callback',redirect_uri):raise ValueError('登录回调地址无效')
        with self.transaction():
            data=self.read();self.write(data)
            a=data['accounts'].get(account) if account else None
            if account and not a:raise ValueError('未找到已保存的账号')
            verifier=secrets.token_urlsafe(48);state=secrets.token_urlsafe(32);nonce=secrets.token_urlsafe(32)
            self.pending={'state':state,'nonce':nonce,'verifier':verifier,'redirect':redirect_uri,'account':account,'subject':a.get('subject') if a else None,'expires':time.time()+600}
            values={'client_id':account or 'dynamic_agent_client','ext_agent_host_id':data['host'],'response_type':'code',
              'redirect_uri':redirect_uri,'scope':SCOPE,'resource':RESOURCE,'state':state,'nonce':nonce,'code_challenge_method':'S256',
              'code_challenge':base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')}
            if not account:values['agent_name_hint']='Research Notebook'
            if a and a.get('id_token'):values['id_token_hint']=a['id_token']
            if a and a.get('email'):values['login_hint']=a['email']
            if a and 'chatgpt.tokens.use.direct' not in a.get('scopes',[]):values['prompt']='consent'
            self.notice='请在 OpenAI 官方页面完成登录和订阅使用授权'
            return ISSUER+'/api/accounts/authorize?'+parse.urlencode(values)
    def validate_identity(self,token,cid,nonce):
        import jwt
        if not self.jwks:self.jwks=jwt.PyJWKClient(ISSUER+'/.well-known/jwks.json',timeout=20)
        try:
            key=self.jwks.get_signing_key_from_jwt(token)
            claims=jwt.decode(token,key.key,algorithms=['RS256'],issuer=ISSUER,audience=cid,options={'require':['exp','iss','aud','sub','nonce']},leeway=20)
            if not secrets.compare_digest(str(claims['nonce']),nonce):raise ValueError()
            return claims
        except Exception:raise ValueError('OpenAI 登录身份校验失败，请重新登录') from None
    def callback(self,params):
        with self.transaction():
            pending=self.pending
            if not pending or pending['expires']<time.time() or not secrets.compare_digest(params.get('state',''),pending['state']):raise ValueError('登录回调无效或已超时，请重新登录')
            self.pending=None
            try:
                if params.get('error'):raise ValueError('登录未完成或授权被取消，可重新登录')
                cid=params.get('client_id') or pending['account']
                if not cid or cid=='dynamic_agent_client' or (pending['account'] and cid!=pending['account']):raise ValueError('登录注册信息不匹配，请重新登录')
                if not params.get('code'):raise ValueError('未收到登录授权码')
                tokens=json_request(TOKEN,{'grant_type':'authorization_code','client_id':cid,'code':params['code'],'code_verifier':pending['verifier'],'redirect_uri':pending['redirect'],'resource':RESOURCE},form=True)
                claims=self.validate_identity(tokens.get('id_token',''),cid,pending['nonce'])
                if pending['subject'] and claims['sub']!=pending['subject']:raise ValueError('返回的账号与所选账号不同，原账号保持不变')
                if tokens.get('token_type','').lower()!='bearer' or not tokens.get('access_token'):raise ValueError('没有收到可用的 OpenAI 凭据')
                data=self.read();data['accounts'][cid]={'subject':claims['sub'],'email':claims.get('email',''),'name':claims.get('name',''),
                  'access_token':tokens['access_token'],'refresh_token':tokens.get('refresh_token'),'id_token':tokens['id_token'],
                  'scopes':tokens.get('scope','').split(),'expires':time.time()+int(tokens.get('expires_in',3600))}
                data['active']=cid;self.write(data);self.catalog.pop(cid,None)
                self.notice='ChatGPT 已登录，请返回 AI 设置选择模型。' if 'chatgpt.tokens.use.direct' in tokens.get('scope','').split() else '身份已登录，但尚未授权订阅使用。请重新登录并允许订阅访问。'
                return self.notice
            except ValueError as e:self.notice=str(e);raise
    def select(self,cid):
        with self.transaction():
            data=self.read()
            if cid not in data['accounts']:raise ValueError('账号不存在')
            data['active']=cid;self.write(data)
        return self.public()
    def access(self,cid=None):
        with self.transaction():
            data=self.read();cid=cid or data.get('active');a=data['accounts'].get(cid,{})
            if not a.get('access_token'):raise ValueError('请在 AI 设置中使用 ChatGPT 登录')
            if 'chatgpt.tokens.use.direct' not in a.get('scopes',[]):raise ValueError('尚未授权此应用使用 ChatGPT 订阅，请重新登录并允许订阅访问')
            if a.get('expires',0)<time.time()+60:
                if not a.get('refresh_token'):raise ValueError('请重新登录 ChatGPT')
                try:tokens=json_request(TOKEN,{'grant_type':'refresh_token','client_id':cid,'refresh_token':a['refresh_token'],'resource':RESOURCE},form=True)
                except ProviderError as e:
                    if e.code in {'invalid_grant','invalid_refresh_token','token_expired','refresh_token_expired','refresh_token_invalidated','refresh_token_reused'}:
                        for key in ['access_token','refresh_token','id_token']:a.pop(key,None)
                        self.write(data)
                    raise
                if not tokens.get('access_token'):raise ValueError('OpenAI 未返回刷新凭据，请重试')
                for key in ['access_token','refresh_token','id_token']:
                    if tokens.get(key):a[key]=tokens[key]
                if 'scope' in tokens:a['scopes']=tokens['scope'].split()
                a['expires']=time.time()+int(tokens.get('expires_in',3600));self.write(data)
                if 'chatgpt.tokens.use.direct' not in a['scopes']:raise ValueError('ChatGPT 订阅使用授权已撤回')
            return cid,a['access_token']
    def models(self,refresh=False,cid=None):
        cid,token=self.access(cid)
        cached=self.catalog.get(cid)
        if cached and not refresh and cached[0]>time.time()-300:return cached[1]
        body=json_request(RESOURCE+'/models',token=token)
        models=[{'id':m['slug'],'name':m.get('display_name') or m['slug'],'reasoning_levels':[r['effort'] for r in m.get('supported_reasoning_levels',[]) if isinstance(r,dict) and isinstance(r.get('effort'),str)],'default_effort':m.get('default_reasoning_level','')} for m in body.get('models',[]) if m.get('visibility')=='list' and isinstance(m.get('slug'),str)]
        self.catalog[cid]=(time.time(),models);return models
    def logout(self,cid):
        confirmed=True
        with self.transaction():
            data=self.read();a=data['accounts'].get(cid)
            if not a:raise ValueError('账号不存在')
            if a.get('refresh_token'):
                try:
                    raw=parse.urlencode({'token':a['refresh_token'],'token_type_hint':'refresh_token','client_id':cid}).encode()
                    with request.urlopen(request.Request(ISSUER+'/api/accounts/oauth/revoke',data=raw,headers={'Content-Type':'application/x-www-form-urlencoded'}),timeout=15) as response:confirmed=response.status==200
                except (OSError,ValueError):confirmed=False
            for key in ['access_token','refresh_token','id_token']:a.pop(key,None)
            self.write(data);self.catalog.pop(cid,None)
            self.notice='已退出 ChatGPT' if confirmed else '已在本机退出；远端撤销未确认，可在 ChatGPT 设置中断开此应用'
        return self.public()
    @staticmethod
    def body(messages,model,tools=None,effort=None):
        inputs=[];instructions=[]
        for m in messages:
            if m['role']=='system':instructions.append(m['content']);continue
            if m['role']=='tool':inputs.append({'type':'function_call_output','call_id':m['tool_call_id'],'output':m['content']});continue
            if m.get('_response_output'):
                inputs.extend(m['_response_output']);continue
            if m.get('content'):inputs.append({'role':m['role'],'content':m['content']})
            for call in m.get('tool_calls') or []:
                inputs.append({'type':'function_call','call_id':call['id'],'name':call['function']['name'],'namespace':'notebook','arguments':call['function']['arguments']})
        body={'model':model,'instructions':'\n\n'.join(instructions),'input':inputs,'store':False,'stream':True}
        if effort:body['reasoning']={'effort':effort}
        if tools:body['tools']=[{'type':'namespace','name':'notebook','description':'User-authorized local research workspace operations','tools':[{'type':'function',**t['function'],'strict':False} for t in tools]}]
        return body
    def chat_stream(self,messages,tools=None,model=None,account=None,effort=None):
        cid,token=self.access(account)
        if not model or model not in {m['id'] for m in self.models(cid=cid)}:raise ValueError('请在 AI 设置中选择此账号可用的模型')
        selected=next((m for m in self.models(cid=cid) if m['id']==model),{})
        if effort and effort not in selected.get('reasoning_levels',[]):raise ValueError('当前模型不支持所选推理等级，请重新选择')
        if not self.gate.acquire(False):raise ValueError('已有两个 ChatGPT 请求正在处理，请稍后重试')
        try:
            body=self.body(messages,model,tools,effort);text='';completed=None;output_items={}
            req=request.Request(RESOURCE+'/responses',data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','Accept':'text/event-stream'})
            try:
                with request.urlopen(req,timeout=45) as response:
                    for raw in response:
                        line=raw.decode('utf-8').strip()
                        if not line.startswith('data:') or line[5:].strip()=='[DONE]':continue
                        event=json.loads(line[5:]);kind=event.get('type')
                        if kind=='response.output_text.delta':
                            delta=event.get('delta','');text+=delta
                            if len(text)>100000:raise ValueError('回答过长，请缩小问题范围')
                            yield {'type':'delta','text':delta}
                        elif kind=='response.output_item.done':
                            index=event.get('output_index');item=event.get('item')
                            if type(index) is int and isinstance(item,dict):output_items[index]=item
                        elif kind in {'response.failed','response.incomplete','error'}:
                            raise ProviderError((event.get('response',{}).get('error') or event.get('error') or event).get('code') or kind)
                        elif kind=='response.completed':completed=event['response'];break
            except error.HTTPError as e:
                try:code=json.loads(e.read(16000)).get('error',{}).get('code')
                except (ValueError,AttributeError):code=None
                raise ProviderError(code or 'http_'+str(e.code)) from None
            except (TimeoutError,error.URLError):raise ValueError('连接 OpenAI 超时，请检查网络后重试') from None
            if not completed:raise ValueError('ChatGPT 回答连接中断，部分回答未保存，工具未执行')
            # Some streaming responses deliver the complete items only through
            # output_item.done and leave response.completed.output empty.
            # Retain those items, including reasoning needed for tool replay.
            calls=[];outputs=[output_items[index] for index in sorted(output_items)]
            for item in completed.get('output') or []:
                key=item.get('id') or item.get('call_id')
                previous=next((i for i,value in enumerate(outputs) if key and (value.get('id') or value.get('call_id'))==key),None)
                if previous is None:outputs.append(item)
                else:outputs[previous]=item
            for item in outputs:
                if item.get('type')=='function_call':
                    if not tools or item.get('namespace') not in {None,'notebook'} or len(calls)>=8:raise ValueError('工具调用无效，未执行操作')
                    if len(item.get('arguments',''))>200000:raise ValueError('工具参数过大，未执行')
                    calls.append({'id':item['call_id'],'type':'function','function':{'name':item['name'],'arguments':item['arguments']}})
            if not text:text=''.join(c.get('text','') for o in outputs if o.get('type')=='message' for c in o.get('content',[]) if c.get('type')=='output_text')
            if not text and not calls:raise ValueError('ChatGPT 未返回正文，请重试')
            yield {'type':'done','text':text,'model':model,'tool_calls':calls,'response_output':outputs,'usage':completed.get('usage',{})}
        finally:self.gate.release()
