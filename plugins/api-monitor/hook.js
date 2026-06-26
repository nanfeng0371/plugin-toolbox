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
      if (e.data.action === 'scan_dom') scanDOM();
      if (e.data.action === 'start_recording') startRecording();
      if (e.data.action === 'stop_recording') stopRecording();
    }
  });

  // ==========================================
  // 🆕 维度1：DOM 结构扫描
  // ==========================================
  function scanDOM() {
    var result = {
      type: 'dom_snapshot',
      time: new Date().toISOString(),
      url: location.href,
      title: document.title,
      tables: [],
      forms: [],
      inputs: [],
      buttons: [],
      selects: [],
      textareas: []
    };

    // 扫描所有表格
    var tables = document.querySelectorAll('table');
    tables.forEach(function (t, ti) {
      var info = { index: ti, id: t.id || '', className: t.className || '', rowCount: t.rows.length };
      // 表头
      var headers = [];
      var ths = t.querySelectorAll('th');
      ths.forEach(function (th) { headers.push((th.textContent || '').trim().substring(0, 50)); });
      info.headers = headers;
      // 列数
      if (t.rows.length > 0) {
        info.colCount = t.rows[0].cells.length;
      }
      // 第一行数据示例
      if (t.rows.length > 1 && headers.length === 0) {
        // 无 th 时用第一行作为列名参考
        var sampleRow = [];
        for (var c = 0; c < t.rows[0].cells.length; c++) {
          sampleRow.push((t.rows[0].cells[c].textContent || '').trim().substring(0, 80));
        }
        info.sampleRow = sampleRow;
      }
      // 检测数据行中的关键元素
      var rowElements = {};
      if (t.rows.length > 1) {
        var dataRow = t.rows[1];
        for (var c2 = 0; c2 < dataRow.cells.length; c2++) {
          var cell = dataRow.cells[c2];
          var inputs = cell.querySelectorAll('input, select, textarea, button');
          if (inputs.length > 0) {
            rowElements['col' + c2] = [];
            inputs.forEach(function (inp) {
              rowElements['col' + c2].push({
                tag: inp.tagName.toLowerCase(),
                type: inp.type || '',
                className: inp.className || '',
                id: inp.id || '',
                name: inp.name || '',
                placeholder: (inp.placeholder || '').substring(0, 50)
              });
            });
          }
        }
      }
      if (Object.keys(rowElements).length > 0) info.rowElements = rowElements;
      result.tables.push(info);
    });

    // 扫描所有输入框
    var allInputs = document.querySelectorAll('input:not([type="hidden"])');
    allInputs.forEach(function (inp) {
      var rect = inp.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return; // 跳过不可见
      result.inputs.push({
        tag: 'input',
        type: inp.type || 'text',
        className: inp.className || '',
        id: inp.id || '',
        name: inp.name || '',
        placeholder: (inp.placeholder || '').substring(0, 50),
        value: inp.value ? inp.value.substring(0, 100) : '',
        readonly: inp.readOnly,
        disabled: inp.disabled,
        parentTag: (inp.parentElement && inp.parentElement.tagName || '').toLowerCase(),
        parentClass: (inp.parentElement && inp.parentElement.className || '').substring(0, 80)
      });
    });

    // 扫描选择框
    var allSelects = document.querySelectorAll('select');
    allSelects.forEach(function (sel) {
      result.selects.push({
        tag: 'select',
        className: sel.className || '',
        id: sel.id || '',
        name: sel.name || '',
        optionCount: sel.options.length,
        value: sel.value || ''
      });
    });

    // 扫描文本框
    var allTextareas = document.querySelectorAll('textarea');
    allTextareas.forEach(function (ta) {
      result.textareas.push({
        tag: 'textarea',
        className: ta.className || '',
        id: ta.id || '',
        name: ta.name || '',
        placeholder: (ta.placeholder || '').substring(0, 50),
        value: ta.value ? ta.value.substring(0, 100) : ''
      });
    });

    // 扫描按钮
    var allButtons = document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]');
    allButtons.forEach(function (btn) {
      var text = (btn.textContent || btn.value || btn.getAttribute('aria-label') || '').trim().substring(0, 50);
      if (!text) return;
      result.buttons.push({
        tag: btn.tagName.toLowerCase(),
        text: text,
        className: btn.className || '',
        id: btn.id || '',
        type: btn.type || ''
      });
    });

    // 扫描表单
    var allForms = document.querySelectorAll('form');
    allForms.forEach(function (f) {
      result.forms.push({
        id: f.id || '',
        className: f.className || '',
        action: f.action || '',
        method: f.method || '',
        inputCount: f.querySelectorAll('input, select, textarea').length
      });
    });

    // 🆕 尝试读取 React Fiber（React 页面专用）
    try {
      var reactRoot = document.getElementById('root') || document.getElementById('app') || document.body;
      var fiberKey = Object.keys(reactRoot).find(function (k) { return k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'); });
      result.hasReact = !!fiberKey;
      if (fiberKey) result.reactKey = fiberKey;
    } catch (e) { result.hasReact = false; }

    // 🆕 尝试读取 Vue 实例
    try {
      var vueRoot = document.getElementById('app') || document.body;
      result.hasVue = !!(vueRoot.__vue__ || vueRoot._vnode || vueRoot.__vue_app__);
    } catch (e) { result.hasVue = false; }

    send('dom_snapshot', result);
  }

  // ==========================================
  // 🆕 维度2：用户交互录制
  // ==========================================
  var _recording = false;
  var _recordStartTime = 0;
  var _recordEvents = [];

  function startRecording() {
    _recording = true;
    _recordStartTime = Date.now();
    _recordEvents = [];
    send('recording_status', { recording: true, startTime: new Date().toISOString() });
  }

  function stopRecording() {
    _recording = false;
    send('recording_data', {
      events: _recordEvents,
      duration: Date.now() - _recordStartTime,
      startTime: new Date(_recordStartTime).toISOString()
    });
    _recordEvents = [];
  }

  function recordEvent(type, detail) {
    if (!_recording) return;
    _recordEvents.push({
      time: Date.now() - _recordStartTime,
      type: type,
      detail: detail
    });
  }

  // 监听点击事件（捕获阶段，确保拿到所有点击）
  document.addEventListener('click', function (e) {
    if (!_recording) return;
    var target = e.target;
    // 构建元素描述
    var desc = {
      tag: target.tagName.toLowerCase(),
      className: (target.className || '').substring(0, 80),
      id: target.id || '',
      text: (target.textContent || target.value || '').trim().substring(0, 60),
      type: target.type || '',
      name: target.name || ''
    };
    // 找最近的可标识父元素（带 id 或 data- 属性）
    var parent = target.closest('[id], [data-id], [data-row-key], [data-key], tr, .row, .card, [class*="item"]');
    if (parent && parent !== target) {
      desc.parentTag = parent.tagName.toLowerCase();
      desc.parentId = parent.id || '';
      desc.parentClass = (parent.className || '').substring(0, 80);
      desc.parentDataId = parent.getAttribute('data-id') || parent.getAttribute('data-row-key') || parent.getAttribute('data-key') || '';
    }
    recordEvent('click', desc);
  }, true);

  // 监听输入事件（用于 React/Vue 受控组件）
  document.addEventListener('input', function (e) {
    if (!_recording) return;
    var target = e.target;
    var tag = target.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return;
    recordEvent('input', {
      tag: tag,
      type: target.type || '',
      className: target.className || '',
      id: target.id || '',
      name: target.name || '',
      value: target.value ? target.value.substring(0, 100) : '',
      parentClass: (target.parentElement && target.parentElement.className || '').substring(0, 60)
    });
  }, true);

  // 监听 change 事件
  document.addEventListener('change', function (e) {
    if (!_recording) return;
    var target = e.target;
    var tag = target.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return;
    recordEvent('change', {
      tag: tag,
      type: target.type || '',
      className: target.className || '',
      id: target.id || '',
      name: target.name || '',
      value: target.value ? target.value.substring(0, 100) : '',
      checked: target.checked
    });
  }, true);

  // 监听 focus/blur（帮助判断输入结束）
  document.addEventListener('focus', function (e) {
    if (!_recording) return;
    var target = e.target;
    var tag = target.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return;
    recordEvent('focus', {
      tag: tag,
      type: target.type || '',
      className: target.className || '',
      id: target.id || '',
      name: target.name || ''
    });
  }, true);

  document.addEventListener('blur', function (e) {
    if (!_recording) return;
    var target = e.target;
    var tag = target.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return;
    recordEvent('blur', {
      tag: tag,
      type: target.type || '',
      className: target.className || '',
      id: target.id || '',
      name: target.name || '',
      value: target.value ? target.value.substring(0, 100) : ''
    });
  }, true);

})();
