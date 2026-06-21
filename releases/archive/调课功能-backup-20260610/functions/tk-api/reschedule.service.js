/**
 * 改约执行服务
 * parse(解析调课指令) / execute(执行单条改约) / batch(批量并发执行)
 */

const https = require('https');

const AI_GENESIS_BASE = 'https://ai-genesis.yuaiweiwu.com';

/**
 * 解析调课指令（不执行，返回任务列表）
 * @param {Object} data - { input: '王一 5 5月2日 10:00\n李二 第3讲 5-3 14:00' }
 */
exports.parse = async function (data, currentUser, ctx) {
  const { db, response } = ctx;

  if (!data.input || !data.input.trim()) {
    return response.badRequest('请输入调课指令');
  }

  try {
    const lines = data.input.trim().split('\n').filter(l => l.trim());
    const tasks = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const parsed = parseLine(line, i + 1);
      tasks.push(parsed);
    }

    // 如果有姓名输入，尝试匹配学员ID
    for (const task of tasks) {
      if (task.status === 'ok' && isNaN(task.studentIdentifier)) {
        // 姓名匹配
        const matchResult = await matchStudentByName(db, currentUser._id, task.studentIdentifier, task.phone);
        if (matchResult.matched) {
          task.studentId = matchResult.studentId;
          task.studentName = matchResult.name || task.studentIdentifier;
        } else {
          task.status = 'error';
          task.error = matchResult.reason || `未找到学员"${task.studentIdentifier}"`;
          if (matchResult.duplicates) {
            task.duplicates = matchResult.duplicates;
          }
        }
      } else if (task.status === 'ok' && !isNaN(task.studentIdentifier)) {
        task.studentId = task.studentIdentifier;
      }
    }

    const successCount = tasks.filter(t => t.status === 'ok').length;
    const failCount = tasks.filter(t => t.status === 'error').length;

    return response.success({
      tasks: tasks,
      total: tasks.length,
      success: successCount,
      failed: failCount,
    });
  } catch (err) {
    console.error('[TK-Reschedule] Parse error:', err);
    return response.error(500, '指令解析失败');
  }
};

/**
 * 执行单条改约
 * @param {Object} data - { studentId, courseId, aiCourseId, aiClassHourId, periodId, userClassTimeId, newDate, newTime }
 */
exports.execute = async function (data, currentUser, ctx) {
  const { db, response } = ctx;

  // 获取调课 JWT
  const tiaokeToken = require('./tiaokeToken.service.js');
  const jwt = await tiaokeToken.getDecryptedToken(currentUser._id, db);
  if (!jwt) {
    return response.error(401, '调课 Token 未设置或已过期，请先获取 Token');
  }

  try {
    // 1. 查询课表获取原始课时信息
    const classData = await getClassHourData(jwt, data);

    // 2. 构造改约请求体
    const requestBody = buildRescheduleBody(data, classData);

    // 3. 提交改约
    const result = await httpPost(
      `${AI_GENESIS_BASE}/prod-api/student-center-ai/ai/user/course/classhour`,
      requestBody,
      jwt
    );

    const success = result.code === '000000' || result.code === 200;

    // 4. 记录日志
    await logReschedule(db, currentUser._id, data, success, success ? '改约成功' : (result.message || result.msg || '改约失败'));

    if (success) {
      return response.success({
        studentId: data.studentId,
        newDate: data.newDate,
        newTime: data.newTime,
      }, '改约成功');
    } else {
      return response.error(400, result.message || result.msg || '改约失败');
    }
  } catch (err) {
    console.error('[TK-Reschedule] Execute error:', err);
    await logReschedule(db, currentUser._id, data, false, err.message || '网络错误');
    return response.error(500, '改约执行失败：' + (err.message || '网络错误'));
  }
};

/**
 * 批量执行改约（并发池 3）
 * @param {Object} data - { tasks: [...] }
 */
exports.batch = async function (data, currentUser, ctx) {
  const { db, response } = ctx;

  if (!data.tasks || !Array.isArray(data.tasks) || data.tasks.length === 0) {
    return response.badRequest('请提供调课任务列表');
  }

  const tiaokeToken = require('./tiaokeToken.service.js');
  const jwt = await tiaokeToken.getDecryptedToken(currentUser._id, db);
  if (!jwt) {
    return response.error(401, '调课 Token 未设置或已过期，请先获取 Token');
  }

  const results = [];
  const CONCURRENCY = 3;
  const STAGGER_MS = 500;
  const BATCH_GAP_MS = 300;

  try {
    for (let i = 0; i < data.tasks.length; i += CONCURRENCY) {
      const batch = data.tasks.slice(i, i + CONCURRENCY);
      const batchPromises = batch.map(async (task, idx) => {
        // 组内错开
        await sleep(idx * STAGGER_MS);

        try {
          const classData = await getClassHourData(jwt, task);
          const requestBody = buildRescheduleBody(task, classData);
          const result = await httpPost(
            `${AI_GENESIS_BASE}/prod-api/student-center-ai/ai/user/course/classhour`,
            requestBody,
            jwt
          );

          const success = result.code === '000000' || result.code === 200;
          const msg = success ? '改约成功' : (result.message || result.msg || '改约失败');

          await logReschedule(db, currentUser._id, task, success, msg);

          return {
            index: i + idx,
            studentId: task.studentId,
            studentName: task.studentName || task.studentId,
            lesson: task.lesson,
            newDate: task.newDate,
            newTime: task.newTime,
            success: success,
            message: msg,
          };
        } catch (err) {
          await logReschedule(db, currentUser._id, task, false, err.message || '网络错误');
          return {
            index: i + idx,
            studentId: task.studentId,
            studentName: task.studentName || task.studentId,
            lesson: task.lesson,
            newDate: task.newDate,
            newTime: task.newTime,
            success: false,
            message: err.message || '网络错误',
          };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      // 批次间间隔
      if (i + CONCURRENCY < data.tasks.length) {
        await sleep(BATCH_GAP_MS);
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    return response.success({
      results: results,
      total: results.length,
      success: successCount,
      failed: failCount,
    }, successCount === results.length ? '全部改约成功' : `${successCount}条成功，${failCount}条失败`);
  } catch (err) {
    console.error('[TK-Reschedule] Batch error:', err);
    return response.error(500, '批量改约执行异常');
  }
};

// ========== 解析工具 ==========

/**
 * 解析单行调课指令
 */
function parseLine(line, lineNum) {
  const task = {
    line: lineNum,
    raw: line,
    status: 'ok',
    error: '',
  };

  // 尝试自然语言解析："王一，第5讲，调到5月2日早上10点上课"
  const nlMatch = line.match(/(.+?)[，,]?\s*第(\d+)讲[，,]?\s*(?:调到|改到|改为|调|改)?\s*(.+)/);
  if (nlMatch) {
    task.studentIdentifier = nlMatch[1].trim();
    task.lesson = parseInt(nlMatch[2]);
    const timeStr = nlMatch[3].trim();
    const parsed = parseDateTimeStr(timeStr);
    if (parsed.date) {
      task.newDate = parsed.date;
      task.newTime = parsed.time || '10:00';
    } else {
      task.status = 'error';
      task.error = `第${lineNum}行：无法识别日期"${timeStr}"`;
    }
    return task;
  }

  // 尝试结构化解析：Tab/逗号/多空格分隔
  const parts = line.split(/[\t,，\u3000]+|\s{2,}/).map(s => s.trim()).filter(s => s);
  if (parts.length >= 3) {
    task.studentIdentifier = parts[0];
    task.lesson = parseInt(parts[1]);
    if (isNaN(task.lesson)) {
      // 第二列可能不是讲次，尝试其他格式
      task.status = 'error';
      task.error = `第${lineNum}行：无法识别讲次"${parts[1]}"`;
      return task;
    }
    const dateStr = parts[2];
    const timeStr = parts[3] || '';
    const parsed = parseDateTimeStr(dateStr + (timeStr ? ' ' + timeStr : ''));
    if (parsed.date) {
      task.newDate = parsed.date;
      task.newTime = parsed.time || '10:00';
    } else {
      task.status = 'error';
      task.error = `第${lineNum}行：无法识别日期"${dateStr}"`;
    }
    return task;
  }

  task.status = 'error';
  task.error = `第${lineNum}行：格式不正确，请检查`;
  return task;
}

/**
 * 解析日期时间字符串
 */
function parseDateTimeStr(str) {
  const result = { date: null, time: null };
  if (!str) return result;

  const now = new Date();
  const currentYear = now.getFullYear();

  // 提取时间
  const timeMatch = str.match(/(\d{1,2}):(\d{2})(?::\d{2})?/) ||
                    str.match(/(上午|早上?)?(\d{1,2})[点时:](\d{0,2})/) ||
                    str.match(/(下午|晚上?)(\d{1,2})[点时:](\d{0,2})/);
  if (timeMatch) {
    let hour, minute;
    if (timeMatch[1] && (timeMatch[1].includes('下') || timeMatch[1].includes('晚'))) {
      hour = parseInt(timeMatch[2]) + (parseInt(timeMatch[2]) < 12 ? 12 : 0);
    } else {
      hour = parseInt(timeMatch[2] || timeMatch[1]);
    }
    minute = parseInt(timeMatch[3]) || 0;
    result.time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  // 提取日期
  // YYYY-MM-DD
  let dateMatch = str.match(/(\d{4})[年\-\/](\d{1,2})[月\-\/](\d{1,2})/);
  if (dateMatch) {
    result.date = `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`;
    return result;
  }

  // MM月DD日 / MM-DD / MM/DD
  dateMatch = str.match(/(\d{1,2})[月\-\/](\d{1,2})[日号]?/);
  if (dateMatch) {
    const month = dateMatch[1].padStart(2, '0');
    const day = dateMatch[2].padStart(2, '0');
    result.date = `${currentYear}-${month}-${day}`;
    return result;
  }

  return result;
}

/**
 * 按姓名匹配学员
 */
async function matchStudentByName(db, userId, name, phone) {
  const exactResult = await db.collection('tk_students').where({
    ownerId: userId,
    name: name,
  }).get();

  if (!exactResult.data || exactResult.data.length === 0) {
    return { matched: false, reason: `未在学情表中找到"${name}"` };
  }

  if (exactResult.data.length === 1) {
    return { matched: true, studentId: exactResult.data[0].studentId, name: exactResult.data[0].name };
  }

  // 重名
  if (phone) {
    const phoneSuffix = phone.trim();
    const phoneMatch = exactResult.data.filter(s => s.phone && s.phone.endsWith(phoneSuffix));
    if (phoneMatch.length === 1) {
      return { matched: true, studentId: phoneMatch[0].studentId, name: phoneMatch[0].name };
    }
  }

  return {
    matched: false,
    reason: `存在${exactResult.data.length}位同名学员"${name}"，请补充手机号后4位`,
    duplicates: exactResult.data.map(s => ({
      name: s.name,
      studentId: s.studentId,
      phoneLast4: s.phone ? s.phone.slice(-4) : '',
    })),
  };
}

/**
 * 查询课时数据（用于构造改约请求）
 */
async function getClassHourData(jwt, task) {
  // 先查课表列表
  // 与Chrome扩展保持一致：前后3个月，日期格式带时分秒
  const now = new Date();
  const threeMonthsAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const threeMonthsLater = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  const startDate = formatDateTime(threeMonthsAgo);
  const endDate = formatDateTime(threeMonthsLater);

  // 检查JWT过期时间
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
    const expTime = payload.exp ? new Date(payload.exp * 1000).toISOString() : 'unknown';
    const isExpired = payload.exp ? (Date.now() > payload.exp * 1000) : false;
    console.log('[TK-Debug] JWT exp:', expTime, 'expired:', isExpired);
  } catch (e) { /* ignore */ }

  const listUrl = `${AI_GENESIS_BASE}/prod-api/student-center-ai/regularCourse/next/class/list?classStatus=0&startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`;
  console.log('[TK-Debug] calling URL:', listUrl);
  const listResult = await httpGet(listUrl, jwt);

  console.log('[TK-Debug] listResult code:', listResult.code, 'mesg:', listResult.mesg, 'keys:', Object.keys(listResult));

  // API返回错误时，记录完整响应便于排查
  if (listResult.code && listResult.code !== '000000') {
    console.log('[TK-Debug] full error response:', JSON.stringify(listResult).substring(0, 2000));
    throw new Error(`课表列表查询失败: ${listResult.mesg || listResult.message || '未知错误'} (code:${listResult.code})`);
  }

  // 打印完整的data字段内容（无论是否为空）
  console.log('[TK-Debug] listResult.data raw:', JSON.stringify(listResult.data).substring(0, 3000));

  let classList = extractArray(listResult);
  console.log('[TK-Debug] classList length:', classList.length, 'type:', typeof classList);
  if (classList.length > 0) {
    console.log('[TK-Debug] first item keys:', Object.keys(classList[0]));
    console.log('[TK-Debug] first item userId:', classList[0].userId, 'studentId:', classList[0].studentId);
  }

  // 过滤该学员（兼容 studentId / userId 两种字段名）
  const studentFiltered = classList.filter(c => {
    const itemUserId = String(c.studentId || c.userId || '');
    return itemUserId === String(task.studentId);
  });
  console.log('[TK-Debug] after student filter:', studentFiltered.length, 'task.studentId:', task.studentId);

  // 从 lessonName 提取"第X讲"匹配
  const targetLesson = task.lesson;
  const targetClass = studentFiltered.find(c => {
    const lessonMatch = (c.lessonName || '').match(/第(\d+)讲/);
    console.log('[TK-Debug] checking lessonName:', c.lessonName, 'match:', lessonMatch);
    return lessonMatch && parseInt(lessonMatch[1]) === targetLesson;
  });

  if (!targetClass) {
    throw new Error(
      `未找到第${targetLesson}讲的课表记录` +
      `(总${classList.length}条, 学员匹配${studentFiltered.length}条)`
    );
  }

  // 查询课时详情
  const bookingId = targetClass.bookingId || targetClass.id || targetClass.userClassTimeId;
  if (bookingId) {
    const hourUrl = `${AI_GENESIS_BASE}/prod-api/student-center-ai/ai/user/course/classhour?userClassTimeId=${bookingId}`;
    const hourResult = await httpGet(hourUrl, jwt);
    return {
      classInfo: targetClass,
      hourData: hourResult.data || hourResult,
    };
  }

  return { classInfo: targetClass, hourData: null };
}

/**
 * 构造改约请求体
 */
function buildRescheduleBody(task, classData) {
  const classInfo = classData.classInfo;
  const hourData = classData.hourData;

  // 从课时数据中获取必要字段
  const courseId = hourData?.courseId || classInfo.courseId || '';
  const aiCourseId = hourData?.aiCourseId || classInfo.aiCourseId || '';
  const aiClassHourId = hourData?.aiClassHourId || classInfo.aiClassHourId || '';
  const periodId = hourData?.periodId || classInfo.periodId || '';
  const userClassTimeId = classInfo.bookingId || classInfo.id || classInfo.userClassTimeId || '';

  // 计算新的结束时间（固定2小时）
  const [startH, startM] = (task.newTime || '10:00').split(':').map(Number);
  const endH = startH + 2;
  const endM = startM;
  const classTimeStart = `${task.newDate} ${task.newTime}:00`;
  const classTimeEnd = `${task.newDate} ${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}:00`;

  return {
    type: 2,
    userId: task.studentId,
    courseId: courseId,
    aiCourseId: aiCourseId,
    aiClassHourId: aiClassHourId,
    periodId: periodId,
    userClassTimes: [{
      classTimeStart: classTimeStart,
      classTimeEnd: classTimeEnd,
      aiClassHourSort: 1,
      id: userClassTimeId,
    }],
  };
}

/**
 * 记录调课日志
 */
async function logReschedule(db, userId, task, success, message) {
  try {
    await db.collection('tk_logs').add({
      userId: userId,
      studentId: task.studentId || '',
      studentName: task.studentName || '',
      lesson: task.lesson || 0,
      newDate: task.newDate || '',
      newTime: task.newTime || '',
      success: success,
      message: message,
      createdAt: new Date(),
    });
  } catch (e) {
    console.error('[TK-Reschedule] Log error:', e);
  }
}

// ========== HTTP 工具 ==========

function httpGet(url, jwt) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'Cookie': `authorization-app=aiXin; authorization-token=${jwt}`,
        'Accept': 'application/json',
        'Referer': 'https://ai-genesis.yuaiweiwu.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      console.log(`[TK-Debug] HTTP status: ${res.statusCode}, content-type: ${res.headers['content-type']}`);

      // 处理重定向
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        console.log('[TK-Debug] Redirect to:', res.headers.location);
        resolve({ code: 'REDIRECT', message: `重定向到: ${res.headers.location}`, statusCode: res.statusCode });
        return;
      }

      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch (e) {
          console.log('[TK-Debug] Non-JSON response, first 500 chars:', data.substring(0, 500));
          resolve({ code: 'PARSE_ERROR', message: '响应非JSON格式', raw: data.substring(0, 500) });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('请求超时')); });
    req.end();
  });
}

function httpPost(url, body, jwt) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const parsedUrl = new URL(url);
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Content-Length': Buffer.byteLength(bodyStr),
        'Cookie': `authorization-app=aiXin; authorization-token=${jwt}`,
        'Accept': 'application/json',
        'Referer': 'https://ai-genesis.yuaiweiwu.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('请求超时')); });
    req.write(bodyStr);
    req.end();
  });
}

function extractArray(result) {
  if (Array.isArray(result)) return result;
  if (result.data) {
    if (Array.isArray(result.data)) return result.data;
    for (const key of ['classList', 'rows', 'list', 'records', 'items', 'content']) {
      if (result.data[key] && Array.isArray(result.data[key])) return result.data[key];
    }
  }
  for (const key of ['classList', 'rows', 'list', 'records', 'items', 'content']) {
    if (result[key] && Array.isArray(result[key])) return result[key];
  }
  return [];
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 格式化日期时间（带时分秒，与Chrome扩展保持一致）
 * API期望格式：YYYY-MM-DD HH:mm:ss
 */
function formatDateTime(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${min}:${s}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
