@echo off
REM ============================================================
REM 插件工作箱 - 首次安装脚本
REM 功能: 通过注册表注册 Native Messaging Host
REM 用法: 右键 -> 以管理员身份运行(推荐)或直接双击
REM ============================================================

set "BAT_DIR=%~dp0"

echo ============================================================
echo  插件工作箱 - 注册 Native Messaging Host
echo ============================================================
echo.
echo  安装目录: %BAT_DIR%
echo.

set "MANIFEST=%BAT_DIR%native-host\com.toolbox.updater.json"
set "EXE_PATH=%BAT_DIR%native-host\toolbox-updater.exe"
set "EXE_PATH_JSON=%EXE_PATH:\=\\%"

REM --- 1. 动态更新 manifest JSON 中的 path 字段 ---

powershell -ExecutionPolicy Bypass -NoProfile -Command "$m = Get-Content '%MANIFEST%' -Raw -Encoding UTF8 | ConvertFrom-Json; $m.path = '%EXE_PATH_JSON%'; $m | ConvertTo-Json -Depth 10 | Set-Content '%MANIFEST%' -Encoding UTF8; Write-Host '[OK] manifest.json path updated'"

if %errorlevel% neq 0 (
    echo [FAIL] manifest.json 更新失败
    pause
    exit /b 1
)

REM --- 1.5 写入 config.json（告诉 Native Host 工具箱目录在哪）---

set "TOOLBOX_DIR=%BAT_DIR%toolbox"
set "TOOLBOX_DIR_JSON=%TOOLBOX_DIR:\=\\%"
powershell -ExecutionPolicy Bypass -NoProfile -Command "$cfg = @{toolbox_dir='%TOOLBOX_DIR_JSON%'; update_url='https://renewal-calendar-7ff2rtj4f876144-1259283480.tcloudbaseapp.com/extensions/toolbox/update.json'; user_agent='Toolbox-Updater/2.1'; log_path=''}; $cfg | ConvertTo-Json | Set-Content '%BAT_DIR%native-host\config.json' -Encoding UTF8; Write-Host '[OK] config.json written: %TOOLBOX_DIR_JSON%'"

if %errorlevel% neq 0 (
    echo [FAIL] config.json 写入失败
    pause
    exit /b 1
)

REM --- 2. 注册 Native Messaging Host 到注册表 ---

powershell -ExecutionPolicy Bypass -NoProfile -Command "$manifestPath = '%MANIFEST%'; $chromeReg = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.toolbox.updater'; try { New-Item -Path $chromeReg -Force | Out-Null; Set-ItemProperty -Path $chromeReg -Name '(default)' -Value $manifestPath; Write-Host '[OK] Chrome Native Messaging Host registered' } catch { Write-Host '[FAIL] Chrome: ' $_.Exception.Message }; $edgeReg = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.toolbox.updater'; try { New-Item -Path $edgeReg -Force | Out-Null; Set-ItemProperty -Path $edgeReg -Name '(default)' -Value $manifestPath; Write-Host '[OK] Edge Native Messaging Host registered' } catch { Write-Host '[FAIL] Edge: ' $_.Exception.Message }; Write-Host ''; Write-Host 'Done!'"

echo.
echo ============================================================
echo  下一步: 手动加载扩展
echo ============================================================
echo.
echo 1. 打开 Edge: edge://extensions/
echo 2. 右上角开启开发者模式
echo 3. 点击加载已解压的扩展程序
echo 4. 选择: %BAT_DIR%toolbox
echo.
echo 安装完成后, 关闭所有浏览器窗口再重新打开.
echo 然后打开侧边栏 - 检查更新 Tab 测试更新功能.
echo.

pause
