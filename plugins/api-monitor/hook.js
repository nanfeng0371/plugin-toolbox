(function () {
  'use strict';
  if (window.__apiMonitorHooked) return;
  window.__apiMonitorHooked = true;

  let _listening = true;
  let _reqId = 0;

  function send(type, data) {
    if (!_listening) return;
    window.postMessage({ source: '__api_monitor_hook__', type: type, payload: data }, '*');
  }

  // ===== 拦截 fetch =====
  const _origFetch = window.fetch;
  window.fetch = async function (...args) {
    const [url, opts = {}] = args;
    const id = ++_reqId;
    const method = (opts.method || 'GET').toUpperCase();
    const reqBody = opts.body || '';
    const startTime = Date.now();

    try {
      const resp = await _origFetch.apply(this, args);
      const clone = resp.clone();
      const respBody = await clone.text().catch(() => '[无法读取响应体]');

      send('request', {
        id: id,
        method: method,
        url: typeof url === 'string' ? url : url.href,
        reqHeaders: opts.headers || {},
        reqBody: typeof reqBody === 'string' ? reqBody : '[Binary]',
        status: resp.status,
        statusText: resp.statusText,
        respHeaders: Object.fromEntries(resp.headers.entries()),
        respBody: respBody,
        duration: Date.now() - startTime,
        type: 'fetch',
        time: new Date().toLocaleTimeString()
      });

      return resp;
    } catch (err) {
      send('request', {
        id: id,
        method: method,
        url: typeof url === 'string' ? url : url.href,
        reqHeaders: opts.headers || {},
        reqBody: typeof reqBody === 'string' ? reqBody : '[Binary]',
        status: 0,
        statusText: err.message || 'Network Error',
        respHeaders: {},
        respBody: err.message || '[Error]',
        duration: Date.now() - startTime,
        type: 'fetch',
        error: true,
        time: new Date().toLocaleTimeString()
      });
      throw err;
    }
  };

  // ===== 拦截 XMLHttpRequest =====
  const _origXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    const xhr = new _origXHR();
    const _origOpen = xhr.open;
    const _origSend = xhr.send;
    const _origSetHeader = xhr.setRequestHeader;
    let id = ++_reqId;
    let method = 'GET';
    let url = '';
    let reqHeaders = {};
    let reqBody = '';
    let startTime = 0;

    xhr.open = function (m, u, async, user, password) {
      method = m.toUpperCase();
      url = u;
      return _origOpen.apply(this, arguments);
    };

    xhr.setRequestHeader = function (header, value) {
      reqHeaders[header] = value;
      return _origSetHeader.apply(this, arguments);
    };

    xhr.send = function (body) {
      reqBody = body || '';
      startTime = Date.now();

      const onReady = function () {
        if (xhr.readyState !== 4) return;
        const respBody = xhr.responseText || '[空响应]';

        send('request', {
          id: id,
          method: method,
          url: url,
          reqHeaders: reqHeaders,
          reqBody: typeof reqBody === 'string' ? reqBody : '[Binary]',
          status: xhr.status,
          statusText: xhr.statusText,
          respHeaders: parseResponseHeaders(xhr.getAllResponseHeaders()),
          respBody: respBody,
          duration: Date.now() - startTime,
          type: 'xhr',
          time: new Date().toLocaleTimeString()
        });
      };

      xhr.addEventListener('loadend', onReady);
      return _origSend.apply(this, arguments);
    };

    return xhr;
  };

  function parseResponseHeaders(raw) {
    const headers = {};
    if (!raw) return headers;
    raw.split('\r\n').forEach(function (line) {
      const idx = line.indexOf(': ');
      if (idx > 0) headers[line.substring(0, idx)] = line.substring(idx + 2);
    });
    return headers;
  }

  // ===== 接收控制命令 =====
  window.addEventListener('message', function (e) {
    if (e.data && e.data.source === '__api_monitor_ctrl__') {
      if (e.data.action === 'stop') _listening = false;
      if (e.data.action === 'start') _listening = true;
    }
  });

})();
