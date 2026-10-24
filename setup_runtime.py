from pathlib import Path
import sys, zipfile, shutil, json
ROOT=Path(__file__).parent
source=Path(sys.base_prefix)
target=ROOT/'.runtime'/'python'
target.mkdir(parents=True,exist_ok=True)
if not (target/'python.exe').exists():
 for name in ['python.exe','pythonw.exe','python3.dll','python312.dll','vcruntime140.dll','vcruntime140_1.dll','LICENSE.txt']:
  if (source/name).exists():shutil.copy2(source/name,target/name)
 shutil.copytree(source/'DLLs',target/'DLLs',dirs_exist_ok=True,ignore=shutil.ignore_patterns('__pycache__'))
 excluded={'site-packages','__pycache__','test','tests','idlelib','tkinter','turtledemo','ensurepip'}
 with zipfile.ZipFile(target/'python312.zip','w',zipfile.ZIP_STORED) as archive:
  for p in (source/'Lib').rglob('*'):
   rel=p.relative_to(source/'Lib')
   if p.is_file() and not any(part in excluded for part in rel.parts) and p.suffix!='.pyc':
    archive.write(p,rel.as_posix())
 (target/'python312._pth').write_text('python312.zip\nDLLs\n.\nLib\\site-packages\n..\\..\n',encoding='utf-8')
try:
 from PIL import Image,ImageDraw
 icon=Image.new('RGBA',(256,256),(0,0,0,0));d=ImageDraw.Draw(icon)
 d.rounded_rectangle((4,4,252,252),radius=48,fill='#0b777b')
 d.rounded_rectangle((61,44,197,215),radius=12,fill='white')
 d.line((91,45,91,214),fill='#bcd8d9',width=5)
 for y in (92,124,156):d.rounded_rectangle((112,y,174,y+8),radius=4,fill='#0b777b')
 icon.save(ROOT/'notebook.ico',sizes=[(16,16),(32,32),(48,48),(64,64),(128,128),(256,256)])
except ImportError:pass
print(json.dumps({'runtime':str(target),'stdlib_bytes':(target/'python312.zip').stat().st_size,'icon':(ROOT/'notebook.ico').exists()}))

