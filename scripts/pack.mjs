#!/usr/bin/env node
/* 「定位给你」打包器 —— 把整个技能目录压成一个可分发的 zip，零依赖（Node 自带 zlib）。
   用法：
     node scripts/pack.mjs                 # 输出 dist/dingwei-geini.zip
     node scripts/pack.mjs 输出目录         # 指定输出目录
     node scripts/pack.mjs --ascii-name    # 另存 dist/dingwei-geini-ascii.zip，且把 frontmatter 的
                                           # name 改成 dingwei-geini（给强制拉丁名的平台用，正文不变）
   打包内容：技能根目录下除 dist/、node_modules/、.git/ 及 .zip/.bak 外的全部文件
             （SKILL.md、README.md、图标、assets/、scripts/ 下的 .mjs 与 .py）。
*/
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FOLDER = path.basename(SKILL_ROOT);                 // zip 内根目录名，例如 dingwei-geini
const argv = process.argv.slice(2);
const asciiName = argv.includes('--ascii-name');
const outDir = path.resolve(argv.find((a) => !a.startsWith('--')) || path.join(SKILL_ROOT, 'dist'));
const SKIP_DIRS = new Set(['dist', 'node_modules', '.git', '.idea', '.vscode']);
const SKIP_EXT = new Set(['.zip', '.bak']);

/* ---------- 1. 校验 frontmatter ---------- */
const mdPath = path.join(SKILL_ROOT, 'SKILL.md');
if (!fs.existsSync(mdPath)) fail('缺少 SKILL.md');
const mdRaw = fs.readFileSync(mdPath, 'utf8');
if (!mdRaw.startsWith('---')) fail('SKILL.md 没有 YAML frontmatter（必须以 --- 开头）');
const fm = (mdRaw.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '';
const nameLine = (fm.match(/^name:\s*(.+)$/m) || [])[1] || '';
const descLine = (fm.match(/^description:\s*(.+)$/m) || [])[1] || '';
if (!nameLine) fail('frontmatter 缺 name');
if (!descLine) fail('frontmatter 缺 description');
if (/[<>]/.test(descLine)) fail('description 里不能有尖括号 < >');

/* 市场提交必需字段：平台解包后逐项校验，缺任何一个都会整包拒收（报「解析失败」）。
   注意它们不在 quick_validate.py 的检查范围内，所以必须在这里挡住。 */
const MARKET_FIELDS = [
  ['version', '版本号，建议 semver，如 1.2.0'],
  ['display_name', '中文展示名'],
  ['display_name_en', '英文展示名'],
  ['description_zh', '中文简介'],
  ['description_en', '英文简介'],
];
const fmMissing = MARKET_FIELDS.filter(([k]) => {
  const m = fm.match(new RegExp('^' + k + ':\\s*(.+)$', 'm'));
  return !m || !m[1].replace(/^["']|["']$/g, '').trim();
}).map(([k, label]) => `${k}（${label}）`);
if (fmMissing.length) fail('frontmatter 缺市场提交必需字段：' + fmMissing.join('、'));

/* 中文可搜的回归保护（1.4.3）：客户端市场实测只有拉丁 slug 能命中，中文展示名不进搜索命中。
   两个展示名都必须带中文关键词，删掉中文别名就当场打包失败，别等上架后用户搜不到才发现。 */
const hasZh = /[\u3400-\u9fff]/;
const dispZh = (fm.match(/^display_name:(.+)$/m) || [])[1] || '';
const dispEn = (fm.match(/^display_name_en:(.+)$/m) || [])[1] || '';
if (!hasZh.test(dispZh) || !hasZh.test(dispEn)) {
  fail('中文展示名与英文展示名都必须带中文关键词，否则市场里搜中文搜不到（只有 slug 能命中）');
}


/* ---------- 2. 收集文件 ---------- */
function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      walk(path.join(dir, ent.name), out);
    } else if (ent.isFile()) {
      if (SKIP_EXT.has(path.extname(ent.name).toLowerCase())) continue;
      out.push(path.join(dir, ent.name));
    }
  }
  return out;
}
const files = walk(SKILL_ROOT).sort();
if (!files.length) fail('目录里没有可打包的文件');

const assets = files.find((f) => /assets[\\/]map\.html$/.test(f));
if (!assets) fail('缺少 assets/map.html（页面本体，别人装了才真的能用）');
if (fs.statSync(assets).size < 100 * 1024) fail('assets/map.html 太小，可能不是完整页面');

/* 市场只接受「根目录/二级目录/文件」两级结构：docs/img/x.jpg 这种三层嵌套会整包拒收，
   报「解析失败：目录层级超限」。在本地就挡住，别等上传才被打回。 */
const tooDeep = files
  .map((f) => path.relative(SKILL_ROOT, f).split(path.sep))
  .filter((p) => p.length > 2);
if (tooDeep.length) {
  fail('目录层级超限 —— 市场只支持「根目录/二级目录/文件」（最多 2 级）：\n  '
    + tooDeep.map((p) => p.join('/')).join('\n  ')
    + '\n请把文件移到一级子目录下（例如 docs/img/01.jpg → docs/01.jpg），并同步改掉文档里的引用路径。');
}

/* ---------- 3. 写 zip（store + deflate，UTF-8 文件名） ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function dosTime(d) {
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  return { time, date };
}

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const raw = e.data;
    const comp = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = comp.length < raw.length;
    const body = useDeflate ? comp : raw;
    const crc = crc32(raw);
    const nameBuf = Buffer.from(e.name, 'utf8');
    const { time, date } = dosTime(e.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);            // UTF-8 文件名
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(useDeflate ? 8 : 0, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    centrals.push(cen, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, end]);
}

/* ---------- 4. 打包 ---------- */
fs.mkdirSync(outDir, { recursive: true });
const zipName = asciiName ? `${FOLDER}-ascii.zip` : `${FOLDER}.zip`;
const zipPath = path.join(outDir, zipName);

const entries = files.map((f) => {
  const rel = path.relative(SKILL_ROOT, f).split(path.sep).join('/');
  let data = fs.readFileSync(f);
  if (asciiName && rel === 'SKILL.md') {
    data = Buffer.from(
      data.toString('utf8').replace(/^name:\s*.+$/m, 'name: dingwei-geini'),
      'utf8'
    );
  }
  return { name: `${FOLDER}/${rel}`, data, mtime: fs.statSync(f).mtime };
});
const zipBuf = buildZip(entries);
fs.writeFileSync(zipPath, zipBuf);

const sha = crypto.createHash('sha256').update(zipBuf).digest('hex');
const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log(`\n技能名：${nameLine}${asciiName ? '  （包内 name 改写为 dingwei-geini）' : ''}`);
console.log(`文件数：${entries.length}`);
for (const e of entries) console.log(`  ${kb(e.data.length).padStart(9)}  ${e.name}`);
console.log(`\n✅ ${zipPath}`);
console.log(`   压缩后 ${kb(zipBuf.length)} / 原始 ${kb(entries.reduce((s, e) => s + e.data.length, 0))}`);
console.log(`   sha256 ${sha}\n`);

function fail(msg) {
  console.error('❌ ' + msg);
  process.exit(1);
}
