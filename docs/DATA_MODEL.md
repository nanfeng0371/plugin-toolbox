# 浏览器插件管理 — 数据模型

## 一、扩展版本管理

### 1.1 manifest.json (plugins/toolbox/)

```json
{
  "manifest_version": 3,
  "name": "插件工作箱",
  "version": "2.2.50",
  "update_url": "https://.../update.xml"
}
```

`version` 字段由 `node build.js` 自动递增（patch: 2.2.X → 2.2.X+1）。

### 1.2 versions.json

记录所有历史版本：

```json
[
  {
    "version": "2.2.50",
    "publishedAt": "2026-06-19T...",
    "crx": "toolbox-v2.2.25.crx",
    "zip": "toolbox-latest.zip",
    "sha256": "..."
  }
]
```

---

## 二、模块配置

### 2.1 module.json

每个子模块目录下的声明文件：

```json
{
  "id": "report",
  "name": "学习报告分析",
  "tabLabel": "📊 报告",
  "order": 1,
  "files": {
    "content": "modules/report/content.js",
    "background": "modules/report/background.js"
  }
}
```

| 字段 | 说明 |
|------|------|
| `id` | 模块标识（全局唯一） |
| `name` | 显示名称 |
| `tabLabel` | 侧边栏 Tab 标签（含 emoji） |
| `order` | Tab 排序权重（越小越靠前） |
| `files.content` | content script 相对路径 |
| `files.background` | service worker 相对路径 |

### 2.2 已注册模块

| ID | 名称 | order |
|----|------|-------|
| `report` | 学习报告分析 | 1 |
| `dingtalk` | 页面表格提取 | 2 |
| `tiaoke` | 调课助手 | 3 |
| `dailyboard` | 每日工作看板 | 4 |
| `heatmap` | 课程排期热力图 | 5 |
| `updater` | 检查更新 | 6 |

---

## 三、Native Host 数据流

### 3.1 更新检查流程

```
content.js                    background.js               toolbox-updater.exe        CloudBase
    │                              │                              │                      │
    ├─ CHECK_UPDATE ───────────────►                              │                      │
    │                              ├─ connectNative ─────────────►                      │
    │                              │                              ├─ ping ──────────────►│
    │                              │                              │◄─ pong ──────────────│
    │                              │                              ├─ check ─────────────►│
    │                              │                              │◄─ version/dnldUrl ───│
    │                              │◄─ 版本比较 ──────────────────│                      │
    │◄─ {hasUpdate, downloadUrl} ──│                              │                      │
```

### 3.2 更新安装流程

```
content.js                    background.js               toolbox-updater.exe        CloudBase
    │                              │                              │                      │
    ├─ INSTALL_UPDATE ─────────────►                              │                      │
    │                              ├─ connectNative ─────────────►                      │
    │                              │                              ├─ download ZIP ──────►│
    │                              │                              │◄─ ZIP binary ────────│
    │                              │                              ├─ 读取 config.json    │
    │                              │                              ├─ 解压到 toolbox_dir  │
    │                              │                              │  (覆盖 manifest 等)  │
    │                              │◄─ {success, action} ────────│                      │
    │◄─ "安装成功" ────────────────│                              │                      │
```

---

## 四、文件清单（打包产物）

### 4.1 toolbox-latest.zip 结构

```
toolbox-latest.zip
├── install.bat                  # 首次安装脚本（GBK 编码）
├── README.txt                   # 安装说明
├── native-host/
│   ├── toolbox-updater.exe      # PyInstaller 打包（8.4MB）
│   └── com.toolbox.updater.json # NM 注册清单
└── toolbox/                     # Chrome 扩展源码
    ├── manifest.json            # MV3 清单
    ├── background.js            # 消息中继 + NM 代理
    ├── content.js               # 侧边栏 UI
    ├── popup.html / popup.js    # 弹出窗口
    ├── panel.css                # 样式
    ├── icons/                   # 图标（5 个）
    └── modules/                 # 6 个子模块
        ├── report/              # 学习报告（6 个文件）
        ├── dingtalk/            # 表格提取（3 个文件）
        ├── tiaoke/              # 调课助手（5 个文件）
        ├── dailyboard/          # 每日工作看板（4 个文件）
        ├── heatmap/             # 课程排期热力图（3 个文件）
        └── updater/             # 更新助手（4 个文件）
```

### 4.2 CloudBase 云端文件

| 路径 | 说明 | 更新策略 |
|------|------|---------|
| `extensions/toolbox/update.json` | Native Host 用版本信息 | 每次 build 覆盖 |
| `extensions/toolbox/update.xml` | Chrome 用自动更新 | 每次 build 覆盖 |
| `extensions/toolbox/toolbox-latest.zip` | 安装包 | 每次 build 覆盖 |
| `extensions/toolbox/toolbox-v*.crx` | 历史 .crx 包 | 追加 |
| `extensions/toolbox/toolbox-v*-quark.zip` | 夸克浏览器版 | 追加 |
