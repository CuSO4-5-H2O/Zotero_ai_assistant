from pathlib import Path
import ctypes, json, os, subprocess, sys, time, urllib.request, traceback
from ctypes import wintypes
ROOT=Path(__file__).resolve().parent
STATE=ROOT/'.runtime'/'state.json'
def alive():
 try:
  data=json.loads(STATE.read_text(encoding='utf-8'))
  with urllib.request.urlopen('http://127.0.0.1:'+str(data['port'])+'/health',timeout=1) as r:
   health=json.load(r)
   if health.get('app')=='research-notebook' and health.get('version',0)>=13:return data
 except Exception:pass
 return None
def ensure_service():
 ctypes.windll.kernel32.CreateMutexW.restype=wintypes.HANDLE
 ctypes.windll.kernel32.CreateMutexW.argtypes=[wintypes.LPVOID,wintypes.BOOL,wintypes.LPCWSTR]
 ctypes.windll.kernel32.WaitForSingleObject.argtypes=[wintypes.HANDLE,wintypes.DWORD]
 ctypes.windll.kernel32.ReleaseMutex.argtypes=[wintypes.HANDLE]
 ctypes.windll.kernel32.CloseHandle.argtypes=[wintypes.HANDLE]
 mutex=ctypes.windll.kernel32.CreateMutexW(None,False,'Local\\ResearchNotebook_Start')
 ctypes.windll.kernel32.WaitForSingleObject(mutex,10000)
 try:
  data=alive()
  if not data:
   logs=(ROOT/'.runtime'/'server.log').open('a',encoding='utf-8')
   subprocess.Popen([str(ROOT/'.runtime'/'python'/'pythonw.exe'),str(ROOT/'server.py')],cwd=ROOT,stdout=logs,stderr=logs,creationflags=subprocess.CREATE_NO_WINDOW)
   for _ in range(60):
    time.sleep(.2);data=alive()
    if data:break
   if not data:raise RuntimeError('本地服务未能启动，请检查 .runtime/server.log')
 finally:
  ctypes.windll.kernel32.ReleaseMutex(mutex);ctypes.windll.kernel32.CloseHandle(mutex)
 return data

def main():
 data=ensure_service()
 if '--service-only' in sys.argv:return
 edge=Path(os.environ.get('PROGRAMFILES(X86)','C:/Program Files (x86)'))/'Microsoft/Edge/Application/msedge.exe'
 if not edge.exists():edge=Path(os.environ.get('PROGRAMFILES','C:/Program Files'))/'Microsoft/Edge/Application/msedge.exe'
 if not edge.exists():raise RuntimeError('没有找到 Microsoft Edge。')
 url='http://127.0.0.1:'+str(data['port'])+'/?session='+data['key']
 profile=ROOT/'.runtime'/'edge-profile'
 subprocess.Popen([str(edge),'--app='+url,'--user-data-dir='+str(profile),'--no-first-run','--no-default-browser-check','--window-size=1450,960'],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
if __name__=='__main__':
 try:main()
 except Exception:
  (ROOT/'.runtime'/'launcher_error.log').write_text(traceback.format_exc(),encoding='utf-8')
  ctypes.windll.user32.MessageBoxW(None,'启动失败。请查看 '+str(ROOT/'.runtime'/'launcher_error.log'),'科研笔记仓库',16)



