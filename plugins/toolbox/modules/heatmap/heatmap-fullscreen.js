(function () {
  'use strict';

  // ===== 常量 =====

  var WEEK_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  var COLOR_COOL = [
    { r: 255, g: 255, b: 255 },
    { r: 179, g: 229, b: 252 },
    { r: 79,  g: 195, b: 247 },
    { r: 2,   g: 136, b: 209 },
    { r: 1,   g: 87,  b: 155 }
  ];

  var AXIS_WIDTH = 82;
  var CELL_HEIGHT = 36;
  var HEADER_HEIGHT = 42;
  var WEEK_GAP = 6; // 周分组之间的间距

  // ===== 状态 =====

  var heatmapData = null;
  var anomalyResult = null;
  var rawSchedules = null;     // 原始排课数据（日期级）
  var allowedWeekDays = [];    // 允许排课的星期（从 cells 推导）
  var dateRows = [];           // [{ date, weekDay, weekGroup, rowIndex, y }]
  var canvasCells = {};        // key: "date|tb" => cell info
  var selectedKey = null;
  var hoveredKey = null;

  var canvas = document.getElementById('fs-canvas');
  var tooltip = document.getElementById('fs-tooltip');

  // ===== 颜色工具 =====

  function getDensityColor(density) {
    var idx = Math.max(0, Math.min(1, density)) * (COLOR_COOL.length - 1);
    var lower = Math.floor(idx);
    var upper = Math.min(lower + 1, COLOR_COOL.length - 1);
    var t = idx - lower;
    return {
      r: Math.round(COLOR_COOL[lower].r + t * (COLOR_COOL[upper].r - COLOR_COOL[lower].r)),
      g: Math.round(COLOR_COOL[lower].g + t * (COLOR_COOL[upper].g - COLOR_COOL[lower].g)),
      b: Math.round(COLOR_COOL[lower].b + t * (COLOR_COOL[upper].b - COLOR_COOL[lower].b))
    };
  }

  function getTextColor(r, g, b) {
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55 ? '#333' : '#fff';
  }

  // ===== 统计 Badge =====

  function renderStats(data, anomaly) {
    if (!data) return;
    var anomalyCount = (anomaly && anomaly.anomalies) ? anomaly.anomalies.length : 0;
    var statsRow = document.getElementById('fs-stats-row');
    if (!statsRow) return;

    var items = [
      { value: data.totalSchedules || 0,              label: '总排课', color: '#1976d2' },
      { value: data.totalStudents || 0,               label: '在排学员', color: '#7b1fa2' },
      { value: anomalyCount,                          label: '异常数', color: anomalyCount > 0 ? '#e53935' : '#10b981' },
      { value: (data.timeBuckets || []).length,       label: '活跃时段', color: '#f59e0b' },
      { value: data.maxCount || 0,                    label: '单格最大', color: '#0097a7' }
    ];

    statsRow.innerHTML = items.map(function (s) {
      return '<div class="fs-stat-badge">' +
        '<div>' +
          '<div class="fs-stat-badge-value" style="color:' + s.color + '">' + s.value + '</div>' +
          '<div class="fs-stat-badge-label">' + s.label + '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  // ===== 日期/周分组工具 =====

  /** 获取某日期的"周一日期"（用于周分组），如 2026-06-07(周日) → 2026-06-01(周一) */
  function getWeekMonday(dateStr) {
    var parts = dateStr.split('-');
    var d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    var day = d.getDay(); // 0=Sun
    var diff = day === 0 ? -6 : 1 - day; // 周日偏移-6，其他偏移到周一
    d.setDate(d.getDate() + diff);
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var da = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + da;
  }

  /** 从日期字符串获取星期几 0=Sun */
  function getWeekDay(dateStr) {
    var parts = dateStr.split('-');
    return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10)).getDay();
  }

  /** 格式化日期为短格式 "06/02" */
  function formatShortDate(dateStr) {
    var parts = dateStr.split('-');
    return parts[1].replace(/^0/, '') + '/' + parts[2].replace(/^0/, '');
  }

  /** 计算时间桶标签（与 background.js 一致：30分钟桶） */
  function computeTimeBucket(timeStr) {
    if (!timeStr) return null;
    // Unix 毫秒时间戳
    if (/^\d{13}$/.test(timeStr)) {
      var d = new Date(parseInt(timeStr, 10));
      if (isNaN(d.getTime())) return null;
      var h = d.getHours(), m = d.getMinutes();
      var totalMin = h * 60 + m;
      var bucketMin = Math.floor(totalMin / 30) * 30;
      var bh = Math.floor(bucketMin / 60), bm = bucketMin % 60;
      return String(bh).padStart(2, '0') + ':' + String(bm).padStart(2, '0') + '-' +
        String(Math.floor((bucketMin + 30) / 60)).padStart(2, '0') + ':' + String((bucketMin + 30) % 60).padStart(2, '0');
    }
    // 字符串 "HH:MM" 或 "HH:MM:SS"
    var m = timeStr.match(/(\d{2}):(\d{2})/);
    if (!m) return null;
    var totalMin = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    var bucketMin = Math.floor(totalMin / 30) * 30;
    var bh = Math.floor(bucketMin / 60), bm = bucketMin % 60;
    return String(bh).padStart(2, '0') + ':' + String(bm).padStart(2, '0') + '-' +
      String(Math.floor((bucketMin + 30) / 60)).padStart(2, '0') + ':' + String((bucketMin + 30) % 60).padStart(2, '0');
  }

  // ===== 热力图渲染 =====

  function getCtx() {
    if (!canvas) return null;
    return canvas.getContext('2d');
  }

  function computeCellWidth(containerWidth, numCols) {
    var available = containerWidth - AXIS_WIDTH - 4;
    var w = Math.floor(available / numCols);
    return Math.max(20, Math.min(64, w));
  }

  /** 从 rawSchedules + heatmapData 构建日期级网格 */
  function buildDateGrid(data, raw) {
    // 推导真正允许排课的星期（从 data.cells 中取 isAllowed=true 的 weekDay 去重）
    var allowed = [];
    if (data && data.cells) {
      var wdSet = {};
      for (var i = 0; i < data.cells.length; i++) {
        if (data.cells[i].isAllowed) wdSet[data.cells[i].weekDay] = true;
      }
      allowed = Object.keys(wdSet).map(Number);
    }
    // 兜底：如果推导为空，显示全部
    if (allowed.length === 0) allowed = [0, 1, 2, 3, 4, 5, 6];
    allowedWeekDays = allowed;

    // 从 rawSchedules 构建 dateMap: date → { timeBucketLabel → { studentSet, count } }
    var dateMap = {};
    if (raw && raw.length > 0) {
      for (var i = 0; i < raw.length; i++) {
        var s = raw[i];
        if (!s.classDate || !s.startTime) continue;
        var bucketLabel = computeTimeBucket(s.startTime);
        if (!bucketLabel) continue;

        if (!dateMap[s.classDate]) dateMap[s.classDate] = {};
        if (!dateMap[s.classDate][bucketLabel]) {
          dateMap[s.classDate][bucketLabel] = { studentSet: new Set(), count: 0 };
        }
        dateMap[s.classDate][bucketLabel].studentSet.add(s.studentId || '?');
        dateMap[s.classDate][bucketLabel].count++;
      }
    }

    // 生成日期范围内所有允许排课日
    var allDates = [];
    var dateRange = data && data.dateRange ? data.dateRange : {};
    if (dateRange.start && dateRange.end) {
      var startParts = dateRange.start.split('-');
      var endParts = dateRange.end.split('-');
      var cursor = new Date(parseInt(startParts[0], 10), parseInt(startParts[1], 10) - 1, parseInt(startParts[2], 10));
      var end = new Date(parseInt(endParts[0], 10), parseInt(endParts[1], 10) - 1, parseInt(endParts[2], 10));
      while (cursor <= end) {
        var y = cursor.getFullYear();
        var m = String(cursor.getMonth() + 1).padStart(2, '0');
        var d = String(cursor.getDate()).padStart(2, '0');
        var dateStr = y + '-' + m + '-' + d;
        allDates.push(dateStr);
        cursor.setDate(cursor.getDate() + 1);
      }
    }

    // 使用现有 timeBuckets
    var buckets = data && data.timeBuckets ? data.timeBuckets : [];

    // 计算最大人数
    var maxCount = 0;

    // 生成所有日期行（可能包含 rawSchedules 中有但不在 range 内的日期）
    var seenDates = {};
    for (var k = 0; k < allDates.length; k++) {
      seenDates[allDates[k]] = true;
    }
    // 也加入 rawSchedules 中在允许星期内的日期
    if (raw && raw.length > 0) {
      for (var r = 0; r < raw.length; r++) {
        var rd = raw[r].classDate;
        if (!rd) continue;
        if (!seenDates[rd]) {
          allDates.push(rd);
          seenDates[rd] = true;
        }
      }
    }
    allDates.sort();

    // 构建行数据
    var rows = [];
    var prevWeekMonday = null;
    var weekGroupIdx = -1;
    for (var ri = 0; ri < allDates.length; ri++) {
      var dt = allDates[ri];
      var wd = getWeekDay(dt);
      var wm = getWeekMonday(dt);

      if (wm !== prevWeekMonday) {
        weekGroupIdx++;
        prevWeekMonday = wm;
      }

      rows.push({ date: dt, weekDay: wd, weekGroup: weekGroupIdx });
    }

    // 构建 cells（仅填充已有数据的格子）
    var cells = [];
    for (var ci = 0; ci < rows.length; ci++) {
      var row = rows[ci];
      var dateData = dateMap[row.date] || {};

      for (var col = 0; col < buckets.length; col++) {
        var tb = buckets[col];
        var slot = dateData[tb.label];
        var count = slot ? slot.studentSet.size : 0;
        if (count > maxCount) maxCount = count;

        var isOk = allowed.indexOf(row.weekDay) !== -1;

        cells.push({
          date: row.date,
          weekDay: row.weekDay,
          weekGroup: row.weekGroup,
          rowIndex: ci,
          colIndex: col,
          timeBucket: tb.label,
          studentCount: count,
          isAllowed: isOk,
          density: 0
        });
      }
    }

    // 计算密度
    for (var di = 0; di < cells.length; di++) {
      cells[di].density = maxCount > 0 ? cells[di].studentCount / maxCount : 0;
    }

    return {
      rows: rows,
      cells: cells,
      buckets: buckets,
      numCols: buckets.length,
      numRows: rows.length,
      maxCount: maxCount
    };
  }

  function renderHeatmap(data, raw) {
    if (!data || !canvas) return;
    if (!raw) raw = rawSchedules;

    var grid = buildDateGrid(data, raw);
    var rows = grid.rows;
    var cells = grid.cells;
    var buckets = grid.buckets;
    var numCols = grid.numCols;
    var numRows = grid.numRows;
    var maxCount = grid.maxCount;

    if (numRows === 0 || numCols === 0) return;

    dateRows = rows;

    var ctx = getCtx();
    if (!ctx) return;

    var container = canvas.parentElement;
    var containerW = container.clientWidth - 40;
    var cellW = computeCellWidth(containerW, numCols);

    // 计算总尺寸：weekGroup 间的间隙
    var totalRowHeight = 0;
    var totalWeekGaps = 0;
    var yPositions = [];
    var prevWeekGroup = null;
    for (var ri = 0; ri < numRows; ri++) {
      if (prevWeekGroup !== null && rows[ri].weekGroup !== prevWeekGroup) {
        totalWeekGaps += WEEK_GAP;
      }
      yPositions.push(totalRowHeight + totalWeekGaps);
      totalRowHeight += CELL_HEIGHT;
      prevWeekGroup = rows[ri].weekGroup;
    }
    var totalH = HEADER_HEIGHT + totalRowHeight + totalWeekGaps;
    var totalW = AXIS_WIDTH + numCols * cellW;
    var dpr = window.devicePixelRatio || 1;

    canvas.width = totalW * dpr;
    canvas.height = totalH * dpr;
    canvas.style.width = totalW + 'px';
    canvas.style.height = totalH + 'px';
    ctx = getCtx();
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);

    canvasCells = {};

    // 背景
    ctx.fillStyle = '#fafbfc';
    ctx.fillRect(0, 0, totalW, totalH);

    // Y轴背景
    ctx.fillStyle = '#f0f4f8';
    ctx.fillRect(0, 0, AXIS_WIDTH, totalH);

    // 分割线
    ctx.strokeStyle = '#d0d8e4';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(AXIS_WIDTH, 0);
    ctx.lineTo(AXIS_WIDTH, totalH);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, HEADER_HEIGHT);
    ctx.lineTo(totalW, HEADER_HEIGHT);
    ctx.stroke();

    // X轴时间标签
    ctx.font = '11px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = '#6b7a8a';
    ctx.textBaseline = 'middle';
    for (var col = 0; col < numCols; col++) {
      var bk = buckets[col];
      var lbl = bk.label.split('-')[0];
      if (lbl.charAt(0) === '0') lbl = lbl.substring(1);
      var xc = AXIS_WIDTH + col * cellW + cellW / 2;
      if (cellW >= 44 || col % 2 === 0) {
        ctx.textAlign = 'center';
        ctx.fillText(lbl, xc, HEADER_HEIGHT / 2);
      }
    }

    // Y轴：日期 + 星期
    var prevWeekG = null;
    var rowY = HEADER_HEIGHT;
    for (var ri2 = 0; ri2 < numRows; ri2++) {
      var r = rows[ri2];
      var wd = r.weekDay;

      // 周分组分隔
      if (prevWeekG !== null && r.weekGroup !== prevWeekG) {
        // 分隔条
        ctx.fillStyle = '#e8ecf1';
        ctx.fillRect(0, rowY - 1, totalW, WEEK_GAP + 2);
        ctx.fillStyle = '#b0bec5';
        ctx.fillRect(AXIS_WIDTH, rowY + Math.floor(WEEK_GAP / 2), totalW - AXIS_WIDTH, 1);
        rowY += WEEK_GAP;
      }
      prevWeekG = r.weekGroup;

      var yCenter = rowY + CELL_HEIGHT / 2;
      // 日期标签在 Y 轴区域
      ctx.font = 'bold 12px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = (allowedWeekDays.indexOf(wd) === -1) ? '#b0bec5' : '#1976d2';
      ctx.fillText(formatShortDate(r.date) + ' ' + WEEK_NAMES[wd], AXIS_WIDTH / 2, yCenter);

      rowY += CELL_HEIGHT;
    }

    // 单元格
    for (var ci = 0; ci < cells.length; ci++) {
      var cell = cells[ci];
      var cx = AXIS_WIDTH + cell.colIndex * cellW;
      var cy = HEADER_HEIGHT + yPositions[cell.rowIndex];
      // 加上前置的间隙
      var gapsBefore = 0;
      for (var g = 0; g < cell.rowIndex; g++) {
        if (g > 0 && rows[g].weekGroup !== rows[g - 1].weekGroup) gapsBefore += WEEK_GAP;
      }
      cy = HEADER_HEIGHT + cell.rowIndex * CELL_HEIGHT + gapsBefore;

      var key = cell.date + '|' + cell.timeBucket;

      canvasCells[key] = {
        x: cx, y: cy, w: cellW, h: CELL_HEIGHT,
        date: cell.date, weekDay: cell.weekDay, timeBucket: cell.timeBucket,
        studentCount: cell.studentCount, isAllowed: cell.isAllowed, density: cell.density
      };

      if (!cell.isAllowed && cell.studentCount === 0) {
        // 不排课星期且无数据：灰底 + 斜条纹。有真实排课数据时正常显示
        ctx.fillStyle = '#f2f3f5';
        ctx.fillRect(cx, cy, cellW, CELL_HEIGHT);
        // 斜线纹理
        ctx.save();
        ctx.beginPath();
        ctx.rect(cx, cy, cellW, CELL_HEIGHT);
        ctx.clip();
        ctx.strokeStyle = 'rgba(180,185,195,0.35)';
        ctx.lineWidth = 0.8;
        var step = 8;
        for (var sx = cx - CELL_HEIGHT; sx < cx + cellW + CELL_HEIGHT; sx += step) {
          ctx.beginPath();
          ctx.moveTo(sx, cy);
          ctx.lineTo(sx + CELL_HEIGHT, cy + CELL_HEIGHT);
          ctx.stroke();
        }
        ctx.restore();
      } else {
        // 允许排课日：填色 + 数字（含 0）
        var color = getDensityColor(cell.density);
        ctx.fillStyle = 'rgb(' + color.r + ',' + color.g + ',' + color.b + ')';
        ctx.fillRect(cx, cy, cellW, CELL_HEIGHT);

        // 高密度光晕
        if (cell.density > 0.35 && cell.studentCount > 0) {
          var alpha = Math.min(0.07, cell.density * 0.1);
          var grad = ctx.createRadialGradient(cx + cellW / 2, cy + CELL_HEIGHT / 4, 0, cx + cellW / 2, cy + CELL_HEIGHT / 2, cellW);
          grad.addColorStop(0, 'rgba(255,255,255,' + alpha + ')');
          grad.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = grad;
          ctx.fillRect(cx, cy, cellW, CELL_HEIGHT);
        }

        // 数字（0 不显示）
        if (cell.studentCount > 0 && cellW >= 22) {
          var textColor = getTextColor(color.r, color.g, color.b);
          ctx.fillStyle = textColor;
          ctx.font = 'bold ' + (cellW >= 36 ? '12' : '10') + 'px "Microsoft YaHei", sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(cell.studentCount), cx + cellW / 2, cy + CELL_HEIGHT / 2);
        }
      }

      // 选中/悬浮/边框
      if (selectedKey === key) {
        ctx.strokeStyle = '#ff6600';
        ctx.lineWidth = 2.5;
        ctx.strokeRect(cx + 1.25, cy + 1.25, cellW - 2.5, CELL_HEIGHT - 2.5);
      } else if (hoveredKey === key && (cell.isAllowed || cell.studentCount > 0)) {
        ctx.strokeStyle = '#1976d2';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(cx + 0.75, cy + 0.75, cellW - 1.5, CELL_HEIGHT - 1.5);
      } else {
        ctx.strokeStyle = '#e0e6ed';
        ctx.lineWidth = 0.5;
        ctx.strokeRect(cx, cy, cellW, CELL_HEIGHT);
      }
    }
  }

  // ===== Canvas 交互 =====

  function findCell(mx, my) {
    var keys = Object.keys(canvasCells);
    for (var i = 0; i < keys.length; i++) {
      var c = canvasCells[keys[i]];
      if (mx >= c.x && mx <= c.x + c.w && my >= c.y && my <= c.y + c.h) return c;
    }
    return null;
  }

  var _rafId = null;

  if (canvas) {
    canvas.addEventListener('mousemove', function (e) {
      var rect = canvas.getBoundingClientRect();
      var mx = e.clientX - rect.left;
      var my = e.clientY - rect.top;
      var cell = findCell(mx, my);
      var key = cell ? (cell.date + '|' + cell.timeBucket) : null;

      if (key !== hoveredKey) {
        hoveredKey = key;
        if (!_rafId) {
          _rafId = requestAnimationFrame(function () {
            _rafId = null;
            if (heatmapData) renderHeatmap(heatmapData, rawSchedules);
          });
        }
      }

      if (cell && cell.isAllowed) {
        tooltip.style.display = 'block';
        tooltip.style.left = (e.clientX + 14) + 'px';
        tooltip.style.top = (e.clientY - 10) + 'px';
        tooltip.innerHTML =
          '<b>' + cell.date + ' ' + WEEK_NAMES[cell.weekDay] + ' ' + cell.timeBucket + '</b><br>' +
          '排课人数：' + cell.studentCount + ' 人<br>' +
          '密度：' + Math.round(cell.density * 100) + '%';
      } else {
        tooltip.style.display = 'none';
      }
    });

    canvas.addEventListener('mouseleave', function () {
      tooltip.style.display = 'none';
      if (hoveredKey !== null) {
        hoveredKey = null;
        if (heatmapData) renderHeatmap(heatmapData, rawSchedules);
      }
    });

    canvas.addEventListener('click', function (e) {
      var rect = canvas.getBoundingClientRect();
      var mx = e.clientX - rect.left;
      var my = e.clientY - rect.top;
      var cell = findCell(mx, my);
      if (!cell || !cell.isAllowed) return;

      var key = cell.date + '|' + cell.timeBucket;
      selectedKey = (selectedKey === key) ? null : key;
      renderHeatmap(heatmapData, rawSchedules);

      var infoEl = document.getElementById('fs-selected-info');
      if (infoEl) {
        if (selectedKey) {
          infoEl.style.display = 'block';
          infoEl.innerHTML = '📌 已选中：<b>' + cell.date + ' ' + WEEK_NAMES[cell.weekDay] + ' ' + cell.timeBucket + '</b>' +
            ' — 共 <b>' + cell.studentCount + '</b> 人排课，密度 <b>' + Math.round(cell.density * 100) + '%</b>';
        } else {
          infoEl.style.display = 'none';
          infoEl.innerHTML = '';
        }
      }
    });
  }

  // ===== 异常列表 =====

  function renderAnomalies(anomaly) {
    var card = document.getElementById('fs-anomaly-card');
    if (!card) return;
    if (!anomaly || !anomaly.anomalies || anomaly.anomalies.length === 0) {
      card.style.display = 'none';
      return;
    }
    card.style.display = 'block';

    var html = '<div class="fs-anomaly-title">⚠️ 异常检测结果 · ' + anomaly.anomalies.length + ' 条' +
      (anomaly.errorCount ? ' &nbsp;<span style="background:#fce4ec;color:#c62828;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">🔴 ' + anomaly.errorCount + ' 严重</span>' : '') +
      (anomaly.warningCount ? ' <span style="background:#fff3e0;color:#e65100;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">🟡 ' + anomaly.warningCount + ' 警告</span>' : '') +
      '</div>';

    html += '<div class="fs-anomaly-list">';
    for (var i = 0; i < anomaly.anomalies.length; i++) {
      var a = anomaly.anomalies[i];
      var icon = a.severity === 'error' ? '🔴' : (a.severity === 'warning' ? '🟡' : '🔵');
      html += '<div class="fs-anomaly-item fs-severity-' + (a.severity || 'info') + '">' +
        icon + ' <b>' + (a.remarkName || a.studentName || '未知') + '</b> — ' + (a.description || '') +
        '</div>';
    }
    html += '</div>';

    card.innerHTML = html;
  }

  // ===== 初始化 =====

  function showError(msg) {
    var container = document.querySelector('.fs-container');
    if (container) {
      container.innerHTML =
        '<div class="fs-empty">' +
          '<div class="fs-empty-icon">⚠️</div>' +
          '<div>' + msg + '</div>' +
        '</div>';
    }
  }

  function init() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      showError('请在 Chrome 扩展环境中打开此页面<br><small>（直接从文件系统打开不支持）</small>');
      return;
    }

    chrome.storage.local.get(['hmFullscreenData'], function (result) {
      var stored = result.hmFullscreenData;
      if (!stored || !stored.heatmapData) {
        showError('暂无热力图数据<br><small>请先在侧边栏查询排课数据，再点击「查看完整热力图」</small>');
        return;
      }

      heatmapData = stored.heatmapData;
      anomalyResult = stored.anomalyResult || null;
      rawSchedules = stored.rawSchedules || [];
      var dateRange = stored.dateRange || {};

      var dateInfoEl = document.getElementById('fs-date-info');
      if (dateInfoEl && dateRange.start) {
        dateInfoEl.textContent = dateRange.start + ' ~ ' + (dateRange.end || '');
      }

      if (dateRange.start) {
        document.title = '课程排期热力图 · ' + dateRange.start + ' ~ ' + (dateRange.end || '');
      }

      try {
        renderStats(heatmapData, anomalyResult);
        renderHeatmap(heatmapData, rawSchedules);
        renderAnomalies(anomalyResult);
      } catch (e) {
        showError('渲染热力图时出错：' + e.message + '<br><small>请检查控制台获取详细信息</small>');
        console.error('[FS] render error:', e);
      }
    });
  }

  window.addEventListener('DOMContentLoaded', init);

  window.addEventListener('resize', function () {
    if (heatmapData) {
      if (_rafId) cancelAnimationFrame(_rafId);
      _rafId = requestAnimationFrame(function () {
        _rafId = null;
        renderHeatmap(heatmapData, rawSchedules);
      });
    }
  });

})();
