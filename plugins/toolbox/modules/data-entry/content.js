/**
 * 批量录入成绩 v1.2.0 — Toolbox 模块化版本（content.js）
 *
 * UI 对标调课助手排课 Tab 设计语言：
 * - 下载模板 + 提示文字 + 大文本框 + 格式说明 + 蓝色大解析按钮
 * - 数据预览表格 + 开始录入按钮 + 进度/统计区
 */
(function () {
  'use strict';

  console.log('[批量录入] 模块正在初始化...');

  // ===== 常量 =====
  var API_BASE = 'https://ai-genesis.yuaiweiwu.com/prod-api/student-center-ai';

  // 下拉选项白名单
  var EXAM_TYPES = ['期中', '期末', '中考', '高考', '进班考', '其他'];
  var SUBJECTS = ['语文', '数学', '英语', '物理', '化学', '综合课'];
  var SCORE_FORMS = ['分数', '等级', '排名'];

  // 下拉值 → API 数字映射
  var EXAM_TYPE_MAP = { '期中': 1, '期末': 2, '中考': 3, '高考': 4, '进班考': 5, '其他': 6 };
  var SUBJECT_MAP = { '语文': 1, '数学': 2, '英语': 3, '物理': 4, '化学': 5, '综合课': 6 };
  var SCORE_FORM_MAP = { '分数': 1, '等级': 2, '排名': 3 };

  var STATUS = {
    PENDING: 'pending',
    RUNNING: 'running',
    SUCCESS: 'success',
    FAIL: 'fail',
    RETRY_OK: 'retry_ok',
  };

  var STATUS_LABEL = {};
  STATUS_LABEL[STATUS.PENDING] = '⏳待执行';
  STATUS_LABEL[STATUS.RUNNING] = '🔄执行中';
  STATUS_LABEL[STATUS.SUCCESS] = '✅成功';
  STATUS_LABEL[STATUS.FAIL] = '❌失败';
  STATUS_LABEL[STATUS.RETRY_OK] = '✅重试成功';

  var STATUS_CSS = {};
  STATUS_CSS[STATUS.PENDING] = 'de-status-pending';
  STATUS_CSS[STATUS.RUNNING] = 'de-status-running';
  STATUS_CSS[STATUS.SUCCESS] = 'de-status-success';
  STATUS_CSS[STATUS.FAIL] = 'de-status-fail';
  STATUS_CSS[STATUS.RETRY_OK] = 'de-status-success';

  var CONCURRENCY = 5;
  var RETRY_DELAY_MS = 2000;

  // ===== 全局状态 =====
  var entryList = [];
  var isRunning = false;
  var studentNameCache = {};
  var studentRegIdCache = {};

  // ===== Shadow DOM =====
  var shadowRoot = window.__shadowRoots__ && window.__shadowRoots__['data-entry'];
  var _moduleRoot = null;

  if (shadowRoot) {
    renderModuleUI(shadowRoot);
  } else {
    console.warn('[批量录入] 未找到壳提供的 Shadow DOM 容器');
  }

  function $(sel) { return _moduleRoot ? _moduleRoot.querySelector(sel) : null; }

  function sendMsg(msg) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.runtime.sendMessage(msg, function (resp) {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(resp);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // ===== 渲染 UI =====

  function renderModuleUI(root) {
    _moduleRoot = root;
    loadNameCache();

    var container = document.createElement('div');
    container.className = 'de-module-root';
    container.innerHTML =

      // 模板下载区
      '<div class="de-section" style="padding-bottom:4px;">' +
      '  <label class="de-section-label">📊 批量录入成绩</label>' +
      '  <button id="de-btn-template" class="de-btn de-btn-outline">📥 下载Excel模板</button>' +
      '  <div class="de-input-hint">下载模板 → Excel填写 → 全选复制 → 粘贴到下方</div>' +
      '</div>' +

      // 粘贴输入区
      '<div class="de-section">' +
      '  <textarea id="de-input-paste" class="de-textarea" rows="6" placeholder="学员ID\t考试类型\t学科\t成绩形式\t成绩内容\n1385357\t期中\t数学\t分数\t85/100\n1433869\t期末\t英语\t等级\tA\n\n考试类型：期中/期末/中考/高考/进班考/其他\n学科：语文/数学/英语/物理/化学/综合课\n成绩形式：分数/等级/排名"></textarea>' +
      '  <div class="de-input-hint">5列：学员ID | 考试类型 | 学科 | 成绩形式 | 成绩内容</div>' +
      '  <div id="de-parse-feedback" class="de-parse-feedback de-hidden"></div>' +
      '  <button id="de-btn-parse" class="de-btn de-btn-primary de-btn-block">解析数据</button>' +
      '</div>' +

      // 数据预览区（始终显示，无数据时占位提示）
      '<div id="de-preview-section" class="de-preview-section">' +
      '  <div class="de-table-wrap" id="de-table-wrap">' +
      '    <table class="de-table">' +
      '      <thead><tr>' +
      '        <th>#</th><th>学员ID</th><th>姓名</th>' +
      '        <th>考试类型</th><th>学科</th><th>成绩形式</th><th>成绩内容</th><th>状态</th>' +
      '      </tr></thead>' +
      '      <tbody id="de-tbody"><tr><td colspan="8" style="text-align:center;color:#bbb;padding:20px;">暂无数据，请在上方粘贴后点击「解析数据」</td></tr></tbody>' +
      '    </table>' +
      '  </div>' +
      '  <div id="de-empty-hint" class="de-empty-hint">待录入条数: <b>0</b></div>' +
      '</div>' +

      // 执行控制区 + 进度统计合并
      '<div id="de-action-section" class="de-action-section de-hidden">' +
      '  <button id="de-btn-exec" class="de-btn de-btn-success de-btn-block">▶ 开始录入</button>' +
      '  <div class="de-progress-bar-wrapper" style="margin-top:10px;"><div id="de-progress-bar" class="de-progress-bar-fill" style="width:0%"></div></div>' +
      '  <div class="de-stats-row">' +
      '    <span class="de-stat-item de-stat-total">总计: <b id="de-stat-total">0</b></span>' +
      '    <span class="de-stat-item de-stat-success">✅ 成功: <b id="de-stat-success">0</b></span>' +
      '    <span class="de-stat-item de-stat-fail">❌ 失败: <b id="de-stat-fail">0</b></span>' +
      '    <span class="de-stat-item de-stat-pending">⏳ 待执行: <b id="de-stat-pending">0</b></span>' +
      '  </div>' +
      '  <button id="de-btn-reset" class="de-btn de-btn-secondary de-btn-block de-hidden" style="margin-top:8px;">🔄 重新录入</button>' +
      '</div>';

    root.appendChild(container);
    bindEvents();
  }

  // ===== 事件绑定 =====

  function bindEvents() {
    $('#de-btn-template').addEventListener('click', downloadTemplate);
    $('#de-btn-parse').addEventListener('click', parseData);
    $('#de-btn-exec').addEventListener('click', startExecution);
    $('#de-btn-reset').addEventListener('click', resetAll);
  }

  // ===== 显示/隐藏工具函数 =====

  function show(id) { var el = $('#' + id); if (el) el.classList.remove('de-hidden'); }
  function hide(id) { var el = $('#' + id); if (el) el.classList.add('de-hidden'); }
  function setText(id, text) {
    var el = $('#' + id);
    if (el) el.textContent = text;
  }

  function showFeedback(msg, isError) {
    var el = $('#de-parse-feedback');
    if (!el) return;
    el.textContent = msg;
    el.className = 'de-parse-feedback ' + (isError ? 'de-feedback-err' : 'de-feedback-ok');
    el.classList.remove('de-hidden');
  }

  // ===== 解析数据 =====

  async function parseData() {
    var ta = $('#de-input-paste');
    if (!ta) return;
    var text = ta.value.trim();
    if (!text) {
      showFeedback('请先粘贴数据', true);
      return;
    }

    var parsed = parsePastedData(text);
    if (parsed.valid.length === 0 && parsed.skipped === 0) {
      showFeedback('未解析到有效数据，请检查格式是否正确', true);
      return;
    }

    entryList = parsed.valid;

    var invalidCount = entryList.filter(function(e) { return e.status === STATUS.FAIL; }).length;
    var validCount = entryList.length - invalidCount;

    var msg = '解析完成：共 ' + entryList.length + ' 条';
    if (parsed.skipped > 0) msg += '，已跳过 ' + parsed.skipped + ' 行';
    if (invalidCount > 0) msg += '，❌ ' + invalidCount + ' 条格式错误';

    if (parsed.errors.length > 0 || invalidCount > 0) {
      var allErrs = parsed.errors.slice();
      for (var ei = 0; ei < entryList.length; ei++) {
        if (entryList[ei].status === STATUS.FAIL && entryList[ei].errorMsg) {
          allErrs.push('第' + (ei + 1) + '行 ' + entryList[ei].errorMsg);
        }
      }
      msg += '\n' + allErrs.slice(0, 4).join('\n');
      if (allErrs.length > 4) msg += '\n...等 ' + allErrs.length + ' 处错误';
      showFeedback(msg, true);
    } else {
      showFeedback(msg, false);
    }

    renderPreviewTable();
    show('de-action-section');
    hide('de-btn-reset');

    var hintEl = $('#de-empty-hint');
    if (hintEl) hintEl.innerHTML = '待录入条数: <b>' + validCount + '</b>' + (invalidCount > 0 ? '（' + invalidCount + '条格式错误）' : '');

    var btnExec = $('#de-btn-exec');
    if (btnExec) {
      btnExec.disabled = invalidCount > 0;
      btnExec.textContent = invalidCount > 0 ? '▶ 有格式错误，请修正后重试' : '▶ 开始录入';
    }

    updateProgress(0);

    // 批量获取姓名和登记ID（等拿到后再更新预览，确保录入时 id 就绪）
    var ids = entryList.map(function (e) { return e.studentId; });
    await batchFetchNames(ids);
    for (var i = 0; i < entryList.length; i++) {
      var sid = String(entryList[i].studentId);
      if (studentNameCache[sid]) entryList[i].name = studentNameCache[sid];
      if (studentRegIdCache[sid] && !entryList[i].id) entryList[i].id = studentRegIdCache[sid];
    }
    renderPreviewTable();
  }

  // ===== 粘贴解析 =====

  function parsePastedData(text) {
    var lines = text.trim().split(/\r?\n/);
    var valid = [];
    var skipped = 0;
    var errors = [];

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;

      var cols = line.split('\t');

      // 跳过表头行
      var firstCell = (cols[0] || '').trim();
      if (/学员ID|ID|考试|学科|成绩/.test(firstCell)) continue;

      var studentId = firstCell.replace(/\(.*\)/, '').trim();
      if (!studentId || !/^\d+$/.test(studentId)) { skipped++; continue; }

      var examType = (cols[1] || '').trim() || '期中';
      var subject = (cols[2] || '').trim() || '数学';
      var scoreForm = (cols[3] || '').trim() || '分数';
      var scoreContent = (cols[4] || '').trim();

      // 白名单校验
      var rowErrors = [];
      if (!/^\d{5,}$/.test(studentId)) rowErrors.push('ID格式错误（需5位以上数字）');
      if (EXAM_TYPES.indexOf(examType) === -1) rowErrors.push('考试类型"' + examType + '"不在范围内（可选：' + EXAM_TYPES.join('/') + '）');
      if (SUBJECTS.indexOf(subject) === -1) rowErrors.push('学科"' + subject + '"不在范围内（可选：' + SUBJECTS.join('/') + '）');
      if (SCORE_FORMS.indexOf(scoreForm) === -1) rowErrors.push('成绩形式"' + scoreForm + '"不在范围内（可选：' + SCORE_FORMS.join('/') + '）');
      if (!scoreContent) rowErrors.push('成绩内容不能为空');

      // 成绩内容格式匹配校验
      if (scoreContent && rowErrors.length === 0) {
        if (scoreForm === '分数') {
          // 分数：应包含数字，如 "85/100"、"92"、"150分"
          if (!/\d/.test(scoreContent)) {
            rowErrors.push('成绩内容"' + scoreContent + '"不像分数（应包含数字）');
          }
        } else if (scoreForm === '等级') {
          // 等级：通常 A/B/C/D 或 优/良/中/差
          if (/[0-9]{2,}/.test(scoreContent) && !/[ABCDF甲乙丙丁优良中差]/.test(scoreContent)) {
            rowErrors.push('成绩内容"' + scoreContent + '"不像等级（应包含字母或中文等级）');
          }
        } else if (scoreForm === '排名') {
          // 排名：应纯数字
          if (!/^\d+$/.test(scoreContent)) {
            rowErrors.push('排名"' + scoreContent + '"应为纯数字');
          }
        }
      }

      valid.push({
        id: studentRegIdCache[studentId] || '',
        studentId: studentId,
        name: studentNameCache[studentId] || '',
        examType: examType,
        subject: subject,
        scoreForm: scoreForm,
        scoreContent: scoreContent,
        status: rowErrors.length > 0 ? STATUS.FAIL : STATUS.PENDING,
        errorMsg: rowErrors.length > 0 ? rowErrors[0] : '',
      });
    }

    return { valid: valid, skipped: skipped, errors: errors };
  }

  // ===== 预览表格 =====

  function renderPreviewTable() {
    var tbody = $('#de-tbody');
    if (!tbody) return;

    if (entryList.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#aaa;padding:20px;">暂无数据</td></tr>';
      return;
    }

    var html = '';
    for (var i = 0; i < entryList.length; i++) {
      var row = entryList[i];
      var rowCls = row.status === STATUS.FAIL ? 'de-row-err' : '';
      var nameTxt = row.name || (row.studentId ? '<span class="de-name-loading">…</span>' : '');
      var statusTxt = row.errorMsg ? escHtml(row.errorMsg) : STATUS_LABEL[row.status];
      var statusCls = STATUS_CSS[row.status] || 'de-status-pending';

      html += '<tr class="' + rowCls + '">' +
        '<td>' + (i + 1) + '</td>' +
        '<td>' + escHtml(row.studentId) + '</td>' +
        '<td>' + nameTxt + '</td>' +
        '<td>' + escHtml(row.examType) + '</td>' +
        '<td>' + escHtml(row.subject) + '</td>' +
        '<td>' + escHtml(row.scoreForm) + '</td>' +
        '<td>' + escHtml(row.scoreContent) + '</td>' +
        '<td><span class="' + statusCls + '">' + statusTxt + '</span></td>' +
        '</tr>';
    }

    tbody.innerHTML = html;
  }

  function renderSingleRowStatus(index, entry) {
    var tbody = $('#de-tbody');
    if (!tbody) return;
    var rows = tbody.querySelectorAll('tr');
    var row = rows[index];
    if (!row) return;

    var statusCell = row.querySelector('td:last-child');
    if (statusCell) {
      var cls = STATUS_CSS[entry.status] || 'de-status-pending';
      var txt = entry.errorMsg ? escHtml(entry.errorMsg) : STATUS_LABEL[entry.status];
      statusCell.innerHTML = '<span class="' + cls + '">' + txt + '</span>';
    }

    if (entry.status === STATUS.FAIL) {
      row.classList.add('de-row-err');
    } else {
      row.classList.remove('de-row-err');
    }
  }

  // ===== 重置 =====

  function resetAll() {
    entryList = [];
    isRunning = false;
    var ta = $('#de-input-paste');
    if (ta) ta.value = '';
    var fb = $('#de-parse-feedback');
    if (fb) { fb.textContent = ''; fb.classList.add('de-hidden'); }
    hide('de-action-section');
    // 恢复空态
    var tbody = $('#de-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#bbb;padding:20px;">暂无数据，请在上方粘贴后点击「解析数据」</td></tr>';
    var hintEl = $('#de-empty-hint');
    if (hintEl) hintEl.innerHTML = '待录入条数: <b>0</b>';
    updateProgress(0);
  }

  // ===== 执行 =====

  async function startExecution() {
    if (isRunning) return;
    if (entryList.length === 0) return;

    var invalidCount = entryList.filter(function(e) { return e.status === STATUS.FAIL; }).length;
    if (invalidCount > 0) {
      alert('有 ' + invalidCount + ' 条数据格式错误，请修正后重新解析');
      return;
    }

    var validItems = [];
    for (var i = 0; i < entryList.length; i++) {
      if (entryList[i].status !== STATUS.FAIL) {
        validItems.push({ entry: entryList[i], index: i });
      }
    }

    if (validItems.length === 0) {
      alert('没有可提交的数据，请检查校验错误后重试');
      return;
    }

    isRunning = true;

    // 隐藏执行按钮，显示进度
    hide('de-btn-exec');

    updateStats(validItems.length, 0, 0, validItems.length);
    updateProgress(0);

    // 首轮执行
    var failedItems = await executeBatch(validItems, false);

    // 自动重试
    var stillFailed = [];
    if (failedItems.length > 0) {
      await sleep(RETRY_DELAY_MS);
      stillFailed = await executeBatch(failedItems, true);
    }

    // 完成
    isRunning = false;
    var successCount = validItems.length - stillFailed.length;
    updateProgress(100);
    updateStats(validItems.length, successCount, stillFailed.length, 0);
    renderPreviewTable();

    // 更新底部计数
    var hintEl = $('#de-empty-hint');
    if (hintEl) hintEl.innerHTML = '待录入条数: <b>' + entryList.length + '</b>';

    show('de-reset-section');
  }

  async function executeBatch(items, isRetry) {
    var failed = [];
    var total = items.length;
    var done = 0;
    var successCount = 0;
    var failCount = 0;

    for (var batchStart = 0; batchStart < total; batchStart += CONCURRENCY) {
      var batch = items.slice(batchStart, batchStart + CONCURRENCY);
      var results = await Promise.all(batch.map(function (item) {
        return executeSingle(item, isRetry);
      }));

      for (var i = 0; i < results.length; i++) {
        done++;
        if (results[i].success) {
          successCount++;
        } else {
          failCount++;
          failed.push(results[i].item);
        }

        updateProgress(Math.round(done / total * 100));
        var pending = total - done;
        updateStats(total, successCount, failCount, pending);

        if (results[i].item) {
          renderSingleRowStatus(results[i].item.index, results[i].item.entry);
        }
      }
    }

    return failed;
  }

  async function executeSingle(item, isRetry) {
    var entry = item.entry;
    entry.status = STATUS.RUNNING;
    entry.errorMsg = '';
    renderSingleRowStatus(item.index, entry);

    try {
      console.log('[批量录入] 提交: studentId=' + entry.studentId + ', id=' + (entry.id || '(空)') + ', subject=' + entry.subject);
      var body = {
        id: entry.id || '',
        studentId: String(entry.studentId),
        subjectId: SUBJECT_MAP[entry.subject] || 1,
        examType: EXAM_TYPE_MAP[entry.examType] || 1,
        scoreForm: SCORE_FORM_MAP[entry.scoreForm] || 1,
        scoreContent: entry.scoreContent,
      };

      var resp = await fetch(API_BASE + '/regularCourse/next/student/score/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!resp.ok) throw new Error('HTTP ' + resp.status);

      var result = await resp.json();

      if (result.code === '000000') {
        entry.status = isRetry ? STATUS.RETRY_OK : STATUS.SUCCESS;
        entry.errorMsg = '';
        if (result.data && result.data.id) entry.id = result.data.id;
        return { success: true, item: item };
      } else {
        entry.status = STATUS.FAIL;
        entry.errorMsg = result.mesg || '未知错误';
        return { success: false, item: item };
      }
    } catch (e) {
      entry.status = STATUS.FAIL;
      entry.errorMsg = isRetry ? ('仍失败: ' + e.message) : e.message;
      return { success: false, item: item };
    }
  }

  // ===== 进度 / 统计 =====

  function updateProgress(pct) {
    var bar = $('#de-progress-bar');
    if (bar) bar.style.width = pct + '%';
  }

  function updateStats(total, success, fail, pending) {
    setText('de-stat-total', total);
    setText('de-stat-success', success);
    setText('de-stat-fail', fail);
    setText('de-stat-pending', pending);
  }

  // ===== 姓名缓存 =====

  function loadNameCache() {
    try {
      var raw = localStorage.getItem('de_name_cache');
      if (raw) studentNameCache = JSON.parse(raw);
    } catch (e) { /* ignore */ }

    try {
      var raw2 = localStorage.getItem('de_regid_cache');
      if (raw2) studentRegIdCache = JSON.parse(raw2);
    } catch (e) { /* ignore */ }

    try {
      chrome.storage.local.get(['studentRoster'], function (result) {
        if (result.studentRoster && Array.isArray(result.studentRoster)) {
          result.studentRoster.forEach(function (s) {
            var id = String(s.studentId || s.id || '');
            var name = s.name || s.studentName || '';
            if (id && name && !studentNameCache[id]) studentNameCache[id] = name;
          });
          saveAllCache();
        }
      });
    } catch (e) { /* ignore */ }
  }

  function saveAllCache() {
    try { localStorage.setItem('de_name_cache', JSON.stringify(studentNameCache)); } catch (e) { /* ignore */ }
    try { localStorage.setItem('de_regid_cache', JSON.stringify(studentRegIdCache)); } catch (e) { /* ignore */ }
  }

  async function batchFetchNames(studentIds) {
    console.log('[批量录入] batchFetchNames 开始, studentIds数量:', studentIds.length);

    var unknown = studentIds.filter(function (sid) {
      return !studentNameCache[String(sid)] || !studentRegIdCache[String(sid)];
    });
    console.log('[批量录入] 需要拉取的学生数:', unknown.length, '(已有缓存:', studentIds.length - unknown.length, ')');
    if (unknown.length === 0) {
      console.log('[批量录入] 所有学生已有缓存，跳过拉取');
      return;
    }

    var schoolYear = '', schoolTermIds = '';

    // ===== 方法1：从页面已发出的 student/list 请求URL中直接提取参数 =====
    // 最可靠的方式：页面加载时已经调用了 student/list，URL里带好了 schoolYear 和 schoolTermIds
    try {
      var entries = performance.getEntriesByType('resource');
      console.log('[批量录入] 方法1: performance entries 数量:', entries.length);
      for (var i = entries.length - 1; i >= 0; i--) {
        var entryName = entries[i].name;
        if (entryName.indexOf('student/list') !== -1 && entryName.indexOf('schoolYear') !== -1) {
          var url = new URL(entryName);
          schoolYear = url.searchParams.get('schoolYear') || '';
          schoolTermIds = url.searchParams.get('schoolTermIds') || '';
          console.log('[批量录入] 方法1成功: schoolYear=' + schoolYear + ', schoolTermIds=' + schoolTermIds);
          break;
        }
      }
    } catch (e) {
      console.warn('[批量录入] 方法1异常:', e.message);
    }

    // ===== 方法2：从DOM读schoolYear + Vue store读schoolTermIds（备选） =====
    if (!schoolYear || !schoolTermIds) {
      console.log('[批量录入] 方法1未找到参数，尝试方法2 (DOM+Vue store)');
      try {
        var yearInput = document.querySelector('.el-input__inner[placeholder="请选择学年"]');
        console.log('[批量录入] yearInput:', yearInput ? ('value=' + yearInput.value) : 'null');
        if (yearInput) schoolYear = yearInput.value;

        var tagEls = document.querySelectorAll('.el-tag--info');
        var tagNames = [];
        tagEls.forEach(function(t) { var n = t.textContent.trim(); if (n && n.length < 10) tagNames.push(n); });
        console.log('[批量录入] tagNames:', tagNames);

        var appEl = document.querySelector('#app');
        console.log('[批量录入] #app元素:', appEl ? 'found' : 'null', '| __vue__:', appEl && appEl.__vue__ ? 'available' : 'unavailable');
        if (appEl && appEl.__vue__ && appEl.__vue__.$store) {
          var semesterList = appEl.__vue__.$store.state.dataConfig.dataDict.semester || [];
          console.log('[批量录入] semesterList数量:', semesterList.length);
          var termIds = [];
          tagNames.forEach(function(name) {
            var found = semesterList.find(function(s) { return s.name === name; });
            if (found) {
              termIds.push(found.id);
              console.log('[批量录入] 学期匹配:', name, '->', found.id);
            }
          });
          schoolTermIds = termIds.join(',');
        } else {
          console.warn('[批量录入] Vue store 不可访问（content script 隔离世界限制）');
        }
      } catch (e) {
        console.warn('[批量录入] 方法2异常:', e.message);
      }
    }

    if (!schoolYear || !schoolTermIds) {
      console.error('[批量录入] 无法获取学年学期参数! schoolYear=' + schoolYear + ', schoolTermIds=' + schoolTermIds);
      return;
    }

    console.log('[批量录入] 最终参数: schoolYear=' + schoolYear + ', schoolTermIds=' + schoolTermIds);

    try {
      var resp = await fetch(API_BASE + '/regularCourse/next/student/list?schoolYear=' + encodeURIComponent(schoolYear) + '&schoolTermIds=' + encodeURIComponent(schoolTermIds) + '&fieldType=intentionLevel');
      console.log('[批量录入] student/list HTTP状态:', resp.status);
      if (resp.ok) {
        var result = await resp.json();
        console.log('[批量录入] 返回code:', result.code);
        var list = (result.data && result.data.studentList) || [];
        console.log('[批量录入] 返回学生数:', list.length);
        if (list.length > 0) {
          console.log('[批量录入] 首条样本:', JSON.stringify({ id: list[0].id, studentId: list[0].studentId, userName: list[0].userName }));
        }
        list.forEach(function (row) {
          var sid = String(row.studentId || '');
          var name = row.userName || row.nickName || '';
          var regId = row.id || '';
          if (sid && name) studentNameCache[sid] = name;
          if (sid && regId) studentRegIdCache[sid] = regId;
        });
        saveAllCache();
        console.log('[批量录入] 缓存更新完毕, regIdCache大小:', Object.keys(studentRegIdCache).length);
      } else {
        console.warn('[批量录入] student/list HTTP错误:', resp.status, resp.statusText);
      }
    } catch (e) {
      console.warn('[批量录入] 批量拉取学员数据失败:', e.message);
    }
  }

  // ===== 下载模板 =====

  async function downloadTemplate() {
    try {
      var resp = await sendMsg({ target: 'data-entry', action: 'GENERATE_GRADE_TEMPLATE' });
      var result = (resp && resp.data) ? resp.data : resp;
      if (!result || !result.xlsxBase64) {
        alert('生成模板失败: ' + (result && result.error ? result.error : '未知错误'));
        return;
      }

      var byteChars = atob(result.xlsxBase64);
      var byteNums = new Uint8Array(byteChars.length);
      for (var i = 0; i < byteChars.length; i++) byteNums[i] = byteChars.charCodeAt(i);
      var blob = new Blob([byteNums], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      var url = URL.createObjectURL(blob);

      var a = document.createElement('a');
      a.href = url;
      a.download = '成绩录入模板.xlsx';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      alert('下载模板失败: ' + e.message);
    }
  }

  // ===== 工具函数 =====

  function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

})();
