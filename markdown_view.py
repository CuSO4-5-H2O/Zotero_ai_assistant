"""CommonMark rendering shared by notebook, paper guide, and AI responses."""
import html
import re
from urllib.parse import unquote, urlsplit
from markdown_it import MarkdownIt
from mdit_py_plugins.footnote import footnote_plugin
from mdit_py_plugins.tasklists import tasklists_plugin
from mdit_py_plugins.dollarmath import dollarmath_plugin
from mdit_py_plugins.amsmath import amsmath_plugin
from mdit_py_plugins.texmath import texmath_plugin

CATALOG = {}


def render_markdown(text, mapping=None):
    mapping = mapping or {}
    md = MarkdownIt('commonmark', {'html': False, 'breaks': False}).enable(['table', 'strikethrough'])
    md.use(footnote_plugin).use(tasklists_plugin).use(dollarmath_plugin).use(texmath_plugin, delimiters='brackets').use(amsmath_plugin)
    # Keep LaTeX as text for local KaTeX; never parse formula contents as Markdown.
    md.renderer.rules['math_inline'] = lambda ts, i, *_: '<span class="math-inline">' + html.escape(ts[i].content) + '</span>'
    md.renderer.rules['math_block'] = lambda ts, i, *_: '<div class="math-display">' + html.escape(ts[i].content) + '</div>\n'
    md.renderer.rules['math_block_label'] = md.renderer.rules['math_block']
    md.renderer.rules['math_block_eqno'] = md.renderer.rules['math_block']
    md.renderer.rules['amsmath'] = md.renderer.rules['math_block']
    tokens = md.parse(text)
    byurl = {x['url'].rstrip('/').lower(): x['id'] for x in CATALOG.values()}
    anchors = {}
    for index, token in enumerate(tokens):
        if token.type == 'heading_open' and index+1<len(tokens):
            title=tokens[index+1].content
            slug=re.sub(r'[^\w\u4e00-\u9fff-]', '', title.strip().lower().replace(' ','-')) or 'section'
            count=anchors.get(slug,0);anchors[slug]=count+1
            token.attrSet('id',slug+(f'-{count}' if count else ''))
        if token.type != 'inline' or not token.children:
            continue
        children = []
        depth = 0
        for child in token.children:
            if child.type == 'link_open':
                depth += 1
                href = child.attrGet('href') or ''
                pid = byurl.get(href.rstrip('/').lower())
                parsed = urlsplit(href)
                local_paper = re.fullmatch(r'/paper/([A-D]\d{1,2}|Z\d+_[A-Z0-9]{8})',parsed.path)
                if local_paper and local_paper[1] in CATALOG and not parsed.scheme:
                    pid=local_paper[1]
                if pid:
                    child.attrSet('href', '/paper/' + pid)
                    child.attrSet('data-paper', pid)
                    child.attrSet('title', '在独立窗口精读 ' + pid)
                    child.attrSet('target', '_blank')
                elif unquote(parsed.path) in mapping:
                    child.attrSet('href', '#')
                    child.attrSet('data-open', mapping[unquote(parsed.path)])
                elif unquote(parsed.path) in {'文献证据矩阵.csv','检索方法与核验说明.md','超表面四方向调查报告.zip'}:
                    child.attrSet('href','/api/report-assets/'+parsed.path)
                    child.attrSet('target','_blank')
                elif parsed.scheme in {'http', 'https', 'mailto'}:
                    child.attrSet('target', '_blank')
                child.attrSet('rel', 'noopener noreferrer')
            elif child.type == 'link_close':
                depth = max(0, depth - 1)
            if child.type == 'text' and not depth:
                # Plain reference IDs in tables and headings are also clickable.
                parts = re.split(r'(?<![A-Za-z0-9_])([A-D]\d{1,2})(?![A-Za-z0-9_])', child.content)
                if len(parts) > 1:
                    from markdown_it.token import Token
                    for part in parts:
                        t = Token('html_inline' if part in CATALOG else 'text', '', 0)
                        t.content = (f'<a class="paper-cite" data-paper="{part}" href="/paper/{part}" target="_blank" rel="noopener" title="在独立窗口精读 {part}">{part}</a>' if part in CATALOG else part)
                        children.append(t)
                    continue
            children.append(child)
        token.children = children
    rendered = md.renderer.render(tokens, md.options, {})
    rendered = rendered.replace('<table>', '<div class="table-wrap"><table>').replace('</table>', '</table></div>')
    rendered = re.sub(r'【([^】\n]{1,30})】', r'<span class="evidence">\1</span>', rendered)
    # Fold only the report bibliography; user Markdown elsewhere keeps its full structure.
    rendered = re.sub(r'<h2[^>]*>完整文献[^<]*</h2>', '<details class="references"><summary>完整文献与证据范围</summary>', rendered, count=1)
    if '<details class="references">' in rendered:
        rendered += '</details>'
    return rendered
