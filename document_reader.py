"""Local PDF / EPUB text, chapter boundaries and source locations."""
import posixpath,re,zipfile
from html.parser import HTMLParser
from urllib.parse import unquote,urldefrag
from xml.etree import ElementTree as ET
from pypdf import PdfReader

class PlainHTML(HTMLParser):
    def __init__(self):super().__init__(convert_charrefs=True);self.parts=[];self.skip=0;self.heading=False;self.head=[];self.title='';self.anchors={}
    def handle_starttag(self,tag,attrs):
        attributes=dict(attrs)
        if attributes.get('id'):self.anchors[attributes['id']]=len(self.parts)
        if tag in {'script','style'}:self.skip+=1
        if tag in {'p','div','br','li','section','h1','h2','h3'}:self.parts.append('\n')
        if tag in {'h1','h2'} and not self.title:self.heading=True
    def handle_endtag(self,tag):
        if tag in {'script','style'}:self.skip=max(0,self.skip-1)
        if tag in {'h1','h2'} and self.heading:self.title=''.join(self.head).strip();self.heading=False
        if tag in {'p','div','li','section','h1','h2','h3'}:self.parts.append('\n')
    def handle_data(self,data):
        if not self.skip:
            self.parts.append(data)
            if self.heading:self.head.append(data)
    def text(self):return re.sub(r'\n\s*\n+', '\n\n',''.join(self.parts)).strip()

def _safe_member(base,href):
    path,fragment=urldefrag(unquote(href));path=posixpath.normpath(posixpath.join(base,path))
    if path.startswith(('../','/')) or ':' in path:raise ValueError('电子书章节路径无效')
    return path,fragment

def read_epub(path):
    with zipfile.ZipFile(path) as z:
        if len(z.infolist())>15000 or sum(i.file_size for i in z.infolist())>300_000_000:raise ValueError('电子书解压内容过大')
        container=ET.fromstring(z.read('META-INF/container.xml'))
        package=next(x.attrib['full-path'] for x in container.iter() if x.tag.endswith('rootfile'))
        package,_=_safe_member('',package);base=posixpath.dirname(package);opf=ET.fromstring(z.read(package))
        manifest={x.attrib['id']:x.attrib for x in opf.iter() if x.tag.endswith('}item')}
        titles={};nav=next((v for v in manifest.values() if 'nav' in v.get('properties','').split()),None)
        if nav:
            navpath,_=_safe_member(base,nav['href'])
            try:
                for a in ET.fromstring(z.read(navpath)).iter():
                    if a.tag.endswith('}a') and a.get('href'):
                        member,fragment=_safe_member(posixpath.dirname(navpath),a.get('href'))
                        titles.setdefault(member,[]).append((''.join(a.itertext()).strip(),fragment))
            except ET.ParseError:pass
        if not titles:
            ncx=next((v for v in manifest.values() if v.get('media-type')=='application/x-dtbncx+xml'),None)
            if ncx:
                ncxpath,_=_safe_member(base,ncx['href'])
                for point in ET.fromstring(z.read(ncxpath)).iter():
                    if not point.tag.endswith('}navPoint'):continue
                    content=next((c for c in point if c.tag.endswith('}content')),None)
                    label=next((c for c in point if c.tag.endswith('}navLabel')),None)
                    if content is not None and content.get('src'):
                        member,fragment=_safe_member(posixpath.dirname(ncxpath),content.get('src'))
                        titles.setdefault(member,[]).append((''.join(label.itertext()).strip() if label is not None else '',fragment))
        pages=[];chapters=[]
        for item in opf.iter():
            if not item.tag.endswith('}itemref') or item.get('linear')=='no':continue
            entry=manifest.get(item.get('idref'),{});href=entry.get('href','')
            if not href or entry.get('media-type') not in {'application/xhtml+xml','text/html'}:continue
            member,_=_safe_member(base,href);parser=PlainHTML();parser.feed(z.read(member).decode('utf-8','replace'));text=parser.text()
            if not text:continue
            nav_entries=titles.get(member,[]);cuts=[];seen=set()
            for title,fragment in nav_entries:
                offset=parser.anchors.get(fragment) if fragment else 0
                if offset is not None and offset not in seen:cuts.append((offset,title,fragment));seen.add(offset)
            if not cuts:cuts=[(0,parser.title or f'第 {len(pages)+1} 节','')]
            cuts.sort(key=lambda c:c[0])
            if cuts[0][0]>0 and ''.join(parser.parts[:cuts[0][0]]).strip():cuts.insert(0,(0,'章前引言',''))
            for index,(offset,title,fragment) in enumerate(cuts):
                end=cuts[index+1][0] if index+1<len(cuts) else len(parser.parts)
                part=re.sub(r'\n\s*\n+','\n\n',''.join(parser.parts[offset:end])).strip()
                if not part:continue
                # Zotero's EPUB reader resolves hrefs from the OPF directory.
                location={'href':posixpath.relpath(member,base)+(('#'+fragment) if fragment else '')}
                number=len(pages)+1;pages.append({'number':number,'text':part,'title':title,'location':location})
                chapters.append({'id':f'c{number}','title':title,'start':number,'end':number,'level':1,'location':location,'source':'epub-spine'})
        if not pages:raise ValueError('电子书没有可读取的正文；请检查是否为加密版本')
        return {'format':'epub','pages':pages,'chapters':chapters}

def read_pdf(path):
    with open(path,'rb') as stream:
        return _read_pdf(PdfReader(stream))


def _read_pdf(reader):
    if reader.is_encrypted and not reader.decrypt(''):raise ValueError('PDF 受密码保护，请先解密')
    pages=[{'number':i+1,'text':(p.extract_text() or '').encode('utf-8',errors='replace').decode()} for i,p in enumerate(reader.pages)]
    chapters=[]
    def walk(nodes,level=1):
        for node in nodes:
            if isinstance(node,list):walk(node,level+1);continue
            try:
                page=reader.get_destination_page_number(node)+1;title=str(node.title).strip()
                if title and 1<=page<=len(pages):chapters.append({'title':title,'start':page,'level':level,'source':'pdf-bookmark'})
            except (TypeError,ValueError,AttributeError):continue
    try:walk(reader.outline)
    except Exception:pass
    if not chapters:
        pattern=re.compile(r'^(?:第[一二三四五六七八九十百零〇\d]+[章节篇部编卷回]|(?:chapter|part)\s+[\divx]+\b|\d{1,2}[.、]\s*\S|introduction$|conclusion[s]?$|导论$|绪论$|结论$|序言$|前言$|后记$|引论$|附录)',re.I)
        for page in pages:
            for line in page['text'].splitlines()[:16]:
                line=line.strip()
                if len(line)<=110 and pattern.search(line):chapters.append({'title':line,'start':page['number'],'level':1,'source':'heading'});break
    if not chapters:
        chapters=[{'title':f'第 {i}—{min(i+11,len(pages))} 页','start':i,'level':1,'source':'page-range'} for i in range(1,len(pages)+1,12)]
    chapters.sort(key=lambda c:c['start'])
    if chapters and chapters[0]['start']>1:chapters.insert(0,{'title':'卷首与导言','start':1,'level':1,'source':'page-range'})
    for i,c in enumerate(chapters):
        next_start=next((v['start'] for v in chapters[i+1:] if v['level']<=c['level'] and v['start']>c['start']),len(pages)+1)
        c.update(id=f'c{i+1}',end=next_start-1,location={'pageIndex':c['start']-1})
    return {'format':'pdf','pages':pages,'chapters':chapters}

def read_document(path):
    return read_epub(path) if path.suffix.lower()=='.epub' else read_pdf(path)
