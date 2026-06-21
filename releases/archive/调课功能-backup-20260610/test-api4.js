/**
 * 调课助手 - API 测试4：探索网关认证机制
 * 尝试各种可能的认证方式
 */

const TOKEN = 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImNlcnQteXVhaXdlaXd1IiwidHlwIjoiSldUIn0.eyJvd25lciI6Inl1YWl3ZWl3dSIsIm5hbWUiOiJ3YW5neWFydSIsImlkIjoiM0ZQa3ZHTWZhT2cyZ0tPeUV3OVg0Z2lFaUUiLCJkaXNwbGF5TmFtZSI6IueOi-S6muiMuSIsImF2YXRhciI6Imh0dHBzOi8vc3RhdGljLWxlZ2FjeS5kaW5ndGFsay5jb20vbWVkaWEvbEFEUERoWUJQYWlJRHNUTkFfbk5BX2tfMTAxN18xMDE3LmpwZyIsImVtYWlsIjoid2FuZ3lhcnVAeXVhaXdlaXd1LmNvbSIsInBob25lIjoiMTM5Mzg2MDU1ODEiLCJ0b2tlblR5cGUiOiJhY2Nlc3MtdG9rZW4iLCJzY29wZSI6InJlYWQiLCJpc3MiOiJodHRwczovL2Nhcy55dWFpd2Vpd3UuY29tIiwic3ViIjoiM0ZQa3ZHTWZhT2cyZ0tPeUV3OVg0Z2lFaUUiLCJhdWQiOlsiYjk1OWQzMmRmZmVhMzg3ZDQyNTMiXSwiZXhwIjoxNzc5Njg5MDE5LCJuYmYiOjE3Nzk2MDI2MTksImlhdCI6MTc3OTYwMjYxOSwianRpIjoiYWRtaW4vZTZmMTZjMDctODFhOC00MTc0LWEyNjctYjNkZmFkMTUzYjdlIn0.u_I63whklRjrZhVirgclNa7VNxtDI_g2MBR7AEIz-Ln9Y-RVEOkoKi2qCDSymQ0c_UN1WPxifDhxf9Yw2XXxIuUiokwRx7vqjwnwnyqSs3S7Qi5f9hMoPgKQ4PC70ceqHqcRdcrC9zTuQLRApxUbSyky3qkt7_N2i7A3m5e93hn6FnLE80JGFztSoeqniFRmtMYzskeQq_jLneXet0VjS4W5pIeCKRgwSdDFjIYm8gRre6zP0kun6gAmptZni5Ki1nb-yt162P5WfDDOv0CrflZVV-ODUBUuei18PmffSYooWXlbdqwrrns_E6lmnUJOXDEmge4PO0A6Eva8nDNBieHrF0dHVAHU7EFLHIbeRluh8QQZW7hykAmyI7i4Gf7z4GEje7j5ca7cz-jS57_8AbphP8YnDhJmRzi6h5xNTWetHAwCRKGqcg9LZ9eWb8OMiokGkeSw3Akzv01XJRNtG8lsitYTYcnHApNreRxz2uiyzPV60JZYTeFSUB69a7SARhPGQdkcHHso11bweRZQ4AQp72BHeYOtpkEtYVHHALUUIFQr1haLC0UeEH69WKWu6sp-G9V4wmpjCQMR7kGbMgwTvUC7K_bk6qhcc70LqZam6xHwTnvbLECQWq3glo2i5whPuqj1dF0_YzIGHq5grHpcJh1zyOCZNLFSZ9ut38w';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

async function tryFetch(label, url, headers) {
  try {
    const res = await fetch(url, { method: 'GET', headers, redirect: 'manual' });
    const text = await res.text();
    console.log(`${label}: HTTP ${res.status} | ${text.slice(0, 80).replace(/\n/g, ' ')}`);
    return { status: res.status, text, headers: Object.fromEntries(res.headers.entries()) };
  } catch (err) {
    console.log(`${label}: 异常 ${err.message}`);
    return null;
  }
}

async function main() {
  console.log('=== 探索网关认证机制 ===\n');

  const apiUrl = 'https://ai-genesis.yuaiweiwu.com/prod-api/student-center-ai/student/name/320207';
  const baseHeaders = {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Referer': 'https://ai-genesis.yuaiweiwu.com/',
    'Origin': 'https://ai-genesis.yuaiweiwu.com',
  };

  // 1. 检查 prod-api 的入口网关
  console.log('--- 1. 不带任何Token，看错误响应详情 ---');
  const r1 = await tryFetch('无Token', apiUrl, baseHeaders);

  // 2. 检查是否有 OAuth2 标准路径
  console.log('\n--- 2. 探测 OAuth/认证相关路径 ---');
  await tryFetch('well-known', 'https://ai-genesis.yuaiweiwu.com/.well-known/openid-configuration', { 'User-Agent': UA });
  await tryFetch('oauth-authorize', 'https://ai-genesis.yuaiweiwu.com/oauth/authorize', { 'User-Agent': UA });
  await tryFetch('api-auth', 'https://ai-genesis.yuaiweiwu.com/prod-api/auth', { 'User-Agent': UA });

  // 3. 尝试 X-Auth-Token 头（有些网关用这个）
  console.log('\n--- 3. 其他可能的Header名 ---');
  await tryFetch('X-Auth-Token', apiUrl, { ...baseHeaders, 'X-Auth-Token': TOKEN });
  await tryFetch('X-Access-Token', apiUrl, { ...baseHeaders, 'X-Access-Token': TOKEN });
  await tryFetch('token', apiUrl, { ...baseHeaders, 'token': TOKEN });
  await tryFetch('Access-Token', apiUrl, { ...baseHeaders, 'Access-Token': TOKEN });

  // 4. 试试 Cookie 里还缺不缺其他字段（有些系统需要多个Cookie）
  console.log('\n--- 4. Cookie带其他常见字段 ---');
  await tryFetch('Cookie+JSESSIONID', apiUrl, {
    ...baseHeaders,
    'Cookie': `authorization-token=${TOKEN}; JSESSIONID=placeholder`,
  });

  // 5. 最关键：检查网关是否检查 Referer/Origin 来判断请求来源
  console.log('\n--- 5. 不带 Origin/Referer（模拟跨域请求） ---');
  await tryFetch('无Origin/Referer+Token', apiUrl, {
    'User-Agent': UA,
    'Accept': 'application/json',
    'authorization-token': TOKEN,
    'Cookie': `authorization-token=${TOKEN}`,
  });

  // 6. 看看 CAS 登录回调的路径
  console.log('\n--- 6. 探测CAS回调路径 ---');
  await tryFetch('cas-callback', 'https://ai-genesis.yuaiweiwu.com/cas/callback', { 'User-Agent': UA });
  await tryFetch('cas-login', 'https://ai-genesis.yuaiweiwu.com/cas/login', { 'User-Agent': UA });

  console.log('\n=== 探测完成 ===');
}

main().catch(err => console.error('异常:', err));
