# 浏览器插件管理 — API 接口参考

> 最后更新：2026-06-29
> 适用平台：ai-genesis.yuaiweiwu.com（爱芯后台）

---

## 一、爱芯平台 API

### 1.1 排课相关

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/prod-api/student-center-ai/ai/user/course/list?userId={id}&courseClassify=3` | 获取学员可选课程列表 |
| GET | `/prod-api/student-center-ai/ai/classtime/one?userClassTimeId={id}` | 获取单节课次详情 |
| GET | `/prod-api/student-center-ai/ai/classtime/template?courseId={id}` | 获取课程讲次模板 |
| POST | `/prod-api/student-center-ai/regularCourse/next/class/list` | 获取讲次排课列表（不专注率用） |
| POST | `/prod-api/student-center-ai/ai/book/cycle` | **排课/改约（同一个API）** |

#### POST book/cycle — 请求体

```json
{
  "userId": "1239612",
  "courseId": "4628",
  "aiCourseId": "1207",
  "periodId": "58726",
  "classHourCycles": [{
    "classTimeStart": "2026-07-26 14:00:00",
    "classTimeEnd": "2026-07-26 16:00:00",
    "classHourOrder": 1,
    "weeks": [1,2,3,4,5]
  }]
}
```

> **注意**：同一 userId+courseId+periodId 已存在 → 自动更新（改约）；不存在 → 新建（排课）。无需传 userClassTimeId。

#### courseList 返回字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 课程ID（courseId） |
| `title` | string | 课程名称 |
| `aiCourseId` | string | AI课程ID |
| `bookStatus` | number | 0=未排过, 1=已排过 |
| `courseClassify` | number | 课程分类（3=一对一互动课） |

---

### 1.2 课堂监控相关

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/prod-api/student-center-ai/ai/teacher/classroom/list` | 获取当前课堂列表（每日看板用） |

#### classroom/list 返回关键字段

| 字段 | 说明 |
|------|------|
| `lessonOnlineStatus` | 课堂在线状态 |
| `lessonDuration` | 课堂持续时长 |
| `periodId` | 讲次ID |
| `studentName` / `studentId` | 学生信息 |
| `courseName` | 课程名称 |

---

### 1.3 企微推送

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/prod-api/student-center-ai/common/teacher/wecom/send-self` | 推送消息到老师企微 |

#### 请求体

```json
{
  "content": "消息内容（支持\\n换行）"
}
```

#### 返回

```json
{ "code": "000000", "mesg": "处理成功" }
```

> **依赖**：老师已绑定企微 + 浏览器有有效爱芯 Cookie。

---

### 1.4 其他

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/prod-api/student-center-ai/ai/schoolCalendar?year=2026` | 获取校历（判断日期合法性） |
| POST | `/prod-api/student-center-ai/api/user/info` | 获取当前登录教师信息 |
| GET | `/prod-api/student-center-ai/ai/schedule?userId={id}` | 获取学员课表 |

---

## 二、调课助手 — 学科映射表

| 用户输入 | 映射到课程类型 |
|---------|--------------|
| 数学 | 思维 |
| 语文 | 人文 |
| 英语 | 演说 |
| 物理 | 科学 |
| 化学 | 实验 |

**学期关键词**：暑假、秋季、寒假、春季、期末、期中、冲刺

**禁止词（自动过滤）**：全科、S班

---

## 三、CloudBase 相关

| 用途 | 环境ID | 集合/路径 |
|------|--------|---------|
| 扩展托管 | `renewal-calendar-7ff2rtj4f876144` | `extensions/toolbox/` |
| 每日看板数据 | 同上 | `teacher_daily_tasks` |

### teacher_daily_tasks 集合

| 索引字段 | 说明 |
|---------|------|
| `date` | 日期 |
| `teacherName` | 教师姓名 |
| `teacherSubject` | 学科 |
| `teacherGrade` | 年级 |

---

## 四、学习报告 API（aitutor100）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `queryCoursePeriodReport` | 课程报告汇总 |
| GET | `queryComponentDialogueList` | 互动明细 |
| GET | `summary` | 摘要信息 |

> 通过短链 `s1.aiv5.cc/xxx` → 302 重定向获取 finalUrl，content.js 页面直连 fetch。
