/**
 * 课程排期分析看板 v1.0 — 模块 Background Service Worker
 *
 * 职责：
 * 1. API 数据获取（/next/class/list）
 * 2. 数据预处理（重约去重）
 * 3. 数据聚合（热力图 + 下钻明细）
 * 4. 异常检测（4条规则）
 * 5. 配置持久化（chrome.storage.local）
 * 6. 消息处理器注册（MessageBus）
 */

// ===== 常量 =====

const CONFIG = {
  WORK_DOMAIN: 'https://ai-genesis.yuaiweiwu.com',
  LIST_API: '/prod-api/student-center-ai/regularCourse/next/class/list',
};

const TIME_BUCKET_SIZE = 30; // 分钟

/** 默认模块配置 */
const DEFAULT_CONFIG = {
  allowedWeekDays: [1, 4, 5, 6, 0],  // 周一、四、五、六、日（0=周日）
  dailyLimit: 1,
  colorScheme: 'cool',
  exportSettings: {
    resolution: '2x',
    format: 'png',
    includeLegend: true,
    includeHeader: true,
    backgroundColor: '#ffffff'
  }
};

/** 暑假阶段日期范围（仅用于异常检测 DATE_OUT_OF_RANGE） */
const SUMMER_PHASE = {
  start: '2026-07-10',
  end: '2026-09-04'
};

/** 星期名称映射 */
const WEEK_DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// ===== 模块级缓存 =====

/** 缓存最近一次请求的原始排课数据 */
let cachedSchedules = [];
/** 缓存最近一次的日期范围 */
let cachedDateRange = null;
/** 当前模块配置 */
let moduleConfig = null;

// ===== 工具函数 =====

/**
 * 格式化分钟数为 HH:mm
 */
function formatMin(minutes) {
  const h = Math.floor(minutes / 60).toString().padStart(2, '0');
  const m = (minutes % 60).toString().padStart(2, '0');
  return h + ':' + m;
}

/**
 * 从时间字符串中提取 HH:mm
 * 兼容格式：
 *   - "14:00" / "14:00:00"
 *   - "2026-06-07 14:00:00"
 *   - Unix 毫秒时间戳字符串 "1738819686000"
 */
function extractHhmm(timeStr) {
  if (!timeStr) return null;
  // 纯数字时间戳（毫秒）
  if (/^\d{13}$/.test(timeStr)) {
    var d = new Date(parseInt(timeStr, 10));
    if (!isNaN(d.getTime())) {
      var h = String(d.getHours()).padStart(2, '0');
      var m = String(d.getMinutes()).padStart(2, '0');
      return h + ':' + m;
    }
  }
  var m = timeStr.match(/(\d{2}):(\d{2})(?::\d{2})?$/);
  if (m) return m[1] + ':' + m[2];
  return null;
}

/**
 * 解析日期字符串为 Date
 */
function parseDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * 获取日期的星期几（0=周日, 1=周一, ..., 6=周六）
 */
function getWeekDay(dateStr) {
  const d = parseDate(dateStr);
  return d ? d.getDay() : -1;
}

/**
 * 判断课程是否为暑假课
 */
function isSummerCourse(courseName) {
  if (!courseName) return false;
  return courseName.indexOf('暑假') !== -1;
}

/**
 * 从课节名称提取讲次数字（如 "第3讲" → 3）
 */
function extractLectureNum(courseName) {
  if (!courseName) return 0;
  const match = courseName.match(/第(\d+)讲/);
  return match ? parseInt(match[1], 10) : 0;
}

// ===== API 调用 =====

/**
 * 封装 API 请求
 */
function workApi(path, params) {
  params = params || {};
  var url = new URL(path, CONFIG.WORK_DOMAIN);
  Object.keys(params).forEach(function (k) {
    url.searchParams.set(k, params[k]);
  });
  return fetch(url.toString(), { credentials: 'include' })
    .then(function (r) { return r.json(); })
    .then(function (r) {
      // API code 可能是 "000000"(成功字符串) 或 200(成功数字)，msg/mesg 字段名各异
      var isSuccess = (r.code === '000000' || r.code === 200 || r.code === '200');
      if (!isSuccess) throw new Error(r.mesg || r.msg || r.message || 'API Error (code=' + r.code + ')');
      return r.data;
    });
}

// ===== 数据预处理 =====

/**
 * 重约去重：同一学生、同一课程、同一天出现 ≥2 条记录 → 按 createTime 保留最新
 */
function dedupSchedules(schedules) {
  if (!schedules || schedules.length === 0) return [];

  // 分组 key: studentId|courseId|classDate
  var groups = {};
  for (var i = 0; i < schedules.length; i++) {
    var s = schedules[i];
    var key = (s.studentId || '') + '|' + (s.courseId || s.courseName || '') + '|' + (s.classDate || '');
    if (!groups[key]) groups[key] = [];
    groups[key].push(s);
  }

  var result = [];
  var keys = Object.keys(groups);
  for (var j = 0; j < keys.length; j++) {
    var group = groups[keys[j]];
    if (group.length === 1) {
      result.push(group[0]);
    } else {
      // 多条记录：按 createTime 保留最新
      group.sort(function (a, b) {
        var ta = a.createTime ? new Date(a.createTime).getTime() : 0;
        var tb = b.createTime ? new Date(b.createTime).getTime() : 0;
        return tb - ta;
      });
      result.push(group[0]);
    }
  }
  return result;
}

// ===== DataAggregator =====

const DataAggregator = {

  /**
   * 从实际排课数据中动态收集时间桶
   * 规则：课程开始时间 → Math.floor 归并到最近 30 分钟桶
   */
  computeTimeBuckets: function (schedules) {
    var bucketSet = new Set();
    for (var i = 0; i < schedules.length; i++) {
      var s = schedules[i];
      var timePart = extractHhmm(s.startTime);
      if (!timePart) continue;
      var parts = timePart.split(':');
      var h = parseInt(parts[0], 10);
      var m = parseInt(parts[1], 10);
      var totalMin = h * 60 + m;
      var bucketMin = Math.floor(totalMin / TIME_BUCKET_SIZE) * TIME_BUCKET_SIZE;
      bucketSet.add(bucketMin);
    }
    var sorted = Array.from(bucketSet).sort(function (a, b) { return a - b; });
    return sorted.map(function (minutes) {
      return {
        label: formatMin(minutes) + '-' + formatMin(minutes + TIME_BUCKET_SIZE),
        startMinutes: minutes,
        endMinutes: minutes + TIME_BUCKET_SIZE
      };
    });
  },

  /**
   * 聚合热力图数据
   * GROUP BY (星期, 时间桶) → COUNT(去重学生)
   */
  aggregate: function (schedules, timeBuckets, weekDays) {
    // 初始化格子 Map: key = weekDay|timeBucketLabel
    var cellMap = {};
    var allowedWeekDaysArr = weekDays || [1, 4, 5, 6, 0];

    for (var i = 0; i < timeBuckets.length; i++) {
      var tb = timeBuckets[i];
      for (var j = 0; j < 7; j++) {
        var wd = j; // 0-6
        var dayIdx = wd; // weekDay 直接对应 0-6
        var key = wd + '|' + tb.label;
        // 判断是否允许排课的星期
        var isAllowed = allowedWeekDaysArr.indexOf(dayIdx) !== -1;
        cellMap[key] = {
          weekDay: wd,
          timeBucket: tb.label,
          timeBucketStart: tb.startMinutes,
          timeBucketEnd: tb.endMinutes,
          studentSet: new Set(),
          scheduleCount: 0,
          isAllowed: isAllowed
        };
      }
    }

    // 遍历排课数据，归入对应格子
    for (var k = 0; k < schedules.length; k++) {
      var s = schedules[k];
      if (!s.classDate || !s.startTime) continue;

      var wd = getWeekDay(s.classDate);
      if (wd === -1) continue;

      // 计算时间桶
      var timePart = extractHhmm(s.startTime);
      if (!timePart) continue;
      var parts = timePart.split(':');
      var h = parseInt(parts[0], 10);
      var m = parseInt(parts[1], 10);
      var totalMin = h * 60 + m;
      var bucketMin = Math.floor(totalMin / TIME_BUCKET_SIZE) * TIME_BUCKET_SIZE;
      var bucketLabel = formatMin(bucketMin) + '-' + formatMin(bucketMin + TIME_BUCKET_SIZE);

      var key = wd + '|' + bucketLabel;
      if (cellMap[key]) {
        cellMap[key].studentSet.add(s.studentId || 'unknown');
        cellMap[key].scheduleCount++;
      }
    }

    // 转数组 + 计算密度
    var cells = [];
    var maxCount = 0;
    var keys = Object.keys(cellMap);
    for (var n = 0; n < keys.length; n++) {
      var cell = cellMap[keys[n]];
      var sc = cell.studentSet.size;
      cell.studentCount = sc;
      if (sc > maxCount) maxCount = sc;
      // 清理 Set（不可序列化）
      delete cell.studentSet;
      cells.push(cell);
    }

    // 归一化密度
    for (var p = 0; p < cells.length; p++) {
      cells[p].density = maxCount > 0 ? cells[p].studentCount / maxCount : 0;
    }

    return {
      cells: cells,
      timeBuckets: timeBuckets,
      weekDaysInData: [0, 1, 2, 3, 4, 5, 6],
      maxDensity: maxCount,
      dateRange: cachedDateRange || {},
      totalSchedules: schedules.length,
      totalStudents: countUniqueStudents(schedules)
    };
  },

  /**
   * 下钻明细：筛选指定格子的排课记录
   */
  drillDown: function (schedules, weekDay, timeBucket, dateRange) {
    var records = [];
    for (var i = 0; i < schedules.length; i++) {
      var s = schedules[i];
      if (!s.classDate || !s.startTime) continue;

      var wd = getWeekDay(s.classDate);
      if (wd !== weekDay) continue;

      // 计算时间桶
      var timePart = extractHhmm(s.startTime);
      if (!timePart) continue;
      var parts = timePart.split(':');
      var h = parseInt(parts[0], 10);
      var m = parseInt(parts[1], 10);
      var totalMin = h * 60 + m;
      var bucketMin = Math.floor(totalMin / TIME_BUCKET_SIZE) * TIME_BUCKET_SIZE;
      var bucketLabel = formatMin(bucketMin) + '-' + formatMin(bucketMin + TIME_BUCKET_SIZE);

      if (bucketLabel !== timeBucket) continue;

      records.push({
        studentName: s.remarkName || s.studentName || '',
        studentId: s.studentId || '',
        courseName: s.courseName || '',
        lectureNum: extractLectureNum(s.courseName),
        classDate: s.classDate,
        startTime: s.startTime,
        endTime: s.endTime || '',
        status: s.status || 0,
        teacherName: s.teacherName || ''
      });
    }
    return records;
  }
};

/**
 * 统计去重学生数
 */
function countUniqueStudents(schedules) {
  var set = new Set();
  for (var i = 0; i < schedules.length; i++) {
    set.add(schedules[i].studentId || '');
  }
  return set.size;
}

// ===== AnomalyDetector =====

const AnomalyDetector = {

  /**
   * 检测所有异常
   * @param {Array} schedules - 原始排课数据（已去重）
   * @param {Object} config - 模块配置
   * @returns {Object} { anomalies, errorCount, warningCount, infoCount }
   */
  detect: function (schedules, config) {
    var cfg = config || DEFAULT_CONFIG;
    var anomalies = [];

    // 规则1：不允许排课的星期
    anomalies = anomalies.concat(this.checkForbiddenWeekday(schedules, cfg.allowedWeekDays));

    // 规则2：超出每日排课上限
    anomalies = anomalies.concat(this.checkDailyLimit(schedules, cfg.dailyLimit));

    // 规则3：排课连续性
    anomalies = anomalies.concat(this.checkContinuityGap(schedules, cfg.allowedWeekDays));

    // 规则4：暑假课日期超出范围
    anomalies = anomalies.concat(this.checkDateRange(schedules));

    var errorCount = 0, warningCount = 0, infoCount = 0;
    for (var i = 0; i < anomalies.length; i++) {
      if (anomalies[i].severity === 'error') errorCount++;
      else if (anomalies[i].severity === 'warning') warningCount++;
      else infoCount++;
    }

    return {
      anomalies: anomalies,
      errorCount: errorCount,
      warningCount: warningCount,
      infoCount: infoCount
    };
  },

  /**
   * 规则1：排课日期的星期 ∉ allowedWeekDays → 报 error
   */
  checkForbiddenWeekday: function (schedules, allowedDays) {
    var result = [];
    var checked = {}; // studentId|date 去重
    for (var i = 0; i < schedules.length; i++) {
      var s = schedules[i];
      if (!s.classDate) continue;
      var wd = getWeekDay(s.classDate);
      if (wd === -1) continue;
      if (allowedDays.indexOf(wd) === -1) {
        var key = s.studentId + '|' + s.classDate;
        if (!checked[key]) {
          checked[key] = true;
          result.push({
            ruleType: 'FORBIDDEN_WEEKDAY',
            severity: 'error',
            studentId: s.studentId || '',
            studentName: s.remarkName || s.studentName || '',
            description: s.classDate + '(' + WEEK_DAY_NAMES[wd] + ')安排了课程，违反排课连续性规则',
            relatedDate: s.classDate
          });
        }
      }
    }
    return result;
  },

  /**
   * 规则2：同一学生同一天排课 > dailyLimit（已去重）
   */
  checkDailyLimit: function (schedules, dailyLimit) {
    var result = [];
    var limit = dailyLimit || 1;
    // 按 studentId|classDate 分组统计
    var dayMap = {};
    for (var i = 0; i < schedules.length; i++) {
      var s = schedules[i];
      if (!s.classDate) continue;
      var key = s.studentId + '|' + s.classDate;
      if (!dayMap[key]) dayMap[key] = [];
      dayMap[key].push(s);
    }
    var keys = Object.keys(dayMap);
    for (var j = 0; j < keys.length; j++) {
      var group = dayMap[keys[j]];
      if (group.length > limit) {
        result.push({
          ruleType: 'EXCEED_DAILY_LIMIT',
          severity: 'warning',
          studentId: group[0].studentId || '',
          studentName: group[0].remarkName || group[0].studentName || '',
          description: group[0].classDate + ' 安排了' + group.length + '节课',
          relatedDate: group[0].classDate,
          scheduleCount: group.length
        });
      }
    }
    return result;
  },

  /**
   * 规则3：按周检查排课连续性
   * 对每个学生的每个允许排课日，检查本周有课但下周同一天无课
   */
  checkContinuityGap: function (schedules, allowedDays) {
    var result = [];
    // 按 studentId 分组
    var studentMap = {};
    for (var i = 0; i < schedules.length; i++) {
      var s = schedules[i];
      var sid = s.studentId;
      if (!sid) continue;
      if (!studentMap[sid]) studentMap[sid] = [];
      studentMap[sid].push(s);
    }

    var studentIds = Object.keys(studentMap);
    for (var si = 0; si < studentIds.length; si++) {
      var sid = studentIds[si];
      var studentSchedules = studentMap[sid];

      // 按 (year, weekNumber, weekDay) 建立索引
      // weekDayMap: key = weekDay, value = Set of weekNumbers
      var weekDayMap = {};
      for (var j = 0; j < studentSchedules.length; j++) {
        var s = studentSchedules[j];
        if (!s.classDate) continue;
        var d = parseDate(s.classDate);
        if (!d) continue;
        var wd = d.getDay();
        // 只检查允许排课日
        if (allowedDays.indexOf(wd) === -1) continue;

        var weekNum = getISOWeekNumber(d);
        if (!weekDayMap[wd]) weekDayMap[wd] = new Set();
        weekDayMap[wd].add(weekNum);
      }

      // 对每个允许排课的星期，检查连续性
      var wdKeys = Object.keys(weekDayMap);
      for (var wk = 0; wk < wdKeys.length; wk++) {
        var wd = parseInt(wdKeys[wk], 10);
        var weekSet = weekDayMap[wd];
        var weeks = Array.from(weekSet).sort(function (a, b) { return a - b; });

        // 检查相邻周次是否连续
        for (var w = 0; w < weeks.length - 1; w++) {
          var currentWeek = weeks[w];
          var nextWeek = weeks[w + 1];
          // 如果间隔不等于1（即不是连续的周），且 nextWeek 不是所有学生都没有排课的全局空周
          if (nextWeek - currentWeek !== 1) {
            // 中间有断档
            var gapWeek = currentWeek + 1;
            result.push({
              ruleType: 'CONTINUITY_GAP',
              severity: 'warning',
              studentId: sid,
              studentName: studentSchedules[0].remarkName || studentSchedules[0].studentName || sid,
              description: WEEK_DAY_NAMES[wd] + '排课在第' + currentWeek + '周和第' + nextWeek + '周之间存在间隔（缺少第' + gapWeek + '周），排课不连续',
              relatedDate: null
            });
          }
        }
      }
    }
    return result;
  },

  /**
   * 规则4：暑假课日期不在 SUMMER_PHASE 范围内
   */
  checkDateRange: function (schedules) {
    var result = [];
    var summerStart = parseDate(SUMMER_PHASE.start);
    var summerEnd = parseDate(SUMMER_PHASE.end);
    if (!summerStart || !summerEnd) return result;

    for (var i = 0; i < schedules.length; i++) {
      var s = schedules[i];
      if (!isSummerCourse(s.courseName)) continue;
      if (!s.classDate) continue;

      var d = parseDate(s.classDate);
      if (!d) continue;

      if (d < summerStart || d > summerEnd) {
        result.push({
          ruleType: 'DATE_OUT_OF_RANGE',
          severity: 'error',
          studentId: s.studentId || '',
          studentName: s.remarkName || s.studentName || '',
          description: '课程"' + (s.courseName || '') + '"安排在 ' + s.classDate + '，不在暑假阶段内（' + SUMMER_PHASE.start + ' ~ ' + SUMMER_PHASE.end + '）',
          relatedDate: s.classDate
        });
      }
    }
    return result;
  }
};

/**
 * 计算 ISO 周次
 */
function getISOWeekNumber(d) {
  var date = new Date(d.getTime());
  date.setHours(0, 0, 0, 0);
  // 设为该周周四
  date.setDate(date.getDate() + 3 - ((date.getDay() + 6) % 7));
  // 1月1日
  var jan1 = new Date(date.getFullYear(), 0, 1);
  // 计算周数
  var weekNum = Math.round(((date - jan1) / 86400000 - 3 + ((jan1.getDay() + 6) % 7)) / 7) + 1;
  return weekNum;
}

// ===== 注册模块消息处理器 =====

self.__registerModuleHandlers('heatmap', {

  /**
   * Tab 注册（模块激活时 content.js 调用）
   */
  REGISTER_TAB: function (data, sender) {
    console.log('[Heatmap-BG] Tab 注册');
    moduleConfig = null; // 重置配置缓存
    return { ok: true };
  },

  /**
   * 加载模块配置
   */
  LOAD_CONFIG: async function (data, sender) {
    try {
      var stored = await chrome.storage.local.get('heatmap_config');
      var config = stored.heatmap_config || null;
      if (config) {
        moduleConfig = config;
      } else {
        moduleConfig = Object.assign({}, DEFAULT_CONFIG);
      }
      return moduleConfig;
    } catch (e) {
      console.error('[Heatmap-BG] 加载配置失败:', e);
      moduleConfig = Object.assign({}, DEFAULT_CONFIG);
      return moduleConfig;
    }
  },

  /**
   * 保存模块配置
   */
  SAVE_CONFIG: async function (data, sender) {
    try {
      var config = data || {};
      moduleConfig = config;
      await chrome.storage.local.set({ heatmap_config: config });
      return { ok: true };
    } catch (e) {
      console.error('[Heatmap-BG] 保存配置失败:', e);
      return { ok: false, error: e.message };
    }
  },

  /**
   * 获取热力图聚合数据 + 异常检测
   * 自动执行异常检测，与热力图数据一起返回
   */
  FETCH_HEATMAP_DATA: async function (data, sender) {
    try {
      var dateRange = data.dateRange || {};
      console.log('[Heatmap-BG] 开始获取热力图数据, dateRange:', dateRange);

      // 发送进度：fetching
      self._sendProgress('fetching', 10);

      // 1. 获取原始排课数据
      var rawData = await workApi(CONFIG.LIST_API, {
        startDate: dateRange.start || '',
        endDate: dateRange.end || ''
      });

      // 兼容不同返回格式（可能在 data.list / data.records / 直接是数组）
      var schedules = [];
      if (Array.isArray(rawData)) {
        schedules = rawData;
      } else if (rawData && Array.isArray(rawData.list)) {
        schedules = rawData.list;
      } else if (rawData && Array.isArray(rawData.records)) {
        schedules = rawData.records;
      } else if (rawData && Array.isArray(rawData.data)) {
        schedules = rawData.data;
      }

      console.log('[Heatmap-BG] 获取到 ' + schedules.length + ' 条原始排课记录');

      self._sendProgress('dedup', 30);

      // 2. 数据预处理：重约去重
      schedules = dedupSchedules(schedules);
      console.log('[Heatmap-BG] 去重后 ' + schedules.length + ' 条记录');

      // 3. 缓存原始数据
      cachedSchedules = schedules;
      cachedDateRange = dateRange;

      self._sendProgress('aggregating', 50);

      // 4. 确保配置已加载
      if (!moduleConfig) {
        try {
          var stored = await chrome.storage.local.get('heatmap_config');
          moduleConfig = stored.heatmap_config || DEFAULT_CONFIG;
        } catch (e) {
          moduleConfig = Object.assign({}, DEFAULT_CONFIG);
        }
      }

      // 5. 计算时间桶
      var timeBuckets = DataAggregator.computeTimeBuckets(schedules);

      // 6. 聚合热力图数据
      var heatmapData = DataAggregator.aggregate(schedules, timeBuckets, moduleConfig.allowedWeekDays);

      self._sendProgress('detecting', 80);

      // 7. 异常检测（自动执行）
      var anomalyResult = AnomalyDetector.detect(schedules, moduleConfig);

      self._sendProgress('done', 100);

      console.log('[Heatmap-BG] 热力图数据准备完成, 格子数=' + heatmapData.cells.length +
        ', 异常数=' + anomalyResult.anomalies.length);

      return {
        heatmapData: heatmapData,
        anomalyResult: anomalyResult,
        dateRange: dateRange
      };
    } catch (e) {
      console.error('[Heatmap-BG] 获取热力图数据失败:', e);
      return {
        heatmapData: null,
        anomalyResult: null,
        error: e.message || '获取数据失败'
      };
    }
  },

  /**
   * 处理原始排课数据（content.js 直接调 API 获取原始数据后发给 SW 处理）
   * 这是 MV3 兼容方案：content.js 有页面 cookie，SW 做数据处理
   */
  PROCESS_RAW_DATA: async function (data, sender) {
    try {
      var schedules = data.schedules || [];
      var dateRange = data.dateRange || {};

      console.log('[Heatmap-BG] 收到 ' + schedules.length + ' 条原始数据，开始处理...');

      if (schedules.length === 0) {
        return {
          heatmapData: DataAggregator.aggregate([], [], moduleConfig ? moduleConfig.allowedWeekDays : DEFAULT_CONFIG.allowedWeekDays),
          anomalyResult: AnomalyDetector.detect([], moduleConfig || DEFAULT_CONFIG),
          dateRange: dateRange,
          error: '没有获取到排课数据'
        };
      }

      self._sendProgress('dedup', 30);

      // 1. 去重
      schedules = dedupSchedules(schedules);
      console.log('[Heatmap-BG] 去重后 ' + schedules.length + ' 条记录');

      // 2. 缓存
      cachedSchedules = schedules;
      cachedDateRange = dateRange;

      // 3. 确保配置已加载
      if (!moduleConfig) {
        try {
          var stored = await chrome.storage.local.get('heatmap_config');
          moduleConfig = stored.heatmap_config || DEFAULT_CONFIG;
        } catch (e) {
          moduleConfig = Object.assign({}, DEFAULT_CONFIG);
        }
      }

      self._sendProgress('aggregating', 60);

      // 4. 计算时间桶 + 聚合
      var timeBuckets = DataAggregator.computeTimeBuckets(schedules);
      var heatmapData = DataAggregator.aggregate(schedules, timeBuckets, moduleConfig.allowedWeekDays);

      self._sendProgress('detecting', 85);

      // 5. 异常检测
      var anomalyResult = AnomalyDetector.detect(schedules, moduleConfig);

      self._sendProgress('done', 100);

      console.log('[Heatmap-BG] 处理完成, 格子数=' + heatmapData.cells.length +
        ', 异常数=' + anomalyResult.anomalies.length);

      return {
        heatmapData: heatmapData,
        anomalyResult: anomalyResult,
        dateRange: dateRange
      };
    } catch (e) {
      console.error('[Heatmap-BG] 数据处理失败:', e);
      return {
        heatmapData: null,
        anomalyResult: null,
        error: e.message || '数据处理失败'
      };
    }
  },

  /**
   * 获取下钻明细
   */
  FETCH_DRILL_DOWN: async function (data, sender) {
    try {
      var weekDay = data.weekDay;
      var timeBucket = data.timeBucket;
      var dateRange = data.dateRange || cachedDateRange || {};

      if (cachedSchedules.length === 0) {
        return { records: [], error: '暂无排课数据，请先加载热力图' };
      }

      var records = DataAggregator.drillDown(cachedSchedules, weekDay, timeBucket, dateRange);
      return { records: records, total: records.length };
    } catch (e) {
      console.error('[Heatmap-BG] 下钻查询失败:', e);
      return { records: [], error: e.message };
    }
  },

  /**
   * 获取指定学生的排课数据（供 content.js 日历导出使用）
   */
  FETCH_STUDENT_SCHEDULES: async function (data, sender) {
    try {
      var studentId = data.studentId;

      var schedules;
      if (cachedSchedules.length > 0) {
        // 从缓存筛选
        schedules = cachedSchedules.filter(function (s) {
          return s.studentId === studentId;
        });
      } else {
        // 缓存不存在，重新获取
        var rawData = await workApi(CONFIG.LIST_API);
        var allSchedules = [];
        if (Array.isArray(rawData)) allSchedules = rawData;
        else if (rawData && Array.isArray(rawData.list)) allSchedules = rawData.list;
        else if (rawData && Array.isArray(rawData.records)) allSchedules = rawData.records;
        else if (rawData && Array.isArray(rawData.data)) allSchedules = rawData.data;
        allSchedules = dedupSchedules(allSchedules);
        schedules = allSchedules.filter(function (s) {
          return s.studentId === studentId;
        });
      }

      return {
        studentId: studentId,
        studentName: schedules.length > 0 ? (schedules[0].remarkName || schedules[0].studentName || studentId) : studentId,
        schedules: schedules
      };
    } catch (e) {
      console.error('[Heatmap-BG] 获取学生排课失败:', e);
      return { studentId: data.studentId, schedules: [], error: e.message };
    }
  },

  /**
   * 获取学生列表（供导出面板使用）
   * 从缓存的排课数据中提取去重学生列表，按讲次数量倒序
   */
  FETCH_STUDENT_LIST: async function (data, sender) {
    try {
      if (cachedSchedules.length === 0) {
        return { students: [], total: 0 };
      }

      var studentMap = {};
      for (var i = 0; i < cachedSchedules.length; i++) {
        var s = cachedSchedules[i];
        var sid = s.studentId || '';
        if (!sid) continue;
        if (!studentMap[sid]) {
          studentMap[sid] = {
            studentId: sid,
            studentName: s.remarkName || s.studentName || sid,
            count: 0
          };
        }
        studentMap[sid].count++;
      }

      // 按讲次数量倒序排列
      var students = Object.keys(studentMap).map(function (k) { return studentMap[k]; });
      students.sort(function (a, b) { return b.count - a.count; });

      return { students: students, total: students.length };
    } catch (e) {
      console.error('[Heatmap-BG] 获取学生列表失败:', e);
      return { students: [], error: e.message };
    }
  },

  /**
   * 下载日历图片（content.js 渲染完 Canvas → 传 dataUrl 过来）
   */
  DOWNLOAD_CALENDAR: async function (data, sender) {
    try {
      var dataUrl = data.dataUrl;
      var filename = data.filename || 'calendar.png';

      await chrome.downloads.download({
        url: dataUrl,
        filename: '学生日历/' + filename,
        saveAs: false
      });

      console.log('[Heatmap-BG] 日历下载已触发:', filename);
      return { ok: true, filename: filename };
    } catch (e) {
      console.error('[Heatmap-BG] 日历下载失败:', e);
      return { ok: false, error: e.message };
    }
  },

  /**
   * 打开全屏热力图页面（content.js 无 tabs 权限，需通过 background.js 创建 Tab）
   */
  OPEN_FULLSCREEN: async function (data, sender) {
    try {
      var url = chrome.runtime.getURL('modules/heatmap/heatmap-fullscreen.html');
      await chrome.tabs.create({ url: url });
      console.log('[Heatmap-BG] 已打开全屏热力图页面:', url);
      return { ok: true };
    } catch (e) {
      console.error('[Heatmap-BG] 打开全屏页面失败:', e);
      return { ok: false, error: e.message };
    }
  }
});

// ===== 进度通知工具（发送给 content.js） =====

self._sendProgress = function (phase, progress) {
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          target: 'heatmap',
          action: 'LOADING_PROGRESS',
          data: { phase: phase, progress: progress }
        }).catch(function () { /* content script 可能未注入 */ });
      }
    });
  } catch (e) { /* ignore */ }
};

console.log('[Heatmap-BG] 课程排期分析看板 background 模块已加载');
