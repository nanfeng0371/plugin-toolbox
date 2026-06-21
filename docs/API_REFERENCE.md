# 浏览器插件管理 — API 参考

## 一、扩展内部消息协议 (MessageBus)

工具箱壳扩展通过 `chrome.runtime.sendMessage` 实现模块间通信。

### 1.1 模块注册

```js
// background.js 中注册
self.__registerModuleHandlers('模块名', {
  ACTION_NAME: async function(data, sender) {
    // 返回 { success: true, data: ... }
  }
});
```

### 1.2 模块调用

```js
// content.js 中调用
const resp = await sendMsg({
  target: '模块名',
  action: 'ACTION_NAME',
  data: { ... }
});
// resp → { success: true, data: ... }
```

### 1.3 Report 模块专有接口（v5.3.0+）

| Action | 方向 | 数据 | 返回 |
|--------|------|------|------|
| `FETCH_REPORTS_BATCH` | content → bg | `{items: [{reportToken, courseClassify, studyVersion, finalUrl}]}` | `{results: [{idx, data, error}]}` |
| `GENERATE_TABLE_EXCEL` | content → bg | `{headers: [...], rows: [...], sheetName: "..."}` | `{base64: "..."}` |

**FETCH_REPORTS_BATCH 详细说明**：
- **功能**：SW 内 30 并发批量获取报告数据（替代 iframe 池方案）
- **输入**：`items` 数组，每项包含 `reportToken`, `courseClassify`, `studyVersion`, `finalUrl`
- **输出**：`results` 数组，每项包含 `idx`, `data`（报告数据）, `error`（错误信息）
- **性能**：330 人从 16 分钟降到 25 秒（35 倍加速）

**GENERATE_TABLE_EXCEL 详细说明**：
- **功能**：SW 内生成 xlsx（复用 report 模块已加载的 xlsx 库）
- **输入**：`headers`（表头数组）, `rows`（数据二维数组）, `sheetName`（工作表名）
- **输出**：`base64`（xlsx 文件 base64 编码）
- **用途**：dingtalk 模块调用，避免 content.js 动态加载 xlsx 库失败

### 1.4 Updater 模块专有接口

| Action | 方向 | 数据 | 返回 |
|--------|------|------|------|
| `CHECK_UPDATE` | content → bg | `{}` | `{currentVersion, latestVersion, hasUpdate, downloadUrl, releaseNotes}` |
| `INSTALL_UPDATE` | content → bg | `{downloadUrl}` | `{message, action: "reload_extension"}` |
| `PING` | content → bg | `{}` | `{status: "pong", host: "python"}` |
| `PROGRESS` | bg → content | `{...}` | 安装进度推送（实时） |

---

## 二、Native Messaging 协议

### 2.1 连接

```js
const port = chrome.runtime.connectNative('com.toolbox.updater');
port.postMessage({ command: 'ping' });
port.onMessage.addListener(resp => { ... });
```

### 2.2 消息格式

```
4 字节 LE 无符号整数 (消息体长度) + UTF-8 JSON 消息体
```

### 2.3 命令

| 命令 | 请求 | 响应 |
|------|------|------|
| `ping` | `{command: "ping"}` | `{success: true, data: {status: "pong", host: "python"}}` |
| `check` | `{command: "check"}` | `{success: true, data: {version, downloadUrl, releaseNotes, ...}}` |
| `update` | `{command: "update", downloadUrl: "..."}` | `{success: true, data: {message, action: "reload_extension"}}` |

### 2.4 错误码

| 错误 | 说明 |
|------|------|
| `Native Host 未安装` | 未运行 install.bat 注册 |
| `Native Host 响应超时` | 30 秒超时 |
| `Native Host 异常退出` | 进程崩溃或未正常断开 |
| `缺少 downloadUrl 参数` | update 命令未提供下载地址 |
| `HTTP 416` | CDN 缓存冲突（已自动重试） |

---

## 三、CloudBase 云端 API

### 3.1 update.json

```
GET https://renewal-calendar-7ff2rtj4f876144-1259283480.tcloudbaseapp.com/extensions/toolbox/update.json
```

响应：
```json
{
  "version": "2.1.76",
  "downloadUrl": "https://.../extensions/toolbox/toolbox-latest.zip",
  "releaseNotes": "v2.1.76 更新",
  "publishedAt": "2026-06-10T...",
  "minVersion": "2.1.24"
}
```

### 3.2 update.xml

```
GET https://renewal-calendar-7ff2rtj4f876144-1259283480.tcloudbaseapp.com/extensions/toolbox/update.xml
```

Chrome 标准自动更新 XML 格式（用于 `update_url` manifest 字段）。

### 3.3 下载

```
GET https://renewal-calendar-7ff2rtj4f876144-1259283480.tcloudbaseapp.com/extensions/toolbox/toolbox-latest.zip
```

固定文件名，每次部署覆盖，无需版本号。

---

## 四、Native Host 配置 (config.json)

由 `install.bat` 首次运行时生成：

```json
{
  "toolbox_dir": "D:\\Claw\\测试6.5\\toolbox-latest\\toolbox",
  "update_url": "https://.../extensions/toolbox/update.json",
  "user_agent": "Toolbox-Updater/2.1",
  "log_path": null
}
```

| 字段 | 说明 | 写入时机 |
|------|------|---------|
| `toolbox_dir` | 工具箱扩展目录绝对路径 | install.bat |
| `update_url` | 更新检查 URL | install.bat（内置默认值） |
| `user_agent` | HTTP 请求 UA | 内置默认值 |
| `log_path` | 日志文件路径（null=不记日志） | 可选 |

---

## 五、注册表

install.bat 写入的 Windows 注册表项：

```
HKCU\Software\Google\Chrome\NativeMessagingHosts\com.toolbox.updater
HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.toolbox.updater
```

默认值指向 `native-host/com.toolbox.updater.json` 的绝对路径。
