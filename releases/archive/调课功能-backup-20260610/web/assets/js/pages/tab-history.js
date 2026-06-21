/**
 * 历史日志 Tab
 */

import { post } from '../api.js';

export function renderHistoryTab(container) {
  container.innerHTML = `
    <div class="history-tab">
      <div class="section">
        <div class="search-row">
          <input type="text" id="historySearch" class="form-input" placeholder="搜索学员姓名/ID">
          <button id="historySearchBtn" class="btn btn-secondary">搜索</button>
        </div>
      </div>
      <div id="historyList" class="section">
        <div class="loading">加载中...</div>
      </div>
    </div>
  `;

  // 加载历史记录
  loadHistory();

  // 搜索事件
  document.getElementById('historySearchBtn').addEventListener('click', handleSearch);
  document.getElementById('historySearch').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSearch();
  });
}

async function loadHistory(page = 1) {
  const listEl = document.getElementById('historyList');
  if (!listEl) return;

  const result = await post('log.list', { page, pageSize: 50 });

  if (result.code !== 0 || !result.data) {
    listEl.innerHTML = `<div class="empty">暂无调课记录</div>`;
    return;
  }

  const { grouped, total } = result.data;
  if (!grouped || Object.keys(grouped).length === 0) {
    listEl.innerHTML = `<div class="empty">暂无调课记录</div>`;
    return;
  }

  let html = `<div class="history-total">共 ${total} 条记录</div>`;

  for (const [date, logs] of Object.entries(grouped)) {
    html += `<div class="history-group">
      <div class="history-date">${date}</div>`;
    for (const log of logs) {
      const icon = log.success ? '✅' : '❌';
      html += `<div class="history-item">
        ${icon} ${log.studentName || log.studentId} 第${log.lesson}讲 → ${log.newDate} ${log.newTime}
        <span class="history-time">${log.message || ''}</span>
      </div>`;
    }
    html += '</div>';
  }

  listEl.innerHTML = html;
}

async function handleSearch() {
  const keyword = document.getElementById('historySearch').value.trim();
  if (!keyword) {
    loadHistory();
    return;
  }

  const listEl = document.getElementById('historyList');
  listEl.innerHTML = '<div class="loading">搜索中...</div>';

  const result = await post('log.search', { keyword });

  if (result.code !== 0 || !result.data) {
    listEl.innerHTML = `<div class="empty">未找到相关记录</div>`;
    return;
  }

  const { list, total } = result.data;
  if (!list || list.length === 0) {
    listEl.innerHTML = `<div class="empty">未找到"${keyword}"的调课记录</div>`;
    return;
  }

  let html = `<div class="history-total">找到 ${total} 条记录</div>`;
  html += '<div class="history-group">';
  for (const log of list) {
    const icon = log.success ? '✅' : '❌';
    html += `<div class="history-item">
      ${icon} ${log.studentName || log.studentId} 第${log.lesson}讲 → ${log.newDate} ${log.newTime}
      <span class="history-time">${log.message || ''}</span>
    </div>`;
  }
  html += '</div>';

  listEl.innerHTML = html;
}
