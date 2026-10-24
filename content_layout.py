"""Idempotent, backed-up separation of reports and automatic paper notes."""
import hashlib,json,re,shutil,time
from pathlib import Path

def separate(vault,reports,papers,atomic,backup):
    backup=Path(backup);result={'reports':0,'paper_notes':0,'guides':0}
    with vault.lock,reports.lock:
        old=vault.read_index();target=reports.read_index();remaining=[]
        for row in old['notes']:
            is_report=row.get('folder')=='调研报告' or row.get('kind')=='report'
            if not is_report:remaining.append(row);continue
            source=vault.path(row);destination=reports.path(row)
            if not backup.exists():backup.mkdir(parents=True)
            atomic(backup/'vault-index.json',json.dumps(old,ensure_ascii=False)) if not (backup/'vault-index.json').exists() else None
            saved=backup/'reports'/row['file'];saved.parent.mkdir(parents=True,exist_ok=True)
            if not saved.exists():shutil.copy2(source,saved)
            if not any(n['id']==row['id'] for n in target['notes']):
                destination.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,destination);target['notes'].append({**row,'kind':'report'})
                if row['folder'] not in target['folders']:target['folders'].append(row['folder'])
                history=vault.root/'.history'/row['id']
                if history.exists():shutil.copytree(history,reports.root/'.history'/row['id'],dirs_exist_ok=True)
            elif not destination.exists() or hashlib.sha256(destination.read_bytes()).digest()!=hashlib.sha256(source.read_bytes()).digest():raise ValueError('报告迁移存在版本差异，已保留原件，请人工对照')
            result['reports']+=1
        reports.write_index(target)
        old['notes']=remaining;old['folders']=[f for f in old['folders'] if f!='调研报告'];vault.write_index(old)
        for row in target['notes']:
            if row.get('kind')=='report':
                source=vault.path(row)
                if source.exists() and (backup/'reports'/row['file']).exists() and source.read_bytes()==reports.path(row).read_bytes():source.unlink()
    # Known automatically-created translation cards are appended to their paper's canonical note.
    for row in list(vault.read_index()['notes']):
        if row.get('trashed'):continue
        match=re.match(r'^(?:翻译笔记|选文总结) · ((?:[A-D]\d{1,2}|Z\d+_[A-Z0-9]{8}))(?:$| ·)',row['title'])
        if not match or match[1] not in papers.refs:continue
        pid=match[1];doc=vault.get(row['id']);reading=papers.reading(pid);marker='<!-- migrated-note:'+row['id']+' -->'
        if marker not in reading['content']:
            atomic(backup/'automatic-notes'/(row['id']+'.json'),json.dumps(doc,ensure_ascii=False))
            papers.save_reading(pid,{'version':reading['version'],'content':reading['content'].rstrip()+'\n\n'+marker+'\n\n'+doc['content']+'\n'})
        vault.trash(row['id']);result['paper_notes']+=1
    # Only exact guide prefixes can be moved automatically; ambiguous personal prose remains untouched.
    for pid in papers.refs:
        reading=papers.reading(pid);guide=papers.guide(pid)
        if guide.strip() and reading['content'].startswith(guide):
            atomic(backup/'mixed-notes'/(pid+'.md'),reading['content'])
            atomic(papers.folder(pid)/'guide.md',guide)
            papers.save_reading(pid,{'version':reading['version'],'content':reading['content'][len(guide):].lstrip()});result['guides']+=1
    atomic(backup/'latest-result.json',json.dumps(result,ensure_ascii=False));return result
