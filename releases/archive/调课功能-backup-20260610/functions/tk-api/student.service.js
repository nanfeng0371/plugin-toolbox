/**
 * 学员信息簿（学情表）服务
 * import(导入学情表) / list(查看) / clear(清空) / match(姓名匹配学员ID)
 * 数据存储于 tk_students 集合，按 ownerId 用户隔离
 */

/**
 * 导入学情表（前端已解析为数组，直接批量写入）
 * @param {Object} data - { students: [{ name, studentId, phone? }] }
 */
exports.import = async function (data, currentUser, ctx) {
  const { db, dbHelper, response } = ctx;

  if (!data.students || !Array.isArray(data.students) || data.students.length === 0) {
    return response.badRequest('学情表数据为空');
  }

  // 最多 2000 条
  if (data.students.length > 2000) {
    return response.badRequest('学情表数据不能超过 2000 条');
  }

  try {
    // 先删除该用户的旧数据
    const oldData = await db.collection('tk_students').where({
      ownerId: currentUser._id,
    }).get();

    if (oldData.data && oldData.data.length > 0) {
      // 批量删除
      for (const record of oldData.data) {
        await db.collection('tk_students').doc(record._id).remove();
      }
    }

    // 批量插入新数据
    const now = new Date();
    const insertData = data.students.map(s => ({
      ownerId: currentUser._id,
      name: (s.name || '').trim(),
      studentId: String(s.studentId || '').trim(),
      phone: (s.phone || '').trim(),
      createdAt: now,
    })).filter(s => s.name && s.studentId);

    const result = await dbHelper.batchInsert(db.collection('tk_students'), insertData, 20);

    return response.success({
      total: insertData.length,
      success: result.success,
      failed: result.failed,
    }, `学情表导入完成：${result.success} 条成功`);
  } catch (err) {
    console.error('[TK-Student] Import error:', err);
    return response.error(500, '学情表导入失败');
  }
};

/**
 * 查看学情表（分页）
 */
exports.list = async function (data, currentUser, ctx) {
  const { db, dbHelper, response } = ctx;

  try {
    const result = await dbHelper.paginateQuery(
      db.collection('tk_students'),
      { ownerId: currentUser._id },
      {
        page: data.page || 1,
        pageSize: Math.min(data.pageSize || 50, 100),
        orderBy: [['name', 'asc']],
      }
    );

    return response.success(result);
  } catch (err) {
    console.error('[TK-Student] List error:', err);
    return response.error(500, '获取学情表失败');
  }
};

/**
 * 清空学情表
 */
exports.clear = async function (data, currentUser, ctx) {
  const { db, response } = ctx;

  try {
    const oldData = await db.collection('tk_students').where({
      ownerId: currentUser._id,
    }).get();

    let deleted = 0;
    if (oldData.data && oldData.data.length > 0) {
      for (const record of oldData.data) {
        await db.collection('tk_students').doc(record._id).remove();
        deleted++;
      }
    }

    return response.success({ deleted }, `已清空学情表（${deleted} 条）`);
  } catch (err) {
    console.error('[TK-Student] Clear error:', err);
    return response.error(500, '清空学情表失败');
  }
};

/**
 * 按姓名匹配学员 ID
 * @param {Object} data - { name: '王一', phone?: '1390' }
 * @returns {Object} 匹配结果
 */
exports.match = async function (data, currentUser, ctx) {
  const { db, response } = ctx;

  if (!data.name) {
    return response.badRequest('请提供学员姓名');
  }

  try {
    const name = data.name.trim();

    // 1. 精确姓名匹配
    const exactResult = await db.collection('tk_students').where({
      ownerId: currentUser._id,
      name: name,
    }).get();

    if (!exactResult.data || exactResult.data.length === 0) {
      // 2. 模糊匹配（名字包含关系）
      const fuzzyResult = await db.collection('tk_students').where({
        ownerId: currentUser._id,
        name: db.RegExp({
          regexp: name,
          options: 'i',
        }),
      }).get();

      if (!fuzzyResult.data || fuzzyResult.data.length === 0) {
        return response.success({
          matched: false,
          reason: `未在学情表中找到"${name}"`,
        });
      }

      // 多个模糊匹配结果，返回候选
      return response.success({
        matched: false,
        reason: '未精确匹配，找到相似姓名',
        candidates: fuzzyResult.data.map(s => ({
          name: s.name,
          studentId: s.studentId,
          phone: s.phone || '',
        })),
      });
    }

    if (exactResult.data.length === 1) {
      // 唯一精确匹配
      const student = exactResult.data[0];
      return response.success({
        matched: true,
        name: student.name,
        studentId: student.studentId,
      });
    }

    // 重名：多个精确匹配
    // 如果提供了手机号后4位，进一步过滤
    if (data.phone) {
      const phoneSuffix = data.phone.trim();
      const phoneMatch = exactResult.data.filter(s =>
        s.phone && s.phone.endsWith(phoneSuffix)
      );
      if (phoneMatch.length === 1) {
        return response.success({
          matched: true,
          name: phoneMatch[0].name,
          studentId: phoneMatch[0].studentId,
        });
      }
    }

    // 返回重名列表，提示补充手机号
    return response.success({
      matched: false,
      reason: `存在${exactResult.data.length}位同名学员"${name}"，请补充手机号后4位`,
      duplicates: exactResult.data.map(s => ({
        name: s.name,
        studentId: s.studentId,
        phoneLast4: s.phone ? s.phone.slice(-4) : '',
      })),
    });
  } catch (err) {
    console.error('[TK-Student] Match error:', err);
    return response.error(500, '学员匹配失败');
  }
};

/**
 * 获取学情表统计信息
 */
exports.stats = async function (data, currentUser, ctx) {
  const { db, response } = ctx;

  try {
    const countResult = await db.collection('tk_students').where({
      ownerId: currentUser._id,
    }).count();

    return response.success({
      total: countResult.total || 0,
    });
  } catch (err) {
    console.error('[TK-Student] Stats error:', err);
    return response.error(500, '获取学情表统计失败');
  }
};
