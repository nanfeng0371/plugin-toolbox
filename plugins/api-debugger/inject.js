(function () {
  'use strict';

  // ============================================================
  // 注入脚本：仅 hook fetch（不 hook XHR，避免与 SPA 框架冲突）
  // 通过 postMessage 把请求信息发送给 content.js 的面板
  // ============================================================

  var LOGS = [];
  var origFetch = window.fetch;
  var isHookActive = true;

  function pushLog(entry) {
    if (!isHookActive) return;
    LOGS.push(entry);
    window.postMessage({ source: 'api-debugger-hook', type: 'log', entry: entry }, '*');
  }

  // 暴露停止方法给 content.js 调用
  window.__apiDebuggerStop = function () {
    if (!isHookActive) return;
    isHookActive = false;
    if (window.fetch === hookedFetch) {
      window.fetch = origFetch;
    }
    console.log('[API-Debugger] hook stopped');
  };

  function hookedFetch() {
    if (!isHookActive) {
      return origFetch.apply(this, arguments);
    }

    var url = arguments[0];
    var opts = arguments[1] || {};
    var startTime = performance.now();

    var urlStr;
    if (typeof url === 'string') urlStr = url;
    else if (url && url.href) urlStr = url.href;
    else urlStr = String(url);

    // 只记录 API 请求
    var isApi = urlStr.indexOf('/prod-api/') !== -1 || urlStr.indexOf('/api/') !== -1;
    var logIndex = -1;

    if (isApi) {
      pushLog({
        type: 'fetch',
        url: urlStr,
        method: (opts.method || 'GET').toUpperCase(),
        headers: opts.headers || null,
        body: opts.body || null,
        time: new Date().toISOString(),
        status: 'pending'
      });
      logIndex = LOGS.length - 1;
    }

    return origFetch.apply(this, arguments).then(function (resp) {
      if (logIndex >= 0 && isHookActive) {
        var clone = resp.clone();
        var status = resp.status;
        clone.text().then(function (text) {
          if (!isHookActive) return;
          LOGS[logIndex].status = status;
          LOGS[logIndex].duration = (performance.now() - startTime).toFixed(1);
          LOGS[logIndex].responsePreview = text.length > 2000 ? text.substring(0, 2000) + '...' : text;
          LOGS[logIndex].responseLength = text.length;
          window.postMessage({ source: 'api-debugger-hook', type: 'update', index: logIndex, entry: LOGS[logIndex] }, '*');
        }).catch(function () {
          if (!isHookActive) return;
          LOGS[logIndex].status = status;
          LOGS[logIndex].duration = (performance.now() - startTime).toFixed(1);
          window.postMessage({ source: 'api-debugger-hook', type: 'update', index: logIndex, entry: LOGS[logIndex] }, '*');
        });
      }
      return resp;
    }).catch(function (err) {
      if (logIndex >= 0 && isHookActive) {
        LOGS[logIndex].status = 'ERROR';
        LOGS[logIndex].error = err.message;
        LOGS[logIndex].duration = (performance.now() - startTime).toFixed(1);
        window.postMessage({ source: 'api-debugger-hook', type: 'update', index: logIndex, entry: LOGS[logIndex] }, '*');
      }
      throw err;
    });
  }

  window.fetch = hookedFetch;

  console.log('[API-Debugger Hook] fetch hooked, listening for /prod-api/ and /api/');
})();
