# Zotero AI Assistant · 2.0.21

在 Zotero 原窗口中阅读 PDF、写 Markdown 笔记、划词翻译、总结和向 AI 提问。支持星标置顶、独立报告、工程文件、对话归档与在线文献检索。

**空白基础框架：不含个人笔记、报告、PDF、文献目录、对话、API Key、登录凭据或 Python 运行环境。**

[图文使用说明](docs/使用说明.md) · [离线 HTML 说明书](docs/使用说明.html) · [验收记录与已知限制](docs/2.0验收记录.md)

## 安装

需要 **Windows、Python 3.12、Zotero 10.0.x**。原生接口在 Zotero 10.0.6 验证；独立桌面入口使用 Microsoft Edge。其他系统和 Zotero 大版本未验证。

```powershell
git clone https://github.com/CuSO4-5-H2O/Zotero_ai_assistant.git
cd Zotero_ai_assistant
py -3.12 tools/bootstrap.py
```

Zotero 的 storage 不在用户目录时，请指定实际位置，例如：

```powershell
py -3.12 tools/bootstrap.py --zotero-storage 'D:\Zotero\storage'
```

1. 运行 `.\.runtime\python\pythonw.exe launcher.py` 启动本地服务。
2. 在 Zotero「工具 → 插件 → 齿轮 → 从文件安装插件」安装本机生成的 `dist/research-notebook-2.0.21.xpi`。
3. 点击右下角 **科研仓库** 或按 **Ctrl + Alt + N**；PDF 中点 **科研精读**。
4. 在设置中配置自己的 AI 服务。未配置时仍可管理笔记和文件。

脚本下载固定版本依赖和 KaTeX、校验公式资源完整性，并生成匹配当前目录的本机插件。**单独复制 XPI 不能代替配套应用安装。** 移动目录后运行 `py -3.12 build_zotero_plugin.py --embed-root`，重新安装生成的包。

## 功能与数据

- 文献笔记、文献导读、报告独立保存。文献笔记自动保存；快速输入按回车追加，Shift + 回车换行。摘录默认追加到当前论文笔记，也可选已有或新建笔记。
- 在 Zotero 切换 PDF 时，浮窗中的文献和助手上下文跟随当前阅读器；切换前保存待处理修改，遇到版本冲突保留本地草稿。
- 划词自动翻译、可编辑译文、选词摘抄、总结；取消选区后关闭，编辑译文期间保留。
- 笔记和报告支持星标置顶；历史、冲突保护及可恢复删除。
- AI 助手支持模型和推理等级、PDF 问答、笔记和工程操作、文献标签、网页搜索、对话删除撤销和归档。
- Crossref 检索无需 Key；Elicit 需要自己的 API 权限与 Key。搜索后可自动获取 PDF 并入库；重复 DOI 优先复用，缺失原文如实显示。
- 普通导入默认加入左侧 storage 分类；PDF 由 Zotero 托管到其实际数据目录的 storage。

服务只监听 `127.0.0.1`。笔记在 `vault/`、报告在 `reports/`、配置与加密凭据在 `.runtime/`，工程目录可另选。导出仓库不含 Zotero 原 PDF、工程文件和密钥，迁移时分别备份。

## 更新与限制

通过上述 `git clone` 安装后，本地后台每次从停止状态启动时，会检查 GitHub 的 `main` 分支。确认本地受版本管理的源码没有改动、版本可快进且依赖没有变化后，自动更新源码并为本机重建插件；Zotero 的本地更新器随后检查、校验并安装新插件。运行中的后台不会被强制重启：如后台一直运行，更新要等它下次启动。

已有 2.0.19 或更早版本需先按常规方式更新源码并重新运行构建脚本一次，才能获得这套更新器。ZIP 方式安装、非 `main` 分支、本地改过源码、依赖发生变化或网络不可用时，自动更新会跳过；状态记录在 `.runtime/github-update-status.json`。依赖变化时请先更新源码、运行安装脚本，再重启本地后台。个人笔记、PDF、报告、工程文件和配置不在版本库中。当前 GitHub 不提供单独 XPI 的直接自动升级，以免插件与旧后台不匹配。

扫描 PDF 需要外部 OCR。Undermind 目前采用网页搜索后粘贴 DOI 导入，尚无插件内一键账号连接。Elicit 网页登录不等于本插件 API 权限。全文下载受出版社、机构权限和网络限制，不保证全部成功。ChatGPT 登录适配器为实验能力，Plus 订阅不等于通用 API 额度。

AI 调用会将相关选文、PDF 文字或工具读取内容发送给所选服务；联网搜索会发送查询词。回答和页码需要对照原文。

## 开发与验证

```powershell
.\.runtime\python\python.exe -m unittest discover -s tests -p '*tests.py' -v
.\.runtime\python\python.exe -m unittest discover -s tests -p 'test_*.py' -v
node tests/test_literature_native.cjs
```

测试使用隔离目录；凭据测试使用 Windows DPAPI。截图为独立示例仓库。版本见 `VERSION`，许可证：[MIT](LICENSE)。
