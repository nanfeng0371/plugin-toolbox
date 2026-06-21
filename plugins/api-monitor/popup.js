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
        tool: 'API 接口监听器 v1.1.0'
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

})();
