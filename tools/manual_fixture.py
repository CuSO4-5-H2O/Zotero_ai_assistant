"""Isolated workspace for UI acceptance/screenshots; never changes the user's library."""
import json, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
import server
root=ROOT/'.runtime'/'audit-2.0'/'demo';root.mkdir(parents=True,exist_ok=True)
server.SOURCE=root/'empty-resources'
notes=server.Vault(root/'vault',seed=False)
if not notes.read_index()['notes']:
    notes.create('阅读计划','我的笔记',['待读'],'# 本周阅读计划\n\n- [ ] 阅读论文的方法与实验\n- [ ] 对照原文记录关键结论\n- [ ] 整理问题与下一步实验\n\n## 一个公式示例\n\n$$E=mc^2$$\n\n保存后可在预览中查看公式。')
    notes.create('实验记录','实验记录',[],'# 实验记录\n\n日期、条件、结果与下一步。')
reports=server.Vault(root/'reports',seed=False);reports.category='reports'
if not reports.read_index()['notes']:reports.create('课题调研报告','调研报告',[],'# 课题调研报告\n\n报告独立保存，不会混入文献笔记。\n\n| 研究方向 | 关注问题 |\n|---|---|\n| 可编程超表面 | 控制与标定 |\n| 移动通信 | 波束跟踪 |')
catalog=root/'vault'/'.papers'/'catalog.json'
if not catalog.exists() or catalog.read_text('utf-8')=='[]':
    server.atomic(catalog,json.dumps([dict(id='A1',title='文献阅读示例',author='示例作者',year='2026',venue='示例',innovation='阅读时记录研究问题、方法与证据。',type='示例题录',relation='操作演示',access='示例数据',boundary='仅供界面验收，不是真实研究论文。')],ensure_ascii=False))
from deepseek_client import DeepSeek
live_ai='--live-ai' in sys.argv
server.DeepSeek=lambda _path,atomic:DeepSeek(ROOT/'.runtime'/'deepseek.json' if live_ai else root/'config'/'deepseek.json',atomic)
projects=root/'projects';projects.mkdir(exist_ok=True)
(projects/'研究计划.md').write_text('# 研究计划\n\n1. 整理文献\n2. 设计实验\n3. 对照数据\n','utf-8')
sys.argv=['server.py','--vault',str(root/'vault'),'--config',str(root/'config'),'--state',str(root/'state.json'),'--fresh-session']
server.main()
