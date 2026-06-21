(function () {
  'use strict';

  // ============================================================
  // API 抓包调试器 — content script
  // 通过 chrome.runtime.getURL 加载 inject.js（不违反 CSP）
  // 在页面右下角创建浮动面板展示 API 请求
  // ============================================================

  var panelCreated = false;

  // 延迟等待页面准备好
  var initTimer = setInterval(function () {
    if (document.head || document.documentElement) {
      clearInterval(initTimer);
      injectHook();
    }
  }, 50);

  function injectHook() {
    // 注入 hook 脚本（文件方式，不违反 CSP）
    var s = document.createElement('script');
    s.src = chrome.runtime.getURL('inject.js');
    s.onload = function () { this.remove(); };
    (document.head || document.documentElement).appendChild(s);

    // 等页面 body 就绪后再创建面板
    var panelTimer = setInterval(function () {
      if (document.body) {
        clearInterval(panelTimer);
        if (!panelCreated) {
          panelCreated = true;
          createPanel();
        }
      }
    }, 100);
  }

  function createPanel() {
    // ---------- 样式 ----------
    var style = document.createElement('style');
    style.textContent =
      '#_adb_panel { position: fixed; bottom: 20px; right: 20px; width: 520px; max-height: 500px; background: #1e1e1e; color: #d4d4d4; font-family: Consolas,"Microsoft YaHei",monospace; font-size: 12px; border-radius: 8px; box-shadow: 0 4px 24px rgba(0,0,0,0.6); z-index: 2147483647; display: flex; flex-direction: column; overflow: hidden; }' +
      '#_adb_header { display: flex; align-items: center; padding: 6px 10px; background: #2d2d2d; border-bottom: 1px solid #444; flex-shrink: 0; }' +
      '#_adb_title { flex: 1; font-weight: bold; color: #4fc1ff; user-select: none; }' +
      '#_adb_header button { margin-left: 4px; padding: 3px 10px; border: none; border-radius: 3px; background: #555; color: #ddd; cursor: pointer; font-size: 11px; }' +
      '#_adb_header button:hover { background: #888; }' +
      '#_adb_header button._danger { background: #c62828; }' +
      '#_adb_header button._danger:hover { background: #e53935; }' +
      '#_adb_body { flex: 1; overflow-y: auto; padding: 4px 0; }' +
      '#_adb_logs { padding: 0 6px; }' +
      '._adb_empty { padding: 20px; text-align: center; color: #666; }' +
      '._adb_log { padding: 6px 8px; margin-bottom: 3px; border-radius: 4px; cursor: pointer; background: #252526; border-left: 3px solid #555; }' +
      '._adb_log:hover { background: #2d2d2d; }' +
      '._adb_log._g { border-left-color: #4fc1ff; }' +
      '._adb_log._p { border-left-color: #ce9178; }' +
      '._adb_log._ok { border-left-color: #4ec9b0; }' +
      '._adb_log._err { border-left-color: #f44336; }' +
      '._adb_log._pend { border-left-color: #ffd700; }' +
      '._adb_lt { display: flex; justify-content: space-between; font-weight: bold; gap: 10px; }' +
      '._adb_la { color: #ce9178; word-break: break-all; flex: 1; }' +
      '._adb_ls { white-space: nowrap; }' +
      '._adb_lm { color: #858585; font-size: 11px; margin-top: 2px; }' +
      '._adb_lp { color: #b5cea8; font-size: 11px; margin-top: 3px; max-height: 50px; overflow: hidden; }' +
      '#_adb_detail { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: #1e1e1e; display: none; flex-direction: column; }' +
      '#_adb_dh { display: flex; align-items: center; padding: 6px 10px; background: #2d2d2d; border-bottom: 1px solid #444; }' +
      '#_adb_dt { flex: 1; font-weight: bold; color: #4fc1ff; }' +
      '#_adb_dc { flex: 1; overflow-y: auto; padding: 10px; margin: 0; font-size: 12px; white-space: pre-wrap; word-break: break-all; color: #d4d4d4; }' +
      '#_adb_panel._min { height: auto; }' +
      '#_adb_panel._min #_adb_body,#_adb_panel._min #_adb_detail { display: none !important; }' +
      '#_adb_destroyed { display: none !important; }';
    document.head.appendChild(style);

    // ---------- 面板 DOM ----------
    var panel = document.createElement('div');
    panel.id = '_adb_panel';
    panel.innerHTML =
      '<div id="_adb_header">' +
      '<span id="_adb_title">🔍 API 抓包调试器</span>' +
      '<button id="_adb_btn_ex">导出</button>' +
      '<button id="_adb_btn_min">_</button>' +
      '<button id="_adb_btn_clr">清空</button>' +
      '<button id="_adb_btn_stop" class="_danger" title="停止Hook并移除面板">✕</button>' +
      '</div>' +
      '<div id="_adb_body">' +
      '<div id="_adb_logs"><div class="_adb_empty">等待 API 请求 (/prod-api/)...</div></div>' +
      '</div>' +
      '<div id="_adb_detail">' +
      '<div id="_adb_dh"><span id="_adb_dt">请求详情</span><button id="_adb_btn_back">← 返回</button></div>' +
      '<pre id="_adb_dc"></pre>' +
      '</div>';
    document.body.appendChild(panel);

    // ---------- 引用 ----------
    var logs = [];
    var logEl = document.getElementById('_adb_logs');
    var detailEl = document.getElementById('_adb_detail');
    var detailCont = document.getElementById('_adb_dc');

    function esc(s) {
      return String(s).replace(/[<>&]/g, function (c) {
        return { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c];
      });
    }

    function shortUrl(urlStr) {
      try {
        var u = new URL(urlStr);
        return u.pathname + u.search;
      } catch (e) {
        return urlStr;
      }
    }

    function renderLogs() {
      if (logs.length === 0) {
        logEl.innerHTML = '<div class="_adb_empty">等待 API 请求...</div>';
        return;
      }
      var html = '';
      for (var i = 0; i < logs.length; i++) {
        var e = logs[i];
        var sc = '';
        if (e.status === 'pending') sc = '_pend';
        else if (e.status >= 200 && e.status < 300) sc = '_ok';
        else if (e.status >= 400 || e.status === 'ERROR') sc = '_err';
        var mc = e.method === 'GET' ? '_g' : '_p';
        var preview = e.responsePreview ? e.responsePreview.substring(0, 100) : (e.status === 'pending' ? '...' : '无响应');
        html +=
          '<div class="_adb_log ' + sc + ' ' + mc + '" data-idx="' + i + '">' +
          '<div class="_adb_lt"><span>' + esc(e.method) + ' <span class="_adb_la">' + esc(shortUrl(e.url)) + '</span></span><span class="_adb_ls">' + esc(e.status) + (e.duration ? ' ' + e.duration + 'ms' : '') + '</span></div>' +
          '<div class="_adb_lm">' + esc((e.responseLength || 0) + ' bytes') + '</div>' +
          '<div class="_adb_lp">' + esc(preview) + '</div>' +
          '</div>';
      }
      logEl.innerHTML = html;

      // 绑定点击事件
      var items = logEl.querySelectorAll('._adb_log');
      for (var j = 0; j < items.length; j++) {
        (function (idx) {
          items[j].addEventListener('click', function () {
            detailCont.textContent = JSON.stringify(logs[idx], null, 2);
            detailEl.style.display = 'flex';
          });
        })(parseInt(items[j].getAttribute('data-idx'), 10));
      }

      // 滚到底部
      var body = document.getElementById('_adb_body');
      if (body) body.scrollTop = body.scrollHeight;
    }

    // 接收页面 hook 消息
    window.addEventListener('message', function (e) {
      if (!e.data || e.data.source !== 'api-debugger-hook') return;
      if (e.data.type === 'log') {
        logs.push(e.data.entry);
        renderLogs();
      } else if (e.data.type === 'update' && e.data.index >= 0 && e.data.index < logs.length) {
        logs[e.data.index] = e.data.entry;
        renderLogs();
      }
    });

    // 按钮事件
    document.getElementById('_adb_btn_clr').addEventListener('click', function () { logs = []; renderLogs(); });
    document.getElementById('_adb_btn_min').addEventListener('click', function () { panel.classList.toggle('_min'); });
    document.getElementById('_adb_btn_back').addEventListener('click', function () { detailEl.style.display = 'none'; });
    document.getElementById('_adb_btn_ex').addEventListener('click', function () {
      var blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'api-debug-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      a.click();
    });

    // 停止 Hook + 移除面板
    document.getElementById('_adb_btn_stop').addEventListener('click', function () {
      // 通过注入脚本调用页面主世界的 __apiDebuggerStop() 来停止 fetch hook
      var stopScript = document.createElement('script');
      stopScript.textContent = 'if(window.__apiDebuggerStop)window.__apiDebuggerStop();';
      (document.head || document.documentElement).appendChild(stopScript);
      stopScript.remove();

      // 完全移除面板
      if (panel && panel.parentNode) {
        panel.parentNode.removeChild(panel);
      }
      if (style && style.parentNode) {
        style.parentNode.removeChild(style);
      }

      console.log('[API-Debugger] 已停止 Hook 并移除面板');
    });

    function onMessage(e) {
      // 本面板已关闭时不再处理
      if (!document.getElementById('_adb_panel')) return;

      if (!e.data || e.data.source !== 'api-debugger-hook') return;
      if (e.data.type === 'log') {
        logs.push(e.data.entry);
        renderLogs();
      } else if (e.data.type === 'update' && e.data.index >= 0 && e.data.index < logs.length) {
        logs[e.data.index] = e.data.entry;
        renderLogs();
      }
    }
  }
})();
