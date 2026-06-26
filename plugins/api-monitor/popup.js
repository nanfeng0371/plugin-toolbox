(function () {
  'use strict';

  // ===== 课堂接口分类规则（关键词匹配 URL） =====
  const CATEGORY_RULES = [
    { cat: 'lesson',  keywords: ['/lesson/', 'queryCoursePeriodReport', 'coursePeriod', 'classRoom', 'classroom', '/class/'] },
    { cat: 'student', keywords: ['/student/', 'studentInfo', 'student/info', 'getStudentList', 'studentList'] },
    { cat: 'report',  keywords: ['/report/', 'summary', 'analyzeReport', 'reportDetail'] },
    { cat: 'biz',     keywords: ['biz', 'broadcastType', 's1.aiv5', 'aiv5.cc'] }
  ];

  function categorize(url) {
    if (!url) return 'other';
    const lower = url.toLowerCase();
    for (const rule of CATEGORY_RULES) {
      if (rule.keywords.some(k => lower.includes(k.toLowerCase()))) {
        return rule.cat;
      }
    }
    return 'other';
  }

  // ===== 状态 =====
  let _requests = [];
  let _listening = true;
  let _filterUrl = '';
  let _filterDomain = '';
  let _filterCategory = '';
  let _detailIdx = -1;

  const $ = function (id) { return document.getElementById(id); };

  // ===== 初始化 =====
  init();

  async function init() {
    await loadRequests();
    renderList();
    bindEvents();
    // 定期刷新
    setInterval(async function () {
      await loadRequests();
      renderList();
    }, 1500);
  }

  function bindEvents() {
    $('btnToggle').onclick = toggleListening;
    $('btnClear').onclick = clearRequests;
    $('btnExportAll').onclick = exportAllJSON;
    $('btnTestFetch').onclick = runTestFetch;
    $('btnCloseOrigin').onclick = closeOriginPanel;
    // 🆕 诊断按钮
    $('btnScanDom').onclick = scanDOM;
    $('btnStartRecord').onclick = startRecording;
    $('btnStopRecord').onclick = stopRecording;
    $('btnGenReport').onclick = generateReport;
    $('btnCloseDiag').onclick = closeDiagPanel;
    $('btnExportDiag').onclick = exportDiagData;
    $('filterInput').oninput = function () {
      _filterUrl = this.value.trim().toLowerCase();
      renderList();
    };
    $('domainFilter').onchange = function () {
      _filterDomain = this.value;
      renderList();
    };
    $('categoryFilter').onchange = function () {
      _filterCategory = this.value;
      renderList();
    };
    $('btnCloseDetail').onclick = closeDetail;
    $('btnCopyDetail').onclick = copyCurrentDetail;
  }

  // ===== 加载请求 =====
  async function loadRequests() {
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'GET_REQUESTS' });
      _requests = (resp && resp.requests) || [];
      $('countBadge').textContent = _requests.length + ' 条';
      updateStats();
    } catch (e) {
      console.warn('[Popup] load requests failed:', e.message);
    }
  }

  // ===== 统计栏更新 =====
  function updateStats() {
    const counts = { lesson: 0, student: 0, report: 0, biz: 0, other: 0 };
    _requests.forEach(function (r) {
      const cat = r._category || categorize(r.url);
      counts[cat] = (counts[cat] || 0) + 1;
    });
    $('statLesson').textContent  = counts.lesson;
    $('statStudent').textContent = counts.student;
    $('statReport').textContent  = counts.report;
    $('statBiz').textContent     = counts.biz;
    $('statOther').textContent   = counts.other;
  }

  // ===== 切换监听 =====
  async function toggleListening() {
    _listening = !_listening;
    const btn = $('btnToggle');
    btn.textContent = _listening ? '⏸ 停止' : '▶ 开启';
    btn.className = _listening ? 'btn danger' : 'btn primary';
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]) {
        await chrome.tabs.sendMessage(tabs[0].id, { action: 'TOGGLE_LISTENING', listening: _listening });
      }
    } catch (e) { /* 忽略 */ }
  }

  // ===== 清空请求 =====
  async function clearRequests() {
    await chrome.runtime.sendMessage({ action: 'CLEAR_REQUESTS' });
    _requests = [];
    $('countBadge').textContent = '0 条';
    renderList();
    updateStats();
  }

  // ===== 导出全部 JSON（增强版，含分析摘要） =====
  async function exportAllJSON() {
    const resp = await chrome.runtime.sendMessage({ action: 'GET_REQUESTS' });
    const all = (resp && resp.requests) || [];

    // 为每条请求附加分类
    const enriched = all.map(function (r) {
      return Object.assign({}, r, { _category: r._category || categorize(r.url) });
    });

    // 生成摘要：各接口 URL 去重统计
    const urlStats = {};
    enriched.forEach(function (r) {
      // 去掉 query string，只统计路径
      let path = r.url || '';
      try { path = new URL(r.url).pathname; } catch (e) {}
      urlStats[path] = (urlStats[path] || 0) + 1;
    });
    const urlStatsSorted = Object.entries(urlStats)
      .sort((a, b) => b[1] - a[1])
      .map(([path, count]) => ({ path, count }));

    const output = {
      _meta: {
        exportTime: new Date().toISOString(),
        totalRequests: enriched.length,
        tool: 'API 接口监听器 v1.3.0'
      },
      _urlStats: urlStatsSorted,
      requests: enriched
    };

    const blob = new Blob([JSON.stringify(output, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'api-capture-' + new Date().toISOString().slice(0, 19).replace(/:/g, '-') + '.json';
    a.click();
    URL.revokeObjectURL(url);

    // 按钮反馈
    const btn = $('btnExportAll');
    const orig = btn.textContent;
    btn.textContent = '✅ 已导出';
    setTimeout(function () { btn.textContent = orig; }, 1500);
  }

  // ===== 渲染列表 =====
  function renderList() {
    const list = $('requestList');
    let filtered = _requests.map(function (r, rawIdx) {
      return Object.assign({}, r, { _rawIdx: rawIdx, _category: r._category || categorize(r.url) });
    });

    // 域名筛选
    if (_filterDomain) {
      filtered = filtered.filter(function (r) {
        return r.pageHost && r.pageHost.includes(_filterDomain);
      });
    }
    // 分类筛选
    if (_filterCategory) {
      filtered = filtered.filter(function (r) { return r._category === _filterCategory; });
    }
    // URL 关键词
    if (_filterUrl) {
      filtered = filtered.filter(function (r) {
        return r.url && r.url.toLowerCase().includes(_filterUrl);
      });
    }

    if (filtered.length === 0) {
      list.innerHTML = '<div class="empty">' + (_filterUrl || _filterDomain || _filterCategory ? '没有匹配的请求' : '暂无捕获的请求') + '</div>';
      return;
    }

    list.innerHTML = filtered.map(function (r) {
      const idx = r._rawIdx;
      const cat = r._category || 'other';
      const statusClass = r.status >= 200 && r.status < 400 ? 'ok' : 'error';
      const baseClass = r.error ? 'request-item error' : 'request-item ok';
      const highlightClass = cat !== 'other' ? ' highlight-' + cat : '';
      const urlShort = (r.url || '?').substring(0, 50) + ((r.url || '').length > 50 ? '...' : '');
      const tagHtml = '<span class="tag tag-' + cat + '">' + catLabel(cat) + '</span>';
      const pageInfo = r.pageHost ? '<div class="req-page">🌐 ' + htmlEscape(r.pageHost) + '</div>' : '';

      return '<div class="' + baseClass + highlightClass + '" data-idx="' + idx + '">' +
        '<div class="req-top">' +
          '<span class="req-method ' + (r.method || 'GET') + '">' + (r.method || 'GET') + '</span>' +
          '<span class="req-url">' + htmlEscape(urlShort) + '</span>' +
          tagHtml +
          '<span class="req-status ' + statusClass + '">' + (r.status || '?') + '</span>' +
          '<button class="btn-copy-row" data-copy-idx="' + idx + '" title="复制此请求">📋</button>' +
        '</div>' +
        '<div class="req-meta">' +
          '<span>' + (r.time || '') + '</span>' +
          '<span>' + (r.duration ? r.duration + 'ms' : '') + '</span>' +
          '<span>' + (r.type || 'fetch') + '</span>' +
        '</div>' +
        pageInfo +
      '</div>';
    }).join('');

    // 绑定事件
    list.querySelectorAll('.request-item').forEach(function (el) {
      el.onclick = function () { showDetail(parseInt(this.dataset.idx)); };
    });
    list.querySelectorAll('.btn-copy-row').forEach(function (btn) {
      btn.onclick = function (e) {
        e.stopPropagation();
        copyRequestJson(parseInt(this.dataset.copyIdx));
      };
    });

    if ($('autoScroll').checked) {
      list.scrollTop = list.scrollHeight;
    }
  }

  function catLabel(cat) {
    const map = { lesson: '课堂', student: '学生', report: '报告', biz: '业务', other: '其他' };
    return map[cat] || cat;
  }

  // ===== 显示详情 =====
  function showDetail(idx) {
    const r = _requests[idx];
    if (!r) return;
    _detailIdx = idx;
    const cat = r._category || categorize(r.url);

    $('detailPanel').style.display = 'flex';
    $('detailBody').innerHTML =
      '<div class="detail-section"><h4>URL</h4><pre>' + htmlEscape(r.url || '?') + '</pre></div>' +
      '<div class="detail-section"><h4>页面来源</h4><pre>' + htmlEscape((r.pageTitle || '') + '\n' + (r.pageUrl || '')) + '</pre></div>' +
      '<div class="detail-section"><h4>状态 / 分类</h4><pre>' + r.status + ' ' + (r.statusText || '') + ' · ' + (r.duration || '?') + 'ms · <b>' + catLabel(cat) + '</b></pre></div>' +
      '<div class="detail-section"><h4>请求头</h4><pre>' + headersToText(r.reqHeaders) + '</pre></div>' +
      '<div class="detail-section"><h4>请求体</h4><pre>' + formatBody(r.reqBody) + '</pre></div>' +
      '<div class="detail-section"><h4>响应头</h4><pre>' + headersToText(r.respHeaders) + '</pre></div>' +
      '<div class="detail-section"><h4>响应体</h4><pre>' + formatBody(r.respBody) + '</pre></div>' +
      '<div class="detail-section"><h4>时间</h4><pre>' + htmlEscape(r.time || '') + '</pre></div>';
  }

  function closeDetail() {
    $('detailPanel').style.display = 'none';
    _detailIdx = -1;
  }

  // ===== 复制 =====
  function copyRequestJson(idx) {
    const r = _requests[idx];
    if (!r) return;
    copyToClipboard(JSON.stringify(r, null, 2));
  }

  function copyCurrentDetail() {
    if (_detailIdx >= 0) copyRequestJson(_detailIdx);
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      flashCopyFeedback();
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-9999px;';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      flashCopyFeedback();
    }
  }

  function flashCopyFeedback() {
    const dbtn = $('btnCopyDetail');
    if (dbtn) {
      dbtn.textContent = '✅ 已复制';
      setTimeout(function () { dbtn.textContent = '📋 复制'; }, 1000);
    }
  }

  // ===== v1.2.0: 同源测试 =====
  async function runTestFetch() {
    const btn = $('btnTestFetch');
    const panel = $('originPanel');
    const body = $('originBody');
    const origText = btn.textContent;
    btn.textContent = '⏳ 测试中...';
    btn.disabled = true;

    panel.style.display = 'block';
    body.innerHTML = '<div style="padding:8px;color:#6c757d;">⏳ 正在从当前页面上下文尝试 fetch 爱芯 API...</div>';

    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]) {
        body.innerHTML = '<div class="origin-error">❌ 无法获取当前标签页</div>';
        return;
      }

      // 用已知可用的 API 做测试
      const testUrl = 'https://ai-genesis.yuaiweiwu.com/prod-api/authorization/api/user/bizInfo?id=3185';
      const resp = await chrome.tabs.sendMessage(tabs[0].id, { action: 'TEST_FETCH', url: testUrl });

      if (resp && resp.success) {
        const sameOrigin = resp.sameOrigin;
        const verdict = sameOrigin
          ? '✅ <b style="color:#155724;">同源！content.js 可以直接 fetch 爱芯 API</b>'
          : '⚠️ <b style="color:#856404;">跨域！content.js 不能直接 fetch，需要换 background.js 调</b>';
        body.innerHTML =
          '<div class="origin-result ' + (sameOrigin ? 'origin-ok' : 'origin-warn') + '">' +
            verdict + '<br>' +
            '<small>页面 origin: ' + htmlEscape(resp.origin) + '</small><br>' +
            '<small>API origin:  ' + htmlEscape(resp.apiOrigin) + '</small><br>' +
            '<small>HTTP status: ' + resp.status + ' · 耗时 ' + resp.duration + 'ms</small><br>' +
            '<small>响应预览: ' + htmlEscape((resp.preview || '').substring(0, 200)) + '</small>' +
          '</div>';
      } else {
        const errMsg = resp ? resp.error : '无响应';
        body.innerHTML =
          '<div class="origin-error">' +
            '❌ <b>fetch 失败！content.js 无法直接调用 API</b><br>' +
            '<small>错误: ' + htmlEscape(errMsg) + '</small><br>' +
            (resp && resp.sameOrigin !== undefined
              ? '<small>页面 origin: ' + htmlEscape(resp.origin) + ' · API origin: ' + htmlEscape(resp.apiOrigin) + '</small>'
              : '') +
          '</div>';
      }
    } catch (e) {
      body.innerHTML =
        '<div class="origin-error">' +
          '❌ <b>通信失败</b><br>' +
          '<small>错误: ' + htmlEscape(e.message) + '</small><br>' +
          '<small>提示：请确保当前标签页是爱芯后台页面</small>' +
        '</div>';
    }
    btn.textContent = origText;
    btn.disabled = false;
  }

  function closeOriginPanel() {
    $('originPanel').style.display = 'none';
  }

  // ===== 工具函数 =====
  function htmlEscape(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function headersToText(headers) {
    if (!headers || Object.keys(headers).length === 0) return '(无)';
    let text = '';
    Object.keys(headers).forEach(function (k) { text += k + ': ' + headers[k] + '\n'; });
    return htmlEscape(text.trim());
  }

  function formatBody(body) {
    if (!body) return '(空)';
    if (body === '[Binary]') return body;
    try {
      return htmlEscape(JSON.stringify(JSON.parse(body), null, 2));
    } catch (e) {
      return htmlEscape(body);
    }
  }

  // ==========================================
  // 🆕 v1.3.0: 诊断功能
  // ==========================================

  // 发送命令到当前标签页
  async function sendToActiveTab(action, extra) {
    try {
      var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]) return null;
      var msg = Object.assign({ action: action }, extra || {});
      return await chrome.tabs.sendMessage(tabs[0].id, msg);
    } catch (e) {
      return null;
    }
  }

  // 🔍 扫描页面 DOM
  async function scanDOM() {
    var btn = $('btnScanDom');
    var origText = btn.textContent;
    btn.textContent = '⏳ 扫描中...';
    btn.disabled = true;

    await sendToActiveTab('SCAN_DOM');

    // 等一会儿让快照存到 storage
    setTimeout(async function () {
      btn.textContent = '✅ 已扫描';
      btn.disabled = false;
      setTimeout(function () { btn.textContent = origText; }, 1500);
      // 自动展示快照
      await showSnapshots();
    }, 500);
  }

  // 展示 DOM 快照
  async function showSnapshots() {
    var result = await chrome.storage.local.get(['__api_monitor_snapshots__']);
    var snapshots = result.__api_monitor_snapshots__ || [];
    if (snapshots.length === 0) {
      showDiagPanel('🔍 DOM 扫描', '<div style="padding:10px;color:#999;">暂无快照，请先点击"扫描页面"</div>');
      return;
    }
    var snap = snapshots[0];
    var html = '';
    // 框架检测
    var framework = '';
    if (snap.hasReact) framework += '<span class="badge-react">React</span> ';
    if (snap.hasVue) framework += '<span class="badge-vue">Vue</span> ';
    html += '<div class="diag-section"><strong>页面：</strong>' + htmlEscape(snap.title || '') + '<br><small>' + htmlEscape(snap.url || '') + '</small><br>' +
      '<small>框架：' + (framework || '无检测') + ' | 时间：' + (snap.time || '') + '</small></div>';

    // 表格信息
    if (snap.tables && snap.tables.length > 0) {
      html += '<div class="diag-section"><h5>📊 表格 (' + snap.tables.length + '个)</h5>';
      snap.tables.forEach(function (t) {
        html += '<table><tr><th>#</th><th>行数</th><th>列数</th><th>表头</th></tr>';
        html += '<tr><td>' + (t.index + 1) + '</td><td>' + t.rowCount + '</td><td>' + (t.colCount || '?') + '</td><td>' + htmlEscape((t.headers || []).join(' | ') || '(无th)') + '</td></tr></table>';
        if (t.sampleRow) {
          html += '<small>首行示例：' + htmlEscape(t.sampleRow.join(' | ')) + '</small><br>';
        }
        if (t.rowElements) {
          html += '<small>行内元素：</small><pre>' + htmlEscape(JSON.stringify(t.rowElements, null, 1)) + '</pre>';
        }
        html += '<br>';
      });
      html += '</div>';
    }

    // 输入框信息
    if (snap.inputs && snap.inputs.length > 0) {
      html += '<div class="diag-section"><h5>✏️ 输入框 (' + snap.inputs.length + '个)</h5>';
      html += '<table><tr><th>类型</th><th>class</th><th>name</th><th>placeholder</th><th>值</th></tr>';
      snap.inputs.forEach(function (inp) {
        html += '<tr><td>' + htmlEscape(inp.type || 'text') + '</td><td>' + htmlEscape(inp.className.substring(0, 30)) + '</td><td>' + htmlEscape(inp.name || '') + '</td><td>' + htmlEscape(inp.placeholder || '') + '</td><td>' + htmlEscape(inp.value || '') + '</td></tr>';
      });
      html += '</table></div>';
    }

    // 按钮信息
    if (snap.buttons && snap.buttons.length > 0) {
      html += '<div class="diag-section"><h5>🔘 按钮 (' + snap.buttons.length + '个)</h5>';
      html += '<table><tr><th>文字</th><th>class</th><th>类型</th></tr>';
      snap.buttons.forEach(function (b) {
        html += '<tr><td>' + htmlEscape(b.text) + '</td><td>' + htmlEscape(b.className.substring(0, 30)) + '</td><td>' + htmlEscape(b.type || b.tag) + '</td></tr>';
      });
      html += '</table></div>';
    }

    // 选择框
    if (snap.selects && snap.selects.length > 0) {
      html += '<div class="diag-section"><h5>📋 下拉框 (' + snap.selects.length + '个)</h5>';
      html += '<table><tr><th>class</th><th>选项数</th><th>当前值</th></tr>';
      snap.selects.forEach(function (s) {
        html += '<tr><td>' + htmlEscape(s.className.substring(0, 30)) + '</td><td>' + s.optionCount + '</td><td>' + htmlEscape(s.value) + '</td></tr>';
      });
      html += '</table></div>';
    }

    // 文本框
    if (snap.textareas && snap.textareas.length > 0) {
      html += '<div class="diag-section"><h5>📝 文本框 (' + snap.textareas.length + '个)</h5>';
      html += '<table><tr><th>class</th><th>placeholder</th></tr>';
      snap.textareas.forEach(function (ta) {
        html += '<tr><td>' + htmlEscape(ta.className.substring(0, 30)) + '</td><td>' + htmlEscape(ta.placeholder || '') + '</td></tr>';
      });
      html += '</table></div>';
    }

    showDiagPanel('🔍 DOM 扫描 — ' + htmlEscape(snap.title || ''), html);
  }

  // ⏺ 开始录制
  async function startRecording() {
    var resp = await sendToActiveTab('START_RECORDING');
    if (resp && resp.ok) {
      $('btnStartRecord').disabled = true;
      $('btnStopRecord').disabled = false;
      $('recordingBar').style.display = 'flex';
      // 启动计时器
      _recStartTime = Date.now();
      _recTimer = setInterval(updateRecTime, 500);
    }
  }

  var _recStartTime = 0;
  var _recTimer = 0;

  function updateRecTime() {
    var elapsed = Math.floor((Date.now() - _recStartTime) / 1000);
    var min = Math.floor(elapsed / 60);
    var sec = elapsed % 60;
    var el = $('recTime');
    if (el) el.textContent = (min < 10 ? '0' + min : min) + ':' + (sec < 10 ? '0' + sec : sec);
  }

  // ⏹ 停止录制
  async function stopRecording() {
    await sendToActiveTab('STOP_RECORDING');
    $('btnStartRecord').disabled = false;
    $('btnStopRecord').disabled = true;
    $('recordingBar').style.display = 'none';
    if (_recTimer) { clearInterval(_recTimer); _recTimer = 0; }

    // 等一会儿让数据存到 storage，然后展示
    setTimeout(async function () { await showRecording(); }, 500);
  }

  // 展示录制数据
  async function showRecording() {
    var result = await chrome.storage.local.get(['__api_monitor_recordings__']);
    var recordings = result.__api_monitor_recordings__ || [];
    if (recordings.length === 0) {
      showDiagPanel('⏺ 操作录制', '<div style="padding:10px;color:#999;">暂无录制数据</div>');
      return;
    }
    var rec = recordings[0];
    var html = '<div class="diag-section">';
    html += '<strong>页面：</strong>' + htmlEscape(rec.pageUrl || '') + '<br>';
    html += '<strong>标题：</strong>' + htmlEscape(rec.pageTitle || '') + '<br>';
    html += '<strong>时长：</strong>' + (rec.duration || 0) + 'ms | ';
    html += '<strong>事件：</strong>' + (rec.events ? rec.events.length : 0) + '个<br>';
    html += '</div>';

    if (rec.events && rec.events.length > 0) {
      html += '<div class="diag-section"><h5>📋 事件时间线</h5>';
      html += '<table><tr><th>时间</th><th>类型</th><th>详情</th></tr>';
      rec.events.forEach(function (ev) {
        var sec = (ev.time / 1000).toFixed(1) + 's';
        var detail = '';
        if (ev.type === 'click') {
          detail = htmlEscape(ev.detail.tag || '') + ' ' + htmlEscape(ev.detail.text || '') + ' .' + htmlEscape(ev.detail.className || '').substring(0, 30);
          if (ev.detail.parentDataId) detail += ' [data-id=' + htmlEscape(ev.detail.parentDataId) + ']';
        } else if (ev.type === 'input' || ev.type === 'change') {
          detail = htmlEscape(ev.detail.tag || '') + ' ' + htmlEscape(ev.detail.name || ev.detail.id || '') + ' = ' + htmlEscape(ev.detail.value || '');
        } else if (ev.type === 'focus' || ev.type === 'blur') {
          detail = htmlEscape(ev.detail.tag || '') + ' ' + htmlEscape(ev.detail.name || ev.detail.id || '');
        }
        html += '<tr><td>' + sec + '</td><td>' + ev.type + '</td><td>' + detail + '</td></tr>';
      });
      html += '</table></div>';
    }

    showDiagPanel('⏺ 操作录制 (' + (rec.events ? rec.events.length : 0) + '个事件)', html);
  }

  // 📋 生成诊断报告
  async function generateReport() {
    var btn = $('btnGenReport');
    var origText = btn.textContent;
    btn.textContent = '⏳ 生成中...';
    btn.disabled = true;

    try {
      var resp = await chrome.runtime.sendMessage({ action: 'GET_DIAG_REPORT' });
      var html = '<div class="diag-section"><strong>导出时间：</strong>' + (resp.exportedAt || '') + '</div>';

      // DOM 快照摘要
      if (resp.snapshots && resp.snapshots.length > 0) {
        html += '<div class="diag-section"><h5>🔍 DOM 快照 (' + resp.snapshots.length + '次)</h5>';
        resp.snapshots.forEach(function (s, i) {
          html += '<small>' + (i + 1) + '. ' + htmlEscape(s.title || '') + ' — ' + (s.time || '') + '</small><br>';
          if (s.tables) html += '<small>  📊 表格:' + s.tables.length + '个</small> ';
          if (s.inputs) html += '<small>✏️ 输入框:' + s.inputs.length + '个</small> ';
          if (s.buttons) html += '<small>🔘 按钮:' + s.buttons.length + '个</small><br>';
        });
        html += '</div>';
      } else {
        html += '<div class="diag-section"><h5>🔍 DOM 快照</h5><small style="color:#999;">无数据 — 请先点击"扫描页面"</small></div>';
      }

      // 录制摘要
      if (resp.recordings && resp.recordings.length > 0) {
        html += '<div class="diag-section"><h5>⏺ 操作录制 (' + resp.recordings.length + '次)</h5>';
        resp.recordings.forEach(function (r, i) {
          html += '<small>' + (i + 1) + '. ' + htmlEscape(r.pageTitle || '') + ' — ' + (r.events ? r.events.length : 0) + '个事件, ' + (r.duration || 0) + 'ms</small><br>';
        });
        html += '</div>';
      } else {
        html += '<div class="diag-section"><h5>⏺ 操作录制</h5><small style="color:#999;">无数据 — 请先点击"录制"并操作页面</small></div>';
      }

      // API 请求摘要
      if (resp.requests && resp.requests.length > 0) {
        // 按 URL 去重统计
        var urlMap = {};
        resp.requests.forEach(function (r) {
          var path = r.url || '';
          try { path = new URL(r.url).pathname; } catch (e) {}
          urlMap[path] = (urlMap[path] || 0) + 1;
        });
        var sorted = Object.entries(urlMap).sort(function (a, b) { return b[1] - a[1]; });

        html += '<div class="diag-section"><h5>🌐 API 请求 (' + resp.requests.length + '条, ' + Object.keys(urlMap).length + '个接口)</h5>';
        html += '<table><tr><th>#</th><th>数量</th><th>接口路径</th></tr>';
        sorted.slice(0, 15).forEach(function (entry, i) {
          html += '<tr><td>' + (i + 1) + '</td><td>' + entry[1] + '</td><td>' + htmlEscape(entry[0].substring(0, 60)) + '</td></tr>';
        });
        html += '</table></div>';
      } else {
        html += '<div class="diag-section"><h5>🌐 API 请求</h5><small style="color:#999;">无数据 — 请确保监听已开启</small></div>';
      }

      showDiagPanel('📋 诊断报告', html);
    } catch (e) {
      showDiagPanel('📋 诊断报告', '<div style="color:#721c24;">生成失败: ' + htmlEscape(e.message) + '</div>');
    }

    btn.textContent = origText;
    btn.disabled = false;
  }

  // 导出诊断数据
  async function exportDiagData() {
    try {
      var resp = await chrome.runtime.sendMessage({ action: 'GET_DIAG_REPORT' });
      var blob = new Blob([JSON.stringify(resp, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'diag-report-' + new Date().toISOString().slice(0, 19).replace(/:/g, '-') + '.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.warn('[Popup] export diag failed:', e.message);
    }
  }

  function showDiagPanel(title, html) {
    $('diagPanelTitle').textContent = title;
    $('diagBody').innerHTML = html;
    $('diagPanel').style.display = 'block';
  }

  function closeDiagPanel() {
    $('diagPanel').style.display = 'none';
  }

})();
