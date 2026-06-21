/**
 * test-api8.js - 排查 500 错误：检查 Cookie 编码 + 尝试不同API端点
 * 
 * 关键发现：
 *   - 带 authorization-app + authorization-token → 500（系统异常）
 *   - 只带 authorization-app → 401
 *   - 只带 authorization-token → 401  
 *   - 不带任何认证 → 401
 * 
 * 500 可能原因：
 *   1. Cookie 中的 token 被 Node.js 编码/截断了
 *   2. 服务端能解析 token 但某个字段导致内部错误
 *   3. 尝试其他更简单的 API 端点
 */

const https = require('https');
const zlib = require('zlib');

const TOKEN = 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImNlcnQteXVhaXdlaXd1IiwidHlwIjoiSldUIn0.eyJvd25lciI6Inl1YWl3ZWl3dSIsIm5hbWUiOiJ3YW5neWFydSIsImlkIjoiM0ZQa3ZHTWZhT2cyZ0tPeUV3OVg0Z2lFaUUiLCJkaXNwbGF5TmFtZSI6IueOi-S6muiMuSIsImF2YXRhciI6Imh0dHBzOi8vc3RhdGljLWxlZ2FjeS5kaW5ndGFsay5jb20vbWVkaWEvbEFEUERoWUJQYWlJRHNUTkFfbk5BX2tfMTAxN18xMDE3LmpwZyIsImVtYWlsIjoid2FuZ3lhcnVAeXVhaXdlaXd1LmNvbSIsInBob25lIjoiMTM5Mzg2MDU1ODEiLCJ0b2tlblR5cGUiOiJhY2Nlc3MtdG9rZW4iLCJzY29wZSI6InJlYWQiLCJpc3MiOiJodHRwczovL2Nhcy55dWFpd2Vpd3UuY29tIiwic3ViIjoiM0ZQa3ZHTWZhT2cyZ0tPeUV3OVg0Z2lFaUUiLCJhdWQiOlsiYjk1OWQzMmRmZmVhMzg3ZDQyNTMiXSwiZXhwIjoxNzc5Njg5MDE5LCJuYmYiOjE3Nzk2MDI2MTksImlhdCI6MTc3OTYwMjYxOSwianRpIjoiYWRtaW4vZTZmMTZjMDctODFhOC00MTc0LWEyNjctYjNkZmFkMTUzYjdlIn0.u_I63whklRjrZhVirgclNa7VNxtDI_g2MBR7AEIz-Ln9Y-RVEOkoKi2qCDSymQ0c_UN1WPxifDhxf9Yw2XXxIuUiokwRx7vqjwnwnyqSs3S7Qi5f9hMoPgKQ4PC70ceqHqcRdcrC9zTuQLRApxUbSyky3qkt7_N2i7A3m5e93hn6FnLE80JGFztSoeqniFRmtMYzskeQq_jLneXet0VjS4W5pIeCKRgwSdDFjIYm8gRre6zP0kun6gAmptZni5Ki1nb-yt162P5WfDDOv0CrflZVV-ODUBUuei18PmffSYooWXlbdqwrrns_E6lmnUJOXDEmge4PO0A6Eva8nDNBieHrF0dHVAHU7EFLHIbeRluh8QQZW7hykAmyI7i4Gf7z4GEje7j5ca7cz-jS57_8AbphP8YnDhJmRzi6h5xNTWetHAwCRKGqcg9LZ9eWb8OMiokGkeSw3Akzv01XJRNtG8lsitYTYcnHApNreRxz2uiyzPV60JZYTeFSUB69a7SARhPGQdkcHHso11bweRZQ4AQp72BHeYOtpkEtYVHHALUUIFQr1haLC0UeEH69WKWu6sp-G9V4wmpjCQMR7kGbMgwTvUC7K_bk6qhcc70LqZam6xHwTnvbLECQWq3glo2i5whPuqj1dF0_YzIGHq5grHpcJh1zyOCZNLFSZ9ut38w';

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
          } else if (encoding === 'deflate' || encoding === 'br') {
            body = zlib.brotliDecompressSync(buffer).toString();
          } else {
            body = buffer.toString();
          }
        } catch (e) {
          body = buffer.toString('utf8');
        }
        resolve({ 
          status: res.statusCode, 
          headers: res.headers, 
          body: body,
          rawLength: buffer.length
        });
      });
    });
    
    req.on('error', (e) => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

const COMMON_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
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

async function runTests() {
  console.log("🔍 排查 500 错误 - test-api8.js\n");
  console.log("=".repeat(60));
  
  // 测试1: 验证 Cookie 字符串中 token 的完整性
  console.log("\n=== 测试1: 检查 Cookie 字符串 ===\n");
  const cookieStr = `authorization-app=aiXin; authorization-token=${TOKEN}`;
  console.log(`Cookie 字符串总长度: ${cookieStr.length}`);
  console.log(`Token 长度: ${TOKEN.length}`);
  console.log(`Cookie 中 token 部分: ${cookieStr.includes(TOKEN) ? '完整' : '不完整！'}`);
  
  // 测试2: 用完整浏览器级别 Header 调用
  console.log("\n=== 测试2: 完整浏览器 Header + Cookie ===\n");
  try {
    const res = await makeRequest('/prod-api/student-center-ai/student/name/1785469369923121154', {
      ...COMMON_HEADERS,
      'Cookie': cookieStr
    });
    console.log(`状态码: ${res.status}`);
    console.log(`Content-Encoding: ${res.headers['content-encoding'] || 'none'}`);
    console.log(`响应体长度: ${res.body.length}`);
    console.log(`响应: ${res.body.substring(0, 500)}`);
  } catch (err) {
    console.error("错误:", err.message);
  }
  
  // 测试3: 课表列表 API（可能更稳定）
  console.log("\n=== 测试3: 课表列表 API ===\n");
  try {
    const today = new Date().toISOString().split('T')[0];
    const res = await makeRequest(
      `/prod-api/student-center-ai/regularCourse/next/class/list?classStatus=0&startDate=${today}&endDate=2026-12-31`,
      { ...COMMON_HEADERS, 'Cookie': cookieStr }
    );
    console.log(`状态码: ${res.status}`);
    console.log(`响应: ${res.body.substring(0, 300)}`);
    
    if (res.status === 200) {
      console.log("\n✅✅✅ 课表API成功了！说明 student/name 那个API本身有问题！");
    }
  } catch (err) {
    console.error("错误:", err.message);
  }
  
  // 测试4: 换一个简单的学员ID试试（可能1785469369923121154不存在导致500）
  console.log("\n=== 测试4: 换一个简单接口测试认证 ===\n");
  try {
    // 尝试获取用户信息接口（常见的 /user/info 或 /auth/user）
    const res = await makeRequest(
      '/prod-api/system/user/getInfo',
      { ...COMMON_HEADERS, 'Cookie': cookieStr }
    );
    console.log(`状态码: ${res.status}`);
    console.log(`响应: ${res.body.substring(0, 500)}`);
  } catch (err) {
    console.error("错误:", err.message);
  }
  
  // 测试5: 尝试 /prod-api/ 的其他公共端点
  console.log("\n=== 测试5: 测试 /prod-api/system/ 端点 ===\n");
  try {
    const res = await makeRequest(
      '/prod-api/system/user/profile',
      { ...COMMON_HEADERS, 'Cookie': cookieStr }
    );
    console.log(`状态码: ${res.status}`);
    console.log(`响应: ${res.body.substring(0, 500)}`);
  } catch (err) {
    console.error("错误:", err.message);
  }

  // 测试6: 使用 Authorization: Bearer Header + authorization-app Cookie 组合
  console.log("\n=== 测试6: Bearer Header + app Cookie 组合 ===\n");
  try {
    const res = await makeRequest('/prod-api/student-center-ai/student/name/1785469369923121154', {
      ...COMMON_HEADERS,
      'Cookie': 'authorization-app=aiXin',
      'Authorization': `Bearer ${TOKEN}`
    });
    console.log(`状态码: ${res.status}`);
    console.log(`响应: ${res.body.substring(0, 300)}`);
  } catch (err) {
    console.error("错误:", err.message);
  }
}

runTests();
