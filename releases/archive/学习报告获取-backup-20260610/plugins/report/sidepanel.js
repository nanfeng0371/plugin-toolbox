/**
 * 侧边面板主逻辑
 * 负责：UI渲染、排序筛选、与background通信、Excel导出
 */

(function() {
  'use strict';

  // ===== State =====
  let allData = [];          // 全部学生数据（分析后的）
  let filteredData = [];     // 筛选后数据
  let sortCol = null;        // 当前排序列
  let sortAsc = true;        // 排序方向

  // ===== 表格列定义 =====
  const COLS = [
    { id: 'idx',      label: '#',            width: 36,  fixed: true },
    { id: 'name',     label: '姓名',         width: 56,  fixed: true, align: 'left' },
    { id: 'tag',      label: '综合标签',      width: 100, render: r => badge(r.overallTag, r.overallTagClass) },
    { id: 'rate',     label: '回答率%',       width: 62,  number: true, render: r => pct(r.rate) },
    { id: 'partTag',  label: '参与度',        width: 90,  render: r => badge(r.label, getPartClass(r.tag)) },
    { id: 'totalAsk', label: '提问数',        width: 52,  number: true },
    { id: 'totalAns', label: '回答数',        width: 52,  number: true },
    { id: 'mastery',  label: '掌握度',        width: 50,  render: r => `<b>${r.masteryRating}</b>` },
    { id: 'firstRt',  label: '首次答对率%',   width: 80,  number: true, render: r => pct(r.firstRate) },
    { id: 'guideRt', label: '引导答对率%',   width: 80,  number: true, render: r => pct(r.guideRate) },
    { id: 'exerTag',  label: '练习情况',      width: 86,  render: r => badge(r.label, getExerClass(r.tag)) },
    { id: 'exerRt',   label: '练习正确率%',   width: 82,  number: true, render: r => r.rate !== null ? pct(r.rate) : '-' },
    { id: 'wrongNum', label: '错题本',        width: 52,  number: true },
    { id: 'quadrant', label: '四象限',        width: 48,  render: r => `<b>${r.quadrant}</b>` },
    { id: 'diagnosis',label: '一句话诊断',     width: 200, align: 'left' },
  ];

  function badge(text, cls) {
    return text ? `<span class="badge-tag ${cls || ''}">${text}</span>` : '-';
  }
  function pct(val) {
    if (val === null || val === undefined) return '-';
    const v = Number(val);
    return `<span class="${v < 40 ? 'pct-low' : v < 60 ? 'pct-mid' : 'pct-high'}">${v}%</span>`;
  }
  function getPartClass(t) {
    return { success:'tag-excellent', normal:'tag-good', warn:'tag-warn', danger:'tag-danger', critical:'tag-critical' }[t] || '';
  }
  function getExerClass(t) {
    return { success:'tag-excellent', good:'tag-good', warn:'tag-warn', danger:'tag-danger' }[t] || '';
  }

  // ===== Init =====
  document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    checkConnection();
  });

  function bindEvents() {
    $('#btnFetch').onclick = startFetch;
    $('#btnExport').onclick = exportExcel;
    $('#btnCopyList').onclick = copyProblemList;
    $('#filterTag').onchange = applyFilter;
    $('#searchName').oninput = debounce(applyFilter, 300);
  }

  // ===== Connection Check =====
  function checkConnection() {
    chrome.runtime.sendMessage({ type: 'CHECK_CONNECTION' }, (res) => {
      if (chrome.runtime.lastError || !res || !res.connected) {
        setStatus(false);
        $('#statusText').textContent = '未检测到工作台页面，请先打开工作台';
      } else {
        setStatus(true, res.count);
        $('#statusText').textContent = `已连接工作台 ✅`;
        $('#studentCount').textContent = `学生数：${res.count}`;
      }
    });
  }

  function setStatus(connected, count) {
    const dot = $('#statusDot');
    dot.className = 'status-dot ' + (connected ? 'connected' : 'disconnected');
    if (!connected) {
      $('#btnFetch').disabled = true;
    } else {
      $('#btnFetch').disabled = false;
    }
  }

  // ===== Fetch Data =====
  async function startFetch() {
    $('#btnFetch').disabled = true;
    $('#progressArea').classList.add('show');
    $('#emptyState').style.display = 'none';
    updateProgress(0, 0, '正在获取学生列表...');

    try {
      // Step1: 获取学生列表
      const listRes = await sendMessage({ type: 'FETCH_STUDENT_LIST' });
      if (listRes.error) throw new Error(listRes.error);

      const students = listRes.data || [];
      const total = students.length;
      if (total === 0) throw new Error('当前筛选条件下没有学生数据');

      updateProgress(0, total, `共${total}个学生，开始逐个获取报告...`);

      // Step2-4: 循环获取每个学生的数据
      allData = [];
      for (let i = 0; i < students.length; i++) {
        const s = students[i];
        updateProgress(i + 1, total, `正在处理 (${i + 1}/${total}): ${s.studentName}`);

        try {
          const dataRes = await sendMessage({
            type: 'FETCH_REPORT_DATA',
            payload: {
              periodId: s.periodId,
              studentId: s.studentId,
              studentName: s.studentName,
              courseClassify: s.courseClassify,
              studyVersion: s.studyVersion
            }
          });

          if (dataRes && dataRes.data) {
            // 运行分析引擎
            const analyzed = Analysis.analyze(dataRes.data);
            analyzed._rawIndex = i;
            allData.push(analyzed);
          }
        } catch (e) {
          console.warn(`[${s.studentName}] 数据获取失败:`, e.message);
        }

        // 每5个更新一次UI
        if ((i + 1) % 5 === 0 || i === total - 1) {
          applyFilter();
        }
      }

      // 完成
      updateProgress(total, total, `完成! 成功获取 ${allData.length}/${total} 个学生`);
      $('#btnExport').disabled = false;

      // 延迟隐藏进度条
      setTimeout(() => {
        $('#progressArea').classList.remove('show');
      }, 2000);

    } catch (err) {
      updateProgress(0, 0, '❌ 错误: ' + err.message);
      $('#btnFetch').disabled = false;
      console.error(err);
    }
  }

  // ===== Render Table =====
  function renderTable(data) {
    const table = $('#dataTable');
    if (data.length === 0) {
      table.style.display = 'none';
      $('#emptyState').style.display = 'flex';
      $('#statsBar').style.display = 'none';
      return;
    }

    table.style.display = 'table';
    $('#emptyState').style.display = 'none';
    $('#statsBar').style.display = 'flex';

    // Header
    let html = '<thead><tr>';
    for (const col of COLS) {
      html += `<th data-col="${col.id}" style="width:${col.width}px">${col.label}</th>`;
    }
    html += '</tr></thead><tbody>';

    // Rows
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const cls = row.rowClass || 'row-normal';
      html += `<tr class="${cls}" data-idx="${i}">`;
      html += `<td>${i + 1}</td>`;
      html += `<td class="text-left"><b>${row.name}</b></td>`;

      for (let j = 2; j < COLS.length; j++) {
        const col = COLS[j];
        let val = row[col.id];
        if (col.render) val = col.render(row);
        else if (val === undefined || val === null) val = '-';
        else val = String(val);

        const align = col.align === 'left' ? 'text-left' : (col.number ? 'number' : '');
        html += `<td class="${align}" title="${typeof val === 'string' ? val.replace(/<[^>]+/g,'') : ''}">${val}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody>';
    table.innerHTML = html;

    // Bind sort events
    table.querySelectorAll('th[data-col]').forEach(th => {
      th.onclick = () => sortByColumn(th.dataset.col);
    });

    // Update stats
    updateStats(data);
  }

  // ===== Stats =====
  function updateStats(data) {
    $('#statTotal').textContent = data.length;
    $('#statDanger').textContent = data.filter(r => ['danger','critical'].includes(r.participation?.tag)).length;
    $('#statWarn').textContent = data.filter(r => r.participation?.tag === 'warn').length;
    $('#statSuccess').textContent = data.filter(r => r.participation?.tag === 'success').length;

    const withRate = data.filter(r => r.rate !== null && !isNaN(r.rate));
    const avgR = withRate.length > 0 ? withRate.reduce((s,r)=>s+r.rate,0)/withRate.length : 0;
    $('#statAvgRate').textContent = withRate.length > 0 ? Math.round(avgR*10)/10 + '%' : '--';
  }

  // ===== Sort =====
  function sortByColumn(colId) {
    if (sortCol === colId) { sortAsc = !sortAsc; }
    else { sortCol = colId; sortAsc = true; }

    filteredData.sort((a, b) => {
      let va = a[colId], vb = b[colId];
      if (typeof va === 'number') return sortAsc ? va - vb : vb - va;
      if (typeof va === 'string') return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      return 0;
    });

    // Update header styles
    $('#dataTable').querySelectorAll('th').forEach(th => {
      th.classList.remove('sorted-asc', 'sorted-desc');
      if (th.dataset.col === colId) {
        th.classList.add(sortAsc ? 'sorted-asc' : 'sorted-desc');
      }
    });

    renderTable(filteredData);
  }

  // ===== Filter =====
  function applyFilter() {
    const tagVal = $('#filterTag').value;
    const nameVal = $('#searchName').value.trim().toLowerCase();

    filteredData = allData.filter(r => {
      // Tag filter
      if (tagVal === 'danger') {
        if (!['danger','critical'].includes(r.participation?.tag)) return false;
      } else if (tagVal === 'warning') {
        if (r.participation?.tag !== 'warn') return false;
      } else if (tagVal === 'success') {
        if (r.participation?.tag !== 'success') return false;
      } else if (tagVal === 'normal') {
        if (r.participation?.tag !== 'normal') return false;
      }

      // Name search
      if (nameVal && !r.name.toLowerCase().includes(nameVal)) return false;

      return true;
    });

    renderTable(filteredData);
  }

  // ===== Export Excel =====
  async function exportExcel() {
    if (allData.length === 0) return;

    $('#btnExport').textContent = '⏳ 导出中...';

    try {
      await sendMessage({ type: 'EXPORT_EXCEL', data: allData });
      $('#btnExport').textContent = '✅ 已导出';
      setTimeout(() => { $('#btnExport').textContent = '⬇️ 下载Excel'; }, 2000);
    } catch (err) {
      alert('导出失败: ' + err.message);
      $('#btnExport').textContent = '⬇️ 下载Excel';
    }
  }

  // 监听来自background的下载回退
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'DOWNLOAD_EXCEL') {
      const binary = atob(msg.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = msg.filename || '学习报告分析.xlsx';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  });

  // ===== Copy Problem List =====
  function copyProblemList() {
    const problems = allData.filter(r =>
      ['danger','critical','warn'].includes(r.participation?.tag)
    );
    if (problems.length === 0) { alert('没有问题学生'); return; }

    let text = '=== 问题学生名单 ===\n\n';
    for (const p of problems) {
      text += `${p.name} | 回答率:${p.rate}% | ${p.overallTag} | ${p.diagnosis}\n`;
    }
    text += `\n共 ${problems.length} 人`;

    navigator.clipboard.writeText(text).then(() => {
      $('#btnCopyList').textContent = '✅ 已复制!';
      setTimeout(() => { $('#btnCopyList').textContent = '📋 复制问题名单'; }, 1500);
    });
  }

  // ===== Progress UI =====
  function updateProgress(current, total, text) {
    const pct = total > 0 ? Math.round(current / total * 100) : 0;
    $('#progressFill').style.width = Math.max(pct, 2) + '%';
    $('#progressFill').textContent = `${current}/${total}`;
    $('#progressPct').textContent = pct + '%';
    $('#progressText').textContent = text;
  }

  // ===== Helpers =====
  function $(sel) { return document.querySelector(sel); }
  function sendMessage(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(res);
      });
    });
  }
  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

})();
