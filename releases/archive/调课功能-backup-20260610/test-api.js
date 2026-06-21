/**
 * 调课助手 - API 可行性测试（多方式验证）
 * 目的：找出正确的 Token 传递方式
 */

const API_BASE = 'https://ai-genesis.yuaiweiwu.com/prod-api/student-center-ai';
const TOKEN = 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImNlcnQteXVhaXdlaXd1IiwidHlwIjoiSldUIn0.eyJvd25lciI6Inl1YWl3ZWl3dSIsIm5hbWUiOiJ3YW5neWFydSIsImlkIjoiM0ZQa3ZHTWZhT2cyZ0tPeUV3OVg0Z2lFaUUiLCJkaXNwbGF5TmFtZSI6IueOi-S6muiMuSIsImF2YXRhciI6Imh0dHBzOi8vc3RhdGljLWxlZ2FjeS5kaW5ndGFsay5jb20vbWVkaWEvbEFEUERoWUJQYWlJRHNUTkFfbk5BX2tfMTAxN18xMDE3LmpwZyIsImVtYWlsIjoid2FuZ3lhcnVAeXVhaXdlaXd1LmNvbSIsInBob25lIjoiMTM5Mzg2MDU1ODEiLCJ0b2tlblR5cGUiOiJhY2Nlc3MtdG9rZW4iLCJzY29wZSI6InJlYWQiLCJpc3MiOiJodHRwczovL2Nhcy55dWFpd2Vpd3UuY29tIiwic3ViIjoiM0ZQa3ZHTWZhT2cyZ0tPeUV3OVg0Z2lFaUUiLCJhdWQiOlsiYjk1OWQzMmRmZmVhMzg3ZDQyNTMiXSwiZXhwIjoxNzc5Njg5MDE5LCJuYmYiOjE3Nzk2MDI2MTksImlhdCI6MTc3OTYwMjYxOSwianRpIjoiYWRtaW4vZTZmMTZjMDctODFhOC00MTc0LWEyNjctYjNkZmFkMTUzYjdlIn0.u_I63whklRjrZhVirgclNa7VNxtDI_g2MBR7AEIz-Ln9Y-RVEOkoKi2qCDSymQ0c_UN1WPxifDhxf9Yw2XXxIuUiokwRx7vqjwnwnyqSs3S7Qi5f9hMoPgKQ4PC70ceqHqcRdcrC9zTuQLRApxUbSyky3qkt7_N2i7A3m5e93hn6FnLE80JGFztSoeqniFRmtMYzskeQq_jLneXet0VjS4W5pIeCKRgwSdDFjIYm8gRre6zP0kun6gAmptZni5Ki1nb-yt162P5WfDDOv0CrflZVV-ODUBUuei18PmffSYooWXlbdqwrrns_E6lmnUJOXDEmge4PO0A6Eva8nDNBieHrF0dHVAHU7EFLHIbeRluh8QQZW7hykAmyI7i4Gf7z4GEje7j5ca7cz-jS57_8AbphP8YnDhJmRzi6h5xNTWetHAwCRKGqcg9LZ9eWb8OMiokGkeSw3Akzv01XJRNtG8lsitYTYcnHApNreRxz2uiyzPV60JZYTeFSUB69a7SARhPGQdkcHHso11bweRZQ4AQp72BHeYOtpkEtYVHHALUUIFQr1haLC0UeEH69WKWu6sp-G9V4wmpjCQMR7kGbMgwTvUC7K_bk6qhcc70LqZam6xHwTnvbLECQWq3glo2i5whPuqj1dF0_YzIGHq5grHpcJh1zyOCZNLFSZ9ut38w';

async function testWithHeaders(headerName, headerValue, label) {
  console.log(`\n🧪 ${label}`);
  try {
    const url = `${API_BASE}/student/name/320207`;
    const headers = {
      'Content-Type': 'application/json;charset=UTF-8',
    };
    headers[headerName] = headerValue;

    const res = await fetch(url, { method: 'GET', headers });
    const text = await res.text();
    
    console.log(`  HTTP状态码: ${res.status}`);
    console.log(`  响应前100字: ${text.slice(0, 100)}`);
    
    if (res.status === 200) {
      try {
        const data = JSON.parse(text);
        if (data.code === '000000') {
          console.log(`  ✅ 成功！学员名: ${data.data?.name || data.data?.studentName || JSON.stringify(data.data).slice(0, 80)}`);
        } else {
          console.log(`  ⚠️ 业务码: ${data.code}, 消息: ${data.mesg || data.msg || ''}`);
        }
      } catch {
        console.log(`  ⚠️ 非JSON响应`);
      }
    } else {
      console.log(`  ❌ HTTP ${res.status}`);
    }
  } catch (err) {
    console.log(`  ❌ 请求异常: ${err.message}`);
  }
}

async function main() {
  console.log('=== 调课助手 API 测试 - 多种Token传递方式 ===');

  // 方式1：Cookie方式（authorization-token=xxx）
  await testWithHeaders('Cookie', `authorization-token=${TOKEN}`, '方式1: Cookie头');
  
  // 方式2：直接用 Cookie 名作为 Header 名
  await testWithHeaders('authorization-token', TOKEN, '方式2: authorization-token头');
  
  // 方式3：Authorization Bearer
  await testWithHeaders('Authorization', `Bearer ${TOKEN}`, '方式3: Authorization Bearer头');
  
  // 方式4：Authorization 直接放token
  await testWithHeaders('Authorization', TOKEN, '方式4: Authorization 直接token头');

  // 方式5：同时传 Cookie + Header
  console.log('\n🧪 方式5: Cookie + authorization-token 双重传递');
  try {
    const url = `${API_BASE}/student/name/320207`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Cookie': `authorization-token=${TOKEN}`,
        'authorization-token': TOKEN,
      },
    });
    const text = await res.text();
    console.log(`  HTTP状态码: ${res.status}`);
    console.log(`  响应前100字: ${text.slice(0, 100)}`);
  } catch (err) {
    console.log(`  ❌ 请求异常: ${err.message}`);
  }

  console.log('\n=== 测试完成 ===');
  console.log('注意：Node.js 的 fetch 默认不自动发送 Cookie，需要手动设置。');
  console.log('如果所有方式都返回 401，可能 Token 已过期（24小时有效），需要重新获取。');
}

main();
