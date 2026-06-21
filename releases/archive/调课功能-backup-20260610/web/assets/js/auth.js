/**
 * 认证管理（V4 Token模式）
 * 纯Token粘贴登录，不再使用用户名密码
 */

import { post } from './api.js';
import { EF_TOKEN_KEY, EF_USER_KEY, JWT_PATTERN } from './config.js';

/**
 * 保存调课Token（验证+存储）
 * @param {string} token - JWT Token字符串
 * @returns {Object} { success, user?, message? }
 */
export async function saveTiaokeToken(token) {
  if (!token || !JWT_PATTERN.test(token)) {
    return { success: false, message: 'Token 格式不正确' };
  }

  const result = await post('tiaokeToken.save', { token });

  if (result.code === 0 && result.data) {
    // 保存成功，标记为已登录
    localStorage.setItem(EF_TOKEN_KEY, 'tiaoke_active');
    if (result.data.user) {
      localStorage.setItem(EF_USER_KEY, JSON.stringify(result.data.user));
    } else {
      // 从JWT解码获取基本信息
      const payload = decodeJwtPayload(token);
      const userInfo = {
        _id: payload?.sub || payload?.user_id || payload?.uid || 'unknown',
        userId: payload?.sub || payload?.user_id || payload?.uid || 'unknown',
        name: payload?.name || payload?.preferred_username || payload?.sub || '辅导员',
        role: 'counselor',
      };
      localStorage.setItem(EF_USER_KEY, JSON.stringify(userInfo));
    }
    return { success: true, user: JSON.parse(localStorage.getItem(EF_USER_KEY)) };
  }

  return { success: false, message: result.message || 'Token 验证失败' };
}

/**
 * 登出
 */
export function logout() {
  localStorage.removeItem(EF_TOKEN_KEY);
  localStorage.removeItem(EF_USER_KEY);
}

/**
 * 获取当前登录用户
 * @returns {Object|null}
 */
export function getCurrentUser() {
  try {
    const userStr = localStorage.getItem(EF_USER_KEY);
    return userStr ? JSON.parse(userStr) : null;
  } catch {
    return null;
  }
}

/**
 * 检查是否已登录（有Token且有效）
 * @returns {boolean}
 */
export function isLoggedIn() {
  return !!localStorage.getItem(EF_TOKEN_KEY);
}

/**
 * 检查Token状态（调用后端验证）
 * @returns {Object} { status, message, expireTime }
 */
export async function checkTokenStatus() {
  const result = await post('tiaokeToken.get');
  if (result.code === 0) {
    return result.data;
  }
  return { status: 'not_set', message: '未设置 Token' };
}

/**
 * 解码JWT Payload（不验证签名）
 */
function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    let payload = parts[1];
    payload = payload.replace(/-/g, '+').replace(/_/g, '/');
    while (payload.length % 4) payload += '=';
    return JSON.parse(atob(payload));
  } catch (e) {
    return null;
  }
}
