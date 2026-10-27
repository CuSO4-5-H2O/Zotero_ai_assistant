"""Safely fast-forward a clean public checkout before starting the backend."""
from __future__ import annotations
import json,os,subprocess
from pathlib import Path

EXPECTED_ORIGIN='https://github.com/CuSO4-5-H2O/Zotero_ai_assistant.git'

def update(root:Path,python:str,*,expected_origin=EXPECTED_ORIGIN,timeout=12):
    root=Path(root).resolve()
    def git(*args,check=True):
        env={**os.environ,'GIT_TERMINAL_PROMPT':'0','GCM_INTERACTIVE':'Never'}
        return subprocess.run(['git','-C',str(root),*args],env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout,check=check,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    try:
        if not (root/'.git').exists():return {'state':'not_git_checkout'}
        if git('remote','get-url','origin').stdout.strip().removesuffix('/')!=expected_origin.removesuffix('/'):return {'state':'unrecognized_origin'}
        if git('branch','--show-current').stdout.strip()!='main':return {'state':'not_main'}
        before=git('rev-parse','HEAD').stdout.strip()
        try:prior=json.loads((root/'.runtime/github-update-status.json').read_text('utf-8'))
        except (OSError,ValueError):prior={}
        if prior.get('state')=='build_failed' and prior.get('revision')==before:
            repair=subprocess.run([python,str(root/'build_zotero_plugin.py'),'--embed-root'],cwd=root,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            if repair.returncode:return {'state':'build_failed','revision':before,'detail':repair.stderr[-600:]}
        if git('status','--porcelain','--untracked-files=no').stdout.strip():return {'state':'local_changes'}
        git('fetch','--quiet','origin','main')
        target=git('rev-parse','FETCH_HEAD').stdout.strip()
        if before==target:return {'state':'current','revision':before}
        if git('merge-base','--is-ancestor',before,target,check=False).returncode:return {'state':'not_fast_forward'}
        # Automatic dependency installation would be a separate, potentially
        # disruptive operation. Leave both code and running installation intact.
        dependency_diff=git('diff','--name-only',before,target,'--','requirements.txt','tools/bootstrap.py','tools/katex-dist.json').stdout.strip()
        if dependency_diff:return {'state':'dependencies_changed','files':dependency_diff.splitlines()}
        # Untracked path collisions are refused by Git before any overwrite.
        merge=git('merge','--ff-only','--no-edit',target,check=False)
        if merge.returncode:return {'state':'merge_refused','detail':merge.stderr[-600:]}
        build=subprocess.run([python,str(root/'build_zotero_plugin.py'),'--embed-root'],cwd=root,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        if build.returncode:
            # Do not claim success; retain fetched revision and report repair path.
            return {'state':'build_failed','revision':target,'detail':build.stderr[-600:]}
        return {'state':'updated','revision':target}
    except (OSError,subprocess.SubprocessError) as error:
        return {'state':'unavailable','detail':str(error)[:300]}

def run_startup(root,python):
    result=update(root,python)
    try:
        path=Path(root)/'.runtime/github-update-status.json';path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    except OSError:pass
    return result
