"""Bounded public web search/read tools. Never send local credentials."""
import html,ipaddress,json,re,socket,time,xml.etree.ElementTree as ET
from html.parser import HTMLParser
from urllib import request,parse
_PUBLIC_DNS={}

def verified_fake_dns(host):
    # TUN/Fake-IP returns benchmark addresses for public domains. Confirm the
    # public DNS answer over HTTPS; never allow literal or actual private IPs.
    cached=_PUBLIC_DNS.get(host)
    if cached and cached>time.monotonic():return True
    if '.' not in host or host.lower().endswith(('.local','.localhost','.internal','.lan','.invalid')):return False
    try:ipaddress.ip_address(host);return False
    except ValueError:pass
    try:
        req=request.Request('https://cloudflare-dns.com/dns-query?name='+parse.quote(host,safe='')+'&type=A',headers={'Accept':'application/dns-json'})
        with request.urlopen(req,timeout=8) as response:data=json.loads(response.read(64000))
        addresses=[a['data'] for a in data.get('Answer',[]) if a.get('type') in {1,28}]
        if data.get('Status')==0 and addresses and all(ipaddress.ip_address(a).is_global for a in addresses):
            _PUBLIC_DNS[host]=time.monotonic()+300;return True
    except (OSError,ValueError,KeyError):pass
    return False

def public_url(url):
    if not isinstance(url,str) or len(url)>3000:raise ValueError('网页地址无效')
    p=parse.urlsplit(url)
    if p.scheme not in {'https','http'} or not p.hostname or p.username or p.password or p.port not in {None,80,443}:raise ValueError('仅支持公开 HTTP/HTTPS 网页')
    if p.hostname.lower() in {'localhost','metadata.google.internal'}:raise ValueError('不访问本机或内网地址')
    try:addresses=socket.getaddrinfo(p.hostname,p.port or (443 if p.scheme=='https' else 80),type=socket.SOCK_STREAM)
    except OSError:raise ValueError('网页域名暂不可用') from None
    ips=[ipaddress.ip_address(a[4][0]) for a in addresses]
    if not ips or (any(not a.is_global for a in ips) and not (all(a in ipaddress.ip_network('198.18.0.0/15') for a in ips) and verified_fake_dns(p.hostname))):raise ValueError('不访问本机、内网或保留地址；如使用 Fake-IP，请检查公开 DNS 核验是否可达')
    return url

class Redirects(request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        public_url(newurl)
        return super().redirect_request(req,fp,code,msg,headers,newurl)

def fetch(url,limit=2_000_000):
    public_url(url)
    req=request.Request(url,headers={'User-Agent':'Mozilla/5.0 ResearchNotebook/1.8','Accept':'text/html,application/xml,text/plain'})
    try:
        with request.build_opener(Redirects()).open(req,timeout=18) as response:
            data=response.read(limit+1)
            if len(data)>limit:raise ValueError('网页超过读取大小限制')
            content_type=response.headers.get_content_type()
            if content_type not in {'text/html','application/xhtml+xml','text/plain','application/rss+xml','application/xml','text/xml'}:raise ValueError('当前工具仅读取网页文字，未读取此文件正文')
            return data.decode(response.headers.get_content_charset() or 'utf-8',errors='replace'),response.url
    except (OSError,ET.ParseError):raise ValueError('网站暂时无法读取，可尝试搜索结果中的其他来源') from None

class Text(HTMLParser):
    def __init__(self):super().__init__();self.hidden=0;self.parts=[]
    def handle_starttag(self,tag,attrs):
        if tag in {'script','style','noscript','nav','footer'}:self.hidden+=1
        if not self.hidden and tag in {'p','div','h1','h2','h3','li','br'}:self.parts.append('\n')
    def handle_endtag(self,tag):
        if tag in {'script','style','noscript','nav','footer'}:self.hidden=max(0,self.hidden-1)
    def handle_data(self,data):
        if not self.hidden:self.parts.append(data)

def web_search(query):
    if not isinstance(query,str) or not 1<=len(query.strip())<=300:raise ValueError('搜索词应为 1—300 字符')
    url='https://www.bing.com/search?format=rss&q='+parse.quote(query.strip())
    text,_=fetch(url);rows=[]
    try:
        for item in ET.fromstring(text).findall('.//item')[:8]:
            link=item.findtext('link','');title=item.findtext('title','')
            if link.startswith(('http://','https://')):rows.append({'title':title,'url':link,'snippet':html.unescape(item.findtext('description',''))[:1000]})
    except ET.ParseError:raise ValueError('搜索服务返回格式已变化，本次未取得结果') from None
    if not rows:raise ValueError('本次搜索没有返回结果，可换用更具体的关键词')
    return {'ok':True,'query':query,'source':'Bing RSS','results':rows,'scope':'搜索摘要；需 read_web_page 核实正文'}

def read_web_page(url):
    raw,final=fetch(url);parser=Text();parser.feed(raw)
    text=re.sub(r'[ \t]+',' ',''.join(parser.parts));text=re.sub(r'\n\s*\n+','\n\n',text).strip()
    return {'ok':True,'url':final,'text':text[:22000],'truncated':len(text)>22000,'scope':'网页可提取文字，不含图片或受登录保护的正文'}
