# Zotero AI Assistant

面向 Zotero 的本地科研笔记与 AI 阅读助手。PDF 阅读器、笔记、划词翻译和工作区助手放在同一个 Zotero 窗口中。

**这是空白基础框架。** 不包含已有笔记、报告、论文 PDF、文献目录、聊天记录、API Key、登录令牌、个人配置或独立 Python 运行环境。首次运行时在本机创建空仓库；AI 功能需要使用者自行配置服务。

## 功能

- Zotero 主窗口固定仓库入口；在 PDF 标签页中也能打开。
- 可拖动、缩放并记住布局的浮窗；支持重置位置和尺寸。
- Markdown 笔记、公式预览、搜索、分类、标签、历史版本和回收站恢复。
- 选中 PDF 文字后自动翻译；译文可编辑、复制或保存；支持总结选文。取消选区后自动关闭，编辑译文时保留窗口。
- PDF 文字层问答、流式回答、连续追问、按论文隔离对话和页码引用。
- 可选 AI 工具：新建、编辑、追加、删除与恢复笔记；管理 Zotero 文献标签；读写选定工程目录中的文本、代码和数据文件。
- 可自行配置 DeepSeek；包含实验性的 ChatGPT 登录适配器，可用性取决于账号授权和服务支持。

## 环境

当前面向 **Windows、Python 3.12、Zotero 10.0.x**；原生接口在 Zotero 10.0.6 上核对。其他系统和 Zotero 大版本尚未验证。独立桌面窗口使用 Microsoft Edge。

## 安装

1. 克隆源码：

   ```powershell
   git clone https://github.com/CuSO4-5-H2O/Zotero_ai_assistant.git
   cd Zotero_ai_assistant
   ```

2. 创建本机运行环境、下载公式字体、构建插件：

   ```powershell
   py -3.12 tools/bootstrap.py
   ```

   如果 Zotero 的 `storage` 不在用户目录的 `Zotero/storage` 下，显式指定：

   ```powershell
   py -3.12 tools/bootstrap.py --zotero-storage 'D:\Zotero\storage'
   ```

   安装脚本会下载 `requirements.txt` 中的依赖及固定版本的 KaTeX。依赖、字体和本机配置存放在忽略目录中，不写入 Git 历史。

3. 启动本地应用：

   ```powershell
   .\.runtime\python\pythonw.exe launcher.py
   ```

4. 在 Zotero 的 **工具 → 插件 → 齿轮 → 从文件安装插件** 中安装 `dist/research-notebook-1.6.6.xpi`。插件需要配套的本地 Python 服务，不能只复制 XPI 到另一台电脑使用。

5. 点击 Zotero 右下角的 **科研仓库**，或使用 `Ctrl+Alt+N`。在 PDF 中点击 **科研精读** 关联当前论文。

安装脚本构建的本机 XPI 会记录当前源码目录。移动目录后，请重新构建并安装：

```powershell
py -3.12 build_zotero_plugin.py --embed-root
```

也可以在 Zotero 高级配置编辑器中设置 `extensions.researchnotebook.root` 为源码目录的绝对路径。该设置优先于构建时记录的目录。

## AI 设置与数据

在仓库中的 **设置 → AI 与工程设置** 配置自己的服务；助手与翻译可以分别选择服务。未配置服务时仍可管理本地笔记。首次 ChatGPT 登录需要本人在官方页面完成登录与授权，不会读取其他应用的登录文件。

- `vault/`：笔记、关联文献目录、文字提取结果、历史与对话。
- `projects/`：默认工程目录，可在设置中改为另一个明确的工程目录。
- `.runtime/`：本机运行环境、服务状态、缓存、配置及 Windows DPAPI 加密凭据。
- `dist/`：本机生成的插件和本地更新描述。

以上目录均默认排除在 Git 之外。不要把自己的运行目录、导出仓库或配置文件提交到公开仓库。

AI 请求会将本次需要的选文、PDF 文字或笔记/工程文件内容发送给使用者选择的模型服务。只有划词翻译会发送当前选文；PDF 问答会发送当前 PDF 文字层及必要对话上下文。代码与文档中的接口地址不是 API Key，本项目不提供任何共享账号或额度。

## 操作范围与局限

- 后端只监听 `127.0.0.1`，本地请求使用会话校验。
- 通过 Zotero 原生接口读取附件路径、管理条目标签和子笔记；不直接修改 `zotero.sqlite`。
- 工程工具只读写用户所选目录中的允许文本格式；编辑检查版本并保留历史，删除可恢复，不执行系统命令，不直接修改二进制仿真工程。
- PDF 问答当前处理文字层，扫描件不提供 OCR；图表图像与复杂公式需核对原文。AI 页码和结论也需要人工核验。
- 本地更新器只检查当前安装目录中自行生成的 `dist/latest.json`。保留域名 `research-notebook.invalid` 不提供互联网更新服务。
- 导出仓库可能包含笔记、关联信息和本地导入的 PDF，分享前请检查内容和文献版权。

## 代码结构

| 目录或模块 | 作用 |
| --- | --- |
| `zotero-plugin/` | Zotero 入口、浮窗、划词界面、本地更新 |
| `web/` | 笔记编辑器、阅读页面、助手界面和设置 |
| `server.py` | 本地 HTTP 服务、笔记仓库与鉴权 |
| `paper_library.py`, `zotero_source.py` | 关联 PDF、文字提取和文献元数据 |
| `paper_chat.py`, `research_tools.py` | 对话与受限工作区工具 |
| `deepseek_client.py`, `chatgpt_client.py`, `ai_service.py` | 可配置模型适配层 |
| `project_files.py` | 工程文本文件、版本检查和恢复 |
| `tools/bootstrap.py` | 本机初始化与依赖资源下载 |

## 开发检查

```powershell
py -3.12 -m compileall -q .
node --check web/dock.js
node --check zotero-plugin/notebook.js
py -3.12 build_zotero_plugin.py
```

CI 检查 Python/JavaScript 语法、固定版本的 KaTeX 下载完整性与 XPI 构建；不等同于 Zotero 原生界面验收。提交前检查 `git diff --cached`，避免将运行数据混入源码。

## 许可证

框架源码使用 [MIT License](LICENSE)。第三方组件分别遵循其许可证，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。


### 对话管理与输出规范

- 每条消息右上角“删除本轮”会删除对应的一问一答；“清空对话”需再次点击确认，作用于当前论文或工作区。可通过“撤销删除”恢复，删除的内容不再进入 AI 上下文；本机保留恢复快照。
- 默认规范在每轮请求中生效，适用于所有已配置模型：中文简洁回答、区分文献与推断、引用 PDF 页码、以工具回执为准。规范位于 `assistant_rules.py`，修改后重启本地服务生效。
- 公式优先使用 `$...$` 和独立成行的 `$$...$$`；支持分式、矩阵与 aligned 多行推导，并兼容 `\(...\)`、`\[...\]`。回答生成中提供公式预览，结束后统一排版。模型输出的 LaTeX 仍须符合 KaTeX 语法。

### 在助手中切换模型与推理等级

进入“AI 助手”，在顶部直接选择模型和推理等级，选择后自动保存，下一次提问生效。模型和可用等级从已登录或已配置服务的模型目录读取；换模型会自动重置不兼容的等级。点击 ↻ 可刷新目录。当前正在生成的回答继续使用发起时的设置。划词翻译单独配置，保留快速模式。

ChatGPT 通过 Responses 的 `reasoning.effort` 设置，DeepSeek 通过 `thinking` 与 `reasoning_effort` 设置；推理正文不展示为回答。接口说明：[OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning)、[DeepSeek thinking](https://api-docs.deepseek.com/guides/thinking_mode/)。
