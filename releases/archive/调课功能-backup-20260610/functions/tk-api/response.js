/**
 * EduFlow 响应工具
 * 统一格式化响应结构
 * 错误码：0=成功, 400=参数错误, 401=未登录, 403=无权限, 404=不存在, 409=冲突, 500=服务端异常
 */

/**
 * 成功响应
 * @param {*} data - 业务数据
 * @param {string} [message='success'] - 提示消息
 * @returns {Object} 标准成功响应
 */
exports.success = function (data, message) {
  return {
    code: 0,
    message: message || 'success',
    data: data !== undefined ? data : null,
  };
};

/**
 * 错误响应
 * @param {number} code - 错误码
 * @param {string} message - 错误消息
 * @returns {Object} 标准错误响应
 */
exports.error = function (code, message) {
  return {
    code: code || 500,
    message: message || '服务端异常',
    data: null,
  };
};

/**
 * 分页响应
 * @param {Array} list - 数据列表
 * @param {number} total - 总记录数
 * @param {number} page - 当前页码
 * @param {number} pageSize - 每页条数
 * @param {Object} [extra={}] - 额外数据（如 unread 等）
 * @returns {Object} 标准分页响应
 */
exports.paginate = function (list, total, page, pageSize, extra) {
  return {
    code: 0,
    message: 'success',
    data: {
      list: list || [],
      total: total || 0,
      page: page || 1,
      pageSize: pageSize || 20,
      ...(extra || {}),
    },
  };
};

/**
 * 参数校验错误快捷方法
 * @param {string} message - 校验失败消息
 * @returns {Object}
 */
exports.badRequest = function (message) {
  return exports.error(400, message || '请求参数错误');
};

/**
 * 未登录快捷方法
 * @param {string} message - 提示消息
 * @returns {Object}
 */
exports.unauthorized = function (message) {
  return exports.error(401, message || '未登录，请先登录');
};

/**
 * 无权限快捷方法
 * @param {string} message - 提示消息
 * @returns {Object}
 */
exports.forbidden = function (message) {
  return exports.error(403, message || '无权限执行此操作');
};

/**
 * 资源不存在快捷方法
 * @param {string} message - 提示消息
 * @returns {Object}
 */
exports.notFound = function (message) {
  return exports.error(404, message || '资源不存在');
};

/**
 * 数据冲突快捷方法
 * @param {string} message - 提示消息
 * @returns {Object}
 */
exports.conflict = function (message) {
  return exports.error(409, message || '数据冲突');
};
