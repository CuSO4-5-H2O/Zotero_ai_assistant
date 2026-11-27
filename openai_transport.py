"""App-local OpenAI routing; leaves system proxy and other providers unchanged."""
import json
from pathlib import Path
from urllib import parse, request, error


class OpenAITransport:
    version = 1

    def __init__(self, config):
        self.config = Path(config)

    def proxy(self):
        if not self.config.exists():
            return ''
        data = json.loads(self.config.read_text(encoding='utf-8'))
        value = data.get('proxy_url', '')
        if not value:
            return ''
        url = parse.urlsplit(value)
        if url.scheme != 'http' or url.hostname not in {'127.0.0.1', 'localhost', '::1'} or not url.port or url.username or url.password or url.path not in {'', '/'} or url.query or url.fragment:
            raise ValueError('OpenAI 代理须为本机 HTTP 代理地址。')
        return value

    def open(self, req, timeout=25):
        url = req.full_url if isinstance(req, request.Request) else req
        proxy = self.proxy()
        if proxy and parse.urlsplit(url).hostname in {'api.openai.com', 'auth.openai.com'}:
            client = request.build_opener(request.ProxyHandler({'https': proxy, 'http': proxy}))
            try:return client.open(req, timeout=timeout)
            except error.URLError as exc:
                reason=getattr(exc,'reason',exc)
                if isinstance(reason,ConnectionRefusedError) or getattr(reason,'errno',None) in {61,111,10061}:
                    raise ValueError('本机 OpenAI 代理未连接（'+str(parse.urlsplit(proxy).hostname)+':'+str(parse.urlsplit(proxy).port)+'），请启动 Clash 后重试；当前输入已保留。') from None
                raise
        return request.urlopen(req, timeout=timeout)
