/**
 * 精确复刻浏览器请求 - 最终验证
 * 使用浏览器完整的 Cookie 和 Header
 */

const TOKEN = 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImNlcnQteXVhaXdlaXd1IiwidHlwIjoiSldUIn0.eyJvd25lciI6Inl1YWl3ZWl3dSIsIm5hbWUiOiJ3YW5neWFydSIsImlkIjoiM0ZQa3ZHTWZhT2cyZ0tPeUV3OVg0Z2lFaUUiLCJkaXNwbGF5TmFtZSI6IueOi-S6muiMuSIsImF2YXRhciI6Imh0dHBzOi8vc3RhdGljLWxlZ2FjeS5kaW5ndGFsay5jb20vbWVkaWEvbEFEUERoWUJQYWlJRHNUTkFfbk5BX2tfMTAxN18xMDE3LmpwZyIsImVtYWlsIjoid2FuZ3lhcnVAeXVhaXdlaXd1LmNvbSIsInBob25lIjoiMTM5Mzg2MDU1ODEiLCJ0b2tlblR5cGUiOiJhY2Nlc3MtdG9rZW4iLCJzY29wZSI6InJlYWQiLCJpc3MiOiJodHRwczovL2Nhcy55dWFpd2Vpd3UuY29tIiwic3ViIjoiM0ZQa3ZHTWZhT2cyZ0tPeUV3OVg0Z2lFaUUiLCJhdWQiOlsiYjk1OWQzMmRmZmVhMzg3ZDQyNTMiXSwiZXhwIjoxNzc5Njg5MDE5LCJuYmYiOjE3Nzk2MDI2MTksImlhdCI6MTc3OTYwMjYxOSwianRpIjoiYWRtaW4vZTZmMTZjMDctODFhOC00MTc0LWEyNjctYjNkZmFkMTUzYjdlIn0.u_I63whklRjrZhVirgclNa7VNxtDI_g2MBR7AEIz-Ln9Y-RVEOkoKi2qCDSymQ0c_UN1WPxifDhxf9Yw2XXxIuUiokwRx7vqjwnwnyqSs3S7Qi5f9hMoPgKQ4PC70ceqHqcRdcrC9zTuQLRApxUbSyky3qkt7_N2i7A3m5e93hn6FnLE80JGFztSoeqniFRmtMYzskeQq_jLneXet0VjS4W5pIeCKRgwSdDFjIYm8gRre6zP0kun6gAmptZni5Ki1nb-yt162P5WfDDOv0CrflZVV-ODUBUuei18PmffSYooWXlbdqwrrns_E6lmnUJOXDEmge4PO0A6Eva8nDNBieHrF0dHVAHU7EFLHIbeRluh8QQZW7hykAmyI7i4Gf7z4GEje7j5ca7cz-jS57_8AbphP8YnDhJmRzi6h5xNTWetHAwCRKGqcg9LZ9eWb8OMiokGkeSw3Akzv01XJRNtG8lsitYTYcnHApNreRxz2uiyzPV60JZYTeFSUB69a7SARhPGQdkcHHso11bweRZQ4AQp72BHeYOtpkEtYVHHALUUIFQr1haLC0UeEH69WKWu6sp-G9V4wmpjCQMR7kGbMgwTvUC7K_bk6qhcc70LqZam6xHwTnvbLECQWq3glo2i5whPuqj1dF0_YzIGHq5grHpcJh1zyOCZNLFSZ9ut38w';

// 完整的浏览器 Cookie
const FULL_COOKIE = `authorization-app=aiXin; __itrace_wid=8a0a33db-2ba9-40a9-b021-007a02a22289; _dataflulx_usr_id=0f6ebef3-608f-4706-9a7d-b0cd2e098d25; authorization-token=${TOKEN}; sidebarStatus=1; _dataflux_s=rum=2&id=8a71842c-d992-475e-bc3f-38424a153a3d&created=1779621306476&expire=1779631214880`;

// 完整的浏览器请求头
const BROWSER_HEADERS = {
  'accept': '*/*',
  'accept-encoding': 'gzip, deflate, br, zstd',
  'accept-language': 'zh-CN,zh;q=0.9',
  'cookie': FULL_COOKIE,
  'referer': 'https://ai-genesis.yuaiweiwu.com/',
  'sec-ch-ua': '"Not?A_Brand";v="99", "Chromium";v="130"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 QuarkPC/6.8.2.847',
};

const BASE = 'https://ai-genesis.yuaiweiwu.com';

async function testAPI(name, url, options = {}) {
  try {
    const headers = { ...BROWSER_HEADERS, ...(options.headers || {}) };
    const resp = await fetch(url, {
      ...options,
      headers,
      redirect: 'manual',
    });
    
    const contentType = resp.headers.get('content-type') || '';
    let body;
    
    if (contentType.includes('json')) {
      body = await resp.json();
    } else {
      const text = await resp.text();
      try { body = JSON.parse(text); } catch { body = text.substring(0, 300); }
    }
    
    const statusEmoji = resp.status === 200 ? '✅' : resp.status === 401 ? '❌' : '⚠️';
    console.log(`\n${statusEmoji} [${name}] 状态码: ${resp.status}`);
    console.log('   响应:', JSON.stringify(body).substring(0, 500));
    
    return { status: resp.status, body };
  } catch (err) {
    console.log(`\n💥 [${name}] 异常: ${err.message}`);
    return { status: 0, error: err.message };
  }
}

async function main() {
  console.log('=== 精确复刻浏览器请求 - 最终验证 ===\n');
  console.log('Token exp:', new Date(1779689019 * 1000).toISOString());
  console.log('当前时间:', new Date().toISOString());
  
  // 测试1: 课表列表（浏览器里返回 "查询我的课堂列表失败" 的那个）
  await testAPI(
    '课表列表',
    `${BASE}/prod-api/student-center-ai/regularCourse/next/class/list?classStatus=0&startDate=2026-05-24&endDate=2026-12-31`
  );
  
  // 测试2: 用户信息（看看能不能拿到当前登录用户信息）
  await testAPI(
    '用户信息',
    `${BASE}/prod-api/system/user/getInfo`
  );
  
  // 测试3: 学员查询（用之前Chrome扩展里的学员ID）
  await testAPI(
    '学员查询',
    `${BASE}/prod-api/student-center-ai/student/name/1785469369923121154`
  );
  
  // 测试4: 课时数据（随机ID，只看认证是否通过）
  await testAPI(
    '课时数据',
    `${BASE}/prod-api/student-center-ai/ai/user/course/classhour?userClassTimeId=1`
  );
  
  // 测试5: 只带核心Cookie（不带追踪类Cookie），验证最小必要Cookie
  console.log('\n\n--- 最小Cookie测试 ---');
  const MINIMAL_COOKIE = `authorization-app=aiXin; authorization-token=${TOKEN}`;
  await testAPI(
    '课表列表(最小Cookie)',
    `${BASE}/prod-api/student-center-ai/regularCourse/next/class/list?classStatus=0&startDate=2026-05-24&endDate=2026-12-31`,
    { headers: { cookie: MINIMAL_COOKIE } }
  );
  
  console.log('\n\n=== 验证完成 ===');
}

main();
