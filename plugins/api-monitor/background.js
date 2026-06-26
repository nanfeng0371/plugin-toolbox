// ===== API 监听器 - Background Service Worker =====

const MAX_RECORDS = 1000;  // 最多保留 N 条

// 接收 content script 发来的请求
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg.action === 'NEW_REQUEST') {
    saveRequest(msg.data);
    return false;
  }
  if (msg.action === 'GET_REQUESTS') {
    getRequests().then(sendResponse).catch(function () { sendResponse({ requests: [] }); });
    return true;
  }
  if (msg.action === 'CLEAR_REQUESTS') {
    clearRequests().then(function () { sendResponse({ ok: true }); });
    return true;
  }
  if (msg.action === 'EXPORT_JSON') {
    getRequests().then(function (r) { sendResponse(r); }).catch(function () { sendResponse({ requests: [] }); });
    return true;
  }
  // 🆕 DOM 快照
  if (msg.action === 'DOM_SNAPSHOT') {
    saveSnapshot(msg.data);
    return false;
  }
  // 🆕 录制状态
  if (msg.action === 'RECORDING_STATUS') {
    chrome.storage.local.set({ __api_monitor_recording__: msg.data });
    return false;
  }
  // 🆕 录制数据
  if (msg.action === 'RECORDING_DATA') {
    saveRecording(msg.data);
    return false;
  }
  // 🆕 获取诊断报告
  if (msg.action === 'GET_DIAG_REPORT') {
    getDiagReport().then(sendResponse);
    return true;
  }
  // 🆕 清空诊断数据
  if (msg.action === 'CLEAR_DIAG_DATA') {
    clearDiagData().then(function () { sendResponse({ ok: true }); });
    return true;
  }
});

async function saveRequest(req) {
  try {
    const result = await chrome.storage.local.get(['__api_monitor_requests__']);
    let arr = result.__api_monitor_requests__ || [];
    arr.unshift(req);  // 新请求放前面
    if (arr.length > MAX_RECORDS) arr = arr.slice(0, MAX_RECORDS);
    await chrome.storage.local.set({ __api_monitor_requests__: arr });
  } catch (e) {
    console.warn('[API Monitor] save failed:', e.message);
  }
}

async function getRequests() {
  try {
    const result = await chrome.storage.local.get(['__api_monitor_requests__']);
    return { requests: result.__api_monitor_requests__ || [] };
  } catch (e) {
    return { requests: [] };
  }
}

async function clearRequests() {
  await chrome.storage.local.remove(['__api_monitor_requests__']);
}

// ==========================================
// 🆕 DOM 快照存储
// ==========================================
async function saveSnapshot(snapshot) {
  try {
    var result = await chrome.storage.local.get(['__api_monitor_snapshots__']);
    var arr = result.__api_monitor_snapshots__ || [];
    arr.unshift(snapshot);
    if (arr.length > 10) arr = arr.slice(0, 10); // 最多保留10个快照
    await chrome.storage.local.set({ __api_monitor_snapshots__: arr });
  } catch (e) {
    console.warn('[API Monitor] saveSnapshot failed:', e.message);
  }
}

// ==========================================
// 🆕 录制数据存储
// ==========================================
async function saveRecording(recData) {
  try {
    var result = await chrome.storage.local.get(['__api_monitor_recordings__']);
    var arr = result.__api_monitor_recordings__ || [];
    arr.unshift(recData);
    if (arr.length > 5) arr = arr.slice(0, 5); // 最多保留5次录制
    await chrome.storage.local.set({ __api_monitor_recordings__: arr });
  } catch (e) {
    console.warn('[API Monitor] saveRecording failed:', e.message);
  }
}

// ==========================================
// 🆕 诊断报告生成
// ==========================================
async function getDiagReport() {
  try {
    var result = await chrome.storage.local.get([
      '__api_monitor_snapshots__',
      '__api_monitor_recordings__',
      '__api_monitor_requests__'
    ]);
    return {
      snapshots: result.__api_monitor_snapshots__ || [],
      recordings: result.__api_monitor_recordings__ || [],
      requests: result.__api_monitor_requests__ || [],
      exportedAt: new Date().toISOString()
    };
  } catch (e) {
    return { snapshots: [], recordings: [], requests: [], error: e.message };
  }
}

async function clearDiagData() {
  await chrome.storage.local.remove([
    '__api_monitor_snapshots__',
    '__api_monitor_recordings__',
    '__api_monitor_recording__'
  ]);
}
