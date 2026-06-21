/**
 * Updater 模块 — 更新检查 UI
 * 功能：显示当前版本、检查更新、安装更新
 */

(function () {
  'use strict';

  // ─── 获取 Shadow DOM 容器 ─────────────────────────────────────────
  let shadowRoot = window.__shadowRoots__ && window.__shadowRoots__.updater;
  let _moduleRoot = null;

  if (shadowRoot) {
    renderModuleUI(shadowRoot);
  } else {
    console.warn('[Updater] 未找到壳提供的 Shadow DOM 容器');
  }

  // ─── DOM 查询辅助 ─────────────────────────────────────────────────
  function $(sel) {
    return _moduleRoot ? _moduleRoot.querySelector(sel) : null;
  }

  function $$(sel) {
    return _moduleRoot ? _moduleRoot.querySelectorAll(sel) : [];
  }

  // ─── 消息发送（回调式，避免 import() 导致 Promise 永久 pending）──
  function sendMsg(msg) {
    return new Promise(function (resolve, reject) {
      chrome.runtime.sendMessage(msg, function (resp) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(resp);
        }
      });
    });
  }

  // ─── UI 渲染 ─────────────────────────────────────────────────────
  function renderModuleUI(root) {
    // 1. 清除壳的 loading 占位符（保留 <style> 标签）
    while (root.firstChild) {
      if (root.firstChild.nodeType === 1 && root.firstChild.tagName === 'STYLE') break;
      root.firstChild.remove();
    }

    // 2. 创建模块根容器
    var container = document.createElement('div');
    container.className = 'upd-module-root';
    container.innerHTML = `
      <div class="upd-container">
        <div class="upd-header">
          <h2 class="upd-title">🔄 检查更新</h2>
          <p class="upd-subtitle">自动检测并安装插件更新</p>
        </div>

        <div class="upd-card">
          <div class="upd-row">
            <span class="upd-label">当前版本</span>
            <span class="upd-value" id="upd-current-version">加载中...</span>
          </div>
          <div class="upd-row">
            <span class="upd-label">最新版本</span>
            <span class="upd-value" id="upd-latest-version">—</span>
          </div>
          <div class="upd-row">
            <span class="upd-label">更新状态</span>
            <span class="upd-value" id="upd-status">未检查</span>
          </div>
        </div>

        <div class="upd-release-notes" id="upd-release-notes" style="display:none;">
          <h3>更新日志</h3>
          <pre id="upd-notes-content"></pre>
        </div>

        <div class="upd-progress-wrap" id="upd-progress-wrap" style="display:none;">
          <div class="upd-progress-bar">
            <div class="upd-progress-fill" id="upd-progress-fill"></div>
          </div>
          <p class="upd-progress-text" id="upd-progress-text">准备中...</p>
        </div>

        <div class="upd-actions">
          <button class="upd-btn upd-btn-primary" id="upd-check-btn">检查更新</button>
          <button class="upd-btn upd-btn-success" id="upd-install-btn" style="display:none;">安装更新</button>
          <button class="upd-btn upd-btn-secondary" id="upd-reload-btn" style="display:none;">重新加载扩展</button>
        </div>

        <div class="upd-hint">
          <p>💡 安装更新后，请点击"重新加载扩展"使新版本生效。</p>
          <p>💡 如需卸载，请删除 Native Host 注册表项并删除扩展目录。</p>
        </div>
      </div>
    `;

    root.appendChild(container);
    _moduleRoot = container;

    // 3. 绑定事件
    bindEvents();

    // 4. 初始化
    initModule();
  }

  // ─── 事件绑定 ─────────────────────────────────────────────────────
  function bindEvents() {
    var checkBtn   = $('#upd-check-btn');
    var installBtn = $('#upd-install-btn');
    var reloadBtn  = $('#upd-reload-btn');

    if (checkBtn) {
      checkBtn.addEventListener('click', function () {
        doCheckUpdate();
      });
    }

    if (installBtn) {
      installBtn.addEventListener('click', function () {
        doInstallUpdate();
      });
    }

    if (reloadBtn) {
      reloadBtn.addEventListener('click', function () {
        // chrome.runtime.reload 在 content script 中可能不可用
        if (chrome.runtime && typeof chrome.runtime.reload === 'function') {
          try { chrome.runtime.reload(); } catch (e) { /* ignore */ }
        }
        // 无论如何都提示用户手动操作
        alert('请手动重新加载扩展：\n1. 打开 chrome://extensions\n2. 找到"插件工作箱"\n3. 点击刷新图标（或关闭浏览器重新打开）');
      });
    }
  }

  // ─── 检查更新 ─────────────────────────────────────────────────────
  async function doCheckUpdate() {
    var statusEl  = $('#upd-status');
    var latestEl = $('#upd-latest-version');
    var notesEl  = $('#upd-release-notes');
    var notesContent = $('#upd-notes-content');
    var installBtn = $('#upd-install-btn');

    if (statusEl) {
      statusEl.textContent = '正在检查...';
      statusEl.className = 'upd-value upd-status-checking';
    }

    if (installBtn) installBtn.style.display = 'none';

    try {
      var resp = await sendMsg({
        target: 'updater',
        action: 'CHECK_UPDATE',
      });

      if (!resp || !resp.success) {
        throw new Error((resp && resp.error) || '检查更新失败');
      }

      var data = resp.data;
      var currentEl = $('#upd-current-version');
      if (currentEl) currentEl.textContent = data.currentVersion || '未知';
      if (latestEl)  latestEl.textContent  = data.latestVersion || '未知';

      if (statusEl) {
        if (data.hasUpdate) {
          statusEl.textContent = '发现新版本！';
          statusEl.className = 'upd-value upd-status-update';
          if (installBtn) installBtn.style.display = '';
        } else {
          statusEl.textContent = '已是最新版本';
          statusEl.className = 'upd-value upd-status-ok';
        }
      }

      // 显示更新日志
      if (data.releaseNotes && notesEl && notesContent) {
        notesContent.textContent = data.releaseNotes;
        notesEl.style.display = '';
      }

      // 保存下载 URL 供安装使用
      window.__updaterDownloadUrl = data.downloadUrl;
    } catch (e) {
      console.error('[Updater] 检查更新失败:', e);
      if (statusEl) {
        statusEl.textContent = '检查失败：' + e.message;
        statusEl.className = 'upd-value upd-status-error';
      }
    }
  }

  // ─── 安装更新 ─────────────────────────────────────────────────────
  async function doInstallUpdate() {
    var progressWrap = $('#upd-progress-wrap');
    var progressFill = $('#upd-progress-fill');
    var progressText = $('#upd-progress-text');
    var installBtn   = $('#upd-install-btn');
    var reloadBtn    = $('#upd-reload-btn');
    var statusEl     = $('#upd-status');

    if (progressWrap) progressWrap.style.display = '';
    if (installBtn)   installBtn.disabled = true;

    try {
      // 通过 background 代理 Native Messaging 调用更新
      var resp = await sendMsg({
        target: 'updater',
        action: 'INSTALL_UPDATE',
        data: {
          downloadUrl: window.__updaterDownloadUrl || null,
        },
      });

      if (!resp || !resp.success) {
        throw new Error((resp && resp.error) || '安装失败');
      }

      if (statusEl) {
        statusEl.textContent = '安装成功！请重新加载扩展';
        statusEl.className = 'upd-value upd-status-ok';
      }

      if (reloadBtn) reloadBtn.style.display = '';
      if (installBtn) installBtn.style.display = 'none';
    } catch (e) {
      console.error('[Updater] 安装更新失败:', e);
      if (statusEl) {
        statusEl.textContent = '安装失败：' + e.message;
        statusEl.className = 'upd-value upd-status-error';
      }
      if (installBtn) {
        installBtn.disabled = false;
      }
    } finally {
      if (progressWrap) progressWrap.style.display = 'none';
    }
  }

  // ─── 初始化 ───────────────────────────────────────────────────────
  function initModule() {
    // 读取当前版本（带防护）
    try {
      var manifest = chrome.runtime.getManifest();
      var currentEl = $('#upd-current-version');
      if (currentEl) currentEl.textContent = manifest.version || '未知';
    } catch (e) {
      console.warn('[Updater] 无法读取扩展版本:', e);
      var currentEl = $('#upd-current-version');
      if (currentEl) currentEl.textContent = '未知';
    }

    // 自动检查一次更新
    setTimeout(function () {
      doCheckUpdate();
    }, 500);
  }
})();
