/**
 * 插件工作箱 - Service Worker
 * 
 * 职责：
 * 1. 管理模块注册表
 * 2. 消息中继（content ↔ module）
 * 3. 模块生命周期管理
 */

// ========== 模块注册表 ==========
const MODULE_REGISTRY = {
  // 学习报告模块
  'report': {
    id: 'report',
    name: '学习报告批量分析',
    icon: '📊',
    description: '批量获取学生听课质量报告，自动生成四维评价分析',
    version: '5.1.1',
    status: 'available',   // available | loading | active | error
    sourcePath: null,       // 实际安装后由 content.js 填充
    enabled: true,
    matchPatterns: ['https://ai-genesis.yuaiweiwu.com/*']
  },
  // 调课助手模块（预留）
  'schedule': {
    id: 'schedule',
    name: '调课助手',
    icon: '📅',
    description: '快速调课、补课安排、课时统计',
    version: '-',
    status: 'coming_soon',
    sourcePath: null,
    enabled: false,
    matchPatterns: []
  },
  // 钉钉提取模块（预留）
  'dingtalk': {
    id: 'dingtalk',
    name: '钉钉数据提取',
    icon: '🔗',
    description: '从钉钉群提取聊天记录和作业数据',
    version: '-',
    status: 'coming_soon',
    sourcePath: null,
    enabled: false,
    matchPatterns: []
  }
};

// ========== 消息中继 ==========
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, moduleId, action } = message || {};

  // 查询模块列表
  if (type === 'GET_MODULE_LIST') {
    sendResponse({ success: true, modules: MODULE_REGISTRY });
    return;
  }

  // 更新模块状态
  if (type === 'MODULE_STATUS_UPDATE') {
    const mod = MODULE_REGISTRY[moduleId];
    if (mod) {
      mod.status = action; // loading | active | error
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: `Module ${moduleId} not found` });
    }
    return;
  }

  // 中继消息到指定 tab 的 content script
  if (type === 'RELAY_TO_CONTENT') {
    const { targetTabId, payload } = message;
    chrome.tabs.sendMessage(targetTabId, { type: 'RELAY_FROM_SW', moduleId, ...payload })
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // async response
  }

  // 存储读写代理
  if (type === 'STORAGE_GET') {
    chrome.storage.local.get(message.keys || [], result => {
      sendResponse({ success: true, data: result });
    });
    return true;
  }

  if (type === 'STORAGE_SET') {
    chrome.storage.local.set(message.data, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  return false;
});

// ========== 扩展安装/更新 ==========
chrome.runtime.onInstalled.addListener((details) => {
  console.log(`[插件工作箱] installed: ${details.reason}`);
  
  if (details.reason === 'install') {
    // 首次安装：初始化默认设置
    chrome.storage.local.set({
      toolbox_version: '1.0.0',
      sidebar_position: 'right',   // right | left
      sidebar_width: 420,
      theme: 'light',              // light | dark
      modules_enabled: ['report'],
      last_active_module: null
    });
  }

  if (details.reason === 'update') {
    console.log(`[插件工作箱] updated to v${chrome.runtime.getManifest().version}`);
  }
});
