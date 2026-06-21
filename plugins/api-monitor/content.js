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
      // 附加当前页面元数据
      const payload = Object.assign({}, e.data.payload, {
        pageUrl: location.href,
        pageTitle: document.title,
        pageHost: location.hostname
      });
      // 转发给 background
      chrome.runtime.sendMessage({ action: 'NEW_REQUEST', data: payload })
        .catch(() => {});
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
