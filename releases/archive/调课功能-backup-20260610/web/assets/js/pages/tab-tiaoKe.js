/**
 * 调课 Tab
 */

import { post } from '../api.js';
import { refreshTokenStatus } from './main.js';
import { JWT_PATTERN, AI_GENESIS_URL } from '../config.js';

export function renderTiaoKeTab(container, tokenStatus) {
  const canOperate = tokenStatus && tokenStatus.status === 'valid';

  container.innerHTML = `
    <div class="tiaoKe-tab">
      ${!canOperate ? renderTokenGuide() : ''}

      <div class="section">
        <label class="section-label">输入调课指令</label>
        <textarea id="tiaoKeInput" class="form-textarea" rows="6"
          placeholder="支持以下格式：&#10;&#10;格式1（每行一条）：&#10;王一  5  5月2日  10:00&#10;12345  3  5-3  14:00&#10;&#10;格式2（自然语言）：&#10;王一，第5讲，调到5月2日10点&#10;把李二的第3讲改到5月3日下午2点"
          ${!canOperate ? 'disabled' : ''}></textarea>
        <div class="btn-row">
          <button id="parseBtn" class="btn btn-secondary" ${!canOperate ? 'disabled' : ''}>📋 解析预览</button>
          <button id="executeBtn" class="btn btn-primary" ${!canOperate ? 'disabled' : ''}>▶ 执行调课</button>
        </div>
      </div>

      <div id="parseResult" class="section" style="display:none">
        <label class="section-label">解析结果</label>
        <div id="parseResultContent"></div>
      </div>

      <div id="executeProgress" class="section" style="display:none">
        <label class="section-label">执行进度</label>
        <div id="executeProgressContent"></div>
      </div>
    </div>
  `;

  // 事件绑定
  const parseBtn = document.getElementById('parseBtn');
  const executeBtn = document.getElementById('executeBtn');

  if (parseBtn) parseBtn.addEventListener('click', handleParse);
  if (executeBtn) executeBtn.addEventListener('click', handleExecute);
}

function renderTokenGuide() {
  return `
    <div class="token-guide">
      <p class="guide-title">⚠️ 调课 Token 未设置，无法执行调课操作</p>
      <p class="guide-steps">
        请按以下步骤操作：<br>
        1. 点击「设置」标签页<br>
        2. 点击「获取 Token」按钮<br>
        3. 在新页面中登录调课后台（企微会自动登录）<br>
        4. 复制页面中的 Token<br>
        5. 切回本页面，Token 会自动填入<br>
        6. 点击「确认保存」即可
      </p>
    </div>
  `;
}

async function handleParse() {
  const input = document.getElementById('tiaoKeInput').value.trim();
  if (!input) return;

  const parseBtn = document.getElementById('parseBtn');
  parseBtn.disabled = true;
  parseBtn.textContent = '解析中...';

  const result = await post('reschedule.parse', { input });

  parseBtn.disabled = false;
  parseBtn.textContent = '📋 解析预览';

  const resultSection = document.getElementById('parseResult');
  const resultContent = document.getElementById('parseResultContent');
  resultSection.style.display = 'block';

  if (result.code !== 0) {
    resultContent.innerHTML = `<div class="result-error">${result.message}</div>`;
    return;
  }

  const data = result.data;
  let html = `<div class="parse-summary">共 ${data.total} 条：✅ ${data.success} 条成功，❌ ${data.failed} 条失败</div>`;
  html += '<div class="parse-list">';

  for (const task of data.tasks) {
    const cls = task.status === 'ok' ? 'parse-item-ok' : 'parse-item-err';
    const icon = task.status === 'ok' ? '✅' : '❌';
    html += `<div class="parse-item ${cls}">
      ${icon} ${task.studentIdentifier || task.studentId || '?'} → 第${task.lesson || '?'}讲 → ${task.newDate || '?'} ${task.newTime || '?'}
      ${task.error ? `<span class="parse-error">${task.error}</span>` : ''}
    </div>`;
  }
  html += '</div>';

  resultContent.innerHTML = html;

  // 保存解析结果供执行使用
  window._tkParsedTasks = data.tasks.filter(t => t.status === 'ok');
}

async function handleExecute() {
  const tasks = window._tkParsedTasks;
  if (!tasks || tasks.length === 0) {
    alert('请先解析调课指令');
    return;
  }

  const executeBtn = document.getElementById('executeBtn');
  executeBtn.disabled = true;
  executeBtn.textContent = '执行中...';

  const progressSection = document.getElementById('executeProgress');
  const progressContent = document.getElementById('executeProgressContent');
  progressSection.style.display = 'block';
  progressContent.innerHTML = '<div class="progress-loading">正在执行调课，请稍候...</div>';

  const result = await post('reschedule.batch', { tasks });

  executeBtn.disabled = false;
  executeBtn.textContent = '▶ 执行调课';

  if (result.code !== 0) {
    progressContent.innerHTML = `<div class="result-error">${result.message}</div>`;
    return;
  }

  const data = result.data;
  let html = `<div class="execute-summary">
    共 ${data.total} 条：✅ ${data.success} 条成功，❌ ${data.failed} 条失败
  </div>`;
  html += '<div class="execute-list">';

  for (const r of data.results) {
    const cls = r.success ? 'execute-item-ok' : 'execute-item-err';
    const icon = r.success ? '✅' : '❌';
    html += `<div class="execute-item ${cls}">
      ${icon} ${r.studentName || r.studentId} 第${r.lesson}讲 → ${r.newDate} ${r.newTime}
      ${!r.success ? `<span class="execute-error">${r.message}</span>` : ''}
    </div>`;
  }
  html += '</div>';

  progressContent.innerHTML = html;
}
