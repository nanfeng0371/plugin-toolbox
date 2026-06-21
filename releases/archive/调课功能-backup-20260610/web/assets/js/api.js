/**
 * HTTP 请求封装（V4）
 * 自动带上 _token 和 userId（用于 tk_tokens 鉴权）
 */

import { API_BASE, EF_TOKEN_KEY, EF_USER_KEY } from './config.js';

/**
 * POST 请求
 * @param {string} action - 接口标识，如 'auth.login'
 * @param {Object} data - 请求数据
 * @returns {Promise<Object>} 响应数据
 */
export async function post(action, data = {}) {
  const token = localStorage.getItem(EF_TOKEN_KEY);

  // V4: 从 localStorage 获取 userId，用于 tk_tokens 鉴权
  let userId = '';
  try {
    const userStr = localStorage.getItem(EF_USER_KEY);
    if (userStr) {
      const user = JSON.parse(userStr);
      userId = user._id || user.userId || user.sub || '';
    }
  } catch (e) {}

  const body = {
    action,
    data: {
      ...data,
      ...(token ? { _token: token } : {}),
      ...(userId ? { _userId: userId } : {}),
    },
  };

  try {
    const res = await fetch(API_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const result = await res.json();

    // 401 → 清除登录态
    if (result.code === 401) {
      localStorage.removeItem(EF_TOKEN_KEY);
      localStorage.removeItem(EF_USER_KEY);
      // 触发全局登出
      window.dispatchEvent(new CustomEvent('tk:unauthorized'));
    }

    return result;
  } catch (err) {
    return {
      code: 500,
      message: '网络错误，请检查网络连接',
      data: null,
    };
  }
}

/**
 * 上传文件（multipart/form-data）
 * 暂时不用，学情表在前端解析
 */
export async function upload(action, formData) {
  const token = localStorage.getItem(EF_TOKEN_KEY);
  formData.append('action', action);
  if (token) formData.append('_token', token);

  try {
    const res = await fetch(API_BASE, {
      method: 'POST',
      body: formData,
    });

    return await res.json();
  } catch (err) {
    return {
      code: 500,
      message: '网络错误，请检查网络连接',
      data: null,
    };
  }
}
