# 浏览器插件管理 — 版本更新说明 v2.1.76

**发布日期**：2026-06-10  
**版本类型**：🔧 修复版本（Hotfix）  
**升级优先级**：🔴 高（建议立即升级）

---

## 一、本次更新摘要

| 插件 | 旧版本 | 新版本 | 更新类型 |
|------|---------|---------|---------|
| 插件工作箱（壳） | v2.1.75 | v2.1.76 | 🔧 修复 |
| 学习报告批量分析 | v5.3.0 | v5.3.0 | ✅ 无变化 |
| 页面表格提取 | v1.0.2 | v1.0.2 | ✅ 无变化 |

---

## 二、主要变更

### 🔧 修复：dingtalk 模块 Excel 下载报错 `XLSX is not defined`

**问题描述**：
- 在 v2.1.74 中，dingtalk 模块的 CSV 下载改为 Excel 下载
- 但 xlsx 库加载失败（CSP/时序问题），导致 `XLSX is not defined` 错误
- 用户无法下载 Excel 文件

**修复方案**：
- 改用 Service Worker `GENERATE_TABLE_EXCEL` handler 代理生成 xlsx
- content.js 只负责发送消息到 SW，不再尝试加载 xlsx 库
- SW 内复用 report 模块已加载的 xlsx 库（importScripts）

**影响范围**：
- ✅ dingtalk 模块：Excel 下载功能恢复正常
- ✅ report 模块：无影响（xslx 库已在 SW 内加载）
- ✅ 其他模块：无影响

---

## 三、技术细节

### 3.1 架构变更

**v2.1.74（有问题）**：
```
dingtalk/content.js
  ↓ (动态加载 xlsx 库)
  ↓ <script> 标签 → CSP 拦截 → 加载失败
  ↓ XLSX is not defined → 报错
```

**v2.1.76（修复后）**：
```
dingtalk/content.js
  ↓ sendMessage({ action: 'GENERATE_TABLE_EXCEL' })
  ↓ Service Worker (background.js)
  ↓ importScripts('xslx.full.min.js') → 已加载
  ↓ XLSX.write() → 生成 xlsx base64
  ↓ return { base64: '...' }
  ↓ content.js → Blob → 下载
```

### 3.2 代码变更

**文件**：`plugins/toolbox/modules/dingtalk/content.js`
- **删除**：`loadXlsxLib()` 函数（动态加载 xlsx 库）
- **重写**：`downloadExcel()` → 改为 `sendMessage → SW`
- **新增**：错误处理（SW 调用失败 → 降级 CSV）

**文件**：`plugins/toolbox/modules/report/background.js`
- **新增**：`GENERATE_TABLE_EXCEL` handler（生成 xlsx base64）

---

## 四、升级指南

### 4.1 自动升级（推荐）

1. 打开插件工作箱侧边栏
2. 点击「🔄 检查更新」Tab
3. 系统自动检测 v2.1.76
4. 点击「安装更新」
5. **关闭所有浏览器窗口，重新打开**（必须！）

### 4.2 手动升级

1. 访问更新 URL：  
   `https://renewal-calendar-7ff2rtj4f876144-1259283480.tcloudbaseapp.com/extensions/toolbox/update.json`
2. 复制 `downloadUrl` 的值
3. 下载 ZIP 文件
4. 管理员运行 `install.bat`
5. **关闭所有浏览器窗口，重新打开**

---

## 五、验证方法

升级后，请验证以下功能：

| 功能 | 验证步骤 | 预期结果 |
|------|---------|---------|
| dingtalk Excel 下载 | 打开页面表格提取 → 点击「💾 下载Excel」 | 下载 .xlsx 文件，无报错 |
| 学习报告获取 | 打开学习报告分析 → 获取报告 | 正常获取，无报错 |
| 调课助手 | 打开调课助手 → 粘贴数据 | 正常提交，无报错 |

---

## 六、已知问题

| 问题 | 状态 | 说明 |
|------|------|------|
| 无 | - | - |

---

## 七、反馈渠道

如遇到问题，请联系开发者：  
- 微信：wy260  
- 邮箱：wy260@example.com

---

**结束**
