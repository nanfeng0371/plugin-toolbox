/**
 * 调课助手 v2.0 - Popup 逻辑
 * 新增：学员信息簿导入、自然语言解析、姓名/手机号匹配学员ID
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
let studentRoster = [];  // 学员信息簿 [{ name, phone, studentId }]

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
// V2 新增 DOM
const elRosterFile = document.getElementById('roster-file');
const elBtnLoadRoster = document.getElementById('btn-load-roster');
const elBtnClearRoster = document.getElementById('btn-clear-roster');
const elRosterStatus = document.getElementById('roster-status');

// ==========================================
// 工具函数
// ==========================================

function showParseFeedback(message, type = 'info') {
  elParseFeedback.textContent = message;
  elParseFeedback.className = `parse-feedback feedback-${type}`;
}

function hideParseFeedback() {
  elParseFeedback.className = 'parse-feedback hidden';
}

function getNowTimeStr() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function addLog(text, type = 'info') {
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `<span class="log-time">${getNowTimeStr()}</span><span class="log-${type}">${text}</span>`;
  elLogContainer.appendChild(entry);
  elLogContainer.scrollTop = elLogContainer.scrollHeight;
}

/**
 * 向Content Script发送消息
 * 
 * 通信方案 V3（三重保障）：
 * 
 * 方案A（首选）：chrome.tabs.sendMessage（标准Chrome扩展通信）
 *   popup → chrome.tabs.sendMessage → content script 的 chrome.runtime.onMessage
 *   这是最标准的方案，V1就在用，在标准Chrome中可靠
 * 
 * 方案B（备选）：chrome.scripting.executeScript + postMessage + chrome.runtime.sendMessage 回传
 *   popup → executeScript注入函数 → window.postMessage → content script
 *   content script → chrome.runtime.sendMessage → service worker → popup
 *   用于方案A不工作的情况（千问浏览器可能的兼容问题）
 * 
 * 方案C（终极兜底）：executeScript注入完整逻辑
 *   不依赖content script，直接注入函数在页面上下文执行fetch请求
 *   最可靠但最不优雅
 * 
 * 当前实现：方案A + 方案B自动降级
 */

/**
 * 获取当前活动标签页（目标网站）
 * @returns {Promise<{tabId: number, url: string}|null>}
 */
async function getActiveTab() {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime.lastError) {
          console.error('[调课助手] getActiveTab 查询失败:', chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        if (!tabs || tabs.length === 0) {
          console.warn('[调课助手] getActiveTab: 没有找到活动标签页');
          resolve(null);
          return;
        }
        const tab = tabs[0];
        console.log('[调课助手] getActiveTab: 找到标签页', tab.id, tab.url);
        if (!tab.id) {
          console.warn('[调课助手] getActiveTab: 标签页没有id');
          resolve(null);
          return;
        }
        if (!tab.url || !tab.url.includes('ai-genesis.yuaiweiwu.com')) {
          console.warn('[调课助手] getActiveTab: 标签页URL不匹配目标网站:', tab.url);
          resolve(null);
          return;
        }
        resolve({ tabId: tab.id, url: tab.url });
      });
    } catch (e) {
      console.error('[调课助手] getActiveTab 异常:', e);
      resolve(null);
    }
  });
}

// ==========================================
// 方案A：chrome.tabs.sendMessage（标准通信）
// ==========================================

function sendViaTabsMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    const msg = { target: 'content', ...message };
    const timeout = setTimeout(() => {
      reject(new Error('tabs.sendMessage 超时'));
    }, 3000); // 方案A超时3秒，快速降级到方案B

    try {
      chrome.tabs.sendMessage(tabId, msg, (response) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          console.warn('[调课助手] 方案A tabs.sendMessage 失败:', chrome.runtime.lastError.message);
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        console.log('[调课助手] 方案A 响应:', response);
        resolve(response);
      });
    } catch (e) {
      clearTimeout(timeout);
      reject(e);
    }
  });
}

// ==========================================
// 方案B：executeScript + postMessage + chrome.runtime.sendMessage 回传
// ==========================================

function sendViaExecuteScript(tabId, message) {
  return new Promise((resolve, reject) => {
    const requestId = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const msg = {
      source: 'tiaoke-popup',
      requestId: requestId,
      ...message,
    };

    // 先注册一次性 onMessage 监听器来接收 content script 的回复
    const responseHandler = (responseMsg, sender, sendResponse) => {
      if (responseMsg && responseMsg.type === 'tiaoke-response' && responseMsg.requestId === requestId) {
        chrome.runtime.onMessage.removeListener(responseHandler);
        console.log('[调课助手] 方案B 通过 runtime.onMessage 收到响应:', responseMsg.result);
        resolve(responseMsg.result);
        sendResponse({ received: true });
      }
      return false;
    };
    chrome.runtime.onMessage.addListener(responseHandler);

    // 超时保护
    const timeout = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(responseHandler);
      reject(new Error('方案B executeScript 响应超时'));
    }, 10000);

    // 注入函数，发送 postMessage 给 content script
    const msgJson = JSON.stringify(msg);
    console.log('[调课助手] 方案B 注入脚本, requestId:', requestId);

    chrome.scripting.executeScript(
      {
        target: { tabId: tabId },
        func: (jsonStr) => {
          const msg = JSON.parse(jsonStr);
          console.log('[调课助手-注入] 发送 postMessage, requestId:', msg.requestId);
          window.postMessage(msg, '*');
        },
        args: [msgJson],
      },
      (results) => {
        if (chrome.runtime.lastError) {
          clearTimeout(timeout);
          chrome.runtime.onMessage.removeListener(responseHandler);
          console.error('[调课助手] 方案B executeScript 错误:', chrome.runtime.lastError.message);
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        // 注入成功，现在等待 content script 通过 chrome.runtime.sendMessage 回传结果
        console.log('[调课助手] 方案B 脚本注入成功，等待响应...');
      }
    );
  });
}

// ==========================================
// 统一发送接口：方案A优先，失败自动降级到方案B
// ==========================================

function sendToContent(message) {
  return new Promise(async (resolve, reject) => {
    try {
      // 1. 获取目标标签页
      const tab = await getActiveTab();
      if (!tab) {
        reject(new Error('未找到目标网站标签页，请在 ai-genesis.yuaiweiwu.com 页面上使用'));
        return;
      }

      console.log('[调课助手] sendToContent: 目标标签页', tab.tabId, 'action:', message.action);

      // 2. 先尝试方案A（标准通信）
      try {
        const response = await sendViaTabsMessage(tab.tabId, message);
        if (response && (response.success !== undefined || response.error !== undefined)) {
          console.log('[调课助手] 方案A成功');
          resolve(response);
          return;
        }
        // 响应格式不对，降级
        console.warn('[调课助手] 方案A响应格式异常，降级到方案B');
      } catch (e) {
        console.warn('[调课助手] 方案A失败，降级到方案B:', e.message);
      }

      // 3. 方案B（executeScript + postMessage + runtime.sendMessage 回传）
      try {
        const response = await sendViaExecuteScript(tab.tabId, message);
        console.log('[调课助手] 方案B成功');
        resolve(response);
      } catch (e) {
        console.error('[调课助手] 方案B也失败:', e.message);
        reject(new Error('无法与页面通信，请刷新目标网站页面后重试'));
      }
    } catch (e) {
      console.error('[调课助手] sendToContent 异常:', e);
      reject(e);
    }
  });
}

async function checkConnection() {
  try {
    console.log('[调课助手] checkConnection: 开始检测连接...');
    const response = await sendToContent({ action: 'ping' });
    console.log('[调课助手] checkConnection: 收到响应', response);
    if (response && response.success) {
      elConnectionStatus.className = 'status-bar status-connected';
      elConnectionStatus.querySelector('.status-text').textContent = '已连接';
      return true;
    }
  } catch (e) {
    console.error('[调课助手] checkConnection 失败:', e.message);
  }
  elConnectionStatus.className = 'status-bar status-disconnected';
  elConnectionStatus.querySelector('.status-text').textContent = '未连接 - 请在目标网站打开插件';
  return false;
}

function showSection(el) { el.classList.remove('hidden'); }
function hideSection(el) { el.classList.add('hidden'); }

// ==========================================
// V2: 学员信息簿
// ==========================================

/**
 * 更新学员信息簿状态显示
 */
function updateRosterStatus() {
  if (studentRoster.length > 0) {
    elRosterStatus.textContent = `已加载: ${studentRoster.length} 名学员`;
    elRosterStatus.className = 'roster-status roster-loaded';
    showSection(elBtnClearRoster);
  } else {
    elRosterStatus.textContent = '未加载';
    elRosterStatus.className = 'roster-status roster-empty';
    hideSection(elBtnClearRoster);
  }
}

/**
 * 从 chrome.storage.local 加载缓存的学员信息簿
 */
async function loadRosterFromStorage() {
  try {
    const result = await chrome.storage.local.get('studentRoster');
    if (Array.isArray(result.studentRoster) && result.studentRoster.length > 0) {
      studentRoster = result.studentRoster;
      updateRosterStatus();
      console.log('[调课助手] 从缓存加载学员信息簿:', studentRoster.length, '名');
    }
  } catch (e) {
    console.warn('[调课助手] 加载学员信息簿缓存失败', e);
  }
}

/**
 * 读取 Excel 文件并解析学员信息
 * @param {File} file - 用户选择的 Excel 文件
 */
function loadRosterFromFile(file) {
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      // 读取第一个 sheet
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      // 转为 JSON 数组（跳过空行）
      const rows = XLSX.utils.sheet_to_json(worksheet, { defval: '' });

      if (rows.length === 0) {
        showParseFeedback('Excel文件为空或格式不正确', 'error');
        return;
      }

      // 尝试智能匹配表头字段
      const sample = rows[0];
      const keys = Object.keys(sample);

      // 找姓名列（优先 name/姓名/学生姓名/学员姓名）
      const nameKey = keys.find(k =>
        /^(name|姓名|学生姓名|学员姓名)$/i.test(k.trim())
      ) || keys[0];

      // 找手机号列（优先 phone/手机/手机号/联系电话）
      const phoneKey = keys.find(k =>
        /^(phone|手机|手机号|联系电话|电话)$/i.test(k.trim())
      ) || keys[1];

      // 找学员ID列（优先 studentId/学员ID/id）
      const idKey = keys.find(k =>
        /^(studentId|学员ID|学员id|student_id|id)$/i.test(k.trim())
      ) || keys[2];

      const roster = [];
      let skipped = 0;

      for (const row of rows) {
        const name = String(row[nameKey] || '').trim();
        const phone = String(row[phoneKey] || '').trim();
        const studentId = String(row[idKey] || '').trim();

        // 学员ID必须为数字
        if (!studentId || !/^\d+$/.test(studentId)) {
          skipped++;
          continue;
        }

        roster.push({ name, phone, studentId });
      }

      if (roster.length === 0) {
        showParseFeedback(`未解析到有效学员数据（共 ${rows.length} 行，全部跳过）。请确认Excel有"学员ID"列`, 'error');
        return;
      }

      studentRoster = roster;

      // 缓存到 storage
      chrome.storage.local.set({ studentRoster: roster }).catch(() => {});
      updateRosterStatus();

      let msg = `学员信息簿加载成功，共 ${roster.length} 名学员`;
      if (skipped > 0) msg += `（跳过 ${skipped} 行无效数据）`;
      showParseFeedback(msg, 'success');
      addLog(msg, 'success');

      console.log('[调课助手] 学员信息簿已加载:', roster.length, '名', '表头映射:', { nameKey, phoneKey, idKey });
    } catch (err) {
      showParseFeedback('Excel解析失败: ' + err.message, 'error');
      console.error('[调课助手] Excel解析失败', err);
    }
  };
  reader.readAsArrayBuffer(file);
}

/**
 * 清除学员信息簿
 */
async function clearRoster() {
  studentRoster = [];
  try {
    await chrome.storage.local.remove('studentRoster');
  } catch (e) {}
  updateRosterStatus();
  showParseFeedback('学员信息簿已清除', 'info');
  addLog('学员信息簿已清除', 'warn');
}

// ==========================================
// V2: 自然语言解析
// ==========================================

/**
 * 从自然语言文本中提取时间
 * 支持：早上10点, 下午2点半, 晚上7点, 10:30, 10点半, 上午8:00
 * @param {string} text - 原始文本
 * @returns {string|null} HH:mm 格式或 null
 */
function parseNaturalTime(text) {
  // 先尝试标准时间格式 HH:mm 或 HH:mm:ss
  const stdTime = text.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (stdTime) {
    const h = String(stdTime[1]).padStart(2, '0');
    const m = String(stdTime[2]).padStart(2, '0');
    return `${h}:${m}`;
  }

  // 中文时间：X点(半)
  const pointMatch = text.match(/(\d{1,2})点半/);
  if (pointMatch) {
    const h = parseInt(pointMatch[1], 10);
    return `${String(h).padStart(2, '0')}:30`;
  }

  const hourMatch = text.match(/(\d{1,2})点/);
  if (hourMatch) {
    let h = parseInt(hourMatch[1], 10);
    // 根据时段词调整小时
    if (/下午|晚上|午后|晚间/.test(text)) {
      if (h < 12) h += 12;
    } else if (/凌晨|半夜/.test(text)) {
      if (h === 12) h = 0;
      else if (h > 12) h -= 12;
    }
    // 早上/上午 不需要调整
    return `${String(h).padStart(2, '0')}:00`;
  }

  return null;
}

/**
 * 从自然语言文本中提取日期片段（用于 normalizeDate 的增强输入）
 * 如 "5月2日" / "5月2号" / "5-2" / "2026-06-01"
 * @param {string} text - 原始文本
 * @returns {string|null} 提取出的日期字符串片段
 */
function extractDateFromText(text) {
  // 先找 "调到/改到/约到" 之后的日期
  const afterKeyword = text.match(/(?:调到|改到|约到|移到|调至|改至)\s*(.+)/);
  const segment = afterKeyword ? afterKeyword[1] : text;

  // X月X日/号（可能带空格，如 "5月 2号"）
  const mdCN = segment.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
  if (mdCN) {
    return `${mdCN[1]}月${mdCN[2]}号`;
  }

  // X月X（省略"日/号"）
  const mdCNShort = segment.match(/(\d{1,2})\s*月\s*(\d{1,2})(?![日号])/);
  if (mdCNShort) {
    return `${mdCNShort[1]}月${mdCNShort[2]}号`;
  }

  // YYYY-MM-DD
  const ymd = segment.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (ymd) {
    return ymd[0];
  }

  // MM-DD
  const mdDash = segment.match(/(\d{1,2})-(\d{1,2})/);
  if (mdDash) {
    return mdDash[0];
  }

  // MM/DD
  const mdSlash = segment.match(/(\d{1,2})\/(\d{1,2})/);
  if (mdSlash) {
    return mdSlash[0];
  }

  return null;
}

/**
 * 解析自然语言调课指令
 * 如 "王一，第5讲，调到5月2日早上10点上课"
 * @param {string} text - 自然语言文本
 * @returns {object|null} { rawName, rawPhone, periodSort, newDate, newTime } 或 null
 */
function parseNaturalLanguage(text) {
  // 提取第几讲
  const lessonMatch = text.match(/第\s*(\d+)\s*讲/);
  if (!lessonMatch) return null;
  const periodSort = parseInt(lessonMatch[1], 10);
  if (periodSort < 1) return null;

  // 提取手机号（11位）
  const phoneMatch = text.match(/1[3-9]\d{9}/);
  const rawPhone = phoneMatch ? phoneMatch[0] : '';

  // 提取姓名：第一个2-4字中文词（排除"第X讲"、时间词等）
  // 先移除"第X讲"和时间相关的词
  const cleaned = text
    .replace(/第\s*\d+\s*讲/, '')
    .replace(/调到|改到|约到|移到|调至|改至|上课|下课/g, '')
    .replace(/\d{1,2}\s*月\s*\d{1,2}\s*[日号]?/g, '')
    .replace(/\d{1,2}[点时]/g, '')
    .replace(/\d{1,2}点半/g, '')
    .replace(/\d{1,2}:\d{2}/g, '')
    .replace(/早上|上午|下午|晚上|凌晨|上午|中午|午后|晚间/g, '')
    .replace(/[,，、\s]/g, '');

  const nameMatch = cleaned.match(/[\u4e00-\u9fa5]{2,4}/);
  const rawName = nameMatch ? nameMatch[0] : '';

  // 如果既没有姓名也没有手机号，无法匹配学员
  if (!rawName && !rawPhone) return null;

  // 提取日期
  const dateStr = extractDateFromText(text);
  if (!dateStr) return null;
  const newDate = normalizeDate(dateStr);
  if (!newDate) return null;

  // 提取时间
  const newTime = parseNaturalTime(text);
  if (!newTime) return null;

  return { rawName, rawPhone, periodSort, newDate, newTime };
}

// ==========================================
// V2: 学员匹配
// ==========================================

/**
 * 通过姓名或手机号匹配学员ID
 * @param {string} rawName - 输入的姓名
 * @param {string} rawPhone - 输入的手机号
 * @returns {{ studentId: string, matchedName: string }|null} 匹配结果
 */
function matchStudent(rawName, rawPhone) {
  if (studentRoster.length === 0) return null;

  // 1. 如果有手机号，按手机号精确匹配
  if (rawPhone) {
    const phoneMatch = studentRoster.filter(s => s.phone === rawPhone);
    if (phoneMatch.length === 1) {
      return { studentId: phoneMatch[0].studentId, matchedName: phoneMatch[0].name };
    }
    // 手机号唯一 + 有姓名辅助确认
    if (phoneMatch.length > 1 && rawName) {
      const namePhone = phoneMatch.filter(s => s.name === rawName);
      if (namePhone.length === 1) {
        return { studentId: namePhone[0].studentId, matchedName: namePhone[0].name };
      }
    }
  }

  // 2. 按姓名精确匹配
  if (rawName) {
    const nameMatches = studentRoster.filter(s => s.name === rawName);

    if (nameMatches.length === 1) {
      return { studentId: nameMatches[0].studentId, matchedName: nameMatches[0].name };
    }

    // 多个同名 + 有手机号辅助
    if (nameMatches.length > 1 && rawPhone) {
      const namePhone = nameMatches.filter(s => s.phone === rawPhone);
      if (namePhone.length === 1) {
        return { studentId: namePhone[0].studentId, matchedName: namePhone[0].name };
      }
      if (namePhone.length === 0) {
        return { error: `姓名"${rawName}"有 ${nameMatches.length} 个匹配，但手机号 ${rawPhone} 不匹配其中任何一个` };
      }
      // namePhone.length > 1 不太可能，但防一下
      return { error: `姓名"${rawName}" + 手机号 ${rawPhone} 仍有多个匹配，请直接用学员ID` };
    }

    // 多个同名 + 无手机号
    if (nameMatches.length > 1) {
      const phones = nameMatches.map(s => `${s.name}(${s.phone})`).join('、');
      return { error: `姓名"${rawName}"有 ${nameMatches.length} 个匹配: ${phones}。请附加手机号或直接用学员ID` };
    }

    // 3. 模糊匹配（姓名包含）
    const fuzzyMatches = studentRoster.filter(s => s.name.includes(rawName) || rawName.includes(s.name));
    if (fuzzyMatches.length === 1) {
      return { studentId: fuzzyMatches[0].studentId, matchedName: fuzzyMatches[0].name };
    }
    if (fuzzyMatches.length > 1) {
      return { error: `姓名"${rawName}"模糊匹配到多个学员，请更精确地输入姓名或直接用学员ID` };
    }
  }

  return { error: `未找到学员"${rawName || rawPhone}"，请检查姓名或手机号是否正确` };
}

// ==========================================
// 数据解析（V1 + V2 混合）
// ==========================================

/**
 * 标准化日期格式
 * 支持：YYYY-MM-DD、MM-DD、MM/DD、MM月DD日/号
 * 自动补全年份为当前年
 */
function normalizeDate(raw) {
  const currentYear = new Date().getFullYear();
  const str = raw.trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str;
  }

  const mdDash = str.match(/^(\d{1,2})-(\d{1,2})$/);
  if (mdDash) {
    return `${currentYear}-${String(mdDash[1]).padStart(2, '0')}-${String(mdDash[2]).padStart(2, '0')}`;
  }

  const mdSlash = str.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (mdSlash) {
    return `${currentYear}-${String(mdSlash[1]).padStart(2, '0')}-${String(mdSlash[2]).padStart(2, '0')}`;
  }

  // MM月DD日 / MM月DD号
  const mdCN = str.match(/^(\d{1,2})月(\d{1,2})[日号]?$/);
  if (mdCN) {
    return `${currentYear}-${String(mdCN[1]).padStart(2, '0')}-${String(mdCN[2]).padStart(2, '0')}`;
  }

  return null;
}

/**
 * 标准化时间格式
 * 支持：HH:mm、HH:mm:ss、H:mm
 */
function normalizeTime(raw) {
  const str = raw.trim();

  if (/^\d{2}:\d{2}$/.test(str)) return str;

  const hms = str.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (hms) {
    return `${String(hms[1]).padStart(2, '0')}:${String(hms[2]).padStart(2, '0')}`;
  }

  const hm = str.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    return `${String(hm[1]).padStart(2, '0')}:${hm[2]}`;
  }

  return null;
}

/**
 * 解析用户粘贴的文本数据（支持结构化 + 自然语言混合输入）
 * @param {string} text - 用户输入的文本
 * @returns {Array<object>} 解析后的任务列表
 */
function parseInputData(text) {
  const lines = text.trim().split('\n');
  const tasks = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // 跳过表头行
    if (line.includes('学员') || line.includes('第几讲') || line.includes('日期') || line.includes('时间')) {
      continue;
    }

    let task = null;

    // ========== 尝试1：结构化解析（Tab/空格/逗号分隔）==========
    let parts = line.split('\t').map(s => s.trim()).filter(s => s);

    if (parts.length < 4) {
      const spaceParts = line.split(/[\s\u3000]+/).map(s => s.trim()).filter(s => s);
      if (spaceParts.length >= 4) parts = spaceParts;
    }

    if (parts.length < 4) {
      const commaParts = line.split(/[,，]/).map(s => s.trim()).filter(s => s);
      if (commaParts.length >= 4) parts = commaParts;
    }

    if (parts.length >= 4) {
      const col1 = parts[0].trim();
      const periodSort = parseInt(parts[1].trim(), 10);
      const rawDate = parts[2].trim();
      const rawTime = parts[3].trim();

      const newDate = normalizeDate(rawDate);
      const newTime = rawTime.includes('点') ? parseNaturalTime(rawTime) : normalizeTime(rawTime);

      if (!isNaN(periodSort) && periodSort >= 1 && newDate && newTime) {
        // col1 可能是学员ID（纯数字）或姓名
        if (/^\d+$/.test(col1)) {
          // 纯数字ID，直接用（V1 兼容）
          task = { userId: col1, periodSort, newDate, newTime };
        } else if (studentRoster.length > 0) {
          // 非数字，尝试通过学员信息簿匹配
          const matched = matchStudent(col1, '');
          if (matched && matched.studentId) {
            task = { userId: matched.studentId, periodSort, newDate, newTime, matchedName: matched.matchedName };
          } else {
            addLog(`第${i + 1}行: ${matched ? matched.error : '未找到学员"' + col1 + '"'}，已跳过`, 'warn');
            continue;
          }
        } else {
          addLog(`第${i + 1}行: "${col1}"不是有效学员ID，且未加载学员信息簿，已跳过`, 'warn');
          continue;
        }
      }
    }

    // ========== 尝试2：自然语言解析 ==========
    if (!task) {
      const nl = parseNaturalLanguage(line);
      if (nl) {
        if (/^\d+$/.test(nl.rawName || nl.rawPhone)) {
          // 输入的是学员ID
          task = { userId: (nl.rawName || nl.rawPhone), periodSort: nl.periodSort, newDate: nl.newDate, newTime: nl.newTime };
        } else if (studentRoster.length > 0) {
          const matched = matchStudent(nl.rawName, nl.rawPhone);
          if (matched && matched.studentId) {
            task = { userId: matched.studentId, periodSort: nl.periodSort, newDate: nl.newDate, newTime: nl.newTime, matchedName: matched.matchedName };
          } else {
            addLog(`第${i + 1}行: ${matched ? matched.error : '未找到学员"' + (nl.rawName || nl.rawPhone) + '"'}，已跳过`, 'warn');
            continue;
          }
        } else {
          addLog(`第${i + 1}行: 自然语言解析成功但未加载学员信息簿，无法匹配学员"${nl.rawName || nl.rawPhone}"`, 'warn');
          continue;
        }
      }
    }

    // ========== 如果都没解析成功 ==========
    if (!task) {
      addLog(`第${i + 1}行无法解析，已跳过: ${line.substring(0, 50)}`, 'warn');
      continue;
    }

    tasks.push({
      index: tasks.length + 1,
      userId: task.userId,
      periodSort: task.periodSort,
      newDate: task.newDate,
      newTime: task.newTime,
      matchedName: task.matchedName || '',
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

function renderPreviewTable() {
  elPreviewTbody.innerHTML = '';
  taskList.forEach((task) => {
    const tr = document.createElement('tr');
    tr.id = `task-row-${task.index}`;
    const displayId = task.matchedName ? `${task.userId} (${task.matchedName})` : task.userId;
    tr.innerHTML = `
      <td>${task.index}</td>
      <td>${displayId}</td>
      <td>${task.periodSort}</td>
      <td>${task.newDate}</td>
      <td>${task.newTime}</td>
      <td class="${STATUS_CSS[task.status]}">${STATUS_LABELS[task.status]}</td>
    `;
    elPreviewTbody.appendChild(tr);
  });
}

function updateRowStatus(index) {
  const task = taskList.find((t) => t.index === index);
  if (!task) return;
  const row = document.getElementById(`task-row-${index}`);
  if (!row) return;
  const statusCell = row.querySelector('td:last-child');
  statusCell.className = STATUS_CSS[task.status];
  statusCell.textContent = STATUS_LABELS[task.status];
}

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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 获取日期范围字符串
 */
function getDateRangeStrings() {
  const now = new Date();
  const threeMonthsAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const threeMonthsLater = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  const fmt = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day} 00:00:00`;
  };
  return { startDate: fmt(threeMonthsAgo), endDate: fmt(threeMonthsLater) };
}

/**
 * 从 fetchClassList 响应中提取数组数据
 */
function extractClassListArray(rawData) {
  if (Array.isArray(rawData)) return rawData;
  if (rawData && typeof rawData === 'object') {
    const fields = ['classList', 'rows', 'list', 'records', 'data', 'items', 'content'];
    for (const field of fields) {
      if (Array.isArray(rawData[field])) {
        console.log('[调课助手] 从对象字段提取数组:', field, rawData[field].length, '条');
        return rawData[field];
      }
    }
  }
  return null;
}

/**
 * 执行批量任务
 */
async function executeTasks() {
  isRunning = true;
  isPaused = false;
  updateControlButtons();

  // 获取课表数据
  if (!classListCache || !Array.isArray(classListCache) || classListCache.length === 0) {
    addLog('正在获取课表数据...', 'info');
    try {
      const { startDate, endDate } = getDateRangeStrings();
      const response = await sendToContent({
        action: 'fetchClassList',
        startDate,
        endDate,
      });

      if (response && response.success) {
        classListCache = extractClassListArray(response.data);

        if (Array.isArray(classListCache) && classListCache.length > 0) {
          addLog(`课表数据获取成功，共 ${classListCache.length} 条记录`, 'success');
          try {
            await chrome.storage.local.set({ classListCache: classListCache });
          } catch (storageErr) {
            console.warn('[调课助手] 写入storage失败:', storageErr);
          }
        } else {
          addLog('课表数据为空或格式异常，请确认日期范围和账号权限', 'fail');
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
    addLog(`使用缓存课表数据，共 ${classListCache.length} 条记录`, 'info');
    try {
      await chrome.storage.local.set({ classListCache: classListCache });
    } catch (storageErr) {
      console.warn('[调课助手] 缓存写入storage失败:', storageErr);
    }
  }

  // 执行任务循环
  let idx = taskList.findIndex((t) => t.status === TASK_STATUS.PENDING);

  while (idx !== -1 && idx < taskList.length) {
    while (isPaused) {
      await delay(300);
    }
    if (!isRunning) break;

    const task = taskList[idx];
    task.status = TASK_STATUS.RUNNING;
    updateRowStatus(task.index);
    updateStats();

    const displayName = task.matchedName ? `${task.matchedName}(${task.userId})` : task.userId;
    addLog(`开始执行 #${task.index}: 学员${displayName} 第${task.periodSort}讲 → ${task.newDate} ${task.newTime}`, 'info');

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

    idx = taskList.findIndex((t) => t.status === TASK_STATUS.PENDING);
    if (idx !== -1) {
      await delay(2000);
    }
  }

  isRunning = false;
  updateControlButtons();
  addLog('批量执行完成', 'info');
}

async function retryFailed() {
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

function exportResults() {
  if (taskList.length === 0) return;

  const headers = ['#', '学员ID', '姓名', '第几讲', '新日期', '新时间', '状态', '备注'];
  const rows = taskList.map((task) => [
    task.index,
    task.userId,
    task.matchedName || '',
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

// textarea 中 Tab 键输入制表符
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

// 选择Excel文件按钮
elBtnLoadRoster.addEventListener('click', () => {
  elRosterFile.click();
});

elRosterFile.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) {
    loadRosterFromFile(file);
    // 清空文件值，允许重复选择同一文件
    elRosterFile.value = '';
  }
});

// 清除学员信息簿
elBtnClearRoster.addEventListener('click', () => {
  clearRoster();
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

  showSection(elLogSection);

  taskList = parseInputData(text);

  if (taskList.length === 0) {
    showParseFeedback('未解析到有效数据，请检查格式', 'error');
    addLog('未解析到有效数据，请检查格式', 'fail');
    addLog('结构化：学员ID/姓名 | 第几讲 | 日期 | 时间', 'info');
    addLog('自然语言：王一，第5讲，调到5月2日早上10点上课', 'info');
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

// 开始执行
elBtnStart.addEventListener('click', () => {
  if (isRunning) return;
  executeTasks();
});

// 暂停/继续
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

// 重试失败
elBtnRetry.addEventListener('click', () => {
  if (isRunning) return;
  retryFailed();
});

// 导出结果
elBtnExport.addEventListener('click', () => {
  exportResults();
});

// ==========================================
// 初始化
// ==========================================

document.addEventListener('DOMContentLoaded', async () => {
  // 先尝试唤醒 service worker，再检查连接
  await checkConnection();
  loadRosterFromStorage();
});
