/**
 * 调课助手 API 云函数入口
 * CORS 预检、JSON 解析、Token 鉴权中间件、action 路由分发、统一响应格式化、异常兜底
 * 结构复用 EduFlow ef-api/index.js
 */

const tcb = require('tcb-admin-node');

// 初始化云开发
tcb.init({
  env: process.env.TCB_ENV,
});

const db = tcb.database();
const _ = db.command;

// 引入公共模块
const response = require('./response.js');
const dbHelper = require('./db-helper.js');
const permission = require('./permission.js');

// 公开接口白名单（无需 Token 鉴权）
// V4: tiaokeToken.save/get 改为公开，直接用 JWT 自身信息做用户标识
const PUBLIC_ACTIONS = ['auth.login', 'tiaokeToken.save', 'tiaokeToken.get'];

// Service 模块懒加载映射
const serviceMap = {};

/**
 * 获取 service 模块（懒加载）
 */
function getService(name) {
  if (!serviceMap[name]) {
    serviceMap[name] = require(`./${name}.js`);
  }
  return serviceMap[name];
}

/**
 * 云函数入口
 */
exports.main = async (event, context) => {
  // ===== 1. CORS 预检处理 =====
  if (event.httpMethod === 'OPTIONS') {
    return {
      isBase64Encoded: false,
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
      body: '',
    };
  }

  // ===== 2. 请求体解析 =====
  let body = event.body || event;
  let action = '';
  let data = {};

  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      return buildHttpResponse(400, response.error(400, 'Invalid JSON body'));
    }
    action = body.action || '';
    data = body.data || {};
  } else {
    action = body.action || '';
    data = body.data || {};
  }

  // 兼容 GET 请求参数
  if (!action && event.queryStringParameters) {
    action = event.queryStringParameters.action || '';
    data = event.queryStringParameters.data
      ? JSON.parse(event.queryStringParameters.data)
      : {};
  }

  if (!action) {
    return buildHttpResponse(400, response.error(400, 'Missing action parameter'));
  }

  // ===== 3. Token 鉴权中间件 =====
  let currentUser = null;
  if (!PUBLIC_ACTIONS.includes(action)) {
    const authHeader = event.headers && (event.headers.Authorization || event.headers.authorization);
    const token = authHeader
      ? authHeader.replace('Bearer ', '')
      : data._token || '';

    if (!token) {
      return buildHttpResponse(401, response.error(401, '未登录，请先登录'));
    }

    try {
      // V4: 先尝试 ef_tokens 鉴权（旧方式），再尝试 tk_tokens 鉴权
      currentUser = await verifyToken(token);
      if (!currentUser) {
        // 尝试从 tk_tokens 鉴权（前端存的 'tiaoke_active' 标记 + userId）
        currentUser = await verifyTiaokeToken(token, data);
      }
      if (!currentUser) {
        return buildHttpResponse(401, response.error(401, 'Token 已过期，请重新登录'));
      }
    } catch (err) {
      console.error('[TK-API] Token verification failed:', err.message);
      return buildHttpResponse(401, response.error(401, 'Token 验证失败，请重新登录'));
    }

    // 检查用户状态
    if (currentUser.status === 'disabled') {
      return buildHttpResponse(403, response.error(403, '账号已被禁用，请联系管理员'));
    }

    // 角色检查：counselor 及以上才能使用调课助手
    if (!permission.checkPermission(currentUser.role, 'tk.use')) {
      return buildHttpResponse(403, response.error(403, '无权限使用调课助手，仅辅导伙伴及以上可用'));
    }
  }

  // ===== 4. action 路由分发 =====
  try {
    let result;
    const [serviceName, methodName] = action.split('.');

    if (!serviceName || !methodName) {
      return buildHttpResponse(400, response.error(400, `Invalid action format: ${action}`));
    }

    const service = getService(`${serviceName}.service`);

    if (!service || typeof service[methodName] !== 'function') {
      return buildHttpResponse(404, response.error(404, `Unknown action: ${action}`));
    }

    // 清理 data 中的内部字段
    const cleanData = { ...data };
    delete cleanData._token;

    // 执行 service 方法
    result = await service[methodName](cleanData, currentUser, { db, _, dbHelper, permission, response });

    return buildHttpResponse(200, result);
  } catch (err) {
    console.error(`[TK-API] Error handling action "${action}":`, err);
    return buildHttpResponse(500, response.error(500, '服务端异常，请稍后重试'));
  }
};

/**
 * 验证 Token 有效性（复用 EduFlow ef_tokens）
 */
async function verifyToken(token) {
  const tokenResult = await db.collection('ef_tokens').where({
    token: token,
  }).get();

  if (!tokenResult.data || tokenResult.data.length === 0) {
    return null;
  }

  const tokenRecord = tokenResult.data[0];

  // 检查是否过期
  if (tokenRecord.expireTime && new Date(tokenRecord.expireTime) < new Date()) {
    await db.collection('ef_tokens').doc(tokenRecord._id).remove();
    return null;
  }

  // 获取用户信息
  const userResult = await db.collection('ef_users').doc(tokenRecord.userId).get();
  if (!userResult.data || (Array.isArray(userResult.data) && userResult.data.length === 0)) {
    return null;
  }

  const user = Array.isArray(userResult.data) ? userResult.data[0] : userResult.data;

  // 活跃用户自动续期（距过期 < 30 分钟时刷新）
  if (tokenRecord.expireTime) {
    const expireTime = new Date(tokenRecord.expireTime).getTime();
    const now = Date.now();
    const renewThreshold = 30 * 60 * 1000;
    if (expireTime - now < renewThreshold) {
      const newExpireTime = new Date(now + 2 * 60 * 60 * 1000);
      await db.collection('ef_tokens').doc(tokenRecord._id).update({
        expireTime: newExpireTime,
      });
    }
  }

  const { passwordHash, ...safeUser } = user;
  return safeUser;
}

/**
 * V4: 验证调课 Token（tk_tokens 鉴权）
 * 前端存的标记是 'tiaoke_active'，通过 data.userId 定位到具体的 tk_tokens 记录
 * 验证该记录的 Token 是否有效，如果有效则构造一个虚拟的 currentUser
 */
async function verifyTiaokeToken(token, data) {
  // token 是 'tiaoke_active' 标记，需要用 userId 找到 tk_tokens 记录
  const userId = data.userId || data._userId;
  if (!userId) return null;

  const result = await db.collection('tk_tokens').where({
    userId: userId,
  }).get();

  if (!result.data || result.data.length === 0) {
    return null;
  }

  const record = result.data[0];

  // 检查过期
  if (record.expireTime && new Date(record.expireTime) < new Date()) {
    return null;
  }

  // 构造虚拟用户（供权限检查使用）
  return {
    _id: record.userId,
    name: record.userName || '辅导员',
    role: 'counselor', // 默认辅导员角色
    status: 'active',
  };
}

/**
 * 构建 HTTP 响应
 */
function buildHttpResponse(statusCode, body) {
  return {
    isBase64Encoded: false,
    statusCode: statusCode,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  };
}
