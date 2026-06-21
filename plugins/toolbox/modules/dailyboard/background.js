/* ==========================================
   每日工作看板 — background.js
   报告数据富化引擎（Service Worker）
   CloudBase 同步已迁移至 content.js 直连
   ========================================== */

(function () {
  'use strict';

  const CFG = {
    WORK_DOMAIN: 'ai-genesis.yuaiweiwu.com',
    AITUTOR_BASE: 'https://next.aitutor100.com',
    BIZ_API: '/prod-api/student-center-ai/ai/teacher/ai/biz',
    MAX_CONCURRENT: 20,  // 提升到20并发，加速富化（原10需25-30秒，现在~12-15秒）
  };

  console.log('[DailyBoard/SW] 启动 v2.2.38 (双源分离架构: doneMap云端 + 学生数据API实时重现)');

  /* ===========================================================
     Part A: 报告分析引擎（从 report/analysis.js 移植）
     =========================================================== */
  const Analysis = (function () {
    function judgeParticipation(askCount, answerCount) {
      var rate = askCount > 0 ? (answerCount / askCount * 100) : 0;
      var tag, label;
      if (rate >= 80) { tag = 'success'; label = '✅ 积极互动'; }
      else if (rate >= 60) { tag = 'normal'; label = '👍 正常参与'; }
      else if (rate >= 40) { tag = 'warn'; label = '⚠️ 不太积极'; }
      else if (rate >= 20) { tag = 'danger'; label = '🔴 敷衍上课'; }
      else { tag = 'critical'; label = '🚨 严重敷衍'; }
      return { rate: Math.round(rate * 10) / 10, tag: tag, label: label };
    }

    function judgeMastery(firstCorrect, guideCorrect, guideNum, masteryRating, answerCount) {
      var firstRate = answerCount > 0 ? (firstCorrect / answerCount * 100) : 0;
      var uncertain = answerCount < 3 ? '?' : '';
      var tag, label;
      if (firstRate >= 60 && ['A+', 'A'].indexOf(masteryRating) !== -1) {
        tag = 'success'; label = '✅ 掌握扎实' + uncertain;
      } else if ((firstRate >= 30 && firstRate < 60) || masteryRating === 'B+') {
        tag = 'good'; label = '👍 基本掌握' + uncertain;
      } else if ((firstRate >= 10 && firstRate < 30) || ['B', 'C'].indexOf(masteryRating) !== -1) {
        tag = 'warn'; label = '⚠️ 有漏洞' + uncertain;
      } else {
        tag = 'danger'; label = '🔴 未掌握' + uncertain;
      }
      return { firstRate: Math.round(firstRate * 10) / 10, tag: tag, label: label };
    }

    function judgeExercise(correctCount, totalWithRecord) {
      if (totalWithRecord === 0) return { rate: null, tag: 'normal', label: '-' };
      var rate = correctCount / totalWithRecord * 100;
      var tag, label;
      if (rate >= 80) { tag = 'success'; label = '✅ 全对'; }
      else if (rate >= 50) { tag = 'good'; label = '👍 大部分对'; }
      else if (rate >= 20) { tag = 'warn'; label = '⚠️ 错较多'; }
      else { tag = 'danger'; label = '🔴 大部分错'; }
      return { rate: Math.round(rate * 10) / 10, tag: tag, label: label };
    }

    function classifyQuadrant(participation, mastery, rawMasteryRating) {
      var rateVal = participation.rate;
      var mr = rawMasteryRating;
      var hasMastery = mr && mr !== '-';
      var quadrant, tag, tagClass;

      if (hasMastery) {
        var masteryLevel;
        if (mr === 'A+' || mr === 'A') { masteryLevel = 'good'; }
        else if (mr === 'B+') { masteryLevel = 'mid'; }
        else { masteryLevel = 'bad'; }
        var rateHigh = rateVal > 80;
        if (masteryLevel === 'good' && rateHigh) {
          quadrant = 'Q1'; tag = '⭐优秀'; tagClass = 'success';
        } else if (masteryLevel === 'mid' && rateHigh) {
          quadrant = 'Q2'; tag = '👍认真'; tagClass = 'info';
        } else if (masteryLevel === 'bad' && rateHigh) {
          quadrant = 'Q3'; tag = '⚠️需辅导'; tagClass = 'warning';
        } else if ((masteryLevel === 'good' || masteryLevel === 'mid') && !rateHigh) {
          quadrant = 'Q4'; tag = '🚨敷衍但会'; tagClass = 'danger';
        } else {
          quadrant = 'Q5'; tag = '🔴敷衍'; tagClass = 'critical';
        }
      } else {
        if (rateVal > 80) {
          quadrant = 'Q1'; tag = '👍认真'; tagClass = 'info';
        } else if (rateVal > 40) {
          quadrant = 'Q4'; tag = '⚠️需关注'; tagClass = 'warning';
        } else {
          quadrant = 'Q5'; tag = '🔴敷衍'; tagClass = 'danger';
        }
      }
      return { quadrant: quadrant, tag: tag, tagClass: tagClass };
    }

    function analyze(raw) {
      var totalAsk = raw.knowledgeList.reduce(function (s, k) { return s + (k.teacherAsk || 0); }, 0);
      var totalAnswer = raw.knowledgeList.reduce(function (s, k) { return s + (k.stuAnswer || 0); }, 0);
      var firstCorrectTotal = raw.knowledgeList.reduce(function (s, k) { return s + (k.firstCorrect || 0); }, 0);
      var guideCorrectTotal = raw.knowledgeList.reduce(function (s, k) { return s + (k.guideCorrect || 0); }, 0);
      var guideNumTotal = raw.knowledgeList.reduce(function (s, k) { return s + (k.guideNum || 0); }, 0);

      var participation = judgeParticipation(totalAsk, totalAnswer);
      var mastery = judgeMastery(firstCorrectTotal, guideCorrectTotal, guideNumTotal, raw.masteryRating, totalAnswer);

      var exerciseRecords = raw.exercises.filter(function (e) { return e.hasRecord; });
      var exerciseCorrect = exerciseRecords.filter(function (e) { return e.correct; }).length;
      var exercise = judgeExercise(exerciseCorrect, exerciseRecords.length);

      var quadrant = classifyQuadrant(participation, mastery, raw.masteryRating);

      return {
        name: raw.name,
        masteryRating: raw.masteryRating || '-',
        participation: participation,
        mastery: mastery,
        exercise: exercise,
        quadrant: quadrant.quadrant,
        overallTag: quadrant.tag,
        overallTagClass: quadrant.tagClass,
      };
    }

    return { analyze: analyze };
  })();

  /* ===========================================================
     Part B: 工作台 API
     =========================================================== */
  async function workApi(path, params) {
    var url = new URL('https://' + CFG.WORK_DOMAIN + path);
    if (params) {
      Object.keys(params).forEach(function (k) {
        if (params[k] != null && params[k] !== '') url.searchParams.set(k, params[k]);
      });
    }
    var res = await fetch(url.toString(), {
      headers: { 'Accept': 'application/json' },
      credentials: 'include',
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var json = await res.json();
    var ok = ['000000', '0', '200', 0, 200];
    if (json.code !== undefined && ok.indexOf(json.code) === -1) {
      throw new Error('API(' + json.code + '): ' + (json.msg || json.mesg || ''));
    }
    return json;
  }

  /* ===========================================================
     Part C: 报告数据获取（一人一管）
     =========================================================== */

  /** 从原始行数据中提取 periodId */
  function findPeriodId(row) {
    var candidates = ['bookingId','periodId','id','classPeriodId','scheduleId','recordId','courseRecordId','lessonId','classScheduleId','classId'];
    for (var i = 0; i < candidates.length; i++) {
      if (row[candidates[i]] !== undefined && row[candidates[i]] !== null && row[candidates[i]] !== '') {
        return row[candidates[i]];
      }
    }
    // 嵌套查找
    var keys = Object.keys(row);
    for (var j = 0; j < keys.length; j++) {
      var v = row[keys[j]];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (var k = 0; k < candidates.length; k++) {
          if (v[candidates[k]] !== undefined && v[candidates[k]] !== null && v[candidates[k]] !== '') {
            return v[candidates[k]];
          }
        }
      }
    }
    return null;
  }

  /** Step2+3: biz接口 → 短链 → 跟随重定向 → reportToken */
  async function getReportToken(periodId, studentName) {
    // Step2: biz（对齐报告模块：数字参数，非字符串）
    var bizRes = await workApi(CFG.BIZ_API, {
      id: periodId,
      urlType: 2,
      broadcastType: 3,
      courseClassify: 3,
    });
    var shortUrl = (bizRes.data && bizRes.data.aiBizUrl) || null;
    if (!shortUrl) throw new Error('biz未返回短链');

    // Step3: 跟随重定向
    var finalUrl = shortUrl;
    try {
      var r1 = await fetch(shortUrl, { redirect: 'follow' });
      if (r1.url && r1.url !== shortUrl) finalUrl = r1.url;
    } catch (e) {}
    if (finalUrl === shortUrl) {
      try {
        var r2 = await fetch(shortUrl, { redirect: 'manual' });
        var loc = r2.headers.get('location');
        if (loc) finalUrl = loc;
      } catch (e) {}
    }

    var match = finalUrl.match(/report=([^&]+)/);
    var reportToken = match ? decodeURIComponent(match[1]) : null;
    if (!reportToken) throw new Error('URL中无report参数');
    return reportToken;
  }

  /** Step4: 从 aitutor100 获取报告数据 */
  async function fetchReportData(reportToken, courseClassify, studyVersion) {
    var ct = courseClassify || 3;
    var sv = studyVersion || 1;
    var hdrs = { 'Accept': 'application/json, text/plain, */*', 'source-sn': 'PROD' };

    var api1Url = CFG.AITUTOR_BASE + '/ai-math-engine/lesson/report/queryCoursePeriodReport?report=' + encodeURIComponent(reportToken) + '&courseType=' + ct + '&studyVersion=' + sv;
    var api2Url = CFG.AITUTOR_BASE + '/ai-math-engine/lesson/report/queryComponentDialogueList?report=' + encodeURIComponent(reportToken);
    var [res1, res2] = await Promise.all([
      fetch(api1Url, { headers: hdrs, credentials: 'include' }),
      fetch(api2Url, { headers: hdrs, credentials: 'include' }),
    ]);
    var json1 = await res1.json();
    // 错题统计（非关键）
    var api1Data = json1 && json1.data ? json1.data : {};
    var uid = api1Data.stuId || api1Data.uid || api1Data.studentId;
    var periodId = api1Data.periodId || api1Data.classPeriodId;
    if (uid && periodId) {
      try {
        var api3Url = CFG.AITUTOR_BASE + '/ai-math-engine/mistake/period/module/summary?uid=' + uid + '&periodId=' + periodId + '&studyVersion=' + sv;
        var res3 = await fetch(api3Url, { headers: hdrs, credentials: 'include' });
        var json3 = await res3.json();
        if (json3 && json3.data) {
          if (!api1Data.mistakeSummaryVo) api1Data.mistakeSummaryVo = json3.data;
          else api1Data.mistakeSummaryVo = Object.assign({}, api1Data.mistakeSummaryVo, json3.data);
        }
      } catch (e) { /* 非关键 */ }
    }
    return json1;
  }

  /** 解析报告 JSON */
  function parseReport(json) {
    if (!json || !json.data) return null;
    var d = json.data;
    var knowledgeList = (d.knowledgeDtoList || []).map(function (k) {
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
    var exercises = [];
    if (d.courseDetail) {
      for (var ci = 0; ci < d.courseDetail.length; ci++) {
        var comp = d.courseDetail[ci];
        if (comp.studyComponentList) {
          for (var si = 0; si < comp.studyComponentList.length; si++) {
            var sc = comp.studyComponentList[si];
            if (sc.componentType === 3) exercises.push({ hasRecord: true, correct: sc.answerCorrect === true });
          }
        }
        if (comp.componentType === 3) exercises.push({ hasRecord: true, correct: comp.answerCorrect === true });
      }
    }
    // masteryRating 取值逻辑与学习报告 (report/content.js parseReportData) 完全一致
    // 优先级: d.masteryRating → d.masteredInfo.masteryRating → knowledgeList[].rating
    var masteryRating = d.masteryRating || (d.masteredInfo && d.masteredInfo.masteryRating) || null;
    if (!masteryRating && knowledgeList.length > 0) {
      for (var mk = 0; mk < knowledgeList.length; mk++) {
        if (knowledgeList[mk].rating && knowledgeList[mk].rating !== '-') {
          masteryRating = knowledgeList[mk].rating; break;
        }
      }
    }
    return {
      name: d.studentName || d.stuName || '',
      courseName: d.courseName || '',
      lessonName: d.lessonName || d.periodName || '',
      masteryRating: masteryRating || '-',
      focusRating: (d.focusInfo && d.focusInfo.focusRating) || null,
      focusAnswer: (d.focusInfo && d.focusInfo.focusAnswer) || 0,
      overOther: (d.focusInfo && d.focusInfo.overOther !== undefined) ? (d.focusInfo.overOther * 100 + '%') : '0%',
      interactNum: d.interactNum || 0,
      wrongNum: (d.mistakeSummaryVo && d.mistakeSummaryVo.wrongNum) || 0,
      questionNum: (d.mistakeSummaryVo && d.mistakeSummaryVo.questionNum) || 0,
      knowledgeList: knowledgeList,
      exercises: exercises,
    };
  }

  /** 完整管道：一人份 */
  async function enrichOneStudent(studentId, studentName, rawRow) {
    var label = (studentName || studentId || '?');
    try {
      // Step A: 找 periodId（优先 bookingId，同报告模块逻辑）
      var periodId = findPeriodId(rawRow);
      if (!periodId) {
        // 尝试从嵌套字段找（API可能把periodId放在courseVo里）
        var nested = rawRow.courseVo || rawRow.course || rawRow.period;
        if (nested && typeof nested === 'object') periodId = findPeriodId(nested);
      }
      if (!periodId) { console.log('[DailyBoard/SW] ' + label + ' ❌ 未找到periodId, 可用字段:', Object.keys(rawRow).slice(0, 10).join(',')); return { studentId: studentId, studentName: studentName, error: '未找到periodId' }; }
      console.log('[DailyBoard/SW] ' + label + ' periodId=' + periodId);

      // Step B: biz→短链→reportToken
      var reportToken = await getReportToken(periodId, studentName);
      if (!reportToken) return { studentId: studentId, studentName: studentName, error: '未获取到reportToken' };

      // Step C: 3个AITutor API
      var courseClassify = rawRow.courseClassify || 3;
      var studyVersion = rawRow.studyVersion || 1;
      var reportJson = await fetchReportData(reportToken, courseClassify, studyVersion);
      if (!reportJson || !reportJson.data) return { studentId: studentId, studentName: studentName, error: '报告数据为空' };

      // Step D: 解析+分析
      var parsed = parseReport(reportJson);
      if (!parsed) return { studentId: studentId, studentName: studentName, error: '解析失败' };

      var result = Analysis.analyze(parsed);
      // 透传原始计数（content.js 表格渲染需要）
      result.askCount = parsed.knowledgeList.reduce(function(s,k){return s+(k.teacherAsk||0);},0);
      result.answerCount = parsed.knowledgeList.reduce(function(s,k){return s+(k.stuAnswer||0);},0);
      result.firstCorrectRate = result.mastery.firstRate;
      result.studentId = studentId;
      result.studentName = studentName;
      console.log('[DailyBoard/SW] ' + label + ' ✅ ' + result.overallTag);
      return result;
    } catch (e) {
      console.log('[DailyBoard/SW] ' + label + ' ❌ ' + e.message);
      return { studentId: studentId, studentName: studentName, error: e.message };
    }
  }

  /** 批量富化（并发 + 进度回调） */
  async function batchEnrich(rawRows, onProgress) {
    var items = [];
    for (var i = 0; i < rawRows.length; i++) {
      var row = rawRows[i];
      var sid = String(row.studentId || '');
      var sname = row.studentName || row.userName || row.realName || '';
      if (sid) {
        items.push({ idx: i, studentId: sid, studentName: sname, rawRow: row });
      }
    }

    if (items.length === 0) { console.log('[DailyBoard/SW] 无学生需富化'); return []; }

    console.log('[DailyBoard/SW] 批量富化 ' + items.length + ' 人...');
    var results = [];
    var running = 0, next = 0, doneCount = 0;
    var total = items.length;

    function processOne(item) {
      return enrichOneStudent(item.studentId, item.studentName, item.rawRow).then(function (res) {
        results.push({ idx: item.idx, data: res });
        doneCount++;
        if (typeof onProgress === 'function') onProgress(doneCount, total, item.studentName);
      });
    }

    return new Promise(function (resolve) {
      function startNext() {
        while (running < CFG.MAX_CONCURRENT && next < items.length) {
          var item = items[next++];
          running++;
          processOne(item).finally(function () {
            running--;
            if (next < items.length) startNext();
            else if (running === 0) resolve(results);
          });
        }
        if (next >= items.length && running === 0) resolve(results);
      }
      startNext();
    });
  }

  /* ===========================================================
     Part D: 验证是否已重约课（分类3打勾后检查）
     =========================================================== */
  async function checkReClassed(studentId, oldClassStartTime, oldClassEndTime) {
    try {
      // 拉取未来7天的排课，检查该学生是否被重新安排
      var today = new Date();
      var startDate = formatDate(today);
      var end = new Date(today.getTime() + 7 * 86400000);
      var endDate = formatDate(end);
      var json = await workApi('/prod-api/student-center-ai/regularCourse/next/class/list', {
        startDate: startDate + ' 00:00:00',
        endDate: endDate + ' 23:59:59',
        current: '1', size: '500',
      });
      var rows = (json.data && (json.data.classList || json.data.records || [])) || [];
      if (!Array.isArray(rows)) rows = [];
      var futureClasses = rows.filter(function (r) {
        return String(r.studentId) === String(studentId) || String(r.userId) === String(studentId);
      });
      return {
        success: true,
        reClassed: futureClasses.length > 0,
        futureCount: futureClasses.length,
        futureClasses: futureClasses.slice(0, 5).map(function (c) {
          return { time: c.classStartTime || '', course: c.courseName || c.className || '' };
        }),
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  function formatDate(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /* ===========================================================
     Part E: 消息路由
     =========================================================== */
  chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    // 报告富化
    if (request.action === 'DAILYBOARD_ENRICH_REPORTS') {
      var rawRows = request.payload && request.payload.rawRows;
      if (!rawRows || !Array.isArray(rawRows)) { sendResponse({ ok: false, error: '缺少 rawRows' }); return false; }
      console.log('[DailyBoard/SW] ENRICH_REPORTS: ' + rawRows.length + ' 条原始数据');

      // 获取发送方 tab ID，用于进度推送
      var progressTabId = (sender.tab && sender.tab.id) ? sender.tab.id : null;

      var progressCb = null;
      if (progressTabId) {
        progressCb = function (done, total, studentName) {
          try {
            chrome.tabs.sendMessage(progressTabId, {
              action: 'DAILYBOARD_ENRICH_PROGRESS',
              done: done,
              total: total,
              studentName: studentName || '',
            });
          } catch (e) { /* 忽略发送失败 */ }
        };
      }

      batchEnrich(rawRows, progressCb).then(function (results) {
        console.log('[DailyBoard/SW] 富化完成: ' + results.length + ' 人');
        // 发送完成信号
        if (progressTabId) {
          try {
            chrome.tabs.sendMessage(progressTabId, {
              action: 'DAILYBOARD_ENRICH_PROGRESS',
              done: results.length,
              total: results.length,
              finished: true,
            });
          } catch (e) {}
        }
        sendResponse({ ok: true, data: results });
      }).catch(function (err) {
        console.error('[DailyBoard/SW] 富化失败:', err);
        sendResponse({ ok: false, error: err.message });
      });
      return true;
    }

    // 验证重约
    if (request.action === 'DAILYBOARD_CHECK_RECLASS') {
      var p = request.payload || {};
      checkReClassed(p.studentId, p.oldClassStartTime, p.oldClassEndTime).then(function (res) {
        sendResponse({ ok: true, data: res });
      }).catch(function (err) {
        sendResponse({ ok: false, error: err.message });
      });
      return true;
    }

    // CloudBase 同步：使用 chrome.scripting.executeScript 在主世界执行
    // 绕过 ai-genesis.yuaiweiwu.com 页面的 CSP 限制（不允许内联脚本/unsafe-eval）
    if (request.action === 'DAILYBOARD_CB_SYNC') {
      var data = request.payload || {};
      var tabId = (sender.tab && sender.tab.id) ? sender.tab.id : null;
      if (!tabId) { sendResponse({ ok: false, error: 'No tab ID' }); return false; }

      // Step 1: 注入 CloudBase SDK 到页面主世界
      chrome.scripting.executeScript({
        target: { tabId: tabId },
        world: 'MAIN',
        files: ['lib/cloudbase.full.js'],
      }, function () {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: 'SDK 注入失败: ' + chrome.runtime.lastError.message });
          return;
        }
        // Step 2: 执行同步逻辑
        chrome.scripting.executeScript({
          target: { tabId: tabId },
          world: 'MAIN',
          func: function (params) {
            return (async function () {
              var cb = window.cloudbase;
              if (!cb) return { ok: false, error: 'window.cloudbase 未找到' };
              if (cb.default && typeof cb.default.init === 'function') cb = cb.default;
              var app = cb.init({ env: params.env });
              var db = app.database();
              var auth = app.auth();
              var state = await auth.getLoginState();
              if (!state) await auth.anonymousAuthProvider().signIn();

              if (params.action === 'add') {
                var res = await db.collection(params.collection).add(params.data);
                console.log('[CB-MainWorld] add 成功:', res.id);
                return { ok: true, action: 'add', id: res.id };
              } else if (params.action === 'update') {
                await db.collection(params.collection).doc(params.docId).update(params.data);
                console.log('[CB-MainWorld] update 成功:', params.docId);
                return { ok: true, action: 'update', id: params.docId };
              }
              return { ok: false, error: '未知 action: ' + params.action };
            })();
          },
          args: [data],
        }, function (results) {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: '同步执行失败: ' + chrome.runtime.lastError.message });
          } else if (results && results[0] && results[0].result) {
            sendResponse(results[0].result);
          } else {
            sendResponse({ ok: false, error: '同步返回空结果' });
          }
        });
      });
      return true;
    }

    // CloudBase 查询（历史数据加载）
    if (request.action === 'DAILYBOARD_CB_QUERY') {
      var qdata = request.payload || {};
      var tabId2 = (sender.tab && sender.tab.id) ? sender.tab.id : null;
      if (!tabId2) { sendResponse({ ok: false, error: 'No tab ID' }); return false; }

      chrome.scripting.executeScript({
        target: { tabId: tabId2 },
        world: 'MAIN',
        files: ['lib/cloudbase.full.js'],
      }, function () {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: 'SDK 注入失败: ' + chrome.runtime.lastError.message });
          return;
        }
        chrome.scripting.executeScript({
          target: { tabId: tabId2 },
          world: 'MAIN',
          func: function (params) {
            return (async function () {
              var cb = window.cloudbase;
              if (!cb) return { ok: false, error: 'window.cloudbase 未找到' };
              if (cb.default && typeof cb.default.init === 'function') cb = cb.default;
              var app = cb.init({ env: params.env });
              var db = app.database();
              var auth = app.auth();
              var state = await auth.getLoginState();
              if (!state) await auth.anonymousAuthProvider().signIn();

              var query = db.collection(params.collection);
              if (params.query && params.query.date) query = query.where({ date: params.query.date });
              if (params.query && params.query.teacherName) query = query.where({ teacherName: params.query.teacherName });
              var res = await query.limit(1).get();
              if (res.data && res.data.length > 0) {
                console.log('[CB-MainWorld] query 成功:', res.data[0].date, res.data[0].students.length + '人');
                return { ok: true, data: res.data[0] };
              }
              return { ok: true, data: null };
            })();
          },
          args: [qdata],
        }, function (results) {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: '查询执行失败: ' + chrome.runtime.lastError.message });
          } else if (results && results[0] && results[0].result) {
            sendResponse(results[0].result);
          } else {
            sendResponse({ ok: false, error: '查询返回空结果' });
          }
        });
      });
      return true;
    }

    // 诊断桥接注入：在 MAIN 世界注入 __dbDiag() 函数
    if (request.action === 'DAILYBOARD_INJECT_DIAG') {
      var diagTabId = (sender.tab && sender.tab.id) ? sender.tab.id : null;
      if (!diagTabId) { sendResponse({ ok: false, error: 'No tab ID' }); return false; }
      chrome.scripting.executeScript({
        target: { tabId: diagTabId },
        world: 'MAIN',
        func: function () {
          /* 每日工作看板 — MAIN 世界桥接工具
           * 通过 postMessage 与 ISOLATED 世界 content script 通信 */

          // ── 诊断工具 ──
          window.__dbDiag = function () {
            console.log('🔍 每日看板诊断中...');
            var rid = 'diag_' + Date.now();
            window.postMessage({ type: 'DB_DIAG_REQUEST', requestId: rid }, '*');
            var handled = false;
            var handler = function (e) {
              if (e.data && e.data.type === 'DB_DIAG_RESPONSE' && e.data.requestId === rid) {
                if (handled) return;
                handled = true;
                window.removeEventListener('message', handler);
                if (e.data.table) console.table(e.data.table);
                if (e.data.lines) e.data.lines.forEach(function (l) { console.log(l); });
                console.log('✅ 诊断完成。');
              }
            };
            window.addEventListener('message', handler);
            setTimeout(function () {
              if (!handled) {
                window.removeEventListener('message', handler);
                console.warn('⚠️ 诊断超时（3秒无响应）。请确保已打开过每日看板面板。');
              }
            }, 3000);
          };

          console.log('[DailyBoard] %c🔧 工具已就绪 %c— 输入 __dbDiag() 开始诊断',
            'color:#4a6cf7;font-weight:bold', 'color:#888');
        },
      }, function () {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: '桥接注入失败: ' + chrome.runtime.lastError.message });
        } else {
          sendResponse({ ok: true });
        }
      });
      return true;
    }

    // Excel 导出（通过 executeScript 注入 MAIN 世界，绕过 CSP + ISOLATED 隔离）
    if (request.action === 'DAILYBOARD_EXPORT_EXCEL') {
      var exportData = request.payload;
      var tabId3 = (sender.tab && sender.tab.id) ? sender.tab.id : null;
      if (!tabId3) { sendResponse({ ok: false, error: 'No tab ID' }); return false; }

      chrome.scripting.executeScript({
        target: { tabId: tabId3 },
        world: 'MAIN',
        files: ['lib/xlsx.full.min.js'],
      }, function () {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: 'XLSX 注入失败: ' + chrome.runtime.lastError.message });
          return;
        }
        chrome.scripting.executeScript({
          target: { tabId: tabId3 },
          world: 'MAIN',
          func: function (params) {
            try {
              /** 时间解析（与 content.js parseTime 对齐） */
              function parseTimeForExcel(v) {
                if (!v && v !== 0) return null;
                if (v instanceof Date) {
                  if (v.getFullYear() < 2024) return null;
                  return v;
                }
                var sv = String(v).trim();
                if (sv === '' || sv === '0') return null;
                // 13位毫秒时间戳
                if (/^\d{13}$/.test(sv)) {
                  var d13 = new Date(parseInt(sv, 10));
                  return d13.getFullYear() >= 2024 ? d13 : null;
                }
                // 10位秒级时间戳 → *1000
                if (/^\d{10}$/.test(sv)) {
                  var d10 = new Date(parseInt(sv, 10) * 1000);
                  return d10.getFullYear() >= 2024 ? d10 : null;
                }
                var d = new Date(v);
                if (isNaN(d.getTime())) {
                  var m = sv.match(/(\d{1,2}):(\d{2})/);
                  if (m) { d = new Date(); d.setHours(+m[1], +m[2], 0, 0); }
                  else return null;
                }
                return d.getFullYear() >= 2024 ? d : null;
              }
              function pad2(n) { return ('0' + n).slice(-2); }

              var X = window.XLSX;
              if (!X) return { ok: false, error: 'window.XLSX 未加载' };

              var wb = X.utils.book_new();
              wb.SheetNames.push('汇总', '明细');
              var t = params.teacherName || '';
              var vd = params.viewDate;
              var hw = ''; hw = params.isHistoryMode ? '（历史）' : '';

              // === Sheet1: 汇总 ===
              var s1 = [['每日工作看板 — 数据导出'], [],
                ['教师', t],
                ['学科', params.teacherSubject || '—'],
                ['年级', params.teacherGrade || '—'],
                ['日期', vd + hw],
                ['导出时间', new Date().toLocaleString('zh-CN')],
                [], ['=== 当日比率 ==='],
                ['有效听课率', params.dayRates.totalStudents > 0 ? Math.round(params.dayRates.listenCount / params.dayRates.totalStudents * 100) + '%' : '—'],
                ['作业完成率', params.dayRates.totalStudents > 0 ? Math.round(params.dayRates.hwDoneCount / params.dayRates.totalStudents * 100) + '%' : '—'],
                ['排课人数', params.dayRates.totalStudents],
                ['有效听课人数', params.dayRates.listenCount],
                ['作业完成人数', params.dayRates.hwDoneCount],
                [], ['=== 七类分布 ==='], ['分类', '人数', '已完成']];

              var CATS = [
                { icon: '📋', label: '今天有课-未上课' }, { icon: '🎓', label: '正在上课' },
                { icon: '⏳', label: '已下课-无报告' }, { icon: '✅', label: '表现好' },
                { icon: '⚠️', label: '一般' }, { icon: '🔴', label: '需跟进' },
                { icon: '📭', label: '今天没课' }
              ];
              var dm = params.doneMap || {};
              CATS.forEach(function (c, i) {
                var list = params.categories[i + 1] || [];
                var done = 0; list.forEach(function (s) { if (dm[s.studentId]) done++; });
                s1.push([c.icon + ' ' + c.label, list.length, done]);
              });

              var needAction = 0, doneTotal = 0;
              for (var ci = 1; ci <= 7; ci++) {
                var cl = params.categories[ci] || [];
                if (ci === 1 || ci === 2 || ci === 3) continue;
                needAction += cl.length;
                cl.forEach(function (s) { if (dm[s.studentId]) doneTotal++; });
              }
              var pct = needAction > 0 ? Math.round(doneTotal / needAction * 100) : 0;
              s1.push([], ['=== 完成进度 ==='], ['需处理', needAction], ['已完成', doneTotal], ['完成率', pct + '%']);
              wb.Sheets['汇总'] = X.utils.aoa_to_sheet(s1);
              wb.Sheets['汇总']['!cols'] = [{ wch: 18 }, { wch: 15 }, { wch: 10 }];

              // === Sheet2: 明细 ===
              var dh = ['姓名', '报名手机号', '学生ID', '课程/班级', '上课时间', '状态', '评价', '回答率', '提问数', '回答数', '首对%', '听课时长', '作业状态', '标签', '分类', '是否完成'];
              var dr = [dh];
              // 构建手机号查找表（ID → 手机号）
              var phoneMap = {};
              (params.boundStudents || []).forEach(function (bs) { if (bs.studentId && bs.phone) phoneMap[bs.studentId] = bs.phone; });
              for (var cid = 1; cid <= 7; cid++) {
                var sl = params.categories[cid] || [];
                sl.forEach(function (s) {
                  var catCfg = CATS[cid - 1];
                  var timeStr = '—';
                  if (s.scheduleTime) {
                    try {
                      var st = parseTimeForExcel(s.scheduleTime);
                      var et = s.endTime ? parseTimeForExcel(s.endTime) : null;
                      if (!st) { timeStr = '—'; }
                      else if (et && (et - st) > 0 && (et - st) < 24 * 3600000)
                        timeStr = pad2(st.getHours()) + ':' + pad2(st.getMinutes()) + '~' + pad2(et.getHours()) + ':' + pad2(et.getMinutes());
                      else
                        timeStr = pad2(st.getHours()) + ':' + pad2(st.getMinutes()) + '~—';
                    } catch (e) { timeStr = '—'; }
                  }
                  dr.push([
                    s.studentName || '', phoneMap[s.studentId] || '', s.studentId || '', s.className || '',
                    timeStr,
                    catCfg ? catCfg.label : '', s.userPeriodLevel || '',
                    s.participationRate != null ? s.participationRate + '%' : '',
                    s.askCount != null ? String(s.askCount) : '',
                    s.answerCount != null ? String(s.answerCount) : '',
                    s.firstCorrectRate != null ? s.firstCorrectRate + '%' : '',
                    s.inClassOnlineDuration || '', s.homeworkStatusDesc || '',
                    s.overallTag || '',
                    catCfg ? (catCfg.icon + ' ' + catCfg.label) : '',
                    dm[s.studentId] ? '✅' : ''
                  ]);
                });
              }
              wb.Sheets['明细'] = X.utils.aoa_to_sheet(dr);
              wb.Sheets['明细']['!cols'] = [
                { wch: 10 }, { wch: 14 }, { wch: 16 },
                { wch: 16 },
                { wch: 14 }, { wch: 14 }, { wch: 6 }, { wch: 8 },
                { wch: 6 }, { wch: 8 }, { wch: 8 }, { wch: 12 },
                { wch: 10 }, { wch: 12 }, { wch: 18 }, { wch: 8 }
              ];

              var out = X.write(wb, { bookType: 'xlsx', type: 'array' });
              var blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
              var fn = '每日工作看板_' + t + '_' + vd + '.xlsx';
              var url = URL.createObjectURL(blob);
              var a = document.createElement('a'); a.href = url; a.download = fn;
              document.body.appendChild(a); a.click();
              setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 5000);
              return { ok: true, size: out.length };
            } catch (e) {
              return { ok: false, error: e.message };
            }
          },
          args: [exportData],
        }, function (results) {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: '导出执行失败: ' + chrome.runtime.lastError.message });
          } else if (results && results[0] && results[0].result) {
            sendResponse(results[0].result);
          } else {
            sendResponse({ ok: false, error: '导出返回空结果' });
          }
        });
      });
      return true;
    }
  });

})();
