/**
 * 调课助手打包脚本（基于 esbuild）+ 内容 Hash 自动化
 * 复用 EduFlow 构建模式：esbuild IIFE + content hash
 *
 * 用法: node build.js
 */

const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const SRC_DIR = path.join(__dirname, 'web', 'assets', 'js');
const ASSETS_DIR = path.join(__dirname, 'web', 'assets');
const CSS_DIR = path.join(__dirname, 'web', 'assets', 'css');
const OUT_FILE = path.join(__dirname, 'web', 'assets', 'js', 'bundle.js');
const ASSETS_INDEX = path.join(__dirname, 'web', 'assets', 'index.html');
const ROOT_INDEX = path.join(__dirname, 'web', 'index.html');

// 计算文件内容的前8位 MD5 hash
function getFileHash(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('md5').update(content).digest('hex').slice(0, 8);
}

// 清理旧的 hash 版本文件
function cleanOldHashFiles(dir, baseName, ext, currentHash) {
  const pattern = new RegExp(`^${baseName}\\.[a-f0-9]{8}\\${ext}$`);
  const files = fs.readdirSync(dir);
  let cleaned = 0;
  files.forEach(f => {
    if (pattern.test(f)) {
      const hashInName = f.replace(`${baseName}.`, '').replace(ext, '');
      if (hashInName !== currentHash) {
        fs.unlinkSync(path.join(dir, f));
        console.log(`  [clean] Removed old: ${f}`);
        cleaned++;
      }
    }
  });
  return cleaned;
}

// 更新 HTML 文件中的资源引用
// jsFile: 完整的JS引用路径（如 "assets/js/bundle.abc12345.js" 或 "js/bundle.abc12345.js"）
// cssFiles: 数组，每项 { hashRef: "assets/css/style.abc12345.css" 或 "css/style.abc12345.css" }
function updateHtmlRefs(htmlPath, jsFile, cssFiles) {
  if (!fs.existsSync(htmlPath)) {
    console.warn(`  [warn] HTML not found: ${htmlPath}`);
    return;
  }
  let html = fs.readFileSync(htmlPath, 'utf8');
  const original = html;

  // 更新 JS 引用 — 直接替换 src 属性值为完整新路径，避免正则捕获路径前缀导致嵌套
  html = html.replace(
    /(<script[^>]+src=["'])[^"']*bundle(?:\.[a-f0-9]{8})?\.js(["'][^>]*>)/g,
    `$1${jsFile}$2`
  );

  // 更新 CSS 引用 — 直接替换 href 属性值为完整新路径
  cssFiles.forEach(({ hashRef }) => {
    html = html.replace(
      /(<link[^>]+href=["'])[^"']*style(?:\.[a-f0-9]{8})?\.css(["'][^>]*>)/g,
      `$1${hashRef}$2`
    );
  });

  if (html !== original) {
    fs.writeFileSync(htmlPath, html, 'utf8');
    console.log(`  [html] Updated: ${path.basename(htmlPath)}`);
  } else {
    console.log(`  [html] No changes needed: ${path.basename(htmlPath)}`);
  }
}

async function build() {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   调课助手 Build Script  (esbuild+hash) ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  // ─── Step 1: esbuild 打包 JS ───────────────────────────────────────────────
  console.log('[1/4] Building JS bundle...');
  try {
    const result = await esbuild.build({
      entryPoints: [path.join(SRC_DIR, 'app.js')],
      bundle: true,
      outfile: OUT_FILE,
      format: 'iife',
      target: ['chrome80', 'edge80'],
      minify: false,
      keepNames: true,
      sourcemap: false,
      logLevel: 'info',
      define: {
        'process.env.NODE_ENV': '"production"',
      },
      metafile: true,
    });

    const outSize = fs.statSync(OUT_FILE).size;
    const inputs = Object.keys(result.metafile.inputs);
    console.log(`  bundle.js => ${(outSize / 1024).toFixed(2)} KB  (${inputs.length} modules)`);
  } catch (err) {
    console.error('[调课助手] Build failed:', err);
    process.exit(1);
  }

  // ─── Step 2: 计算 hash ─────────────────────────────────────────────────────
  console.log('');
  console.log('[2/4] Computing content hashes...');

  const jsHash = getFileHash(OUT_FILE);
  console.log(`  bundle.js => hash: ${jsHash}`);

  const cssFiles = ['style.css'];
  const cssHashMap = [];
  cssFiles.forEach(name => {
    const filePath = path.join(CSS_DIR, name);
    if (fs.existsSync(filePath)) {
      const hash = getFileHash(filePath);
      const ext = path.extname(name);
      const nameNoExt = name.replace(ext, '');
      const hashName = `${nameNoExt}.${hash}${ext}`;
      cssHashMap.push({ baseName: name, hash, hashName, filePath });
      console.log(`  ${name.padEnd(20)} => hash: ${hash}`);
    }
  });

  // ─── Step 3: 生成带 hash 文件名的副本 ─────────────────────────────────────
  console.log('');
  console.log('[3/4] Creating hash-named copies...');

  const jsHashFile = `bundle.${jsHash}.js`;
  const jsHashPath = path.join(SRC_DIR, jsHashFile);
  fs.copyFileSync(OUT_FILE, jsHashPath);
  console.log(`  bundle.js => ${jsHashFile}`);
  const jsClean = cleanOldHashFiles(SRC_DIR, 'bundle', '.js', jsHash);
  if (jsClean) console.log(`  (removed ${jsClean} old JS hash files)`);

  cssHashMap.forEach(({ baseName, hash, hashName, filePath }) => {
    const hashPath = path.join(CSS_DIR, hashName);
    fs.copyFileSync(filePath, hashPath);
    console.log(`  ${baseName} => ${hashName}`);
    const ext = path.extname(baseName);
    const nameNoExt = baseName.replace(ext, '');
    const cssClean = cleanOldHashFiles(CSS_DIR, nameNoExt, ext, hash);
    if (cssClean) console.log(`  (removed ${cssClean} old CSS hash files)`);
  });

  // ─── Step 4: 更新 HTML 引用 ────────────────────────────────────────────────
  console.log('');
  console.log('[4/4] Updating HTML references...');
  // assets/index.html — 路径相对于 assets/ 目录（如 css/style.hash.css, js/bundle.hash.js）
  updateHtmlRefs(ASSETS_INDEX, `js/${jsHashFile}`, cssHashMap.map(c => ({
    hashRef: `css/${c.hashName}`,
  })));
  // root index.html — 路径相对于 web/ 目录（如 assets/css/style.hash.css, assets/js/bundle.hash.js）
  updateHtmlRefs(ROOT_INDEX, `assets/js/${jsHashFile}`, cssHashMap.map(c => ({
    hashRef: `assets/css/${c.hashName}`,
  })));

  // ─── Summary ───────────────────────────────────────────────────────────────
  console.log('');
  console.log('✅ Build complete!');
  console.log(`   JS:  js/${jsHashFile}`);
  cssHashMap.forEach(c => {
    console.log(`   CSS: css/${c.hashName}`);
  });
  console.log('');
  console.log('📦 Next: 部署到 EduFlow 的 CloudBase 静态托管 /tk/ 路径');
  console.log('');
}

build();
