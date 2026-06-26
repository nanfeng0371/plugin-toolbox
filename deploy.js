/**
 * 浏览器插件管理 — 一键部署脚本（优化版）
 *
 * 流程：
 *   1. 环境检查（gh CLI、GitHub 登录、CloudBase CLI、Git 仓库）
 *   2. 打包（调用 build.js）
 *   3. 版本一致性检查
 *   4. 包体积检查（异常增长警告）
 *   5. 备份到 GitHub Releases（历史版本存档）
 *   6. 部署到 CloudBase（只推送最新版本）
 *   7. 验证云端部署（update.xml + .crx 文件可下载性）
 *   8. 清理本地旧版本文件
 *   9. 写部署日志
 *  10. Git 提交并推送版本号更新
 *  11. 发送 Windows 通知
 *
 * 用法:
 *   node deploy.js                    # 完整部署流程
 *   node deploy.js --dry-run          # 预演模式（不实际部署）
 *   node deploy.js --rollback=v2.2.80 # 回滚到指定版本
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// ─── 读取配置（Token 优先级：环境变量 > deploy-config.js）─────────────
let config = {};
const CONFIG_FILE = path.join(__dirname, 'deploy-config.js');
if (fs.existsSync(CONFIG_FILE)) {
  try {
    config = require(CONFIG_FILE);
  } catch (e) {
    console.error('❌ deploy-config.js 有语法错误！');
    console.error('   错误:', e.message);
    process.exit(1);
  }
} else {
  console.error('❌ 找不到 deploy-config.js！');
  console.error('   请复制 deploy-config.example.js 为 deploy-config.js 并填写 Token');
  process.exit(1);
}

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || config.GITHUB_TOKEN || '';
const ENV_ID = config.CLOUDBASE_ENV_ID || 'renewal-calendar-7ff2rtj4f876144';

// ─── 配置（从 deploy-config.js 读取）─────────────────────────────────
const DIST_DIR = path.join(__dirname, 'dist', 'extensions', 'toolbox');
const BASE_URL = `https://${ENV_ID}-1259283480.tcloudbaseapp.com`;
const GITHUB_REPO = config.GITHUB_REPO || 'nanfeng0371/plugin-toolbox';
const REPO_URL = `https://github.com/${GITHUB_REPO}`;

const KEEP_VERSIONS = config.KEEP_VERSIONS || 3;
const ENABLE_NOTIFICATION = config.ENABLE_NOTIFICATION !== false;
const DEPLOY_LOG_FILE = config.DEPLOY_LOG_FILE || 'deploy-log.txt';
const SIZE_CHECK_ENABLED = config.SIZE_CHECK_ENABLED !== false;
const SIZE_CHECK_THRESHOLD = config.SIZE_CHECK_THRESHOLD || 0.2;

// gh CLI 路径：优先用 deploy-config.js 配置，找不到再 fallback 到系统 PATH
const LOCAL_GH = path.join(__dirname, config.GH_PATH || 'tools/gh/bin/gh.exe');
const GH_BIN = fs.existsSync(LOCAL_GH) ? LOCAL_GH : 'gh';

// 把 gh 所在目录加入 PATH（让所有 gh 子命令都能找到）
if (GH_BIN !== 'gh') {
  const ghDir = path.dirname(GH_BIN);
  if (!process.env.PATH.includes(ghDir)) {
    process.env.PATH = ghDir + path.delimiter + process.env.PATH;
  }
}

// ─── 工具函数 ─────────────────────────────────────────────────────────

// 设置 GitHub Token 环境变量（所有子进程共用）
if (GITHUB_TOKEN) {
  process.env.GITHUB_TOKEN = GITHUB_TOKEN;
  process.env.GH_TOKEN = GITHUB_TOKEN;
}

function runCmd(cmd, opts = {}) {
  const defaults = { stdio: 'inherit', encoding: 'utf8' };
  const options = { ...defaults, ...opts };
  return execSync(cmd, options);
}

function runCmdSilent(cmd, ignoreError = false) {
  try {
    return execSync(cmd, { stdio: 'pipe', encoding: 'utf8' }).trim();
  } catch (e) {
    if (!ignoreError) {
      throw e;
    }
    return '';
  }
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const options = {
      headers: Object.assign({ 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' }, headers)
    };
    client.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpGet(res.headers.location).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    }).on('error', reject);
  });
}

function httpHead(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const options = {
      method: 'HEAD',
      headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' }
    };
    const req = client.request(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpHead(res.headers.location).then(resolve).catch(reject);
        return;
      }
      resolve({ status: res.statusCode, headers: res.headers });
    });
    req.on('error', reject);
    req.end();
  });
}

function pad(n) { return n < 10 ? '0' + n : String(n); }

function nowStr() {
  const d = new Date();
  const offset = 8; // UTC+8
  const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
  const c = new Date(utc + (3600000 * offset));
  return `${c.getFullYear()}-${pad(c.getMonth()+1)}-${pad(c.getDate())} ${pad(c.getHours())}:${pad(c.getMinutes())}:${pad(c.getSeconds())}`;
}

// ─── Windows 通知 ─────────────────────────────────────────────────────
function sendNotification(title, message) {
  if (!ENABLE_NOTIFICATION) return;

  try {
    const psCmd = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

$xml = @"
<?xml version="1.0" encoding="utf-8"?>
<toast>
  <visual>
    <binding template="ToastText02">
      <text id="1">${title}</text>
      <text id="2">${message}</text>
    </binding>
  </visual>
</toast>
"@

$xmlDoc = New-Object Windows.Data.Xml.Dom.XmlDocument
$xmlDoc.LoadXml($xml)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xmlDoc)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("插件工作箱").Show($toast)
`;
    const tmpFile = path.join(__dirname, 'dist', '_notify.ps1');
    fs.writeFileSync(tmpFile, psCmd);
    runCmdSilent(`powershell -ExecutionPolicy Bypass -File "${tmpFile}"`, true);
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  } catch (e) {
    // 通知发送失败不影响部署
  }
}

// ─── 回滚功能 ─────────────────────────────────────────────────────────
async function rollback(targetVersion) {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   插件工作箱 — 回滚到 v' + targetVersion.padEnd(12) + '║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  // 1. 从 GitHub Releases 下载指定版本的 .crx 文件
  console.log('📥 [1/5] 从 GitHub Releases 下载 v' + targetVersion + '...');
  const crxUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${targetVersion}/toolbox-v${targetVersion}.crx`;
  const crxPath = path.join(DIST_DIR, `toolbox-v${targetVersion}.crx`);

  // 确保 DIST_DIR 存在
  if (!fs.existsSync(DIST_DIR)) {
    fs.mkdirSync(DIST_DIR, { recursive: true });
  }

  try {
    const res = await httpGet(crxUrl);
    if (res.status !== 200) {
      console.error('❌ 下载失败！HTTP', res.status);
      console.error('   请检查版本号是否正确: v' + targetVersion);
      process.exit(1);
    }
    fs.writeFileSync(crxPath, res.body);
    console.log('  ✅ 下载完成:', crxPath);
  } catch (e) {
    console.error('❌ 下载失败:', e.message);
    process.exit(1);
  }

  // 2. 更新 update.xml 和 update.json 指向这个版本
  console.log('');
  console.log('📝 [2/5] 更新 update.xml 和 update.json...');

  const updateXmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="nmpdifejooglhkcilhgjkhggbioalojk">
    <updatecheck codebase="${BASE_URL}/extensions/toolbox/toolbox-latest.crx" version="${targetVersion}"/>
  </app>
</gupdate>`;

  const updateJsonContent = JSON.stringify({
    version: targetVersion,
    update_url: `${BASE_URL}/extensions/toolbox/update.xml`,
    download_url: `${BASE_URL}/extensions/toolbox/toolbox-latest.crx`,
    changelog: `回滚到 v${targetVersion}`,
    published_at: new Date().toISOString(),
  }, null, 2);

  fs.writeFileSync(path.join(DIST_DIR, 'update.xml'), updateXmlContent);
  fs.writeFileSync(path.join(DIST_DIR, 'update.json'), updateJsonContent);
  console.log('  ✅ 已更新 update.xml 和 update.json');

  // 3. 复制 .crx 文件为 toolbox-latest.crx
  fs.copyFileSync(crxPath, path.join(DIST_DIR, 'toolbox-latest.crx'));
  console.log('  ✅ 已复制为 toolbox-latest.crx');

  // 4. 部署到 CloudBase（带重试）
  console.log('');
  console.log('☁️  [3/5] 部署到 CloudBase...');
  let deploySuccess = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      runCmd(`cloudbase hosting deploy "${DIST_DIR}" extensions/toolbox --envId ${ENV_ID}`);
      deploySuccess = true;
      console.log('  ✅ 部署成功！');
      break;
    } catch (e) {
      if (attempt < 3) {
        console.log(`  ⚠️  部署失败，第 ${attempt} 次重试（等待 60 秒）...`);
        await new Promise(resolve => setTimeout(resolve, 60000));
      } else {
        console.error('❌ 部署失败（已重试 3 次）:', e.message);
        process.exit(1);
      }
    }
  }

  // 5. 验证部署
  console.log('');
  console.log('🔍 [4/5] 验证部署...');
  try {
    const updateUrl = `${BASE_URL}/extensions/toolbox/update.xml`;
    const res = await httpGet(updateUrl);
    const cloudMatch = res.body.match(/version\s*=\s*['"]([^'"]+)['"]/);
    const cloudVersion = cloudMatch ? cloudMatch[1] : '';

    if (cloudVersion === targetVersion) {
      console.log('  ✅ 回滚成功！当前云端版本: v' + cloudVersion);
    } else {
      console.log('  ⚠️  回滚验证警告！云端版本: v' + (cloudVersion || '(无法解析)'));
    }
  } catch (e) {
    console.log('  ⚠️  无法验证回滚结果:', e.message);
  }

  // 6. 写回滚日志
  console.log('');
  console.log('📋 [5/5] 写回滚日志...');
  const logFile = path.join(__dirname, DEPLOY_LOG_FILE);
  const logEntry = `[${nowStr()}] v${targetVersion}  ROLLBACK  CloudBase:成功\n`;
  fs.appendFileSync(logFile, logEntry);
  console.log('  ✅ 回滚日志已写入:', DEPLOY_LOG_FILE);

  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log('✅ 回滚完成！');
  console.log('');
  console.log('   版本: v' + targetVersion);
  console.log('   CloudBase: ' + BASE_URL + '/extensions/toolbox/');
  console.log('');

  // 发送通知
  sendNotification('回滚完成', `插件工作箱已回滚到 v${targetVersion}`);
}

// ─── 主流程 ───────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');

  // 解析 --rollback=v2.2.80 参数
  const rollbackArg = args.find(a => a.startsWith('--rollback='));
  if (rollbackArg) {
    const targetVersion = rollbackArg.split('=')[1];
    await rollback(targetVersion);
    return;
  }

  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   插件工作箱 — 一键部署脚本              ║');
  console.log('╚══════════════════════════════════════════╝');

  if (isDryRun) {
    console.log('  ⚠️  预演模式（不会实际部署）');
  }
  console.log('');

  // ─── 1. 环境检查 ─────────────────────────────────────────────────
  console.log('🔍 [1/11] 环境检查...');

  // 检查 gh CLI
  if (!fs.existsSync(GH_BIN)) {
    console.error('❌ 未找到 gh CLI！');
    console.error('   期望路径:', GH_BIN);
    process.exit(1);
  }

  // 检查 gh 登录状态
  const authStatus = runCmdSilent(`${GH_BIN} auth status 2>&1`);
  if (!authStatus.includes('Logged in')) {
    console.error('❌ 未登录 GitHub！');
    console.error('   请先设置 GITHUB_TOKEN 环境变量');
    process.exit(1);
  }
  console.log('  ✅ gh CLI 已登录');

  // 检查 CloudBase CLI
  const tcbVer = runCmdSilent('cloudbase --version 2>&1');
  if (!tcbVer.includes('CloudBase')) {
    console.error('❌ 未安装 CloudBase CLI！');
    console.error('   请先运行: npm install -g @cloudbase/cli');
    process.exit(1);
  }
  console.log('  ✅ CloudBase CLI:', tcbVer.split('\n')[0]);

  // 检查 git 仓库
  if (!fs.existsSync(path.join(__dirname, '.git'))) {
    console.error('❌ 当前目录不是 Git 仓库！');
    process.exit(1);
  }
  console.log('  ✅ Git 仓库已初始化');
  console.log('');

  // ─── 2. 打包 ─────────────────────────────────────────────────────
  console.log('📦 [2/11] 打包中...');
  if (!isDryRun) {
    try {
      runCmd('node build.js');
    } catch (e) {
      console.error('❌ 打包失败！');
      process.exit(1);
    }
  } else {
    console.log('  (预演模式，跳过打包)');
  }

  // 读取版本号（build.js 可能已自动递增）
  const manifest = JSON.parse(fs.readFileSync('plugins/toolbox/manifest.json', 'utf8'));
  const version = manifest.version;
  console.log('');

  // ─── 3. 版本一致性检查 ───────────────────────────────────────────
  console.log('🔍 [3/11] 版本一致性检查...');
  const crxFile = path.join(DIST_DIR, `toolbox-v${version}.crx`);
  const latestZip = path.join(DIST_DIR, 'toolbox-latest.zip');

  if (!fs.existsSync(crxFile)) {
    console.error('❌ 找不到 CRX 文件:', crxFile);
    console.error('   请检查 build.js 是否正确生成了版本化 CRX 文件');
    process.exit(1);
  }
  console.log('  ✅ CRX 文件存在:', `toolbox-v${version}.crx`);

  if (!fs.existsSync(latestZip)) {
    console.error('❌ 找不到 ZIP 文件:', latestZip);
    process.exit(1);
  }
  console.log('  ✅ ZIP 文件存在: toolbox-latest.zip');

  // 检查 GitHub Release 是否已存在
  const existingRelease = runCmdSilent(
    `${GH_BIN} release view v${version} --repo ${GITHUB_REPO} 2>&1`, true
  );
  if (!existingRelease || existingRelease.includes(`release v${version} not found`)) {
    console.log('  ✅ GitHub Release v' + version + ' 不存在（可以创建）');
  } else {
    console.error('❌ GitHub Release v' + version + ' 已存在！');
    console.error('   请先删除: ' + REPO_URL + '/releases/tag/v' + version);
    process.exit(1);
  }
  console.log('');

  // ─── 4. 包体积检查 ───────────────────────────────────────────────
  console.log('📊 [4/11] 包体积检查...');
  if (SIZE_CHECK_ENABLED && !isDryRun) {
    const crxStats = fs.statSync(crxFile);
    const crxSize = crxStats.size;
    const crxSizeKB = (crxSize / 1024).toFixed(1);

    console.log('  当前包大小: ' + crxSizeKB + ' KB');

    // 读取上次部署的包大小（从部署日志）
    const logFile = path.join(__dirname, DEPLOY_LOG_FILE);
    if (fs.existsSync(logFile)) {
      const logContent = fs.readFileSync(logFile, 'utf8');
      const sizeMatch = logContent.match(/SIZE:(\d+)/);
      if (sizeMatch) {
        const lastSize = parseInt(sizeMatch[1]);
        const growth = (crxSize - lastSize) / lastSize;
        if (growth > SIZE_CHECK_THRESHOLD) {
          console.log('  ⚠️  包体积增长 ' + (growth * 100).toFixed(1) + '%（上次: ' + (lastSize / 1024).toFixed(1) + ' KB）');
          console.log('   请检查是否误加了大型资源文件');
        } else {
          console.log('  ✅ 包体积正常（上次: ' + (lastSize / 1024).toFixed(1) + ' KB，增长: ' + (growth * 100).toFixed(1) + '%）');
        }
      }
    }
  } else {
    console.log('  (跳过包体积检查)');
  }
  console.log('');

  // ─── 5. 备份到 GitHub Releases ───────────────────────────────────
  console.log('📋 [5/11] 备份到 GitHub Releases...');

  const versionedZip = path.join(DIST_DIR, `toolbox-v${version}.zip`);
  fs.copyFileSync(latestZip, versionedZip);

  const releaseNotes = `## 插件工作箱 v${version}

部署时间: ${nowStr()}
CloudBase: ${BASE_URL}/extensions/toolbox/

### 产物
- \`toolbox-v${version}.crx\` — Chrome/Edge 加密扩展包
- \`toolbox-v${version}.zip\` — 完整安装包（含扩展 + Native Host）
`;

  let releaseCreated = false;

  if (!isDryRun) {
    try {
      const noteFile = path.join(__dirname, 'dist', '_release_notes.md');
      fs.writeFileSync(noteFile, releaseNotes, 'utf8');

      runCmd(
        `${GH_BIN} release create v${version} ` +
        `"${crxFile}" "${versionedZip}" ` +
        `--repo ${GITHUB_REPO} ` +
        `--title "插件工作箱 v${version}" ` +
        `--notes-file "${noteFile}"`
      );

      fs.unlinkSync(noteFile);
      fs.unlinkSync(versionedZip);

      releaseCreated = true;
      console.log('  ✅ GitHub Release 创建成功: v' + version);
      console.log(`     ${REPO_URL}/releases/tag/v${version}`);
    } catch (e) {
      console.error('❌ GitHub 备份失败！');
      console.error('   错误:', e.message);
      console.log('  ⚠️  跳过 GitHub 备份，继续 CloudBase 部署...');
    }
  } else {
    console.log('  (预演模式，跳过 GitHub 备份)');
    releaseCreated = true;
  }
  console.log('');

  // ─── 6. 部署到 CloudBase ─────────────────────────────────────────
  console.log('☁️  [6/11] 部署到 CloudBase...');
  if (!isDryRun) {
    let deploySuccess = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        runCmd(`cloudbase hosting deploy "${DIST_DIR}" extensions/toolbox --envId ${ENV_ID}`);
        deploySuccess = true;
        console.log('');
        break;
      } catch (e) {
        if (attempt < 3) {
          console.log(`  ⚠️  部署失败，第 ${attempt} 次重试（等待 60 秒）...`);
          await new Promise(resolve => setTimeout(resolve, 60000));
        } else {
          console.error('❌ CloudBase 部署失败（已重试 3 次）！');
          console.error('   错误:', e.message);

          // 清理已创建的 GitHub Release（避免孤立的 Release）
          if (releaseCreated) {
            console.log('');
            console.log('🗑️  清理已创建的 GitHub Release...');
            try {
              runCmdSilent(`${GH_BIN} release delete v${version} --repo ${GITHUB_REPO} --yes 2>&1`);
              console.log('  ✅ 已删除 GitHub Release v' + version);
            } catch (e2) {
              console.log('  ⚠️  无法删除 GitHub Release: ' + e2.message);
              console.log('   请手动删除: ' + REPO_URL + '/releases/tag/v' + version);
            }
          }

          process.exit(1);
        }
      }
    }
  } else {
    console.log('  (预演模式，跳过 CloudBase 部署)');
  }
  console.log('');

  // ─── 7. 验证云端部署 ─────────────────────────────────────────────
  console.log('🔍 [7/11] 验证部署...');
  if (!isDryRun) {
    let validationPassed = true;

    try {
      const updateUrl = `${BASE_URL}/extensions/toolbox/update.xml`;
      const res = await httpGet(updateUrl);

      if (res.status !== 200) {
        console.error('❌ 验证失败！HTTP', res.status);
        process.exit(1);
      }

      // 匹配 version="2.2.81" 或 version='2.2.81'（双引号或单引号）
      const cloudMatch = res.body.match(/version\s*=\s*['"]([^'"]+)['"]/);
      const cloudVersion = cloudMatch ? cloudMatch[1] : '';

      if (cloudVersion !== version) {
        console.log('  ⚠️  版本号验证警告！');
        console.log('    云端版本: v' + (cloudVersion || '(无法解析)'));
        console.log('    本地版本: v' + version);
        console.log('    ⚠️  可能原因：CDN 缓存未刷新，部署可能实际已成功');
        validationPassed = false;
      } else {
        console.log('  ✅ 版本号验证通过！云端版本: v' + cloudVersion);
      }

      // 加强验证：检查 .crx 文件是否可下载
      const codebaseMatch = res.body.match(/codebase\s*=\s*['"]([^'"]+)['"]/);
      if (codebaseMatch) {
        const crxUrl = codebaseMatch[1];
        console.log('  🔍 检查 .crx 文件可下载性...');
        try {
          const headRes = await httpHead(crxUrl);
          if (headRes.status === 200) {
            const fileSize = headRes.headers['content-length'] || '未知';
            console.log('  ✅ .crx 文件可下载 (HTTP 200, 大小: ' + fileSize + ' bytes)');
          } else {
            console.log('  ⚠️  .crx 文件检查失败 (HTTP ' + headRes.status + ')');
            validationPassed = false;
          }
        } catch (e) {
          console.log('  ⚠️  .crx 文件检查失败: ' + e.message);
          validationPassed = false;
        }
      } else {
        console.log('  ⚠️  无法从 update.xml 解析 .crx 文件 URL');
        validationPassed = false;
      }

      if (!validationPassed) {
        console.log('  ⚠️  部署验证未完全通过，请手动检查: ' + updateUrl);
      }
    } catch (e) {
      console.error('❌ 验证请求失败:', e.message);
      console.log('  ⚠️  部署可能成功但无法验证，请手动检查');
    }
  } else {
    console.log('  (预演模式，跳过验证)');
  }
  console.log('');

  // ─── 8. 清理旧版本文件 ──────────────────────────────────────────
  console.log('🗑️  [8/11] 清理本地旧版本文件...');
  const files = fs.readdirSync(DIST_DIR);

  // 收集所有版本化文件，按版本号分组
  const versionMap = {};
  files.forEach(f => {
    const match = f.match(/^toolbox-(v[\d.]+)/);
    if (match) {
      const v = match[1];
      if (!versionMap[v]) versionMap[v] = [];
      versionMap[v].push(f);
    }
  });

  // 按版本号排序（新→旧）
  const allVersions = Object.keys(versionMap).sort((a, b) => {
    const aParts = a.slice(1).split('.').map(Number);
    const bParts = b.slice(1).split('.').map(Number);
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      if ((aParts[i] || 0) !== (bParts[i] || 0)) {
        return (bParts[i] || 0) - (aParts[i] || 0);
      }
    }
    return 0;
  });

  // 保留最新 KEEP_VERSIONS 个版本（含当前版本）
  const keepCount = KEEP_VERSIONS + 1;  // +1 是因为包含当前版本
  const keepVersions = new Set(allVersions.slice(0, keepCount));
  const deleteFiles = [];

  allVersions.forEach(v => {
    if (!keepVersions.has(v)) {
      versionMap[v].forEach(f => deleteFiles.push(f));
    }
  });

  if (deleteFiles.length > 0) {
    if (!isDryRun) {
      deleteFiles.forEach(f => {
        fs.unlinkSync(path.join(DIST_DIR, f));
        console.log(`  🗑️  删除: ${f}`);
      });
    } else {
      console.log('  (预演模式，将删除以下文件:)');
      deleteFiles.forEach(f => console.log(`     ${f}`));
    }
    console.log(`  ✅ 已删除 ${deleteFiles.length} 个旧版本文件（保留最新 ${KEEP_VERSIONS} 个版本）`);
  } else {
    console.log('  ℹ️  没有旧版本文件需要清理');
  }
  console.log('');

  // ─── 9. 写部署日志 ──────────────────────────────────────────────
  console.log('📋 [9/11] 写部署日志...');
  if (!isDryRun) {
    const crxStats = fs.statSync(crxFile);
    const crxSize = crxStats.size;
    const logFile = path.join(__dirname, DEPLOY_LOG_FILE);
    const logEntry = `[${nowStr()}] v${version}  CloudBase:成功  GitHub:${releaseCreated ? '成功' : '失败'}  SIZE:${crxSize}\n`;
    fs.appendFileSync(logFile, logEntry);
    console.log('  ✅ 部署日志已写入:', DEPLOY_LOG_FILE);
  } else {
    console.log('  (预演模式，跳过写日志)');
  }
  console.log('');

  // ─── 10. Git 提交并推送 ─────────────────────────────────────────
  console.log('📤 [10/11] Git 提交并推送...');
  if (!isDryRun) {
    try {
      // 检查是否有改动
      const status = runCmdSilent('git status --porcelain 2>&1');
      if (!status) {
        console.log('  ℹ️  没有文件改动，跳过 Git 提交');
      } else {
        runCmd('git add -A');
        runCmd(`git commit -m "chore: deploy v${version}"`);
        console.log('  ✅ Git 提交完成');

        // 用 Token 推送（避免 git credential 问题）
        const token = GITHUB_TOKEN || '';
        if (token) {
          const [owner] = GITHUB_REPO.split('/');
          const authUrl = `https://${owner}:${token}@github.com/${GITHUB_REPO}.git`;
          runCmd(`git push ${authUrl} master 2>&1`);
        } else {
          runCmd(`git push origin master 2>&1`);
        }
        console.log('  ✅ Git 推送完成');
      }
    } catch (e) {
      console.log('  ⚠️  Git 操作失败（不影响部署）:', e.message);
    }
  } else {
    console.log('  (预演模式，跳过 Git 提交)');
  }
  console.log('');

  // ─── 11. 发送通知 ───────────────────────────────────────────────
  console.log('🔔 [11/11] 发送通知...');
  sendNotification('部署完成', `插件工作箱 v${version} 已部署到云端`);
  console.log('  ✅ Windows 通知已发送');
  console.log('');

  // ─── 完成 ───────────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════');
  console.log('✅ 部署完成！');
  console.log('');
  console.log('  版本: v' + version);
  console.log('  CloudBase: ' + BASE_URL + '/extensions/toolbox/');
  if (releaseCreated) {
    console.log('  GitHub: ' + REPO_URL + '/releases/tag/v' + version);
  }
  console.log('');
}

// ─── 启动 ─────────────────────────────────────────────────────────────
main().catch(e => {
  console.error('❌ 部署失败！');
  console.error('   错误:', e.message);
  process.exit(1);
});
