# EduFlow 每日工作看板（管理端）— 完整 PRD

> 版本：**v1.1**（修正架构错误）
> 日期：2026-06-14
> 用途：**供其他 AI 直接开发使用的完整规格文档**
> 前置：插件端 v2.2.25 已完成数据写入 CloudBase，数据库已有真实数据
> ⚠️ v1.0→v1.1 修正：云函数签名、路由注册方式、ROLES 常量（详见各章节标注）

---

## 目录

1. [产品概述](#一产品概述)
2. [数据模型（CloudBase 真实结构）](#二数据模型)
3. [页面结构](#三页面结构)
4. [UI 规格（逐屏逐状态）](#四ui-规格)
5. [云函数 API 规格](#五云函数-api-规格)
6. [前端页面代码结构](#六前端页面代码结构)
7. [EduFlow 集成清单](#七eduflow-集成清单)
8. [权限矩阵](#八权限矩阵)
9. [验收清单](#九验收清单)
10. [附录：真实数据样本](#十附录)

---

## 一、产品概述

### 1.1 产品定位

EduFlow 管理看板是「每日工作看板」系统的管理端页面，嵌入 EduFlow 管理后台。
辅导老师在插件端打勾后数据自动同步到 CloudBase，管理层通过此页面查看团队整体的工作完成情况。

### 1.2 核心功能

| 功能 | 说明 |
|------|------|
| 团队汇总表 | 按日期查看所有辅导老师的工作统计数据，支持按中心/学科/年级筛选 |
| 个人详情下钻 | 点击某老师行，展开其当天 7 类学生明细 |
| 日期切换 | 查看历史日期数据（默认今天） |

### 1.3 技术架构

```
┌────────────────────────────────────────────────────────────────┐
│  EduFlow 前端（浏览器）                                          │
│  assets/js/pages/daily-board.js                                │
│       │                                                        │
│       │ POST { action: 'dailyboard.getTeamData', data: {...} } │
│       ▼                                                        │
│  CloudBase 云函数 ef-api                                         │
│  functions/ef-api/index.js → dailyboard.service.js（自动路由）   │
│       │                                                        │
│       │ ctx.db.collection('teacher_daily_tasks')                │
│       ▼                                                        │
│  CloudBase NoSQL: teacher_daily_tasks                           │
└────────────────────────────────────────────────────────────────┘
```

> ⚠️ **v1.1 修正**：架构图中 `tcb-admin-node: db.collection(...)` 改为 `ctx.db.collection(...)`，因为 service 通过 `ctx.db` 访问数据库，不自己 require tcb-admin-node。

**为什么不直接前端 SDK 读？** — EduFlow 现有架构统一走云函数 REST API（鉴权中间件统一处理），不引入新的 SDK 依赖。

---

## 二、数据模型

### 2.1 CloudBase 集合：teacher_daily_tasks

**环境**：`renewal-calendar-7ff2rtj4f876144`

#### 文档结构（v2.2.25 实际写入结构）

```typescript
// ⚠️ 以下字段名来自实际数据库，与早期架构文档有差异，以本文档为准
interface DailyTaskDoc {
  _id: string;                    // CloudBase 自动生成
  _openid: string;                // 匿名登录 uid
  date: string;                   // "2026-06-14"
  teacherName: string;            // "甘海凤"
  teacherCenter: string;          // "郑州"
  teacherGrade: string;           // "初三"
  teacherSubject: string;         // "数学"
  totalStudents: number;          // 27 — 当日学生总数
  doneCount: number;              // 1 — 已完成打勾数
  doneRate: number;               // 4 — 完成率百分比（整数）
  needActionCount: number;        // 24 — 需要打勾的总人数
  updatedAt: string;              // ISO 时间戳 "2026-06-14T10:35:18.705Z"

  // 当日两率（有效听课率 + 作业完成率）
  dayRates: {
    hwDoneCount: number;          // 作业完成人数
    listenCount: number;          // 有效听课人数
    totalStudents: number;        // 有排课总人数（去重）
  };

  // 7 类分类汇总（预聚合，可直接用于团队汇总表）
  catSummary: {
    "1": { done: number; total: number; };
    "2": { done: number; total: number; };
    "3": { done: number; total: number; };
    "4": { done: number; total: number; };
    "5": { done: number; total: number; };
    "6": { done: number; total: number; };
    "7": { done: number; total: number; };
  };

  // 学生明细
  students: StudentRecord[];
}

interface StudentRecord {
  studentId: string;             // "275310"
  studentName: string;           // "翌萱"（实际字段名是 studentName，非 chineseName）
  className: string;             // 课程名称
  scheduleTime: string;          // 上课时间（epoch 毫秒字符串）"1781434800000"
  endTime: string;               // 下课时间（epoch 毫秒字符串，可能为空）
  categoryId: number;            // 1-7 分类编号（实际字段名是 categoryId，非 category）
  isDone: boolean;               // 是否已打勾
  reportVersion: number;         // 0=无报告，1=有报告
  userPeriodLevel: string;       // 掌握度等级 ""/"-"/"A"/"B"/"C"
  homeworkStatus: number;        // -1=未解锁, 1=已解锁未学习, 3=已完成
  homeworkStatusDesc: string;    // 作业状态中文描述
  inClassOnlineDuration: string; // 听课时长 "137min20s"
  onlineStatus: string;          // 在线状态（可能为空）
  gradeName: string;             // 年级名（可能为空）
  subjectName: string;           // 科目名（可能为空）
}
```

#### 现有索引

```
_id_          (默认)
_openid_1     (默认)
```

**需要新增的索引**（管理看板查询需要）：

```javascript
// 索引1：按日期查询全部（最常用）
db.collection('teacher_daily_tasks').createIndex({
  date: 1
});

// 索引2：按日期+中心筛选
db.collection('teacher_daily_tasks').createIndex({
  date: 1,
  teacherCenter: 1
});

// 索引3：按日期+年级筛选
db.collection('teacher_daily_tasks').createIndex({
  date: 1,
  teacherGrade: 1
});

// 索引4：按日期+学科筛选
db.collection('teacher_daily_tasks').createIndex({
  date: 1,
  teacherSubject: 1
});
```

---

## 三、页面结构

### 3.1 URL 路由

```
路径：/#/daily-board
标题：每日工作看板
```

### 3.2 组件树

```
page-container（全宽，标准 EduFlow 内容区）
├── .db-mgmt-header           ← 页面头部
│   ├── 标题："📊 每日工作看板"
│   ├── 日期选择器            ← <input type="date">
│   └── 筛选下拉框 × 3         ← 中心/学科/年级（可选）
│
├── .db-mgmt-summary-cards    ← 统计卡片区
│   ├── 卡片1：团队人数
│   ├── 卡片2：总学生数（去重）
│   ├── 卡片3：有效听课率
│   └── 卡片4：作业完成率
│
├── .db-mgmt-table-container  ← 主表格区
│   ├── 表头操作栏
│   │   ├── "团队汇总" 标签
│   │   ├── 展开/折叠全部按钮
│   │   └── 排序下拉（按完成率/异常数）
│   │
│   ├── <table> 团队汇总表
│   │   ├── 列：辅导老师 | 中心 | 年级 | 学科 | 有课人数 | 需行动 | 已完成 | 完成率 | 7类明细 | 有效听课率 | 作业完成率
│   │   └── 行：每个老师一条，可点击展开
│   │
│   └── 详情展开区（每行下方）
│       ├── 7 类分段统计表
│       └── 学生明细列表（可折叠）
│
└── .db-mgmt-empty            ← 空状态（无数据时）
```

### 3.3 响应式行为

| 屏幕宽度 | 行为 |
|---------|------|
| > 1200px | 完整表格，所有列可见 |
| 768-1200px | 隐藏作业完成率列，7类明细用缩写图标 |
| < 768px | 卡片堆叠布局，每行一个卡片 |

---

## 四、UI 规格（逐屏逐状态）

### 4.1 标准状态（有数据）

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  📊 每日工作看板                                        2026-06-14 📅 [查询]  │
│                                                                              │
│  筛选: [全部中心 ▾]  [全部学科 ▾]  [全部年级 ▾]                               │
│                                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │   团队人数    │  │  总学生数    │  │  有效听课率   │  │  作业完成率   │         │
│  │     1       │  │     27      │  │    81%      │  │    52%      │         │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘         │
│                                                                              │
│  团队汇总 ▸ 展开全部  |  排序: [完成率 ↑]                                     │
│                                                                              │
│  ┌─────────┬──────┬──────┬──────┬──────┬──────┬──────┬──────┬──────┬───────┐ │
│  │ 辅导老师  │ 中心  │ 年级  │ 学科  │有课人数│需行动│已完成│完成率│ 7类  │操作   │ │
│  ├─────────┼──────┼──────┼──────┼──────┼──────┼──────┼──────┼──────┼───────┤ │
│  │ 甘海凤  │ 郑州  │ 初三  │ 数学  │  27  │  24  │  1   │  4%  │●●●●●│ ▸详情 │ │
│  └─────────┴──────┴──────┴──────┴──────┴──────┴──────┴──────┴──────┴───────┘ │
│                                                                              │
│  ※ 数据更新时间: 2026-06-14 18:35                                            │
└──────────────────────────────────────────────────────────────────────────────┘
```

#### 4.1.1 统计卡片计算规则

| 卡片 | 字段来源 | 计算方式 |
|------|---------|---------|
| 团队人数 | 文档数组 | `docs.length`（去重 teacherName 计数） |
| 总学生数 | `totalStudents` | `sum(doc.totalStudents)`，同日期同老师只取一条 |
| 有效听课率 | `dayRates.listenCount / dayRates.totalStudents` | 加权平均：`sum(listenCount) / sum(totalStudents) × 100%` |
| 作业完成率 | `dayRates.hwDoneCount / dayRates.totalStudents` | 加权平均：`sum(hwDoneCount) / sum(totalStudents) × 100%` |

#### 4.1.2 团队汇总表列定义

| 列 | 字段来源 | 格式 | 排序 |
|----|---------|------|:--:|
| 辅导老师 | `teacherName` | 文本 | ✅ |
| 中心 | `teacherCenter` | 文本 | ✅ |
| 年级 | `teacherGrade` | 文本 | — |
| 学科 | `teacherSubject` | 文本 | — |
| 有课人数 | `totalStudents` | 数字 | ✅ |
| 需行动 | `needActionCount`（分类3-7总人数） | 数字 | ✅ |
| 已完成 | `doneCount` | 数字 | ✅ |
| 完成率 | `doneRate` | 百分比（如 `4%`） | ✅ 默认升序 |
| 7类 | `catSummary` 各分类 done/total | 7 个圆点（绿/黄/红/灰） | — |
| 有效听课率 | `dayRates.listenCount / dayRates.totalStudents` | 百分比 | ✅ |
| 作业完成率 | `dayRates.hwDoneCount / dayRates.totalStudents` | 百分比 | ✅ |
| 操作 | — | "▸ 展开详情" 按钮 | — |

#### 4.1.3 7类状态圆点颜色规则

```
每个分类用一个圆点表示，颜色由 {done, total} 决定：

总数为 0      → ⚪ 灰色圆点
完成率 = 100% → 🟢 绿色圆点
完成率 ≥ 50%  → 🟡 黄色圆点
完成率 < 50%  → 🔴 红色圆点

7 个圆点从左到右对应分类 1-7
```

### 4.2 详情展开状态

点击某行"▸ 展开详情"按钮（或点击整行），在行下方展开详情面板：

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  │ 甘海凤  │ 郑州  │ 初三  │ 数学  │  27  │  24  │  1   │  4%  │●●●●●│ ▾收起 │
│  ├──────────────────────────────────────────────────────────────────────────┤
│  │  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  │  甘海凤 — 2026-06-14 详情                        有效听课: 81%     │  │
│  │  │                                                    作业完成: 52%     │  │
│  │  ├──────────┬──────┬────────┬────────┬────────────────────────────────┤  │
│  │  │ 分类      │ 人数  │ 已完成  │ 完成率  │ 未完成学生                      │  │
│  │  ├──────────┼──────┼────────┼────────┼────────────────────────────────┤  │
│  │  │ 1.未上课  │  3   │   —    │   —    │ （无需打勾）                     │  │
│  │  │ 2.正在上  │  0   │   —    │   —    │                                │  │
│  │  │ 3.⚠无报告 │  2   │   0    │   0%   │ 艾珈、小雨                       │  │
│  │  │ 4.表现好  │  16  │   0    │   0%   │ 奕辰、艺蕾、婧瑶...等 16 人       │  │
│  │  │ 5.一般    │  4   │   0    │   0%   │ 玉轩、奕钦、茵茹、小果            │  │
│  │  │ 6.🚨需跟进│  2   │   1    │  50%   │ 敬凌（未完成）                   │  │
│  │  │ 7.没课    │  0   │   0    │   —    │                                │  │
│  │  └──────────┴──────┴────────┴────────┴────────────────────────────────┘  │
│  │                                                                          │
│  │  [展开学生明细] / [收起学生明细]                                            │
│  │                                                                          │
│  │  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  │ 学生明细（全部 27 人）                                               │  │
│  │  │ 学生ID    │ 姓名   │ 课程             │ 时间    │ 分类 │ 状态      │  │
│  │  │ 275310   │ 翌萱   │ 初二思维名师AI... │ 10:00  │ 1.未上课│ ⏳等待   │  │
│  │  │ 278510   │ 培轩   │ 初二思维名师AI... │ 10:00  │ 1.未上课│ ⏳等待   │  │
│  │  │ ...      │ ...    │ ...              │ ...    │ ...   │ ...       │  │
│  │  │ 281877   │ 鑫宇   │ 初二思维名师AI... │ 09:00  │ 6.需跟进│ ✅已完成  │  │
│  │  └────────────────────────────────────────────────────────────────────┘  │
│  └──────────────────────────────────────────────────────────────────────────┘
└──────────────────────────────────────────────────────────────────────────────┘
```

#### 4.2.1 详情面板交互

| 交互 | 行为 |
|------|------|
| 点击行 | 展开/折叠详情面板 |
| 点击"展开学生明细" | 显示所有学生的明细表格 |
| 点击"收起学生明细" | 折叠学生明细（7类统计表保持可见） |
| 再次点击行或"收起" | 完全折叠详情面板 |
| 同时只能展开一行 | 展开新行时自动折叠旧行 |

#### 4.2.2 学生明细表列定义

| 列 | 字段 | 说明 |
|----|------|------|
| 学生ID | `studentId` | 纯数字 ID |
| 姓名 | `studentName` | — |
| 课程 | `className` | 截断到 20 字符，hover 显示全称 |
| 时间 | `scheduleTime` | epoch 毫秒 → 格式化为 `HH:mm`（上课时间） |
| 分类 | `categoryId` → `CATEGORY_LABELS[categoryId]` | 带颜色标签 |
| 状态 | `isDone` + `userPeriodLevel` + `reportVersion` | 见下表 |
| 听课时长 | `inClassOnlineDuration` | 如 "137min20s" |
| 作业 | `homeworkStatusDesc` | "已完成"/"未解锁"/"已解锁未学习" |

#### 4.2.3 状态列渲染规则

| 条件 | 显示 |
|------|------|
| `isDone === true` | `✅ 已完成` 绿色 |
| `categoryId === 1` | `⏳ 等待上课` 灰色 |
| `categoryId === 2` | `🔵 正在上课` 蓝色 |
| `categoryId === 3 && !isDone` | `⚠️ 无报告` 橙色 |
| `categoryId >= 4 && !isDone && reportVersion >= 1` | `☐ 待处理` + 掌握度标签 |
| `categoryId >= 4 && !isDone && reportVersion === 0` | `⏳ 等待报告` 灰色 |
| `categoryId === 7 && !isDone` | `☐ 待私聊` 灰色 |
| `categoryId === 7 && isDone` | `✅ 已私聊` 绿色 |

### 4.3 筛选栏

```
筛选:  [全部中心 ▾]  [全部学科 ▾]  [全部年级 ▾]
```

三个下拉框，从当前查询结果中动态提取选项：

```javascript
// 伪代码
const centers = [...new Set(docs.map(d => d.teacherCenter))].sort();
const subjects = [...new Set(docs.map(d => d.teacherSubject))].sort();
const grades = [...new Set(docs.map(d => d.teacherGrade))].sort();
```

筛选逻辑：前端过滤，选中后只显示匹配的行。支持多选组合（如「郑州」+「数学」）。

### 4.4 空状态

```
┌──────────────────────────────────────────────────────────────┐
│  📊 每日工作看板                        2026-06-14 📅 [查询]  │
│                                                              │
│                      📭                                       │
│              所选日期暂无工作数据                               │
│                                                              │
│         请确认：辅导老师是否已在插件端刷新数据？                   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 4.5 加载状态

```
│  ⏳ 正在加载数据...                                           │
│  ████████░░░░░░░░                                            │
```

### 4.6 错误状态

```
│  ⚠️ 数据加载失败                                              │
│  网络连接异常，请稍后重试                                       │
│  [重新加载]                                                   │
```

### 4.7 日期切换

- 日期选择器默认值：当天日期
- 切换日期 → 重新请求云函数 → 更新全部数据
- URL 支持日期参数：`/#/daily-board?date=2026-06-13`

---

## 五、云函数 API 规格

### 5.1 新增 action：`dailyboard.getTeamData`

**请求**：

```json
{
  "action": "dailyboard.getTeamData",
  "data": {
    "date": "2026-06-14"
  }
}
```

**响应（成功）**：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "date": "2026-06-14",
    "docs": [
      {
        "_id": "ed693ef16a2e6fff001ec7e85452ae04",
        "teacherName": "甘海凤",
        "teacherCenter": "郑州",
        "teacherGrade": "初三",
        "teacherSubject": "数学",
        "totalStudents": 27,
        "doneCount": 1,
        "doneRate": 4,
        "needActionCount": 24,
        "dayRates": {
          "hwDoneCount": 0,
          "listenCount": 22,
          "totalStudents": 27
        },
        "catSummary": {
          "1": { "done": 0, "total": 3 },
          "2": { "done": 0, "total": 0 },
          "3": { "done": 0, "total": 2 },
          "4": { "done": 0, "total": 16 },
          "5": { "done": 0, "total": 4 },
          "6": { "done": 1, "total": 2 },
          "7": { "done": 0, "total": 0 }
        },
        "students": [ /* 完整学生数组，字段见 §2.1 StudentRecord */ ],
        "updatedAt": "2026-06-14T10:35:18.705Z"
      }
    ],
    "totalTeachers": 1,
    "queryTime": "2026-06-14T18:30:00.000Z"
  }
}
```

**响应（无数据）**：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "date": "2026-06-14",
    "docs": [],
    "totalTeachers": 0,
    "queryTime": "2026-06-14T18:30:00.000Z"
  }
}
```

**响应（错误）**：

```json
{
  "code": 500,
  "message": "查询 teacher_daily_tasks 失败: [具体错误]"
}
```

### 5.2 云函数实现文件

**文件**：`D:\Claw\EduFlow\functions\ef-api\dailyboard.service.js`（新建）

> ⚠️ **v1.1 修正**：EduFlow 所有 service 的函数签名为 `(data, currentUser, ctx)`，其中 `ctx = { db, _, dbHelper, permission, response }`。**禁止**自己 `require('tcb-admin-node')`，通过 `ctx.db` 访问数据库。旧版 v1.0 写的 `require('tcb-admin-node')` 和 `(ctx, data)` 签名是错误的。

```javascript
/**
 * 每日工作看板 — 管理端数据查询服务
 *
 * 被 ef-api/index.js 的懒加载自动路由调用
 * action: 'dailyboard.getTeamData'
 *
 * ⚠️ 函数签名必须遵循 EduFlow service 规范：(data, currentUser, ctx)
 *    - data: 请求参数对象
 *    - currentUser: 当前登录用户（由 verifyToken 中间件注入）
 *    - ctx: { db, _, dbHelper, permission, response }（由 index.js 注入）
 *    禁止自己 require('tcb-admin-node')，用 ctx.db 访问数据库。
 */

/**
 * 获取指定日期的团队工作数据
 *
 * @param {object} data - 请求参数
 * @param {string} data.date - 查询日期 "YYYY-MM-DD"
 * @param {object} currentUser - 当前登录用户（由 verifyToken 注入）
 * @param {object} ctx - 云函数上下文 { db, _, dbHelper, permission, response }
 * @returns {object} { code, message, data }
 */
exports.getTeamData = async function(data, currentUser, ctx) {
  const { db, response } = ctx;

  if (!currentUser) {
    return response.unauthorized();
  }

  const { date } = data;

  // 参数校验
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return response.error(400, '参数错误：date 格式需为 YYYY-MM-DD');
  }

  try {
    // 按日期查询所有老师数据
    const res = await db.collection('teacher_daily_tasks')
      .where({ date: date })
      .get();

    return {
      code: 0,
      message: 'success',
      data: {
        date: date,
        docs: res.data || [],
        totalTeachers: (res.data || []).length,
        queryTime: new Date().toISOString()
      }
    };
  } catch (err) {
    console.error('[dailyboard.getTeamData] 查询失败:', err);
    return {
      code: 500,
      message: '查询 teacher_daily_tasks 失败: ' + err.message
    };
  }
};
```

### 5.3 云函数路由注册

> ⚠️ **v1.1 修正**：EduFlow 的 `index.js` 使用**懒加载自动路由**，会自动根据 `action.split('.')` 找到对应的 service 文件。**不需要在 index.js 中手动 `require` 或注册 handler**。新建 `dailyboard.service.js` 文件后，调用 `dailyboard.getTeamData` 会自动路由到该文件的 `exports.getTeamData`。旧版 v1.0 写的 `require('./dailyboard.service')` + `handlers` 注册是**完全错误的**，照做会破坏现有架构。

**无需修改 `index.js`！** 自动路由逻辑如下：

```javascript
// index.js 内部路由逻辑（已有，无需修改）：
const [serviceName, methodName] = action.split('.');   // 'dailyboard' + 'getTeamData'
const serviceFileName = `${serviceName}.service`;      // 'dailyboard.service'
const service = getService(serviceFileName);            // 懒加载 require('./dailyboard.service.js')
result = await service[methodName](cleanData, currentUser, { db, _, dbHelper, permission, response });
```

只需确保文件名是 `dailyboard.service.js`，导出的方法名是 `getTeamData`，路由自动生效。

### 5.4 前端 API 调用封装

在 `assets/js/pages/daily-board.js` 中：

```javascript
import { post } from '../api.js';

/**
 * 获取管理看板团队数据
 * @param {string} date - "YYYY-MM-DD"
 */
async function fetchTeamData(date) {
  try {
    const result = await post('dailyboard.getTeamData', { date });
    if (result.code === 0) {
      return result.data;
    }
    throw new Error(result.message || 'API 返回错误');
  } catch (err) {
    console.error('[daily-board] 数据加载失败:', err);
    throw err;
  }
}
```

---

## 六、前端页面代码结构

### 6.1 文件路径

```
D:\Claw\EduFlow\assets\js\pages\daily-board.js    ← 新建，核心页面逻辑
```

> **不需要新建 CSS 文件**：看板样式通过内联 `<style>` 标签或利用 EduFlow 现有 main.css 中的通用样式即可。如需额外样式，加在 `main.css` 末尾。

### 6.2 页面模块导出

```javascript
// daily-board.js

// 常量
const CATEGORY_LABELS = {
  1: '未上课', 2: '正在上课', 3: '⚠️无报告',
  4: '表现好', 5: '一般', 6: '🚨需跟进', 7: '没课'
};

const CATEGORY_COLORS = {
  1: '#9e9e9e', 2: '#2196f3', 3: '#ff9800',
  4: '#4caf50', 5: '#2196f3', 6: '#f44336', 7: '#757575'
};

// 状态变量
let teamData = null;
let expandedTeacher = null;  // 当前展开的老师姓名
let filters = { center: '全部', subject: '全部', grade: '全部' };

/**
 * 渲染页面（EduFlow 页面标准接口）
 * @param {HTMLElement} container - 页面容器 DOM 元素
 */
export async function render(container) {
  container.innerHTML = getPageHTML();
  
  // 从 URL 参数读取日期
  const urlParams = new URLSearchParams(window.location.hash.split('?')[1] || '');
  const date = urlParams.get('date') || getTodayStr();
  document.getElementById('db-mgmt-date').value = date;
  
  // 加载数据
  await loadAndRender(date);
  
  return { unmount: () => { teamData = null; expandedTeacher = null; } };
}

/**
 * 绑定事件（EduFlow 页面标准接口）
 */
export function bindEvents() {
  // 日期切换
  document.getElementById('db-mgmt-date').addEventListener('change', onDateChange);
  
  // 筛选下拉框
  ['center', 'subject', 'grade'].forEach(type => {
    document.getElementById(`db-filter-${type}`).addEventListener('change', onFilterChange);
  });
  
  // 展开/折叠全部
  document.getElementById('db-toggle-all').addEventListener('click', toggleAllDetails);
  
  // 团队汇总表 — 使用事件委托处理行点击和排序
  document.getElementById('db-team-table').addEventListener('click', onTableClick);
  document.getElementById('db-team-table').addEventListener('click', onSortClick);
}

// ============================================================
// 以下为内部函数，按功能分组实现
// ============================================================

// ──── 数据加载 ────
function getTodayStr() { ... }           // 返回 "YYYY-MM-DD"
async function fetchTeamData(date) { ... } // 调用 post('dailyboard.getTeamData', { date })
async function loadAndRender(date) { ... } // 调用 API → 更新 teamData → 渲染全部

// ──── 统计卡片 ────
function renderSummaryCards(docs) { ... }  // 计算并渲染 4 个统计卡片

// ──── 筛选栏 ────
function renderFilters(docs) { ... }       // 动态填充下拉框选项
function applyFilters(docs) { ... }        // 按 center/subject/grade 过滤
function onFilterChange(e) { ... }         // 筛选变化 → 重新渲染表格
function onDateChange(e) { ... }           // 日期变化 → 重新加载数据

// ──── 团队汇总表 ────
function renderTeamTable(docs) { ... }     // 渲染主表格
function renderTableRow(doc) { ... }       // 渲染单行
function renderCatDots(catSummary) { ... } // 渲染 7 类圆点
function sortTable(sortBy) { ... }         // 排序逻辑
function onSortClick(e) { ... }            // 列头点击排序

// ──── 详情面板 ────
function renderDetailPanel(doc) { ... }    // 渲染展开的详情面板（7类统计 + 学生明细）
function renderCatStats(catSummary, students) { ... } // 7类统计表
function renderStudentTable(students) { ... }  // 学生明细表
function renderStudentRow(student) { ... }     // 单行学生
function renderStatusTag(student) { ... }      // 状态标签
function getStatusLabel(student) { ... }       // 状态文字
function toggleDetail(teacherName) { ... }     // 展开/折叠详情
function toggleAllDetails() { ... }            // 展开/折叠全部
function formatScheduleTime(epochMs) { ... }   // epoch 毫秒 → "HH:mm"

// ──── HTML 模板 ────
function getPageHTML() { ... }             // 返回页面完整 HTML 字符串
```

### 6.3 关键渲染逻辑伪代码

#### 统计卡片

```javascript
function renderSummaryCards(docs) {
  if (!docs || docs.length === 0) {
    // 全部显示 0
    updateCard('db-card-teachers', '0');
    updateCard('db-card-students', '0');
    updateCard('db-card-listen-rate', '—');
    updateCard('db-card-hw-rate', '—');
    return;
  }
  
  const teacherCount = docs.length;
  const totalStudents = docs.reduce((sum, d) => sum + (d.dayRates?.totalStudents || d.totalStudents || 0), 0);
  const totalListen = docs.reduce((sum, d) => sum + (d.dayRates?.listenCount || 0), 0);
  const totalHwDone = docs.reduce((sum, d) => sum + (d.dayRates?.hwDoneCount || 0), 0);
  
  updateCard('db-card-teachers', teacherCount);
  updateCard('db-card-students', totalStudents);
  updateCard('db-card-listen-rate', totalStudents > 0 ? Math.round(totalListen / totalStudents * 100) + '%' : '—');
  updateCard('db-card-hw-rate', totalStudents > 0 ? Math.round(totalHwDone / totalStudents * 100) + '%' : '—');
}
```

#### 团队汇总表

```javascript
function renderTeamTable(docs) {
  const tbody = document.getElementById('db-team-tbody');
  if (!docs || docs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="db-empty-hint">暂无数据</td></tr>`;
    return;
  }
  
  // 按完成率升序排列（完成率低的排前面，方便管理者关注）
  const sorted = [...docs].sort((a, b) => (a.doneRate || 0) - (b.doneRate || 0));
  
  tbody.innerHTML = sorted.map(doc => `
    <tr class="db-team-row ${expandedTeacher === doc.teacherName ? 'db-expanded' : ''}"
        data-teacher="${escapeAttr(doc.teacherName)}">
      <td>${escapeHtml(doc.teacherName)}</td>
      <td>${escapeHtml(doc.teacherCenter || '—')}</td>
      <td>${escapeHtml(doc.teacherGrade || '—')}</td>
      <td>${escapeHtml(doc.teacherSubject || '—')}</td>
      <td>${doc.totalStudents || 0}</td>
      <td>${doc.needActionCount || 0}</td>
      <td>${doc.doneCount || 0}</td>
      <td><span class="db-rate-badge" style="background:${getRateColor(doc.doneRate)}">
        ${doc.doneRate || 0}%
      </span></td>
      <td class="db-cat-dots">${renderCatDotsHTML(doc.catSummary)}</td>
      <td>${doc.dayRates?.totalStudents ? Math.round(doc.dayRates.listenCount / doc.dayRates.totalStudents * 100) + '%' : '—'}</td>
      <td>${doc.dayRates?.totalStudents ? Math.round(doc.dayRates.hwDoneCount / doc.dayRates.totalStudents * 100) + '%' : '—'}</td>
      <td>
        <button class="db-detail-btn" data-action="toggle" data-teacher="${escapeAttr(doc.teacherName)}">
          ${expandedTeacher === doc.teacherName ? '▾ 收起' : '▸ 详情'}
        </button>
      </td>
    </tr>
    ${expandedTeacher === doc.teacherName ? renderDetailRow(doc) : ''}
  `).join('');
}

function getRateColor(rate) {
  if (rate >= 80) return '#4caf50';
  if (rate >= 50) return '#ff9800';
  return '#f44336';
}

function renderCatDotsHTML(catSummary) {
  if (!catSummary) return '<span class="db-no-data">—</span>';
  return [1,2,3,4,5,6,7].map(cat => {
    const cs = catSummary[String(cat)];
    if (!cs || cs.total === 0) return '<span class="db-dot db-dot-empty" title="分类' + cat + ': 0人">⚪</span>';
    const rate = cs.total > 0 ? cs.done / cs.total : 0;
    if (rate >= 1) return '<span class="db-dot db-dot-done" title="分类' + cat + ': ' + cs.done + '/' + cs.total + '">🟢</span>';
    if (rate >= 0.5) return '<span class="db-dot db-dot-half" title="分类' + cat + ': ' + cs.done + '/' + cs.total + '">🟡</span>';
    return '<span class="db-dot db-dot-low" title="分类' + cat + ': ' + cs.done + '/' + cs.total + '">🔴</span>';
  }).join('');
}
```

#### 详情面板

```javascript
function renderDetailRow(doc) {
  return `
    <tr class="db-detail-row" data-teacher="${escapeAttr(doc.teacherName)}">
      <td colspan="12">
        <div class="db-detail-panel">
          <!-- 7类统计表 -->
          <table class="db-cat-stats-table">
            <thead>
              <tr>
                <th>分类</th><th>人数</th><th>已完成</th><th>完成率</th><th>未完成学生</th>
              </tr>
            </thead>
            <tbody>
              ${[1,2,3,4,5,6,7].map(cat => renderCatStatsRow(cat, doc)).join('')}
            </tbody>
          </table>
          
          <!-- 学生明细表（初始折叠） -->
          <details class="db-student-details">
            <summary>📋 学生明细（共 ${doc.students?.length || 0} 人）</summary>
            <table class="db-student-table">
              <thead>
                <tr>
                  <th>学生ID</th><th>姓名</th><th>课程</th><th>时间</th><th>分类</th><th>状态</th>
                  <th>听课时长</th><th>作业</th>
                </tr>
              </thead>
              <tbody>
                ${(doc.students || []).map(s => renderStudentRowHTML(s)).join('')}
              </tbody>
            </table>
          </details>
        </div>
      </td>
    </tr>
  `;
}

function renderCatStatsRow(cat, doc) {
  const cs = doc.catSummary?.[String(cat)];
  const total = cs?.total || 0;
  const done = cs?.done || 0;
  const catStudents = (doc.students || []).filter(s => s.categoryId === cat);
  const undoneStudents = catStudents.filter(s => !s.isDone);
  const hasCheckbox = ![1, 2].includes(cat); // 分类1/2无checkbox

  return `
    <tr class="db-cat-row cat-${cat}">
      <td style="border-left: 3px solid ${CATEGORY_COLORS[cat]}">
        ${cat}. ${CATEGORY_LABELS[cat]}
      </td>
      <td>${total}</td>
      <td>${hasCheckbox ? done : '—'}</td>
      <td>${hasCheckbox ? (total > 0 ? Math.round(done / total * 100) + '%' : '—') : '—'}</td>
      <td class="db-undone-list">
        ${undoneStudents.length > 0 
          ? undoneStudents.slice(0, 10).map(s => escapeHtml(s.studentName)).join('、')
            + (undoneStudents.length > 10 ? ` 等 ${undoneStudents.length} 人` : '')
          : (total > 0 ? '✅ 全部完成' : '—')}
      </td>
    </tr>
  `;
}

function renderStudentRowHTML(s) {
  const categoryLabel = CATEGORY_LABELS[s.categoryId] || `分类${s.categoryId}`;
  const classTime = formatScheduleTimeStr(s.scheduleTime);
  
  return `
    <tr class="db-student-row ${s.isDone ? 'db-student-done' : ''}">
      <td>${s.studentId}</td>
      <td>${escapeHtml(s.studentName)}</td>
      <td title="${escapeAttr(s.className)}">${escapeHtml(truncateStr(s.className, 20))}</td>
      <td>${classTime}</td>
      <td><span class="db-cat-tag" style="background:${CATEGORY_COLORS[s.categoryId]}20;color:${CATEGORY_COLORS[s.categoryId]}">
        ${categoryLabel}
      </span></td>
      <td>${getStatusHTML(s)}</td>
      <td>${s.inClassOnlineDuration || '—'}</td>
      <td>${s.homeworkStatusDesc || '—'}</td>
    </tr>
  `;
}

function formatScheduleTimeStr(epochMs) {
  if (!epochMs) return '—';
  const d = new Date(parseInt(epochMs));
  if (isNaN(d.getTime())) return '—';
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function getStatusHTML(s) {
  if (s.isDone) return '<span class="db-status-done">✅ 已完成</span>';
  if (s.categoryId === 1) return '<span class="db-status-waiting">⏳ 等待上课</span>';
  if (s.categoryId === 2) return '<span class="db-status-ongoing">🔵 正在上课</span>';
  if (s.categoryId === 3) return '<span class="db-status-warn">⚠️ 无报告</span>';
  if (s.reportVersion >= 1) return '<span class="db-status-pending">☐ 待处理</span>';
  return '<span class="db-status-waiting">⏳ 等待报告</span>';
}

function truncateStr(str, maxLen) {
  if (!str) return '—';
  return str.length > maxLen ? str.substring(0, maxLen) + '...' : str;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function escapeAttr(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
```

---

## 七、EduFlow 集成清单

### 7.1 文件变更总览

| 操作 | 文件路径 | 说明 |
|------|---------|------|
| 🆕 新建 | `assets/js/pages/daily-board.js` | 管理看板页面逻辑（~500 行） |
| 🆕 新建 | `functions/ef-api/dailyboard.service.js` | 云函数数据查询服务（~50 行） |
| ✏️ 修改 | `assets/js/pages/index.js` | 注册页面模块 |
| ✏️ 修改 | `assets/js/router.js` | 新增路由 + 导航条目 |
| ✏️ 修改 | `build.js` | 更新 CHANGELOG（可选） |

> ⚠️ **v1.1 修正**：旧版 v1.0 列了「修改 `functions/ef-api/index.js` 注册 action handler」，这是错误的。index.js 使用懒加载自动路由，**无需修改**。

### 7.2 精确修改位置 (Step by Step)

#### Step 1: 创建 `daily-board.js`

**文件**：`D:\Claw\EduFlow\assets\js\pages\daily-board.js`

按照 [§六 前端页面代码结构](#六前端页面代码结构) 中的结构实现。核心要求：
- 导出 `render(container)` 和 `bindEvents()` 函数
- 使用 `import { post } from '../api.js'` 调用云函数
- 使用 `import { hasMinRole } from '../permission.js'` 做前端二次鉴权
- 使用 `import { escapeHtml } from '../utils.js'`（如果 utils.js 有的话，没有就自己实现）
- 所有 CSS 用内联 style 或页面级 `<style>` 标签，不新建 CSS 文件

#### Step 2: 注册页面模块

**文件**：`D:\Claw\EduFlow\assets\js\pages\index.js`

在文件末尾的 `pageModules` 对象中新增一行：

```javascript
// 找到类似这样的对象：
const pageModules = {
  'login': login,
  'dashboard': dashboard,
  // ... 其他模块
};

// 新增：
'daily-board': dailyBoard,  // ← 新增这行
```

同时在文件顶部新增 import：

```javascript
import * as dailyBoard from './daily-board.js';  // ← 新增这行
```

#### Step 3: 新增路由

**文件**：`D:\Claw\EduFlow\assets\js\router.js`

**3a. 在 `routes` 数组中新增**（约第 12-104 行之间）：

```javascript
// 找到 routes 数组定义，在合适位置新增：
{ path: '/daily-board', page: 'daily-board', title: '每日工作看板', requireAuth: true, requiredRole: ROLES.GRADE_LEADER },
```

> ⚠️ **v1.1 修正**：使用 `ROLES.GRADE_LEADER` 常量，不是字符串 `'gradeLeader'`。router.js 中所有路由都使用 `ROLES.*` 常量。`requiredRole: ROLES.GRADE_LEADER` 表示只有年级小组长（角色等级 ≥ 2）及以上才能访问。无权限用户访问会被路由守卫重定向到 `/dashboard`。

**3b. 在 `getVisibleRoutes()` 函数的 `navRoutes` 数组中新增**（约第 516-532 行）：

```javascript
const navRoutes = [
  { path: '/dashboard', title: '消息主页', icon: '📋' },
  { path: '/favorites', title: '我的空间', icon: '⭐' },
  { path: '/schedule', title: '行事历', icon: '📅' },
  { path: '/report', title: '日报', icon: '📝' },
  { path: '/daily-board', title: '每日工作看板', icon: '📊' },  // ← 新增，放在数据统计前面
  { path: '/stats', title: '数据统计', icon: '📊' },
  { path: '/admin/users', title: '用户管理', icon: '👥' },
  // ... 其他
];
```

#### Step 4: 创建云函数服务

**文件**：`D:\Claw\EduFlow\functions\ef-api\dailyboard.service.js`（新建）

内容见 [§5.2 云函数实现文件](#52-云函数实现文件)。

#### Step 5: 确认自动路由生效

> ⚠️ **v1.1 修正**：旧版 v1.0 让你修改 `index.js` 加 `require` 和 `handlers` 注册，这是**完全错误的**。EduFlow 的 `index.js` 使用懒加载自动路由，新建 `dailyboard.service.js` 后路由自动生效，**无需修改 index.js**。

**无需任何操作！** 只需确认 `dailyboard.service.js` 文件已创建在 `functions/ef-api/` 目录下，且导出了 `getTeamData` 方法即可。

#### Step 6: 部署云函数

```bash
cd D:\Claw\EduFlow
# 部署云函数到 CloudBase
npx tcb fn deploy ef-api --envId renewal-calendar-7ff2rtj4f876144
```

#### Step 7: 构建前端

```bash
cd D:\Claw\EduFlow
node build.js
```

---

## 八、权限矩阵

### 8.1 页面访问权限

| 角色 | 等级 | 能否访问 | 数据范围 |
|------|:--:|:--:|------|
| `superAdmin`（超级管理员） | 6 | ✅ | 全部老师 |
| `operationLeader`（运营负责人） | 5 | ✅ | 全部老师 |
| `centerLeader`（中心负责人） | 4 | ✅ | 本中心老师 |
| `subjectLeader`（学科负责人） | 3 | ✅ | 本学科老师 |
| `gradeLeader`（年级小组长） | 2 | ✅ | 本年级老师 |
| `counselor`（辅导伙伴） | 1 | ❌ | — |

### 8.2 权限实现方案

**Phase 1（当前 PRD 范围）**：
- 路由守卫：`requiredRole: ROLES.GRADE_LEADER` → 角色等级 ≥ 2 的可见页面
- 数据过滤：**不做后端过滤**，所有 gradeLeader+ 用户看到全部团队数据
- 原因：当前团队规模小（<10 老师），全量数据对管理层都是透明的

**Phase 2（未来可扩展）**：
- 云函数 `getTeamData` 中根据 `ctx.currentUser` 的组织信息过滤数据
- 中心负责人只返回 `teacherCenter` 匹配的文档
- 学科负责人只返回 `teacherSubject` 匹配的文档

### 8.3 前端二次鉴权（防御性编程）

在 `daily-board.js` 的 `render()` 中：

```javascript
import { hasMinRole } from '../permission.js';

export async function render(container) {
  // 前端二次鉴权
  if (!hasMinRole('gradeLeader')) {
    container.innerHTML = `
      <div class="db-mgmt-empty">
        <p>🔒 仅年级组长及以上角色可访问</p>
      </div>`;
    return { unmount: () => {} };
  }
  // ... 正常渲染
}
```

---

## 九、验收清单

### 9.1 功能验收

| # | 验收项 | 预期结果 |
|---|--------|---------|
| AC1 | `gradeLeader` 登录 EduFlow → 左侧导航出现「📊 每日工作看板」 | ✅ 导航可见 |
| AC2 | `counselor` 登录 → 左侧导航无看板入口 → 直接访问 URL 被重定向 | ✅ 无权限 |
| AC3 | 点击导航进入看板 → 日期默认为今天 → 显示甘海凤的数据 | ✅ 数据加载 |
| AC4 | 4 个统计卡片显示正确数字（团队人数 1、总学生数 27、有效听课率 81%、作业完成率 0%） | ✅ 统计卡片 |
| AC5 | 团队汇总表显示一行数据 → 完成率 4% → 红色标记 | ✅ 团队汇总 |
| AC6 | 7 类圆点颜色正确（分类1=3人灰色、分类3=2人红色、分类4=16人红色、分类6=2人黄色） | ✅ 圆点颜色 |
| AC7 | 点击"▸ 详情"展开详情面板 → 显示 7 类统计表 → 显示学生明细 | ✅ 详情展开 |
| AC8 | 展开学生明细 → 27 个学生各字段正确 → 鑫宇显示 ✅已完成 | ✅ 学生明细 |
| AC9 | 切换日期到 2026-06-13 → 显示"暂无数据"空状态 | ✅ 空状态 |
| AC10 | 切换回今天 → 数据重新加载 → 正常显示 | ✅ 日期切换 |
| AC11 | 按学科筛选"数学" → 只显示甘海凤 → 按"全部学科"恢复 | ✅ 筛选 |
| AC12 | 点击列头排序 → 按完成率/有课人数等排序 | ✅ 排序 |

### 9.2 数据验证

| # | 验证项 | 验证方式 |
|---|--------|---------|
| DV1 | 云函数返回数据与 CloudBase 数据库一致 | 对比 `dailyboard.getTeamData` 返回 vs 数据库直接查询 |
| DV2 | 学生 `scheduleTime` 格式化正确 | epoch `1781434800000` → "10:00" |
| DV3 | `catSummary` 数据与 `students` 数组一致 | 分类人数 = 按 categoryId 分组计数 |
| DV4 | `doneRate` 计算 = `doneCount / needActionCount × 100` | 手动验算 |

---

## 十、附录

### 10.1 真实数据样本（2026-06-14，甘海凤）

```json
{
  "teacherName": "甘海凤",
  "teacherCenter": "郑州",
  "teacherGrade": "初三",
  "teacherSubject": "数学",
  "totalStudents": 27,
  "doneCount": 1,
  "doneRate": 4,
  "needActionCount": 24,
  "dayRates": {
    "hwDoneCount": 0,
    "listenCount": 22,
    "totalStudents": 27
  },
  "catSummary": {
    "1": { "done": 0, "total": 3 },
    "2": { "done": 0, "total": 0 },
    "3": { "done": 0, "total": 2 },
    "4": { "done": 0, "total": 16 },
    "5": { "done": 0, "total": 4 },
    "6": { "done": 1, "total": 2 },
    "7": { "done": 0, "total": 0 }
  },
  "students": [
    {
      "studentId": "281877",
      "studentName": "鑫宇",
      "className": "2026【初二思维】名师AI 一对一春季互动课",
      "scheduleTime": "1781404200000",
      "categoryId": 6,
      "isDone": true,
      "reportVersion": 1,
      "userPeriodLevel": "-",
      "homeworkStatus": 1,
      "homeworkStatusDesc": "已解锁未学习",
      "inClassOnlineDuration": "105min36s"
    }
    // ... 共 27 条，完整数据见 CloudBase 数据库
  ]
}
```

### 10.2 scheduleTime 格式化参考

```javascript
// epoch 毫秒字符串 → "HH:mm"
function formatScheduleTime(epochMs) {
  if (!epochMs) return '—';
  const d = new Date(parseInt(epochMs));
  if (isNaN(d.getTime())) return '—';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// 示例：
// "1781434800000" → new Date(1781434800000) → 2026-06-14 10:00 → "10:00"
// "1781404200000" → 2026-06-14 01:30  → "01:30"（注意：北京时间需 +8）
//
// ⚠️ 重要：scheduleTime 可能是 UTC 毫秒，格式化时注意时区
// 建议在客户端直接用本地时区格式化：
//   new Date(parseInt(epochMs)).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
```

### 10.3 完整 HTML 模板

```html
<div class="daily-board-page">
  <!-- 页面头部 -->
  <div class="db-mgmt-header">
    <h2>📊 每日工作看板</h2>
    <div class="db-mgmt-controls">
      <input type="date" id="db-mgmt-date" class="db-date-input">
    </div>
  </div>

  <!-- 筛选栏 -->
  <div class="db-mgmt-filters">
    <label>筛选：</label>
    <select id="db-filter-center">
      <option value="全部">全部中心</option>
    </select>
    <select id="db-filter-subject">
      <option value="全部">全部学科</option>
    </select>
    <select id="db-filter-grade">
      <option value="全部">全部年级</option>
    </select>
  </div>

  <!-- 统计卡片 -->
  <div class="db-mgmt-cards" id="db-mgmt-cards">
    <div class="db-card">
      <div class="db-card-value" id="db-card-teachers">—</div>
      <div class="db-card-label">团队人数</div>
    </div>
    <div class="db-card">
      <div class="db-card-value" id="db-card-students">—</div>
      <div class="db-card-label">总学生数</div>
    </div>
    <div class="db-card">
      <div class="db-card-value" id="db-card-listen-rate">—</div>
      <div class="db-card-label">有效听课率</div>
    </div>
    <div class="db-card">
      <div class="db-card-value" id="db-card-hw-rate">—</div>
      <div class="db-card-label">作业完成率</div>
    </div>
  </div>

  <!-- 表格操作栏 -->
  <div class="db-mgmt-table-toolbar">
    <span class="db-table-title">团队汇总</span>
    <button id="db-toggle-all" class="db-btn-text">展开全部</button>
  </div>

  <!-- 团队汇总表 -->
  <div class="db-mgmt-table-wrap">
    <table id="db-team-table" class="db-team-table">
      <thead>
        <tr>
          <th data-sort="teacherName">辅导老师</th>
          <th data-sort="teacherCenter">中心</th>
          <th data-sort="teacherGrade">年级</th>
          <th data-sort="teacherSubject">学科</th>
          <th data-sort="totalStudents">有课人数</th>
          <th data-sort="needActionCount">需行动</th>
          <th data-sort="doneCount">已完成</th>
          <th data-sort="doneRate">完成率</th>
          <th>7类明细</th>
          <th>有效听课率</th>
          <th>作业完成率</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody id="db-team-tbody">
        <tr><td colspan="12" class="db-loading-hint">⏳ 加载中...</td></tr>
      </tbody>
    </table>
  </div>

  <!-- 更新时间 -->
  <div class="db-mgmt-footer" id="db-mgmt-footer">
    <span class="db-update-time" id="db-update-time"></span>
  </div>
</div>

<!-- 页面级样式 -->
<style>
  /* ===== 管理看板样式 ===== */
  .daily-board-page { padding: 20px; max-width: 1400px; margin: 0 auto; }
  
  /* 头部 */
  .db-mgmt-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
  .db-mgmt-header h2 { margin: 0; font-size: 20px; }
  .db-date-input { padding: 6px 12px; border: 1px solid #d0d5dd; border-radius: 6px; font-size: 14px; }
  
  /* 筛选栏 */
  .db-mgmt-filters { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; font-size: 14px; }
  .db-mgmt-filters select { padding: 4px 8px; border: 1px solid #d0d5dd; border-radius: 4px; }
  
  /* 统计卡片 */
  .db-mgmt-cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
  .db-card { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; text-align: center; }
  .db-card-value { font-size: 28px; font-weight: 700; color: #1f2937; }
  .db-card-label { font-size: 13px; color: #6b7280; margin-top: 4px; }
  
  /* 表格工具栏 */
  .db-mgmt-table-toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .db-table-title { font-weight: 600; font-size: 15px; }
  .db-btn-text { background: none; border: none; color: #2196f3; cursor: pointer; font-size: 13px; padding: 4px 8px; border-radius: 4px; }
  .db-btn-text:hover { background: #e3f2fd; }
  
  /* 主表格 */
  .db-mgmt-table-wrap { overflow-x: auto; }
  .db-team-table { width: 100%; border-collapse: collapse; font-size: 13px; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; }
  .db-team-table th { background: #f9fafb; padding: 10px 8px; text-align: left; font-weight: 600; border-bottom: 2px solid #e5e7eb; white-space: nowrap; }
  .db-team-table th[data-sort] { cursor: pointer; user-select: none; }
  .db-team-table th[data-sort]:hover { background: #f0f0f0; }
  .db-team-table td { padding: 8px; border-bottom: 1px solid #f0f0f0; }
  .db-team-row { cursor: pointer; transition: background 0.15s; }
  .db-team-row:hover { background: #f9fafb; }
  .db-team-row.db-expanded { background: #e3f2fd; }
  
  /* 完成率标记 */
  .db-rate-badge { display: inline-block; padding: 2px 8px; border-radius: 10px; color: white; font-weight: 600; font-size: 12px; min-width: 36px; text-align: center; }
  
  /* 7类圆点 */
  .db-cat-dots { display: flex; gap: 2px; }
  .db-dot { font-size: 12px; }
  .db-dot-empty { opacity: 0.3; }
  
  /* 详情面板 */
  .db-detail-row td { padding: 0; }
  .db-detail-panel { padding: 16px; background: #fafafa; border-top: 2px solid #2196f3; }
  
  /* 分类统计表 */
  .db-cat-stats-table { width: 100%; border-collapse: collapse; margin-bottom: 12px; font-size: 13px; }
  .db-cat-stats-table th { background: #f0f0f0; padding: 6px 8px; text-align: left; }
  .db-cat-stats-table td { padding: 6px 8px; border-bottom: 1px solid #e5e7eb; }
  .db-cat-row:hover { background: #f5f5f5; }
  .db-undone-list { color: #f44336; font-size: 12px; max-width: 400px; }
  
  /* 学生明细 */
  .db-student-details { margin-top: 12px; }
  .db-student-details summary { cursor: pointer; font-weight: 600; font-size: 14px; color: #2196f3; padding: 4px 0; }
  .db-student-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
  .db-student-table th { background: #f0f0f0; padding: 4px 6px; text-align: left; }
  .db-student-table td { padding: 4px 6px; border-bottom: 1px solid #f0f0f0; }
  .db-student-row.db-student-done { background: #e8f5e9; }
  .db-cat-tag { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: 500; }
  
  /* 状态标签 */
  .db-status-done { color: #4caf50; }
  .db-status-waiting { color: #9e9e9e; }
  .db-status-ongoing { color: #2196f3; }
  .db-status-warn { color: #ff9800; font-weight: 600; }
  .db-status-pending { color: #757575; }
  
  /* 空状态/加载 */
  .db-loading-hint { text-align: center; color: #9e9e9e; padding: 40px !important; }
  .db-empty-hint { text-align: center; color: #9e9e9e; padding: 40px !important; }
  
  /* 底部 */
  .db-mgmt-footer { margin-top: 12px; text-align: right; }
  .db-update-time { font-size: 12px; color: #9e9e9e; }
  
  /* 响应式 */
  @media (max-width: 1200px) {
    .db-mgmt-cards { grid-template-columns: repeat(2, 1fr); }
  }
  @media (max-width: 768px) {
    .db-mgmt-cards { grid-template-columns: 1fr; }
    .db-mgmt-header { flex-direction: column; align-items: flex-start; gap: 8px; }
  }
</style>
```

### 10.4 关键风险与缓解

| 风险 | 缓解 |
|------|------|
| `ef-api/index.js` 的 handler 注册格式可能与文档假设不同 | 先读实际文件确认 handler 格式，按现有格式添加 |
| `scheduleTime` 时区问题导致时间显示偏差 | 使用 `new Date(parseInt(ms)).toLocaleTimeString('zh-CN', {...})` |
| 云函数部署后未生效 | 部署后等 1-2 分钟 CloudBase 热加载，或手动重启 |
| 历史日期数据量大（150天） | 当前只查单日，每月最多 10×31 = 310 个文档，每个 ~30KB，总计 < 10MB，云函数 6MB 内存限制内 |

---

> **文档版本**：v1.1（修正架构错误） | 2026-06-14
> **基于**：插件 v2.2.25 实际数据库结构 | EduFlow 现有架构
> **可交付给其他 AI 直接开发**
> **v1.0→v1.1 修正清单**：
> - §1.3 架构图：`tcb-admin-node: db.collection` → `ctx.db.collection`
> - §5.2 云函数实现：签名 `(ctx, data)` + `require('tcb-admin-node')` → `(data, currentUser, ctx)` + `ctx.db`
> - §5.3 路由注册：删除 `require` + `handlers` 手动注册 → 懒加载自动路由，无需改 index.js
> - §7.1 文件变更：删除「修改 index.js」条目
> - §7.2 Step 5：删除 index.js 修改步骤 → 确认自动路由生效
> - §7.2 Step 3a + §8.2：`requiredRole: 'gradeLeader'` → `ROLES.GRADE_LEADER`
