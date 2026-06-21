/* ==========================================
   每日工作看板 v2.2.51 — content.js
   表格式密集视图 + 标签筛选 + 报告富化 + CloudBase 直连同步
   ========================================== */

(function () {
  'use strict';

  /* ── 模块注册 ── */
  const MODULE = { name: 'dailyboard', init: init, destroy: destroy };
  if (typeof window.__toolboxRegisterModule === 'function') {
    window.__toolboxRegisterModule(MODULE);
  } else {
    window.addEventListener('toolbox:ready', function () {
      if (typeof window.__toolboxRegisterModule === 'function') window.__toolboxRegisterModule(MODULE);
    });
  }

  /* ── 进度推送监听（SW → content.js）── */
  chrome.runtime.onMessage.addListener(function (msg, sender) {
    if (msg && msg.action === 'DAILYBOARD_ENRICH_PROGRESS') {
      // 更新进度状态
      state.enrichmentProgress = { done: msg.done || 0, total: msg.total || 0 };
      state.enrichmentStatus = (msg.finished) ? 'done' : 'fetching';
      updateEnrichUI();
    }
  });

  /* ── 常量 ── */
  const WORK_DOMAIN = location.origin;
  const SCHEDULE_API = '/prod-api/student-center-ai/regularCourse/next/class/list';
  const SIDEBAR_WIDTH = 420;
  const WAIT_MINUTES = 30;
  const NARROW_THRESHOLD = 900;

  /** 7 × 7 映射 */
  const CATS = [
    { id: 1, label: '今天有课-未上课',    icon: '🕐', action: '等待上课',                    hasCB: false, rowCls: 'db-row--cat1', actionCls: 'db-action--info' },
    { id: 2, label: '今天有课-正在上课',   icon: '🏫', action: '正在上课',                    hasCB: false, rowCls: 'db-row--cat2', actionCls: 'db-action--info' },
    { id: 3, label: '已下课-无报告',       icon: '⚠️', action: '📞 电话重新约课排课',         hasCB: true,  rowCls: 'db-row--cat3', actionCls: 'db-action--warn' },
    { id: 4, label: '已下课-优秀',         icon: '⭐', action: '📝 要笔记/抽查/重复',          hasCB: true,  rowCls: 'db-row--cat4', actionCls: '' },
    { id: 5, label: '已下课-敷衍但会',     icon: '👌', action: '✅ 抽查/完整重复',             hasCB: true,  rowCls: 'db-row--cat5', actionCls: '' },
    { id: 6, label: '已下课-敷衍',         icon: '🚨', action: '📞 电话联系家长',              hasCB: true,  rowCls: 'db-row--cat6', actionCls: 'db-action--danger' },
    { id: 7, label: '今天没课',             icon: '💬', action: '💬 私聊布置题目',               hasCB: true,  rowCls: 'db-row--cat7', actionCls: '' },
  ];

  /** 从报告 overallTag 映射到分类（与学习报告 content.js 四维评价逻辑一致）
   *  ⭐优秀→cat4 / 👍认真→cat4 / 🚨敷衍但会→cat5 / ⚠️需辅导/需关注→cat5 / 🔴敷衍→cat6 / 无标签→cat6(默认跟进)
   */
  function catFromReportTag(overallTag) {
    if (!overallTag) return 6; // 无标签 → 默认需要跟进
    // 按优先级从长到短匹配（"敷衍但会" 必须在 "敷衍" 之前）
    if (overallTag.indexOf('优秀') !== -1) return 4;       // ⭐优秀
    if (overallTag.indexOf('认真') !== -1) return 4;         // 👍认真
    if (overallTag.indexOf('敷衍但会') !== -1) return 5;     // 🚨敷衍但会（必须在"敷衍"前！）
    if (overallTag.indexOf('敷衍') !== -1) return 6;         // 🔴敷衍
    if (overallTag.indexOf('需辅导') !== -1 ||
        overallTag.indexOf('需关注') !== -1 ||
        overallTag.indexOf('异常') !== -1) return 5;          // ⚠️需辅导/需关注
    return 6; // 兜底：未知标签 → 需跟进
  }

  /* ── 状态 ── */
  let state = {
    teacher: {},
    rawRows: [],           // API 原始数据
    students: [],          // 映射后 + 富化后
    categories: null,      // { 1:[], 2:[], ... }
    searchKeyword: '',
    activeFilter: 0,       // 0=全部, 1-7=分类
    syncStatus: 'idle',
    lastSyncTime: null,
    lastDataFetchTime: null,  // 数据获取时间
    dayRates: { totalStudents: 0, listenCount: 0, hwDoneCount: 0 },  // 当日听课率/作业完成率
    settingsConfigured: false,
    enrichmentStatus: 'idle', // 'idle'|'fetching'|'done'|'error'
    enrichmentError: null,
    enrichmentProgress: { done: 0, total: 0 },
    viewDate: null,         // 当前查看日期（null=今天）
    isHistoryMode: false,   // 是否历史模式（只读）
    viewMode: 'date',       // 'date' | 'lecture' — 日期视角 vs 课节视角
    lectureCourses: [293],  // 课节视角选中的课程 aiCourseId 列表（默认293=主课）
    lectureLecNum: null,    // 课节视角选中的讲次号（如 "15"）
    lectures: [],           // 可选课节列表 [{lecNum, label, lessonNames, periodIds, studentCount, latestDate}]
    courseList: [],         // 教师所有课程 [{aiCourseId, title, studentCount}]
    sortCol: '',           // 当前排序列: 'name'|'time'|'ansrate'|'duration'|'firstrate'
    sortDir: 0,            // 0=默认 1=升序 -1=降序（三态循环）
  };

  let panelEl = null;
  let panelRoot = null;
  let doneMap = {};   // { studentId: true }

  /* ── 不专注率主动提醒 ── */
  let _nfMonitor = {
    timer: null,        // setInterval 句柄
    lastScan: 0,        // 上次扫描时间戳
    alerted: {},        // 去重: "studentId_periodId" → true
    enabled: true,      // 默认开启
  };
  const NF_THRESHOLD = 40;
  const NF_SCAN_INTERVAL = 1200000;  // 20分钟
  const NF_CHECK_INTERVAL = 60000;   // 1分钟检查一次
  const NF_EARLIEST_HOUR = 8;
  const NF_LATEST_HOUR = 23;

  /* ── 初始化 & 销毁 ── */
  function init() { loadSettings(); loadDoneStatus(); loadBoundStudents(); }
  function loadBoundStudents() {
    return new Promise(function (resolve) {
      chrome.storage.local.get(['db_boundStudents'], function (d) {
        if (chrome.runtime.lastError) {
          console.warn('[DailyBoard] 加载绑定学生失败:', chrome.runtime.lastError.message);
        } else if (d.db_boundStudents && d.db_boundStudents.length > 0) {
          window.__db_boundStudents = d.db_boundStudents;
          console.log('[DailyBoard] 加载绑定学生:', d.db_boundStudents.length, '人');
        }
        resolve();
      });
    });
  }
  function destroy() { closePanel(true); panelEl = null; panelRoot = null; }

  /* ── Storage ── */
  async function loadSettings() {
    chrome.storage.local.get(['db_teacherSubject', 'db_teacherGrade', 'db_teacherCenter', 'db_teacherName'], function (d) {
      state.teacher = state.teacher || {};
      if (d.db_teacherName) state.teacher.name = d.db_teacherName;
      if (d.db_teacherSubject) state.teacher.subject = d.db_teacherSubject;
      if (d.db_teacherGrade) state.teacher.grade = d.db_teacherGrade;
      if (d.db_teacherCenter) state.teacher.center = d.db_teacherCenter;
      state.settingsConfigured = !!(state.teacher.subject || state.teacher.grade);
    });
  }
  async function saveSettings(subject, grade, center) {
    chrome.storage.local.set({ db_teacherSubject: subject || '', db_teacherGrade: grade || '', db_teacherCenter: center || '' });
    state.settingsConfigured = true;
  }
  async function loadDoneStatus() {
    var k = 'db_done_' + (state.viewDate || todayKey());
    var d = await chrome.storage.local.get([k]);
    try { doneMap = JSON.parse(d[k] || '{}'); } catch (e) { doneMap = {}; }
  }
  async function saveDoneStatus() {
    chrome.storage.local.set({ ['db_done_' + (state.viewDate || todayKey())]: JSON.stringify(doneMap) });
  }
  function dateKey(optionalDate) {
    var d = optionalDate ? new Date(optionalDate) : new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  /** 获取今天的 dateKey */
  function todayKey() { return dateKey(); }

  /** 构建日期选择器 option 列表（今天 + 近7天 + 近30天） */
  function buildDateOptions(selectedDateStr) {
    var today = todayKey();
    var opts = '<option value="' + today + '">📅 今天 ' + today + '</option>';
    // 近7天
    for (var i = 1; i <= 7; i++) {
      var d = new Date(); d.setDate(d.getDate() - i);
      var ds = dateKey(d);
      var label = i <= 1 ? '昨天' : (i <= 6 ? ['', '一', '二', '三', '四', '五'][i] + '天前' : '');
      opts += '<option value="' + ds + '"' + (ds === selectedDateStr ? ' selected' : '') + '>📅 ' + (label || ds) + ' ' + ds + '</option>';
    }
    // 分隔 + 近30天
    opts += '<option disabled>─── 更早 ───</option>';
    for (var j = 8; j <= 30; j++) {
      var d2 = new Date(); d2.setDate(d2.getDate() - j);
      var ds2 = dateKey(d2);
      opts += '<option value="' + ds2 + '"' + (ds2 === selectedDateStr ? ' selected' : '') + '>' + ds2 + '</option>';
    }
    return opts;
  }

  /** 切换查看日期 */
  async function switchToDate(dateStr) {
    var isToday = (dateStr === todayKey());
    state.viewDate = isToday ? null : dateStr;
    state.isHistoryMode = !isToday;

    if (state.isHistoryMode) {
      // 历史模式：双源分离加载（doneMap云端 + 排课/报告API实时）
      _progressLastTime = 0;  // 重置进度计时器
      panelRoot.innerHTML = '<style>' + buildCSS() + '</style>' +
        '<div class="db-header"><div class="db-titlebar"><span class="db-title-text">📊 每日工作看板</span></div><button class="db-close-btn" id="db-close">✕</button></div>' +
        '<div class="db-loading-wrap"><div class="db-spinner"></div><span class="db-loading-text">步骤 1/5 · 拉取排课数据...</span><div class="db-progress-bar"><div class="db-progress-fill" style="width:20%"></div></div></div>';
      var closeBtn = panelRoot.getElementById('db-close');
      if (closeBtn) closeBtn.addEventListener('click', closePanel);

      var histData = await loadHistoryData(dateStr);
      if (histData && histData.students && histData.students.length > 0) {
        state.students = histData.students;
        state.dayRates = histData.dayRates || { totalStudents: 0, listenCount: 0, hwDoneCount: 0 };
        state.lastDataFetchTime = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        // 恢复云端 doneMap（教师手动打勾，不可重现）
        doneMap = histData.doneMap || {};
        state.categories = classifyStudents(state.students, new Date());
        var p = calcProgress(state.categories);
        renderContent(teacherName(), state.categories, p);
      } else {
        panelRoot.innerHTML = '<style>' + buildCSS() + '</style>' +
          '<div class="db-header"><div class="db-titlebar"><span class="db-title-text">📊 每日工作看板</span><select class="db-date-picker" id="db-date-picker">' + buildDateOptions(dateStr) + '</select><span class="db-history-badge">📅 历史模式-只读</span></div><button class="db-close-btn" id="db-close">✕</button></div>' +
          '<div style="padding:40px 20px;text-align:center;color:#aaa;font-size:13px;">📭 ' + dateStr + ' 无历史数据</div>';
        var c2 = panelRoot.getElementById('db-close'); if (c2) c2.addEventListener('click', closePanel);
        var dp2 = panelRoot.getElementById('db-date-picker'); if (dp2) dp2.addEventListener('change', onDatePickerChange);
      }
    } else {
      // 回到今天：优先 sessionStorage 缓存秒出，无缓存再走完整加载
      _progressLastTime = 0;
      doneMap = {};
      await loadDoneStatus();

      var cr = readCache(_pck(todayKey()));
      var cached = cr.data;

      if (cr.hit && cached && cached.students && cached.students.length > 0) {
        state.students = cached.students;
        state.dayRates = cached.dayRates || { totalStudents: 0, listenCount: 0, hwDoneCount: 0 };
        state.lastDataFetchTime = cached.lastDataFetchTime;
        state.enrichmentStatus = 'done';
        state.categories = classifyStudents(cached.students, new Date());
        var p = calcProgress(state.categories);
        renderContent(teacherName(), state.categories, p);
        loadData(true);  // 后台静默刷新
      } else {
        loadData();
      }
    }
  }

  /** 日期选择器 change 事件 */
  function onDatePickerChange(e) {
    switchToDate(e.target.value);
  }

  /* ── 工具 ── */
  function esc(s) { if (!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  /** 解析时长字符串 → 分钟数（小数）; "0min0s"→0, "5min30s"→5.5, "15min0s"→15 */
  function parseDuration(dur) {
    if (!dur || dur === '0min0s') return 0;
    var m = String(dur).match(/(\d+)min(\d*)s?/);
    if (!m) return 0;
    return Number(m[1]) + (m[2] ? Number(m[2]) / 60 : 0);
  }
  function parseTime(v) {
    if (!v && v !== 0) return new Date(0);
    if (v instanceof Date) return v;
    var sv = String(v).trim();
    // 空字符串 → 无效
    if (sv === '' || sv === '0') return new Date(0);
    // 13位毫秒时间戳（字符串或数字）
    if (/^\d{13}$/.test(sv)) return new Date(parseInt(sv, 10));
    // 10位秒级时间戳 → *1000
    if (/^\d{10}$/.test(sv)) return new Date(parseInt(sv, 10) * 1000);
    var d = new Date(v);
    if (isNaN(d.getTime())) {
      var m = sv.match(/(\d{1,2}):(\d{2})/);
      if (m) { d = new Date(); d.setHours(+m[1], +m[2], 0, 0); }
      else return new Date(0);
    }
    // 年份 < 2024 视为无效（保护老时间戳/epoch 0）
    if (d.getFullYear() < 2024) return new Date(0);
    return d;
  }
  function fmtHM(d) { return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
  function fmtTimeRange(start, end) { return fmtHM(start) + '-' + fmtHM(end); }
  function teacherName() { return state.teacher.name || '辅导老师'; }

  /* ── API ── */
  async function workApi(path, params) {
    var url = new URL(path, WORK_DOMAIN);
    Object.keys(params || {}).forEach(function (k) {
      if (params[k] !== undefined && params[k] !== null && params[k] !== '') url.searchParams.set(k, params[k]);
    });
    console.log('[DailyBoard] GET', url.toString());
    var resp = await fetch(url.toString(), { credentials: 'include', headers: { 'Accept': 'application/json' } });
    var text = await resp.text();
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + text.substring(0, 200));
    var json;
    try { json = JSON.parse(text); } catch (e) {
      console.error('[DailyBoard] JSON解析失败, 原始响应前200字符:', text.substring(0, 200));
      throw new Error('非JSON响应(' + path + '): ' + text.substring(0, 100));
    }
    var ok = ['000000', '0', '200', 0, 200];
    if (json.code !== undefined && ok.indexOf(json.code) === -1) throw new Error('API(' + json.code + '): ' + (json.msg || json.mesg || ''));
    return json;
  }

  async function workApiPost(path, body) {
    var url = new URL(path, WORK_DOMAIN);
    console.log('[DailyBoard] POST', url.toString(), JSON.stringify(body));
    var resp = await fetch(url.toString(), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body),
    });
    var text = await resp.text();
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    var json; try { json = JSON.parse(text); } catch (e) { throw new Error('非JSON'); }
    var ok = ['000000', '0', '200', 0, 200];
    if (json.code !== undefined && ok.indexOf(json.code) === -1) throw new Error('API(' + json.code + '): ' + (json.msg || json.mesg || ''));
    return json;
  }

  /** 获取当前登录教师姓名 */
  async function fetchTeacherName() {
    try {
      var json = await workApi('/prod-api/authorization/account/getUser', { application: 'aiXin' });
      var name = (json && json.data && json.data.name) || '';
      console.log('[DailyBoard] 当前教师:', name || '(未获取到)');
      return name;
    } catch (e) {
      console.warn('[DailyBoard] 获取教师姓名失败:', e.message);
      return '';
    }
  }

  /**
   * 检测并切换教师（登录账号变化时自动切换）
   * @returns {Promise<boolean>} true=发生了切换
   */
  async function checkTeacherSwitch() {
    var apiName = await fetchTeacherName();
    if (!apiName) return false; // API 失败，不处理

    var oldName = state.teacher.name || '';
    if (oldName && apiName !== oldName) {
      // 发生切换
      console.log('[DailyBoard] 🔄 检测到教师切换: ' + oldName + ' → ' + apiName);
      // 清内存数据
      state.students = [];
      state.categories = null;
      state.dayRates = { totalStudents: 0, listenCount: 0, hwDoneCount: 0 };
      doneMap = {};
      window.__db_boundStudents = [];
      // 清 sessionStorage 缓存（排课数据 + 富化缓存）
      try {
        var keys = Object.keys(sessionStorage);
        for (var i = 0; i < keys.length; i++) {
          if (keys[i].indexOf('db_cache_') === 0 || keys[i].indexOf('db_enrich_') === 0) {
            sessionStorage.removeItem(keys[i]);
          }
        }
      } catch (_) {}
      // 清 chrome.storage.local 中的富化缓存和绑定数据
      try {
        chrome.storage.local.get(null, function (all) {
          var toRemove = [];
          Object.keys(all).forEach(function (k) {
            if (k.indexOf('db_enrich_cache_') === 0 || k === 'db_boundStudents') {
              toRemove.push(k);
            }
          });
          if (toRemove.length) chrome.storage.local.remove(toRemove);
        });
      } catch (_) {}
      // 更新教师信息
      state.teacher.name = apiName;
      chrome.storage.local.set({ db_teacherName: apiName, db_boundStudents: [] });
      return true;
    }
    if (!oldName && apiName) {
      // 首次使用，设置教师名
      state.teacher.name = apiName;
      chrome.storage.local.set({ db_teacherName: apiName });
    }
    return false;
  }

  async function fetchSchedule(targetDate) {
    console.log('[DailyBoard] 获取排课...', targetDate ? ('(历史: ' + targetDate + ')') : '');
    var t = targetDate || dateKey();
    var paramsList = [
      { label: '无classStatus+日期', data: { startDate: t + ' 00:00:00', endDate: t + ' 23:59:59', current: '1', size: '500' } },
      { label: 'classStatus=1+日期', data: { startDate: t + ' 00:00:00', endDate: t + ' 23:59:59', classStatus: '1', current: '1', size: '500' } },
      { label: 'classStatus=0+日期', data: { startDate: t + ' 00:00:00', endDate: t + ' 23:59:59', classStatus: '0', current: '1', size: '500' } },
    ];
    function extractRows(json) {
      try {
        var data = json && json.data;
        // 详细诊断：打印完整返回结构和 data 类型
        console.log('[DailyBoard] 🔍 排课API返回 code=' + json.code + ' | dataType=' + (Array.isArray(data) ? 'array[' + data.length + ']' : typeof data) + ' | keys=' + (data && typeof data === 'object' ? Object.keys(data).join(',') : 'N/A'));
        if (!data) return [];
        // 情况1：data 本身就是数组
        if (Array.isArray(data)) return data;
        // 情况2：data 是对象，查找数组子字段
        if (typeof data === 'object') {
          var fields = ['classList', 'rows', 'list', 'records', 'items', 'content'];
          for (var fi = 0; fi < fields.length; fi++) {
            if (Array.isArray(data[fields[fi]])) {
              console.log('[DailyBoard] ✅ 从字段', fields[fi], '提取到', data[fields[fi]].length, '条');
              return data[fields[fi]];
            }
          }
          // 情况3：data 是单个学生对象（有 studentId 或 userId）— 包装为数组
          if (data.studentId || data.userId || data.studentName) {
            console.log('[DailyBoard] ⚠️ data是单对象(非数组)，包装为1条:', data.studentId || data.userId);
            return [data];
          }
          // 情况4：data 有 records/total 分页结构
          if (data.records && Array.isArray(data.records)) return data.records;
        }
        console.warn('[DailyBoard] ⚠️ 无法从data中提取数组, rawKeys=', Object.keys(data).join(','));
        return [];
      } catch (err) {
        console.warn('[DailyBoard] 排课数据解析异常:', err.message);
        return [];
      }
    }

    // 先尝试 GET（部分环境GET可用），如果全部空则尝试 POST
    for (var i = 0; i < paramsList.length; i++) {
      try {
        var json = await workApi(SCHEDULE_API, paramsList[i].data);
        var rows = extractRows(json);
        // 剔除「非应出勤」学员
        rows = rows.filter(function(r) { return r.attendanceRequired === 1; });
        if (rows.length > 0) { console.log('[DailyBoard] ✅', paramsList[i].label, rows.length + '条'); return rows; }
      } catch (e) { console.warn('[DailyBoard]', paramsList[i].label, 'GET失败:', e.message); }
    }

    // GET 全部返回空 → 尝试 POST
    console.log('[DailyBoard] 🔄 GET全部为空，改试POST...');
    for (var j = 0; j < paramsList.length; j++) {
      try {
        var postJson = await workApiPost(SCHEDULE_API, paramsList[j].data);
        var postRows = extractRows(postJson);
        // 剔除「非应出勤」
        postRows = postRows.filter(function(r) { return r.attendanceRequired === 1; });
        if (postRows.length > 0) { console.log('[DailyBoard] ✅[POST]', paramsList[j].label, postRows.length + '条'); return postRows; }
      } catch (e2) { console.warn('[DailyBoard]', paramsList[j].label, 'POST失败:', e2.message); }
    }
    console.warn('[DailyBoard] ⚠️ 全部组合返回空');
    return [];
  }

  /** 获取教师所有课程列表（含学生人数） */
  async function fetchAllCourses() {
    try {
      var json = await workApi('/prod-api/student-center-ai/ai/teacher/course/list', {});
      var courses = (json && json.data) || [];
      if (!Array.isArray(courses)) courses = [];
      console.log('[DailyBoard] 课程列表:', courses.length + '门');
      return courses.map(function (c) {
        return {
          aiCourseId: Number(c.aiCourseId || c.id || 0),
          title: c.title || c.courseName || '',
          subject: c.subject || '',
          grade: c.grade || '',
          studentCount: 0, // 后续从排课数据填充
        };
      });
    } catch (e) {
      console.warn('[DailyBoard] 获取课程列表失败:', e.message);
      return [];
    }
  }

  /** 拉取全学期排课数据（用于课节视角） */
  async function fetchScheduleWide(startDate, endDate) {
    console.log('[DailyBoard] 🔍 全学期排课:', startDate, '~', endDate);
    var tStart = startDate + ' 00:00:00';
    var tEnd = endDate + ' 23:59:59';
    var paramsList = [
      { label: 'classStatus=2+全学期', data: { startDate: tStart, endDate: tEnd, classStatus: '2', current: '1', size: '500' } },
      { label: 'classStatus=1+全学期', data: { startDate: tStart, endDate: tEnd, classStatus: '1', current: '1', size: '500' } },
      { label: 'classStatus=0+全学期', data: { startDate: tStart, endDate: tEnd, classStatus: '0', current: '1', size: '500' } },
    ];

    function extractRows(json) {
      try {
        var data = json && json.data;
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          var fields = ['classList', 'rows', 'list', 'records', 'data', 'items', 'content'];
          for (var fi = 0; fi < fields.length; fi++) {
            if (data && Array.isArray(data[fields[fi]])) { data = data[fields[fi]]; break; }
          }
          if (!Array.isArray(data)) data = [];
        }
        return Array.isArray(data) ? data : [];
      } catch (err) {
        console.warn('[DailyBoard] 全学期排课数据解析异常:', err.message);
        return [];
      }
    }

    var allRows = [];
    for (var i = 0; i < paramsList.length; i++) {
      var page = 1;
      while (true) {
        try {
          var params = Object.assign({}, paramsList[i].data);
          params.current = String(page);
          var json = await workApi(SCHEDULE_API, params);
          var rows = extractRows(json);
          console.log('[DailyBoard] 全学期', paramsList[i].label, '第' + page + '页', rows.length + '条');
          allRows = allRows.concat(rows);
          var totalPages = Number((json && json.data && json.data.pages)) || 1;
          if (page >= totalPages || rows.length === 0) break;
          page++;
        } catch (e) {
          console.warn('[DailyBoard] 全学期', paramsList[i].label, '第' + page + '页失败:', e.message);
          break;
        }
      }
    }
    console.log('[DailyBoard] 全学期排课总计:', allRows.length + '条');
    return allRows;
  }

  /** 带缓存的排课拉取（同参数30秒内复用） */
  var _scheduleWideCache = null;
  var _scheduleWideCacheKey = '';
  var _scheduleWideCacheTime = 0;
  async function fetchScheduleWideCached(startDate, endDate) {
    var key = startDate + '|' + endDate;
    var now = Date.now();
    if (_scheduleWideCache && _scheduleWideCacheKey === key && (now - _scheduleWideCacheTime) < 30000) {
      console.log('[DailyBoard] ♻️ 复用排课缓存:', _scheduleWideCache.length + '条');
      return _scheduleWideCache;
    }
    _scheduleWideCache = await fetchScheduleWide(startDate, endDate);
    _scheduleWideCacheKey = key;
    _scheduleWideCacheTime = now;
    return _scheduleWideCache;
  }

  /** 从排课数据提取课节列表（按讲号合并多课程） */
  function extractLectures(scheduleRows, courseIds) {
    var cidSet = {};
    courseIds.forEach(function (id) { cidSet[id] = true; });

    // 按讲号（第N讲）分组，合并多课程的 students 和 periodIds
    var lectureMap = {}; // key: "第N讲" → { lessonName, periodIds: [], totalStudents, latestDate }
    var seenKeys = {};   // 去重: key="lessonName|aiCourseId" → { userIds: {}, pid, latestDate }

    scheduleRows.forEach(function (r) {
      var cid = Number(r.aiCourseId);
      if (!cidSet[cid]) return;
      var ln = r.lessonName || '';
      var pid = String(r.aiPeriodId || '');
      var uid = String(r.studentId || r.userId || '');
      if (!ln || !pid) return;

      // 提取讲号
      var m = ln.match(/第(\d+)讲/);
      if (!m) return;
      var lecNum = m[1];

      // 同课程同讲号，用 userId 去重（同一学生不同日期上同一讲只算1人）
      var dupKey = ln + '|' + cid;
      if (!seenKeys[dupKey]) {
        seenKeys[dupKey] = { userIds: {}, pid: pid, latestDate: '' };
      }
      seenKeys[dupKey].userIds[uid] = true;
      var cd = r.classDate || '';
      if (cd > seenKeys[dupKey].latestDate) seenKeys[dupKey].latestDate = cd;

      if (!lectureMap[lecNum]) lectureMap[lecNum] = { lecNum: lecNum, lessonNames: [], periodIds: [], totalStudents: 0, latestDate: '' };
    });

    // 合并同讲号、去重 periodIds
    Object.entries(seenKeys).forEach(function (entry) {
      var key = entry[0], info = entry[1];
      var m = key.match(/第(\d+)讲/);
      if (!m) return;
      var lecNum = m[1];
      var lm = lectureMap[lecNum];
      if (!lm) return;
      if (lm.periodIds.indexOf(info.pid) === -1) lm.periodIds.push(info.pid);
      lm.lessonNames.push(key.split('|')[0]);
      lm.totalStudents += Object.keys(info.userIds).length;  // 按唯一userId计数
      if (info.latestDate > lm.latestDate) lm.latestDate = info.latestDate;
    });

    // 转数组，按讲号排序
    var lectures = Object.values(lectureMap).map(function (lm) {
      return {
        lecNum: lm.lecNum,
        label: '第' + lm.lecNum + '讲',
        lessonNames: lm.lessonNames,
        periodIds: lm.periodIds,
        studentCount: lm.totalStudents,
        latestDate: lm.latestDate,
      };
    });

    lectures.sort(function (a, b) { return parseInt(a.lecNum) - parseInt(b.lecNum); });

    console.log('[DailyBoard] 课节列表:', lectures.length + '讲(' + courseIds.length + '门课)');
    return lectures;
  }

  /** 获取课堂数据（支持历史日期筛选） */
  async function fetchClassroomData(targetDate) {
    console.log('[DailyBoard] 获取课堂数据...', targetDate ? '(筛选: ' + targetDate + ')' : '');
    var filterDate = targetDate || dateKey();
    var allRecords = [];
    var page = 1;
    while (true) {
      var json = await workApiPost('/prod-api/student-center-ai/ai/teacher/classroom/list', {
        current: String(page),
        size: '500',
        courseClassify: 3,
        operationType: 1,
      });
      var data = json && json.data;
      var records = data && data.records ? data.records : [];
      allRecords = allRecords.concat(records);
      var totalPages = Number(data && data.pages) || 1;
      if (page >= totalPages || records.length === 0) break;
      page++;
    }
    // 按目标日期筛选（课堂 API 返回全部数据，client 端按 classDate 过滤）
    var filtered = allRecords.filter(function (r) { return r.classDate === filterDate; });
    console.log('[DailyBoard] 课堂数据: 总' + allRecords.length + '条 → 筛选(' + filterDate + ') ' + filtered.length + '条');
    return filtered;
  }

  /** 获取正在上课学生的互动明细，计算不专注率（互动轮次≥5的场景占比） */
  async function fetchInteractionData(rawRows) {
    try {
      // 修复：onlineStatus 不可靠（129人有时长但 status=0），改用 classStatus + 有听课时长来判断
      var inClassRows = rawRows.filter(function (r) {
        if (!r) return false;
        var isInProgress = Number(r.classStatus) === 1;
        var hasDuration = r.inClassOnlineDuration && r.inClassOnlineDuration !== '0min0s';
        return isInProgress && hasDuration;
      });
      if (inClassRows.length === 0) return;

      // 按 studentId 去重（优先取 startTime 最新的课节，即最近的一节课）
      var sidMap = {};
      inClassRows.forEach(function (r) {
        var sid = String(r.studentId || '');
        if (!sid || !r) return;
        var existing = sidMap[sid];
        if (!existing) {
          sidMap[sid] = r;
        } else {
          // 取 startTime 更晚的（最新的课）
          var rStart = r.startTime ? new Date(r.startTime).getTime() : 0;
          var eStart = existing.startTime ? new Date(existing.startTime).getTime() : 0;
          if (rStart > eStart) sidMap[sid] = r;
        }
      });
      var uniqueRows = Object.values(sidMap);

      // 并行调用 module/data 接口（每批最多 5 个，避免并发过多）
      var batchSize = 5;
      for (var bi = 0; bi < uniqueRows.length; bi += batchSize) {
        var batch = uniqueRows.slice(bi, bi + batchSize);
        await Promise.all(batch.map(function (r) {
          // 防御：确保 row 存在
          if (!r) return Promise.resolve();
          var sid = String(r.studentId || '');
          var cid = String(r.courseId || '');
          var acid = String(r.aiCourseId || '');
          var aid = String(r.aiPeriodId || '');
          var mid = String(r.aiClassHourId || '');

          if (!sid || !mid) {
            r.__notFocusRate = null;
            r.__notFocusDetail = '';
            return Promise.resolve();
          }

          var url = '/prod-api/student-center-ai/ai/user/course/period/module/data'
            + '?userId=' + sid
            + '&courseId=' + cid
            + '&aiCourseId=' + acid
            + '&aiPeriodId=' + aid
            + '&moduleId=' + mid;

          return workApi(url, {})
            .then(function (json) {
              if (!json || !json.data || !json.data.clipList || json.data.clipList.length === 0) {
                r.__notFocusRate = null;
                r.__notFocusDetail = '';
                return;
              }
              var clips = json.data.clipList;
              var total = clips.length;
              var notFocused = clips.filter(function (c) { return c.interactChatNum >= 5; }).length;
              var rate = Math.round(notFocused / total * 100);
              r.__notFocusRate = rate;
              r.__notFocusDetail = notFocused + '/' + total + ' 场景轮次≥5';
            })
            .catch(function (e) {
              console.warn('[DailyBoard] 获取互动明细失败:', e.message);
              if (r) { r.__notFocusRate = null; r.__notFocusDetail = ''; }
            });
        }));
      }
    } catch (e) {
      console.warn('[DailyBoard] fetchInteractionData 异常（不影响主流程）:', e.message);
    }
  }

  /** 从排课数据计算当日两率（rawRows 来自 regularCourse/next/class/list，已有实时字段） */
  function calcDayRates(rawRows, targetDate) {
    var target = targetDate || dateKey();

    // 分母：今天排课总人数（去重 studentId）
    var scheduleSids = {};
    rawRows.forEach(function (r) {
      var sid = String(r.studentId || r.userId || '');
      if (sid) scheduleSids[sid] = true;
    });
    var totalStudents = Object.keys(scheduleSids).length;

    // 按 userId 去重统计（用 regularCourse API 返回的实时字段）
    var uMap = {};
    rawRows.forEach(function (r) {
      var uid = String(r.studentId || r.userId || '');
      if (!uid) return;
      if (!uMap[uid]) uMap[uid] = { listen: false, hwDone: false };

      // 有效听课：onlineStatus==1 或 inClassOnlineDuration 不为 "0min0s"
      var dur = r.inClassOnlineDuration || '';
      var isOnline = Number(r.onlineStatus) === 1;
      var hasDuration = dur && dur !== '0min0s' && dur !== '';
      if (isOnline || hasDuration) uMap[uid].listen = true;

      // 作业完成：homeworkCompletionStatus == 1
      if (Number(r.homeworkCompletionStatus) === 1) uMap[uid].hwDone = true;
    });

    var listenCount = 0, hwDoneCount = 0;
    for (var uid in uMap) {
      if (uMap[uid].listen) listenCount++;
      if (uMap[uid].hwDone) hwDoneCount++;
    }

    state.dayRates = {
      totalStudents: totalStudents,
      listenCount: listenCount,
      hwDoneCount: hwDoneCount,
    };
    console.log('[DailyBoard] 当日比率: 总人数=' + totalStudents + ' 有效听课=' + listenCount + ' 作业完成=' + hwDoneCount);
  }

  /** 加载历史日期数据：双源分离
   *   路A: CloudBase doneMap（教师手动打勾，不可重现）
   *   路B: API 实时拉取（排课→富化→课堂→两率，始终可重现计算） */
  async function loadHistoryData(dateStr) {
    console.log('[DailyBoard] 🔄 历史加载:', dateStr);
    // 初始 HTML 已设置 "步骤 1/5 · 拉取排课数据..."

    // ── 路A: CloudBase 读 doneMap（并行发起，不阻塞路B） ──
    var doneMapCloud = {};
    var cbPromise = new Promise(function (resolve) {
      chrome.runtime.sendMessage({
        action: 'DAILYBOARD_CB_QUERY',
        payload: {
          env: 'renewal-calendar-7ff2rtj4f876144',
          collection: 'teacher_daily_tasks',
          query: { date: dateStr, teacherName: state.teacher.name || '' },
        }
      }, function (resp) {
        if (resp && resp.ok && resp.data && resp.data.doneMap) {
          console.log('[DailyBoard] ☁️ doneMap 已加载:', Object.keys(resp.data.doneMap).length, '项');
          resolve(resp.data.doneMap);
        } else {
          console.log('[DailyBoard] ☁️ 无 doneMap（可能是首次加载或 query 失败）');
          resolve({});
        }
      });
    });

    // ── 路B: 排课 API + 课堂 API ──
    try {
      // Step 1: 拉取目标日期排课
      setLoadingProgress(1, 5, '拉取排课数据...');
      var rawRows = await fetchSchedule(dateStr);
      if (!rawRows || rawRows.length === 0) {
        console.warn('[DailyBoard] ' + dateStr + ' 无排课数据');
        return null;
      }

      // Step 2: 课堂数据
      setLoadingProgress(2, 5, '拉取课堂数据...');
      var classroomData = await fetchClassroomData(dateStr);
      calcDayRates(rawRows, classroomData, dateStr);

      // Step 3: 映射
      var students = rawRows.map(mapScheduleRow);

      // Step 3: 富化报告（查缓存 → SW 富化）
      var rowsForEnrich = rawRows.filter(function (r) {
        return Number(r.classStatus) === 2 || Number(r.reportVersion) > 0;
      });
      setLoadingProgress(3, 5, '分析报告 (' + rowsForEnrich.length + '人)...');
      var cacheKey = 'db_enrich_cache_' + dateStr;
      var cachedResults = await new Promise(function (r) {
        chrome.storage.local.get([cacheKey], function (d) { r(d[cacheKey] || null); });
      });
      var enrichResults;
      if (cachedResults && cachedResults.length > 0) {
        console.log('[DailyBoard] ♻️ 缓存命中:', cachedResults.length, '人');
        enrichResults = cachedResults;
      } else {
        enrichResults = await enrichWithReports(rowsForEnrich, true);
        if (enrichResults && enrichResults.length > 0) {
          chrome.storage.local.set({ [cacheKey]: enrichResults });
        }
      }
      var enrichMap = {};
      if (enrichResults && enrichResults.length > 0) {
        enrichResults.forEach(function (er) {
          if (er && er.data) enrichMap[String(er.data.studentId || '')] = er.data;
        });
      }
      students.forEach(function (s) {
        var enriched = enrichMap[s.studentId];
        if (enriched && !enriched.error) {
          s.overallTag = enriched.overallTag || null;
          s.overallTagClass = enriched.overallTagClass || null;
          s.masteryRating = enriched.masteryRating || null;
          s.participation = enriched.participation || null;
          s.askCount = enriched.askCount || 0;
          s.answerCount = enriched.answerCount || 0;
          s.firstCorrectRate = enriched.firstCorrectRate || '';
        } else if (enriched && enriched.error) {
          s.enrichError = enriched.error;
        }
      });

      // 等待路A完成
      setLoadingProgress(4, 5, '同步打勾状态...');
      doneMapCloud = await cbPromise;

      setLoadingProgress(5, 5, '完成');
      console.log('[DailyBoard] ✅ ' + dateStr + ' 双源分离加载完成: ' + students.length + '人');

      return {
        students: students,
        dayRates: state.dayRates || { totalStudents: students.length, listenCount: 0, hwDoneCount: 0 },
        doneMap: doneMapCloud,
      };
    } catch (e) {
      console.error('[DailyBoard] 历史加载失败:', e);
      return null;
    }
  }

  function mapScheduleRow(row) {
    // API 字段优先级：备注名 > 中文名 > 用户名 > 学生标识(手机号) > 真实名
    // 注意 studentName 是脱敏手机号(139****8818)，必须放最后！
    // classTimeStart/classTimeEnd 是 ISO 时间字符串（如 "2026-06-14 19:00:00"），
    // startTime 是 13 位毫秒时间戳。优先读 classTime 系列字段。
    var startTime = row.classTimeStart || row.startTime || row.classStartTime || row.scheduleTime || '';
    var endTime = row.classTimeEnd || row.endTime || row.classEndTime || row.classFinishTime || '';
    var sid = String(row.studentId || row.userId || '');
    var sname = row.remarkName || row.chineseName || row.userName || row.studentName || row.realName || '';
    return {
      studentId: sid,
      studentName: sname,
      className: row.className || row.courseName || '',
      gradeName: row.gradeName || row.grade || '',
      subjectName: row.subjectName || row.subject || '',
      scheduleTime: startTime,
      endTime: endTime,
      reportVersion: row.reportVersion || 0,
      onlineStatus: row.onlineStatus || '',
      homeworkStatus: row.homeworkCompletionStatus || '',
      homeworkStatusDesc: row.homeworkCompletionStatusDesc || '',
      inClassOnlineDuration: row.inClassOnlineDuration || '',
      // 富化字段（稍后填充）
      overallTag: null,
      overallTagClass: null,
      masteryRating: null,
      participation: null,
      diagnosis: null,
      enrichError: null,
      // 保留原始行（给 SW 用）
      _raw: row,
      // 不专注率（来自互动明细，仅正在上课学生有值）
      notFocusRate: (row && row.__notFocusRate != null) ? row.__notFocusRate : null,
      notFocusDetail: (row && row.__notFocusDetail) || '',
    };
  }

  /** 通过 SW 批量富化报告数据
   *  @param {Array} rawRows - 待富化的学生行
   *  @param {boolean} [silent] - 静默模式（后台刷新时不显示进度条）
   */
  async function enrichWithReports(rawRows, silent) {
    if (!rawRows || rawRows.length === 0) return [];
    // 对所有排课学生尝试富化（不依赖reportVersion，报告模块也不看reportVersion）
    // SW 会逐个尝试 biz→短链→aitutor100，拿不到的自然跳过
    console.log('[DailyBoard] 准备富化 ' + rawRows.length + ' 人...');

    state.enrichmentStatus = 'fetching';
    state.enrichmentProgress = { done: 0, total: rawRows.length };
    if (!silent) updateEnrichUI();

    return new Promise(function (resolve, reject) {
      console.log('[DailyBoard] 向 SW 发送富化请求:', rawRows.length + '人');
      chrome.runtime.sendMessage({
        action: 'DAILYBOARD_ENRICH_REPORTS',
        payload: { rawRows: rawRows },
      }, function (resp) {
        if (chrome.runtime.lastError) {
          state.enrichmentStatus = 'error';
          state.enrichmentError = chrome.runtime.lastError.message;
          resolve([]);
          return;
        }
        if (!resp || !resp.ok) {
          state.enrichmentStatus = 'error';
          state.enrichmentError = (resp && resp.error) || '未知错误';
          resolve([]);
          return;
        }
        state.enrichmentStatus = 'done';
        state.enrichmentProgress.done = rawRows.length;
        resolve(resp.data || []);
      });
    });
  }

  function updateEnrichUI() {
    if (!panelRoot) return;
    var el = panelRoot.getElementById('db-enrich-status');
    if (!el) return;
    if (state.enrichmentStatus === 'fetching') {
      var pct = state.enrichmentProgress.total > 0
        ? Math.round(state.enrichmentProgress.done / state.enrichmentProgress.total * 100)
        : 0;
      el.innerHTML = '<span>⏳ 获取报告中 ' + state.enrichmentProgress.done + '/' + state.enrichmentProgress.total + '（' + pct + '%）</span>'
        + '<div class="db-enrich-bar"><div class="db-enrich-fill" style="width:' + pct + '%"></div></div>';
      el.style.display = '';
    } else if (state.enrichmentStatus === 'error') {
      el.textContent = '⚠️ 报告获取失败: ' + (state.enrichmentError || '');
      el.style.display = '';
    } else {
      el.style.display = 'none';
    }
  }

  /* ── 分类引擎 ── */
  function classifyStudents(students, now) {
    var cats = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] };
    students.forEach(function (s) {
      // 没排课时间 → 分类7
      if (!s.scheduleTime) { s._catId = 7; s._catStatus = 'noclass'; cats[7].push(s); return; }

      var start = parseTime(s.scheduleTime);
      var end = parseTime(s.endTime);

      if (now < start) { s._catId = 1; s._catStatus = 'pending'; cats[1].push(s); return; }
      if (now >= start && now <= end) { s._catId = 2; s._catStatus = 'inclass'; cats[2].push(s); return; }

      // 已下课
      var minSinceEnd = (now - end) / 60000;
      var hasReport = !!s.overallTag; // 已从报告API拿到数据
      var reportVersionNum = Number(s.reportVersion) || 0;

      if (!hasReport && reportVersionNum === 0) {
        if (minSinceEnd < WAIT_MINUTES) {
          s._catId = 2; s._catStatus = 'waiting'; cats[2].push(s); // 等待报告
        } else {
          s._catId = 3; s._catStatus = 'noreport'; cats[3].push(s);
        }
      } else if (!hasReport && reportVersionNum > 0) {
        // 有报告版本号但没拿到数据 → 可能是富化失败 → 降级为分类3
        s._catId = 3; s._catStatus = 'noreport'; cats[3].push(s);
      } else {
        // 有报告数据
        var catId = catFromReportTag(s.overallTag);
        s._catId = catId;
        s._catStatus = catId === 4 ? 'good' : catId === 5 ? 'normal' : 'needfollow';
        cats[catId].push(s);
      }
    });

    // 第7类：学情表绑定学生（合并）
    var bound = window.__db_boundStudents || [];
    var sidSet = {};
    students.forEach(function (s) { sidSet[s.studentId] = true; });
    bound.forEach(function (bs) {
      if (!sidSet[bs.studentId]) {
        var ns = mapScheduleRow({ studentId: bs.studentId, remarkName: bs.remarkName, studentName: bs.studentName, gradeName: bs.grade || '' });
        ns._catId = 7; ns._catStatus = 'noclass'; cats[7].push(ns);
      }
    });

    return cats;
  }

  /* ── 统计 ── */
  function calcProgress(cats) {
    var need = 0, done = 0;
    [3, 4, 5, 6, 7].forEach(function (cid) {
      (cats[cid] || []).forEach(function (s) { need++; if (doneMap[s.studentId]) done++; });
    });
    return { needAction: need, done: done, pct: need > 0 ? Math.round(done / need * 100) : 0 };
  }

  /* ── UI 框架 ── */
  function renderPanel() {
    if (panelEl) { panelEl.remove(); panelEl = null; }
    var isNarrow = window.innerWidth < NARROW_THRESHOLD;

    panelEl = document.createElement('div');
    panelEl.id = 'db-right-panel';
    panelEl.className = 'db-panel' + (isNarrow ? ' db-panel--narrow' : '');
    panelEl.style.position = 'fixed';
    panelEl.style.top = '0';
    panelEl.style.zIndex = '2147483645';
    panelEl.style.background = '#fff';
    panelEl.style.display = 'flex';
    panelEl.style.flexDirection = 'column';
    panelEl.style.fontFamily = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
    panelEl.style.fontSize = '13px';
    panelEl.style.color = '#1a1a1a';

    if (isNarrow) {
      // 窄窗口：居中浮动覆盖（不变）
      panelEl.style.left = '50%'; panelEl.style.top = '50%';
      panelEl.style.transform = 'translate(-50%, -50%)';
      panelEl.style.height = '80vh'; panelEl.style.width = '90vw';
      panelEl.style.maxWidth = '500px'; panelEl.style.borderRadius = '12px';
      panelEl.style.boxShadow = '0 8px 32px rgba(0,0,0,0.25)';
    } else {
      // 左侧定位：紧贴工具箱右侧，铺满剩余全部空间
      var sidebarEl = document.getElementById('tb-sidebar');
      var panelLeft = sidebarEl ? sidebarEl.getBoundingClientRect().right : SIDEBAR_WIDTH;
      if (panelLeft <= 0) panelLeft = SIDEBAR_WIDTH;
      panelEl.style.left = panelLeft + 'px';
      panelEl.style.height = '100vh';
      panelEl.style.width = (window.innerWidth - panelLeft) + 'px';
      panelEl.style.boxShadow = '2px 0 16px rgba(0,0,0,0.1)';
    }

    panelRoot = panelEl.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent = buildCSS();
    panelRoot.appendChild(style);

    document.body.appendChild(panelEl);

    if (isNarrow) {
      var ov = document.createElement('div'); ov.className = 'db-overlay'; ov.id = 'db-overlay';
      ov.addEventListener('click', closePanel); document.body.appendChild(ov);
    }
  }

  async function openPanel() {
    console.log('[DailyBoard/DIAG] openPanel — dateKey():', dateKey(), 'todayKey():', todayKey(), 'viewDate:', state.viewDate, 'isHistoryMode:', state.isHistoryMode);
    // 🔧 每次打开面板重置 viewDate 为今天（防止残留旧日期）
    state.viewDate = null;
    state.isHistoryMode = false;

    if (panelEl && panelEl.parentNode) {
      panelEl.style.transition = ''; panelEl.style.transform = ''; panelEl.style.opacity = '';
      return;
    }

    // ⚡ 先查 sessionStorage 缓存 — 命中则直接渲染，不显示"加载中..."
    var pck = _pck(dateKey());
    console.log('[DailyBoard/DIAG] 缓存key:', pck);
    var cr = readCache(pck);
    var cached = cr.data;
    console.log('[DailyBoard/DIAG] 缓存命中:', cr.hit, cached ? cached.students.length + '人' : 'N/A');

    // ⚡ 先加载学情绑定（await 确保完成后再渲染，否则 hasBound 判断会错误）
    await loadBoundStudents();

    renderPanel();  // 只创建壳（style + panelEl），不 append loader

    if (cr.hit && cached && cached.students && cached.students.length > 0) {
      state.students = cached.students;
      state.dayRates = cached.dayRates || { totalStudents: 0, listenCount: 0, hwDoneCount: 0 };
      state.lastDataFetchTime = cached.lastDataFetchTime;
      state.enrichmentStatus = 'done';
      state.categories = classifyStudents(cached.students, new Date());
      var p = calcProgress(state.categories);
      console.log('[DailyBoard] 缓存秒出:', cached.students.length, '人');
      await loadDoneStatus();
      renderContent(teacherName(), state.categories, p);
      // 后台静默刷新（过期时显示微提示）
      loadData(true);
    } else {
      // 无缓存：显示 loader 再加载
      var ldr = document.createElement('div');
      ldr.className = 'db-loading-wrap';
      ldr.innerHTML = '<div class="db-spinner"></div><span class="db-loading-text">步骤 1/4 · 读取设置...</span><div class="db-progress-bar"><div class="db-progress-fill" style="width:25%"></div></div>';
      panelRoot.appendChild(ldr);
      loadData();
    }
  }

  /* ── 不专注率提醒：监控函数 ── */
  function saveNfMonitorState() {
    try {
      sessionStorage.setItem('db_nf_monitor', JSON.stringify({
        alerted: _nfMonitor.alerted,
        lastScan: _nfMonitor.lastScan,
        enabled: _nfMonitor.enabled,
      }));
    } catch (e) { /* 非关键 */ }
  }

  function loadNfMonitorState() {
    try {
      var raw = sessionStorage.getItem('db_nf_monitor');
      if (raw) {
        var d = JSON.parse(raw);
        _nfMonitor.alerted = d.alerted || {};
        _nfMonitor.lastScan = d.lastScan || 0;
        _nfMonitor.enabled = d.enabled !== false;  // 默认 true
      }
    } catch (e) { /* 非关键 */ }
  }

  function inMonitorTimeRange() {
    var h = new Date().getHours();
    return h >= NF_EARLIEST_HOUR && h < NF_LATEST_HOUR;
  }

  function updateBellUI() {
    if (!panelRoot) return;
    var bell = panelRoot.getElementById('db-nf-bell');
    if (!bell) return;
    if (_nfMonitor.enabled) {
      bell.textContent = '\uD83D\uDD14';
      bell.title = '不专注提醒中（点击关闭）';
      bell.style.color = '#1976d2';
    } else {
      bell.textContent = '\uD83D\uDD15';
      bell.title = '不专注提醒已关闭（点击开启）';
      bell.style.color = '#999';
    }
    updateNfStatusUI();
  }

  /** 更新监控状态栏 */
  function updateNfStatusUI() {
    if (!panelRoot) return;
    var el = panelRoot.getElementById('db-nf-status');
    if (!el) return;
    if (!_nfMonitor.enabled || state.isHistoryMode) { el.style.display = 'none'; return; }
    el.style.display = '';
    var lastStr = _nfMonitor.lastScan ? new Date(_nfMonitor.lastScan).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '尚未';
    var nextMs = _nfMonitor.lastScan ? NF_SCAN_INTERVAL - (Date.now() - _nfMonitor.lastScan) : 0;
    var nextMin = Math.max(0, Math.ceil(nextMs / 60000));
    var nextStr = nextMin <= 0 ? '即将扫描' : nextMin + '分钟后';
    var alertCount = Object.keys(_nfMonitor.alerted).length;
    el.textContent = '\uD83D\uDD14 监控中 · 上次扫描 ' + lastStr + ' · 下次约' + nextStr + ' · 今日已提醒 ' + alertCount + ' 人';
  }

  function showNfNotification(alerts) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (alerts.length === 0) return;
    var now = new Date();
    var timeStr = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
    var lines = alerts.map(function (a) { return a.name + '  不专注 ' + a.rate + '%'; });
    var body = lines.join('\n') + '\n\n共 ' + alerts.length + ' 名学生走神率超标';
    var notif = new Notification('\u26a0\ufe0f 课堂走神提醒（' + timeStr + '）', {
      body: body,
      icon: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="8" fill="#f44336"/><text x="32" y="44" text-anchor="middle" font-size="36" fill="white">\u26a0</text></svg>'),
      tag: 'notfocus-alert',
      requireInteraction: true,
    });
    notif.onclick = function () { /* 纯提醒，不跳转 */ };
  }

  async function scanAndNotify() {
    if (!_nfMonitor.enabled) return;
    if (!state.rawRows || state.rawRows.length === 0) return;
    // 重新获取互动明细（state.rawRows 可能过期）
    await fetchInteractionData(state.rawRows);
    var alerts = [];
    state.rawRows.forEach(function (r) {
      if (!r) return;
      var rate = r.__notFocusRate;
      if (rate == null || rate < NF_THRESHOLD) return;
      // ≥15分钟才推送（否则数据不可靠）
      var _durMin = parseDuration(r.inClassOnlineDuration);
      if (_durMin < 15) return;
      var key = String(r.studentId || '') + '_' + String(r.aiPeriodId || r.classId || '');
      if (_nfMonitor.alerted[key]) return;
      _nfMonitor.alerted[key] = true;
      // 优先用备注名（绑定学情表），其次 row 自带的 remarkName，最后原始姓名
      var name = r.remarkName || '';
      if (!name && window.__db_boundStudents) {
        var bs = window.__db_boundStudents.find(function (b) { return String(b.studentId) === String(r.studentId); });
        if (bs && bs.remarkName) name = bs.remarkName;
      }
      if (!name) name = r.studentName || ('学员' + r.studentId);
      var grade = r.gradeName || '';
      alerts.push({ name: name + (grade ? '（' + grade + '）' : ''), rate: rate });
    });
    if (alerts.length > 0) {
      showNfNotification(alerts);
      console.log('[DailyBoard] \uD83D\uDD14 不专注提醒: ' + alerts.length + ' 名学生');
    }
    saveNfMonitorState();
    updateNfStatusUI();
  }

  function startNotFocusMonitor() {
    loadNfMonitorState();
    if (!_nfMonitor.enabled) return;
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    if (_nfMonitor.timer) clearInterval(_nfMonitor.timer);
    // 立即扫描一次
    _nfMonitor.lastScan = 0;
    scanAndNotify();
    _nfMonitor.lastScan = Date.now();
    saveNfMonitorState();
    updateNfStatusUI();
    _nfMonitor.timer = setInterval(function () {
      if (!_nfMonitor.enabled) return;
      if (!inMonitorTimeRange()) return;
      var now = Date.now();
      if (now - _nfMonitor.lastScan < NF_SCAN_INTERVAL) return;
      _nfMonitor.lastScan = now;
      saveNfMonitorState();
      scanAndNotify();
    }, NF_CHECK_INTERVAL);
  }

  function stopNotFocusMonitor() {
    if (_nfMonitor.timer) { clearInterval(_nfMonitor.timer); _nfMonitor.timer = null; }
  }

  function toggleNotFocusMonitor() {
    _nfMonitor.enabled = !_nfMonitor.enabled;
    saveNfMonitorState();
    updateBellUI();
    if (_nfMonitor.enabled) {
      startNotFocusMonitor();
      _nfMonitor.lastScan = 0;
    } else {
      stopNotFocusMonitor();
    }
  }

  function closePanel(immediate) {
    stopNotFocusMonitor();
    if (!panelEl) return;
    if (immediate) { panelEl.remove(); removeOverlay(); panelEl = null; return; }
    panelEl.style.transition = 'transform 300ms ease, opacity 300ms ease';
    panelEl.style.transform = 'translateX(-100%)'; panelEl.style.opacity = '0';
    removeOverlay();
    setTimeout(function () { if (panelEl) { panelEl.remove(); panelEl = null; } }, 300);
  }

  function removeOverlay() { var ov = document.getElementById('db-overlay'); if (ov) ov.remove(); }

  /* ── 表格式视图渲染 ── */
  function renderContent(teacherNameVal, cats, progress) {
    if (!panelRoot) return;
    panelRoot.innerHTML = '';

    var style = document.createElement('style');
    style.textContent = buildCSS();
    panelRoot.appendChild(style);

    // === 视角切换 Tab ===
    var tabBar = document.createElement('div');
    tabBar.className = 'db-viewtabs';
    tabBar.innerHTML =
      '<button class="db-viewtab' + (state.viewMode === 'date' ? ' db-viewtab--active' : '') + '" data-view="date">📅 日期视角</button>' +
      '<button class="db-viewtab' + (state.viewMode === 'lecture' ? ' db-viewtab--active' : '') + '" data-view="lecture">📚 课节视角</button>';
    panelRoot.appendChild(tabBar);

    // === 头部 ===
    var hdr = document.createElement('div');
    hdr.className = 'db-header';
    hdr.innerHTML =
      /* 全部一行：标题 | 教师信息 | 搜索框(弹性填充) | 统计 | 数据时间 | 按钮 */
      '<div class="db-titlebar">' +
        '<span class="db-title-icon">📊</span>' +
        '<span class="db-title-text">每日工作看板</span>' +
        '<select class="db-date-picker" id="db-date-picker" title="选择查看日期">' + buildDateOptions(state.viewDate || todayKey()) + '</select>' +
        (state.isHistoryMode ? '<span class="db-history-badge">📅 历史模式-只读</span>' : '') +
        '<span class="db-meta-inline">👤 ' + esc(teacherNameVal) +
          (state.teacher.subject ? ' · ' + esc(state.teacher.subject) : '') +
          (state.teacher.grade ? ' · ' + esc(state.teacher.grade) : '') +
          ' · ' + (state.viewDate || todayKey()) + '</span>' +
        '<input type="text" class="db-search-input" id="db-search" placeholder="🔍 搜索学生..." autocomplete="off">' +
        '<span class="db-stats-inline">需处理<b>' + progress.needAction + '</b> 已完成<b>' + progress.done + '</b> <b>' + progress.pct + '%</b></span>' +
        '<span class="db-data-time-label" id="db-data-time" ' + (state.lastDataFetchTime ? '' : 'style="display:none;"') + '>截取 ' + (state.lastDataFetchTime || '') + (state.isHistoryMode ? '（历史数据）' : '') + '</span>' +
        '<button class="db-btn db-btn--primary" id="db-export" title="导出Excel">📥</button>' +
        '<button class="db-btn db-btn--primary" id="db-settings" title="设置">⚙️</button>' +
        (!state.isHistoryMode ? '<button class="db-btn" id="db-switch-teacher" title="切换教师（检测到账号变化会自动切换）">👤 切换</button>' : '') +
        (!state.isHistoryMode ? '<button class="db-btn" id="db-refresh" title="刷新">🔄</button>' : '') +
        (!state.isHistoryMode ? '<button class="db-btn" id="db-nf-bell" title="不专注提醒中（点击关闭）" style="color:#1976d2;font-size:15px;">🔔</button>' : '') +
      '</div>' +
      '<button class="db-close-btn" id="db-close">✕</button>' +
      '</div>' +
      /* 监控状态栏 */
      '<div id="db-nf-status" style="font-size:11px;color:#666;padding:2px 12px 4px;display:none;"></div>' +
      /* 进度条 */
      '<div id="db-enrich-status" style="font-size:12px;color:#f57c00;margin-top:2px;display:none;"></div>' +
      /* 当日比率 */
      '<div class="db-dayrates" id="db-dayrates">' +
        '<span class="db-rate-item">🎧 有效听课率 <b>' + (state.dayRates.totalStudents > 0 ? Math.round(state.dayRates.listenCount / state.dayRates.totalStudents * 100) : 0) + '%</b></span>' +
        '<span class="db-rate-divider">|</span>' +
        '<span class="db-rate-item">📝 作业完成率 <b>' + (state.dayRates.totalStudents > 0 ? Math.round(state.dayRates.hwDoneCount / state.dayRates.totalStudents * 100) : 0) + '%</b></span>' +
        '<span class="db-rate-hint">（有效听课' + state.dayRates.listenCount + '人 / 作业完成' + state.dayRates.hwDoneCount + '人 / 排课' + state.dayRates.totalStudents + '人）</span>' +
      '</div>';
    panelRoot.appendChild(hdr);

    // === 标签筛选栏 ===
    var filterBar = document.createElement('div');
    filterBar.className = 'db-filter-bar';
    filterBar.id = 'db-filter-bar';
    var totalAll = 0;
    for (var k in cats) { if (Number(k) !== 7) totalAll += cats[k].length; }  // "全部" 不含第7类（今天没课）
    var chips = [
      { id: 0, label: '全部', count: totalAll },
    ];
    CATS.forEach(function (c) { chips.push({ id: c.id, label: c.icon + ' ' + c.label, count: (cats[c.id] || []).length }); });
    chips.forEach(function (ch) {
      var cls = 'db-filter-chip' + (state.activeFilter === ch.id ? ' db-filter-chip--active' : '');
      filterBar.innerHTML += '<span class="' + cls + '" data-filter="' + ch.id + '">' + ch.label + '<span class="db-filter-count"> ' + ch.count + '</span></span>';
    });
    panelRoot.appendChild(filterBar);

    // === 学情表绑定区 ===
    var hasBound = (window.__db_boundStudents && window.__db_boundStudents.length > 0);
    var boundCount = hasBound ? window.__db_boundStudents.length : 0;
    var bindWrap = document.createElement('div');
    bindWrap.className = 'db-bind-wrap';
    bindWrap.id = 'db-bind-wrap';
    var bannerHTML = hasBound
      ? '<div class="db-bind-banner" id="db-bind-banner" style="background:#e8f5e9;border-color:#c8e6c9;color:#2e7d32;">'
          + '✅ 已绑定 <b>' + boundCount + '</b> 名学生，<a role="button" id="db-bind-toggle">重新绑定</a> | <a role="button" id="db-bind-clear" style="color:#d32f2f;">清空绑定</a>'
        + '</div>'
      : '<div class="db-bind-banner" id="db-bind-banner">'
          + '📋 尚未绑定学情表，<a role="button" id="db-bind-toggle">点击粘贴学生数据</a>（用于第7类「今天没课」）'
        + '</div>';
    bindWrap.innerHTML =
      bannerHTML +
      '<div class="db-bind-body" id="db-bind-body" style="display:none;padding:10px 14px;background:#fafbfc;border-bottom:1px solid #e8eaed;">' +
        '<p style="margin:0 0 6px;font-size:12px;color:#666;">从学情表复制数据粘贴到下方（Tab制表符分隔，3列：备注名(或学员姓名)、ID、手机号，支持含/不含表头）：</p>' +
        '<textarea class="db-bind-textarea" id="db-bind-textarea" rows="5" style="width:100%;box-sizing:border-box;border:1px solid #ddd;border-radius:6px;padding:8px 10px;font-size:12px;font-family:Menlo,Consolas,monospace;resize:vertical;" placeholder="备注名&#9;ID&#9;报名手机号&#10;小张&#9;13912348818&#9;13800001111&#10;小李&#9;13800138000&#9;13900002222"></textarea>' +
        '<div style="margin-top:6px;display:flex;gap:8px;align-items:center;">' +
          '<button class="db-btn db-btn--primary" id="db-bind-parse">解析并绑定</button>' +
          '<span id="db-bind-msg" style="font-size:12px;color:#888;"></span>' +
        '</div>' +
      '</div>';
    panelRoot.appendChild(bindWrap);

    // === 表格 ===
    var tableWrap = document.createElement('div');
    tableWrap.className = 'db-table-wrap';
    var tableHTML = '<table class="db-table" id="db-table"><thead><tr>' +
      '<th class="db-th--action">动作</th>' +
      '<th class="db-th--cb">☐</th>' +
      '<th class="db-th--name" data-sort="name">姓名<span class="db-sort-arrow" data-sort-arrow="name"></span></th>' +
      '<th class="db-th--time" data-sort="time">时间<span class="db-sort-arrow" data-sort-arrow="time"></span></th>' +
      '<th class="db-th--status">状态</th>' +
      '<th class="db-th--level">评价</th>' +
      '<th class="db-th--ansrate" data-sort="ansrate">回答率<span class="db-sort-arrow" data-sort-arrow="ansrate"></span></th>' +
      '<th class="db-th--asks">提问</th>' +
      '<th class="db-th--answers">回答</th>' +
      '<th class="db-th--firstrate" data-sort="firstrate">首对%<span class="db-sort-arrow" data-sort-arrow="firstrate"></span></th>' +
      '<th class="db-th--duration" data-sort="duration">听课时长<span class="db-sort-arrow" data-sort-arrow="duration"></span></th>' +
      '<th class="db-th--homework" data-sort="homework">作业<span class="db-sort-arrow" data-sort-arrow="homework"></span></th>' +
      '<th class="db-th--tag">标签</th>' +
    '</tr></thead><tbody id="db-tbody"></tbody></table>';
    tableWrap.innerHTML = tableHTML;
    panelRoot.appendChild(tableWrap);

    // === 底部 ===
    var footer = document.createElement('div');
    footer.className = 'db-footer';
    var syncIcon = state.syncStatus === 'synced' ? '🟢' : state.syncStatus === 'error' ? '🔴' : '⚪';
    var syncText = state.syncStatus === 'syncing' ? '同步中...' : state.syncStatus === 'error' ? '同步失败' : state.lastSyncTime ? '已同步 ' + state.lastSyncTime : '待同步';
    footer.innerHTML =
      '<span class="db-sync-dot db-sync-dot--' + (state.syncStatus === 'synced' ? 'synced' : state.syncStatus === 'error' ? 'error' : 'pending') + '"></span>' +
      '<span>' + syncText + '</span>';
    panelRoot.appendChild(footer);

    // 填表
    renderTableBody(cats);

    // 绑定事件
    bindTableEvents();
  }

  /** 更新表头排序箭头 UI */
  function updateSortUI() {
    if (!panelRoot) return;
    panelRoot.querySelectorAll('.db-sort-arrow').forEach(function (el) {
      var col = el.dataset.sortArrow;
      if (col === state.sortCol) {
        el.textContent = state.sortDir > 0 ? ' ↑' : ' ↓';
      } else {
        el.textContent = '';
      }
    });
  }

  /** 对行数据排序（根据 state.sortCol / state.sortDir） */
  function sortRows(rows) {
    if (!state.sortCol || state.sortDir === 0) return rows;
    var dir = state.sortDir;
    var col = state.sortCol;
    return rows.slice().sort(function (a, b) {
      var va, vb;
      if (col === 'name') {
        va = (a.remarkName || a.studentName || '').toLowerCase();
        vb = (b.remarkName || b.studentName || '').toLowerCase();
        return dir * (va < vb ? -1 : va > vb ? 1 : 0);
      }
      if (col === 'time') {
        va = parseTime(a.scheduleTime) || 0;
        vb = parseTime(b.scheduleTime) || 0;
        return dir * (va - vb);
      }
      if (col === 'ansrate') {
        // 只按不专注率排序，不混合 answerRate（两者语义相反）
        // 有值的按数值排，没值的排末尾
        var ha = a.notFocusRate != null && a.notFocusRate !== undefined;
        var hb = b.notFocusRate != null && b.notFocusRate !== undefined;
        if (ha && hb) { return dir * (a.notFocusRate - b.notFocusRate); }
        if (ha) { return -1; }  // a有值b没值 → a排前
        if (hb) { return 1; }   // b有值a没值 → b排前
        return 0;               // 都没值保持原序
      }
      if (col === 'duration') {
        va = parseDuration(a.inClassOnlineDuration);
        vb = parseDuration(b.inClassOnlineDuration);
        return dir * (va - vb);
      }
      if (col === 'firstrate') {
        va = a.firstReplyRate != null ? a.firstReplyRate : -1;
        vb = b.firstReplyRate != null ? b.firstReplyRate : -1;
        return dir * (va - vb);
      }
      if (col === 'homework') {
        // homeworkStatus: -1=未解锁, 0=未完成, 1=已完成，没值的排最后
        va = a.homeworkStatus != null && a.homeworkStatus !== '' ? Number(a.homeworkStatus) : -2;
        vb = b.homeworkStatus != null && b.homeworkStatus !== '' ? Number(b.homeworkStatus) : -2;
        return dir * (va - vb);
      }
      return 0;
    });
  }

  function renderTableBody(cats) {
    var tbody = panelRoot && panelRoot.getElementById('db-tbody');
    if (!tbody) return;

    // 按筛选过滤
    var rows = [];
    if (state.activeFilter === 0) {
      for (var cid = 1; cid <= 6; cid++) rows = rows.concat(cats[cid] || []);  // "全部"仅显示今日有课(1-6类), 第7类"今天没课"单独查看
    } else {
      rows = cats[state.activeFilter] || [];
    }

    // 搜索过滤
    var kw = state.searchKeyword;
    if (kw) {
      rows = rows.filter(function (s) {
        return (s.studentName || '').toLowerCase().indexOf(kw) !== -1 || (s.studentId || '').indexOf(kw) !== -1;
      });
    }

    // 排序
    rows = sortRows(rows);

    var now = new Date();

    var html = '';
    for (var i = 0; i < rows.length; i++) {
      html += buildTableRow(rows[i], now);
    }

    if (rows.length === 0) {
      html = '<tr><td colspan="13" style="text-align:center;padding:24px;color:#aaa;font-size:13px;">📭 ' + (kw ? '无匹配学生' : '无数据') + '</td></tr>';
    }

    tbody.innerHTML = html;
  }

  /** 检测学生数据是否需要异常红底标记 */
  function needsAlert(s, field) {
    if (!s || !s._raw) return false;
    switch (field) {
      case 'level': { var rl = String(s._raw.userPeriodLevel || '').toUpperCase(); return rl === 'B' || rl === 'B+'; }
      case 'ansrate': return s.participation && s.participation.rate != null && s.participation.rate < 80;
      case 'duration':
        var dur = s.inClassOnlineDuration || '';
        var dm = dur.match(/(\d+)min/);
        return dm ? parseInt(dm[1], 10) < 96 : false;
      case 'homework': var hw = s.homeworkStatusDesc || ''; return hw && hw !== '已完成' && hw !== '-' && hw !== '未解锁';
      default: return false;
    }
  }

  function buildTableRow(s, now) {
    var catCfg = CATS[s._catId - 1];
    var isDone = !!doneMap[s.studentId];
    var rowCls = (catCfg && catCfg.rowCls ? catCfg.rowCls : '') + (isDone ? ' db-row--done' : '');

    // 动作
    var actionText = catCfg ? catCfg.action : '';
    var actionCls = catCfg ? catCfg.actionCls : '';

    // Checkbox（历史模式禁用）
    var cbHtml = '';
    if (catCfg && catCfg.hasCB) {
      var checked = isDone ? ' checked' : '';
      var disabled = (s._catStatus === 'waiting' || state.isHistoryMode) ? ' disabled' : '';
      cbHtml = '<input type="checkbox" class="db-checkbox' + (s._catId === 3 ? ' db-checkbox--cat3' : '') + '" data-sid="' + esc(s.studentId) + '" data-cat="' + s._catId + '"' + checked + disabled + '>';
    }

    // 状态标签
    var statusHTML = '';
    if (s._catStatus === 'pending') statusHTML = '<span class="db-status-badge db-status-badge--pending">未上课</span>';
    else if (s._catStatus === 'inclass') statusHTML = '<span class="db-status-badge db-status-badge--inclass">上课中</span>';
    else if (s._catStatus === 'waiting') statusHTML = '<span class="db-status-badge db-status-badge--pending">等待报告</span>';
    else if (s._catStatus === 'noreport') statusHTML = '<span class="db-status-badge db-status-badge--noreport">无报告</span>';
    else if (s._catStatus === 'noclass') statusHTML = '<span class="db-status-badge db-status-badge--noclass">没课</span>';
    else statusHTML = '<span class="db-status-badge db-status-badge--done">已下课</span>';

    // 评价等级 + 异常检测（B/B+ 红底）
    var levelHTML = '';
    var rawLevel = (s._raw && s._raw.userPeriodLevel) ? String(s._raw.userPeriodLevel) : (String(s.userPeriodLevel || ''));
    var levelAlert = needsAlert(s, 'level');
    if (rawLevel) {
      var rl = rawLevel.toUpperCase();
      var rlc = 'db-level--none';
      if (rl === 'A' || rl === 'A+') rlc = 'db-level--a';
      else if (rl === 'B' || rl === 'B+') rlc = 'db-level--b';
      else rlc = 'db-level--c';
      levelHTML = '<span class="' + rlc + (levelAlert ? ' db-cell--alert' : '') + '">' + esc(rawLevel) + '</span>';
    } else {
      levelHTML = '<span class="db-level--none">—</span>';
    }

    // 报告标签（class 与 report/content.js 统一：success/info/warning/danger/critical）
    var tagHTML = '';
    if (s.overallTag) {
      var tcs = '';
      if (s.overallTagClass === 'success') tcs = 'db-report-tag--excellent';
      else if (s.overallTagClass === 'info') tcs = 'db-report-tag--info';
      else if (s.overallTagClass === 'warning') tcs = 'db-report-tag--warn';
      else if (s.overallTagClass === 'danger') tcs = 'db-report-tag--danger';
      else if (s.overallTagClass === 'critical') tcs = 'db-report-tag--critical';
      else if (s.overallTagClass === 'tag-excellent') tcs = 'db-report-tag--excellent';  // 兼容旧版本
      else if (s.overallTagClass === 'tag-warn') tcs = 'db-report-tag--warn';
      else if (s.overallTagClass === 'tag-danger') tcs = 'db-report-tag--danger';
      else if (s.overallTagClass === 'tag-critical') tcs = 'db-report-tag--critical';
      tagHTML = '<span class="db-report-tag ' + tcs + '">' + esc(s.overallTag) + '</span>';
    } else if (s.enrichError) {
      tagHTML = '<span class="db-report-tag db-report-tag--none">获取失败</span>';
    } else if (s._catId === 3) {
      tagHTML = '<span class="db-report-tag db-report-tag--none">未生成</span>';
    } else if (s._catId === 1 || s._catId === 2 || s._catId === 7) {
      tagHTML = '<span class="db-report-tag db-report-tag--none">—</span>';
    } else {
      tagHTML = '<span class="db-report-tag db-report-tag--warn">获取中...</span>';
    }

    // 上课时间
    var timeStr = '';
    if (s.scheduleTime) {
      var startT = parseTime(s.scheduleTime);
      var endT = null;
      if (s.endTime) {
        endT = parseTime(s.endTime);
        // parseTime 已内置年份<2024保护，此处仅做额外 sanity check
        if (endT && startT && !isNaN(endT.getTime()) && !isNaN(startT.getTime())) {
          if (endT - startT > 24 * 3600000) endT = null;  // 结束时间不能比开始大24小时
          if (endT - startT < 0) endT = null;              // 结束时间不能早于开始
        }
      }
      if (endT && !isNaN(endT.getTime()) && endT.getFullYear() >= 2024) {
        timeStr = fmtTimeRange(startT, endT);
      } else {
        timeStr = fmtHM(startT) + '~—';
      }
      // DEBUG: 打印原始时间字段帮助排错
      if (s.endTime && (!endT || isNaN(endT.getTime()) || endT.getFullYear() < 2024)) {
        console.log('[DailyBoard] ⚠️ endTime失效: raw=' + JSON.stringify(s.endTime) + ' sid=' + s.studentId + ' name=' + s.studentName);
      }
    } else if (s._catId === 7) {
      timeStr = '—';
    }

    // 报告指标列（有报告才显示具体数值）+ 异常检测
    var ansrateHTML = '', asksHTML = '', answersHTML = '', firstrateHTML = '';
    var ansrateAlert = false;
    if (s.overallTag) {
      var ar = s.participation && s.participation.rate != null ? s.participation.rate : null;
      ansrateAlert = ar !== null && ar < 80;
      ansrateHTML = ar != null ? ar + '%' : '—';
      asksHTML = s.askCount != null ? String(s.askCount) : '—';
      answersHTML = s.answerCount != null ? String(s.answerCount) : '—';
      firstrateHTML = s.firstCorrectRate != null ? s.firstCorrectRate + '%' : '—';
    } else if (s._catId === 3) {
      ansrateHTML = '—'; asksHTML = '—'; answersHTML = '—'; firstrateHTML = '—';
    } else {
      // 今天有课-未上课/正在上课/今天没课：暂无报告
      ansrateHTML = '—';
      asksHTML = '—';
      answersHTML = '—';
      firstrateHTML = '—';
    }
    // 不专注率 tooltip（正在上课且有互动数据时显示）
    var ansrateTitle = '';
    if (s.notFocusRate !== null && s.notFocusRate !== undefined) {
      ansrateTitle = '不专注率：' + s.notFocusRate + '%（' + s.notFocusDetail + '）';
    }
    // 👇 正在上课且有不专注率数据 → 直接显示在单元格（仅≥15分钟才显示）
    if (s._catId === 2 && s.notFocusRate !== null && s.notFocusRate !== undefined) {
      var _durMin = parseDuration(s.inClassOnlineDuration);
      if (_durMin >= 15) {
        ansrateHTML = '不专注' + s.notFocusRate + '%';
        ansrateAlert = s.notFocusRate >= 40;
      }
    }
    // 排课字段（来自 schedule API，非报告）+ 异常检测
    var durationHTML = s.inClassOnlineDuration || '';
    var durationAlert = needsAlert(s, 'duration');
    var hwText = s.homeworkStatusDesc || '';
    var hwAlert = needsAlert(s, 'homework');
    if (!hwText && s.homeworkStatus !== '' && s.homeworkStatus !== null && s.homeworkStatus !== undefined) {
      var hwn = Number(s.homeworkStatus);
      hwText = hwn === 1 ? '已完成' : hwn === 0 ? '未完成' : hwn === -1 ? '未解锁' : '';
    }
    if (!durationHTML && s._catId === 7) durationHTML = '—';
    if (!hwText && s._catId === 7) hwText = '—';

    return '<tr class="' + rowCls + '" data-sid="' + esc(s.studentId) + '" data-cat="' + s._catId + '">' +
      '<td class="db-td--action"><span class="db-action-text ' + actionCls + '">' + esc(actionText) + '</span></td>' +
      '<td class="db-td--cb">' + cbHtml + '</td>' +
      '<td class="db-td--name" title="' + esc(s.studentName) + '">' + esc(s.studentName || s.studentId) + '</td>' +
      '<td class="db-td--time">' + esc(timeStr) + '</td>' +
      '<td class="db-td--status">' + statusHTML + '</td>' +
      '<td class="db-td--level' + (levelAlert ? ' db-cell--alert' : '') + '">' + levelHTML + '</td>' +
      '<td class="db-td--ansrate' + (ansrateAlert ? ' db-cell--alert' : '') + '"' + (ansrateTitle ? ' title="' + esc(ansrateTitle) + '"' : '') + '>' + esc(ansrateHTML) + '</td>' +
      '<td class="db-td--asks">' + esc(asksHTML) + '</td>' +
      '<td class="db-td--answers">' + esc(answersHTML) + '</td>' +
      '<td class="db-td--firstrate">' + esc(firstrateHTML) + '</td>' +
      '<td class="db-td--duration' + (durationAlert ? ' db-cell--alert' : '') + '">' + esc(durationHTML) + '</td>' +
      '<td class="db-td--homework' + (hwAlert ? ' db-cell--alert' : '') + '">' + esc(hwText) + '</td>' +
      '<td class="db-td--tag">' + tagHTML + '</td>' +
    '</tr>';
  }

  function bindTableEvents() {
    // 视角切换 Tab
    panelRoot.querySelectorAll('.db-viewtab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        var mode = this.dataset.view;
        if (mode === state.viewMode) return;
        switchViewMode(mode);
      });
    });

    var closeBtn = panelRoot.getElementById('db-close');
    if (closeBtn) closeBtn.addEventListener('click', closePanel);

    var refreshBtn = panelRoot.getElementById('db-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', function () { loadData(true); });

    var settingsBtn = panelRoot.getElementById('db-settings');
    if (settingsBtn) settingsBtn.addEventListener('click', showSettings);

    var exportBtn = panelRoot.getElementById('db-export');
    if (exportBtn) exportBtn.addEventListener('click', exportToExcel);

    var bellBtn = panelRoot.getElementById('db-nf-bell');
    if (bellBtn) { bellBtn.addEventListener('click', toggleNotFocusMonitor); updateBellUI(); }

    // 切换教师按钮
    var switchBtn = panelRoot.getElementById('db-switch-teacher');
    if (switchBtn) {
      switchBtn.addEventListener('click', function () {
        this.disabled = true;
        this.textContent = '检测中...';
        checkTeacherSwitch().then(function (switched) {
          switchBtn.disabled = false;
          switchBtn.innerHTML = '👤 切换';
          if (switched) {
            loadData();
          } else {
            alert('当前教师: ' + (state.teacher.name || '(未知)') + '\n未检测到教师变化。\n（如果刚切换了账号，请刷新页面后再试）');
          }
        }).catch(function () {
          switchBtn.disabled = false;
          switchBtn.innerHTML = '👤 切换';
        });
      });
    }

    var datePicker = panelRoot.getElementById('db-date-picker');
    if (datePicker) datePicker.addEventListener('change', onDatePickerChange);

    var searchInput = panelRoot.getElementById('db-search');
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        state.searchKeyword = this.value.trim().toLowerCase();
        renderTableBody(state.categories);
      });
    }

    // 标签筛选
    panelRoot.querySelectorAll('.db-filter-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        state.activeFilter = parseInt(this.dataset.filter);
        // 更新高亮
        panelRoot.querySelectorAll('.db-filter-chip').forEach(function (c) { c.classList.remove('db-filter-chip--active'); });
        this.classList.add('db-filter-chip--active');
        renderTableBody(state.categories);
      });
    });

    // Checkbox
    panelRoot.querySelectorAll('.db-checkbox').forEach(function (cb) {
      cb.addEventListener('change', onCheckboxChange);
    });

    // 列头排序点击
    panelRoot.querySelectorAll('[data-sort]').forEach(function (th) {
      th.style.cursor = 'pointer';
      th.addEventListener('click', function () {
        var col = this.dataset.sort;
        if (state.sortCol === col) {
          // 三态循环：升序 → 降序 → 默认
          state.sortDir = state.sortDir === 1 ? -1 : state.sortDir === -1 ? 0 : 1;
          if (state.sortDir === 0) state.sortCol = '';
        } else {
          state.sortCol = col;
          state.sortDir = 1;  // 默认升序
        }
        updateSortUI();
        renderTableBody(state.categories);
      });
    });

    // ESC 关闭
    document.addEventListener('keydown', function escH(e) {
      if (e.key === 'Escape' && panelEl && panelEl.parentNode) closePanel();
    });

    // 学情表绑定事件
    var bindToggle = panelRoot.getElementById('db-bind-toggle');
    var bindBody = panelRoot.getElementById('db-bind-body');
    var bindTextarea = panelRoot.getElementById('db-bind-textarea');
    var bindParse = panelRoot.getElementById('db-bind-parse');
    var bindMsg = panelRoot.getElementById('db-bind-msg');
    if (bindToggle && bindBody) {
      bindToggle.addEventListener('click', function () {
        var visible = bindBody.style.display !== 'none';
        bindBody.style.display = visible ? 'none' : '';
        if (!visible && bindTextarea) bindTextarea.focus();
      });
    }
    // 首次渲染时横幅上的「清空绑定」按钮
    var bindClear = panelRoot.getElementById('db-bind-clear');
    if (bindClear) {
      bindClear.addEventListener('click', function () {
        window.__db_boundStudents = [];
        try { chrome.storage.local.remove('db_boundStudents'); } catch (_) {}
        var b = panelRoot.getElementById('db-bind-banner');
        if (b) {
          b.innerHTML = '📋 尚未绑定学情表，<a role="button" id="db-bind-toggle">点击粘贴学生数据</a>（用于第7类「今天没课」）';
          b.style.background = '#fff8e1';
          b.style.borderColor = '#ffe082';
          b.style.color = '#888';
        }
        if (bindBody) bindBody.style.display = 'none';
        state.categories = classifyStudents(state.students, new Date());
        renderTableBody(state.categories);
      });
    }
    if (bindParse && bindTextarea && bindMsg) {
      bindParse.addEventListener('click', function () {
        var raw = bindTextarea.value.trim();
        if (!raw) { bindMsg.textContent = '请先粘贴学情表数据'; bindMsg.style.color = '#e53935'; return; }
        var rows = raw.split(/\n/).filter(function (r) { return r.trim(); });
        if (rows.length === 0) { bindMsg.textContent = '未识别到有效数据行'; bindMsg.style.color = '#e53935'; return; }
        // ── 智能识别列（按内容特征，不依赖表头名称）─────────────────
        // 策略：先找手机号（11位1开头纯数字）→ 剩余列中数字=ID，中文=姓名
        var hasHeader = rows.length > 0 && /[\u4e00-\u9fa5]/.test(rows[0].split('\t')[0]) && rows[0].split('\t')[0].length > 1 && !/^\d{11}$/.test(rows[0].split('\t')[0].trim());
        var dataStart = hasHeader ? 1 : 0;
        var colCnt = rows[dataStart].split('\t').length;
        var colMap = { remarkIdx: -1, idIdx: -1, phoneIdx: -1, gradeIdx: -1 };
        // 取前5行样本，统计每列特征
        var sample = Math.min(dataStart + 5, rows.length);
        for (var ci = 0; ci < colCnt; ci++) {
          var phoneHits = 0, chineseHits = 0, numberHits = 0, total = 0;
          for (var ri = dataStart; ri < sample; ri++) {
            var vals = rows[ri].split('\t');
            var v = (vals[ci] || '').trim();
            if (!v) continue;
            total++;
            if (/^1\d{10}$/.test(v)) phoneHits++;      // 11位1开头 = 手机号
            else if (/[\u4e00-\u9fa5]/.test(v)) chineseHits++;  // 含中文 = 姓名
            else if (/^\d{3,}$/.test(v)) numberHits++; // 纯数字3位以上 = ID
            else if (/^\d{2,}$/.test(v)) numberHits++; // 2位以上数字也算ID
          }
          if (total === 0) continue;
          // 按特征归类
          if (phoneHits >= total * 0.6) colMap.phoneIdx = ci;
          else if (chineseHits >= total * 0.6) colMap.remarkIdx = ci;
          else if (numberHits >= total * 0.6) colMap.idIdx = ci;
        }
        // 如果还有列没识别，补一个兜底
        if (colMap.remarkIdx < 0 && colMap.idIdx < 0 && colMap.phoneIdx < 0) {
          // 全都没识别，按位置兜底
          colMap.remarkIdx = 0; colMap.idIdx = 1; colMap.phoneIdx = 2;
        }
        // 解析
        var bound = [];
        for (var ri = dataStart; ri < rows.length; ri++) {
          var cols = rows[ri].split('\t').map(function (c) { return c.trim(); });
          if (cols.length < 2) continue;
          var sid = colMap.idIdx >= 0 ? cols[colMap.idIdx] : '';
          var sname = colMap.remarkIdx >= 0 ? cols[colMap.remarkIdx] : '';
          var phone = colMap.phoneIdx >= 0 ? (cols[colMap.phoneIdx] || '') : '';
          var grade = colMap.gradeIdx >= 0 ? (cols[colMap.gradeIdx] || '') : '';
          if (!sid || !sname) continue;
          bound.push({ studentId: sid, studentName: sname, remarkName: sname, grade: grade, phone: phone });
        }
        if (bound.length === 0) { bindMsg.textContent = '未解析到有效数据，请检查格式'; bindMsg.style.color = '#e53935'; return; }
        window.__db_boundStudents = bound;
        chrome.storage.local.set({ db_boundStudents: bound }, function () {
          if (chrome.runtime.lastError) console.warn('[DailyBoard] 绑定学生保存失败:', chrome.runtime.lastError.message);
        });
        bindMsg.textContent = '已绑定 ' + bound.length + ' 名学生（永久保存），刷新数据后生效';
        bindMsg.style.color = '#43a047';
        // 折叠粘贴区（只隐藏输入框，保留"已绑定"提示）
        bindBody.style.display = 'none';
        // 更新顶部横幅显示已绑定信息
        var banner = document.getElementById('db-bind-banner');
        if (banner) {
          banner.innerHTML = '✅ 已绑定 <b>' + bound.length + '</b> 名学生，<a role="button" id="db-bind-toggle">重新绑定</a> | <a role="button" id="db-bind-clear" style="color:#d32f2f;">清空绑定</a>';
          banner.style.background = '#e8f5e9';
          banner.style.borderColor = '#c8e6c9';
          banner.style.color = '#2e7d32';
          banner.style.display = '';
          // 重新绑定事件
          var newToggle = banner.querySelector('#db-bind-toggle');
          if (newToggle && bindBody) {
            newToggle.addEventListener('click', function () {
              bindBody.style.display = '';
              if (bindTextarea) bindTextarea.focus();
            });
          }
          // 清空绑定事件
          var clearBtn = banner.querySelector('#db-bind-clear');
          if (clearBtn) {
            clearBtn.addEventListener('click', function () {
              window.__db_boundStudents = [];
              try { chrome.storage.local.remove('db_boundStudents'); } catch (_) {}
              var b = document.getElementById('db-bind-banner');
              if (b) {
                b.innerHTML = '📋 尚未绑定学情表，<a role="button" id="db-bind-toggle">点击粘贴学生数据</a>（用于第7类「今天没课」）';
                b.style.background = '#fff8e1';
                b.style.borderColor = '#ffe082';
                b.style.color = '#888';
              }
              if (bindBody) bindBody.style.display = 'none';
              state.categories = classifyStudents(state.students, new Date());
              renderTableBody(state.categories);
            });
          }
        }
        // ⚠️ 不再隐藏 db-bind-wrap，保留"已绑定"提示可见
        // 刷新表格（重新合并第7类）
        state.categories = classifyStudents(state.students, new Date());
        renderTableBody(state.categories);
      });
    }
  }

  function onCheckboxChange(e) {
    var cb = e.target;
    var sid = cb.dataset.sid;
    var catId = parseInt(cb.dataset.cat);

    // 分类3：确认重约弹窗
    if (catId === 3 && cb.checked) {
      e.preventDefault(); cb.checked = false;
      showConfirmModal(sid, cb);
      return;
    }

    toggleDone(sid, cb.checked);
  }

  function toggleDone(studentId, isDone) {
    if (isDone) doneMap[studentId] = true; else delete doneMap[studentId];
    saveDoneStatus();
    // 更新行样式
    var row = panelRoot && panelRoot.querySelector('tr[data-sid="' + studentId + '"]');
    if (row) {
      if (isDone) row.classList.add('db-row--done'); else row.classList.remove('db-row--done');
    }
    // 更新进度
    if (state.categories) {
      var p = calcProgress(state.categories);
      var fill = panelRoot && panelRoot.getElementById('db-progress-fill');
      var pct = panelRoot && panelRoot.getElementById('db-progress-pct');
      if (fill) fill.style.width = p.pct + '%';
      if (pct) pct.textContent = p.pct + '%';
    }
    syncToCloudBase(studentId, isDone);
  }

  function showConfirmModal(studentId, checkbox) {
    var backdrop = document.createElement('div');
    backdrop.className = 'db-modal-backdrop';
    backdrop.innerHTML =
      '<div class="db-modal">' +
        '<div class="db-modal-title">⚠️ 确认重约排课</div>' +
        '<div class="db-modal-body">该学生课后报告未生成，需要一对一电话联系重新约课排课。</div>' +
        '<div class="db-modal-body" style="font-weight:500;color:#c62828;">是否已完成联系并安排了重新排课？</div>' +
        '<div style="margin-top:8px;font-size:11px;color:#888;">打勾后将自动验证该学生是否已在未来排课</div>' +
        '<div class="db-modal-actions">' +
          '<button class="db-btn" id="db-modal-cancel">取消</button>' +
          '<button class="db-btn db-btn--primary" id="db-modal-confirm">✅ 已重约，打勾</button>' +
        '</div>' +
      '</div>';
    panelRoot.appendChild(backdrop);

    backdrop.querySelector('#db-modal-cancel').addEventListener('click', function () { backdrop.remove(); });
    backdrop.querySelector('#db-modal-confirm').addEventListener('click', function () {
      backdrop.remove();
      checkbox.checked = true;
      toggleDone(studentId, true);
      // 异步验证重约
      var student = findStudent(studentId);
      chrome.runtime.sendMessage({
        action: 'DAILYBOARD_CHECK_RECLASS',
        payload: { studentId: studentId, oldClassStartTime: student ? student.scheduleTime : '', oldClassEndTime: student ? student.endTime : '' },
      }, function (resp) {
        if (resp && resp.ok && resp.data && resp.data.reClassed) {
          console.log('[DailyBoard] ✅ 已验证重约: ' + studentId + ', 未来排课 ' + resp.data.futureCount + ' 节');
        }
      });
    });
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) backdrop.remove(); });
  }

  function findStudent(sid) {
    if (!state.categories) return null;
    for (var k in state.categories) {
      var list = state.categories[k];
      for (var i = 0; i < list.length; i++) { if (list[i].studentId === sid) return list[i]; }
    }
    return null;
  }

  /* ── 设置弹窗 ── */
  function showSettings() {
    var sel = function (val, opt) { return val === opt ? ' selected' : ''; };
    var backdrop = document.createElement('div');
    backdrop.className = 'db-modal-backdrop';
    backdrop.innerHTML =
      '<div class="db-modal">' +
        '<div class="db-modal-title">⚙️ 教师设置</div>' +
        '<div class="db-modal-body">设置学科和年级，数据将写入云端供管理看板使用</div>' +
        '<select id="db-set-subject" style="width:100%;padding:6px;border:1px solid #ddd;border-radius:6px;font-size:13px;margin-bottom:6px;">' +
          '<option value="">-- 选择学科 --</option>' +
          '<option' + sel(state.teacher.subject, '数学') + '>数学</option><option' + sel(state.teacher.subject, '英语') + '>英语</option>' +
          '<option' + sel(state.teacher.subject, '物理') + '>物理</option><option' + sel(state.teacher.subject, '化学') + '>化学</option>' +
          '<option' + sel(state.teacher.subject, '语文') + '>语文</option><option' + sel(state.teacher.subject, '生物') + '>生物</option>' +
        '</select>' +
        '<select id="db-set-grade" style="width:100%;padding:6px;border:1px solid #ddd;border-radius:6px;font-size:13px;margin-bottom:6px;">' +
          '<option value="">-- 选择年级 --</option>' +
          '<option' + sel(state.teacher.grade, '初一') + '>初一</option><option' + sel(state.teacher.grade, '初二') + '>初二</option>' +
          '<option' + sel(state.teacher.grade, '初三') + '>初三</option><option' + sel(state.teacher.grade, '高一') + '>高一</option>' +
          '<option' + sel(state.teacher.grade, '高二') + '>高二</option><option' + sel(state.teacher.grade, '高三') + '>高三</option>' +
        '</select>' +
        '<select id="db-set-center" style="width:100%;padding:6px;border:1px solid #ddd;border-radius:6px;font-size:13px;">' +
          '<option value="">-- 选择中心（可选）--</option>' +
          '<option' + sel(state.teacher.center, '郑州') + '>郑州</option>' +
        '</select>' +
        '<div class="db-modal-actions">' +
          '<button class="db-btn" id="db-set-cancel">取消</button>' +
          '<button class="db-btn db-btn--primary" id="db-set-save">保存</button>' +
        '</div>' +
      '</div>';
    panelRoot.appendChild(backdrop);
    backdrop.querySelector('#db-set-cancel').addEventListener('click', function () { backdrop.remove(); });
    backdrop.querySelector('#db-set-save').addEventListener('click', function () {
      saveSettings(backdrop.querySelector('#db-set-subject').value, backdrop.querySelector('#db-set-grade').value, backdrop.querySelector('#db-set-center').value);
      state.teacher.subject = backdrop.querySelector('#db-set-subject').value;
      state.teacher.grade = backdrop.querySelector('#db-set-grade').value;
      state.teacher.center = backdrop.querySelector('#db-set-center').value;
      backdrop.remove();
      if (state.categories) {
        var p = calcProgress(state.categories);
        renderContent(teacherName(), state.categories, p);
      }
    });
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) backdrop.remove(); });
  }

  /* ── 数据加载 ── */
  async function loadData(isRefresh) {
    if (!panelRoot) return;

    // 检测教师是否切换（必须在最前面，确保用最新登录教师加载数据）
    var teacherSwitched = await checkTeacherSwitch();
    if (teacherSwitched) {
      console.log('[DailyBoard] 教师已切换，将重新加载数据');
    }

    // panelCacheKey — 用于后续保存
    var panelCacheKey = _pck(dateKey());

    // 显示加载
    if (!isRefresh) {
      panelRoot.innerHTML = '<style>' + buildCSS() + '</style><div class="db-loading-wrap"><div class="db-spinner"></div><span class="db-loading-text">步骤 1/4 · 读取设置...</span><div class="db-progress-bar"><div class="db-progress-fill" style="width:25%"></div></div></div>';
    }

    try {
      // Step 1: 读教师设置
      var stored = await new Promise(function (r) {
        chrome.storage.local.get(['db_teacherSubject', 'db_teacherGrade', 'db_teacherCenter', 'db_teacherName'], r);
      });
      state.teacher = state.teacher || {};
      if (stored.db_teacherName) state.teacher.name = stored.db_teacherName;
      if (stored.db_teacherSubject) state.teacher.subject = stored.db_teacherSubject;
      if (stored.db_teacherGrade) state.teacher.grade = stored.db_teacherGrade;
      if (stored.db_teacherCenter) state.teacher.center = stored.db_teacherCenter;
      // 中心默认郑州
      if (!state.teacher.center) { state.teacher.center = '郑州'; chrome.storage.local.set({ db_teacherCenter: '郑州' }); }
      // 姓名未配置时自动从 API 获取
      if (!state.teacher.name) {
        var autoName = await fetchTeacherName();
        if (autoName) {
          state.teacher.name = autoName;
          chrome.storage.local.set({ db_teacherName: autoName });
        }
      }
      state.settingsConfigured = !!(state.teacher.subject || state.teacher.grade);

      // Step 2: 获取排课数据（含实时数据：onlineStatus、inClassInteractiveScenesCount、aiClassHourId 等）
      setLoadingProgress(2, 5, '查询排课与课堂实时数据...');
      var rawRows = await fetchSchedule();
      if (!rawRows || !Array.isArray(rawRows)) rawRows = [];
      console.log('[DailyBoard] 排课:', rawRows.length + '条');

      // Step 2.5: 获取正在上课学生的互动明细（不专注率）
      await fetchInteractionData(rawRows);

      // 计算当日听课率/作业完成率（直接用 rawRows，它已有实时字段）
      calcDayRates(rawRows);

      // 映射
      var students = rawRows.map(mapScheduleRow);

      // 合并学情绑定（第7类）
      var bound = window.__db_boundStudents || [];
      var sidSet = {};
      students.forEach(function (s) { sidSet[s.studentId] = true; });
      bound.forEach(function (bs) {
        if (!sidSet[bs.studentId]) {
          students.push(mapScheduleRow({ studentId: bs.studentId, remarkName: bs.remarkName, studentName: bs.studentName, gradeName: bs.grade || '' }));
        }
      });

      if (isRefresh) { var oldDone = Object.assign({}, doneMap); }

      // Step 3: 富化报告（只富化已下课的学生，减少无效请求）
      // classStatus: 0=未上课 1=上课中 2=已结束 → 只有已下课才有报告
      var rowsForEnrich = rawRows.filter(function (r) {
        return Number(r.classStatus) === 2 || Number(r.reportVersion) > 0;
      });
      console.log('[DailyBoard] 需要富化: ' + rowsForEnrich.length + '/' + rawRows.length + ' 人');

      // 检查同日缓存
      setLoadingProgress(3, 4, '分析报告 (' + rowsForEnrich.length + '人)...');
      var enrichResults = [];
      try {
        var cacheKey = 'db_enrich_cache_' + dateKey();
        var cachedResults = null;
        if (!isRefresh) {
          cachedResults = await new Promise(function (r) {
            chrome.storage.local.get([cacheKey], function (d) { r(d[cacheKey] || null); });
          });
        }
        if (cachedResults && cachedResults.length > 0) {
          console.log('[DailyBoard] ♻️ 使用缓存结果:', cachedResults.length, '人');
          enrichResults = cachedResults;
        } else {
          enrichResults = await enrichWithReports(rowsForEnrich, isRefresh);
          // 缓存到本地（同日有效）
          if (enrichResults && enrichResults.length > 0) {
            chrome.storage.local.set({ [cacheKey]: enrichResults });
            console.log('[DailyBoard] 💾 已缓存', enrichResults.length, '人富化结果');
          }
        }
      } catch (enrichErr) {
        console.warn('[DailyBoard] 报告富化失败（继续使用基础数据）:', enrichErr.message);
        enrichResults = [];
      }
      // 合并富化结果（防御：enrichResults 可能为空数组）
      var enrichMap = {};
      if (Array.isArray(enrichResults)) {
        enrichResults.forEach(function (er) { 
          if (er && er.data) enrichMap[String(er.data.studentId || '')] = er.data; 
        });
      }
      students.forEach(function (s) {
        var enriched = enrichMap[s.studentId];
        if (enriched && !enriched.error) {
          s.overallTag = enriched.overallTag;
          s.overallTagClass = enriched.overallTagClass;
          s.masteryRating = enriched.masteryRating;
          s.participation = enriched.participation;
          s.askCount = enriched.askCount;
          s.answerCount = enriched.answerCount;
          s.firstCorrectRate = enriched.firstCorrectRate;
          s.diagnosis = null;
        } else if (enriched && enriched.error) {
          s.enrichError = enriched.error;
        }
      });

      state.students = students;
      state.rawRows = rawRows;
      state.lastDataFetchTime = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

      // Step 4: 分类 + 渲染（核心步骤，必须成功）
      setLoadingProgress(4, 4, '分类处理...');
      var now = new Date();
      console.log('[DailyBoard] 🔹 Step4a: 开始分类, students=', students.length);
      state.categories = classifyStudents(students, now);
      console.log('[DailyBoard] 🔹 Step4b: 分类完成, categories=', Object.keys(state.categories).length);

      // 刷新时恢复打勾
      if (isRefresh && oldDone) {
        for (var k in oldDone) doneMap[k] = oldDone[k];
      }

      console.log('[DailyBoard] 🔹 Step4c: 计算进度...');
      var progress = calcProgress(state.categories);
      console.log('[DailyBoard] 🔹 Step4d: 渲染内容...');
      renderContent(teacherName(), state.categories, progress);
      console.log('[DailyBoard] 🔹 Step4e: 渲染完成 ✅');

      // 刷新完成后清除过期提示
      if (isRefresh) {
        var es2 = panelRoot.getElementById('db-enrich-status');
        if (es2) es2.style.display = 'none';
      }

      // 缓存到 sessionStorage（非关键，失败不中断）
      try {
        writeCache(panelCacheKey, {
          students: state.students,
          dayRates: state.dayRates,
          lastDataFetchTime: state.lastDataFetchTime,
        });
      } catch (cacheErr) {
        console.warn('[DailyBoard] 缓存写入失败（不影响使用）:', cacheErr.message);
      }

      // 异步同步（非关键）
      try { syncToCloudBase(); } catch (syncErr) {
        console.warn('[DailyBoard] 云端同步失败（不影响使用）:', syncErr.message);
      }

      // 启动不专注率主动提醒（非关键）
      try { startNotFocusMonitor(); } catch (monErr) {
        console.warn('[DailyBoard] 监控启动失败:', monErr.message);
      }

    } catch (err) {
      console.error('[DailyBoard] ❌ 加载失败:', err.message);
      console.error('[DailyBoard] ❌ 堆栈:', (err.stack || '无堆栈').substring(0, 500));
      // 只有面板为空或只有加载动画时才显示错误页面
      // 如果已经有内容了，只显示一个小提示而不覆盖
      if (panelRoot) {
        var hasContent = panelRoot.querySelector('.db-tbody') || panelRoot.querySelector('.db-cat-section');
        if (!hasContent) {
          panelRoot.innerHTML = '<style>' + buildCSS() + '</style>' +
            '<div class="db-header"><div class="db-titlebar"><div class="db-titlebar-left"><span class="db-title-text">📊 每日工作看板</span></div></div><button class="db-close-btn" id="db-close">✕</button></div>' +
            '<div style="padding:16px;color:#c62828;font-size:13px;">❌ 加载失败：' + esc(err.message || String(err)) + '<br><button class="db-btn" id="db-retry" style="margin-top:8px;">重试</button></div>';
          var cb = panelRoot.getElementById('db-close'); if (cb) cb.addEventListener('click', closePanel);
          var rb = panelRoot.getElementById('db-retry'); if (rb) rb.addEventListener('click', function () { loadData(); });
        } else {
          console.warn('[DailyBoard] 部分功能异常但主数据已渲染:', err.message);
        }
      }
    }
  }

  /** 课节视角：按课程+讲次加载 */
  async function loadLectureData() {

    try {
    var courseIds = state.lectureCourses;
    var lecNum = state.lectureLecNum;
    if (!courseIds.length || !lecNum) {
      console.warn('[DailyBoard] 课节加载条件不满足: courses=' + courseIds.length + ' lecNum=' + lecNum);
      return;
    }
    console.log('[DailyBoard] 🎯 课节加载: courses=' + courseIds.join(',') + ' 第' + lecNum + '讲');

    var cidSet = {};
    courseIds.forEach(function (id) { cidSet[id] = true; });

    // 先查课节缓存
    var lecCacheKey = _lck(courseIds, lecNum);
    var lcr = readCache(lecCacheKey);
    if (lcr.hit && lcr.data && lcr.data.dayRates && lcr.data.students && lcr.data.students.length > 0) {
      console.log('[DailyBoard] ⚡ 课节缓存秒出:', lcr.data.students.length, '人');
      state.dayRates = lcr.data.dayRates;
      state.lastDataFetchTime = lcr.data.lastDataFetchTime;
      state.categories = classifyStudents(lcr.data.students, new Date());
      var lcp = calcProgress(state.categories);
      renderLectureContent(teacherName(), state.categories, lcp);
      return;
    }

      await loadLectureDataNoCache(courseIds, lecNum, cidSet);

    } catch (err) {
      console.error('[DailyBoard] 课节加载失败:', err);
      if (panelRoot) {
        panelRoot.getElementById('db-loading-wrap')?.remove();
        panelRoot.innerHTML = '<style>' + buildCSS() + '</style>' + buildLectureHeaderHTML() +
          '<div style="padding:16px;color:#c62828;font-size:13px;">❌ 加载失败：' + esc(err.message || String(err)) + '<br><button class="db-btn" id="db-retry" style="margin-top:8px;">重试</button></div>';
        var rb = panelRoot.getElementById('db-retry'); if (rb) rb.addEventListener('click', loadLectureData);
      }
    }
  }

  /** 课节视角：无缓存，完整加载（内部函数） */
  async function loadLectureDataNoCache(courseIds, lecNum, cidSet) {

    try {
      // Step 1: 拉取全学期排课
      setLoadingProgress(1, 5, '拉取全学期排课数据...');
      var allSchedule = await fetchScheduleWideCached('2026-03-01', dateKey());
      if (!allSchedule || allSchedule.length === 0) {
        if (panelRoot) panelRoot.innerHTML = '<style>' + buildCSS() + '</style>' + buildLectureHeaderHTML() + '<div style="padding:40px 20px;text-align:center;color:#aaa;font-size:13px;">📭 未获取到排课数据</div>';
        return;
      }

      // 重建课节列表（同步课程多选变化）
      state.lectures = extractLectures(allSchedule, courseIds);

      // 找到当前讲次的所有 periodIds
      var curLecture = state.lectures.find(function (l) { return l.lecNum === lecNum; });
      if (!curLecture) {
        if (panelRoot) panelRoot.innerHTML = '<style>' + buildCSS() + '</style>' + buildLectureHeaderHTML() + '<div style="padding:40px 20px;text-align:center;color:#aaa;font-size:13px;">📭 未找到第' + lecNum + '讲</div>';
        return;
      }
      var periodIdSet = {};
      curLecture.periodIds.forEach(function (pid) { periodIdSet[pid] = true; });

      // Step 2: 筛选匹配的学生行（按选中课程 + 该讲号下所有 periodIds）
      setLoadingProgress(2, 5, '筛选课节学生...');
      var matchedRows = allSchedule.filter(function (r) {
        return cidSet[Number(r.aiCourseId)] && periodIdSet[String(r.aiPeriodId)];
      });
      var rawCount = matchedRows.length;
      var userRowMap = {};
      matchedRows.forEach(function (r) {
        var uid = String(r.studentId || r.userId || '');
        if (!userRowMap[uid] || (r.classDate || '') > (userRowMap[uid].classDate || '')) {
          userRowMap[uid] = r;
        }
      });
      matchedRows = Object.values(userRowMap);
      console.log('[DailyBoard] 课节匹配学生(去重:' + rawCount + '→' + matchedRows.length + '人) (第' + lecNum + '讲, ' + curLecture.periodIds.length + '个课节ID)');
      if (matchedRows.length === 0) {
        console.warn('[DailyBoard] 无匹配学生');
        if (panelRoot) panelRoot.innerHTML = '<style>' + buildCSS() + '</style>' + buildLectureHeaderHTML() + '<div style="padding:40px 20px;text-align:center;color:#aaa;font-size:13px;">📭 该课节无学生数据</div>';
        return;
      }

      // Step 3: 拉取课堂数据（取出所有相关日期，拉全量课堂数据后客户端筛选）
      setLoadingProgress(3, 5, '拉取课堂数据...');
      var dateSet = {};
      var sDateMap = {}; // studentId → classDate
      matchedRows.forEach(function (r) {
        var cd = r.classDate || '';
        if (cd) dateSet[cd] = true;
        var sid = String(r.studentId || r.userId || '');
        if (sid && cd) sDateMap[sid] = cd;
      });
      var dates = Object.keys(dateSet).sort();
      console.log('[DailyBoard] 课节涉及日期:', dates.length + '天:', dates.join(', '));

      // 拉全量课堂数据后按 userId+classDate 筛选（分页 + 实时进度）
      var allClassroom = [];
      var cPage = 1;
      var cTotalKnown = null;
      while (true) {
        var label = cTotalKnown ? ('拉取课堂数据 (第' + cPage + '/' + cTotalKnown + '页)...') : ('拉取课堂数据 (第' + cPage + '页)...');
        setLoadingProgress(3, 5, label);
        var cj = await workApiPost('/prod-api/student-center-ai/ai/teacher/classroom/list', {
          current: String(cPage), size: '500', courseClassify: 3, operationType: 1,
        });
        var cr = (cj && cj.data && cj.data.records) || [];
        allClassroom = allClassroom.concat(cr);
        var cTotal = Number(cj && cj.data && cj.data.pages) || 1;
        if (cTotalKnown === null) cTotalKnown = cTotal;
        if (cPage >= cTotal || cr.length === 0) break;
        cPage++;
      }
      // 按 (userId, classDate) 建索引
      var cIdx = {};
      allClassroom.forEach(function (r) {
        var uid = String(r.userId || '');
        var cd = r.classDate || '';
        if (uid && cd) cIdx[uid + '|' + cd] = r;
      });
      console.log('[DailyBoard] 课堂数据总' + allClassroom.length + '条，已索引');

      // 计算课节比率
      var listenCount = 0, hwDoneCount = 0;
      matchedRows.forEach(function (r) {
        var sid = String(r.studentId || r.userId || '');
        var cd = sDateMap[sid];
        var crow = cd ? cIdx[sid + '|' + cd] : null;
        if (crow) {
          if (Number(crow.lessonDuration) > 0 || Number(crow.lessonFinishStatus) === 1) listenCount++;
          if (Number(crow.homeworkStatus) === 2) hwDoneCount++;
        }
      });
      state.dayRates = {
        totalStudents: matchedRows.length,
        listenCount: listenCount,
        hwDoneCount: hwDoneCount,
      };

      // Step 4: 映射 + 富化报告
      setLoadingProgress(4, 5, '分析报告 (' + matchedRows.length + '人)...');
      var students = matchedRows.map(mapScheduleRow);

      // 富化：含报告版本的学生
      var rowsForEnrich = matchedRows.filter(function (r) {
        return Number(r.classStatus) === 2 || Number(r.reportVersion) > 0;
      });
      if (rowsForEnrich.length > 0) {
        var enrichResults = await enrichWithReports(rowsForEnrich, true);
        var enrichMap = {};
        if (enrichResults && enrichResults.length > 0) {
          enrichResults.forEach(function (er) {
            if (er && er.data) enrichMap[String(er.data.studentId || '')] = er.data;
          });
        }
        students.forEach(function (s) {
          var enriched = enrichMap[s.studentId];
          if (enriched && !enriched.error) {
            s.overallTag = enriched.overallTag || null;
            s.overallTagClass = enriched.overallTagClass || null;
            s.masteryRating = enriched.masteryRating || null;
            s.participation = enriched.participation || null;
            s.askCount = enriched.askCount || 0;
            s.answerCount = enriched.answerCount || 0;
            s.firstCorrectRate = enriched.firstCorrectRate || '';
          } else if (enriched && enriched.error) {
            s.enrichError = enriched.error;
          }
        });
      }

      state.students = students;
      state.lastDataFetchTime = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

      // Step 5: 分类
      setLoadingProgress(5, 5, '完成');
      var now = new Date();
      state.categories = classifyStudents(students, now);

      // 计算完成度
      var needAction = 0, doneCount = 0;
      for (var catId = 3; catId <= 7; catId++) {
        var cat = (state.categories[catId] || []);
        cat.forEach(function (s) {
          needAction++;
          if (doneMap[s.studentId]) doneCount++;
        });
      }
      var progress = {
        needAction: needAction,
        done: doneCount,
        pct: needAction > 0 ? Math.round(doneCount / needAction * 100) : 100,
      };

      // 写入课节缓存
      writeCache(_lck(courseIds, lecNum), {
        students: students,
        dayRates: state.dayRates,
        lastDataFetchTime: state.lastDataFetchTime,
      });

      renderLectureContent(teacherName(), state.categories, progress);

    } catch (err) {
      console.error('[DailyBoard] 课节加载失败:', err);
      if (panelRoot) {
        panelRoot.innerHTML = '<style>' + buildCSS() + '</style>' + buildLectureHeaderHTML() +
          '<div style="padding:16px;color:#c62828;font-size:13px;">❌ 加载失败：' + esc(err.message || String(err)) + '<br><button class="db-btn" id="db-retry" style="margin-top:8px;">重试</button></div>';
        var rb = panelRoot.getElementById('db-retry'); if (rb) rb.addEventListener('click', loadLectureData);
      }
    }
  }

  /** 课节视角的头部 HTML（不含完整 header，仅课节控制区） */
  function buildLectureHeaderHTML() {
    var lectures = state.lectures;
    var lecNum = state.lectureLecNum;
    var info = lectures.find(function (l) { return l.lecNum === lecNum; });
    var headerTitle = info ? ('第' + info.lecNum + '讲') : '课节视角';
    var studentsCount = state.dayRates.totalStudents > 0 ? state.dayRates.totalStudents : (info ? info.studentCount : 0);

    return '<div class="db-header">' +
      '<div class="db-titlebar">' +
        '<span class="db-title-icon">📚</span>' +
        '<span class="db-title-text">课节视角</span>' +
        '<span class="db-lecture-meta">' + esc(headerTitle) + ' · ' + state.lectureCourses.length + '门课 · ' + studentsCount + '人</span>' +
        '<span class="db-data-time-label" id="db-data-time" ' + (state.lastDataFetchTime ? '' : 'style="display:none;"') + '>截取 ' + (state.lastDataFetchTime || '') + '</span>' +
        '<button class="db-btn" id="db-switch-teacher" title="切换教师（检测到账号变化会自动切换）">👤 切换</button>' +
        '</div>' +
      '<button class="db-close-btn" id="db-close">✕</button>' +
      '</div>' +
      // 课程多选区
      '<div class="db-lecture-controls">' +
        '<div class="db-lecture-courses" id="db-lecture-courses">' +
          buildCourseChipsHTML() +
        '</div>' +
        '<div class="db-lecture-picker">' +
          '第 <select class="db-lecture-select" id="db-lecture-select">' +
            buildLectureOptionsHTML(lectures, lecNum) +
          '</select> 讲' +
        '</div>' +
      '</div>' +
      // 当日比率
      '<div class="db-dayrates" id="db-dayrates">' +
        '<span class="db-rate-item">🎧 有效听课率 <b>' + (state.dayRates.totalStudents > 0 ? Math.round(state.dayRates.listenCount / state.dayRates.totalStudents * 100) : 0) + '%</b></span>' +
        '<span class="db-rate-divider">|</span>' +
        '<span class="db-rate-item">📝 作业完成率 <b>' + (state.dayRates.totalStudents > 0 ? Math.round(state.dayRates.hwDoneCount / state.dayRates.totalStudents * 100) : 0) + '%</b></span>' +
        '<span class="db-rate-hint">（有效听课' + state.dayRates.listenCount + '人 / 作业完成' + state.dayRates.hwDoneCount + '人 / 排课' + state.dayRates.totalStudents + '人）</span>' +
      '</div>';
  }

  /** 课程多选 chips */
  function buildCourseChipsHTML() {
    var list = state.courseList;
    if (list.length === 0) return '<span style="color:#bbb;font-size:12px;padding:2px 0;">加载中...</span>';
    var selected = state.lectureCourses;
    var selSet = {};
    selected.forEach(function (id) { selSet[id] = true; });
    return list.map(function (c) {
      var checked = selSet[c.aiCourseId];
      return '<label class="db-course-chip' + (checked ? ' db-course-chip--active' : '') + '" data-course-id="' + c.aiCourseId + '">' +
        '<input type="checkbox" ' + (checked ? 'checked' : '') + ' style="display:none;">' +
        esc(c.title) + '</label>';
    }).join('');
  }

  /** 讲次下拉 option */
  function buildLectureOptionsHTML(lectures, selectedLecNum) {
    return lectures.map(function (l) {
      var sel = (l.lecNum === selectedLecNum) ? ' selected' : '';
      return '<option value="' + l.lecNum + '"' + sel + '>第' + l.lecNum + '讲 (' + l.studentCount + '人)</option>';
    }).join('');
  }

  /** 课节视角完整渲染 */
  function renderLectureContent(teacherNameVal, cats, progress) {
    if (!panelRoot) return;
    panelRoot.innerHTML = '';

    var style = document.createElement('style');
    style.textContent = buildCSS();
    panelRoot.appendChild(style);

    // 头部 + 课节控制
    var hdr = document.createElement('div');
    hdr.innerHTML = buildLectureHeaderHTML();
    while (hdr.firstChild) panelRoot.appendChild(hdr.firstChild);

    // 绑定事件
    var closeBtn = panelRoot.getElementById('db-close');
    if (closeBtn) closeBtn.addEventListener('click', closePanel);

    // 课程 chips 点击
    var chips = panelRoot.querySelectorAll('.db-course-chip');
    chips.forEach(function (chip) {
      chip.addEventListener('click', function () {
        var cid = Number(this.dataset.courseId);
        var idx = state.lectureCourses.indexOf(cid);
        if (idx >= 0) {
          // 至少保留1门课
          if (state.lectureCourses.length > 1) state.lectureCourses.splice(idx, 1);
        } else {
          state.lectureCourses.push(cid);
        }
        // 重新加载
        panelRoot.innerHTML = '<style>' + buildCSS() + '</style>' +
          '<div class="db-header"><div class="db-titlebar"><span class="db-title-text">📚 课节视角</span></div><button class="db-close-btn" id="db-close">✕</button></div>' +
          '<div class="db-loading-wrap"><div class="db-spinner"></div><span class="db-loading-text">步骤 1/5 · 拉取全学期排课数据...</span><div class="db-progress-bar"><div class="db-progress-fill" style="width:20%"></div></div></div>';
        _progressLastTime = 0;
        loadLectureData();
      });
    });

    // 讲次下拉
    var select = panelRoot.getElementById('db-lecture-select');
    if (select) {
      // 显式设定值（修复部分浏览器 selected 属性不生效的问题）
      if (state.lectureLecNum) select.value = state.lectureLecNum;
      select.addEventListener('change', function () {
        state.lectureLecNum = this.value;
        panelRoot.innerHTML = '<style>' + buildCSS() + '</style>' +
          '<div class="db-header"><div class="db-titlebar"><span class="db-title-text">📚 课节视角</span></div><button class="db-close-btn" id="db-close">✕</button></div>' +
          '<div class="db-loading-wrap"><div class="db-spinner"></div><span class="db-loading-text">步骤 1/5 · 拉取全学期排课数据...</span><div class="db-progress-bar"><div class="db-progress-fill" style="width:20%"></div></div></div>';
        _progressLastTime = 0;
        loadLectureData();
      });
    }

    // === 标签筛选栏（复用） ===
    var filterBar = document.createElement('div');
    filterBar.className = 'db-filter-bar';
    filterBar.id = 'db-filter-bar';
    var totalAll = 0;
    for (var k in cats) { if (Number(k) !== 7) totalAll += cats[k].length; }  // "全部" 不含第7类（今天没课）
    var chipsList = [{ id: 0, label: '全部', count: totalAll }];
    CATS.forEach(function (c) { chipsList.push({ id: c.id, label: c.icon + ' ' + c.label, count: (cats[c.id] || []).length }); });
    chipsList.forEach(function (ch) {
      var cls = 'db-filter-chip' + (state.activeFilter === ch.id ? ' db-filter-chip--active' : '');
      filterBar.innerHTML += '<span class="' + cls + '" data-filter="' + ch.id + '">' + ch.label + '<span class="db-filter-count"> ' + ch.count + '</span></span>';
    });
    panelRoot.appendChild(filterBar);

    // === 表格（复用） ===
    var tableWrap = document.createElement('div');
    tableWrap.className = 'db-table-wrap';
    tableWrap.innerHTML = '<table class="db-table" id="db-table"><thead><tr>' +
      '<th class="db-th--action">动作</th><th class="db-th--cb">☐</th><th class="db-th--name">姓名</th>' +
      '<th class="db-th--time">时间</th><th class="db-th--status">状态</th><th class="db-th--level">评价</th>' +
      '<th class="db-th--ansrate">回答率</th><th class="db-th--asks">提问</th><th class="db-th--answers">回答</th>' +
      '<th class="db-th--firstrate">首对%</th><th class="db-th--duration">听课时长</th>' +
      '<th class="db-th--homework">作业</th><th class="db-th--tag">标签</th>' +
    '</tr></thead><tbody id="db-tbody"></tbody></table>';
    panelRoot.appendChild(tableWrap);

    // === 底部（复用） ===
    var footer = document.createElement('div');
    footer.className = 'db-footer';
    footer.innerHTML =
      '<span style="color:#888;font-size:11px;">进度：已完成 ' + progress.done + '/' + progress.needAction + '（' + progress.pct + '%）</span>' +
      '<div style="display:flex;gap:6px;">' +
        '<button class="db-btn db-btn--primary" id="db-export" title="导出Excel">📥</button>' +
        '<button class="db-btn db-btn--primary" id="db-settings" title="设置">⚙️</button>' +
      '</div>';
    panelRoot.appendChild(footer);

    // 绑定通用事件（标签/搜索/表格/导出/设置/checkbox）
    bindTableEvents();
  }

  /** 切换视角 */
  function switchViewMode(mode) {
    state.viewMode = mode;
    _progressLastTime = 0;
    doneMap = {};

    if (mode === 'lecture') {
      panelRoot.innerHTML = '<style>' + buildCSS() + '</style>' +
        '<div class="db-header"><div class="db-titlebar"><span class="db-title-text">📚 课节视角</span></div><button class="db-close-btn" id="db-close">✕</button></div>' +
        '<div class="db-loading-wrap"><div class="db-spinner"></div><span class="db-loading-text">步骤 1/5 · 初始化课程列表...</span><div class="db-progress-bar"><div class="db-progress-fill" style="width:20%"></div></div></div>';

      var cb1 = panelRoot.getElementById('db-close');
      if (cb1) cb1.addEventListener('click', closePanel);

      // 先拉课程列表
      fetchAllCourses().then(function (courses) {
        state.courseList = courses;
        // 默认全不选中 → 选中293（如果存在）
        if (courses.length > 0) {
          var has293 = courses.some(function (c) { return c.aiCourseId === 293; });
          state.lectureCourses = has293 ? [293] : [courses[0].aiCourseId];
        }
        // 加载全学期数据 → 提取课节 → 默认最近讲次
        fetchScheduleWideCached('2026-03-01', dateKey()).then(function (allSchedule) {
          state.lectures = extractLectures(allSchedule, state.lectureCourses);
          // 默认选中最近讲次
          if (state.lectures.length > 0) {
            // 按 latestDate 排序，取最晚的
            var sorted = state.lectures.slice().sort(function (a, b) { return (b.latestDate || '').localeCompare(a.latestDate || ''); });
            state.lectureLecNum = sorted[0].lecNum;
          }
          loadLectureData();
        }).catch(function (e) {
          console.error('[DailyBoard] 课节初始化失败:', e);
        });
      }).catch(function (e) {
        console.error('[DailyBoard] 课程列表加载失败:', e);
      });
    } else {
      // 切回日期视角
      state.viewDate = null;
      state.isHistoryMode = false;
      loadDoneStatus().then(function () {
        var cacheKey = _pck(todayKey());
        // 策略：先尝试 sessionStorage（最可靠，同一 session 内有效）
        var ssData = null;
        try {
          var ssRaw = sessionStorage.getItem(cacheKey);
          if (ssRaw) { var ssParsed = JSON.parse(ssRaw); if (ssParsed && ssParsed._v) ssData = ssParsed._v; }
        } catch (e) {}
        // 再尝试 chrome.storage.local（持久化，跨 session 有效）
        readCache(cacheKey).then(function (cr) {
          // 优先用 chrome.storage 的数据（更新），fallback 到 sessionStorage
          var cached = (cr.hit && cr.data && cr.data.students && cr.data.students.length > 0)
            ? cr.data
            : (ssData && ssData.students && ssData.students.length > 0 ? ssData : null);
          var source = (cr.hit && cr.data === cached) ? 'storage' : (ssData === cached ? 'sessionStorage' : 'none');

          if (cached) {
            console.log('[DailyBoard] ⚡ 切回今天秒出:', cached.students.length + '人', 'source=' + source);
            state.students = cached.students;
            state.dayRates = cached.dayRates || { totalStudents: 0, listenCount: 0, hwDoneCount: 0 };
            state.lastDataFetchTime = cached.lastDataFetchTime;
            state.enrichmentStatus = 'done';
            state.categories = classifyStudents(cached.students, new Date());
            var p = calcProgress(state.categories);
            renderContent(teacherName(), state.categories, p);
            loadData(true);
          } else {
            console.log('[DailyBoard] 切回今天无缓存，走完整加载');
            loadData();
          }
        }).catch(function () { loadData(); });
      });
    }
  }

  /* ── CloudBase 直连同步（只同步 doneMap + 摘要，学生详情由 API 实时重现）── */
  async function syncToCloudBase(studentId, isDone) {
    state.syncStatus = 'syncing';
    updateSyncUI();
    try {
      var date = dateKey();
      var teacherName = state.teacher.name || '';
      var docId = teacherName + '_' + date;

      // 构建 doneMap：只存教师手动打勾状态（不可重现的核心数据）
      var dm = {};
      if (state.students) {
        state.students.forEach(function (s) { dm[s.studentId] = !!doneMap[s.studentId]; });
      }

      // 计算汇总
      var doneCount = 0, needActionCount = 0;
      if (state.students) {
        state.students.forEach(function (s) {
          if ((s._catId || 0) >= 3) needActionCount++;
        });
      }
      for (var sid in doneMap) { if (doneMap[sid]) doneCount++; }
      var doneRate = needActionCount > 0 ? Math.round(doneCount / needActionCount * 100) : 0;

      var catSummary = {};
      for (var c = 1; c <= 7; c++) {
        var catList = (state.categories && state.categories[c]) ? state.categories[c] : [];
        var catDone = 0;
        catList.forEach(function (s) { if (doneMap[s.studentId]) catDone++; });
        catSummary[c] = { total: catList.length, done: catDone };
      }

      var dayRates = state.dayRates || { totalStudents: 0, listenCount: 0, hwDoneCount: 0 };

      // 本地备份 doneMap（最小兜底，CloudBase 不可用时降级使用）
      chrome.storage.local.set({ ['db_donemap_' + date]: dm });

      // CloudBase 文档：仅 doneMap + 摘要（学生详情由 API 实时重现，不再存云端快照）
      var doc = {
        date: date,
        teacherName: teacherName,
        teacherSubject: state.teacher.subject || '',
        teacherGrade: state.teacher.grade || '',
        teacherCenter: state.teacher.center || '',
        updatedAt: new Date().toISOString(),
        totalStudents: (state.students || []).length,
        doneMap: dm,
        doneCount: doneCount,
        needActionCount: needActionCount,
        doneRate: doneRate,
        dayRates: dayRates,
        catSummary: catSummary,
      };
      var cbIdKey = 'cb_docid_' + teacherName + '_' + date;
      var cbDocId = await new Promise(function (r) {
        chrome.storage.local.get([cbIdKey], function (d) { r(d[cbIdKey] || null); });
      });

      var result = await new Promise(function (resolve, reject) {
        chrome.runtime.sendMessage({
          action: 'DAILYBOARD_CB_SYNC',
          payload: {
            env: 'renewal-calendar-7ff2rtj4f876144',
            collection: 'teacher_daily_tasks',
            action: cbDocId ? 'update' : 'add',
            docId: cbDocId || undefined,
            data: doc,
          }
        }, function (resp) {
          if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
          if (resp && resp.ok) resolve(resp);
          else reject(new Error((resp && resp.error) || 'CloudBase 同步失败'));
        });
      });

      if (result.action === 'add') {
        chrome.storage.local.set({ [cbIdKey]: result.id });
        console.log('[DailyBoard] CloudBase add 成功:', result.id);
      } else {
        console.log('[DailyBoard] CloudBase update 成功:', result.id);
      }

      state.syncStatus = 'synced';
      state.lastSyncTime = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      updateSyncUI();
    } catch (e) {
      console.warn('[DailyBoard] CloudBase 写入失败（已本地备份 doneMap）:', e.message);
      state.syncStatus = 'error';
      updateSyncUI();
    }
  }

  function updateSyncUI() {
    if (!panelRoot) return;
    var dot = panelRoot.querySelector('.db-sync-dot');
    if (dot) dot.className = 'db-sync-dot db-sync-dot--' + (state.syncStatus === 'synced' ? 'synced' : state.syncStatus === 'error' ? 'error' : 'pending');
    var txt = dot && dot.nextElementSibling;
    if (txt) {
      txt.textContent = state.syncStatus === 'syncing' ? '同步中...' : state.syncStatus === 'error' ? '同步失败' : state.lastSyncTime ? '已同步 ' + state.lastSyncTime : '待同步';
    }
  }

  /* ── Excel 导出 ── */
  async function exportToExcel() {
    if (!state.students || state.students.length === 0) { alert('无数据可导出'); return; }
    console.log('[DailyBoard] 📥 发起 Excel 导出...');

    // 序列化导出数据发送给 background.js 处理（绕过 ISOLATED 世界限制）
    var cats = {};
    for (var c = 1; c <= 7; c++) {
      cats[c] = ((state.categories && state.categories[c]) || []).map(function (s) {
        return {
          studentName: s.studentName, studentId: s.studentId, className: s.className,
          gradeName: s.gradeName, subjectName: s.subjectName,
          scheduleTime: s.scheduleTime, endTime: s.endTime,
          _catId: s._catId,
          userPeriodLevel: (s._raw && s._raw.userPeriodLevel) || '',
          participationRate: s.participation && s.participation.rate != null ? s.participation.rate : null,
          askCount: s.askCount, answerCount: s.answerCount,
          firstCorrectRate: s.firstCorrectRate,
          inClassOnlineDuration: s.inClassOnlineDuration,
          homeworkStatusDesc: s.homeworkStatusDesc,
          overallTag: s.overallTag,
        };
      });
    }
    var exportPayload = {
      teacherName: teacherName(),
      teacherSubject: state.teacher.subject || '',
      teacherGrade: state.teacher.grade || '',
      viewDate: state.viewDate || todayKey(),
      isHistoryMode: !!state.isHistoryMode,
      dayRates: state.dayRates,
      doneMap: doneMap,
      categories: cats,
      boundStudents: window.__db_boundStudents || [],
    };

    chrome.runtime.sendMessage({ action: 'DAILYBOARD_EXPORT_EXCEL', payload: exportPayload }, function (res) {
      if (chrome.runtime.lastError) {
        console.error('[DailyBoard] 导出失败:', chrome.runtime.lastError.message);
        alert('导出失败: ' + chrome.runtime.lastError.message);
      } else if (res && !res.ok) {
        console.error('[DailyBoard] 导出失败:', res.error);
        alert('导出失败: ' + res.error);
      } else {
        console.log('[DailyBoard] 📥 导出成功:', res.size + ' bytes');
      }
    });
  }

  /* ── 内联 CSS ── */
  function buildCSS() {
    return [
      /* 面板 */
      '.db-panel{position:fixed;top:0;height:100vh;z-index:2147483645;background:#fff;display:flex;flex-direction:column;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;font-size:13px;color:#1a1a1a;box-shadow:2px 0 16px rgba(0,0,0,0.1);transition:transform 300ms ease,opacity 300ms ease;border-radius:0;}',
      '.db-panel--closing{transform:translateX(-100%);opacity:0;}',
      /* 头部 — 全部一行，搜索框弹性填充 */
      '.db-header{padding:8px 12px 6px;border-bottom:1px solid #e8eaed;flex-shrink:0;background:#fff;position:relative;}',
      '.db-titlebar{display:flex;align-items:center;gap:6px;width:100%;}',
      '.db-title-icon{font-size:18px;flex-shrink:0;}',
      '.db-title-text{font-size:16px;font-weight:700;color:#1a1a1a;flex-shrink:0;}',
      '.db-meta-inline{font-size:13px;color:#555;flex-shrink:0;}',      /* 教师信息内联 */
      '.db-search-input{flex:1;min-width:60px;max-width:280px;padding:5px 10px;border:1px solid #ddd;border-radius:14px;font-size:13px;outline:none;background:#f8f8f8;transition:border-color 0.15s;}',
      '.db-search-input:focus{border-color:#4a6cf7;background:#fff;box-shadow:0 0 0 2px rgba(74,108,247,0.1);}',
      '.db-search-input::placeholder{color:#aaa;}',
      '.db-stats-inline{font-size:13px;color:#666;flex-shrink:0;white-space:nowrap;}',   /* 统计内联 */
      '.db-stats-inline b{color:#222;font-weight:700;margin:0 3px;}',
      '.db-data-time-label{font-size:12px;color:#555;background:#e8eaed;padding:2px 10px;border-radius:10px;white-space:nowrap;flex-shrink:0;}',
      /* 当日比率 */
      '.db-dayrates{display:flex;align-items:center;gap:8px;padding:4px 12px;font-size:13px;color:#555;background:#f8f9fb;border-bottom:1px solid #e8eaed;flex-wrap:wrap;}',
      '.db-rate-item{white-space:nowrap;}',
      '.db-rate-item b{color:#4a6cf7;font-weight:700;font-size:14px;}',
      '.db-rate-divider{color:#ccc;}',
      '.db-rate-hint{font-size:11px;color:#999;}',
      '.db-btn{background:#f0f2f5;border:none;font-size:14px;cursor:pointer;padding:4px 8px;border-radius:6px;flex-shrink:0;transition:background 0.15s;}',
      '.db-btn:hover{background:#e1e4ea;}',
      '.db-btn--primary{background:#4a6cf7;color:#fff;}',
      '.db-btn--primary:hover{background:#3b5ce4;}',
      '.db-close-btn{position:absolute;top:6px;right:10px;background:none;border:none;font-size:16px;cursor:pointer;color:#999;padding:3px 5px;border-radius:4px;flex-shrink:0;}',
      '.db-close-btn:hover{background:#f0f0f0;color:#333;}',      /* 标签筛选 */
      '.db-filter-bar{display:flex;gap:5px;padding:8px 14px;overflow-x:auto;border-bottom:1px solid #f0f0f0;flex-shrink:0;background:#fafbfc;}',
      '.db-filter-bar::-webkit-scrollbar{height:0;display:none;}',
      '.db-filter-chip{padding:4px 12px;border-radius:14px;font-size:11px;cursor:pointer;border:1px solid #e8e8e8;background:#fff;white-space:nowrap;user-select:none;transition:all 0.15s;font-weight:500;color:#555;}',
      '.db-filter-chip:hover{border-color:#4a6cf7;color:#4a6cf7;background:#f8faff;}',
      '.db-filter-chip--active{background:#4a6cf7;color:#fff;border-color:#4a6cf7;box-shadow:0 2px 6px rgba(74,108,247,0.25);}',
      '.db-filter-chip .db-filter-count{opacity:0.75;margin-left:3px;font-weight:400;}',
      /* 学情表绑定 */
      '.db-bind-banner{padding:8px 14px;font-size:12px;color:#888;background:#fff8e1;border-bottom:1px solid #ffe082;flex-shrink:0;}',
      '.db-bind-banner a{cursor:pointer;color:#4a6cf7;text-decoration:underline;font-weight:500;}',
      '.db-bind-banner a:hover{color:#3b5ce4;}',
      '.db-bind-textarea:focus{outline:none;border-color:#4a6cf7;box-shadow:0 0 0 2px rgba(74,108,247,0.1);}',
      /* 表格 */
      '.db-table-wrap{flex:1;overflow:auto;position:relative;background:#fff;}',
      '.db-table-wrap::-webkit-scrollbar{width:6px;height:6px;}',
      '.db-table-wrap::-webkit-scrollbar-thumb{background:#d0d4d8;border-radius:3px;}',
      '.db-table{width:100%;border-collapse:separate;border-spacing:0;table-layout:auto;}',
      '.db-table thead{position:sticky;top:0;z-index:3;}',
      '.db-table th{padding:10px 8px;font-size:13.5px;font-weight:700;color:#333;background:#f0f2f5;border-bottom:2px solid #d8dce3;text-align:left;white-space:nowrap;position:sticky;top:0;z-index:3;}',
      /* 列宽 — 13列紧凑布局，880面板 */
      '.db-th--action{width:100px;padding-left:12px!important;}',
      '.db-th--cb{width:26px;text-align:center;}',
      '.db-th--name{width:50px;}',
      '.db-th--time{width:80px;}',
      '.db-th--status{width:52px;}',
      '.db-th--level{width:36px;text-align:center;}',
      '.db-th--ansrate{width:52px;text-align:center;}',
      '.db-th--asks{width:32px;text-align:center;}',
      '.db-th--answers{width:32px;text-align:center;}',
      '.db-th--firstrate{width:50px;text-align:center;}',
      '.db-th--duration{width:68px;}',
      '.db-th--homework{width:56px;}',
      '.db-th--tag{width:68px;}',
      '.db-table td{padding:7px 8px;font-size:12px;border-bottom:1px solid #f0f0f0;vertical-align:middle;transition:background 0.1s;}',
      '.db-table tbody tr:hover td{background:#f5f7ff!important;}',
      /* 行颜色 — 仅动作列有左侧色条，无大面积背景 */
      '.db-row--cat1{color:#aaa;}',
      '.db-row--cat2 .db-td--action{border-left:3px solid #81c784;background:#f0faf4;}',
      '.db-row--cat3 .db-td--action{border-left:3px solid #e57373;background:#fef4f4;font-weight:500;}',
      '.db-row--cat4 .db-td--action{border-left:3px solid #81c784;background:#f0fdf4;}',
      '.db-row--cat5 .db-td--action{border-left:3px solid #ffb74d;background:#fffbeb;}',
      '.db-row--cat6 .db-td--action{border-left:3px solid #e57373;background:#fff8e1;font-weight:500;}',
      '.db-row--cat7{color:#999;}',
      '.db-row--done{opacity:0.45;text-decoration:line-through;}',
      '.db-row--done .db-td--cb{opacity:1;}',
      /* 进度条 */
      '.db-enrich-bar{width:100%;height:4px;background:#e0e0e0;border-radius:2px;overflow:hidden;margin-top:4px;}',
      '.db-enrich-fill{height:100%;background:linear-gradient(90deg,#4caf50,#8bc34a);border-radius:2px;transition:width 0.3s;}',
      /* 动作 */
      '.db-td--action{font-size:11.5px;line-height:1.4;padding-left:12px!important;}',
      '.db-action-text{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.db-action--info{color:#888;}',
      '.db-action--warn{color:#d84315;font-weight:500;}',
      '.db-action--danger{color:#c62828;font-weight:500;}',
      /* Checkbox */
      '.db-td--cb{text-align:center;}',
      '.db-checkbox{appearance:none;-webkit-appearance:none;width:15px;height:15px;border:2px solid #ccc;border-radius:3px;cursor:pointer;position:relative;margin:0;vertical-align:middle;}',
      '.db-checkbox:checked{background:#4caf50;border-color:#4caf50;}',
      '.db-checkbox:checked::after{content:"";position:absolute;top:1px;left:4px;width:4px;height:8px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg);}',
      '.db-checkbox:disabled{opacity:0.2;cursor:default;}',
      /* 姓名 */
      '.db-td--name{font-weight:600;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#222;}',
      /* 时间 */
      '.db-td--time{font-size:11.5px;color:#666;white-space:nowrap;font-family:"SF Mono",SFMono-Regular,Consolas,"Liberation Mono",Menlo,monospace;}',
      /* 状态 */
      '.db-status-badge{font-size:10px;padding:2px 8px;border-radius:10px;white-space:nowrap;font-weight:500;display:inline-block;}',
      '.db-status-badge--pending{background:#ececec;color:#999;border:1px solid #ddd;}',
      '.db-status-badge--inclass{background:#e8f5e9;color:#2e7d32;border:1px solid #c8e6c9;}',
      '.db-status-badge--noreport{background:#fce4ec;color:#c62828;border:1px solid #ef9a9a;}',
      '.db-status-badge--done{background:#e3f2fd;color:#1565c0;border:1px solid #bbdefb;}',
      '.db-status-badge--noclass{background:#f5f5f5;color:#aaa;border:1px solid #eee;}',
      /* 评价 */
      '.db-td--level{text-align:center;font-weight:700;font-size:13px;}',
      '.db-level--a{color:#2e7d32;}',
      '.db-level--b{color:#1565c0;}',
      '.db-level--c{color:#e65100;}',
      '.db-level--none{color:#aaa;}',
      /* 报告指标 */
      '.db-td--ansrate{text-align:center;font-size:11.5px;color:#555;}',
      '.db-td--asks{text-align:center;font-size:11.5px;color:#555;}',
      '.db-td--answers{text-align:center;font-size:11.5px;color:#555;}',
      '.db-td--firstrate{text-align:center;font-size:11.5px;color:#555;}',
      '.db-td--duration{font-size:11px;color:#666;white-space:nowrap;}',
      '.db-td--homework{font-size:11px;color:#666;white-space:nowrap;}',
      /* 报告标签 */
      '.db-report-tag{font-size:10px;padding:2px 8px;border-radius:10px;white-space:nowrap;display:inline-block;font-weight:500;border:1px solid transparent;}',
      '.db-report-tag--excellent{background:#e8f5e9;color:#2e7d32;border-color:#c8e6c9;}',
      '.db-report-tag--warn{background:#fff8e1;color:#e65100;border-color:#ffe0b2;}',
      '.db-report-tag--danger{background:#fce4ec;color:#c62828;border-color:#ef9a9a;}',
      '.db-report-tag--critical{background:#fce4ec;color:#b71c1c;border-color:#ef9a9a;font-weight:600;}',
      '.db-report-tag--none{color:#ccc;font-style:italic;}',
      /* 日期选择器 */
      '.db-date-picker{font-size:12px;padding:3px 6px;border:1px solid #ddd;border-radius:6px;cursor:pointer;background:#fff;color:#333;font-weight:500;flex-shrink:0;outline:none;}',
      '.db-date-picker:focus{border-color:#4a6cf7;box-shadow:0 0 0 2px rgba(74,108,247,0.1);}',
      /* 历史模式标签 */
      '.db-history-badge{font-size:11px;color:#e65100;background:#fff3e0;border:1px solid #ffe0b2;border-radius:8px;padding:1px 10px;white-space:nowrap;font-weight:500;flex-shrink:0;}',
      /* 异常单元格红底（非整行，仅特定列） */
      '.db-cell--alert{background:#fef0f0!important;color:#c62828!important;font-weight:700;}',
      '.db-cell--alert span{color:inherit!important;}',
      /* 底部 */
      '.db-footer{padding:6px 14px;border-top:1px solid #e8eaed;font-size:11px;color:#999;display:flex;align-items:center;gap:6px;flex-shrink:0;}',
      '.db-sync-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0;}',
      '.db-sync-dot--synced{background:#4caf50;}',
      '.db-sync-dot--error{background:#f44336;}',
      '.db-sync-dot--pending{background:#ff9800;animation:db-pulse 1.5s infinite;}',
      '@keyframes db-pulse{0%,100%{opacity:1}50%{opacity:0.4}}',      /* 弹窗 */
      '.db-modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:2147483647;display:flex;align-items:center;justify-content:center;}',
      '.db-modal{background:#fff;border-radius:12px;padding:20px 24px;min-width:320px;box-shadow:0 8px 32px rgba(0,0,0,0.2);}',
      '.db-modal-title{font-size:15px;font-weight:600;margin-bottom:10px;}',
      '.db-modal-body{font-size:13px;color:#666;margin-bottom:6px;line-height:1.5;}',
      '.db-modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:14px;}',
      /* 加载 */
      '.db-loading-wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:10px;color:#999;}',
      '.db-spinner{width:24px;height:24px;border:3px solid #e0e0e0;border-top-color:#2196f3;border-radius:50%;animation:db-spin 0.8s linear infinite;}',
      '@keyframes db-spin{to{transform:rotate(360deg)}}',
      '.db-loading-text{font-size:12px;margin-bottom:2px;}',
      '.db-progress-bar{width:180px;height:4px;background:#e8e8e8;border-radius:2px;overflow:hidden;}',
      '.db-progress-fill{height:100%;background:linear-gradient(90deg,#4a6cf7,#6d8ff7);border-radius:2px;transition:width 0.4s ease;}',
      /* 窄窗口 */
      '@media(max-width:900px){.db-panel--narrow{left:50%!important;top:50%!important;transform:translate(-50%,-50%)!important;height:80vh!important;width:90vw!important;max-width:500px!important;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.25)!important;}}',
      '.db-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.3);z-index:2147483644;}',
    ].join('');
  }

  /* ── 暴露 API ── */
  window.__db = {
    open: openPanel,
    close: closePanel,
    refresh: function () { loadData(true); },
    setBoundStudents: function (list) { window.__db_boundStudents = list; chrome.storage.local.set({ db_boundStudents: list }); },
  };

  /* ── 全局诊断函数 — 在 Console 执行 __dbDiag() ──
   *  同时暴露给 ISOLATED 世界（content script 内部）和 MAIN 世界（通过 background 注入） */
  window.__dbDiag = async function () {
    var info = await collectDiagInfo();
    console.table(info.table);
    info.lines.forEach(function (l) { console.log(l); });
    console.log('✅ 诊断完成。');
  };

  /** 更新加载进度文字+进度条 */
  var _progressLastTime = 0;
  function setLoadingProgress(step, total, msg) {
    if (!panelRoot) return;
    var now = Date.now();
    _progressLastTime = now;
    var textEl = panelRoot.querySelector('.db-loading-text');
    if (textEl) textEl.textContent = '\u6B65\u9AA4 ' + step + '/' + total + ' \u00B7 ' + msg;
    var fillEl = panelRoot.querySelector('.db-progress-fill');
    if (fillEl) fillEl.style.width = Math.round(step / total * 100) + '%';
  }

  /* ── 缓存辅助函数（sessionStorage，同tab秒出，最简单可靠） ── */

  function _pck(dateStr) {
    return 'db_panel_cache_' + (dateStr || dateKey());
  }

  function _lck(courseIds, lecNum) {
    var sorted = courseIds.slice().sort(function (a, b) { return a - b; });
    return 'db_lecture_cache_' + sorted.join(',') + '_' + lecNum;
  }

  /** 读缓存（sessionStorage），同步返回 { hit, data } */
  function readCache(key) {
    try {
      var raw = sessionStorage.getItem(key);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.students && parsed.students.length > 0) {
          console.log('[DailyBoard] 💾 缓存命中:', key, parsed.students.length + '人');
          return { hit: true, data: parsed };
        }
      }
    } catch (e) {}
    return { hit: false, data: null };
  }

  /** 写缓存（sessionStorage），同步 */
  function writeCache(key, data) {
    if (!data || !data.students || data.students.length === 0) return;
    try {
      sessionStorage.setItem(key, JSON.stringify(data));
      console.log('[DailyBoard] 💾 缓存写入:', key, data.students.length + '人');
    } catch (e) {}
  }

  /** 收集诊断数据（供 ISOLATED 和 MAIN 世界共用） */
  async function collectDiagInfo() {
    var info = {};
    info.today = (function () { var d = new Date(); return d.toString(); })();
    info.todayKey = dateKey();
    info.viewDate = state.viewDate;
    info.isHistoryMode = state.isHistoryMode;
    info.teacherName = state.teacher.name || '(未获取)';
    info.teacherSubject = state.teacher.subject || '(未设)';
    info.teacherGrade = state.teacher.grade || '(未设)';
    info.studentsCount = state.students ? state.students.length : 0;
    info.categories = {};
    if (state.categories) {
      for (var c = 1; c <= 7; c++) {
        info.categories[c] = state.categories[c] ? state.categories[c].length : 0;
      }
    }
    info.dayRates = state.dayRates;
    info.doneMapKeys = Object.keys(doneMap).length;
    info.enrichmentStatus = state.enrichmentStatus;
    info.lastDataFetchTime = state.lastDataFetchTime;
    // 检查 chrome.storage.local 缓存
    var pk2 = _pck(dateKey());
    var cr2 = readCache(pk2);
    info.panelCacheExists = cr2.hit;
    info.panelCacheStale = false;
    info.panelCacheDate = dateKey();
    info.panelCacheStudents = (cr2.data && cr2.data.students) ? cr2.data.students.length : 0;

    // 收集前5个学生的时间原始值
    var timeSamples = [];
    if (state.students && state.students.length > 0) {
      for (var i = 0; i < Math.min(5, state.students.length); i++) {
        var s = state.students[i];
        var rawEndTime = s._raw ? (s._raw.classTimeEnd || s._raw.endTime) : null;
        var rawStartTime = s._raw ? (s._raw.classTimeStart || s._raw.startTime || s._raw.classStartTime) : null;
        timeSamples.push({
          name: s.studentName,
          scheduleTime: s.scheduleTime,
          scheduleTimeType: typeof s.scheduleTime,
          endTime: s.endTime,
          endTimeType: typeof s.endTime,
          rawStartTime: rawStartTime,
          rawStartTimeType: typeof rawStartTime,
          rawEndTime: rawEndTime,
          rawEndTimeType: typeof rawEndTime,
          parsedStart: parseTime(s.scheduleTime).toString(),
          parsedEnd: s.endTime ? parseTime(s.endTime).toString() : 'N/A',
          inClassOnlineDuration: s.inClassOnlineDuration,
          _catId: s._catId,
        });
      }
    }

    var table = [
      { 字段: 'today', 值: info.today },
      { 字段: 'todayKey', 值: info.todayKey },
      { 字段: 'viewDate', 值: String(info.viewDate) },
      { 字段: 'isHistoryMode', 值: String(info.isHistoryMode) },
      { 字段: 'teacherName', 值: info.teacherName },
      { 字段: 'teacherSubject', 值: info.teacherSubject },
      { 字段: 'teacherGrade', 值: info.teacherGrade },
      { 字段: 'studentsCount', 值: String(info.studentsCount) },
      { 字段: 'cat1(未上课)', 值: String(info.categories[1] || 0) },
      { 字段: 'cat2(上课中)', 值: String(info.categories[2] || 0) },
      { 字段: 'cat3(无报告)', 值: String(info.categories[3] || 0) },
      { 字段: 'cat4(优秀)', 值: String(info.categories[4] || 0) },
      { 字段: 'cat5(敷衍但会)', 值: String(info.categories[5] || 0) },
      { 字段: 'cat6(敷衍)', 值: String(info.categories[6] || 0) },
      { 字段: 'cat7(没课)', 值: String(info.categories[7] || 0) },
      { 字段: 'dayRates.listenCount', 值: String(info.dayRates.listenCount) },
      { 字段: 'dayRates.hwDoneCount', 值: String(info.dayRates.hwDoneCount) },
      { 字段: 'dayRates.totalStudents', 值: String(info.dayRates.totalStudents) },
      { 字段: 'doneMapKeys', 值: String(info.doneMapKeys) },
      { 字段: 'enrichmentStatus', 值: info.enrichmentStatus },
      { 字段: 'lastDataFetchTime', 值: String(info.lastDataFetchTime || '') },
      { 字段: 'panelCacheExists', 值: String(info.panelCacheExists) },
      { 字段: 'panelCacheStale', 值: String(info.panelCacheStale) },
    ];

    var lines = [
      '',
      '📋 前5个学生的原始时间字段:',
    ];
    timeSamples.forEach(function (ts, i) {
      lines.push('  [' + (i+1) + '] ' + ts.name +
        ' | scheduleTime=' + JSON.stringify(ts.scheduleTime) + ' (' + ts.scheduleTimeType + ')' +
        ' | endTime=' + JSON.stringify(ts.endTime) + ' (' + ts.endTimeType + ')' +
        ' | cat=' + ts._catId +
        ' | parsedStart=' + ts.parsedStart +
        ' | parsedEnd=' + ts.parsedEnd);
      if (ts.rawStartTime !== undefined) {
        lines.push('       _raw.startTime=' + JSON.stringify(ts.rawStartTime) + ' (' + ts.rawStartTimeType + ')' +
          ' _raw.endTime=' + JSON.stringify(ts.rawEndTime) + ' (' + ts.rawEndTimeType + ')');
      }
      lines.push('       inClassOnlineDuration=' + JSON.stringify(ts.inClassOnlineDuration));
    });

    // 扫描 chrome.storage.local 中所有 db_* 备份
    lines.push('');
    lines.push('🗄️ chrome.storage.local 备份清单:');
    try {
      var allItems = await new Promise(function (resolve) {
        chrome.storage.local.get(null, resolve);
      });
      var dbKeys = Object.keys(allItems).filter(function (k) { return k.startsWith('db_'); });
      if (dbKeys.length === 0) {
        lines.push('  ⚠️ chrome.storage.local 无 db_ 前缀的缓存记录。');
      } else {
        dbKeys.sort().forEach(function (k) {
          var v = allItems[k];
          var desc = '';
          if (k.indexOf('db_cloudbackup_') === 0) {
            desc = v && v.students ? '备份 ' + v.students.length + '人, updatedAt=' + v.updatedAt : '解析失败';
          } else if (k.indexOf('db_done_') === 0) {
            var doneObj = {};
            try { doneObj = JSON.parse(v || '{}'); } catch (e) {}
            desc = 'checkbox ' + Object.keys(doneObj).length + '个已勾选';
          } else if (k.indexOf('db_enrich_cache_') === 0) {
            desc = v && v.forEach ? '富化缓存 ' + v.length + '条' : '格式未知';
          } else {
            desc = typeof v === 'string' ? v.substring(0, 60) : JSON.stringify(v).substring(0, 80);
          }
          lines.push('  ' + k + ' → ' + desc);
        });
      }
    } catch (e) {
      lines.push('  ❌ 读取失败: ' + e.message);
    }

    return { table: table, lines: lines };
  }

  /* ── 历史数据重备份：重新拉取+富化+保存完整格式 ── */
  /* ── MAIN 世界桥接：让用户在 Console 直接执行 __dbDiag() ── */
  (function setupDiagBridge() {
    // 响应来自 MAIN 世界的诊断请求
    window.addEventListener('message', async function (e) {
      if (e.data && e.data.type === 'DB_DIAG_REQUEST') {
        var diag = await collectDiagInfo();
        window.postMessage({
          type: 'DB_DIAG_RESPONSE',
          requestId: e.data.requestId,
          table: diag.table,
          lines: diag.lines,
        }, '*');
      }
    });

    // 请求 background 在 MAIN 世界注入桥接函数
    if (!window.__dbDiagBridgeInjected) {
      window.__dbDiagBridgeInjected = true;
      try {
        chrome.runtime.sendMessage({ action: 'DAILYBOARD_INJECT_DIAG' });
      } catch (e) {
        console.warn('[DailyBoard] 诊断桥接注入请求失败:', e.message);
      }
    }
  })();

})();
