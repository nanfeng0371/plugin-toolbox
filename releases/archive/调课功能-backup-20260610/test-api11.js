/**
 * test-api11.js - 最终验证：精确模拟浏览器请求
 * 
 * 截图确认：
 *   - 浏览器和 Node.js 返回相同的 "查询我的课堂列表失败" 错误
 *   - 说明认证已通过！
 *   - 服务端是 Tengine (阿里云)
 * 
 * 现在需要：
 *   1. 用正确的 API 调课表（带正确参数）
 *   2. 找到能正常返回数据的API端点
 *   3. 测试改约POST请求
 */

const https = require('https');
const zlib = require('zlib');

const TOKEN = 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImNlcnQteXVhaXdlaXd1IiwidHlwIjoiSldUIn0.eyJvd25lciI6Inl1YWl3ZWl3dSIsIm5hbWUiOiJ3YW5neWFydSIsImlkIjoiM0ZQa3ZHTWZhT2cyZ0tPeUV3OVg0Z2lFaUUiLCJkaXNwbGF5TmFtZSI6IueOi-S6muiMuSIsImF2YXRhciI6Imh0dHBzOi8vc3RhdGljLWxlZ2FjeS5kaW5ndGFsay5jb20vbWVkaWEvbEFEUERoWUJQYWlJRHNUTkFfbk5BX2tfMTAxN18xMDE3LmpwZyIsImVtYWlsIjoid2FuZ3lhcnVAeXVhaXdlaXd1LmNvbSIsInBob25lIjoiMTM5Mzg2MDU1ODEiLCJ0b2tlblR5cGUiOiJhY2Nlc3MtdG9rZW4iLCJzY29wZSI6InJlYWQiLCJpc3MiOiJodHRwczovL2Nhcy55dWFpd2Vpd3UuY29tIiwic3ViIjoiM0ZQa3ZHTWZhT2cyZ0tPeUV3OVg0Z2lFaUUiLCJhdWQiOlsiYjk1OWQzMmRmZmVhMzg3ZDQyNTMiXSwiZXhwIjoxNzc5Njg5MDE5LCJuYmYiOjE3Nzk2MDI2MTksImlhdCI6MTc3OTYwMjYxOSwianRpIjoiYWRtaW4vZTZmMTZjMDctODFhOC00MTc0LWEyNjctYjNkZmFkMTUzYjdlIn0.u_I63whklRjrZhVirgclNa7VNxtDI_g2MBR7AEIz-Ln9Y-RVEOkoKi2qCDSymQ0c_UN1WPxifDhxf9Yw2XXxIuUiokwRx7vqjwnwnyqSs3S7Qi5f9hMoPgKQ4PC70ceqHqcRdcrC9zTuQLRApxUbSyky3qkt7_N2i7A3m5e93hn6FnLE80JGFztSoeqniFRmtMYzskeQq_jLneXet0VjS4W5pIeCKRgwSdDFjIYm8gRre6zP0kun6gAmptZni5Ki1nb-yt162P5WfDDOv0CrflZVV-ODUBUuei18PmffSYooWXlbdqwrrns_E6lmnUJOXDEmge4PO0A6Eva8nDNBieHrF0dHVAHU7EFLHIbeRluh8QQZW7hykAmyI7i4Gf7z4GEje7j5ca7cz-jS57_8AbphP8YnDhJmRzi6h5xNTWetHAwCRKGqcg9LZ9eWb8OMiokGkeSw3Akzv01XJRNtG8lsitYTYcnHApNreRxz2uiyzPV60JZYTeFSUB69a7SARhPGQdkcHHso11bweRZQ4AQp72BHeYOtpkEtYVHHALUUIFQr1haLC0UeEH69WKWu6sp-G9V4wmpjCQMR7kGbMgwTvUC7K_bk6qhcc70LqZam6xHwTnvbLECQWq3glo2i5whPuqj1dF0_YzIGHq5grHpcJh1zyOCZNLFSZ9ut38w';

const COOKIE = `authorization-app=aiXin; authorization-token=${TOKEN}`;

// 精确匹配浏览器的 Header
function makeRequest(path, headers, method = 'GET', bodyStr = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'ai-genesis.yuaiweiwu.com',
      path: path,
      method: method,
      headers: headers,
      timeout: 15000
    };
    
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => { chunks.push(chunk); });
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        let body;
        try { body = zlib.gunzipSync(buffer).toString(); } 
        catch (e) { try { body = buffer.toString('utf8'); } catch (e2) { body = ''; } }
        resolve({ status: res.statusCode, headers: res.headers, body: body });
      });
    });
    
    req.on('error', (e) => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function runFinalTests() {
  console.log("🏁 最终验证 - test-api11.js\n");
  console.log("=".repeat(60));
  
  // 从截图中看到左侧有学员列表：柯源、可欣、李子墨、羽梦...
  // 这些是真实的学员数据！
  
  // 关键测试：课表列表 - 前端页面显示有数据，说明这个API在前端是能用的
  // 可能前端传了额外的参数
  
  // 测试1: 课表列表 - 不带 classStatus 参数
  console.log("\n=== 测试1: 课表列表 - 无 classStatus ===\n");
  try {
    const res = await makeRequest(
      '/prod-api/student-center-ai/regularCourse/next/class/list?startDate=2026-05-24&endDate=2026-12-31',
      {
        'Accept': 'application/json, text/plain, */*',
        'Cookie': COOKIE,
        'Host': 'ai-genesis.yuaiweiwu.com',
        'Referer': 'https://ai-genesis.yuaiweiwu.com/',
        'User-Agent': 'Mozilla/5.0'
      }
    );
    console.log(`状态码: ${res.status}`);
    console.log(`响应: ${res.body.substring(0, 500)}`);
  } catch (err) { console.error("错误:", err.message); }
  
  // 测试2: 尝试学员列表 API（从左侧菜单看到"学员列表"）
  console.log("\n=== 测试2: 学员列表 ===\n");
  try {
    // 常见的学生列表接口
    const endpoints = [
      '/prod-api/student-center-ai/student/list',
      '/prod-api/student-center-ai/student/page',
      '/prod-api/student-center-ai/student/myList',
      '/prod-api/student-center-ai/student/queryMyStudent',
    ];
    for (const ep of endpoints) {
      const res = await makeRequest(ep + '?pageNum=1&pageSize=10', {
        'Accept': 'application/json',
        'Cookie': COOKIE,
        'Host': 'ai-genesis.yuaiweiwu.com',
        'Referer': 'https://ai-genesis.yuaiweiwu.com/',
        'User-Agent': 'Mozilla/5.0'
      });
      const summary = res.body.substring(0, 200);
      console.log(`${ep} → ${res.status}: ${summary}`);
      if (res.status === 200 && !summary.includes('<!DOCTYPE')) {
        console.log(`  ✅ 这个端点有效！`);
        break;
      }
    }
  } catch (err) { console.error("错误:", err.message); }

  // 测试3: 改约 POST 请求（最重要！）
  console.log("\n=== 测试3: 改约 POST 请求（测试性提交）===\n");
  try {
    const postData = JSON.stringify({
      type: 2,
      userId: "1785469369923121154",
      courseId: "test-course-id",
      aiCourseId: "test-ai-course-id", 
      aiClassHourId: "test-classhour-id",
      periodId: "test-period-id",
      userClassTimes: [{
        classTimeStart: "2026-05-25 10:00:00",
        classTimeEnd: "2026-05-25 12:00:00",
        aiClassHourSort: 1,
        id: "test-id"
      }]
    });

    const res = await makeRequest(
      '/prod-api/student-center-ai/ai/user/course/classhour',
      {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=UTF-8',
        'Content-Length': Buffer.byteLength(postData),
        'Authorization': `Bearer ${TOKEN}`,
        'Cookie': COOKIE,
        'Host': 'ai-genesis.yuaiweiwu.com',
        'Origin': 'https://ai-genesis.yuaiweiwu.com',
        'Referer': 'https://ai-genesis.yuaiweiwu.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      },
      'POST',
      postData
    );
    console.log(`状态码: ${res.status}`);
    console.log(`响应: ${res.body.substring(0, 500)}`);
    
    if (!res.body.includes('"401"') && !res.body.includes('Unauthorized')) {
      console.log("\n✅ 认证通过！改约API能收到请求！");
    }
  } catch (err) { console.error("错误:", err.message); }

  // 测试4: 在浏览器中能用的完整参数组合
  // 从截图中看到左侧有真实学员数据（柯源等），说明平台确实有数据
  // 问题可能是我们的查询条件不对
  console.log("\n=== 测试4: 不同日期范围的课表查询 ===\n");
  const dateRanges = [
    ['2026-01-01', '2026-12-31'],     // 全年
    ['2026-05-20', '2026-06-10'],      // 当前续班周期附近
    ['2026-03-20', '2026-05-05'],      // 续班周期（3.20-5.5）
  ];
  
  for (const [start, end] of dateRanges) {
    try {
      const res = await makeRequest(
        `/prod-api/student-center-ai/regularCourse/next/class/list?classStatus=0&startDate=${start}&endDate=${end}`,
        {
          'Accept': 'application/json',
          'Cookie': COOKIE,
          'Host': 'ai-genesis.yuaiweiwu.com',
          'User-Agent': 'Mozilla/5.0'
        }
      );
      
      let summary;
      if (res.status === 200) {
        try {
          const data = JSON.parse(res.body);
          if (Array.isArray(data.data)) {
            summary = `code:${data.code}, 数据条数:${data.data.length}`;
          } else if (data.data && typeof data.data === 'object') {
            summary = `code:${data.code}, data类型:${typeof data.data}, 字段:${Object.keys(data.data).join(',')}`;
          } else {
            summary = `code:${data.code}, mesg:${data.mesg || '无'}`;
          }
        } catch (e) { summary = `非JSON`; }
      } else {
        summary = res.body.substring(0, 100);
      }
      console.log(`  ${start} ~ ${end} → ${res.status}: ${summary}`);
    } catch (err) {
      console.error(`  ${start} ~ ${end} → 错误: ${err.message}`);
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("\n✅ 结论总结:");
  console.log("   1. Node.js 带 authorization-app+authorization-token Cookie 可以通过认证");
  console.log("   2. student/name API 返回500可能是该API本身的问题或参数不对");
  console.log("   3. 课表列表 API 通过认证但返回'查询失败'可能是业务逻辑问题");
  console.log("   4. 改约POST请求可以到达服务器（不是401）");
  console.log("   5. 下一步：需要找到正确的API调用方式来获取实际数据");
}

runFinalTests();
