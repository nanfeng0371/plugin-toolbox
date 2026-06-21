/**
 * 调课助手 - Content Script
 * 在目标网站上下文中运行，负责实际API调用
 * 由于Content Script与页面同域，可以直接发起fetch请求并自动携带Cookie
 */

const API_BASE = 'https://ai-genesis.yuaiweiwu.com/prod-api/student-center-ai';

/**
 * 通用API请求封装
 * @param {string} url - 完整请求URL
 * @param {object} options - fetch选项
 * @returns {Promise<object>} API响应数据
 */
async function apiRequest(url, options = {}) {
  const defaultOptions = {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
    },
    credentials: 'include',
  };

  const mergedOptions = { ...defaultOptions, ...options };

  try {
    const response = await fetch(url, mergedOptions);
    if (!response.ok) {
      throw new Error(`HTTP错误: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('[调课助手] API请求失败:', url, error);
    throw error;
  }
}

/**
 * 查询学员信息
 * @param {string} userId - 学员ID
 * @returns {Promise<object|null>} 学员信息
 */
async function fetchStudentInfo(userId) {
  const url = `${API_BASE}/student/name/${userId}`;
  const result = await apiRequest(url);
  if (result.code === '000000') {
    return result.data;
  }
  throw new Error(result.mesg || '查询学员信息失败');
}

/**
 * 查询课表列表（按日期范围）
 * 用于获取学员的课程数据，再按学员ID和periodSort过滤
 * @param {string} startDate - 开始日期 YYYY-MM-DD HH:mm:ss
 * @param {string} endDate - 结束日期 YYYY-MM-DD HH:mm:ss
 * @returns {Promise<Array>} 课表列表
 */
async function fetchClassList(startDate, endDate) {
  const url = `${API_BASE}/regularCourse/next/class/list?classStatus=0&startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`;
  const result = await apiRequest(url);
  console.log('[调课助手] fetchClassList 原始响应:', result);
  if (result.code === '000000') {
    let data = result.data || result.rows || result.list || result.records || [];

    // 如果 data 是对象（如 { classList: [...], realStartDate: ... }），尝试提取其中的数组字段
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const possibleArrayFields = ['classList', 'rows', 'list', 'records', 'data', 'items', 'content'];
      for (const field of possibleArrayFields) {
        if (Array.isArray(data[field])) {
          console.log('[调课助手] fetchClassList 从对象字段提取:', field, data[field].length, '条');
          data = data[field];
          break;
        }
      }
    }

    if (!Array.isArray(data)) {
      console.warn('[调课助手] fetchClassList 无法提取数组，原始数据类型:', typeof data, data);
      data = [];
    }

    console.log('[调课助手] fetchClassList 最终数据:', data.length, '条');
    return data;
  }
  throw new Error(result.mesg || '查询课表列表失败');
}

/**
 * 查询课堂数据（单条，通过userClassTimeId）
 * @param {string} userClassTimeId - 课堂记录ID
 * @returns {Promise<object>} 课堂详情
 */
async function fetchClassHour(userClassTimeId) {
  const url = `${API_BASE}/ai/user/course/classhour?userClassTimeId=${userClassTimeId}`;
  const result = await apiRequest(url);
  if (result.code === '000000') {
    return result.data;
  }
  throw new Error(result.mesg || '查询课堂数据失败');
}

/**
 * 提交改约
 * @param {object} params - 改约参数
 * @param {string} params.userId - 学员ID
 * @param {string} params.courseId - 课程ID
 * @param {string} params.aiCourseId - AI课程ID
 * @param {string} params.aiClassHourId - AI课时ID
 * @param {string} params.periodId - 期ID
 * @param {Array} params.userClassTimes - 课堂时间列表
 * @returns {Promise<object>} 提交结果
 */
async function submitReschedule(params) {
  const url = `${API_BASE}/ai/user/course/classhour`;
  const body = {
    type: 2,
    userId: params.userId,
    courseId: params.courseId,
    aiCourseId: params.aiCourseId,
    aiClassHourId: params.aiClassHourId,
    periodId: params.periodId,
    userClassTimes: params.userClassTimes,
  };

  const result = await apiRequest(url, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (result.code === '000000') {
    return { success: true, message: result.mesg || '处理成功' };
  }
  throw new Error(result.mesg || '改约提交失败');
}

/**
 * 计算结束时间（开始时间+2小时）
 * @param {string} dateStr - 日期 YYYY-MM-DD
 * @param {string} timeStr - 开始时间 HH:mm
 * @returns {{ classTimeStart: string, classTimeEnd: string }} 格式化的时间对
 */
function calculateTimeRange(dateStr, timeStr) {
  const classTimeStart = `${dateStr} ${timeStr}:00`;
  const startDate = new Date(`${dateStr}T${timeStr}:00`);
  const endDate = new Date(startDate.getTime() + 2 * 60 * 60 * 1000);
  const endHours = String(endDate.getHours()).padStart(2, '0');
  const endMinutes = String(endDate.getMinutes()).padStart(2, '0');
  const endSeconds = String(endDate.getSeconds()).padStart(2, '0');
  const classTimeEnd = `${dateStr} ${endHours}:${endMinutes}:${endSeconds}`;
  return { classTimeStart, classTimeEnd };
}

/**
 * 生成日期范围（前后3个月）
 * @returns {{ startDate: string, endDate: string }} 日期范围字符串
 */
function getDefaultDateRange() {
  const now = new Date();
  const threeMonthsAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const threeMonthsLater = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

  const formatDate = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day} 00:00:00`;
  };

  return {
    startDate: formatDate(threeMonthsAgo),
    endDate: formatDate(threeMonthsLater),
  };
}

/**
 * 从课表列表中提取讲次序号
 * 优先使用 aiClassHourSort，其次从 lessonName/periodName 中提取数字
 * @param {object} item - 课表记录
 * @returns {number} 讲次序号
 */
function extractPeriodSort(item) {
  // 优先使用数字字段
  if (item.aiClassHourSort && Number(item.aiClassHourSort) > 0) {
    return Number(item.aiClassHourSort);
  }
  if (item.periodSort && Number(item.periodSort) > 0) {
    return Number(item.periodSort);
  }
  // 从 lessonName 或 periodName 中提取，如 "第2讲 xxx"
  const name = item.lessonName || item.periodName || '';
  const match = name.match(/第(\d+)讲/);
  if (match) {
    return parseInt(match[1], 10);
  }
  return 0;
}

/**
 * 在课表列表中匹配目标课程
 * @param {Array} classList - 课表列表
 * @param {string} userId - 学员ID
 * @param {number} periodSort - 第几讲
 * @returns {object|null} 匹配到的课堂记录
 */
function matchTargetClass(classList, userId, periodSort) {
  return classList.find((item) => {
    const itemUserId = String(item.studentId || item.userId || '');
    const itemPeriodSort = extractPeriodSort(item);
    return itemUserId === String(userId) && itemPeriodSort === Number(periodSort);
  }) || null;
}

/**
 * 执行单条调课任务
 * @param {object} task - 调课任务
 * @param {string} task.userId - 学员ID
 * @param {number} task.periodSort - 第几讲
 * @param {string} task.newDate - 新日期
 * @param {string} task.newTime - 新开始时间
 * @returns {Promise<object>} 执行结果
 */
async function executeSingleTask(task) {
  try {
    // 从 chrome.storage.local 读取缓存的课表数据
    let classList = null;
    try {
      const stored = await chrome.storage.local.get('classListCache');
      const cached = stored.classListCache;
      if (Array.isArray(cached) && cached.length > 0) {
        classList = cached;
        console.log('[调课助手] 使用storage缓存，共', classList.length, '条记录');
      } else if (cached !== undefined && cached !== null) {
        console.warn('[调课助手] storage中的classListCache类型异常:', typeof cached, '长度:', cached?.length, '将重新查询');
      }
    } catch (e) {
      console.warn('[调课助手] 读取storage缓存失败，将重新查询', e);
    }

    // 如果没有缓存或缓存无效，则自行查询
    if (!classList) {
      console.log('[调课助手] 缓存不可用，开始查询课表...');
      const { startDate, endDate } = getDefaultDateRange();
      classList = await fetchClassList(startDate, endDate);
      console.log('[调课助手] 查询完成，共', classList.length, '条记录');
    }

    // 最终安全检查：确保 classList 是数组
    if (!Array.isArray(classList)) {
      return {
        success: false,
        error: `课表数据格式异常（类型: ${typeof classList}），请联系开发者`,
      };
    }

    if (classList.length === 0) {
      return {
        success: false,
        error: '课表数据为空，请确认日期范围和账号权限',
      };
    }

    // 按学员ID和第几讲匹配
    const targetClass = matchTargetClass(classList, task.userId, task.periodSort);

    if (!targetClass) {
      return {
        success: false,
        error: `未找到学员${task.userId}第${task.periodSort}讲的课程数据`,
      };
    }

    // 调试：打印匹配到的完整课程记录，用于确认字段名
    console.log('[调课助手] 匹配到的课程记录:', JSON.stringify(targetClass, null, 2));

    // 4. 提取关键字段
    const courseId = String(targetClass.courseId || '');
    const aiCourseId = String(targetClass.aiCourseId || '');
    const aiClassHourId = String(targetClass.aiClassHourId || '');
    const periodId = String(targetClass.periodId || targetClass.aiPeriodId || '');
    // 上课时间ID：优先 bookingId（课表列表返回），其次 id / userClassTimeId
    const userClassTimeId = String(targetClass.bookingId || targetClass.id || targetClass.userClassTimeId || '');

    // 5. 计算新时间
    const { classTimeStart, classTimeEnd } = calculateTimeRange(task.newDate, task.newTime);

    // 6. 构造提交参数
    const submitParams = {
      userId: String(task.userId),
      courseId: courseId,
      aiCourseId: aiCourseId,
      aiClassHourId: aiClassHourId,
      periodId: periodId,
      userClassTimes: [
        {
          classTimeStart: classTimeStart,
          classTimeEnd: classTimeEnd,
          aiClassHourSort: 1,
          id: userClassTimeId,
        },
      ],
    };

    // 7. 提交改约
    const result = await submitReschedule(submitParams);

    return {
      success: true,
      message: result.message,
      detail: {
        studentName: targetClass.studentName || task.userId,
        courseName: targetClass.courseName || '',
        lessonName: targetClass.lessonName || '',
        newTime: `${classTimeStart} ~ ${classTimeEnd}`,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || '未知错误',
    };
  }
}

/**
 * 处理消息请求
 */
async function handleMessage(message) {
  switch (message.action) {
    case 'ping':
      return { success: true, message: 'content script is ready' };

    case 'fetchStudentInfo':
      try {
        const data = await fetchStudentInfo(message.userId);
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err.message };
      }

    case 'fetchClassList':
      try {
        const data = await fetchClassList(message.startDate, message.endDate);
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err.message };
      }

    case 'fetchClassHour':
      try {
        const data = await fetchClassHour(message.userClassTimeId);
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err.message };
      }

    case 'executeTask':
      try {
        const result = await executeSingleTask(message.task);
        return result;
      } catch (err) {
        return { success: false, error: err.message };
      }

    default:
      return { success: false, error: `未知操作: ${message.action}` };
  }
}

/**
 * 方式1：监听来自Background转发的消息（标准Chrome）
 */
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target !== 'content') return false;

    handleMessage(message).then((result) => {
      sendResponse(result);
    });
    return true; // 异步响应
  });
}

/**
 * 方式2：监听来自页面注入代码的 postMessage（千问浏览器兼容）
 * 通过 window.postMessage 通信
 * 
 * 收到 postMessage 后，处理请求，然后通过两种方式回传结果：
 * - window.postMessage（旧方案，注入函数内监听）
 * - chrome.runtime.sendMessage（新方案，由 popup 通过 runtime.onMessage 接收）
 * 双重回传确保兼容性
 */
window.addEventListener('message', async (event) => {
  // 只处理来自同源的消息
  if (event.source !== window) return;

  const message = event.data;
  if (!message || message.source !== 'tiaoke-popup') return;

  console.log('[调课助手] Content Script 收到 postMessage:', message.action, 'requestId:', message.requestId);

  const result = await handleMessage(message);

  // 回传方式1：通过 postMessage 返回结果（旧方案兼容）
  window.postMessage(
    {
      source: 'tiaoke-content',
      requestId: message.requestId,
      result,
    },
    '*'
  );

  // 回传方式2：通过 chrome.runtime.sendMessage 返回结果（新方案，由 popup 的 runtime.onMessage 接收）
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({
        type: 'tiaoke-response',
        requestId: message.requestId,
        result,
      });
    }
  } catch (e) {
    console.warn('[调课助手] runtime.sendMessage 回传失败:', e.message);
  }
});

console.log('[调课助手] Content Script 已加载');
