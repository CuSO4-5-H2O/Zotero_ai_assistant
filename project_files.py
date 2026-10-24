"""Versioned text-file operations inside a user-selected project directory."""
import base64,hashlib,json,os,re,threading,time,uuid
from pathlib import Path

EXT={'.md','.txt','.csv','.json','.yaml','.yml','.toml','.py','.js','.ts','.jsx','.tsx','.html','.css','.m','.tex','.bib','.xml','.svg','.ini'}
DENY={'node_modules','__pycache__','storage','vault','extensions','appdata','windows','program files'}

class ProjectFiles:
    def __init__(self,path,atomic):
        self.path=Path(path);self.atomic=atomic;self.lock=threading.RLock();self.history=self.path.parent/'project-history'
        self.default=self.path.parent.parent/'projects';self.default.mkdir(exist_ok=True)
    def settings(self):
        data=json.loads(self.path.read_text('utf-8')) if self.path.exists() else {'root':str(self.default)}
        return {**data,'label':Path(data['root']).name,'extensions':sorted(EXT)}
    def set_root(self,value):
        if not isinstance(value,str) or not value.strip():raise ValueError('请输入工程目录')
        root=Path(value).expanduser().resolve(strict=True)
        app=self.path.parent.parent.resolve()
        if not root.is_dir() or root==Path(root.anchor) or root==Path.home() or root==app or root==app/'.runtime' or any(part.lower() in DENY or part.startswith('.') for part in root.parts[1:]):raise ValueError('请选择具体的工程目录，不能选择系统、凭据或文献存储目录')
        self.atomic(self.path,json.dumps({'root':str(root)},ensure_ascii=False));return self.settings()
    def bind(self):return ProjectSession(self,Path(self.settings()['root']).resolve())

class ProjectSession:
    def __init__(self,owner,root):self.owner=owner;self.root=root;self.reads={}
    def path(self,value,writing=False):
        if not isinstance(value,str) or not value or len(value)>300:raise ValueError('请输入工程内的相对路径')
        parts=value.replace('\\','/').split('/')
        if any(p in {'','..','.'} or p.startswith('.') or p.lower() in DENY or ':' in p or p.endswith((' ','.')) for p in parts):raise ValueError('工程路径不合法或涉及受保护目录')
        path=self.root.joinpath(*parts)
        for p in [path,*path.parents]:
            if p==self.root:break
            if p.is_symlink() or (hasattr(p,'is_junction') and p.is_junction()):raise ValueError('不允许操作链接或联接目录')
        if not path.resolve().is_relative_to(self.root):raise ValueError('路径不在所选工程中')
        if path.exists() and path.stat().st_nlink>1:raise ValueError('不允许修改硬链接文件')
        if writing and path.suffix.lower() not in EXT:raise ValueError('此格式仅支持查看文件信息，不支持修改；工程二进制文件须使用原软件')
        name=path.name.lower()
        if any(x in name for x in ['credential','secret','token','password','api_key']) or name in {'auth.json','id_rsa','id_ed25519'}:raise ValueError('此文件可能含有登录凭据，不向助手提供')
        return path
    def list(self,query=''):
        if not isinstance(query,str) or len(query)>200:raise ValueError('搜索词过长')
        rows=[];visited=0
        for base,dirs,files in os.walk(self.root):
            dirs[:]=[d for d in dirs if not d.startswith('.') and d.lower() not in DENY and not (Path(base)/d).is_symlink() and not (Path(base)/d).is_junction()]
            for name in sorted(files):
                visited+=1
                if visited>10000:return {'files':rows,'limited':True}
                rel=(Path(base)/name).relative_to(self.root).as_posix()
                try:p=self.path(rel)
                except ValueError:continue
                if query.casefold() not in rel.casefold():continue
                rows.append({'path':rel,'bytes':p.stat().st_size,'editable':p.suffix.lower() in EXT})
                if len(rows)>=150:return {'files':rows,'limited':True}
        return {'files':rows,'limited':False}
    def import_file(self,path,encoded):
        p=self.path(path)
        if p.suffix.lower() in {'.exe','.dll','.com','.bat','.cmd','.ps1','.lnk','.url'}:raise ValueError('工程仓库不导入可执行程序或系统快捷方式')
        if not isinstance(encoded,str) or len(encoded)>28_000_000:raise ValueError('单个导入文件最大 20MB')
        try:raw=base64.b64decode(encoded,validate=True)
        except ValueError:raise ValueError('文件数据无效') from None
        if len(raw)>20_000_000:raise ValueError('单个导入文件最大 20MB')
        with self.owner.lock:
            p.parent.mkdir(parents=True,exist_ok=True)
            try:
                with p.open('xb') as file:file.write(raw)
            except FileExistsError:raise ValueError('同名文件已存在，未覆盖；请更名后导入') from None
        return {'ok':True,'path':p.relative_to(self.root).as_posix(),'bytes':len(raw)}

    def read(self,path):
        p=self.path(path,True)
        if p.stat().st_size>500000:raise ValueError('文本文件超过500KB，请缩小文件后处理')
        raw=p.read_bytes()
        try:content=raw.decode('utf-8-sig')
        except UnicodeDecodeError:raise ValueError('文件不是 UTF-8 文本，未进行修改') from None
        result={'path':p.relative_to(self.root).as_posix(),'content':content,'version':hashlib.sha256(raw).hexdigest()}
        self.reads[result['path']]=result;return result
    def history(self,p,raw,action):
        key=uuid.uuid4().hex;folder=self.owner.history/key
        self.owner.atomic(folder/'content.txt',raw.decode('utf-8-sig'))
        self.owner.atomic(folder/'record.json',json.dumps({'root':str(self.root),'path':p.relative_to(self.root).as_posix(),'action':action,'time':time.time()},ensure_ascii=False))
        return key
    def execute(self,name,args):
        with self.owner.lock:
            if name=='list_project_files':return {'ok':True,**self.list(args.get('query',''))}
            if name=='read_project_file':return {'ok':True,**self.read(args['path'])}
            path=args['path'];p=self.path(path,True);rel=p.relative_to(self.root).as_posix()
            if name=='restore_project_file':
                key=args.get('history_id')
                if not isinstance(key,str) or not re.fullmatch('[a-f0-9]{32}',key):raise ValueError('恢复记录无效')
                folder=self.owner.history/key;record=json.loads((folder/'record.json').read_text('utf-8'))
                if record['root']!=str(self.root) or record['path']!=rel:raise ValueError('恢复记录不属于当前工程文件')
                if p.exists():raise ValueError('目标文件已存在，请先读取并对照历史，不覆盖当前文件')
                self.owner.atomic(p,(folder/'content.txt').read_text('utf-8'));version=hashlib.sha256(p.read_bytes()).hexdigest()
            elif name=='create_project_file':
                if p.exists():raise ValueError('同名文件已存在，请读取后编辑，不能覆盖新建')
                content=args.get('content');self.validate_content(content)
                p.parent.mkdir(parents=True,exist_ok=True)
                # Exclusive creation also protects against a concurrent external creator.
                with p.open('x',encoding='utf-8',newline='') as f:f.write(content)
                key=None;version=hashlib.sha256(p.read_bytes()).hexdigest()
            else:
                doc=self.reads.get(rel)
                if not doc or args.get('version')!=doc['version']:raise ValueError('必须先读取工程文件，并使用读取的版本进行修改')
                raw=p.read_bytes()
                if hashlib.sha256(raw).hexdigest()!=doc['version']:raise ValueError('工程文件已被外部修改，请重新读取')
                if name=='update_project_file':
                    content=args.get('content');self.validate_content(content);key=self.history(p,raw,name)
                    self.owner.atomic(p,content);version=hashlib.sha256(p.read_bytes()).hexdigest()
                elif name=='trash_project_file':
                    key=self.history(p,raw,name);p.unlink();version='deleted'
                else:raise ValueError('未知工程文件操作')
            self.reads.pop(rel,None)
            return {'ok':True,'action':name,'kind':'project','title':rel,'note_id':'project:'+rel,'version':version,'history_id':key,'recoverable':name=='trash_project_file'}
    @staticmethod
    def validate_content(content):
        if not isinstance(content,str) or len(content.encode('utf-8'))>500000:raise ValueError('内容必须为500KB以内的文本')
