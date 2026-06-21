/**
 * test-api9.js - 验证改约 API 的完整流程
 * 
 * ✅ 已确认：Cookie: authorization-app=aiXin; authorization-token=xxx 可以认证通过
 * 
 * 现在测试：
 *   1. 学员查询 API（换正确的 userId）
 *   2. 课表列表 API（带正确参数）
 *   3. 课堂数据 API
 *   4. 改约提交 API（POST，最重要）
 */

const https = require('https');
const zlib = require('zlib');

const TOKEN = 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImNlcnQteXVhaXdlaXd1IiwidHlwIjoiSldUIn0.eyJvd25lciI6Inl1YWl3ZWl3dSIsIm5hbWUiOiJ3YW5neWFydSIsImlkIjoiM0ZQa3ZHTWZhT2cyZ0tPeUV3OVg0Z2lFaUUiLCJkaXNwbGF5TmFtZSI6IueOi-S6muiMuSIsImF2YXRhciI6Imh0dHBzOi8vc3RhdGljLWxlZ2FjeS5kaW5ndGFsay5jb20vbWVkaWEvbEFEUERoWUJQYWlJRHNUTkFfbk5BX2tfMTAxN18xMDE3LmpwZyIsImVtYWlsIjoid2FuZ3lhcnVAeXVhaXdlaXd1LmNvbSIsInBob25lIjoiMTM5Mzg2MDU1ODEiLCJ0b2tlblR5cGUiOiJhY2Nlc3MtdG9rZW4iLCJzY29wZSI6InJlYWQiLCJpc3MiOiJodHRwczovL2Nhcy55dWFpd2Vpd3UuY29tIiwic3ViIjoiM0ZQa3ZHTWZhT2cyZ0tPeUV3OVg0Z2lFaUUiLCJhdWQiOlsiYjk1OWQzMmRmZmVhMzg3ZDQyNTMiXSwiZXhwIjoxNzc5Njg5MDE5LCJuYmYiOjE3Nzk2MDI2MTksImlhdCI6MTc3OTYwMjYxOSwianRpIjoiYWRtaW4vZTZmMTZjMDctODFhOC00MTc0LWEyNjctYjNkZmFkMTUzYjdlIn0.u_I63whklRjrZhVirgclNa7VNxtDI_g2MBR7AEIz-Ln9Y-RVEOkoKi2qCDSymQ0c_UN1WPxifDhxf9Yw2XXxIuUiokwRx7vqjwnwnyqSs3S7Qi5f9hMoPgKQ4PC70ceqHqcRdcrC9zTuQLRApxUbSyky3qkt7_N2i7A3m5e93hn6FnLE80JGFztSoeqniFRmtMYzskeQq_jLneXet0VjS4W5pIeCKRgwSdDFjIYm8gRre6zP0kun6gAmptZni5Ki1nb-yt162P5WfDDOv0CrflZVV-ODUBUuei18PmffSYooWXlbdqwrrns_E6lmnUJOXDEmge4PO0A6Eva8nDNBieHrF0dHVAHU7EFLHIbeRluh8QQZW7hykAmyI7i4Gf7z4GEje7j5ca7cz-jS57_8AbphP8YnDhJmRzi6h5xNTWetHAwCRKGqcg9LZ9eWb8OMiokGkeSw3Akzv01XJRNtG8lsitYTYcnHApNreRxz2uiyzPV60JZYTeFSUB69a7SARhPGQdkcHHso11bweRZQ4AQp72BHeYOtpkEtYVHHALUUIFQr1haLC0UeEH69WKWu6sp-G9V4wmpjCQMR7kGbMgwTvUC7K_bk6qhcc70LqZam6xHwTnvbLECQWq3glo2i5whPuqj1dF0_YzIGHq5grHpcJh1zyOCZNLFSZ9ut38w';

const COOKIE = `authorization-app=aiXin; authorization-token=${TOKEN}`;

const COMMON_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Connection': 'keep-alive',
  'Cookie': COOKIE,
  'Host': 'ai-genesis.yuaiweiwu.com',
  'Referer': 'https://ai-genesis.yuaiweiwu.com/',
  'Origin': 'https://ai-genesis.yuaiweiwu.com',
  'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
};

function makeRequest(path, headers, method = 'GET', body = null) {
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
        const encoding = res.headers['content-encoding'];
        try {
          if (encoding === 'gzip') {
            body = zlib.gunzipSync(buffer).toString();
          } else if (encoding === 'br') {
            body = zlib.brotliDecompressSync(buffer).toString();
          } else if (encoding === 'deflate') {
            body = zlib.inflateSync(buffer).toString();
          } else {
            body = buffer.toString();
          }
        } catch (e) {
          body = buffer.toString('utf8');
        }
        resolve({ status: res.statusCode, headers: res.headers, body: body });
      });
    });
    
    req.on('error', (e) => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

async function runTests() {
  console.log("🚀 完整 API 流程验证 - test-api9.js\n");
  console.log("认证方式: Cookie: authorization-app=aiXin; authorization-token=xxx\n");
  console.log("=".repeat(60));
  
  // 测试1: 学员查询 - 从JWT里提取userId
  console.log("\n=== 测试1: 用 JWT 中的 sub 作为 userId 查询 ===\n");
  // JWT payload: sub = "3FPkvGMfaOg2gKOyEw9X4giEiE"
  const userId = "3FPkvGMfaOg2gKOyEw9X4giEiE";
  try {
    const res = await makeRequest(
      `/prod-api/student-center-ai/student/name/${userId}`,
      COMMON_HEADERS
    );
    console.log(`状态码: ${res.status}`);
    console.log(`响应: ${res.body.substring(0, 500)}`);
    if (res.status === 200) {
      console.log("\n✅ 学员查询成功！");
    }
  } catch (err) {
    console.error("错误:", err.message);
  }
  
  // 测试2: 用之前Chrome扩展用过的学员ID
  console.log("\n=== 测试2: 用之前已知的学员ID ===\n");
  // Chrome扩展中用的学员ID: 1785469369923121154
  try {
    const res = await makeRequest(
      '/prod-api/student-center-ai/student/name/1785469369923121154',
      COMMON_HEADERS
    );
    console.log(`状态码: ${res.status}`);
    console.log(`响应: ${res.body.substring(0, 500)}`);
  } catch (err) {
    console.error("错误:", err.message);
  }
  
  // 测试3: 课表列表 API - 带正确的查询参数
  console.log("\n=== 测试3: 课表列表 API ===\n");
  try {
    const res = await makeRequest(
      '/prod-api/student-center-ai/regularCourse/next/class/list?classStatus=0&startDate=2026-05-24&endDate=2026-06-30',
      COMMON_HEADERS
    );
    console.log(`状态码: ${res.status}`);
    const bodyLen = res.body.length;
    console.log(`响应长度: ${bodyLen} 字符`);
    
    // 尝试解析JSON
    try {
      const data = JSON.parse(res.body);
      console.log(`code: ${data.code}`);
      console.log(`mesg: ${data.mesg || '无'}`);
      if (data.data) {
        const dataType = Array.isArray(data.data) ? `数组(${data.data.length}项)` : typeof data.data;
        console.log(`data类型: ${dataType}`);
        if (typeof data.data === 'object' && !Array.isArray(data.data)) {
          console.log(`data字段: ${Object.keys(data.data).join(', ')}`);
        }
      } else if (data.rows) {
        console.log(`rows类型: ${Array.isArray(data.rows) ? `数组(${data.rows.length}项)` : typeof data.rows}`);
      }
      console.log(`完整响应(前500): ${res.body.substring(0, 500)}`);
    } catch (e) {
      console.log(`非JSON响应: ${res.body.substring(0, 300)}`);
    }
  } catch (err) {
    console.error("错误:", err.message);
  }

  // 测试4: 尝试获取用户信息接口
  console.log("\n=== 测试4: 获取当前用户信息 ===\n");
  try {
    // 常见后台用户信息接口
    const endpoints = [
      '/prod-api/system/user/getInfo',
      '/prod-api/getInfo',
      '/prod-api/user/info',
    ];
    for (const ep of endpoints) {
      const res = await makeRequest(ep, COMMON_HEADERS);
      console.log(`${ep} → ${res.status}: ${res.body.substring(0, 200)}`);
    }
  } catch (err) {
    console.error("错误:", err.message);
  }
}

runTests();
