from __future__ import annotations

import argparse
import hashlib
import html
import json
import mimetypes
import os
import re
import secrets
import threading
import time
import uuid
from datetime import datetime
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit
import markdown_view
from markdown_view import render_markdown
from paper_library import PaperLibrary
from deepseek_client import DeepSeek
from zotero_source import ZoteroStorage
from dock_bridge import DockBridge
from paper_chat import PaperChat
from chatgpt_client import ChatGPT
from ai_service import AIService
from project_files import ProjectFiles
from research_tools import native_action
from workspace_context import WorkspaceContext
import urllib.request

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / 'resources'
DEFAULT_FOLDERS = ['调研报告', '文献笔记', '课题想法', '实验记录', '我的笔记']
PAPER_ID_RE = r'(?:[A-D]\d{1,2}|Z\d+_[A-Z0-9]{8})'


def now():
    return datetime.now().astimezone().isoformat(timespec='seconds')


def atomic(path: Path, content: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.' + uuid.uuid4().hex[:8] + '.tmp')
    with tmp.open('w', encoding='utf-8', newline='\n') as f:
        f.write(content)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def safe_name(text: str):
    text = re.sub(r'[\x00-\x1f<>:"/\\|?*]', '_', str(text)).strip(' .')[:100]
    if not text or text.upper() in {'CON', 'PRN', 'AUX', 'NUL', *(f'COM{i}' for i in range(1, 10)), *(f'LPT{i}' for i in range(1, 10))}:
        raise ValueError('请输入有效名称')
    return text


class Conflict(Exception):
    pass


class Vault:
    def __init__(self, root: Path, seed=True):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.index = self.root / 'index.json'
        self.lock = threading.RLock()
        if not self.index.exists():
            self.write_index({'version': 1, 'folders': DEFAULT_FOLDERS[:], 'notes': []})

    def read_index(self):
        return json.loads(self.index.read_text(encoding='utf-8'))

    def write_index(self, value):
        atomic(self.index, json.dumps(value, ensure_ascii=False, indent=2))

    def path(self, note):
        target = (self.root / note['file']).resolve()
        if not target.is_relative_to(self.root) or target.suffix != '.md':
            raise ValueError('无效的笔记路径')
        return target

    def _find(self, data, note_id):
        return next(x for x in data['notes'] if x['id'] == note_id)

    def _doc(self, note):
        content = self.path(note).read_text(encoding='utf-8')
        revision = hashlib.sha256((content + '\0' + str(note.get('revision', 0))).encode()).hexdigest()
        return {**note, 'content': content, 'version': revision}

    def list(self, query='', folder='', trash=False):
        with self.lock:
            data = self.read_index()
            result = []
            for note in data['notes']:
                if bool(note.get('trashed')) != trash or (folder and note['folder'] != folder):
                    continue
                doc = self._doc(note)
                searchable = ' '.join([doc['title'], doc['folder'], ' '.join(doc['tags']), doc['content']]).casefold()
                if query and not all(word in searchable for word in query.casefold().split()):
                    continue
                excerpt_lines = [line for line in doc['content'].splitlines() if line.strip() and not line.lstrip().startswith(('#', '|'))]
                plain = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', ' '.join(excerpt_lines))
                plain = re.sub(r'[#*|>\[\]`]', '', plain)
                result.append({**note, 'excerpt': re.sub(r'\s+', ' ', plain)[:100], 'characters': len(doc['content'])})
            result.sort(key=lambda x: x['updated'], reverse=True)
            if not query and folder == '调研报告':
                result.sort(key=lambda x: (not x.get('source', '').endswith('00_阅读入口.md'), x['title']))
            counts = {f: sum(n['folder'] == f and not n.get('trashed') for n in data['notes']) for f in data['folders']}
            return {'notes': result, 'folders': data['folders'], 'counts': counts,
                    'total': sum(not n.get('trashed') for n in data['notes']), 'trash': sum(bool(n.get('trashed')) for n in data['notes'])}

    def get(self, note_id):
        with self.lock:
            data = self.read_index()
            doc = self._doc(self._find(data, note_id))
            mapping = {Path(n.get('source') or n['file']).name: n['id'] for n in data['notes'] if not n.get('trashed')}
            doc['html'] = render_markdown(doc['content'], mapping)
            return doc

    def create(self, title, folder, tags, content, source=''):
        with self.lock:
            title, folder = safe_name(title), safe_name(folder)
            if not isinstance(tags, list) or len(tags) > 30 or not isinstance(content, str) or len(content) > 2_000_000:
                raise ValueError('笔记内容或标签不合法')
            data = self.read_index()
            nid = uuid.uuid4().hex
            note = {'id': nid, 'title': title, 'folder': folder, 'tags': [str(t).strip()[:50] for t in tags if str(t).strip()],
                    'file': f'{folder}/{title}_{nid[:6]}.md', 'source': source, 'created': now(), 'updated': now(), 'revision': 1, 'trashed': False}
            atomic(self.path(note), content)
            data['notes'].append(note)
            if folder not in data['folders']: data['folders'].append(folder)
            self.write_index(data)
            return self.get(nid)

    def backup(self, note):
        target = self.root / '.history' / note['id']
        stamp = datetime.now().strftime('%Y%m%d_%H%M%S_%f')
        atomic(target / (stamp + '.md'), self.path(note).read_text(encoding='utf-8'))
        atomic(target / (stamp + '.json'), json.dumps(note, ensure_ascii=False, indent=2))

    def save(self, note_id, payload):
        with self.lock:
            data = self.read_index()
            note = self._find(data, note_id)
            if note.get('trashed'): raise ValueError('请先从回收站恢复这篇笔记')
            current = self._doc(note)
            if payload.get('version') != current['version']:
                raise Conflict('文件已被其他窗口或外部软件修改。当前草稿已保留，请重新载入后比较。')
            title, folder = safe_name(payload['title']), safe_name(payload['folder'])
            tags, content = payload.get('tags', []), payload['content']
            if not isinstance(content, str) or len(content) > 2_000_000 or not isinstance(tags, list) or len(tags) > 30:
                raise ValueError('笔记过大或标签不合法')
            tags = [str(t).strip()[:50] for t in tags if str(t).strip()]
            if (title, folder, tags, content) == (note['title'], note['folder'], note['tags'], current['content']): return self.get(note_id)
            self.backup(note)
            old_path = self.path(note)
            note.update(title=title, folder=folder, tags=tags, file=f'{folder}/{title}_{note_id[:6]}.md', updated=now(), revision=note['revision'] + 1)
            new_path = self.path(note)
            atomic(new_path, content)
            if folder not in data['folders']: data['folders'].append(folder)
            self.write_index(data)
            if new_path != old_path and old_path.exists(): old_path.unlink()
            return self.get(note_id)

    def trash(self, note_id, restore=False):
        with self.lock:
            data = self.read_index()
            note = self._find(data, note_id)
            if bool(note.get('trashed')) == (not restore): return self.get(note_id)
            self.backup(note)
            old_path = self.path(note)
            note['file'] = f"{note['folder']}/{safe_name(note['title'])}_{note_id[:6]}.md" if restore else f'.trash/{note_id}.md'
            atomic(self.path(note), old_path.read_text(encoding='utf-8'))
            note.update(trashed=not restore, updated=now(), revision=note['revision'] + 1)
            self.write_index(data)
            if old_path != self.path(note): old_path.unlink()
            return self.get(note_id)

    def history(self, note_id):
        with self.lock:
            self._find(self.read_index(), note_id)
            paths = sorted((self.root / '.history' / note_id).glob('*.md'), reverse=True)
            return [{'key': p.stem, 'time': datetime.strptime(p.stem, '%Y%m%d_%H%M%S_%f').isoformat(timespec='seconds'), 'characters': len(p.read_text(encoding='utf-8'))} for p in paths]

    def historical(self, note_id, key):
        with self.lock:
            self._find(self.read_index(), note_id)
            if not re.fullmatch(r'\d{8}_\d{6}_\d{6}', key): raise ValueError('无效版本')
            base = self.root / '.history' / note_id
            return {**json.loads((base / (key + '.json')).read_text(encoding='utf-8')), 'content': (base / (key + '.md')).read_text(encoding='utf-8')}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # OAuth callback query strings contain one-time codes; never log URLs.
        return

    def send_bytes(self, data, content_type, status=200, extra=None):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; style-src-attr 'unsafe-inline'; font-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
        for key, value in (extra or {}).items(): self.send_header(key, value)
        self.end_headers(); self.wfile.write(data)

    def js(self, value, status=200):
        self.send_bytes(json.dumps(value, ensure_ascii=False).encode('utf-8'), 'application/json; charset=utf-8', status)

    def authenticated(self):
        try:
            if self.bearer_authenticated():return True
            cookies = SimpleCookie(self.headers.get('Cookie', ''))
            return secrets.compare_digest(cookies['research_notebook'].value, self.server.key)
        except (KeyError, ValueError): return False

    def bearer_authenticated(self):
        token=self.headers.get('Authorization','')
        return token.startswith('Bearer ') and secrets.compare_digest(token[7:],self.server.key)

    def do_GET(self):
        path = urlsplit(self.path)
        if path.path == '/health': return self.js({'app': 'research-notebook', 'version': 14})
        if path.path == '/auth/callback':
            import html
            try:message=self.server.chatgpt.callback({k:v[0] for k,v in parse_qs(path.query).items()});status=200
            except ValueError as e:message=str(e);status=400
            page='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ChatGPT · 科研笔记</title><body><h1>科研笔记仓库</h1><p>'+html.escape(message)+'</p><p>可以关闭此页，返回 Zotero 的 AI 设置。</p></body></html>'
            return self.send_bytes(page.encode(),'text/html; charset=utf-8',status)
        bootstrap = secrets.compare_digest(parse_qs(path.query).get('session', [''])[0], self.server.key)
        typed_navigation = not self.authenticated() and self.headers.get('Sec-Fetch-Site') == 'none' and self.headers.get('Sec-Fetch-Mode') == 'navigate'
        if path.path == '/' and (bootstrap or typed_navigation):
            query=parse_qs(path.query);paper=query.get('paper',[''])[0]
            destination='/paper/'+paper if re.fullmatch(PAPER_ID_RE,paper) else '/'
            if query.get('view')==['dock']:
                channel=query.get('channel',[''])[0]
                destination='/dock?host=zotero'
                if re.fullmatch(PAPER_ID_RE,paper):destination+='&paper='+paper
                if re.fullmatch('[a-f0-9]{32}',channel):destination+='&channel='+channel
            elif query.get('host')==['zotero']:destination+='?host=zotero'
            return self.send_bytes(b'', 'text/plain', 303, {'Location': destination, 'Set-Cookie': 'research_notebook=' + self.server.key + '; HttpOnly; SameSite=Strict; Path=/'})
        if not self.authenticated(): return self.js({'error': '请从桌面“科研笔记仓库”启动'}, 401)
        try:
            if path.path == '/api/deepseek/settings': return self.js(self.server.deepseek.public())
            if path.path == '/api/ai/settings':return self.js(self.server.ai.public())
            if path.path == '/api/ai/catalog':return self.js(self.server.ai.catalog(refresh=parse_qs(path.query).get('refresh')==['1']))
            if path.path == '/api/ai/models':return self.js({'models':self.server.chatgpt.models(refresh=parse_qs(path.query).get('refresh')==['1'])})
            if path.path == '/api/projects/settings':return self.js(self.server.projects.settings())
            if path.path == '/api/projects/files':return self.js(self.server.projects.bind().list(parse_qs(path.query).get('q',[''])[0]))
            if path.path == '/api/workspace/chat':return self.js(self.server.workspace_chat.get('workspace'))
            if path.path == '/api/dock/events':
                query=parse_qs(path.query)
                return self.js(self.server.dock.events(query.get('channel',[''])[0],query.get('since',['0'])[0]))
            if path.path == '/api/papers': return self.js(list(self.server.papers.refs.values()))
            history_match=re.fullmatch(rf'/api/papers/({PAPER_ID_RE})/history(?:/(\d{{8}}_\d{{6}}_\d{{6}}))?',path.path)
            if history_match:
                pid,key=history_match.groups();folder=self.server.papers.folder(pid)/'history'
                if key:return self.js({'content':(folder/(key+'.md')).read_text(encoding='utf-8')})
                return self.js([{'key':p.stem,'time':datetime.strptime(p.stem,'%Y%m%d_%H%M%S_%f').isoformat(timespec='seconds'),'characters':len(p.read_text(encoding='utf-8'))} for p in sorted(folder.glob('*.md'),reverse=True)[:100]])
            paper_match = re.fullmatch(rf'/api/papers/({PAPER_ID_RE})(?:/(pages|pdf|chat))?', path.path)
            if paper_match:
                pid, action = paper_match.groups()
                if action == 'chat':return self.js(self.server.chat.get(pid))
                if action == 'pages': return self.js(self.server.papers.pages(pid))
                if action == 'pdf':
                    pdf = self.server.papers.pdf(pid)
                    if not pdf: return self.js({'error':'尚未收录这篇文献的 PDF'},404)
                    return self.send_bytes(pdf.read_bytes(),'application/pdf',extra={'Content-Disposition':'inline; filename="'+pid+'.pdf"'})
                return self.js(self.server.papers.get(pid))
            if path.path == '/api/notes':
                q = parse_qs(path.query)
                return self.js(self.server.vault.list(q.get('q', [''])[0], q.get('folder', [''])[0], q.get('trash', ['0'])[0] == '1'))
            if path.path == '/api/info': return self.js({'vault': str(self.server.vault.root), 'version': 1})
            match = re.fullmatch(r'/api/notes/([a-f0-9]{32})(?:/(history)(?:/([\d_]+))?)?', path.path)
            if match:
                nid, history, key = match.groups()
                return self.js(self.server.vault.historical(nid, key) if key else self.server.vault.history(nid) if history else self.server.vault.get(nid))
            if path.path == '/api/export':
                import io, zipfile
                stream = io.BytesIO()
                with zipfile.ZipFile(stream, 'w', zipfile.ZIP_DEFLATED) as z:
                    with self.server.vault.lock:
                        for p in self.server.vault.root.rglob('*'):
                            if p.is_file() and p.suffix in {'.md', '.json', '.pdf'}: z.write(p, p.relative_to(self.server.vault.root))
                return self.send_bytes(stream.getvalue(), 'application/zip', extra={'Content-Disposition': 'attachment; filename="ResearchNotebook.zip"'})
            if path.path == '/' or re.fullmatch(rf'/paper/{PAPER_ID_RE}',path.path) or path.path in {'/dock','/dock.js','/chat.js','/dock.css','/app.js','/paper.js','/shared.js','/ai-settings.js','/style.css','/reader.css','/favicon.svg'} or path.path.startswith('/vendor/'):
                filename = 'index.html' if path.path == '/' else 'dock.html' if path.path == '/dock' else 'paper.html' if path.path.startswith('/paper/') else unquote(path.path).lstrip('/')
                file = (ROOT / 'web' / filename).resolve()
                if not file.is_relative_to((ROOT/'web').resolve()): raise ValueError('无效资源路径')
                mime = mimetypes.guess_type(str(file))[0] or 'application/octet-stream'
                return self.send_bytes(file.read_bytes(),mime+('; charset=utf-8' if file.suffix in {'.html','.js','.css'} else ''))
            self.js({'error': '页面不存在'}, 404)
        except (StopIteration, FileNotFoundError): self.js({'error': '笔记或版本不存在'}, 404)
        except ValueError as e: self.js({'error': str(e)}, 400)

    def do_POST(self):
        origin = f'http://127.0.0.1:{self.server.server_port}'
        if not self.authenticated() or self.headers.get('X-Notebook-Request') != '1' or (self.headers.get('Origin') != origin and not (self.bearer_authenticated() and self.headers.get('Origin') in {None,'null'})):
            return self.js({'error': '请求未获本地窗口授权'}, 403)
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length <= 0 or length > 44_000_000: raise ValueError('请求内容过大或为空')
            payload = json.loads(self.rfile.read(length))
            if self.path == '/api/dock/channel':return self.js(self.server.dock.create())
            if self.path == '/api/dock/publish':
                if not isinstance(payload.get('event'),dict):raise ValueError('浮窗消息格式不正确')
                if payload['event'].get('type')!='home':self.server.papers.item(payload['event'].get('paper_id'))
                return self.js(self.server.dock.publish(payload.get('channel'),payload.get('event')))
            if self.path == '/api/zotero/action':
                if payload.get('action') in {'get_tags','add_paper_tags','remove_paper_tags'}:return self.js(native_action(ROOT,self.server.papers,payload))
                pid=str(payload.get('paper_id',''));paper=self.server.papers.item(pid)
                if not paper.get('zotero'):raise ValueError('该文献尚未关联 Zotero PDF')
                action=payload.get('action')
                if action not in {'open_pdf','save_note','list_notes'}:raise ValueError('未知的 Zotero 操作')
                message={'action':action,'attachment_key':paper['zotero']['attachment_key'],'library_id':paper['zotero']['library_id'],'page':payload.get('page')}
                if action=='save_note':
                    content=payload.get('content','')
                    if not isinstance(content,str) or not content.strip() or len(content)>2_000_000:raise ValueError('请先填写笔记内容')
                    message['html']=render_markdown(content)
                try:bridge=json.loads((ROOT/'.runtime'/'zotero-bridge.json').read_text(encoding='utf-8'))
                except (OSError,ValueError):raise ValueError('请先在 Zotero 中启用科研笔记仓库插件') from None
                message['bridge_token']=bridge['token']
                request=urllib.request.Request('http://127.0.0.1:23119/research-notebook/action',data=json.dumps(message).encode(),headers={'Content-Type':'application/json'},method='POST')
                try:
                    with urllib.request.urlopen(request,timeout=20) as response:return self.js(json.load(response))
                except urllib.error.HTTPError as error:
                    try:message=json.load(error).get('error','Zotero 操作失败')
                    except (ValueError,AttributeError):message='Zotero 操作失败'
                    raise ValueError(message) from None
                except OSError:raise ValueError('Zotero 插件未就绪，请安装并启用新版插件') from None
            if self.path == '/api/zotero/register':return self.js(self.server.zotero.register(payload))
            if self.path == '/api/zotero/sync':return self.js(self.server.zotero.sync_reports())
            if self.path == '/api/zotero/open':
                pid=str(payload.get('paper_id',''))
                self.server.papers.item(pid)
                try:bridge=json.loads((ROOT/'.runtime'/'zotero-bridge.json').read_text(encoding='utf-8'))
                except (OSError,ValueError):raise ValueError('请先在 Zotero 中安装并启用科研笔记仓库插件') from None
                request=urllib.request.Request('http://127.0.0.1:23119/research-notebook/open',data=json.dumps({'bridge_token':bridge['token'],'paper_id':pid}).encode(),headers={'Content-Type':'application/json'},method='POST')
                try:
                    with urllib.request.urlopen(request,timeout=10) as result:return self.js(json.load(result))
                except OSError:raise ValueError('Zotero 插件未就绪，请在 Zotero 中启用科研笔记仓库插件') from None
            if self.path == '/api/deepseek/settings': return self.js(self.server.deepseek.save(payload))
            if self.path == '/api/ai/settings':return self.js(self.server.ai.save(payload))
            if self.path == '/api/ai/login':
                import webbrowser
                url=self.server.chatgpt.begin(origin+'/auth/callback',payload.get('account'))
                if not webbrowser.open(url,new=2):raise ValueError('无法打开系统浏览器，请检查默认浏览器设置')
                return self.js({'ok':True,'message':'已打开 OpenAI 官方登录页，请完成登录和授权'})
            if self.path == '/api/ai/account':return self.js(self.server.chatgpt.select(payload.get('account')))
            if self.path == '/api/ai/logout':return self.js(self.server.chatgpt.logout(payload.get('account')))
            if self.path == '/api/projects/settings':return self.js(self.server.projects.set_root(payload.get('root')))
            if self.path == '/api/projects/read':return self.js(self.server.projects.bind().read(payload.get('path')))
            if self.path == '/api/workspace/note-actions/restore':return self.js(self.server.workspace_chat.restore_action('workspace',payload.get('action_id')))
            if self.path == '/api/deepseek/test': return self.js(self.server.deepseek.complete('只回复 OK。','连接测试',16))
            if self.path in {'/api/translate/stream','/api/selection/stream'}:
                stream=self.server.ai.selection_stream(payload.get('text'),payload.get('target','简体中文'),payload.get('mode','translate'))
                first=next(stream)
                self.send_response(200);self.send_header('Content-Type','application/x-ndjson; charset=utf-8');self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff');self.send_header('X-Accel-Buffering','no');self.send_header('Connection','close');self.end_headers();self.close_connection=True
                def emit(event):self.wfile.write((json.dumps(event,ensure_ascii=False)+'\n').encode());self.wfile.flush()
                try:
                    emit(first)
                    for event in stream:emit(event)
                except (BrokenPipeError,ConnectionResetError):pass
                except (ValueError,OSError) as error:
                    try:emit({'type':'error','error':str(error)})
                    except (BrokenPipeError,ConnectionResetError):pass
                finally:stream.close()
                return
            if self.path == '/api/translate':
                result = self.server.deepseek.translate(payload.get('text'),payload.get('target','简体中文'))
                return self.js({**result,'html':render_markdown(result['text'])})
            restore_action=re.fullmatch(rf'/api/papers/({PAPER_ID_RE})/note-actions/restore',self.path)
            if restore_action:return self.js(self.server.chat.restore_action(restore_action[1],payload.get('action_id')))
            chat_edit=re.fullmatch(rf'/api/papers/({PAPER_ID_RE})/chat/edit',self.path)
            if chat_edit or self.path=='/api/workspace/chat/edit':
                return self.js((self.server.chat if chat_edit else self.server.workspace_chat).edit(chat_edit[1] if chat_edit else 'workspace',payload))
            chat_match=re.fullmatch(rf'/api/papers/({PAPER_ID_RE})/chat',self.path)
            if chat_match or self.path=='/api/workspace/chat':
                stream=(self.server.chat.stream(chat_match[1],payload,self.server.ai.bind()) if chat_match else self.server.workspace_chat.stream('workspace',payload,self.server.ai.bind()))
                first=next(stream)
                self.send_response(200);self.send_header('Content-Type','application/x-ndjson; charset=utf-8');self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff');self.send_header('Connection','close');self.end_headers();self.close_connection=True
                try:
                    for event in (first,):self.wfile.write((json.dumps(event,ensure_ascii=False)+'\n').encode());self.wfile.flush()
                    for event in stream:self.wfile.write((json.dumps(event,ensure_ascii=False)+'\n').encode());self.wfile.flush()
                except (BrokenPipeError,ConnectionResetError):pass
                except (ValueError,OSError) as error:
                    try:self.wfile.write((json.dumps({'type':'error','error':str(error)},ensure_ascii=False)+'\n').encode());self.wfile.flush()
                    except OSError:pass
                finally:stream.close()
                return
            paper_match = re.fullmatch(rf'/api/papers/({PAPER_ID_RE})/(upload|reading|analyze)',self.path)
            if paper_match:
                pid, action = paper_match.groups()
                if action == 'upload': return self.js(self.server.papers.upload(pid,payload))
                if action == 'reading': return self.js(self.server.papers.save_reading(pid,payload))
                result = self.server.papers.analyze(pid,self.server.ai.bind())
                return self.js({**result,'html':render_markdown(result['text'])})
            if self.path == '/api/folders':
                name = safe_name(payload['name'])
                with self.server.vault.lock:
                    data = self.server.vault.read_index()
                    if name not in data['folders']: data['folders'].append(name)
                    self.server.vault.write_index(data)
                return self.js({'name': name})
            if self.path == '/api/preview':
                content = payload.get('content', '')
                if not isinstance(content, str) or len(content) > 2_000_000: raise ValueError('内容过大')
                with self.server.vault.lock:
                    mapping = {Path(n.get('source') or n['file']).name: n['id'] for n in self.server.vault.read_index()['notes'] if not n.get('trashed')}
                return self.js({'html': render_markdown(content, mapping)})
            if self.path == '/api/notes': return self.js(self.server.vault.create(payload['title'], payload.get('folder', '我的笔记'), payload.get('tags', []), payload.get('content', '')), 201)
            match = re.fullmatch(r'/api/notes/([a-f0-9]{32})(?:/(trash|restore))?', self.path)
            if not match: return self.js({'error': '操作不存在'}, 404)
            nid, action = match.groups()
            return self.js(self.server.vault.trash(nid, action == 'restore') if action else self.server.vault.save(nid, payload))
        except Conflict as e: self.js({'error': str(e)}, 409)
        except (StopIteration, FileNotFoundError): self.js({'error': '笔记不存在'}, 404)
        except (ValueError, KeyError, TypeError) as e: self.js({'error': str(e)}, 400)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--vault', type=Path, default=ROOT / 'vault')
    parser.add_argument('--state', type=Path, default=ROOT / '.runtime' / 'state.json')
    parser.add_argument('--resume', action='store_true')
    parser.add_argument('--config', type=Path, default=ROOT/'.runtime')
    parser.add_argument('--zotero-storage', type=Path, default=Path(os.environ.get('ZOTERO_STORAGE', str(Path.home()/'Zotero'/'storage'))))
    args = parser.parse_args()
    preferences=ROOT/'.runtime'/'app-settings.json'
    if preferences.exists() and '--zotero-storage' not in __import__('sys').argv:
        args.zotero_storage=Path(json.loads(preferences.read_text(encoding='utf-8')).get('zotero_storage',str(args.zotero_storage)))
    previous = json.loads(args.state.read_text(encoding='utf-8')) if args.resume and args.state.exists() else {}
    server = ThreadingHTTPServer(('127.0.0.1', previous.get('port',0)), Handler)
    server.daemon_threads = True
    server.vault = Vault(args.vault)
    server.key = previous.get('key') or secrets.token_urlsafe(32)
    server.papers = PaperLibrary(args.vault/'.papers', SOURCE, atomic, Conflict, render_markdown)
    markdown_view.CATALOG = server.papers.refs
    server.deepseek = DeepSeek(ROOT/'.runtime'/'deepseek.json',atomic)
    args.config.mkdir(parents=True,exist_ok=True)
    server.chatgpt = ChatGPT(args.config/'chatgpt-credentials.dat',atomic)
    server.ai = AIService(args.config/'ai-settings.json',atomic,server.deepseek,server.chatgpt)
    server.projects = ProjectFiles(args.config/'project-settings.json',atomic)
    server.chat = PaperChat(server.papers,atomic,render_markdown,server.vault,server.projects,lambda payload:native_action(ROOT,server.papers,payload))
    server.workspace_chat = PaperChat(WorkspaceContext(server.papers),atomic,render_markdown,server.vault,server.projects,lambda payload:native_action(ROOT,server.papers,payload))
    server.zotero = ZoteroStorage(server.papers,args.zotero_storage)
    server.dock = DockBridge()
    atomic(args.state, json.dumps({'app': 'research-notebook', 'pid': os.getpid(), 'port': server.server_port, 'key': server.key, 'started': now()}))
    server.serve_forever()


if __name__ == '__main__': main()


