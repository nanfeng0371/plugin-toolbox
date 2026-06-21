/**
 * Hash 路由
 */

/** 路由映射 */
const routes = {};
let currentPath = '';

/**
 * 注册路由
 */
export function registerRoute(path, renderFn) {
  routes[path] = renderFn;
}

/**
 * 初始化路由
 */
export function initRouter() {
  window.addEventListener('hashchange', handleRoute);
  handleRoute();
}

/**
 * 导航
 */
export function navigate(path) {
  window.location.hash = '#' + path;
}

/**
 * 获取当前路径
 */
export function getCurrentPath() {
  return currentPath;
}

/**
 * 处理路由变化
 */
function handleRoute() {
  const hash = window.location.hash || '#/login';
  const path = hash.replace('#', '');
  currentPath = path;

  const renderFn = routes[path];
  if (renderFn) {
    renderFn();
  } else {
    // 404 → 回首页
    navigate('/login');
  }
}
