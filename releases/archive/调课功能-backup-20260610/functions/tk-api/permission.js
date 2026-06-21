/**
 * EduFlow 权限工具
 * 角色等级、权限检查、组织范围过滤
 * T02 完善完整逻辑
 */

/**
 * 角色等级映射（对齐PRD V2.3 四.1 角色层级）
 * @type {Object}
 */
exports.ROLE_LEVELS = {
  superAdmin: 6,
  operationLeader: 5,
  centerLeader: 4,
  subjectLeader: 3,
  gradeLeader: 2,
  counselor: 1,
};

/**
 * 操作权限映射表（对齐PRD V2.3 四.2 权限矩阵）
 * key: action 标识, value: 所需最低角色等级
 * @type {Object}
 */
const ACTION_MIN_LEVELS = {
  'message.create:operation': 5,
  'message.create:center': 4,
  'message.create:subject': 3,
  'message.create:team': 2,
  'message.update': 2,
  'message.delete': 3,
  'message.top': 3,
  'message.archive': 3,
  'message.view': 1,
  'message.cancelSchedule': 2,
  'report.submit': 2,
  'report.summary': 3,
  'schedule.create': 2,
  'schedule.update': 2,
  'schedule.delete': 2,
  'user.list': 2,
  'user.create': 2,
  'user.update': 2,
  'user.disable': 2,
  'user.enable': 2,
  'config.createType': 6,
  'config.updateType': 6,
  'config.deleteType': 6,
  'config.createTag': 4,
  'config.updateTag': 4,
  'config.deleteTag': 4,
  'auth.impersonate': 5,
  'seed.init': 6,
  // 调课助手权限
  'tk.use': 1,          // counselor 及以上可用
  'tk.token.save': 1,   // 保存调课 JWT
  'tk.student.import': 1, // 导入学情表
  'tk.reschedule': 1,   // 执行改约
};

/**
 * 检查用户是否有指定操作权限
 * @param {string} role - 用户角色
 * @param {string} action - 操作标识，如 "message.create:grade"
 * @returns {boolean} 是否有权限
 */
exports.checkPermission = function (role, action) {
  const userLevel = exports.ROLE_LEVELS[role] || 0;
  const requiredLevel = ACTION_MIN_LEVELS[action] || 0;

  if (requiredLevel === 0) {
    // 未定义的操作默认允许
    return true;
  }

  return userLevel >= requiredLevel;
};

/**
 * 根据角色返回可发布的消息类型
 * @param {string} role - 用户角色
 * @returns {string|null} 消息类型 scope，null 表示不可发布
 */
exports.getPublishableType = function (role) {
  const typeMap = {
    superAdmin: 'operation',
    operationLeader: 'operation',
    centerLeader: 'center',
    subjectLeader: 'subject',
    gradeLeader: 'team',
  };
  return typeMap[role] || null;
};

/**
 * 根据角色返回可选的可见层级范围
 * @param {string} role - 用户角色
 * @returns {number[]} 可选 visibilityLevel 列表
 */
exports.getVisibilityLevelRange = function (role) {
  const ranges = {
    superAdmin: [1, 2, 3, 4, 5],
    operationLeader: [1, 2, 3, 4],
    centerLeader: [1, 2, 3],
    subjectLeader: [1, 2],
    gradeLeader: [1],
  };
  return ranges[role] || [];
};

/**
 * 获取用户可见的消息过滤条件
 * 合并 visibilityLevel 等级过滤 + scopeOrg 组织范围过滤
 * 规则：visibilityLevel <= userLevel 且 组织范围匹配（含上级消息跨板块可见）
 *
 * ⚠️ CloudBase SDK 的 _.or 是方法调用，不是对象key！
 *    错误：filter[_.or] = [...]  → _.or.toString()变成函数源码字符串作为key，SDK不识别
 *    正确：filter.orCondition = _.or([...])  → 返回LogicCommand对象，再用_.and组合
 *
 * @param {Object} user - 用户对象（含 organization、role 等）
 * @param {Object} _ - db.command 对象（用于 _.or / _.lte 等）
 * @returns {Object} { visibilityLevel, orCondition? } orCondition 是 _.or() 返回的 LogicCommand
 */
exports.getVisibleMessageFilter = function (user, _) {
  if (!user || !user.organization) {
    return {};
  }

  const userLevel = exports.ROLE_LEVELS[user.role] || 0;
  const filter = {};

  // visibilityLevel 过滤
  if (_) {
    filter.visibilityLevel = _.lte(userLevel);
  }

  // 超级管理员和运营负责人可查看所有组织范围的消息
  if (userLevel >= 5) {
    return filter;
  }

  const org = user.organization;
  if (!_) return filter;

  // 中心负责人：本中心 + 运营消息（scopeOrg.center=''）
  if (user.role === 'centerLeader') {
    if (org.center) {
      filter.orCondition = _.or([
        { 'scopeOrg.center': org.center },
        { 'scopeOrg.center': '' },
      ]);
    }
    return filter;
  }

  // 学科负责人：本学科 + 本中心不限学科 + 运营消息
  if (user.role === 'subjectLeader') {
    if (org.center) {
      filter.orCondition = _.or([
        { 'scopeOrg.center': org.center, 'scopeOrg.subject': org.subject || '' },
        { 'scopeOrg.center': org.center, 'scopeOrg.subject': '' },
        { 'scopeOrg.center': '' },
      ]);
    }
    return filter;
  }

  // 年级小组长：本组 + 本学科不限年级 + 本中心不限学科 + 运营消息
  if (user.role === 'gradeLeader') {
    if (org.center) {
      filter.orCondition = _.or([
        { 'scopeOrg.center': org.center, 'scopeOrg.subject': org.subject || '', 'scopeOrg.grade': org.grade || '' },
        { 'scopeOrg.center': org.center, 'scopeOrg.subject': org.subject || '', 'scopeOrg.grade': '' },
        { 'scopeOrg.center': org.center, 'scopeOrg.subject': '' },
        { 'scopeOrg.center': '' },
      ]);
    }
    return filter;
  }

  // 辅导伙伴：本组 + 本年级不限小组 + 本学科不限年级 + 本中心不限学科 + 运营消息
  if (org.center) {
    filter.orCondition = _.or([
      { 'scopeOrg.center': org.center, 'scopeOrg.subject': org.subject || '', 'scopeOrg.grade': org.grade || '', 'scopeOrg.team': org.team || '' },
      { 'scopeOrg.center': org.center, 'scopeOrg.subject': org.subject || '', 'scopeOrg.grade': org.grade || '', 'scopeOrg.team': '' },
      { 'scopeOrg.center': org.center, 'scopeOrg.subject': org.subject || '', 'scopeOrg.grade': '' },
      { 'scopeOrg.center': org.center, 'scopeOrg.subject': '' },
      { 'scopeOrg.center': '' },
    ]);
  }

  return filter;
};

/**
 * 判断操作者是否可管理目标用户
 * 基于角色等级比较：操作者等级必须 >= 目标等级
 * @param {Object} operator - 操作者用户对象
 * @param {Object} target - 目标用户对象
 * @returns {boolean} 是否可管理
 */
exports.canManageUser = function (operator, target) {
  if (!operator || !target) return false;

  const operatorLevel = exports.ROLE_LEVELS[operator.role] || 0;
  const targetLevel = exports.ROLE_LEVELS[target.role] || 0;

  // 操作者等级必须严格大于目标才能管理
  // 同级不可管理（除非是超管管理超管）
  if (operator.role === 'superAdmin') return true;

  return operatorLevel > targetLevel;
};

/**
 * 获取用户可查询的用户列表过滤条件
 * 超管/运营负责人看全部；中心负责人看本中心；学科负责人看本学科；年级小组长看本年级；辅导伙伴看自己
 * @param {Object} user - 当前用户对象
 * @returns {Object} NoSQL 查询条件对象
 */
exports.getUserQueryFilter = function (user) {
  if (!user) {
    return {};
  }

  // 超级管理员可查看所有用户
  if (user.role === 'superAdmin') {
    return {};
  }

  // 运营负责人可查看所有用户
  if (user.role === 'operationLeader') {
    return {};
  }

  // 中心负责人可查看本中心下所有用户
  if (user.role === 'centerLeader') {
    if (user.organization && user.organization.center) {
      return { 'organization.center': user.organization.center };
    }
    return {};
  }

  const org = user.organization || {};
  const filter = {};

  // 学科负责人：可看本学科下所有用户
  if (user.role === 'subjectLeader') {
    if (org.center) filter['organization.center'] = org.center;
    if (org.subject) filter['organization.subject'] = org.subject;
    return filter;
  }

  // 年级小组长：可看本年级下所有用户
  if (user.role === 'gradeLeader') {
    if (org.center) filter['organization.center'] = org.center;
    if (org.subject) filter['organization.subject'] = org.subject;
    if (org.grade) filter['organization.grade'] = org.grade;
    return filter;
  }

  // 辅导伙伴：只能看自己
  return { _id: user._id };
};

/**
 * 判断用户是否为管理员级别以上（中心负责人及以上）
 * @param {string} role - 用户角色
 * @returns {boolean}
 */
exports.isAdmin = function (role) {
  const level = exports.ROLE_LEVELS[role] || 0;
  return level >= 2;
};

/**
 * 判断用户是否为超级管理员
 * @param {string} role - 用户角色
 * @returns {boolean}
 */
exports.isSuperAdmin = function (role) {
  return role === 'superAdmin';
};
