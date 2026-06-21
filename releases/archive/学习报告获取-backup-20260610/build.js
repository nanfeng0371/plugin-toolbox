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
 *   node build.js              # 打包（需已有 .pem）
 *   node build.js --init       # 首次使用：生成私钥 .pem
 *
 * CloudBase 上传:
 *   cloudbase hosting deploy dist extensions --envId renewal-calendar-7ff2rtj4f876144
 *
 * 伙伴安装后 Chrome 会自动检查:
 *   https://renewal-calendar-7ff2rtj4f876144-1259283480.tcloudbaseapp.com/extensions/report-fetcher/update.xml
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');

// ─── 配置 ────────────────────────────────────────────────────────────
const BASE_URL = 'https://renewal-calendar-7ff2rtj4f876144-1259283480.tcloudbaseapp.com';
const EXT_ID = 'report-fetcher'; // 插件标识（用于 update.xml 和目录名）
const EXT_NAME = '学习报告批量分析';

const SRC_DIR = path.join(__dirname, 'plugins', 'report');
const DIST_DIR = path.join(__dirname, 'dist', 'extensions', EXT_ID);
const KEY_FILE = path.join(__dirname, 'key.pem');
const MANIFEST_PATH = path.join(SRC_DIR, 'manifest.json');
const VERSIONS_PATH = path.join(__dirname, 'versions.json');

// ─── 工具函数 ─────────────────────────────────────────────────────────
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getVersion() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  return manifest.version;
}

// 纯 Node.js 实现目录打包为 zip（无需外部依赖）
// 生成标准的 ZIP 格式，包含 local file headers + central directory
function createZipFromDir(srcDir) {
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

  walkDir(srcDir, '');

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

// ─── Step 3: 生成 update.xml ──────────────────────────────────────────
function generateUpdateXml(version, crxFile) {
  console.log(`\n[3/4] 生成 update.xml...`);

  const crxUrl = `${BASE_URL}/extensions/${EXT_ID}/${crxFile}`;
  const crxPath = path.join(DIST_DIR, crxFile);
  const crxContent = fs.readFileSync(crxPath);

  // 生成 codebase 的 sha256（Chrome 用来校验下载完整性）
  const sha256 = crypto.createHash('sha256').update(crxContent).digest('hex');

  // 版本号转数字：x.y.z → x.y.z.p（Chrome update manifest 用四段式）
  // 但 update.xml 的 version 属性直接接受字符串版本号
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="${EXT_ID}">
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

// ─── Step 4: 更新 versions.json ───────────────────────────────────────
function updateVersionsJson(version, crxFile) {
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
    console.log(`  ⚠️  v${version} 已存在，更新时间戳。`);
    existing.buildTime = new Date().toISOString();
    existing.file = crxFile;
  } else {
    versions.unshift({
      version,
      buildTime: new Date().toISOString(),
      file: crxFile,
      changes: [],
    });
  }

  fs.writeFileSync(VERSIONS_PATH, JSON.stringify(versions, null, 2), 'utf8');
  console.log(`  ✅ versions.json (${versions.length} 个版本)`);
}

// ─── Main ─────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const isInit = args.includes('--init');

  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   浏览器插件管理 — 打包脚本(学习报告)   ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  if (isInit) {
    initKey();
    console.log('');
    console.log('✅ 初始化完成！下次运行 node build.js 即可打包。');
    return;
  }

  if (!fs.existsSync(KEY_FILE)) {
    console.error('❌ 未找到 key.pem，请先运行: node build.js --init');
    process.exit(1);
  }

  const version = getVersion();
  console.log(`📦 当前版本: v${version}`);
  console.log(`📁 扩展目录: ${EXT_NAME}`);

  const crxFile = packCrx(version);
  generateUpdateXml(version, crxFile);
  updateVersionsJson(version, crxFile);

  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log('✅ 打包完成！');
  console.log('');
  console.log('📦 产物:');
  console.log(`   dist/extensions/${EXT_ID}/`);
  console.log(`   ├── ${crxFile}`);
  console.log(`   └── update.xml`);
  console.log('');
  console.log('🚀 上传到 CloudBase:');
  console.log(`   cloudbase hosting deploy dist extensions --envId renewal-calendar-7ff2rtj4f876144`);
  console.log('');
  console.log('🔗 更新检查 URL（伙伴 Chrome 自动检查）:');
  console.log(`   ${BASE_URL}/extensions/${EXT_ID}/update.xml`);
  console.log('');
}
main();
