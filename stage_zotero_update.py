"""Bootstrap an already-installed local plugin at Zotero's next normal exit.

No Zotero process is terminated, and no database or add-on registry is modified.
"""
from pathlib import Path
import argparse,ctypes,hashlib,json,os,shutil,subprocess,sys,time,zipfile
from ctypes import wintypes
from release_cleanup import cleanup

ROOT=Path(__file__).resolve().parent
PLUGIN_ID='research-notebook@local.research'
PLAN=ROOT/'.runtime/pending-plugin-update.json'
STATUS=ROOT/'.runtime/plugin-bootstrap-update.json'

def atomic_json(path,data):
    path.parent.mkdir(parents=True,exist_ok=True)
    temporary=path.with_suffix(path.suffix+'.tmp')
    temporary.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8');os.replace(temporary,path)

def manifest(path):
    with zipfile.ZipFile(path) as archive:
        if archive.testzip() is not None:raise ValueError('插件 ZIP 校验失败')
        value=json.loads(archive.read('manifest.json'))
        if value.get('applications',{}).get('zotero',{}).get('id')!=PLUGIN_ID:raise ValueError('插件 ID 不匹配')
        return value

def version(value):
    parts=str(value).split('.')
    if not parts or not all(p.isdigit() for p in parts):raise ValueError('插件版本格式不合法')
    return tuple(map(int,parts))

def validate_plan(plan):
    profile=Path(plan['profile']).resolve();target=Path(plan['target']).resolve();package=Path(plan['package']).resolve()
    if target!=profile/'extensions'/(PLUGIN_ID+'.xpi'):raise ValueError('目标不在指定 Zotero 插件目录')
    if not package.is_relative_to((ROOT/'.runtime/pending-plugin').resolve()):raise ValueError('升级包不在本地暂存目录')
    raw=package.read_bytes()
    if len(raw)!=plan['bytes'] or hashlib.sha256(raw).hexdigest()!=plan['sha256']:raise ValueError('暂存升级包校验失败')
    new=manifest(package);old=manifest(target)
    if new['version']!=plan['version']:raise ValueError('暂存包版本不匹配')
    return target,package,new,old

def apply(plan):
    target,package,new,old=validate_plan(plan)
    if version(old['version'])>=version(new['version']):return {'state':'already-current','version':old['version']}
    backup=ROOT/'.runtime/plugin-backups'/(old['version']+'-'+hashlib.sha256(target.read_bytes()).hexdigest()[:12]+'.xpi')
    backup.parent.mkdir(parents=True,exist_ok=True)
    if not backup.exists():shutil.copy2(target,backup)
    temporary=target.with_suffix('.xpi.pending')
    shutil.copy2(package,temporary)
    if temporary.read_bytes()!=package.read_bytes():raise ValueError('插件写入校验失败')
    os.replace(temporary,target)
    if target.read_bytes()!=package.read_bytes():raise ValueError('已安装插件校验失败')
    return {'state':'applied-awaiting-zotero-start','version':new['version'],'backup':str(backup)}

def process_ids(executable):
    literal=str(Path(executable).resolve()).replace("'","''")
    command="$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter \"name='zotero.exe'\" | Where-Object {$_.ExecutablePath -eq '"+literal+"'} | Select-Object ProcessId,ParentProcessId) | ConvertTo-Json -Compress"
    output=subprocess.check_output(['powershell.exe','-NoProfile','-NonInteractive','-Command',command],creationflags=subprocess.CREATE_NO_WINDOW)
    rows=json.loads(output.decode('utf-8-sig') or '[]')
    if isinstance(rows,dict):rows=[rows]
    ids={row['ProcessId'] for row in rows}
    return [row['ProcessId'] for row in rows if row['ParentProcessId'] not in ids]

def wait_for_exit(pids):
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.OpenProcess.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD];kernel.OpenProcess.restype=wintypes.HANDLE
    kernel.WaitForMultipleObjects.argtypes=[wintypes.DWORD,ctypes.POINTER(wintypes.HANDLE),wintypes.BOOL,wintypes.DWORD];kernel.WaitForMultipleObjects.restype=wintypes.DWORD
    kernel.CloseHandle.argtypes=[wintypes.HANDLE]
    handles=[]
    try:
        for pid in pids:
            handle=kernel.OpenProcess(0x00100000,False,int(pid))
            if handle:handles.append(handle)
            elif ctypes.get_last_error()!=87:raise OSError('无法等待 Zotero 正常退出')
        if handles:
            result=kernel.WaitForMultipleObjects(len(handles),(wintypes.HANDLE*len(handles))(*handles),True,86400000)
            if result!=0:raise TimeoutError('升级等待已结束，请重新运行升级助手')
    finally:
        for handle in handles:kernel.CloseHandle(handle)

def watch():
    plan=json.loads(PLAN.read_text(encoding='utf-8'))
    try:
        wait_for_exit(plan['pids'])
        # Child processes can briefly retain the XPI after the parent exits.
        for attempt in range(40):
            try:result=apply(plan);break
            except PermissionError:
                if attempt==39:raise
                time.sleep(.1)
        atomic_json(STATUS,{**result,'time':time.time()})
        deadline=time.monotonic()+86400
        while time.monotonic()<deadline:
            try:
                active=json.loads((ROOT/'.runtime/zotero-plugin-status.json').read_text(encoding='utf-8'))
                if active.get('loaded') and version(active.get('version','0'))>=version(plan['version']):
                    cleaned=cleanup(ROOT,plan['profile'],active['version'])
                    atomic_json(ROOT/'.runtime/plugin-cleanup-status.json',{**cleaned,'time':time.time()});break
            except (OSError,ValueError,KeyError):pass
            time.sleep(1)
    except Exception as error:atomic_json(STATUS,{'state':'failed','error':str(error),'time':time.time()})

def stage(profile,executable):
    release=json.loads((ROOT/'dist/latest.json').read_text(encoding='utf-8'))
    if release['id']!=PLUGIN_ID or release['file']!='research-notebook-'+release['version']+'.xpi':raise ValueError('本地发布包信息不合法')
    source=ROOT/'dist'/release['file'];raw=source.read_bytes()
    if hashlib.sha256(raw).hexdigest()!=release['sha256'] or len(raw)!=release['bytes']:raise ValueError('发布包校验失败')
    package=ROOT/'.runtime/pending-plugin'/source.name;package.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,package)
    target=Path(profile).resolve()/'extensions'/(PLUGIN_ID+'.xpi')
    plan={'profile':str(Path(profile).resolve()),'target':str(target),'package':str(package),'version':release['version'],'sha256':release['sha256'],'bytes':len(raw),'pids':process_ids(executable)}
    validate_plan(plan);atomic_json(PLAN,plan)
    if not plan['pids']:
        result=apply(plan);atomic_json(STATUS,{**result,'time':time.time()});return result
    current={ 'state':'waiting-for-normal-zotero-exit','version':release['version'],'time':time.time()}
    atomic_json(STATUS,current)
    worker=subprocess.Popen([str(ROOT/'.runtime/python/pythonw.exe'),str(Path(__file__).resolve()),'--watch'],cwd=ROOT,creationflags=subprocess.CREATE_NO_WINDOW)
    current['worker_pid']=worker.pid;atomic_json(STATUS,current)
    return current

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--watch',action='store_true');parser.add_argument('--cleanup-only',action='store_true');parser.add_argument('--profile',type=Path);parser.add_argument('--exe',type=Path)
    args=parser.parse_args()
    if args.cleanup_only and args.profile:
        try:
            active=json.loads((ROOT/'.runtime/zotero-plugin-status.json').read_text(encoding='utf-8'))
            result=cleanup(ROOT,args.profile,active['version'])
            atomic_json(ROOT/'.runtime/plugin-cleanup-status.json',{**result,'time':time.time()})
        except Exception as error:atomic_json(ROOT/'.runtime/plugin-cleanup-status.json',{'state':'deferred','error':str(error),'time':time.time()})
    elif args.watch:watch()
    elif args.profile and args.exe:print(json.dumps(stage(args.profile,args.exe),ensure_ascii=False))
    else:parser.error('请指定 --profile 和 --exe')
