/**
 * 调课 JWT Token 管理服务（V4）
 * save(保存/更新调课JWT) / get(获取状态)
 * JWT AES-256-CBC 加密存储于 tk_tokens 集合
 * V4: 不再依赖 ef_users 登录体系，用JWT自身sub做用户标识
 */

const crypto = require('crypto');

// AES 加密密钥（正好32字节，生产环境应从环境变量读取）
const AES_KEY = process.env.TK_AES_KEY || 'tk-aes-key-2026-tiaoke-helper-32';
// AES 初始向量（正好16字节）
const AES_IV = process.env.TK_AES_IV || 'tk-iv-2026-16byt';

/**
 * 保存/更新调课 JWT
 * V4: 公开接口，用JWT的sub字段作为用户标识（不再依赖currentUser）
 * @param {Object} data - { token: 'eyJ...' }
 * @param {Object} currentUser - null（公开接口）
 * @param {Object} ctx - 上下文
 */
exports.save = async function (data, currentUser, ctx) {
  const { db, response } = ctx;

  if (!data.token) {
    return response.badRequest('请提供调课 Token');
  }

  // JWT 格式基本校验
  const jwtPattern = /^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
  if (!jwtPattern.test(data.token)) {
    return response.badRequest('Token 格式不正确，请检查是否完整复制');
  }

  try {
    // 解码 JWT 获取过期时间和用户信息
    const payload = decodeJwtPayload(data.token);
    if (!payload) {
      return response.badRequest('Token 无法解析，请检查是否完整复制');
    }

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return response.error(400, 'Token 已过期，请重新获取');
    }

    // 验证 JWT 签发方
    if (payload.iss && payload.iss !== 'https://cas.yuaiweiwu.com') {
      return response.badRequest('Token 不是来自调课后台，请确认来源');
    }

    // 用JWT的sub作为用户标识（V4核心改动：不再依赖ef_users）
    const userId = payload.sub || payload.user_id || payload.uid || 'unknown';
    const userName = payload.name || payload.preferred_username || payload.sub || '辅导员';

    // AES 加密
    const encrypted = aesEncrypt(data.token);

    // 计算过期时间
    const expireTime = payload.exp ? new Date(payload.exp * 1000) : new Date(Date.now() + 24 * 60 * 60 * 1000);

    // 以 userId 为主键，upsert
    const existing = await db.collection('tk_tokens').where({
      userId: userId,
    }).get();

    const tokenData = {
      encryptedToken: encrypted,
      expireTime: expireTime,
      userName: userName,
      updatedAt: new Date(),
    };

    if (existing.data && existing.data.length > 0) {
      // 更新
      await db.collection('tk_tokens').doc(existing.data[0]._id).update(tokenData);
    } else {
      // 新增
      await db.collection('tk_tokens').add({
        userId: userId,
        ...tokenData,
      });
    }

    return response.success({
      expireTime: expireTime,
      remaining: payload.exp ? Math.floor((payload.exp - now) / 3600) + '小时' : '约24小时',
      user: { userId: userId, name: userName, role: 'counselor' },
    }, 'Token 保存成功');
  } catch (err) {
    console.error('[TK-Token] Save error:', err);
    return response.error(500, 'Token 保存失败');
  }
};

/**
 * 获取当前调课 JWT 状态（不返回明文 Token）
 * V4: 公开接口，用请求中的 _token 或 body.userId 标识用户
 */
exports.get = async function (data, currentUser, ctx) {
  const { db, response } = ctx;

  // V4: 尝试从 data 中获取 userId 标识
  // 前端可能传 userId，也可能不传（此时返回所有或最近一条）
  let query = db.collection('tk_tokens');

  if (data.userId) {
    query = query.where({ userId: data.userId });
  }

  try {
    // 如果没有指定userId，尝试从localStorage存的user信息中获取
    // 简化处理：如果没有userId，返回最近一条记录
    let result;
    if (data.userId) {
      result = await query.get();
    } else {
      // 查询最近更新的记录
      result = await db.collection('tk_tokens')
        .orderBy('updatedAt', 'desc')
        .limit(1)
        .get();
    }

    if (!result.data || result.data.length === 0) {
      return response.success({
        status: 'not_set',
        message: '未设置调课 Token',
      });
    }

    const record = result.data[0];
    const now = new Date();
    const expireTime = new Date(record.expireTime);
    const remainingMs = expireTime.getTime() - now.getTime();

    let status, message;
    if (remainingMs <= 0) {
      status = 'expired';
      message = '调课 Token 已过期';
    } else if (remainingMs < 2 * 60 * 60 * 1000) {
      status = 'expiring';
      message = `Token 即将过期（剩余 ${Math.floor(remainingMs / 60000)} 分钟）`;
    } else {
      status = 'valid';
      message = `Token 有效（剩余 ${Math.floor(remainingMs / 3600000)} 小时）`;
    }

    return response.success({
      status: status,
      message: message,
      expireTime: record.expireTime,
      updatedAt: record.updatedAt,
      userId: record.userId,
      userName: record.userName || '-',
    });
  } catch (err) {
    console.error('[TK-Token] Get status error:', err);
    return response.error(500, '获取 Token 状态失败');
  }
};

/**
 * 获取解密后的调课 JWT（内部使用，不暴露为 API）
 * 供 reschedule.service.js 和 class.service.js 调用
 * V4: 需要传入 userId 来定位具体的 Token 记录
 */
exports.getDecryptedToken = async function (userId, db) {
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

  try {
    return aesDecrypt(record.encryptedToken);
  } catch (err) {
    console.error('[TK-Token] Decrypt error:', err);
    return null;
  }
};

// ========== 工具函数 ==========

/**
 * 解码 JWT Payload（不验证签名）
 */
function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    let payload = parts[1];
    // Base64URL 解码
    payload = payload.replace(/-/g, '+').replace(/_/g, '/');
    while (payload.length % 4) payload += '=';
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * AES-256-CBC 加密
 */
function aesEncrypt(text) {
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(AES_KEY, 'utf8'), Buffer.from(AES_IV, 'utf8'));
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return encrypted;
}

/**
 * AES-256-CBC 解密
 */
function aesDecrypt(encrypted) {
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(AES_KEY, 'utf8'), Buffer.from(AES_IV, 'utf8'));
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
