#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
插件工作箱 — Native Messaging Host (Python)
支持命令：ping / check / update
协议：Chrome Native Messaging (4字节LE长度 + JSON body)
"""
import sys
import json
import struct
import os
import io
import traceback
import urllib.request
import urllib.error
from datetime import datetime

# ─── 配置（优先读 config.json，其次用内置默认值）────────────────────
# PyInstaller 打包后 __file__ 指向临时目录，需用 sys.executable
if getattr(sys, 'frozen', False):
    SCRIPT_DIR = os.path.dirname(os.path.abspath(sys.executable))
else:
    SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(SCRIPT_DIR, "config.json")

# 内置默认值（当 config.json 不存在时使用，无需手动修改）
_DEFAULT_CONFIG = {
    "update_url": "https://renewal-calendar-7ff2rtj4f876144-1259283480.tcloudbaseapp.com/extensions/toolbox/update.json",
    "user_agent": "Toolbox-Updater/2.1",
    "log_path": None,
    "toolbox_dir": None,  # install.bat 写入绝对路径，最优先使用
}

def _load_config():
    """读取 config.json，不存在则自动创建（写入默认值）"""
    if os.path.isfile(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            for k, v in _DEFAULT_CONFIG.items():
                cfg.setdefault(k, v)
            return cfg
        except Exception:
            pass
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(_DEFAULT_CONFIG, f, ensure_ascii=False, indent=2)
    except Exception:
        pass
    return dict(_DEFAULT_CONFIG)

_cfg = _load_config()
UPDATE_URL = _cfg["update_url"]
USER_AGENT = _cfg["user_agent"]
LOG_PATH = _cfg.get("log_path", None)


def _log(msg):
    if not LOG_PATH:
        return
    try:
        log_dir = os.path.dirname(LOG_PATH) or SCRIPT_DIR
        os.makedirs(log_dir, exist_ok=True)
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write("%s [PyHost] %s\n" % (datetime.now().strftime("%H:%M:%S"), msg))
    except Exception:
        pass


# ─── NM 协议读写 ───────────────────────────────────────────────────
# 使用 sys.stdin.buffer / sys.stdout.buffer 读写二进制流

def read_message():
    """读一条 Native Messaging 消息"""
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    msg_len = struct.unpack("=I", raw_len)[0]
    if msg_len == 0 or msg_len > 10485760:
        return None
    raw_body = sys.stdin.buffer.read(msg_len)
    return json.loads(raw_body.decode("utf-8"))


def send_message(obj):
    """发送一条 Native Messaging 响应"""
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


# ─── 命令处理器 ─────────────────────────────────────────────────────

def handle_ping(msg):
    """Ping 检测"""
    return {"success": True, "data": {"status": "pong", "host": "python"}}


def handle_check(msg):
    """检查更新：从云端获取 update.json（带重试机制，处理 416 等错误）"""
    import time

    def _fetch(url, extra_headers=None):
        """发起 HTTP 请求并返回解析后的 JSON 数据"""
        req = urllib.request.Request(url)
        req.add_header("User-Agent", USER_AGENT)
        req.add_header("Cache-Control", "no-cache")
        req.add_header("Pragma", "no-cache")
        if extra_headers:
            for k, v in extra_headers.items():
                req.add_header(k, v)
        resp = urllib.request.urlopen(req, timeout=15)
        data = json.loads(resp.read().decode("utf-8"))
        return data

    try:
        # 第一次尝试：加时间戳绕过 CDN 缓存
        sep = "&" if "?" in UPDATE_URL else "?"
        cache_bust_url = "%s%s%d" % (UPDATE_URL, sep, int(time.time()))
        _log("Check update (attempt 1, cache-bust): %s" % cache_bust_url)
        cloud_data = _fetch(cache_bust_url)
        _log("Cloud data: %s" % json.dumps(cloud_data, ensure_ascii=False))
        return {"success": True, "data": cloud_data}

    except urllib.error.HTTPError as e:
        _log("Check HTTPError (attempt 1): %s %s" % (e.code, e.reason))
        if e.code == 416:
            # 416 Range Not Satisfiable：CDN 可能误解 cache-busting 参数
            # 重试：使用原始 URL（不带 ?t= 参数），仅用抗缓存请求头
            try:
                _log("Check update (attempt 2, original URL, no cache-bust): %s" % UPDATE_URL)
                cloud_data = _fetch(UPDATE_URL)
                _log("Cloud data (retry): %s" % json.dumps(cloud_data, ensure_ascii=False))
                return {"success": True, "data": cloud_data}
            except urllib.error.HTTPError as e2:
                _log("Check HTTPError (attempt 2): %s %s" % (e2.code, e2.reason))
                if e2.code == 416:
                    # 第三次尝试：原始 URL + 更激进的抗缓存头
                    try:
                        _log("Check update (attempt 3, original URL, extra headers): %s" % UPDATE_URL)
                        cloud_data = _fetch(
                            UPDATE_URL,
                            extra_headers={
                                "If-None-Match": "",
                                "If-Modified-Since": "Thu, 01 Jan 1970 00:00:00 GMT",
                            },
                        )
                        _log("Cloud data (retry 2): %s" % json.dumps(cloud_data, ensure_ascii=False))
                        return {"success": True, "data": cloud_data}
                    except Exception as e3:
                        _log("Check failed (attempt 3): %s" % e3)
                        return {"success": False, "data": {"error": "获取更新信息失败：HTTP %s" % e3}}
                return {"success": False, "data": {"error": "获取更新信息失败：HTTP %s %s" % (e2.code, e2.reason)}}
            except Exception as e2:
                _log("Check failed (attempt 2): %s" % e2)
                return {"success": False, "data": {"error": "获取更新信息失败：%s" % e2}}
        # 其他 HTTP 错误直接返回
        return {"success": False, "data": {"error": "获取更新信息失败：HTTP %s %s" % (e.code, e.reason)}}

    except Exception as e:
        _log("Check failed: %s" % e)
        return {"success": False, "data": {"error": "获取更新信息失败：%s" % e}}


def handle_update(msg):
    """安装更新：下载 ZIP -> 解压到扩展目录"""
    download_url = msg.get("downloadUrl", "")
    if not download_url:
        return {"success": False, "data": {"error": "缺少 downloadUrl 参数"}}

    try:
        import tempfile
        import zipfile

        target_dir = os.environ.get("TOOLBOX_DIR", "")
        if not target_dir:
            # 第一优先：install.bat 写入 config.json 的 toolbox_dir（绝对路径，最可靠）
            target_dir = _cfg.get("toolbox_dir", "")
        if not target_dir:
            # 第二优先：自动检测同级 toolbox/ → 兼容开发环境 plugins/toolbox/
            project_root = os.path.dirname(SCRIPT_DIR)
            sibling_toolbox = os.path.join(project_root, "toolbox")
            if os.path.isdir(sibling_toolbox) and os.path.isfile(os.path.join(sibling_toolbox, "manifest.json")):
                target_dir = sibling_toolbox
            else:
                target_dir = os.path.join(project_root, "plugins", "toolbox")
        if not os.path.isdir(target_dir):
            return {"success": False, "data": {"error": "无法定位工具箱目录: %s" % target_dir}}

        _log("Downloading: %s" % download_url)
        _log("Target: %s" % target_dir)

        req = urllib.request.Request(download_url)
        req.add_header("User-Agent", USER_AGENT)
        resp = urllib.request.urlopen(req, timeout=120)

        tmp_zip = os.path.join(tempfile.gettempdir(), "toolbox-update.zip")
        with open(tmp_zip, "wb") as f:
            f.write(resp.read())

        _log("Downloaded to: %s" % tmp_zip)

        with zipfile.ZipFile(tmp_zip, "r") as zf:
            for member in zf.namelist():
                if not member.startswith("toolbox/") and not member.startswith("toolbox\\"):
                    continue
                if member.endswith("/") or member.endswith("\\"):
                    continue
                rel_path = member[8:]
                dest = os.path.join(target_dir, rel_path)
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with zf.open(member) as src, open(dest, "wb") as dst:
                    dst.write(src.read())

        _log("Extract complete")

        try:
            os.unlink(tmp_zip)
        except Exception:
            pass

        return {
            "success": True,
            "data": {
                "message": "更新已安装到 " + target_dir,
                "action": "reload_extension",
            }
        }
    except Exception as e:
        _log("Update failed: %s" % traceback.format_exc())
        return {"success": False, "data": {"error": "安装更新失败：%s" % e}}


# ─── 主入口 ──────────────────────────────────────────────────────────

def main():
    _log("STARTED PID=%s" % os.getpid())

    try:
        msg = read_message()
        if msg is None:
            _log("No message, exiting")
            sys.exit(0)

        _log("Command: %s" % msg.get("command", "?"))

        cmd = msg.get("command", "")

        if cmd == "ping":
            resp = handle_ping(msg)
        elif cmd == "check":
            resp = handle_check(msg)
        elif cmd == "update":
            resp = handle_update(msg)
        else:
            resp = {"success": False, "data": {"error": "未知命令: %s" % cmd}}

        send_message(resp)
        _log("Done")
    except Exception:
        _log("CRASH: %s" % traceback.format_exc())
        try:
            send_message({"success": False, "data": {"error": "Native Host 内部错误"}})
        except Exception:
            pass
        sys.exit(1)


if __name__ == "__main__":
    main()
