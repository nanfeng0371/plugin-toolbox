/**
 * Report 模块 — Service Worker 入口 (v5.3.0 模块化版)
 *
 * 变更说明：
 *   - 包装为 IIFE，避免全局污染
 *   - 用 self.__registerModuleHandlers('report', handlers) 注册消息处理器
 *   - REGISTER_TAB handler 使用 sender?.tab?.id 从壳路由的 sender 对象中获取
 *   - REPORT_DATA_RESULT handler 由壳 background.js 硬编码识别并转发
 *   - 消息格式遵循 { target, action, data } 统一协议
 */

(function () {
  'use strict';

  // 加载 xlsx 库（SheetJS — 多 Sheet Excel 导出）
  try {
    importScripts('modules/report/lib/xlsx.full.min.js');
    console.log('[Report模块] xlsx库加载成功');
  } catch (e) {
    console.warn('[Report模块] xlsx库加载失败（降级为CSV）:', e.message);
  }

  // ========== 配置 ==========

  const CONFIG = {
    WORK_DOMAIN: 'ai-genesis.yuaiweiwu.com',
    LIST_API: '/prod-api/student-center-ai/regularCourse/next/class/list',
    BIZ_API: '/prod-api/student-center-ai/ai/teacher/ai/biz',
  };

  console.log('[Report模块] Service Worker v5.3.0 模块化版启动');

  // ========== 日志系统 ==========

  /** @type {Array<{time: string, msg: string, level: string}>} */
  let _recentLogs = [];

  /**
   * 记录日志
   * @param {string} msg
   * @param {'info'|'ok'|'warn'|'error'} level
   */
  function log(msg, level) {
    if (level === undefined) level = 'info';
    const prefix = '[Report模块]';
    console.log(prefix + ' ' + msg);
    _recentLogs = _recentLogs || [];
    _recentLogs.push({ time: new Date().toLocaleTimeString(), msg: msg, level: level });
    if (_recentLogs.length > 500) _recentLogs.shift();
  }

  /**
   * 获取最近的日志条目
   * @returns {Array<{time: string, msg: string, level: string}>}
   */
  function getRecentLogs() {
    return (_recentLogs || []).slice(-100);
  }

  // ========== 工作台 tab 跟踪 ==========

  /** @type {number|null} 当前工作台 tab ID */
  let _workTabId = null;

  // ========== 工作台 API 请求（Step1/2 用，SW fetch + credentials:include）==========

  /**
   * 向工作台 API 发送 GET 请求
   * @param {string} path - API 路径
   * @param {Object<string, string>} params - 查询参数
   * @returns {Promise<Object>} API JSON 响应
   */
  async function workApi(path, params) {
    if (!params) params = {};
    const url = new URL('https://' + CONFIG.WORK_DOMAIN + path);
    Object.entries(params).forEach(function (entry) {
      let k = entry[0];
      let v = entry[1];
      if (v !== null && v !== undefined) url.searchParams.set(k, v);
    });

    log('请求工作台API: ' + path + '?' + url.searchParams.toString().slice(0, 80), 'info');

    let res = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      credentials: 'include',
    });

    if (!res.ok) {
      let errText = await res.text().catch(function () { return ''; });
      log('工作台API失败: HTTP ' + res.status + ' ' + errText.slice(0, 200), 'error');
      throw new Error('HTTP ' + res.status + ': ' + errText.slice(0, 150));
    }

    let json = await res.json();
    // 兼容成功码：数字 0/200 或字符串 '0'/'200'/'000000'
    let SUCCESS_CODES = [0, 200, '0', '200', '000000'];
    if (json.code !== undefined && SUCCESS_CODES.indexOf(json.code) === -1) {
      log('工作台API业务错误: code=' + json.code + ' msg=' + (json.msg || json.message || ''), 'warn');
    }
    return json;
  }

  // ========== Step1: 学生列表 ==========

  // ===== 手机号智能提取（v5.2.1）=====
  function extractPhone(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 3) return '';
    var candidates = [
      'userPhone', 'phone', 'mobilePhone', 'mobile', 'bindPhone',
      'studentPhone', 'studentMobile', 'userMobile', 'cellPhone',
      'contactMobile', 'contactPhone', 'tel', 'telephone', 'phoneNumber'
    ];
    for (var ci = 0; ci < candidates.length; ci++) {
      var key = candidates[ci];
      if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') {
        return String(obj[key]);
      }
    }
    var skipKeys = { course: true, lesson: true, class: true, school: true, grade: true };
    var keys = Object.keys(obj);
    for (var ki = 0; ki < keys.length; ki++) {
      var k = keys[ki];
      var v = obj[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && !skipKeys[k]) {
        var found = extractPhone(v, depth + 1);
        if (found) return found;
      }
    }
    return '';
  }

  /**
   * 获取学生列表
   * @param {Object} options - 筛选参数
   * @returns {Promise<Object>} { data: Array, _debugFirst: string|null }
   */
  async function fetchStudentList(options) {
    let opts = options || {};
    let params = {
      classStatus: opts.classStatus != null ? opts.classStatus : 2,
      startDate: opts.startDate || '2026-01-01 00:00:00',
      endDate: opts.endDate || '2030-12-31 23:59:59',
    };
    if (opts.keyword) {
      params.keyword = opts.keyword;
    }
    let json = await workApi(CONFIG.LIST_API, params);
    let list = (json.data && json.data.classList) || [];
    log('[Step1\u2705] 获取到 ' + list.length + ' 个学生', 'ok');

    if (list.length > 0) {
      let first = list[0];
      log('[Step1\u{1F50D}] 第一个学生原始字段: ' + Object.keys(first).join(', '), 'info');
      let idFields = findAllIdFields(first);
      log('[Step1\u{1F50D}] 所有ID类字段: ' + idFields, 'info');
      // v5.2.1: 也显示嵌套对象的字段
      var firstKeys = Object.keys(first);
      for (var fki = 0; fki < firstKeys.length; fki++) {
        var fk = firstKeys[fki];
        var fv = first[fk];
        if (fv && typeof fv === 'object' && !Array.isArray(fv)) {
          log('[Step1\u{1F50D}] 嵌套对象 ' + fk + ' 的字段: ' + Object.keys(fv).join(', '), 'info');
        }
      }
      log('[Step1\u{1F50D}] 手机号提取: ' + (extractPhone(first, 0) || '(未找到)'), 'info');
    }

    let possibleIdFields = [
      'bookingId', 'periodId', 'id', 'classPeriodId', 'scheduleId', 'recordId',
      'courseRecordId', 'lessonId', 'classScheduleId'
    ];

    return {
      data: list.map(function (item) {
        let resolvedId = null;
        for (let fi = 0; fi < possibleIdFields.length; fi++) {
          let field = possibleIdFields[fi];
          if (item[field] !== undefined && item[field] !== null && item[field] !== '') {
            resolvedId = item[field];
            break;
          }
        }
        let realName = item.chineseName || item.userName || item.remarkName ||
                        item.studentName || item.name || item.stuName || '';
        return {
          periodId: resolvedId,
          studentId: item.studentId || item.userId || '',
          studentName: realName,
          userPhone: extractPhone(item, 0),
          courseClassify: item.courseClassify || 3,
          studyVersion: item.studyVersion || 1,
          inClassDuration: item.inClassOnlineDuration || '',
          homeworkStatus: item.homeworkCompletionStatusDesc || '-',
          attendanceStatus: item.effectiveAttendanceDesc || '-',
          rawCourseName: item.courseName || '',
          rawLessonName: item.lessonName || '',
          _rawItem: item,
          _debugIds: (function () {
            let ids = {};
            for (let di = 0; di < possibleIdFields.length; di++) {
              let f = possibleIdFields[di];
              if (item[f] !== undefined) ids[f] = item[f];
            }
            return ids;
          })(),
        };
      }),
      _debugFirst: list.length > 0 ? JSON.stringify(list[0]) : null,
      _debugPhone: list.length > 0 ? extractPhone(list[0], 0) : null,
    };
  }

  /**
   * 递归查找对象中所有 ID 类字段
   * @param {Object} obj
   * @param {string} prefix
   * @param {string[]} results
   * @returns {string[]}
   */
  function findAllIdFields(obj, prefix, results) {
    if (!results) results = [];
    if (prefix === undefined) prefix = '';
    if (!obj || typeof obj !== 'object') return results;
    let entries = Object.entries(obj);
    for (let i = 0; i < entries.length; i++) {
      let k = entries[i][0];
      let v = entries[i][1];
      let fullKey = prefix ? (prefix + '.' + k) : k;
      if (typeof v === 'string' || typeof v === 'number') {
        if (/id/i.test(k) || /Id$/.test(k)) {
          results.push(fullKey + '=' + v);
        }
      } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        findAllIdFields(v, fullKey, results);
      }
    }
    return results;
  }

  // ========== Step2+3: 获取短链 + 跟随重定向取 reportToken ==========

  /**
   * 获取短链并提取 reportToken
   * @param {Object} payload - { periodId, studentName, courseClassify }
   * @returns {Promise<Object>} { shortUrl, reportToken }
   */
  async function fetchShortUrl(payload) {
    let periodId = payload.periodId;
    let studentName = payload.studentName;
    let courseClassify = payload.courseClassify;

    // Step2: biz 接口 (broadcastType=3)
    log((studentName || '?') + ' [Step2] 调用biz接口 id=' + periodId, 'info');
    let bizRes = await workApi(CONFIG.BIZ_API, {
      id: periodId,
      urlType: 2,
      broadcastType: 3,
      courseClassify: String(courseClassify || 3),
    });

    log((studentName || '?') + ' [Step2] biz响应: code=' + bizRes.code, 'info');

    let successCodes = ['000000', '0', '200', 0, 200];
    if (bizRes.code !== undefined && successCodes.indexOf(bizRes.code) === -1) {
      throw new Error('biz业务错误(code=' + bizRes.code + '): ' + (bizRes.msg || bizRes.mesg || ''));
    }

    let shortUrl = (bizRes.data && bizRes.data.aiBizUrl) || null;
    if (!shortUrl) {
      throw new Error('biz未返回短链(响应: ' + JSON.stringify(bizRes).slice(0, 200) + ')');
    }
    log((studentName || '?') + ' [Step2\u2705] 短链: ' + shortUrl, 'ok');

    // Step3: 跟随短链重定向获取最终 URL（含 reportToken）
    let finalUrl;
    try {
      finalUrl = await getFinalUrlFromShortCode(shortUrl);
      log((studentName || '?') + ' [Step3\u2705] 最终URL长度: ' + finalUrl.length, 'ok');
    } catch (e) {
      log((studentName || '?') + ' [Step3\u274C] ' + e.message, 'error');
      throw new Error('[获取Token] ' + e.message);
    }

    let reportToken = extractReportToken(finalUrl);
    if (!reportToken) {
      throw new Error('[提取Token] 最终URL中无report参数: ' + finalUrl.slice(0, 120));
    }
    log((studentName || '?') + ' [Step3\u2705] token长度: ' + reportToken.length, 'ok');

    return { shortUrl: shortUrl, reportToken: reportToken, finalUrl: finalUrl };
  }

  // ========== 短链重定向：SW fetch 跟随 ==========

  /**
   * v5.3.0: SW批量获取单个学生的报告数据（3个API并行）
   * @param {string} reportToken
   * @param {number} courseClassify
   * @param {number} studyVersion
   * @returns {Promise<Object>} 合并后的报告JSON
   */
  async function fetchOneReportData(reportToken, courseClassify, studyVersion) {
    var BASE = 'https://next.aitutor100.com';
    var ct = courseClassify || 3;
    var sv = studyVersion || 1;
    var hdrs = { 'Accept': 'application/json, text/plain, */*', 'source-sn': 'PROD' };

    // API 1: 主报告 + API 2: 对话列表（并行）
    var api1Url = BASE + '/ai-math-engine/lesson/report/queryCoursePeriodReport?report=' + encodeURIComponent(reportToken) + '&courseType=' + ct + '&studyVersion=' + sv;
    var api2Url = BASE + '/ai-math-engine/lesson/report/queryComponentDialogueList?report=' + encodeURIComponent(reportToken);
    var [res1, res2] = await Promise.all([
      fetch(api1Url, { headers: hdrs, credentials: 'include' }),
      fetch(api2Url, { headers: hdrs, credentials: 'include' }),
    ]);
    var json1 = await res1.json();
    var json2 = await res2.json();

    // API 3: 错题统计（需要 uid + periodId）
    var json3 = null;
    var api1Data = json1 && json1.data ? json1.data : {};
    var uid = api1Data.stuId || api1Data.uid || api1Data.studentId;
    var periodId = api1Data.periodId || api1Data.classPeriodId;
    if (uid && periodId) {
      try {
        var api3Url = BASE + '/ai-math-engine/mistake/period/module/summary?uid=' + uid + '&periodId=' + periodId + '&studyVersion=' + sv;
        var res3 = await fetch(api3Url, { headers: hdrs, credentials: 'include' });
        json3 = await res3.json();
      } catch (e) { /* 错题统计非关键 */ }
    }

    // 合并 summary 到主报告
    if (json3 && json3.data) {
      var mainData = json1.data || {};
      if (!mainData.mistakeSummaryVo && json3.data) {
        mainData.mistakeSummaryVo = json3.data;
      } else if (mainData.mistakeSummaryVo && json3.data) {
        mainData.mistakeSummaryVo = Object.assign({}, mainData.mistakeSummaryVo, json3.data);
      }
    }

    return json1;
  }

  /**
   * v5.3.0: SW批量获取报告（30并发）
   * @param {Array} items - [{ idx, reportToken, courseClassify, studyVersion }]
   * @returns {Promise<Array>} [{ idx, data, error }]
   */
  async function fetchReportsBatch(items) {
    var MAX_CONCURRENT = 30;
    var results = [];
    var idx = 0;

    async function processOne(item) {
      try {
        var json = await fetchOneReportData(item.reportToken, item.courseClassify, item.studyVersion);
        if (json.code && json.code !== '000000' && json.code !== 0 && json.code !== 200) {
          throw new Error('API错误(code=' + json.code + '): ' + (json.msg || json.mesg || ''));
        }
        results.push({ idx: item.idx, data: json });
      } catch (e) {
        results.push({ idx: item.idx, error: e.message });
      }
    }

    return new Promise(function (resolve) {
      var running = 0;
      var next = 0;
      function startNext() {
        while (running < MAX_CONCURRENT && next < items.length) {
          var item = items[next++];
          running++;
          processOne(item).finally(function () {
            running--;
            if (next < items.length) {
              startNext();
            } else if (running === 0) {
              resolve(results);
            }
          });
        }
        if (next >= items.length && running === 0) resolve(results);
      }
      startNext();
    });
  }

  /**
   * 跟随短链重定向获取最终 URL
   * @param {string} shortUrl
   * @returns {Promise<string>}
   */
  async function getFinalUrlFromShortCode(shortUrl) {
    try {
      var res = await fetch(shortUrl, { method: 'GET', redirect: 'follow' });
      var finalUrl = res.url || '';
      if (finalUrl && finalUrl !== shortUrl) return finalUrl;
    } catch (e) {}
    try {
      var res2 = await fetch(shortUrl, { method: 'GET', redirect: 'manual' });
      var location = res2.headers.get('location');
      if (location) return location;
    } catch (e) {}
    throw new Error('无法跟随短链重定向');
  }

  /** v5.2.14: 批量跟随短链重定向（SW 无 CORS 限制，content.js 调用） */
  async function followRedirectsBatch(items) {
    // items: [{ idx, shortUrl }, ...]
    var results = [];
    var promises = items.map(function (item) {
      return (async function () {
        try {
          var finalUrl = await getFinalUrlFromShortCode(item.shortUrl);
          var reportMatch = finalUrl.match(/report=([^&]+)/);
          var reportToken = reportMatch ? decodeURIComponent(reportMatch[1]) : '';
          if (!reportToken) throw new Error('URL中无report参数');
          results.push({ idx: item.idx, shortUrl: item.shortUrl, reportToken: reportToken, finalUrl: finalUrl });
        } catch (e) {
          results.push({ idx: item.idx, shortUrl: item.shortUrl, error: e.message });
        }
      })();
    });
    await Promise.all(promises);
    return results;
  }



  /**
   * 从最终 URL 中提取 reportToken
   * @param {string} finalUrl
   * @returns {string|null}
   */
  function extractReportToken(finalUrl) {
    let match = finalUrl.match(/report=([^&]+)/);
    if (match) return decodeURIComponent(match[1]);
    return null;
  }

  // ========== 数据解析 ==========

  /**
   * 解析报告 API 返回的 JSON 数据
   * @param {Object} json
   * @returns {Object|null}
   */
  function parseReportData(json) {
    if (!json || !json.data) return null;
    let d = json.data;

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
      for (let ci = 0; ci < d.courseDetail.length; ci++) {
        let comp = d.courseDetail[ci];
        if (comp.studyComponentList) {
          for (let si = 0; si < comp.studyComponentList.length; si++) {
            let sc = comp.studyComponentList[si];
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

    return {
      name: d.studentName || d.stuName || '未知',
      courseName: d.courseName || '',
      lessonName: d.lessonName || d.periodName || '',
      masteryRating: d.masteryRating || '-',
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

  // ========== 连接检测 ==========

  /**
   * 检测与工作台后端的连接
   * @returns {Promise<Object>} { connected: boolean, count?: number, error?: string }
   */
  async function checkConnection() {
    try {
      let json = await workApi(CONFIG.LIST_API, {
        classStatus: 2,
        startDate: '2026-01-01 00:00:00',
        endDate: '2030-12-31 23:59:59',
      });
      let list = (json.data && json.data.classList) || [];
      return { connected: true, count: list.length };
    } catch (e) {
      log('连接检测失败: ' + e.message, 'error');
      return { connected: false, error: e.message };
    }
  }

  // ========== Excel 导出（v5.2.12: xlsx多Sheet，CSV降级兜底）==========

  /**
   * 生成Excel数据（xlsx优先，CSV兜底）
   * @param {Array} students - 分析后的学生数据数组
   * @returns {Object} { success, count, xlsx?, csv?, filename }
   */
  async function generateExcel(students) {
    var filename = '学习报告分析_' + formatDate();
    if (typeof XLSX !== 'undefined') {
      try {
        var xlsxB64 = generateXLSX(students);
        return { success: true, count: students.length, xlsx: xlsxB64, filename: filename + '.xlsx' };
      } catch (e) {
        log('xlsx生成失败（降级为CSV）: ' + e.message, 'warn');
      }
    }
    // CSV 兜底
    var csv = buildCSV(students);
    return { success: true, count: students.length, csv: csv, filename: filename + '.csv' };
  }

  /**
   * 生成多Sheet xlsx（base64格式）
   * @param {Array} students
   * @returns {string} base64
   */
  function generateXLSX(students) {
    var wb = XLSX.utils.book_new();

    // ===== Sheet1: 学生明细 =====
    var detailHeader = ['学员姓名', '学员ID', '手机号', '课程名称', '本课节名称', '听课时长', '作业完成', '有效出勤', '综合标签', '一句话诊断', '四象限', '参与度', '回答率%', '提问数', '回答数', '专注度', '认真回答次数', '超过同学%', '学习效果'];
    var detailRows = [detailHeader];
    for (var i = 0; i < students.length; i++) {
      var s = students[i];
      detailRows.push([
        s.name || '', String(s.studentId || ''), String(s.userPhone || ''), s.courseName || '', s.lessonName || '',
        s.inClassDuration || '', s.homeworkStatus || '', s.attendanceStatus || '',
        s.overallTag || '', s.diagnosis || '', s.quadrant || '',
        s.label || '', s.rate != null ? s.rate : '', s.totalAsk || 0, s.totalAns || 0,
        s.focusRating || '', s.focusAnswer || 0, s.overOther || '0%', s.masteryLabel || ''
      ]);
    }
    var ws1 = XLSX.utils.aoa_to_sheet(detailRows);
    // 设置列宽
    ws1['!cols'] = [
      {wch: 8}, {wch: 10}, {wch: 13}, {wch: 14}, {wch: 14}, {wch: 10}, {wch: 10}, {wch: 8},
      {wch: 16}, {wch: 30}, {wch: 6}, {wch: 12}, {wch: 8}, {wch: 6}, {wch: 6},
      {wch: 8}, {wch: 10}, {wch: 10}, {wch: 10}
    ];
    XLSX.utils.book_append_sheet(wb, ws1, '学生明细');

    // ===== Sheet2: 讲次信息 =====
    var lessonSummary = buildLessonSummary(students);
    var lessonRows = [];
    // 概览
    lessonRows.push(['课节名称', '学生数', '平均回答率%', '敷衍预警(<50%)', '严重敷衍(<30%)', '优秀人数']);
    for (var li = 0; li < lessonSummary.length; li++) {
      var ls = lessonSummary[li];
      lessonRows.push([ls.lessonName, ls.total, ls.avgRate, ls.dangerCount, ls.criticalCount, ls.successCount]);
    }
    lessonRows.push([]);
    lessonRows.push(['========== 各课节学生排名 ==========']);

    for (var lj = 0; lj < lessonSummary.length; lj++) {
      var ls2 = lessonSummary[lj];
      lessonRows.push([]);
      lessonRows.push(['【' + ls2.lessonName + '】学生排名（按回答率升序）']);
      lessonRows.push(['排名', '姓名', 'ID', '回答率%', '掌握度', '综合标签', '一句话诊断']);
      var ranking = ls2.ranking;
      for (var ri = 0; ri < ranking.length; ri++) {
        var r = ranking[ri];
        lessonRows.push([ri + 1, r.name, r.studentId || '', r.rate != null ? r.rate : '', r.masteryRating, r.overallTag, r.diagnosis]);
      }
      lessonRows.push([]);
      if (ls2.problemStudents.length > 0) {
        lessonRows.push(['问题学生名单']);
        lessonRows.push(['姓名', 'ID', '问题类型', '回答率%', '建议动作']);
        for (var pi = 0; pi < ls2.problemStudents.length; pi++) {
          var p = ls2.problemStudents[pi];
          var ptype = (p.participation.tag === 'danger' || p.participation.tag === 'critical') ? '敷衍上课' : '学习能力需关注';
          var action = p.participation.tag === 'critical' ? '联系家长/班主任' : p.participation.tag === 'danger' ? '关注下节课状态' : '调整教学方法';
          lessonRows.push([p.name, p.studentId || '', ptype, p.rate != null ? p.rate : '', action]);
        }
      }
    }
    var ws2 = XLSX.utils.aoa_to_sheet(lessonRows);
    ws2['!cols'] = [{wch: 18}, {wch: 12}, {wch: 16}, {wch: 16}, {wch: 16}, {wch: 12}, {wch: 30}];
    XLSX.utils.book_append_sheet(wb, ws2, '讲次信息');

    // 生成 ArrayBuffer → base64
    var buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    var bytes = new Uint8Array(buf);
    var binary = '';
    for (var bi = 0; bi < bytes.length; bi++) {
      binary += String.fromCharCode(bytes[bi]);
    }
    return btoa(binary);
  }

  /**
   * CSV 字段转义
   * @param {*} val
   * @returns {string}
   */
  function escapeCSV(val) {
    if (val == null) return '';
    let s = String(val);
    if (s.indexOf(',') >= 0 || s.indexOf('"') >= 0 || s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  /**
   * 构建 CSV 文本内容
   * @param {Array} students
   * @returns {string}
   */
  function buildCSV(students) {
    let lines = [];

    // ===== Sheet1: 学生明细（v5.2.2 增加手机号列）=====
    lines.push('\u2550\u2550\u2550\u2550\u2550 学生明细 \u2550\u2550\u2550\u2550\u2550');
    lines.push([
      '学员姓名', '学员ID', '手机号', '课程名称', '本课节名称', '听课时长', '作业完成情况', '有效出勤',
      '综合标签', '一句话诊断', '四象限',
      '参与度', '回答率%', '老师总提问数', '学生总回答数', '专注度', '认真回答次数', '超过同学%',
      '学习效果'
    ].map(escapeCSV).join(','));

    for (let i = 0; i < students.length; i++) {
      let s = students[i];
      let row = [
        s.name, s.studentId || '', s.userPhone || '', s.courseName, s.lessonName,
        s.inClassDuration || '', s.homeworkStatus || '', s.attendanceStatus || '',
        s.overallTag, s.diagnosis, s.quadrant,
        s.label, s.rate != null ? s.rate : '', s.totalAsk, s.totalAns,
        s.focusRating || '', s.focusAnswer, s.overOther,
        s.masteryLabel
      ];
      lines.push(row.map(escapeCSV).join(','));
    }

    lines.push('');

    // ===== Sheet2: 课节汇总 =====
    let summary = buildLessonSummary(students);
    for (let li = 0; li < summary.length; li++) {
      let lesson = summary[li];
      lines.push('\u2550\u2550\u2550\u2550\u2550 ' + lesson.lessonName + ' \u2550\u2550\u2550\u2550\u2550');
      lines.push('【课节概览】');
      lines.push(['指标', '值'].map(escapeCSV).join(','));
      lines.push(['学生总数', lesson.total].map(escapeCSV).join(','));
      lines.push(['平均回答率', lesson.avgRate + '%'].map(escapeCSV).join(','));
      lines.push(['敷衍预警人数(<50%)', lesson.dangerCount].map(escapeCSV).join(','));
      lines.push(['严重敷衍人数(<30%)', lesson.criticalCount].map(escapeCSV).join(','));
      lines.push(['优秀人数', lesson.successCount].map(escapeCSV).join(','));
      lines.push('');
      lines.push('【学生排名】按回答率升序');
      lines.push(['排名', '姓名', 'ID', '回答率%', '掌握度', '综合标签', '一句话诊断'].map(escapeCSV).join(','));
      let ranking = lesson.ranking;
      for (let ri = 0; ri < ranking.length; ri++) {
        let r = ranking[ri];
        lines.push([
          ri + 1, r.name, r.studentId || '',
          (r.rate != null ? r.rate : '') + '%', r.masteryRating,
          r.overallTag, r.diagnosis
        ].map(escapeCSV).join(','));
      }
      lines.push('');
      if (lesson.problemStudents.length > 0) {
        lines.push('【问题学生名单】');
        lines.push(['姓名', 'ID', '问题类型', '关键指标', '建议动作'].map(escapeCSV).join(','));
        for (let pi = 0; pi < lesson.problemStudents.length; pi++) {
          let p = lesson.problemStudents[pi];
          let ptype = (p.participation.tag === 'danger' || p.participation.tag === 'critical')
            ? '敷衍上课' : '学习能力需关注';
          let action = p.participation.tag === 'critical'
            ? '联系家长/班主任，严肃谈话'
            : p.participation.tag === 'danger'
              ? '关注下节课状态'
              : '调整教学方法';
          lines.push([p.name, p.studentId || '', ptype, '回答率 ' + p.rate + '%', action].map(escapeCSV).join(','));
        }
      } else {
        lines.push('【无问题学生】\u2705');
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * 构建课节汇总数据
   * @param {Array} students
   * @returns {Array<Object>}
   */
  function buildLessonSummary(students) {
    let groups = {};
    for (let i = 0; i < students.length; i++) {
      let s = students[i];
      let key = s.lessonName || '未知课节';
      if (!groups[key]) groups[key] = [];
      groups[key].push(s);
    }
    let keys = Object.keys(groups);
    return keys.map(function (lessonName) {
      let group = groups[lessonName];
      let validRate = group.filter(function (x) { return x.rate != null; });
      let avgRate = validRate.length
        ? Math.round(validRate.reduce(function (s, r) { return s + r.rate; }, 0) / validRate.length)
        : null;
      let validExer = group.filter(function (x) { return x.exerRate != null; });
      let avgExercise = validExer.length
        ? Math.round(validExer.reduce(function (s, r) { return s + r.exerRate; }, 0) / validExer.length)
        : null;
      let ranking = group.slice().sort(function (a, b) { return (a.rate || 0) - (b.rate || 0); });
      let problemStudents = group.filter(function (r) {
        return r.tag === 'danger' || r.tag === 'critical' || r.overallTagClass === 'danger';
      }).map(function (r) {
        return {
          name: r.name, studentId: r.studentId || '', rate: r.rate,
          participation: { tag: r.tag },
          masteryRating: r.masteryRating,
          overallTag: r.overallTag, diagnosis: r.diagnosis
        };
      });
      return {
        lessonName: lessonName,
        total: group.length,
        avgRate: avgRate != null ? avgRate : 0,
        dangerCount: group.filter(function (r) { return r.tag === 'danger' || r.tag === 'critical'; }).length,
        criticalCount: group.filter(function (r) { return r.rate != null && r.rate < 30; }).length,
        successCount: group.filter(function (r) { return r.tag === 'success'; }).length,
        avgExercise: avgExercise,
        ranking: ranking,
        problemStudents: problemStudents,
      };
    });
  }

  /**
   * 格式化日期为 YYYYMMDD
   * @returns {string}
   */
  function formatDate() {
    let d = new Date();
    let year = d.getFullYear();
    let month = String(d.getMonth() + 1).padStart(2, '0');
    let day = String(d.getDate()).padStart(2, '0');
    return year + month + day;
  }

  // ========== 消息处理器注册 ==========


  /**
   * 注册所有模块消息处理器到壳的 MessageBus
   * 格式: { [action: string]: (data, sender) => Promise|* }
   *
   * 壳路由规则:
   *   - chrome.runtime.onMessage 识别 { type: 'REPORT_DATA_RESULT' } 硬编码转发到 handlers['REPORT_DATA_RESULT']
   *   - chrome.runtime.onMessage 识别 { target: 'report', action: '...' } 通过 MessageBus.route() 转发
   *   - MessageBus.route() 调用 mod.handlers[action](data, sender)，sender 对象保留 sender.tab.id
   */
  let handlers = {

    /**
     * 注册工作台 tab ID（content.js 启动时调用）
     * 壳路由方式: { target: 'report', action: 'REGISTER_TAB', data: {} }
     * sender.tab.id 由壳 MessageBus.route() 传入
     */
    'REGISTER_TAB': function (data, sender) {
      _workTabId = sender && sender.tab ? sender.tab.id : (data && data.tabId ? data.tabId : null);
      log('工作台tab已注册: tabId=' + _workTabId);
      return { ok: true };
    },

    /**
     * 接收 report_fetcher.js 从 iframe 内发回的数据，relay 给 content.js
     * 壳路由方式: 硬编码识别 { type: 'REPORT_DATA_RESULT' }
     * 壳会转换 data 为: { reportToken, data, error } 并传入此 handler
     */
    'REPORT_DATA_RESULT': function (data, sender) {
      let reportToken = data && data.reportToken;
      let reportData = data && data.data;
      let error = data && data.error;
      log('[relay] 收到iframe数据, reportToken=' + (reportToken || '').slice(0, 10) + '..., error=' + (error || '无'), 'info');
      if (_workTabId) {
        chrome.tabs.sendMessage(_workTabId, {
          type: 'RELAY_REPORT_DATA',
          reportToken: reportToken,
          data: reportData,
          error: error,
        }).catch(function (e) {
          log('[relay] 发送失败: ' + e.message, 'error');
        });
      } else {
        log('[relay] 无工作台tabId，无法转发！', 'error');
      }
      return { relayed: true };
    },

    /**
     * 获取日志
     */
    'GET_LOGS': function (data, sender) {
      return getRecentLogs();
    },

    /**
     * 取消获取
     */
    'CANCEL_FETCH': function (data, sender) {
      log('收到中断请求', 'warn');
      return { cancelled: true };
    },

    /**
     * 检测连接
     */
    'CHECK_CONNECTION': function (data, sender) {
      return checkConnection();
    },

    /**
     * 获取学生列表
     */
    'FETCH_STUDENT_LIST': function (data, sender) {
      return fetchStudentList(data);
    },

    /**
     * 获取短链 + reportToken
     */
    'FETCH_SHORT_URL': function (data, sender) {
      return fetchShortUrl(data);
    },
    'FOLLOW_REDIRECTS_BATCH': function (data, sender) {
      return followRedirectsBatch(data);
    },

    /**
     * v5.3.0: SW批量获取报告（核心方案，替代iframe）
     * 由 content.js 在短链预取完成后调用，SW内30并发直接fetch API
     * @param {Array} data - [{ idx, reportToken, courseClassify, studyVersion }]
     * @returns {Promise<Array>} [{ idx, data: json1, error }]
     */
    'FETCH_REPORTS_BATCH': async function (data, sender) {
      return fetchReportsBatch(data);
    },

    /**
     * v2.1.74: 表格提取工具 → 生成 Excel
     * 由 dingtalk content.js 调用，SW 内已加载 xlsx 库
     * @param {Object} data - { header: [...], data: [[...], ...], filename }
     * @returns {Object} { success, base64, filename }
     */
    'GENERATE_TABLE_EXCEL': async function (data, sender) {
      try {
        var wb = XLSX.utils.book_new();
        var rows = [];
        if (data.header && data.header.length > 0) rows.push(data.header);
        data.data.forEach(function (row) { rows.push(row); });
        var ws = XLSX.utils.aoa_to_sheet(rows);
        XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
        var wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
        return { success: true, base64: wbout, filename: data.filename || 'table.xlsx' };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },

    /**
     * SW降级直连：直接调用3个报告API（iframe超时时的降级方案）
     * 由 content.js 在 iframe 超时后调用
     */
    'FETCH_REPORT_DATA_DIRECT': async function (data, sender) {
      const { shortUrl, reportToken, courseClassify, studyVersion } = data;
      const BASE = 'https://next.aitutor100.com';
      const ct = courseClassify || 3;
      const sv = studyVersion || 1;

      // API 1: queryCoursePeriodReport
      const api1Url = `${BASE}/ai-math-engine/lesson/report/queryCoursePeriodReport?report=${encodeURIComponent(reportToken)}&courseType=${ct}&studyVersion=${sv}`;
      const res1 = await fetch(api1Url, {
        headers: { 'Accept': 'application/json, text/plain, */*', 'source-sn': 'PROD' },
        credentials: 'include',
      });
      const json1 = await res1.json();

      // API 2: queryComponentDialogueList
      const api2Url = `${BASE}/ai-math-engine/lesson/report/queryComponentDialogueList?report=${encodeURIComponent(reportToken)}`;
      const res2 = await fetch(api2Url, {
        headers: { 'Accept': 'application/json, text/plain, */*', 'source-sn': 'PROD' },
        credentials: 'include',
      });
      const json2 = await res2.json();

      // API 3: summary (需要 uid + periodId，从API1响应提取)
      let json3 = null;
      const api1Data = json1 && json1.data ? json1.data : {};
      const uid = api1Data.stuId || api1Data.uid || api1Data.studentId;
      const periodId = api1Data.periodId || api1Data.classPeriodId;
      if (uid && periodId) {
        const api3Url = `${BASE}/ai-math-engine/mistake/period/module/summary?uid=${uid}&periodId=${periodId}&studyVersion=${sv}`;
        const res3 = await fetch(api3Url, {
          headers: { 'Accept': 'application/json, text/plain, */*', 'source-sn': 'PROD' },
          credentials: 'include',
        });
        json3 = await res3.json();
      }

      // 合并 summary 到主报告（同 report_fetcher.js 逻辑）
      if (json3 && json3.data) {
        const mainData = json1.data || {};
        if (!mainData.mistakeSummaryVo && json3.data) {
          mainData.mistakeSummaryVo = json3.data;
        } else if (mainData.mistakeSummaryVo && json3.data) {
          mainData.mistakeSummaryVo = { ...mainData.mistakeSummaryVo, ...json3.data };
        }
      }

      return json1;
    },

    /**
     * 导出 Excel/CSV
     */
    'EXPORT_EXCEL': function (data, sender) {
      return generateExcel(data);
    },
  };

  // 注册到壳的模块命名空间
  self.__registerModuleHandlers('report', handlers);

  console.log('[Report模块] 消息处理器已注册，共 ' + Object.keys(handlers).length + ' 个');

})();
