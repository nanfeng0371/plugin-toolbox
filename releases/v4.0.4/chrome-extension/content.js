/**
 * Content Script v4.0.0 — iframe方案
 * 
 * 核心变更：Step4改用iframe
 *   - 在工作台页面内创建隐藏iframe，src=短链(s1.aiv5.cc/xxx)
 *   - 浏览器自动走302+SSO+种Cookie → iframe加载reportV2.html（有登录态）
 *   - report_fetcher.js(all_frames:true)在iframe内同源fetch 3个API
 *   - 数据流: report_fetcher.js → background.js(relay) → content.js
 *   - 收到数据后移除iframe，处理下一个学生
 */

(function() {
  'use strict';

  const WORK_DOMAINS = ['ai-genesis.yuaiweiwu.com', 'www.yuaiweiwu.com'];
  const PANEL_ID = 'lrp-panel-container';

  // 不在工作台页面就退出
  if (!WORK_DOMAINS.includes(location.hostname)) return;

  // 防止重复注入
  if (document.getElementById(PANEL_ID)) return;

  // ===== 注册工作台tab到background.js =====
  chrome.runtime.sendMessage({ type: 'REGISTER_TAB' });

  // ===== iframe请求管理 =====
  const _pendingIframeRequests = new Map(); // reportToken → { resolve, reject, timer, iframe }

  // 监听background.js relay过来的数据
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'RELAY_REPORT_DATA') {
      const { reportToken, data, error } = msg;
      const pending = _pendingIframeRequests.get(reportToken);
      if (!pending) return; // 不是我们的请求

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
      // Fallback: 用base64下载
      try {
        const bin = atob(msg.data);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = msg.filename || 'report.xlsx';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } catch(e) { alert('下载失败: ' + e.message); }
    }
  });

  /**
   * 通过iframe获取报告数据
   * @param {string} shortUrl - 短链URL (s1.aiv5.cc/xxx)
   * @param {string} reportToken - 从短链重定向中提取的token
   * @param {number} [timeout=30000] - 超时时间(ms)
   * @returns {Promise<Object>} - API返回的JSON数据
   */
  function fetchViaIframe(shortUrl, reportToken, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = _pendingIframeRequests.get(reportToken);
        if (pending && pending.iframe) pending.iframe.remove();
        _pendingIframeRequests.delete(reportToken);
        reject(new Error(`iframe数据获取超时(${timeout/1000}s)`));
      }, timeout);

      // 创建隐藏iframe
      const iframe = document.createElement('iframe');
      iframe.style.cssText = 'width:1px;height:1px;position:fixed;left:-9999px;top:-9999px;opacity:0;pointer-events:none;border:none;';
      iframe.src = shortUrl;

      _pendingIframeRequests.set(reportToken, { resolve, reject, timer, iframe: null });

      document.body.appendChild(iframe);
      _pendingIframeRequests.get(reportToken).iframe = iframe;

      log('info', `[Step4] iframe已创建, 短链=${shortUrl.slice(-12)}`);
    });
  }

  /** 清除所有pending的iframe请求（用于停止操作） */
  function cleanupAllIframes() {
    for (const [token, pending] of _pendingIframeRequests) {
      clearTimeout(pending.timer);
      if (pending.iframe) pending.iframe.remove();
      pending.reject(new Error('用户取消'));
    }
    _pendingIframeRequests.clear();
  }

  // ===== 创建侧边栏容器 =====
  const container = document.createElement('div');
  container.id = PANEL_ID;
  container.className = 'lrp-container';
  container.innerHTML = buildHTML();
  document.body.appendChild(container);

  // ===== 状态 =====
  let allData = [];
  let filteredData = [];
  let sortCol = null;
  let sortAsc = true;
  let collapsed = false;
  let isFetching = false;
  let abortFlag = false;

  // ===== DOM引用 =====
  const $ = s => container.querySelector(s);
  const $$ = s => container.querySelectorAll(s);

  // ===== 初始化 =====
  init();

  function init() {
    bindEvents();
    checkConnection();
  }

  function buildHTML() {
    return `
    <button class="lrp-toggle" id="lrpToggle" title="收起/展开">◀</button>
    <div class="lrp-inner" style="width:100%;height:100%;display:flex;flex-direction:column;">
      <!-- Header -->
      <div class="lrp-header">
        <h1>📊 学习报告分析 <small>v4.0.4</small></h1>
        <div class="lrp-status">
          <span class="lrp-dot grey" id="lrpDot"></span>
          <span id="lrpStatusText">检测登录态中...</span>
          <button class="lrp-btn small" id="lrpRefreshBtn" title="重新检测页面数据">🔄</button>
        </div>
      </div>

      <!-- Toolbar -->
      <div class="lrp-toolbar">
        <button class="lrp-btn primary" id="lrpStartBtn">🚀 批量获取分析</button>
        <button class="lrp-btn danger" id="lrpStopBtn" style="display:none;">⏹ 停止</button>
        <button class="lrp-btn" id="lrpExportBtn" disabled>⬇️ 下载CSV</button>
        <button class="lrp-btn" id="lrpCopyBtn" disabled>📋 复制问题名单</button>
      </div>

      <!-- Filter -->
      <div class="lrp-filter-bar" style="display:none;" id="lrpFilterBar">
        <label>筛选：</label>
        <select id="lrpFilterTag"><option value="">全部</option><option value="danger">🚨敷衍预警</option><option value="warning">⚠️需关注</option><option value="success">⭐优秀</option></select>
        <select id="lrpFilterLesson"><option value="">全部课节</option></select>
      </div>

      <!-- Progress -->
      <div class="lrp-progress" id="lrpProgress" style="display:none;">
        <div class="lrp-progress-bar"><div class="lrp-progress-fill" id="lrpProgressFill" style="width:0%">0%</div></div>
        <div class="lrp-progress-info" id="lrpProgressInfo">准备中...</div>
      </div>

      <!-- Table Area -->
      <div class="lrp-table-wrap" id="lrpTableWrap">
        <div class="lrp-empty" id="lrpEmpty">
          <div class="lrp-empty-icon">📊</div>
          <div><b>准备就绪</b></div>
          <p>点击上方「批量获取分析」开始</p>
        </div>
      </div>

      <!-- Stats Bar -->
      <div class="lrp-stats" id="lrpStats" style="display:none;"></div>

      <!-- Log Area -->
      <div class="lrp-log-area" id="lrpLogArea" style="display:none;max-height:200px;overflow-y:auto;background:#1e1e1e;color:#0f0;font-family:Consolas,monospace;font-size:11px;padding:8px;border-radius:4px;"></div>
      <div style="display:flex;gap:4px;">
        <button class="lrp-btn small" id="lrpToggleLogBtn" style="display:none;">📋 日志</button>
        <button class="lrp-btn small" id="lrpBgLogBtn" style="display:none;">🔧 后台日志</button>
      </div>
    `;
  }

  // ===== 事件绑定 =====
  function bindEvents() {
    $('#lrpToggle').onclick = togglePanel;
    $('#lrpStartBtn').onclick = startBatchFetch;
    $('#lrpStopBtn').onclick = stopFetch;
    $('#lrpExportBtn').onclick = exportExcel;
    $('#lrpCopyBtn').onclick = copyProblemList;
    $('#lrpRefreshBtn').onclick = () => {
      setStatus('blue', '🔄 正在刷新...');
      checkConnection();
    };
    $('#lrpFilterTag').onchange = applyFilter;
    $('#lrpFilterLesson').onchange = applyFilter;
    if ($('#lrpToggleLogBtn')) $('#lrpToggleLogBtn').onclick = () => {
      const area = $('#lrpLogArea');
      area.style.display = area.style.display === 'none' ? '' : 'none';
    };
    if ($('#lrpBgLogBtn')) $('#lrpBgLogBtn').onclick = async () => {
      try {
        const logs = await sendMessage({ type: 'GET_LOGS' });
        const area = $('#lrpLogArea');
        area.style.display = '';
        area.innerHTML = '';
        if (logs && logs.length) {
          logs.forEach(l => {
            const entry = document.createElement('div');
            entry.className = `lrp-log-entry ${l.level}`;
            entry.style.cssText = l.level==='error' ? 'color:#f88;' : l.level==='warn' ? 'color:#ff0;' : '';
            entry.textContent = `[${l.time}] ${l.msg}`;
            area.appendChild(entry);
          });
          area.scrollTop = area.scrollHeight;
        } else {
          area.innerHTML = '<div class="lrp-log-entry info">暂无后台日志</div>';
        }
      } catch(e) { alert('获取日志失败: '+e.message); }
    };
  }

  function togglePanel() {
    collapsed = !collapsed;
    container.classList.toggle('lrp-collapsed', collapsed);
    $('#lrpToggle').textContent = collapsed ? '▶' : '◀';
  }

  // ===== 连接检测 =====
  async function checkConnection() {
    try {
      setStatus('grey', '⏳ 检测中...');
      const filters = extractPageFilters();
      try {
        const res = await sendMessage({ type: 'FETCH_STUDENT_LIST', payload: filters });
        if (res.data && res.data.length > 0) {
          setStatus('ok', `✅ 已连接 | ${res.data.length} 个学生`);
          log('info', `连接成功，${res.data.length} 个学生`);
          return;
        } else if (res.error) {
          throw new Error(res.error);
        } else {
          setStatus('yellow', `⚠️ 插件正常 | 当前筛选无数据`);
          return;
        }
      } catch(apiErr) {
        log('warn', '带参API检测失败: ' + apiErr.message);
      }
      const fallback = await sendMessage({ type: 'CHECK_CONNECTION' });
      if (fallback.connected) {
        setStatus('ok', `✅ 已连接 | 后端可用(${fallback.count}条)`);
      } else {
        setStatus('red', '❌ 未登录或无数据');
      }
    } catch(e) {
      setStatus('red', '❌ 检测失败: ' + e.message);
    }
  }

  // ===== 从页面提取筛选参数 =====
  function extractPageFilters() {
    const filters = { classStatus: 2 };
    try {
      const dateInputs = document.querySelectorAll(
        'input[placeholder*="日期"], input[placeholder*="-"], .el-date-editor input, ' +
        '.ant-picker input, [class*="date"] input, [class*="Date"] input'
      );
      if (dateInputs.length >= 2) {
        filters.startDate = dateInputs[0].value || undefined;
        filters.endDate = dateInputs[1].value || undefined;
      } else if (dateInputs.length === 1) {
        const val = dateInputs[0].value;
        if (val && val.includes('~')) {
          const parts = val.split('~');
          filters.startDate = parts[0].trim();
          filters.endDate = parts[1].trim();
        }
      }
      if (!filters.startDate || !filters.endDate) {
        const pageText = document.body.innerText;
        const dateMatch = pageText.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s*[—~-]\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
        if (dateMatch) {
          filters.startDate = dateMatch[1];
          filters.endDate = dateMatch[2];
        }
      }
    } catch(e) {}

    try {
      const tabs = document.querySelectorAll('.el-tabs__item, .ant-tabs-tab, [class*="tab"] li, [role="tab"]');
      for (const tab of tabs) {
        const text = tab.textContent.trim();
        const isActive = tab.classList.contains('is-active') || tab.classList.contains('active') ||
                         tab.getAttribute('aria-selected') === 'true';
        if (isActive) {
          if (text.includes('进行中')) filters.classStatus = 1;
          else if (text.includes('已结束')) filters.classStatus = 2;
          else if (text.includes('全部')) filters.classStatus = null;
          else if (text.includes('待开始')) filters.classStatus = 0;
          break;
        }
      }
    } catch(e) {}

    try {
      const searchInput = document.querySelector('input[placeholder*="搜索"], input[placeholder*="查找"], .search-input input, [class*="search"] input');
      if (searchInput && searchInput.value.trim()) {
        filters.keyword = searchInput.value.trim();
      }
    } catch(e) {}

    log('info', `页面筛选: classStatus=${filters.classStatus}, 日期=${filters.startDate || '~'} → ${filters.endDate || '~'}`);
    return filters;
  }

  // ===== 批量获取（v4.0.0: iframe方案）=====
  async function startBatchFetch() {
    const btn = $('#lrpStartBtn');
    const stopBtn = $('#lrpStopBtn');
    btn.disabled = true; btn.textContent = '⏳ 获取中...';
    stopBtn.style.display = ''; stopBtn.disabled = false;
    isFetching = true; abortFlag = false;
    showProgress(true); showLog(true);

    try {
      // Step1: 获取学生列表
      log('info', '正在读取页面筛选条件...');
      setProgress(3, '正在读取页面筛选条件...');
      const filters = extractPageFilters();

      log('info', '正在获取学生列表...');
      setProgress(5, '正在获取学生列表...');
      const listRes = await sendMessage({ type: 'FETCH_STUDENT_LIST', payload: filters });

      if (listRes.error || !listRes.data || listRes.data.length === 0) {
        throw new Error(listRes.error || '未找到任何学生');
      }

      const students = listRes.data;

      if (listRes._debugFirst) {
        log('info', `[Step1🔍] 原始数据: ${listRes._debugFirst}`);
      }
      if (students.length > 0 && students[0]._debugIds) {
        log('info', `[Step1🔍] 候选ID字段: ${Object.keys(students[0]._debugIds).join(', ')}`);
      }

      // Step1.5: 从页面DOM提取真实biz ID
      log('info', '[Step1.5] 正在从页面提取真实ID...');
      setProgress(5, '正在从页面提取真实ID...');
      const domIdMap = scrapeReportLinkIds();
      let matchedCount = 0;
      for (const s of students) {
        const realId = findBestMatch(s, domIdMap);
        if (realId && realId !== s.periodId) {
          s._originalPeriodId = s.periodId;
          s.periodId = realId;
          matchedCount++;
        }
      }
      log('info', `[Step1.5✅] DOM ID匹配: ${matchedCount}/${students.length}`);

      setStatus('green', `🔄 正在获取: 0/${students.length}`);
      allData = [];

      // Step2+3+4: 逐个获取报告（iframe方案）
      for (let i = 0; i < students.length; i++) {
        if (abortFlag) {
          log('warn', `用户中断！已完成 ${i}/${students.length}`);
          setStatus('yellow', `⏹ 已停止 | 完成 ${i}/${students.length}`);
          break;
        }

        const s = students[i];
        setProgress(5 + Math.round(90 * i / students.length), `[${i+1}/${students.length}] ${s.studentName}`);

        try {
          // Step2+3: 从background.js获取短链和reportToken
          log('info', `${s.studentName} [Step2+3] 获取短链...`);
          const urlRes = await sendMessage({ type: 'FETCH_SHORT_URL', payload: s });

          if (urlRes.error) {
            throw new Error(urlRes.error);
          }

          const { shortUrl, reportToken } = urlRes;
          log('info', `${s.studentName} [Step2+3✅] 短链=${shortUrl.slice(-12)}, token=${reportToken.slice(0,8)}...`);

          // Step4: 创建iframe → 等待数据回传
          log('info', `${s.studentName} [Step4] 创建iframe获取数据...`);
          const dataJson = await fetchViaIframe(shortUrl, reportToken);

          // 检查API返回
          if (dataJson.code && dataJson.code !== '000000' && dataJson.code !== 0 && dataJson.code !== 200) {
            const errMsg = dataJson.msg || dataJson.mesg || '';
            throw new Error(`API错误(${dataJson.code}): ${errMsg}`);
          }

          log('info', `${s.studentName} [Step4✅] 数据获取成功`);

          // 解析+分析（传入学生列表中的姓名作为fallback）
          const parsed = parseReportData(dataJson, s.studentName);
          if (!parsed) {
            throw new Error('返回数据结构异常');
          }
          const analyzed = analyzeStudent(parsed);
          analyzed._idx = i + 1;
          allData.push(analyzed);
          log('ok', `${s.studentName}: ✅ 完成`);

        } catch(e) {
          log('error', `${s.studentName}: ${e.message}`);
          allData.push(makeErrorRow(s, e.message));
        }

        // 每3个更新一次表格显示
        if ((i + 1) % 3 === 0 || i === students.length - 1 || abortFlag) {
          renderTable(allData);
        }
      }

      // 完成后的收尾
      const completedCount = abortFlag ? allData.length : students.length;
      setProgress(100, abortFlag ? `已停止 (${completedCount}/${students.length})` : `全部完成！${students.length}个学生`);
      showProgress(false);
      isFetching = false; abortFlag = false;

      const logBtn = $('#lrpToggleLogBtn');
      const bgLogBtn = $('#lrpBgLogBtn');
      if (logBtn && $('#lrpLogArea').children.length > 0) {
        logBtn.style.display = '';
      }
      if (bgLogBtn) { bgLogBtn.style.display = ''; }

      if (abortFlag) {
        setStatus('yellow', `⏹ 已停止 | ${completedCount}个学生`);
        btn.textContent = '🔄 继续获取';
      } else {
        setStatus('green', `✅ 完成 | ${students.length}个学生`);
        btn.textContent = '🔄 重新获取';
      }
      btn.disabled = false;
      stopBtn.style.display = 'none';

      if (allData.length > 0) {
        $('#lrpExportBtn').disabled = false;
        $('#lrpCopyBtn').disabled = false;
      }

      applyFilter();

    } catch(e) {
      log('error', '批量获取失败: ' + e.message);
      setStatus('red', '❌ 失败: ' + e.message);
      showProgress(false);
      isFetching = false; abortFlag = false;
      btn.textContent = '🚀 重试'; btn.disabled = false;
      $('#lrpStopBtn').style.display = 'none';
      cleanupAllIframes();
    }
  }

  // ===== 中断获取 =====
  function stopFetch() {
    abortFlag = true;
    cleanupAllIframes();
    const stopBtn = $('#lrpStopBtn');
    if (stopBtn) { stopBtn.disabled = true; stopBtn.textContent = '⏹ 停止中...'; }
    log('warn', '正在停止，请稍候...');
  }

  // ===== 从页面「报告链接」按钮提取真实biz ID =====
  function scrapeReportLinkIds() {
    const idMap = new Map();

    // 策略1: 查找「报告」按钮
    const reportLinks = document.querySelectorAll(
      'a[href*="report"], a[href*="biz"], button[class*="report"], ' +
      '[class*="report"] a, [class*="btn"] span, ' +
      'a[target="_blank"], .el-button--primary, .ant-btn-primary'
    );
    for (const link of reportLinks) {
      const text = (link.textContent || '').trim();
      if (!text.includes('报告') && !text.includes('Report')) continue;
      const row = link.closest('tr, [class*="row"]');
      if (!row) continue;
      const studentKey = extractStudentKeyFromRow(row);
      const realId = extractIdFromLink(link);
      if (realId && studentKey) {
        idMap.set(studentKey, { realId, source: `报告按钮(${text})` });
      }
    }

    // 策略2: onclick/href/data属性
    if (idMap.size === 0) {
      const allClickable = document.querySelectorAll('a, button, [role="button"], [class*="btn"], td, .cell');
      for (const el of allClickable) {
        const onclick = el.getAttribute('onclick') || '';
        const href = el.getAttribute('href') || '';
        const dataId = el.dataset.id || el.dataset.periodId || el.dataset.bookingId || '';
        if ((onclick.includes('biz') || onclick.includes('report') || href.includes('biz') || dataId)) {
          const row = el.closest('tr, [class*="row"]');
          if (!row) continue;
          const studentKey = extractStudentKeyFromRow(row);
          let realId = null;
          if (onclick) {
            const idMatch = onclick.match(/['"]?id['"]?\s*[:=]\s*['"]?(\d{5,10})/);
            if (idMatch) realId = idMatch[1];
          }
          if (!realId && href) {
            const hrefId = href.match(/[?&]id=(\d{5,10})/);
            if (hrefId) realId = hrefId[1];
          }
          if (!realId && dataId) realId = dataId;
          if (realId && studentKey) {
            idMap.set(studentKey, { realId, source: 'onclick/href/data' });
          }
        }
      }
    }

    // 策略3: Vue实例
    if (idMap.size === 0) {
      const rows = document.querySelectorAll('table tbody tr, .el-table__row, [class*="row"]');
      for (const row of rows) {
        try {
          const vm = row.__vue__;
          if (!vm) continue;
          let rowData = vm.row;
          if (!rowData && vm.$parent && vm.$parent.tableData) {
            rowData = vm.$parent.tableData[vm.$index];
          }
          if (rowData) {
            const name = rowData.studentName || rowData.name || rowData.chineseName;
            const allFields = flattenObject(rowData);
            const idCandidates = [];
            for (const [path, val] of Object.entries(allFields)) {
              if (/id$/i.test(path.split('.').pop()) && /^\d{5,8}$/.test(String(val))) {
                idCandidates.push({ path, val: String(val) });
              }
            }
            if (name && idCandidates.length > 0) {
              idCandidates.sort((a, b) => b.val.length - a.val.length);
              idMap.set(name, { realId: idCandidates[0].val, source: `Vue.${idCandidates[0].path}` });
            }
          }
        } catch(e) {}
      }
    }

    log('info', `[Step1.5🔍] DOM扫描: ${idMap.size} 个报告链接ID`);
    return idMap;
  }

  function extractStudentKeyFromRow(row) {
    const cells = row.querySelectorAll('td, .cell');
    for (const cell of cells) {
      const text = cell.textContent.trim();
      if(/^\d{3}\*{4}\d{4}$/.test(text)) return text;
      if (text.length >= 2 && text.length <= 15 &&
          !text.includes('%') && !text.includes('-') &&
          !['是', '否', '离线', '在线', '有效', '无效', '应出勤'].includes(text) &&
          !/\d{11}/.test(text) && !/^\d+$/.test(text)) {
        return text;
      }
    }
    return null;
  }

  function extractIdFromLink(el) {
    const onclick = el.getAttribute('onclick') || '';
    const m1 = onclick.match(/['"]?id['"]?\s*[:=]\s*['"]?(\d{5,10})/);
    if (m1) return m1[1];
    const href = el.getAttribute('href') || '';
    const m2 = href.match(/[?&]id=(\d{5,10})/);
    if (m2) return m2[1];
    if (el.dataset.id && /^\d{5,10}$/.test(el.dataset.id)) return el.dataset.id;
    if (el.dataset.periodId && /^\d{5,10}$/.test(el.dataset.periodId)) return el.dataset.periodId;
    if (el.dataset.bookingId && /^\d{5,10}$/.test(el.dataset.bookingId)) return el.dataset.bookingId;
    return null;
  }

  function flattenObject(obj, prefix = '', result = {}) {
    if (!obj || typeof obj !== 'object') return result;
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        flattenObject(v, path, result);
      } else {
        result[path] = v;
      }
    }
    return result;
  }

  function findBestMatch(student, domIdMap) {
    if (domIdMap.size === 0) return null;
    const keys = [student.studentName, student.userName, student.chineseName, student.remarkName, student.userPhone].filter(Boolean);
    for (const key of keys) {
      if (domIdMap.has(key)) return domIdMap.get(key).realId;
    }
    for (const [domKey, val] of domIdMap.entries()) {
      for (const k of keys) {
        if (k && (domKey.includes(k) || (k.includes(domKey) && domKey.length > 1))) {
          return val.realId;
        }
      }
    }
    return null;
  }

  // ===== 数据解析（同background.js的parseReportData）=====
  function parseReportData(json, fallbackName) {
    if (!json) return null;
    const d = json.data || {};

    const knowledgeList = (d.knowledgeDtoList || []).map(k => ({
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
    }));

    const exercises = [];
    if (d.courseDetail) {
      for (const comp of d.courseDetail) {
        if (comp.studyComponentList) {
          for (const sc of comp.studyComponentList) {
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

    // 尝试多种可能的姓名字段，最后用fallbackName兜底
    const name = d.studentName || d.stuName || d.name || d.userName || d.chineseName || fallbackName || '未知';

    // 掌握度：尝试多种路径（顶层 → masteredInfo → knowledgeList第一个有效的）
    let masteryRating = d.masteryRating || (d.masteredInfo && d.masteredInfo.masteryRating) || null;
    if (!masteryRating && knowledgeList.length > 0) {
      for (const k of knowledgeList) {
        if (k.rating && k.rating !== '-') { masteryRating = k.rating; break; }
      }
    }

    return {
      name,
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
      knowledgeList,
      exercises,
    };
  }

  // ===== 分析单个学生 =====
  function analyzeStudent(d) {
    // 检测是否无课节报告数据（未生成报告）
    const hasData = (d.knowledgeList && d.knowledgeList.length > 0) ||
                    (d.exercises && d.exercises.length > 0) ||
                    (d.interactNum > 0);
    if (!hasData) {
      return {
        _idx: 0, name: d.name || '未知',
        courseName: d.courseName || '', lessonName: d.lessonName || '',
        rate: null, totalAsk: 0, totalAns: 0,
        focusRating: null, focusAnswer: 0, overOther: '0%',
        masteryRating: '-', firstRate: null, guideRate: null,
        firstCorrectTotal: 0, guideCorrectTotal: 0, guideNumTotal: 0,
        exerRate: null, exerTotalRecorded: 0, exerCorrectCount: 0, exerWrongCount: 0,
        wrongNum: 0, questionNum: 0, wrongRate: 0,
        knowledgeCount: 0, completedKnowledge: 0, completionRate: 0,
        interactNum: 0,
        tag: 'muted', label: '⚪未生成报告', masteryLabel: '-', exerLabel: '-',
        quadrant: '-', overallTag: '⚪未生成报告', overallTagClass: 'muted',
        diagnosis: '该学生暂无课节报告或报告尚未生成',
        knowledgeRows: [],
      };
    }

    let totalAsk = 0, totalAns = 0, firstCorrectTotal = 0,
        guideCorrectTotal = 0, guideNumTotal = 0;

    const knowledgeRows = (d.knowledgeList || []).map(k => {
      totalAsk += k.teacherAsk;
      totalAns += k.stuAnswer;
      firstCorrectTotal += k.firstCorrect;
      guideCorrectTotal += k.guideCorrect;
      guideNumTotal += k.guideNum;
      return k;
    });

    const rate = totalAsk > 0 ? Math.round(totalAns / totalAsk * 100) : null;
    const firstRate = totalAns > 0 ? Math.round(firstCorrectTotal / totalAns * 100) : null;
    const guideRate = guideNumTotal > 0 ? Math.round(guideCorrectTotal / guideNumTotal * 100) : null;

    // 参与度判定
    let tag, label;
    if (rate === null) { tag = 'muted'; label = '-'; }
    else if (rate >= 80) { tag = 'success'; label = '✅积极互动'; }
    else if (rate >= 50) { tag = 'warning'; label = '👍正常参与'; }
    else if (rate >= 30) { tag = 'danger'; label = '🔴敷衍上课'; }
    else { tag = 'critical'; label = '🚨严重敷衍'; }

    // 学习效果判定
    let masteryLabel;
    const mr = d.masteryRating;
    if (mr === 'A+' || mr === 'A') { masteryLabel = '✅掌握扎实'; }
    else if (mr === 'B+') { masteryLabel = '👍基本掌握'; }
    else if (mr === 'B') { masteryLabel = '⚠️有漏洞'; }
    else { masteryLabel = '🔴未掌握'; }

    // 练习情况判定
    let exerLabel, exerRate;
    const exerTotalRecorded = d.exercises ? d.exercises.length : 0;
    const exerCorrectCount = d.exercises ? d.exercises.filter(e => e.correct).length : 0;
    const exerWrongCount = exerTotalRecorded - exerCorrectCount;
    exerRate = exerTotalRecorded > 0 ? Math.round(exerCorrectCount / exerTotalRecorded * 100) : null;
    if (exerRate === null) { exerLabel = '-'; }
    else if (exerRate >= 80) { exerLabel = '✅全对'; }
    else if (exerRate >= 50) { exerLabel = '👍大部分对'; }
    else { exerLabel = '🔴大部分错'; }

    // 错题率
    const wrongRate = d.questionNum > 0 ? Math.round(d.wrongNum / d.questionNum * 100) : 0;
    const knowledgeCount = knowledgeRows.length;
    const completedKnowledge = knowledgeRows.filter(k => k.completed).length;
    const completionRate = knowledgeCount > 0 ? Math.round(completedKnowledge / knowledgeCount * 100) : 0;

    // 四象限（方案B：有掌握度数据走四象限，无掌握度只看回答率）
    let quadrant, overallTag, overallTagClass;
    const rateVal = rate !== null ? rate : 0;
    const hasMastery = mr && mr !== '-';
    const mrVal = (mr === 'A+' || mr === 'A') ? 4 : (mr === 'B+') ? 3 : (mr === 'B') ? 2 : 1;

    if (hasMastery) {
      // 有掌握度 → 标准四象限
      if (rateVal >= 80 && mrVal >= 3) { quadrant = 'Q1'; overallTag = '⭐优秀'; overallTagClass = 'success'; }
      else if (rateVal >= 50 && mrVal >= 2) { quadrant = 'Q2'; overallTag = '👍认真'; overallTagClass = 'info'; }
      else if (rateVal < 50 && mrVal < 2) { quadrant = 'Q3'; overallTag = '❌敷衍+未掌握'; overallTagClass = 'danger'; }
      else { quadrant = 'Q4'; overallTag = '⚠️需关注'; overallTagClass = 'warning'; }
    } else {
      // 无掌握度 → 只看回答率
      if (rateVal >= 80) { quadrant = 'Q1'; overallTag = '⭐优秀'; overallTagClass = 'success'; }
      else if (rateVal >= 60) { quadrant = 'Q2'; overallTag = '👍认真'; overallTagClass = 'info'; }
      else if (rateVal >= 40) { quadrant = 'Q4'; overallTag = '⚠️需关注'; overallTagClass = 'warning'; }
      else { quadrant = 'Q3'; overallTag = '❌敷衍'; overallTagClass = 'danger'; }
    }

    // 一句话诊断
    let diagParts = [];
    if (rate !== null && rate < 50) diagParts.push(`回答率${rate}%严重偏低`);
    else if (rate !== null) diagParts.push(`回答率${rate}%`);
    if (firstRate !== null && firstRate < 30) diagParts.push(`首次答对率仅${firstRate}%`);
    if (d.wrongNum > 0) diagParts.push(`${d.wrongNum}道错题待复习`);
    const diagnosis = diagParts.length > 0 ? diagParts.join('；') + '。' : '整体表现良好。';

    return {
      _idx: 0, name: d.name,
      courseName: d.courseName, lessonName: d.lessonName,
      rate, totalAsk, totalAns,
      focusRating: d.focusRating, focusAnswer: d.focusAnswer, overOther: d.overOther,
      masteryRating: d.masteryRating, firstRate, guideRate,
      firstCorrectTotal, guideCorrectTotal, guideNumTotal,
      exerRate, exerTotalRecorded, exerCorrectCount, exerWrongCount,
      wrongNum: d.wrongNum, questionNum: d.questionNum, wrongRate,
      knowledgeCount, completedKnowledge, completionRate,
      interactNum: d.interactNum,
      tag, label, masteryLabel, exerLabel,
      quadrant, overallTag, overallTagClass, diagnosis,
      knowledgeRows,
    };
  }

  function makeErrorRow(student, error) {
    const shortErr = error.length > 80 ? error.slice(0, 80) + '...' : error;
    return {
      _idx: 0, name: student.studentName,
      courseName: '', lessonName: '',
      rate: null, totalAsk: 0, totalAns: 0,
      focusRating: null, focusAnswer: 0, overOther: '0%',
      masteryRating: '-', firstRate: null, guideRate: null,
      firstCorrectTotal: 0, guideCorrectTotal: 0, guideNumTotal: 0,
      exerRate: null, exerTotalRecorded: 0, exerCorrectCount: 0, exerWrongCount: 0,
      wrongNum: 0, questionNum: 0, wrongRate: 0,
      knowledgeCount: 0, completedKnowledge: 0, completionRate: 0,
      interactNum: 0,
      tag: 'muted', label: '❌获取失败', masteryLabel: '-', exerLabel: '-',
      quadrant: '-', overallTag: '❌获取失败', overallTagClass: 'danger',
      diagnosis: shortErr,
      knowledgeRows: [],
    };
  }

  // ===== 表格渲染 =====
  function renderTable(data) {
    const wrap = $('#lrpTableWrap');
    if (!data || data.length === 0) {
      wrap.innerHTML = '<div class="lrp-empty"><div class="lrp-empty-icon">📭</div><p>暂无数据</p></div>';
      return;
    }

    const cols = [
      { id:'_idx', label:'#', w:32 },
      { id:'name', label:'姓名', w:56 },
      { id:'overallTag', label:'标签', w:90, render:r => badge(r.overallTag,r.overallTagClass) },
      { id:'rate', label:'回答率%', w:62, num:true, render:r => pct(r.rate) },
      { id:'totalAsk', label:'提问数', w:52, num:true },
      { id:'totalAns', label:'回答数', w:52, num:true },
      { id:'masteryRating', label:'掌握度', w:48, render:r => `<b>${r.masteryRating}</b>` },
      { id:'firstRate', label:'首次答对率%', w:78, num:true, render:r => pct(r.firstRate) },
      { id:'exerRate', label:'练习正确率%', w:82, num:true, render:r => pct(r.exerRate) },
      { id:'wrongNum', label:'错题本', w:48, num:true },
      { id:'quadrant', label:'象限', w:40, render:r => `<b>${r.quadrant}</b>` },
      { id:'diagnosis', label:'诊断', w:200, align:'left' },
    ];

    let html = `<table class="lrp-table"><thead><tr>`;
    cols.forEach(c => html += `<th data-col="${c.id}" style="width:${c.w}px">${c.label}</th>`);
    html += '</tr></thead><tbody>';

    data.forEach(r => {
      const rowClass =
        r.tag === 'danger' || r.tag === 'critical' ? 'lrp-row-danger' :
        r.tag === 'warning' ? 'lrp-row-warning' :
        r.tag === 'success' ? 'lrp-row-success' : '';
      html += `<tr class="${rowClass}">`;
      cols.forEach(c => {
        const val = c.render ? c.render(r) : (r[c.id] != null ? r[c.id] : '-');
        const align = c.num ? 'text-align:right;' : (c.align||'');
        html += `<td style="${align}">${val}</td>`;
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;

    $$('.lrp-table th[data-col]').forEach(th => {
      th.onclick = () => sortBy(cols.find(c=>c.id===th.dataset.col));
    });

    updateStats(data);
    updateLessonFilter(data);
    $('#lrpFilterBar').style.display = '';
    $('#lrpStats').style.display = '';
  }

  function sortBy(col) {
    if (!col) return;
    if (sortCol === col.id) { sortAsc = !sortAsc; }
    else { sortCol = col.id; sortAsc = true; }
    filteredData.sort((a,b) => {
      let va = a[col.id], vb = b[col.id];
      if (va == null) va = -999; if (vb == null) vb = -999;
      if (typeof va === 'string') return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      return sortAsc ? va - vb : vb - va;
    });
    renderTable(filteredData);
  }

  function applyFilter() {
    const tagVal = $('#lrpFilterTag').value;
    const lessonVal = $('#lrpFilterLesson').value;
    filteredData = allData.filter(r => {
      if (tagVal === 'danger') { if (r.tag !== 'danger' && r.tag !== 'critical') return false; }
      else if (tagVal === 'warning') { if (r.tag !== 'warning' && r.overallTagClass !== 'warning') return false; }
      else if (tagVal === 'success') { if (r.tag !== 'success' && r.overallTagClass !== 'success') return false; }
      if (lessonVal && r.lessonName !== lessonVal) return false;
      return true;
    });
    renderTable(filteredData);
  }

  function updateStats(data) {
    if (!data.length) return;
    const valid = data.filter(r => r.rate != null);
    const avgRate = valid.length ? Math.round(valid.reduce((s,r)=>s+r.rate,0)/valid.length) : 0;
    const dangerCount = data.filter(r => r.tag==='danger'||r.tag==='critical').length;
    const successCount = data.filter(r => r.tag==='success').length;
    $('#lrpStats').innerHTML = `
      <span>总计: <strong>${data.length}</strong></span>
      <span>🚨敷衍: <strong>${dangerCount}</strong></span>
      <span>⭐优秀: <strong>${successCount}</strong></span>
      <span>平均回答率: <strong>${avgRate}%</strong></span>`;
  }

  function updateLessonFilter(data) {
    const sel = $('#lrpFilterLesson');
    const lessons = [...new Set(data.map(r => r.lessonName).filter(Boolean))];
    sel.innerHTML = '<option value="">全部课节</option>' +
      lessons.map(l => `<option value="${l}">${l.substring(0,20)}${l.length>20?'...':''}</option>`).join('');
  }

  // ===== Excel导出 =====
  async function exportExcel() {
    if (allData.length === 0) return;
    $('#lrpExportBtn').textContent = '⏳ 导出中...';
    try {
      const resp = await sendMessage({ type: 'EXPORT_EXCEL', data: allData });
      if (resp && resp.error) throw new Error(resp.error);
      // SW无法操作DOM，CSV字符串传回content.js用<a>下载
      if (resp && resp.csv) {
        const bom = '\uFEFF';
        const blob = new Blob([bom + resp.csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = resp.filename || `学习报告分析.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }
      $('#lrpExportBtn').textContent = '✅ 已导出';
      setTimeout(()=>$('#lrpExportBtn').textContent='⬇️ 下载CSV', 2000);
    } catch(e) {
      alert('导出失败: ' + e.message);
      $('#lrpExportBtn').textContent='⬇️ 下载CSV';
    }
  }

  // ===== 复制问题名单 =====
  function copyProblemList() {
    const problems = allData.filter(r =>
      r.tag === 'danger' || r.tag === 'critical' || r.overallTagClass === 'danger'
    );
    if (problems.length === 0) { alert('没有需要关注的学生！'); return; }

    let text = '问题学生名单\n' + '='.repeat(40)+'\n';
    text += '序号\t姓名\t回答率%\t掌握度\t诊断\n';
    text += '-'.repeat(40)+'\n';
    problems.forEach((r,i) => {
      text += `${i+1}\t${r.name}\t${r.rate!=null?r.rate:'-'}\t${r.masteryRating}\t${r.diagnosis}\n`;
    });

    navigator.clipboard.writeText(text).then(() => {
      $('#lrpCopyBtn').textContent = '✅ 已复制';
      setTimeout(()=>$('#lrpCopyBtn').textContent='📋 复制问题名单',2000);
    }).catch(() => alert('复制失败'));
  }

  // ===== 工具函数 =====
  function sendMessage(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, resp => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(resp);
      });
    });
  }

  function setStatus(color, text) {
    const dot = $('#lrpDot');
    dot.className = 'lrp-dot ' + color;
    $('#lrpStatusText').textContent = text;
  }

  function showProgress(show) { $('#lrpProgress').style.display = show ? '' : 'none'; }
  function showLog(show) {
    const area = $('#lrpLogArea');
    const btn = $('#lrpToggleLogBtn');
    area.style.display = show ? '' : 'none';
    if (btn) btn.style.display = show ? '' : 'none';
  }

  function setProgress(pct, info) {
    $('#lrpProgressFill').style.width = pct + '%';
    $('#lrpProgressFill').textContent = pct + '%';
    $('#lrpProgressInfo').textContent = info;
  }

  function log(type, msg) {
    const area = $('#lrpLogArea');
    if (!area) return;
    area.style.display = '';
    const entry = document.createElement('div');
    entry.className = `lrp-log-entry ${type}`;
    entry.style.cssText = type==='error' ? 'color:#f88;' : type==='warn' ? 'color:#ff0;' : type==='ok' ? 'color:#0f0;' : '';
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    area.appendChild(entry);
    area.scrollTop = area.scrollHeight;
  }

  function badge(text, cls) {
    return text ? `<span class="lrp-badge ${cls||''}">${text}</span>` : '-';
  }

  function pct(val) {
    if (val==null) return '-';
    const v = Number(val);
    return `<span class="${v<40?'pct-low':v<60?'pct-mid':'pct-high'}">${v}%</span>`;
  }

})();
