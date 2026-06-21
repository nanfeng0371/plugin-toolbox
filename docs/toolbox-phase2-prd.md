# Toolbox Phase2 模块化架构重构 PRD

> **状态**：已批准方案 → 待开发
> **版本**：v2.0.0
> **日期**：2026-03-25
> **语言**：纯 HTML + CSS + JS（无框架）
> **运行环境**：Chrome Extension Manifest V3

---

## 1. 原始需求复述

将现有的 report（辅导报告）和 dingtalk（钉钉数据提取）两个独立 Chrome 扩展嵌入 toolbox 壳扩展，实现统一入口管理。架构层面重构为模块化体系，壳扩展只做框架（注册、路由、加载、权限），所有业务逻辑归属各模块自管理。重构后新增模块（如第3个、第10个工具）时，只需放入目录并添加 `module.json`，无需改动壳代码。

---

## 2. 产品目标

| # | 目标 | 衡量标准 |
|---|------|----------|
| G1 | **统一入口，一键切换** | 辅导老师从 toolbox 一个入口访问所有工具，不再需要在扩展管理页搜索和启用独立扩展 |
| G2 | **零侵入扩展** | 新增一个工具模块只需：创建目录 → 放文件 → 添加 module.json → 完成。壳代码零改动 |
| G3 | **模块完全隔离** | 任意模块的 CSS/JS 故障不影响其他模块和壳的运行；模块间无全局变量污染 |

---

## 3. 用户故事

### US-1：打开工具箱使用报告功能
> 作为辅导老师，我点击浏览器工具栏的 Toolbox 图标，在侧边栏点击「辅导报告」Tab，页面自动加载报告工具，我可以选择学员、生成报告，而不需要单独安装或切换扩展。

### US-2：从钉钉页面提取数据
> 作为辅导老师，我在钉钉页面打开了 Toolbox 侧边栏，点击「钉钉数据」Tab，浮动面板自动出现在钉钉页面上，我可以一键提取表格数据并导出。

### US-3：同时使用多个工具
> 作为辅导老师，我在编写辅导报告时，需要切换到钉钉数据 Tab 查看学员信息，切换后报告 Tab 的状态保持不变，回来后可以继续之前的工作。

### US-4：新工具自动出现
> 作为产品维护者，我将新的工具模块文件夹放入扩展的 modules 目录，刷新扩展后，Toolbox 侧边栏自动出现新工具的 Tab，无需修改任何现有代码。

### US-5：模块故障不影响其他功能
> 作为辅导老师，如果某个工具模块加载失败，其他工具仍然可以正常使用，侧边栏会显示该模块"加载失败"的提示而不是整个工具箱崩溃。

---

## 4. 需求池

### P0 — 核心必须（MVP）

| ID | 需求 | 说明 |
|----|------|------|
| P0-01 | **module.json 模块自描述注册** | 每个模块目录含 `module.json`（name, label, version, entry, permissions, icon 等），壳启动时自动扫描 modules/ 目录完成注册 |
| P0-02 | **消息总线路由** | background.js 精简为约50行的路由中枢，模块通过 `chrome.runtime.onMessage` 自注册消息处理器，消息格式 `{ target: "moduleName", action: "...", data: ... }` |
| P0-03 | **Tab 按需加载** | 侧边栏点击 Tab 时才加载对应模块的 JS + CSS，未点击的 Tab 不加载任何资源 |
| P0-04 | **Shadow DOM CSS 隔离** | 每个模块的 UI 渲染在独立 Shadow DOM 容器中，彻底杜绝 CSS 命名冲突 |
| P0-05 | **Report 模块迁移** | 将现有 plugins/report/ 的全部功能（学员列表、报告生成、Excel导出、四维评价）迁移为 toolbox 的一个模块 |
| P0-06 | **Dingtalk 模块迁移** | 将现有 plugins/dingtalk/ 的全部功能（浮动面板、表格提取、智能去重、CSV下载）迁移为 toolbox 的一个模块 |
| P0-07 | **移除独立扩展** | report 和 dingtalk 不再作为独立 Chrome 扩展发布，仅作为 toolbox 的模块存在 |

### P1 — 重要应该有

| ID | 需求 | 说明 |
|----|------|------|
| P1-01 | **optional_permissions 按需申请** | 模块在 module.json 中声明权限，壳首次加载该模块时弹出权限申请；如 report 的 cookies/downloads 权限 |
| P1-02 | **模块状态保持** | 切换 Tab 时保留模块状态（表单数据、滚动位置等），不重新加载 |
| P1-03 | **模块加载错误处理** | 模块加载失败时显示友好提示（图标 + "加载失败" 文字），提供重试按钮 |
| P1-04 | **模块禁用/启用** | 用户可在 popup 设置页中启用或禁用单个模块（持久化到 chrome.storage） |
| P1-05 | **统一主题适配** | 壳提供基础 CSS 变量（主色调、字体、间距），各模块可选用；保留各模块原有主题色作为可选方案 |

### P2 — 锦上添花

| ID | 需求 | 说明 |
|----|------|------|
| P2-01 | **模块开发脚手架** | 提供 `create-module` 脚本，一键生成模块目录模板（含 module.json、入口文件、Shadow DOM 容器模板） |
| P2-02 | **模块版本检测** | 壳启动时检查模块 version 字段，版本不兼容时提示用户 |
| P2-03 | **模块间通信** | 提供受控的模块间消息通道（通过壳中转），支持 report 调用 dingtalk 的数据 |
| P2-04 | **打包脚本升级** | 考虑从纯 Node.js ZIP 打包迁移到 esbuild，支持模块代码分割和压缩 |

---

## 5. 技术方案概述

基于已确认的 5 个关键改进点：

### 5.1 模块自描述注册（module.json）

```
modules/
├── report/
│   ├── module.json        ← 模块描述文件
│   ├── background.js      ← 模块自身的 Service Worker 逻辑
│   ├── content.js         ← 模块 UI 渲染（注入 Shadow DOM）
│   ├── panel.css          ← 模块样式
│   └── analysis.js        ← 模块内部依赖
├── dingtalk/
│   ├── module.json
│   ├── content.js
│   └── style.css
└── _template/             ← 新模块模板（P2）
```

**module.json 示例**：
```json
{
  "name": "report",
  "label": "辅导报告",
  "version": "1.0.0",
  "icon": "report.svg",
  "permissions": ["cookies", "downloads"],
  "hostPermissions": ["https://ai-genesis.yuaiweiwu.com/*"],
  "entry": {
    "content": "content.js",
    "background": "background.js",
    "css": "panel.css"
  }
}
```

壳启动时（`chrome.runtime.onInstalled` / `chrome.runtime.onStartup`）扫描 `modules/*/module.json`，构建模块注册表存入 `chrome.storage.local`。

### 5.2 消息总线替代硬编码路由

**壳 background.js**（约50行）：
- 监听所有 `chrome.runtime.onMessage`
- 根据 `message.target` 路由到对应模块的处理器
- 模块通过 `chrome.runtime.sendMessage({ type: "REGISTER_HANDLER", module: "report", actions: [...] })` 自注册

**消息流**：
```
content(模块UI) → sendMessage → 壳background → 路由到模块background → 返回结果
```

### 5.3 按需加载（Lazy Load）

- 侧边栏初始化时只加载壳的 Tab 栏 UI
- 用户点击 Tab → 动态创建 `<link>` 注入模块 CSS → 动态执行模块 content.js
- 已加载的模块缓存状态，切换回来不重新加载

### 5.4 Shadow DOM CSS 隔离

```javascript
const shadowHost = document.createElement('div');
shadowHost.id = `module-${moduleName}`;
const shadowRoot = shadowHost.attachShadow({ mode: 'open' });
// 模块的所有 DOM 和 CSS 在 shadowRoot 内渲染
shadowRoot.innerHTML = `<style>${moduleCSS}</style><div class="module-container">...</div>`;
```

### 5.5 optional_permissions 按需申请

```javascript
// 模块 module.json 声明 permissions
// 壳在首次激活该模块时：
const granted = await chrome.permissions.request({
  permissions: module.permissions,
  origins: module.hostPermissions
});
```

---

## 6. 技术约束

| 约束 | 说明 |
|------|------|
| Chrome MV3 | Service Worker（非 persistent）、不支持 DOM |
| 纯 HTML/CSS/JS | 不使用 React/Vue 等框架 |
| Shadow DOM | content script 中可用，MV3 兼容 |
| importScripts | MV3 Service Worker 中可用（SW 唤醒时重新加载） |
| optional_permissions | MV3 原生支持，用户可撤销 |
| 现有权限 | activeTab, storage, scripting + toolbox 现有 host_permissions |
| 用户体验 | 简单直接，不过度工程化 |

---

## 7. 待确认问题

| # | 问题 | 影响范围 | 建议 |
|---|------|----------|------|
| Q1 | 模块的 background.js 与壳的 background.js 如何共存？MV3 只允许一个 SW | P0-02 | 方案A：壳 SW 用 importScripts 动态加载模块 background 代码；方案B：模块 background 逻辑注册为函数，壳 SW 在启动时加载执行 |
| Q2 | Dingtalk 模块原来无 background.js，其 popup 选择去重模式的交互如何保留？ | P0-06 | 在 toolbox popup 中为 dingtalk 模块增加设置入口，或移到侧边栏模块内 |
| Q3 | Report 模块依赖 iframe 抓取（report_fetcher.js 的 all_frames），迁移后 all_frames 注入策略是否变化？ | P0-05 | 保持 content_scripts 的 all_frames 声明，壳 manifest 中预留 extension-specific 配置 |
| Q4 | 现有独立扩展的用户数据（chrome.storage 中已保存的配置）是否需要迁移？ | P1-02 | 首次迁移时提供一次性数据导入逻辑，存储键加模块前缀避免冲突 |
