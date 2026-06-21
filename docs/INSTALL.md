# 插件工作箱 — 安装说明

---

## 第一步：下载 ZIP

直接点击或复制到浏览器下载：
```
https://renewal-calendar-7ff2rtj4f876144-1259283480.tcloudbaseapp.com/extensions/toolbox/toolbox-latest.zip
```

下载后解压到任意目录。


## 第二步：注册 Native Host

右键解压目录里的 `install.bat` → 以管理员身份运行

看到 **4 个绿色的 [OK]** 就对了：

```
  [OK] manifest.json path updated
  [OK] config.json written: D:\你的路径\toolbox-latest\toolbox
  [OK] Chrome Native Messaging Host registered
  [OK] Edge Native Messaging Host registered
  Done!
```

## 第三步：加载扩展

- **Chrome**：`chrome://extensions/` → 右上角开启「开发者模式」
- **Edge**：`edge://extensions/` → 同上

点击「加载已解压的扩展程序」→ 选择解压目录下的 **`toolbox/`** 文件夹


## 第四步：⚠️ 重启浏览器

关闭**所有**浏览器窗口（任务管理器确认无 chrome/edge 进程）→ 重新打开

> 这一步必须做！否则扩展连不上 Native Host。


## 第五步：验证

1. 打开任意网页 → 左侧出现悬浮按钮 → 点击打开侧边栏
2. 切换到 **🔄 检查更新** 标签
3. 点击「检查更新」→ 显示"已是最新版本"
4. 确认版本号正常显示


## 以后如何更新？

侧边栏 → 🔄 标签 → 点「检查更新」→ 有新版本就点「安装更新」→ 按提示重载扩展。

**无需重装、无需手动下载 ZIP、无需重跑 install.bat！**


## 常见问题

| 问题 | 解决 |
|------|------|
| install.bat 一闪而过 | 右键 → 以管理员身份运行 |
| 扩展加载报错 | Chrome/Edge 版本需 ≥ 88（支持 MV3）|
| 检查更新显示"Native Host 未安装" | 重新执行第二步 |
| 安装更新后版本号没变 | 关闭所有浏览器窗口再重新打开 |
