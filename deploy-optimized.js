/**
 * 浏览器插件管理 — 一键部署脚本（优化版）
 *
 * 流程：
 *   1. 环境检查（gh CLI、GitHub 登录、CloudBase CLI、Git 仓库）
 *   2. 打包（调用 build.js）
 *   3. 版本一致性检查
 *   4. 检查 GitHub Release 是否已存在
 *   5. 备份到 GitHub Releases（历史版本存档）
 *   6. 部署到 CloudBase（只推送最新版本）
 *   7. 验证云端部署（update.xml + .crx 文件可下载性）
 *   8. 包体积检查（异常增长警告）
 *   9. 清理本地旧版本文件
 *  10. 写部署日志
 *  11. Git 提交并推送版本号更新
 *  12. 发送 Windows 通知
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

// ─── 回滚功能 ─────────────────────────────────────────────────────────
async function rollback(targetVersion) {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   插件工作箱 — 回滚到 v' + targetVersion.padEnd(12) + '║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  // 1. 从 GitHub Releases 下载指定版本的 .crx 文件
  console.log('📥 [1/4] 从 GitHub Releases 下载 v' + targetVersion + '...');
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
  console.log('📝 [2/4] 更新 update.xml 和 update.json...');

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

  // 4. 部署到 CloudBase
  console.log('');
  console.log('☁️  [3/4] 部署到 CloudBase...');
  try {
    runCmd(`cloudbase hosting deploy "${DIST_DIR}" extensions/toolbox --envId ${ENV_ID}`);
    console.log('  ✅ 部署成功！');
  } catch (e) {
    console.error('❌ 部署失败:', e.message);
    process.exit(1);
  }

  // 5. 验证部署
  console.log('');
  console.log('🔍 [4/4] 验证部署...');
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

  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log('✅ 回滚完成！');
  console.log('');
  console.log('   版本: v' + targetVersion);
  console.log('   CloudBase: ' + BASE_URL + '/extensions/toolbox/');
  console.log('');

  // 发送通知
  if (ENABLE_NOTIFICATION) {
    sendNotification('回滚完成', `插件工作箱已回滚到 v${targetVersion}`);
  }
}

// ─── Windows 通知 ─────────────────────────────────────────────────────
function sendNotification(title, message) {
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
    fs.unlinkSync(tmpFile);
  } catch (e) {
    // 通知发送失败不影响部署
  }
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
  console.log('🔍 [1/12] 环境检查...');

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
  console.log('📦 [2/12] 打包中...');
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
