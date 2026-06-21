/**
 * 设置 Tab
 * Token 获取 + 学情表管理
 */

import { post } from '../api.js';
import { refreshTokenStatus } from './main.js';
import { JWT_PATTERN, AI_GENESIS_URL } from '../config.js';

export function renderSettingsTab(container, tokenStatus) {
  const isValid = tokenStatus && tokenStatus.status === 'valid';

  container.innerHTML = `
    <div class="settings-tab">
      <!-- Token 区域 -->
      <div class="section">
        <label class="section-label">🔑 调课 Token</label>
        <div class="token-status-card ${isValid ? 'card-valid' : 'card-invalid'}">
          <div class="token-status-text">
            ${renderTokenStatusText(tokenStatus)}
          </div>
        </div>

        ${!isValid ? renderTokenGuide() : ''}

        <div class="token-actions">
          <a href="${AI_GENESIS_URL}" target="_blank" class="btn btn-secondary btn-block">
            📱 打开调课后台（如需重新登录）
          </a>
        </div>

        <div class="token-paste-section">
          <label class="form-label">粘贴 Token</label>
          <div class="paste-row">
            <input type="text" id="tokenInput" class="form-input"
              placeholder="eyJ..."
              autocomplete="off">
            <button id="pasteTokenBtn" class="btn btn-secondary">📋 粘贴</button>
          </div>
          <button id="saveTokenBtn" class="btn btn-primary btn-block" style="margin-top:8px">
            ✅ 验证并保存
          </button>
          <div id="tokenError" class="form-error" style="display:none"></div>
        </div>
      </div>

      <!-- 学情表区域 -->
      <div class="section">
        <label class="section-label">📋 学情表（学员信息簿）</label>
        <div id="rosterStatus" class="roster-status">未加载</div>
        <div class="roster-actions">
          <button id="importRosterBtn" class="btn btn-secondary btn-block">📥 导入 Excel 学情表</button>
          <input type="file" id="rosterFile" accept=".xlsx,.xls,.csv" style="display:none">
          <button id="clearRosterBtn" class="btn btn-text btn-block" style="display:none">🗑️ 清除学情表</button>
        </div>
        <div id="rosterDetail" class="roster-detail" style="display:none"></div>
      </div>

      <!-- 操作提示 -->
      <div class="section">
        <label class="section-label">💡 操作说明</label>
        <div class="help-content">
          <p><b>Token 获取步骤：</b></p>
          <ol>
            <li>在<b>电脑</b>上登录调课后台（ai-genesis）</li>
            <li>打开调课助手扩展，点击「复制 Token」</li>
            <li>通过企微/微信把 Token 发给自己</li>
            <li>在手机上复制 Token，粘贴到上方输入框</li>
            <li>点击「验证并保存」即可</li>
          </ol>
          <p>Token 有效期 24 小时，每天操作一次即可。</p>
        </div>
      </div>
    </div>
  `;

  bindTokenEvents();
  bindRosterEvents();
  startClipboardWatch();
}

function renderTokenStatusText(status) {
  if (!status || status.status === 'not_set') {
    return '❌ 未设置';
  }
  switch (status.status) {
    case 'valid':
      return `✅ ${status.message || 'Token 有效'}`;
    case 'expiring':
      return `⚠️ ${status.message || 'Token 即将过期'}`;
    case 'expired':
      return '❌ Token 已过期，请重新获取';
    default:
      return '❓ 未知状态';
  }
}

function renderTokenGuide() {
  return `
    <div class="token-guide-inline">
      <p>⚠️ Token 未设置，无法执行调课操作。请按上方步骤获取并粘贴 Token。</p>
    </div>
  `;
}

function bindTokenEvents() {
  // 粘贴按钮
  const pasteBtn = document.getElementById('pasteTokenBtn');
  if (pasteBtn) {
    pasteBtn.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        const tokenInput = document.getElementById('tokenInput');
        if (tokenInput && text) {
          tokenInput.value = text.trim();
          tryAutoSave(text.trim());
        }
      } catch (e) {
        // 剪贴板权限被拒绝，提示手动粘贴
        const tokenInput = document.getElementById('tokenInput');
        if (tokenInput) tokenInput.focus();
      }
    });
  }

  // 验证保存按钮
  const saveBtn = document.getElementById('saveTokenBtn');
  if (saveBtn) {
    saveBtn.addEventListener('click', handleSaveToken);
  }

  // 输入框变化自动检测
  const tokenInput = document.getElementById('tokenInput');
  if (tokenInput) {
    tokenInput.addEventListener('input', () => {
      const val = tokenInput.value.trim();
      if (JWT_PATTERN.test(val)) {
        tokenInput.classList.add('input-valid');
      } else {
        tokenInput.classList.remove('input-valid');
      }
    });
  }
}

async function handleSaveToken() {
  const tokenInput = document.getElementById('tokenInput');
  const errorEl = document.getElementById('tokenError');
  const saveBtn = document.getElementById('saveTokenBtn');

  if (!tokenInput) return;
  const token = tokenInput.value.trim();

  if (!token) {
    showError(errorEl, '请先粘贴 Token');
    return;
  }

  if (!JWT_PATTERN.test(token)) {
    showError(errorEl, 'Token 格式不正确，应以 eyJ 开头，三段式格式');
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = '验证中...';
  hideError(errorEl);

  const result = await post('tiaokeToken.save', { token });

  saveBtn.disabled = false;
  saveBtn.textContent = '✅ 验证并保存';

  if (result.code === 0) {
    tokenInput.value = '';
    tokenInput.classList.remove('input-valid');
    // 刷新 Token 状态并重新渲染设置页
    const newStatus = await refreshTokenStatus();
    const content = document.getElementById('tabContent');
    if (content) {
      renderSettingsTab(content, newStatus);
    }
  } else {
    showError(errorEl, result.message || 'Token 验证失败');
  }
}

function tryAutoSave(text) {
  if (JWT_PATTERN.test(text)) {
    // 自动触发保存
    handleSaveToken();
  }
}

function startClipboardWatch() {
  // 页面可见性变化时检测剪贴板
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      const tokenInput = document.getElementById('tokenInput');
      if (!tokenInput) return;

      // 如果输入框为空，尝试从剪贴板读取
      if (!tokenInput.value.trim()) {
        try {
          const text = await navigator.clipboard.readText();
          const trimmed = text.trim();
          if (JWT_PATTERN.test(trimmed)) {
            tokenInput.value = trimmed;
            tokenInput.classList.add('input-valid');
            // 自动触发保存
            handleSaveToken();
          }
        } catch (e) {
          // 剪贴板权限被拒绝，静默忽略
        }
      }
    }
  });
}

// ========== 学情表管理 ==========

function bindRosterEvents() {
  const importBtn = document.getElementById('importRosterBtn');
  const rosterFile = document.getElementById('rosterFile');
  const clearBtn = document.getElementById('clearRosterBtn');

  if (importBtn && rosterFile) {
    importBtn.addEventListener('click', () => rosterFile.click());
    rosterFile.addEventListener('change', handleRosterFile);
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', handleClearRoster);
  }

  // 加载已有学情表状态
  loadRosterStatus();
}

async function loadRosterStatus() {
  const result = await post('student.getRoster');
  const statusEl = document.getElementById('rosterStatus');
  const detailEl = document.getElementById('rosterDetail');
  const clearBtn = document.getElementById('clearRosterBtn');

  if (result.code === 0 && result.data && result.data.count > 0) {
    if (statusEl) {
      statusEl.textContent = `已加载: ${result.data.count} 名学员`;
      statusEl.className = 'roster-status roster-loaded';
    }
    if (detailEl) {
      detailEl.style.display = 'block';
      detailEl.textContent = `上次导入: ${result.data.updatedAt || '未知'}`;
    }
    if (clearBtn) clearBtn.style.display = 'block';
  }
}

async function handleRosterFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';

  const statusEl = document.getElementById('rosterStatus');

  if (statusEl) {
    statusEl.textContent = '正在解析...';
    statusEl.className = 'roster-status roster-loading';
  }

  try {
    // 前端解析 Excel（SheetJS）
    const students = await parseExcelFile(file);

    if (students.length === 0) {
      if (statusEl) {
        statusEl.textContent = 'Excel 为空或格式不正确';
        statusEl.className = 'roster-status roster-empty';
      }
      return;
    }

    // 上传到云端
    const result = await post('student.importRoster', { students });

    if (result.code === 0) {
      if (statusEl) {
        statusEl.textContent = `已加载: ${students.length} 名学员`;
        statusEl.className = 'roster-status roster-loaded';
      }
      const clearBtn = document.getElementById('clearRosterBtn');
      if (clearBtn) clearBtn.style.display = 'block';
    } else {
      if (statusEl) {
        statusEl.textContent = '导入失败: ' + (result.message || '未知错误');
        statusEl.className = 'roster-status roster-empty';
      }
    }
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = 'Excel 解析失败: ' + err.message;
      statusEl.className = 'roster-status roster-empty';
    }
  }
}

/**
 * 前端解析 Excel 文件（SheetJS）
 * @param {File} file
 * @returns {Promise<Array<{name:string, phone:string, studentId:string}>>}
 */
async function parseExcelFile(file) {
  // 动态加载 SheetJS
  if (typeof XLSX === 'undefined') {
    await loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
  }

  const data = await file.arrayBuffer();
  const workbook = XLSX.read(data, { type: 'array' });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: '' });

  if (rows.length === 0) return [];

  const sample = rows[0];
  const keys = Object.keys(sample);

  // 智能匹配表头
  const nameKey = keys.find(k => /^(name|姓名|学生姓名|学员姓名)$/i.test(k.trim())) || keys[0];
  const phoneKey = keys.find(k => /^(phone|手机|手机号|联系电话|电话)$/i.test(k.trim())) || keys[1];
  const idKey = keys.find(k => /^(studentId|学员ID|学员id|student_id|id)$/i.test(k.trim())) || keys[2];

  const students = [];
  for (const row of rows) {
    const name = String(row[nameKey] || '').trim();
    const phone = String(row[phoneKey] || '').trim();
    const studentId = String(row[idKey] || '').trim();

    if (!studentId || !/^\d+$/.test(studentId)) continue;
    students.push({ name, phone, studentId });
  }

  return students;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

async function handleClearRoster() {
  if (!confirm('确定清除学情表？')) return;

  const result = await post('student.clearRoster');
  const statusEl = document.getElementById('rosterStatus');
  const detailEl = document.getElementById('rosterDetail');
  const clearBtn = document.getElementById('clearRosterBtn');

  if (result.code === 0) {
    if (statusEl) {
      statusEl.textContent = '未加载';
      statusEl.className = 'roster-status roster-empty';
    }
    if (detailEl) detailEl.style.display = 'none';
    if (clearBtn) clearBtn.style.display = 'none';
  }
}

function showError(el, msg) {
  if (el) { el.textContent = msg; el.style.display = 'block'; }
}

function hideError(el) {
  if (el) el.style.display = 'none';
}
