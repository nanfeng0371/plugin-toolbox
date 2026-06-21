/**
 * 网络监听器 v1.1 - debugger + webRequest 双管齐下
 * 
 * debugger 抓主页面请求，webRequest 抓所有请求（包括iframe内部）
 * 
 * 用法：
 * 1. 在工作台页面点击插件图标 → 开始监听
 * 2. 在工作台点一个学生的「报告」按钮
 * 3. 等报告弹窗加载完（数据完全出来）
 * 4. 再次点击插件图标 → 停止监听并输出报告
 */

const TARGET_DOMAINS = [
  'aitutor100.com',
  's1.aiv5.cc',
  'aiv5.cc',
  'yuaiweiwu.com',
];

let isMonitoring = false;
let targetTabId = null;
let requests = [];
let requestIdMap = {};

// ===== webRequest 拦截（能抓iframe内的请求！） =====
const WEBREQUEST_URLS = [
  'https://next.aitutor100.com/*',
  'https://*.aitutor100.com/*',
  'https://s1.aiv5.cc/*',
  'https://ai-genesis.yuaiweiwu.com/*',
];

// 监听请求发送前
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!isMonitoring) return;
    
    const record = {
      source: 'webRequest',
      id: details.requestId,
      url: details.url,
      method: details.method,
      type: details.type,  // main_frame, sub_frame, xmlhttprequest, etc.
      tabId: details.tabId,
      requestHeaders: {},
      status: null,
      responseHeaders: {},
      setCookieHeaders: [],
      locationHeader: null,
      timestamp: details.timeStamp,
      wallTime: details.timeStamp / 1000,
    };

    // 提取请求头
    if (details.requestHeaders) {
      for (const h of details.requestHeaders) {
        record.requestHeaders[h.name] = h.value;
      }
    }

    requestIdMap['wr_' + details.requestId] = record;
    requests.push(record);
    
    console.log(`[WR→] ${details.type} ${details.method} ${truncate(details.url, 120)}`);
  },
  { urls: WEBREQUEST_URLS },
  ['requestHeaders']
);

// 监听响应（onHeadersReceived 能看到重定向和Set-Cookie）
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const record = requestIdMap['wr_' + details.requestId];
    if (!record) return;

    record.status = details.statusCode;
    record.statusLine = details.statusLine;

    if (details.responseHeaders) {
      for (const h of details.responseHeaders) {
        record.responseHeaders[h.name] = h.value;
        const lower = h.name.toLowerCase();
        if (lower === 'set-cookie') {
          record.setCookieHeaders.push(h.value);
        }
        if (lower === 'location') {
          record.locationHeader = h.value;
        }
      }
    }

    const redirectMark = details.statusCode >= 300 && details.statusCode < 400 ? ' 🔀重定向' : '';
    const cookieMark = record.setCookieHeaders.length > 0 ? ' 🍪Set-Cookie' : '';
    console.log(`[WR←] ${details.statusCode} ${details.type} ${truncate(details.url, 100)}${redirectMark}${cookieMark}`);
  },
  { urls: WEBREQUEST_URLS },
  ['responseHeaders']
);

console.log('[网络监听器] v1.1 已加载（debugger + webRequest双模式），点击插件图标开始监听');

// ===== 点击图标切换监听 =====
chrome.action.onClicked.addListener(async (tab) => {
  if (isMonitoring) {
    stopMonitoring();
  } else {
    startMonitoring(tab.id);
  }
});

async function startMonitoring(tabId) {
  targetTabId = tabId;
  requests = [];
  requestIdMap = {};

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
    
    isMonitoring = true;
    chrome.action.setBadgeText({ text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
    chrome.action.setTitle({ title: '监听中... 点击停止' });
    
    console.log('[网络监听器] ✅ 已开始监听 tabId=' + tabId);
    console.log('[网络监听器] 现在去工作台点「报告」按钮，等数据出来后再点图标停止');
  } catch (e) {
    console.error('[网络监听器] ❌ 启动失败:', e.message);
  }
}

function stopMonitoring() {
  if (!targetTabId) return;

  chrome.debugger.detach({ tabId: targetTabId }).catch(() => {});
  isMonitoring = false;
  
  chrome.action.setBadgeText({ text: '' });
  chrome.action.setTitle({ title: '开始监听' });

  console.log('[网络监听器] 🛑 监听停止，共捕获 ' + requests.length + ' 条请求');
  generateReport();
}

// ===== debugger 事件处理（保留原逻辑） =====
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!isMonitoring) return;
  if (source.tabId !== targetTabId) return;

  switch (method) {
    case 'Network.requestWillBeSent':
      handleRequestWillBeSent(params);
      break;
    case 'Network.responseReceived':
      handleResponseReceived(params);
      break;
    case 'Network.requestWillBeSentExtraInfo':
      handleRequestExtraInfo(params);
      break;
    case 'Network.responseReceivedExtraInfo':
      handleResponseExtraInfo(params);
      break;
  }
});

function handleRequestWillBeSent(params) {
  const url = params.request.url;
  const req = {
    source: 'debugger',
    id: params.requestId,
    url: url,
    method: params.request.method,
    type: params.type,
    requestHeaders: params.request.headers || {},
    requestHeadersText: params.request.headersText || '',
    initiator: params.initiator ? params.initiator.type : '',
    timestamp: params.timestamp,
    wallTime: params.wallTime,
    redirectResponse: params.redirectResponse ? {
      status: params.redirectResponse.status,
      headers: params.redirectResponse.headers,
    } : null,
    status: null,
    statusText: null,
    responseHeaders: {},
    responseHeadersText: '',
    setCookieHeaders: [],
    locationHeader: null,
  };

  requestIdMap[params.requestId] = req;
  
  if (isTargetUrl(url)) {
    requests.push(req);
    console.log(`[DBG→] ${params.request.method} ${truncate(url, 120)}`);
  }
}

function handleRequestExtraInfo(params) {
  const req = requestIdMap[params.requestId];
  if (!req) return;
  if (params.headers) {
    req.requestHeaders = { ...req.requestHeaders, ...params.headers };
  }
  if (params.headersText) {
    req.requestHeadersText = params.headersText;
  }
}

function handleResponseReceived(params) {
  const req = requestIdMap[params.requestId];
  if (!req) return;
  
  req.status = params.response.status;
  req.statusText = params.response.statusText;
  req.responseHeaders = params.response.headers || {};
  req.mimeType = params.response.mimeType;
  
  if (params.response.headersText) {
    req.responseHeadersText = params.response.headersText;
  }
  
  const headers = params.response.headers || {};
  const lowerHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    lowerHeaders[k.toLowerCase()] = v;
  }
  
  if (lowerHeaders['set-cookie']) {
    req.setCookieHeaders = Array.isArray(lowerHeaders['set-cookie']) 
      ? lowerHeaders['set-cookie'] 
      : [lowerHeaders['set-cookie']];
  }
  if (lowerHeaders['location']) {
    req.locationHeader = lowerHeaders['location'];
  }

  if (isTargetUrl(req.url)) {
    const redirectMark = req.status >= 300 && req.status < 400 ? ' 🔀重定向→' + (req.locationHeader || '') : '';
    const cookieMark = req.setCookieHeaders.length > 0 ? ' 🍪Set-Cookie' : '';
    console.log(`[DBG←] ${req.status} ${truncate(req.url, 100)}${redirectMark}${cookieMark}`);
  }
}

function handleResponseExtraInfo(params) {
  const req = requestIdMap[params.requestId];
  if (!req) return;
  
  if (params.headers) {
    req.responseHeaders = { ...req.responseHeaders, ...params.headers };
    const lowerHeaders = {};
    for (const [k, v] of Object.entries(params.headers)) {
      lowerHeaders[k.toLowerCase()] = v;
    }
    if (lowerHeaders['set-cookie']) {
      const newCookies = Array.isArray(lowerHeaders['set-cookie']) 
        ? lowerHeaders['set-cookie'] 
        : [lowerHeaders['set-cookie']];
      req.setCookieHeaders = [...req.setCookieHeaders, ...newCookies];
    }
    if (lowerHeaders['location']) {
      req.locationHeader = lowerHeaders['location'];
    }
  }
  if (params.headersText) {
    req.responseHeadersText += '\n' + params.headersText;
  }
}

function isTargetUrl(url) {
  return TARGET_DOMAINS.some(d => url.includes(d));
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '...' : str;
}

// ===== 生成报告 =====
function generateReport() {
  console.log('\n' + '═'.repeat(80));
  console.log('📋 网络请求完整报告（debugger + webRequest）');
  console.log('═'.repeat(80));

  if (requests.length === 0) {
    console.log('❌ 没有捕获到任何目标域名的请求');
    return;
  }

  // 去重（webRequest和debugger可能重复捕获同一请求）
  const seen = new Set();
  const uniqueRequests = [];
  for (const r of requests) {
    const key = `${r.method}|${r.url}|${r.wallTime ? Math.floor(r.wallTime * 10) : ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueRequests.push(r);
    }
  }

  // 按时间排序
  uniqueRequests.sort((a, b) => (a.wallTime || 0) - (b.wallTime || 0));

  // 1. 完整时间线
  console.log('\n📅 请求时间线（按时间排序，已去重）：');
  console.log('-'.repeat(80));
  
  for (let i = 0; i < uniqueRequests.length; i++) {
    const r = uniqueRequests[i];
    const num = String(i + 1).padStart(3, ' ');
    const status = r.status ? `${r.status}` : '???';
    const method = r.method || '?';
    const src = r.source === 'webRequest' ? 'WR' : 'DBG';
    const type = r.type ? `(${r.type})` : '';
    const time = r.wallTime ? new Date(r.wallTime * 1000).toLocaleTimeString('zh-CN', {hour12:false, hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3}) : '';
    
    console.log(`${num}. [${time}] [${src}] ${method} ${status} ${type} ${truncate(r.url, 100)}`);
    
    // 重定向
    if (r.locationHeader) {
      console.log(`    🔀 Location: ${truncate(r.locationHeader, 120)}`);
    }
    
    // Set-Cookie
    if (r.setCookieHeaders.length > 0) {
      for (const sc of r.setCookieHeaders) {
        const cookieName = sc.split('=')[0];
        const cookieValue = sc.split(';')[0].slice(cookieName.length + 1);
        const isHttpOnly = sc.toLowerCase().includes('httponly');
        const domain = sc.match(/domain=([^;]+)/i);
        const path = sc.match(/path=([^;]+)/i);
        console.log(`    🍪 Set-Cookie: ${cookieName}=${truncate(cookieValue, 40)}${domain ? ` domain=${domain[1]}` : ''}${path ? ` path=${path[1]}` : ''}${isHttpOnly ? ' [HttpOnly]' : ''}`);
      }
    }

    // 请求中关键头
    const reqH = r.requestHeaders || {};
    const importantReqHeaders = ['cookie', 'authorization', 'authorization-token', 'referer', 'origin', 'source-sn', 'sec-fetch-site', 'sec-fetch-mode'];
    const foundHeaders = importantReqHeaders.filter(h => {
      return Object.keys(reqH).some(k => k.toLowerCase() === h);
    });
    if (foundHeaders.length > 0) {
      for (const h of foundHeaders) {
        const key = Object.keys(reqH).find(k => k.toLowerCase() === h);
        if (key) {
          let val = reqH[key];
          if (h === 'cookie') {
            val = val.split(';').map(c => {
              const name = c.trim().split('=')[0];
              return name;
            }).join(', ');
            console.log(`    📤 ${key}: [${val}]`);
          } else {
            console.log(`    📤 ${key}: ${truncate(val, 80)}`);
          }
        }
      }
    }
  }

  // 2. 🔥 关键API调用（重点关注！）
  const apiRequests = uniqueRequests.filter(r => 
    r.url.includes('queryCoursePeriodReport') || 
    r.url.includes('biz') ||
    r.url.includes('summary')
  );
  if (apiRequests.length > 0) {
    console.log('\n🎯 关键API调用（最关键部分！）：');
    console.log('-'.repeat(80));
    for (const r of apiRequests) {
      const src = r.source === 'webRequest' ? 'WR' : 'DBG';
      console.log(`\n  [${src}] ${r.method} ${r.status} ${truncate(r.url, 120)}`);
      console.log(`  请求头:`);
      for (const [k, v] of Object.entries(r.requestHeaders)) {
        if (k.toLowerCase() === 'cookie') {
          const names = v.split(';').map(c => c.trim().split('=')[0]).join(', ');
          console.log(`    ${k}: [${names}]`);
        } else {
          console.log(`    ${k}: ${truncate(v, 80)}`);
        }
      }
      if (r.status) {
        console.log(`  响应头(Set-Cookie/Location等):`);
        for (const [k, v] of Object.entries(r.responseHeaders)) {
          if (['set-cookie', 'location', 'content-type'].includes(k.toLowerCase())) {
            console.log(`    ${k}: ${truncate(v, 120)}`);
          }
        }
      }
    }
  }

  // 3. Cookie种入记录
  const cookieRequests = uniqueRequests.filter(r => r.setCookieHeaders.length > 0);
  if (cookieRequests.length > 0) {
    console.log('\n🍪 Cookie种入记录：');
    console.log('-'.repeat(80));
    for (const r of cookieRequests) {
      console.log(`  URL: ${truncate(r.url, 100)}`);
      for (const sc of r.setCookieHeaders) {
        console.log(`    ${truncate(sc, 150)}`);
      }
    }
  }

  // 4. 重定向链
  const redirectRequests = uniqueRequests.filter(r => r.locationHeader);
  if (redirectRequests.length > 0) {
    console.log('\n🔀 重定向链：');
    console.log('-'.repeat(80));
    for (const r of redirectRequests) {
      console.log(`  ${r.status} ${truncate(r.url, 80)} → ${truncate(r.locationHeader, 80)}`);
    }
  }

  console.log('\n' + '═'.repeat(80));
  console.log(`📊 总计: ${uniqueRequests.length} 条请求(去重后) | ${redirectRequests.length} 次重定向 | ${cookieRequests.length} 次Cookie种入 | ${apiRequests.length} 个关键API`);
  console.log('═'.repeat(80));
  
  globalThis.__monitorData = uniqueRequests;
  console.log('\n💡 完整数据已保存到 globalThis.__monitorData');
  
  // 特别高亮：queryCoursePeriodReport 是否被捕获
  const reportApi = uniqueRequests.find(r => r.url.includes('queryCoursePeriodReport'));
  if (reportApi) {
    console.log('\n🎉🎉🎉 queryCoursePeriodReport 被成功捕获！方案可行！');
    console.log(`   请求头中的Cookie: ${reportApi.requestHeaders.cookie || reportApi.requestHeaders['Cookie'] || '无'}`);
    console.log(`   Sec-Fetch-Site: ${reportApi.requestHeaders['sec-fetch-site'] || reportApi.requestHeaders['Sec-Fetch-Site'] || '未捕获'}`);
  } else {
    console.log('\n⚠️ queryCoursePeriodReport 未被捕获（可能在iframe内被CORS限制，或debugger未监听到）');
  }
}

// debugger 断开连接时自动停止
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === targetTabId) {
    isMonitoring = false;
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: '开始监听' });
    console.log('[网络监听器] 调试器已断开:', reason);
    if (requests.length > 0) {
      generateReport();
    }
  }
});
