// 钉钉数据提取助手 - 内容脚本
// 使用立即执行函数确保正确加载
(function() {
  'use strict';

  console.log('📊 钉钉数据提取助手正在初始化...');

  // 数据存储
  window.extractedData = [];
  window.uniqueKeys = new Set();
  window.isRunning = false;
  window.shouldStop = false;
  window.selectedTable = null;  // 用户选择的表格
  window.detectedTables = [];  // 检测到的所有表格

  // 创建控制面板
  function createControlPanel() {
    // 如果已存在，先删除
    const existing = document.getElementById('dingtalk-extractor-panel');
    if (existing) {
      existing.remove();
    }

    // 检测表格数量
    const tables = detectAllTables();
    const hasMultipleTables = tables.length > 1;
    const tableSelectorHTML = hasMultipleTables
      ? `<button id="btn-select-table" style="background: #722ed1; margin-bottom: 10px;">📋 选择表格 (${tables.length}个)</button>`
      : '';

    const panel = document.createElement('div');
    panel.id = 'dingtalk-extractor-panel';
    panel.innerHTML = `
      <div class="dingtalk-extractor-container">
        <div class="dingtalk-extractor-header">
          <span class="dingtalk-extractor-title">📊 钉钉数据提取助手</span>
          <button class="dingtalk-extractor-close" id="btn-close">✕</button>
        </div>

        <div class="dingtalk-extractor-status" id="ext-status">
          准备就绪，点击"开始提取"按钮
        </div>

        <div class="dingtalk-extractor-info" id="ext-info"></div>

        ${tableSelectorHTML}

        <div class="dingtalk-extractor-buttons">
          <button id="btn-start">▶ 开始提取</button>
          <button id="btn-stop">⏹ 停止</button>
          <button id="btn-download">💾 下载CSV</button>
        </div>

        <div class="dingtalk-extractor-settings">
          <label>
            <span>滚动延迟：</span>
            <input type="range" id="scroll-delay" min="500" max="3000" value="1500">
            <span id="delay-value">1500ms</span>
          </label>
        </div>
      </div>
    `;

    document.body.appendChild(panel);

    // 绑定事件监听器
    document.getElementById('btn-close').addEventListener('click', function() {
      panel.remove();
    });

    document.getElementById('btn-start').addEventListener('click', startExtraction);
    document.getElementById('btn-stop').addEventListener('click', stopExtraction);
    document.getElementById('btn-download').addEventListener('click', downloadCSV);
    document.getElementById('scroll-delay').addEventListener('input', function() {
      document.getElementById('delay-value').textContent = this.value + 'ms';
    });

    // 如果有多个表格，绑定选择按钮事件
    if (hasMultipleTables) {
      document.getElementById('btn-select-table').addEventListener('click', showTableSelector);
    }

    console.log('✓ 控制面板已创建，事件监听器已绑定');
  }

  // 检测所有表格
  function detectAllTables() {
    window.detectedTables = [];
    let index = 0;

    // 策略1：查找传统的table标签
    document.querySelectorAll('table').forEach((table, i) => {
      const rows = table.querySelectorAll('tbody tr, tr');
      if (rows.length > 0) {
        // 获取第一行数据作为预览
        let preview = [];
        rows.forEach((row, ri) => {
          const cells = row.querySelectorAll('td');
          if (cells.length > 0 && ri < 3) {
            const cellTexts = [];
            cells.forEach(c => cellTexts.push(c.innerText?.trim()?.substring(0, 15) || ''));
            preview.push(cellTexts.join(' | '));
          }
        });
        window.detectedTables.push({
          type: 'table',
          element: table,
          rows: rows.length,
          preview: preview.slice(0, 2).join('\n'),
          label: `表格 ${index + 1} (${rows.length}行)`
        });
        index++;
      }
    });

    // 策略2：查找Vue/Ant Design表格容器
    document.querySelectorAll('.el-table__body, .ant-table-content, .ant-table-body').forEach((container, i) => {
      const rows = Array.from(container.querySelectorAll('tr'));
      if (rows.length > 0) {
        let preview = '';
        rows.slice(0, 2).forEach((row, ri) => {
          const cells = row.querySelectorAll('td, div[class*="cell"]');
          if (cells.length > 0) {
            preview += rows.slice(0, 2).map(r => {
              const c = r.querySelectorAll('td, div[class*="cell"]');
              return Array.from(c).map(x => x.innerText?.trim()?.substring(0, 15) || '').join(' | ');
            }).join('\n');
          }
        });
        window.detectedTables.push({
          type: 'vue/ant',
          element: container,
          rows: rows.length,
          preview: preview.substring(0, 100),
          label: `虚拟表格 ${index + 1} (${rows.length}行)`
        });
        index++;
      }
    });

    // 策略3：查找其他包含大量tr的元素
    if (window.detectedTables.length === 0) {
      const allElements = document.querySelectorAll('*');
      let bestContainer = null;
      let maxRows = 0;

      allElements.forEach(el => {
        const rows = el.querySelectorAll('tr');
        if (rows.length > maxRows && rows.length > 5 && el.tagName !== 'BODY' && el.tagName !== 'HTML') {
          maxRows = rows.length;
          bestContainer = el;
        }
      });

      if (bestContainer) {
        const rows = bestContainer.querySelectorAll('tr');
        window.detectedTables.push({
          type: 'container',
          element: bestContainer,
          rows: rows.length,
          preview: '',
          label: `数据容器 (${rows.length}行)`
        });
      }
    }

    console.log(`  检测到 ${window.detectedTables.length} 个表格`);
    window.detectedTables.forEach((t, i) => {
      console.log(`    ${i + 1}. ${t.label}`);
    });

    return window.detectedTables;
  }

  // 显示表格选择器
  function showTableSelector() {
    // 如果已有选择器，先删除
    const existing = document.getElementById('dingtalk-table-selector');
    if (existing) {
      existing.remove();
    }

    // 重新检测表格
    detectAllTables();

    const selector = document.createElement('div');
    selector.id = 'dingtalk-table-selector';

    let optionsHTML = window.detectedTables.map((t, i) => {
      const preview = t.preview ? t.preview.substring(0, 60).replace(/\n/g, ' ') : '（无预览）';
      return `
        <div class="table-option" data-index="${i}">
          <div class="table-option-label">${t.label}</div>
          <div class="table-option-preview">${preview}</div>
        </div>
      `;
    }).join('');

    // 添加"自动选择"选项
    optionsHTML = `
      <div class="table-option ${window.selectedTable === null ? 'selected' : ''}" data-index="-1">
        <div class="table-option-label">🤖 自动选择（推荐）</div>
        <div class="table-option-preview">由插件智能选择最佳表格</div>
      </div>
    ` + optionsHTML;

    selector.innerHTML = `
      <div class="table-selector-overlay"></div>
      <div class="table-selector-content" id="table-selector-content-inner">
        <div class="table-selector-header">
          <span>📋 请选择要提取的表格</span>
          <button id="btn-close-selector">✕</button>
        </div>
        <div class="table-selector-list">
          ${optionsHTML}
        </div>
        <div class="table-selector-footer">
          <small style="color: #666;">点击表格选项选择，点击遮罩或✕关闭</small>
        </div>
      </div>
    `;

    document.body.appendChild(selector);

    // 内容框阻止事件冒泡，避免点击选项时触发遮罩关闭
    document.getElementById('table-selector-content-inner').addEventListener('click', function(e) {
      e.stopPropagation();
    });

    // 绑定关闭按钮
    document.getElementById('btn-close-selector').addEventListener('click', (e) => {
      e.stopPropagation();
      selector.remove();
    });

    // 点击遮罩关闭（只有点到遮罩自身才关闭）
    selector.querySelector('.table-selector-overlay').addEventListener('click', () => selector.remove());

    // selector容器本身（遮罩之外空白区域）点击也关闭
    selector.addEventListener('click', (e) => {
      if (e.target === selector) selector.remove();
    });

    // 绑定表格选项点击
    selector.querySelectorAll('.table-option').forEach(option => {
      option.addEventListener('click', function(e) {
        e.stopPropagation();
        const index = parseInt(this.dataset.index);
        if (index === -1) {
          // 自动选择
          window.selectedTable = null;
          window.updateStatus('🤖 已切换为自动选择模式');
        } else {
          // 选择指定表格
          window.selectedTable = window.detectedTables[index];
          window.updateStatus(`✓ 已选择: ${window.selectedTable.label}`);
        }

        // 更新选中状态
        selector.querySelectorAll('.table-option').forEach(o => o.classList.remove('selected'));
        this.classList.add('selected');

        // 延迟关闭选择器
        setTimeout(() => selector.remove(), 300);
      });
    });
  }

  // 查找表格（支持多种表格类型，优先使用用户选择的表格）
  window.findTable = function() {
    // 如果用户选择了特定表格，直接返回
    if (window.selectedTable) {
      console.log(`  ✓ 使用用户选择的表格: ${window.selectedTable.label}`);
      return window.selectedTable.element;
    }

    // 自动模式：检测所有表格，返回最佳匹配
    detectAllTables();

    if (window.detectedTables.length === 0) {
      console.log('  ❌ 未找到有效的数据表格');
      return null;
    }

    if (window.detectedTables.length === 1) {
      // 只有一个表格，直接使用
      console.log(`  ✓ 找到唯一表格: ${window.detectedTables[0].label}`);
      return window.detectedTables[0].element;
    }

    // 有多个表格，尝试智能选择
    // 优先选择行数最多的表格
    let bestTable = window.detectedTables.reduce((best, current) => {
      return current.rows > best.rows ? current : best;
    });

    console.log(`  ✓ 自动选择表格: ${bestTable.label} (${bestTable.rows}行)`);
    return bestTable.element;
  };

  // 查找滚动容器（支持多种滚动方式）
  window.findScrollContainer = function() {
    // 策略1：查找常见的滚动容器
    const selectors = [
      '.el-table__body-wrapper',      // Element UI
      '.ant-table-content',           // Ant Design
      '.ant-table-body',             // Ant Design
      '.table-body',                  // 通用
      '.table-scroll',                // 通用
      '.table-container',             // 通用
      '[class*="scroll"]',           // 包含scroll的class
      '[class*="body-wrapper"]',     // 包含body-wrapper的class
      '.dingtalk-table-body'          // 钉钉专用
    ];

    for (let s of selectors) {
      const elements = document.querySelectorAll(s);
      for (let el of elements) {
        if (el.scrollHeight > el.clientHeight) {
          console.log(`  ✓ 找到滚动容器: ${s}`);
          return el;
        }
      }
    }

    // 策略2：查找任何可滚动的元素
    const allElements = document.querySelectorAll('*');
    for (let el of allElements) {
      if (el.scrollHeight > el.clientHeight + 50) { // 高度差大于50px
        // 排除body和html
        if (el.tagName !== 'BODY' && el.tagName !== 'HTML') {
          console.log(`  ✓ 找到可滚动元素: ${el.tagName}.${el.className}`);
          return el;
        }
      }
    }

    console.log('  ⚠ 未找到滚动容器，使用window');
    return window;
  };

  // 获取单元格文本（处理各种情况，避免重复）
  function getCellText(cell) {
    if (!cell) return '';

    // 方法1：直接获取innerText（最快且最准确）
    let text = cell.innerText?.trim() || '';

    // 如果已经有文本，直接返回（避免重复处理）
    if (text && text.length > 0) {
      return text;
    }

    // 方法2：尝试获取title属性
    text = cell.getAttribute('title')?.trim() || '';
    if (text) return text;

    // 方法3：尝试获取data-value属性
    text = cell.getAttribute('data-value')?.trim() || '';
    if (text) return text;

    // 方法4：获取textContent（不包含HTML标签）
    text = cell.textContent?.trim() || '';
    if (text) return text;

    // 方法5：如果还是为空，检查输入框
    const input = cell.querySelector('input, textarea');
    if (input) {
      text = input.value || input.getAttribute('value') || '';
      if (text) return text;
    }

    return '';
  }

  // 智能检测ID列位置
  function findIdColumnIndex(rowData) {
    // 遍历所有列，找到纯数字的列（ID列）
    for (let i = 0; i < rowData.length; i++) {
      const text = rowData[i] || '';
      // ID通常是5-10位纯数字，且不是日期时间格式
      // 排除包含-、/、空格等分隔符的数字（可能是日期）
      if (/^\d{5,10}$/.test(text) && !/[\/\-\s:]/.test(text)) {
        return i;
      }
    }
    // 如果没找到，默认使用第3列或第4列
    return rowData.length > 4 ? 3 : 2;
  }

  // 智能检测时间列位置
  function findTimeColumnIndex(rowData) {
    // 遍历所有列，找到日期时间格式的列
    const timePatterns = [
      /^\d{4}-\d{2}-\d{2}/,           // 2024-03-16
      /^\d{4}\/\d{2}\/\d{2}/,          // 2024/03/16
      /^\d{2}:\d{2}:\d{2}/,           // 14:30:00
      /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/,  // 2024-03-16 14:30
      /\d{2}:\d{2}/                    // 14:30
    ];

    for (let i = 0; i < rowData.length; i++) {
      const text = rowData[i] || '';
      for (let pattern of timePatterns) {
        if (pattern.test(text)) {
          console.log(`  ✓ 检测到时间列在第 ${i} 列: "${text}"`);
          return i;
        }
      }
    }

    return -1; // 未找到时间列
  }

  // 提取当前可见数据（支持多种表格类型）
  window.extractCurrentData = function() {
    const container = window.findTable();
    if (!container) return 0;

    // 在选中的表格容器内查找行，避免匹配到其他表格
    // 优先查找 tbody（传统表格），然后是直接子元素中的行
    let rows = container.querySelectorAll('tbody tr');
    
    // 如果没有 tbody，查找 table > tr
    if (rows.length === 0) {
      rows = container.querySelectorAll('table > tr');
    }
    
    // 如果还是没有，查找直接的 div.row 或 tr
    if (rows.length === 0) {
      rows = container.querySelectorAll(':scope > tr, :scope > div[class*="row"]');
    }
    
    // 最后尝试通用选择器，但限定在当前表格内
    if (rows.length === 0) {
      rows = container.querySelectorAll('tr, div[class*="row"]');
    }
    
    let count = 0;
    let idColumnIndex = -1;
    let timeColumnIndex = -1;
    
    // 记录已处理的行元素，避免虚拟表格重用元素导致重复
    const processedRows = new Set();
    
    console.log(`  找到 ${rows.length} 行数据`);

    rows.forEach((row, index) => {
      // 跳过表头行（通常是第一行包含列名）
      if (index === 0 && row.querySelector('th')) {
        return;
      }
      
      // 跳过已处理的行元素（防止虚拟表格重复渲染）
      if (processedRows.has(row)) {
        return;
      }
      processedRows.add(row);
      
      // 策略1：优先查找 td 标签
      let cells = row.querySelectorAll('td');

      // 策略2：如果没有 td，查找 div.cell
      if (cells.length === 0) {
        cells = row.querySelectorAll('div[class*="cell"]');
      }

      // 策略3：如果还没有，查找所有直接子div
      if (cells.length === 0) {
        cells = row.querySelectorAll(':scope > div');
      }

      if (cells.length === 0) {
        console.log(`  第${index}行没有单元格，跳过`);
        return;
      }

      // 提取所有单元格数据
      const rowData = [];

      cells.forEach((cell, cellIndex) => {
        const text = getCellText(cell);
        rowData.push(text);
      });

      // 调试：显示第一行的所有列
      if (index === 0) {
        console.log('  表格结构分析:');
        rowData.forEach((text, i) => {
          console.log(`    列${i}: "${text.substring(0, 40)}"`);
        });
        // 检测ID列位置
        idColumnIndex = findIdColumnIndex(rowData);
        console.log(`  ✓ 检测到ID列在第 ${idColumnIndex} 列`);

        // 检测时间列位置
        timeColumnIndex = findTimeColumnIndex(rowData);
        if (timeColumnIndex >= 0) {
          console.log(`  ✓ 检测到时间列在第 ${timeColumnIndex} 列`);
        } else {
          console.log(`  ℹ 未检测到时间列，将使用ID去重`);
        }
      }

      // 检查是否是有效数据行
      const hasData = rowData.some(text => text && text.length > 0 && text !== '-');
      if (!hasData) {
        console.log(`  第${index}行无有效数据，跳过`);
        return;
      }

      // 生成唯一键 - 根据去重模式选择
      const idValue = idColumnIndex >= 0 ? (rowData[idColumnIndex] || '') : '';
      const timeValue = timeColumnIndex >= 0 ? (rowData[timeColumnIndex] || '') : '';
      
      // 获取去重模式（默认为 id+time）
      const dedupMode = (typeof window !== 'undefined' && window.dedupMode) || 'id+time';

      // 智能生成key
      let key = '';
      if (idValue && idValue.match(/^\d+$/) && idValue.length >= 4) {
        // 有有效ID（>=4位纯数字）
        if (dedupMode === 'id-only') {
          // 模式1：仅按ID去重
          key = idValue;
        } else {
          // 模式2（默认）：按 ID + 时间去重
          if (timeValue && timeValue.length > 0) {
            key = `${idValue}_${timeValue}`;
          } else {
            key = idValue;
          }
        }
      } else if (rowData[1] && rowData[2]) {
        // 没有有效ID，使用姓名+手机号去重
        if (dedupMode === 'id-only') {
          key = `${rowData[1]}_${rowData[2]}`;
        } else {
          key = `${rowData[1]}_${rowData[2]}_${timeValue || ''}`;
        }
      } else {
        key = rowData.filter(t => t && t !== '-' && t.match(/\S/)).join('_');
      }

      // 确保key不为空
      if (key && key.length > 0) {
        if (!window.uniqueKeys.has(key)) {
          window.uniqueKeys.add(key);
          window.extractedData.push(rowData);
          count++;

          // 显示提取的信息（只显示前几列避免日志太长）
          const displayName = rowData[1] || rowData[2] || 'N/A';
          const displayId = idValue || 'N/A';
          const displayTime = timeValue || 'N/A';
          console.log(`  ✓ 提取第${count}行: 姓名="${displayName}", ID=${displayId}, 时间="${displayTime}"`);
        } else {
          console.log(`  ✗ 跳过重复行: key=${key.substring(0, 40)}`);
        }
      } else {
        console.log(`  ✗ 跳过无效行: key为空`);
      }
    });

    console.log(`  本次提取完成，新增 ${count} 条记录`);
    return count;
  };

  // 滚动到下一屏
  window.scrollNext = function() {
    const container = window.findScrollContainer();

    if (container === window) {
      const currentScroll = window.pageYOffset;
      const viewportHeight = window.innerHeight;
      const newScroll = currentScroll + viewportHeight - 20;
      window.scrollTo(0, newScroll);
    } else {
      const currentScroll = container.scrollTop;
      const viewportHeight = container.clientHeight;
      const newScroll = currentScroll + viewportHeight - 20;
      container.scrollTop = newScroll;
    }
  };

  // 更新状态
  window.updateStatus = function(msg) {
    const el = document.getElementById('ext-status');
    if (el) el.innerText = msg;
  };

  // 更新信息
  window.updateInfo = function(msg) {
    const el = document.getElementById('ext-info');
    if (el) el.innerText = msg;
  };

  // 获取滚动延迟
  window.getScrollDelay = function() {
    const el = document.getElementById('scroll-delay');
    return el ? parseInt(el.value) : 1500;
  };

  // 停止提取
  window.stopExtraction = function() {
    window.shouldStop = true;
    window.isRunning = false;
    window.updateStatus('⏹ 提取已停止');
  };

  // 下载CSV（使用UTF-8 with BOM编码，兼容Excel和WPS）
  window.downloadCSV = function() {
    if (window.extractedData.length === 0) {
      alert('没有数据！请先点击"开始提取"');
      return;
    }

    // 生成时间戳
    const now = new Date();
    const timeStr = now.toTimeString().slice(0,5).replace(':', '-');
    const fileName = `钉钉数据_${now.toISOString().slice(0,10)}_${timeStr}.csv`;

    let csv = '';
    window.extractedData.forEach(row => {
      const quoted = row.map(c => '"' + String(c).replace(/"/g, '""') + '"');
      csv += quoted.join(',') + '\n';
    });

    // 方法1：使用ArrayBuffer + Uint8Array 确保BOM正确写入
    const BOM = new Uint8Array([0xEF, 0xBB, 0xBF]);
    const csvBytes = new TextEncoder().encode(csv);
    const combined = new Uint8Array(BOM.length + csvBytes.length);
    combined.set(BOM, 0);
    combined.set(csvBytes, BOM.length);

    const blob = new Blob([combined], {type: 'text/csv;charset=utf-8'});

    // 使用 download 属性触发下载
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();

    // 清理
    setTimeout(() => URL.revokeObjectURL(url), 100);

    window.updateStatus(`✅ CSV文件已下载：${fileName}`);
  };

  // 开始提取
  window.startExtraction = async function() {
    if (window.isRunning) {
      alert('提取正在进行中...');
      return;
    }

    window.isRunning = true;
    window.shouldStop = false;
    window.extractedData = [];
    window.uniqueKeys = new Set();
    window.updateStatus('🚀 开始提取数据，请稍候...');
    window.updateInfo('总计: 0 条');

    // 初始提取
    let added = window.extractCurrentData();
    window.updateStatus(`✓ 初始提取: ${added} 条记录`);
    window.updateInfo(`总计: ${window.extractedData.length} 条`);

    // 循环滚动提取
    let noNewCount = 0;
    const scrollDelay = window.getScrollDelay();

    for (let i = 1; i <= 100; i++) {
      if (window.shouldStop) {
        window.updateStatus('⏹ 提取已停止');
        break;
      }

      window.updateStatus(`第 ${i} 次滚动提取中...`);

      // 滚动
      window.scrollNext();

      // 等待加载
      await new Promise(r => setTimeout(r, scrollDelay));

      // 提取数据
      const before = window.extractedData.length;
      added = window.extractCurrentData();
      const after = window.extractedData.length;

      window.updateInfo(`总计: ${after} 条 (本次+${added})`);

      // 检查是否完成
      if (added === 0) {
        noNewCount++;
        if (noNewCount >= 3) {
          window.updateStatus('✅ 数据提取完成！所有数据已提取');
          break;
        }
      } else {
        noNewCount = 0;
      }

      // 检查是否到达底部
      const container = window.findScrollContainer();
      let atBottom = false;
      if (container === window) {
        atBottom = window.innerHeight + window.pageYOffset >= document.documentElement.scrollHeight - 50;
      } else {
        atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 50;
      }

      if (atBottom) {
        window.updateStatus('✅ 已到达页面底部，提取完成');
        break;
      }
    }

    window.isRunning = false;
    window.updateStatus(`🎉 提取完成！共 ${window.extractedData.length} 条记录`);

    // 自动下载
    if (window.extractedData.length > 0) {
      window.downloadCSV();
    } else {
      window.updateStatus('❌ 未提取到任何数据');
    }
  };

  // 插件消息监听
  if (typeof chrome !== 'undefined' && chrome.runtime) {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      console.log('📩 收到消息:', request);
      if (request.action === 'showPanel') {
        // 接收去重模式参数并保存
        window.dedupMode = request.dedupMode || 'id+time';
        console.log('📊 去重模式:', window.dedupMode);
        createControlPanel();
        sendResponse({status: 'success'});
      }
    });
    console.log('✅ 消息监听器已注册');
  } else {
    console.log('❌ chrome.runtime 不可用');
  }

  // 页面加载完成后显示提示
  console.log('📊 钉钉数据提取助手已加载，点击插件图标显示控制面板');

  // 立即执行函数结尾
})();
