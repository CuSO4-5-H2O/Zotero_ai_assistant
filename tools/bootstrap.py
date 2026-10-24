"""Windows/Python 3.12 first-run setup. Never imports an existing notebook."""
import argparse,base64,hashlib,io,json,os,subprocess,sys,tarfile,urllib.request
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
def assets():
    spec=json.loads((ROOT/'tools/katex-dist.json').read_text('utf-8'))
    with urllib.request.urlopen(spec['url'],timeout=60) as response:raw=response.read(20_000_000)
    algorithm,expected=spec['integrity'].split('-',1)
    if algorithm!='sha512' or base64.b64encode(hashlib.sha512(raw).digest()).decode()!=expected:raise RuntimeError('KaTeX integrity verification failed')
    destination=ROOT/'web/vendor/katex';destination.mkdir(parents=True,exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(raw),mode='r:gz') as archive:
        for member in archive.getmembers():
            if not member.isfile():continue
            if member.name=='package/LICENSE':relative=Path('LICENSE')
            elif member.name.startswith('package/dist/'):
                relative=Path(member.name.removeprefix('package/dist/'))
                if relative.as_posix() not in {'katex.min.js','katex.min.css'} and not relative.as_posix().startswith('fonts/'):continue
            else:continue
            target=(destination/relative).resolve()
            if not target.is_relative_to(destination.resolve()):raise RuntimeError('Invalid archive path')
            target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(archive.extractfile(member).read())
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--zotero-storage',type=Path);parser.add_argument('--assets-only',action='store_true');args=parser.parse_args()
    if args.assets_only:assets();print('KaTeX assets installed and integrity checked.');return
    if os.name!='nt' or sys.version_info[:2]!=(3,12):raise SystemExit('Use Windows and Python 3.12: py -3.12 tools/bootstrap.py')
    subprocess.run([sys.executable,str(ROOT/'setup_runtime.py')],check=True,cwd=ROOT)
    target=ROOT/'.runtime/python/Lib/site-packages';target.mkdir(parents=True,exist_ok=True)
    subprocess.run([sys.executable,'-m','pip','install','-r',str(ROOT/'requirements.txt'),'--target',str(target)],check=True,cwd=ROOT)
    assets()
    if args.zotero_storage:
        folder=args.zotero_storage.expanduser().resolve(strict=True)
        if not folder.is_dir():raise SystemExit('Zotero storage must be a directory')
        (ROOT/'.runtime/app-settings.json').write_text(json.dumps({'zotero_storage':str(folder)}),'utf-8')
    subprocess.run([sys.executable,str(ROOT/'build_zotero_plugin.py'),'--embed-root'],check=True,cwd=ROOT)
    print('Ready. Run .runtime\\python\\pythonw.exe launcher.py, then install the XPI from dist in Zotero.')
if __name__=='__main__':main()

