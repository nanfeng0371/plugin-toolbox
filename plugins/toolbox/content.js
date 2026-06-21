/**
 * 插件工作箱 v2.0.1 — Content Script（侧边栏框架 + 模块加载器 + 调试面板）
 *
 * 职责：
 * 1. SidebarUI — 创建侧边栏 DOM（header + nav tabs + content panels + footer）
 * 2. ModuleLoader — 首次点击 Tab 时懒加载模块 JS+CSS 到 Shadow DOM；后续用 display 切换保留状态
 * 3. FloatingButton — 左侧悬浮按钮，页面加载即注入，一键打开/收起侧边栏
 * 4. DebugPanel — 调试面板 Tab，展示模块状态、实时日志、消息追踪、错误面板
 * 5. 从 chrome.runtime 获取模块列表（不硬编码模块名）
 * 6. 消息监听：接收 shell SW 消息（TOGGLE_SIDEBAR 等）
 */

(function () {
  'use strict';

  // ========== 全局常量 ==========
  const Z_MAX = 2147483647; // 最高层级，确保不被任何页面元素覆盖
  // ========== 防止在 iframe 中执行 ==========
  if (window.self !== window.top) return;

  // ========== 配置 ==========

  const CONFIG = {
    sidebarWidth: 420,
    position: 'left',  // A优化：改为左侧
    animDuration: 250,
    /** 已知模块目录名（用于 fetch module.json，无需硬编码元数据） */
    knownModules: ['report', 'dingtalk', 'tiaoke', 'updater', 'heatmap', 'dailyboard'],
  };

  // ========== 模块图标映射（统一定义）==========
  const ICON_MAP = { dashboard: '🏠', debug: '🔧', report: '📊', dingtalk: '🔗', tiaoke: '📚', updater: '🔄', heatmap: '🗓️', dailyboard: '📋' };

  // ========== Storage Key 常量 ==========
  const STORAGE_KEYS = {
    MODULE_REGISTRY: 'shell.module_registry',
    ENABLED_MODULES: 'shell.enabled_modules',
    REPORT_COUNT: 'report_count',
    STUDENT_COUNT: 'student_count',
    TIME_SAVED: 'time_saved',
    DINGTALK_DEDUP: 'dingtalk.dedupMode',
    TIAOKE_ROSTER: 'studentRoster',
    TIAOKE_CLASS_LIST: 'classListCache',
    TIAOKE_HISTORY: 'tiaokeHistory',
    SIDEBAR_VISIBLE: 'tb_sidebar_visible',
  };

  // ========== 动态版本号 ==========

  let VERSION = '0.0.0';
  try {
    VERSION = chrome.runtime.getManifest().version;
  } catch (e) { /* 忽略 */ }

  // ========== 状态 ==========

  let sidebarVisible = false;
  let activeTab = 'dashboard';
  let sidebarEl = null;
  let fabEl = null;
  /** @type {Object[]} 从 SW 获取的模块列表 */
  let moduleList = [];
  let _runtimeInvalidated = false;  // 标记 Runtime 是否已失效
  /** @type {Map<string, boolean>} 记录模块是否已加载（避免重复注入） */
  const loadedModules = new Map();
  /** 调试日志轮询定时器 */
  let debugPollTimer = null;

  // ========== Shadow Root 暴露 ==========

  /** 全局命名空间，供模块 content.js 获取自己的 Shadow Root */
  window.__shadowRoots__ = window.__shadowRoots__ || {};

  // ========== A: 创建悬浮按钮（页面加载即注入） ==========

  function createFloatingButton() {
    if (fabEl) return;
    const btn = document.createElement('div');
    btn.className = 'tb-fab';
    btn.title = '插件工作箱';
    btn.innerHTML = '<span class="tb-fab-arrow" style="display:inline-block;width:0;height:0;border-top:13px solid transparent;border-bottom:13px solid transparent;border-left:18px solid rgba(255,255,255,0.85);filter:drop-shadow(0 0 3px rgba(79,70,229,0.5));transition:transform 0.2s cubic-bezier(0.4,0,0.2,1);"></span>';
    btn.style.cssText = `
      position: fixed;
      left: 0;
      top: 50%;
      transform: translateY(-50%);
      z-index: ${Z_MAX};
      width: 30px;
      height: 40px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      user-select: none;
    `;
    btn.addEventListener('mouseenter', () => {
      const arrow = btn.querySelector('.tb-fab-arrow');
      if (arrow) { arrow.style.transform = 'scale(1.2)'; arrow.style.borderLeftColor = 'rgba(255,255,255,1)'; }
    });
    btn.addEventListener('mouseleave', () => {
      const arrow = btn.querySelector('.tb-fab-arrow');
      if (arrow) { arrow.style.transform = 'scale(1)'; arrow.style.borderLeftColor = 'rgba(255,255,255,0.85)'; }
    });
    btn.addEventListener('click', toggleSidebar);
    document.body.appendChild(btn);
    fabEl = btn;
  }

  // ========== 消息监听 ==========

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) return false;

    // 统一消息格式
    if (message.target === 'shell' && message.action === 'TOGGLE_SIDEBAR') {
      toggleSidebar();
      sendResponse({ success: true, visible: sidebarVisible });
      return false;
    }

    // 转发给当前激活模块（统一 target+action 格式）
    if (message.target && message.target !== 'shell' && activeTab === message.target) {
      if (window.__moduleMessageHandlers__) {
        const handler = window.__moduleMessageHandlers__[message.target];
        if (handler) {
          handler(message);
        }
      }
    }

    // ★ 转发模块 relay 消息（type 格式，无 target 字段）
    // 背景：模块 background.js 用 chrome.tabs.sendMessage 发 relay 消息到 content.js，
    // 格式为 {type: 'RELAY_REPORT_DATA', reportToken, data, error}，
    // 这类消息没有 target 字段，需要根据 type 识别并转发到对应模块 handler
    if (message.type && window.__moduleMessageHandlers__) {
      // RELAY_REPORT_DATA → report 模块
      if (message.type === 'RELAY_REPORT_DATA') {
        const handler = window.__moduleMessageHandlers__['report'];
        if (handler) {
          handler(message);
        }
      }
      // REPORT_PHONE_PROGRESS → report 模块（手机号获取进度）
      if (message.type === 'REPORT_PHONE_PROGRESS') {
        const handler = window.__moduleMessageHandlers__['report'];
        if (handler) {
          handler(message);
        }
      }
    }

    return false;
  });

  // ========== 侧边栏显隐 ==========

  /** 防止快速连续点击时重复创建 */
  let sidebarCreating = false;

  async function toggleSidebar() {
    // 防止创建过程中重复触发
    if (sidebarCreating) return;

    if (!sidebarEl) {
      sidebarCreating = true;
      try {
        await createSidebar();
      } catch (e) {
        console.error('[壳Content] 创建侧边栏失败:', e);
      } finally {
        sidebarCreating = false;
      }
    }

    if (sidebarVisible) {
      hideSidebar();
    } else {
      showSidebar();
    }
  }

  /** 点击侧边栏外部时关闭 */
  function onDocumentClick(e) {
    if (!sidebarEl || !sidebarVisible) return;
    // 点在侧边栏内部 → 不关
    if (sidebarEl.contains(e.target)) return;
    // 点在悬浮按钮上 → 不关（由 toggleSidebar 处理）
    if (fabEl && fabEl.contains(e.target)) return;
    // 点在下拉菜单 portal 上 → 不关（portal 挂在 body 上，不在 sidebar 内）
    const dropdown = document.getElementById('tb-nav-dropdown-portal');
    if (dropdown && dropdown.contains(e.target)) return;
    hideSidebar();
  }

  function showSidebar() {
    if (!sidebarEl) return;
    sidebarEl.style.transform = 'translateX(0)';
    sidebarVisible = true;
    document.body.style.overflow = 'hidden';
    // 悬浮按钮隐藏（侧边栏打开时不需要显示）
    if (fabEl) {
      fabEl.style.opacity = '0';
      fabEl.style.pointerEvents = 'none';
    }
    // 延迟绑定「点击外部关闭」，避免打开侧边栏的那次点击立即触发关闭
    // ⚠️ 用户要求：只有点关闭按钮才收起，禁用点外部自动收回
    // setTimeout(() => {
    //   document.addEventListener('click', onDocumentClick);
    // }, 0);
  }

  function hideSidebar() {
    if (!sidebarEl) return;
    const translate =
      CONFIG.position === 'right' ? 'translateX(100%)' : 'translateX(-100%)';
    sidebarEl.style.transform = translate;
    sidebarVisible = false;
    document.body.style.overflow = '';
    // 悬浮按钮恢复
    if (fabEl) {
      fabEl.style.opacity = '1';
      fabEl.style.pointerEvents = '';
    }
    // 移除外部点击监听
    document.removeEventListener('click', onDocumentClick);
  }

  // ========== SidebarUI：创建侧边栏 DOM ==========

  async function createSidebar() {
    const wrapper = document.createElement('div');
    wrapper.id = 'toolbox-sidebar';
    wrapper.className = 'toolbox-sidebar toolbox-' + CONFIG.position;

    const translate =
      CONFIG.position === 'right' ? 'translateX(100%)' : 'translateX(-100%)';
    // 左侧阴影在右边，右侧阴影在左边
    const shadowDir = CONFIG.position === 'right' ? '-4px 0 24px' : '4px 0 24px';
    wrapper.style.cssText = `
      position: fixed;
      top: 0;
      ${CONFIG.position}: 0;
      width: ${CONFIG.sidebarWidth}px;
      height: 100vh;
      background: #fff;
      z-index: ${Z_MAX - 1};
      box-shadow: ${shadowDir} rgba(0,0,0,0.08);
      transform: ${translate};
      transition: transform ${CONFIG.animDuration}ms cubic-bezier(0.4, 0, 0.2, 1);
      display: flex;
      flex-direction: column;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    `;

    // 生成 Tab HTML（首页 + 调试 + 动态模块 Tab）
    const navHtml = await buildNavHtml();
    // 生成面板 HTML
    const panelsHtml = await buildPanelsHtml();

    wrapper.innerHTML = `
      <!-- 头部 -->
      <div class="tb-header">
        <div class="tb-header-left">
          <span class="tb-logo">🧰</span>
          <div>
            <div class="tb-title">插件工作箱</div>
            <div class="tb-subtitle">辅导老师统一工作台</div>
          </div>
        </div>
        <button class="tb-close" title="收起">✕</button>
      </div>

      <!-- 导航 Tab（动态生成） -->
      <div class="tb-nav">${navHtml}</div>

      <!-- 内容区域 -->
      <div class="tb-content">${panelsHtml}</div>

      <!-- 底部状态栏 -->
      <div class="tb-footer">
        <span id="tb-status-text">就绪</span>
        <span style="color:#cbd5e1">|</span>
        <span>v${VERSION}</span>
      </div>
    `;

    document.body.appendChild(wrapper);
    sidebarEl = wrapper;

    // 绑定事件
    bindSidebarEvents(wrapper);

    // 初始化自适应 Tab 栏
    initAdaptiveNav();

    // 渲染首页仪表盘模块卡片
    renderDashboardCards();

    // 加载使用统计
    loadStats();

    console.log('[壳Content] 侧边栏已创建（左侧模式）');
  }

  /**
   * 动态构建导航 Tab HTML
   * 首页 Tab + 调试 Tab 固定，模块 Tab 从 moduleList 动态生成
   */
  async function buildNavHtml() {
    // 获取模块列表
    moduleList = await fetchModuleList();

    // 图标映射（使用全局 ICON_MAP）

    // 首页 Tab
    let html = `
      <div class="tb-tab active" data-tab="dashboard" title="首页">
        <span class="tb-tab-icon">${ICON_MAP.dashboard}</span>
        <span class="tb-tab-text">首页</span>
      </div>
    `;

    // 调试 Tab（C优化）
    html += `
      <div class="tb-tab" data-tab="debug" title="调试">
        <span class="tb-tab-icon">${ICON_MAP.debug}</span>
        <span class="tb-tab-text">调试</span>
      </div>
    `;

    // 模块 Tab
    for (const mod of moduleList) {
      if (!mod.enabled) continue;
      const icon = ICON_MAP[mod.name] || '📦';
      html += `
        <div class="tb-tab" data-tab="${mod.name}" title="${mod.label || mod.name}">
          <span class="tb-tab-icon">${icon}</span>
          <span class="tb-tab-text">${mod.label || mod.name}</span>
        </div>
      `;
    }

    // 更多 ▼ 按钮（初始隐藏）
    html += `
      <div class="tb-nav-more" title="更多">
        <span>更多</span>
        <span class="tb-nav-more-arrow">▼</span>
      </div>
    `;

    // 滚动提示遮罩
    html += `
      <div class="tb-nav-scroll-hint tb-nav-scroll-hint--left"></div>
      <div class="tb-nav-scroll-hint tb-nav-scroll-hint--right"></div>
    `;

    return html;
  }

  /**
   * 动态构建面板 HTML
   */
  async function buildPanelsHtml() {
    let html = `
      <!-- 首页仪表盘 -->
      <div class="tb-panel active" data-panel="dashboard">
        <div class="tb-dashboard">
          <div class="tb-welcome">
            <div class="tb-welcome-icon">👋</div>
            <div class="tb-welcome-text">
              <div class="tb-welcome-title">欢迎使用插件工作箱</div>
              <div class="tb-welcome-desc">选择下方模块开始工作</div>
            </div>
          </div>

          <div class="tb-section-title">📦 可用模块</div>
          <div class="tb-module-grid" id="tb-module-grid"></div>

          <div class="tb-section-title" style="margin-top:24px;">📈 使用统计</div>
          <div class="tb-stats">
            <div class="tb-stat-card">
              <div class="tb-stat-value" id="stat-reports">0</div>
              <div class="tb-stat-label">已分析报告</div>
            </div>
            <div class="tb-stat-card">
              <div class="tb-stat-value" id="stat-students">0</div>
              <div class="tb-stat-label">已处理学生</div>
            </div>
            <div class="tb-stat-card">
              <div class="tb-stat-value" id="stat-time">0min</div>
              <div class="tb-stat-label">累计节省时间</div>
            </div>
          </div>
        </div>
      </div>
    `;

    // 调试面板（C优化）
    html += `
      <!-- 调试面板 -->
      <div class="tb-panel" data-panel="debug">
        <div class="tb-debug-panel">
          <!-- 模块状态 -->
          <div class="tb-debug-section">
            <div class="tb-debug-section-title">📌 模块状态</div>
            <div id="debug-module-status" class="tb-debug-status-grid"></div>
          </div>
          <!-- 消息追踪 -->
          <div class="tb-debug-section">
            <div class="tb-debug-section-title">📨 消息追踪 <small style="color:var(--tb-text-muted)">(最近20条)</small></div>
            <div id="debug-message-trace" class="tb-debug-log-list"></div>
          </div>
          <!-- 实时日志 -->
          <div class="tb-debug-section">
            <div class="tb-debug-section-title">📝 实时日志 <small style="color:var(--tb-text-muted)">(最近50条)</small></div>
            <div id="debug-log-stream" class="tb-debug-log-list"></div>
          </div>
          <!-- 错误面板 -->
          <div class="tb-debug-section">
            <div class="tb-debug-section-title">❌ 错误 <small style="color:var(--tb-text-muted)">(最近10条)</small></div>
            <div id="debug-error-panel" class="tb-debug-log-list"></div>
          </div>
          <!-- 操作按钮 -->
          <div class="tb-debug-actions">
            <button class="tb-debug-btn" id="debug-refresh">🔄 刷新</button>
            <button class="tb-debug-btn tb-debug-btn-danger" id="debug-clear-logs">🗑️ 清空日志</button>
            <button class="tb-debug-btn" id="debug-export-logs">📋 导出日志</button>
          </div>
        </div>
      </div>
    `;

    // 模块面板（Shadow DOM 容器）
    for (const mod of moduleList) {
      if (!mod.enabled) continue;
      html += `
        <div class="tb-panel" data-panel="${mod.name}">
          <div class="tb-shadow-container" id="shadow-host-${mod.name}"></div>
        </div>
      `;
    }

    return html;
  }

  // ========== 事件绑定 ==========

  function bindSidebarEvents(wrapper) {
    // 关闭按钮
    wrapper.querySelector('.tb-close').addEventListener('click', hideSidebar);

    // Tab 切换
    wrapper.querySelectorAll('.tb-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        switchTab(tab.dataset.tab);
      });
    });

    // 首页模块卡片点击（事件委托）
    const grid = wrapper.querySelector('#tb-module-grid');
    if (grid) {
      grid.addEventListener('click', (e) => {
        const card = e.target.closest('.tb-module-card');
        if (card) {
          const moduleName = card.dataset.module;
          switchTab(moduleName);
        }
      });
    }

    // 调试面板按钮绑定（C优化）
    const btnRefresh = wrapper.querySelector('#debug-refresh');
    if (btnRefresh) btnRefresh.addEventListener('click', refreshDebugPanel);

    const btnClear = wrapper.querySelector('#debug-clear-logs');
    if (btnClear) btnClear.addEventListener('click', clearDebugLogs);

    const btnExport = wrapper.querySelector('#debug-export-logs');
    if (btnExport) btnExport.addEventListener('click', exportDebugLogs);
  }

  // ========== Tab 切换 ==========

  function switchTab(tabName) {
    if (!sidebarEl) return;

    // 更新 Tab 高亮
    sidebarEl.querySelectorAll('.tb-tab').forEach((t) => {
      t.classList.toggle('active', t.dataset.tab === tabName);
    });

    // 更新面板显示（所有 Tab 统一处理）
    sidebarEl.querySelectorAll('.tb-panel').forEach((p) => {
      p.classList.toggle('active', p.dataset.panel === tabName);
    });

    activeTab = tabName;

    // 离开每日看板时，关闭看板面板（恢复页面布局）
    if (activeTab !== 'dailyboard' && window.__db && typeof window.__db.close === 'function') {
      window.__db.close();
    }

    // 关闭下拉菜单（portal 挂在 body 上）
    const dropdown = document.getElementById('tb-nav-dropdown-portal');
    if (dropdown) dropdown.style.display = 'none';

    // 重新计算自适应布局（因为 active tab 可能需要从 dropdown 移出）
    if (typeof recalcAdaptiveNav === 'function') recalcAdaptiveNav();

    // 首页无需加载模块
    if (tabName === 'dashboard') {
      updateStatus('就绪');
      return;
    }

    // 调试面板：切换时刷新数据 + 启动轮询
    if (tabName === 'debug') {
      updateStatus('调试中');
      refreshDebugPanel();
      startDebugPolling();
      return;
    } else {
      stopDebugPolling();
    }

    // 每日看板：侧边栏切到「学习报告分析」tab，面板紧跟侧边栏右侧弹出
    if (tabName === 'dailyboard') {
      // 切换侧边栏到报告模块（保证两侧独立使用，互不影响）
      sidebarEl.querySelectorAll('.tb-tab').forEach(function(t) {
        t.classList.toggle('active', t.dataset.tab === 'report');
      });
      sidebarEl.querySelectorAll('.tb-panel').forEach(function(p) {
        p.classList.toggle('active', p.dataset.panel === 'report');
      });
      activeTab = 'report';  // 侧边栏实际状态
      // 加载报告模块（如果还没加载）
      if (!loadedModules.has('report')) {
        updateStatus('正在加载学习报告分析...');
        loadModule('report');
      }
      updateStatus('每日看板已打开 · 左侧报告分析可独立使用');
      if (window.location.hostname.includes('ai-genesis.yuaiweiwu.com')) {
        injectDailyboardModule();
      } else {
        alert('每日看板需要在爱芯后台页面（ai-genesis.yuaiweiwu.com）使用');
      }
      return;
    }

    // 模块 Tab：懒加载模块（首次点击时加载，后续用 display 切换保留状态）
    if (!loadedModules.has(tabName)) {
      updateStatus(`正在加载「${getModuleLabel(tabName)}」...`);
      loadModule(tabName);
    } else {
      updateStatus(`「${getModuleLabel(tabName)}」已就绪`);
    }
  }

  // ========== 自适应 Tab 栏 ==========

  /** 防抖工具函数 */
  function debounce(fn, ms) {
    let timer = null;
    return function (...args) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  /** 更新滚动遮罩可见性 */
  function updateScrollHints(nav) {
    if (!nav) return;
    const leftHint = nav.querySelector('.tb-nav-scroll-hint--left');
    const rightHint = nav.querySelector('.tb-nav-scroll-hint--right');
    const maxScroll = nav.scrollWidth - nav.clientWidth;

    if (leftHint) {
      leftHint.style.opacity = nav.scrollLeft > 2 ? '1' : '0';
    }
    if (rightHint) {
      rightHint.style.opacity = nav.scrollLeft < maxScroll - 2 ? '1' : '0';
    }
  }

  /** recalcAdaptiveNav 的引用，供 switchTab 调用 */
  let recalcAdaptiveNav = null;

  /** 初始化自适应 Tab 栏逻辑 */
  function initAdaptiveNav() {
    const nav = sidebarEl ? sidebarEl.querySelector('.tb-nav') : null;
    if (!nav) return;

    const tabs = Array.from(nav.querySelectorAll('.tb-tab[data-tab]'));
    const moreBtn = nav.querySelector('.tb-nav-more');

    // 下拉菜单挂到 document.body，避免被 overflow:auto 容器剪切
    let dropdown = document.getElementById('tb-nav-dropdown-portal');
    if (!dropdown) {
      dropdown = document.createElement('div');
      dropdown.id = 'tb-nav-dropdown-portal';
      dropdown.className = 'tb-nav-dropdown';
      // Portal 挂在 document.body 上，无法继承 #toolbox-sidebar 内的 CSS 变量
      // 必须显式设置 z-index，否则会被 sidebar（z-index: 2147483646）遮挡
      dropdown.style.zIndex = String(Z_MAX);
      document.body.appendChild(dropdown);
    }

    /** 图标映射（使用全局 ICON_MAP）*/

    /** 获取 tab 名称的标签文本 */
    function getTabLabel(tabName) {
      const mod = moduleList.find((m) => m.name === tabName);
      if (mod) return mod.label || mod.name;
      if (tabName === 'dashboard') return '首页';
      if (tabName === 'debug') return '调试';
      return tabName;
    }

    /** 核心：重新计算自适应布局 */
    function recalc() {
      // 1. 重置所有 tab 为正常状态
      tabs.forEach((tab) => {
        tab.classList.remove('tb-tab--icon-only', 'tb-tab--compact');
        tab.style.display = '';
      });

      // 2. 清空 dropdown，隐藏 moreBtn
      if (dropdown) dropdown.innerHTML = '';
      if (moreBtn) moreBtn.style.display = 'none';

      // 3. 计算 nav 可用宽度（扣除 padding 和 moreBtn 占位预留）
      const navAvailable = nav.clientWidth;

      // 4. 计算所有 tab 的总宽度
      let totalWidth = 0;
      const tabWidths = tabs.map((tab) => {
        // 临时显示以确保 offsetWidth 准确
        tab.style.display = '';
        tab.classList.remove('tb-tab--icon-only', 'tb-tab--compact');
        const w = tab.offsetWidth;
        totalWidth += w;
        return w;
      });

      // 5. 如果总宽度 <= 可用宽度，无需适配
      if (totalWidth <= navAvailable) {
        if (moreBtn) moreBtn.style.display = 'none';
        updateScrollHints(nav);
        return;
      }

      // 6. 需要适配：预留 moreBtn 宽度
      if (moreBtn) moreBtn.style.display = 'flex';
      const moreBtnWidth = moreBtn ? moreBtn.offsetWidth : 60;
      const targetWidth = navAvailable - moreBtnWidth;

      // 7. 从右往左，依次给 tab 添加 icon-only 模式（保留 active tab 文字）
      let currentWidth = 0;
      let iconOnlyStartIndex = -1;

      for (let i = 0; i < tabs.length; i++) {
        currentWidth += tabWidths[i];
        if (currentWidth > targetWidth) {
          iconOnlyStartIndex = i;
          break;
        }
      }

      if (iconOnlyStartIndex >= 0) {
        // === 策略：active tab 优先保留，其余从右往左压缩/移入 dropdown ===
        const activeTabName = activeTab;

        // 第一步：从 iconOnlyStartIndex 开始给 tab 加 icon-only
        for (let i = iconOnlyStartIndex; i < tabs.length; i++) {
          tabs[i].classList.add('tb-tab--icon-only');
        }

        // 第二步：重新累加宽度，找出放不下的 tab（从右往左移入 dropdown）
        // 需要收集哪些 tab 要移入 dropdown
        const hiddenTabNames = new Set();

        // 从右往左检查，直到总宽度满足 targetWidth
        let runningWidth = 0;
        for (let i = 0; i < tabs.length; i++) {
          runningWidth += tabs[i].offsetWidth;
        }

        for (let i = tabs.length - 1; i >= 0 && runningWidth > targetWidth; i--) {
          const tab = tabs[i];
          const tabName = tab.dataset.tab;
          // active tab 跳过，不移入 dropdown
          if (tabName === activeTabName) continue;
          hiddenTabNames.add(tabName);
          runningWidth -= tabs[i].offsetWidth;
        }

        // 第三步：执行隐藏并填入 dropdown
        let hasDropdownItems = false;
        for (let i = 0; i < tabs.length; i++) {
          const tab = tabs[i];
          const tabName = tab.dataset.tab;
          if (hiddenTabNames.has(tabName)) {
            tab.style.display = 'none';
            if (dropdown) {
              const icon = ICON_MAP[tabName] || '📦';
              const itemEl = document.createElement('div');
              itemEl.className = 'tb-nav-dropdown-item';
              itemEl.dataset.tab = tabName;
              itemEl.innerHTML = `<span>${icon}</span><span>${getTabLabel(tabName)}</span>`;
              dropdown.appendChild(itemEl);
              hasDropdownItems = true;
            }
          }
        }

        // 更多按钮：有 dropdown 项才显示
        if (moreBtn) {
          if (hasDropdownItems) {
            moreBtn.style.display = 'flex';
            moreBtn.classList.remove('active');
          } else {
            moreBtn.style.display = 'none';
          }
        }
      }

      updateScrollHints(nav);
    }

    // 保存引用供 switchTab 使用
    recalcAdaptiveNav = recalc;

    // 监听滚动更新遮罩
    nav.addEventListener('scroll', () => updateScrollHints(nav));

    // 监听窗口 resize（防抖）
    window.addEventListener('resize', debounce(recalc, 150));

    // 下拉菜单点击
    if (dropdown) {
      dropdown.addEventListener('click', (e) => {
        const item = e.target.closest('.tb-nav-dropdown-item');
        if (item) {
          switchTab(item.dataset.tab);
          dropdown.style.display = 'none';
        }
      });
    }

    // 更多按钮点击
    if (moreBtn) {
      moreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isVisible = dropdown.style.display === 'block';
        if (isVisible) {
          dropdown.style.display = 'none';
        } else {
          // 定位到 moreBtn 正下方
          const rect = moreBtn.getBoundingClientRect();
          dropdown.style.top = (rect.bottom + 4) + 'px';
          dropdown.style.left = Math.max(4, rect.right - 140) + 'px';
          dropdown.style.display = 'block';
        }
      });
    }

    // 点击外部关闭下拉
    document.addEventListener('click', (e) => {
      if (dropdown && !dropdown.contains(e.target) && e.target !== moreBtn && !moreBtn?.contains(e.target)) {
        dropdown.style.display = 'none';
      }
    });

    // 首次计算
    recalc();
  }

  // ========== C: 调试面板 ==========

  function startDebugPolling() {
    stopDebugPolling();
    debugPollTimer = setInterval(refreshDebugPanel, 2000);
  }

  function stopDebugPolling() {
    if (debugPollTimer) {
      clearInterval(debugPollTimer);
      debugPollTimer = null;
    }
  }

  async function refreshDebugPanel() {
    try {
      // 向 SW 请求调试数据
      const resp = await chrome.runtime.sendMessage({
        target: 'shell',
        action: 'DEBUG_GET_LOGS',
      });
      if (resp && resp.success) {
        renderModuleStatus(resp.data.moduleStatus || {});
        renderMessageTrace(resp.data.messages || []);
        renderLogStream(resp.data.logs || []);
        renderErrorPanel(resp.data.errors || []);
      }
    } catch (e) {
      // SW 可能未就绪，静默处理
    }
  }

  function renderModuleStatus(statusMap) {
    const container = document.getElementById('debug-module-status');
    if (!container) return;

    const entries = Object.entries(statusMap);
    if (entries.length === 0) {
      container.innerHTML = '<div style="color:var(--tb-text-muted);font-size:12px;padding:8px;">等待数据...</div>';
      return;
    }

    container.innerHTML = entries.map(([name, info]) => {
      const ok = info.online !== false;
      const statusText = ok ? '● 在线' : '● 离线';
      const statusColor = ok ? '#16a34a' : '#dc2626';
      return `
        <div class="tb-debug-status-item">
          <span class="tb-debug-status-dot" style="color:${statusColor}">${statusText}</span>
          <span class="tb-debug-status-name">${name}</span>
          ${info.version ? `<span class="tb-debug-status-ver">${info.version}</span>` : ''}
        </div>
      `;
    }).join('');
  }

  function renderMessageTrace(messages) {
    const container = document.getElementById('debug-message-trace');
    if (!container) return;

    if (messages.length === 0) {
      container.innerHTML = '<div style="color:var(--tb-text-muted);font-size:12px;padding:8px;">暂无消息</div>';
      return;
    }

    container.innerHTML = messages.slice(-20).reverse().map(msg => {
      const time = msg.time ? new Date(msg.time).toLocaleTimeString() : '--:--:--';
      const isError = msg.error;
      return `
        <div class="tb-debug-log-item ${isError ? 'tb-debug-log-error' : ''}">
          <span class="tb-debug-log-time">${time}</span>
          <span class="tb-debug-log-action">${msg.action || msg.type || '?'}</span>
          <span class="tb-debug-log-target">${msg.target || '-'}</span>
          ${isError ? `<span class="tb-debug-log-err">${msg.error}</span>` : ''}
        </div>
      `;
    }).join('');
  }

  function renderLogStream(logs) {
    const container = document.getElementById('debug-log-stream');
    if (!container) return;

    if (logs.length === 0) {
      container.innerHTML = '<div style="color:var(--tb-text-muted);font-size:12px;padding:8px;">暂无日志</div>';
      return;
    }

    container.innerHTML = logs.slice(-50).reverse().map(log => {
      const time = log.time ? new Date(log.time).toLocaleTimeString() : '--:--:--';
      const level = log.level || 'log';
      const colorClass = level === 'error' ? 'tb-debug-log-error' : level === 'warn' ? 'tb-debug-log-warn' : '';
      return `
        <div class="tb-debug-log-item ${colorClass}">
          <span class="tb-debug-log-time">${time}</span>
          <span class="tb-debug-log-source">[${log.source || 'shell'}]</span>
          <span class="tb-debug-log-msg">${escapeHtml(log.message || log.msg || '')}</span>
        </div>
      `;
    }).join('');
  }

  function renderErrorPanel(errors) {
    const container = document.getElementById('debug-error-panel');
    if (!container) return;

    if (errors.length === 0) {
      container.innerHTML = '<div style="color:#16a34a;font-size:12px;padding:8px;">✅ 无错误</div>';
      return;
    }

    container.innerHTML = errors.slice(-10).reverse().map(err => {
      const time = err.time ? new Date(err.time).toLocaleTimeString() : '--:--:--';
      return `
        <div class="tb-debug-log-item tb-debug-log-error">
          <span class="tb-debug-log-time">${time}</span>
          <span class="tb-debug-log-source">[${err.source || '?'}]</span>
          <span class="tb-debug-log-err">${escapeHtml(err.message || err.msg || '')}</span>
          ${err.stack ? `<div class="tb-debug-log-stack">${escapeHtml(err.stack)}</div>` : ''}
        </div>
      `;
    }).join('');
  }

  async function clearDebugLogs() {
    try {
      await chrome.runtime.sendMessage({
        target: 'shell',
        action: 'DEBUG_CLEAR_LOGS',
      });
      // 立即清空 UI
      const ids = ['debug-message-trace', 'debug-log-stream', 'debug-error-panel'];
      ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '<div style="color:var(--tb-text-muted);font-size:12px;padding:8px;">已清空</div>';
      });
    } catch (e) { /* 静默 */ }
  }

  function exportDebugLogs() {
    // 复制调试面板内容到剪贴板
    const panels = {
      moduleStatus: document.getElementById('debug-module-status')?.innerText || '',
      messageTrace: document.getElementById('debug-message-trace')?.innerText || '',
      logs: document.getElementById('debug-log-stream')?.innerText || '',
      errors: document.getElementById('debug-error-panel')?.innerText || '',
    };
    const text = Object.entries(panels)
      .filter(([, v]) => v)
      .map(([k, v]) => `=== ${k} ===\n${v}`)
      .join('\n\n');
    navigator.clipboard.writeText(text).then(() => {
      updateStatus('日志已复制到剪贴板');
    }).catch(() => {
      updateStatus('复制失败');
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ========== ModuleLoader：懒加载模块 ==========

  /**
   * 加载模块到 Shadow DOM
   */
  async function loadModule(moduleName) {
    const hostContainer = document.getElementById(`shadow-host-${moduleName}`);
    if (!hostContainer) {
      console.error(`[壳Content] 找不到 Shadow DOM 宿主: shadow-host-${moduleName}`);
      return;
    }

    // 创建 Shadow DOM
    const shadowRoot = hostContainer.attachShadow({ mode: 'open' });

    // 暴露给模块
    window.__shadowRoots__[moduleName] = shadowRoot;

    // 先显示加载占位
    shadowRoot.innerHTML = `
      <div style="padding:32px;text-align:center;color:#94a3b8;">
        <div class="tb-spinner" style="margin:0 auto 12px;"></div>
        正在加载「${getModuleLabel(moduleName)}」...
      </div>
    `;

    try {
      // 获取模块元数据
      const meta = moduleList.find((m) => m.name === moduleName);
      if (!meta) {
        throw new Error(`模块 ${moduleName} 不在模块列表中`);
      }

      // fetch module.json 获取 CSS 入口
      const metaJsonUrl = chrome.runtime.getURL(
        `modules/${moduleName}/module.json`
      );
      const metaResp = await fetch(metaJsonUrl);
      const metaJson = await metaResp.json();

      // 注入模块 CSS 到 Shadow Root
      const cssEntry = metaJson.entry && metaJson.entry.css;
      if (cssEntry) {
        const cssUrl = chrome.runtime.getURL(`modules/${moduleName}/${cssEntry}`);
        const cssResp = await fetch(cssUrl);
        if (cssResp.ok) {
          const cssText = await cssResp.text();
          // 忽略仅含注释的空 CSS 文件
          if (cssText.trim() && !cssText.trim().startsWith('/*') || cssText.includes('{')) {
            const styleEl = document.createElement('style');
            styleEl.textContent = cssText;
            shadowRoot.appendChild(styleEl);
          }
        }
      }

      // 加载并执行模块 content.js
      // 使用动态 import() 而非 new Function()，避免触发 CSP 'unsafe-eval' 限制
      const jsEntry = metaJson.entry && metaJson.entry.content;
      if (jsEntry) {
        const jsUrl = chrome.runtime.getURL(`modules/${moduleName}/${jsEntry}`);
        await import(jsUrl);
        console.log(`[壳Content] 模块 ${moduleName} content.js 加载成功`);
      }

      // 标记为已加载
      loadedModules.set(moduleName, true);
      updateStatus(`「${getModuleLabel(moduleName)}」已就绪`);
    } catch (e) {
      console.error(`[壳Content] 加载模块 ${moduleName} 失败:`, e);
      shadowRoot.innerHTML = `
        <div style="padding:32px;text-align:center;color:#ef4444;">
          <div style="font-size:32px;margin-bottom:12px;">❌</div>
          <div>加载「${getModuleLabel(moduleName)}」失败</div>
          <div style="font-size:12px;color:#94a3b8;margin-top:8px;">${e.message}</div>
        </div>
      `;
      updateStatus(`模块加载失败`);
    }
  }

  /**
   * 注入每日看板模块到宿主页面（而非侧边栏 Shadow DOM）
   * 每日看板需要创建右侧面板，直接操作宿主页面 DOM
   */
  async function injectDailyboardModule() {
    try {
      console.log('[壳Content] 开始注入每日看板模块...');
      const jsUrl = chrome.runtime.getURL('modules/dailyboard/content.js');
      console.log('[壳Content] import:', jsUrl);
      await import(jsUrl);
      console.log('[壳Content] 模块文件加载完成, window.__db=', typeof window.__db);
      // content.js 注册了 window.__db，调用 open()
      if (window.__db && typeof window.__db.open === 'function') {
        window.__db.open();
      } else {
        console.error('[壳Content] window.__db 未定义或缺少 open 方法');
      }
    } catch (e) {
      console.error('[壳Content] 注入每日看板失败:', e);
      alert('每日看板加载失败：' + e.message);
    }
  }

  // ========== 首页仪表盘 ==========

  function renderDashboardCards() {
    const grid = document.getElementById('tb-module-grid');
    if (!grid) return;

    const enabledModules = moduleList.filter((m) => m.enabled);
    if (enabledModules.length === 0) {
      grid.innerHTML =
        '<div style="text-align:center;color:#94a3b8;padding:16px;font-size:13px;">暂无可用模块</div>';
      return;
    }

    // 模块颜色映射
    const colorMap = { report: '#4f46e5', dingtalk: '#2563eb', tiaoke: '#d97706' };
    // 图标映射（使用全局 ICON_MAP）

    grid.innerHTML = enabledModules
      .map((mod) => {
        const color = colorMap[mod.name] || '#4f46e5';
        const icon = ICON_MAP[mod.name] || '📦';
        return `
        <div class="tb-module-card" data-module="${mod.name}">
          <div class="tb-module-card-icon" style="background:${color}15;color:${color}">
            ${icon}
          </div>
          <div class="tb-module-card-info">
            <div class="tb-module-card-name">${mod.label || mod.name}</div>
            <div class="tb-module-card-desc">${mod.description}</div>
          </div>
          <span class="tb-module-badge tb-module-badge-ready">点击使用</span>
        </div>
      `;
      })
      .join('');
  }

  // ========== 使用统计 ==========

  async function loadStats() {
    try {
      const resp = await chrome.storage.local.get([
        'report_count',
        'student_count',
        'time_saved',
      ]);
      const reportCount = document.getElementById('stat-reports');
      const studentCount = document.getElementById('stat-students');
      const timeSaved = document.getElementById('stat-time');

      if (reportCount) reportCount.textContent = resp.report_count || 0;
      if (studentCount) studentCount.textContent = resp.student_count || 0;
      if (timeSaved) timeSaved.textContent = (resp.time_saved || 0) + 'min';
    } catch (e) {
      console.log('[壳Content] 加载统计失败:', e);
    }
  }

  // ========== 工具函数 ==========

  /**
   * 从 SW 获取模块列表
   */
  async function fetchModuleList() {
    // 如果 Runtime 已失效，直接返回空数组
    if (_runtimeInvalidated) return [];

    try {
      const resp = await chrome.runtime.sendMessage({
        target: 'shell',
        action: 'GET_MODULE_LIST',
      });
      if (resp && resp.success) {
        return resp.data || [];
      }
    } catch (e) {
      // 检测 Extension context invalidated
      if (e.message && e.message.indexOf('Extension context invalidated') >= 0) {
        console.warn('[壳Content] 扩展上下文已失效，显示恢复界面');
        _runtimeInvalidated = true;
        showContextInvalidatedUI();
        return [];
      }
      console.warn('[壳Content] 获取模块列表失败:', e);
    }

    // 降级：逐一 fetch module.json
    const modules = [];
    for (const name of CONFIG.knownModules) {
      try {
        const url = chrome.runtime.getURL(`modules/${name}/module.json`);
        const resp = await fetch(url);
        if (resp.ok) {
          const meta = await resp.json();
          modules.push({ ...meta, name: meta.name || name });
        }
      } catch {
        // 也不行了就打住
        if (!_runtimeInvalidated) {
          _runtimeInvalidated = true;
          showContextInvalidatedUI();
        }
        return modules;  // 返回已收集到的
      }
    }
    return modules;
  }

  /**
   * Runtime 失效时显示恢复 UI
   */
  function showContextInvalidatedUI() {
    // 在 sidebar 主区域显示恢复界面
    const content = sidebarEl ? sidebarEl.querySelector('.tb-content') : null;
    const target = content || document.querySelector('#toolbox-sidebar .tb-content');
    if (!target) return;

    // 覆盖 target 内容
    target.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:32px;text-align:center;color:#64748b;">
        <div style="font-size:48px;margin-bottom:16px;">🔄</div>
        <div style="font-size:16px;font-weight:600;color:#334155;margin-bottom:8px;">扩展已重新加载</div>
        <div style="font-size:13px;line-height:1.6;margin-bottom:20px;">
          install.bat 注册 Native Host 后<br>浏览器自动刷新了扩展服务<br>
          请点击下方按钮刷新页面即可恢复
        </div>
        <button onclick="location.reload()"
          style="background:#3b82f6;color:#fff;border:none;padding:10px 24px;border-radius:8px;font-size:14px;cursor:pointer;font-weight:500;">
          🔄 刷新页面
        </button>
        <div style="font-size:11px;color:#94a3b8;margin-top:12px;">或按 F5 / Ctrl+R 刷新</div>
      </div>
    `;

    // 同时更新状态栏
    updateStatus('⚠️ 扩展已重载，请刷新页面');

    // 隐藏 Tab 导航
    const nav = document.querySelector('.tb-nav');
    if (nav) nav.style.display = 'none';
  }

  /**
   * 获取模块显示名称
   */
  function getModuleLabel(name) {
    const mod = moduleList.find((m) => m.name === name);
    return mod ? mod.label || mod.name : name;
  }

  /**
   * 更新状态栏文字
   */
  function updateStatus(text) {
    const el = document.getElementById('tb-status-text');
    if (el) el.textContent = text;
  }

  // ========== 初始化 ==========

  // A优化：页面加载立即注入悬浮按钮（不再等待 popup 消息）
  createFloatingButton();

  console.log(`[壳Content] 插件工作箱 v${VERSION} content.js 已加载（左侧悬浮按钮模式）`);

})();
