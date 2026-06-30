/**
 * 插件工作箱 v2.0.0 - 微内核 Service Worker
 *
 * 职责：
 * 1. 初始化 self.__modules__ 命名空间
 * 2. ModuleRegistry - 通过 fetch 加载 modules/module.json 构建模块清单
 * 3. MessageBus - 统一消息路由 {target, action, data}
 * 4. importScripts 加载已启用模块的 background.js
 * 5. 硬编码识别 iframe 的 REPORT_DATA_RESULT 消息并转发
 * 6. onInstalled 首次安装初始化默认设置
 */

(function () {
  'use strict';

  // ========== 命名空间初始化 ==========

  /** 全局模块命名空间，每个模块的 background.js 将 handlers 挂载于此 */
  self.__modules__ = {};

  /**
   * 注册模块消息处理器
   * 模块 background.js 调用此函数，将自身 handler 注册到 __modules__[name].handlers
   * @param {string} name - 模块名称
   * @param {Object} handlers - { [action: string]: (data, sender) => Promise|* }
   */
  self.__registerModuleHandlers = function (name, handlers) {
    self.__modules__[name] = self.__modules__[name] || {};
    Object.assign(self.__modules__[name], { handlers: handlers || {} });
  };

  // ========== 已知模块列表 ==========

  /** 壳内硬编码的已知模块目录名，用于扫描 module.json */
  const KNOWN_MODULES = ['report', 'dingtalk', 'tiaoke', 'updater', 'heatmap', 'dailyboard', 'data-entry'];

  /**
   * 已知模块 background.js 路径映射
   * 键=模块名，值=相对路径（用于 importScripts 顶层同步加载）
   * 无 background 入口的模块（如 dingtalk）设为 null
   */
  const KNOWN_MODULE_BG_MAP = {
    report: 'modules/report/background.js',
    dingtalk: null,
    tiaoke: 'modules/tiaoke/background.js',
    updater: 'modules/updater/background.js',
    heatmap: 'modules/heatmap/background.js',
    dailyboard: 'modules/dailyboard/background.js',
    'data-entry': 'modules/data-entry/background.js',
  };

  // ========== ModuleRegistry ==========

  const ModuleRegistry = {
    /** @type {Map<string, Object>} name -> module.json 内容（含 enabled 状态） */
    _cache: new Map(),

    /**
     * 扫描所有已知模块的 module.json，构建模块清单
     * 优先从 storage 缓存读取，缓存不存在则 fetch 逐一加载
     * @returns {Promise<Object[]>} 模块清单数组
     */
    async getAll() {
      const currentVersion = chrome.runtime.getManifest().version;

      // 版本戳校验：缓存版本 === 当前版本才复用，否则跳过缓存重新扫描
      const stamp = await this._readVersionStamp();
      if (stamp === currentVersion) {
        const cached = await this._readCache();
        if (cached && cached.length > 0) {
          const enabledMap = await this._getEnabledMap();
          return cached.map((mod) => ({
            ...mod,
            enabled: enabledMap[mod.name] !== false,
          }));
        }
      }

      if (stamp && stamp !== currentVersion) {
        console.log(`[壳SW] 模块缓存版本不匹配 (${stamp} → ${currentVersion})，重新扫描`);
      }

      // fetch 逐一加载 module.json
      const modules = [];
      for (const name of KNOWN_MODULES) {
        try {
          const url = chrome.runtime.getURL(`modules/${name}/module.json`);
          const resp = await fetch(url);
          if (!resp.ok) continue;
          const meta = await resp.json();
          modules.push({ ...meta, name: meta.name || name });
        } catch (e) {
          console.warn(`[壳SW] 加载模块 ${name}/module.json 失败:`, e);
        }
      }

      // 写入缓存
      if (modules.length > 0) {
        await this._writeCache(modules);
      }

      // 合并 enabled 状态
      const enabledMap = await this._getEnabledMap();
      return modules.map((mod) => ({
        ...mod,
        enabled: enabledMap[mod.name] !== false,
      }));
    },

    /**
     * 获取单个模块的元数据
     * @param {string} name
     * @returns {Promise<Object|null>}
     */
    async get(name) {
      const all = await this.getAll();
      return all.find((m) => m.name === name) || null;
    },

    /**
     * 读取 storage 缓存
     * @private
     */
    async _readCache() {
      try {
        const result = await chrome.storage.local.get('shell.module_registry');
        return result['shell.module_registry'] || null;
      } catch {
        return null;
      }
    },

    /**
     * 读取缓存的版本戳
     * @private
     * @returns {Promise<string|null>}
     */
    async _readVersionStamp() {
      try {
        const result = await chrome.storage.local.get('shell.module_registry_version');
        return result['shell.module_registry_version'] || null;
      } catch {
        return null;
      }
    },

    /**
     * 写入 storage 缓存
     * @private
     */
    async _writeCache(modules) {
      try {
        await chrome.storage.local.set({
          'shell.module_registry': modules,
          'shell.module_registry_version': chrome.runtime.getManifest().version,
        });
      } catch (e) {
        console.warn('[壳SW] 写入模块缓存失败:', e);
      }
    },

    /**
     * 读取模块启用状态 Map
     * @private
     * @returns {Promise<Object>} { [name]: boolean }
     */
    async _getEnabledMap() {
      try {
        const result = await chrome.storage.local.get('shell.enabled_modules');
        return result['shell.enabled_modules'] || {};
      } catch {
        return {};
      }
    },

    /**
     * 切换模块启用状态
     * @param {string} name
     * @param {boolean} enabled
     */
    async setEnabled(name, enabled) {
      const map = await this._getEnabledMap();
      map[name] = enabled;
      await chrome.storage.local.set({ 'shell.enabled_modules': map });
      // 清除缓存，下次 getAll 重新加载
      await chrome.storage.local.remove('shell.module_registry');
    },

    /**
     * 清除模块缓存（扩展更新时调用）
     */
    async clearCache() {
      await chrome.storage.local.remove(['shell.module_registry', 'shell.module_registry_version']);
    },
  };

  // ========== DebugLogger：调试日志收集 ==========

  const DebugLogger = {
    /** 日志缓冲区（最多保留 100 条） */
    _logs: [],
    /** 错误缓冲区（最多保留 20 条） */
    _errors: [],
    /** 消息追踪缓冲区（最多保留 50 条） */
    _messages: [],
    /** 消息日志开关（默认开启） */
    _enabled: true,

    /**
     * 记录日志
     * @param {string} level - log|warn|error
     * @param {string} source - 来源（如 shell、report）
     * @param {string} message - 日志内容
     */
    log(level, source, message) {
      if (!this._enabled) return;
      const entry = { time: Date.now(), level, source, message };
      this._logs.push(entry);
      if (this._logs.length > 100) this._logs.shift();

      if (level === 'error') {
        this._errors.push(entry);
        if (this._errors.length > 20) this._errors.shift();
      }
    },

    /**
     * 记录消息追踪
     */
    trackMessage(msg) {
      if (!this._enabled) return;
      const entry = {
        time: Date.now(),
        action: msg.action || msg.type || '',
        target: msg.target || '',
        error: msg.error || null,
      };
      this._messages.push(entry);
      if (this._messages.length > 50) this._messages.shift();
    },

    /**
     * 获取所有调试数据
     */
    getData() {
      // 模块状态
      const moduleStatus = {};
      moduleStatus['SW'] = { online: true, version: chrome.runtime.getManifest().version };
      for (const [name, mod] of Object.entries(self.__modules__)) {
        moduleStatus[name] = {
          online: mod.enabled !== false,
          version: mod.version || 'loaded',
        };
      }
      // 加载但未注册的模块也检查
      for (const name of KNOWN_MODULES) {
        if (!moduleStatus[name]) {
          moduleStatus[name] = { online: false, version: 'not loaded' };
        }
      }

      return {
        moduleStatus,
        logs: this._logs,
        errors: this._errors,
        messages: this._messages,
      };
    },

    /**
     * 清空所有日志
     */
    clear() {
      this._logs = [];
      this._errors = [];
      this._messages = [];
    },
  };

  // 覆盖 console 方法自动收集日志
  const _origConsoleLog = console.log.bind(console);
  const _origConsoleWarn = console.warn.bind(console);
  const _origConsoleError = console.error.bind(console);

  /**
   * 从日志内容识别来源模块
   * @param {string} text
   * @returns {string} 来源标识
   */
  function detectLogSource(text) {
    if (text.indexOf('[Report模块]') >= 0) return 'report';
    if (text.indexOf('[report]') >= 0) return 'report';
    if (text.indexOf('[TableExtractor]') >= 0) return 'dingtalk';
    if (text.indexOf('[dingtalk]') >= 0) return 'dingtalk';
    if (text.indexOf('[调课助手]') >= 0 || text.indexOf('[tiaoke]') >= 0) return 'tiaoke';
    if (text.indexOf('[壳SW]') >= 0 || text.indexOf('[壳]') >= 0) return 'shell';
    return 'shell';
  }

  console.log = function (...args) {
    _origConsoleLog(...args);
    const text = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    DebugLogger.log('log', detectLogSource(text), text);
  };
  console.warn = function (...args) {
    _origConsoleWarn(...args);
    const text = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    DebugLogger.log('warn', detectLogSource(text), text);
  };
  console.error = function (...args) {
    _origConsoleError(...args);
    const text = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    DebugLogger.log('error', detectLogSource(text), text);
  };

  // ========== 消息总线 MessageBus ==========

  const MessageBus = {
    /**
     * 路由消息：根据 target 分发到对应模块 handler 或壳自身 handler
     * @param {ModuleMessage} message
     * @param {chrome.runtime.MessageSender} sender
     * @param {Function} sendResponse
     * @returns {boolean} 是否异步响应
     */
    route(message, sender, sendResponse) {
      const { target, action, data, payload } = message || {};
      // 兼容 content.js 用 payload 和 data 两种字段名传参
      const handlerData = data !== undefined ? data : payload;

      // 壳自身处理的消息
      if (target === 'shell') {
        return this._handleShellMessage(action, handlerData, sender, sendResponse);
      }

      // 转发到模块 handler
      const mod = self.__modules__[target];
      // 检查模块是否被禁用
      if (mod && mod.enabled === false) {
        console.warn(`[壳SW] 模块 ${target} 已禁用，拒绝消息: ${action}`);
        sendResponse({ success: false, error: `模块 ${target} 已禁用` });
        return false;
      }
      if (mod && mod.handlers && mod.handlers[action]) {
        try {
          const result = mod.handlers[action](handlerData, sender);
          // 如果返回 Promise，异步发送响应
          if (result && typeof result.then === 'function') {
            result
              .then((res) => sendResponse({ success: true, data: res }))
              .catch((err) =>
                sendResponse({ success: false, error: err.message || String(err) })
              );
            return true; // 异步响应
          }
          // 同步结果
          sendResponse({ success: true, data: result });
          return false;
        } catch (e) {
          sendResponse({ success: false, error: e.message });
          return false;
        }
      }

      // 未找到 handler
      console.warn(`[壳SW] 未找到消息处理器: target=${target}, action=${action}`);
      sendResponse({ success: false, error: `未知目标: ${target}` });
      return false;
    },

    /**
     * 处理壳自身的消息
     * @private
     */
    _handleShellMessage(action, data, sender, sendResponse) {
      switch (action) {
        case 'GET_MODULE_LIST': {
          // 返回模块列表（异步）
          ModuleRegistry.getAll()
            .then((modules) => {
              sendResponse({ success: true, data: modules });
            })
            .catch((err) => {
              sendResponse({ success: false, error: err.message });
            });
          return true; // 异步响应
        }

        case 'MODULE_ENABLE_TOGGLE': {
          // 切换模块启用状态
          const { name, enabled } = data || {};
          if (!name) {
            sendResponse({ success: false, error: '缺少模块名' });
            return false;
          }
          ModuleRegistry.setEnabled(name, enabled)
            .then(() => {
              sendResponse({ success: true, data: { name, enabled } });
            })
            .catch((err) => {
              sendResponse({ success: false, error: err.message });
            });
          return true;
        }

        case 'TOGGLE_SIDEBAR': {
          // 转发到 content script（由 popup 或其他来源触发）
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) {
              chrome.tabs.sendMessage(tabs[0].id, {
                target: 'shell',
                action: 'TOGGLE_SIDEBAR',
              });
            }
          });
          sendResponse({ success: true });
          return false;
        }

        case 'DEBUG_GET_LOGS': {
          sendResponse({ success: true, data: DebugLogger.getData() });
          return false;
        }

        case 'DEBUG_CLEAR_LOGS': {
          DebugLogger.clear();
          sendResponse({ success: true });
          return false;
        }

        case 'LOG_FORWARD': {
          // content.js 转发日志到调试面板
          const { level, source, message: logMsg } = data || {};
          if (level && logMsg) {
            DebugLogger.log(level, source || 'content', logMsg);
          }
          sendResponse({ success: true });
          return false;
        }

        default:
          sendResponse({ success: false, error: `未知壳操作: ${action}` });
          return false;
      }
    },
  };

  // ========== 消息监听器 ==========

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) return false;

    // 硬编码识别 iframe 发来的 REPORT_DATA_RESULT 消息
    // report_fetcher.js 使用 {type: 'REPORT_DATA_RESULT'} 格式
    if (message.type === 'REPORT_DATA_RESULT' && sender.tab) {
      // 转换为统一消息格式，转发给 report 模块 handler
      const mod = self.__modules__.report;
      if (mod && mod.enabled === false) {
        sendResponse({ success: false, error: 'report 模块已禁用' });
        return false;
      }
      if (mod && mod.handlers && mod.handlers['REPORT_DATA_RESULT']) {
        try {
          const result = mod.handlers['REPORT_DATA_RESULT'](
            { reportToken: message.reportToken, data: message.data, error: message.error },
            sender
          );
          if (result && typeof result.then === 'function') {
            result
              .then((res) => sendResponse({ success: true, data: res }))
              .catch((err) => sendResponse({ success: false, error: err.message }));
            return true;
          }
          sendResponse({ success: true, data: result });
          return false;
        } catch (e) {
          sendResponse({ success: false, error: e.message });
          return false;
        }
      }
      // report 模块未注册 handler，仅记录
      console.log('[壳SW] 收到 REPORT_DATA_RESULT 但 report 模块未注册 handler，数据已暂存');
      sendResponse({ success: true, pending: true });
      return false;
    }

    // 统一消息格式路由
    if (message.target && message.action) {
      DebugLogger.trackMessage(message);
      // 模块加载期间先排队，加载完成后自动处理
      if (_modulesLoading && message.target !== 'shell') {
        _messageQueue.push({ message, sender, sendResponse });
        return true; // 异步响应，稍后 sendResponse
      }
      return MessageBus.route(message, sender, sendResponse);
    }

    return false;
  });

  // ========== 模块加载 ==========

  /** 模块加载中标记（用于异步初始化阶段的消息排队） */
  let _modulesLoading = true;
  /** 模块加载完成后的消息队列 */
  let _messageQueue = [];

  /**
   * 在 SW 顶层同步加载所有已知模块的 background.js
   *
   * MV3 铁律：
   * - importScripts() 只能在 SW 顶层同步作用域调用，不能在 async 函数 / Promise 回调里调用
   * - 动态 import() 在 ServiceWorkerGlobalScope 中被 W3C 规范明确禁止
   * - 每次 SW 冷启动或休眠唤醒时，整个 background.js 会重新执行，此时顶层 importScripts() 正常可用
   *
   * 策略：将 importScripts 放在顶层同步执行，不受异步代码影响
   */
  function loadModuleBackgrounds() {
    for (const name of KNOWN_MODULES) {
      try {
        const bgPath = KNOWN_MODULE_BG_MAP[name];
        if (!bgPath) {
          console.log(`[壳SW] 模块 ${name} 无 background 入口映射，跳过`);
          continue;
        }
        const url = chrome.runtime.getURL(bgPath);
        importScripts(url);
        console.log(`[壳SW] 模块 ${name} background.js 加载成功`);
      } catch (e) {
        console.error(`[壳SW] 模块 ${name} background.js 加载失败:`, e.message || e);
      }
    }
  }

  /**
   * 异步初始化模块启用状态（在代码已加载的基础上设置 enabled 标志）
   */
  async function initModuleStates() {
    const enabledMap = await ModuleRegistry._getEnabledMap();
    for (const name of KNOWN_MODULES) {
      if (self.__modules__[name]) {
        self.__modules__[name].enabled = enabledMap[name] !== false;
      }
    }
    console.log(`[壳SW] 模块启用状态:`, Object.fromEntries(
      Object.entries(self.__modules__).map(([k, v]) => [k, v.enabled])
    ));
  }

  /**
   * 处理模块加载期间积压的消息
   */
  function flushMessageQueue() {
    if (_messageQueue.length === 0) return;
    console.log(`[壳SW] 处理积压消息 ${_messageQueue.length} 条`);
    for (const { message, sender, sendResponse } of _messageQueue) {
      try {
        MessageBus.route(message, sender, sendResponse);
      } catch (e) {
        console.error('[壳SW] 处理积压消息出错:', e);
      }
    }
    _messageQueue = [];
  }

  // ========== 扩展安装/更新 ==========

  chrome.runtime.onInstalled.addListener(async (details) => {
    console.log(`[壳SW] 安装事件: ${details.reason}`);

    if (details.reason === 'install') {
      // 首次安装：初始化默认设置
      await chrome.storage.local.set({
        'shell.version': '2.0.0',
        'shell.sidebar_position': 'right',
        'shell.sidebar_width': 420,
        'shell.theme': 'light',
        'shell.enabled_modules': {
          report: true,
          dingtalk: true,
          tiaoke: true,
          updater: true,
          heatmap: true,
        },
        'shell.last_active_module': null,
      });
      console.log('[壳SW] 首次安装，默认设置已初始化');
    }

    if (details.reason === 'update') {
      // 更新：清除模块缓存，重新加载
      await ModuleRegistry.clearCache();
      console.log(`[壳SW] 扩展已更新到 v${chrome.runtime.getManifest().version}`);
    }

    // 更新模块启用状态
    await initModuleStates();
  });

  // ========== 启动 ==========

  // ① 顶层同步：importScripts 加载所有模块 background.js（必须在顶层！）
  loadModuleBackgrounds();

  // ② 异步：初始化模块启用状态 + 处理可能积压的消息
  (async function startup() {
    console.log(`[壳SW] 插件工作箱 v${chrome.runtime.getManifest().version} 微内核启动中...`);
    _modulesLoading = false;
    flushMessageQueue();
    await initModuleStates();
    console.log(`[壳SW] 插件工作箱 v${chrome.runtime.getManifest().version} 微内核已启动`);
  })();

})();
