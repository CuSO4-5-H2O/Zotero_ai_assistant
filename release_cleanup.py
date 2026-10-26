"""Remove only older, ID-verified packages after the replacement is active."""
from pathlib import Path
import json,re,zipfile

PLUGIN_ID='research-notebook@local.research'
def version(value):
    if not re.fullmatch(r'\d+\.\d+\.\d+',str(value)):raise ValueError('版本格式不合法')
    return tuple(map(int,value.split('.')))

def cleanup(root,profile,active_version,desktop=None):
    root=Path(root).resolve();profile=Path(profile).resolve()
    status=json.loads((root/'.runtime/zotero-plugin-status.json').read_text(encoding='utf-8'))
    if status.get('plugin')!=PLUGIN_ID or not status.get('loaded') or status.get('version')!=active_version:raise ValueError('新版尚未成功加载，暂不删除旧包')
    target=profile/'extensions'/(PLUGIN_ID+'.xpi')
    def read(path):
        with zipfile.ZipFile(path) as archive:return json.loads(archive.read('manifest.json'))
    installed=read(target)
    if installed.get('applications',{}).get('zotero',{}).get('id')!=PLUGIN_ID or installed['version']!=active_version:raise ValueError('当前安装版本与启动状态不一致，暂不清理')
    candidates=[]
    for directory in [root/'dist',root/'.runtime/pending-plugin']:
        candidates.extend(p for p in directory.glob('research-notebook-*.xpi') if re.fullmatch(r'research-notebook-\d+\.\d+\.\d+\.xpi',p.name))
    candidates.extend(p for p in (root/'.runtime/plugin-backups').glob('*.xpi') if re.fullmatch(r'\d+\.\d+\.\d+-[a-f0-9]{12}\.xpi',p.name))
    desktop=Path(desktop) if desktop else Path.home()/'OneDrive/桌面'
    candidates.extend(p for p in desktop.glob('科研笔记仓库-Zotero插件-*.xpi') if re.fullmatch(r'科研笔记仓库-Zotero插件-\d+\.\d+\.\d+\.xpi',p.name))
    allowed={p.resolve() for p in [root/'dist',root/'.runtime/pending-plugin',root/'.runtime/plugin-backups',desktop]}
    removed=[];skipped=[]
    for path in candidates:
        # No recursion, junction traversal, arbitrary filenames, or installed XPI deletion.
        if path.is_symlink() or path.resolve().parent not in allowed or path.resolve()==target.resolve():continue
        try:
            item=read(path)
            if item.get('applications',{}).get('zotero',{}).get('id')!=PLUGIN_ID or version(item['version'])>=version(active_version):continue
            path.unlink();removed.append(str(path))
        except (OSError,ValueError,KeyError,zipfile.BadZipFile):skipped.append(str(path))
    return {'state':'older-packages-removed','active_version':active_version,'removed':removed,'skipped':skipped}
