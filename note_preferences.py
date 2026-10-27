"""Shared excerpt presentation preferences, separate from AI credentials."""
import json,threading
from pathlib import Path

class NotePreferences:
    def __init__(self,path,atomic):self.path=Path(path);self.atomic=atomic;self.lock=threading.RLock()
    def public(self):
        with self.lock:
            try:data=json.loads(self.path.read_text('utf-8'))
            except (OSError,ValueError):data={}
            return {'include_source':isinstance(data,dict) and data.get('include_source') is True}
    def save(self,data):
        if not isinstance(data,dict) or set(data)!={'include_source'} or type(data['include_source'])!=bool:raise ValueError('摘抄设置必须为开启或关闭')
        with self.lock:
            self.atomic(self.path,json.dumps({'include_source':data['include_source']},ensure_ascii=False))
            return self.public()
