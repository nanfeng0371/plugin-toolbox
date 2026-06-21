/*
 * 不专注率主动提醒 — 控制台验证脚本（每次扫描都弹通知）
 * 
 * 用法：在爱芯平台页面打开 F12 控制台，粘贴整段代码回车。
 * 
 * 测试参数：
 *   - 阈值：0%（所有上课学生都会触发）
 *   - 间隔：10秒（每次刷新都弹通知）
 *   - 时段：不限制
 *   - 🔔 不论有没有在线上课学生，每次都弹通知（有真实数据用真实，没有用模拟数据）
 *   
 * 停止命令：__notFocusTestStop()
 */

(function () {
  'use strict';

  /* ========== 第一步：请求通知权限 ========== */
  if (!('Notification' in window)) {
    console.error('❌ 浏览器不支持桌面通知');
    return;
  }

  function ensurePermission() {
    if (Notification.permission === 'granted') return Promise.resolve(true);
    if (Notification.permission === 'denied') {
      console.error('❌ 通知权限已被拒绝，请在浏览器设置中重新允许');
      return Promise.resolve(false);
    }
    return Notification.requestPermission().then(function (p) {
      if (p === 'granted') { console.log('✅ 通知权限已获取'); return true; }
      console.error('❌ 未获得通知权限: ' + p);
      return false;
    });
  }

  /* ========== 第二步：API 工具（内容脚本同款，同域 fetch） ========== */
  var BASE = location.origin;
  var SCHEDULE_API = '/prod-api/student-center-ai/regularCourse/next/class/list';
  var MODULE_DATA_API = '/prod-api/student-center-ai/ai/user/course/period/module/data';

  function apiGet(path, params) {
    var url = new URL(path, BASE);
    Object.keys(params || {}).forEach(function (k) {
      if (params[k] != null && params[k] !== '') url.searchParams.set(k, params[k]);
    });
    return fetch(url.toString(), { credentials: 'include', headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.text(); })
      .then(function (t) { return JSON.parse(t); });
  }

  function apiPost(path, body) {
    return fetch(new URL(path, BASE).toString(), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) { return r.text(); })
      .then(function (t) { return JSON.parse(t); });
  }

  /* ========== 第三步：获取排课并计算不专注率 ========== */
  async function fetchScheduleAndNotFocus() {
    // 3.1 获取排课（POST）
    var scheduleParams = {
      pageNum: 1,
      pageSize: 500,
      params: {
        ifJoinClass: 1,
        onlineStatusList: [0, 1, 2]
      }
    };
    var sch = await apiPost(SCHEDULE_API, scheduleParams);
    var rawRows = (sch && sch.data && sch.data.records) ? sch.data.records : [];
    if (rawRows.length === 0) {
      console.log('[测试] 无排课数据');
      return [];
    }

    // 3.2 筛选正在上课的学生（classStatus=1, onlineStatus=1）
    var inClassRows = rawRows.filter(function (r) {
      return Number(r.classStatus) === 1 && Number(r.onlineStatus) === 1;
    });

    if (inClassRows.length === 0) {
      console.log('[测试] 当前无在线上课学生');
      return [];
    }

    // 按 studentId 去重
    var sidMap = {};
    inClassRows.forEach(function (r) {
      var sid = String(r.studentId || '');
      if (sid && r && !sidMap[sid]) sidMap[sid] = r;
    });
    var uniqueRows = Object.values(sidMap);

    console.log('[测试] 在线上课学生: ' + uniqueRows.length + ' 人，开始获取互动明细...');

    // 3.3 批量获取互动明细（每批5个）
    var batchSize = 5;
    for (var bi = 0; bi < uniqueRows.length; bi += batchSize) {
      var batch = uniqueRows.slice(bi, bi + batchSize);
      await Promise.all(batch.map(function (r) {
        if (!r) return Promise.resolve();
        var sid = String(r.studentId || '');
        var cid = String(r.courseId || '');
        var acid = String(r.aiCourseId || '');
        var aid = String(r.aiPeriodId || '');
        var mid = String(r.aiClassHourId || '');

        if (!sid || !mid) {
          r.__notFocusRate = null;
          return Promise.resolve();
        }

        return apiGet(MODULE_DATA_API, {
          userId: sid,
          courseId: cid,
          aiCourseId: acid,
          aiPeriodId: aid,
          moduleId: mid,
        }).then(function (json) {
          if (!json || !json.data || !json.data.clipList || json.data.clipList.length === 0) {
            r.__notFocusRate = null;
            return;
          }
          var clips = json.data.clipList;
          var total = clips.length;
          var notFocused = clips.filter(function (c) { return c.interactChatNum >= 5; }).length;
          r.__notFocusRate = Math.round(notFocused / total * 100);
          r.__notFocusDetail = notFocused + '/' + total;
        }).catch(function (e) {
          console.warn('[测试] 明细获取失败: ' + sid + ' ' + e.message);
          r.__notFocusRate = null;
        });
      }));
    }

    console.log('[测试] 互动明细获取完成');
    return uniqueRows;
  }

  /* ========== 第四步：告警判定 + 去重 + 通知 ========== */
  var alerted = {};  // 去重：studentId_periodId → true

  function buildNotification(alerts) {
    if (alerts.length === 0) return;

    var now = new Date();
    var timeStr = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');

    var lines = alerts.map(function (a) {
      return a.name + '  不专注 ' + a.rate + '%';
    });

    var body = lines.join('\n') + '\n\n共 ' + alerts.length + ' 名学生走神率超标';

    var notif = new Notification('⚠️ 课堂走神提醒（' + timeStr + '）', {
      body: body,
      icon: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="6" fill="#f44336"/><text x="16" y="22" text-anchor="middle" font-size="18" fill="white">⚠</text></svg>'),
      tag: 'notfocus-alert',  // 同tag合并
      requireInteraction: false,
    });

    notif.onclick = function () {
      console.log('[测试] 通知被点击（不做跳转）');
    };
  }

  var THRESHOLD = 0;  // 测试阈值：0%（方便验证所有学生都触发）

  async function scan() {
    console.log('─────────────── 扫描开始 ───────────────');
    try {
      var rows = await fetchScheduleAndNotFocus();

      var alerts = [];
      rows.forEach(function (r) {
        var rate = r.__notFocusRate;
        if (rate == null || rate < THRESHOLD) return;

        var key = r.studentId + '_' + (r.aiPeriodId || r.classId || '');
        if (alerted[key]) {
          console.log('  ⏭ 跳过（已提醒）: ' + (r.studentName || r.studentId) + ' 不专注' + rate + '%');
          return;
        }

        alerted[key] = true;
        var name = r.remarkName || r.studentName || ('学员' + r.studentId);
        var grade = r.gradeName || '';
        alerts.push({ name: name + (grade ? '（' + grade + '）' : ''), rate: rate });
        console.log('  🚨 触发告警: ' + name + ' 不专注' + rate + '%');
      });

      // 🔔 核心改动：没有真实告警时，用模拟数据弹通知（方便验证通知样式）
      if (alerts.length === 0) {
        alerts = [
          { name: '张三（初一数学）', rate: 52 },
          { name: '李四（初二英语）', rate: 45 },
          { name: '王五（初三物理）', rate: 40 },
        ];
        console.log('  📢 当前无在线上课学生，使用模拟数据展示通知样式');
      } else {
        console.log('✅ 使用真实数据');
      }

      buildNotification(alerts);
      console.log('✅ 已发送桌面通知，共 ' + alerts.length + ' 名学生');
    } catch (e) {
      console.error('[测试] 扫描异常:', e.message);
      // 异常时也用模拟数据弹通知
      buildNotification([
        { name: '张三（初一数学）', rate: 52 },
        { name: '李四（初二英语）', rate: 45 },
      ]);
    }
    console.log('─────────────── 扫描结束 ───────────────');
  }

  /* ========== 启动 ========== */
  ensurePermission().then(function (ok) {
    if (!ok) return;

    console.log('🚀 不专注率监控测试启动');
    console.log('  阈值: ' + THRESHOLD + '%（测试模式）');
    console.log('  间隔: 10秒');
    console.log('  停止命令: __notFocusTestStop()');
    console.log('');

    // 立即跑一次
    scan();

    // 每10秒跑一次
    var timer = setInterval(scan, 10000);
    window.__notFocusTestStop = function () {
      clearInterval(timer);
      console.log('⏹ 监控测试已停止');
      console.log('  已提醒 ' + Object.keys(alerted).length + ' 人次');
      console.log('  去重记录: ', alerted);
    };
  });
})();
