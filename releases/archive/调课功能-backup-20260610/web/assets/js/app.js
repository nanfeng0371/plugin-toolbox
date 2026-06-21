/**
 * 应用入口
 * 初始化路由、全局事件、登录态检查
 */

import { initRouter, navigate } from './router.js';
import { isLoggedIn, getCurrentUser, logout } from './auth.js';
import { EF_TOKEN_KEY } from './config.js';

// 显式引入页面模块，触发路由注册（esbuild IIFE 需要静态 import）
import './pages/login.js';
import './pages/main.js';

/** 当前活动 Tab */
let activeTab = 'tiaoKe';

/**
 * 应用初始化
 */
function initApp() {
  buildAppShell();
  initRouter();
  checkAuth();
  bindGlobalEvents();
  console.log('[调课助手] App initialized');
}

/**
 * 构建应用壳
 */
function buildAppShell() {
  const app = document.getElementById('app');
  if (!app) return;
  app.innerHTML = '<div id="app-root"></div>';
}

/**
 * 检查登录态
 */
function checkAuth() {
  if (isLoggedIn()) {
    navigate('/main');
  } else {
    navigate('/login');
  }
}

/**
 * 绑定全局事件
 */
function bindGlobalEvents() {
  // 401 全局登出
  window.addEventListener('tk:unauthorized', () => {
    logout();
    navigate('/login');
  });
}

// 启动
document.addEventListener('DOMContentLoaded', initApp);
