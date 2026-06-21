/**
 * Report 模块 — Content Script v5.3.0 模块化版
 *
 * 迁移自 plugins/report/content.js (v5.1.1 iframe方案)
 * 核心改动：
 *   - 移除自建 sidebar (#lrp-panel-container)，改用壳 Shadow DOM 容器
 *   - 消息监听改为 window.__moduleMessageHandlers__
 *   - DOM 查询从 document 改为容器作用域
 *   - 保留所有业务逻辑：iframe pool、DOM 抓取、表格渲染、CSV导出
 */

(function () {
  'use strict';

  const WORK_DOMAINS = ['ai-genesis.yuaiweiwu.com', 'www.yuaiweiwu.com'];

  // 不在工作台页面就退出
  if (!WORK_DOMAINS.includes(location.hostname)) return;

  // 防重复注入
  let _initialized = false;
  if (_initialized) return;
  _initialized = true;

  // ★ 从壳获取 Shadow DOM 容器
  const shadowRoot = window.__shadowRoots__ && window.__shadowRoots__.report;
  if (!shadowRoot) {
    console.warn('[Report模块] 未找到 Shadow DOM 容器 (window.__shadowRoots__.report)');
    return;
  }

  // ★ 注册消息处理器（壳会调用 window.__moduleMessageHandlers__['report'] 转发消息）
  window.__moduleMessageHandlers__ = window.__moduleMessageHandlers__ || {};
  window.__moduleMessageHandlers__['report'] = onModuleMessage;

  // ★ 直接监听 SW 消息（不依赖壳转发，确保消息可靠到达）
  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg) return;
  });

  // ===== 注册工作台tab到模块 background.js =====
  chrome.runtime.sendMessage({ target: 'report', action: 'REGISTER_TAB' });

  // ===== 清除之前的内容（保留 <style> 标签，避免删掉壳注入的 CSS）=====
  let toRemove = [];
  for (var i = 0; i < shadowRoot.children.length; i++) {
    let child = shadowRoot.children[i];
    if (child.tagName !== 'STYLE') toRemove.push(child);
  }
  toRemove.forEach(function (c) { shadowRoot.removeChild(c); });

  // ===== 模块根容器 =====
  const container = document.createElement('div');
  container.className = 'lrp-module-container';
  container.innerHTML = buildHTML();
  shadowRoot.appendChild(container);

  // ===== iframe请求管理 =====
  const _pendingIframeRequests = new Map(); // reportToken → { resolve, reject, timer, iframe }

  /**
   * 壳消息转发处理
   * 壳 content.js 在收到 SW 转发消息时调用此函数
   */
  function onModuleMessage(msg) {
    if (msg.type === 'RELAY_REPORT_DATA') {
      const { reportToken, data, error } = msg;
      const pending = _pendingIframeRequests.get(reportToken);
      if (!pending) return;

      clearTimeout(pending.timer);
      if (pending.iframe) {
        pending.iframe.remove();
      }
      _pendingIframeRequests.delete(reportToken);

      if (error) {
        pending.reject(new Error(error));
      } else {
        pending.resolve(data);
      }
    }
    if (msg.type === 'DOWNLOAD_EXCEL') {
      try {
        const bin = atob(msg.data);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = msg.filename || 'report.xlsx';
        a.click();
        setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      } catch (e) { alert('下载失败: ' + e.message); }
    }
  }

  /**
   * 通过iframe获取报告数据
   * @param {string} shortUrl - 短链URL
   * @param {string} reportToken - report token
   * @param {number} timeout - 超时毫秒（默认20s）
   * @param {number} _attempt - 内部重试计数（外部勿传）
   */
  function fetchViaIframe(shortUrl, reportToken, timeout, _attempt) {
    if (timeout === undefined) timeout = 8000;
    if (_attempt === undefined) _attempt = 1;
    let MAX_ATTEMPTS = 2;

    return new Promise(function (resolve, reject) {
      let timer = setTimeout(function () {
        let pending = _pendingIframeRequests.get(reportToken);
        if (pending && pending.iframe) pending.iframe.remove();
        _pendingIframeRequests.delete(reportToken);

        if (_attempt < MAX_ATTEMPTS) {
          log('warn', '[Step4] iframe超时(' + (timeout / 1000) + 's)，第' + _attempt + '次，重试中...');
          fetchViaIframe(shortUrl, reportToken, timeout, _attempt + 1)
            .then(resolve)
            .catch(reject);
        } else {
          reject(new Error('iframe数据获取超时(' + (timeout / 1000) + 's x' + MAX_ATTEMPTS + ')'));
        }
      }, timeout);

      let iframe = document.createElement('iframe');
      iframe.style.cssText = 'width:1px;height:1px;position:fixed;left:-9999px;top:-9999px;opacity:0;pointer-events:none;border:none;';
      iframe.src = shortUrl;

      _pendingIframeRequests.set(reportToken, { resolve: resolve, reject: reject, timer: timer, iframe: null });

      document.body.appendChild(iframe);
      _pendingIframeRequests.get(reportToken).iframe = iframe;

      log('info', '[Step4] iframe已创建(第' + _attempt + '次), 短链=' + shortUrl.slice(-12));
    });
  }

  function cleanupAllIframes() {
    _pendingIframeRequests.forEach(function (pending, token) {
      clearTimeout(pending.timer);
      if (pending.iframe) pending.iframe.remove();
      pending.reject(new Error('用户取消'));
    });
    _pendingIframeRequests.clear();
  }

  // ===== 状态 =====
  let allData = [];
  let filteredData = [];
  let sortCol = null;
  let sortAsc = true;
  let isFetching = false;
  let abortFlag = false;

  // ===== DOM引用辅助 =====
  function $(s) { return container.querySelector(s); }
  function $$(s) { return container.querySelectorAll(s); }

  // ===== 初始化 =====
  init();

  function init() {
    restoreLastAnalysis();
    bindEvents();
    checkConnection();
  }

  /**
   * 从 chrome.storage.local 恢复上次分析结果
   * 解决：关闭侧边栏/刷新页面后数据丢失的问题
   */
  async function restoreLastAnalysis() {
    try {
      let saved = await chrome.storage.local.get(['report_last_analysis']);
      if (!saved || !saved.report_last_analysis) return;
      let cached = saved.report_last_analysis;
      if (!cached.data || !Array.isArray(cached.data) || cached.data.length === 0) return;

      allData = cached.data;
      filteredData = [...allData];

      if (allData.length > 0) {
        renderTable(allData);
        applyFilter();
        $('#lrpExportBtn').disabled = false;
        $('#lrpCopyBtn').disabled = false;

        let age = cached.timestamp ? Math.round((Date.now() - cached.timestamp) / 60000) : 0;
        let ageStr = age > 0 ? (age + '分钟前') : '刚刚';
        setStatus('green', '\uD83D\uDCE6 已恢复上次分析 | ' + allData.length + '个学生 | ' + ageStr);
        log('info', '已从本地存储恢复上次分析结果: ' + allData.length + '个学生 (' + ageStr + ')');
      }
    } catch (e) {
      // 静默失败，恢复是尽力而为的
      console.warn('[Report模块] 恢复上次分析失败:', e.message);
    }
  }

  function buildHTML() {
    return '\n' +
      '    <div class="lrp-header">\n' +
      '      <h1>\uD83D\uDCCA 学习报告分析 <small>v5.3.0</small></h1>\n' +
      '      <div class="lrp-status">\n' +
      '        <span class="lrp-dot grey" id="lrpDot"></span>\n' +
      '        <span id="lrpStatusText">检测登录态中...</span>\n' +
      '        <button class="lrp-btn small" id="lrpRefreshBtn" title="重新检测页面数据">\uD83D\uDD04</button>\n' +
      '      </div>\n' +
      '    </div>\n' +
      '\n' +
      '    <div class="lrp-toolbar">\n' +
      '      <button class="lrp-btn primary" id="lrpStartBtn">\uD83D\uDE80 批量获取分析</button>\n' +
      '      <button class="lrp-btn danger" id="lrpStopBtn" style="display:none;">\u23F9 停止</button>\n' +
      '      <button class="lrp-btn" id="lrpExportBtn" disabled>\u2B07\uFE0F 下载Excel</button>\n' +
      '      <button class="lrp-btn" id="lrpCopyBtn" disabled>\uD83D\uDCCB 复制问题名单</button>\n' +
      
      '    </div>\n' +
      '\n' +
      '    <div class="lrp-phone-progress" id="lrpPhoneProgress" style="display:none;padding:6px 10px;font-size:12px;color:#666;background:#f8f9fa;border-radius:4px;margin-bottom:8px;">\n' +
      '      ⏳ 信息获取进度: <span id="lrpPhoneProgressText">0/0</span>\n' +
      '    </div>\n' +
      '    \n' +
      '    <div class="lrp-filter-bar" style="display:none;" id="lrpFilterBar">\n' +
      '      <label>筛选：</label>\n' +
      '      <select id="lrpFilterTag"><option value="">全部标签</option><option value="critical">\uD83D\uDD34敷衍</option><option value="danger">\uD83D\uDEA8敷衍但会</option><option value="warning">\u26A0\uFE0F需关注</option><option value="info">\uD83D\uDC4D认真</option><option value="success">\u2B50优秀</option><option value="muted">\u23F9未生成报告</option></select>\n' +
      '      <select id="lrpFilterLesson"><option value="">全部课节</option></select>\n' +
      '    </div>\n' +
      '\n' +
      '    <div class="lrp-progress" id="lrpProgress" style="display:none;">\n' +
      '      <div class="lrp-progress-bar"><div class="lrp-progress-fill" id="lrpProgressFill" style="width:0%">0%</div></div>\n' +
      '      <div class="lrp-progress-info" id="lrpProgressInfo">准备中...</div>\n' +
      '    </div>\n' +
      '\n' +
      '    <div class="lrp-table-wrap" id="lrpTableWrap">\n' +
      '      <div class="lrp-empty" id="lrpEmpty">\n' +
      '        <div class="lrp-empty-icon">\uD83D\uDCCA</div>\n' +
      '        <div><b>准备就绪</b></div>\n' +
      '        <p>点击上方「批量获取分析」开始</p>\n' +
      '      </div>\n' +
      '    </div>\n' +
      '\n' +
      '    <div class="lrp-stats" id="lrpStats" style="display:none;"></div>\n' +
      '\n' +
      '    <div class="lrp-log-area" id="lrpLogArea" style="display:none;"></div>\n' +
      '    <div id="lrpLogBtnRow" style="display:none;gap:4px;flex-wrap:wrap;">\n' +
      '      <button class="lrp-btn small" id="lrpToggleLogBtn">\uD83D\uDCCB 日志</button>\n' +
      '      <button class="lrp-btn small" id="lrpBgLogBtn">\uD83D\uDD27 后台日志</button>\n' +
      '    </div>\n' +
      '  ';
  }

  // ===== 事件绑定 =====
  function bindEvents() {
    $('#lrpStartBtn').onclick = startBatchFetch;
    $('#lrpStopBtn').onclick = stopFetch;
    $('#lrpExportBtn').onclick = exportExcel;
    $('#lrpCopyBtn').onclick = copyProblemList;
    $('#lrpRefreshBtn').onclick = function () {
      setStatus('blue', '\uD83D\uDD04 正在刷新...');
      checkConnection();
    };
    $('#lrpFilterTag').onchange = applyFilter;
    $('#lrpFilterLesson').onchange = applyFilter;
    if ($('#lrpToggleLogBtn')) $('#lrpToggleLogBtn').onclick = function () {
      let area = $('#lrpLogArea');
      area.style.display = area.style.display === 'none' ? '' : 'none';
    };
    if ($('#lrpBgLogBtn')) $('#lrpBgLogBtn').onclick = function () {
      sendMessage({ target: 'report', action: 'GET_LOGS' }).then(function (logs) {
        let area = $('#lrpLogArea');
        area.style.display = '';
        area.innerHTML = '';
        if (logs && logs.length) {
          logs.forEach(function (l) {
            let entry = document.createElement('div');
            entry.className = 'lrp-log-entry ' + l.level;
            entry.style.cssText = l.level === 'error' ? 'color:#f88;' : l.level === 'warn' ? 'color:#ff0;' : '';
            entry.textContent = '[' + l.time + '] ' + l.msg;
            area.appendChild(entry);
          });
          area.scrollTop = area.scrollHeight;
        } else {
          area.innerHTML = '<div class="lrp-log-entry info">暂无后台日志</div>';
        }
      }).catch(function (e) { alert('获取日志失败: ' + e.message); });
    };
  }

  // ===== 连接检测 =====
  async function checkConnection() {
      try {
        setStatus('grey', '\u23F3 检测中...');
        let filters = extractPageFilters();
        try {
          let res = await sendMessage({ target: 'report', action: 'FETCH_STUDENT_LIST', payload: filters });
          let resPayload = (res && res.data) || res || {};
          let inner = resPayload.data || {};
          let resList = Array.isArray(inner.data) ? inner.data : (Array.isArray(resPayload.data) ? resPayload.data : []);
          if (!res || res.success === false) throw new Error(res.error || '请求失败');
          if (resList.length > 0) {
            setStatus('ok', '\u2705 已连接 | ' + resList.length + ' 个学生');
            log('info', '连接成功，' + resList.length + ' 个学生');
            return true;
          } else {
            setStatus('yellow', '\u26A0\uFE0F 插件正常 | 当前筛选无数据');
            return true;
          }
        } catch (apiErr) {
          log('warn', '带参API检测失败: ' + apiErr.message);
        }
        let fallback = await sendMessage({ target: 'report', action: 'CHECK_CONNECTION' });
        // CHECK_CONNECTION handler 返回 { connected, count }，路由包装后是 { success, data: { connected, count } }
        let fallbackData = (fallback && fallback.data) || fallback || {};
        if (fallbackData.connected) {
          setStatus('ok', '\u2705 已连接 | 后端可用(' + fallbackData.count + '条)');
          return true;
        } else {
          setStatus('red', '\u274C 未登录或无数据');
          return false;
        }
      } catch (e) {
        setStatus('red', '\u274C 检测失败: ' + e.message);
        return false;
      }
  }

  // ===== 从页面提取筛选参数 =====
  function extractPageFilters() {
    let filters = { classStatus: 2 };
    try {
      let dateInputs = document.querySelectorAll(
        'input[placeholder*="日期"], input[placeholder*="-"], .el-date-editor input, ' +
        '.ant-picker input, [class*="date"] input, [class*="Date"] input'
      );
      log('info', '[调试] 日期输入框数量: ' + dateInputs.length
        + (dateInputs.length > 0 ? ', 第1个值=' + dateInputs[0].value : '')
        + (dateInputs.length > 1 ? ', 第2个值=' + dateInputs[1].value : ''));
      if (dateInputs.length >= 2) {
        filters.startDate = dateInputs[0].value || undefined;
        filters.endDate = dateInputs[1].value || undefined;
      } else if (dateInputs.length === 1) {
        let val = dateInputs[0].value;
        if (val && val.indexOf('~') >= 0) {
          let parts = val.split('~');
          filters.startDate = parts[0].trim();
          filters.endDate = parts[1].trim();
        }
      }
      if (!filters.startDate || !filters.endDate) {
        let pageText = document.body.innerText;
        let dateMatch = pageText.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s*[—~-]\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
        if (dateMatch) {
          filters.startDate = dateMatch[1];
          filters.endDate = dateMatch[2];
        }
      }
      // 校验：如果开始日期 > 结束日期，自动交换（页面DOM顺序可能与逻辑顺序相反）
      if (filters.startDate && filters.endDate && filters.startDate > filters.endDate) {
        let tmp = filters.startDate;
        filters.startDate = filters.endDate;
        filters.endDate = tmp;
        log('warn', '⚠️ 日期顺序已自动修正（原始顺序反了）');
      }
    } catch (e) {}

    try {
      let tabs = document.querySelectorAll('.el-tabs__item, .ant-tabs-tab, [class*="tab"] li, [role="tab"]');
      for (var i = 0; i < tabs.length; i++) {
        let tab = tabs[i];
        let text = tab.textContent.trim();
        let isActive = tab.classList.contains('is-active') || tab.classList.contains('active') ||
                       tab.getAttribute('aria-selected') === 'true';
        if (isActive) {
          if (text.indexOf('进行中') >= 0) filters.classStatus = 1;
          else if (text.indexOf('已结束') >= 0) filters.classStatus = 2;
          else if (text.indexOf('全部') >= 0) filters.classStatus = null;
          else if (text.indexOf('待开始') >= 0) filters.classStatus = 0;
          break;
        }
      }
    } catch (e) {}

    try {
      let searchInput = document.querySelector('input[placeholder*="搜索"], input[placeholder*="查找"], .search-input input, [class*="search"] input');
      if (searchInput && searchInput.value.trim()) {
        filters.keyword = searchInput.value.trim();
      }
    } catch (e) {}

    log('info', '页面筛选条件 → classStatus=' + filters.classStatus
      + ', 日期=' + (filters.startDate || '(未读取)') + ' → ' + (filters.endDate || '(未读取)')
      + (filters.keyword ? ', 关键词=' + filters.keyword : ''));
    return filters;
  }

  // ===== 并发控制 =====
  let MAX_CONCURRENT_IFRAMES = 6;

  // ===== 批量获取（重构版：拆分为子函数）=====

  /** Phase 1: 筛选条件 + 学生列表 + DOM ID匹配 */
  async function _fetchStudentListAndMatch() {
    log('info', '正在读取页面筛选条件...');
    setProgress(3, '正在读取页面筛选条件...');
    let filters = extractPageFilters();
    log('info', '正在获取学生列表...');
    setProgress(5, '正在获取学生列表...');
    let listRes = await sendMessage({ target: 'report', action: 'FETCH_STUDENT_LIST', payload: filters });
    if (!listRes || listRes.success === false) throw new Error((listRes && listRes.error) || '获取学生列表失败');
    let listPayload = (listRes && listRes.data) || {};
    let listInner = listPayload.data || {};
    let students = Array.isArray(listInner.data) ? listInner.data : (Array.isArray(listPayload.data) ? listPayload.data : []);
    if (students.length === 0) throw new Error('未找到任何学生');
    if (students.length > 0 && students[0]._debugIds) log('info', '[Step1🔍] 候选ID字段: ' + Object.keys(students[0]._debugIds).join(', '));
    log('info', '[Step1.5] 正在从页面提取真实ID...');
    setProgress(5, '正在从页面提取真实ID...');
    let domIdMap = scrapeReportLinkIds();
    let matchedCount = 0;
    for (var i = 0; i < students.length; i++) {
      let s = students[i]; let realId = findBestMatch(s, domIdMap);
      if (realId && realId !== s.periodId) { s._originalPeriodId = s.periodId; s.periodId = realId; matchedCount++; }
    }
    log('info', '[Step1.5\u2705] DOM ID匹配: ' + matchedCount + '/' + students.length);
    return students;
  }

  /** Phase 2: 并行预取短链（biz→content.js直连，重定向→SW批量处理，绕过CORS） */
  async function _prefetchShortUrls(students) {
    log('info', '[Phase1] 开始并行预取 ' + students.length + ' 个短链...');
    setProgress(8, 'biz获取短链中... 0/' + students.length);

    // Phase A: 页面直连 biz API（并行，同源无CORS）
    var BASE = location.origin;
    var BIZ_API = '/prod-api/student-center-ai/ai/teacher/ai/biz';
    var bizResults = new Map(); var bizDone = 0;
    var bizPromises = students.map(function (st, idx) {
      return (async function () {
        try {
          var bizParams = 'id=' + st.periodId + '&urlType=2&broadcastType=3&courseClassify=' + (st.courseClassify || 3);
          var bizUrl = BASE + BIZ_API + '?' + bizParams;
          var bizRes = await fetch(bizUrl, {
            headers: { 'Accept': 'application/json' },
            credentials: 'include',
          });
          var bizJson = await bizRes.json();
          var SUCCESS_CODES = ['000000', '0', '200', 0, 200];
          if (bizJson.code !== undefined && SUCCESS_CODES.indexOf(bizJson.code) === -1) {
            throw new Error('biz错误(code=' + bizJson.code + ')');
          }
          var shortUrl = (bizJson.data && bizJson.data.aiBizUrl) || null;
          if (!shortUrl) throw new Error('biz未返回短链');
          bizResults.set(idx, { shortUrl: shortUrl, name: st.studentName });
          bizDone++;
        } catch (e) {
          bizResults.set(idx, { error: e.message, name: st.studentName });
          bizDone++;
          log('error', st.studentName + ' [biz❌] ' + e.message);
        }
      })();
    });
    await Promise.all(bizPromises);
    log('info', '[Phase1-A] biz短链: ' + bizDone + '/' + students.length + ' 完成');

    // Phase B: 收集所有短链，批量发SW跟随重定向（SW无CORS限制）
    var redirectBatch = [];
    var bizEntries = [];
    bizResults.forEach(function (val, key) { bizEntries.push({ idx: key, shortUrl: val.shortUrl, error: val.error, name: val.name }); });
    for (var i = 0; i < bizEntries.length; i++) {
      if (bizEntries[i].shortUrl) {
        redirectBatch.push({ idx: bizEntries[i].idx, shortUrl: bizEntries[i].shortUrl });
      }
    }

    var shortUrlMap = new Map();
    // 先把 biz 失败的标上
    for (var j = 0; j < bizEntries.length; j++) {
      if (bizEntries[j].error) {
        shortUrlMap.set(bizEntries[j].idx, { error: bizEntries[j].error, finalUrl: null });
      }
    }

    if (redirectBatch.length > 0) {
      setProgress(10, 'SW跟随重定向... 0/' + redirectBatch.length);
      try {
        var swResp = await sendMessage({ target: 'report', action: 'FOLLOW_REDIRECTS_BATCH', data: redirectBatch });
        var swResults = (swResp && swResp.data) || [];
        for (var k = 0; k < swResults.length; k++) {
          var r = swResults[k];
          if (r.error) {
            shortUrlMap.set(r.idx, { error: r.error, finalUrl: null });
            log('error', (students[r.idx] && students[r.idx].studentName) + ' [重定向❌] ' + r.error);
          } else {
            shortUrlMap.set(r.idx, { shortUrl: r.shortUrl, reportToken: r.reportToken, finalUrl: r.finalUrl });
            log('ok', (students[r.idx] && students[r.idx].studentName) + ' [预取✅] 短链就绪');
          }
        }
        var successCount = swResults.filter(function (x) { return !x.error; }).length;
        setProgress(28, '预取完成: ' + (successCount + (students.length - redirectBatch.length - bizEntries.filter(function (x) { return x.error; }).length)) + '/' + students.length);
      } catch (e) {
        log('error', '[Phase1-B] SW批量重定向失败: ' + e.message);
        for (var m = 0; m < redirectBatch.length; m++) {
          if (!shortUrlMap.has(redirectBatch[m].idx)) {
            shortUrlMap.set(redirectBatch[m].idx, { error: 'SW重定向失败: ' + e.message, finalUrl: null });
          }
        }
      }
    }

    return shortUrlMap;
  }


  /** Phase 3: 3并发iframe池获取 */
  /**
   * v5.3.0: SW 批量获取报告（替代 iframe 池）
   * 向 SW 发送 FETCH_REPORTS_BATCH，SW 30并发直接fetch API
   * @param {Array} students
   * @param {Map} shortUrlMap
   * @returns {Promise<number>} startTime
   */
  async function _fetchReportsBatch(students, shortUrlMap) {
    log('info', '[Phase2] SW批量获取报告: ' + students.length + ' 人');
    setProgress(30, 'SW批量获取: 0/' + students.length);
    let startTime = Date.now();

    // 构建批量请求 payload
    var batchItems = [];
    for (var i = 0; i < students.length; i++) {
      var urlInfo = shortUrlMap.get(i);
      if (urlInfo && urlInfo.reportToken) {
        batchItems.push({
          idx: i,
          reportToken: urlInfo.reportToken,
          courseClassify: students[i].courseClassify || 3,
          studyVersion: students[i].studyVersion || 1,
        });
      }
    }
    if (batchItems.length === 0) throw new Error('无有效reportToken，无法获取报告');

    log('info', '[Phase2] 发送 FETCH_REPORTS_BATCH: ' + batchItems.length + ' 个');
    setProgress(32, 'SW获取中: 0/' + batchItems.length);

    try {
      var swResp = await sendMessage({ target: 'report', action: 'FETCH_REPORTS_BATCH', data: batchItems });
      var results = (swResp && swResp.data) || [];
      log('info', '[Phase2✅] SW批量完成: ' + results.length + '/' + batchItems.length);

      // 解析结果，填入 allData
      var completedCount = 0;
      for (var j = 0; j < results.length; j++) {
        var r = results[j];
        var st = students[r.idx];
        if (!st) { completedCount++; continue; }

        if (r.error) {
          allData[r.idx] = makeErrorRow(st, r.error);
        } else {
          var dataJson = r.data;
          if (dataJson.code && dataJson.code !== '000000' && dataJson.code !== 0 && dataJson.code !== 200) {
            allData[r.idx] = makeErrorRow(st, 'API错误(' + dataJson.code + '): ' + (dataJson.msg || dataJson.mesg || ''));
          } else {
            var parsed = parseReportData(dataJson, st.studentName);
            if (!parsed) {
              allData[r.idx] = makeErrorRow(st, '解析失败');
            } else {
              parsed.studentId = st.studentId;
              parsed.inClassDuration = st.inClassDuration;
              parsed.homeworkStatus = st.homeworkStatus;
              parsed.attendanceStatus = st.attendanceStatus;
              parsed.rawCourseName = st.rawCourseName;
              parsed.rawLessonName = st.rawLessonName;
              parsed.userPhone = st.userPhone || '';
              var analyzed = analyzeStudent(parsed);
              analyzed._idx = r.idx + 1;
              allData[r.idx] = analyzed;
            }
          }
        }
        completedCount++;
        if (completedCount % 10 === 0 || completedCount === results.length) {
          var pct = 32 + Math.round(60 * completedCount / results.length);
          setProgress(pct, '解析中: ' + completedCount + '/' + results.length);
          renderTable(allData.filter(Boolean));
        }
      }

      // 补全没有结果的（预取失败的学生）
      for (var k = 0; k < students.length; k++) {
        if (!allData[k]) {
          var urlInfo2 = shortUrlMap.get(k);
          allData[k] = makeErrorRow(students[k], urlInfo2 ? (urlInfo2.error || '预取失败') : '无数据');
        }
      }

      return startTime;
    } catch (e) {
      log('error', '[Phase2] SW批量失败: ' + e.message);
      // 降级：逐个用 SW 直连（很慢，但能完成）
      log('warn', '[Phase2] 降级为逐个SW直连...');
      throw e;  // 让上层 catch 处理
    }
  }


  // ===== v5.2.8: 本地手机号获取（content.js 直连，绕过 SW cookie 限制）=====

  /**
   * 获取单个学员的完整手机号（页面上下文 fetch，天然带 cookie）
   * @param {string} studentId
   * @returns {Promise<string>}
   */
  async function fetchStudentPhone(studentId) {
    var BASE = location.origin;
    var url = BASE + '/prod-api/student-center-ai/regularCourse/next/student/info?studentId=' + studentId;
    try {
      var controller = new AbortController();
      var timeoutId = setTimeout(function () { controller.abort(); }, 5000);
      var res = await fetch(url, {
        headers: { 'Accept': 'application/json, text/plain, */*' },
        credentials: 'include',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!res.ok) return '';
      var json = await res.json();
      if (json.code !== '000000' && json.code !== 0 && json.code !== 200) return '';
      return (json.data && json.data.mobile) || '';
    } catch (e) {
      return '';
    }
  }

  /**
   * 批量获取完整手机号（并发5个），实时更新页面进度
   * @param {string[]} studentIds
   * @returns {Promise<Object<string,string>>} { studentId: mobile }
   */
  async function batchFetchPhonesWithProgress(studentIds) {
    var CONCURRENCY = 20;
    var phoneMap = {};
    var completed = 0;
    for (var i = 0; i < studentIds.length; i += CONCURRENCY) {
      var batch = studentIds.slice(i, i + CONCURRENCY);
      var results = await Promise.all(batch.map(async function (sid) {
        var phone = await fetchStudentPhone(sid);
        return { sid: sid, phone: phone };
      }));
      for (var ri = 0; ri < results.length; ri++) {
        var r = results[ri];
        if (r.phone) phoneMap[r.sid] = r.phone;
        completed++;
      }
      // ★ v5.2.8: 更新独立的"信息获取进度"显示（不碰主进度条）
      var pp = container.querySelector('#lrpPhoneProgress');
      var ppt = container.querySelector('#lrpPhoneProgressText');
      if (pp) pp.style.display = '';
      if (ppt) ppt.textContent = completed + '/' + studentIds.length;
    }
    return phoneMap;
  }

  function startBatchFetch() {
    return (async function () {
      cleanupAllIframes(); allData = []; filteredData = []; renderTable([]);
      let btn = $('#lrpStartBtn'), stopBtn = $('#lrpStopBtn');
      btn.disabled = true; btn.textContent = '\u23F3 \u83B7\u53D6\u4E2D...';
      stopBtn.style.display = ''; stopBtn.disabled = false;
      isFetching = true; abortFlag = false;
      showProgress(true); showLog(false); showLogBtns(false);
      setProgress(0, '\u51C6\u5907\u4E2D...');

      try {
        let students = await _fetchStudentListAndMatch();
        setStatus('green', '\uD83D\uDD04 \u6B63\u5728\u83B7\u53D6: 0/' + students.length);
        allData = [];

        // v5.3.0: \u624B\u673A\u53F7\u548C\u77ED\u94FE\u9884\u53D6\u5E76\u884C\u542F\u52A8
        var phoneStudentIds = students.map(function (s) { return s.studentId; }).filter(Boolean);
        var phonePromise = null;
        var pp = container.querySelector('#lrpPhoneProgress');
        var ppt = container.querySelector('#lrpPhoneProgressText');
        if (phoneStudentIds.length > 0) {
          if (pp) pp.style.display = '';
          if (ppt) ppt.textContent = '\u51C6\u5907\u4E2D...';
          phonePromise = batchFetchPhonesWithProgress(phoneStudentIds);
        }

        // \u77ED\u94FE\u9884\u53D6\uFF08await\uFF0C\u62FF\u5230 reportToken \u540E\u624D\u80FD fetch \u62A5\u544A\uFF09
        let shortUrlMap = await _prefetchShortUrls(students);
        let preSuccessCount = 0;
        shortUrlMap.forEach(function (v) { if (!v.error) preSuccessCount++; });
        log('info', '[Phase1\u2705] \u77ED\u94FE\u9884\u53D6\u5B8C\u6210: ' + preSuccessCount + '/' + students.length + ' \u6210\u529F');
        if (preSuccessCount === 0) throw new Error('\u6240\u6709\u77ED\u94FE\u9884\u53D6\u5931\u8D25\uFF0C\u65E0\u6CD5\u7EE7\u7EED');

        // \u7B49\u624B\u673A\u53F7\u5B8C\u6210\uFF08\u5E94\u4E0E\u77ED\u94FE\u9884\u53D6\u5E76\u884C\u7ED3\u675F\uFF09
        var phoneMap = {};
        if (phonePromise) {
          try {
            phoneMap = await phonePromise;
            var phoneCount = 0;
            students.forEach(function (s) {
              if (phoneMap[s.studentId]) { s.userPhone = phoneMap[s.studentId]; phoneCount++; }
            });
            log('info', '[Step1.5\u2705] \u4FE1\u606F\u83B7\u53D6\u5B8C\u6210: ' + phoneCount + '/' + students.length);
            if (ppt) ppt.textContent = '\u2705 \u5B8C\u6210: ' + phoneCount + '/' + students.length;
          } catch (e) {
            log('warn', '[Step1.5] \u4FE1\u606F\u83B7\u53D6\u5931\u8D25: ' + e.message + '\uFF0C\u7EE7\u7EED...');
            if (ppt) ppt.textContent = '\u274C \u5931\u8D25';
          }
        }

        // v5.3.0: \u66FF\u6362 iframe \u4E3A SW \u6279\u91CF
        let startTime = await _fetchReportsBatch(students, shortUrlMap);

        allData = allData.filter(Boolean);
        allData.forEach(function (r, i) { r._idx = i + 1; });
        let totalCount = abortFlag ? allData.length : students.length;
        let elapsedTotal = ((Date.now() - startTime) / 1000).toFixed(1);
        let wasAborted = abortFlag;
        setProgress(100, wasAborted ? '\u5DF2\u505C\u6B62 (' + totalCount + '/' + students.length + ')' : '\u5168\u90E8\u5B8C\u6210\uFF01' + students.length + '\u4EBA | ' + elapsedTotal + 's');

        if (!wasAborted) {
          try {
            let stats = await chrome.storage.local.get(['report_count', 'student_count', 'time_saved']);
            let oldReport = parseInt(stats.report_count) || 0, oldStudent = parseInt(stats.student_count) || 0, oldTime = parseInt(stats.time_saved) || 0;
            let newReport = oldReport + allData.length, newStudent = oldStudent + students.length, newTime = oldTime + Math.round(allData.length * 1.5);
            await chrome.storage.local.set({ report_count: newReport, student_count: newStudent, time_saved: newTime });
            log('info', '[\u7EDF\u8BA1] \u4F7F\u7528\u7EDF\u8BA1\u5DF2\u66F4\u65B0: \u62A5\u544A+' + allData.length + ', \u5B66\u751F+' + students.length + ', \u65F6\u95F4+' + Math.round(allData.length * 1.5) + 'min');
          } catch (e) { log('warn', '[\u7EDF\u8BA1] \u5199\u5165\u4F7F\u7528\u7EDF\u8BA1\u5931\u8D25: ' + e.message); }
        }

        showProgress(false); isFetching = false; abortFlag = false; showLogBtns(true);
        if (abortFlag) { setStatus('yellow', '\u23F9 \u5DF2\u505C\u6B62 | ' + totalCount + '\u4E2A\u5B66\u751F'); btn.textContent = '\uD83D\uDD04 \u7EE7\u7EED\u83B7\u53D6'; }
        else { setStatus('green', '\u2705 \u5B8C\u6210 | ' + students.length + '\u4E2A\u5B66\u751F | ' + elapsedTotal + 's'); btn.textContent = '\uD83D\uDD04 \u91CD\u65B0\u83B7\u53D6'; }
        btn.disabled = false; stopBtn.style.display = 'none';
        if (allData.length > 0) { $('#lrpExportBtn').disabled = false; $('#lrpCopyBtn').disabled = false; }
        applyFilter();

        // \u6301\u4E45\u5316\uFF1A\u4FDD\u5B58\u5206\u6790\u7ED3\u679C\u5230 chrome.storage.local\uFF0C\u5173\u95ED\u4FA7\u8FB9\u680F/\u5237\u65B0\u9875\u9762\u53EF\u6062\u590D
        if (!wasAborted && allData.length > 0) {
          try {
            await chrome.storage.local.set({
              report_last_analysis: { data: allData, timestamp: Date.now(), count: allData.length }
            });
          } catch (e) { log('warn', '\u4FDD\u5B58\u672C\u6B21\u5206\u6790\u7ED3\u679C\u5931\u8D25: ' + e.message); }
        }

      } catch (e) {
        log('error', '\u6279\u91CF\u83B7\u53D6\u5931\u8D25: ' + e.message);
        setStatus('red', '\u274C \u5931\u8D25: ' + e.message);
        showProgress(false); isFetching = false; abortFlag = false;
        showLogBtns(true); showLog(true);
        btn.textContent = '\uD83D\uDE80 \u91CD\u8BD5'; btn.disabled = false;
        $('#lrpStopBtn').style.display = 'none';
        cleanupAllIframes();
      }
    })();
  }


  function stopFetch() {
    abortFlag = true;
    cleanupAllIframes();
    let stopBtn = $('#lrpStopBtn');
    if (stopBtn) { stopBtn.disabled = true; stopBtn.textContent = '\u23F9 停止中...'; }
    log('warn', '正在停止，请稍候...');
  }

  // ===== 从页面「报告链接」按钮提取真实biz ID =====
  function scrapeReportLinkIds() {
    let idMap = new Map();

    let reportLinks = document.querySelectorAll(
      'a[href*="report"], a[href*="biz"], button[class*="report"], ' +
      '[class*="report"] a, [class*="btn"] span, ' +
      'a[target="_blank"], .el-button--primary, .ant-btn-primary'
    );
    for (var i = 0; i < reportLinks.length; i++) {
      let link = reportLinks[i];
      let text = (link.textContent || '').trim();
      if (text.indexOf('报告') < 0 && text.indexOf('Report') < 0) continue;
      let row = link.closest('tr, [class*="row"]');
      if (!row) continue;
      let studentKey = extractStudentKeyFromRow(row);
      let realId = extractIdFromLink(link);
      if (realId && studentKey) {
        idMap.set(studentKey, { realId: realId, source: '报告按钮(' + text + ')' });
      }
    }

    if (idMap.size === 0) {
      let allClickable = document.querySelectorAll('a, button, [role="button"], [class*="btn"], td, .cell');
      for (var j = 0; j < allClickable.length; j++) {
        let el = allClickable[j];
        let onclick = el.getAttribute('onclick') || '';
        let href = el.getAttribute('href') || '';
        let dataId = el.dataset.id || el.dataset.periodId || el.dataset.bookingId || '';
        if ((onclick.indexOf('biz') >= 0 || onclick.indexOf('report') >= 0 || href.indexOf('biz') >= 0 || dataId)) {
          let row2 = el.closest('tr, [class*="row"]');
          if (!row2) continue;
          let studentKey2 = extractStudentKeyFromRow(row2);
          let realId2 = null;
          if (onclick) {
            let idMatch = onclick.match(/['"]?id['"]?\s*[:=]\s*['"]?(\d{5,10})/);
            if (idMatch) realId2 = idMatch[1];
          }
          if (!realId2 && href) {
            let hrefId = href.match(/[?&]id=(\d{5,10})/);
            if (hrefId) realId2 = hrefId[1];
          }
          if (!realId2 && dataId) realId2 = dataId;
          if (realId2 && studentKey2) {
            idMap.set(studentKey2, { realId: realId2, source: 'onclick/href/data' });
          }
        }
      }
    }

    if (idMap.size === 0) {
      let rows = document.querySelectorAll('table tbody tr, .el-table__row, [class*="row"]');
      for (var k = 0; k < rows.length; k++) {
        try {
          let rowEl = rows[k];
          if (!rowEl || !rowEl.__vue__) continue;
          let vm = rowEl.__vue__;
          let rowData = vm.row;
          if (!rowData && vm.$parent && vm.$parent.tableData) {
            rowData = vm.$parent.tableData[vm.$index];
          }
          if (rowData) {
            let name = rowData.studentName || rowData.name || rowData.chineseName;
            let allFields = flattenObject(rowData);
            let idCandidates = [];
            for (var path in allFields) {
              if (!allFields.hasOwnProperty(path)) continue;
              let val = allFields[path];
              if (/id$/i.test(path.split('.').pop()) && /^\d{5,8}$/.test(String(val))) {
                idCandidates.push({ path: path, val: String(val) });
              }
            }
            if (name && idCandidates.length > 0) {
              idCandidates.sort(function (a, b) { return b.val.length - a.val.length; });
              idMap.set(name, { realId: idCandidates[0].val, source: 'Vue.' + idCandidates[0].path });
            }
          }
        } catch (e) {}
      }
    }

    log('info', '[Step1.5\uD83D\uDD0D] DOM扫描: ' + idMap.size + ' 个报告链接ID');
    return idMap;
  }

  function extractStudentKeyFromRow(row) {
    let cells = row.querySelectorAll('td, .cell');
    for (var i = 0; i < cells.length; i++) {
      let text = cells[i].textContent.trim();
      if (/^\d{3}\*{4}\d{4}$/.test(text)) return text;
      if (text.length >= 2 && text.length <= 15 &&
          text.indexOf('%') < 0 && text.indexOf('-') < 0 &&
          ['是', '否', '离线', '在线', '有效', '无效', '应出勤'].indexOf(text) < 0 &&
          !/\d{11}/.test(text) && !/^\d+$/.test(text)) {
        return text;
      }
    }
    return null;
  }

  function extractIdFromLink(el) {
    let onclick = el.getAttribute('onclick') || '';
    let m1 = onclick.match(/['"]?id['"]?\s*[:=]\s*['"]?(\d{5,10})/);
    if (m1) return m1[1];
    let href = el.getAttribute('href') || '';
    let m2 = href.match(/[?&]id=(\d{5,10})/);
    if (m2) return m2[1];
    if (el.dataset.id && /^\d{5,10}$/.test(el.dataset.id)) return el.dataset.id;
    if (el.dataset.periodId && /^\d{5,10}$/.test(el.dataset.periodId)) return el.dataset.periodId;
    if (el.dataset.bookingId && /^\d{5,10}$/.test(el.dataset.bookingId)) return el.dataset.bookingId;
    return null;
  }

  function flattenObject(obj, prefix, result, _depth) {
    let MAX_DEPTH = 5;
    if (!_depth) _depth = 0;
    if (_depth > MAX_DEPTH) return result || {};
    if (!prefix) prefix = '';
    if (!result) result = {};
    if (!obj || typeof obj !== 'object') return result;
    for (var k in obj) {
      if (!obj.hasOwnProperty(k)) continue;
      let v = obj[k];
      let path = prefix ? prefix + '.' + k : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        flattenObject(v, path, result, _depth + 1);
      } else {
        result[path] = v;
      }
    }
    return result;
  }

  function findBestMatch(student, domIdMap) {
    if (domIdMap.size === 0) return null;
    let keys = [student.studentName, student.userName, student.chineseName, student.remarkName, student.userPhone].filter(Boolean);
    for (var i = 0; i < keys.length; i++) {
      if (domIdMap.has(keys[i])) return domIdMap.get(keys[i]).realId;
    }
    let entries = [];
    domIdMap.forEach(function (val, key) { entries.push([key, val]); });
    for (var j = 0; j < entries.length; j++) {
      let domKey = entries[j][0];
      let val = entries[j][1];
      for (var k = 0; k < keys.length; k++) {
        if (keys[k] && (domKey.indexOf(keys[k]) >= 0 || (keys[k].indexOf(domKey) >= 0 && domKey.length > 1))) {
          return val.realId;
        }
      }
    }
    return null;
  }

  // ===== 数据解析 =====
  function parseReportData(json, fallbackName) {
    if (!json) return null;
    let d = json.data || {};

    let knowledgeList = (d.knowledgeDtoList || []).map(function (k) {
      return {
        name: k.knowledgeName || '',
        rating: k.masteryRating || '-',
        totalQuestions: k.totalQuestionNum || 0,
        teacherAsk: (k.interactExample && k.interactExample.teacherAsk) || 0,
        stuAnswer: (k.interactExample && k.interactExample.stuAnswer) || 0,
        firstCorrect: (k.interactExample && k.interactExample.firstCorrect) || 0,
        guideCorrect: (k.interactExample && k.interactExample.guideCorrect) || 0,
        guideNum: (k.interactExample && k.interactExample.guideNum) || 0,
        exerciseCount: k.exerciseCount || 0,
        exerciseCorrect: k.exerciseCorrect || 0,
        completed: !!k.isCompleted,
      };
    });

    let exercises = [];
    if (d.courseDetail) {
      for (var i = 0; i < d.courseDetail.length; i++) {
        let comp = d.courseDetail[i];
        if (comp.studyComponentList) {
          for (var j = 0; j < comp.studyComponentList.length; j++) {
            let sc = comp.studyComponentList[j];
            if (sc.componentType === 3) {
              exercises.push({ hasRecord: true, correct: sc.answerCorrect === true });
            }
          }
        }
        if (comp.componentType === 3) {
          exercises.push({ hasRecord: true, correct: comp.answerCorrect === true });
        }
      }
    }

    let name = d.studentName || d.stuName || d.name || d.userName || d.chineseName || fallbackName || '未知';

    let masteryRating = d.masteryRating || (d.masteredInfo && d.masteredInfo.masteryRating) || null;
    if (!masteryRating && knowledgeList.length > 0) {
      for (var k = 0; k < knowledgeList.length; k++) {
        if (knowledgeList[k].rating && knowledgeList[k].rating !== '-') { masteryRating = knowledgeList[k].rating; break; }
      }
    }

    return {
      name: name,
      courseName: d.courseName || '',
      lessonName: d.lessonName || d.periodName || '',
      masteryRating: masteryRating || '-',
      focusRating: (d.focusInfo && d.focusInfo.focusRating) || null,
      focusAnswer: (d.focusInfo && d.focusInfo.focusAnswer) || 0,
      overOther: (d.focusInfo && d.focusInfo.overOther !== undefined)
        ? (d.focusInfo.overOther * 100 + '%') : '0%',
      interactNum: d.interactNum || 0,
      wrongNum: (d.mistakeSummaryVo && d.mistakeSummaryVo.wrongNum) || 0,
      questionNum: (d.mistakeSummaryVo && d.mistakeSummaryVo.questionNum) || 0,
      knowledgeList: knowledgeList,
      exercises: exercises,
    };
  }

  // ===== 分析单个学生 =====
  function analyzeStudent(d) {
    let hasData = (d.knowledgeList && d.knowledgeList.length > 0) ||
                  (d.exercises && d.exercises.length > 0) ||
                  (d.interactNum > 0);
    if (!hasData) {
      return {
        _idx: 0, name: d.name || '未知', studentId: d.studentId || '', userPhone: d.userPhone || '',
        courseName: d.courseName || d.rawCourseName || '', lessonName: d.lessonName || d.rawLessonName || '',
        rate: null, totalAsk: 0, totalAns: 0,
        focusRating: null, focusAnswer: 0, overOther: '0%',
        masteryRating: '-', firstRate: null, guideRate: null,
        firstCorrectTotal: 0, guideCorrectTotal: 0, guideNumTotal: 0,
        exerRate: null, exerTotalRecorded: 0, exerCorrectCount: 0, exerWrongCount: 0,
        wrongNum: 0, questionNum: 0, wrongRate: 0,
        knowledgeCount: 0, completedKnowledge: 0, completionRate: 0,
        interactNum: 0,
        inClassDuration: d.inClassDuration || '', homeworkStatus: d.homeworkStatus || '-', attendanceStatus: d.attendanceStatus || '-',
        tag: 'muted', label: '\u26AA未生成报告', masteryLabel: '-', exerLabel: '-',
        quadrant: '-', overallTag: '\u26AA未生成报告', overallTagClass: 'muted',
        diagnosis: '该学生暂无课节报告或报告尚未生成',
        knowledgeRows: [],
      };
    }

    let totalAsk = 0, totalAns = 0, firstCorrectTotal = 0,
        guideCorrectTotal = 0, guideNumTotal = 0;

    let knowledgeRows = (d.knowledgeList || []).map(function (k) {
      totalAsk += k.teacherAsk;
      totalAns += k.stuAnswer;
      firstCorrectTotal += k.firstCorrect;
      guideCorrectTotal += k.guideCorrect;
      guideNumTotal += k.guideNum;
      return k;
    });

    let rate = totalAsk > 0 ? Math.round(totalAns / totalAsk * 100) : null;
    let firstRate = totalAns > 0 ? Math.round(firstCorrectTotal / totalAns * 100) : null;
    let guideRate = guideNumTotal > 0 ? Math.round(guideCorrectTotal / guideNumTotal * 100) : null;

    let tag, label;
    if (rate === null) { tag = 'muted'; label = '-'; }
    else if (rate >= 80) { tag = 'success'; label = '\u2705积极互动'; }
    else if (rate >= 50) { tag = 'warning'; label = '\uD83D\uDC4D正常参与'; }
    else if (rate >= 30) { tag = 'danger'; label = '\uD83D\uDD34敷衍上课'; }
    else { tag = 'critical'; label = '\uD83D\uDEA8严重敷衍'; }

    let masteryLabel;
    let mr = d.masteryRating;
    if (mr === 'A+' || mr === 'A') { masteryLabel = '\u2705掌握扎实'; }
    else if (mr === 'B+') { masteryLabel = '\uD83D\uDC4D基本掌握'; }
    else if (mr === 'B') { masteryLabel = '\u26A0\uFE0F有漏洞'; }
    else { masteryLabel = '\uD83D\uDD34未掌握'; }

    let exerLabel, exerRate;
    let exerTotalRecorded = d.exercises ? d.exercises.length : 0;
    let exerCorrectCount = d.exercises ? d.exercises.filter(function (e) { return e.correct; }).length : 0;
    let exerWrongCount = exerTotalRecorded - exerCorrectCount;
    exerRate = exerTotalRecorded > 0 ? Math.round(exerCorrectCount / exerTotalRecorded * 100) : null;
    if (exerRate === null) { exerLabel = '-'; }
    else if (exerRate >= 80) { exerLabel = '\u2705全对'; }
    else if (exerRate >= 50) { exerLabel = '\uD83D\uDC4D大部分对'; }
    else { exerLabel = '\uD83D\uDD34大部分错'; }

    let wrongRate = d.questionNum > 0 ? Math.round(d.wrongNum / d.questionNum * 100) : 0;
    let knowledgeCount = knowledgeRows.length;
    let completedKnowledge = knowledgeRows.filter(function (k) { return k.completed; }).length;
    let completionRate = knowledgeCount > 0 ? Math.round(completedKnowledge / knowledgeCount * 100) : 0;

    // 综合标签（四维评价 v5.1.0）
    let quadrant, overallTag, overallTagClass;
    let rateVal = rate !== null ? rate : 0;
    let hasMastery = mr && mr !== '-';

    let masteryLevel;
    if (mr === 'A+' || mr === 'A') { masteryLevel = 'good'; }
    else if (mr === 'B+') { masteryLevel = 'mid'; }
    else { masteryLevel = 'bad'; }

    let rateHigh = rateVal > 80;

    if (hasMastery) {
      if (masteryLevel === 'good' && rateHigh) {
        quadrant = 'Q1'; overallTag = '\u2B50优秀'; overallTagClass = 'success';
      } else if (masteryLevel === 'mid' && rateHigh) {
        quadrant = 'Q2'; overallTag = '\uD83D\uDC4D认真'; overallTagClass = 'info';
      } else if (masteryLevel === 'bad' && rateHigh) {
        quadrant = 'Q3'; overallTag = '\u26A0\uFE0F需辅导'; overallTagClass = 'warning';
      } else if ((masteryLevel === 'good' || masteryLevel === 'mid') && !rateHigh) {
        quadrant = 'Q4'; overallTag = '\uD83D\uDEA8敷衍但会'; overallTagClass = 'danger';
      } else {
        quadrant = 'Q5'; overallTag = '\uD83D\uDD34敷衍'; overallTagClass = 'critical';
      }
    } else {
      if (rateVal > 80) { quadrant = 'Q1'; overallTag = '\uD83D\uDC4D认真'; overallTagClass = 'info'; }
      else if (rateVal > 40) { quadrant = 'Q4'; overallTag = '\u26A0\uFE0F需关注'; overallTagClass = 'warning'; }
      else { quadrant = 'Q5'; overallTag = '\uD83D\uDD34敷衍'; overallTagClass = 'danger'; }
    }

    // 风险附注
    let riskTags = [];
    let durationStr = d.inClassDuration || '';
    let durationMatch = durationStr.match(/(\d+)min/);
    let durationMin = durationMatch ? parseInt(durationMatch[1]) : 0;
    if (durationMin > 0 && durationMin <= 97) {
      riskTags.push('\u23F0听课不足');
    }
    let hwStatus = d.homeworkStatus || '';
    if (hwStatus && hwStatus !== '已完成' && hwStatus !== '-') {
      riskTags.push('\uD83D\uDCDD未交作业');
    }
    if (riskTags.length > 0) {
      overallTag = overallTag + ' ' + riskTags.join(' ');
    }

    let diagParts = [];
    if (rate !== null && rate < 50) diagParts.push('回答率' + rate + '%严重偏低');
    else if (rate !== null) diagParts.push('回答率' + rate + '%');
    if (mr && mr !== '-') diagParts.push('掌握度' + mr);
    if (durationMin > 0 && durationMin <= 97) diagParts.push('听课仅' + durationMin + '分钟');
    if (hwStatus && hwStatus !== '已完成' && hwStatus !== '-') diagParts.push('作业' + hwStatus);
    if (firstRate !== null && firstRate < 30) diagParts.push('首次答对率仅' + firstRate + '%');
    if (d.wrongNum > 0) diagParts.push(d.wrongNum + '道错题待复习');
    let diagnosis = diagParts.length > 0 ? diagParts.join('；') + '。' : '整体表现良好。';

    return {
      _idx: 0, name: d.name, studentId: d.studentId || '', userPhone: d.userPhone || '',
      courseName: d.courseName || d.rawCourseName || '', lessonName: d.lessonName || d.rawLessonName || '',
      rate: rate, totalAsk: totalAsk, totalAns: totalAns,
      focusRating: d.focusRating, focusAnswer: d.focusAnswer, overOther: d.overOther,
      masteryRating: d.masteryRating, firstRate: firstRate, guideRate: guideRate,
      firstCorrectTotal: firstCorrectTotal, guideCorrectTotal: guideCorrectTotal, guideNumTotal: guideNumTotal,
      exerRate: exerRate, exerTotalRecorded: exerTotalRecorded, exerCorrectCount: exerCorrectCount, exerWrongCount: exerWrongCount,
      wrongNum: d.wrongNum, questionNum: d.questionNum, wrongRate: wrongRate,
      knowledgeCount: knowledgeCount, completedKnowledge: completedKnowledge, completionRate: completionRate,
      interactNum: d.interactNum,
      inClassDuration: d.inClassDuration || '', homeworkStatus: d.homeworkStatus || '-', attendanceStatus: d.attendanceStatus || '-',
      tag: tag, label: label, masteryLabel: masteryLabel, exerLabel: exerLabel,
      quadrant: quadrant, overallTag: overallTag, overallTagClass: overallTagClass, diagnosis: diagnosis,
      knowledgeRows: knowledgeRows,
    };
  }

  function makeErrorRow(student, error) {
    let shortErr = error.length > 80 ? error.slice(0, 80) + '...' : error;
    return {
      _idx: 0, name: student.studentName, studentId: student.studentId || '', userPhone: student.userPhone || '',
      courseName: student.rawCourseName || '', lessonName: student.rawLessonName || '',
      rate: null, totalAsk: 0, totalAns: 0,
      focusRating: null, focusAnswer: 0, overOther: '0%',
      masteryRating: '-', firstRate: null, guideRate: null,
      firstCorrectTotal: 0, guideCorrectTotal: 0, guideNumTotal: 0,
      exerRate: null, exerTotalRecorded: 0, exerCorrectCount: 0, exerWrongCount: 0,
      wrongNum: 0, questionNum: 0, wrongRate: 0,
      knowledgeCount: 0, completedKnowledge: 0, completionRate: 0,
      interactNum: 0,
      inClassDuration: student.inClassDuration || '', homeworkStatus: student.homeworkStatus || '-', attendanceStatus: student.attendanceStatus || '-',
      tag: 'muted', label: '\u274C获取失败', masteryLabel: '-', exerLabel: '-',
      quadrant: '-', overallTag: '\u274C获取失败', overallTagClass: 'danger',
      diagnosis: shortErr,
      knowledgeRows: [],
    };
  }

  // ===== 表格渲染 =====
  function renderTable(data) {
    let wrap = $('#lrpTableWrap');
    if (!data || data.length === 0) {
      wrap.innerHTML = '<div class="lrp-empty"><div class="lrp-empty-icon">\uD83D\uDCED</div><p>暂无数据</p></div>';
      return;
    }

    let cols = [
      { id: '_idx', label: '#', w: 32 },
      { id: 'name', label: '姓名', w: 56 },
      { id: 'studentId', label: 'ID', w: 56, num: true },
      { id: 'overallTag', label: '标签', w: 90, render: function (r) { return badge(r.overallTag, r.overallTagClass); } },
      { id: 'rate', label: '回答率%', w: 62, num: true, render: function (r) { return pct(r.rate); } },
      { id: 'totalAsk', label: '提问数', w: 52, num: true },
      { id: 'totalAns', label: '回答数', w: 52, num: true },
      { id: 'masteryRating', label: '掌握度', w: 48, render: function (r) { return '<b>' + r.masteryRating + '</b>'; } },
      { id: 'firstRate', label: '首次答对率%', w: 78, num: true, render: function (r) { return pct(r.firstRate); } },
      { id: 'inClassDuration', label: '听课时长', w: 72, render: function (r) { return r.inClassDuration || '-'; } },
      { id: 'homeworkStatus', label: '作业完成', w: 64, render: function (r) { return r.homeworkStatus || '-'; } },
      { id: 'quadrant', label: '象限', w: 40, render: function (r) { return '<b>' + r.quadrant + '</b>'; } },
      { id: 'diagnosis', label: '诊断', w: 200, align: 'left' },
    ];

    let html = '<table class="lrp-table"><thead><tr>';
    cols.forEach(function (c) { html += '<th data-col="' + c.id + '" style="width:' + c.w + 'px">' + c.label + '</th>'; });
    html += '</tr></thead><tbody>';

    data.forEach(function (r) {
      let rowClass =
        r.tag === 'danger' || r.tag === 'critical' ? 'lrp-row-danger' :
        r.tag === 'warning' ? 'lrp-row-warning' :
        r.tag === 'success' ? 'lrp-row-success' : '';
      html += '<tr class="' + rowClass + '">';
      cols.forEach(function (c) {
        let val = c.render ? c.render(r) : (r[c.id] != null ? r[c.id] : '-');
        let align = c.num ? 'text-align:right;' : (c.align || '');
        html += '<td style="' + align + '">' + val + '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;

    $$('.lrp-table th[data-col]').forEach(function (th) {
      th.onclick = function () { sortBy(cols.find(function (c) { return c.id === th.dataset.col; })); };
    });

    updateStats(data);
    updateLessonFilter(data);
    $('#lrpFilterBar').style.display = '';
    $('#lrpStats').style.display = '';
  }

  // 标签排序权重：未生成→敷衍→敷衍但会→需辅导/需关注→认真→优秀
  let TAG_RANK = {
    'muted': 0,    // 未生成报告
    'critical': 1, // 🔴敷衍
    'danger': 2,   // 🚨敷衍但会 / 获取失败
    'warning': 3,  // ⚠️需辅导/需关注
    'info': 4,     // 👍认真
    'success': 5   // ⭐优秀
  };

  function getTagRank(r) {
    // 未生成报告单独标识
    if (r.overallTagClass === 'muted') return 0;
    return TAG_RANK[r.overallTagClass] !== undefined ? TAG_RANK[r.overallTagClass] : 99;
  }

  function sortBy(col) {
    if (!col) return;
    if (sortCol === col.id) { sortAsc = !sortAsc; }
    else { sortCol = col.id; sortAsc = true; }
    filteredData.sort(function (a, b) {
      // 标签列：按业务优先级权重排序，而非字符串字母序
      if (col.id === 'overallTag') {
        let ra = getTagRank(a), rb = getTagRank(b);
        return sortAsc ? ra - rb : rb - ra;
      }
      let va = a[col.id], vb = b[col.id];
      if (va == null) va = -999; if (vb == null) vb = -999;
      if (typeof va === 'string') return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      return sortAsc ? va - vb : vb - va;
    });
    renderTable(filteredData);
  }

  function applyFilter() {
    let tagVal = $('#lrpFilterTag').value;
    let lessonVal = $('#lrpFilterLesson').value;
    filteredData = allData.filter(function (r) {
      // 统一用 overallTagClass 字段匹配，与表格显示的标签一致
      if (tagVal && r.overallTagClass !== tagVal) return false;
      if (lessonVal && r.lessonName !== lessonVal) return false;
      return true;
    });
    renderTable(filteredData);
  }

  function updateStats(data) {
    if (!data.length) return;
    let valid = data.filter(function (r) { return r.rate != null; });
    let avgRate = valid.length ? Math.round(valid.reduce(function (s, r) { return s + r.rate; }, 0) / valid.length) : 0;
    // 统一用 overallTagClass 统计，与表格标签和筛选下拉一致
    let fuYanCount = data.filter(function (r) { return r.overallTagClass === 'critical' || r.overallTagClass === 'danger'; }).length;
    let youXiuCount = data.filter(function (r) { return r.overallTagClass === 'success'; }).length;
    let renZhenCount = data.filter(function (r) { return r.overallTagClass === 'info'; }).length;
    let guanZhuCount = data.filter(function (r) { return r.overallTagClass === 'warning'; }).length;
    $('#lrpStats').innerHTML =
      '<span>总计: <strong>' + data.length + '</strong></span>' +
      '<span>\uD83D\uDD34\uD83D\uDEA8敷衍: <strong>' + fuYanCount + '</strong></span>' +
      '<span>\u26A0\uFE0F需关注: <strong>' + guanZhuCount + '</strong></span>' +
      '<span>\uD83D\uDC4D认真: <strong>' + renZhenCount + '</strong></span>' +
      '<span>\u2B50优秀: <strong>' + youXiuCount + '</strong></span>' +
      '<span>平均回答率: <strong>' + avgRate + '%</strong></span>';
  }

  function updateLessonFilter(data) {
    let sel = $('#lrpFilterLesson');
    // 始终基于全量数据 allData 构建选项，避免筛选后选项丢失
    let sourceData = allData.length > 0 ? allData : data;
    let lessons = [];
    let seen = {};
    sourceData.forEach(function (r) {
      if (r.lessonName && !seen[r.lessonName]) {
        seen[r.lessonName] = true;
        lessons.push(r.lessonName);
      }
    });
    // 保留当前选中值
    let curVal = sel.value;
    sel.innerHTML = '<option value="">全部课节</option>' +
      lessons.map(function (l) { return '<option value="' + l + '">' + l.substring(0, 20) + (l.length > 20 ? '...' : '') + '</option>'; }).join('');
    // 恢复选中值
    if (curVal) sel.value = curVal;
  }

  // ===== Excel导出（v5.2.14: xlsx多Sheet）=====
  function exportExcel() {
    return (async function () {
      if (allData.length === 0) return;
      $('#lrpExportBtn').textContent = '\u23F3 导出中...';
      try {
        let resp = await sendMessage({ target: 'report', action: 'EXPORT_EXCEL', data: allData });
        let respData = (resp && resp.data) || resp || {};
        if (resp && resp.success === false) throw new Error(resp.error || '导出失败');
        // xlsx 优先（v5.2.14+）
        if (respData.xlsx) {
          let bin = atob(respData.xlsx);
          let buf = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
          let blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
          let url = URL.createObjectURL(blob);
          let a = document.createElement('a');
          a.href = url;
          a.download = respData.filename || '学习报告分析.xlsx';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
        } else if (respData.csv) {
          // CSV 兜底（旧版兼容）
          let bom = '\uFEFF';
          let blob = new Blob([bom + respData.csv], { type: 'text/csv;charset=utf-8;' });
          let url = URL.createObjectURL(blob);
          let a = document.createElement('a');
          a.href = url;
          a.download = respData.filename || '学习报告分析.csv';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
        }
        $('#lrpExportBtn').textContent = '\u2705 已导出';
        setTimeout(function () { $('#lrpExportBtn').textContent = '\u2B07\uFE0F 下载Excel'; }, 2000);
      } catch (e) {
        alert('导出失败: ' + e.message);
        $('#lrpExportBtn').textContent = '\u2B07\uFE0F 下载Excel';
      }
    })();
  }

  // ===== 复制问题名单 =====
  function copyProblemList() {
    let problems = allData.filter(function (r) {
      return r.tag === 'danger' || r.tag === 'critical' || r.overallTagClass === 'danger';
    });
    if (problems.length === 0) { alert('没有需要关注的学生！'); return; }

    let text = '问题学生名单\n' + '='.repeat(40) + '\n';
    text += '序号\t姓名\t回答率%\t掌握度\t诊断\n';
    text += '-'.repeat(40) + '\n';
    problems.forEach(function (r, i) {
      text += (i + 1) + '\t' + r.name + '\t' + (r.rate != null ? r.rate : '-') + '\t' + r.masteryRating + '\t' + r.diagnosis + '\n';
    });

    navigator.clipboard.writeText(text).then(function () {
      $('#lrpCopyBtn').textContent = '\u2705 已复制';
      setTimeout(function () { $('#lrpCopyBtn').textContent = '\uD83D\uDCCB 复制问题名单'; }, 2000);
    }).catch(function () { alert('复制失败'); });
  }

  function escapeHTML(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ===== 工具函数 =====
  function sendMessage(msg) {
    return new Promise(function (resolve, reject) {
      chrome.runtime.sendMessage(msg, function (resp) {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(resp);
      });
    });
  }

  function setStatus(color, text) {
    let dot = $('#lrpDot');
    dot.className = 'lrp-dot ' + color;
    $('#lrpStatusText').textContent = text;
  }

  function showProgress(show) { $('#lrpProgress').style.display = show ? '' : 'none'; }
  function showLog(show) {
    let area = $('#lrpLogArea');
    area.style.display = show ? '' : 'none';
    // 按钮行始终不在这里控制，由 showLogBtns 单独管理
  }

  // 显示/隐藏日志按钮行（获取完成/失败后调用）
  function showLogBtns(show) {
    let row = $('#lrpLogBtnRow');
    if (row) row.style.display = show ? 'flex' : 'none';
  }

  function setProgress(pct, info) {
    $('#lrpProgressFill').style.width = pct + '%';
    $('#lrpProgressFill').textContent = pct + '%';
    $('#lrpProgressInfo').textContent = info;
  }

  /**
   * 转发日志到壳的调试面板（仅 error/warn，避免消息过多）
   */
  function forwardLogToShell(level, msg) {
    try {
      chrome.runtime.sendMessage({
        target: 'shell',
        action: 'LOG_FORWARD',
        data: { level: level, source: 'report-content', message: msg }
      }).catch(function () {});
    } catch (e) {}
  }

  function log(type, msg) {
    let area = $('#lrpLogArea');
    if (!area) return;
    // ★ 不强制展开日志区，由 showLog()/showLogBtns() 统一控制可见性
    let entry = document.createElement('div');
    entry.className = 'lrp-log-entry ' + type;
    entry.style.cssText = type === 'error' ? 'color:#f88;' : type === 'warn' ? 'color:#ff0;' : type === 'ok' ? 'color:#0f0;' : '';
    entry.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
    area.appendChild(entry);
    area.scrollTop = area.scrollHeight;
    // error/warn 转发到壳调试面板
    if (type === 'error' || type === 'warn') {
      forwardLogToShell(type, msg);
    }
  }

  function badge(text, cls) {
    return text ? '<span class="lrp-badge ' + (cls || '') + '">' + text + '</span>' : '-';
  }

  function pct(val) {
    if (val == null) return '-';
    let v = Number(val);
    return '<span class="' + (v < 40 ? 'pct-low' : v < 60 ? 'pct-mid' : 'pct-high') + '">' + v + '%</span>';
  }

})();
