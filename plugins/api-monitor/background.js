// ===== API 监听器 - Background Service Worker =====

const MAX_RECORDS = 1000;  // 最多保留 N 条

// 接收 content script 发来的请求
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg.action === 'NEW_REQUEST') {
    saveRequest(msg.data);
    return false;
  }
  if (msg.action === 'GET_REQUESTS') {
    getRequests().then(sendResponse).catch(() => sendResponse({ requests: [] }));
    return true;
  }
  if (msg.action === 'CLEAR_REQUESTS') {
    clearRequests().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.action === 'EXPORT_JSON') {
    getRequests().then(function (r) { sendResponse(r); }).catch(() => sendResponse({ requests: [] }));
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
