# 手机遥控插件方案（CloudBase 实时监听）

> **状态：⏳ 待办（方案已定，未开发）**
> **创建时间：2026-06-26**
> **优先级：中**
> **预估工作量：1-2天**

---

## 一、要解决什么问题

在手机上发一条指令（文字或表单），电脑上的插件自动收到并执行任务（如：给学生改约课）。

不用回到电脑前操作，手机一句话搞定。

---

## 二、整体流程

```
[手机浏览器]                [CloudBase数据库]              [电脑插件]
    |                              |                           |
    | 输入指令："把思颖的课改到明天15点"  |                           |
    |──写入 commands 表────────────→|                           |
    |                              |──watch() 推送给订阅者──────→|
    |                              |                           | 收到指令
    |                              |                           | 解析：谁？改到几点？
    |                              |                           | 调改约API（已有）
    |                              |                           | 执行完毕
    |                              |←──标记 done:true──────────|
    |←──推送执行结果────────────────|                           |
    | 手机显示："✅ 思颖的课已改到明天15:00"
```

---

## 三、技术架构

### 3.1 数据库层

新建 `commands` 集合：

```javascript
{
  _id: "自动生成",
  teacherId: "王好国",        // 这条命令是给谁的（隔离50人）
  task: "reschedule",         // 任务类型：reschedule=改约 / refresh=刷新 / scan=扫描
  payload: {                  // 任务参数（结构化）
    studentName: "思颖",
    targetDate: "2026-06-27",
    targetTime: "15:00"
  },
  rawText: "把思颖的课改到明天15点",  // 原始文字（可选，用于AI解析）
  status: "pending",          // pending → executing → done / failed
  result: "",                 // 执行结果
  createdAt: 1700000000000,
  executedAt: null
}
```

**索引**：`teacherId + status + createdAt`

### 3.2 插件层（content.js）

**启动时订阅：**

```javascript
// 插件打开时建立 WebSocket 长连接
db.collection('commands')
  .where({ teacherId: currentTeacherName, status: 'pending' })
  .watch({
    onChange(snapshot) {
      // snapshot.docChanges 里有新增的命令
      snapshot.docChanges.forEach(change => {
        if (change.queueType === 'enqueue') {
          handleCommand(change.doc);
        }
      });
    },
    onError(err) { console.error('监听断开', err); }
  });
```

**命令处理函数：**

```javascript
async function handleCommand(cmd) {
  // 1. 标记为执行中
  db.collection('commands').doc(cmd._id).update({ status: 'executing' });

  try {
    // 2. 根据 task 类型分发
    switch (cmd.task) {
      case 'reschedule':
        await doReschedule(cmd.payload);  // 调已有的改约API
        break;
      case 'refresh':
        await doRefresh();                // 刷新今日看板
        break;
      // ... 更多任务
    }
    // 3. 标记完成
    db.collection('commands').doc(cmd._id).update({
      status: 'done',
      result: '成功：思颖的课已改到6月27日15:00',
      executedAt: Date.now()
    });
  } catch (err) {
    db.collection('commands').doc(cmd._id).update({
      status: 'failed',
      result: '失败：' + err.message
    });
  }
}
```

### 3.3 手机控制页面

**方案A（表单式，简单可靠）：**

```
┌─────────────────────────────┐
│  📱 插件遥控器               │
│  教师：[王好国 ▼]            │
│                             │
│  学生：[思颖 ▼]              │
│  改到：[6月27日] [15:00]     │
│                             │
│  [📋 发送改约指令]           │
│  [🔄 刷新看板]               │
│  [🔔 扫描不专注]             │
│                             │
│  最近指令：                  │
│  ✅ 改约思颖 → 6/27 15:00    │
│  ✅ 刷新看板                 │
└─────────────────────────────┘
```

**方案B（自然语言+AI解析）：**

```
┌─────────────────────────────┐
│  📱 插件遥控器               │
│  教师：[王好国 ▼]            │
│                             │
│  [把思颖的课改到明天15点___] │
│  [发送]                      │
│                             │
│  → AI解析中...               │
│  → {student:"思颖",          │
│     date:"2026-06-27",       │
│     time:"15:00"}            │
│  → 已发送到插件 ✓            │
└─────────────────────────────┘
```

**部署位置**：CloudBase 静态托管，手机浏览器直接打开。

---

## 四、50人隔离方案

| 环节 | 隔离方式 |
|------|---------|
| 插件订阅 | `where({ teacherId: 当前教师名 })` 只收自己的命令 |
| 手机页面 | 下拉选教师 / 专属链接带参数 `?teacher=王好国` |
| 数据库 | 每条命令带 `teacherId` 字段，互不干扰 |

---

## 五、已有的零件 vs 缺的零件

| 需要 | 现状 | 还差 |
|------|------|------|
| 数据库实时推送 | CloudBase watch() 可直接用 | ❌ 无 |
| 改约执行逻辑 | ✅ 插件已有 | ❌ 无 |
| 学生数据 | ✅ 198人已绑定 | ❌ 无 |
| 插件调爱芯API | ✅ 同源直连 | ❌ 无 |
| CloudBase SDK | ✅ lib/cloudbase.full.js 已有 | ❌ 无 |
| commands 集合 | ❌ 未创建 | 建集合+索引 |
| 插件 watch() 监听 | ❌ 未写 | ~30行代码 |
| 手机控制页面 | ❌ 未做 | HTML页面+CloudBase SDK |
| AI自然语言解析（方案B） | ❌ 未接 | AI API调用 |

---

## 六、改约的具体细节（需要想清楚）

手动改约流程：
1. 看学生当前课
2. 查可用空档时间
3. 选时间确认

自动改约时第2步怎么办：

| 处理方式 | 说明 | 难度 |
|---------|------|------|
| 你指定具体时间 | "改到明天15:00" → 直接用 | ⭐最简单 |
| 插件自动查空档 | 插件查可用时间，自动挑最近一个 | ⭐⭐ |
| 插件查完发回手机让你选 | 插件把可选时间发回数据库，手机展示让你选 | ⭐⭐⭐ |

---

## 七、开发步骤（建议顺序）

1. **建 commands 集合**（5分钟）
2. **插件加 watch() 监听**（~30行代码，先只打印到控制台，不执行）
3. **做最简手机页面**（一个按钮 → 写一条命令 → 看插件控制台是否收到）
4. **跑通链路后**，接入改约执行逻辑
5. **加结果回传**（插件执行完 → 写回 result → 手机页面显示）
6. **（可选）接 AI 自然语言解析**

---

## 八、注意事项

- **插件必须开着**：content.js 跑在网页里，标签页关了监听就断。平时工作时爱芯平台一直开着，没问题
- **WebSocket 重连**：CloudBase watch() 断线会自动重连，但需加 `onError` 处理
- **幂等性**：同一条命令可能被推送多次，插件需检查 `status !== 'done'` 再执行
- **权限**：commands 集合需要开读写权限（匿名登录已支持）
- **费用**：CloudBase watch() 免费额度足够50人使用

---

## 九、可扩展的任务类型

除了改约，这个架构还能遥控：

| 任务 | 说明 |
|------|------|
| `refresh` | 刷新今日看板数据 |
| `scan_focus` | 立即扫描不专注率 |
| `export` | 导出今日数据 |
| `notify` | 弹桌面通知 |
| `custom` | 自定义任意操作 |

以后加新功能只需在 `handleCommand` 的 switch 里加一个 case。

---

> **下次拿出来执行时，按「第七节 开发步骤」逐步做即可。**
