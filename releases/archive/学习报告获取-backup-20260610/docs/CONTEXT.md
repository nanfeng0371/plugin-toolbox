# 《学习报告获取》项目 — 上下文文档

## 一句话描述
Chrome 扩展，批量获取 AI 一对一课学习报告数据，自动分析听课质量，导出 CSV。

## 当前状态
- **版本**：v5.1.0
- **功能完整度**：✅ 核心功能全部跑通
- **最后更新**：2026-05-31

## 访问入口
- **工作台**：https://ai-genesis.yuaiweiwu.com（课堂数据页面）
- **报告域**：https://next.aitutor100.com（iframe 内同源 fetch）
- **短链域**：https://s1.aiv5.cc（SSO 跳转）

## 技术栈
- **平台**：Chrome Extension MV3（Manifest V3）
- **语言**：纯 JavaScript（无框架，无构建工具）
- **导出**：CSV（UTF-8 BOM，Excel 直接打开）
- **认证**：iframe SSO + source-sn:PROD 头

## 文件结构
```
学习报告获取/
├── chrome-extension/          # 主扩展
│   ├── manifest.json          # MV3 配置（v5.1.0）
│   ├── content.js             # 主面板 UI + 批量获取调度（1149 行）
│   ├── background.js          # Service Worker（API 请求 + CSV 生成，454 行）
│   ├── report_fetcher.js      # iframe 内同源 fetch（100 行）
│   ├── panel.css              # 面板样式（225 行）
│   ├── analysis.js            # 独立分析逻辑（272 行）
│   ├── sidepanel.js/html      # 侧边面板（346 行）
│   └── icons/                 # 图标（16/48/128px）
├── network-monitor/           # 辅助调试工具
├── releases/
│   └── v4.0.4/                # 稳定版封存（含 ZIP）
├── documents/
│   └── CONTEXT.md             # 本文档
└── .workbuddy/memory/         # 记忆系统
```

## 核心架构决策

### 数据获取（4 步链路）
1. **Step1**：FETCH_STUDENT_LIST → 工作台 API 拿学生列表（含 ID、听课时长、作业状态等）
2. **Step2**：biz 接口（broadcastType=3）→ 生成短链 `s1.aiv5.cc/xxx`
3. **Step3**：短链 302 重定向 → 浏览器自动 SSO + 种 Cookie
4. **Step4**：iframe 内同源 fetch → 3 个报告 API 全部 200

### 并发优化（v5.0.0）
- **Phase1**：所有学生 Step2+3 并行预取短链
- **Phase2**：3 并发 iframe 池，150ms 间隔创建
- **效果**：161 学生从 6-7min → 2-3min

### 评价体系（v5.1.0）
- **四维优先级**：掌握度(P1) → 回答率(P2) → 听课时长(P3) → 作业完成(P4)
- **5 档主标签**：⭐优秀 / 👍认真 / ⚠️需辅导 / 🚨敷衍但会 / 🔴敷衍
- **风险附注**：⏰听课不足（≤97min）/ 📝未交作业
- **无掌握度退化**：只看回答率

## 安全与限制
- **铁律**：aitutor100.com 数据只能在系统后台页面内获取（新标签页无 SSO 登录态）
- **SW 限制**：MV3 Service Worker 无 DOM API（URL.createObjectURL 等不可用）
- **下载策略**：SW 返回 CSV 字符串 → content.js 用 Blob + `<a>` 下载

## 发布流程（SOP — 每次大更新后必须执行）

### 发版检查清单
1. 确认 `manifest.json` 的 `version` 已更新
2. 确认功能测试通过
3. 与用户确认「这次更新可以发版了」

### 发版步骤
```bash
# 1. 打包
node build.js

# 2. 上传到 CloudBase（通过 AI 助手执行 MCP 上传，或手动 CLI）
#    AI 助手会自动调用 mcp__cloudbase__manageHosting 上传 dist/extensions/ 目录

# 3. 伙伴的 Chrome 自动检测更新（约5小时检查一次，无需手动操作）
```

### 关键文件
| 文件 | 说明 |
|------|------|
| `build.js` | 一键打包脚本（生成 .crx + update.xml） |
| `key.pem` | 扩展签名私钥，**每次打包必须用同一个**，已备份 |
| `versions.json` | 版本历史记录 |
| `releases/` | 分发版 ZIP 存档 |

### CloudBase 托管路径
- 更新清单：`extensions/report-fetcher/update.xml`
- CRX 下载：`extensions/report-fetcher/report-fetcher-vX.Y.Z.crx`

### 伙伴首次安装
- 给伙伴分发 `releases/学习报告获取-vX.Y.Z-分发版.zip`
- 解压 → 拖入 `chrome://extensions/`（开启开发者模式）
- 之后自动更新，无需再手动操作

## 已知问题 / TODO
- 暂无

## 禁止事项
- ❌ 不要在新标签页打开报告链接（必然跳登录页）
- ❌ 不要在 SW 里操作 DOM
- ❌ 不要用 broadcastType=4（工作台实际用的是 3）
