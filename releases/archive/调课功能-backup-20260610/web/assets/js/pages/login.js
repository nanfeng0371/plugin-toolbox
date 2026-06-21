/**
 * 登录页（V4 Token粘贴模式）
 * 不再需要用户名密码，直接粘贴从扩展复制的Token
 */

import { registerRoute, navigate } from '../router.js';
import { saveTiaokeToken, isLoggedIn } from '../auth.js';
import { JWT_PATTERN } from '../config.js';

registerRoute('/login', renderLogin);

function renderLogin() {
  const root = document.getElementById('app-root');
  if (!root) return;

  root.innerHTML = `
    <div class="login-page">
      <div class="login-card">
        <div class="login-header">
          <div class="login-icon">🎯</div>
          <h1 class="login-title">调课助手</h1>
          <p class="login-subtitle">粘贴 Token 即可使用</p>
        </div>
        <form id="loginForm" class="login-form">
          <div class="form-group">
            <label class="form-label">粘贴调课 Token</label>
            <textarea id="tokenInput" class="form-input form-textarea"
              placeholder="eyJhbGciOi..."
              rows="3"
              autocomplete="off"></textarea>
            <div class="form-hint">从电脑端调课助手扩展复制 Token，粘贴到这里</div>
          </div>
          <div id="loginError" class="form-error" style="display:none"></div>
          <button type="submit" id="loginBtn" class="btn btn-primary btn-block">验证并登录</button>
        </form>

        <div class="login-help">
          <p><b>获取 Token 步骤：</b></p>
          <ol>
            <li>在<b>电脑</b>上登录调课后台（ai-genesis）</li>
            <li>打开调课助手扩展，点击「复制 Token」</li>
            <li>通过企微/微信把 Token 发给自己</li>
            <li>在手机上复制 Token，粘贴到上方输入框</li>
          </ol>
          <p class="login-help-note">Token 有效期 24 小时，每天操作一次即可</p>
        </div>
      </div>
    </div>
  `;

  // 绑定事件
  const form = document.getElementById('loginForm');
  form.addEventListener('submit', handleLogin);

  // 输入框自动检测JWT格式
  const tokenInput = document.getElementById('tokenInput');
  tokenInput.addEventListener('input', () => {
    const val = tokenInput.value.trim();
    if (JWT_PATTERN.test(val)) {
      tokenInput.classList.add('input-valid');
    } else {
      tokenInput.classList.remove('input-valid');
    }
  });

  // 粘贴时自动检测
  tokenInput.addEventListener('paste', () => {
    setTimeout(() => {
      const val = tokenInput.value.trim();
      if (JWT_PATTERN.test(val)) {
        // 自动提交
        handleLogin(new Event('submit', { cancelable: true }));
      }
    }, 100);
  });

  // 尝试从剪贴板读取
  tryAutoFillFromClipboard();
}

async function tryAutoFillFromClipboard() {
  const tokenInput = document.getElementById('tokenInput');
  if (!tokenInput) return;

  try {
    const text = await navigator.clipboard.readText();
    const trimmed = text.trim();
    if (JWT_PATTERN.test(trimmed)) {
      tokenInput.value = trimmed;
      tokenInput.classList.add('input-valid');
      // 自动提交
      handleLogin(new Event('submit', { cancelable: true }));
    }
  } catch (e) {
    // 剪贴板权限被拒绝，静默忽略
  }
}

async function handleLogin(e) {
  e.preventDefault();

  const tokenInput = document.getElementById('tokenInput');
  const errorEl = document.getElementById('loginError');
  const btn = document.getElementById('loginBtn');

  if (!tokenInput) return;
  const token = tokenInput.value.trim();

  if (!token) {
    errorEl.textContent = '请先粘贴 Token';
    errorEl.style.display = 'block';
    return;
  }

  if (!JWT_PATTERN.test(token)) {
    errorEl.textContent = 'Token 格式不正确，应以 eyJ 开头';
    errorEl.style.display = 'block';
    return;
  }

  btn.disabled = true;
  btn.textContent = '验证中...';
  errorEl.style.display = 'none';

  const result = await saveTiaokeToken(token);

  if (result.success) {
    navigate('/main');
  } else {
    errorEl.textContent = result.message || 'Token 验证失败';
    errorEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = '验证并登录';
  }
}
