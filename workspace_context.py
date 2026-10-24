"""A conversation home for research work without a selected PDF."""
from paper_library import PaperLibrary

class WorkspaceContext(PaperLibrary):
    def __init__(self,papers):
        self.papers=papers;self.root=papers.root.parent/'.assistant';self.root.mkdir(exist_ok=True)
        self.refs=papers.refs;self.lock=papers.lock;self.atomic=papers.atomic;self.render=papers.render;self.conflict=papers.conflict
    def item(self,pid):return {'id':'workspace','title':'科研工作区'} if pid=='workspace' else self.papers.item(pid)
    def folder(self,pid):return self.root if pid=='workspace' else self.papers.folder(pid)
    def pages(self,pid):return {'status':'notes-only','pages':[]}
