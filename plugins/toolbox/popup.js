/**
 * 插件工作箱 — Popup 模块管理逻辑
 *
 * 功能：
 * 1. 通过 chrome.runtime.sendMessage 获取模块列表
 * 2. 渲染模块列表（图标 + 名称 + 版本 + 描述 + toggle switch）
 * 3. toggle switch 点击发送 MODULE_ENABLE_TOGGLE 消息
 *
 * 注意：打开侧边栏功能已移至页面左侧悬浮按钮，popup 仅做模块启禁管理
 */

document.addEventListener('DOMContentLoaded', async () => {
  const listContainer = document.getElementById('module-list-container');

  // 动态版本号
  try {
    const manifest = chrome.runtime.getManifest();
    document.getElementById('popup-version').textContent =
      `v${manifest.version} · 模块化管理`;
  } catch (e) { /* 忽略 */ }

  // ========== 获取模块列表并渲染 ==========

  try {
    const resp = await chrome.runtime.sendMessage({
      target: 'shell',
      action: 'GET_MODULE_LIST',
    });
    if (resp && resp.success) {
      renderModuleList(resp.data || []);
    } else {
      listContainer.innerHTML =
        '<div style="text-align:center;color:#94a3b8;padding:16px;font-size:13px;">获取模块列表失败</div>';
    }
  } catch (e) {
    console.error('[popup] 获取模块列表失败:', e);
    listContainer.innerHTML =
      '<div style="text-align:center;color:#94a3b8;padding:16px;font-size:13px;">获取模块列表失败</div>';
  }
});

/**
 * 渲染模块列表
 * @param {Object[]} modules - 模块列表
 */
function renderModuleList(modules) {
  const container = document.getElementById('module-list-container');

  if (!modules || modules.length === 0) {
    container.innerHTML =
      '<div style="text-align:center;color:#94a3b8;padding:16px;font-size:13px;">暂无可用模块</div>';
    return;
  }

  // 模块图标映射
  const iconMap = { report: '📊', dingtalk: '🔗' };

  container.innerHTML = modules
    .map((mod) => {
      const icon = iconMap[mod.name] || '📦';
      const version = mod.version ? `v${mod.version}` : '';
      const checked = mod.enabled ? 'checked' : '';

      return `
        <div class="module-item" data-module="${mod.name}">
          <span class="m-icon">${icon}</span>
          <div class="m-info">
            <div class="m-name">${mod.label || mod.name} <small style="color:#94a3b8">${version}</small></div>
            <div class="m-desc">${mod.description || ''}</div>
          </div>
          <label class="toggle-switch" title="${mod.enabled ? '点击禁用' : '点击启用'}">
            <input type="checkbox" ${checked} data-module="${mod.name}" class="module-toggle">
            <span class="toggle-slider"></span>
          </label>
        </div>
      `;
    })
    .join('');

  // ========== 绑定 toggle 事件 ==========

  container.querySelectorAll('.module-toggle').forEach((toggle) => {
    toggle.addEventListener('change', async (e) => {
      const name = e.target.dataset.module;
      const enabled = e.target.checked;

      try {
        const resp = await chrome.runtime.sendMessage({
          target: 'shell',
          action: 'MODULE_ENABLE_TOGGLE',
          data: { name: name, enabled: enabled },
        });

        if (resp && resp.success) {
          console.log(`[popup] 模块 ${name} 已${enabled ? '启用' : '禁用'}`);
        } else {
          // 恢复原状态
          e.target.checked = !enabled;
          console.error('[popup] 切换模块状态失败:', resp);
        }
      } catch (err) {
        // 恢复原状态
        e.target.checked = !enabled;
        console.error('[popup] 切换模块状态失败:', err);
      }
    });
  });
}
