/**
 * 插件工作箱 - Popup（工具栏图标弹窗）
 * 
 * 功能：
 * 1. 显示模块列表和状态
 * 2. 快捷打开侧边栏
 * 3. 设置入口
 */

document.addEventListener('DOMContentLoaded', async () => {
  const listContainer = document.getElementById('module-list-container');
  const btnOpenSidebar = document.getElementById('btn-open-sidebar');

  // 获取模块列表并渲染
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_MODULE_LIST' });
    if (resp.success) {
      renderModuleList(resp.modules);
    }
  } catch (e) {
    console.error('[popup] 获取模块列表失败:', e);
  }

  // 打开侧边栏 → 发消息给当前标签页
  btnOpenSidebar.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR' }).catch(() => {
        // content script 未注入时，提示用户刷新页面
        alert('请在页面中刷新后重试（需要注入内容脚本）');
      });
      window.close();
    }
  });

  // 设置入口
  document.getElementById('btn-settings').addEventListener('click', () => {
    chrome.runtime.openOptionsPage?.() || alert('设置功能即将上线');
  });
});

/**
 * 渲染模块列表
 */
function renderModuleList(modules) {
  const container = document.getElementById('module-list-container');
  const entries = Object.values(modules).sort((a, b) => {
    // available 排最前，coming_soon 排后面
    const order = { available: 0, active: 1, loading: 2, error: 3, coming_soon: 4 };
    return (order[a.status] || 9) - (order[b.status] || 9);
  });

  if (entries.length === 0) {
    container.innerHTML = '<div style="text-align:center;color:#94a3b8;padding:16px;font-size:13px;">暂无可用模块</div>';
    return;
  }

  container.innerHTML = entries.map(mod => {
    let statusClass = 'status-coming';
    let statusText = '敬请期待';
    
    if (mod.status === 'available' || mod.status === 'active') {
      statusClass = mod.status === 'active' ? 'status-active' : 'status-available';
      statusText = mod.status === 'active' ? '运行中' : '已就绪';
    } else if (mod.status === 'loading') {
      statusClass = 'status-active'; // 复用紫色
      statusText = '加载中...';
    }

    return `
      <div class="module-item" data-module="${mod.id}">
        <span class="m-icon">${mod.icon}</span>
        <div class="m-info">
          <div class="m-name">${mod.name} ${mod.version !== '-' ? '<small style="color:#94a3b8">v' + mod.version + '</small>' : ''}</div>
          <div class="m-desc">${mod.description}</div>
        </div>
        <span class="m-status ${statusClass}">${statusText}</span>
      </div>
    `;
  }).join('');
}
