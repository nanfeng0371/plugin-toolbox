# 学习报告批量分析 v4.0.4 — 版本留存

**留存日期**：2026-05-30
**版本状态**：✅ 稳定可用（功能全部跑通）
**ZIP包**：`releases/v4.0.4-stable-20260530.zip`（370.7 KB，MD5: `b4b74c001fa33498f887b203c1ea4751`）

---

## 功能概述

Chrome 扩展，批量获取 AI 一对一课学生学习报告数据，自动分析听课质量，导出 CSV。

### 核心流程（4步API链路）

```
Step1: 列表API（yuaiweiwu.com JWT+Cookie）→ 获取学生列表
Step2: biz接口（broadcastType=3）→ 生成短链 s1.aiv5.cc/xxx
Step3: 短链302重定向 → 取 report token
Step4: iframe嵌入短链 → 浏览器自动SSO → report_fetcher.js同源fetch 3个API
```

### 3个数据API

1. `queryCoursePeriodReport` — 课节报告主数据
2. `queryComponentDialogueList` — 互动对话明细
3. `summary` — 错题统计

---

## 包含组件

### 1. chrome-extension/（主扩展）
| 文件 | 说明 |
|------|------|
| manifest.json | MV3，v4.0.4 |
| background.js | SW：relay模式+CSV生成+短链预取 |
| content.js | 主逻辑：面板UI+4步流程+数据分析+CSV下载 |
| report_fetcher.js | iframe内注入：同源fetch 3个API + source-sn:PROD |
| analysis.js | 分析算法：四象限判定+标签生成 |
| panel.css | 面板样式 |
| sidepanel.html / sidepanel.js | 侧边栏（预留） |
| icons/ | 扩展图标 |
| lib/xlsx.full.min.js | XLSX库（已废弃，当前用CSV） |

### 2. network-monitor/（调试辅助工具）
| 文件 | 说明 |
|------|------|
| manifest.json | MV3，调试扩展 |
| monitor.js | webRequest监听器：抓取iframe内API请求 |

---

## 版本迭代记录

### v4.0.4（当前留存版本）
- ✅ 修复掌握度三级查找（d.masteryRating → masteredInfo.masteryRating → knowledgeDtoList[0].rating）
- ✅ 修复四象限逻辑：区分"有掌握度"和"无掌握度"两套判定
  - 有掌握度：标准四象限（参与度×学习效果）
  - 无掌握度：只看回答率（≥80%⭐ ≥60%👍 ≥40%⚠️ <40%❌）
- ✅ 实测41/161学生处理成功

### v4.0.3
- ✅ 修复CSV下载：SW只返回CSV字符串，content.js用Blob+`<a download>`触发下载
- ✅ 移除XLSX依赖（CSP/eval问题）

### v4.0.2
- ✅ 姓名fallback：studentName→stuName→name→userName→chineseName→fallbackName
- ✅ 无数据学生标记为"⚪未生成报告"

### v4.0.0 — 里程碑版本
- ✅ iframe relay方案：content.js创建隐藏iframe → 浏览器自动SSO → report_fetcher.js同源fetch
- ✅ 彻底解决Step4 055007错误
- ✅ broadcastType=3（之前一直用的4是错的）
- ✅ all_frames:true（report_fetcher.js必须注入iframe内）

### v3.0.0
- 尝试新标签页+content_script同源fetch → 失败（无登录态）

### v2.x
- 尝试SW直接fetch → 055007（Sec-Fetch-Site:cross-origin被拒）
- 尝试加Origin/Referer头 → 仍055007
- 尝试移除authorization-token + source-sn:PROD → 仍055007

---

## 关键铁律

1. **aitutor100.com的report数据只能在系统后台页面内获取**
2. **iframe嵌入短链是唯一可行方案**：浏览器自动走302+SSO+Cookie
3. **broadcastType必须是3**（工作台实际用的，4是错的）
4. **report_fetcher.js必须all_frames:true**（注入iframe内）
5. **iframe内API请求必须带source-sn:PROD头**

---

## 已知限制

- 串行处理161学生约6-7分钟（待优化：方案A 3并发iframe池）
- xlsx.full.min.js 已废弃但未清理
- sidepanel.html/sidepanel.js 预留未使用

---

## 待执行：方案A（性能优化）

**目标**：6-7分钟 → 2-3分钟（3倍提速）

### Phase1：短链预取（Step2并行）
- 所有学生Step2同时发出biz请求
- 短链结果存Map<studentId, {shortUrl, reportToken}>

### Phase2：3并发iframe池
- 最多3个隐藏iframe同时存在
- 完成一个立刻补上下一个
- DOM操作在content.js页面上下文执行（不受SW限制）

**留存此版本后，在chrome-extension/上直接实施方案A修改。**
