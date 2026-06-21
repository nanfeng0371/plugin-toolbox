/**
 * EduFlow 数据库工具
 * 分页查询封装、事务辅助、批量操作
 */

/**
 * 分页查询封装
 * @param {Object} collection - 数据库集合引用
 * @param {Object} query - 查询条件
 * @param {Object} options - 分页排序选项
 * @param {number} [options.page=1] - 页码
 * @param {number} [options.pageSize=20] - 每页条数
 * @param {Array} [options.orderBy] - 排序规则 [['createTime', 'desc']]
 * @param {Object} [options.projection] - 字段投影
 * @returns {Promise<{list: Array, total: number, page: number, pageSize: number}>}
 */
exports.paginateQuery = async function (collection, query, options) {
  const page = Math.max(1, (options && options.page) || 1);
  // 导出模式下允许更大的 pageSize（上限 5000），普通模式限制最大 100
  const maxPageSize = (options && options.export) ? 5000 : 100;
  const pageSize = Math.min(maxPageSize, Math.max(1, (options && options.pageSize) || 20));
  const orderBy = (options && options.orderBy) || [['createTime', 'desc']];
  const projection = options && options.projection;

  // 支持自定义排序字段和方向
  const sortField = (options && options.sortField) || '';
  const sortOrder = (options && options.sortOrder) || '';
  if (sortField && sortOrder) {
    orderBy.length = 0;
    orderBy.push([sortField, sortOrder]);
  }

  const skip = (page - 1) * pageSize;

  // 查询总数
  const countResult = await collection.where(query).count();
  const total = countResult.total || 0;

  // 查询数据
  let queryBuilder = collection.where(query).skip(skip).limit(pageSize);

  // 应用排序
  if (orderBy && orderBy.length > 0) {
    for (const [field, order] of orderBy) {
      queryBuilder = queryBuilder.orderBy(field, order);
    }
  }

  // 应用字段投影
  if (projection) {
    queryBuilder = queryBuilder.field(projection);
  }

  const dataResult = await queryBuilder.get();
  const list = dataResult.data || [];

  return {
    list: list,
    total: total,
    page: page,
    pageSize: pageSize,
  };
};

/**
 * 事务辅助：执行事务
 * @param {Object} db - 数据库实例
 * @param {Function} callback - 事务回调，接收 transaction 对象
 * @returns {Promise<*>} 事务结果
 */
exports.runTransaction = async function (db, callback) {
  const transaction = await db.startTransaction();
  try {
    const result = await callback(transaction);
    await transaction.commit();
    return result;
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
};

/**
 * 批量插入数据
 * @param {Object} collection - 数据库集合引用
 * @param {Array} dataList - 数据列表
 * @param {number} [batchSize=20] - 每批处理数量
 * @returns {Promise<{success: number, failed: number, errors: Array}>}
 */
exports.batchInsert = async function (collection, dataList, batchSize) {
  batchSize = batchSize || 20;
  let success = 0;
  let failed = 0;
  const errors = [];

  for (let i = 0; i < dataList.length; i += batchSize) {
    const batch = dataList.slice(i, i + batchSize);
    const promises = batch.map(async (item) => {
      try {
        await collection.add(item);
        success++;
      } catch (err) {
        failed++;
        errors.push({
          index: i + batch.indexOf(item),
          error: err.message,
        });
      }
    });
    await Promise.all(promises);
  }

  return { success, failed, errors };
};

/**
 * 批量更新数据
 * @param {Object} collection - 数据库集合引用
 * @param {Array<{id: string, data: Object}>} updateList - 更新列表
 * @param {number} [batchSize=20] - 每批处理数量
 * @returns {Promise<{success: number, failed: number, errors: Array}>}
 */
exports.batchUpdate = async function (collection, updateList, batchSize) {
  batchSize = batchSize || 20;
  let success = 0;
  let failed = 0;
  const errors = [];

  for (let i = 0; i < updateList.length; i += batchSize) {
    const batch = updateList.slice(i, i + batchSize);
    const promises = batch.map(async ({ id, data }) => {
      try {
        await collection.doc(id).update(data);
        success++;
      } catch (err) {
        failed++;
        errors.push({
          id: id,
          error: err.message,
        });
      }
    });
    await Promise.all(promises);
  }

  return { success, failed, errors };
};

/**
 * 获取单条记录（通过 ID）
 * @param {Object} collection - 数据库集合引用
 * @param {string} id - 记录 ID
 * @returns {Promise<Object|null>} 记录对象，不存在返回 null
 */
exports.getById = async function (collection, id) {
  try {
    const result = await collection.doc(id).get();
    // CloudBase doc(id).get() 返回 { data: <object> }，非数组
    if (result.data) {
      // 兼容处理：如果是数组取第一个，如果是对象直接返回
      if (Array.isArray(result.data)) {
        return result.data.length > 0 ? result.data[0] : null;
      }
      return result.data;
    }
    return null;
  } catch (err) {
    if (err.message && err.message.includes('not exist')) {
      return null;
    }
    throw err;
  }
};

/**
 * 软删除：标记 isDeleted 为 true
 * @param {Object} collection - 数据库集合引用
 * @param {string} id - 记录 ID
 * @returns {Promise<Object>} 更新结果
 */
exports.softDelete = async function (collection, id) {
  return await collection.doc(id).update({
    isDeleted: true,
    updateTime: new Date(),
  });
};

/**
 * 构建日期范围查询条件
 * @param {string} field - 日期字段名
 * @param {string} startDate - 开始日期 YYYY-MM-DD
 * @param {string} endDate - 结束日期 YYYY-MM-DD
 * @param {Object} _ - db.command 对象
 * @returns {Object} 查询条件
 */
exports.dateRangeQuery = function (field, startDate, endDate, _) {
  if (!startDate && !endDate) return {};

  const conditions = [];
  if (startDate) {
    conditions.push(_.gte(new Date(startDate + 'T00:00:00.000Z')));
  }
  if (endDate) {
    conditions.push(_.lte(new Date(endDate + 'T23:59:59.999Z')));
  }

  if (conditions.length === 1) {
    return { [field]: conditions[0] };
  }

  return { [field]: _.and(conditions) };
};
