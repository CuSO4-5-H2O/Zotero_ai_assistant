"""Build only the plugin sources. No credentials, notes or PDFs enter the XPI."""
import argparse,hashlib,json,zipfile
from pathlib import Path

ROOT=Path(__file__).resolve().parent
def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--embed-root',action='store_true',help='Embed this local checkout path for a personal installation; never commit the generated package.')
    args=parser.parse_args()
    source=ROOT/'zotero-plugin';manifest=json.loads((source/'manifest.json').read_text('utf-8'))
    files=['manifest.json','bootstrap.js','notebook.js','dock.js','updater.js','translation.js','README.md']
    output=ROOT/'dist'/('research-notebook-'+manifest['version']+'.xpi');output.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as archive:
        for name in files:
            content=(source/name).read_text('utf-8')
            if name=='notebook.js' and args.embed_root:content=content.replace('bundleRoot:null','bundleRoot:'+json.dumps(str(ROOT)))
            archive.writestr(name,content.encode('utf-8'))
    release={'id':manifest['applications']['zotero']['id'],'version':manifest['version'],'file':output.name,'bytes':output.stat().st_size,'sha256':hashlib.sha256(output.read_bytes()).hexdigest()}
    (ROOT/'dist/latest.json').write_text(json.dumps(release,indent=2),'utf-8')
    print('Built '+str(output))
if __name__=='__main__':main()

