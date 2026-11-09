# Light Reader

一个轻量的本地代码阅读器，专为 AI 辅助开发时代的代码浏览和理解而设计——打开快、可搜索、可跳转，不需要启动完整的 IDE。

## 当前功能

- 打开本地文件夹为只读 workspace
- 懒加载文件树，支持 `.gitignore`
- Tree-sitter 语法高亮：JavaScript / TypeScript / TSX / Python / Java
- 全文/正则搜索，流式返回结果
- 文件大纲与跳转到定义（MVP）
- SQLite 符号持久化，文件变更自动刷新索引
- 三栏布局：左侧文件/搜索，中间代码视图，右侧上下文面板

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri 2 |
| 后端 | Rust |
| 前端 | React 19 + TypeScript + Vite |
| 代码编辑器 | CodeMirror 6 |
| 语法解析 | Tree-sitter |
| 持久化 | SQLite (rusqlite) |
| 文件监听 | notify |

## 开发环境

```bash
# 安装依赖
npm install

# 启动开发模式
npm run tauri dev
```

### 生产构建

```bash
npm run tauri build
```

### 仅构建前端

```bash
npm run build
```

### Rust 后端测试

```bash
cd src-tauri
cargo test
```

## Windows 构建依赖

- Rust MSVC 工具链（`rustup` 默认安装）
- Visual Studio Build Tools（C++ 桌面开发工作负载）
- WebView2（Windows 11 内置，Windows 10 可从 Microsoft 下载）

## 架构概览

```
┌─────────────────────────────────────────────────┐
│                 Tauri 桌面应用                    │
├────────────┬────────────────────┬───────────────┤
│  React UI  │   Tauri IPC 层     │  Rust 后端     │
│  CodeMirror│  workspace_open   │  文件扫描       │
│  文件树     │  file_tree        │  Tree-sitter   │
│  搜索面板   │  search           │  符号提取       │
│  大纲面板   │  resolve_def      │  SQLite 存储   │
│            │  highlight        │  notify 监听   │
└────────────┴────────────────────┴───────────────┘
```

## 安全模型

- workspace 以只读方式打开，应用不修改用户项目
- 所有 IPC 路径经过校验，禁止越界访问
- 不执行仓库内的代码
- 不联网、不收集遥测
- 索引数据存储在用户数据目录，不写入 workspace

## 路线图

- [x] 文件树 + 语法高亮
- [x] 全局搜索
- [x] 跳转到定义
- [ ] 查找引用
- [ ] Git diff / blame 视图
- [ ] 调用链可视化
- [ ] 插件系统与可选 LSP
- [ ] AI 摘要（可选插件）

## 贡献

欢迎提交 PR！请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE-MIT) OR [Apache-2.0](LICENSE-APACHE)
