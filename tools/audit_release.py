"""Reject private workspace content and credential-shaped literals before release."""
import re, subprocess, sys
from pathlib import Path
root=Path(__file__).resolve().parents[1]
files=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=root).decode().split('\0')
bad=[];checked=0
for name in filter(None,files):
    path=root/name
    if Path(name).parts[0] in {'.runtime','vault','reports','projects'} or path.suffix.lower() in {'.pdf','.sqlite','.dat','.xpi'}:bad.append(name);continue
    if path.suffix.lower() in {'.py','.js','.json','.md','.yml','.html'}:
        text=path.read_text('utf-8-sig');checked+=1
        if re.search(r'(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{24,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',text):bad.append(name)
if bad:raise SystemExit('Release audit rejected paths: '+', '.join(bad))
print(f'PASS: {checked} text files checked; no private workspace directories, PDFs, runtime credentials or credential-shaped literals.')
