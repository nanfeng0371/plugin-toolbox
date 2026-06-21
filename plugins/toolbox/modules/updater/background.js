/**
 * Updater 模块 — background.js
 * 通过 chrome.runtime.connectNative 代理 Native Messaging 通信
 * 支持命令：ping / check / update
 */

(function () {
  'use strict';

  const HOST_NAME = 'com.toolbox.updater'; // 必须与注册表中的 name 一致

  // ─── Native Messaging 代理 ─────────────────────────────────────────

  /**
   * 调用 Native Host（通过 connectNative，支持长连接 + 多次消息）
   * @param {Object} message - 要发送的消息 { command: 'ping'|'check'|'update' }
   * @returns {Promise<Object>} - Native Host 的响应 { success, data|error }
   */
  function callNative(message) {
    return new Promise(function (resolve, reject) {
      let port = null;
      try {
        port = chrome.runtime.connectNative(HOST_NAME);
      } catch (e) {
        reject(new Error('无法连接 Native Host：' + e.message + '。请先运行 install.bat 注册 Native Messaging。'));
        return;
      }

      var timeout = setTimeout(function () {
        port.disconnect();
        reject(new Error('Native Host 响应超时'));
      }, 30000);

      port.onMessage.addListener(function (resp) {
        clearTimeout(timeout);
        // 检查是否是进度消息（type: 'progress'）
        if (resp.type === 'progress') {
          // 进度消息，转发给 content script
          chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
            if (tabs && tabs[0]) {
              chrome.tabs.sendMessage(tabs[0].id, {
                target: 'updater',
                type: 'PROGRESS',
                data: resp.data,
              });
            }
          });
          return; // 不 resolve，继续等待最终结果
        }
        // 最终结果
        resolve(resp);
      });

      port.onDisconnect.addListener(function () {
        clearTimeout(timeout);
        var lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error('Native Host 断开：' + lastError.message));
        } else {
          reject(new Error('Native Host 异常退出'));
        }
      });

      // 发送消息
      try {
        port.postMessage(message);
      } catch (e) {
        clearTimeout(timeout);
        reject(new Error('发送消息失败：' + e.message));
      }
    });
  }

  // ─── 版本比较 ─────────────────────────────────────────────────────

  /** 简单的语义化版本比较：a > b 返回 1，a < b 返回 -1，相等返回 0 */
  function _compareVersions(a, b) {
    var pa = (a || '0').split('.').map(Number);
    var pb = (b || '0').split('.').map(Number);
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var na = pa[i] || 0;
      var nb = pb[i] || 0;
      if (na > nb) return 1;
      if (na < nb) return -1;
    }
    return 0;
  }

  // ─── 处理器注册 ─────────────────────────────────────────────────────

  self.__registerModuleHandlers('updater', {

    /** 检查更新 */
    CHECK_UPDATE: async function (data, sender) {
      // 先 ping 一下，确认 Native Host 可用
      var pingResp = await callNative({ command: 'ping' });
      if (!pingResp || !pingResp.success) {
        throw new Error('Native Host 未安装或不可用。请先运行 install.bat 注册。');
      }
      // 检查更新（Native Host 返回云端原始数据）
      var checkResp = await callNative({ command: 'check' });
      if (!checkResp || !checkResp.success) {
        throw new Error((checkResp && checkResp.data && checkResp.data.error) || '检查更新失败');
      }
      var cloudData = checkResp.data;
      // 获取当前扩展版本
      var manifest = chrome.runtime.getManifest();
      var currentVersion = manifest.version;
      var latestVersion = cloudData.version || '0.0.0';

      // MessageBus 会自动包裹 { success:true, data:... }
      return {
        currentVersion: currentVersion,
        latestVersion: latestVersion,
        hasUpdate: _compareVersions(latestVersion, currentVersion) > 0,
        downloadUrl: cloudData.downloadUrl || '',
        releaseNotes: cloudData.releaseNotes || '',
      };
    },

    /** 安装更新 */
    INSTALL_UPDATE: async function (data, sender) {
      var msg = { command: 'update' };
      if (data && data.downloadUrl) {
        msg.downloadUrl = data.downloadUrl;
      }
      var updateResp = await callNative(msg);
      if (!updateResp || !updateResp.success) {
        throw new Error((updateResp && updateResp.error) || '安装更新失败');
      }
      return updateResp.data;
    },

    /** Ping Native Host */
    PING: async function (data, sender) {
      var pingResp = await callNative({ command: 'ping' });
      return pingResp && pingResp.data;
    },

  });

  console.log('[Updater BG] 模块已加载，Native Host 名称：', HOST_NAME);
})();
