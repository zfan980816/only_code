# Light Reader

一个轻量的本地代码阅读器，专为 AI 辅助开发时代的代码浏览和理解而设计——打开快、可搜索、可跳转；需要小改动时也可以直接编辑保存，不需要启动完整的 IDE。

## 当前功能

- 本地工作区管理：打开文件夹、拖拽导入、常用目录、会话恢复
- 懒加载文件树，支持 `.gitignore`，隐藏/超大/二进制文件安全跳过
- 多编码自动识别：UTF-8 / UTF-16 BOM / GBK·GB2312·GB18030（中文存量项目注释不再乱码）
- 语法高亮：JavaScript / TypeScript / TSX / Python / Java 完整解析，Rust / Go / C / C++ / C# / PHP / Ruby / Kotlin / Swift / Lua / SQL / Shell / JSON / YAML / TOML / CSS / HTML / XML / Vue / Svelte / Markdown 关键词高亮
- 全文/正则搜索，流式返回结果
- IDE 风格分组大纲（Imports / Classes / Functions / Constants / Types）、符号搜索、跳转到定义、引用查找
- **LSP 精确跳转（可选）**：自动检测 rust-analyzer / pyright / gopls / clangd 等语言服务器，跳转和引用查找达到 IDE 级精度，未安装时自动回退内置解析
- 只读阅读优先，同时支持文件编辑、Ctrl+S 保存、查找替换
- 新建、重命名、删除文件，左侧树实时同步
- 文件标签页、文件内搜索、代码缩放、固定行号与当前行高亮
- 点击标识符，当前文件内所有相同引用自动高亮，状态栏显示匹配数，`F3` / `Shift+F3` 在匹配之间跳转
- 块注释（`/* */`、JSDoc）与行注释统一着色
- 浏览历史 Back / Forward，支持跳转后回退和前进
- Git History：提交图、搜索/Hash 查找、分支/作者/日期/路径过滤、提交详情、变更文件分组和逐文件 diff
- **Review 模式**：GitHub 风格差异视图——行内红绿高亮、词级修改标记、语法着色、hunk 间导航（Alt+↑/↓）、一键打开文件；侧栏角标显示未提交文件数，一键进入 review
- Git 未提交修改：Working Tree vs HEAD 的文件列表和 diff；文件树内直接显示修改/新增角标
- 明 / 暗主题，IDE 风格三栏布局，可拖拽调整侧栏宽度
- 本地设置：界面语言、主题、代码字号/字体/行距、行号、当前行高亮、会话恢复、删除确认

## 快速开始

### 方式一：从源码运行（开发者）

#### 前置依赖

| 依赖 | 最低版本 | 说明 |
|------|----------|------|
| Node.js | v18+ | 前端构建 |
| Rust | stable | 后端编译 |
| Visual Studio Build Tools | 2022 | Windows 下 C++ 编译（勾选"桌面 C++ 开发"） |
| WebView2 | 最新 | Windows 11 内置，Windows 10 需安装 |

#### 步骤

```bash
# 1. 克隆项目
git clone https://github.com/zfan980816/only_code.git
cd only_code

# 2. 安装前端依赖
npm install

# 3. 启动桌面应用（开发模式）
npm run tauri dev
```

首次启动会自动编译 Rust 后端，需要几分钟。窗口弹出后即可使用。

### 方式二：仅构建前端（浏览器预览）

如果只想看 UI 效果，不启动桌面端：

```bash
npm install
npm run dev
```

打开浏览器访问 `http://localhost:5173`。浏览器模式下无法打开本地文件夹（需要 Tauri 后端）。

### 方式三：打包安装程序

```bash
npm run tauri build
```

打包完成后，安装包位于 `src-tauri/target/release/bundle/` 目录下。

## 使用指南

### 1. 打开代码文件夹

启动应用后，点击左侧 **打开文件夹** 按钮，或把文件夹拖入窗口。也可以在左侧活动栏点击 **文件 → 常用目录** 快速切换。

支持的仓库类型：
- Git 仓库（自动遵守 `.gitignore`）
- 普通文件夹（会跳过 `node_modules`、`.git` 等隐藏目录）

### 2. 浏览文件

左侧文件面板展示常用目录和文件树：

- 点击文件夹展开/折叠
- 点击文件名在中间打开代码视图
- 语法高亮自动识别 JS/TS/TSX/Python/Java
- 其他格式以纯文本显示
- 点击右上角 **编辑** 修改代码，`Ctrl+S` 保存
- 编辑模式下 `Ctrl+H` 打开查找/替换

### 3. 全局搜索

切换到左侧 **Search** 标签：

| 选项 | 说明 | 快捷键 |
|------|------|--------|
| 文本搜索 | 输入关键词，回车或自动触发 | 直接输入 |
| 正则搜索 | 勾选 `.*` | 在输入框写正则 |
| 大小写敏感 | 勾选 `Aa` | |
| 整词匹配 | 勾选 Word | |

搜索结果按文件分组展示，点击任意结果跳转到对应文件和行。

### 4. 跳转到定义

在代码视图中，**Ctrl + 点击**（macOS 上 **⌘ + 点击**）任意标识符：

- 优先使用 LSP 语言服务器精确解析（如已安装并启用）
- 回退到内置 Tree-sitter 符号索引
- 跳转到定义所在文件和行
- 多个匹配时弹出选择列表
- **Ctrl + Alt + 点击** 查找引用，同样优先 LSP

### 5. 查看文件大纲

打开文件后，右侧 **Outline** 面板自动显示当前文件的符号：

- 函数（function）
- 类（class）
- 方法（method）
- 接口（interface）
- 类型（type）
- 常量（constant）
- 导入（import）

点击大纲项快速跳转到对应位置。

### 6. 最近浏览

左侧底部 **Recent** 面板记录最近打开的 20 个文件，点击快速切换。

### 7. 键盘快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl + O` | 打开文件夹 |
| `Ctrl + P` | 快速打开文件 |
| `Ctrl + Shift + N` | 搜索符号 |
| `Ctrl + Shift + F` | 全局搜索 |
| `Ctrl + F` | 文件内搜索 |
| `Ctrl + H` | 编辑模式查找/替换 |
| `Ctrl + S` | 保存当前文件 |
| `Ctrl + 滚轮` | 代码字体缩放 |
| `Ctrl + 点击` | 跳转到定义 |
| `Ctrl + Alt + 点击` | 查找引用 |
| `F3` / `Shift + F3` | 下一个 / 上一个引用匹配 |
| `Alt + ←` | 浏览历史后退 |
| `Alt + →` | 浏览历史前进 |

## Git History

点击左侧面板右上角的 Git 图标，打开 Git 面板：

### 提交历史

- 左侧显示提交图、提交标题、作者、时间和分支标签
- 顶部支持 Text/Hash、Branch、User、Date、Paths 过滤
- 中间显示选中提交详情和单个文件 diff
- 右侧按目录分组显示本次提交的变更文件
- 支持“当前分支”和“所有分支”历史
- 中文/特殊字符路径、仓库子目录、根提交、合并提交都有兼容处理

### 未提交修改（Review AI 改动）

切换到 **未提交**（或点击左侧文件面板顶部的 Review 按钮）：

- 列出 Working Tree 中修改、新增、删除的文件，角标实时显示数量
- GitHub 风格差异视图：行级红绿背景 + 词级修改高亮 + 语法着色
- 多处修改时用 Alt+↑ / Alt+↓ 或 ▲▼ 按钮在 hunk 间跳转
- 一键"打开文件"跳到对应位置继续阅读

## LSP 语言服务器（可选）

在 **设置 → 精确跳转 (LSP)** 中开启后，跳转到定义和查找引用会优先使用 LSP 解析，精度等同 IDE。

| 语言 | 服务器 | 自动检测 |
|------|--------|----------|
| Rust | rust-analyzer | ✅ |
| Python | pyright-langserver | ✅ |
| Go | gopls | ✅ |
| C / C++ | clangd | ✅ |
| TypeScript / JavaScript | typescript-language-server | ✅ |
| Java | jdtls | ✅ |

- 服务器未安装时自动回退到内置解析，无需任何配置
- 想用其他服务器（如 pylsp、vscode-html-language-server）时，在设置中填入启动命令即可
- 语言服务器进程按工作区惰性启动，关闭窗口自动退出

## 支持的语言

| 语言 | 语法高亮 | 符号提取 | 跳转 |
|------|----------|----------|------|
| JavaScript / JSX | ✅ Tree-sitter | ✅ 函数/类/方法/常量/导入 | ✅ |
| TypeScript / TSX | ✅ Tree-sitter | ✅ 函数/类/方法/接口/类型/常量/导入 | ✅ |
| Python | ✅ Tree-sitter | ✅ 函数/类/赋值/导入 | ✅ |
| Java | ✅ Tree-sitter | ✅ 类/方法/接口/枚举/字段/导入 | ✅ |
| Rust / Go / C / C++ / C# / PHP | ✅ 关键词 | ❌ | ❌ |
| Ruby / Kotlin / Swift / Lua / SQL / Shell | ✅ 关键词 | ❌ | ❌ |
| JSON / YAML / TOML / CSS / Markdown | ✅ 关键词 | ❌ | ❌ |
| HTML / XML / Vue / Svelte | ✅ 标签 | ❌ | ❌ |
| 其他格式 | 纯文本 | ❌ | ❌ |

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri 2 |
| 后端 | Rust |
| 前端 | React 19 + TypeScript + Vite |
| 代码视图 | React 虚拟滚动编辑/阅读视图 |
| 语法解析 | Tree-sitter |
| 持久化 | SQLite (rusqlite) |
| 文件监听 | notify |
| 精确跳转 | LSP 客户端（stdio JSON-RPC，可选） |

## 架构概览

```
┌─────────────────────────────────────────────────────┐
│                  Tauri 桌面应用                       │
├─────────────┬─────────────────────┬─────────────────┤
│  React UI   │   Tauri IPC 层       │  Rust 后端       │
│  代码视图    │  workspace_open     │  文件扫描         │
│  文件树      │  file_tree          │  Tree-sitter     │
│  搜索面板    │  search             │  符号提取         │
│  大纲面板    │  resolve_def        │  SQLite 存储     │
│             │  highlight          │  notify 监听     │
└─────────────┴─────────────────────┴─────────────────┘
```

## 安全模型

- 阅读器默认只读；只有用户主动编辑并保存时才写文件
- 所有 IPC 路径经过校验，禁止越界访问
- 不执行仓库内的代码
- 不联网、不收集遥测
- 索引数据存储在用户数据目录，不写入 workspace

## 常见问题

### Q: 启动时报错 "error: linker not found"

Windows 下缺少 Visual Studio Build Tools。安装 [VS Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)，勾选"使用 C++ 的桌面开发"。

### Q: 搜索没有结果

确认勾选了正确的搜索选项。默认大小写不敏感。如果开启了正则模式，检查正则表达式语法。

### Q: 跳转到定义没有反应

跳转功能依赖 Tree-sitter 符号提取，仅支持 JS/TS/Python/Java。其他语言暂时不支持。

### Q: 大文件显示"truncated"

超过 2MB 的文件会截断显示，只展示前 2MB 内容以保护性能。

### Q: 打开老项目中文注释显示乱码？

Light Reader 会自动识别 UTF-8 / UTF-16 / GBK 系编码（按 BOM 与内容探测）。无法识别时以 UTF-8 有损方式展示。编辑保存统一写为 UTF-8。

## 路线图

- [x] 文件树 + 语法高亮
- [x] 全局搜索
- [x] 跳转到定义
- [x] 查找引用
- [x] 点击标识符全文引用高亮与 F3 导航
- [x] Git 提交历史与 GitHub 风格 Review diff 视图
- [x] 浏览历史前进 / 后退
- [x] 更多语言高亮（Rust / Go / C/C++ / JSON / CSS / HTML 等）
- [x] 文件树 Git 状态标记（修改/新增角标，目录包含变更时显示圆点）
- [x] 可选 LSP 精确跳转（rust-analyzer / clangd / gopls / pyright 自动检测）
- [ ] 插件系统

## 贡献

欢迎提交 PR！请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE-MIT) OR [Apache-2.0](LICENSE-APACHE)
