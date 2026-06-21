/**
 * 主页（Tab 容器）
 */

import { registerRoute, navigate } from '../router.js';
import { getCurrentUser, logout } from '../auth.js';
import { post } from '../api.js';
import { renderTiaoKeTab } from './tab-tiaoKe.js';
import { renderHistoryTab } from './tab-history.js';
import { renderSettingsTab } from './tab-settings.js';

registerRoute('/main', renderMain);

let activeTab = 'tiaoKe';
let tokenStatus = null;

async function renderMain() {
  const root = document.getElementById('app-root');
  if (!root) return;

  const user = getCurrentUser();
  if (!user) {
    navigate('/login');
    return;
  }

  // 获取 Token 状态
  const statusResult = await post('tiaokeToken.get');
  tokenStatus = statusResult.code === 0 ? statusResult.data : { status: 'not_set' };

  root.innerHTML = `
    <div class="main-page">
      <header class="main-header">
        <div class="header-left">
          <span class="header-title">🎯 调课助手</span>
        </div>
        <div class="header-right">
          <button id="logoutBtn" class="btn btn-text">退出</button>
        </div>
      </header>

      <div class="token-bar" id="tokenBar">
        ${renderTokenBar(tokenStatus)}
      </div>

      <nav class="tab-nav">
        <button class="tab-btn ${activeTab === 'tiaoKe' ? 'active' : ''}" data-tab="tiaoKe">调课</button>
        <button class="tab-btn ${activeTab === 'history' ? 'active' : ''}" data-tab="history">历史</button>
        <button class="tab-btn ${activeTab === 'settings' ? 'active' : ''}" data-tab="settings">设置</button>
      </nav>

      <main class="tab-content" id="tabContent">
      </main>
    </div>
  `;

  // 事件绑定
  document.getElementById('logoutBtn').addEventListener('click', () => {
    logout();
    navigate('/login');
  });

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderActiveTab();
    });
  });

  renderActiveTab();
}

function renderTokenBar(status) {
  if (!status) return '<span class="token-status token-unknown">🔑 Token：检查中...</span>';

  switch (status.status) {
    case 'valid':
      return `<span class="token-status token-valid">🔑 Token：✅ ${status.message}</span>`;
    case 'expiring':
      return `<span class="token-status token-expiring">🔑 Token：⚠️ ${status.message}</span>`;
    case 'expired':
      return `<span class="token-status token-expired">🔑 Token：❌ 已过期</span>`;
    default:
      return `<span class="token-status token-notset">🔑 Token：未设置</span>`;
  }
}

function renderActiveTab() {
  const content = document.getElementById('tabContent');
  if (!content) return;

  switch (activeTab) {
    case 'tiaoKe':
      renderTiaoKeTab(content, tokenStatus);
      break;
    case 'history':
      renderHistoryTab(content);
      break;
    case 'settings':
      renderSettingsTab(content, tokenStatus);
      break;
  }
}

// 导出 Token 刷新函数
export async function refreshTokenStatus() {
  const statusResult = await post('tiaokeToken.get');
  tokenStatus = statusResult.code === 0 ? statusResult.data : { status: 'not_set' };
  const bar = document.getElementById('tokenBar');
  if (bar) bar.innerHTML = renderTokenBar(tokenStatus);
  return tokenStatus;
}
