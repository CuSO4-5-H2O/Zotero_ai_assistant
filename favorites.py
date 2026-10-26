"""Persistent star metadata, separate from note content and edit versions."""
import json
import re
import threading
from pathlib import Path

class Favorites:
    def __init__(self,path,atomic):self.path=Path(path);self.atomic=atomic;self.lock=threading.RLock()
    def snapshot(self):
        with self.lock:
            if not self.path.exists():return set()
            data=json.loads(self.path.read_text(encoding='utf-8'))
            return set(data.get('starred',[]))
    def has(self,kind,item_id):return kind+':'+item_id in self.snapshot()
    def set(self,kind,item_id,starred):
        pattern=r'(?:[A-D]\d{1,2}|Z\d+_[A-Z0-9]{8})' if kind=='paper' else r'[a-f0-9]{32}'
        if kind not in {'note','report','paper'} or not isinstance(item_id,str) or not re.fullmatch(pattern,item_id) or type(starred)!=bool:raise ValueError('星标参数无效')
        with self.lock:
            values=self.snapshot();key=kind+':'+item_id
            if starred:values.add(key)
            else:values.discard(key)
            self.atomic(self.path,json.dumps({'version':1,'starred':sorted(values)},ensure_ascii=False,indent=2))
        return {'ok':True,'kind':kind,'id':item_id,'starred':starred}
