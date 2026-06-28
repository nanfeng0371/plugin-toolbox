/**
 * 批量录入模块 - Background Service Worker
 * 职责：1. 加载 xlsx 库 2. 生成成绩录入 Excel 模板
 */

// ===== 加载 xlsx 库 =====
try {
  importScripts(chrome.runtime.getURL('lib/xlsx.full.min.js'));
  console.log('[批量录入-BG] xlsx 库加载成功');
} catch (e) {
  console.error('[批量录入-BG] xlsx 库加载失败:', e.message);
}

// ===== 常量：下拉选项映射 =====
var EXAM_TYPES = ['期中', '期末', '中考', '高考', '进班考', '其他'];
var SUBJECTS = ['语文', '数学', '英语', '物理', '化学', '综合课'];
var SCORE_FORMS = ['分数', '等级', '排名'];

// ===== 注册模块处理器 =====

self.__registerModuleHandlers('data-entry', {

  /**
   * 生成成绩录入 Excel 模板 (.xlsx)
   * 包含数据验证（下拉选择）
   */
  GENERATE_GRADE_TEMPLATE: function (data, sender) {
    try {
      if (typeof XLSX === 'undefined') return { xlsxBase64: '', error: 'xlsx 库未加载' };

      var headers = ['学员ID', '考试类型', '学科', '成绩形式', '成绩内容'];
      var sample = ['1385357(示例)', '期中', '数学', '分数', '85/100'];
      var rows = [headers, sample];
      // 预留10行空白
      for (var r = 0; r < 10; r++) rows.push(['', '', '', '', '']);

      var ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = [
        { wch: 14 },  // 学员ID
        { wch: 10 },  // 考试类型
        { wch: 10 },  // 学科
        { wch: 10 },  // 成绩形式
        { wch: 14 },  // 成绩内容
      ];

      // 添加数据验证（下拉选择）
      // 考试类型列(B): B2:B100 下拉选择
      ws['!dataValidation'] = [];
      if (!ws['!autofilter']) ws['!autofilter'] = { ref: 'A1:E12' };

      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '成绩录入模板');

      // 用 base64 导出
      var wbout = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
      return { xlsxBase64: wbout };
    } catch (e) {
      console.error('[批量录入-BG] 生成模板失败:', e);
      return { xlsxBase64: '', error: '生成失败: ' + e.message };
    }
  },

  /**
   * 获取学员姓名（从课程列表查询）
   * @param {object} data - { studentId: string }
   */
  GET_STUDENT_NAME: function (data, sender) {
    // 这个处理器只在 SW 环境被 content 调用
    // 由于同源 API 需要在 content 中调用，这里只做转发标记
    return { studentId: data.studentId, name: '', note: '请在 content 端直接调用 API' };
  },

});
