# 浏览器插件管理 — 数据模型

> 最后更新：2026-06-29

---

## 一、每日工作看板 — 排课数据

### 来源：POST /regularCourse/next/class/list

```javascript
{
  classId: string,           // 课次ID
  periodId: string,          // 讲次ID
  userId: string,            // 学员ID
  userName: string,          // 学员姓名
  courseName: string,        // 课程名称
  startTime: string,         // 开始时间 "2026-07-26 14:00:00"
  onlineStatus: number,      // 在线状态
  inClassOnlineDuration: number, // 在线时长(秒?)
  lessonOnlineStatus: string,    // 课堂在线状态
  lessonDuration: number,        // 课堂时长
  answerRate: number,            // 回答率
  firstAnswerCorrectRate: number,// 首答正确率
  unfocused: number,             // 不专注率(百分比)
  studentRemark: string,         // 备注名
}
```

### 缓存策略

| 层级 | 存储位置 | 生命周期 |
|------|---------|---------|
| 每日看板数据 | `sessionStorage` (`_nfDB.xxx`) | 同标签页 |
| 学情绑定表 | `chrome.storage.local` (`shell.binding_data`) | 永久（跨标签页/跨会话） |
| 扫描记录 | `sessionStorage` (`_nfMonitor.history[10]`) | 同标签页 |
| 不专注率去重 | `chrome.storage.local` (`_nfMonitor.wecom_dedup`) | 24h |

---

## 二、调课助手 — 排课数据模型

### 用户输入模板（Tab 分隔）

```
学员ID	日期	时间	课程名	星期(可选)
1239612	2026-07-26	14:00	数学暑假课	12345
```

### 解析后结构

```javascript
{
  userId: string,          // 学员ID
  date: string,            // 日期 YYYY-MM-DD
  time: string,            // 时间 HH:MM
  courseKeyword: string,   // 原始课程名 → 学科映射 + 学期提取
  weekDays: number[],      // 星期数字数组 [1,2,3,4,5]
  courseMapped: string,    // 映射后课程类型 "思维"
  semester: string,        // 提取的学期关键词 "暑假"
}
```

---

## 三、插件工作箱 — 模块注册表

### KNOWN_MODULES（background.js）

```javascript
const KNOWN_MODULES = [
  'report',      // 学习报告分析
  'dingtalk',    // 页面表格提取
  'tiaoke',      // 调课助手
  'updater',     // 更新助手
  'heatmap',     // 课程排期热力图
  'dailyboard',  // 每日工作看板
  'data-entry',  // 批量录入成绩
];
```

### 缓存存储

| 键 | 存储位置 | 说明 |
|----|---------|------|
| `shell.module_registry` | `chrome.storage.local` | 模块元数据列表 |
| `shell.module_registry_version` | `chrome.storage.local` | 版本戳（v2.2.132+） |
| `shell.enabled_modules` | `chrome.storage.local` | `{ moduleName: boolean }` |

---

## 四、学习报告 — 评价数据模型

### 四维评价（P1→P4 优先级递减）

```javascript
{
  mastery: { score, level },      // P1 掌握度
  answerRate: { score, level },   // P2 回答率
  listenDuration: { score, level },// P3 听课时长
  homeworkRate: { score, level },  // P4 作业完成率
}
```

### 5 档标签

| 标签 | 条件 |
|------|------|
| ⭐优秀 | 四维全高 |
| 👍认真 | 整体不错 |
| ⚠️需关注 | 部分偏低 |
| 🚨敷衍预警 | 多项低 |
| ❌敷衍+未掌握 | 严重偏低 |

---

## 五、CloudBase — teacher_daily_tasks

### 文档结构

```javascript
{
  _id: string,
  date: string,              // "2026-07-26"
  teacherName: string,
  teacherSubject: string,
  teacherGrade: string,
  // --- 6项上传字段 ---
  dayRates: {                // 当日两率
    effectiveListenRate: number,
    homeworkCompleteRate: number,
  },
  catSummary: {              // 分类统计
    total: number,
    cat1_noClass: number,
    cat2_inClass: number,
    cat3_noReport: number,
    cat4_good: number,
    cat5_normal: number,
    cat6_followUp: number,
    cat7_custom: number,
  },
  students: [{               // 学生明细
    studentId: string,
    studentName: string,
    onlineStatus: number,
    lessonDuration: number,
    answerRate: number,
    firstAnswerCorrectRate: number,
    unfocused: number,
    category: number,        // 1-7 分类
  }],
  uploadTime: string,
}
```
