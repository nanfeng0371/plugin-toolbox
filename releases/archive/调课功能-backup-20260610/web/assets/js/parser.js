/**
 * 调课指令解析器
 * 从 V3 Chrome 扩展移植，适配 Web 端
 */

/**
 * 标准化日期格式
 * 支持：YYYY-MM-DD、MM-DD、MM/DD、MM月DD日/号
 * 自动补全年份为当前年
 */
export function normalizeDate(raw) {
  const currentYear = new Date().getFullYear();
  const str = raw.trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;

  const mdDash = str.match(/^(\d{1,2})-(\d{1,2})$/);
  if (mdDash) {
    return `${currentYear}-${String(mdDash[1]).padStart(2, '0')}-${String(mdDash[2]).padStart(2, '0')}`;
  }

  const mdSlash = str.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (mdSlash) {
    return `${currentYear}-${String(mdSlash[1]).padStart(2, '0')}-${String(mdSlash[2]).padStart(2, '0')}`;
  }

  // MM月DD日 / MM月DD号
  const mdCN = str.match(/^(\d{1,2})月(\d{1,2})[日号]?$/);
  if (mdCN) {
    return `${currentYear}-${String(mdCN[1]).padStart(2, '0')}-${String(mdCN[2]).padStart(2, '0')}`;
  }

  return null;
}

/**
 * 标准化时间格式
 * 支持：HH:mm、HH:mm:ss、H:mm
 */
export function normalizeTime(raw) {
  const str = raw.trim();

  if (/^\d{2}:\d{2}$/.test(str)) return str;

  const hms = str.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (hms) {
    return `${String(hms[1]).padStart(2, '0')}:${String(hms[2]).padStart(2, '0')}`;
  }

  const hm = str.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    return `${String(hm[1]).padStart(2, '0')}:${hm[2]}`;
  }

  return null;
}

/**
 * 从自然语言文本中提取时间
 * 支持：早上10点, 下午2点半, 晚上7点, 10:30, 10点半
 */
export function parseNaturalTime(text) {
  // 标准时间格式
  const stdTime = text.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (stdTime) {
    const h = String(stdTime[1]).padStart(2, '0');
    const m = String(stdTime[2]).padStart(2, '0');
    return `${h}:${m}`;
  }

  // X点半
  const pointMatch = text.match(/(\d{1,2})点半/);
  if (pointMatch) {
    const h = parseInt(pointMatch[1], 10);
    return `${String(h).padStart(2, '0')}:30`;
  }

  // X点
  const hourMatch = text.match(/(\d{1,2})点/);
  if (hourMatch) {
    let h = parseInt(hourMatch[1], 10);
    if (/下午|晚上|午后|晚间/.test(text)) {
      if (h < 12) h += 12;
    } else if (/凌晨|半夜/.test(text)) {
      if (h === 12) h = 0;
      else if (h > 12) h -= 12;
    }
    return `${String(h).padStart(2, '0')}:00`;
  }

  return null;
}

/**
 * 从自然语言文本中提取日期
 */
export function extractDateFromText(text) {
  const afterKeyword = text.match(/(?:调到|改到|约到|移到|调至|改至)\s*(.+)/);
  const segment = afterKeyword ? afterKeyword[1] : text;

  // X月X日/号
  const mdCN = segment.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
  if (mdCN) return `${mdCN[1]}月${mdCN[2]}号`;

  // X月X（省略"日/号"）
  const mdCNShort = segment.match(/(\d{1,2})\s*月\s*(\d{1,2})(?![日号])/);
  if (mdCNShort) return `${mdCNShort[1]}月${mdCNShort[2]}号`;

  // YYYY-MM-DD
  const ymd = segment.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (ymd) return ymd[0];

  // MM-DD
  const mdDash = segment.match(/(\d{1,2})-(\d{1,2})/);
  if (mdDash) return mdDash[0];

  // MM/DD
  const mdSlash = segment.match(/(\d{1,2})\/(\d{1,2})/);
  if (mdSlash) return mdSlash[0];

  return null;
}

/**
 * 解析自然语言调课指令
 * @param {string} text
 * @returns {object|null} { rawName, rawPhone, periodSort, newDate, newTime }
 */
export function parseNaturalLanguage(text) {
  const lessonMatch = text.match(/第\s*(\d+)\s*讲/);
  if (!lessonMatch) return null;
  const periodSort = parseInt(lessonMatch[1], 10);
  if (periodSort < 1) return null;

  const phoneMatch = text.match(/1[3-9]\d{9}/);
  const rawPhone = phoneMatch ? phoneMatch[0] : '';

  // 提取姓名
  const cleaned = text
    .replace(/第\s*\d+\s*讲/, '')
    .replace(/调到|改到|约到|移到|调至|改至|上课|下课/g, '')
    .replace(/\d{1,2}\s*月\s*\d{1,2}\s*[日号]?/g, '')
    .replace(/\d{1,2}[点时]/g, '')
    .replace(/\d{1,2}点半/g, '')
    .replace(/\d{1,2}:\d{2}/g, '')
    .replace(/早上|上午|下午|晚上|凌晨|上午|中午|午后|晚间/g, '')
    .replace(/[,，、\s]/g, '');

  const nameMatch = cleaned.match(/[\u4e00-\u9fa5]{2,4}/);
  const rawName = nameMatch ? nameMatch[0] : '';

  if (!rawName && !rawPhone) return null;

  const dateStr = extractDateFromText(text);
  if (!dateStr) return null;
  const newDate = normalizeDate(dateStr);
  if (!newDate) return null;

  const newTime = parseNaturalTime(text);
  if (!newTime) return null;

  return { rawName, rawPhone, periodSort, newDate, newTime };
}

/**
 * 解析用户输入（结构化 + 自然语言混合）
 * @param {string} text - 用户输入的文本
 * @param {Array} studentRoster - 学员信息簿 [{ name, phone, studentId }]
 * @param {Function} logFn - 日志回调 (message, type)
 * @returns {{ tasks: Array, total: number, success: number, failed: number }}
 */
export function parseInputData(text, studentRoster = [], logFn = null) {
  const lines = text.trim().split('\n');
  const tasks = [];

  const log = (msg, type) => { if (logFn) logFn(msg, type); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // 跳过表头行
    if (line.includes('学员') || line.includes('第几讲') || line.includes('日期') || line.includes('时间')) {
      continue;
    }

    let task = null;

    // ========== 结构化解析 ==========
    let parts = line.split('\t').map(s => s.trim()).filter(s => s);

    if (parts.length < 4) {
      const spaceParts = line.split(/[\s\u3000]+/).map(s => s.trim()).filter(s => s);
      if (spaceParts.length >= 4) parts = spaceParts;
    }

    if (parts.length < 4) {
      const commaParts = line.split(/[,，]/).map(s => s.trim()).filter(s => s);
      if (commaParts.length >= 4) parts = commaParts;
    }

    if (parts.length >= 4) {
      const col1 = parts[0].trim();
      const periodSort = parseInt(parts[1].trim(), 10);
      const rawDate = parts[2].trim();
      const rawTime = parts[3].trim();

      const newDate = normalizeDate(rawDate);
      const newTime = rawTime.includes('点') ? parseNaturalTime(rawTime) : normalizeTime(rawTime);

      if (!isNaN(periodSort) && periodSort >= 1 && newDate && newTime) {
        if (/^\d+$/.test(col1)) {
          task = { studentId: col1, periodSort, newDate, newTime, status: 'ok' };
        } else if (studentRoster.length > 0) {
          const matched = matchStudent(col1, '', studentRoster);
          if (matched && matched.studentId) {
            task = { studentId: matched.studentId, studentName: matched.matchedName, periodSort, newDate, newTime, status: 'ok' };
          } else {
            tasks.push({ status: 'error', error: matched?.error || `未找到学员"${col1}"`, line: i + 1 });
            continue;
          }
        } else {
          tasks.push({ status: 'error', error: `"${col1}"不是学员ID，且未加载学情表`, line: i + 1 });
          continue;
        }
      }
    }

    // ========== 自然语言解析 ==========
    if (!task) {
      const nl = parseNaturalLanguage(line);
      if (nl) {
        if (/^\d+$/.test(nl.rawName || nl.rawPhone)) {
          task = { studentId: (nl.rawName || nl.rawPhone), periodSort: nl.periodSort, newDate: nl.newDate, newTime: nl.newTime, status: 'ok' };
        } else if (studentRoster.length > 0) {
          const matched = matchStudent(nl.rawName, nl.rawPhone, studentRoster);
          if (matched && matched.studentId) {
            task = { studentId: matched.studentId, studentName: matched.matchedName, periodSort: nl.periodSort, newDate: nl.newDate, newTime: nl.newTime, status: 'ok' };
          } else {
            tasks.push({ status: 'error', error: matched?.error || `未找到学员"${nl.rawName || nl.rawPhone}"`, line: i + 1 });
            continue;
          }
        } else {
          tasks.push({ status: 'error', error: `自然语言解析成功但未加载学情表，无法匹配"${nl.rawName}"`, line: i + 1 });
          continue;
        }
      }
    }

    if (!task) {
      tasks.push({ status: 'error', error: `无法解析: ${line.substring(0, 50)}`, line: i + 1 });
      continue;
    }

    tasks.push(task);
  }

  const success = tasks.filter(t => t.status === 'ok').length;
  const failed = tasks.filter(t => t.status === 'error').length;

  return { tasks, total: tasks.length, success, failed };
}

/**
 * 学员匹配
 */
export function matchStudent(rawName, rawPhone, studentRoster) {
  if (!studentRoster || studentRoster.length === 0) return null;

  // 手机号精确匹配
  if (rawPhone) {
    const phoneMatch = studentRoster.filter(s => s.phone === rawPhone);
    if (phoneMatch.length === 1) {
      return { studentId: phoneMatch[0].studentId, matchedName: phoneMatch[0].name };
    }
    if (phoneMatch.length > 1 && rawName) {
      const namePhone = phoneMatch.filter(s => s.name === rawName);
      if (namePhone.length === 1) {
        return { studentId: namePhone[0].studentId, matchedName: namePhone[0].name };
      }
    }
  }

  // 姓名精确匹配
  if (rawName) {
    const nameMatches = studentRoster.filter(s => s.name === rawName);
    if (nameMatches.length === 1) {
      return { studentId: nameMatches[0].studentId, matchedName: nameMatches[0].name };
    }

    if (nameMatches.length > 1 && rawPhone) {
      const namePhone = nameMatches.filter(s => s.phone === rawPhone);
      if (namePhone.length === 1) {
        return { studentId: namePhone[0].studentId, matchedName: namePhone[0].name };
      }
      if (namePhone.length === 0) {
        return { error: `姓名"${rawName}"有 ${nameMatches.length} 个匹配，但手机号不匹配` };
      }
      return { error: `姓名"${rawName}" + 手机号仍有多个匹配，请直接用学员ID` };
    }

    if (nameMatches.length > 1) {
      const phones = nameMatches.map(s => `${s.name}(${s.phone})`).join('、');
      return { error: `姓名"${rawName}"有 ${nameMatches.length} 个匹配: ${phones}，请附加手机号或用学员ID` };
    }

    // 模糊匹配
    const fuzzy = studentRoster.filter(s => s.name.includes(rawName) || rawName.includes(s.name));
    if (fuzzy.length === 1) {
      return { studentId: fuzzy[0].studentId, matchedName: fuzzy[0].name };
    }
    if (fuzzy.length > 1) {
      return { error: `"${rawName}"模糊匹配到多个学员，请更精确输入或用学员ID` };
    }
  }

  return { error: `未找到学员"${rawName || rawPhone}"` };
}
