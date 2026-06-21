// 页面表格提取工具 — Toolbox 模块化版本（content.js）
// 迁移自 plugins/dingtalk/content.js
// 改动：消除 window 全局变量 → TableExtractorState 模块作用域；Shadow DOM 双容器架构
(function () {
  'use strict';

  console.log('[TableExtractor] 页面表格提取工具正在初始化...');

  // ★ 所有状态封装到模块作用域对象 ★
  const State = {
    extractedData: [],
    uniqueKeys: new Set(),
    headerRow: null,       // ★ 表头行（首次提取时自动识别）
    isRunning: false,
    shouldStop: false,
    selectedTable: null,    // 用户选择的表格
    detectedTables: [],    // 检测到的所有表格
    dedupMode: 'id+time',  // 默认去重模式
    scrollDelay: 1500,
  };

  // ===== Shadow DOM 容器 =====
  const shadowRoot = window.__shadowRoots__?.dingtalk;
  let _moduleRoot = null;   // 模块根容器引用（用于内部 querySelector）

  if (shadowRoot) {
    renderSidebarUI(shadowRoot);
  } else {
    console.warn('[TableExtractor] 未找到壳提供的 Shadow DOM 容器');
  }

  function $(sel) { return _moduleRoot ? _moduleRoot.querySelector(sel) : null; }

  /**
   * 在壳提供的 Shadow DOM 容器中渲染侧边栏控制区
   */
  function renderSidebarUI(root) {
    // ★ 清除壳的 loading 占位符（保留 <style> 标签）
    const toRemove = [];
    for (let i = 0; i < root.children.length; i++) {
      if (root.children[i].tagName !== 'STYLE') toRemove.push(root.children[i]);
    }
    toRemove.forEach(function (c) { root.removeChild(c); });

    const container = document.createElement('div');
    container.className = 'dt-sidebar-section';
    container.innerHTML =
      '<div class="dt-sidebar-header">' +
      '  <h3>📊 页面表格提取工具</h3>' +
      '  <p class="dt-sidebar-desc">一键提取网页表格数据，支持自动滚动、智能去重、Excel下载</p>' +
      '</div>' +
      '<div class="dt-dedup-control">' +
      '  <label for="dt-dedup-mode">去重模式：</label>' +
      '  <select id="dt-dedup-mode">' +
      '    <option value="id+time" selected>ID+时间</option>' +
      '    <option value="id-only">仅ID</option>' +
      '  </select>' +
      '</div>' +
      '<div class="dt-scroll-control">' +
      '  <label for="dt-scroll-delay">滚动延迟：</label>' +
      '  <input type="range" id="dt-scroll-delay" min="500" max="3000" value="1500" step="100">' +
      '  <span id="dt-delay-value">1500ms</span>' +
      '</div>' +
      '<div class="dt-table-info" id="dt-table-info"></div>' +
      '<div class="dt-status" id="dt-sidebar-status">准备就绪，点击"开始提取"按钮</div>' +
      '<div class="dt-count-info" id="dt-count-info"></div>' +
      '<div class="dt-progress-wrap" id="dt-progress-wrap" style="display:none;">' +
      '  <div class="dt-progress-status" id="dt-progress-status">准备中...</div>' +
      '  <div class="dt-progress-bar-wrap">' +
      '    <div class="dt-progress-fill" id="dt-progress-fill" style="width:0%"></div>' +
      '  </div>' +
      '  <div class="dt-progress-count" id="dt-progress-count">0 条</div>' +
      '</div>' +
      '<div class="dt-buttons">' +
      '  <button id="dt-btn-start" class="dt-btn dt-btn-primary">▶ 开始提取</button>' +
      '  <button id="dt-btn-stop" class="dt-btn dt-btn-danger">⏹ 停止</button>' +
      '  <button id="dt-btn-download" class="dt-btn dt-btn-info">💾 下载Excel</button>' +
      '</div>' +
      '<div class="dt-table-selector-btn" id="dt-table-selector-btn" style="display:none;">' +
      '  <button id="dt-btn-select-table" class="dt-btn dt-btn-purple">📋 选择表格 (<span id="dt-table-count">0</span>个)</button>' +
      '</div>';
    root.appendChild(container);
    _moduleRoot = container;

    // 绑定事件
    $('#dt-btn-start').addEventListener('click', startExtraction);
    $('#dt-btn-stop').addEventListener('click', stopExtraction);
    $('#dt-btn-download').addEventListener('click', downloadExcel);

    $('#dt-dedup-mode').addEventListener('change', function (e) {
      State.dedupMode = e.target.value;
      chrome.storage.local.set({ 'dingtalk.dedupMode': e.target.value });
    });

    $('#dt-scroll-delay').addEventListener('input', function () {
      const val = parseInt(this.value, 10);
      State.scrollDelay = val;
      const label = $('#dt-delay-value');
      if (label) label.textContent = val + 'ms';
    });

    // 读取存储的去重模式
    chrome.storage.local.get('dingtalk.dedupMode', function (result) {
      if (result['dingtalk.dedupMode']) {
        State.dedupMode = result['dingtalk.dedupMode'];
        const sel = $('#dt-dedup-mode');
        if (sel) sel.value = State.dedupMode;
      }
    });

    // 初始检测表格
    const tables = detectAllTables();
    updateTableInfo(tables);

    console.log('[TableExtractor] 侧边栏 UI 已渲染');
  }

  // ===== 进度条（侧边栏内） =====
  function showProgressWrap(show) {
    const el = $('#dt-progress-wrap');
    if (el) el.style.display = show ? '' : 'none';
  }
  function updateProgressStatus(msg) {
    const el = $('#dt-progress-status');
    if (el) el.textContent = msg;
  }
  function updateProgressCount(count) {
    const el = $('#dt-progress-count');
    if (el) el.textContent = (count || 0) + ' 条';
  }
  function updateProgressFill(percent) {
    const el = $('#dt-progress-fill');
    if (el) el.style.width = Math.min(100, Math.max(0, percent)) + '%';
  }

  // ===== 状态更新 =====
  function updateStatus(msg) {
    const el = $('#dt-sidebar-status');
    if (el) el.textContent = msg;
  }
  function updateCountInfo(msg) {
    const el = $('#dt-count-info');
    if (el) el.textContent = msg;
  }

  // ===== 表格检测 =====
  function detectAllTables() {
    State.detectedTables = [];
    let MAX_TABLES = 50; // 性能保护：最多检测50个表格
    let index = 0;

    let tables = document.querySelectorAll('table');
    for (var ti = 0; ti < tables.length && index < MAX_TABLES; ti++) {
      let table = tables[ti];
      let rows = table.querySelectorAll('tbody tr, tr');
      if (rows.length > 0 && rows.length <= 5000) {
        const preview = [];
        rows.forEach(function (row, ri) {
          const cells = row.querySelectorAll('td');
          if (cells.length > 0 && ri < 3) {
            const cellTexts = [];
            cells.forEach(function (c) { cellTexts.push((c.innerText || '').trim().substring(0, 15)); });
            preview.push(cellTexts.join(' | '));
          }
        });
        State.detectedTables.push({
          type: 'table',
          element: table,
          rows: rows.length,
          preview: preview.slice(0, 2).join('\n'),
          label: '表格 ' + (index + 1) + ' (' + rows.length + '行)',
        });
        index++;
      }
    }

    document.querySelectorAll('.el-table__body, .ant-table-content, .ant-table-body').forEach(function (container) {
      const rows = Array.from(container.querySelectorAll('tr'));
      if (rows.length > 0) {
        let preview = rows.slice(0, 2).map(function (r) {
          const c = r.querySelectorAll('td, div[class*="cell"]');
          return Array.from(c).map(function (x) { return (x.innerText || '').trim().substring(0, 15); }).join(' | ');
        }).join('\n');
        State.detectedTables.push({
          type: 'vue/ant',
          element: container,
          rows: rows.length,
          preview: preview.substring(0, 100),
          label: '虚拟表格 ' + (index + 1) + ' (' + rows.length + '行)',
        });
        index++;
      }
    });

    if (State.detectedTables.length === 0) {
      const allElements = document.querySelectorAll('*');
      let bestContainer = null;
      let maxRows = 0;
      allElements.forEach(function (el) {
        const rows = el.querySelectorAll('tr');
        if (rows.length > maxRows && rows.length > 5 && el.tagName !== 'BODY' && el.tagName !== 'HTML') {
          maxRows = rows.length;
          bestContainer = el;
        }
      });
      if (bestContainer) {
        State.detectedTables.push({
          type: 'container',
          element: bestContainer,
          rows: maxRows,
          preview: '',
          label: '数据容器 (' + maxRows + '行)',
        });
      }
    }

    console.log('[TableExtractor] 检测到 ' + State.detectedTables.length + ' 个表格');
    return State.detectedTables;
  }

  // ===== 更新表格信息展示 =====
  function updateTableInfo(tables) {
    const infoEl = $('#dt-table-info');
    const selectorBtnWrap = $('#dt-table-selector-btn');
    const tableCountEl = $('#dt-table-count');

    if (tables.length === 0) {
      if (infoEl) infoEl.innerHTML = '<span class="dt-info-warn">⚠ 未检测到表格，请确认页面已加载</span>';
      if (selectorBtnWrap) selectorBtnWrap.style.display = 'none';
      return;
    }

    if (infoEl) {
      const labels = tables.map(function (t) { return '<span class="dt-table-tag">' + t.label + '</span>'; }).join(' ');
      infoEl.innerHTML = '<span class="dt-info-label">检测到 ' + tables.length + ' 个表格：</span><br>' + labels;
    }

    if (tables.length >= 1 && selectorBtnWrap) {
      selectorBtnWrap.style.display = 'block';
      if (tableCountEl) tableCountEl.textContent = tables.length;
      const btn = $('#dt-btn-select-table');
      if (btn) btn.onclick = showTableSelector;
    } else if (selectorBtnWrap) {
      selectorBtnWrap.style.display = 'none';
    }
  }

  // ===== 表格选择器 =====
  let selectorHost = null;

  function showTableSelector() {
    if (selectorHost) { selectorHost.remove(); selectorHost = null; }

    detectAllTables();

    const host = document.createElement('div');
    host.id = 'table-extractor-selector-host';
    host.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; z-index:2147483647;';
    const selectorRoot = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = getTableSelectorCSS();
    selectorRoot.appendChild(style);

    let optionsHTML = State.detectedTables.map(function (t, i) {
      const preview = t.preview ? t.preview.substring(0, 60).replace(/\n/g, ' ') : '（无预览）';
      return '<div class="dt-table-option" data-index="' + i + '">' +
        '<div class="dt-table-option-label">' + t.label + '</div>' +
        '<div class="dt-table-option-preview">' + preview + '</div>' +
        '</div>';
    }).join('');

    optionsHTML = '<div class="dt-table-option ' + (State.selectedTable === null ? 'selected' : '') + '" data-index="-1">' +
      '<div class="dt-table-option-label">🤖 自动选择（推荐）</div>' +
      '<div class="dt-table-option-preview">由插件智能选择最佳表格</div>' +
      '</div>' + optionsHTML;

    const content = document.createElement('div');
    content.className = 'dt-selector-content';
    content.innerHTML =
      '<div class="dt-selector-header">' +
      '  <span>📋 请选择要提取的表格</span>' +
      '  <button class="dt-selector-close" id="dt-btn-close-selector">✕</button>' +
      '</div>' +
      '<div class="dt-selector-list">' + optionsHTML + '</div>' +
      '<div class="dt-selector-footer"><small>点击表格选项选择，点击遮罩或 ✕ 关闭</small></div>';

    const overlay = document.createElement('div');
    overlay.className = 'dt-selector-overlay';
    selectorRoot.appendChild(overlay);
    selectorRoot.appendChild(content);
    document.body.appendChild(host);
    selectorHost = host;

    content.addEventListener('click', function (e) { e.stopPropagation(); });
    content.querySelector('#dt-btn-close-selector').addEventListener('click', function (e) {
      e.stopPropagation();
      host.remove();
      selectorHost = null;
    });
    overlay.addEventListener('click', function () { host.remove(); selectorHost = null; });

    content.querySelectorAll('.dt-table-option').forEach(function (option) {
      option.addEventListener('click', function (e) {
        e.stopPropagation();
        const idx = parseInt(this.dataset.index, 10);
        if (idx === -1) {
          State.selectedTable = null;
          updateStatus('🤖 已切换为自动选择模式');
        } else {
          State.selectedTable = State.detectedTables[idx];
          updateStatus('✓ 已选择: ' + State.selectedTable.label);
        }
        content.querySelectorAll('.dt-table-option').forEach(function (o) { o.classList.remove('selected'); });
        this.classList.add('selected');
        setTimeout(function () { host.remove(); selectorHost = null; }, 300);
      });
    });
  }

  function getTableSelectorCSS() {
    return '.dt-selector-overlay { position:absolute; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.5); }' +
      '.dt-selector-content { position:relative; z-index:2; background:white; border-radius:16px; box-shadow:0 8px 40px rgba(0,0,0,0.3); width:90%; max-width:500px; max-height:80vh; margin:10vh auto; overflow:hidden; display:flex; flex-direction:column; font-family:"Microsoft YaHei",Arial,sans-serif; }' +
      '.dt-selector-header { background:linear-gradient(135deg,#1890ff 0%,#40a9ff 100%); color:white; padding:16px 20px; display:flex; justify-content:space-between; align-items:center; font-size:16px; font-weight:bold; }' +
      '.dt-selector-close { background:rgba(255,255,255,0.2); border:none; color:white; font-size:18px; width:28px; height:28px; border-radius:50%; cursor:pointer; line-height:1; transition:all 0.2s; }' +
      '.dt-selector-close:hover { background:rgba(255,255,255,0.3); transform:scale(1.1); }' +
      '.dt-selector-list { padding:16px; overflow-y:auto; flex:1; }' +
      '.dt-table-option { background:#f5f5f5; border:2px solid transparent; border-radius:10px; padding:14px; margin-bottom:10px; cursor:pointer; transition:all 0.2s; }' +
      '.dt-table-option:hover { background:#e6f7ff; border-color:#1890ff; transform:translateY(-2px); }' +
      '.dt-table-option.selected { background:#bae7ff; border-color:#1890ff; box-shadow:0 2px 8px rgba(24,144,255,0.3); }' +
      '.dt-table-option-label { font-size:14px; font-weight:bold; color:#333; margin-bottom:6px; }' +
      '.dt-table-option-preview { font-size:12px; color:#666; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }' +
      '.dt-selector-footer { padding:12px 16px; background:#fafafa; text-align:center; border-top:1px solid #eee; color:#666; }';
  }

  // ===== 数据查找 =====
  function findTable() {
    if (State.selectedTable) {
      console.log('[TableExtractor] 使用用户选择的表格: ' + State.selectedTable.label);
      return State.selectedTable.element;
    }
    detectAllTables();
    if (State.detectedTables.length === 0) {
      console.log('[TableExtractor] 未找到有效的数据表格');
      return null;
    }
    if (State.detectedTables.length === 1) {
      return State.detectedTables[0].element;
    }
    let bestTable = State.detectedTables.reduce(function (best, current) {
      return current.rows > best.rows ? current : best;
    });
    console.log('[TableExtractor] 自动选择表格: ' + bestTable.label);
    return bestTable.element;
  }

  function findScrollContainer() {
    const selectors = [
      '.el-table__body-wrapper',
      '.ant-table-content',
      '.ant-table-body',
      '.table-body',
      '.table-scroll',
      '.table-container',
      '[class*="scroll"]',
      '[class*="body-wrapper"]',
    ];
    for (let s = 0; s < selectors.length; s++) {
      const elements = document.querySelectorAll(selectors[s]);
      for (let j = 0; j < elements.length; j++) {
        if (elements[j].scrollHeight > elements[j].clientHeight) {
          return elements[j];
        }
      }
    }
    const allElements = document.querySelectorAll('*');
    for (let i = 0; i < allElements.length; i++) {
      const el = allElements[i];
      if (el.scrollHeight > el.clientHeight + 50 && el.tagName !== 'BODY' && el.tagName !== 'HTML') {
        return el;
      }
    }
    return window;
  }

  // ===== 单元格工具 =====
  function getCellText(cell) {
    if (!cell) return '';
    let text = (cell.innerText || '').trim();
    if (text) return text;
    text = (cell.getAttribute('title') || '').trim();
    if (text) return text;
    text = (cell.getAttribute('data-value') || '').trim();
    if (text) return text;
    text = (cell.textContent || '').trim();
    if (text) return text;
    const input = cell.querySelector('input, textarea');
    if (input) {
      text = input.value || input.getAttribute('value') || '';
      if (text) return text;
    }
    return '';
  }

  function findIdColumnIndex(rowData) {
    for (let i = 0; i < rowData.length; i++) {
      const text = rowData[i] || '';
      if (/^\d{5,10}$/.test(text) && !/[\/\-\s:]/.test(text)) return i;
    }
    return rowData.length > 4 ? 3 : 2;
  }

  function findTimeColumnIndex(rowData) {
    const timePatterns = [
      /^\d{4}-\d{2}-\d{2}/,
      /^\d{4}\/\d{2}\/\d{2}/,
      /^\d{2}:\d{2}:\d{2}/,
      /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/,
      /\d{2}:\d{2}/,
    ];
    for (let i = 0; i < rowData.length; i++) {
      const text = rowData[i] || '';
      for (let p = 0; p < timePatterns.length; p++) {
        if (timePatterns[p].test(text)) return i;
      }
    }
    return -1;
  }

  // ===== 表头提取 =====
  function extractHeader(container) {
    // 辅助：从 th/td 节点列表提取文本
    function textsFrom(cells) {
      return Array.from(cells).map(function (c) { return getCellText(c); });
    }

    // 0. 清理表头文本（去掉排序箭头、过滤图标等杂项）
    function cleanHeader(text) {
      return text
        .replace(/[↓↑↕⇅]/g, '')          // 排序箭头
        .replace(/\s+/g, ' ')              // 多余空格
        .replace(/^[\s\uFEFF]+|[\s\uFEFF]+$/g, ''); // BOM和首尾空格
    }

    // 1. 在 container 自身内找 <thead>（表头和数据在同一个 table 内）
    let thead = container.querySelector('thead');
    if (!thead && container.tagName === 'THEAD') thead = container;
    if (thead) {
      let thRow = thead.querySelector('tr');
      if (thRow) {
        let ths = thRow.querySelectorAll('th, td');
        if (ths.length > 0) {
          let hdr = textsFrom(ths).map(cleanHeader);
          console.log('[TableExtractor] 从 <thead> 提取表头:', hdr);
          return hdr;
        }
      }
    }

    // 2. Element UI 场景：数据体 container 的同级 header wrapper
    if (container.classList && container.classList.contains('el-table__body')) {
      let elTable = container.closest('.el-table');
      if (elTable) {
        let headerWrap = elTable.querySelector('.el-table__header-wrapper, .el-table__header');
        if (headerWrap) {
          let headerCells = headerWrap.querySelectorAll('th, .el-table__cell');
          if (headerCells.length > 0) {
            let hdr = textsFrom(headerCells).map(cleanHeader);
            console.log('[TableExtractor] 从 Element UI header wrapper 提取表头:', hdr);
            return hdr;
          }
        }
      }
    }
    // 2b. Ant Design / 其他虚拟表格：在 container 的父级或兄弟中找 thead
    let parent = container.parentElement;
    for (var pi = 0; parent && pi < 3; pi++) { // 向上查3层
      let pThead = parent.querySelector('thead');
      if (pThead) {
        let pThRow = pThead.querySelector('tr');
        if (pThRow) {
          let pThs = pThRow.querySelectorAll('th, td');
          if (pThs.length > 0) {
            let hdr = textsFrom(pThs).map(cleanHeader);
            console.log('[TableExtractor] 从父级 <thead> 提取表头:', hdr);
            return hdr;
          }
        }
      }
      // 也查兄弟中的 header
      let siblings = parent.children;
      for (var si = 0; si < siblings.length; si++) {
        let sib = siblings[si];
        if (sib === container) continue;
        let sibThead = sib.querySelector('thead');
        if (sibThead) {
          let sThRow = sibThead.querySelector('tr');
          if (sThRow) {
            let sThs = sThRow.querySelectorAll('th, td');
            if (sThs.length > 0) {
              let hdr = textsFrom(sThs).map(cleanHeader);
              console.log('[TableExtractor] 从兄弟元素 <thead> 提取表头:', hdr);
              return hdr;
            }
          }
        }
        // 查常见 header class
        let sibHeader = sib.querySelector('.el-table__header, .ant-table-thead, [class*="header"]');
        if (sibHeader) {
          let sCells = sibHeader.querySelectorAll('th, .el-table__cell, .ant-table-cell');
          if (sCells.length > 0) {
            let hdr = textsFrom(sCells).map(cleanHeader);
            console.log('[TableExtractor] 从兄弟 header 提取表头:', hdr);
            return hdr;
          }
        }
      }
      parent = parent.parentElement;
    }

    // 3. container 内找含 <th> 的行（标准表格 tbody 中可能混有 th）
    let firstTr = container.querySelector('tr');
    if (firstTr && firstTr.querySelector('th')) {
      let ths = firstTr.querySelectorAll('th, td');
      if (ths.length > 0) {
        let hdr = textsFrom(ths).map(cleanHeader);
        console.log('[TableExtractor] 从首行 <th> 提取表头:', hdr);
        return hdr;
      }
    }

    // 4. 最终兜底：页面全局搜索最大列数的 thead（适用于容器选择偏离的情况）
    let allTheads = document.querySelectorAll('thead');
    let bestThead = null, bestCols = 0;
    for (var ti = 0; ti < allTheads.length; ti++) {
      let trow = allTheads[ti].querySelector('tr');
      if (trow) {
        let tcells = trow.querySelectorAll('th, td');
        if (tcells.length > bestCols) {
          bestCols = tcells.length;
          bestThead = allTheads[ti];
        }
      }
    }
    if (bestThead) {
      let bRow = bestThead.querySelector('tr');
      if (bRow) {
        let bThs = bRow.querySelectorAll('th, td');
        let hdr = textsFrom(bThs).map(cleanHeader);
        console.log('[TableExtractor] 从全局最佳 <thead> 提取表头:', hdr);
        return hdr;
      }
    }

    console.log('[TableExtractor] 未能提取到表头');
    return null;
  }

  // ===== 核心提取 =====
  function extractCurrentData() {
    const container = findTable();
    if (!container) return 0;

    let rows = container.querySelectorAll('tbody tr');
    if (rows.length === 0) rows = container.querySelectorAll('table > tr');
    if (rows.length === 0) rows = container.querySelectorAll(':scope > tr, :scope > div[class*="row"]');
    if (rows.length === 0) rows = container.querySelectorAll('tr, div[class*="row"]');

    // ★ 提取表头（仅在第一次提取时，避免滚动追加时重复）
    if (!State.headerRow && rows.length > 0) {
      const hdr = extractHeader(container);
      if (hdr && hdr.length > 0) {
        State.headerRow = hdr;
        console.log('[TableExtractor] 提取表头: [' + hdr.join(', ') + ']');
      }
    }

    let count = 0;
    let idColumnIndex = -1;
    let timeColumnIndex = -1;
    const processedRows = new Set();
    let dataRowIndex = 0; // 数据行计数（排除表头行）

    rows.forEach(function (row, index) {
      if (processedRows.has(row)) return;
      processedRows.add(row);

      // 同时取 td 和 th
      let cells = row.querySelectorAll('td, th');
      if (cells.length === 0) cells = row.querySelectorAll('div[class*="cell"]');
      if (cells.length === 0) cells = row.querySelectorAll(':scope > div');
      if (cells.length === 0) return;

      const rowData = [];
      cells.forEach(function (cell) { rowData.push(getCellText(cell)); });

      // 跳过表头行（与已提取的表头内容一致，或者是纯 <th> 行）
      if (State.headerRow && rowData.length === State.headerRow.length) {
        let isHeader = true;
        for (var hi = 0; hi < rowData.length; hi++) {
          if (rowData[hi] !== State.headerRow[hi]) { isHeader = false; break; }
        }
        if (isHeader) return;
      }
      // 纯 <th> 行也跳过（标准表格 thead 行不在 rows 里，但 tbody 里可能混有 th）
      if (row.querySelector('th') && !row.querySelector('td')) return;

      if (dataRowIndex === 0) {
        idColumnIndex = findIdColumnIndex(rowData);
        timeColumnIndex = findTimeColumnIndex(rowData);
      }
      dataRowIndex++;

      const hasData = rowData.some(function (text) { return text && text.length > 0 && text !== '-'; });
      if (!hasData) return;

      const idValue = idColumnIndex >= 0 ? rowData[idColumnIndex] || '' : '';
      const timeValue = timeColumnIndex >= 0 ? rowData[timeColumnIndex] || '' : '';
      const dedupMode = State.dedupMode;

      let key = '';
      if (idValue && idValue.match(/^\d+$/) && idValue.length >= 4) {
        if (dedupMode === 'id-only') {
          key = idValue;
        } else {
          key = timeValue ? idValue + '_' + timeValue : idValue;
        }
      } else if (rowData[1] && rowData[2]) {
        if (dedupMode === 'id-only') {
          key = rowData[1] + '_' + rowData[2];
        } else {
          key = rowData[1] + '_' + rowData[2] + '_' + (timeValue || '');
        }
      } else {
        key = rowData.filter(function (t) { return t && t !== '-' && t.match(/\S/); }).join('_');
      }

      if (key && key.length > 0) {
        if (!State.uniqueKeys.has(key)) {
          State.uniqueKeys.add(key);
          State.extractedData.push(rowData);
          count++;
        }
      }
    });

    return count;
  }

  function scrollNext() {
    const container = findScrollContainer();
    if (container === window) {
      window.scrollTo(0, window.pageYOffset + window.innerHeight - 20);
    } else {
      container.scrollTop = container.scrollTop + container.clientHeight - 20;
    }
  }

  // ===== 操作 =====
  function stopExtraction() {
    State.shouldStop = true;
    State.isRunning = false;
    updateStatus('⏹ 提取已停止');
  }

  // 动态加载 xlsx 库（复用 report 模块的库）
  async function downloadExcel() {
    if (State.extractedData.length === 0) {
      alert('没有数据！请先点击"开始提取"');
      return;
    }
    const now = new Date();
    const timeStr = now.toTimeString().slice(0, 5).replace(':', '-');
    const fileName = '表格数据_' + now.toISOString().slice(0, 10) + '_' + timeStr + '.xlsx';

    var rows = [];
    if (State.headerRow && State.headerRow.length > 0) rows.push(State.headerRow);
    State.extractedData.forEach(function (row) { rows.push(row); });

    try {
      var res = await new Promise(function (resolve, reject) {
        chrome.runtime.sendMessage(
          { target: 'report', action: 'GENERATE_TABLE_EXCEL', data: { header: State.headerRow, data: State.extractedData, filename: fileName } },
          function (resp) {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(resp);
          }
        );
      });
      if (res && res.success === false) throw new Error(res.error || '生成失败');
      var wbout = res.base64 || (res.data && res.data.base64);
      if (!wbout) throw new Error('SW 未返回 xlsx 数据');
      var buf = Uint8Array.from(atob(wbout), function (c) { return c.charCodeAt(0); });
      var blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.click();
      setTimeout(function () { URL.revokeObjectURL(url); }, 100);
      updateStatus('✅ Excel文件已下载：' + fileName);
    } catch (e) {
      console.warn('[TableExtractor] SW生成xlsx失败，降级为CSV:', e.message);
      downloadCSV();
    }
  }

  // CSV 兜底
  function downloadCSV() {
    if (State.extractedData.length === 0) {
      alert('没有数据！请先点击"开始提取"');
      return;
    }
    const now = new Date();
    const timeStr = now.toTimeString().slice(0, 5).replace(':', '-');
    const fileName = '表格数据_' + now.toISOString().slice(0, 10) + '_' + timeStr + '.csv';

    let csv = '';
    // 表头行（首次提取时自动识别）
    if (State.headerRow && State.headerRow.length > 0) {
      const hdrQuoted = State.headerRow.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; });
      csv += hdrQuoted.join(',') + '\n';
    }
    State.extractedData.forEach(function (row) {
      const quoted = row.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; });
      csv += quoted.join(',') + '\n';
    });

    const BOM = new Uint8Array([0xef, 0xbb, 0xbf]);
    const csvBytes = new TextEncoder().encode(csv);
    const combined = new Uint8Array(BOM.length + csvBytes.length);
    combined.set(BOM, 0);
    combined.set(csvBytes, BOM.length);

    const blob = new Blob([combined], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 100);

    updateStatus('✅ CSV文件已下载：' + fileName);
  }

  async function startExtraction() {
    if (State.isRunning) {
      alert('提取正在进行中...');
      return;
    }

    State.isRunning = true;
    try {
      State.shouldStop = false;
      State.extractedData = [];
      State.uniqueKeys = new Set();
      State.headerRow = null;
      updateStatus('🚀 开始提取数据，请稍候...');
      updateCountInfo('总计: 0 条');

    // 显示侧边栏内进度条
    showProgressWrap(true);
    updateProgressStatus('🚀 开始提取数据...');
    updateProgressCount(0);
    updateProgressFill(0);

    let added = extractCurrentData();
    updateStatus('✓ 初始提取: ' + added + ' 条记录');
    updateCountInfo('总计: ' + State.extractedData.length + ' 条');
    updateProgressStatus('✓ 初始提取完成');
    updateProgressCount(State.extractedData.length);
    updateProgressFill(5);

    let noNewCount = 0;
    const scrollDelay = State.scrollDelay;
    const maxRounds = 100;

    for (let i = 1; i <= maxRounds; i++) {
      if (State.shouldStop) {
        updateStatus('⏹ 提取已停止');
        updateProgressStatus('⏹ 提取已停止');
        break;
      }

      const statusMsg = '第 ' + i + ' 次滚动提取中...';
      updateStatus(statusMsg);
      updateProgressStatus(statusMsg);

      scrollNext();
      await new Promise(function (r) { setTimeout(r, scrollDelay); });

      added = extractCurrentData();
      const total = State.extractedData.length;
      updateCountInfo('总计: ' + total + ' 条 (本次+' + added + ')');
      updateProgressStatus('第 ' + i + '/' + maxRounds + ' 次提取中...');
      updateProgressCount(total);
      updateProgressFill(5 + (i / maxRounds) * 90);

      if (added === 0) {
        noNewCount++;
        if (noNewCount >= 3) {
          updateStatus('✅ 数据提取完成！所有数据已提取');
          updateProgressStatus('✅ 数据提取完成！');
          updateProgressFill(100);
          break;
        }
      } else {
        noNewCount = 0;
      }

      const container = findScrollContainer();
      let atBottom = false;
      if (container === window) {
        atBottom = window.innerHeight + window.pageYOffset >= document.documentElement.scrollHeight - 50;
      } else {
        atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 50;
      }
      if (atBottom) {
        updateStatus('✅ 已到达页面底部，提取完成');
        updateProgressStatus('✅ 已到达底部，提取完成');
        updateProgressFill(100);
        break;
      }
    }

    State.isRunning = false;
    const finalCount = State.extractedData.length;
    updateStatus('🎉 提取完成！共 ' + finalCount + ' 条记录');
    updateProgressStatus('🎉 提取完成！共 ' + finalCount + ' 条记录');
    updateProgressCount(finalCount);
    updateProgressFill(100);

    // ★ 写入使用统计 + 触发下载（仅在正常完成时）
    if (finalCount > 0) {
      try {
        let stats = await chrome.storage.local.get(['time_saved']);
        let oldTime = parseInt(stats.time_saved) || 0;
        let newTime = oldTime + Math.max(1, Math.round(finalCount / 100 * 2));
        await chrome.storage.local.set({ time_saved: newTime });
        console.log('[TableExtractor] 统计已更新: time_saved+' + Math.max(1, Math.round(finalCount / 100 * 2)) + 'min');
      } catch (e) {
        console.warn('[TableExtractor] 写入统计失败:', e.message);
      }
      downloadExcel();
    } else {
      updateStatus('❌ 未提取到任何数据');
    }
    } catch (e) {
      console.error('[TableExtractor] 提取失败:', e);
      updateStatus('❌ 提取出错: ' + e.message);
      updateProgressStatus('❌ 提取出错');
      showProgressWrap(false);
      State.isRunning = false;
    }
  }

  // ===== 模块消息处理 =====
  if (window.__moduleMessageHandlers__) {
    window.__moduleMessageHandlers__.dingtalk = function (message) {
      console.log('[TableExtractor] 收到壳转发消息:', message);
    };
  }

  console.log('[TableExtractor] 页面表格提取工具模块已加载');
})();
