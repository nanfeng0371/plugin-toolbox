# 每日看板 — 文件架构全景

> 版本：**v1.1**（左右分栏UI + 150天数据保留）
> 日期：2026-06-13
> 基于：架构设计 v2.1 + PRD v1.2 + EduFlow 实际目录结构

---

## 一、总览：三端对应关系

```
┌──────────────────────────┐   ┌───────────────────────┐   ┌───────────────────────┐
│  插件侧（本地）            │   │  CloudBase NoSQL（云）  │   │  EduFlow 管理看板（云）  │
│  D:\Claw\浏览器插件管理\   │   │  renewal-calendar-     │   │  D:\Claw\EduFlow\      │
│  plugins/toolbox/         │   │  7ff2rtj4f876144       │   │  assets/               │
│                           │   │                       │   │                         │
│  modules/dailyboard/      │   │  teacher_daily_tasks   │   │  js/pages/daily-board.js│
│  ├ content.js  ──fetch──→ │   │  ←──background.js 写入 │   │  ←──CloudBase SDK 直读  │
│  ├ background.js ──SDK───→│   │                       │   │                         │
│  ├ content.css            │   │                       │   │                         │
│  └ module.json            │   │                       │   │                         │
└──────────────────────────┘   └───────────────────────┘   └───────────────────────┘
```

| 端 | 角色 | 操作 |
|----|------|------|
| 插件 content.js | 数据采集 + UI | **直接 fetch 爱芯 API** → 分类 → 渲染 → 通知 background |
| 插件 background.js | 云端同步 | 接收 content 消息 → **CloudBase SDK 写入/读取** |
| CloudBase NoSQL | 数据中心 | 存 teacher_daily_tasks → 供 EduFlow 读取 |
| EduFlow 页面 | 管理展示 | **CloudBase SDK 直读** → 团队汇总 + 详情 |

---

## 二、本地文件架构（插件侧）

### 2.1 目录树

```
D:\Claw\浏览器插件管理\
└── plugins/
    └── toolbox/                          ← 🔧 插件工作箱（壳）
        ├── manifest.json                 ← [需修改] 新增4个 web_accessible_resources
        ├── background.js                 ← [需修改] KNOWN_MODULES + KNOWN_MODULE_BG_MAP
        ├── content.js                    ← [需修改] knownModules + ICON_MAP
        │
        └── modules/
            └── dailyboard/               ← 🆕 新增整个目录
                ├── module.json           # 模块元数据声明
                ├── content.js            # ★ 主逻辑：API调用 + 分类引擎 + UI渲染 + 打勾
                ├── content.css           # Shadow DOM 内样式（.db- 前缀）
                ├── background.js         # CloudBase 同步 + 消息中继
                └── lib/                  # （后备）如果 CSP 拦截 CDN
                    └── cloudbase.full.js # CloudBase JS SDK 本地副本
```

### 2.2 每个文件的职责与核心内容

#### `module.json` — 模块声明

```json
{
  "id": "dailyboard",
  "name": "每日看板",
  "version": "1.0.0",
  "description": "辅导老师每日工作看板：7类学生分类、打勾、云端同步",
  "icon": "📋",
  "hasBackground": true,
  "hasContent": true
}
```

**壳如何加载它**：background.js 在 `__registerModuleHandlers()` 时，遍历 `KNOWN_MODULES`，发现 `dailyboard` → 动态 `importScripts('modules/dailyboard/background.js')`。

---

#### `content.js` — ★ 核心文件（最大的文件，预估 ~800 行）

这是整个系统的心脏。按逻辑分 6 个区块：

```
content.js 内部结构
│
├── [区块1] 初始化 (~50行)
│   ├── 创建 Shadow DOM
│   ├── 注入 content.css
│   └── 检测当前页面是否为爱芯域名
│
├── [区块2] API 调用层 (~80行)
│   ├── workApi(url, options)              # 统一 fetch 封装（credentials: 'include'）
│   ├── fetchTeacherInfo()                 # getLoginParam → bizInfo → {name, jobNumber}
│   └── fetchTodaySchedule(date)           # next/class/list → ScheduleItem[]
│       └── 字段映射：API字段 → 内部字段（§3.1 of 架构文档）
│
├── [区块3] 学情表管理 (~60行)
│   ├── showStudentBinder()                # 显示 textarea 输入区
│   ├── parseStudentInfo(text)             # Tab 分隔解析 → StudentInfo[]
│   ├── validateStudentInfo(list)          # 校验：首列纯数字 + 至少3列
│   └── saveStudentInfo(list)              # chrome.storage.local 存取
│
├── [区块4] 7类分类引擎 (~150行)
│   ├── classifyStudents(schedule, info, prev)  # ★ 主分类函数（含30分钟延迟）
│   ├── groupByCategory(classified)              # 按 category 分组
│   └── calcSummary(classified)                  # 统计计算
│
├── [区块5] UI 渲染 (~350行) ← v1.1 增加（左右分栏）
│   ├── createRightPanel()                # 创建右侧面板 DOM → 注入 body
│   ├── setupDividerDrag()                # 分隔条拖拽交互
│   ├── openPanel() / closePanel()        # 打开/关闭动画
│   ├── renderHeader(teacher, date)        # A区：标题栏 + 信息栏 + 工具栏
│   ├── renderCategories(groups)           # B区：7个折叠面板
│   │   └── renderCategoryPanel(cat, students)  # 单个面板：标题 + 学生列表
│   │       └── renderStudentRow(student)       # 单行：checkbox + 姓名 + 标签
│   └── renderFooter(syncStatus)           # C区：同步状态栏
│
├── [区块6] 打勾交互 (~120行)
│   ├── onCheckboxClick(studentId, category)
│   │   ├── 第3类 → 弹窗确认"是否已重约？"
│   │   ├── 更新本地状态
│   │   ├── re-render（该行变色 + 下移）
│   │   └── sendMessage to background → 同步云端
│   └── onRefreshClick()                   # "刷新数据"按钮
│
└── [区块7] 消息处理 (~40行)
    ├── 监听 chrome.runtime.onMessage
    └── 处理来自 popup/background 的消息
```

**与壳的交互协议**：

```javascript
// content.js → background.js
chrome.runtime.sendMessage({
  target: 'dailyboard',
  action: 'SYNC_TO_CLOUD',
  data: { teacherName, date, students, summary }
});

// background.js → content.js（回复）
{ target: 'dailyboard-shell', action: 'SYNC_RESULT', data: { success, error } }
```

---

#### `background.js` — CloudBase 同步 + 消息中继（~200 行）

```
background.js 内部结构
│
├── [初始化] (~40行)
│   ├── importScripts 加载 cloudbase.full.js
│   │   ├── 优先：CDN 加载
│   │   └── 失败 → 回退：本地 lib/cloudbase.full.js
│   ├── cloudbase.init({ env: 'renewal-calendar-7ff2rtj4f876144' })
│   └── 匿名登录: app.auth().anonymousAuthProvider().signIn()
│
├── [数据库操作] DB 对象 (~120行)
│   ├── DB.getDoc(teacherName, date)           # where 查询
│   ├── DB.upsert(teacherName, date, students, summary)  # 全量写入
│   ├── DB.updateStudentStatus(...)             # 增量更新单学生
│   └── DB.getTodayAll()                        # EduFlow 查询用（备选）
│
├── [消息处理] (~40行)
│   ├── SYNC_TO_CLOUD      → DB.upsert()
│   ├── SYNC_ONE_STUDENT   → DB.updateStudentStatus()
│   └── GET_TODAY_DATA     → DB.getDoc()
│
└── [健康检查]
    └── 每次消息处理时检查 CloudBase 连接状态 → 自动重连
```

---

#### `content.css` — 样式文件（~400 行，v1.1 增加分栏样式）

```css
/* 所有样式以 .db- 为前缀，在 Shadow DOM 内隔离 */

/* ── 面板框架 ── */
.db-panel              /* 面板主体（#db-right-panel） */
.db-divider            /* 分隔条容器 */
.db-divider-handle     /* 分隔条可视手柄 */
.db-header-fixed       /* A区：固定顶部 */
.db-titlebar           /* 标题栏 44px */
.db-infobar            /* 信息栏 36px */
.db-toolbar            /* 工具栏 40px */
.db-scroll-area        /* B区：可滚动区域 */
.db-footer-fixed       /* C区：固定底部 */
.db-close-btn          /* ✕ 关闭按钮 */

/* ── 分类面板 ── */
.db-cat-panel          /* 单个折叠面板 */
.db-cat-panel--collapsed  /* 折叠状态 */
.db-cat-title          /* 面板标题 */
.db-cat-count          /* 面板内学生计数 */

/* ── 学生行 ── */
.db-student-row        /* 学生行 */
.db-student-row--done       /* 已完成行（绿色背景） */
.db-student-row--warning    /* 需跟进行（黄色背景） */
.db-student-row--danger     /* 高风险行（红色背景） */
.db-student-row--waiting    /* 等待报告行（灰色背景） */

/* ── 组件 ── */
.db-checkbox           /* 自定义 checkbox */
.db-student-info       /* 学生姓名+元数据 */
.db-student-name       /* 姓名 */
.db-student-meta       /* 年级·时间·课程 */
.db-status-tags        /* 标签容器 */
.db-tag                /* 通用标签 */
.db-tag--level-a       /* 掌握度A标签 */
.db-tag--level-b       /* 掌握度B标签 */
.db-tag--level-c       /* 掌握度C标签 */
.db-tag--has-report    /* "有报告"标签 */
.db-tag--waiting       /* "等待报告"标签 */
.db-progress-bar       /* 进度条 */

/* ── 辅助 ── */
.db-empty-hint         /* 全完成提示 */
.db-toast              /* 浮动提示 */
.db-loading            /* 加载中遮罩 */
.db-student-binder     /* 学情表粘贴区 */
.db-bind-result        /* 绑定结果提示 */
.db-modal              /* 弹窗（第3类确认） */
.db-search-input       /* 搜索框 */
.db-refresh-btn        /* 刷新按钮 */
.db-overlay            /* 窄窗口模式遮罩 */
```

### 2.3 壳文件修改清单（4 个文件，共 ~15 行改动）

| 文件 | 位置 | 改动内容 |
|------|------|---------|
| `manifest.json` | `web_accessible_resources` 数组 | 新增 4 行：`"modules/dailyboard/module.json"`, `"modules/dailyboard/content.js"`, `"modules/dailyboard/content.css"`, `"modules/dailyboard/background.js"` |
| `background.js` | `KNOWN_MODULES` 数组（约第35行） | 新增 `'dailyboard'` |
| `background.js` | `KNOWN_MODULE_BG_MAP` 对象（约第42行） | 新增 `dailyboard: 'modules/dailyboard/background.js'` |
| `content.js` | `CONFIG.knownModules` 数组（约第28行） | 新增 `'dailyboard'` |
| `content.js` | `ICON_MAP` 对象（约第32行） | 新增 `dailyboard: '📋'` |

---

## 三、云端文件架构

### 3.1 CloudBase NoSQL（数据库）

```
CloudBase 环境: renewal-calendar-7ff2rtj4f876144

集合: teacher_daily_tasks
│
├── 文档1: { teacherName:"甘海凤", date:"2026-06-13", ... }
├── 文档2: { teacherName:"王老师",  date:"2026-06-13", ... }
├── 文档3: { teacherName:"甘海凤", date:"2026-06-12", ... }
└── ...

索引:
├── date_1_teacherName_1          ← 复合索引（管理看板按日期查全量）
└── teacherName_1_date_1          ← 复合索引（插件按老师+日期查）

安全规则:
{
  "teacher_daily_tasks": { ".read": true, ".write": true }
}
```

**文档结构**（每条记录约 30KB）：

```typescript
interface DailyTaskDoc {
  _id: string;
  teacherName: string;        // "甘海凤"
  teacherJobNumber: string;    // "A02747"
  teacherCenter: string;       // "郑州（一部）"— 已有
  teacherSubject: string;      // 🆕 方案 A："数学"
  teacherGrade: string;        // 🆕 方案 A："初一"
  date: string;               // "2026-06-13"
  lastSyncTime: string;        // ISO 时间戳
  
  students: [                   // 学生数组（~120条）
    {
      studentId: string;
      chineseName: string;
      phone: string;
      grade: string;
      center: string;
      courseName: string;
      classTimeStart: string;
      classTimeEnd: string;
      category: number;          // 1-7
      categoryLabel: string;
      isDone: boolean;
      doneTime: string | null;
      rebooked: boolean | null;  // 仅第3类
      userPeriodLevel: string | null;
      hasReport: boolean;
      lessonStatus: string;
      // 🆕 方案 A：冗余字段，便于 EduFlow 按维度分组
      teacherSubject?: string;
      teacherGrade?: string;
    }
  ];
  
  summary: {
    totalWithCourse: number;
    totalNoCourse: number;
    categoryCount: { "1": 20, "2": 15, ... };
    doneCount: number;
    doneRate: number;            // 0.54
  };
}
```

**数据量估算**：

| 维度 | 数量 |
|------|------|
| 每文档学生数 | ~120 |
| 每文档大小 | ~30KB |
| 每日文档数 | ~辅导老师数（假设10人） |
| 日增数据量 | ~300KB |
| **150天数据量** | **~45MB**（完全在 CloudBase 免费 2GB 内） |
| 数据保留 | **150 天**，超出自动清理 |

---

### 3.2 EduFlow 管理看板页面（本地 → 部署到 CloudBase 托管）

```
D:\Claw\EduFlow\                          ← 📦 EduFlow 项目根目录
├── assets/                                ← 🚀 部署到 CloudBase /ef/
│   ├── index.html                         ← SPA 入口（hash 路由）
│   │
│   ├── js/
│   │   ├── pages/
│   │   │   └── daily-board.js             ← 🆕 新增：管理看板页面逻辑
│   │   │
│   │   └── bundle.js                      ← [重建] esbuild 打包产物（自动重新生成）
│   │
│   └── css/
│       └── main.css                       ← [可选] 新增看板相关样式（或内联）
│
├── cloudbaserc.json                       ← 无需修改（已配好环境）
└── build.js                               ← 无需修改（自动打包 + 部署）
```

#### `daily-board.js` 页面结构（~400 行）

```
daily-board.js 内部结构
│
├── [区块1] 初始化 (~30行)
│   ├── 引入 CloudBase SDK（已在 app.js 中初始化）
│   ├── 权限检查：年级小组长及以上（gradeLeader role≥2）
│   └── 渲染页面框架：标题 + 日期选择器 + 表格容器
│
├── [区块2] 数据加载 (~60行)
│   ├── loadTodayTasks(date)                # CloudBase 直读 teacher_daily_tasks
│   │   └── db.collection('teacher_daily_tasks')
│   │       .where({ date })
│   │       .get()
│   ├── mergeTeamData(tasks)                # 多老师数据合并
│   └── autoRefresh()                       # 每5分钟自动刷新
│
├── [区块3] 团队汇总表 (~120行)
│   ├── renderTeamTable(data)               # 表格渲染
│   │   ├── 列：老师 | 中心 | 有课人数 | 已完成 | 完成率 | 异常数 | 操作
│   │   ├── 排序：按完成率 ↑（低排前）
│   │   └── 异常定义：分类3过多 → 标红
│   └── onRowClick(teacherName)             # 点击 → 展开详情
│
├── [区块4] 详情面板 (~100行)
│   ├── renderDetailPanel(teacherTask)      # 7类明细展开
│   │   ├── 每类：学生数 + 已完成数 + 列表
│   │   └── 未完成学生高亮
│   └── collapseDetail()                    # 收起
│
├── [区块5] 导出 (~50行)
│   ├── exportExcel(data)                   # SheetJS 导出
│   └── 可选：按中心/日期筛选导出
│
└── [区块6] 路由注册 (~10行)
    └── router.register('daily-board', renderDailyBoard)
```

#### 路由集成

```javascript
// router.js 路由表新增：
{ path: '/daily-board', page: 'daily-board', title: '每日看板', requireAuth: true, role: 2 }

// router.js getVisibleRoutes() 导航菜单新增（放在 数据统计 下面）：
{ path: '/daily-board', title: '每日看板', icon: '🖥️' },
```

> `role: 2` = 年级小组长（等级2）及以上可见。辅导员（等级1）看不到这个管理看板。
> 权限过滤由 `hasRoutePermission()` 自动处理（`router.js` 第 517-532 行）。

访问方式：`https://renewal-calendar-7ff2rtj4f876144-1259283480.tcloudbaseapp.com/ef/#/daily-board`

#### 部署命令（无需修改现有流程）

```bash
# 在 D:\Claw\EduFlow\ 下执行
node build.js           # esbuild 打包 → 生成带 hash 的 bundle.js
                        # 自动上传到 CloudBase /ef/
```

---

## 四、数据流全景

### 4.1 辅导老师写数据（插件端）

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ 爱芯 API         │     │ 插件 content.js  │     │ CloudBase NoSQL  │
│ ai-genesis.yua..│     │                  │     │                  │
├─────────────────┤     ├─────────────────┤     ├─────────────────┤
│                  │     │                  │     │                  │
│ ① HTTP Response  │────→│ fetchTodayData() │     │                  │
│    (120条排课)   │     │        │         │     │                  │
│                  │     │        ▼         │     │                  │
│                  │     │ classifyStudents │     │                  │
│                  │     │        │         │     │                  │
│                  │     │        ▼         │     │                  │
│                  │     │ renderCategories│     │                  │
│                  │     │        │         │     │                  │
│                  │     │        ▼         │     │                  │
│                  │     │  用户打勾        │     │                  │
│                  │     │        │         │     │                  │
│                  │     │        ▼         │     │                  │
│                  │     │ sendMessage ────→│     │                  │
│                  │     │ (SYNC_TO_CLOUD)  │     │                  │
│                  │     │                  │     │                  │
│                  │     │     background.js│     │   ② upsert/      │
│                  │     │                  │────→│     update       │
│                  │     │                  │     │                  │
│                  │     │  ← SYNC_RESULT ──│     │                  │
│                  │     │                  │     │                  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

**关键路径**：
1. content.js 从页面上下文直接 fetch 爱芯 API（共享 cookie，绕过认证问题）
2. content.js 本地分类 + 渲染 UI（完全不依赖 background.js）
3. 打勾时 content.js → background.js → CloudBase（异步，不阻塞 UI）

### 4.2 管理人员读数据（EduFlow 端）

```
┌─────────────────┐     ┌─────────────────┐
│ CloudBase NoSQL  │     │ EduFlow 页面     │
│                  │     │ /#daily-board    │
├─────────────────┤     ├─────────────────┤
│                  │     │                  │
│                  │     │ loadTodayTasks() │
│   ③ where({date})│←────│                  │
│                  │────→│   返回所有老师    │
│                  │     │   今日数据        │
│                  │     │        │         │
│                  │     │        ▼         │
│                  │     │ renderTeamTable()│
│                  │     │        │         │
│                  │     │        ▼         │
│                  │     │ 点击某行         │
│                  │     │        │         │
│                  │     │        ▼         │
│                  │     │ renderDetailPanel│
│                  │     │                  │
└─────────────────┘     └─────────────────┘
```

**关键路径**：
3. EduFlow 页面用 CloudBase SDK（已在 app.js 中初始化）直读数据库
4. 无需经过插件、无需经过 API 云函数——纯前端直读 NoSQL
5. 与插件端完全解耦，各自独立读写

### 4.3 完整数据链路（一次"刷新→打勾→看板查看"）

```
辅导老师电脑                         CloudBase 云                管理电脑
──────────────────────────────────────────────────────────────────────────

[爱芯后台页面]
     │
     ├─① fetch API → 拿排课数据
     │
[插件 content.js]
     │
     ├─② 7类分类 + 渲染UI
     │
     ├─③ 打勾 → sendMessage
     │
[插件 background.js]
     │
     ├─④ CloudBase SDK 写入 ─────→ [teacher_daily_tasks]
     │                                       │
     │                                       │
     │                              ⑤ EduFlow SDK 读取
     │                                       │
     │                              [EduFlow /daily-board]
     │                                       │
     │                                       ├─ 团队汇总表
     │                                       └─ 详情面板
     │
     └─⑥ 返回 SYNC_RESULT → 更新本地 UI
```

---

## 五、文件统计

### 5.1 新增文件清单

| 文件 | 路径 | 预估行数 | 类型 |
|------|------|---------|------|
| `module.json` | `plugins/toolbox/modules/dailyboard/` | 10 | JSON 配置 |
| `content.js` | 同上 | ~**900** | JS 主逻辑 ← v1.1 增加（分栏交互） |
| `content.css` | 同上 | ~**400** | CSS 样式 ← v1.1 增加（分栏样式） |
| `background.js` | 同上 | ~200 | JS 同步 |
| `cloudbase.full.js` | `plugins/toolbox/modules/dailyboard/lib/` | ~500KB | SDK（后备） |
| `daily-board.js` | `D:\Claw\EduFlow\assets\js\pages\` | ~400 | JS 看板页面 |
| **合计（不含SDK）** | | **~1,910 行** | ← v1.1 更新 |

### 5.2 修改文件清单

| 文件 | 路径 | 改动行数 |
|------|------|---------|
| `manifest.json` | `plugins/toolbox/` | +4 |
| `background.js` | `plugins/toolbox/` | +2 |
| `content.js` | `plugins/toolbox/` | +2 |
| **合计** | | **~8 行** |

---

## 六、关键决策依据

| # | 决策 | 为什么这么选 |
|---|------|-------------|
| 1 | API 从 content.js 调 | SW 没有页面 cookie，调爱芯 API 会 401；content.js 共享页面登录态 |
| 2 | CloudBase 从 background.js 写 | SW 生命周期独立，操作可靠；不与 UI 线程竞争 |
| 3 | EduFlow 直读 CloudBase | 不经过云函数，零延迟；已初始化 SDK，开箱即用 |
| 4 | NoSQL 一个老师一天一个文档 | 查询简单（where date），写入原子化；120学生×200字节≈24KB，不过大 |
| 5 | CloudBase SDK 本地后备 | CDN 可能被 CSP 拦；本地加载 100% 可靠 |
| 6 | EduFlow 页面独立文件 | 遵循现有 SPA + pages/ 模式；不污染其他页面代码 |
| 7 | 不新增云函数 | 读操作客户端直连、写操作插件端直连；不需要服务端中转 |

---

## 七、部署流程

### 7.1 首次部署

```
Step 1: CloudBase 控制台
  ├─ 创建集合 teacher_daily_tasks
  ├─ 创建索引: date + teacherName（复合）
  └─ 设置安全规则: {read: true, write: true}

Step 2: 插件侧（本地开发）
  ├─ 创建 modules/dailyboard/ 目录 + 4个文件
  ├─ 修改壳文件 4 处
  ├─ 在 Edge 浏览器加载测试
  └─ 如果 CSP 拦截 CDN → 下载 cloudbase.full.js 到 lib/

Step 3: EduFlow 侧（本地开发）
  ├─ 创建 assets/js/pages/daily-board.js
  ├─ 注册路由
  └─ node build.js → 自动部署到 CloudBase 托管
```

### 7.2 后续更新

| 变更范围 | 操作 |
|---------|------|
| 插件 dailyboard 模块 | 修改本地文件 → Edge 热加载看到效果 → `node build.js` 打包 CRX |
| EduFlow 看板页面 | 修改 daily-board.js → `node build.js` 自动打包+部署 |
| CloudBase 数据库 | 无需部署，集合结构不变 |

---

> **下一步**：确认这个文件架构方案无误后，进入 T0 —— 在 CloudBase 控制台创建 `teacher_daily_tasks` 集合和索引。
