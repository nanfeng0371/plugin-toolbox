/**
 * test-api10.js - 用浏览器 cURL 对比方式
 * 
 * 核心思路：让用户在浏览器 Network 里 "Copy as cURL" 一个成功的请求，
 * 然后我们用 Node.js 完全复刻这个请求
 * 
 * 同时，我们也试试直接用 puppeteer/playwright 来自动化浏览器
 */

const https = require('https');
const zlib = require('zlib');

const TOKEN = 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImNlcnQteXVhaXdlaXd1IiwidHlwIjoiSldUIn0.eyJvd25lciI6Inl1YWl3ZWl3dSIsIm5hbWUiOiJ3YW5neWFydSIsImlkIjoiM0ZQa3ZHTWZhT2cyZ0tPeUV3OVg0Z2lFaUUiLCJkaXNwbGF5TmFtZSI6IueOi-S6muiMuSIsImF2YXRhciI6Imh0dHBzOi8vc3RhdGljLWxlZ2FjeS5kaW5ndGFsay5jb20vbWVkaWEvbEFEUERoWUJQYWlJRHNUTkFfbk5BX2tfMTAxN18xMDE3LmpwZyIsImVtYWlsIjoid2FuZ3lhcnVAeXVhaXdlaXd1LmNvbSIsInBob25lIjoiMTM5Mzg2MDU1ODEiLCJ0b2tlblR5cGUiOiJhY2Nlc3MtdG9rZW4iLCJzY29wZSI6InJlYWQiLCJpc3MiOiJodHRwczovL2Nhcy55dWFpd2Vpd3UuY29tIiwic3ViIjoiM0ZQa3ZHTWZhT2cyZ0tPeUV3OVg0Z2lFaUUiLCJhdWQiOlsiYjk1OWQzMmRmZmVhMzg3ZDQyNTMiXSwiZXhwIjoxNzc5Njg5MDE5LCJuYmYiOjE3Nzk2MDI2MTksImlhdCI6MTc3OTYwMjYxOSwianRpIjoiYWRtaW4vZTZmMTZjMDctODFhOC00MTc0LWEyNjctYjNkZmFkMTUzYjdlIn0.u_I63whklRjrZhVirgclNa7VNxtDI_g2MBR7AEIz-Ln9Y-RVEOkoKi2qCDSymQ0c_UN1WPxifDhxf9Yw2XXxIuUiokwRx7vqjwnwnyqSs3S7Qi5f9hMoPgKQ4PC70ceqHqcRdcrC9zTuQLRApxUbSyky3qkt7_N2i7A3m5e93hn6FnLE80JGFztSoeqniFRmtMYzskeQq_jLneXet0VjS4W5pIeCKRgwSdDFjIYm8gRre6zP0kun6gAmptZni5Ki1nb-yt162P5WfDDOv0CrflZVV-ODUBUuei18PmffSYooWXlbdqwrrns_E6lmnUJOXDEmge4PO0A6Eva8nDNBieHrF0dHVAHU7EFLHIbeRluh8QQZW7hykAmyI7i4Gf7z4GEje7j5ca7cz-jS57_8AbphP8YnDhJmRzi6h5xNTWetHAwCRKGqcg9LZ9eWb8OMiokGkeSw3Akzv01XJRNtG8lsitYTYcnHApNreRxz2uiyzPV60JZYTeFSUB69a7SARhPGQdkcHHso11bweRZQ4AQp72BHeYOtpkEtYVHHALUUIFQr1haLC0UeEH69WKWu6sp-G9V4wmpjCQMR7kGbMgwTvUC7K_bk6qhcc70LqZam6xHwTnvbLECQWq3glo2i5whPuqj1dF0_YzIGHq5grHpcJh1zyOCZNLFSZ9ut38w';

const COOKIE = `authorization-app=aiXin; authorization-token=${TOKEN}`;

// 关键洞察：浏览器发的请求可能会带 Authorization: Bearer xxx 头
// 同时 Cookie 里也有 authorization-token=xxx
// 双重携带！

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
          if (encoding === 'gzip') body = zlib.gunzipSync(buffer).toString();
          else if (encoding === 'br') body = zlib.brotliDecompressSync(buffer).toString();
          else if (encoding === 'deflate') body = zlib.inflateSync(buffer).toString();
          else body = buffer.toString();
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
  console.log("🔬 深度认证排查 - test-api10.js\n");
  console.log("=".repeat(60));
  
  // 猜测：前端可能同时用 Cookie + Authorization: Bearer 双重认证
  // 浏览器 fetch 带 credentials: 'include' 会自动发 Cookie
  // 但前端代码可能也手动设置了 Authorization header
  
  // 测试1: Cookie + Authorization Bearer 双重携带
  console.log("\n=== 测试1: Cookie(app+token) + Authorization Bearer 双重认证 ===\n");
  try {
    const res = await makeRequest(
      '/prod-api/student-center-ai/student/name/1785469369923121154',
      {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Authorization': `Bearer ${TOKEN}`,  // 同时加 Bearer
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
      }
    );
    console.log(`状态码: ${res.status}`);
    console.log(`响应: ${res.body.substring(0, 500)}`);
    if (res.status === 200) console.log("\n✅ 双重认证成功！");
  } catch (err) {
    console.error("错误:", err.message);
  }
  
  // 测试2: 看看 student/name 这个API是不是真的只能用数字ID
  // 从 JWT 可以看到 phone: 13938605581，试试用手机号
  console.log("\n=== 测试2: 用手机号查询学员 ===\n");
  try {
    const res = await makeRequest(
      '/prod-api/student-center-ai/student/name/13938605581',
      {
        'Accept': 'application/json',
        'Cookie': COOKIE,
        'Host': 'ai-genesis.yuaiweiwu.com',
        'Referer': 'https://ai-genesis.yuaiweiwu.com/',
        'User-Agent': 'Mozilla/5.0'
      }
    );
    console.log(`状态码: ${res.status}`);
    console.log(`响应: ${res.body.substring(0, 500)}`);
  } catch (err) {
    console.error("错误:", err.message);
  }
  
  // 测试3: 课表列表 - 加上更多查询参数，模拟前端实际请求
  console.log("\n=== 测试3: 课表列表 - 模拟前端完整参数 ===\n");
  try {
    const res = await makeRequest(
      '/prod-api/student-center-ai/regularCourse/next/class/list?classStatus=0&startDate=2026-05-24&endDate=2026-12-31&pageNum=1&pageSize=10',
      {
        'Accept': 'application/json, text/plain, */*',
        'Authorization': `Bearer ${TOKEN}`,
        'Cookie': COOKIE,
        'Host': 'ai-genesis.yuaiweiwu.com',
        'Referer': 'https://ai-genesis.yuaiweiwu.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      }
    );
    console.log(`状态码: ${res.status}`);
    console.log(`响应长度: ${res.body.length}`);
    console.log(`响应: ${res.body.substring(0, 500)}`);
    
    if (res.status === 200) {
      try {
        const data = JSON.parse(res.body);
        console.log(`\n✅ code: ${data.code}, mesg: ${data.mesg}`);
        if (data.data) {
          if (Array.isArray(data.data)) {
            console.log(`返回 ${data.data.length} 条课表记录`);
            if (data.data.length > 0) {
              console.log('第一条记录:', JSON.stringify(data.data[0]).substring(0, 300));
            }
          } else if (typeof data.data === 'object') {
            const keys = Object.keys(data.data);
            console.log(`data 是对象，字段: ${keys.join(', ')}`);
            // 查找数组字段
            for (const key of keys) {
              if (Array.isArray(data.data[key])) {
                console.log(`  ${key}: 数组(${data.data[key].length}项)`);
                if (data.data[key].length > 0) {
                  console.log(`  第一条: ${JSON.stringify(data.data[key][0]).substring(0, 200)}`);
                }
              }
            }
          }
        }
      } catch (e) {
        // not JSON
      }
    }
  } catch (err) {
    console.error("错误:", err.message);
  }

  // 测试4: 课堂时数据 API
  console.log("\n=== 测试4: 课堂时数据 API（用一个示例ID）===\n");
  try {
    const res = await makeRequest(
      '/prod-api/student-center-ai/ai/user/course/classhour?userClassTimeId=1785469369923121154',
      {
        'Accept': 'application/json, text/plain, */*',
        'Authorization': `Bearer ${TOKEN}`,
        'Cookie': COOKIE,
        'Host': 'ai-genesis.yuaiweiwu.com',
        'Referer': 'https://ai-genesis.yuaiweiwu.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      }
    );
    console.log(`状态码: ${res.status}`);
    console.log(`响应: ${res.body.substring(0, 500)}`);
  } catch (err) {
    console.error("错误:", err.message);
  }

  console.log("\n" + "=".repeat(60));
  console.log("\n📋 下一步：如果仍然失败，请用户在浏览器F12 → Network 中：");
  console.log("   1. 随便查询一个学员信息");
  console.log("   2. 找到 prod-api 开头的请求");
  console.log("   3. 右键 → Copy → Copy as cURL (bash)");
  console.log("   4. 把 cURL 命令发给我");
}

runTests();
