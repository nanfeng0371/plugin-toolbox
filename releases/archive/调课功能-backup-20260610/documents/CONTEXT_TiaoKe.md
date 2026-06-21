# 调课助手 — 项目快速启动上下文

> **用途**：任何 AI 实例读取此文件后，可在 30 秒内恢复完整项目上下文，继续开发。  
> **更新规则**：每次功能变更/部署/Bug修复后，同步更新。  
> **最后更新**：2026-05-25

---

## 一句话描述

调课助手是一个 Chrome 扩展（V3，已有）+ 网页版（开发中）的工具，用于在公司内部调课平台（ai-genesis.yuaiweiwu.com）批量自动改约，服务于 K12 辅导机构的一线辅导伙伴。

## 当前状态

- **Chrome 扩展 V3**：功能完整 ✅（历史日志+并发加速+自然语言解析+学情表）
- **网页版**：PRD V1.0 完成 ✅，架构/代码/部署**待开发**
- **PRD**：`documents/PRD_TiaoKe_Web.md` ✅
- **架构文档**：`documents/Architecture_TiaoKe_Web.md` ❌ 待写
- **API 文档**：`documents/API_REFERENCE_TK.md` ❌ 待写

## 目标调课平台

- **地址**：https://ai-genesis.yuaiweiwu.com/
- **平台名**：初&高中辅导工作台
- **鉴权**：必须同时携带两个 Cookie
  ```
  Cookie: authorization-app=aiXin; authorization-token=<JWT>
  ```
  - JWT 24小时过期，来自钉钉 CAS SSO
  - Bearer Header 方式不支持（401）

## 核心 API

```
学员查询：GET /prod-api/student-center-ai/student/name/{userId}
课表列表：GET /prod-api/student-center-ai/regularCourse/next/class/list
课时数据：GET /prod-api/student-center-ai/ai/user/course/classhour?userClassTimeId={id}
改约提交：POST /prod-api/student-center-ai/ai/user/course/classhour
  Body: { type:2, userId, courseId, aiCourseId, aiClassHourId, periodId,
          userClassTimes:[{classTimeStart, classTimeEnd, aiClassHourSort:1, id}] }
  成功响应：code="000000"
```

## CloudBase 部署信息

- **环境 ID**：`renewal-calendar-7ff2rtj4f876144`
- **网页端地址**：`https://renewal-calendar-7ff2rtj4f876144-1259283480.tcloudbaseapp.com/tk/`
- **API 地址**：`https://renewal-calendar-7ff2rtj4f876144-1259283480.ap-shanghai.app.tcloudbase.com/tk-api`
- **云函数**：`tk-api`（Event 类型 + 网关路由，与 ef-api 模式完全一致）
- **静态托管**：`/tk/` 子目录

## 复用 EduFlow 资源

- 集合 `ef_users`：用于验证登录用户（只读）
- 集合 `ef_tokens`：用于验证 ef_token（只读）
- 代码复用：`response.js`、`db-helper.js`、`permission.js`（100% 直接复制）
- 构建脚本：参考 `D:\Claw\EduFlow\build.js`（esbuild IIFE 模式）

## 新增 CloudBase 集合

| 集合 | 用途 |
|------|------|
| `tk_tokens` | 调课 JWT（AES 加密存储，以 userId 为主键） |
| `tk_students` | 学情表（姓名→ID 映射，按 ownerId 隔离） |
| `tk_logs` | 调课历史记录（按 userId 隔离，最多 1000 条） |

## 项目文件结构

```
D:\Claw\调课功能\
├── manifest.json / popup/ / background/ / content/  ← Chrome扩展 V3（已有，不动）
│
├── web/                              ← 网页版前端（待开发）
│   ├── index.html
│   ├── package.json（esbuild）
│   ├── build.js
│   └── assets/
│       ├── index.html（静态托管入口）
│       ├── css/main.css, components.css
│       └── js/app.js, config.js, api.js, auth.js, parser.js,
│              studentMatch.js, pages/...
│
├── functions/tk-api/                 ← 调课 API 云函数（待开发）
│   ├── index.js（入口+路由）
│   ├── response.js, db-helper.js, permission.js（复制 ef-api）
│   ├── auth.service.js
│   ├── tiaokeToken.service.js
│   ├── student.service.js
│   ├── class.service.js
│   └── reschedule.service.js
│
├── cloudbaserc.tk.json               ← 部署配置（待写）
│
└── documents/
    ├── PRD_TiaoKe_Web.md             ← ✅ PRD（本文关联）
    ├── Architecture_TiaoKe_Web.md    ← ❌ 待写
    ├── API_REFERENCE_TK.md           ← ❌ 待写
    └── CONTEXT_TiaoKe.md             ← ← 本文件
```

## API 路由设计（tk-api）

```
POST /tk-api
Body: { "action": "service.method", "data": {...}, "_token": "<ef_token>" }

公开：auth.login
需鉴权：
  auth.verify
  tiaokeToken.save / get
  student.import / list / clear / match
  class.list / getHour
  reschedule.parse / execute / batch
  log.list / search
```

## 关键技术决策

| 决策 | 选择 | 原因 |
|------|------|------|
| 用户体系 | 复用 EduFlow ef_users | 零运维成本，伙伴不用重新注册 |
| 调课 JWT 存储 | 云端 AES 加密 | 前端不持久化，安全边界清晰 |
| Token 同步 | Chrome 扩展一键同步 | 一线伙伴无需懂代码/F12 |
| Excel 解析 | 前端（SheetJS） | 省流量，V3 扩展已有 SheetJS |
| 路由 | Hash 路由 | 静态托管无服务端路由 |
| 打包 | esbuild IIFE | 绕过 CloudBase CDN ES Module 限制 |
| 框架 | 无框架原生 JS | 与 EduFlow 对齐，零复杂度 |

## 禁止做的事

- ❌ 不在 `C:\Users\wy260\WorkBuddy\` 下创建任何项目文件
- ❌ 不修改 EduFlow、续班日历的任何文件
- ❌ 不使用 CloudBase HTTP 类型云函数（必须 Event + 网关）
- ❌ 不在前端持久化调课 JWT 明文

## 参考文档

- EduFlow 上下文：`D:\Claw\EduFlow\documents\CONTEXT.md`
- EduFlow ef-api 入口：`D:\Claw\EduFlow\functions\ef-api\index.js`（路由模式参考）
- Chrome 扩展记忆：`D:\Claw\调课功能\.workbuddy\memory\MEMORY.md`
