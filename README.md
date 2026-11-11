# Light Reader

一个轻量的本地代码阅读器，专为 AI 辅助开发时代的代码浏览和理解而设计——打开快、可搜索、可跳转；需要小改动时也可以直接编辑保存，不需要启动完整的 IDE。

## 当前功能

- 本地工作区管理：打开文件夹、拖拽导入、常用目录、会话恢复
- 懒加载文件树，支持 `.gitignore`，隐藏/超大/二进制文件安全跳过
- 语法高亮：JavaScript / TypeScript / TSX / Python / Java
- 全文/正则搜索，流式返回结果
- 文件大纲、符号搜索、跳转到定义、引用查找
- 只读阅读优先，同时支持文件编辑、Ctrl+S 保存、查找替换
- 新建、重命名、删除文件，左侧树实时同步
- 文件标签页、书签、文件内搜索、代码缩放
- Git 最近提交对比：查看本次提交修改了哪些文件和具体 diff
- 明 / 暗主题，IDE 风格三栏布局，可拖拽调整侧栏宽度

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

![打开文件夹](docs/screenshot-open-folder.png)

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

- 自动查找该符号在项目中的定义位置
- 跳转到定义所在文件和行
- 右侧 Definitions 面板显示所有匹配的定义

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

## Git 对比

如果打开的文件夹是 Git 仓库，点击左侧面板右上角的 Git 图标：

1. 列出当前 `HEAD` 提交修改的文件
2. 点击任意文件查看与上一提交的差异
3. 新增行、删除行、hunk 位置分别高亮

## 支持的语言

| 语言 | 语法高亮 | 符号提取 | 跳转 |
|------|----------|----------|------|
| JavaScript / JSX | ✅ Tree-sitter | ✅ 函数/类/方法/常量/导入 | ✅ |
| TypeScript / TSX | ✅ Tree-sitter | ✅ 函数/类/方法/接口/类型/常量/导入 | ✅ |
| Python | ✅ Tree-sitter | ✅ 函数/类/赋值/导入 | ✅ |
| Java | ✅ Tree-sitter | ✅ 类/方法/接口/枚举/字段/导入 | ✅ |
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

## 架构概览

```
┌─────────────────────────────────────────────────────┐
│                  Tauri 桌面应用                       │
├─────────────┬─────────────────────┬─────────────────┤
│  React UI   │   Tauri IPC 层       │  Rust 后端       │
│  CodeMirror │  workspace_open     │  文件扫描         │
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

## 路线图

- [x] 文件树 + 语法高亮
- [x] 全局搜索
- [x] 跳转到定义
- [x] 查找引用
- [x] Git 最近提交 diff 视图
- [ ] 调用链可视化
- [ ] 插件系统与可选 LSP
- [ ] AI 摘要（可选插件）

## 贡献

欢迎提交 PR！请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE-MIT) OR [Apache-2.0](LICENSE-APACHE)
