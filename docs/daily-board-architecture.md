# 辅导老师每日工作看板 — 系统架构设计 v2.1

> 架构师：高见远  
> 版本：**v2.1**（左右分栏UI + 150天数据保留）  
> 日期：2026-06-13  
> 基于：`docs/daily-board-prd-v1.md` v1.2  
> **v2.1 变更**：UI从全屏覆盖层改为左右分栏；数据保留 150 天；分隔条可拖拽  
> **v2.0 变更**：修复 v1 审查发现的 P0-致命×3 + P1-重要×4 + P2-小×3

---

## 目录

1. [整体架构](#1-整体架构)
2. [文件清单与路径](#2-文件清单与路径)
3. [数据结构（基于真实 API）](#3-数据结构基于真实-api)
4. [7 类分类引擎（修正版）](#4-7-类分类引擎修正版)
5. [程序调用流程](#5-程序调用流程)
6. [CloudBase 接入方案](#6-cloudbase-接入方案)
7. [Content UI 设计规格](#7-content-ui-设计规格)
8. [有序任务清单](#8-有序任务清单)
9. [依赖包与环境](#9-依赖包与环境)
10. [共享知识与约定](#10-共享知识与约定)
11. [已确认决策](#11-已确认决策)
12. [v2 修正记录](#12-v2-修正记录)

---

## 1. 整体架构

### 1.1 三层架构图

```
┌────────────────────────────────────────────────────────────┐
│                    浏览器（辅导老师）                         │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ 插件工作箱（壳）                                       │  │
│  │ ┌──────────────────────────────────────────────────┐ │  │
│  │ │ dailyboard 模块                                  │ │  │
│  │ │                                                  │ │  │
│  │ │ content.js (UI + 分类)    background.js (API)    │ │  │
│  │ │ ├─ StudentBinder          ├─ workApi()           │ │  │
│  │ │ ├─ Classifier7            ├─ fetchTodayData()    │ │  │
│  │ │ ├─ TaskBoard              ├─ cloudSync()  → ☁️   │ │  │
│  │ │ └─ UIRenderer             └─ alarmTimer() (P2)   │ │  │
│  │ │                                                  │ │  │
│  │ │ 复用 report 模块：                                │ │  │
│  │ │   ├─ workApi() 模式（fetch + credentials:include）│ │  │
│  │ │   ├─ extractPeriodId()  字段提取逻辑              │ │  │
│  │ │   └─ (Phase 2) FETCH_REPORT_DATA_DIRECT 消息路由  │ │  │
│  │ └──────────────────────────────────────────────────┘ │  │
│  └──────────────────────────────────────────────────────┘  │
└──────────────────────┬─────────────────────────────────────┘
                       │ HTTPS (content.js fetch)
                       │ + credentials: 'include'
                       │ 共享页面登录状态
                       ▼
┌────────────────────────────────────────────────────────────┐
│             爱芯 API (ai-genesis.yuaiweiwu.com)              │
│  ├─ /regularCourse/next/class/list  ← 学生排课数据         │
│  ├─ /authorization/api/user/bizInfo  ← 教师姓名            │
│  └─ (Phase 2) /ai/biz + report API  ← 完整四维评价        │
└────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────┐
│              CloudBase (renewal-calendar-7ff2rtj4f876144)   │
│  ├─ teacher_daily_tasks 集合                               │
│  └─ 索引: date + teacherName                               │
└──────────────────────┬──────────────────────────────────────┘
                       │ CloudBase JS SDK
                       ▼
┌────────────────────────────────────────────────────────────┐
│                    EduFlow 管理后台                          │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ /daily-board 页面                                     │  │
│  │ ├─ TeamOverview (团队汇总表)                          │  │
│  │ └─ DetailPanel  (详情展开)                            │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

### 1.2 技术选型

| 层面 | 选型 | 理由 |
|------|------|------|
| 扩展架构 | Chrome MV3 + Service Worker | 现有架构已确定 |
| 模块隔离 | Shadow DOM | 现有模式，CSS/JS 完全隔离 |
| 模块通信 | MessageBus (`chrome.runtime.sendMessage`) | 壳路由，模块解耦 |
| UI 渲染 | 原生 DOM API | 侧边栏 420px，列表型 UI，无需框架 |
| 数据存储(本地) | `chrome.storage.local` | 学情表持久化、打勾状态缓存 |
| 数据存储(云端) | CloudBase NoSQL (`@cloudbase/js-sdk`) | 与 EduFlow 同平台 |
| **API 调用** | **content.js 直接 fetch（推荐）** | **共享页面 cookie，与热力图模块一致** |
| 文件导出 | SheetJS (CDN) | 与磐石工具箱/报告模块一致 |
| 定时任务(P2) | `chrome.alarms` | 页面活跃时轮询上课状态 |

### 1.3 API 调用位置决策 ✅ 已决

| 方案 | 描述 | 风险 |
|------|------|------|
| content.js（✅选中） | 从内容脚本直接调爱芯 API | SW 没有页面 cookie，可能调不通 |
| background.js SW | 从 Service Worker 调 | 需要 `credentials: 'include'`，同源才有效 |

**结论**：采用 content.js 直接调 API，与热力图模块保持一致。background.js 只负责 CloudBase 同步和消息中继。

**关键修正**：API 调用方式从 v1 的「background.js SW 调 API」改为「content.js 直接调 API」。这是 P1-2 的修复，基于热力图模块的实际验证。

---

## 2. 文件清单与路径

### 2.1 新增文件

```
plugins/toolbox/modules/dailyboard/
├── module.json              # [新增] 模块声明
├── background.js            # [新增] CloudBase 同步 + 消息中继
├── content.js               # [新增] API 调用 + UI 渲染 + 7类分类
└── content.css              # [新增] 模块样式（.db- 前缀）
```

### 2.2 壳文件修改清单

| 文件 | 修改点 | 精确位置 | 说明 |
|------|--------|---------|------|
| `plugins/toolbox/manifest.json` | `web_accessible_resources` 新增 4 行 | 第 84 行之后（resources 数组末尾） | dailyboard 模块资源声明 |
| `plugins/toolbox/background.js` | `KNOWN_MODULES` 数组新增 `'dailyboard'` | 第 35 行 | 模块注册 |
| `plugins/toolbox/background.js` | `KNOWN_MODULE_BG_MAP` 新增映射 | 第 42-48 行 | `dailyboard: 'modules/dailyboard/background.js'` |
| `plugins/toolbox/content.js` | `CONFIG.knownModules` 数组新增 `'dailyboard'` | 第 28 行 | 侧边栏加载 |
| `plugins/toolbox/content.js` | `ICON_MAP` 新增 | 第 32 行附近 | `dailyboard: '📋'` |

### 2.3 EduFlow 新增文件

```
EduFlow/pages/daily-board/
├── index.html
├── index.js
└── index.css
```

### 2.4 各文件职责

| 文件 | 职责 |
|------|------|
| `module.json` | 模块元数据：名称/版本/入口 |
| `background.js` | CloudBase 连接管理、全量/增量同步、消息中继（不再调爱芯 API） |
| `content.js` | **爱芯 API 调用**（workApi）、7 类分类、UI 渲染、学情表绑定、打勾交互 |
| `content.css` | Shadow DOM 内样式 |

---

## 3. 数据结构（基于真实 API）

### 3.1 API 响应字段对照（关键修正）

> ⚠️ v1 使用的 `ScheduleItem` 字段名与实际 API 不一致，v2 已全部修正。

**真实 API 响应**（`/regularCourse/next/class/list`，`classStatus=2`，含 startDate/endDate 筛选）：

| API 字段 | 类型 | 示例值 | 用途 |
|----------|------|--------|------|
| `studentId` | number | `273719` | 主键，匹配学情表 |
| `chineseName` | string | `"冉冉"` | 学生姓名（v1 误用 `studentName`） |
| `classTimeStart` | string | `"2026-06-13 10:00:00"` | 上课开始（v1 误以为是 `HH:mm`） |
| `classTimeEnd` | string | `"2026-06-13 12:00:00"` | 上课结束 |
| `classTimeRange` | string | `"06月13日 10:00-12:00"` | 展示用（非计算用） |
| `classStatus` | number | `2`（已结束） | 课堂状态（v1 误用 `status`） |
| `reportVersion` | number | `0` 或 `1` | **0=未生成报告，1=已生成** |
| `userPeriodLevel` | string | `"A"` / `"B"` / `"C"` | P1 掌握度等级 |
| `inClassOnlineDuration` | string | `"118min38s"` | 听课时长 |
| `inClassInteractiveScenesCount` | number | `19` | 互动次数 |
| `homeworkCompletionStatus` | number | `3`（已完成） | 作业状态 |
| `personalizedTaskCompletionStatus` | number | `0` | 个性化任务 |
| `onlineStatus` | number | `0` | 在线状态 |
| `courseName` | string | — | 课程名称 |
| `bookingId` | number | — | **可用于报告 API 的 periodId** |

**教师信息 API**（`GET /authorization/api/user/bizInfo?id=3185`）：

| API 字段 | 示例值 | 用途 |
|----------|--------|------|
| `name` | `"甘海凤"` | 教师中文名 |
| `jobNumber` | `"A02747"` | 工号 |
| `userBizDtoList[0].segmentName` | `"郑州（一部）"` | 部门 |

**获取 cno**（`GET /student-center-ai/agent/getLoginParam`）：
```json
{ "cno": "3185" }  → 拼到 bizInfo?id=3185
```

### 3.2 内部数据结构 (修正后)

```typescript
// ===== 学情表（来自 Excel 粘贴） =====
interface StudentInfo {
  studentId: string;       // 必须有，来自学情表 Excel ID 列
  studentName: string;
  phone: string;
  grade: string;
  center: string;
}

// ===== 排课数据（来自 next/class/list API，字段名已修正） =====
interface ScheduleItem {
  studentId: string;       // API 字段: studentId (number → string)
  chineseName: string;     // API 字段: chineseName (v1 误用 studentName)
  classTimeStart: string;  // API 字段: classTimeStart "2026-06-13 10:00:00"
  classTimeEnd: string;    // API 字段: classTimeEnd   "2026-06-13 12:00:00"
  classStatus: number;     // API 字段: classStatus (v1 误用 status)
  reportVersion: number;   // API 字段: reportVersion (0=无, 1=有)
  userPeriodLevel: string; // API 字段: userPeriodLevel (A/B/C)
  courseName: string;      // API 字段: courseName
  bookingId: string;       // API 字段: bookingId (Phase 2 用于报告 API)
  inClassOnlineDuration: string;
  homeworkCompletionStatus: number;
}

// ===== 报告数据（Phase 1 简化版，Phase 2 完整版） =====
// Phase 1: 从 next/class/list 直接获取
interface ReportData {
  hasReport: boolean;        // reportVersion >= 1
  userPeriodLevel: string;   // A / B / C
}
// Phase 2: 通过 report 模块拿到完整四维评价
// interface FullReportData {
//   masterLabel: '⭐优秀' | '👍认真' | '⚠️需关注' | '🚨敷衍预警' | '❌敷衍+未掌握';
//   answerRate: number;
//   lessonDuration: number;
//   homeworkDone: boolean;
// }

// ===== 7 类分类 ID =====
type CategoryId = 1 | 2 | 3 | 4 | 5 | 6 | 7;

const CATEGORY_LABELS: Record<CategoryId, string> = {
  1: '今天有课-未上课',
  2: '今天有课-正在上课',
  3: '已下课-无报告',
  4: '已下课-表现好',
  5: '已下课-一般',
  6: '已下课-需跟进',
  7: '今天没课',
};

// ===== 分类结果 =====
interface ClassifiedStudent {
  studentId: string;
  chineseName: string;      // 来自 API
  phone: string;            // 来自学情表
  grade: string;            // 来自学情表
  center: string;           // 来自学情表
  courseName: string;
  classTimeStart: string;   // 原始格式 "2026-06-13 10:00:00"
  classTimeEnd: string;
  category: CategoryId;
  categoryLabel: string;
  userPeriodLevel: string | null;     // Phase 1 用
  hasReport: boolean;                 // Phase 1 用
  lessonStatus: 'upcoming' | 'ongoing' | 'finished' | 'none';
  minutesAfterClass: number | null;
}

// ===== 打勾状态 =====
interface TaskState {
  studentId: string;
  isDone: boolean;
  doneTime: string | null;
  rebooked: boolean | null;  // 仅第3类
}

// ===== CloudBase 文档（方案 A：带学科/年级字段，便于 EduFlow 按维度筛选）=====
interface DailyTaskDoc {
  _id?: string;
  teacherName: string;        // 如 "甘海凤"
  teacherJobNumber: string;    // 如 "A02747"
  teacherCenter: string;       // 如 "郑州（一部）"— 已有
  teacherSubject: string;      // 🆕 如 "数学"— 方案 A 新增
  teacherGrade: string;        // 🆕 如 "初一"— 方案 A 新增（多学科身份时为空）
  date: string;               // "2026-06-13"
  lastSyncTime: string;
  students: StudentTaskRecord[];
  summary: TaskSummary;
}

interface StudentTaskRecord {
  studentId: string;
  chineseName: string;
  phone: string;
  grade: string;           // 来自学情表
  center: string;          // 来自学情表
  courseName: string;
  classTimeStart: string;
  classTimeEnd: string;
  category: number;
  categoryLabel: string;
  isDone: boolean;
  doneTime: string | null;
  rebooked: boolean | null;
  userPeriodLevel: string | null;
  hasReport: boolean;
  lessonStatus: string;
  // 🆕 方案 A：EduFlow 按学科/年级分组用
  teacherSubject?: string;   // 冗余，便于按学科筛选
  teacherGrade?: string;    // 冗余，便于按年级分组
}

interface TaskSummary {
  totalWithCourse: number;
  totalNoCourse: number;
  categoryCount: Record<string, number>;
  doneCount: number;
  doneRate: number;
}
```

---

## 4. 7 类分类引擎（修正版）

### 4.1 Phase 1 数据源策略 ✅ 已决

| 数据 | Phase 1 来源 | Phase 2 增强 |
|------|-------------|-------------|
| 学生排课信息 | `next/class/list` API | 同 |
| 是否有报告 | API 的 `reportVersion` 字段（0/1） | 同 |
| 掌握度等级 | API 的 `userPeriodLevel` 字段（A/B/C） | 同 |
| 四维评价标签 | **无**（Phase 2 加） | 复用 report 模块 → `FETCH_REPORT_DATA_DIRECT` |
| 报告 Token | **不需要**（Phase 1 不调报告 API） | 复用 report 模块 → `FETCH_SHORT_URL` |

**关键修正**：v1 假设 `next/class/list` 返回 reportToken，实际上不返回。Phase 1 用 `reportVersion` + `userPeriodLevel` 做分类，Phase 2 再加完整报告 API 集成。

### 4.2 修正后的分类决策树

```javascript
/**
 * 7 类分类引擎（修正版）
 * 
 * 判定优先级（从高到低）：
 *   1. 没课 → 分类 7
 *   2. 未上课 → 分类 1
 *   3. 正在上课 → 分类 2
 *   4. 已下课 + 无报告 + 下课<30分钟 → 暂不分类（等待中）
 *   5. 已下课 + 无报告 + 下课≥30分钟 → 分类 3
 *   6. 已下课 + 有报告 + 掌握度好(A/A+) → 分类 4
 *   7. 已下课 + 有报告 + 掌握度中(B/B+) → 分类 5
 *   8. 已下课 + 有报告 + 掌握度差(C/无) → 分类 6
 */

function parseTimeString(timeStr) {
  // "2026-06-13 10:00:00" → Date
  // 兼容 ISO 和 "YYYY-MM-DD HH:mm:ss" 格式
  return new Date(timeStr.replace(' ', 'T'));
}

function classifyStudents(scheduleList, studentInfoList, prevStates) {
  const now = new Date();
  const infoMap = new Map(studentInfoList.map(s => [String(s.studentId), s]));
  const stateMap = new Map((prevStates || []).map(s => [s.studentId, s]));

  // 有课学生的 classDate 日期集合（用于判断没课）
  const withCourseIds = new Set();

  // Step 1: 分类有课学生
  const classified = scheduleList.map(item => {
    const sid = String(item.studentId);
    withCourseIds.add(sid);

    const info = infoMap.get(sid) || {};
    const prevState = stateMap.get(sid);
    const classStart = parseTimeString(item.classTimeStart);
    const classEnd = parseTimeString(item.classTimeEnd);

    let category, lessonStatus;

    // ──── 判定开始 ────
    if (now < classStart) {
      // 还没到上课时间
      category = 1;
      lessonStatus = 'upcoming';
    } else if (now >= classStart && now <= classEnd) {
      // 正在上课时间内
      category = 2;
      lessonStatus = 'ongoing';
    } else {
      // now > classEnd → 已下课
      lessonStatus = 'finished';
      const minsAfter = Math.floor((now - classEnd) / 60000); // ✅ P0-2 修正

      const hasReport = item.reportVersion >= 1;
      const level = item.userPeriodLevel || '';

      if (!hasReport) {
        // ✅ P0-2 修正：30 分钟延迟判定
        if (minsAfter < 30) {
          // 下课不到 30 分钟，暂不判为"无报告"→ 归入临时等待态
          // 在 UI 上显示为"已下课-等待报告"，category 仍用 2 的视觉但加标签
          category = 2; // 复用"正在上课"面板，加 (等待报告) 标签
          lessonStatus = 'finished_waiting';
        } else {
          category = 3; // 下课 ≥30 分钟仍无报告
        }
      } else {
        // 有报告 → 按掌握度分 3 档
        if (level === 'A+' || level === 'A') {
          category = 4; // 表现好
        } else if (level === 'B+' || level === 'B') {
          category = 5; // 一般
        } else {
          category = 6; // 需跟进（C 或空）
        }
      }
    }

    let minutesAfterClass = null;
    if (lessonStatus === 'finished' || lessonStatus === 'finished_waiting') {
      minutesAfterClass = Math.floor((now - classEnd) / 60000);
    }

    return {
      studentId: sid,
      chineseName: item.chineseName,           // ✅ P0-3 修正
      phone: info.phone || '',
      grade: info.grade || '',
      center: info.center || '',
      courseName: item.courseName || '',
      classTimeStart: item.classTimeStart,     // ✅ P0-3 修正（完整时间戳）
      classTimeEnd: item.classTimeEnd,
      category,
      categoryLabel: CATEGORY_LABELS[category],
      userPeriodLevel: item.userPeriodLevel || null,
      hasReport: item.reportVersion >= 1,
      lessonStatus,
      minutesAfterClass,
      isDone: prevState ? prevState.isDone : false,
      doneTime: prevState ? prevState.doneTime : null,
      rebooked: prevState ? prevState.rebooked : null,
    };
  });

  // Step 2: 找出没课学生（学情表有但今天没排课）
  const noCourse = studentInfoList
    .filter(s => !withCourseIds.has(String(s.studentId))) // ✅ P1-3 修正：用 studentId 匹配
    .map(s => ({
      studentId: String(s.studentId),
      chineseName: s.studentName,
      phone: s.phone,
      grade: s.grade,
      center: s.center,
      courseName: '',
      classTimeStart: '',
      classTimeEnd: '',
      category: 7,
      categoryLabel: '今天没课',
      userPeriodLevel: null,
      hasReport: false,
      lessonStatus: 'none',
      minutesAfterClass: null,
      isDone: (stateMap.get(String(s.studentId)) || {}).isDone || false,
      doneTime: (stateMap.get(String(s.studentId)) || {}).doneTime || null,
      rebooked: null,
    }));

  return [...classified, ...noCourse];
}
```

### 4.3 分类逻辑验证清单

| 场景 | classTime | reportVersion | userPeriodLevel | 下课分钟 | 期望分类 |
|------|-----------|---------------|-----------------|---------|---------|
| 还没上课 | 14:00-16:00，现在 13:00 | — | — | — | 1 |
| 正在上课 | 13:00-15:00，现在 14:00 | — | — | — | 2 |
| 下课 5 分钟无报告 | 13:00-13:50，现在 13:55 | 0 | — | 5 | 2+等待标签 |
| 下课 35 分钟无报告 | 11:00-13:00，现在 13:35 | 0 | — | 35 | 3 |
| 有报告+A | 结束 | 1 | A | — | 4 |
| 有报告+B | 结束 | 1 | B | — | 5 |
| 有报告+C | 结束 | 1 | C | — | 6 |
| 没课 | — | — | — | — | 7 |

---

## 5. 程序调用流程

### 5.1 数据刷新流程（核心修正）

```
User 点击"刷新数据"
  │
  ▼
content.js: 直接 HTTP fetch
  ├─ fetch('https://ai-genesis.yuaiweiwu.com/prod-api/student-center-ai/agent/getLoginParam')
  │    → 拿 cno → fetch bizInfo?id={cno} → 拿教师姓名（甘海凤）  ✅ P1-1 已决
  │
  ├─ fetch('https://ai-genesis.yuaiweiwu.com/prod-api/student-center-ai/regularCourse/next/class/list'
  │         + '?classStatus=2&startDate=2026-06-13 00:00:00&endDate=2026-06-13 23:59:59')
  │    → 拿到今日所有排课（含 reportVersion + userPeriodLevel）
  │    ✅ 注意：API 不需要分页参数，classStatus=2 默认返回全部
  │
  ├─ 读取 chrome.storage.local 中的学情表
  │
  ▼
content.js: classifyStudents(scheduleList, studentInfo, prevStates)
  │           ✅ P0-2 修正：30 分钟延迟判定
  │           ✅ P0-3 修正：字段名匹配实际 API
  │           ✅ P1-3 修正：studentId 精确匹配
  │
  ▼
content.js: renderTaskBoard() → 渲染 7 类面板
  │
  ├─ 保存到 chrome.storage.local（本地缓存）
  │
  ▼
content.js → sendMessage({ target:'dailyboard', action:'SYNC_TO_CLOUD', data })
  │
  ▼
background.js: DB.upsertDailyTask(teacherName, date, students, summary)
  │              → CloudBase collection('teacher_daily_tasks').add/set
  │
  ▼
background.js → content.js: { action:'SYNC_RESULT', data:{ success:true } }
```

### 5.2 打勾同步流程（P2-2 修正：增量更新）

```
User 点击 checkbox
  │
  ▼
content.js: 更新本地 TaskState → re-render（该行变绿 → 移至底部）
  │
  ├─ 第3类 → 弹窗确认"是否已重约课？" → 记录 rebooked 字段
  │
  ▼
content.js → sendMessage({ target:'dailyboard', action:'SYNC_ONE_STUDENT', data })
  │
  ▼
background.js: 
  │ ✅ P2-2 修正：使用 doc().update() 只更新数组中的单个元素
  │ （而非 v1 的 读全量→改一行→写全量）
  │
  ├─ 构建 update 对象:
  │   { "students.$[elem].isDone": true, 
  │     "students.$[elem].doneTime": now,
  │     "lastSyncTime": now }
  │   + arrayFilters: [{ "elem.studentId": studentId }]
  │
  ├─ 但 CloudBase NoSQL 的 doc().update() 不支持 $[] 位置操作符
  │   → 实际方案：用 CloudBase 的命令式更新
  │   
  │   替代方案（更精确）：
  │   const cmd = db.command;
  │   await db.collection('teacher_daily_tasks')
  │     .where({ teacherName, date })
  │     .update({
  │       lastSyncTime: new Date().toISOString(),
  │       // CloudBase NoSQL 不支持数组元素级更新...
  │       // 回退：读全量→改单元素→写全量，但只在 SW 中做，不影响 UI
  │     });
  │   
  │   最终方案：读全量→改单元素→写全量（SW 中异步，不阻塞 UI）
  │   ⚠️ 已知局限：CloudBase NoSQL 无原生数组元素级更新
  │   ⚠️ 缓解：文档较小（~120学生×~200字节≈24KB），读写很快
  │
  ▼
background.js → content.js: { action:'SYNC_ONE_RESULT', data:{ success:true } }
```

### 5.3 学情表绑定流程

```
User 打开侧边栏 → 看到"📎 绑定学情表"提示
  │
  ▼
User 从 Excel 复制 → 粘贴到 textarea
  │  格式：每行一个学生，列用 Tab 分隔
  │  必须包含：studentId | 姓名 | 手机号 | 年级 | 中心
  │
  ▼
content.js: parseStudentInfo(pastedText)
  │  split('\n') → 每行 split('\t') → StudentInfo[]
  │  校验：至少 3 列、第一列是纯数字（studentId）
  │  校验失败 → 显示错误行号 + 格式提示
  │
  ▼
content.js: chrome.storage.local.set({ dailyboard_student_info })
  │
  ▼
提示："已绑定 N 名学生"
```

### 5.4 EduFlow 管理看板加载流程

```
管理打开 EduFlow → /daily-board
  │
  ▼
index.js: cloudBase.collection('teacher_daily_tasks')
           .where({ date: today })
           .get()
  │
  ▼
角色过滤（Phase 1 全量，Phase 2 按角色）：
  - superAdmin / centerLeader / operationLeader → 全量
  │
  ▼
renderTeamOverview() → 表格每行：老师 | 有课人数 | 已完成 | 完成率 | 异常
  │
  ▼
onRowClick() → renderDetailPanel() → 7 类明细
```

### 5.5 教师姓名获取流程 ✅ 已决

```
content.js 在爱芯页面注入时:
  │
  ├─ Step 1: fetch('/student-center-ai/agent/getLoginParam')
  │           → 拿 { cno: "3185" }
  │
  ├─ Step 2: fetch('/authorization/api/user/bizInfo?id=3185')
  │           → 拿 { name: "甘海凤", jobNumber: "A02747" }
  │
  └─ Step 3: 缓存到 chrome.storage.local
             → 后续刷新直接用缓存
```

---

## 6. CloudBase 接入方案

### 6.1 SDK 加载方式

```
方案: background.js 中 importScripts 加载 cloudbase.full.js

├─ 尝试 CDN 加载:
│   importScripts('https://web-9gikcbug35bad3a8-1304825656.tcloudbaseapp.com/sdk/1.7.0/cloudbase.full.js');
│
├─ 如果 CSP 拦截 → 回退方案:
│   下载 cloudbase.full.js 到 plugins/toolbox/modules/dailyboard/lib/cloudbase.full.js
│   用相对路径 importScripts('modules/dailyboard/lib/cloudbase.full.js');
│
└─ 初始化:
    const app = cloudbase.init({ env: 'renewal-calendar-7ff2rtj4f876144' });
    await app.auth().anonymousAuthProvider().signIn();
    const db = app.database();
```

### 6.2 环境确认 ✅ P2-3 已决

**envId: `renewal-calendar-7ff2rtj4f876144`** — 与 EduFlow、工具箱、续班日历共用同一 CloudBase 环境。EduFlow 管理看板直接读取同一数据库。

### 6.3 数据库操作封装

```javascript
const DB = {
  collection: 'teacher_daily_tasks',

  /** 获取某老师某天的文档 */
  async getDoc(teacherName, date) {
    const res = await db.collection(this.collection)
      .where({ teacherName, date })
      .limit(1)
      .get();
    return res.data.length > 0 ? res.data[0] : null;
  },

  /** 全量写入/覆盖（方案 A：含 teacherSubject/teacherGrade） */
  async upsert(teacherName, date, students, summary, teacherInfo) {
    // teacherInfo = { teacherJobNumber, teacherCenter, teacherSubject, teacherGrade }
    const existing = await this.getDoc(teacherName, date);
    const doc = {
      teacherName,
      teacherJobNumber: teacherInfo.teacherJobNumber,
      teacherCenter: teacherInfo.teacherCenter,
      teacherSubject: teacherInfo.teacherSubject || '',   // 🆕 方案 A
      teacherGrade: teacherInfo.teacherGrade || '',     // 🆕 方案 A
      date,
      lastSyncTime: new Date().toISOString(),
      students,
      summary,
      updatedAt: new Date().toISOString(),
      ...(existing ? {} : { createdAt: new Date().toISOString() }),
    };
    if (existing) {
      await db.collection(this.collection).doc(existing._id).set(doc);
    } else {
      await db.collection(this.collection).add(doc);
    }
  },

  /** ✅ P2-2 修正：增量更新单学生状态 */
  async updateStudentStatus(teacherName, date, studentId, updates) {
    const doc = await this.getDoc(teacherName, date);
    if (!doc) return;
    const idx = doc.students.findIndex(s => s.studentId === studentId);
    if (idx === -1) return;

    // 修改目标学生
    Object.assign(doc.students[idx], updates, { updatedAt: new Date().toISOString() });
    
    // 重新计算统计
    const totalWithCourse = doc.students.filter(s => s.category !== 7).length;
    const doneCount = doc.students.filter(s => s.isDone).length;
    doc.summary.doneCount = doneCount;
    doc.summary.doneRate = totalWithCourse > 0 ? doneCount / totalWithCourse : 0;
    doc.summary.categoryCount = {};
    doc.students.forEach(s => {
      const k = String(s.category);
      doc.summary.categoryCount[k] = (doc.summary.categoryCount[k] || 0) + 1;
    });
    doc.lastSyncTime = new Date().toISOString();
    doc.updatedAt = new Date().toISOString();

    await db.collection(this.collection).doc(doc._id).set(doc);
  },

  /** EduFlow 管理端：获取今日所有老师数据 */
  async getTodayAll() {
    const today = new Date().toISOString().slice(0, 10);
    const res = await db.collection(this.collection)
      .where({ date: today })
      .get();
    return res.data;
  },
};
```

### 6.4 安全规则

```json
{
  "teacher_daily_tasks": {
    ".read": true,
    ".write": true
  }
}
```

> 一期简化：全量读写。Phase 2 接入自定义登录。

### 6.5 数据保留策略（v2.1 新增）

| 参数 | 值 |
|------|-----|
| 保留期限 | **150 天** |
| 清理方式 | Phase 1 手动 / Phase 2 云函数定时触发器 |
| 清理逻辑 | `db.collection('teacher_daily_tasks').where({ date: db.command.lt(cutoffDate) }).remove()` |
| cutoffDate | `new Date(Date.now() - 150 * 24 * 3600 * 1000).toISOString().slice(0, 10)` |

> 150 天覆盖完整学期（~5 个月），CloudBase 免费额度 2GB 足够（150天×10人×30KB ≈ 45MB）。

---

## 7. Content UI 设计规格

### 7.1 左右分栏布局（v2.1 重构）

```
┌──────────────────────────────────────────────────────────────────┐
│ 浏览器窗口                                                        │
│ ┌──────────────────────────────┬───────────────────────────────┐ │
│ │  爱芯后台（原页面）             │  #db-right-panel            │ │
│ │  body margin-right: 500px    │  ┌─────────────────────────┐ │ │
│ │                              │  │ A区: 标题栏 + 信息栏     │ │ │
│ │  原页面功能完整保留            │  │      + 工具栏            │ │ │
│ │                              │  ├─────────────────────────┤ │ │
│ │                              │  │ B区: 7类折叠面板         │ │ │
│ │                              │  │      (独立滚动)          │ │ │
│ │  ←── 可拖拽分隔条 ──→        │  ├─────────────────────────┤ │ │
│ │                              │  │ C区: 状态栏              │ │ │
│ └──────────────────────────────┴───────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

**关键参数**：
| 参数 | 值 |
|------|-----|
| 面板默认宽度 | 500px |
| 面板最小/最大宽度 | 420px / 55vw |
| 分隔条宽度 | 6px（含 2px 可视手柄） |
| 面板 z-index | 999998 |
| 打开/关闭动画 | 300ms ease |
| 窄窗口降级阈值 | < 900px → 浮动覆盖模式 |
| 面板注入位置 | `document.body`（非 Shadow DOM，style 用 Shadow DOM 隔离） |

> 详细 UI 交互规格见 `docs/daily-board-ui-spec.md` v2.0

```
Shadow Root
├── .db-header
│   ├── .db-date-label    "2026年06月13日 周五"
│   ├── .db-teacher-label "甘海凤（A02747）"
│   └── .db-actions
│       ├── [🔄 刷新数据]
│       ├── [📎 绑定学情表]
│       └── .db-last-sync  "上次同步: 13:45"
├── .db-summary-bar
│   ├── "有课 120人 · 已下课 90人 · 没课 40人"
│   └── "完成进度: ████████░░ 65/120 (54%)"
├── .db-student-binder（默认隐藏）
│   ├── textarea
│   ├── [解析] 按钮
│   └── .db-bind-result
├── .db-categories
│   ├── .db-cat-panel × 7（折叠面板）
│   └── .db-empty-hint "全部完成 🎉"
├── .db-error-toast（浮动提示）
└── .db-loading（加载中遮罩）
```

### 7.2 组件树（右侧面板内）

```
#db-right-panel (Shadow Root)
├── #db-divider                   ← 左边缘分隔条（可拖拽）
│   └── .db-divider-handle
├── .db-header-fixed              ← A 区（固定不滚动）
│   ├── .db-titlebar              ← "📊 每日工作看板" + ✕关闭
│   ├── .db-infobar               ← 日期 · 教师名 · 中心 · 学科 · 完成率
│   └── .db-toolbar               ← 搜索框 + 🔄刷新按钮
├── .db-scroll-area               ← B 区（独立滚动）
│   ├── .db-student-binder        ← 学情表粘贴区（首次使用/重新绑定时显示）
│   ├── .db-error-banner          ← API 错误横幅
│   ├── .db-empty-hint            ← 无排课提示
│   └── .db-categories
│       └── .db-cat-panel × 7     ← 折叠面板（1-7类，按编号排序）
│           ├── .db-cat-header    ← 标题 + 计数 + 展开/折叠按钮
│           └── .db-cat-body
│               └── .db-student-row × N  ← 学生行
│                   ├── label.db-checkbox-label
│                   ├── .db-student-info
│                   └── .db-status-tags
└── .db-footer-fixed              ← C 区（固定不滚动）
    ├── .db-sync-status           ← 🟢 同步状态
    └── (可选).db-refresh-btn     ← 底部刷新按钮
```

### 7.3 学生行 DOM

```html
<div class="db-student-row" data-id="273719" data-done="false">
  <label class="db-checkbox-label">
    <input type="checkbox" class="db-checkbox">
    <span class="db-checkmark"></span>
  </label>
  <div class="db-student-info">
    <span class="db-student-name">冉冉</span>
    <span class="db-student-meta">初一 · 10:00-12:00 · 数学</span>
  </div>
  <div class="db-status-tags">
    <span class="db-tag db-tag-level-a">A</span>        <!-- userPeriodLevel -->
    <span class="db-tag db-tag-has-report">有报告</span>  <!-- reportVersion=1 -->
    <!-- 或 -->
    <span class="db-tag db-tag-waiting">等待报告(5分钟)</span>  <!-- 下课<30分钟 -->
  </div>
</div>
```

### 7.4 样式规范

| 元素 | 规范 |
|------|------|
| 面板 | `position: fixed; top: 0; right: 0; height: 100vh; z-index: 999998` |
| 分隔条 | 宽 6px，手柄 2px 灰色 `#d0d5dd`，hover 蓝色 `#2196f3` |
| body 推开 | `margin-right: 500px; transition: margin-right 300ms ease` |
| 面板内 Shadow DOM | CSS 前缀 `.db-`，`all: initial` 重置外部样式 |
| 分类面板 | 可折叠，有未完成项→展开，全完成→自动折叠 |
| 已完成行 | `background: #e8f5e9`，checkbox 变绿 ✓ |
| 需跟进行(第3类) | `background: #fff3cd`，⚠️ 标签 |
| 高风险行(第6类) | `background: #f8d7da`，🔴 标签 |
| 等待中行 | `background: #e2e3e5`，"⏳ 等待报告"标签 |
| 进度条 | 渐变色（绿→黄→红按完成率） |
| 窄窗口降级(< 900px) | 浮动覆盖模式，半透明遮罩 `rgba(0,0,0,0.3)`，面板居中最大 500px |

---

## 8. 有序任务清单

### 8.1 Phase 1 任务（MVP）

```
T0: CloudBase 环境准备 ─────────────────────────── [30min，无依赖]
 │   确认 teacher_daily_tasks 集合存在
 │   创建索引: date + teacherName 复合索引
 │   测试 importScripts 加载 cloudbase.full.js
 │   ⚠️ 如果 CSP 拦截 → 下载 SDK 到本地 lib/ 目录
 │
 ├─ T1: 创建模块脚手架 ──────────────────────────── [20min，依赖 T0]
 │   │  创建 module.json / content.js / content.css / background.js
 │   │  修改壳文件：manifest.json + background.js + content.js
 │   │  验证侧边栏出现 dailyboard Tab
 │   │
 │   ├─ T2: 实现学情表绑定 ──────────────────────── [30min，依赖 T1]
 │   │   textarea 输入 → Tab 分隔解析 → StudentInfo[]
 │   │   校验：第一列纯数字（studentId）
 │   │   chrome.storage.local 存取
 │   │   绑定成功/失败提示
 │   │
 │   ├─ T3: 实现 API 调用层 ─────────────────────── [45min，依赖 T1]
 │   │   content.js 中 workApi() 函数
 │   │   调 getLoginParam → bizInfo → 拿教师姓名
 │   │   调 next/class/list → 拿今日排课
 │   │   API 数据格式化（字段名映射）
 │   │   ⚠️ 注意：从 content.js fetch，不在 SW 中调
 │   │
 │   ├─ T4: 实现 7 类分类引擎 ───────────────────── [30min，依赖 T3]
 │   │   classifyStudents() 决策树（含 30 分钟延迟）
 │   │   学情表 studentId 精确匹配
 │   │   单元测试：覆盖 4.3 节验证清单全部 8 种场景
 │   │
 │   ├─ T5: 实现 UI 渲染 ────────────────────────── [90min，依赖 T2, T4]
 │   │   **v2.1 更新**：左右分栏布局（非全屏覆盖层）
 │   │   创建右侧面板 DOM（#db-right-panel）
 │   │   分隔条拖拽交互（420px~55vw）
 │   │   body margin-right 推开页面
 │   │   面板 Shadow DOM + .db- 样式隔离
 │   │   7 类折叠面板 + 学生行 + checkbox + 状态标签
 │   │   进度概览 + 搜索栏 + 刷新按钮
 │   │   窄窗口(< 900px)降级为浮动模式
 │   │   打开/关闭动画（300ms ease）
 │   │
 │   ├─ T6: 实现打勾交互 ────────────────────────── [30min，依赖 T5]
 │   │   checkbox 切换
 │   │   第3类弹窗确认（是否已重约）
 │   │   已完成行变色+下移
 │   │   分类完成自动折叠
 │   │
 │   ├─ T7: 实现 CloudBase 同步 ──────────────────── [45min，依赖 T0, T4]
 │   │   background.js 中集成 @cloudbase/js-sdk
 │   │   全量同步（刷新后）
 │   │   增量同步（打勾后）
 │   │   同步成功/失败提示
 │   │   ⚠️ P2-2 注意：NoSQL 无数组元素级更新→读全量改单元素写全量
 │   │
 │   ├─ T8: 实现 EduFlow 管理看板 ────────────────── [60min，依赖 T0, T7]
 │   │   /daily-board 页面（HTML + JS + CSS）
 │   │   团队汇总表格（CloudBase 直读）
 │   │   Phase 1 不设权限过滤（全量显示）
 │   │   点击行展开 7 类明细
 │   │
 │   └─ T9: 集成测试 ─────────────────────────────── [30min，依赖 T1-T8]
 │       粘贴学情 → 刷新 → 分类 → 打勾 → 看板验证
 │       边界：无排课日、学情表为空、API 异常
 │
 └─ T10-T12: Phase 2（1-2天）
    T10: 完整报告 API（复用 report 模块 FETCH_REPORT_DATA_DIRECT）
    T11: 日期切换（历史日期查看）
    T12: Excel 导出（SheetJS）
```

### 8.2 依赖关系矩阵

| 任务 | 前置 | 预估 | 优先级 |
|------|------|------|--------|
| T0 CloudBase 准备 | — | 30min | P0 |
| T1 模块脚手架 | T0 | 20min | P0 |
| T2 学情表绑定 | T1 | 30min | P0 |
| T3 API 调用层 | T1 | 45min | P0 |
| T4 分类引擎 | T3 | 30min | P0 |
| T5 UI 渲染 | T2, T4 | **90min** | P0 | ← v2.1 更新，左右分栏增加 30min |
| T6 打勾交互 | T5 | 30min | P0 |
| T7 CloudBase 同步 | T0, T4 | 45min | P0 |
| T8 EduFlow 看板 | T0, T7 | 60min | P0 |
| T9 集成测试 | T1-T8 | 30min | P0 |
| **Phase 1 合计** | — | **~7h** | — | ← v2.1 更新，UI 分栏增加 1h |
| T10 报告 API | T4 | 60min | P1 |
| T11 日期切换 | T5 | 30min | P1 |
| T12 Excel 导出 | T5 | 30min | P2 |

---

## 9. 依赖包与环境

### 9.1 新增依赖

| 包 | 用途 | 加载方式 |
|----|------|---------|
| `@cloudbase/js-sdk` v1.7+ | NoSQL 操作 | importScripts CDN → 回退本地 lib/ |
| SheetJS (xlsx) | Phase 2 导出 | CDN 动态加载 |

### 9.2 CloudBase 环境 ✅ P2-3 已确认

| 配置 | 值 |
|------|-----|
| envId | `renewal-calendar-7ff2rtj4f876144` |
| 集合 | `teacher_daily_tasks` |
| 索引1 | `date_1_teacherName_1`（复合） |
| 索引2 | `teacherName_1_date_1`（复合） |
| 安全规则 | 全量读写（一期） |

---

## 10. 共享知识与约定

### 10.1 与 report 模块的关系

| 方面 | 说明 |
|------|------|
| workApi() 模式 | 复制 report 模块的 `workApi()` 实现（同域名、同认证方式） |
| 字段提取 | 复用 `extractPeriodId()` 逻辑（bookingId/periodId 等字段名映射） |
| Phase 2 报告 | dailyboard content.js 发消息 → `{ target: 'report', action: 'FETCH_REPORT_DATA_DIRECT' }` → 通过壳路由到 report 模块 |
| 数据独立 | dailyboard 不依赖 report 模块的状态，各自独立运作 |

### 10.2 命名约定

| 范围 | 约定 | 示例 |
|------|------|------|
| 消息 action | UPPER_SNAKE_CASE | `FETCH_TODAY_DATA` |
| CSS class | `.db-` + kebab-case | `.db-cat-panel` |
| Storage key | `dailyboard_` 前缀 | `dailyboard_student_info` |
| CloudBase 文档 | teacherName + date 唯一 | 通过 where 查询，不依赖 _id |

### 10.3 错误处理

```javascript
// Content 端统一错误展示
function showToast(msg, type = 'error') {
  const el = shadowRoot.querySelector('.db-toast');
  el.textContent = msg;
  el.className = `db-toast db-toast--${type} db-toast--visible`;
  setTimeout(() => el.classList.remove('db-toast--visible'), 3000);
}

// API 异常 → 显示 toast + 保留上次数据
// 同步失败 → 显示 toast + 队列重试（最多3次）
```

---

## 11. 已确认决策

| # | 决策 | 状态 |
|---|------|------|
| D1 | teacherId 用教师姓名（无重名） | ✅ 已决 |
| D2 | 排期 API 不需要按老师筛选 | ✅ 已决 |
| D3 | 未生成报告判定延迟 30 分钟 | ✅ 已决 |
| D4 | 管理看板实时同步（打勾即上传） | ✅ 已决 |
| D5 | API 从 content.js 直接调用（非 SW） | ✅ v2 修正 |
| D6 | 教师姓名从 bizInfo API 获取 | ✅ v2 修正 |
| D7 | 学情表用 studentId 匹配 | ✅ v2 修正 |
| D8 | Phase 1 用 reportVersion + userPeriodLevel 分类 | ✅ v2 修正 |
| D9 | CloudBase envId 统一用 renewal-calendar | ✅ v2 确认 |
| D10 | CloudBase 一期匿名登录 | ✅ 已决 |

---

## 12. v2.1 修正记录

| # | 问题 | 级别 | 修正 |
|---|------|------|------|
| UI-1 | 全屏覆盖层交互体验差，用户无法同时看到原页面 | 🔴架构 | **UI 重构为左右分栏：右侧面板 500px（position:fixed），原页面 body margin-right 推开。分隔条可拖拽（420px~55vw）。** |
| UI-2 | 全屏覆盖层无动画 | 🟡交互 | **新增 300ms ease 滑入/滑出动画，body margin 同步过渡。** |
| UI-3 | 窄窗口下全屏覆盖无降级 | 🟡边缘 | **新增 < 900px 降级：浮动覆盖模式，半透明遮罩，面板居中。** |
| UI-4 | 面板宽度不可调 | 🟡体验 | **新增分隔条拖拽交互，宽度记忆到 chrome.storage.local。** |
| DATA-1 | 数据保留期限未明确 | 🟡运维 | **明确为 150 天（覆盖完整学期），超出自动清理。** |

## 13. v2 修正记录

| # | 问题 | 级别 | 修正 |
|---|------|------|------|
| P0-1 | 报告评价数据缺失，7类分类依赖完整四维标签 | 🔴致命 | **Phase 1 用 next/class/list 的 reportVersion + userPeriodLevel 做简化分类。Phase 2 通过 report 模块消息路由获取完整四维评价。** |
| P0-2 | 30分钟延迟逻辑未实现，下课1分钟无报告直接判分类3 | 🔴致命 | **修正 classifyStudents(): now>classEnd + !hasReport + minsAfter<30 → 暂归"等待报告"（category 2 + 特殊标签），≥30分钟才入分类3。增加 finished_waiting 状态。** |
| P0-3 | ScheduleItem 字段名全错（studentName→chineseName, status→classStatus, startTime格式错） | 🔴致命 | **全部修正为 API 实际字段名。新增 API 字段对照表（§3.1）。** |
| P1-1 | 教师姓名获取标记为"待决"但 API 已验证可行 | 🟡重要 | **更新为已决。完整两步方案：getLoginParam→cno→bizInfo→name。** |
| P1-2 | API 调用位置（SW vs content.js）未确定 | 🟡重要 | **确定用 content.js 直接 fetch。与热力图模块一致。background.js 只做 CloudBase 同步。** |
| P1-3 | 没课学生匹配依赖 studentId，但未确认学情表有此列 | 🟡重要 | **用户确认学情表必须有 ID 列。用 String(studentId) 精确匹配。** |
| P1-4 | PRD Phase 1 不含报告 API，但分类依赖报告数据 | 🟡重要 | **PRD 与架构统一：Phase 1 用 API 自带字段做分类。架构 §4.1 明确数据源策略。** |
| P2-1 | 未考虑 API 分页 | 🟢小 | **确认 classStatus=2 默认返回全量。如果发现分页→加 page/size 参数循环获取。** |
| P2-2 | 打勾同步读全量改单字段写全量，效率低 | 🟢小 | **保持当前方案（CloudBase NoSQL 无原生数组元素级更新）。文档大小 ~24KB，不影响性能。** |
| P2-3 | CloudBase 环境是否与 EduFlow 一致 | 🟢小 | **确认 envId 统一为 renewal-calendar-7ff2rtj4f876144。** |

---

> **下一步**：架构审核通过后 → T0 开始：确认 CloudBase 集合 + 测试 importScripts 加载 SDK。
