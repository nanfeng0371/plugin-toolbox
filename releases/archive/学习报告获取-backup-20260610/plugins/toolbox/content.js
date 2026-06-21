/**
 * 插件工作箱 - Content Script
 * 
 * 职责：
 * 1. 注入统一侧边栏 UI
 * 2. 首页仪表盘（模块卡片 + Tab 切换框架）
 * 3. 模块加载器（iframe 方式隔离）
 * 4. 与 background.js 通信
 */

(function() {
  'use strict';

  // ========== 配置 ==========
  const CONFIG = {
    sidebarWidth: 420,
    position: 'right',
    animDuration: 250
  };

  // ========== 状态 ==========
  let sidebarVisible = false;
  let activeModule = null;   // 当前激活的模块ID
  let sidebarEl = null;

  // ========== 模块元数据（与 background.js 同步） ==========
  const MODULES = {
    report: {
      id: 'report',
      name: '学习报告批量分析',
      icon: '📊',
      description: '批量获取学生听课质量报告，自动生成四维评价分析',
      version: '5.1.1',
      color: '#4f46e5',
      status: 'available'
    },
    schedule: {
      id: 'schedule',
      name: '调课助手',
      icon: '📅',
      description: '快速调课、补课安排、课时统计',
      version: '-',
      color: '#0891b2',
      status: 'coming_soon'
    },
    dingtalk: {
      id: 'dingtalk',
      name: '钉钉数据提取',
      icon: '🔗',
      description: '从钉钉群提取聊天记录和作业数据',
      version: '-',
      color: '#2563eb',
      status: 'coming_soon'
    }
  };

  // ========== 消息监听 ==========
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const { type, moduleId } = message || {};

    if (type === 'TOGGLE_SIDEBAR') {
      toggleSidebar();
      sendResponse({ success: true, visible: sidebarVisible });
      return;
    }

    if (type === 'RELAY_FROM_SW') {
      // 来自 SW 的中继消息，转发到当前激活的模块
      relayToModule(message);
      sendResponse({ success: true });
      return;
    }

    return false;
  });

  // ========== 侧边栏主逻辑 ==========

  function toggleSidebar() {
    if (!sidebarEl) {
      createSidebar();
    }
    
    if (sidebarVisible) {
      hideSidebar();
    } else {
      showSidebar();
    }
  }

  function showSidebar() {
    if (!sidebarEl) return;
    sidebarEl.style.transform = 'translateX(0)';
    sidebarVisible = true;
    document.body.style.overflow = 'hidden';
  }

  function hideSidebar() {
    if (!sidebarEl) return;
    const translate = CONFIG.position === 'right' ? 'translateX(100%)' : 'translateX(-100%)';
    sidebarEl.style.transform = translate;
    sidebarVisible = false;
    document.body.style.overflow = '';
  }

  // ========== 创建侧边栏 DOM ==========

  function createSidebar() {
    const wrapper = document.createElement('div');
    wrapper.id = 'toolbox-sidebar';
    wrapper.className = 'toolbox-sidebar toolbox-' + CONFIG.position;

    const translate = CONFIG.position === 'right' ? 'translateX(100%)' : 'translateX(-100%)';
    wrapper.style.cssText = `
      position: fixed;
      top: 0;
      ${CONFIG.position}: 0;
      width: ${CONFIG.sidebarWidth}px;
      height: 100vh;
      background: #fff;
      z-index: 2147483646;
      box-shadow: -4px 0 24px rgba(0,0,0,0.08);
      transform: ${translate};
      transition: transform ${CONFIG.animDuration}ms cubic-bezier(0.4, 0, 0.2, 1);
      display: flex;
      flex-direction: column;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    `;

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

      <!-- 导航 Tab -->
      <div class="tb-nav">
        <div class="tb-tab active" data-tab="dashboard">
          <span class="tb-tab-icon">🏠</span>
          <span>首页</span>
        </div>
        <div class="tb-tab" data-tab="report">
          <span class="tb-tab-icon">📊</span>
          <span>学习报告</span>
        </div>
        <div class="tb-tab" data-tab="schedule">
          <span class="tb-tab-icon">📅</span>
          <span>调课助手</span>
        </div>
        <div class="tb-tab" data-tab="dingtalk">
          <span class="tb-tab-icon">🔗</span>
          <span>钉钉提取</span>
        </div>
      </div>

      <!-- 内容区域 -->
      <div class="tb-content">
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

        <!-- 学习报告模块面板 -->
        <div class="tb-panel" data-panel="report">
          <div class="tb-module-loading">
            <div class="tb-spinner"></div>
            <div>正在加载学习报告模块...</div>
          </div>
        </div>

        <!-- 调课助手模块面板 -->
        <div class="tb-panel" data-panel="schedule">
          <div class="tb-empty-state">
            <div class="tb-empty-icon">🚧</div>
            <div class="tb-empty-title">调课助手</div>
            <div class="tb-empty-desc">该模块正在开发中，敬请期待</div>
            <div class="tb-empty-version">预计上线：v1.1.0</div>
          </div>
        </div>

        <!-- 钉钉提取模块面板 -->
        <div class="tb-panel" data-panel="dingtalk">
          <div class="tb-empty-state">
            <div class="tb-empty-icon">🚧</div>
            <div class="tb-empty-title">钉钉数据提取</div>
            <div class="tb-empty-desc">该模块正在开发中，敬请期待</div>
            <div class="tb-empty-version">预计上线：v1.2.0</div>
          </div>
        </div>
      </div>

      <!-- 底部状态栏 -->
      <div class="tb-footer">
        <span id="tb-status-text">就绪</span>
        <span style="color:#cbd5e1">|</span>
        <span>v1.0.0</span>
      </div>
    `;

    document.body.appendChild(wrapper);
    sidebarEl = wrapper;

    // 绑定事件
    bindSidebarEvents(wrapper);
    
    // 渲染模块卡片
    renderModuleCards();
    
    // 加载使用统计
    loadStats();
  }

  // ========== 绑定事件 ==========

  function bindSidebarEvents(wrapper) {
    // 关闭按钮
    wrapper.querySelector('.tb-close').addEventListener('click', hideSidebar);

    // Tab 切换
    wrapper.querySelectorAll('.tb-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const tabName = tab.dataset.tab;
        switchTab(tabName);
      });
    });

    // 点击模块卡片（通过事件委托）
    wrapper.querySelector('.tb-module-grid').addEventListener('click', (e) => {
      const card = e.target.closest('.tb-module-card');
      if (card) {
        const moduleId = card.dataset.module;
        activateModule(moduleId);
      }
    });
  }

  // ========== Tab 切换 ==========

  function switchTab(tabName) {
    if (!sidebarEl) return;

    // 更新 Tab 样式
    sidebarEl.querySelectorAll('.tb-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === tabName);
    });

    // 更新面板显示
    sidebarEl.querySelectorAll('.tb-panel').forEach(p => {
      p.classList.toggle('active', p.dataset.panel === tabName);
    });

    // 如果切到模块面板，自动激活对应模块
    if (tabName !== 'dashboard') {
      activateModule(tabName);
    }
  }

  // ========== 模块激活 ==========

  async function activateModule(moduleId) {
    const mod = MODULES[moduleId];
    if (!mod) return;

    // 更新 Tab 高亮
    if (sidebarEl) {
      sidebarEl.querySelectorAll('.tb-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === moduleId);
      });
      sidebarEl.querySelectorAll('.tb-panel').forEach(p => {
        p.classList.toggle('active', p.dataset.panel === moduleId);
      });
    }

    activeModule = moduleId;

    // 更新状态栏
    updateStatus(`正在加载「${mod.name}」...`);

    // 如果模块是 available，尝试加载
    if (mod.status === 'available') {
      await loadModule(moduleId);
    } else if (mod.status === 'coming_soon') {
      updateStatus(`${mod.name} 即将上线`);
    }
  }

  // ========== 加载模块 ==========

  async function loadModule(moduleId) {
    const panel = sidebarEl?.querySelector(`[data-panel="${moduleId}"]`);
    if (!panel) return;

    // 学习报告模块特殊处理：嵌入 iframe 加载原扩展
    if (moduleId === 'report') {
      // 检查是否在工作台页面
      const isWorkPage = location.hostname === 'ai-genesis.yuaiweiwu.com';
      
      if (!isWorkPage) {
        panel.innerHTML = `
          <div class="tb-empty-state">
            <div class="tb-empty-icon">📋</div>
            <div class="tb-empty-title">学习报告批量分析</div>
            <div class="tb-empty-desc">请前往「辅导工作台」页面使用此功能</div>
            <div style="margin-top:16px;font-size:13px;color:#64748b;">
              当前页面：<code style="background:#f1f5f9;padding:2px 6px;border-radius:4px;">${location.hostname}</code>
            </div>
          </div>
        `;
        updateStatus('请切换到工作台页面');
        return;
      }

      // 在工作台页面：直接注入学习报告扩展的内容脚本逻辑
      panel.innerHTML = `
        <div class="tb-module-frame" id="report-frame-container">
          <div style="padding:16px;text-align:center;color:#94a3b8;">
            <div class="tb-spinner" style="margin:0 auto 12px;"></div>
            正在初始化学习报告分析器...
          </div>
        </div>
      `;

      // 动态加载学习报告模块的代码
      try {
        await injectReportModule(panel.querySelector('#report-frame-container'));
        updateStatus('学习报告模块已就绪');
      } catch (e) {
        console.error('[插件工作箱] 加载学习报告模块失败:', e);
        panel.innerHTML = `
          <div class="tb-empty-state">
            <div class="tb-empty-icon">❌</div>
            <div class="tb-empty-title">加载失败</div>
            <div class="tb-empty-desc">无法加载学习报告模块，请检查扩展是否正确安装</div>
            <div style="margin-top:8px;font-size:11px;color:#94a3b8;">${e.message}</div>
          </div>
        `;
        updateStatus('加载失败');
      }
    }
  }

  // ========== 注入学习报告模块 ==========

  async function injectReportModule(container) {
    // 方案：通过 chrome.runtime.sendMessage 调用学习报告扩展的 background
    // 由于跨扩展通信需要特定配置，这里先提供简化版本：
    // 显示一个提示，引导用户安装学习报告扩展
    
    container.innerHTML = `
      <div style="padding:24px 16px;text-align:center;">
        <div style="font-size:48px;margin-bottom:16px;">📊</div>
        <div style="font-size:16px;font-weight:600;color:#1e293b;margin-bottom:8px;">学习报告批量分析 v5.1.1</div>
        <div style="font-size:13px;color:#64748b;line-height:1.6;margin-bottom:20px;">
          批量获取学生听课质量报告<br>
          自动生成四维评价分析
        </div>
        
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;margin-bottom:16px;text-align:left;">
          <div style="font-size:12px;font-weight:600;color:#475569;margin-bottom:8px;">✨ 功能特性</div>
          <div style="font-size:12px;color:#64748b;line-height:1.8;">
            • 批量抓取 200+ 学生报告<br>
            • 四维评价：掌握度 × 回答率 × 听课时长 × 作业完成<br>
            • 自动打标签：⭐优秀 / 👍认真 / ⚠️需辅导 / 🚨敷衍<br>
            • 一键导出 CSV 分析表
          </div>
        </div>

        <button id="btn-launch-report" style="
          background: linear-gradient(135deg, #4f46e5, #7c3aed);
          color: #fff;
          border: none;
          padding: 10px 28px;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.15s ease;
        ">启动学习报告分析器</button>
        
        <div style="margin-top:12px;font-size:11px;color:#94a3b8;">
          需要安装「学习报告批量分析」扩展才能使用
        </div>
      </div>
    `;

    container.querySelector('#btn-launch-report').addEventListener('click', () => {
      // 尝试向学习报告扩展发送消息
      chrome.runtime.sendMessage(
        '学习报告批量分析扩展的ID',  // TODO: 需要实际扩展ID
        { type: 'LAUNCH_FROM_TOOLBOX' },
        (response) => {
          if (chrome.runtime.lastError) {
            // 扩展未安装或ID不对
            alert('请先安装「学习报告批量分析」扩展（v5.1.1+）\n\n安装后刷新页面即可使用。');
          }
        }
      );
    });
  }

  // ========== 渲染模块卡片 ==========

  function renderModuleCards() {
    const grid = document.getElementById('tb-module-grid');
    if (!grid) return;

    const entries = Object.values(MODULES).sort((a, b) => {
      const order = { available: 0, active: 1, loading: 2, error: 3, coming_soon: 4 };
      return (order[a.status] || 9) - (order[b.status] || 9);
    });

    grid.innerHTML = entries.map(mod => {
      const isAvailable = mod.status === 'available';
      const isComingSoon = mod.status === 'coming_soon';
      
      return `
        <div class="tb-module-card ${isAvailable ? '' : 'tb-module-disabled'}" data-module="${mod.id}">
          <div class="tb-module-card-icon" style="background:${mod.color}15;color:${mod.color}">
            ${mod.icon}
          </div>
          <div class="tb-module-card-info">
            <div class="tb-module-card-name">${mod.name}</div>
            <div class="tb-module-card-desc">${mod.description}</div>
          </div>
          ${isComingSoon ? '<span class="tb-module-badge">即将上线</span>' : ''}
          ${isAvailable ? '<span class="tb-module-badge tb-module-badge-ready">点击使用</span>' : ''}
        </div>
      `;
    }).join('');
  }

  // ========== 加载使用统计 ==========

  async function loadStats() {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'STORAGE_GET', keys: ['report_count', 'student_count', 'time_saved'] });
      if (resp.success) {
        const data = resp.data || {};
        const reportCount = document.getElementById('stat-reports');
        const studentCount = document.getElementById('stat-students');
        const timeSaved = document.getElementById('stat-time');
        
        if (reportCount) reportCount.textContent = data.report_count || 0;
        if (studentCount) studentCount.textContent = data.student_count || 0;
        if (timeSaved) timeSaved.textContent = (data.time_saved || 0) + 'min';
      }
    } catch (e) {
      console.log('[插件工作箱] 加载统计失败:', e);
    }
  }

  // ========== 状态栏更新 ==========

  function updateStatus(text) {
    const el = document.getElementById('tb-status-text');
    if (el) el.textContent = text;
  }

  // ========== 模块消息中继 ==========

  function relayToModule(message) {
    // 将消息转发给当前激活的模块
    // 具体实现取决于模块的通信协议
    console.log('[插件工作箱] relay to module:', activeModule, message);
  }

  // ========== 初始化 ==========

  console.log('[插件工作箱] content.js 已加载');

})();
