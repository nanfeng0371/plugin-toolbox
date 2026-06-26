(function () {
  'use strict';

  // ===== 注入 hook.js 到页面主世界 =====
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('hook.js');
  script.onload = function () { this.remove(); };
  (document.head || document.documentElement).appendChild(script);

  // ===== 接收 hook.js 发来的拦截数据 =====
  window.addEventListener('message', function (e) {
    if (e.data && e.data.source === '__api_monitor_hook__') {
      var msgType = e.data.type;
      // API 请求数据 → 附加页面元数据
      if (msgType === 'request') {
        const payload = Object.assign({}, e.data.payload, {
          pageUrl: location.href,
          pageTitle: document.title,
          pageHost: location.hostname
        });
        chrome.runtime.sendMessage({ action: 'NEW_REQUEST', data: payload }).catch(function () {});
      }
      // 🆕 DOM 快照 → 直接转发
      if (msgType === 'dom_snapshot') {
        chrome.runtime.sendMessage({ action: 'DOM_SNAPSHOT', data: e.data.payload }).catch(function () {});
      }
      // 🆕 录制状态 → 转发
      if (msgType === 'recording_status') {
        chrome.runtime.sendMessage({ action: 'RECORDING_STATUS', data: e.data.payload }).catch(function () {});
      }
      // 🆕 录制数据 → 附加页面URL后转发
      if (msgType === 'recording_data') {
        var recData = Object.assign({}, e.data.payload, {
          pageUrl: location.href,
          pageTitle: document.title
        });
        chrome.runtime.sendMessage({ action: 'RECORDING_DATA', data: recData }).catch(function () {});
      }
    }
  });

  // ===== 接收 popup/background 的控制命令 =====
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg.action === 'TOGGLE_LISTENING') {
      window.postMessage({
        source: '__api_monitor_ctrl__',
        action: msg.listening ? 'start' : 'stop'
      }, '*');
      sendResponse({ ok: true });
    }
    // 🆕 DOM 扫描
    if (msg.action === 'SCAN_DOM') {
      window.postMessage({ source: '__api_monitor_ctrl__', action: 'scan_dom' }, '*');
      sendResponse({ ok: true });
    }
    // 🆕 录制控制
    if (msg.action === 'START_RECORDING') {
      window.postMessage({ source: '__api_monitor_ctrl__', action: 'start_recording' }, '*');
      sendResponse({ ok: true });
    }
    if (msg.action === 'STOP_RECORDING') {
      window.postMessage({ source: '__api_monitor_ctrl__', action: 'stop_recording' }, '*');
      sendResponse({ ok: true });
    }
    // v1.2.0: 同源测试 — 从 content script 上下文尝试 fetch
    if (msg.action === 'TEST_FETCH') {
      const testUrl = msg.url;
      const startTime = Date.now();
      fetch(testUrl, { credentials: 'include' })
        .then(async function (resp) {
          const text = await resp.text().catch(function () { return ''; });
          sendResponse({
            success: true,
            status: resp.status,
            duration: Date.now() - startTime,
            origin: location.origin,
            apiOrigin: new URL(testUrl).origin,
            sameOrigin: location.origin === new URL(testUrl).origin,
            preview: text.substring(0, 500)
          });
        })
        .catch(function (err) {
          sendResponse({
            success: false,
            error: err.message,
            origin: location.origin,
            apiOrigin: (function () { try { return new URL(testUrl).origin; } catch (e) { return '?'; } })(),
            sameOrigin: (function () { try { return location.origin === new URL(testUrl).origin; } catch (e) { return false; } })()
          });
        });
      return true; // 异步 sendResponse
    }
    return true;
  });

})();
