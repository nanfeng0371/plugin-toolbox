/**
 * 课表查询服务（透传 ai-genesis API）
 * list(查询课表列表) / getHour(查询课时详情)
 * 所有请求在云函数端完成，携带 Cookie 认证
 */

const https = require('https');
const http = require('http');

const AI_GENESIS_BASE = 'https://ai-genesis.yuaiweiwu.com';

/**
 * 查询学员课表列表
 * @param {Object} data - { studentId, startDate?, endDate? }
 */
exports.list = async function (data, currentUser, ctx) {
  const { db, response } = ctx;

  if (!data.studentId) {
    return response.badRequest('请提供学员ID');
  }

  // 获取解密后的调课 JWT
  const tiaokeToken = require('./tiaokeToken.service.js');
  const jwt = await tiaokeToken.getDecryptedToken(currentUser._id, db);
  if (!jwt) {
    return response.error(401, '调课 Token 未设置或已过期，请先获取 Token');
  }

  try {
    // 默认查询未来30天
    const now = new Date();
    const startDate = data.startDate || formatDate(now);
    const endDate = data.endDate || formatDate(new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000));

    const url = `${AI_GENESIS_BASE}/prod-api/student-center-ai/regularCourse/next/class/list?classStatus=0&startDate=${startDate}&endDate=${endDate}`;

    const result = await httpGet(url, jwt);

    if (result.code && result.code !== '000000' && result.code !== 200) {
      return response.error(502, `课表查询失败：${result.message || result.msg || '未知错误'}`);
    }

    // 提取课表数组
    let classList = extractArray(result);

    // 过滤该学员的课表
    if (data.studentId && classList.length > 0) {
      classList = classList.filter(c =>
        String(c.userId) === String(data.studentId) ||
        String(c.studentId) === String(data.studentId)
      );
    }

    return response.success({
      total: classList.length,
      list: classList,
    });
  } catch (err) {
    console.error('[TK-Class] List error:', err);
    return response.error(500, '课表查询失败：' + (err.message || '网络错误'));
  }
};

/**
 * 查询课时详情
 * @param {Object} data - { userClassTimeId }
 */
exports.getHour = async function (data, currentUser, ctx) {
  const { db, response } = ctx;

  if (!data.userClassTimeId) {
    return response.badRequest('请提供课时ID');
  }

  const tiaokeToken = require('./tiaokeToken.service.js');
  const jwt = await tiaokeToken.getDecryptedToken(currentUser._id, db);
  if (!jwt) {
    return response.error(401, '调课 Token 未设置或已过期，请先获取 Token');
  }

  try {
    const url = `${AI_GENESIS_BASE}/prod-api/student-center-ai/ai/user/course/classhour?userClassTimeId=${data.userClassTimeId}`;

    const result = await httpGet(url, jwt);

    if (result.code && result.code !== '000000' && result.code !== 200) {
      return response.error(502, `课时查询失败：${result.message || result.msg || '未知错误'}`);
    }

    return response.success(result.data || result);
  } catch (err) {
    console.error('[TK-Class] GetHour error:', err);
    return response.error(500, '课时查询失败：' + (err.message || '网络错误'));
  }
};

// ========== 工具函数 ==========

/**
 * HTTP GET 请求（携带认证 Cookie）
 */
function httpGet(url, jwt) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'Cookie': `authorization-app=aiXin; authorization-token=${jwt}`,
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
      },
    };

    const protocol = parsedUrl.protocol === 'https:' ? https : http;
    const req = protocol.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ raw: data });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
    req.end();
  });
}

/**
 * 从 API 响应中提取数组（兼容多种响应格式）
 */
function extractArray(result) {
  if (Array.isArray(result)) return result;
  if (result.data) {
    if (Array.isArray(result.data)) return result.data;
    // data 可能是 { totalCount, rows: [...] }
    for (const key of ['rows', 'list', 'records', 'items', 'content']) {
      if (result.data[key] && Array.isArray(result.data[key])) {
        return result.data[key];
      }
    }
  }
  for (const key of ['rows', 'list', 'records', 'items', 'content']) {
    if (result[key] && Array.isArray(result[key])) {
      return result[key];
    }
  }
  return [];
}

/**
 * 格式化日期为 YYYY-MM-DD
 */
function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
