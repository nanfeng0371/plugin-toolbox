/**
 * 调课历史日志服务
 * list(查询历史记录) / search(按关键词搜索)
 */

/**
 * 查询历史调课记录（按日期分组）
 * @param {Object} data - { page?, pageSize?, startDate?, endDate? }
 */
exports.list = async function (data, currentUser, ctx) {
  const { db, dbHelper, response } = ctx;

  try {
    const query = { userId: currentUser._id };

    // 日期范围过滤
    if (data.startDate || data.endDate) {
      const _ = ctx._;
      const conditions = [];
      if (data.startDate) {
        conditions.push(_.gte(new Date(data.startDate + 'T00:00:00.000Z')));
      }
      if (data.endDate) {
        conditions.push(_.lte(new Date(data.endDate + 'T23:59:59.999Z')));
      }
      if (conditions.length === 1) {
        query.createdAt = conditions[0];
      } else {
        query.createdAt = _.and(conditions);
      }
    }

    const result = await dbHelper.paginateQuery(
      db.collection('tk_logs'),
      query,
      {
        page: data.page || 1,
        pageSize: Math.min(data.pageSize || 20, 100),
        orderBy: [['createdAt', 'desc']],
      }
    );

    // 按日期分组
    const grouped = {};
    for (const log of result.list) {
      const date = log.createdAt
        ? new Date(log.createdAt).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
        : '未知日期';
      if (!grouped[date]) grouped[date] = [];
      grouped[date].push(log);
    }

    return response.success({
      list: result.list,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      grouped: grouped,
    });
  } catch (err) {
    console.error('[TK-Log] List error:', err);
    return response.error(500, '获取调课记录失败');
  }
};

/**
 * 按关键词搜索历史记录
 * @param {Object} data - { keyword, page?, pageSize? }
 */
exports.search = async function (data, currentUser, ctx) {
  const { db, dbHelper, response } = ctx;

  if (!data.keyword) {
    return response.badRequest('请提供搜索关键词');
  }

  try {
    const keyword = data.keyword.trim();

    // 在 studentName 和 studentId 中搜索
    const result = await dbHelper.paginateQuery(
      db.collection('tk_logs'),
      {
        userId: currentUser._id,
        studentName: db.RegExp({
          regexp: keyword,
          options: 'i',
        }),
      },
      {
        page: data.page || 1,
        pageSize: Math.min(data.pageSize || 20, 100),
        orderBy: [['createdAt', 'desc']],
      }
    );

    return response.success(result);
  } catch (err) {
    console.error('[TK-Log] Search error:', err);
    return response.error(500, '搜索调课记录失败');
  }
};
