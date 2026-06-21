/**
 * 课程排期分析看板 v2.0 — 模块 Content Script（仪表盘视图 + 全屏热力图入口）
 *
 * 职责：
 * 1. Shadow DOM 内 UI 构建与渲染
 * 2. 仪表盘视图（统计卡片 + 过载/闲置 Top5）
 * 3. 下钻明细表格（三态排序）
 * 4. 异常检测结果面板
 * 5. 导出设置面板 + 日历 Canvas 导出（content.js 内，SW 无 DOM）
 * 6. 全屏热力图：通过 chrome.storage.local 传递数据，新 Tab 打开
 * 7. 消息监听与处理
 */

(function () {
  'use strict';

  // ===== 常量 =====

  var WEEK_DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  /** 默认模块配置（与 background.js 保持一致） */
  var DEFAULT_CONFIG = {
    allowedWeekDays: [1, 4, 5, 6, 0],
    dailyLimit: 1,
    colorScheme: 'cool',
    exportSettings: {
      resolution: '2x',
      format: 'png',
      includeLegend: true,
      includeHeader: true,
      backgroundColor: '#ffffff'
    }
  };

  // ===== API 配置（content.js 直接调 API，共享页面 origin 和 cookie） =====

  var API_CONFIG = {
    WORK_DOMAIN: 'https://ai-genesis.yuaiweiwu.com',
    LIST_API: '/prod-api/student-center-ai/regularCourse/next/class/list'
  };

  /**
   * 封装 API 请求（content script 上下文，共享页面 cookie）
   * @returns {{ success: boolean, data: any, error?: string }}
   */
  async function workApiFromContent(path, params) {
    params = params || {};
    var url = new URL(path, API_CONFIG.WORK_DOMAIN);
    Object.keys(params).forEach(function (k) {
      if (params[k] !== undefined && params[k] !== null && params[k] !== '') {
        url.searchParams.set(k, params[k]);
      }
    });

    try {
      var resp = await fetch(url.toString(), {
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
      });
      var text = await resp.text();
      var json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        return { success: false, error: '响应非 JSON: ' + text.substring(0, 200) };
      }

      // API 返回格式：code 可能是 "000000"(成功) 或 200(成功)，msg 字段可能是 "mesg"

      // ===== 调试：打印完整响应结构 =====
      console.log('[Heatmap-CS] === API 完整响应结构 ===');
      console.log('[Heatmap-CS] URL:', url.toString());
      console.log('[Heatmap-CS] 顶层 keys:', Object.keys(json));
      console.log('[Heatmap-CS] code:', json.code, 'type:', typeof json.code);
      console.log('[Heatmap-CS] data:', json.data, 'type:', typeof json.data);
      if (json.data && typeof json.data === 'object' && !Array.isArray(json.data)) {
        console.log('[Heatmap-CS] data keys:', Object.keys(json.data));
        // 打印每个 data 子字段的摘要
        Object.keys(json.data).forEach(function(k) {
          var v = json.data[k];
          if (Array.isArray(v)) {
            console.log('[Heatmap-CS]   data.' + k + ': 数组, 长度=' + v.length + ', 第一条=', JSON.stringify(v[0]).substring(0, 200));
          } else if (typeof v === 'object' && v !== null) {
            console.log('[Heatmap-CS]   data.' + k + ': 对象, keys=' + Object.keys(v).join(','));
          } else {
            console.log('[Heatmap-CS]   data.' + k + ':', v);
          }
        });
      }
      console.log('[Heatmap-CS] === 完整响应（前2000字符）===', text.substring(0, 2000));
      // ===== 调试结束 =====

      var isSuccess = (json.code === '000000' || json.code === 200 || json.code === '200');
      var errMsg = json.mesg || json.msg || json.message || '';
      var dataInfo = json.data
        ? (Array.isArray(json.data) ? json.data.length : (json.data.classList ? json.data.classList.length : (json.data.list ? json.data.list.length : 'obj')))
        : 'null';

      console.log('[Heatmap-CS] API 响应摘要: code=' + json.code + ', isSuccess=' + isSuccess +
        ', errMsg=' + errMsg + ', 数据量=' + dataInfo);

      if (!isSuccess) {
        return { success: false, error: errMsg || '服务器返回 code=' + json.code, rawResponse: json };
      }

      var rawData = json.data;

      // 提取数组：兼容 data 直接是数组 / data.list / data.classList / data.records / data.data
      // （学习报告插件实测数据在 data.classList 里）
      var schedules = [];
      if (Array.isArray(rawData)) {
        schedules = rawData;
      } else if (rawData && Array.isArray(rawData.classList)) {
        schedules = rawData.classList;
      } else if (rawData && Array.isArray(rawData.list)) {
        schedules = rawData.list;
      } else if (rawData && Array.isArray(rawData.records)) {
        schedules = rawData.records;
      } else if (rawData && Array.isArray(rawData.data)) {
        schedules = rawData.data;
      }

      console.log('[Heatmap-CS] 提取到 ' + schedules.length + ' 条排课记录');
      return { success: true, data: schedules, total: schedules.length };
    } catch (e) {
      console.error('[Heatmap-CS] API 请求失败:', e);
      return { success: false, error: e.message || '网络请求失败' };
    }
  }

  // ===== 工具函数 =====

  function $(sel) {
    return _moduleRoot ? _moduleRoot.querySelector(sel) : null;
  }

  function $$(sel) {
    return _moduleRoot ? _moduleRoot.querySelectorAll(sel) : [];
  }

  /**
   * 发送消息到 background，返回 Promise
   * MessageBus 包装格式：{ success: true, data: result } 或 { success: false, error: msg }
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

  function escHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /**
   * 提取时间显示（兼容 Unix 毫秒时间戳 和 HH:mm 字符串）
   */
  function extractTimeDisplay(timeStr) {
    if (!timeStr) return '';
    if (/^\d{13}$/.test(timeStr)) {
      var d = new Date(parseInt(timeStr, 10));
      if (!isNaN(d.getTime())) {
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      }
    }
    var m = timeStr.match(/(\d{2}):(\d{2})(?::\d{2})?$/);
    if (m) return m[1] + ':' + m[2];
    return timeStr;
  }

  /**
   * 从日期字符串获取星期几（0=周日）
   */
  function getWeekDayFromDate(dateStr) {
    var d = new Date(dateStr);
    if (isNaN(d.getTime())) return -1;
    return d.getDay();
  }

  // ===== 状态 =====

  var shadowRoot = null;
  var _moduleRoot = null;
  var moduleConfig = null;
  var heatmapData = null;
  var anomalyResult = null;
  var drillRecords = [];
  var cachedStudentMap = {}; // 从热力图数据中提取的学生映射 sid → {name, count}
  var currentSort = { key: null, dir: null }; // asc | desc | null
  var currentStartDate = '';
  var currentEndDate = '';
  // 下钻时记录当前选中的格子（weekDay + timeBucket），用于 CSV 导出文件名
  var selectedDrillCell = null;
  // 原始排课数据缓存（用于排课时段列表）
  var rawSchedules = null;

  // Shadow DOM 初始化
  try {
    shadowRoot = window.__shadowRoots__ && window.__shadowRoots__.heatmap;
    if (shadowRoot) {
      _moduleRoot = shadowRoot;
      renderModuleUI(shadowRoot);
    } else {
      console.warn('[Heatmap] 未找到壳提供的 Shadow DOM 容器');
    }
  } catch (e) {
    console.error('[Heatmap] 初始化失败:', e);
  }

  // ===== 仪表盘渲染 =====

  function renderDashboard() {
    if (!heatmapData) return;

    var anomalyCount = (anomalyResult && anomalyResult.anomalies) ? anomalyResult.anomalies.length : 0;

    // 显示统计卡片（一行四列）
    var summaryGrid = $('#hm-summary-grid');
    if (summaryGrid) {
      summaryGrid.style.display = 'grid';
      summaryGrid.innerHTML =
        '<div class="hm-stat-card">' +
          '<div class="hm-stat-value" style="color:#1976d2">' + (heatmapData.totalSchedules || 0) + '</div>' +
          '<div class="hm-stat-label">总排课</div>' +
        '</div>' +
        '<div class="hm-stat-card">' +
          '<div class="hm-stat-value" style="color:#7b1fa2">' + (heatmapData.totalStudents || 0) + '</div>' +
          '<div class="hm-stat-label">在排学员</div>' +
        '</div>' +
        '<div class="hm-stat-card">' +
          '<div class="hm-stat-value" style="color:' + (anomalyCount > 0 ? '#e53935' : '#10b981') + '">' + anomalyCount + '</div>' +
          '<div class="hm-stat-label">异常</div>' +
        '</div>' +
        '<div class="hm-stat-card">' +
          '<div class="hm-stat-value" style="color:#f59e0b">' + (heatmapData.timeBuckets ? heatmapData.timeBuckets.length : 0) + '</div>' +
          '<div class="hm-stat-label">活跃时段</div>' +
        '</div>';
    }

    // 显示排课时段列表
    renderHotspots();

    // 显示全屏按钮
    var fullscreenArea = $('#hm-fullscreen-btn-area');
    if (fullscreenArea) fullscreenArea.style.display = 'flex';
  }

  function renderHotspots() {
    var panel = $('#hm-hotspots-panel');
    if (!panel || !rawSchedules || rawSchedules.length === 0) {
      if (panel) panel.style.display = 'none';
      return;
    }

    var weekNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

    // 按日期分组，统计每天的去重学生数和代表时段
    var dateMap = {};
    for (var i = 0; i < rawSchedules.length; i++) {
      var s = rawSchedules[i];
      var date = s.classDate;
      if (!date) continue;
      if (!dateMap[date]) {
        dateMap[date] = {
          date: date,
          students: new Set(),
          times: {},
          scheduleCount: 0,
          sampleStartTime: '',
          firstBucket: ''
        };
      }
      dateMap[date].students.add(s.studentId || '?');
      dateMap[date].scheduleCount++;

      // 收集时间段
      var timeDisplay = extractTimeDisplay(s.startTime);
      if (timeDisplay) {
        dateMap[date].times[timeDisplay] = (dateMap[date].times[timeDisplay] || 0) + 1;
        if (!dateMap[date].sampleStartTime) {
          dateMap[date].sampleStartTime = timeDisplay;
        }
      }
    }

    // 按日期排序
    var dates = Object.keys(dateMap).sort();

    // 渲染列表
    var html = '<div class="hm-hotspot-title">📅 排课时段（按日期）</div>';

    if (dates.length === 0) {
      html += '<div style="font-size:11px;color:#b0b8c4;text-align:center;padding:8px 0;">暂无数据</div>';
    } else {
      // 展示所有日期（侧边栏宽度有限，不做截断）
      for (var di = 0; di < dates.length; di++) {
        var info = dateMap[dates[di]];
        var wd = getWeekDayFromDate(dates[di]);
        var wdName = weekNames[wd] || '';
        var studentCnt = info.students.size;

        // 找到当天最繁忙的时段
        var topTime = info.sampleStartTime || '';
        var topTimeCount = 0;
        var timeKeys = Object.keys(info.times);
        for (var tk = 0; tk < timeKeys.length; tk++) {
          if (info.times[timeKeys[tk]] > topTimeCount) {
            topTimeCount = info.times[timeKeys[tk]];
            topTime = timeKeys[tk];
          }
        }

        // 时间段合并显示（多个时段用逗号连接）
        var allTimes = timeKeys.sort().join(', ');

        var badgeColor = studentCnt > 50 ? 'background:#fce4ec;color:#c62828'
          : studentCnt > 20 ? 'background:#fff3e0;color:#e65100'
          : 'background:#e8f5e9;color:#2e7d32';

        html +=
          '<div class="hm-hotspot-item" data-date="' + escHtml(dates[di]) + '">' +
            '<span class="hm-slot-info">' +
              '<span class="hm-slot-date">' + dates[di] + ' ' + wdName + '</span>' +
              '<span class="hm-slot-time">' + (allTimes || '—') + '</span>' +
            '</span>' +
            '<span class="hm-hotspot-badge" style="' + badgeColor + '">' + studentCnt + '人 · ' + info.scheduleCount + '节</span>' +
          '</div>';
      }
    }

    panel.style.display = 'flex';
    panel.innerHTML = html;

    // 绑定点击 → 加载下钻
    var items = panel.querySelectorAll('.hm-hotspot-item');
    for (var j = 0; j < items.length; j++) {
      items[j].addEventListener('click', function(e) {
        var el = e.currentTarget;
        var date = el.getAttribute('data-date');
        loadDrillDownByDate(date);
      });
    }
  }

  /**
   * 按日期下钻：筛选该日期的所有排课记录
   */
  async function loadDrillDownByDate(date) {
    if (!date) return;
    selectedDrillCell = { date: date };
    try {
      // 直接从 rawSchedules 筛选（无需调 background）
      var records = [];
      for (var i = 0; i < rawSchedules.length; i++) {
        var s = rawSchedules[i];
        if (s.classDate !== date) continue;
        // 课节名称：API 字段 lessonName（如 "2026名题AI一对一..."）
        // 从中提取讲次 "第X讲"
        // 手机号：API 字段 userPhone
        // 在线状态：API 字段 onlineStatus（1=在线）
        var lectureMatch = (s.lessonName || '').match(/第(\d+)[讲讲节]/);
        records.push({
          studentName: s.remarkName || s.studentName || '',
          studentId: s.studentId || '',
          mobile: s.userPhone || '',
          courseName: s.courseName || '',
          lessonName: s.lessonName || '',
          lectureDisplay: lectureMatch ? '第' + lectureMatch[1] + '讲' : '',
          classDate: s.classDate,
          startTime: extractTimeDisplay(s.startTime),
          endTime: extractTimeDisplay(s.endTime),
          onlineStatus: s.onlineStatus,
          teacherName: s.userName || s.chineseName || ''
        });
      }
      drillRecords = records;
      currentSort = { key: null, dir: null };
      renderDrillDownByDate(records, date);
    } catch (e) {
      console.error('[Heatmap] 日期下钻失败:', e);
      showDrillDownError(e.message);
    }
  }

  function renderDrillDownByDate(records, date) {
    var panel = $('#hm-drilldown');
    if (!panel) return;

    if (records.length === 0) {
      panel.style.display = 'none';
      return;
    }

    var wd = getWeekDayFromDate(date);
    var wdName = WEEK_DAY_NAMES[wd] || '';

    panel.style.display = 'block';

    function sortIcon(key) {
      if (currentSort.key !== key) return '';
      if (currentSort.dir === 'asc') return ' ▲';
      if (currentSort.dir === 'desc') return ' ▼';
      return '';
    }

    var html = '<div class="hm-drilldown-header">' +
      '<div class="hm-drilldown-header-left">' +
      '📋 ' + date + ' ' + wdName + ' 排课明细（共' + records.length + '人）' +
      '</div>' +
      '<div class="hm-drilldown-header-right">' +
      ' <button class="hm-btn hm-btn-sm hm-export-csv-btn" title="导出当日 CSV">📥 导出CSV</button>' +
      ' <button class="hm-btn hm-btn-sm hm-drilldown-close-btn" title="关闭明细">✕</button>' +
      '</div>' +
      '</div>' +
      '<div class="hm-drilldown-table-wrap">' +
      '<table class="hm-table">' +
      '<thead><tr>' +
      '<th data-sort="studentName" class="hm-sortable">姓名' + sortIcon('studentName') + '</th>' +
      '<th data-sort="studentId" class="hm-sortable">学员ID' + sortIcon('studentId') + '</th>' +
      '<th data-sort="lectureDisplay" class="hm-sortable">讲次' + sortIcon('lectureDisplay') + '</th>' +
      '<th data-sort="startTime" class="hm-sortable">时段' + sortIcon('startTime') + '</th>' +
      '<th>在线</th>' +
      '</tr></thead><tbody>';

    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      html += '<tr>' +
        '<td>' + escHtml(r.remarkName || r.studentName || '') + '</td>' +
        '<td>' + escHtml(r.studentId || '') + '</td>' +
        '<td>' + escHtml(r.lectureDisplay || r.lessonName || '') + '</td>' +
        '<td>' + escHtml((r.startTime || '') + (r.endTime ? '-' + r.endTime : '')) + '</td>' +
        '<td>' + ((r.onlineStatus === 1) ? '🟢' : '🔴') + '</td>' +
        '</tr>';
    }
    html += '</tbody></table></div>';
    panel.innerHTML = html;

    // 绑定关闭按钮
    var closeBtn = panel.querySelector('.hm-drilldown-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', function() {
        panel.style.display = 'none';
        selectedDrillCell = null;
      });
    }

    // 绑定排序
    var headers = panel.querySelectorAll('.hm-sortable');
    for (var j = 0; j < headers.length; j++) {
      headers[j].addEventListener('click', onSortClick);
    }

    // 绑定 CSV 导出
    var csvBtn = panel.querySelector('.hm-export-csv-btn');
    if (csvBtn) {
      csvBtn.addEventListener('click', function() {
        if (drillRecords.length === 0) return;
        var BOM = '\uFEFF';
        var rows = [BOM + '学员名称,学员ID,手机号,课程名称,课节名称,时间段,在线状态'];
        for (var k = 0; k < drillRecords.length; k++) {
          var r = drillRecords[k];
          rows.push([
            r.remarkName || r.studentName || '',
            r.studentId || '',
            r.mobile || '',
            r.courseName || '',
            r.lessonName || '',
            (r.startTime || '') + (r.endTime ? '-' + r.endTime : ''),
            r.onlineStatus === 1 ? '在线' : '离线'
          ].map(function(v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(','));
        }
        var blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = '排课明细_' + date + '.csv';
        a.click();
        URL.revokeObjectURL(url);
      });
    }

    // 滚动到下钻面板
    panel.scrollIntoView({ behavior: 'smooth' });
  }

  // ===== 打开全屏热力图 =====

  async function openFullscreen() {
    if (!heatmapData) return;
    try {
      await chrome.storage.local.set({
        hmFullscreenData: {
          heatmapData: heatmapData,
          anomalyResult: anomalyResult,
          dateRange: { start: currentStartDate, end: currentEndDate },
          rawSchedules: rawSchedules || []
        }
      });
      // 通过 background.js 创建新 Tab（content script 不能直接调用 chrome.tabs.create）
      await sendMsg({
        target: 'heatmap',
        action: 'OPEN_FULLSCREEN',
        data: {}
      });
    } catch (e) {
      console.error('[Heatmap] 打开全屏页面失败:', e);
      showAlert('打开全屏页面失败: ' + e.message);
    }
  }

  // ===== 下钻明细 =====

  async function loadDrillDown(weekDay, timeBucket) {
    selectedDrillCell = { weekDay: weekDay, timeBucket: timeBucket };
    try {
      showLoading(true, '正在加载明细...');
      var resp = await sendMsg({
        target: 'heatmap',
        action: 'FETCH_DRILL_DOWN',
        data: {
          weekDay: weekDay,
          timeBucket: timeBucket
        }
      });

      if (resp && resp.success && resp.data) {
        // 优先检查业务层错误（如缓存为空）
        if (resp.data.error) {
          drillRecords = [];
          showDrillDownError(resp.data.error);
        } else {
          drillRecords = resp.data.records || [];
          currentSort = { key: null, dir: null };
          renderDrillDown(drillRecords);
        }
      } else {
        drillRecords = [];
        var errMsg = (resp && !resp.success && resp.error) ? resp.error : '加载失败';
        showDrillDownError(errMsg);
      }
    } catch (e) {
      console.error('[Heatmap] 下钻失败:', e);
      showDrillDownError(e.message);
    } finally {
      showLoading(false);
    }
  }

  function renderDrillDown(records) {
    var panel = $('#hm-drilldown');
    if (!panel) return;

    if (records.length === 0 || !selectedDrillCell) {
      panel.style.display = 'none';
      return;
    }

    panel.style.display = 'block';
    var weekDayName = WEEK_DAY_NAMES[selectedDrillCell.weekDay] || '';

    // 排序指示符
    function sortIcon(key) {
      if (currentSort.key !== key) return '';
      if (currentSort.dir === 'asc') return ' ▲';
      if (currentSort.dir === 'desc') return ' ▼';
      return '';
    }

    var html = '<div class="hm-drilldown-header">' +
      '📋 下钻明细：' + weekDayName + ' ' + selectedDrillCell.timeBucket + '（共' + records.length + '人）' +
      ' <button class="hm-btn hm-btn-sm hm-export-csv-btn" title="导出本格 CSV">📥 导出CSV</button>' +
      '</div>' +
      '<div class="hm-drilldown-table-wrap">' +
      '<table class="hm-table">' +
      '<thead><tr>' +
      '<th data-sort="studentName" class="hm-sortable">学员名称' + sortIcon('studentName') + '</th>' +
      '<th data-sort="courseName" class="hm-sortable">课程名称' + sortIcon('courseName') + '</th>' +
      '<th data-sort="lectureNum" class="hm-sortable">课节' + sortIcon('lectureNum') + '</th>' +
      '<th data-sort="classDate" class="hm-sortable">约课日期' + sortIcon('classDate') + '</th>' +
      '<th data-sort="startTime" class="hm-sortable">时间段' + sortIcon('startTime') + '</th>' +
      '<th>在线</th>' +
      '</tr></thead>' +
      '<tbody>';

    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      html += '<tr>' +
        '<td>' + escHtml(r.remarkName || r.studentName || '') + '</td>' +
        '<td>' + escHtml(r.courseName || '') + '</td>' +
        '<td>第' + (r.lectureNum || '?') + '讲</td>' +
        '<td>' + escHtml(r.classDate || '') + '</td>' +
        '<td>' + escHtml((r.startTime || '') + '-' + (r.endTime || '')) + '</td>' +
        '<td>' + ((r.status === 1) ? '🟢' : '🔴') + '</td>' +
        '</tr>';
    }

    html += '</tbody></table></div>';
    panel.innerHTML = html;

    // 绑定排序点击
    var headers = panel.querySelectorAll('.hm-sortable');
    for (var j = 0; j < headers.length; j++) {
      headers[j].addEventListener('click', onSortClick);
    }

    // 绑定 CSV 导出
    var csvBtn = panel.querySelector('.hm-export-csv-btn');
    if (csvBtn) {
      csvBtn.addEventListener('click', onExportCsvClick);
    }
  }

  function onSortClick(e) {
    var key = e.currentTarget.getAttribute('data-sort');
    if (currentSort.key === key) {
      // 三态循环: asc → desc → null
      if (currentSort.dir === 'asc') currentSort.dir = 'desc';
      else if (currentSort.dir === 'desc') currentSort = { key: null, dir: null };
      else currentSort.dir = 'asc';
    } else {
      currentSort = { key: key, dir: 'asc' };
    }

    // 排序
    var sorted = [].concat(drillRecords);
    if (currentSort.key && currentSort.dir) {
      var dir = currentSort.dir === 'asc' ? 1 : -1;
      var sortKey = currentSort.key;
      sorted.sort(function (a, b) {
        var va = getSortValue(a, sortKey);
        var vb = getSortValue(b, sortKey);
        if (va < vb) return -1 * dir;
        if (va > vb) return 1 * dir;
        return 0;
      });
    }
    if (selectedDrillCell && selectedDrillCell.date) {
      renderDrillDownByDate(sorted, selectedDrillCell.date);
    } else {
      renderDrillDown(sorted);
    }
  }

  function getSortValue(record, key) {
    switch (key) {
      case 'studentName': return (record.remarkName || record.studentName || '');
      case 'courseName': return (record.courseName || '');
      case 'lectureNum': return record.lectureNum || 0;
      case 'classDate': return (record.classDate || '');
      case 'startTime': return (record.startTime || '');
      default: return '';
    }
  }

  function onExportCsvClick() {
    if (drillRecords.length === 0) return;
    // 添加 BOM 以支持 Excel 正确显示中文
    var BOM = '\uFEFF';
    var csvRows = [BOM + '学员名称,课程名称,课节,约课日期,时间段,在线状态'];
    for (var i = 0; i < drillRecords.length; i++) {
      var r = drillRecords[i];
      csvRows.push([
        r.remarkName || r.studentName || '',
        r.courseName || '',
        '第' + (r.lectureNum || '?') + '讲',
        r.classDate || '',
        (r.startTime || '') + '-' + (r.endTime || ''),
        r.status === 1 ? '在线' : '离线'
      ].map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(','));
    }
    var blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    var weekDayName = selectedDrillCell ? WEEK_DAY_NAMES[selectedDrillCell.weekDay] : '';
    var timeLabel = selectedDrillCell ? selectedDrillCell.timeBucket.replace(/:/g, '') : '';
    a.download = '下钻明细_' + weekDayName + '_' + timeLabel + '.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  function showDrillDownError(msg) {
    var panel = $('#hm-drilldown');
    if (!panel) return;
    panel.style.display = 'block';
    panel.innerHTML = '<div class="hm-error">❌ ' + escHtml(msg || '加载失败') + '</div>';
  }

  // ===== 异常检测面板 =====

  function renderAnomalyPanel(result) {
    var panel = $('#hm-anomaly-panel');
    if (!panel) return;

    if (!result || !result.anomalies || result.anomalies.length === 0) {
      panel.innerHTML = '<div class="hm-anomaly-header">' +
        '<span>⚠️ 异常检测 · 0 条</span>' +
        '<span class="hm-anomaly-toggle">展开 ▼</span></div>' +
        '<div class="hm-anomaly-list" style="display:none;"><div class="hm-anomaly-empty hm-anomaly-empty-success">✅ 未发现异常，排课数据一切正常</div></div>';
      var hdr = panel.querySelector('.hm-anomaly-header');
      if (hdr) hdr.addEventListener('click', toggleAnomalyPanel);
      return;
    }

    var anomalies = result.anomalies;
    var html = '<div class="hm-anomaly-header" data-collapsed="true">' +
      '<span class="hm-anomaly-badge">' +
      '⚠️ 异常检测 · ' + anomalies.length + ' 条 ' +
      '<span class="hm-anomaly-badge-count hm-anomaly-badge-error">' + (result.errorCount || 0) + '</span>' +
      '<span class="hm-anomaly-badge-count hm-anomaly-badge-warning">' + (result.warningCount || 0) + '</span>' +
      '</span>' +
      '<span class="hm-anomaly-toggle">展开 ▼</span></div>' +
      '<div class="hm-anomaly-list" style="display:none;">';

    for (var i = 0; i < anomalies.length; i++) {
      var a = anomalies[i];
      var icon = a.severity === 'error' ? '🔴' : (a.severity === 'warning' ? '🟡' : '🔵');
      html += '<div class="hm-anomaly-item hm-severity-' + (a.severity || 'info') + '">' +
        icon + ' <b>' + escHtml(a.remarkName || a.studentName || '未知') + '</b> — ' + escHtml(a.description) +
        '</div>';
    }

    html += '</div>';
    panel.innerHTML = html;

    // 折叠/展开
    var toggle = panel.querySelector('.hm-anomaly-toggle');
    if (toggle) toggle.addEventListener('click', toggleAnomalyPanel);
  }

  function toggleAnomalyPanel(e) {
    var header = e.target.closest('.hm-anomaly-header');
    if (!header) return;
    var list = header.querySelector('.hm-anomaly-list');
    if (!list) {
      // 可能 header 的同级 div 是 list
      list = header.nextElementSibling;
    }
    if (!list) return;
    var collapsed = header.getAttribute('data-collapsed') !== 'false';
    header.setAttribute('data-collapsed', collapsed ? 'false' : 'true');
    list.style.display = collapsed ? 'block' : 'none';
    // 翻转箭头
    var toggle = header.querySelector('.hm-anomaly-toggle');
    if (toggle) {
      toggle.textContent = collapsed ? '收起 ▲' : '展开 ▼';
    }
  }

  // ===== 导出面板 =====

  function showExportPanel() {
    if (!heatmapData || !heatmapData.cells || heatmapData.cells.length === 0) {
      alert('请先查询热力图数据');
      return;
    }

    var overlay = $('#hm-export-overlay');
    if (!overlay) return;
    overlay.style.display = 'flex';

    var settings = (moduleConfig && moduleConfig.exportSettings) || { resolution: '2x', format: 'png', watermark: '', showWatermark: false };
    var html = '<div class="hm-export-card">' +
      '<div class="hm-export-title">📥 导出学生日历设置</div>' +
      '<div class="hm-export-body">' +

      '<label class="hm-checkbox"><input type="checkbox" checked data-field="onlyHasClass"> 只导出有课的学生</label>' +
      '<label class="hm-checkbox"><input type="checkbox" checked data-field="sortByLecture"> 按讲次数量倒序排列</label>' +

      '<div class="hm-export-section">水印文字：<input type="text" class="hm-input hm-watermark-input" placeholder="留空不显示" value="' + escHtml(settings.watermark || '') + '">' +
      ' <label class="hm-checkbox hm-inline"><input type="checkbox"' + (settings.showWatermark ? ' checked' : '') + ' data-field="showWatermark"> 显示水印</label></div>' +

      '<div class="hm-export-section">导出尺寸：<br>' +
      '<label class="hm-radio"><input type="radio" name="exportSize" value="1200" ' + (settings.resolution !== 'a4' ? 'checked' : '') + '> 1200×900（手机版）</label>' +
      '<label class="hm-radio"><input type="radio" name="exportSize" value="a4" ' + (settings.resolution === 'a4' ? 'checked' : '') + '> A4 2480×3508（打印级）</label></div>' +

      '<div class="hm-export-section">选择学生（全选 <input type="checkbox" checked class="hm-select-all">）：</div>' +
      '<div class="hm-student-list" id="hm-student-list-container">加载学生列表中...</div>' +

      '</div>' +
      '<div class="hm-export-footer">' +
      '<button class="hm-btn hm-btn-secondary" id="hm-export-cancel">取消</button>' +
      '<button class="hm-btn hm-btn-primary" id="hm-export-start">开始导出</button>' +
      '</div>' +
      '</div>';

    overlay.innerHTML = html;

    // 加载学生列表
    loadStudentListForExport();

    // 绑定
    var cancelBtn = $('#hm-export-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', function () { overlay.style.display = 'none'; });
    var startBtn = $('#hm-export-start');
    if (startBtn) startBtn.addEventListener('click', onStartExport);
    var selectAll = $('.hm-select-all');
    if (selectAll) selectAll.addEventListener('change', onSelectAllChange);
  }

  async function loadStudentListForExport() {
    var listContainer = $('#hm-student-list-container');
    if (!listContainer) return;

    listContainer.textContent = '正在加载学生列表...';

    try {
      var resp = await sendMsg({ target: 'heatmap', action: 'FETCH_STUDENT_LIST', data: {} });

      if (resp && resp.success && resp.data && resp.data.students) {
        var students = resp.data.students;

        if (students.length === 0) {
          listContainer.textContent = '无排课数据，请先查询热力图';
          return;
        }

        // 缓存学生映射
        cachedStudentMap = {};
        for (var k = 0; k < students.length; k++) {
          cachedStudentMap[students[k].studentId] = {
            name: students[k].remarkName || students[k].studentName,
            count: students[k].count
          };
        }

        var html = '';
        for (var j = 0; j < students.length; j++) {
          var s = students[j];
          html += '<label class="hm-checkbox"><input type="checkbox" checked data-sid="' + escHtml(s.studentId) + '"> ' +
            escHtml(s.remarkName || s.studentName) + '（' + s.count + '节）</label>';
        }
        listContainer.innerHTML = html;
      } else {
        listContainer.textContent = '加载学生列表失败';
      }
    } catch (e) {
      console.error('[Heatmap] 加载学生列表失败:', e);
      listContainer.textContent = '加载失败：' + e.message;
    }
  }

  function onSelectAllChange(e) {
    var checked = e.target.checked;
    var container = $('#hm-student-list-container');
    if (!container) return;
    var boxes = container.querySelectorAll('input[type="checkbox"]');
    for (var i = 0; i < boxes.length; i++) boxes[i].checked = checked;
  }

  async function onStartExport() {
    var overlay = $('#hm-export-overlay');
    if (overlay) overlay.style.display = 'none';

    // 收集选中的学生
    var selectedSids = [];
    var container = $('#hm-student-list-container');
    if (container) {
      var boxes = container.querySelectorAll('input[type="checkbox"]:checked');
      for (var i = 0; i < boxes.length; i++) {
        selectedSids.push(boxes[i].getAttribute('data-sid'));
      }
    }

    if (selectedSids.length === 0) {
      alert('请选择要导出的学生');
      return;
    }

    showLoading(true, '正在导出 ' + selectedSids.length + ' 位学生的日历...');

    var successCount = 0;
    for (var idx = 0; idx < selectedSids.length; idx++) {
      var sid = selectedSids[idx];
      showLoading(true, '正在导出 ' + (idx + 1) + '/' + selectedSids.length + '：' + (cachedStudentMap[sid] ? cachedStudentMap[sid].name : sid));

      try {
        var resp = await sendMsg({ target: 'heatmap', action: 'FETCH_STUDENT_SCHEDULES', data: { studentId: sid } });

        if (!resp || !resp.success || !resp.data) {
          console.warn('[Heatmap] 获取学生 ' + sid + ' 数据失败:', resp);
          continue;
        }

        var schedules = resp.data.schedules || [];
        var studentName = resp.data.remarkName || resp.data.studentName || sid;

        if (schedules.length === 0) continue;

        // Canvas 渲染日历（content.js 端，SW 无 DOM）
        var settings = collectExportSettings();
        var dataUrl = renderCalendarImage(schedules, settings, studentName);

        // 传给 background 下载
        await sendMsg({
          target: 'heatmap',
          action: 'DOWNLOAD_CALENDAR',
          data: {
            dataUrl: dataUrl,
            filename: studentName + '_课程日历.png'
          }
        });

        successCount++;

      } catch (e) {
        console.error('[Heatmap] 导出学生 ' + sid + ' 失败:', e);
      }
    }

    showLoading(false);
    alert('导出完成！成功 ' + successCount + '/' + selectedSids.length + ' 位学生');
  }

  function collectExportSettings() {
    var res = '2x';
    var radios = $$('input[name="exportSize"]');
    for (var i = 0; i < radios.length; i++) {
      if (radios[i].checked) { res = radios[i].value; break; }
    }
    var watermark = '';
    var watermarkInput = _moduleRoot ? _moduleRoot.querySelector('.hm-watermark-input') : null;
    if (watermarkInput) watermark = watermarkInput.value || '';
    var showWatermark = false;
    var wmCheck = _moduleRoot ? _moduleRoot.querySelector('input[data-field="showWatermark"]') : null;
    if (wmCheck) showWatermark = wmCheck.checked;

    return {
      resolution: res === 'a4' ? '3x' : '2x',
      format: 'png',
      watermark: watermark,
      showWatermark: showWatermark,
      size: res === 'a4' ? 'a4' : 'mobile'
    };
  }

  // ===== 日历图片 Canvas 渲染（content.js 内，SW 无 DOM） =====

  function renderCalendarImage(schedules, settings, studentName) {
    // Canvas 尺寸
    var baseW, baseH;
    if (settings.size === 'a4') {
      baseW = 2480;
      baseH = 3508;
    } else {
      baseW = 1200;
      baseH = 900;
    }
    var width = baseW;
    var height = baseH;

    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext('2d');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    var fs = Math.max(1, Math.round(width / 60));

    // ===== 工具函数 =====
    // 格式化时间：支持 13 位毫秒戳、16 位微秒戳、HH:MM:SS、classTimeRange 等
    function fmtTime(t) {
      if (!t && t !== 0) return '';
      t = String(t);
      // 16 位微秒戳 → 先转 13 位毫秒戳
      if (/^\d{16}$/.test(t)) {
        t = String(Math.floor(parseInt(t, 10) / 1000));
      }
      if (/^\d{13}$/.test(t)) {
        var dt = new Date(parseInt(t, 10));
        if (!isNaN(dt.getTime())) return String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0');
      }
      // classTimeRange 格式："06月07日 17:00-19:00" → 提取 "17:00-19:00"
      var m = t.match(/(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})/);
      if (m) return m[1] + '-' + m[2];
      m = t.match(/(\d{2}):(\d{2})/);
      return m ? m[1] + ':' + m[2] : t;
    }
    // 从 classTimeRange 提取完整时段字符串（如 "17:00-19:00"）
    function fmtTimeRange(s) {
      if (!s) return '';
      s = String(s);
      var m = s.match(/(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})/);
      return m ? m[1] + '-' + m[2] : fmtTime(s);
    }

    // 提取讲次（优先课节名称 lessonName，其次 lectureName，最后 courseName）
    function extractLecture(s) {
      var v = s.lessonName || s.lectureName || '';
      if (!v) v = s.courseName || '';
      if (!v) return '-';
      var m = v.match(/第(\d+)[讲讲节课]/);
      if (m) return '第' + m[1] + '讲';
      return '-';
    }

    // ===== 按日期排序 =====
    var sorted = [].concat(schedules).sort(function (a, b) {
      return (a.classDate || '').localeCompare(b.classDate || '') || (fmtTime(a.startTime) || '').localeCompare(fmtTime(b.startTime) || '');
    });

    // ---- 1. 标题 ----
    var courseTitle = '';
    for (var ci = 0; ci < sorted.length; ci++) {
      if (sorted[ci].courseName) { courseTitle = sorted[ci].courseName; break; }
    }
    ctx.fillStyle = '#333';
    ctx.font = 'bold ' + (fs * 1.4) + 'px "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(studentName + ' — 课程日历', width / 2, fs * 0.8);
    if (courseTitle) {
      ctx.fillStyle = '#888';
      ctx.font = (fs * 0.9) + 'px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(courseTitle, width / 2, fs * 2.6);
    }

    // ---- 2. 排课详情表 ----
    var tableTop = fs * 5; // 标题+副标题后，直接接表格

    // 表格标题
    ctx.fillStyle = '#555';
    ctx.font = (fs * 0.9) + 'px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('📋 排课详情（共 ' + schedules.length + ' 节）', fs * 1.5, tableTop + fs * 0.3);
    tableTop += fs * 1.8;
var rowH = fs * 2.2;
    var colWidths = [width * 0.20, width * 0.10, width * 0.40, width * 0.18, width * 0.12];
    var headers = ['日期', '星期', '课节名称', '时段', '讲次'];

    // 表头
    ctx.fillStyle = '#e3f2fd';
    ctx.fillRect(0, tableTop, width, rowH);
    ctx.fillStyle = '#1565c0';
    ctx.font = 'bold ' + fs + 'px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    var colX = 0;
    for (var hi = 0; hi < headers.length; hi++) {
      ctx.fillText(headers[hi], colX + 4, tableTop + rowH / 2);
      colX += colWidths[hi];
    }
    ctx.strokeStyle = '#bbdefb';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, tableTop + rowH);
    ctx.lineTo(width, tableTop + rowH);
    ctx.stroke();

    // 数据行
    ctx.font = fs + 'px "Microsoft YaHei", sans-serif';
    var rowY = tableTop + rowH;
    for (var ri = 0; ri < sorted.length && rowY + rowH < height - fs * 6; ri++) {
      var s = sorted[ri];
      if (ri % 2 === 1) {
        ctx.fillStyle = '#f5f5f5';
        ctx.fillRect(0, rowY, width, rowH);
      }

      var classDate = s.classDate || '';
      var weekDay = '';
      if (classDate) {
        var d = new Date(classDate);
        if (!isNaN(d.getTime())) {
          weekDay = WEEK_DAY_NAMES[d.getDay()];
        }
      }
      var lessonName = s.lessonName || s.courseName || '';
      // 时段优先用 classTimeRange（"06月07日 17:00-19:00"）→ 提取 "17:00-19:00"
      var timeSlot = '';
      if (s.classTimeRange) {
        timeSlot = fmtTimeRange(s.classTimeRange);
      } else {
        timeSlot = fmtTime(s.startTime) + (s.endTime ? '-' + fmtTime(s.endTime) : '');
      }
      var lectureStr = extractLecture(s);

      var values = [classDate, weekDay, lessonName, timeSlot, lectureStr];
      colX = 0;
      for (var vi = 0; vi < values.length; vi++) {
        ctx.fillStyle = '#333';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        var val = values[vi];
        var truncVal = val;
        // 课节名称列（vi=2）：用 measureText 精确截断
        if (vi === 2) {
          var maxW = colWidths[vi] - 8;
          while (ctx.measureText(truncVal + '…').width > maxW && truncVal.length > 0) {
            truncVal = truncVal.slice(0, -1);
          }
          if (truncVal.length < val.length) truncVal += '…';
        }
        ctx.fillText(truncVal, colX + 4, rowY + rowH / 2);
        colX += colWidths[vi];
      }

      ctx.strokeStyle = '#e0e0e0';
      ctx.beginPath();
      ctx.moveTo(0, rowY + rowH);
      ctx.lineTo(width, rowY + rowH);
      ctx.stroke();

      rowY += rowH;
    }

    // ---- 3. 统计 ----
    var statsY = height - fs * 4;
    ctx.fillStyle = '#666';
    ctx.font = (fs * 0.9) + 'px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('共 ' + schedules.length + ' 节课', fs, statsY);

    if (schedules.length > 0) {
      var weekSet = new Set();
      for (var wi = 0; wi < schedules.length; wi++) {
        if (schedules[wi].classDate) {
          var wd = new Date(schedules[wi].classDate);
          if (!isNaN(wd.getTime())) {
            var jan1 = new Date(wd.getFullYear(), 0, 1);
            var weekNum = Math.ceil(((wd - jan1) / 86400000 + jan1.getDay() + 1) / 7);
            weekSet.add(wd.getFullYear() * 100 + weekNum);
          }
        }
      }
      var avgPerWeek = weekSet.size > 0 ? (schedules.length / weekSet.size).toFixed(1) : '?';
      ctx.fillText(' | 每周约 ' + avgPerWeek + ' 节', fs + ctx.measureText('共 ' + schedules.length + ' 节课').width, statsY);
    // 排课日期范围
    if (sorted.length > 0) {
      var dateRange = sorted[0].classDate + ' ~ ' + sorted[sorted.length - 1].classDate;
      ctx.fillText('📅 排课日期范围：' + dateRange, fs, statsY + fs * 1.2);
    }
  }

  // ---- 4. 水印 ----
    if (settings.showWatermark && settings.watermark) {
      ctx.save();
      ctx.globalAlpha = 0.12;
      ctx.font = (fs * 2.5) + 'px "Microsoft YaHei", sans-serif';
      ctx.fillStyle = '#999';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.translate(width / 2, height / 2);
      ctx.rotate(-Math.PI / 6);
      ctx.fillText(settings.watermark, 0, 0);
      ctx.restore();
    }

    // ---- 5. 底部边框线 ----
    ctx.strokeStyle = '#1565c0';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, height - 2);
    ctx.lineTo(width, height - 2);
    ctx.stroke();

    return canvas.toDataURL('image/png');
  }

  // ===== 主 UI 渲染 =====

  function renderModuleUI(root) {
    _moduleRoot = root;

    // 清除壳的 loading 占位符（保留 <style> 标签）
    var toRemove = [];
    for (var i = 0; i < root.children.length; i++) {
      if (root.children[i].tagName !== 'STYLE') toRemove.push(root.children[i]);
    }
    for (var j = 0; j < toRemove.length; j++) {
      root.removeChild(toRemove[j]);
    }

    // 构建主 UI
    var html = '' +
      '<div class="hm-root">' +

      // Header
      '<div class="hm-header">' +
      '  <span class="hm-title">🗓️ 课程排期分析</span>' +
      '  <div class="hm-header-btns">' +
      '    <button class="hm-btn hm-btn-header hm-btn-sm" id="hm-btn-export">📥 导出日历</button>' +
      '    <button class="hm-btn hm-btn-header hm-btn-sm" id="hm-btn-settings">⚙️ 设置</button>' +
      '  </div>' +
      '</div>' +

      // Controls
      '<div class="hm-controls">' +
      '  <label>日期：<input type="date" id="hm-date-start" class="hm-input hm-input-sm"></label>' +
      '  <span class="hm-range-sep">~</span>' +
      '  <label><input type="date" id="hm-date-end" class="hm-input hm-input-sm"></label>' +
      '  <button class="hm-btn hm-btn-primary hm-btn-sm" id="hm-btn-query">🔍 查询</button>' +
      '</div>' +

      // Loading
      '<div id="hm-loading" class="hm-loading" style="display:none;">' +
      '  <div class="hm-loading-text"></div>' +
      '  <div class="hm-loading-bar"><div class="hm-loading-progress"></div></div>' +
      '</div>' +

      // 统计卡片（查询后显示）
      '<div id="hm-summary-grid" class="hm-summary-grid" style="display:none;"></div>' +

      // 排课时段列表（查询后显示）
      '<div id="hm-hotspots-panel" class="hm-hotspots-panel" style="display:none;"></div>' +

      // 异常面板
      '<div id="hm-anomaly-panel" class="hm-anomaly-panel"></div>' +

      // 下钻明细
      '<div id="hm-drilldown" class="hm-drilldown" style="display:none;"></div>' +

      // 全屏按钮区域（查询后显示）
      '<div id="hm-fullscreen-btn-area" class="hm-fullscreen-btn-area" style="display:none;">' +
      '  <button class="hm-btn-fullscreen" id="hm-btn-fullscreen">📊 查看完整热力图</button>' +
      '</div>' +

      // 导出面板 Overlay
      '<div id="hm-export-overlay" class="hm-export-overlay" style="display:none;"></div>' +

      '</div>';

    var wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    while (wrapper.firstChild) {
      root.appendChild(wrapper.firstChild);
    }

    // 绑定按钮事件
    var queryBtn = $('#hm-btn-query');
    if (queryBtn) queryBtn.addEventListener('click', onQueryClick);
    var exportBtn = $('#hm-btn-export');
    if (exportBtn) exportBtn.addEventListener('click', showExportPanel);
    var settingsBtn = $('#hm-btn-settings');
    if (settingsBtn) settingsBtn.addEventListener('click', showSettingsPanel);
    var fullscreenBtn = $('#hm-btn-fullscreen');
    if (fullscreenBtn) fullscreenBtn.addEventListener('click', openFullscreen);

    // 初始加载配置 + 查询
    loadConfigAndQuery();
  }

  async function loadConfigAndQuery() {
    try {
      var resp = await sendMsg({ target: 'heatmap', action: 'LOAD_CONFIG', data: {} });
      if (resp && resp.success && resp.data) {
        moduleConfig = resp.data;
      } else if (resp && resp.data) {
        // 兼容：某些情况下可能没有 success 包装
        moduleConfig = resp.data;
      }
    } catch (e) {
      console.warn('[Heatmap] 加载配置失败:', e);
      moduleConfig = null;
    }

    // 不自动查询，等用户手动点击查询按钮
    // 设置日期默认值为当月
    var now = new Date();
    var monthStart = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-01';
    // 月末
    var monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    var monthEndStr = monthEnd.getFullYear() + '-' + String(monthEnd.getMonth() + 1).padStart(2, '0') + '-' + String(monthEnd.getDate()).padStart(2, '0');

    var startInput = $('#hm-date-start');
    var endInput = $('#hm-date-end');
    if (startInput && !startInput.value) startInput.value = monthStart;
    if (endInput && !endInput.value) endInput.value = monthEndStr;
  }

  async function onQueryClick() {
    var startVal = $('#hm-date-start') ? $('#hm-date-start').value : '';
    var endVal = $('#hm-date-end') ? $('#hm-date-end').value : '';

    if (!startVal || !endVal) {
      alert('请设置日期范围');
      return;
    }

    // 保存日期范围供全屏使用
    currentStartDate = startVal;
    currentEndDate = endVal;

    showLoading(true, '正在获取数据...');

    try {
      // ===== 步骤1: content.js 直接调 API（共享页面 cookie，SW 没有认证） =====
      showLoading(true, '正在调用 API 获取排课数据...');
      // 参数格式对齐学习报告插件：classStatus=2（必须），日期格式 YYYY-MM-DD HH:mm:ss
      var apiResp = await workApiFromContent(API_CONFIG.LIST_API, {
        classStatus: 2,
        startDate: startVal + ' 00:00:00',
        endDate: endVal + ' 23:59:59'
      });

      if (!apiResp.success) {
        showLoading(false);
        alert('API 调用失败：' + apiResp.error + '\n\n请在控制台（F12）查看详细日志，\n或使用「API 抓包调试器」抓取请求。');
        return;
      }

      if (!apiResp.data || apiResp.data.length === 0) {
        showLoading(false);
        alert('没有获取到排课数据（' + startVal + ' ~ ' + endVal + '）');
        return;
      }

      console.log('[Heatmap-CS] API 获取成功，共 ' + apiResp.data.length + ' 条记录');

      // 保存原始数据用于排课时段列表
      rawSchedules = apiResp.data;

      // ===== 步骤2: 发送原始数据给 background.js 做去重+聚合+异常检测 =====
      showLoading(true, '正在处理数据（去重、聚合、异常检测）...');
      var resp = await sendMsg({
        target: 'heatmap',
        action: 'PROCESS_RAW_DATA',
        data: {
          schedules: apiResp.data,
          dateRange: { start: startVal, end: endVal }
        }
      });

      if (resp && resp.success && resp.data) {
        var data = resp.data;

        if (data.error && !data.heatmapData) {
          showLoading(false);
          alert('数据处理失败：' + data.error);
          return;
        }

        heatmapData = data.heatmapData;
        anomalyResult = data.anomalyResult;

        // 导出面板的学生列表稍后通过 FETCH_STUDENT_LIST 获取
        cachedStudentMap = {};

        // 渲染仪表盘（统计卡片 + 过载/闲置）
        renderDashboard();
        renderAnomalyPanel(anomalyResult);

        // 隐藏下钻面板
        var drillPanel = $('#hm-drilldown');
        if (drillPanel) drillPanel.style.display = 'none';
        selectedDrillCell = null;

        showLoading(false);
      } else {
        showLoading(false);
        var errMsg = (resp && !resp.success && resp.error) ? resp.error : '数据处理返回异常';
        alert('处理失败：' + errMsg);
      }
    } catch (e) {
      console.error('[Heatmap] 查询失败:', e);
      showLoading(false);
      alert('查询失败：' + e.message);
    }
  }

  // ===== 设置面板 =====

  function showSettingsPanel() {
    var config = moduleConfig || Object.assign({}, DEFAULT_CONFIG);

    var overlay = document.createElement('div');
    overlay.className = 'hm-export-overlay';
    overlay.id = 'hm-settings-overlay';
    overlay.innerHTML = '<div class="hm-export-card"><div class="hm-export-title">⚙️ 排期分析设置</div>' +
      '<div class="hm-export-body">' +
      '<div class="hm-setting-row"><label>允许排课星期（0=日,1=一...6=六）：</label>' +
      '<input id="hm-set-weekdays" value="' + (config.allowedWeekDays || DEFAULT_CONFIG.allowedWeekDays).join(',') + '" class="hm-input"></div>' +
      '<div class="hm-setting-row"><label>每日排课上限（节）：</label>' +
      '<input id="hm-set-dailylimit" type="number" value="' + (config.dailyLimit || DEFAULT_CONFIG.dailyLimit) + '" class="hm-input" min="1" max="10"></div>' +
      '<div class="hm-setting-row"><label>配色方案：</label>' +
      '<select id="hm-set-colorscheme" class="hm-input"><option value="cool"' + ((config.colorScheme || 'cool') === 'cool' ? ' selected' : '') + '>蓝色系（cool）</option><option value="warm"' + (config.colorScheme === 'warm' ? ' selected' : '') + '>红色系（warm）</option></select></div>' +
      '</div>' +
      '<div class="hm-export-footer"><button class="hm-btn hm-btn-secondary" id="hm-settings-cancel">取消</button><button class="hm-btn hm-btn-primary" id="hm-settings-save">保存</button></div></div>';
    overlay.style.display = 'flex';
    _moduleRoot.appendChild(overlay);

    overlay.querySelector('#hm-settings-cancel').addEventListener('click', function () { overlay.remove(); });
    overlay.querySelector('#hm-settings-save').addEventListener('click', async function () {
      var newConfig = Object.assign({}, config);
      var weekdaysStr = overlay.querySelector('#hm-set-weekdays').value;
      newConfig.allowedWeekDays = weekdaysStr.split(',').map(function (s) { return parseInt(s.trim(), 10); }).filter(function (n) { return !isNaN(n) && n >= 0 && n <= 6; });
      newConfig.dailyLimit = parseInt(overlay.querySelector('#hm-set-dailylimit').value, 10) || 1;
      newConfig.colorScheme = overlay.querySelector('#hm-set-colorscheme').value;
      moduleConfig = newConfig;

      try {
        await sendMsg({ target: 'heatmap', action: 'SAVE_CONFIG', data: newConfig });
      } catch (e) {
        console.warn('[Heatmap] 保存配置失败:', e);
      }

      overlay.remove();
      // 重新查询刷新
      onQueryClick();
    });
  }

  // ===== 辅助函数 =====

  function showLoading(show, text) {
    var el = $('#hm-loading');
    if (!el) return;
    el.style.display = show ? 'block' : 'none';
    if (text) {
      var textEl = el.querySelector('.hm-loading-text');
      if (textEl) textEl.textContent = text;
    }
  }

  // ===== 消息处理（从 background 推送过来的消息） =====

  window.__moduleMessageHandlers__ = window.__moduleMessageHandlers__ || {};
  window.__moduleMessageHandlers__['heatmap'] = function (msg) {
    if (!msg || !msg.action) return;

    if (msg.action === 'LOADING_PROGRESS') {
      var phase = msg.data ? msg.data.phase : '';
      var progress = msg.data ? msg.data.progress : 0;
      showLoading(true, getProgressText(phase) + ' ' + progress + '%');
    }
  };

  function getProgressText(phase) {
    var map = {
      'fetching': '正在获取数据',
      'dedup': '数据去重处理',
      'aggregating': '正在聚合热力图数据',
      'detecting': '异常检测中',
      'done': '完成'
    };
    return map[phase] || phase;
  }

  console.log('[Heatmap] 模块 content.js 已加载 v2.0');

})();
