/**
 * 调课助手 - 模块 Background Service Worker
 * 职责：1. 加载 xlsx 库用于学员信息簿解析 2. 代理 cookies.get API 3. 注册消息处理器
 */

// ===== 加载 xlsx 库（Service Worker 顶层同步加载） =====
try {
  importScripts(chrome.runtime.getURL('modules/tiaoke/lib/xlsx.full.min.js'));
  console.log('[调课助手-BG] xlsx 库加载成功');
} catch (e) {
  console.error('[调课助手-BG] xlsx 库加载失败:', e.message);
}

// ===== 注册模块处理器 =====

self.__registerModuleHandlers('tiaoke', {
  /**
   * 获取调课后台的 authorization-token Cookie
   */
  GET_COOKIE: async function (data, sender) {
    try {
      var cookie = await chrome.cookies.get({
        url: 'https://ai-genesis.yuaiweiwu.com',
        name: 'authorization-token',
      });
      if (cookie && cookie.value) {
        return { token: cookie.value, found: true };
      }
    } catch (e) {
      console.error('[调课助手-BG] 读取 Cookie 失败:', e);
    }
    return { token: '', found: false };
  },

  /**
   * 解析学员信息簿 Excel 文件
   * @param {object} data - { arrayBuffer: ArrayBuffer }
   * @returns {object} { roster: [{name, phone, studentId}], skipped: number, error?: string }
   */
  PARSE_ROSTER: function (data, sender) {
    try {
      if (typeof XLSX === 'undefined') {
        return { roster: [], skipped: 0, error: 'xlsx 库未加载' };
      }

      var uint8 = new Uint8Array(data.uint8Array);
      var workbook = XLSX.read(uint8, { type: 'array' });
      var firstSheetName = workbook.SheetNames[0];
      var worksheet = workbook.Sheets[firstSheetName];
      var rows = XLSX.utils.sheet_to_json(worksheet, { defval: '' });

      if (rows.length === 0) {
        return { roster: [], skipped: 0, error: 'Excel文件为空或格式不正确' };
      }

      // 智能匹配表头字段
      var sample = rows[0];
      var keys = Object.keys(sample);

      var nameKey = keys.find(function (k) {
        return /^(name|姓名|学生姓名|学员姓名)$/i.test(k.trim());
      }) || keys[0];

      var phoneKey = keys.find(function (k) {
        return /^(phone|手机|手机号|联系电话|电话)$/i.test(k.trim());
      }) || keys[1];

      var idKey = keys.find(function (k) {
        return /^(studentId|学员ID|学员id|student_id|id)$/i.test(k.trim());
      }) || keys[2];

      var roster = [];
      var skipped = 0;

      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var name = String(row[nameKey] || '').trim();
        var phone = String(row[phoneKey] || '').trim();
        var studentId = String(row[idKey] || '').trim();

        if (!studentId || !/^\d+$/.test(studentId)) {
          skipped++;
          continue;
        }

        roster.push({ name: name, phone: phone, studentId: studentId });
      }

      console.log('[调课助手-BG] 学员信息簿解析完成:', roster.length, '名, 跳过', skipped, '行');
      return { roster: roster, skipped: skipped, error: null };
    } catch (e) {
      console.error('[调课助手-BG] Excel 解析失败:', e);
      return { roster: [], skipped: 0, error: 'Excel解析失败: ' + e.message };
    }
  },
});
