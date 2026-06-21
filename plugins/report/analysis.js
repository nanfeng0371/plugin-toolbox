/**
 * 学习报告分析引擎 — 四层判定逻辑
 * 依赖: 无，纯函数式
 */

const Analysis = (() => {

  // ===== 第一层：参与度判定 =====
  function judgeParticipation(askCount, answerCount) {
    const rate = askCount > 0 ? (answerCount / askCount * 100) : 0;
    let tag, label;
    if (rate >= 80) { tag = 'success'; label = '✅ 积极互动'; }
    else if (rate >= 60) { tag = 'normal'; label = '👍 正常参与'; }
    else if (rate >= 40) { tag = 'warn'; label = '⚠️ 不太积极'; }
    else if (rate >= 20) { tag = 'danger'; label = '🔴 敷衍上课'; }
    else { tag = 'critical'; label = '🚨 严重敷衍'; }
    return { rate: Math.round(rate * 10) / 10, tag, label };
  }

  // ===== 第二层：学习效果判定 =====
  function judgeMastery(firstCorrect, guideCorrect, guideNum, masteryRating, answerCount) {
    const firstRate = answerCount > 0 ? (firstCorrect / answerCount * 100) : 0;
    const guideRate = guideNum > 0 ? (guideCorrect / guideNum * 100) : 0;

    let tag, label;
    // 回答太少时标记为不确定
    const uncertain = answerCount < 3 ? '?' : '';

    if (firstRate >= 60 && ['A+', 'A'].includes(masteryRating)) {
      tag = 'success'; label = `✅ 掌握扎实${uncertain}`;
    } else if ((firstRate >= 30 && firstRate < 60) || masteryRating === 'B+') {
      tag = 'good'; label = `👍 基本掌握${uncertain}`;
    } else if ((firstRate >= 10 && firstRate < 30) || ['B', 'C'].includes(masteryRating)) {
      tag = 'warn'; label = `⚠️ 有漏洞${uncertain}`;
    } else {
      tag = 'danger'; label = `🔴 未掌握${uncertain}`;
    }

    return {
      firstRate: Math.round(firstRate * 10) / 10,
      guideRate: Math.round(guideRate * 10) / 10,
      tag, label
    };
  }

  // ===== 第三层：练习情况判定 =====
  function judgeExercise(correctCount, totalWithRecord) {
    if (totalWithRecord === 0) return { rate: null, tag: 'normal', label: '-' };

    const rate = correctCount / totalWithRecord * 100;
    let tag, label;
    if (rate >= 80) { tag = 'success'; label = '✅ 全对'; }
    else if (rate >= 50) { tag = 'good'; label = '👍 大部分对'; }
    else if (rate >= 20) { tag = 'warn'; label = '⚠️ 错较多'; }
    else { tag = 'danger'; label = '🔴 大部分错'; }
    return { rate: Math.round(rate * 10) / 10, tag, label };
  }

  // ===== 第四层：四象限综合分类 =====
  function classifyQuadrant(participation, mastery, exercise) {
    const highPart = participation.rate >= 50;   // 高参与度阈值
    const highMaster = mastery.firstRate >= 30 || mastery.tag === 'success' || mastery.tag === 'good';
    const highExercise = exercise.rate === null || exercise.rate >= 50;

    let quadrant, tag, tagClass;

    if (highPart && highMaster && highExercise) {
      quadrant = 'Q1'; tag = '⭐ 优秀'; tagClass = 'tag-excellent';
    } else if (highPart && (!highMaster || !highExercise)) {
      quadrant = 'Q2'; tag = '⚠️ 需关注'; tagClass = 'tag-warn';
    } else if (!highPart && highMaster && highExercise) {
      quadrant = 'Q3'; tag = '🟠 异常'; tagClass = 'tag-warn';
    } else {
      quadrant = 'Q4';
      if (participation.rate < 20) {
        tag = '❌ 敷衍+未掌握'; tagClass = 'tag-critical';
      } else {
        tag = '🚨 敷衍预警'; tagClass = 'tag-danger';
      }
    }

    return { quadrant, tag, tagClass };
  }

  // ===== 诊断文字生成 =====
  function generateDiagnosis(raw, analysis) {
    const parts = [];
    const p = analysis.participation;

    // 参与度描述
    parts.push(`回答率${p.rate}%`);
    if (p.rate < 40) {
      parts.push(`${raw.totalAsk}问仅答${raw.totalAnswer}次`);
    }

    // 态度+能力判断
    if (analysis.quadrant.quadrant === 'Q4') {
      parts.push('态度和能力双重问题');
    } else if (analysis.quadrant.quadrant === 'Q2') {
      parts.push('态度好但需辅导');
    } else if (analysis.quadrant.quadrant === 'Q3') {
      parts.push('数据异常需核实');
    }

    // 练习补充
    if (analysis.exercise.rate !== null && analysis.exercise.rate < 40) {
      parts.push(`练习正确率仅${analysis.exercise.rate}%`);
    }

    // 错题本
    if (raw.wrongNum > 0) {
      parts.push(`${raw.wrongNum}道错题待复习`);
    }

    return parts.join('，') + '。';
  }

  // ===== 主分析入口 =====
  /**
   * @param {Object} raw - 从API解析的原始数据
   * @returns {Object} 完整分析结果 + 用于表格的行数据
   */
  function analyze(raw) {
    // 1. 汇总基础数据
    const totalAsk = raw.knowledgeList.reduce((s, k) => s + (k.teacherAsk || 0), 0);
    const totalAnswer = raw.knowledgeList.reduce((s, k) => s + (k.stuAnswer || 0), 0);
    const firstCorrectTotal = raw.knowledgeList.reduce((s, k) => s + (k.firstCorrect || 0), 0);
    const guideCorrectTotal = raw.knowledgeList.reduce((s, k) => s + (k.guideCorrect || 0), 0);
    const guideNumTotal = raw.knowledgeList.reduce((s, k) => s + (k.guideNum || 0), 0);

    const exerciseRecords = raw.exercises.filter(e => e.hasRecord);
    const exerciseCorrect = exerciseRecords.filter(e => e.correct).length;
    const exerciseWrong = exerciseRecords.length - exerciseCorrect;

    const completedK = raw.knowledgeList.filter(k => k.completed).length;

    // 2. 四层判定
    const participation = judgeParticipation(totalAsk, totalAnswer);
    const mastery = judgeMastery(firstCorrectTotal, guideCorrectTotal, guideNumTotal, raw.masteryRating, totalAnswer);
    const exercise = judgeExercise(exerciseCorrect, exerciseRecords.length);
    const quadrant = classifyQuadrant(participation, mastery, exercise);

    // 3. 诊断
    const diagnosis = generateDiagnosis({
      totalAsk, totalAnswer,
      wrongNum: raw.wrongNum || 0
    }, { participation, mastery, exercise, quadrant });

    // 4. 知识点明细行数据
    const knowledgeRows = raw.knowledgeList.map((k, idx) => ({
      name: k.name,
      rating: k.rating,
      totalQuestions: k.totalQuestions,
      teacherAsk: k.teacherAsk,
      stuAnswer: k.stuAnswer,
      firstCorrect: k.firstCorrect,
      guideCorrect: k.guideCorrect,
      guideNum: k.guideNum,
      exerciseCount: k.exerciseCount,
      exerciseCorrect: k.exerciseCorrect,
      completed: k.completed
    }));

    return {
      // 基础信息
      name: raw.name,
      courseName: raw.courseName,
      lessonName: raw.lessonName,

      // 综合评定
      quadrant: quadrant.quadrant,
      overallTag: quadrant.tag,
      overallTagClass: quadrant.tagClass,
      diagnosis,

      // 参与度
      ...participation,
      totalAsk,
      totalAnswer,
      focusRating: raw.focusRating || '-',
      focusAnswer: raw.focusAnswer || 0,
      overOther: raw.overOther || '0%',

      // 学习效果
      masteryRating: raw.masteryRating || '-',
      firstCorrectTotal,
      guideCorrectTotal,
      guideNumTotal,
      ...mastery,

      // 练习
      ...exercise,
      exerciseTotalRecorded: exerciseRecords.length,
      exerciseCorrectCount: exerciseCorrect,
      exerciseWrongCount: exerciseWrong,

      // 错题本 & 完成
      wrongNum: raw.wrongNum || 0,
      questionNum: raw.questionNum || 0,
      wrongRate: raw.questionNum > 0 ? Math.round(raw.wrongNum / raw.questionNum * 100 * 10) / 10 : 0,
      knowledgeCount: raw.knowledgeList.length,
      completedKnowledge: completedK,
      completionRate: raw.knowledgeList.length > 0 ? Math.round(completedK / raw.knowledgeList.length * 100 * 10) / 10 : 0,

      // 其他
      interactNum: raw.interactNum || 0,

      // 知识点明细
      knowledgeRows,

      // 行样式
      rowClass: getRowClass(quadrant.tagClass)
    };
  }

  function getRowClass(tagClass) {
    switch (tagClass) {
      case 'tag-critical': case 'tag-danger': return 'row-danger';
      case 'tag-warn': return 'row-warning';
      case 'tag-excellent': return 'row-success';
      default: return 'row-normal';
    }
  }

  // ===== 全班统计汇总（用于Sheet2）=====
  function summarizeByLesson(students) {
    const groups = {};
    for (const s of students) {
      const key = s.lessonName || '未知课节';
      if (!groups[key]) groups[key] = [];
      groups[key].push(s);
    }

    return Object.entries(groups).map(([lessonName, list]) => {
      const total = list.length;
      const avgRate = list.reduce((s, x) => s + x.rate, 0) / total;
      const dangerCount = list.filter(x => ['danger', 'critical'].includes(x.tag)).length;
      const criticalCount = list.filter(x => x.tag === 'critical').length;
      const successCount = list.filter(x => x.tag === 'success').length;

      // 掌握度分布
      const masteryDist = {};
      for (const s of list) {
        const r = s.masteryRating || '-';
        masteryDist[r] = (masteryDist[r] || 0) + 1;
      }

      // 平均练习率
      const withEx = list.filter(x => x.rate !== null);
      const avgExercise = withEx.length > 0 ? withEx.reduce((s, x) => s + x.rate, 0) / withEx.length : null;

      // 学生排名（按回答率升序）
      const ranking = [...list].sort((a, b) => a.rate - b.rate);

      return {
        lessonName,
        total,
        avgRate: Math.round(avgRate * 10) / 10,
        dangerCount,
        criticalCount,
        successCount,
        masteryDist,
        avgExercise: avgExercise !== null ? Math.round(avgExercise * 10) / 10 : null,
        ranking,
        problemStudents: list.filter(s => ['warn', 'danger', 'critical'].includes(s.participation?.tag))
      };
    });
  }

  return { analyze, judgeParticipation, judgeMastery, judgeExercise, classifyQuadrant, generateDiagnosis, summarizeByLesson };

})();
