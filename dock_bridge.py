"""Short-lived, authenticated messages between native readers and their notebook dock."""
import re
import secrets
import threading
import time


class DockBridge:
    def __init__(self):
        self.condition = threading.Condition()
        self.channels = {}

    def create(self):
        with self.condition:
            if len(self.channels) >= 32:
                oldest = min(self.channels, key=lambda key: self.channels[key]['touched'])
                del self.channels[oldest]
            channel = secrets.token_hex(16)
            self.channels[channel] = {'sequence': 0, 'events': [], 'touched': time.monotonic()}
            return {'channel': channel}

    def state(self, channel):
        if not re.fullmatch(r'[a-f0-9]{32}', str(channel)) or channel not in self.channels:
            raise ValueError('浮窗连接已失效，请重新打开科研精读')
        return self.channels[channel]

    def publish(self, channel, event):
        if not isinstance(event, dict) or event.get('type') not in {'paper', 'clip','context','home'}:
            raise ValueError('未知的浮窗消息')
        if event['type']!='home' and not re.fullmatch(r'(?:[A-D]\d{1,2}|Z\d+_[A-Z0-9]{8})', str(event.get('paper_id', ''))):
            raise ValueError('文献编号不合法')
        if event['type'] in {'clip','context'}:
            if not isinstance(event.get('text'), str) or not (1 if event['type']=='clip' else 0) <= len(event['text'].strip()) <= 12000:
                raise ValueError('请选择 1—12,000 字符的文字')
            page = event.get('page')
            if page is not None and (type(page) is not int or page < 1 or page > 100000):
                raise ValueError('PDF 页码不合法')
            if event.get('source_uri') and not re.fullmatch(r'zotero://open-pdf/(?:library|groups/\d+)/items/[A-Z0-9]{8}(?:\?page=\d+)?',str(event['source_uri'])):
                raise ValueError('PDF 来源链接不合法')
            if event['type']=='context' and event.get('intent') not in {'edit','new','reports','assistant'}:raise ValueError('笔记操作不合法')
        if event.get('selection_kind') not in {None,'original','translation','summary'}:raise ValueError('选文类型不合法')
        if event.get('clip_kind') not in {None,'translation','summary'}:raise ValueError('摘抄类型不合法')
        if 'autosave' in event and type(event['autosave']) is not bool:raise ValueError('保存选项不合法')
        with self.condition:
            state = self.state(channel)
            state['sequence'] += 1
            message = {key: event[key] for key in ['type', 'paper_id', 'text', 'page', 'title', 'attachment_key', 'library_id', 'source_uri','intent','clip_kind','autosave','selection_kind'] if key in event}
            state['events'].append({**message, 'sequence': state['sequence']})
            state['events'] = state['events'][-80:]
            state['touched'] = time.monotonic()
            self.condition.notify_all()
            return {'ok': True, 'sequence': state['sequence']}

    def events(self, channel, since=0, wait=15):
        since = max(0, int(since))
        deadline = time.monotonic() + min(15, max(0, wait))
        with self.condition:
            state = self.state(channel)
            while state['sequence'] <= since and time.monotonic() < deadline:
                self.condition.wait(deadline - time.monotonic())
                state = self.state(channel)
            state['touched'] = time.monotonic()
            return {'sequence': state['sequence'], 'events': [e for e in state['events'] if e['sequence'] > since]}
