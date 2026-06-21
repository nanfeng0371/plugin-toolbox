/**
 * 调课助手认证服务
 * 直接复用 EduFlow ef_users/ef_tokens 进行登录验证
 */

const bcrypt = require('bcryptjs');
const crypto = require('crypto');

/** EF Token 有效期（2小时，与 EduFlow 一致） */
const TOKEN_EXPIRE_MS = 2 * 60 * 60 * 1000;

/**
 * 用户登录（复用 ef_users 验证）
 */
exports.login = async function (data, currentUser, ctx) {
  const { db, response } = ctx;

  if (!data.username || !data.password) {
    return response.badRequest('请输入用户名和密码');
  }

  try {
    // 查询 ef_users
    const userResult = await db.collection('ef_users').where({
      username: data.username,
    }).get();

    if (!userResult.data || userResult.data.length === 0) {
      return response.error(401, '用户名或密码错误');
    }

    const user = userResult.data[0];

    // 检查用户状态
    if (user.status === 'disabled') {
      return response.error(403, '账号已被禁用，请联系管理员');
    }

    // 角色检查：counselor 及以上
    const ROLE_LEVELS = {
      superAdmin: 6,
      operationLeader: 5,
      centerLeader: 4,
      subjectLeader: 3,
      gradeLeader: 2,
      counselor: 1,
    };
    const userLevel = ROLE_LEVELS[user.role] || 0;
    if (userLevel < 1) {
      return response.error(403, '无权限使用调课助手');
    }

    // 验证密码
    const isPasswordValid = await bcrypt.compare(data.password, user.passwordHash);
    if (!isPasswordValid) {
      return response.error(401, '用户名或密码错误');
    }

    // 生成 Token（与 EduFlow 格式一致）
    const token = generateToken();
    const expireTime = new Date(Date.now() + TOKEN_EXPIRE_MS);

    // 存储 Token 记录到 ef_tokens
    await db.collection('ef_tokens').add({
      token: token,
      userId: user._id,
      expireTime: expireTime,
      createTime: new Date(),
    });

    // 更新最后登录时间
    await db.collection('ef_users').doc(user._id).update({
      lastLoginTime: new Date(),
    });

    // 返回用户信息（去除敏感字段）
    const { passwordHash, ...safeUser } = user;

    return response.success({
      token: token,
      user: safeUser,
    }, '登录成功');
  } catch (err) {
    console.error('[TK-Auth] Login error:', err);
    return response.error(500, '登录失败，请稍后重试');
  }
};

/**
 * 验证 Token 有效性
 */
exports.verify = async function (data, currentUser, ctx) {
  const { response } = ctx;
  if (currentUser) {
    return response.success({
      valid: true,
      user: currentUser,
    });
  }
  return response.error(401, 'Token 无效');
};

/**
 * 生成随机 Token（与 EduFlow 格式一致）
 */
function generateToken(length) {
  length = length || 32;
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payloadStr = base64UrlEncode(JSON.stringify({
    iat: Math.floor(Date.now() / 1000),
    jti: crypto.randomBytes(8).toString('hex'),
  }));
  const signature = crypto.randomBytes(length).toString('hex').substring(0, length);
  return `${header}.${payloadStr}.${signature}`;
}

function base64UrlEncode(str) {
  return Buffer.from(str)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}
