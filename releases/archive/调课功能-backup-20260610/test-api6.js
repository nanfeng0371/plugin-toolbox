/**
 * test-api6.js - 带 authorization-app Cookie 的 API 测试
 * 
 * 关键发现：浏览器有6个Cookie，其中2个可能是认证必需的：
 *   - authorization-app: aiXin (应用标识)
 *   - authorization-token: eyJhbGciOiJSUzI1NiIs... (JWT)
 */

const TOKEN = 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImNlcnQteXVhaXdlaXd1IiwidHlwIjoiSldUIn0.eyJvd25lciI6Inl1YWl3ZWl3dSIsIm5hbWUiOiJ3YW5neWFydSIsImlkIjoiM0ZQa3ZHTWZhT2cyZ0tPeUV3OVg0Z2lFaUUiLCJkaXNwbGF5TmFtZSI6IueOi-S6muiMuSIsImF2YXRhciI6Imh0dHBzOi8vc3RhdGljLWxlZ2FjeS5kaW5ndGFsay5jb20vbWVkaWEvbEFEUERoWUJQYWlJRHNUTkFfbk5BX2tfMTAxN18xMDE3LmpwZyIsImVtYWlsIjoid2FuZ3lhcnVAeXVhaXdlaXd1LmNvbSIsInBob25lIjoiMTM5Mzg2MDU1ODEiLCJ0b2tlblR5cGUiOiJhY2Nlc3MtdG9rZW4iLCJzY29wZSI6InJlYWQiLCJpc3MiOiJodHRwczovL2Nhcy55dWFpd2Vpd3UuY29tIiwic3ViIjoiM0ZQa3ZHTWZhT2cyZ0tPeUV3OVg0Z2lFaUUiLCJhdWQiOlsiYjk1OWQzMmRmZmVhMzg3ZDQyNTMiXSwiZXhwIjoxNzc5Njg5MDE5LCJuYmYiOjE3Nzk2MDI2MTksImlhdCI6MTc3OTYwMjYxOSwianRpIjoiYWRtaW4vZTZmMTZjMDctODFhOC00MTc0LWEyNjctYjNkZmFkMTUzYjdlIn0.u_I63whklRjrZhVirgclNa7VNxtDI_g2MBR7AEIz-Ln9Y-RVEOkoKi2qCDSymQ0c_UN1WPxifDhxf9Yw2XXxIuUiokwRx7vqjwnwnyqSs3S7Qi5f9hMoPgKQ4PC70ceqHqcRdcrC9zTuQLRApxUbSyky3qkt7_N2i7A3m5e93hn6FnLE80JGFztSoeqniFRmtMYzskeQq_jLneXet0VjS4W5pIeCKRgwSdDFjIYm8gRre6zP0kun6gAmptZni5Ki1nb-yt162P5WfDDOv0CrflZVV-ODUBUuei18PmffSYooWXlbdqwrrns_E6lmnUJOXDEmge4PO0A6Eva8nDNBieHrF0dHVAHU7EFLHIbeRluh8QQZW7hykAmyI7i4Gf7z4GEje7j5ca7cz-jS57_8AbphP8YnDhJmRzi6h5xNTWetHAwCRKGqcg9LZ9eWb8OMiokGkeSw3Akzv01XJRNtG8lsitYTYcnHApNreRxz2uiyzPV60JZYTeFSUB69a7SARhPGQdkcHHso11bweRZQ4AQp72BHeYOtpkEtYVHHALUUIFQr1haLC0UeEH69WKWu6sp-G9V4wmpjCQMR7kGbMgwTvUC7K_bk6qhcc70LqZam6xHwTnvbLECQWq3glo2i5whPuqj1dF0_YzIGHq5grHpcJh1zyOCZNLFSZ9ut38w';

const DATAFLUX_S = 'rum=2&id=8a71842c-d992-475e-bc3f-38424a153a3d&created=1779621306476&expire=1779630293724';

const API_URL = "https://ai-genesis.yuaiweiwu.com/prod-api/student-center-ai/student/name/1785469369923121154";

// 测试1: 只带 authorization-app + authorization-token (Cookie方式)
async function test1_TwoCookies() {
  console.log("=== 测试1: Cookie带 authorization-app + authorization-token ===\n");
  
  const cookieStr = `authorization-app=aiXin; authorization-token=${TOKEN}`;
  
  try {
    const res = await fetch(API_URL, {
      method: "GET",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Cookie": cookieStr,
        "Referer": "https://ai-genesis.yuaiweiwu.com/",
        "Origin": "https://ai-genesis.yuaiweiwu.com",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
      }
    });
    
    console.log(`状态码: ${res.status} ${res.statusText}`);
    const text = await res.text();
    console.log(`响应: ${text.substring(0, 300)}`);
    
    if (res.status === 200) {
      console.log("\n✅ 成功！authorization-app 是关键！");
    } else {
      console.log("\n❌ 失败，继续尝试...");
    }
    return res.status;
  } catch (err) {
    console.error("请求错误:", err.message);
    return -1;
  }
}

// 测试2: authorization-app 作为 Header + authorization-token 作为 Cookie
async function test2_AppHeader_TokenCookie() {
  console.log("\n=== 测试2: authorization-app 作为Header, authorization-token 作为Cookie ===\n");
  
  try {
    const res = await fetch(API_URL, {
      method: "GET",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "authorization-app": "aiXin",
        "Cookie": `authorization-token=${TOKEN}`,
        "Referer": "https://ai-genesis.yuaiweiwu.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
      }
    });
    
    console.log(`状态码: ${res.status} ${res.statusText}`);
    const text = await res.text();
    console.log(`响应: ${text.substring(0, 300)}`);
    
    if (res.status === 200) {
      console.log("\n✅ 成功！Header+Cookie组合有效！");
    }
    return res.status;
  } catch (err) {
    console.error("请求错误:", err.message);
    return -1;
  }
}

// 测试3: 完整Cookie（模拟浏览器全部6个Cookie）
async function test3_FullCookies() {
  console.log("\n=== 测试3: 模拟浏览器完整6个Cookie ===\n");
  
  const fullCookie = [
    `authorization-app=aiXin`,
    `authorization-token=${TOKEN}`,
    `sidebarStatus=1`,
    `_dataflux_s=${DATAFLUX_S}`,
    `_dataflux_user_id=0f6ebedf3-608f-4706-aaf3-fa1c8e8e6b43`,
    `_itrace_wid=8a0a33db-2ba9-40bd-b00b-e8c8c8d7e3c3`
  ].join("; ");
  
  try {
    const res = await fetch(API_URL, {
      method: "GET",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Cookie": fullCookie,
        "Referer": "https://ai-genesis.yuaiweiwu.com/",
        "Origin": "https://ai-genesis.yuaiweiwu.com",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
      }
    });
    
    console.log(`状态码: ${res.status} ${res.statusText}`);
    const text = await res.text();
    console.log(`响应: ${text.substring(0, 300)}`);
    
    if (res.status === 200) {
      console.log("\n✅ 完整Cookie方案成功！");
    }
    return res.status;
  } catch (err) {
    console.error("错误:", err.message);
    return -1;
  }
}

// 测试4: Authorization Bearer + authorization-app Header（无Cookie）
async function test4_BearerToken_AppHeader() {
  console.log("\n=== 测试4: Authorization Bearer + authorization-app Header（纯Header方式）===\n");
  
  try {
    const res = await fetch(API_URL, {
      method: "GET",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Authorization": `Bearer ${TOKEN}`,
        "authorization-app": "aiXin",
        "Referer": "https://ai-genesis.yuaiweiwu.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
      }
    });
    
    console.log(`状态码: ${res.status} ${res.statusText}`);
    const text = await res.text();
    console.log(`响应: ${text.substring(0, 300)}`);
    
    if (res.status === 200) {
      console.log("\n✅ 纯Header方式成功！这是最干净的方案！");
    }
    return res.status;
  } catch (err) {
    console.error("错误:", err.message);
    return -1;
  }
}

// 测试5: authorization-token 作为 Header + authorization-app 作为 Header
async function test5_BothHeaders() {
  console.log("\n=== 测试5: authorization-token Header + authorization-app Header ===\n");
  
  try {
    const res = await fetch(API_URL, {
      method: "GET",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "authorization-token": TOKEN,
        "authorization-app": "aiXin",
        "Referer": "https://ai-genesis.yuaiweiwu.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
      }
    });
    
    console.log(`状态码: ${res.status} ${res.statusText}`);
    const text = await res.text();
    console.log(`响应: ${text.substring(0, 300)}`);
    
    if (res.status === 200) {
      console.log("\n✅ 双Header方式成功！");
    }
    return res.status;
  } catch (err) {
    console.error("错误:", err.message);
    return -1;
  }
}

// 运行所有测试
(async () => {
  console.log("🔑 Token 有效期至: 2026-05-25 06:03:39 UTC (还有约17小时)\n");
  console.log("📦 测试目标: 找到能让 Node.js 成功调用 API 的认证方式\n");
  console.log("=".repeat(60));
  
  const results = {};
  results.test1 = await test1_TwoCookies();
  results.test2 = await test2_AppHeader_TokenCookie();
  results.test3 = await test3_FullCookies();
  results.test4 = await test4_BearerToken_AppHeader();
  results.test5 = await test5_BothHeaders();
  
  console.log("\n" + "=".repeat(60));
  console.log("📊 测试结果汇总:");
  console.log("-".repeat(40));
  for (const [name, status] of Object.entries(results)) {
    const icon = status === 200 ? "✅" : "❌";
    console.log(`${icon} ${name}: ${status}`);
  }
  
  const anySuccess = Object.values(results).some(s => s === 200);
  if (anySuccess) {
    console.log("\n🎉 有方案成功了！Node.js 可以直接调用 API！");
  } else {
    console.log("\n⚠️ 所有方案都返回非200状态码");
    console.log("可能原因: 服务器验证了请求来源(非浏览器)、TLS指纹、或IP白名单");
  }
})();
