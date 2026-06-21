# 调课助手 Web 版 - 部署阻塞问题诊断报告

## 一、项目背景

调课助手是一个 Chrome 扩展（正在开发 Web 版），部署在腾讯云 CloudBase 上。

- **CloudBase 环境ID**：`renewal-calendar-7ff2rtj4f876144`
- **静态托管域名**：`renewal-calendar-7ff2rtj4f876144-1259283480.tcloudbaseapp.com`（静态文件）
- **网关/API 域名**：`renewal-calendar-7ff2rtj4f876144-1259283480.ap-shanghai.app.tcloudbase.com`（云函数调用）
- **同环境已有项目**：EduFlow（路径 `/ef/`），API 路径 `/ef-api`，运行正常

### 部署结构

| 路径 | 用途 | 状态 |
|------|------|------|
| `/tk/` | 调课助手前端静态文件 | ✅ 正常 |
| `/tk-api` | 调课助手后端云函数 | ❌ 400 错误 |
| `/ef/` | EduFlow 前端 | ✅ 正常 |
| `/ef-api` | EduFlow 后端云函数 | ✅ 正常 |
| `/api` | 公共 API | ✅ 正常 |

## 二、问题现象

调用 `https://renewal-calendar-7ff2rtj4f876144-1259283480.ap-shanghai.app.tcloudbase.com/tk-api` 返回 **400 错误**，响应头包含：
```
x-cloudbase-upstream-type: Tencent-SCF_HTTP
x-cloudbase-upstream-status-code: 400
```

而同域名的 `/ef-api` 和 `/api` 调用正常返回 200。

## 三、根因分析

CloudBase 网关有**多个域名**，每个域名下有独立的路由表：

| 域名 | 说明 |
|------|------|
| `*`（通配符域名） | 优先级最高，所有 `app.tcloudbase.com` 的请求都匹配它 |
| `tcbaccess-in.tencentcloudbase.com` | 内部访问域名，DNSStatus: INVALID |
| `app.tcloudbase.com` | 实际 API 域名 |

### 当前路由状态（`*` 通配符域名下）

| 路径 | 路由类型 (UpstreamResourceType) | 云函数 | 状态 |
|------|------|------|------|
| `/ef-api` | **SCF** (Type=1) | ef-api | ✅ 正常 |
| `/tk-api` | **WEB_SCF** (Type=6) | tk-api | ❌ 400 |
| `/api` | SCF | — | ✅ 正常 |

### 根本原因

**`/tk-api` 路由被创建为 `WEB_SCF` 类型，但 tk-api 是 Event 类型云函数。**

- `SCF`（Type=1）：适用于 Event 类型函数，网关会构造标准 HTTP Event 对象（含 `httpMethod`、`body`、`headers`、`queryStringParameters`）传给函数
- `WEB_SCF`（Type=6）：适用于 HTTP（Web）类型函数，网关直接把原始 HTTP 请求转发给函数，期望函数用 `(req, res)` 模式处理

tk-api 函数入口是 Event 类型（`exports.main = async (event) => {...}`），收到 WEB_SCF 转发的原始 HTTP 请求后无法解析，返回 400。

### ef-api 为什么正常？

ef-api 在 `*` 域名上的路由类型是 `SCF`，与 ef-api 的 Event 类型函数匹配，所以正常工作。

## 四、已尝试的修复方案及结果

| 尝试 | 做法 | 结果 |
|------|------|------|
| 1. MCP `deleteRoute` | 删除 `/tk-api` 路由再重建 | ❌ 只删除了 `tcbaccess-in` 域名上的路由，`*` 域名上的路由不受影响 |
| 2. MCP `updateRoute` | 修改路由类型 | ❌ 同上，只操作 `tcbaccess-in` 域名 |
| 3. MCP `createRoute` (SCF) | 在 `tcbaccess-in` 域名创建 SCF 类型路由 | ✅ 创建成功，但类型变成了 CBR（非 SCF），且 `tcbaccess-in` 域名 DNS INVALID，无法访问 |
| 4. MCP `createAccess` | 创建新的网关访问入口 | ❌ 报 "Path '/tk-api' is used"（`*` 域名已占用） |
| 5. `callCloudApi` + `DeleteHTTPServiceRoute` | 直接调 TCB API 删除路由 | ❌ 返回 "Action not found"（参数格式可能不对） |
| 6. `tcbaccess-in` 域名直接访问 | 绕过 `*` 域名 | ❌ SSL 证书问题 + CBR 类型不匹配（SERVICE_VERSION_NOT_FOUND） |

### 关键发现

- CloudBase MCP 工具（`manageGateway`/`queryGateway`）**只能操作 `tcbaccess-in` 域名**的路由
- `*` 通配符域名的路由**只能通过腾讯云 API 或 CloudBase 控制台修改**
- 腾讯云有 `ModifyHTTPServiceRoute` 和 `DeleteHTTPServiceRoute` API（文档链接见下方），但通过 `callCloudApi` 调用时参数格式未确定

## 五、需要解决的问题

**如何将 `*` 通配符域名上 `/tk-api` 路由的 `UpstreamResourceType` 从 `WEB_SCF` (Type=6) 改为 `SCF` (Type=1)？**

### 方案 A：通过腾讯云 API 修改

腾讯云文档中存在以下 API：
- **ModifyHTTPServiceRoute**：https://cloud.tencent.com/document/api/876/129797
- **DeleteHTTPServiceRoute**：https://cloud.tencent.com/document/api/876/129799

通过 `callCloudApi`（service=`tcb`）调用这些 API，但需要确定正确的参数格式。之前尝试 `Action=DeleteHTTPServiceRoute` 返回 "Action not found"，可能是参数名或结构不对。

**需要确认**：
1. 这两个 API 的完整参数列表（尤其是 `EnvId`、`Domain`、`RouteId` 的正确字段名）
2. `callCloudApi` 是否支持这些 Action
3. 如果不支持，是否有其他 API 或 SDK 可以调用

### 方案 B：用户在 CloudBase 控制台手动修改

登录 CloudBase 控制台 → 环境 → 云接入/网关 → 找到 `/tk-api` 路由 → 修改类型从 WEB_SCF 改为 SCF。

这是最稳妥的方案，但需要用户有控制台访问权限并手动操作。

### 方案 C：删除 tk-api 云函数后重新创建

先删除 tk-api 云函数和所有路由，然后重新部署。关键是在重新创建网关路由时，确保使用 `SCF` 类型而非 `WEB_SCF`。

**风险**：重新创建路由时，MCP 工具可能还是会将其创建为错误类型。

### 方案 D：改造 tk-api 为 HTTP（Web）类型函数

将 tk-api 的入口从 Event 类型改为 HTTP 类型（`exports.main = async (req, res) => {...}`），使其兼容 WEB_SCF 路由。

**代价**：需要重写函数入口和请求/响应处理逻辑。

## 六、tk-api 云函数代码概要

```javascript
// functions/tk-api/index.js — Event 类型云函数
exports.main = async (event, context) => {
  // event 结构: { httpMethod, body, headers, queryStringParameters, path, ... }
  // 返回格式: { statusCode, headers, body }
  
  const { httpMethod, body, headers = {}, queryStringParameters = {} } = event;
  const method = httpMethod || 'GET';
  
  // CORS 预检
  if (method === 'OPTIONS') {
    return buildHttpResponse(204, '');
  }
  
  // 解析请求体
  let requestData = {};
  if (body) {
    try { requestData = JSON.parse(body); } catch(e) {}
  }
  
  const { action, data } = requestData;
  
  // Token 鉴权
  // Action 路由
  // 错误处理
  
  return buildHttpResponse(200, JSON.stringify(result));
};

function buildHttpResponse(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      ...extraHeaders
    },
    body
  };
}
```

## 七、环境信息

- **CloudBase 环境**：个人版
- **区域**：ap-shanghai
- **已安装依赖**：bcryptjs（tk-api 用）
- **前端技术栈**：纯 HTML + CSS + JS，esbuild IIFE 打包
- **前端 API 配置**：`API_BASE = https://renewal-calendar-7ff2rtj4f876144-1259283480.ap-shanghai.app.tcloudbase.com/tk-api`

## 八、期望结果

`/tk-api` 路由类型改为 `SCF`，使得：
1. 前端调用 `POST https://...ap-shanghai.app.tcloudbase.com/tk-api` 返回 200
2. 登录、Token 验证、调课等 API 功能端到端可用

---

## 九、✅ 问题已解决（2026-05-25）

### 解决方案：方案 A — 通过腾讯云 API `ModifyHTTPServiceRoute` 修改

之前尝试 `callCloudApi` + `DeleteHTTPServiceRoute` 失败是因为**参数格式不对**。正确的做法是用 `ModifyHTTPServiceRoute` 增量修改路由类型。

### 正确的调用方式

```json
{
  "service": "tcb",
  "action": "ModifyHTTPServiceRoute",
  "params": {
    "EnvId": "renewal-calendar-7ff2rtj4f876144",
    "Domain": {
      "Domain": "*",
      "Routes": [
        {
          "Path": "/tk-api",
          "UpstreamResourceType": "SCF",
          "UpstreamResourceName": "tk-api"
        }
      ]
    }
  }
}
```

### 关键参数说明

| 参数 | 值 | 说明 |
|------|-----|------|
| `service` | `"tcb"` | 腾讯云 CloudBase 服务 |
| `action` | `"ModifyHTTPServiceRoute"` | 增量修改路由（不是 DeleteHTTPServiceRoute！） |
| `EnvId` | 环境ID | 你的 CloudBase 环境 ID |
| `Domain.Domain` | `"*"` | 通配符域名（不是 `tcbaccess-in`！） |
| `Domain.Routes[].Path` | `"/tk-api"` | 要修改的路由路径 |
| `Domain.Routes[].UpstreamResourceType` | `"SCF"` | 目标类型（从 WEB_SCF 改为 SCF） |
| `Domain.Routes[].UpstreamResourceName` | `"tk-api"` | 云函数名（保持不变） |

### 之前失败的原因

1. **用了 `DeleteHTTPServiceRoute` 而不是 `ModifyHTTPServiceRoute`**：Delete 的参数结构不同，需要 RouteId
2. **MCP 工具只能操作 `tcbaccess-in` 域名**：manageGateway/queryGateway 操作的是内部域名，而实际请求走 `*` 通配符域名
3. **`callCloudApi` 参数格式**：必须把 `Domain` 作为嵌套对象传入，包含 `Domain` 和 `Routes` 数组

### 验证结果

修改后调用 `POST /tk-api` 返回：
- HTTP Status: **200** ✅
- 响应体: `{"code":400,"message":"请输入用户名和密码","data":null}` — 这是业务层校验（正常），不再是网关层 400 错误

### 教训总结

> **CloudBase 网关路由问题的排查路径：**
> 1. 先用 `queryGateway(action="listRoutes")` 查看所有域名的路由状态
> 2. 确认 `*` 通配符域名下的路由类型（这才是实际生效的）
> 3. MCP 网关工具操作的域名可能不是 `*` 域名，需要用 `callCloudApi` + `ModifyHTTPServiceRoute` 操作
> 4. Event 类型云函数 → 路由类型必须是 `SCF`；HTTP 类型云函数 → 路由类型必须是 `WEB_SCF`
> 5. `ModifyHTTPServiceRoute` 是增量修改，只传需要改的字段即可
