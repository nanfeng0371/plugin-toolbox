/**
 * 调课助手 - Popup 逻辑
 * 负责用户交互、数据解析、任务调度、状态管理
 */

// ==========================================
// 状态常量
// ==========================================
const TASK_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCESS: 'success',
  FAIL: 'fail',
};

const STATUS_LABELS = {
  [TASK_STATUS.PENDING]: '⏳待执行',
  [TASK_STATUS.RUNNING]: '🔄执行中',
  [TASK_STATUS.SUCCESS]: '✅成功',
  [TASK_STATUS.FAIL]: '❌失败',
};

const STATUS_CSS = {
  [TASK_STATUS.PENDING]: 'status-pending',
  [TASK_STATUS.RUNNING]: 'status-running',
  [TASK_STATUS.SUCCESS]: 'status-success',
  [TASK_STATUS.FAIL]: 'status-fail',
};

// ==========================================
// 全局状态
// ==========================================
let taskList = [];       // 解析后的调课任务列表
let isRunning = false;   // 是否正在执行
let isPaused = false;    // 是否暂停
let classListCache = null; // 课表列表缓存（一次查询，所有任务共用）

// ==========================================
// DOM 元素引用
// ==========================================
const elConnectionStatus = document.getElementById('connection-status');
const elInputData = document.getElementById('input-data');
const elBtnParse = document.getElementById('btn-parse');
const elPreviewSection = document.getElementById('preview-section');
const elPreviewTbody = document.getElementById('preview-tbody');
const elControlSection = document.getElementById('control-section');
const elBtnStart = document.getElementById('btn-start');
const elBtnPause = document.getElementById('btn-pause');
const elBtnRetry = document.getElementById('btn-retry');
const elStatsSection = document.getElementById('stats-section');
const elProgressBar = document.getElementById('progress-bar');
const elStatTotal = document.getElementById('stat-total');
const elStatSuccess = document.getElementById('stat-success');
const elStatFail = document.getElementById('stat-fail');
const elStatPending = document.getElementById('stat-pending');
const elLogSection = document.getElementById('log-section');
const elLogContainer = document.getElementById('log-container');
const elBtnExport = document.getElementById('btn-export');
const elParseFeedback = document.getElementById('parse-feedback');

// ==========================================
// 工具函数
// ==========================================

/**
 * 显示解析反馈提示
 * @param {string} message - 反馈消息
 * @param {'success'|'error'|'info'} type - 反馈类型
 */
function showParseFeedback(message, type = 'info') {
  elParseFeedback.textContent = message;
  elParseFeedback.className = `parse-feedback feedback-${type}`;
}

function hideParseFeedback() {
  elParseFeedback.className = 'parse-feedback hidden';
}

/**
 * 获取当前时间字符串
 * @returns {string} HH:mm:ss 格式
 */
function getNowTimeStr() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/**
 * 添加日志
 * @param {string} text - 日志内容
 * @param {'info'|'success'|'fail'|'warn'} type - 日志类型
 */
function addLog(text, type = 'info') {
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `<span class="log-time">${getNowTimeStr()}</span><span class="log-${type}">${text}</span>`;
  elLogContainer.appendChild(entry);
  elLogContainer.scrollTop = elLogContainer.scrollHeight;
}

/**
 * 向Content Script发送消息（通过Background中转）
 * @param {object} message - 消息对象
 * @returns {Promise<object>} 响应
 */
function sendToContent(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { ...message, target: 'content' },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      }
    );
  });
}

/**
 * 检查与Content Script的连接状态
 */
async function checkConnection() {
  try {
    const response = await sendToContent({ action: 'ping' });
    if (response && response.success) {
      elConnectionStatus.className = 'status-bar status-connected';
      elConnectionStatus.querySelector('.status-text').textContent = '已连接';
      return true;
    }
  } catch (e) {
    // 连接失败
  }
  elConnectionStatus.className = 'status-bar status-disconnected';
  elConnectionStatus.querySelector('.status-text').textContent = '未连接 - 请在目标网站打开插件';
  return false;
}

// ==========================================
// 数据解析
// ==========================================

/**
 * 标准化日期格式
 * 支持：YYYY-MM-DD、MM-DD、MM/DD、MM月DD日
 * 自动补全年份为当前年
 * @param {string} raw - 原始日期字符串
 * @returns {string|null} YYYY-MM-DD 格式或 null
 */
function normalizeDate(raw) {
  const currentYear = new Date().getFullYear();
  const str = raw.trim();

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str;
  }

  // MM-DD
  const mdDash = str.match(/^(\d{1,2})-(\d{1,2})$/);
  if (mdDash) {
    const m = String(mdDash[1]).padStart(2, '0');
    const d = String(mdDash[2]).padStart(2, '0');
    return `${currentYear}-${m}-${d}`;
  }

  // MM/DD
  const mdSlash = str.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (mdSlash) {
    const m = String(mdSlash[1]).padStart(2, '0');
    const d = String(mdSlash[2]).padStart(2, '0');
    return `${currentYear}-${m}-${d}`;
  }

  // MM月DD日 / MM月DD号
  const mdCN = str.match(/^(\d{1,2})月(\d{1,2})[日号]?$/);
  if (mdCN) {
    const m = String(mdCN[1]).padStart(2, '0');
    const d = String(mdCN[2]).padStart(2, '0');
    return `${currentYear}-${m}-${d}`;
  }

  return null;
}

/**
 * 标准化时间格式
 * 支持：HH:mm、HH:mm:ss、H:mm
 * @param {string} raw - 原始时间字符串
 * @returns {string|null} HH:mm 格式或 null
 */
function normalizeTime(raw) {
  const str = raw.trim();

  // HH:mm
  if (/^\d{2}:\d{2}$/.test(str)) {
    return str;
  }

  // HH:mm:ss
  const hms = str.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (hms) {
    const h = String(hms[1]).padStart(2, '0');
    const m = String(hms[2]).padStart(2, '0');
    return `${h}:${m}`;
  }

  // H:mm
  const hm = str.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const h = String(hm[1]).padStart(2, '0');
    return `${h}:${hm[2]}`;
  }

  return null;
}

/**
 * 解析用户粘贴的文本数据
 * @param {string} text - 用户输入的文本
 * @returns {Array<object>} 解析后的任务列表
 */
function parseInputData(text) {
  const lines = text.trim().split('\n');
  const tasks = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // 跳过表头行（包含中文字符的非数据行）
    if (line.includes('学员') || line.includes('第几讲') || line.includes('日期') || line.includes('时间')) {
      continue;
    }

    // 智能分隔：优先Tab，然后多空格（含全角空格），最后逗号
    let parts = line.split('\t').map(s => s.trim()).filter(s => s);

    if (parts.length < 4) {
      // 全角空格也当作分隔符
      const spaceParts = line.split(/[\s\u3000]+/).map(s => s.trim()).filter(s => s);
      if (spaceParts.length >= 4) {
        parts = spaceParts;
      }
    }

    if (parts.length < 4) {
      const commaParts = line.split(/[,，]/).map(s => s.trim()).filter(s => s);
      if (commaParts.length >= 4) {
        parts = commaParts;
      }
    }

    if (parts.length < 4) {
      addLog(`第${i + 1}行数据格式错误（只有${parts.length}列，需要4列），已跳过`, 'warn');
      continue;
    }

    const userId = parts[0].trim();
    const periodSort = parseInt(parts[1].trim(), 10);
    const rawDate = parts[2].trim();
    const rawTime = parts[3].trim();

    // 验证
    if (!/^\d+$/.test(userId)) {
      addLog(`第${i + 1}行学员ID格式错误，已跳过: ${userId}`, 'warn');
      continue;
    }
    if (isNaN(periodSort) || periodSort < 1) {
      addLog(`第${i + 1}行第几讲格式错误，已跳过: ${parts[1]}`, 'warn');
      continue;
    }

    const newDate = normalizeDate(rawDate);
    if (!newDate) {
      addLog(`第${i + 1}行日期格式错误，已跳过: ${rawDate}（支持格式：05月30日、05-30、05/30、2026-05-30）`, 'warn');
      continue;
    }

    const newTime = normalizeTime(rawTime);
    if (!newTime) {
      addLog(`第${i + 1}行时间格式错误，已跳过: ${rawTime}（支持格式：10:31、10:31:00）`, 'warn');
      continue;
    }

    tasks.push({
      index: tasks.length + 1,
      userId,
      periodSort,
      newDate,
      newTime,
      status: TASK_STATUS.PENDING,
      error: '',
      detail: null,
    });
  }

  return tasks;
}

// ==========================================
// UI 渲染
// ==========================================

/**
 * 渲染预览表格
 */
function renderPreviewTable() {
  elPreviewTbody.innerHTML = '';
  taskList.forEach((task) => {
    const tr = document.createElement('tr');
    tr.id = `task-row-${task.index}`;
    tr.innerHTML = `
      <td>${task.index}</td>
      <td>${task.userId}</td>
      <td>${task.periodSort}</td>
      <td>${task.newDate}</td>
      <td>${task.newTime}</td>
      <td class="${STATUS_CSS[task.status]}">${STATUS_LABELS[task.status]}</td>
    `;
    elPreviewTbody.appendChild(tr);
  });
}

/**
 * 更新单行状态
 * @param {number} index - 任务序号（1-based）
 */
function updateRowStatus(index) {
  const task = taskList.find((t) => t.index === index);
  if (!task) return;
  const row = document.getElementById(`task-row-${index}`);
  if (!row) return;
  const statusCell = row.querySelector('td:last-child');
  statusCell.className = STATUS_CSS[task.status];
  statusCell.textContent = STATUS_LABELS[task.status];
}

/**
 * 更新统计信息
 */
function updateStats() {
  const total = taskList.length;
  const success = taskList.filter((t) => t.status === TASK_STATUS.SUCCESS).length;
  const fail = taskList.filter((t) => t.status === TASK_STATUS.FAIL).length;
  const pending = taskList.filter((t) => t.status === TASK_STATUS.PENDING || t.status === TASK_STATUS.RUNNING).length;
  const done = success + fail;

  elStatTotal.textContent = total;
  elStatSuccess.textContent = success;
  elStatFail.textContent = fail;
  elStatPending.textContent = pending;

  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  elProgressBar.style.width = `${percent}%`;
}

/**
 * 显示/隐藏区域
 */
function showSection(el) {
  el.classList.remove('hidden');
}

function hideSection(el) {
  el.classList.add('hidden');
}

/**
 * 更新按钮状态
 */
function updateControlButtons() {
  if (isRunning && !isPaused) {
    elBtnStart.disabled = true;
    elBtnStart.textContent = '▶ 执行中...';
    elBtnPause.disabled = false;
    elBtnPause.textContent = '⏸ 暂停';
    elBtnRetry.disabled = true;
  } else if (isRunning && isPaused) {
    elBtnStart.disabled = true;
    elBtnStart.textContent = '▶ 执行中...';
    elBtnPause.disabled = false;
    elBtnPause.textContent = '▶ 继续';
    elBtnRetry.disabled = true;
  } else {
    // 未运行
    const hasPending = taskList.some((t) => t.status === TASK_STATUS.PENDING);
    const hasFailed = taskList.some((t) => t.status === TASK_STATUS.FAIL);

    elBtnStart.disabled = !hasPending;
    elBtnStart.textContent = '▶ 开始执行';
    elBtnPause.disabled = true;
    elBtnPause.textContent = '⏸ 暂停';
    elBtnRetry.disabled = !hasFailed;
  }
}

// ==========================================
// 任务执行引擎
// ==========================================

/**
 * 延迟函数
 * @param {number} ms - 延迟毫秒数
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 执行批量任务
 */
async function executeTasks() {
  isRunning = true;
  isPaused = false;
  updateControlButtons();

  // 如果没有缓存的课表数据，先一次性获取并通过storage传递给Content Script
  if (!classListCache) {
    addLog('正在获取课表数据...', 'info');
    try {
      const now = new Date();
      const threeMonthsAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      const threeMonthsLater = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
      const formatDate = (d) => {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day} 00:00:00`;
      };

      const response = await sendToContent({
        action: 'fetchClassList',
        startDate: formatDate(threeMonthsAgo),
        endDate: formatDate(threeMonthsLater),
      });

      if (response && response.success) {
        let rawData = response.data;

        // 如果 rawData 是对象（如 { classList: [...], realStartDate: ... }），尝试提取其中的数组字段
        if (rawData && typeof rawData === 'object' && !Array.isArray(rawData)) {
          const possibleArrayFields = ['classList', 'rows', 'list', 'records', 'data', 'items', 'content'];
          for (const field of possibleArrayFields) {
            if (Array.isArray(rawData[field])) {
              console.log('[调课助手] Popup 从对象字段提取数组:', field, rawData[field].length, '条');
              rawData = rawData[field];
              break;
            }
          }
        }

        classListCache = rawData;

        // 详细的类型检查和日志
        const dataType = typeof classListCache;
        const isArray = Array.isArray(classListCache);
        const count = isArray ? classListCache.length : 0;

        console.log('[调课助手] fetchClassList 返回数据类型:', dataType, '是否数组:', isArray, '长度:', count);

        if (isArray && count > 0) {
          addLog(`课表数据获取成功，共 ${count} 条记录`, 'success');

          // 将课表数据存入chrome.storage.local，供Content Script读取
          try {
            await chrome.storage.local.set({ classListCache: classListCache });
            console.log('[调课助手] classListCache 已写入storage');
          } catch (storageErr) {
            console.warn('[调课助手] 写入storage失败:', storageErr);
            addLog('缓存写入失败（不影响执行，Content Script将自行查询）', 'warn');
          }
        } else if (isArray && count === 0) {
          addLog('课表数据为空（0条记录），请确认日期范围和账号权限', 'fail');
          isRunning = false;
          updateControlButtons();
          return;
        } else {
          // 数据不是数组——这是 classList.find 报错的根因
          addLog(`课表数据格式异常（类型: ${dataType}，值: ${JSON.stringify(classListCache).substring(0, 200)}），请联系开发者`, 'fail');
          console.error('[调课助手] classListCache 不是数组:', classListCache);
          isRunning = false;
          updateControlButtons();
          return;
        }
      } else {
        addLog('课表数据获取失败: ' + ((response && response.error) || '未知错误'), 'fail');
        isRunning = false;
        updateControlButtons();
        return;
      }
    } catch (err) {
      addLog('课表数据获取异常: ' + err.message, 'fail');
      isRunning = false;
      updateControlButtons();
      return;
    }
  } else {
    // 已有缓存，确保storage中也有（带类型检查）
    if (Array.isArray(classListCache) && classListCache.length > 0) {
      try {
        await chrome.storage.local.set({ classListCache: classListCache });
        addLog(`使用缓存课表数据，共 ${classListCache.length} 条记录`, 'info');
      } catch (storageErr) {
        console.warn('[调课助手] 缓存写入storage失败:', storageErr);
        addLog('缓存写入失败（不影响执行，Content Script将自行查询）', 'warn');
      }
    } else {
      // 缓存无效，重新查询
      console.warn('[调课助手] 缓存无效，重新查询');
      classListCache = null;
      // 回退到查询逻辑——重新执行 fetchClassList
      addLog('缓存数据异常，重新查询课表...', 'warn');
      try {
        const now = new Date();
        const threeMonthsAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        const threeMonthsLater = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
        const formatDate = (d) => {
          const y = d.getFullYear();
          const m = String(d.getMonth() + 1).padStart(2, '0');
          const day = String(d.getDate()).padStart(2, '0');
          return `${y}-${m}-${day} 00:00:00`;
        };

        const response = await sendToContent({
          action: 'fetchClassList',
          startDate: formatDate(threeMonthsAgo),
          endDate: formatDate(threeMonthsLater),
        });

        if (response && response.success) {
          let rawData = response.data;
          // 同样做对象嵌套解析
          if (rawData && typeof rawData === 'object' && !Array.isArray(rawData)) {
            const possibleArrayFields = ['classList', 'rows', 'list', 'records', 'data', 'items', 'content'];
            for (const field of possibleArrayFields) {
              if (Array.isArray(rawData[field])) {
                rawData = rawData[field];
                break;
              }
            }
          }
          if (!Array.isArray(rawData)) {
            addLog('课表数据获取失败，无法提取数组', 'fail');
            isRunning = false;
            updateControlButtons();
            return;
          }
          classListCache = rawData;
          await chrome.storage.local.set({ classListCache: classListCache });
          addLog(`课表数据重新获取成功，共 ${classListCache.length} 条记录`, 'success');
        } else {
          addLog('课表数据获取失败，无法继续执行', 'fail');
          isRunning = false;
          updateControlButtons();
          return;
        }
      } catch (err) {
        addLog('课表数据获取异常: ' + err.message, 'fail');
        isRunning = false;
        updateControlButtons();
        return;
      }
    }
  }

  // 找到第一个待执行的任务
  let idx = taskList.findIndex((t) => t.status === TASK_STATUS.PENDING);

  while (idx !== -1 && idx < taskList.length) {
    // 检查暂停
    while (isPaused) {
      await delay(300);
    }

    // 检查是否还在运行（可能被重置）
    if (!isRunning) break;

    const task = taskList[idx];

    // 标记为执行中
    task.status = TASK_STATUS.RUNNING;
    updateRowStatus(task.index);
    updateStats();
    addLog(`开始执行 #${task.index}: 学员${task.userId} 第${task.periodSort}讲 → ${task.newDate} ${task.newTime}`, 'info');

    try {
      const response = await sendToContent({
        action: 'executeTask',
        task: {
          userId: task.userId,
          periodSort: task.periodSort,
          newDate: task.newDate,
          newTime: task.newTime,
        },
      });

      if (response && response.success) {
        task.status = TASK_STATUS.SUCCESS;
        task.detail = response.detail || null;
        const detailInfo = task.detail
          ? ` (${task.detail.studentName || ''} ${task.detail.courseName || ''})`
          : '';
        addLog(`#${task.index} 执行成功${detailInfo}`, 'success');
      } else {
        task.status = TASK_STATUS.FAIL;
        task.error = (response && response.error) || '未知错误';
        addLog(`#${task.index} 执行失败: ${task.error}`, 'fail');
      }
    } catch (err) {
      task.status = TASK_STATUS.FAIL;
      task.error = err.message || '请求异常';
      addLog(`#${task.index} 请求异常: ${task.error}`, 'fail');
    }

    updateRowStatus(task.index);
    updateStats();

    // 找下一个待执行的任务
    idx = taskList.findIndex((t) => t.status === TASK_STATUS.PENDING);

    // 如果还有下一条，等待2秒
    if (idx !== -1) {
      await delay(2000);
    }
  }

  isRunning = false;
  updateControlButtons();
  addLog('批量执行完成', 'info');
}

/**
 * 重试失败的任务
 */
async function retryFailed() {
  // 将失败的任务重置为待执行
  taskList.forEach((task) => {
    if (task.status === TASK_STATUS.FAIL) {
      task.status = TASK_STATUS.PENDING;
      task.error = '';
      updateRowStatus(task.index);
    }
  });
  updateStats();
  addLog('开始重试失败项...', 'warn');
  await executeTasks();
}

// ==========================================
// 导出结果
// ==========================================

/**
 * 导出执行结果为CSV
 */
function exportResults() {
  if (taskList.length === 0) return;

  const headers = ['#', '学员ID', '第几讲', '新日期', '新时间', '状态', '备注'];
  const rows = taskList.map((task) => [
    task.index,
    task.userId,
    task.periodSort,
    task.newDate,
    task.newTime,
    task.status === TASK_STATUS.SUCCESS ? '成功' : task.status === TASK_STATUS.FAIL ? '失败' : '待执行',
    task.error || (task.detail ? `课程: ${task.detail.courseName || ''}` : ''),
  ]);

  const csvContent = [headers, ...rows]
    .map((row) => row.map((cell) => String(cell).replace(/,/g, '，')).join(','))
    .join('\n');

  const BOM = '\uFEFF';
  const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `调课结果_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);

  addLog('结果已导出为CSV文件', 'info');
}

// ==========================================
// 事件绑定
// ==========================================

// textarea 中 Tab 键输入制表符（阻止焦点导航）
elInputData.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    const start = elInputData.selectionStart;
    const end = elInputData.selectionEnd;
    const value = elInputData.value;
    elInputData.value = value.substring(0, start) + '\t' + value.substring(end);
    elInputData.selectionStart = elInputData.selectionEnd = start + 1;
  }
});

// 解析数据按钮
elBtnParse.addEventListener('click', () => {
  const text = elInputData.value.trim();
  if (!text) {
    showParseFeedback('请先粘贴调课数据', 'error');
    return;
  }

  // 重置状态
  isRunning = false;
  isPaused = false;
  classListCache = null;
  elLogContainer.innerHTML = '';
  hideParseFeedback();

  // 先显示日志区域，确保用户能看到反馈
  showSection(elLogSection);

  taskList = parseInputData(text);

  if (taskList.length === 0) {
    showParseFeedback('未解析到有效数据，请检查格式（需Tab分隔4列）', 'error');
    addLog('未解析到有效数据，请检查格式', 'fail');
    addLog('期望格式：学员ID(Tab)第几讲(Tab)新日期(Tab)新时间', 'info');
    addLog('示例：320207→2→2026-06-01→14:00（→代表Tab键）', 'info');
    return;
  }

  showParseFeedback(`成功解析 ${taskList.length} 条调课数据`, 'success');
  addLog(`成功解析 ${taskList.length} 条调课数据`, 'success');
  renderPreviewTable();
  updateStats();
  showSection(elPreviewSection);
  showSection(elControlSection);
  showSection(elStatsSection);
  updateControlButtons();
});

// 开始执行按钮
elBtnStart.addEventListener('click', () => {
  if (isRunning) return;
  executeTasks();
});

// 暂停/继续按钮
elBtnPause.addEventListener('click', () => {
  if (!isRunning) return;
  isPaused = !isPaused;
  if (isPaused) {
    addLog('已暂停执行', 'warn');
  } else {
    addLog('继续执行', 'info');
  }
  updateControlButtons();
});

// 重试失败按钮
elBtnRetry.addEventListener('click', () => {
  if (isRunning) return;
  retryFailed();
});

// 导出结果按钮
elBtnExport.addEventListener('click', () => {
  exportResults();
});

// ==========================================
// 初始化
// ==========================================

document.addEventListener('DOMContentLoaded', () => {
  checkConnection();
});
