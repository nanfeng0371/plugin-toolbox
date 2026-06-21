/**
 * 浏览器插件管理 — Chrome 扩展打包脚本（学习报告插件）
 *
 * 流程：
 * 1. 读取 manifest.json 获取版本号
 * 2. 用 Chrome 打包 .crx（需要私钥 .pem）
 * 3. 生成 update.xml（Chrome 自动更新检查文件）
 * 4. 更新 versions.json（版本历史）
 * 5. 输出到 dist/ 目录，准备好上传到 CloudBase 静态托管
 *
 * 用法:
 *   node build.js                     # 默认打包 plugins/toolbox
 *   node build.js --src report       # 打包指定子插件目录
 *   node build.js --init             # 首次使用：生成私钥 .pem
 *
 * CloudBase 上传:
 *   cloudbase hosting deploy dist/extensions/toolbox extensions/toolbox --envId renewal-calendar-7ff2rtj4f876144
 *
 * 伙伴安装后 Chrome 会自动检查:
 *   https://renewal-calendar-7ff2rtj4f876144-1259283480.tcloudbaseapp.com/extensions/toolbox/update.xml
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');

// ─── 配置（用 let，支持 --src 动态切换）────────────────────────────
let BASE_URL = 'https://renewal-calendar-7ff2rtj4f876144-1259283480.tcloudbaseapp.com';
let EXT_ID = 'toolbox'; // 插件标识（用于 update.xml 和目录名）
let EXT_NAME = '插件工作箱';

let SRC_DIR = path.join(__dirname, 'plugins', 'toolbox');
let DIST_DIR = path.join(__dirname, 'dist', 'extensions', EXT_ID);
let KEY_FILE = path.join(__dirname, 'key.pem');
let MANIFEST_PATH = path.join(SRC_DIR, 'manifest.json');
let VERSIONS_PATH = path.join(__dirname, 'versions.json');
let EXT_CHROME_ID = 'nmpdifejooglhkcilhgjkhggbioalojk'; // Chrome Extension ID

// ─── 各子插件配置（--src 切换）──────────────────────────────────────
const PLUGIN_CONFIGS = {
  toolbox: {
    id: 'toolbox',
    name: '插件工作箱',
    src: 'toolbox',
    keyFile: 'key.pem',
    extId: 'nmpdifejooglhkcilhgjkhggbioalojk', // 由 key.pem 计算出的 Chrome Extension ID
  },
  report: {
    id: 'report-fetcher',
    name: '学习报告批量分析',
    src: 'report',
    keyFile: 'key-report.pem',
    extId: null, // TODO: 由 key-report.pem 计算
  },
  dingtalk: {
    id: 'dingtalk-table',
    name: '页面表格提取工具',
    src: 'dingtalk',
    keyFile: 'key-dingtalk.pem',
    extId: null,
  },
  devtools: {
    id: 'devtools-monitor',
    name: '网络监控（调试）',
    src: 'devtools',
    keyFile: 'key-devtools.pem',
    extId: null,
  },
};

// ─── 工具函数 ─────────────────────────────────────────────────────────
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getVersion() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  return manifest.version;
}

function setVersion(version) {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  manifest.version = version;
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return version;
}

/** 递增版本号：x.y.z → 按指定级别递增 */
function bumpVersion(version, level = 'patch') {
  const [major, minor, patch] = version.split('.').map(Number);
  if (level === 'major') return `${major + 1}.0.0`;
  if (level === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** 检查版本是否已在 versions.json 中（即已打包过） */
function isVersionPublished(version) {
  if (!fs.existsSync(VERSIONS_PATH)) return false;
  try {
    const versions = JSON.parse(fs.readFileSync(VERSIONS_PATH, 'utf8'));
    return versions.some(v => v.version === version);
  } catch (e) {
    return false;
  }
}

// 纯 Node.js 实现目录打包为 zip（无需外部依赖）
// 生成标准的 ZIP 格式，包含 local file headers + central directory
function createZipFromDir(srcDir, zipPrefix = '') {
  const chunks = [];
  const files = [];

  function walkDir(dir, basePath) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const zipPath = basePath ? basePath + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        walkDir(fullPath, zipPath);
      } else if (entry.isFile()) {
        const content = fs.readFileSync(fullPath);
        files.push({ name: zipPath, content, mtime: fs.statSync(fullPath).mtime });
      }
    }
  }

  walkDir(srcDir, zipPrefix);

  const localFileHeaders = [];
  const centralDirEntries = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const crc = crc32(file.content);

    // Local file header
    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0);  // signature
    localHeader.writeUInt16LE(20, 4);            // version needed
    localHeader.writeUInt16LE(0x0800, 6);        // flags (bit 3 = use data descriptor)
    localHeader.writeUInt16LE(0, 8);             // compression (stored)
    const dosDT = toDosDateTime(file.mtime);
    localHeader.writeUInt16LE(dosDT.time, 10);   // mod time
    localHeader.writeUInt16LE(dosDT.date, 12);   // mod date
    localHeader.writeUInt32LE(crc, 14);          // crc32
    localHeader.writeUInt32LE(file.content.length, 18); // compressed size
    localHeader.writeUInt32LE(file.content.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);      // file name length
    localHeader.writeUInt16LE(0, 28);            // extra field length
    nameBuf.copy(localHeader, 30);

    localFileHeaders.push(localHeader);
    localFileHeaders.push(file.content);

    // Central directory entry
    const cdEntry = Buffer.alloc(46 + nameBuf.length);
    cdEntry.writeUInt32LE(0x02014b50, 0);        // signature
    cdEntry.writeUInt16LE(20, 4);                 // version made by
    cdEntry.writeUInt16LE(20, 6);                 // version needed
    cdEntry.writeUInt16LE(0x0800, 8);             // flags
    cdEntry.writeUInt16LE(0, 10);                 // compression
    cdEntry.writeUInt16LE(dosDT.time, 12);        // mod time
    cdEntry.writeUInt16LE(dosDT.date, 14);        // mod date
    cdEntry.writeUInt32LE(crc, 16);               // crc32
    cdEntry.writeUInt32LE(file.content.length, 20);  // compressed size
    cdEntry.writeUInt32LE(file.content.length, 24);  // uncompressed size
    cdEntry.writeUInt16LE(nameBuf.length, 28);    // file name length
    cdEntry.writeUInt16LE(0, 30);                 // extra field length
    cdEntry.writeUInt16LE(0, 32);                 // file comment length
    cdEntry.writeUInt16LE(0, 34);                 // disk number start
    cdEntry.writeUInt16LE(0, 36);                 // internal attributes
    cdEntry.writeUInt32LE(0, 38);                 // external attributes
    cdEntry.writeUInt32LE(offset, 42);            // relative offset
    nameBuf.copy(cdEntry, 46);

    centralDirEntries.push(cdEntry);
    offset += localHeader.length + file.content.length;
  }

  const centralDir = Buffer.concat(centralDirEntries);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);              // signature
  eocd.writeUInt16LE(0, 4);                        // disk number
  eocd.writeUInt16LE(0, 6);                        // disk with CD
  eocd.writeUInt16LE(files.length, 8);             // entries on disk
  eocd.writeUInt16LE(files.length, 10);            // total entries
  eocd.writeUInt32LE(centralDir.length, 12);       // CD size
  eocd.writeUInt32LE(offset, 16);                  // CD offset
  eocd.writeUInt16LE(0, 20);                       // comment length

  return Buffer.concat([...localFileHeaders, centralDir, eocd]);
}

// CRC32 计算
const crc32Table = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = crc32Table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Unix time → DOS date/time（返回 { time, date } 两个 16-bit 值）
function toDosDateTime(d) {
  const sec = Math.floor(d.getUTCSeconds() / 2);
  const min = d.getUTCMinutes();
  const hour = d.getUTCHours();
  const day = d.getUTCDate();
  const month = d.getUTCMonth() + 1;
  const year = d.getUTCFullYear() - 1980;
  return {
    time: sec | (min << 5) | (hour << 11),
    date: day | (month << 5) | (year << 9),
  };
}

// ─── Step 1: 生成私钥（仅首次）───────────────────────────────────────
function initKey() {
  if (fs.existsSync(KEY_FILE)) {
    console.log('  key.pem 已存在，跳过生成。');
    return;
  }
  console.log('  🔑 生成私钥 key.pem（仅首次，请妥善保管！）');
  // 使用 openssl 生成 RSA 私钥
  execSync('openssl genrsa -out key.pem 2048', { cwd: __dirname, stdio: 'inherit' });
  console.log('  ✅ key.pem 已生成。此文件是扩展的身份证，每次打包必须用同一个！');
  console.log('  ⚠️  请将 key.pem 备份到安全位置。');
}

// ─── Step 2: 打包 .crx ────────────────────────────────────────────────
function packCrx(version) {
  console.log(`\n[2/4] 打包 .crx (v${version})...`);

  ensureDir(DIST_DIR);

  const crxFile = `${EXT_ID}-v${version}.crx`;
  const crxPath = path.join(DIST_DIR, crxFile);

  // Chrome 扩展打包：用 Chrome 浏览器打包目录
  // 方式：把扩展目录打包为 zip，然后生成 .crx 头
  // 注意：.crx 格式 = "Cr24" magic(4) + version(4) + pubkey_len(4) + sig_len(4) + pubkey + sig + zip_content

  // 先用 openssl 导出公钥
  const pubkeyPath = path.join(__dirname, 'key.pub');
  execSync(`openssl rsa -in "${KEY_FILE}" -pubout -out "${pubkeyPath}" 2>NUL`, { cwd: __dirname });

  const pubkeyDer = execSync(`openssl rsa -pubin -in "${pubkeyPath}" -outform DER`, { cwd: __dirname, maxBuffer: 10*1024*1024 });
  fs.unlinkSync(pubkeyPath);

  // 打包扩展目录为 zip（纯 Node.js 实现，无需外部依赖）
  const zipPath = path.join(__dirname, 'dist', 'temp.zip');
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  const zipContent = createZipFromDir(SRC_DIR);
  fs.writeFileSync(zipPath, zipContent);

  // 签名 zip 内容
  const signResult = execSync(
    `openssl dgst -sha256 -sign "${KEY_FILE}"`,
    { cwd: __dirname, input: zipContent, maxBuffer: 10*1024*1024 }
  );

  // 构建 .crx 文件
  // Magic: "Cr24", Version: 2 (or 3)
  const magic = Buffer.from('Cr24', 'ascii');
  const versionBuf = Buffer.alloc(4);
  versionBuf.writeUInt32LE(3, 0); // CRX version 3
  const pubkeyLenBuf = Buffer.alloc(4);
  pubkeyLenBuf.writeUInt32LE(pubkeyDer.length, 0);
  const sigLenBuf = Buffer.alloc(4);
  sigLenBuf.writeUInt32LE(signResult.length, 0);

  const crxContent = Buffer.concat([
    magic,
    versionBuf,
    pubkeyLenBuf,
    sigLenBuf,
    pubkeyDer,
    signResult,
    zipContent,
  ]);

  fs.writeFileSync(crxPath, crxContent);
  fs.unlinkSync(zipPath);

  const sizeKB = (crxContent.length / 1024).toFixed(1);
  console.log(`  ✅ ${crxFile} (${sizeKB} KB)`);
  return crxFile;
}

// ─── Step 2.5: 打包扩展为 ZIP（用于 Native Host 安装）────────────
function packZip(version) {
  console.log(`\n[2.5/4] 打包 .zip (v${version})...`);

  const zipFile = `${EXT_ID}-latest.zip`;
  const zipPath = path.join(DIST_DIR, zipFile);

  // 创建临时 staging 目录，组装完整安装包内容
  const stagingDir = path.join(__dirname, 'dist', '_staging');
  const extStage = path.join(stagingDir, 'toolbox');
  const hostStage = path.join(stagingDir, 'native-host');

  // 清理并重建
  if (fs.existsSync(stagingDir)) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
  fs.mkdirSync(stagingDir, { recursive: true });

  // 1) 复制扩展源码 → staging/toolbox/
  function copyDir(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const srcPath = path.join(src, entry.name);
      const dstPath = path.join(dst, entry.name);
      if (entry.isDirectory()) {
        copyDir(srcPath, dstPath);
      } else {
        fs.copyFileSync(srcPath, dstPath);
      }
    }
  }
  copyDir(SRC_DIR, extStage);

  // 2) 复制 native-host/（仅打包必需文件：exe + manifest）
  const nativeHostSrc = path.join(__dirname, 'native-host');
  if (fs.existsSync(nativeHostSrc)) {
    fs.mkdirSync(hostStage, { recursive: true });
    // 只复制 exe 和 manifest JSON，排除 Python 源码/bat/build 临时目录
    const hostFiles = [
      'toolbox-updater.exe',
      'com.toolbox.updater.json',
    ];
    for (const f of hostFiles) {
      const src = path.join(nativeHostSrc, f);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(hostStage, f));
      }
    }
  }

  // 3) 复制 install.bat
  const installBatSrc = path.join(__dirname, 'install.bat');
  if (fs.existsSync(installBatSrc)) {
    fs.copyFileSync(installBatSrc, path.join(stagingDir, 'install.bat'));
  }

  // 4) 写入安装说明
  const readme = `插件工作箱 v${version} — 安装说明
========================================
1. 右键 install.bat → "以管理员身份运行"
   （自动注册 Chrome/Edge 的 Native Messaging Host）

2. 打开 Chrome/Edge → 地址栏输入 chrome://extensions
   → 右上角开启【开发者模式】
   → 点击【加载已解压的扩展程序】
   → 选择本文件夹内的 "toolbox" 文件夹

3. 安装完成！插件图标将出现在浏览器工具栏。

4. 后续更新：点击侧边栏 "🔄 检查更新" → 安装 → 重新加载

注意事项：
- Windows 首次运行 PowerShell 脚本时可能需要允许执行策略
- 如果安装后扩展未出现，请刷新 extensions 页面
`;
  fs.writeFileSync(path.join(stagingDir, 'README.txt'), readme, 'utf8');

  // 打包 staging 目录
  const zipContent = createZipFromDir(stagingDir);
  fs.writeFileSync(zipPath, zipContent);

  // 清理 staging
  fs.rmSync(stagingDir, { recursive: true, force: true });

  const sizeKB = (zipContent.length / 1024).toFixed(1);
  console.log(`  ✅ ${zipFile} (${sizeKB} KB)`);
  return zipFile;
}

// ─── Step 3: 生成 update.xml ──────────────────────────────────────────
function generateUpdateXml(version, crxFile) {
  console.log(`\n[3/4] 生成 update.xml...`);

  const crxUrl = `${BASE_URL}/extensions/${EXT_ID}/${crxFile}`;
  const crxPath = path.join(DIST_DIR, crxFile);
  const crxContent = fs.readFileSync(crxPath);

  // 生成 codebase 的 sha256（Chrome 用来校验下载完整性）
  const sha256 = crypto.createHash('sha256').update(crxContent).digest('hex');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="${EXT_CHROME_ID || EXT_ID}">
    <updatecheck
      codebase="${crxUrl}"
      version="${version}"
      hash_sha256="${sha256}"
      status="ok" />
  </app>
</gupdate>`;

  const xmlPath = path.join(DIST_DIR, 'update.xml');
  fs.writeFileSync(xmlPath, xml, 'utf8');
  console.log(`  ✅ update.xml (version=${version}, sha256=${sha256.slice(0,12)}...)`);
}

// ─── Step 3.2: 生成 update.json（Native Host 检查更新用）────────────
function generateUpdateJson(version, zipFile) {
  console.log(`\n[3.2/4] 生成 update.json（Native Host 用）...`);

  const downloadUrl = `${BASE_URL}/extensions/${EXT_ID}/${zipFile}`;
  const changelogPath = path.join(__dirname, 'CHANGELOG.md');

  let releaseNotes = '';
  if (fs.existsSync(changelogPath)) {
    releaseNotes = fs.readFileSync(changelogPath, 'utf8').slice(0, 2000);
  }

  const updateJson = {
    version: version,
    downloadUrl: downloadUrl,
    releaseNotes: releaseNotes || `v${version} 更新`,
    publishedAt: new Date().toISOString(),
    minVersion: '2.1.24',  // 最低支持的版本（Native Host 协议版本）
  };

  const jsonPath = path.join(DIST_DIR, 'update.json');
  fs.writeFileSync(jsonPath, JSON.stringify(updateJson, null, 2), 'utf8');
  console.log(`  ✅ update.json (version=${version})`);
}

// ─── Step 3.5: 生成安装文件（Chrome/Edge/夸克）────────────────────
function generateInstallReg(version) {
  if (!EXT_CHROME_ID) {
    console.log('  ⚠️  跳过安装文件（未配置 Chrome Extension ID）');
    return;
  }
  console.log(`\n[3.5/4] 生成安装文件（Chrome / Edge / 夸克）...`);

  const updateUrl = `${BASE_URL}/extensions/${EXT_ID}/update.xml`;
  const extId = EXT_CHROME_ID;

  // ─── Chrome ──────────────────────────────────────────────────────
  const chromeReg = `Windows Registry Editor Version 5.00

; ============================================================
; ${EXT_NAME} v${version} — Chrome 一键安装
; ============================================================
; 使用方法：双击此文件 → 点"是" → 重启 Chrome → 自动安装
; 卸载方法：chrome://extensions/ 删除扩展 + regedit 删除下方注册表项
; ============================================================

[HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Google\\Chrome]
[HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Google\\Chrome\\ExtensionInstallForcelist]
"1"="${extId};${updateUrl}"
`;
  fs.writeFileSync(path.join(DIST_DIR, 'install-chrome.reg'), chromeReg, 'utf8');
  console.log('  ✅ install-chrome.reg');

  // ─── Edge ─────────────────────────────────────────────────────────
  const edgeReg = `Windows Registry Editor Version 5.00

; ============================================================
; ${EXT_NAME} v${version} — Edge 一键安装
; ============================================================
; 使用方法：双击此文件 → 点"是" → 重启 Edge → 自动安装
; 卸载方法：edge://extensions/ 删除扩展 + regedit 删除下方注册表项
; ============================================================

[HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Edge]
[HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Edge\\ExtensionInstallForcelist]
"1"="${extId};${updateUrl}"
`;
  fs.writeFileSync(path.join(DIST_DIR, 'install-edge.reg'), edgeReg, 'utf8');
  console.log('  ✅ install-edge.reg');

  // ─── 全家桶（Chrome + Edge 同时安装）──────────────────────────────
  const allReg = `Windows Registry Editor Version 5.00

; ============================================================
; ${EXT_NAME} v${version} — Chrome + Edge 一键安装
; ============================================================
; 使用方法：双击此文件 → 点"是" → 重启浏览器 → 自动安装
; 卸载方法：浏览器扩展页删除 + regedit 删除对应注册表项
; ============================================================

[HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Google\\Chrome]
[HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Google\\Chrome\\ExtensionInstallForcelist]
"1"="${extId};${updateUrl}"

[HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Edge]
[HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Edge\\ExtensionInstallForcelist]
"1"="${extId};${updateUrl}"
`;
  fs.writeFileSync(path.join(DIST_DIR, 'install-all.reg'), allReg, 'utf8');
  console.log('  ✅ install-all.reg（Chrome + Edge 同时安装）');

  // ─── HKCU 版本（无需管理员权限）───────────────────────────────────
  const chromeUserReg = `Windows Registry Editor Version 5.00

; ============================================================
; ${EXT_NAME} v${version} — Chrome 一键安装（当前用户版，无需管理员）
; ============================================================
; 如果 HKLM 版本导入后没效果，用这个版本试试
; ============================================================

[HKEY_CURRENT_USER\\SOFTWARE\\Policies\\Google\\Chrome]
[HKEY_CURRENT_USER\\SOFTWARE\\Policies\\Google\\Chrome\\ExtensionInstallForcelist]
"1"="${extId};${updateUrl}"
`;
  fs.writeFileSync(path.join(DIST_DIR, 'install-chrome-user.reg'), chromeUserReg, 'utf8');
  console.log('  ✅ install-chrome-user.reg（无需管理员权限）');

  const edgeUserReg = `Windows Registry Editor Version 5.00

; ============================================================
; ${EXT_NAME} v${version} — Edge 一键安装（当前用户版，无需管理员）
; ============================================================
; 如果 HKLM 版本导入后没效果，用这个版本试试
; ============================================================

[HKEY_CURRENT_USER\\SOFTWARE\\Policies\\Microsoft\\Edge]
[HKEY_CURRENT_USER\\SOFTWARE\\Policies\\Microsoft\\Edge\\ExtensionInstallForcelist]
"1"="${extId};${updateUrl}"
`;
  fs.writeFileSync(path.join(DIST_DIR, 'install-edge-user.reg'), edgeUserReg, 'utf8');
  console.log('  ✅ install-edge-user.reg（无需管理员权限）');

  const allUserReg = `Windows Registry Editor Version 5.00

; ============================================================
; ${EXT_NAME} v${version} — Chrome + Edge 同时安装（当前用户版，无需管理员）
; ============================================================
; ============================================================

[HKEY_CURRENT_USER\\SOFTWARE\\Policies\\Google\\Chrome]
[HKEY_CURRENT_USER\\SOFTWARE\\Policies\\Google\\Chrome\\ExtensionInstallForcelist]
"1"="${extId};${updateUrl}"

[HKEY_CURRENT_USER\\SOFTWARE\\Policies\\Microsoft\\Edge]
[HKEY_CURRENT_USER\\SOFTWARE\\Policies\\Microsoft\\Edge\\ExtensionInstallForcelist]
"1"="${extId};${updateUrl}"
`;
  fs.writeFileSync(path.join(DIST_DIR, 'install-all-user.reg'), allUserReg, 'utf8');
  console.log('  ✅ install-all-user.reg（Chrome + Edge，无需管理员权限）');

  // ─── 夸克浏览器 ZIP 包（开发者模式加载）─────────────────────────
  const zipFileName = `${EXT_ID}-v${version}-quark.zip`;
  const zipPath = path.join(DIST_DIR, zipFileName);
  const zipContent = createZipFromDir(SRC_DIR, 'toolbox');
  fs.writeFileSync(zipPath, zipContent);
  const sizeKB = (zipContent.length / 1024).toFixed(1);
  console.log(`  ✅ ${zipFileName} (${sizeKB} KB) — 夸克浏览器开发者模式加载用`);

  // ─── 安装说明 ────────────────────────────────────────────────────
  const readmeContent = `# ${EXT_NAME} v${version} 安装指南

## 🌐 Google Chrome
1. 双击 \`install-chrome.reg\` → 点"是"
2. 重启 Chrome → 扩展自动出现
3. 后续版本自动更新 ✅

## 📘 Microsoft Edge
**方法A（推荐，无需管理员权限）：**
1. 双击 \`install-edge-user.reg\` → 点"是"
2. 重启 Edge → 扩展自动出现
3. 后续版本自动更新 ✅

**方法B（需要管理员权限）：**
1. 右键 \`install-edge.reg\` → 「以管理员身份运行」→ 点"是"
2. 重启 Edge → 扩展自动出现
3. 后续版本自动更新 ✅

> 💡 如果方法B没效果，说明注册表写入失败，请用方法A的 \`-user\` 版本

## ⚡ Chrome + Edge 同时安装
1. 双击 \`install-all-user.reg\`（无需管理员）或 \`install-all.reg\`（需管理员）

## 🔮 夸克浏览器
1. 打开 \`quark://extensions/\`（地址栏输入）
2. 右上角开启「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 先解压 \`${zipFileName}\` 到任意文件夹
5. 选择解压后的文件夹 → 完成
6. ⚠️ 夸克暂不支持自动更新，新版需重新下载解压

## 卸载
- Chrome：\`chrome://extensions/\` → 删除扩展
- Edge：\`edge://extensions/\` → 删除扩展
- 夸克：\`quark://extensions/\` → 删除扩展
- 注册表清理：按 Win+R → 输入 \`regedit\` → 删除以下路径
  - \`HKLM\\SOFTWARE\\Policies\\Google\\Chrome\\ExtensionInstallForcelist\`（管理员版）
  - \`HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\ExtensionInstallForcelist\`（管理员版）
  - \`HKCU\\SOFTWARE\\Policies\\Google\\Chrome\\ExtensionInstallForcelist\`（用户版）
  - \`HKCU\\SOFTWARE\\Policies\\Microsoft\\Edge\\ExtensionInstallForcelist\`（用户版）
`;
  fs.writeFileSync(path.join(DIST_DIR, '安装说明.md'), readmeContent, 'utf8');
  console.log('  ✅ 安装说明.md');
}
function updateVersionsJson(version, crxFile, isNewVersion = false) {
  console.log(`\n[4/4] 更新 versions.json...`);

  let versions = [];
  if (fs.existsSync(VERSIONS_PATH)) {
    try {
      versions = JSON.parse(fs.readFileSync(VERSIONS_PATH, 'utf8'));
    } catch (e) {
      versions = [];
    }
  }

  // 检查是否已有此版本
  const existing = versions.find(v => v.version === version);
  if (existing) {
    console.log(`  ⚠️  v${version} 已存在，更新时间戳和文件引用。`);
    existing.buildTime = new Date().toISOString();
    existing.file = crxFile;
    existing.rebuildCount = (existing.rebuildCount || 0) + 1;
  } else {
    versions.unshift({
      version,
      buildTime: new Date().toISOString(),
      file: crxFile,
      changes: [],
      rebuildCount: 0,
    });
    console.log(`  ✅ 新增版本记录 v${version}`);
  }

  fs.writeFileSync(VERSIONS_PATH, JSON.stringify(versions, null, 2), 'utf8');
  console.log(`  ✅ versions.json (${versions.length} 个版本)`);
}

// ─── Main ─────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const isInit = args.includes('--init');
  const isList = args.includes('--list');
  const noBump = args.includes('--no-bump');
  const bumpIdx = args.indexOf('--bump');
  const bumpLevel = bumpIdx >= 0 ? (args[bumpIdx + 1] || 'patch') : null;
  const versionIdx = args.indexOf('--version');
  const manualVersion = versionIdx >= 0 ? args[versionIdx + 1] : null;

  // ─── --src: 切换打包目标子插件 ─────────────────────────────
  const srcIdx = args.indexOf('--src');
  const srcKey = srcIdx >= 0 ? (args[srcIdx + 1] || 'toolbox') : 'toolbox';
  const pluginConfig = PLUGIN_CONFIGS[srcKey];
  if (!pluginConfig) {
    console.error(`❌ 未知的子插件: ${srcKey}`);
    console.error(`   支持的子插件: ${Object.keys(PLUGIN_CONFIGS).join(', ')}`);
    process.exit(1);
  }
  EXT_ID = pluginConfig.id;
  EXT_NAME = pluginConfig.name;
  SRC_DIR = path.join(__dirname, 'plugins', pluginConfig.src);
  DIST_DIR = path.join(__dirname, 'dist', 'extensions', EXT_ID);
  KEY_FILE = path.join(__dirname, pluginConfig.keyFile);
  MANIFEST_PATH = path.join(SRC_DIR, 'manifest.json');
  EXT_CHROME_ID = pluginConfig.extId; // Chrome Extension ID（用于 update.xml appid 和 install.reg）
  // ─────────────────────────────────────────────────────────────

  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   浏览器插件管理 — Chrome 扩展打包脚本   ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  // --list: 只显示版本历史，不打包
  if (isList) {
    const currentVersion = getVersion();
    console.log(`📦 当前 manifest 版本: v${currentVersion}`);
    console.log('');
    console.log('📋 版本历史:');
    if (fs.existsSync(VERSIONS_PATH)) {
      try {
        const versions = JSON.parse(fs.readFileSync(VERSIONS_PATH, 'utf8'));
        versions.slice(0, 10).forEach((v, i) => {
          const time = new Date(v.buildTime).toLocaleString('zh-CN');
          const flag = v.version === currentVersion ? ' ← current' : '';
          console.log(`   ${i + 1}. v${v.version}  ${time}  ${v.file}${flag}`);
        });
        if (versions.length > 10) {
          console.log(`   ... 共 ${versions.length} 个版本`);
        }
      } catch (e) {
        console.log('   (读取失败)');
      }
    } else {
      console.log('   (暂无版本记录)');
    }
    console.log('');
    console.log('💡 用法:');
    console.log('   node build.js              # 自动递增 patch 打包');
    console.log('   node build.js --bump minor # 递增 minor 版本');
    console.log('   node build.js --version 2.1.0  # 指定版本号');
    console.log('   node build.js --no-bump    # 不更新版本号，直接打包');
    console.log('   node build.js --list       # 查看版本历史（不打包）');
    console.log('');
    return;
  }

  if (isInit) {
    initKey();
    console.log('');
    console.log('✅ 初始化完成！下次运行 node build.js 即可打包。');
    console.log('');
    console.log('📖 用法示例:');
    console.log('   node build.js              # 自动递增 patch 版本并打包');
    console.log('   node build.js --bump minor # 递增 minor 版本');
    console.log('   node build.js --version 2.1.0  # 指定版本号');
    console.log('   node build.js --no-bump    # 测试打包，不更新版本号');
    console.log('');
    return;
  }

  if (!fs.existsSync(KEY_FILE)) {
    console.error('❌ 未找到 key.pem，请先运行: node build.js --init');
    process.exit(1);
  }

  let version = getVersion();
  let versionChanged = false;

  // 版本号决策逻辑
  if (manualVersion) {
    // 手动指定版本
    if (manualVersion !== version) {
      version = setVersion(manualVersion);
      versionChanged = true;
      console.log(`📝 手动设置版本: v${version}`);
    }
  } else if (bumpLevel) {
    // 显式 --bump 参数
    const newVersion = bumpVersion(version, bumpLevel);
    version = setVersion(newVersion);
    versionChanged = true;
    console.log(`⬆️  递增 ${bumpLevel} 版本: ${getVersion()} → v${version}`);
  } else if (!noBump) {
    // 默认行为：如果当前版本已发布过，自动递增 patch
    if (isVersionPublished(version)) {
      const newVersion = bumpVersion(version, 'patch');
      console.log(`⚠️  版本 v${version} 已发布过，自动递增 patch: ${version} → ${newVersion}`);
      version = setVersion(newVersion);
      versionChanged = true;
    } else {
      console.log(`📦 当前版本: v${version}（首次打包）`);
    }
  } else {
    console.log(`📦 当前版本: v${version}（--no-bump 模式，不更新版本号）`);
  }

  if (versionChanged) {
    console.log(`✅ manifest.json 已更新为 v${version}`);
  }

  console.log(`📁 扩展目录: ${EXT_NAME}`);

  const crxFile = packCrx(version);
  const zipFile = packZip(version);
  generateUpdateXml(version, crxFile);
  generateUpdateJson(version, zipFile);
  generateInstallReg(version);
  updateVersionsJson(version, crxFile, versionChanged);
  cleanOldVersions(10);

  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log('✅ 打包完成！');
  console.log('');
  console.log('📦 产物:');
  console.log(`   dist/extensions/${EXT_ID}/`);
  console.log(`   ├── ${crxFile}`);
  console.log(`   ├── update.xml`);
  if (EXT_CHROME_ID) {
    console.log(`   ├── install-chrome.reg      ← Chrome 一键安装（需管理员）`);
    console.log(`   ├── install-edge.reg        ← Edge 一键安装（需管理员）`);
    console.log(`   ├── install-all.reg         ← Chrome+Edge 同时安装（需管理员）`);
    console.log(`   ├── install-chrome-user.reg ← Chrome 一键安装（无需管理员）`);
    console.log(`   ├── install-edge-user.reg   ← Edge 一键安装（无需管理员）★推荐`);
    console.log(`   ├── install-all-user.reg    ← Chrome+Edge 同时安装（无需管理员）`);
    console.log(`   ├── ${EXT_ID}-v${version}-quark.zip  ← 夸克开发者模式加载`);
    console.log(`   └── 安装说明.md`);
  }
  console.log('');
  console.log('🚀 上传到 CloudBase:');
  console.log(`   cloudbase hosting deploy dist/extensions/${EXT_ID} extensions/${EXT_ID} --envId renewal-calendar-7ff2rtj4f876144`);
  console.log('');
  console.log('🔗 更新检查 URL（伙伴 Chrome 自动检查）:');
  console.log(`   ${BASE_URL}/extensions/${EXT_ID}/update.xml`);
  console.log('');
}

// ─── 清理旧版本文件（保留最新 N 个版本）──────────────────────────────────
function cleanOldVersions(maxVersions = 10) {
  const distDir = DIST_DIR;
  if (!fs.existsSync(distDir)) return;
  
  // 获取所有版本文件（.crx 和 -quark.zip）
  const files = fs.readdirSync(distDir).filter(f => {
    const lower = f.toLowerCase();
    return lower.match(/^toolbox-v.*\.crx$/) || lower.match(/^toolbox-v.*-quark\.zip$/);
  });
  
  // 按文件名降序排序（版本号高的在前）
  files.sort().reverse();
  
  // 跳过最新的 maxVersions 个版本（每个版本 2 个文件）
  const toDelete = files.slice(maxVersions * 2);
  
  if (toDelete.length > 0) {
    console.log(`🗑️  清理旧版本文件（保留最新 ${maxVersions} 个版本）...`);
    toDelete.forEach(f => {
      fs.unlinkSync(path.join(distDir, f));
      console.log(`   ✅ 删除 ${f}`);
    });
  }
}
main();
