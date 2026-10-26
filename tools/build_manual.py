"""Build a portable illustrated HTML manual with embedded local screenshots."""
from pathlib import Path
import base64, html, sys
from urllib.parse import quote
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from markdown_view import render_markdown
source=ROOT/'docs'/'使用说明.md'
body=render_markdown(source.read_text('utf-8'))
for image in (source.parent/'images').glob('*.png'):
    body=body.replace('src="images/'+quote(image.name)+'"','src="data:image/png;base64,'+base64.b64encode(image.read_bytes()).decode()+'"')
assert body.count('src="data:image/png;base64,')==8, 'All eight screenshots must be embedded'
css='''*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#f2f6f3;color:#243c34;font:16px/1.85 "Microsoft YaHei","Segoe UI",sans-serif}main{max-width:920px;margin:35px auto;padding:36px 50px;background:white;border:1px solid #dde7df;border-radius:16px}h1{font-size:30px;color:#176c58}h2{margin-top:42px;padding-top:16px;border-top:1px solid #e4ece6;font-size:22px}p,li{max-width:76ch}a{color:#14715d}img{display:block;max-width:100%;height:auto;margin:22px auto;border:1px solid #dbe6df;border-radius:8px;box-shadow:0 4px 14px #153d2510}table{border-collapse:collapse;width:100%;font-size:14px}td,th{border:1px solid #dbe5dd;padding:9px 13px;text-align:left}th{background:#edf5ef}code{background:#edf4ef;padding:2px 5px;border-radius:4px}li{margin:7px 0}strong{color:#195d4b}footer{margin-top:35px;color:#728378;font-size:13px}@media(max-width:650px){main{margin:0;padding:22px 18px;border:0;border-radius:0}h1{font-size:25px}table{font-size:12px}td,th{padding:6px}}@media print{body{background:white}main{border:0;margin:0;padding:0}h2{break-after:avoid}img,table{break-inside:avoid}a{color:inherit}}'''
page='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>科研笔记仓库 2.0 使用说明</title><style>'+css+'</style></head><body><main>'+body+'<footer>2.0.1 · 2026-10-26 · 截图为隔离示例仓库</footer></main></body></html>'
target=source.with_suffix('.html');target.write_text(page,'utf-8');print(str(target))
