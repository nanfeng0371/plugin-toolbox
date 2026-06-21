/**
 * test-api7.js - 深入排查 500 错误
 * 
 * 之前的发现：
 *   - 不带 authorization-app → 401
 *   - 带 authorization-app → 500 (系统异常)
 * 
 * 500 可能的原因：
 *   1. Cookie 在 Node.js fetch 中被忽略了（某些环境不允许手动设置Cookie）
 *   2. 服务端能识别身份但token解析出错
 *   3. 还需要其他必需的Header
 * 
 * 策略：用 https 模块（完全手动控制），逐个排查
 */

const https = require('https');

const TOKEN = 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImNlcnQteXVhaXdlaXd1IiwidHlwIjoiSldUIn0.eyJvd25lciI6Inl1YWl3ZWl3dSIsIm5hbWUiOiJ3YW5neWFydSIsImlkIjoiM0ZQa3ZHTWZhT2cyZ0tPeUV3OVg0Z2lFaUUiLCJkaXNwbGF5TmFtZSI6IueOi-S6muiMuSIsImF2YXRhciI6Imh0dHBzOi8vc3RhdGljLWxlZ2FjeS5kaW5ndGFsay5jb20vbWVkaWEvbEFEUERoWUJQYWlJRHNUTkFfbk5BX2tfMTAxN18xMDE3LmpwZyIsImVtYWlsIjoid2FuZ3lhcnVAeXVhaXdlaXd1LmNvbSIsInBob25lIjoiMTM5Mzg2MDU1ODEiLCJ0b2tlblR5cGUiOiJhY2Nlc3MtdG9rZW4iLCJzY29wZSI6InJlYWQiLCJpc3MiOiJodHRwczovL2Nhcy55dWFpd2Vpd3UuY29tIiwic3ViIjoiM0ZQa3ZHTWZhT2cyZ0tPeUV3OVg0Z2lFaUUiLCJhdWQiOlsiYjk1OWQzMmRmZmVhMzg3ZDQyNTMiXSwiZXhwIjoxNzc5Njg5MDE5LCJuYmYiOjE3Nzk2MDI2MTksImlhdCI6MTc3OTYwMjYxOSwianRpIjoiYWRtaW4vZTZmMTZjMDctODFhOC00MTc0LWEyNjctYjNkZmFkMTUzYjdlIn0.u_I63whklRjrZhVirgclNa7VNxtDI_g2MBR7AEIz-Ln9Y-RVEOkoKi2qCDSymQ0c_UN1WPxifDhxf9Yw2XXxIuUiokwRx7vqjwnwnyqSs3S7Qi5f9hMoPgKQ4PC70ceqHqcRdcrC9zTuQLRApxUbSyky3qkt7_N2i7A3m5e93hn6FnLE80JGFztSoeqniFRmtMYzskeQq_jLneXet0VjS4W5pIeCKRgwSdDFjIYm8gRre6zP0kun6gAmptZni5Ki1nb-yt162P5WfDDOv0CrflZVV-ODUBUuei18PmffSYooWXlbdqwrrns_E6lmnUJOXDEmge4PO0A6Eva8nDNBieHrF0dHVAHU7EFLHIbeRluh8QQZW7hykAmyI7i4Gf7z4GEje7j5ca7cz-jS57_8AbphP8YnDhJmRzi6h5xNTWetHAwCRKGqcg9LZ9eWb8OMiokGkeSw3Akzv01XJRNtG8lsitYTYcnHApNreRxz2uiyzPV60JZYTeFSUB69a7SARhPGQdkcHHso11bweRZQ4AQp72BHeYOtpkEtYVHHALUUIFQr1haLC0UeEH69WKWu6sp-G9V4wmpjCQMR7kGbMgwTvUC7K_bk6qhcc70LqZam6xHwTnvbLECQWq3glo2i5whPuqj1dF0_YzIGHq5grHpcJh1zyOCZNLFSZ9ut38w';

const DATAFLUX_S = 'rum=2&id=8a71842c-d992-475e-bc3f-38424a153a3d&created=1779621306476&expire=1779630293724';

function makeRequest(path, headers) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'ai-genesis.yuaiweiwu.com',
      path: path,
      method: 'GET',
      headers: headers,
      timeout: 10000
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: data });
      });
    });
    
    req.on('error', (e) => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function runTests() {
  const API_PATH = '/prod-api/student-center-ai/student/name/1785469369923121154';
  
  // 测试1: 完全模拟浏览器请求（https模块，Cookie方式）
  console.log("=== 测试1: https模块 - 完整Cookie（模拟浏览器）===\n");
  try {
    const cookieStr = [
      `authorization-app=aiXin`,
      `authorization-token=${TOKEN}`,
      `sidebarStatus=1`,
      `_dataflux_s=${DATAFLUX_S}`,
      `_dataflux_user_id=0f6ebedf3-608f-4706-aaf3-fa1c8e8e6b43`,
      `_itrace_wid=8a0a33db-2ba9-40bd-b00b-e8c8c8d7e3c3`
    ].join('; ');
    
    const res = await makeRequest(API_PATH, {
      'Accept': 'application/json, text/plain, */*',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Connection': 'keep-alive',
      'Cookie': cookieStr,
      'Host': 'ai-genesis.yuaiweiwu.com',
      'Referer': 'https://ai-genesis.yuaiweiwu.com/',
      'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    });
    
    console.log(`状态码: ${res.status}`);
    console.log(`响应头 Content-Type: ${res.headers['content-type']}`);
    // 如果是gzip，先解压
    let body = res.body;
    if (res.headers['content-encoding'] === 'gzip') {
      const zlib = require('zlib');
      body = zlib.gunzipSync(Buffer.from(res.body, 'binary')).toString();
    }
    console.log(`响应: ${body.substring(0, 500)}`);
    
    if (res.status === 200) {
      console.log("\n✅✅✅ 完全模拟浏览器方案成功！！！");
    }
  } catch (err) {
    console.error("错误:", err.message);
  }
  
  // 测试2: Cookie + authorization-token 也作为 Header
  console.log("\n=== 测试2: https模块 - Cookie + authorization-token Header 双保险 ===\n");
  try {
    const res = await makeRequest(API_PATH, {
      'Accept': 'application/json, text/plain, */*',
      'Cookie': `authorization-app=aiXin; authorization-token=${TOKEN}`,
      'authorization-token': TOKEN,
      'authorization-app': 'aiXin',
      'Host': 'ai-genesis.yuaiweiwu.com',
      'Referer': 'https://ai-genesis.yuaiweiwu.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    });
    
    let body = res.body;
    if (res.headers['content-encoding'] === 'gzip') {
      const zlib = require('zlib');
      body = zlib.gunzipSync(Buffer.from(res.body, 'binary')).toString();
    }
    console.log(`状态码: ${res.status}`);
    console.log(`响应: ${body.substring(0, 500)}`);
    
    if (res.status === 200) {
      console.log("\n✅ 双保险方案成功！");
    }
  } catch (err) {
    console.error("错误:", err.message);
  }

  // 测试3: 先测试一个不需要登录的API端点，看看网关是否正常
  console.log("\n=== 测试3: 测试网关根路径 ===\n");
  try {
    const res = await makeRequest('/', {
      'Host': 'ai-genesis.yuaiweiwu.com',
      'User-Agent': 'Mozilla/5.0'
    });
    
    console.log(`状态码: ${res.status}`);
    console.log(`响应: ${res.body.substring(0, 200)}`);
  } catch (err) {
    console.error("错误:", err.message);
  }
  
  // 测试4: prod-api 根路径
  console.log("\n=== 测试4: prod-api 根路径 ===\n");
  try {
    const res = await makeRequest('/prod-api/', {
      'Host': 'ai-genesis.yuaiweiwu.com',
      'User-Agent': 'Mozilla/5.0'
    });
    
    console.log(`状态码: ${res.status}`);
    console.log(`响应: ${res.body.substring(0, 200)}`);
  } catch (err) {
    console.error("错误:", err.message);
  }

  // 测试5: 只带 authorization-app Cookie，不带 token（验证 app 是否单独起作用）
  console.log("\n=== 测试5: 只带 authorization-app，不带 token ===\n");
  try {
    const res = await makeRequest(API_PATH, {
      'Accept': 'application/json',
      'Cookie': `authorization-app=aiXin`,
      'Host': 'ai-genesis.yuaiweiwu.com',
      'Referer': 'https://ai-genesis.yuaiweiwu.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    });
    
    let body = res.body;
    if (res.headers['content-encoding'] === 'gzip') {
      const zlib = require('zlib');
      body = zlib.gunzipSync(Buffer.from(res.body, 'binary')).toString();
    }
    console.log(`状态码: ${res.status}`);
    console.log(`响应: ${body.substring(0, 300)}`);
  } catch (err) {
    console.error("错误:", err.message);
  }
}

runTests();
