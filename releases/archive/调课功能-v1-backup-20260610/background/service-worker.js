/**
 * 调课助手 - Background Service Worker
 * 负责在Popup和Content Script之间转发消息
 */

// 监听来自Popup的消息，转发到Content Script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === 'content') {
    // Popup -> Content Script: 查找当前活动标签页并转发
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length === 0 || !tabs[0].id) {
        sendResponse({ success: false, error: '未找到活动标签页，请确保在目标网站上操作' });
        return;
      }

      const tabId = tabs[0].id;

      // 检查URL是否匹配目标域名
      const tabUrl = tabs[0].url || '';
      if (!tabUrl.includes('ai-genesis.yuaiweiwu.com')) {
        sendResponse({ success: false, error: '请在 ai-genesis.yuaiweiwu.com 网站上使用此插件' });
        return;
      }

      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: '无法连接到页面，请刷新页面后重试' });
          return;
        }
        sendResponse(response);
      });
    });
    return true; // 异步响应
  }

  if (message.target === 'background' && message.action === 'ping') {
    sendResponse({ success: true, message: 'service-worker is active' });
    return false;
  }
});

// 扩展安装或更新时的初始化
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('[调课助手] 扩展已安装');
  } else if (details.reason === 'update') {
    console.log('[调课助手] 扩展已更新到版本', chrome.runtime.getManifest().version);
  }
});
