/**
 * 课表API日期格式测试
 * 验证：纯日期 vs 带时分秒 的API响应差异
 * 使用之前保存的JWT（可能已过期，仅验证格式）
 */

const https = require('https');
const BASE = 'https://ai-genesis.yuaiweiwu.com';

// 从命令行参数或环境变量获取JWT
const JWT = process.argv[2] || process.env.TK_JWT || '';

if (!JWT) {
  console.log('用法: node test-date-format.js <JWT>');
  console.log('需要一个有效的JWT token来测试');
  process.exit(1);
}

function httpGet(url, jwt) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'Cookie': `authorization-app=aiXin; authorization-token=${jwt}`,
        'Accept': 'application/json',
        'Referer': 'https://ai-genesis.yuaiweiwu.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      console.log(`HTTP status: ${res.statusCode}`);
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data.substring(0, 500) });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function main() {
  // 检查JWT过期
  try {
    const payload = JSON.parse(Buffer.from(JWT.split('.')[1], 'base64').toString());
    const expTime = new Date(payload.exp * 1000).toISOString();
    const isExpired = Date.now() > payload.exp * 1000;
    console.log(`JWT过期时间: ${expTime}, 已过期: ${isExpired}`);
    if (isExpired) {
      console.log('⚠️ JWT已过期，API调用会失败。但可以对比HTTP状态码和错误信息。');
    }
  } catch (e) {
    console.log('JWT解析失败');
  }

  console.log('\n=== 测试1: 纯日期格式 (旧V4方式) ===');
  const url1 = `${BASE}/prod-api/student-center-ai/regularCourse/next/class/list?classStatus=0&startDate=2026-05-27&endDate=2026-08-27`;
  console.log('URL:', url1);
  try {
    const r1 = await httpGet(url1, JWT);
    console.log('响应:', JSON.stringify(r1.body).substring(0, 500));
  } catch (e) {
    console.log('错误:', e.message);
  }

  console.log('\n=== 测试2: 带时分秒格式 (Chrome扩展方式) ===');
  const url2 = `${BASE}/prod-api/student-center-ai/regularCourse/next/class/list?classStatus=0&startDate=${encodeURIComponent('2026-02-27 00:00:00')}&endDate=${encodeURIComponent('2026-08-27 23:59:59')}`;
  console.log('URL:', url2);
  try {
    const r2 = await httpGet(url2, JWT);
    console.log('响应:', JSON.stringify(r2.body).substring(0, 500));
  } catch (e) {
    console.log('错误:', e.message);
  }

  console.log('\n=== 对比完成 ===');
}

main();
