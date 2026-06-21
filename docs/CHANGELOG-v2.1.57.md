# 📦 插件工作箱 v2.1.57 版本更新日志

**发布日期**：2026年6月7日
**云端版本**：v2.1.53 → v2.1.57  
**Extension ID**：`nmpdifejooglhkcilhgjkhggbioalojk`

---

## 🔗 更新范围总览

| 版本 | 构建时间 | 影响模块 | 核心变更 |
|------|---------|---------|---------|
| v2.1.54 | 12:14 | 热力图（content.js） | 导出图片列头对齐修复 |
| v2.1.55 | 12:16 | 热力图（content.js） | 死代码清理 |
| v2.1.56 | 12:25 | 热力图（3文件） | 学员姓名 → 备注名 |
| **v2.1.57** | **13:33** | **学习报告（2文件）** | **iframe预检 + SW降级 + 持久化** |

---

## 🆕 v2.1.57 核心新功能（学习报告模块）

### 1. 🛡️ iframe 短链预检（Plan B）

**问题**：偶发短链重定向异常，iframe 无法到达报告页，用户需等待 40 秒后才报超时。

**修复**：
- 创建 iframe 前先调用 `fetchShortUrl` 检查短链最终落点
- 若落点不是报告页（`next.aitutor100.com`）则**秒级跳过**，不再干等超时
- `fetchShortUrl` 现在返回 `finalUrl`，供预检使用

**影响文件**：
- `modules/report/content.js`：`checkShortLinkAndCreateIframe()` 新增预检逻辑
- `modules/report/background.js`：`fetchShortUrl` 返回 `finalUrl`

---

### 2. 🔄 SW 降级直连（Plan A）

**问题**：iframe 方案因网络/认证瞬时异常超时后，数据获取彻底失败。

**修复**：
- iframe 超时（40秒）后 Service Worker 自动接管
- SW 直接调用 3 种报告 API（`queryCoursePeriodReport` + `summary`）返回数据
- 作为降级兜底方案，用户无感知切换

**影响文件**：
- `modules/report/background.js`：新增 `FETCH_REPORT_DATA_DIRECT` handler
- `modules/report/content.js`：iframe 超时 → 发 `FETCH_REPORT_DATA_DIRECT` 消息

---

### 3. 📁 分析结果持久化存储

**问题**：分析完成后关闭侧边栏/刷新页面，结果丢失，显示空白。

**修复**：
- 分析完成自动存入 `chrome.storage.local`（key: `heatmap_last_result`）
- 重新打开侧边栏自动恢复上次数据
- 状态栏显示：`📁 已恢复上次分析 | 144个学生 | 5分钟前`

**影响文件**：
- `modules/report/content.js`：`saveAnalysisResult()` + `restoreAnalysisResult()`

---

### 双重防御效果

```
短链落点不对 → Plan B 预检拦截，秒级跳过 ⚡
      ↓
iframe 超时    → Plan A SW 代理调 API，自动兜底 🔄
      ↓
两者都失败    → 才记录错误（与之前相同）❌
```

---

## 🔧 v2.1.56 变更（热力图模块）

### 全域 studentName → remarkName 字段切换

**问题**：热力图所有显示「学员姓名」的地方使用 `studentName`（昵称），用户实际工作中更关注 `remarkName`（备注名）。

**修复**：所有显示处改为 `s.remarkName || s.studentName`（备注名优先，昵称兜底）；去重逻辑改用纯 `s.studentId`。

**影响文件**（3文件，26处）：
- `modules/heatmap/background.js`：数据处理层（去重key→studentId，显示值→remarkName）
- `modules/heatmap/content.js`：UI层（表格/CSV/异常/筛选/导出图片）
- `modules/heatmap/heatmap-fullscreen.js`：全屏热力图（日期格子+异常列表）

**影响视图**：
- 📊 仪表盘异常列表 → 备注名
- 🔍 排课明细表格+CSV → 备注名
- 🗺️ 全屏热力图异常区域 → 备注名
- 📷 导出图片标题+表格+文件名 → 备注名
- 🏷️ 学员筛选下拉 → 备注名

---

## 🔧 v2.1.55 变更（代码清理）

### 死代码清理

- 删除 `getMonday()` 函数（9行，日历热力图删除后遗留）
- 修复章节编号缺口（3→4→5→6 改为 1→2→3→4→5）
- 确认 `hmEndY` 残留已清零（Grep 零匹配）

---

## 🔧 v2.1.54 变更（导出图片修复）

### 导出日历图片列头对齐修复

**问题**：导出日历图片中，表头（日期/星期/课节名称/时段/讲次）与下方数据行左右错位。

**根因**：表头用 `textAlign: center`，数据行用 `textAlign: left` + 4px 偏移，起点不同导致错位。

**修复**：表头改为 `textAlign: left` + `fillText(..., colX + 4, ...)`，与数据行保持一致。

---

## 📊 版本对比速览

| 功能 | v2.1.53（云端旧版） | v2.1.57（当前新版） |
|------|---------------------|---------------------|
| 热力图学员显示 | studentName（昵称） | remarkName（备注名）✅ |
| 导出图片列头 | 错位❌ | 对齐✅ |
| 学习报告-iframe预检 | 无（等40秒超时） | 秒级跳过✅ |
| 学习报告-SW降级 | 无（超时后失败） | 自动兜底✅ |
| 学习报告-结果持久化 | 无（关闭即丢失） | 自动恢复✅ |
| 代码死代码 | getMonday残留 | 已清理✅ |

---

## 🚀 升级指南

### 方式一：Chrome/Edge 自动更新
扩展会自动检测 `update.xml` 并提示更新（下次浏览器启动时）。

### 方式二：手动重新加载
1. 打开 `edge://extensions/`（或 `chrome://extensions/`）
2. 找到「插件工作箱」→ 点击「重新加载」
3. 确认版本显示 `2.1.57`

### 方式三：夸克浏览器开发者模式
加载 `dist/extensions/toolbox/toolbox-v2.1.57-quark.zip`

---

## 🔗 相关链接

- **更新检查 URL**：https://renewal-calendar-7ff2rtj4f876144-1259283480.tcloudbaseapp.com/extensions/toolbox/update.xml
- **CRX 下载**：`dist/extensions/toolbox/toolbox-v2.1.57.crx`
- **夸克版**：`dist/extensions/toolbox/toolbox-v2.1.57-quark.zip`

---

## 📝 完整版本链

```
v2.1.53（12:08）→ v2.1.54（12:14）→ v2.1.55（12:16）→ v2.1.56（12:25）→ v2.1.57（13:33）
```

**推荐**：直接从 v2.1.53 升级到 v2.1.57（包含全部4个增量版本的所有修复）
