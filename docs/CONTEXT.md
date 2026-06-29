# 浏览器插件管理项目 — 上下文文档

## 一句话描述
Chrome 扩展管理工作台，统一管理多个辅导老师效率工具子插件（学习报告分析、调课助手、页面表格提取、网络监控调试）。

## 当前状态
- **项目版本**：v2.2.122（壳扩展工作台层级）
- **最后更新**：2026-06-29
- **最新构建**：插件工作箱（壳）v2.2.122，学习报告 v5.3.1，调课助手 v4.3.0，批量录入 v1.1.0

## 归属于该项目的完整插件清单

| # | 插件名称 | 类型 | 版本 | 目录位置 | 状态 |
|---|---------|------|------|---------|------|
| 1 | 插件工具箱（壳） | 核心插件 | v2.2.122 | `plugins/toolbox/` | ✅稳定 |
| 2 | 学习报告批量分析 | 嵌入+独立双版 | v5.3.1 | `plugins/report/` + `modules/report/` | ✅稳定 |
| 3 | 页面表格提取 | 嵌入+独立双版 | v1.0.2 | `plugins/dingtalk/` + `modules/dingtalk/` | ✅稳定 |
| 4 | 调课助手 | 嵌入模块 | v4.3.0 | `plugins/toolbox/modules/tiaoke/` | ✅稳定 |
| 5 | 课程排期热力图 | 嵌入模块 | v1.0.0 | `plugins/toolbox/modules/heatmap/` | ✅稳定 |
| 6 | 每日工作看板 | 嵌入模块 | v2.2.100 | `plugins/toolbox/modules/dailyboard/` | ✅稳定 |
| 7 | 批量录入成绩 | 嵌入模块 | v1.1.0 | `plugins/toolbox/modules/data-entry/` | 🆕新增 |
| 8 | **磐石工具箱** | **独立外部插件** | v1.0.35 | `D:\Claw\磐石工具箱\` | ✅稳定 |
| — | 网络监控调试 | 调试辅助 | v1.1.0 | `plugins/devtools/` | 🔧辅助 |
| — | API接口监听器 | 调试辅助 | v1.3.0 | `plugins/api-monitor/` | 🔧调试 |

> **说明**：#6 磐石工具箱虽然物理位置在项目目录外（`D:\Claw\磐石工具箱\`），但由「浏览器插件管理」项目统一管理和维护，是本项目的一部分。

## 技术栈
- **平台**：Chrome Extension MV3（Manifest V3）
- **语言**：纯 JavaScript（无框架，无构建工具）
- **导出**：CSV（UTF-8 BOM，Excel 直接打开）
- **打包**：build.js（纯 Node.js ZIP + .crx 签名，自动版本号管理：patch 自动递增）
- **托管**：CloudBase 静态托管（`update.xml` 自动更新）

## 完整项目结构（D:\Claw\）

```
D:\Claw\
├── 浏览器插件管理\              ← 📦 项目根目录（记忆系统在这里）
│   ├── plugins/
│   │   ├── toolbox\             ← 插件1：插件工具箱（壳）v2.2.99
│   │   │   └── modules/
│   │   │       ├── report\      ← 插件2：学习报告分析（嵌入版）v5.3.1
│   │   │       ├── dingtalk\    ← 插件3：页面表格提取（嵌入版）v1.0.2
│   │   │       ├── tiaoke\      ← 插件4：调课助手 v4.0.0（嵌入版）
│   │   │       ├── updater\     ← 更新助手（检查更新 UI + 安装进度）
│   │   │       └── heatmap\     ← 插件5：课程排期热力图 v1.0.0
│   │   ├── report\              ← 插件2：学习报告分析（独立版）v5.3.1
│   │   ├── dingtalk\            ← 插件3：页面表格提取（独立版）v1.0.2
│   │   ├── devtools\            ← 辅助：网络监控调试 v1.1.0
│   │   └── api-monitor\         ← 调试：API接口监听器 v1.3.0
│   ├── native-host\             ← Native Messaging 本地服务
│   ├── dist/                    ← 打包产物
│   ├── docs/                    ← 项目文档（CONTEXT.md 等）
│   └── .workbuddy/memory/       ← 🔑 项目级记忆（涵盖所有插件）
│
├── 磐石工具箱\                  ← 插件6：独立外部插件 v1.0.35
│   （归属于「浏览器插件管理」项目管理，但物理位置在外部）
│
├── EduFlow\                     ← ❌ 不是本项目（禁止触碰）
├── 团队建设\                    ← ❌ 不用管
└── 测试6.5\                     ← ❌ 不用管
```

> **归档说明**：`学习报告获取/`、`调课功能/`、`调课功能-v1~v3` 已于 2026-06-10 删除（功能已集成，备份至 `releases/archive/`）。

## 子插件详情

### 学习报告批量分析（子插件A）— v5.3.1 ✅稳定

**访问入口**：
- 工作台：https://ai-genesis.yuaiweiwu.com
- 报告域：https://next.aitutor100.com（SW 内同源 fetch）
- 短链域：https://s1.aiv5.cc（SSO 跳转）

**核心架构 — 3步数据链路（v5.3.0+）**：
1. Step1：FETCH_STUDENT_LIST → 工作台 API 拿学生列表
2. Step2：biz 接口（broadcastType=3）→ 短链 `s1.aiv5.cc/xxx`，content.js 页面直连 fetch 获取 finalUrl
3. Step3：SW 内 30 并发直接 fetch 3 个报告 API（queryCoursePeriodReport + queryComponentDialogueList + summary）

**性能优化**（v5.3.0）：
- 短链预取：content.js 页面直连 fetch（biz API + 重定向），获取 finalUrl
- SW 批量获取：30 并发直接 fetch(API_URL)，330 人从 16 分钟降到 25 秒
- 手机号获取：content.js 直连 `student/info` API，并发 20

**评价体系**（v5.1.0）：
- 四维优先级：掌握度(P1) → 回答率(P2) → 听课时长(P3) → 作业完成(P4)
- 5 档主标签：⭐优秀 / 👍认真 / ⚠️需关注 / 🚨敷衍预警 / ❌敷衍+未掌握
- CSV 输出：18 列精简布局

### 插件工作箱（壳）（子插件B）— v2.2.122 ✅稳定

**核心架构**：
- manifest V3，popup 弹窗 + content script 注入侧边栏
- background.js：模块注册表（KNOWN_MODULES）+ 消息中继路由
- content.js：侧边栏 UI（Tab 切换 + 模块懒加载 `import()` + 模块卡片）
- CSS 以 `.tb-` 前缀，不污染宿主

**Phase1（v2.0.x）**：侧边栏框架 + 首页仪表盘
**Phase2（v2.0.x~v2.1.x）**：✅ 学习报告 + 页面表格提取嵌入壳扩展，统一侧边栏入口，Shadow DOM 隔离，消息总线路由
**Phase3（v2.1.9+）**：✅ 调课助手 v4.0 集成，成为第三个模块 Tab，自然语言调课 + 批量执行
**Phase4（v2.1.14+）**：✅ 调课解析器升级为智能字段分类器（支持多分隔符、相对日期、字段乱序）
**Phase5（v2.1.15+）**：✅ Tab 栏自适应收缩（三级：正常→仅图标→更多下拉）
**Phase6（v2.1.19+）**：✅ 使用统计管道接入（三个子插件自动累加写入 chrome.storage.local）
**Phase7（v2.1.22~v2.1.23）**：✅ 代码质量全量修复（var→let 500+处、startBatchFetch 重构、CSS 变量化、常量提取、try-catch 容错）；v2.1.23 Hotfix 修复悬浮按钮 z-index 模板字符串 Bug
**Phase8（v2.1.24~v2.1.39）**：✅ Native Messaging 自更新架构（PyInstaller exe + ping/check/update 三命令 + 检查更新 UI Tab + CDN update.json 版本检测）；v2.1.27 BugFix 修复 install.bat UTF-8 乱码 + HTTP 416 三重试策略；v2.1.28 CloudBase 部署路径修正 + 下载链接优化（固定 toolbox-latest.zip）；v2.1.29~v2.1.32 web_accessible_resources 兼容性终极修复（逐文件精确列举 23 个资源文件）；v2.1.34~v2.1.36 路径检测修复（PyInstaller `__file__` → `sys.executable`）；v2.1.37~v2.1.38 config.json 精确路径机制（install.bat 写入绝对路径）；v2.1.39 ✅ 同事端到端自动更新测试通过
**Phase9（v2.1.40~v2.1.53）**：🆕 课程排期热力图模块（仪表盘+全屏热力图+导出日历图片），含大量迭代修复：NaN:NaN 时间戳兼容、CSP 内联脚本拦截、非排课日斜条纹视觉区分、多周日期级热力图、导出日历图片重构（目前保留排课详情表）
**Phase10（v2.1.73）**：✅ SW 批量获取报告架构重构（v5.3.0），完全替代 iframe 池方案，SW 内 30 并发直接 fetch API，330 人从 16 分钟降到 25 秒（35 倍加速）
**Phase11（v2.1.74~v2.1.76）**：🔧 dingtalk 模块下载功能优化（v2.1.74 CSV 改 Excel，v2.1.75 修复 XLSX is not defined 报错，v2.1.76 发布热修复）

**关键修复**：
- v2.0.9：壳 content.js 消息转发漏了 `type` 格式 relay 消息
- v2.1.11：Token 检测 ES Module 中 sendMessage Promise 永久 pending（改用回调）
- v2.1.17：更多按钮下拉被 overflow 容器剪切（改为 Portal 方案，挂 body）
- v2.1.22：代码质量全包修复（P0×5 + P1×7 + P2×9，共22项）
- v2.1.23：悬浮按钮 z-index 模板字符串 Bug（`' + Z_MAX + '` → `${Z_MAX}`）
- v2.1.27：install.bat UTF-8 乱码（添加 chcp 65001）+ native-echo.py HTTP 416 错误（三重试策略）
- v2.1.28：CloudBase 部署路径修正（`dist/extensions/toolbox` → `extensions/toolbox`）+ 下载链接固定为 `toolbox-latest.zip`
- v2.1.29~v2.1.32：web_accessible_resources 兼容性修复（Edge 企业版不支持 glob 通配符 → 逐文件精确列举 23 个资源文件）+ install.bat GBK 编码终极修复（CMD 解析器在 chcp 前以 GBK 读取 → 源文件直接保存为 GBK）
- v2.1.33：自动更新端到端测试部署（同事本地 v2.1.32 → 云端 v2.1.33 触发更新流程）

### 调课助手（嵌入模块）— v4.3.0 ✅稳定

- 自然语言调课解析（智能字段分类器：userId/讲次/日期/时间/课程名）
- 支持相对日期（今天/明天/后天/周X/下周X）
- **排课功能**：自定义星期排课 + Excel模板下载 + 本地格式校验
- **本地格式校验**（v4.3.0）：ID/日期/时间/课程名/星期全面校验，有错误禁止提交
- 3 并发批量执行
- 学员信息簿（Excel 导入）
- 历史记录
- Shadow DOM 隔离

### 每日工作看板（嵌入模块）— v2.2.100 ✅稳定

- 爱芯后台页面内嵌看板，实时监控学生上课状态
- 不专注率主动提醒（铃铛开关 + 每20分钟扫描 + 桌面通知）
- 课节视角（日期范围 + 关键字过滤 + 列头排序）
- 学情绑定表（姓名/备注名/ID/手机号）

### 批量录入成绩（嵌入模块）— v1.1.0 🆕新增

- Excel 模板下载 → 填写 → 粘贴 → 解析 → 一键批量录入学生成绩
- 支持考试类型/学科/成绩形式的白名单校验
- 成绩内容格式匹配：分数应有数字、等级应为字母、排名应为纯数字
- 5 并发执行 + 失败自动重试一轮
- 姓名自动获取（绑定表缓存 → API 批量查询）
- 有格式错误时禁用提交按钮

### 页面表格提取（子插件C）— v1.0.2 ✅稳定

- 一键提取网页表格数据
- 支持自动滚动、智能去重、自动下载 Excel（v2.1.74 起，通过 SW GENERATE_TABLE_EXCEL handler 生成）
- 已嵌入壳扩展作为模块 Tab

### 网络监控调试（子插件D）— v1.1.0 🔧辅助工具

- 监听工作台点击报告按钮后的完整网络请求序列
- 使用 Chrome DevTools Protocol（debugger 权限）
- 用于开发调试，非日常使用

### 课程排期热力图（嵌入模块）— v1.0.0 🆕新增

- 侧边栏仪表盘视图：统计卡片 + 过载/闲置 Top5 + 异常检测面板
- 全屏热力图：`chrome.tabs.create` 打开独立页面，多周日期级渲染
- 排课明细面板：按日期下钻、5 列精简表格（姓名/ID/讲次/时段/在线）、CSV 导出
- 导出日历图片：Canvas 渲染排课详情表 + 统计信息，支持 A4/标准尺寸

### 磐石工具箱（独立外部插件）— v1.0.35 ✅稳定

> **定位**：教学管理辅助工具，独立于插件工具箱之外，但由本项目统一管理。
> **物理位置**：`D:\Claw\磐石工具箱\`

**核心功能**：
- 批量查询班级在班人数，按大班级汇总统计
- 支持小班明细导出（**Excel .xlsx 格式**，v1.0.35 起从 CSV 升级）
- 支持**教师信息粘贴绑定**（姓名/年级/中心），导出时自动从小班名匹配教师→附加年级/中心列
- 智能探针自动识别班级列表 API 和小班列表 API
- 支持手动配置接口地址和认证信息

**核心架构**：
- **MV3 Service Worker**（background.js）：网络请求拦截探针、批量查询调度、消息中继
- **Content Script**（content.js）：注入侧边栏 UI（3 个 Tab：探针/查询/结果）
- **Popup**（popup.js）：悬浮按钮，点击打开侧边栏
- **探针机制**：通过 `chrome.scripting.executeScript(world: 'MAIN')` 注入页面主世界，拦截 XHR/fetch 请求，自动识别 API 接口

- **3 步使用流程**：
1. **批量查询**：粘贴班级名称列表（每行一个）→ 设置并发数 → 开始查询（查询Tab默认打开，探针已折叠）
2. **教师匹配**（可选）：粘贴「姓名	年级	中心」→ 导出时自动匹配
3. **结果导出**：查看汇总结果（班级数/小班数/在班总计）→ 展开明细 → 导出 Excel

**关键设计**：
- **探针智能识别**：根据响应体字段自动判断接口类型（班级列表 vs 小班列表），支持手动分配
- **双模式查询**：
  - 标准模式：搜索班级 → 匹配 classId → 翻页获取小班列表
  - 直接翻页模式（无小班列表接口时）：直接从班级搜索接口翻页获取全部数据
- **字段智能兜底**：自动扫描响应体中的数字字段，兼容多种 API 返回格式（snake_case/camelCase/中文键名）
- **调试日志**：全程记录查询过程，支持导出捕获数据供 AI 分析

**目标平台**：`ai-rock.yuaiweiwu.com`（磐石系统）

## 发布流程（SOP）

### 发版检查清单
1. 确认 `manifest.json` 的 `version` 已更新
2. 确认功能测试通过
3. 与用户确认「这次更新可以发版了」

### 发版步骤
```bash
node build.js   # SRC=plugins/toolbox（默认），自动递增 patch 版本号
```
- build.js 自动：生成 .crx + update.xml，更新版本记录
- 推送云端：`mcp__cloudbase__manageHosting` 上传整个 `dist/extensions/` 目录
- Chrome 自动检测更新（约每 5 小时检查 `update.xml`）

### 关键文件
| 文件 | 说明 |
|------|------|
| `build.js` | 一键打包脚本（自动版本管理 + .crx 签名） |
| `key.pem` | 扩展签名私钥，每次打包必须用同一个（已纳入 build.js 流程） |
| `versions.json` | 版本历史记录 |
| `plugins/toolbox/manifest.json` | 壳扩展清单（含 `update_url`） |
| `dist/extensions/toolbox/update.xml` | Chrome 自动更新清单 |
| `releases/` | 分发版 ZIP 存档 |

### CloudBase 托管路径
- 环境 ID：`renewal-calendar-7ff2rtj4f876144`
- 壳扩展更新清单：`extensions/toolbox/update.xml`
- 壳扩展 CRX：`extensions/toolbox/toolbox-vX.Y.Z.crx`
- 自更新版本信息：`extensions/toolbox/update.json`（Native Messaging 读取）
- 报告插件更新清单：`extensions/report-fetcher/update.xml`
- 静态托管域名：`renewal-calendar-7ff2rtj4f876144-1259283480.tcloudbaseapp.com`

### 自动更新链路
```
Native Messaging 自更新（v2.1.24+）：
  用户 → 侧边栏 🔄 检查更新 Tab → background.js (connectNative)
    → toolbox-updater.exe (ping → check → update)
      → check: HTTP GET 云端 update.json → 版本比较
      → update: 下载 .zip → 解压到 plugins/toolbox/
    → 重新加载扩展

Chrome 原生自动更新（备选）：
  辅导老师 Chrome 扩展
    → 定期检查 update.xml（约每5小时）
    → 读到 version > 本地版本
    → 下载新 .crx → 静默安装
```

### 安装包分发
- **首次安装**：同事下载 ZIP → 解压 → 右键管理员运行 `install.bat` → 手动加载 `toolbox/` 目录 → 关闭所有浏览器窗口重新打开
- **后续更新**：侧边栏 🔄 Tab → 检查更新 → 安装更新 → 重新加载扩展（Native Messaging）
- **自动更新**：已装 v2.1.27+ 的用户可通过侧边栏一键检查更新

## 安全与限制
- Extension ID 锁定：`nmpdifejooglhkcilhgjkhggbioalojk`（由 key.pem 锁定，不可变）
- aitutor100.com 数据只能在系统后台页面内获取（新标签页无 SSO 登录态）
- MV3 Service Worker 无 DOM API（URL.createObjectURL 等不可用）
- 下载策略：SW 返回 CSV 字符串 → content.js 用 Blob + `<a>` 下载
- MV3 ES Module 中 `chrome.runtime.sendMessage` Promise 形式可能永久 pending，必须用回调包装
- Native Messaging 本地通讯：扩展通过 `chrome.runtime.connectNative('com.toolbox.updater')` 调用本地 exe，需注册表配置

## 禁止事项
- ❌ 不要在新标签页打开报告链接（必然跳登录页）
- ❌ 不要在 SW 里操作 DOM
- ❌ 不要用 broadcastType=4（工作台实际用的是 3）
- ❌ 不做物理删除用户（统一软删除）
- ❌ 不修改非当前项目的任何资源
- ❌ 不在用户个人目录创建项目文件

## 禁区（⚠️ 以下目录与本项目无关，禁止触碰）

| 目录 | 说明 | 操作权限 |
|------|------|---------|
| `D:\Claw\EduFlow\` | 用户的其他核心项目 | ❌ 禁止任何操作 |
| `D:\Claw\团队建设\` | 非代码项目 | ❌ 禁止任何操作 |
| `D:\Claw\测试6.5\` | 临时测试目录 | ❌ 禁止任何操作 |
