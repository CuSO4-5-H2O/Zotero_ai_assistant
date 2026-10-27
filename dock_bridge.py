"""Short-lived, authenticated messages between native readers and their notebook dock."""
import re
import secrets
import threading
import time
import json
from pathlib import Path


class DockBridge:
    def __init__(self, path=None, atomic=None):
        self.condition = threading.Condition()
        self.channels = {}
        self.path=Path(path) if path else None
        self.atomic=atomic
        if self.path and self.path.exists():
            try:
                saved=json.loads(self.path.read_text(encoding='utf-8'))
                for key,value in list(saved.items())[-32:]:
                    if re.fullmatch(r'[a-f0-9]{32}',key) and isinstance(value,dict) and type(value.get('sequence')) is int and isinstance(value.get('events'),list):
                        self.channels[key]={'sequence':value['sequence'],'events':value['events'][-80:],'touched':time.monotonic()}
            except (OSError,ValueError,TypeError,AttributeError):pass

    def persist(self):
        if self.path and self.atomic:
            self.atomic(self.path,json.dumps({key:{'sequence':value['sequence'],'events':value['events']} for key,value in self.channels.items()},ensure_ascii=False))

    def restore(self,channel):
        if len(self.channels)>=32:
            oldest=min(self.channels,key=lambda key:self.channels[key]['touched']);del self.channels[oldest]
        self.channels[channel]={'sequence':0,'events':[],'touched':time.monotonic()}
        self.persist()
        return self.channels[channel]

    def create(self):
        with self.condition:
            if len(self.channels) >= 32:
                oldest = min(self.channels, key=lambda key: self.channels[key]['touched'])
                del self.channels[oldest]
            channel = secrets.token_hex(16)
            self.restore(channel)
            return {'channel': channel}

    def state(self, channel):
        if not re.fullmatch(r'[a-f0-9]{32}', str(channel)):
            raise ValueError('浮窗连接编号无效，请重新打开科研精读')
        if channel not in self.channels:self.restore(channel)
        return self.channels[channel]

    def publish(self, channel, event):
        if not isinstance(event, dict) or event.get('type') not in {'paper', 'clip','context','home','open_note'}:
            raise ValueError('未知的浮窗消息')
        if event['type'] not in {'home','open_note'} and not re.fullmatch(r'(?:[A-D]\d{1,2}|Z\d+_[A-Z0-9]{8})', str(event.get('paper_id', ''))):
            raise ValueError('文献编号不合法')
        if event['type']=='open_note' and not re.fullmatch(r'[a-f0-9]{32}',str(event.get('note_id',''))):raise ValueError('目标笔记编号无效')
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
        if 'background' in event and type(event['background']) is not bool:raise ValueError('后台摘录选项不合法')
        if event.get('background') and (event['type']!='clip' or (event.get('note_id') is not None and not re.fullmatch(r'[a-f0-9]{32}',str(event['note_id'])))):raise ValueError('后台摘录目标不合法')
        with self.condition:
            state = self.state(channel)
            state['sequence'] += 1
            message = {key: event[key] for key in ['type', 'paper_id', 'note_id','text', 'page', 'title', 'attachment_key', 'library_id', 'source_uri','intent','clip_kind','autosave','selection_kind','background'] if key in event}
            state['events'].append({**message, 'sequence': state['sequence']})
            state['events'] = state['events'][-80:]
            state['touched'] = time.monotonic()
            self.persist()
            self.condition.notify_all()
            return {'ok': True, 'sequence': state['sequence']}

    def events(self, channel, since=0, wait=15):
        since = max(0, int(since))
        deadline = time.monotonic() + min(15, max(0, wait))
        with self.condition:
            state = self.state(channel)
            reset=since>state['sequence']
            if reset:since=0
            while not reset and state['sequence'] <= since and time.monotonic() < deadline:
                self.condition.wait(deadline - time.monotonic())
                state = self.state(channel)
            state['touched'] = time.monotonic()
            return {'sequence': state['sequence'], 'events': [e for e in state['events'] if e['sequence'] > since], 'reset':reset}
