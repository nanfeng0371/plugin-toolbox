/**
 * 调课助手 v4.0 — Toolbox 模块化版本（content.js）
 * 合并自 popup.js（UI逻辑）+ content/content.js（API调用）
 * 改动：popup→Shadow DOM 模块；API调用直接在 content script 执行；xlsx 解析委托 background
 */
(function () {
  'use strict';

  console.log('[调课助手] 模块正在初始化...');

  // ===== 常量 =====
  let TASK_STATUS = { PENDING: 'pending', RUNNING: 'running', SUCCESS: 'success', FAIL: 'fail' };
  let STATUS_LABELS = {};
  STATUS_LABELS[TASK_STATUS.PENDING] = '⏳待执行';
  STATUS_LABELS[TASK_STATUS.RUNNING] = '🔄执行中';
  STATUS_LABELS[TASK_STATUS.SUCCESS] = '✅成功';
  STATUS_LABELS[TASK_STATUS.FAIL] = '❌失败';
  let STATUS_CSS = {};
  STATUS_CSS[TASK_STATUS.PENDING] = 'tk-status-pending';
  STATUS_CSS[TASK_STATUS.RUNNING] = 'tk-status-running';
  STATUS_CSS[TASK_STATUS.SUCCESS] = 'tk-status-success';
  STATUS_CSS[TASK_STATUS.FAIL] = 'tk-status-fail';

  let API_BASE = 'https://ai-genesis.yuaiweiwu.com/prod-api/student-center-ai';
  let HISTORY_KEY = 'tiaokeHistory';
  let MAX_HISTORY = 500;
  let CN_NUM_MAP = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10, '十一': 11, '十二': 12 };

  // ===== 全局状态 =====
  let taskList = [];
  let isRunning = false;
  let isPaused = false;
  let classListCache = null;
  let studentRoster = [];
  let historyRecords = [];
  let currentToken = '';
  let activeInnerTab = 'main';  // 默认显示 调课 页

  // ===== Shadow DOM =====
  let shadowRoot = window.__shadowRoots__ && window.__shadowRoots__.tiaoke;
  let _moduleRoot = null;

  if (shadowRoot) {
    renderModuleUI(shadowRoot);
  } else {
    console.warn('[调课助手] 未找到壳提供的 Shadow DOM 容器');
  }

  function $(sel) { return _moduleRoot ? _moduleRoot.querySelector(sel) : null; }

  /**
   * 包装 chrome.runtime.sendMessage 为 Promise（回调方式）
   * 避免 import() 加载的 ES Module 中 Promise 形式的 sendMessage 永远 pending 的问题
   */
  function sendMsg(msg) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.runtime.sendMessage(msg, function (resp) {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(resp);
          }
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  // ======================================================================
  // UI 渲染
  // ======================================================================

  function renderModuleUI(root) {
    // 清除壳的 loading 占位符（保留 <style> 标签）
    let toRemove = [];
    for (var i = 0; i < root.children.length; i++) {
      if (root.children[i].tagName !== 'STYLE') toRemove.push(root.children[i]);
    }
    toRemove.forEach(function (c) { root.removeChild(c); });

    let container = document.createElement('div');
    container.className = 'tk-module-root';
    container.innerHTML =
      // 内部 Tab 切换
      '<div class="tk-tab-bar">' +
      '  <button class="tk-tab-btn tk-tab-active" data-itab="main">📚 调课</button>' +
      '  <button class="tk-tab-btn" data-itab="token">🔑 Token</button>' +
      '  <button class="tk-tab-btn" data-itab="history">📜 历史</button>' +
      '</div>' +

      // === Token 面板 ===
      '<div class="tk-tab-panel" data-ipanel="token">' +
      '  <div class="tk-token-section">' +
      '    <label class="tk-section-label">🔑 调课后台 Token</label>' +
      '    <div id="tk-token-card" class="tk-token-card tk-token-card-checking">' +
      '      <div class="tk-token-card-icon">🔍</div>' +
      '      <div class="tk-token-card-text">正在检测 Token...</div>' +
      '    </div>' +
      '    <div id="tk-token-detail" class="tk-token-detail tk-hidden">' +
      '      <div class="tk-token-detail-row"><span class="tk-token-detail-label">Token</span><span id="tk-token-preview" class="tk-token-preview">-</span></div>' +
      '      <div class="tk-token-detail-row"><span class="tk-token-detail-label">有效期至</span><span id="tk-token-expire" class="tk-token-expire">-</span></div>' +
      '      <div class="tk-token-detail-row"><span class="tk-token-detail-label">用户</span><span id="tk-token-user" class="tk-token-user">-</span></div>' +
      '    </div>' +
      '    <div class="tk-token-actions">' +
      '      <button id="tk-btn-copy-token" class="tk-btn tk-btn-primary tk-btn-block" disabled>📋 复制 Token</button>' +
      '      <button id="tk-btn-refresh-token" class="tk-btn tk-btn-secondary tk-btn-block">🔄 刷新检测</button>' +
      '    </div>' +
      '    <div class="tk-token-help">' +
      '      <p><b>使用方法：</b></p>' +
      '      <ol><li>在电脑上登录 <b>调课后台</b>（ai-genesis）</li>' +
      '      <li>点击上方「复制 Token」按钮</li>' +
      '      <li>通过企微/微信发给自己</li>' +
      '      <li>手机上调课助手页面粘贴即可</li></ol>' +
      '      <p class="tk-token-help-note">Token 有效期 24 小时，每天复制一次即可</p>' +
      '    </div>' +
      '  </div>' +
      '</div>' +

      // === 调课主面板 ===
      '<div class="tk-tab-panel tk-tab-panel-active" data-ipanel="main">' +
      '  <!-- 连接状态 -->' +
      '  <div id="tk-conn-status" class="tk-status-bar tk-status-disconnected">' +
      '    <span class="tk-status-dot"></span><span class="tk-status-text">未连接</span>' +
      '  </div>' +
      '  <!-- 学员信息簿 -->' +
      '  <div class="tk-roster-section">' +
      '    <div class="tk-roster-header">' +
      '      <label class="tk-section-label">📋 学员信息簿</label>' +
      '      <span id="tk-roster-status" class="tk-roster-status tk-roster-empty">未加载</span>' +
      '    </div>' +
      '    <div class="tk-roster-actions">' +
      '      <input type="file" id="tk-roster-file" accept=".xlsx,.xls" class="tk-hidden">' +
      '      <button id="tk-btn-load-roster" class="tk-btn tk-btn-outline">选择Excel文件</button>' +
      '      <button id="tk-btn-clear-roster" class="tk-btn tk-btn-sm tk-btn-outline tk-hidden">清除</button>' +
      '    </div>' +
      '    <div class="tk-input-hint">格式：姓名 | 手机号 | 学员ID（Sheet1第一行为表头）</div>' +
      '  </div>' +
      '  <!-- 数据输入 -->' +
      '  <div class="tk-input-section">' +
      '    <label class="tk-section-label">粘贴调课数据</label>' +
      '    <textarea id="tk-input-data" class="tk-textarea" rows="6" placeholder="支持两种格式：&#10;&#10;格式1（结构化）：&#10;学员ID/姓名  第几讲  新日期  新时间&#10;320207  2  2026-06-01  14:00&#10;&#10;格式2（自然语言）：&#10;王一，第5讲，调到5月2日早上10点上课&#10;13400001234，第3讲，调到6月5号下午2点半"></textarea>' +
      '    <div class="tk-input-hint">结构化：ID/姓名 | 第几讲 | 日期 | 时间 &nbsp;|&nbsp; 自然语言：姓名/手机号，第X讲，调到X月X日X点</div>' +
      '    <div id="tk-parse-feedback" class="tk-parse-feedback tk-hidden"></div>' +
      '    <button id="tk-btn-parse" class="tk-btn tk-btn-primary">解析数据</button>' +
      '  </div>' +
      '  <!-- 预览表格 -->' +
      '  <div id="tk-preview-section" class="tk-preview-section tk-hidden">' +
      '    <label class="tk-section-label">数据预览</label>' +
      '    <div class="tk-table-wrapper">' +
      '      <table class="tk-preview-table"><thead><tr>' +
      '        <th class="tk-col-index">#</th><th class="tk-col-id">学员ID</th>' +
      '        <th class="tk-col-lesson">第几讲</th><th class="tk-col-date">新日期</th>' +
      '        <th class="tk-col-time">新时间</th><th class="tk-col-status">状态</th>' +
      '      </tr></thead><tbody id="tk-preview-tbody"></tbody></table>' +
      '    </div>' +
      '  </div>' +
      '  <!-- 执行控制 -->' +
      '  <div id="tk-control-section" class="tk-control-section tk-hidden">' +
      '    <div class="tk-control-buttons">' +
      '      <button id="tk-btn-start" class="tk-btn tk-btn-success">▶ 开始执行</button>' +
      '      <button id="tk-btn-pause" class="tk-btn tk-btn-warning" disabled>⏸ 暂停</button>' +
      '      <button id="tk-btn-retry" class="tk-btn tk-btn-info" disabled>🔄 重试失败</button>' +
      '    </div>' +
      '  </div>' +
      '  <!-- 进度与统计 -->' +
      '  <div id="tk-stats-section" class="tk-stats-section tk-hidden">' +
      '    <div class="tk-progress-bar-wrapper"><div id="tk-progress-bar" class="tk-progress-bar" style="width:0%"></div></div>' +
      '    <div class="tk-stats-row">' +
      '      <span class="tk-stat-item tk-stat-total">总计: <b id="tk-stat-total">0</b></span>' +
      '      <span class="tk-stat-item tk-stat-success">✅ 成功: <b id="tk-stat-success">0</b></span>' +
      '      <span class="tk-stat-item tk-stat-fail">❌ 失败: <b id="tk-stat-fail">0</b></span>' +
      '      <span class="tk-stat-item tk-stat-pending">⏳ 待执行: <b id="tk-stat-pending">0</b></span>' +
      '    </div>' +
      '  </div>' +
      '  <!-- 日志 -->' +
      '  <div id="tk-log-section" class="tk-log-section tk-hidden">' +
      '    <div class="tk-log-header">' +
      '      <label class="tk-section-label">执行日志</label>' +
      '      <button id="tk-btn-export" class="tk-btn tk-btn-sm tk-btn-outline">📥 导出结果</button>' +
      '    </div>' +
      '    <div id="tk-log-container" class="tk-log-container"></div>' +
      '  </div>' +
      '</div>' +

      // === 历史面板 ===
      '<div class="tk-tab-panel" data-ipanel="history">' +
      '  <div class="tk-history-header">' +
      '    <label class="tk-section-label">📜 历史调课记录</label>' +
      '    <button id="tk-btn-clear-history" class="tk-btn tk-btn-sm tk-btn-outline tk-btn-danger">🗑️ 清空历史</button>' +
      '  </div>' +
      '  <div id="tk-history-container" class="tk-history-container">' +
      '    <div class="tk-history-empty">暂无历史记录</div>' +
      '  </div>' +
      '</div>';

    root.appendChild(container);
    _moduleRoot = container;

    // 绑定事件
    bindEvents();

    // 初始化
    initModule();
  }

  // ======================================================================
  // 事件绑定
  // ======================================================================

  function bindEvents() {
    // 内部 Tab 切换
    _moduleRoot.querySelectorAll('.tk-tab-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { switchInnerTab(btn.dataset.itab); });
    });

    // Token
    $('#tk-btn-copy-token').addEventListener('click', copyToken);
    $('#tk-btn-refresh-token').addEventListener('click', refreshToken);

    // 学员信息簿
    $('#tk-btn-load-roster').addEventListener('click', function () { $('#tk-roster-file').click(); });
    $('#tk-roster-file').addEventListener('change', function (e) {
      let file = e.target.files[0];
      if (file) loadRosterFromFile(file);
      e.target.value = '';
    });
    $('#tk-btn-clear-roster').addEventListener('click', clearRoster);

    // 数据输入 Tab 键支持
    $('#tk-input-data').addEventListener('keydown', function (e) {
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        let ta = e.target;
        let start = ta.selectionStart, end = ta.selectionEnd;
        ta.value = ta.value.substring(0, start) + '\t' + ta.value.substring(end);
        ta.selectionStart = ta.selectionEnd = start + 1;
      }
    });

    // 解析
    $('#tk-btn-parse').addEventListener('click', parseAndPreview);

    // 执行控制
    $('#tk-btn-start').addEventListener('click', function () { if (!isRunning) executeTasks(); });
    $('#tk-btn-pause').addEventListener('click', function () {
      if (!isRunning) return;
      isPaused = !isPaused;
      addLog(isPaused ? '已暂停执行' : '继续执行', isPaused ? 'warn' : 'info');
      updateControlButtons();
    });
    $('#tk-btn-retry').addEventListener('click', function () { if (!isRunning) retryFailed(); });
    $('#tk-btn-export').addEventListener('click', exportResults);

    // 历史
    $('#tk-btn-clear-history').addEventListener('click', function () {
      if (confirm('确定清空所有历史调课记录？此操作不可恢复。')) clearHistory();
    });
  }

  // ======================================================================
  // 内部 Tab 切换
  // ======================================================================

  function switchInnerTab(tabName) {
    activeInnerTab = tabName;
    _moduleRoot.querySelectorAll('.tk-tab-btn').forEach(function (btn) {
      btn.classList.toggle('tk-tab-active', btn.dataset.itab === tabName);
    });
    _moduleRoot.querySelectorAll('.tk-tab-panel').forEach(function (panel) {
      panel.classList.toggle('tk-tab-panel-active', panel.dataset.ipanel === tabName);
    });
    if (tabName === 'token') refreshToken();
    if (tabName === 'history') renderHistory();
  }

  // ======================================================================
  // Token 功能（通过 background 代理 chrome.cookies）
  // ======================================================================

  async function refreshToken() {
    let card = $('#tk-token-card');
    card.className = 'tk-token-card tk-token-card-checking';
    card.innerHTML = '<div class="tk-token-card-icon">🔄</div><div class="tk-token-card-text">正在检测 Token...</div>';
    $('#tk-token-detail').classList.add('tk-hidden');
    $('#tk-btn-copy-token').disabled = true;

    try {
      let resp = await sendMsg({
        target: 'tiaoke', action: 'GET_COOKIE'
      });
      if (resp && resp.success && resp.data) {
        updateTokenUI(resp.data);
      } else {
        updateTokenUI({ token: '', found: false });
      }
    } catch (e) {
      console.error('[调课助手] 获取 Token 失败:', e);
      updateTokenUI({ token: '', found: false });
    }
  }

  function updateTokenUI(result) {
    let card = $('#tk-token-card');
    let detail = $('#tk-token-detail');

    if (result.found && result.token) {
      let payload = decodeJwtPayload(result.token);
      let now = Math.floor(Date.now() / 1000);
      let isExpired = false;
      let expireStr = '-';
      let remainingStr = '';

      if (payload && payload.exp) {
        let expDate = new Date(payload.exp * 1000);
        expireStr = expDate.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        isExpired = payload.exp < now;
        if (!isExpired) {
          let hours = Math.floor((payload.exp - now) / 3600);
          remainingStr = hours >= 1 ? '剩余 ' + hours + ' 小时' : '剩余 ' + Math.floor((payload.exp - now) / 60) + ' 分钟';
        }
      }

      if (isExpired) {
        currentToken = '';
        card.className = 'tk-token-card tk-token-card-expired';
        card.innerHTML = '<div class="tk-token-card-icon">⚠️</div><div class="tk-token-card-text">Token 已过期，请重新登录调课后台</div>';
        $('#tk-btn-copy-token').disabled = true;
        detail.classList.add('tk-hidden');
      } else {
        currentToken = result.token;
        card.className = 'tk-token-card tk-token-card-valid';
        card.innerHTML = '<div class="tk-token-card-icon">✅</div><div class="tk-token-card-text">Token 有效' + (remainingStr ? '（' + remainingStr + '）' : '') + '</div>';
        $('#tk-btn-copy-token').disabled = false;
        detail.classList.remove('tk-hidden');
        let ts = result.token.substring(0, 20);
        let te = result.token.substring(result.token.length - 10);
        $('#tk-token-preview').textContent = ts + '...' + te;
        $('#tk-token-expire').textContent = expireStr;
        $('#tk-token-user').textContent = payload && (payload.sub || payload.name || payload.preferred_username) || '-';
      }
    } else {
      currentToken = '';
      card.className = 'tk-token-card tk-token-card-empty';
      card.innerHTML = '<div class="tk-token-card-icon">❌</div><div class="tk-token-card-text">未检测到 Token，请先登录调课后台</div>';
      $('#tk-btn-copy-token').disabled = true;
      detail.classList.add('tk-hidden');
    }
  }

  function decodeJwtPayload(token) {
    try {
      let parts = token.split('.');
      if (parts.length !== 3) return null;
      let p = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (p.length % 4) p += '=';
      return JSON.parse(atob(p));
    } catch (e) { return null; }
  }

  async function copyToken() {
    if (!currentToken) return;
    try {
      await navigator.clipboard.writeText(currentToken);
      let btn = $('#tk-btn-copy-token');
      btn.textContent = '✅ 已复制！';
      btn.classList.add('tk-btn-copied');
      setTimeout(function () {
        btn.textContent = '📋 复制 Token';
        btn.classList.remove('tk-btn-copied');
      }, 2000);
    } catch (e) {
      addLog('Token 复制失败: ' + e.message, 'fail');
    }
  }

  // ======================================================================
  // 连接检测
  // ======================================================================

  function isOnTargetSite() {
    return window.location.hostname === 'ai-genesis.yuaiweiwu.com';
  }

  async function checkConnection() {
    let bar = $('#tk-conn-status');
    if (!isOnTargetSite()) {
      bar.className = 'tk-status-bar tk-status-disconnected';
      bar.querySelector('.tk-status-text').textContent = '请在 ai-genesis 页面使用';
      return false;
    }
    try {
      let data = await apiRequest(API_BASE + '/student/name/1');
      bar.className = 'tk-status-bar tk-status-connected';
      bar.querySelector('.tk-status-text').textContent = '已连接';
      return true;
    } catch (e) {
      bar.className = 'tk-status-bar tk-status-disconnected';
      bar.querySelector('.tk-status-text').textContent = '连接失败（请确认已登录 ai-genesis）';
      console.error('[调课助手] 连接检测失败:', e);
      return false;
    }
  }

  // ======================================================================
  // 学员信息簿
  // ======================================================================

  function updateRosterStatus() {
    let el = $('#tk-roster-status');
    let btn = $('#tk-btn-clear-roster');
    if (studentRoster.length > 0) {
      el.textContent = '已加载: ' + studentRoster.length + ' 名学员';
      el.className = 'tk-roster-status tk-roster-loaded';
      btn.classList.remove('tk-hidden');
    } else {
      el.textContent = '未加载';
      el.className = 'tk-roster-status tk-roster-empty';
      btn.classList.add('tk-hidden');
    }
  }

  async function loadRosterFromStorage() {
    try {
      let result = await chrome.storage.local.get('studentRoster');
      if (Array.isArray(result.studentRoster) && result.studentRoster.length > 0) {
        studentRoster = result.studentRoster;
        updateRosterStatus();
      }
    } catch (e) { /* 忽略 */ }
  }

  async function loadRosterFromFile(file) {
    let reader = new FileReader();
    reader.onload = async function (e) {
      try {
        let arrayBuffer = e.target.result;
        // ArrayBuffer 无法直接序列化传递，转为普通数组
        let uint8Array = Array.from(new Uint8Array(arrayBuffer));
        // 委托 background 解析 Excel
        let resp = await sendMsg({
          target: 'tiaoke',
          action: 'PARSE_ROSTER',
          data: { uint8Array: uint8Array }
        });
        if (resp && resp.success && resp.data) {
          let result = resp.data;
          if (result.error) {
            showParseFeedback(result.error, 'error');
            return;
          }
          studentRoster = result.roster;
          try { await chrome.storage.local.set({ studentRoster: studentRoster }); } catch (e) { /* 忽略 */ }
          updateRosterStatus();
          let msg = '学员信息簿加载成功，共 ' + studentRoster.length + ' 名学员';
          if (result.skipped > 0) msg += '（跳过 ' + result.skipped + ' 行无效数据）';
          showParseFeedback(msg, 'success');
          addLog(msg, 'success');
        } else {
          showParseFeedback('Excel解析失败', 'error');
        }
      } catch (err) {
        showParseFeedback('文件读取失败: ' + err.message, 'error');
      }
    };
    reader.readAsArrayBuffer(file);
  }

  async function clearRoster() {
    studentRoster = [];
    try { await chrome.storage.local.remove('studentRoster'); } catch (e) { /* 忽略 */ }
    updateRosterStatus();
    showParseFeedback('学员信息簿已清除', 'info');
  }

  // ======================================================================
  // 自然语言解析（从 popup.js 迁移）
  // ======================================================================

  function parseNaturalTime(text) {
    let stdTime = text.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (stdTime) return String(stdTime[1]).padStart(2, '0') + ':' + String(stdTime[2]).padStart(2, '0');
    // 支持点号时间：19.01 / 9.30
    let dotTime = text.match(/(\d{1,2})\.(\d{2})(?!\d)/);
    if (dotTime) return String(dotTime[1]).padStart(2, '0') + ':' + dotTime[2];
    let pointMatch = text.match(/(\d{1,2})点半/);
    if (pointMatch) return String(parseInt(pointMatch[1], 10)).padStart(2, '0') + ':30';
    let hourMatch = text.match(/(\d{1,2})点/);
    if (hourMatch) {
      let h = parseInt(hourMatch[1], 10);
      if (/下午|晚上|午后|晚间/.test(text)) { if (h < 12) h += 12; }
      else if (/凌晨|半夜/.test(text)) { if (h === 12) h = 0; else if (h > 12) h -= 12; }
      return String(h).padStart(2, '0') + ':00';
    }
    return null;
  }

  // ===== 相对日期计算 =====
  function resolveRelativeDate(text) {
    let now = new Date();
    let today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let str = text.trim();
    if (str === '今天' || str === '今日') return formatDate(today);
    if (str === '明天' || str === '明日') return formatDate(new Date(today.getTime() + 86400000));
    if (str === '后天') return formatDate(new Date(today.getTime() + 86400000 * 2));
    if (str === '大后天' || str === '大后天后') return formatDate(new Date(today.getTime() + 86400000 * 3));
    if (str === '昨天' || str === '昨日') return formatDate(new Date(today.getTime() - 86400000));
    // 星期：周一~周日 / 星期一~星期日
    let weekMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };
    let weekMatch = str.match(/(?:下|这)?(?:周|星期)([一二三四五六日天])/);
    if (weekMatch) {
      let targetDay = weekMap[weekMatch[1]];
      if (targetDay === undefined) return null;
      let isNext = str.indexOf('下') === 0;
      let currentDay = today.getDay();
      let diff = targetDay - currentDay;
      if (diff <= 0 || isNext) diff += 7;
      if (isNext && diff <= 7) diff += 7; // "下周X" 跳过本周
      return formatDate(new Date(today.getTime() + diff * 86400000));
    }
    return null;
  }

  function formatDate(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function extractDateFromText(text) {
    // 先尝试相对日期
    let relMatch = text.match(/(今天|今日|明天|明日|后天|大后天|昨天|昨日|(?:下|这)?(?:周|星期)[一二三四五六日天])/);
    if (relMatch) {
      let rd = resolveRelativeDate(relMatch[1]);
      if (rd) return rd;
    }
    let afterKeyword = text.match(/(?:调到|改到|约到|移到|调至|改至)\s*(.+)/);
    let segment = afterKeyword ? afterKeyword[1] : text;
    let mdCN = segment.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
    if (mdCN) return mdCN[1] + '月' + mdCN[2] + '号';
    let mdCNShort = segment.match(/(\d{1,2})\s*月\s*(\d{1,2})(?![日号])/);
    if (mdCNShort) return mdCNShort[1] + '月' + mdCNShort[2] + '号';
    let ymd = segment.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (ymd) return ymd[0];
    let mdDash = segment.match(/(\d{1,2})-(\d{1,2})/);
    if (mdDash) return mdDash[0];
    let mdSlash = segment.match(/(\d{1,2})\/(\d{1,2})/);
    if (mdSlash) return mdSlash[0];
    return null;
  }

  function normalizeDate(raw) {
    let str = raw.trim();
    // 先尝试相对日期
    let rd = resolveRelativeDate(str);
    if (rd) return rd;
    let cy = new Date().getFullYear();
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(str)) {
      let p = str.split('-');
      return p[0] + '-' + String(p[1]).padStart(2, '0') + '-' + String(p[2]).padStart(2, '0');
    }
    let mdDash = str.match(/^(\d{1,2})-(\d{1,2})$/);
    if (mdDash) return cy + '-' + String(mdDash[1]).padStart(2, '0') + '-' + String(mdDash[2]).padStart(2, '0');
    let mdSlash = str.match(/^(\d{1,2})\/(\d{1,2})$/);
    if (mdSlash) return cy + '-' + String(mdSlash[1]).padStart(2, '0') + '-' + String(mdSlash[2]).padStart(2, '0');
    let mdCN = str.match(/^(\d{1,2})月(\d{1,2})[日号]?$/);
    if (mdCN) return cy + '-' + String(mdCN[1]).padStart(2, '0') + '-' + String(mdCN[2]).padStart(2, '0');
    return null;
  }

  function normalizeTime(raw) {
    let str = raw.trim();
    if (/^\d{2}:\d{2}$/.test(str)) return str;
    let hm = str.match(/^(\d{1,2}):(\d{2})$/);
    if (hm) return String(hm[1]).padStart(2, '0') + ':' + hm[2];
    // 支持 19.01 / 9.30 等点号代替冒号的写法
    let hmDot = str.match(/^(\d{1,2})\.(\d{2})$/);
    if (hmDot) return String(hmDot[1]).padStart(2, '0') + ':' + hmDot[2];
    // 支持中文时间
    return parseNaturalTime(str);
  }

  // ===== 智能字段分类器 =====
  function classifyField(s) {
    let str = s.trim();
    if (!str) return null;
    // 手机号：1开头11位
    if (/^1[3-9]\d{9}$/.test(str)) return { type: 'phone', value: str };
    // 纯数字5位及以上 → userId
    if (/^\d{5,}$/.test(str)) return { type: 'userId', value: str };
    // "第N讲" / "第N" / "第N课" → periodSort
    let lessonMatch = str.match(/^第\s*(\d+)\s*(?:讲|课|次)?$/);
    if (lessonMatch) return { type: 'periodSort', value: parseInt(lessonMatch[1], 10) };
    // "N讲" / "N课" / "第二讲"
    let lessonMatch2 = str.match(/^(\d+)\s*(?:讲|课|次)$/);
    if (lessonMatch2) return { type: 'periodSort', value: parseInt(lessonMatch2[1], 10) };
    // 中文数字讲次：第一讲 ~ 第十讲
    let cnLesson = str.match(/^第([一二三四五六七八九十]+)\s*(?:讲|课|次)?$/);
    if (cnLesson && CN_NUM_MAP[cnLesson[1]]) return { type: 'periodSort', value: CN_NUM_MAP[cnLesson[1]] };
    // 纯数字3-4位 → userId（短ID兜底）
    if (/^\d{3,4}$/.test(str)) return { type: 'userId', value: str };
    // 纯数字1-2位 → periodSort
    if (/^\d{1,2}$/.test(str)) {
      let n = parseInt(str, 10);
      if (n >= 1 && n <= 30) return { type: 'periodSort', value: n };
    }
    // 相对日期关键词
    if (/^(今天|今日|明天|明日|后天|大后天|昨天|昨日|(?:下|这)?(?:周|星期)[一二三四五六日天])$/.test(str)) {
      return { type: 'date', value: str };
    }
    // 日期格式：6月3日 / 6-3 / 6/3 / 2026-06-03
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(str) || /^\d{1,2}[\/\-]\d{1,2}$/.test(str) || /^\d{1,2}月\d{1,2}[日号]?$/.test(str)) {
      return { type: 'date', value: str };
    }
    // 时间格式：19:00 / 19.01 / 19点 / 下午3点
    if (/^\d{1,2}:\d{2}$/.test(str) || /^\d{1,2}\.\d{2}$/.test(str) ||
        /^\d{1,2}点半?$/.test(str) || /^(上午|下午|晚上|凌晨|中午)?\d{1,2}点?$/.test(str)) {
      return { type: 'time', value: str };
    }
    // 日期时间合并：6月3日19.01 / 6月3日19:00 / 6月3日19点
    let dtMerged = str.match(/^(.*?[日号])\s*(\d{1,2}[.:]\d{2})$/) ||
                   str.match(/^(.*?[日号])\s*(\d{1,2}点.*)$/) ||
                   str.match(/^(\d{1,2}[月\/\-]\d{1,2}[日号]?)\s+(\d{1,2}[.:]\d{2})$/) ||
                   str.match(/^(\d{1,2}[月\/\-]\d{1,2}[日号]?)\s+(\d{1,2}:\d{2})$/);
    if (dtMerged) {
      return { type: 'dateTime', datePart: dtMerged[1].trim(), timePart: dtMerged[2].trim() };
    }
    // 2-4个中文字 → 姓名
    if (/^[\u4e00-\u9fa5]{2,4}$/.test(str)) return { type: 'name', value: str };
    return null;
  }

  function parseNaturalLanguage(text) {
    let periodSort = null;
    // 匹配讲次：第2讲 / 第2 / 2讲 / 第二讲
    let lessonMatch = text.match(/第\s*(\d+)\s*(?:讲|课|次)?/) || text.match(/(\d+)\s*(?:讲|课|次)/);
    if (lessonMatch) {
      periodSort = parseInt(lessonMatch[1], 10);
    } else {
      // 中文数字讲次
      let cnLesson = text.match(/第([一二三四五六七八九十]+)\s*(?:讲|课|次)?/);
      if (cnLesson && CN_NUM_MAP[cnLesson[1]]) periodSort = CN_NUM_MAP[cnLesson[1]];
    }
    if (!periodSort || periodSort < 1) return null;
    let phoneMatch = text.match(/1[3-9]\d{9}/);
    let rawPhone = phoneMatch ? phoneMatch[0] : '';
    // 提取ID：行首或独立存在的5位以上纯数字
    let idMatch = text.match(/(?:^|[,，\s])(\d{5,})(?:[,，\s第\d]|$)/) || text.match(/^(\d{5,})/);
    let rawId = idMatch ? idMatch[1] || idMatch[0] : '';
    // 提取姓名：去掉讲次/日期/时间/关键词后，剩余中文字
    let cleaned = text.replace(/第\s*\d+\s*(?:讲|课|次)?/, '').replace(/第[一二三四五六七八九十]+\s*(?:讲|课|次)?/, '')
      .replace(/\d+\s*(?:讲|课|次)/, '')
      .replace(/调到|改到|约到|移到|调至|改至|上课|下课/g, '')
      .replace(/\d{1,2}\s*月\s*\d{1,2}\s*[日号]?/g, '').replace(/\d{1,2}[点时]/g, '')
      .replace(/\d{1,2}点半/g, '').replace(/\d{1,2}:\d{2}/g, '').replace(/\d{1,2}\.\d{2}/g, '')
      .replace(/今天|明天|后天|大后天|昨天/g, '').replace(/(?:下|这)?(?:周|星期)[一二三四五六日天]/g, '')
      .replace(/早上|上午|下午|晚上|凌晨|中午|午后|晚间/g, '').replace(/[,，、\s\d]/g, '');
    let nameMatch = cleaned.match(/[\u4e00-\u9fa5]{2,4}/);
    let rawName = nameMatch ? nameMatch[0] : '';
    if (!rawName && !rawPhone && !rawId) return null;
    let dateStr = extractDateFromText(text);
    if (!dateStr) return null;
    let newDate = normalizeDate(dateStr);
    if (!newDate) return null;
    let newTime = parseNaturalTime(text);
    if (!newTime) return null;
    // rawName 优先用中文名，如果有纯数字ID则放到 rawId 里
    return { rawName: rawName, rawPhone: rawPhone, rawId: rawId, periodSort: periodSort, newDate: newDate, newTime: newTime };
  }

  // ===== 学员匹配 =====
  function matchStudent(rawName, rawPhone) {
    if (studentRoster.length === 0) return null;
    if (rawPhone) {
      let phoneMatch = studentRoster.filter(function (s) { return s.phone === rawPhone; });
      if (phoneMatch.length === 1) return { studentId: phoneMatch[0].studentId, matchedName: phoneMatch[0].name };
      if (phoneMatch.length > 1 && rawName) {
        let np = phoneMatch.filter(function (s) { return s.name === rawName; });
        if (np.length === 1) return { studentId: np[0].studentId, matchedName: np[0].name };
      }
    }
    if (rawName) {
      let nameMatches = studentRoster.filter(function (s) { return s.name === rawName; });
      if (nameMatches.length === 1) return { studentId: nameMatches[0].studentId, matchedName: nameMatches[0].name };
      if (nameMatches.length > 1 && rawPhone) {
        let np2 = nameMatches.filter(function (s) { return s.phone === rawPhone; });
        if (np2.length === 1) return { studentId: np2[0].studentId, matchedName: np2[0].name };
        if (np2.length === 0) return { error: '姓名"' + rawName + '"有 ' + nameMatches.length + ' 个匹配，但手机号不匹配' };
      }
      if (nameMatches.length > 1) return { error: '姓名"' + rawName + '"有 ' + nameMatches.length + ' 个匹配，请附加手机号' };
      let fuzzy = studentRoster.filter(function (s) { return s.name.includes(rawName) || rawName.includes(s.name); });
      if (fuzzy.length === 1) return { studentId: fuzzy[0].studentId, matchedName: fuzzy[0].name };
      if (fuzzy.length > 1) return { error: '姓名"' + rawName + '"模糊匹配到多个学员' };
    }
    return { error: '未找到学员"' + (rawName || rawPhone) + '"' };
  }

  // ===== 解析输入数据（智能字段识别） =====
  function parseInputData(text) {
    let lines = text.trim().split('\n');
    let tasks = [];
    for (var i = 0; i < lines.length; i++) {
      let line = lines[i].trim();
      if (!line) continue;
      // 跳过表头行
      if (/学员|第几讲|日期|时间|姓名|手机|ID/i.test(line) && /[,，\t\s]/.test(line) && line.length < 30) continue;
      let task = parseOneLine(line, i);
      if (!task) { addLog('第' + (i + 1) + '行无法解析: ' + line.substring(0, 60), 'warn'); continue; }
      tasks.push({ index: tasks.length + 1, userId: task.userId, periodSort: task.periodSort, newDate: task.newDate, newTime: task.newTime, matchedName: task.matchedName || '', status: TASK_STATUS.PENDING, error: '', detail: null });
    }
    return tasks;
  }

  function parseOneLine(line, lineIdx) {
    // 1. 先尝试自然语言（含"调到/改到"等关键词，或含讲次+日期的混合句式）
    if (/调到|改到|约到|移到|调至|改至/.test(line) || /第?\d+\s*(?:讲|课|次)/.test(line) || /\d+\s*(?:讲|课|次)/.test(line)) {
      let nl = parseNaturalLanguage(line);
      if (nl) {
        // rawId（纯数字ID，如741191）优先
        if (nl.rawId) {
          return { userId: nl.rawId, periodSort: nl.periodSort, newDate: nl.newDate, newTime: nl.newTime };
        }
        // 手机号匹配
        if (nl.rawPhone && /^1[3-9]\d{9}$/.test(nl.rawPhone) && studentRoster.length > 0) {
          let m = matchStudent(nl.rawName, nl.rawPhone);
          if (m && m.studentId) return { userId: m.studentId, periodSort: nl.periodSort, newDate: nl.newDate, newTime: nl.newTime, matchedName: m.matchedName };
        }
        // 中文名当ID（纯数字的情况已在 rawId 处理）
        if (nl.rawName && /^\d{5,}$/.test(nl.rawName)) {
          return { userId: nl.rawName, periodSort: nl.periodSort, newDate: nl.newDate, newTime: nl.newTime };
        }
        if (nl.rawName && studentRoster.length > 0) {
          let m2 = matchStudent(nl.rawName, nl.rawPhone);
          if (m2 && m2.studentId) return { userId: m2.studentId, periodSort: nl.periodSort, newDate: nl.newDate, newTime: nl.newTime, matchedName: m2.matchedName };
          return null;
        }
      }
    }

    // 2. 结构化解析：按分隔符拆分，用 classifyField 智能识别
    let fields = splitLine(line);
    let result = classifyAndAssemble(fields, lineIdx);
    if (result) return result;

    // 3. 兜底：再试自然语言
    let nl2 = parseNaturalLanguage(line);
    if (nl2) {
      if (nl2.rawId) {
        return { userId: nl2.rawId, periodSort: nl2.periodSort, newDate: nl2.newDate, newTime: nl2.newTime };
      }
      if (nl2.rawName && /^\d{5,}$/.test(nl2.rawName)) {
        return { userId: nl2.rawName, periodSort: nl2.periodSort, newDate: nl2.newDate, newTime: nl2.newTime };
      }
      if (nl2.rawName && studentRoster.length > 0) {
        let m3 = matchStudent(nl2.rawName, nl2.rawPhone);
        if (m3 && m3.studentId) return { userId: m3.studentId, periodSort: nl2.periodSort, newDate: nl2.newDate, newTime: nl2.newTime, matchedName: m3.matchedName };
      }
    }

    return null;
  }

  // 按多种分隔符拆分，取字段最多的结果
  function splitLine(line) {
    let candidates = [];
    // Tab 分隔
    let byTab = line.split('\t').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
    if (byTab.length > 1) candidates.push(byTab);
    // 空格分隔（清理末尾逗号）
    let bySpace = line.split(/[\s\u3000]+/).map(function (s) { return s.replace(/[,，;；]$/, '').trim(); }).filter(function (s) { return s; });
    if (bySpace.length > 1) candidates.push(bySpace);
    // 逗号分隔
    let byComma = line.split(/[,，;；]/).map(function (s) { return s.trim(); }).filter(function (s) { return s; });
    if (byComma.length > 1) candidates.push(byComma);

    if (candidates.length === 0) return [line];
    // 选字段最多的方案
    candidates.sort(function (a, b) { return b.length - a.length; });
    return candidates[0];
  }

  // 智能分类并组装结果
  function classifyAndAssemble(fields, lineIdx) {
    let userId = '';
    let periodSort = null;
    let dateVal = '';
    let timeVal = '';
    let nameVal = '';
    let phoneVal = '';

    for (var fi = 0; fi < fields.length; fi++) {
      let cls = classifyField(fields[fi]);
      if (!cls) continue;
      if (cls.type === 'userId' && !userId) userId = cls.value;
      else if (cls.type === 'periodSort' && periodSort === null) periodSort = cls.value;
      else if (cls.type === 'date' && !dateVal) dateVal = cls.value;
      else if (cls.type === 'time' && !timeVal) timeVal = cls.value;
      else if (cls.type === 'dateTime') {
        if (!dateVal) dateVal = cls.datePart;
        if (!timeVal) timeVal = cls.timePart;
      }
      else if (cls.type === 'name' && !nameVal) nameVal = cls.value;
      else if (cls.type === 'phone' && !phoneVal) phoneVal = cls.value;
    }

    // 如果有 userId 直接用；否则尝试姓名匹配信息簿
    if (!userId && nameVal && studentRoster.length > 0) {
      let m = matchStudent(nameVal, phoneVal);
      if (m && m.studentId) { userId = m.studentId; }
      else if (m && m.error) return null;
    }
    if (!userId && phoneVal && studentRoster.length > 0) {
      let m2 = matchStudent(nameVal, phoneVal);
      if (m2 && m2.studentId) { userId = m2.studentId; }
    }
    // 没有 userId 也没有姓名，检查是否有纯数字5位以上的字段没被识别
    if (!userId) {
      for (var fi2 = 0; fi2 < fields.length; fi2++) {
        if (/^\d{5,}$/.test(fields[fi2].trim())) { userId = fields[fi2].trim(); break; }
      }
    }

    // 归一化日期和时间
    let newDate = dateVal ? normalizeDate(dateVal) : null;
    let newTime = timeVal ? normalizeTime(timeVal) : null;

    if (userId && periodSort !== null && newDate && newTime) {
      return { userId: userId, periodSort: periodSort, newDate: newDate, newTime: newTime };
    }
    return null;
  }

  function parseAndPreview() {
    let text = $('#tk-input-data').value.trim();
    if (!text) { showParseFeedback('请先粘贴调课数据', 'error'); return; }
    isRunning = false; isPaused = false; classListCache = null;
    $('#tk-log-container').innerHTML = '';
    hideParseFeedback();
    $('#tk-log-section').classList.remove('tk-hidden');
    taskList = parseInputData(text);
    if (taskList.length === 0) {
      showParseFeedback('未解析到有效数据，请检查格式', 'error');
      addLog('未解析到有效数据', 'fail');
      return;
    }
    showParseFeedback('成功解析 ' + taskList.length + ' 条调课数据', 'success');
    addLog('成功解析 ' + taskList.length + ' 条调课数据', 'success');
    renderPreviewTable();
    updateStats();
    $('#tk-preview-section').classList.remove('tk-hidden');
    $('#tk-control-section').classList.remove('tk-hidden');
    $('#tk-stats-section').classList.remove('tk-hidden');
    updateControlButtons();
  }

  // ======================================================================
  // UI 更新函数
  // ======================================================================

  function renderPreviewTable() {
    let tbody = $('#tk-preview-tbody');
    tbody.innerHTML = '';
    taskList.forEach(function (task) {
      let tr = document.createElement('tr');
      tr.id = 'tk-task-row-' + task.index;
      let displayId = task.matchedName ? task.userId + ' (' + task.matchedName + ')' : task.userId;
      tr.innerHTML =
        '<td>' + task.index + '</td>' +
        '<td>' + displayId + '</td>' +
        '<td>' + task.periodSort + '</td>' +
        '<td>' + task.newDate + '</td>' +
        '<td>' + task.newTime + '</td>' +
        '<td class="' + (STATUS_CSS[task.status] || '') + '">' + (STATUS_LABELS[task.status] || '') + '</td>';
      tbody.appendChild(tr);
    });
  }

  function updateRowStatus(index) {
    let task = taskList.find(function (t) { return t.index === index; });
    if (!task) return;
    let row = $('#tk-task-row-' + index);
    if (!row) return;
    let cell = row.querySelector('td:last-child');
    cell.className = STATUS_CSS[task.status] || '';
    cell.textContent = STATUS_LABELS[task.status] || '';
  }

  function updateStats() {
    let total = taskList.length;
    let success = taskList.filter(function (t) { return t.status === TASK_STATUS.SUCCESS; }).length;
    let fail = taskList.filter(function (t) { return t.status === TASK_STATUS.FAIL; }).length;
    let pending = taskList.filter(function (t) { return t.status === TASK_STATUS.PENDING || t.status === TASK_STATUS.RUNNING; }).length;
    $('#tk-stat-total').textContent = total;
    $('#tk-stat-success').textContent = success;
    $('#tk-stat-fail').textContent = fail;
    $('#tk-stat-pending').textContent = pending;
    let pct = total > 0 ? Math.round(((success + fail) / total) * 100) : 0;
    $('#tk-progress-bar').style.width = pct + '%';
  }

  function updateControlButtons() {
    let btnStart = $('#tk-btn-start');
    let btnPause = $('#tk-btn-pause');
    let btnRetry = $('#tk-btn-retry');
    if (isRunning && !isPaused) {
      btnStart.disabled = true; btnStart.textContent = '▶ 执行中...';
      btnPause.disabled = false; btnPause.textContent = '⏸ 暂停';
      btnRetry.disabled = true;
    } else if (isRunning && isPaused) {
      btnStart.disabled = true; btnStart.textContent = '▶ 执行中...';
      btnPause.disabled = false; btnPause.textContent = '▶ 继续';
      btnRetry.disabled = true;
    } else {
      let hasPending = taskList.some(function (t) { return t.status === TASK_STATUS.PENDING; });
      let hasFailed = taskList.some(function (t) { return t.status === TASK_STATUS.FAIL; });
      btnStart.disabled = !hasPending; btnStart.textContent = '▶ 开始执行';
      btnPause.disabled = true; btnPause.textContent = '⏸ 暂停';
      btnRetry.disabled = !hasFailed;
    }
  }

  // ======================================================================
  // 日志
  // ======================================================================

  function getNowTimeStr() {
    let now = new Date();
    return String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + ':' + String(now.getSeconds()).padStart(2, '0');
  }

  function addLog(text, type) {
    let entry = document.createElement('div');
    entry.className = 'tk-log-entry';
    entry.innerHTML = '<span class="tk-log-time">' + getNowTimeStr() + '</span><span class="tk-log-' + (type || 'info') + '">' + text + '</span>';
    let container = $('#tk-log-container');
    container.appendChild(entry);
    container.scrollTop = container.scrollHeight;
  }

  function showParseFeedback(message, type) {
    let el = $('#tk-parse-feedback');
    el.textContent = message;
    el.className = 'tk-parse-feedback tk-feedback-' + type;
    el.classList.remove('tk-hidden');
  }

  function hideParseFeedback() {
    $('#tk-parse-feedback').classList.add('tk-hidden');
  }

  // ======================================================================
  // API 调用（从原 content.js 迁移，直接在 content script 中执行）
  // ======================================================================

  async function apiRequest(url, options) {
    let defaults = { method: 'GET', headers: { 'Content-Type': 'application/json;charset=UTF-8' }, credentials: 'include' };
    let merged = Object.assign({}, defaults, options || {});
    let response = await fetch(url, merged);
    if (!response.ok) throw new Error('HTTP错误: ' + response.status + ' ' + response.statusText);
    return await response.json();
  }

  async function fetchClassList(startDate, endDate) {
    let url = API_BASE + '/regularCourse/next/class/list?classStatus=0&startDate=' + encodeURIComponent(startDate) + '&endDate=' + encodeURIComponent(endDate);
    let result = await apiRequest(url);
    if (result.code === '000000') {
      let data = result.data || result.rows || result.list || result.records || [];
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        let fields = ['classList', 'rows', 'list', 'records', 'data', 'items', 'content'];
        for (var fi = 0; fi < fields.length; fi++) {
          if (Array.isArray(data[fields[fi]])) { data = data[fields[fi]]; break; }
        }
      }
      return Array.isArray(data) ? data : [];
    }
    throw new Error(result.mesg || '查询课表列表失败');
  }

  function calculateTimeRange(dateStr, timeStr) {
    let classTimeStart = dateStr + ' ' + timeStr + ':00';
    let startDate = new Date(dateStr + 'T' + timeStr + ':00');
    let endDate = new Date(startDate.getTime() + 2 * 60 * 60 * 1000);
    let classTimeEnd = dateStr + ' ' + String(endDate.getHours()).padStart(2, '0') + ':' + String(endDate.getMinutes()).padStart(2, '0') + ':' + String(endDate.getSeconds()).padStart(2, '0');
    return { classTimeStart: classTimeStart, classTimeEnd: classTimeEnd };
  }

  function extractPeriodSort(item) {
    if (item.aiClassHourSort && Number(item.aiClassHourSort) > 0) return Number(item.aiClassHourSort);
    if (item.periodSort && Number(item.periodSort) > 0) return Number(item.periodSort);
    let name = item.lessonName || item.periodName || '';
    let match = name.match(/第(\d+)讲/);
    return match ? parseInt(match[1], 10) : 0;
  }

  function matchTargetClass(classList, userId, periodSort) {
    return classList.find(function (item) {
      let itemUserId = String(item.studentId || item.userId || '');
      let itemPS = extractPeriodSort(item);
      return itemUserId === String(userId) && itemPS === Number(periodSort);
    }) || null;
  }

  async function executeSingleTask(task) {
    try {
      if (!classListCache || !Array.isArray(classListCache) || classListCache.length === 0) {
        let dateRange = getDateRangeStrings();
        classListCache = await fetchClassList(dateRange.startDate, dateRange.endDate);
        try { await chrome.storage.local.set({ classListCache: classListCache }); } catch (e) { /* 忽略 */ }
      }
      if (!Array.isArray(classListCache) || classListCache.length === 0) {
        return { success: false, error: '课表数据为空' };
      }
      let targetClass = matchTargetClass(classListCache, task.userId, task.periodSort);
      if (!targetClass) return { success: false, error: '未找到学员' + task.userId + '第' + task.periodSort + '讲的课程数据' };

      let courseId = String(targetClass.courseId || '');
      let aiCourseId = String(targetClass.aiCourseId || '');
      let aiClassHourId = String(targetClass.aiClassHourId || '');
      let periodId = String(targetClass.periodId || targetClass.aiPeriodId || '');
      let userClassTimeId = String(targetClass.bookingId || targetClass.id || targetClass.userClassTimeId || '');
      let times = calculateTimeRange(task.newDate, task.newTime);

      let body = { type: 2, userId: String(task.userId), courseId: courseId, aiCourseId: aiCourseId, aiClassHourId: aiClassHourId, periodId: periodId, userClassTimes: [{ classTimeStart: times.classTimeStart, classTimeEnd: times.classTimeEnd, aiClassHourSort: 1, id: userClassTimeId }] };
      let result = await apiRequest(API_BASE + '/ai/user/course/classhour', { method: 'POST', body: JSON.stringify(body) });
      if (result.code === '000000') {
        return { success: true, message: result.mesg || '处理成功', detail: { studentName: targetClass.studentName || task.userId, courseName: targetClass.courseName || '', lessonName: targetClass.lessonName || '', newTime: times.classTimeStart + ' ~ ' + times.classTimeEnd } };
      }
      throw new Error(result.mesg || '改约提交失败');
    } catch (error) {
      return { success: false, error: error.message || '未知错误' };
    }
  }

  function getDateRangeStrings() {
    let now = new Date();
    let ago = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    let later = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
    let fmt = function (d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' 00:00:00'; };
    return { startDate: fmt(ago), endDate: fmt(later) };
  }

  // ======================================================================
  // 任务执行引擎
  // ======================================================================

  function delay(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  async function executeTasks() {
    isRunning = true; isPaused = false;
    updateControlButtons();

    try {
    // 获取课表数据
    if (!classListCache || !Array.isArray(classListCache) || classListCache.length === 0) {
      addLog('正在获取课表数据...', 'info');
      try {
        let dateRange = getDateRangeStrings();
        classListCache = await fetchClassList(dateRange.startDate, dateRange.endDate);
        if (Array.isArray(classListCache) && classListCache.length > 0) {
          addLog('课表数据获取成功，共 ' + classListCache.length + ' 条记录', 'success');
          try { await chrome.storage.local.set({ classListCache: classListCache }); } catch (e) { /* 忽略 */ }
        } else {
          addLog('课表数据为空或格式异常', 'fail');
          isRunning = false; updateControlButtons(); return;
        }
      } catch (err) {
        addLog('课表数据获取异常: ' + err.message, 'fail');
        isRunning = false; updateControlButtons(); return;
      }
    } else {
      addLog('使用缓存课表数据，共 ' + classListCache.length + ' 条记录', 'info');
    }

    // 并发执行
    let CONCURRENCY = 3;
    let INTERVAL = 500;
    let pendingTasks = taskList.filter(function (t) { return t.status === TASK_STATUS.PENDING; });

    while (pendingTasks.length > 0) {
      while (isPaused) { await delay(300); }
      if (!isRunning) break;
      let batch = pendingTasks.splice(0, CONCURRENCY);
      let promises = batch.map(async function (task, batchIdx) {
        if (batchIdx > 0) await delay(batchIdx * INTERVAL);
        while (isPaused) { await delay(300); }
        if (!isRunning) return;
        task.status = TASK_STATUS.RUNNING;
        updateRowStatus(task.index);
        updateStats();
        let displayName = task.matchedName ? task.matchedName + '(' + task.userId + ')' : task.userId;
        addLog('开始执行 #' + task.index + ': 学员' + displayName + ' 第' + task.periodSort + '讲 → ' + task.newDate + ' ' + task.newTime, 'info');
        try {
          let result = await executeSingleTask(task);
          if (result.success) {
            task.status = TASK_STATUS.SUCCESS;
            task.detail = result.detail || null;
            let detailInfo = task.detail ? ' (' + (task.detail.studentName || '') + ' ' + (task.detail.courseName || '') + ')' : '';
            addLog('#' + task.index + ' 执行成功' + detailInfo, 'success');
            addHistoryRecord(task, true, '');
          } else {
            task.status = TASK_STATUS.FAIL;
            task.error = result.error || '未知错误';
            addLog('#' + task.index + ' 执行失败: ' + task.error, 'fail');
            addHistoryRecord(task, false, task.error);
          }
        } catch (err) {
          task.status = TASK_STATUS.FAIL;
          task.error = err.message || '请求异常';
          addLog('#' + task.index + ' 请求异常: ' + task.error, 'fail');
          addHistoryRecord(task, false, task.error);
        }
        updateRowStatus(task.index);
        updateStats();
      });
      await Promise.all(promises);
      if (pendingTasks.length > 0) await delay(300);
    }
    isRunning = false;
    updateControlButtons();
    addLog('批量执行完成', 'info');

    // ★ 写入使用统计（调课不产生"报告"，只累加学生数和时间）
    try {
      let success = taskList.filter(function (t) { return t.status === TASK_STATUS.SUCCESS; }).length;
      let stats = await chrome.storage.local.get(['student_count', 'time_saved']);
      let oldStudent = parseInt(stats.student_count) || 0;
      let oldTime = parseInt(stats.time_saved) || 0;

      // 累加：studentRoster.length 个学生，每成功调课省 3min
      let newStudent = oldStudent + studentRoster.length;
      let newTime = oldTime + Math.round(success * 3);

      await chrome.storage.local.set({ student_count: newStudent, time_saved: newTime });
      addLog('[统计] 使用统计已更新: 学生+' + studentRoster.length + ', 时间+' + Math.round(success * 3) + 'min', 'info');
    } catch (e) {
      addLog('[统计] 写入使用统计失败: ' + e.message, 'warn');
    }
    } catch (e) {
      addLog('批量执行异常: ' + e.message, 'fail');
      console.error('[Tiaoke] executeTasks error:', e);
      isRunning = false;
      updateControlButtons();
    }
  }

  async function retryFailed() {
    taskList.forEach(function (task) {
      if (task.status === TASK_STATUS.FAIL) { task.status = TASK_STATUS.PENDING; task.error = ''; updateRowStatus(task.index); }
    });
    updateStats();
    addLog('开始重试失败项...', 'warn');
    await executeTasks();
  }

  // ======================================================================
  // 导出结果
  // ======================================================================

  function exportResults() {
    if (taskList.length === 0) return;
    let headers = ['#', '学员ID', '姓名', '第几讲', '新日期', '新时间', '状态', '备注'];
    let rows = taskList.map(function (task) {
      return [task.index, task.userId, task.matchedName || '', task.periodSort, task.newDate, task.newTime,
        task.status === TASK_STATUS.SUCCESS ? '成功' : task.status === TASK_STATUS.FAIL ? '失败' : '待执行',
        task.error || (task.detail ? '课程: ' + (task.detail.courseName || '') : '')];
    });
    let csvContent = [headers].concat(rows).map(function (row) {
      return row.map(function (cell) { return String(cell).replace(/,/g, '，'); }).join(',');
    }).join('\n');
    let BOM = '\uFEFF';
    let blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' });
    let url = URL.createObjectURL(blob);
    let a = document.createElement('a');
    a.href = url;
    a.download = '调课结果_' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    URL.revokeObjectURL(url);
    addLog('结果已导出为CSV文件', 'info');
  }

  // ======================================================================
  // 历史记录
  // ======================================================================

  async function loadHistory() {
    try {
      let result = await chrome.storage.local.get(HISTORY_KEY);
      if (Array.isArray(result[HISTORY_KEY])) historyRecords = result[HISTORY_KEY];
    } catch (e) { /* 忽略 */ }
  }

  async function saveHistory() {
    try {
      if (historyRecords.length > MAX_HISTORY) historyRecords = historyRecords.slice(-MAX_HISTORY);
      let obj = {}; obj[HISTORY_KEY] = historyRecords;
      await chrome.storage.local.set(obj);
    } catch (e) { /* 忽略 */ }
  }

  function addHistoryRecord(task, success, error) {
    historyRecords.push({
      id: Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      timestamp: new Date().toISOString(),
      userId: task.userId,
      matchedName: task.matchedName || '',
      periodSort: task.periodSort,
      newDate: task.newDate,
      newTime: task.newTime,
      success: success,
      error: error || '',
      detail: task.detail || null,
    });
    saveHistory();
  }

  function renderHistory() {
    let container = $('#tk-history-container');
    if (historyRecords.length === 0) {
      container.innerHTML = '<div class="tk-history-empty">暂无历史记录</div>';
      return;
    }
    let grouped = {};
    let sorted = historyRecords.slice().reverse();
    for (var i = 0; i < sorted.length; i++) {
      let date = sorted[i].timestamp.slice(0, 10);
      if (!grouped[date]) grouped[date] = [];
      grouped[date].push(sorted[i]);
    }
    let html = '';
    let dates = Object.keys(grouped).sort(function (a, b) { return b.localeCompare(a); });
    for (var di = 0; di < dates.length; di++) {
      html += '<div class="tk-history-date-group"><div class="tk-history-date-label">' + dates[di] + '</div>';
      for (var ri = 0; ri < grouped[dates[di]].length; ri++) {
        let r = grouped[dates[di]][ri];
        let time = r.timestamp.slice(11, 19);
        let name = r.matchedName ? r.matchedName + '(' + r.userId + ')' : r.userId;
        let statusClass = r.success ? 'tk-history-item-success' : 'tk-history-item-fail';
        let statusText = r.success ? '✅成功' : '❌失败';
        let errorInfo = r.error ? ' - ' + r.error : '';
        html += '<div class="tk-history-item"><span class="tk-history-item-time">' + time + '</span><span class="' + statusClass + '">' + statusText + '</span><span class="tk-history-item-detail">' + name + ' 第' + r.periodSort + '讲 → ' + r.newDate + ' ' + r.newTime + errorInfo + '</span></div>';
      }
      html += '</div>';
    }
    container.innerHTML = html;
  }

  async function clearHistory() {
    historyRecords = [];
    try { await chrome.storage.local.remove(HISTORY_KEY); } catch (e) { /* 忽略 */ }
    renderHistory();
    addLog('历史记录已清空', 'warn');
  }

  // ======================================================================
  // 初始化
  // ======================================================================

  function initModule() {
    // 检测连接状态
    checkConnection();
    // 加载学员信息簿缓存
    loadRosterFromStorage();
    // 加载历史记录
    loadHistory();
    // 模块加载时立即检测 Token（不等切换到 Token Tab）
    refreshToken();
    // 尝试从 storage 加载课表缓存
    chrome.storage.local.get('classListCache', function (result) {
      if (Array.isArray(result.classListCache) && result.classListCache.length > 0) {
        classListCache = result.classListCache;
        console.log('[调课助手] 从 storage 加载课表缓存:', classListCache.length, '条');
      }
    });

    console.log('[调课助手] 模块初始化完成');
  }

})();
