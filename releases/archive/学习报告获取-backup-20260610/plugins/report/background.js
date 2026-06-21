/**
 * Background Service Worker v5.1.0
 * 
 * 核心变更：Step4改用iframe方案
 *   - 工作台页面(content.js)创建iframe嵌入短链
 *   - 浏览器自动走 302+SSO+种Cookie → iframe加载reportV2.html（有登录态）
 *   - report_fetcher.js (all_frames:true) 在iframe内同源fetch 3个API
 *   - report_fetcher.js → sendMessage → SW → relay → content.js
 * 
 * 修复：
 *   - broadcastType: 3（工作台实际用的，不是4）
 */

const CONFIG = {
  WORK_DOMAIN: 'ai-genesis.yuaiweiwu.com',
  LIST_API: '/prod-api/student-center-ai/regularCourse/next/class/list',
  BIZ_API: '/prod-api/student-center-ai/ai/teacher/ai/biz',
};

console.log('[学习报告插件] Service Worker v5.1.0 启动');

// ===== 日志系统 =====
let _recentLogs = [];

function log(msg, level = 'info') {
  const prefix = '[学习报告插件]';
  console.log(`${prefix} ${msg}`);
  _recentLogs = (_recentLogs || []);
  _recentLogs.push({ time: new Date().toLocaleTimeString(), msg, level });
  if (_recentLogs.length > 500) _recentLogs.shift();
}

function getRecentLogs() {
  return (_recentLogs || []).slice(-100);
}

// ===== 工作台tab跟踪 =====
let _workTabId = null;

// ===== 工作台API请求（Step1/2用，SW fetch + credentials:include） =====
async function workApi(path, params = {}) {
  const url = new URL(`https://${CONFIG.WORK_DOMAIN}${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== null && v !== undefined) url.searchParams.set(k, v);
  });

  log(`请求工作台API: ${path}?${url.searchParams.toString().slice(0,80)}`, 'info');

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
    credentials: 'include',
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    log(`工作台API失败: HTTP ${res.status} ${errText.slice(0,200)}`, 'error');
    throw new Error(`HTTP ${res.status}: ${errText.slice(0,150)}`);
  }

  const json = await res.json();
  if (json.code !== undefined && json.code !== 0 && json.code !== 200) {
    log(`工作台API业务错误: code=${json.code} msg=${json.msg || json.message || ''}`, 'warn');
  }
  return json;
}

// ===== Step1: 学生列表 =====
async function fetchStudentList(options) {
  const opts = options || {};
  const params = {
    classStatus: opts.classStatus != null ? opts.classStatus : 2,
    startDate: opts.startDate || '2026-01-01 00:00:00',
    endDate: opts.endDate || '2030-12-31 23:59:59',
  };
  if (opts.keyword) {
    params.keyword = opts.keyword;
  }
  const json = await workApi(CONFIG.LIST_API, params);
  const list = (json.data && json.data.classList) || [];
  log(`[Step1✅] 获取到 ${list.length} 个学生`, 'ok');

  if (list.length > 0) {
    const first = list[0];
    log(`[Step1🔍] 第一个学生原始字段: ${Object.keys(first).join(', ')}`, 'info');
    const idFields = findAllIdFields(first);
    log(`[Step1🔍] 所有ID类字段: ${idFields}`, 'info');
  }

  const possibleIdFields = ['bookingId', 'periodId', 'id', 'classPeriodId', 'scheduleId', 'recordId', 'courseRecordId', 'lessonId', 'classScheduleId'];

  return {
    data: list.map(item => {
      let resolvedId = null;
      for (const field of possibleIdFields) {
        if (item[field] !== undefined && item[field] !== null && item[field] !== '') {
          resolvedId = item[field];
          break;
        }
      }
      // 修复姓名取法：chineseName → userName → remarkName → studentName → name → stuName
      const realName = item.chineseName || item.userName || item.remarkName || item.studentName || item.name || item.stuName || '';
      return {
        periodId: resolvedId,
        studentId: item.studentId || item.userId || '',
        studentName: realName,
        courseClassify: item.courseClassify || 3,
        studyVersion: item.studyVersion || 1,
        // 从工作台列表API额外携带的字段（报告API里没有）
        inClassDuration: item.inClassOnlineDuration || '',
        homeworkStatus: item.homeworkCompletionStatusDesc || '-',
        attendanceStatus: item.effectiveAttendanceDesc || '-',
        rawCourseName: item.courseName || '',
        rawLessonName: item.lessonName || '',
        _rawItem: item,
        _debugIds: (() => {
          const ids = {};
          for (const f of possibleIdFields) { if (item[f] !== undefined) ids[f] = item[f]; }
          return ids;
        })(),
      };
    }),
    _debugFirst: list.length > 0 ? JSON.stringify(list[0]) : null,
  };
}

function findAllIdFields(obj, prefix = '', results = []) {
  if (!obj || typeof obj !== 'object') return results;
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string' || typeof v === 'number') {
      if (/id/i.test(k) || /Id$/.test(k)) {
        results.push(`${fullKey}=${v}`);
      }
    } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      findAllIdFields(v, fullKey, results);
    }
  }
  return results;
}

// ===== Step2+3: 获取短链 + 跟随重定向取reportToken =====
async function fetchShortUrl(payload) {
  const { periodId, studentName, courseClassify } = payload;

  // Step2: biz接口 (broadcastType=3 ← 关键修复！工作台实际用的就是3)
  log(`${studentName || '?'} [Step2] 调用biz接口 id=${periodId}`, 'info');
  const bizRes = await workApi(CONFIG.BIZ_API, {
    id: periodId,
    urlType: 2,
    broadcastType: 3,  // ← 关键！不是4
    courseClassify: String(courseClassify || 3),
  });

  log(`${studentName || '?'} [Step2] biz响应: code=${bizRes.code}`, 'info');

  const successCodes = ['000000', '0', '200', 0, 200, undefined];
  if (bizRes.code !== undefined && !successCodes.includes(bizRes.code)) {
    throw new Error(`biz业务错误(code=${bizRes.code}): ${bizRes.msg || bizRes.mesg || ''}`);
  }

  const shortUrl = (bizRes.data && bizRes.data.aiBizUrl) || null;
  if (!shortUrl) throw new Error(`biz未返回短链(响应: ${JSON.stringify(bizRes).slice(0,200)})`);
  log(`${studentName || '?'} [Step2✅] 短链: ${shortUrl}`, 'ok');

  // Step3: 跟随短链重定向获取最终URL（含reportToken）
  let finalUrl;
  try {
    finalUrl = await getFinalUrlFromShortCode(shortUrl);
    log(`${studentName || '?'} [Step3✅] 最终URL长度: ${finalUrl.length}`, 'ok');
  } catch(e) {
    log(`${studentName || '?'} [Step3❌] ${e.message}`, 'error');
    throw new Error(`[获取Token] ${e.message}`);
  }

  const reportToken = extractReportToken(finalUrl);
  if (!reportToken) {
    throw new Error(`[提取Token] 最终URL中无report参数: ${finalUrl.slice(0,120)}`);
  }
  log(`${studentName || '?'} [Step3✅] token长度: ${reportToken.length}`, 'ok');

  return { shortUrl, reportToken };
}

// ===== 短链重定向：SW fetch跟随 =====
async function getFinalUrlFromShortCode(shortUrl) {
  try {
    const res = await fetch(shortUrl, { method: 'GET', redirect: 'follow' });
    const finalUrl = res.url || '';
    if (finalUrl && finalUrl !== shortUrl) return finalUrl;
    log(`[Step3] fetch返回URL相同或为空, status=${res.status}, 尝试手动跟随`, 'warn');
  } catch(e) {
    log(`[Step3] fetch直接失败: ${e.message}, 尝试手动跟随`, 'warn');
  }

  try {
    const res = await fetch(shortUrl, { method: 'GET', redirect: 'manual' });
    const location = res.headers.get('location');
    if (location) return location;
  } catch(e) {
    log(`[Step3] manual fetch也失败: ${e.message}`, 'warn');
  }

  throw new Error('无法跟随短链重定向');
}

function extractReportToken(finalUrl) {
  const match = finalUrl.match(/report=([^&]+)/);
  if (match) return decodeURIComponent(match[1]);
  return null;
}

// ===== 数据解析 =====
function parseReportData(json) {
  if (!json || !json.data) return null;
  const d = json.data;

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
    knowledgeList,
    exercises,
  };
}

// ===== 消息处理器 =====
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // content.js注册工作台tab ID
  if (msg.type === 'REGISTER_TAB') {
    _workTabId = sender.tab?.id || null;
    log(`工作台tab已注册: tabId=${_workTabId}`);
    sendResponse({ ok: true });
    return;
  }

  // report_fetcher.js从iframe内发回数据 → relay给content.js
  if (msg.type === 'REPORT_DATA_RESULT') {
    log(`[relay] 收到iframe数据, reportToken=${(msg.reportToken||'').slice(0,10)}..., error=${msg.error||'无'}`, 'info');
    if (_workTabId) {
      chrome.tabs.sendMessage(_workTabId, {
        type: 'RELAY_REPORT_DATA',
        reportToken: msg.reportToken,
        data: msg.data,
        error: msg.error,
      }).catch(e => log(`[relay] 发送失败: ${e.message}`, 'error'));
    } else {
      log('[relay] 无工作台tabId，无法转发！', 'error');
    }
    return;
  }

  if (msg.type === 'GET_LOGS') {
    sendResponse(getRecentLogs());
    return;
  }

  if (msg.type === 'CANCEL_FETCH') {
    log('收到中断请求', 'warn');
    sendResponse({ cancelled: true });
    return;
  }

  const handler = handleMessage(msg, sender);
  handler.then(sendResponse).catch(err => {
    console.error('[学习报告插件] 错误:', msg.type, err);
    try { sendResponse({ error: err.message }); } catch(e) {}
  });
  return true;
});

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'CHECK_CONNECTION':     return await checkConnection();
    case 'FETCH_STUDENT_LIST':   return await fetchStudentList(msg.payload);
    case 'FETCH_SHORT_URL':      return await fetchShortUrl(msg.payload);
    case 'EXPORT_EXCEL':         return await generateExcel(msg.data);
    default: throw new Error('未知消息类型: ' + msg.type);
  }
}

// ===== 连接检测 =====
async function checkConnection() {
  try {
    const json = await workApi(CONFIG.LIST_API, {
      classStatus: 2,
      startDate: '2026-01-01 00:00:00',
      endDate: '2030-12-31 23:59:59',
    });
    const list = (json.data && json.data.classList) || [];
    return { connected: true, count: list.length };
  } catch (e) {
    log(`连接检测失败: ${e.message}`, 'error');
    return { connected: false, error: e.message };
  }
}

// ===== CSV导出（SW无DOM，把CSV字符串传回content.js用<a>下载）=====
async function generateExcel(students) {
  const csv = buildCSV(students);
  const filename = `学习报告分析_${formatDate()}.csv`;
  // Service Worker 没有 URL.createObjectURL / Blob，
  // 把 CSV 字符串传回 content.js，由 content.js 用 <a download> 触发下载
  return { success: true, count: students.length, csv, filename };
}

function escapeCSV(val) {
  if (val == null) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function buildCSV(students) {
  const lines = [];

  // ===== Sheet1: 学生明细（v5.1.0 精简18列）=====
  lines.push('═════ 学生明细 ═════');
  lines.push([
    '学员姓名','学员ID','课程名称','本课节名称','听课时长','作业完成情况','有效出勤',
    '综合标签','一句话诊断','四象限',
    '参与度','回答率%','老师总提问数','学生总回答数','专注度','认真回答次数','超过同学%',
    '学习效果'
  ].map(escapeCSV).join(','));

  for (let i = 0; i < students.length; i++) {
    const s = students[i];
    const row = [
      s.name, s.studentId || '', s.courseName, s.lessonName,
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
  const summary = buildLessonSummary(students);
  for (const lesson of summary) {
    lines.push(`═════ ${lesson.lessonName} ═════`);
    lines.push('【课节概览】');
    lines.push(['指标','值'].map(escapeCSV).join(','));
    lines.push(['学生总数', lesson.total].map(escapeCSV).join(','));
    lines.push(['平均回答率', lesson.avgRate + '%'].map(escapeCSV).join(','));
    lines.push(['敷衍预警人数(<50%)', lesson.dangerCount].map(escapeCSV).join(','));
    lines.push(['严重敷衍人数(<30%)', lesson.criticalCount].map(escapeCSV).join(','));
    lines.push(['优秀人数', lesson.successCount].map(escapeCSV).join(','));
    lines.push('');
    lines.push('【学生排名】按回答率升序');
    lines.push(['排名','姓名','ID','回答率%','掌握度','综合标签','一句话诊断'].map(escapeCSV).join(','));
    for (const [idx, s] of lesson.ranking.entries()) {
      lines.push([idx + 1, s.name, s.studentId || '', (s.rate != null ? s.rate : '') + '%', s.masteryRating, s.overallTag, s.diagnosis].map(escapeCSV).join(','));
    }
    lines.push('');
    if (lesson.problemStudents.length > 0) {
      lines.push('【问题学生名单】');
      lines.push(['姓名','ID','问题类型','关键指标','建议动作'].map(escapeCSV).join(','));
      for (const p of lesson.problemStudents) {
        const ptype = p.participation.tag === 'danger' || p.participation.tag === 'critical'
          ? '敷衍上课' : '学习能力需关注';
        const action = p.participation.tag === 'critical' ? '联系家长/班主任，严肃谈话'
          : p.participation.tag === 'danger' ? '关注下节课状态' : '调整教学方法';
        lines.push([p.name, p.studentId || '', ptype, `回答率 ${p.rate}%`, action].map(escapeCSV).join(','));
      }
    } else {
      lines.push('【无问题学生】✅');
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ===== Sheet2: 课节汇总 =====
function buildLessonSummary(students) {
  const groups = {};
  for (const s of students) {
    const key = s.lessonName || '未知课节';
    if (!groups[key]) groups[key] = [];
    groups[key].push(s);
  }
  return Object.entries(groups).map(([lessonName, group]) => {
    const validRate = group.filter(s => s.rate != null);
    const avgRate = validRate.length ? Math.round(validRate.reduce((s,r)=>s+r.rate,0)/validRate.length) : null;
    const validExer = group.filter(s => s.exerRate != null);
    const avgExercise = validExer.length ? Math.round(validExer.reduce((s,r)=>s+r.exerRate,0)/validExer.length) : null;
    const ranking = [...group].sort((a,b) => (a.rate||0)-(b.rate||0));
    const problemStudents = group.filter(r =>
      r.tag === 'danger' || r.tag === 'critical' || r.overallTagClass === 'danger'
    ).map(r => ({
      name: r.name, studentId: r.studentId || '', rate: r.rate,
      participation: { tag: r.tag },
      masteryRating: r.masteryRating,
      overallTag: r.overallTag, diagnosis: r.diagnosis
    }));
    return {
      lessonName, total: group.length,
      avgRate: avgRate != null ? avgRate : 0,
      dangerCount: group.filter(r=>r.tag==='danger'||r.tag==='critical').length,
      criticalCount: group.filter(r=>r.rate!=null&&r.rate<30).length,
      successCount: group.filter(r=>r.tag==='success').length,
      avgExercise, ranking, problemStudents,
    };
  });
}

function formatDate() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}
