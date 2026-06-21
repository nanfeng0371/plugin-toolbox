/**
 * report_fetcher.js v4.0.0
 * 
 * 在 next.aitutor100.com/reportV2.html 中运行（含iframe，all_frames:true）
 * 
 * 原理：工作台页面创建iframe → src=短链 → 浏览器302+SSO自动认证 → 
 *       iframe获得登录态 → 本脚本在iframe内同源fetch → 数据发回SW
 * 
 * 三个API：
 *   1. queryCoursePeriodReport — 主报告数据
 *   2. queryComponentDialogueList — 对话/互动列表
 *   3. summary — 错题统计（需uid+periodId，从主报告数据中提取）
 */
(async function() {
  'use strict';

  const params = new URLSearchParams(location.search);
  const report = params.get('report');
  if (!report) return; // 非报告页面，忽略

  const courseType = params.get('courseType') || '3';
  const studyVersion = params.get('studyVersion') || '1';

  // 公共请求头
  const HEADERS = {
    'Accept': 'application/json, text/plain, */*',
    'source-sn': 'PROD',
  };

  try {
    // ===== 1. 主报告数据 =====
    const reportUrl = `/ai-math-engine/lesson/report/queryCoursePeriodReport?report=${encodeURIComponent(report)}&courseType=${courseType}&studyVersion=${studyVersion}`;
    const reportResp = await fetch(reportUrl, { headers: HEADERS });
    const reportJson = await reportResp.json();

    // 检查主报告是否成功
    if (reportJson.code && reportJson.code !== '000000' && reportJson.code !== 0) {
      throw new Error(`主报告API错误: code=${reportJson.code}, msg=${reportJson.msg || ''}`);
    }

    // ===== 2. 对话列表 =====
    let dialogueJson = null;
    try {
      const dialogueUrl = `/ai-math-engine/lesson/report/queryComponentDialogueList?report=${encodeURIComponent(report)}`;
      const dialogueResp = await fetch(dialogueUrl, { headers: HEADERS });
      dialogueJson = await dialogueResp.json();
    } catch(e) {
      console.warn('[report_fetcher] 对话列表获取失败:', e.message);
    }

    // ===== 3. 错题统计 =====
    let summaryJson = null;
    try {
      const data = reportJson.data || {};
      // 从主报告数据提取uid和periodId
      const uid = data.stuId || data.uid || data.studentId;
      const periodId = data.periodId || data.classPeriodId;
      
      if (uid && periodId) {
        const summaryUrl = `/ai-math-engine/mistake/period/module/summary?uid=${uid}&periodId=${periodId}&studyVersion=${studyVersion}`;
        const summaryResp = await fetch(summaryUrl, { headers: HEADERS });
        summaryJson = await summaryResp.json();
      }
    } catch(e) {
      console.warn('[report_fetcher] 错题统计获取失败:', e.message);
    }

    // ===== 合并summary数据到主报告 =====
    // 如果summary接口返回了mistakeSummaryVo且主报告没有，补充进去
    if (summaryJson && summaryJson.data) {
      const mainData = reportJson.data || {};
      if (!mainData.mistakeSummaryVo && summaryJson.data) {
        mainData.mistakeSummaryVo = summaryJson.data;
      } else if (mainData.mistakeSummaryVo && summaryJson.data) {
        // 如果两边都有，用summary接口的覆盖（更准确）
        mainData.mistakeSummaryVo = {
          ...mainData.mistakeSummaryVo,
          ...summaryJson.data,
        };
      }
    }

    // ===== 发送数据回SW =====
    chrome.runtime.sendMessage({
      type: 'REPORT_DATA_RESULT',
      reportToken: report,
      data: reportJson,
      _dialogue: dialogueJson,
      _summary: summaryJson,
    });

  } catch(e) {
    // 发送错误回SW
    chrome.runtime.sendMessage({
      type: 'REPORT_DATA_RESULT',
      reportToken: report,
      error: e.message,
    });
  }
})();
