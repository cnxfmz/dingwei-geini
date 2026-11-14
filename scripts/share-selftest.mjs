#!/usr/bin/env node
/* 「零服务器分享」核心逻辑回归 —— 纯 Node，不开浏览器。
   从 assets/map.html 里把分享模块抠出来放进 vm，只测不依赖 DOM 的纯函数：
   加密往返 / 密文防篡改 / 差异生成 / 三方合并 / 冲突以创建人为准 / 二维码容量与编码。

   用法：node scripts/share-selftest.mjs
   退出码：0 全通过；1 有用例失败。 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'assets', 'map.html'), 'utf8');
const start = html.indexOf('/* ===== 零服务器分享');
const end = html.indexOf('})();', start);
if (start < 0 || end < 0) {
  console.error('找不到分享模块：assets/map.html 结构变了');
  process.exit(1);
}
const code = html.slice(start, end + 5);

/* vm 里没有 document，模块会自动跳过 DOM 绑定；只注入 Web 标准全局 */
const ctx = {
  window: {}, crypto: webcrypto, console,
  btoa, atob, Blob, Response, CompressionStream, DecompressionStream,
  TextEncoder, TextDecoder, URL, URLSearchParams, setTimeout,
};
vm.createContext(ctx);
/* 二维码编码器是独立内联的 script 块，先喂进同一个 vm，qrEligible 才看得见它 */
const qs = html.indexOf('<script id="qr-lib">');
const qe = html.indexOf('</script>', qs);
const qrCode = qs >= 0 ? html.slice(qs + '<script id="qr-lib">'.length, qe) : '';
if (!qrCode) { console.error('找不到内联 QR 编码器：assets/map.html 结构变了'); process.exit(1); }
vm.runInContext(qrCode, ctx, { filename: 'qr-lib.js' });
vm.runInContext(code, ctx, { filename: 'share-module.js' });
const S = ctx.window.SHARE;
if (!S || !S.pack || !S.mergeDelta) {
  console.error('分享模块没暴露 SHARE API');
  process.exit(1);
}

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log(' FAIL  ' + name + (detail ? ' · ' + detail : '')); }
};
const P = (id, short, extra) => Object.assign({
  id, no: 1, short, raw: short, queries: [], note: '', lat: 32.0089, lng: 112.1226,
  autoLat: 32.0089, autoLng: 112.1226, matched: '', query: '', rel: null, level: null,
  source: '手动新增', stdAddr: '', status: 'auto', off: false, hidden: false,
  alts: [], autoSnapshot: null,
}, extra || {});

const A = P('pa', '甲处');
const B = P('pb', '乙处');
const C = P('pc', '丙处');
const base = S.baseOf([A, B]);

/* 1. 加密往返：中文、压缩分支、base64url 字符集 */
const payload = { v: 1, k: 'share', room: 'RTEST', round: 3, base, pts: [A, B], del: [], ts: 1 };
const token = await S.pack(payload);
ok('链接令牌只有 URL 安全字符', /^[0-9A-Za-z_.-]+$/.test(token), token.slice(0, 40));
const back = await S.unpack(token);
ok('加密往返点位无损', back.pts.length === 2 && back.pts[0].short === '甲处' && back.room === 'RTEST');
ok('基准指纹随链接带回', back.base.pa === base.pa && back.base.pb === base.pb);

/* 2. 密文被改一个字符必须解不开（GCM 完整性） */
const parts = token.split('.');
const bad = parts.slice();
const last = bad[3];
bad[3] = (last[0] === 'A' ? 'B' : 'A') + last.slice(1);
let tamperRejected = false;
try { await S.unpack(bad.join('.')); } catch (e) { tamperRejected = true; }
ok('篡改密文会被拒绝', tamperRejected);

/* 3. 截断链接要给出人话错误，不是白屏 */
let truncated = '';
try { await S.unpack('1.abc.def'); truncated = ''; } catch (e) { truncated = e.message; }
ok('截断链接有明确报错', /格式不对|截断/.test(truncated), truncated);

/* 4. 差异生成：改一个 / 删一个 / 新增一个，且基准指纹不变 */
const guest = [Object.assign({}, A, { short: '甲处（对方改）' }), C];
const delta = S.buildDelta(guest, base, ['pb']);
ok('差异只带新增与改过的点', delta.pts.length === 2 && delta.pts.some(p => p.id === 'pc'));
ok('删除用显式 deletedIds', delta.del.length === 1 && delta.del[0] === 'pb');
ok('编号变化不误判为改动', S.fp(A) === S.fp(Object.assign({}, A, { no: 99 })));

/* 5. 无冲突合并：创建人这边没动过 */
const r = S.mergeDelta([A, B], Object.assign({}, delta, { base }));
ok('合并新增/更新/删除计数正确',
  r.stat.added === 1 && r.stat.updated === 1 && r.stat.deleted === 1 && r.stat.conflicts === 0,
  JSON.stringify(r.stat));
ok('合并结果采用对方改动', r.points.length === 2 && r.points.find(p => p.id === 'pa').short === '甲处（对方改）');
ok('新增点被并入正本', r.points.some(p => p.id === 'pc'));

/* 6. 同一个点两边都改过 → 以创建人为准，且明确计数 */
const myA = Object.assign({}, A, { short: '甲处（我改）' });
const r2 = S.mergeDelta([myA, B], Object.assign({}, delta, { base }));
ok('双方都改过时以创建人为准', r2.points.find(p => p.id === 'pa').short === '甲处（我改）');
ok('冲突被计数而不是静默丢弃', r2.stat.conflicts === 1 && r2.stat.updated === 0, JSON.stringify(r2.stat));
ok('冲突不影响其它点合并', r2.stat.added === 1 && r2.stat.deleted === 1);

/* 7. 删除冲突：创建人改过对方要删的点 → 不删，算冲突 */
const r3 = S.mergeDelta([myA, B], { base, pts: [], del: ['pa'] });
ok('删除冲突保留创建人版本', r3.points.some(p => p.id === 'pa') && r3.stat.deleted === 0);
ok('删除冲突被计数', r3.stat.conflicts === 1);

/* 8. 基准里不存在的 id 出现在 del 里，不能误删（对方自己新增又删） */
const r4 = S.mergeDelta([A, B], { base, pts: [], del: ['pz'] });
ok('陌生人删除 id 不会误删正本', r4.points.length === 2 && r4.stat.deleted === 0);

/* 9. 空清单也能分享 / 合并 */
const empty = { v: 1, k: 'share', room: 'RE', round: 1, base: {}, pts: [], del: [], ts: 1 };
const emptyBack = await S.unpack(await S.pack(empty));
ok('空地图分享往返正常', emptyBack.pts.length === 0 && Object.keys(emptyBack.base).length === 0);

/* ===== 二维码专项（1.3.1 → 1.4.6） =======================================
   零服务器下密文必须整份塞进链接。1.4.6 起不再按字符数猜门槛 —— 先真编一次，
   看编码器返回的 version 再决定：>v36 不出码，≥v33 判「密」强制先存图。
   这里不依赖浏览器 canvas（qrFit 只判版本不画图），纯逻辑可验。 */
const QR = ctx.window.QRCodeCore;
ok('内联 QR 编码器可用', !!QR && typeof QR.create === 'function');
const URL_HEAD = 'https://xiangyang-9points.app.workbuddy.host/?sharecode=NNNTEDLJEX#s=';
const link = (n) => URL_HEAD + 'Ab3_Xy9-'.repeat(500).slice(0, Math.max(0, n - URL_HEAD.length));
/* 全大写 + 数字的链接会进 alphanumeric 模式：2900 字符正好 v33，用来测「密集码」分支 */
const denseLink = URL_HEAD + 'A1B2C3D4E5F6G7H8I9J0'.repeat(200).slice(0, 2900 - URL_HEAD.length);
const shortLink = link(979), longLink = link(3100);
ok('非空文本才去试出码', S.qrEligible(shortLink) && !S.qrEligible('') && !S.qrEligible(null));
ok('门槛换成版本号 v36 / v33（不再用字符数）',
  S.QR_MAXV === 36 && S.QR_DENSEV === 33, `v${S.QR_MAXV} / v${S.QR_DENSEV}`);
const fitShort = S.qrFit(shortLink);
ok('短链接 fit 通过并带版本号', fitShort.ok && fitShort.version > 0 && fitShort.size > 0,
  fitShort.ok ? `v${fitShort.version}/${fitShort.size}` : fitShort.why);
/* 3100 字符的混合大小写链接：byte 模式装不进 v40，fit 必须判 big 而不是崩 */
const fitLong = S.qrFit(longLink);
ok('超容量链接判 big（不是抛异常）', !fitLong.ok && fitLong.why === 'big');
ok('空文本不试编', !S.qrFit('').ok && S.qrFit('').why === 'fail');
let q1 = null, q2 = null;
try { q1 = QR.create(shortLink, { errorCorrectionLevel: 'L' }); q2 = QR.create(link(400), { errorCorrectionLevel: 'L' }); }
catch (e) { q1 = null; }
ok('979 字符能真的编成二维码', !!q1 && q1.modules.size > 0 && q1.modules.data.length === q1.modules.size ** 2);
ok('短链接的码比长链接更稀疏', !!q1 && !!q2 && q2.modules.size < q1.modules.size,
  q1 && q2 ? `${q2.modules.size} < ${q1.modules.size}` : '');
/* 左上 7×7 定位图案：外框黑(0,0)、(1,1) 白环、中心 (3,3) 黑；右上角也必须是黑 */
ok('定位图案在位（QR 结构正确）', !!q1 &&
  q1.modules.get(0, 0) === 1 && q1.modules.get(1, 1) === 0 &&
  q1.modules.get(3, 3) === 1 && q1.modules.get(0, q1.modules.size - 1) === 1);

/* ===== 1.4.4 容量回归（保留：分享不再携带 base） ========================= */
const manyPts = Array.from({ length: 37 }, (_, i) => P('q' + i, '地点' + i + '号'));
const baseBefore = S.baseOf(manyPts);
const shareNoBase = { v: 1, k: 'share', room: 'RROOM144', round: 1, pts: manyPts, del: [], ts: 1 };
const backNoBase = await S.unpack(await S.pack(shareNoBase));
ok('分享链接不再携带 base 字段', !('base' in backNoBase), Object.keys(backNoBase).join(','));
ok('对方从 pts 重算的基准字节等价',
  JSON.stringify(S.baseOf(backNoBase.pts)) === JSON.stringify(baseBefore));
const deltaWithBase = { v: 1, k: 'delta', room: 'RROOM144', round: 1,
  base: baseBefore, pts: [manyPts[0]], del: [], ts: 1 };
const backDelta = await S.unpack(await S.pack(deltaWithBase));
ok('回传链接仍带 base（差异无法重算）',
  JSON.stringify(backDelta.base) === JSON.stringify(baseBefore));

/* ===== 1.4.6 41 进制字母表 ===============================================
   二维码 alphanumeric 模式 5.5 bit/字符，base64 只能走 byte 模式 8 bit/字符。
   换字母表后 token 变长但比特数变少，37 点从 v40(177) 降到 v35(157)。
   字符集禁区（每一条都是踩过的）：`.` 是分段符、`+` 会被 URLSearchParams 吃成空格、
   `%` 会被百分号解码、空格不在 URL 安全集里。 */
ok('41 进制字母表长度正好 41（41³=68921≥65536）',
  S.r41 && typeof S.r41 === 'function' && S.QR_MAXV === 36);
const R41SET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ$*-/:';
ok('字母表剔掉了 . + % 空格',
  R41SET.length === 41 && !/[.+% ]/.test(R41SET), R41SET);
/* 往返：长度 1..5、以及随机大块，逐字节还原 */
let rtOk = true, rtBad = '';
for (const n of [0, 1, 2, 3, 4, 5, 100, 2065]) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 37 + 11) & 255;
  const enc = S.r41(b), dec = S.unr41(enc);
  if (dec.length !== b.length || dec.some((v, i) => v !== b[i])) { rtOk = false; rtBad = 'n=' + n; break; }
}
ok('41 进制往返逐字节无损（含奇数长度）', rtOk, rtBad);
ok('字母表全在二维码 alphanumeric 字符集内',
  [...R41SET].every((c) => '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:'.includes(c)));
ok('非法字符会被拦下', (() => { try { S.unr41('AB+CD'); return false; } catch (e) { return true; } })());
/* 新格式标记：分享用 2/3 开头，回传仍是 0/1 */
const newTok = await S.pack({ v: 1, k: 'share', room: 'R146', round: 1, pts: manyPts, del: [], ts: 1 }, true);
const oldTok = await S.pack({ v: 1, k: 'share', room: 'R146', round: 1, pts: manyPts, del: [], ts: 1 });
ok('分享 token 用 2/3 标记走 41 进制', /^[23]\./.test(newTok) && !/[a-z]/.test(newTok.slice(2)),
  newTok.slice(0, 6));
ok('回传 / 老链路仍是 0/1 开头 base64', /^[01]\./.test(oldTok) && /[a-z]/.test(oldTok.slice(2)));
const backNew = await S.unpack(newTok), backOld = await S.unpack(oldTok);
ok('两种标记都能读回同样多点位',
  backNew.pts.length === 37 && backOld.pts.length === 37);
ok('新旧格式算出的基准完全一致（合并不会误判）',
  JSON.stringify(S.baseOf(backNew.pts)) === JSON.stringify(S.baseOf(backOld.pts)));
ok('37 点新格式比老格式短在比特上（token 更长但二维码更小）',
  newTok.length > oldTok.length);
const qNew = S.qrFit(URL_HEAD + newTok), qOld = S.qrFit(URL_HEAD + oldTok);
ok('37 点：新格式 v36 以内出码、版本比老格式低',
  qNew.ok && qNew.version < S.QR_MAXV + 1, qNew.ok ? `v${qNew.version}/${qNew.size}` : qNew.why);


/* ===== 1.4.5 短格式（链接变短，合并语义不变） ==============================
   37 个真实形态点位整份加密后原本 4000+ 字符、二维码编不出来。短格式换了明文排布：
   短数组 + 相对坐标 + 省略默认值，但 fp() 用到的字段一个都不能少 —— 少一个，
   接收方算出的基准就和创建人对不上，回传会把所有点误判成「双方都改过」。 */
const rich = Object.assign({}, A, {
  id: 'prich', no: 7,
  short: '鼓楼公寓东门',
  raw: '湖北省襄阳市襄城区荆州街60号鼓楼公寓东门',
  queries: ['湖北省襄阳市襄城区荆州街60号', '鼓楼公寓'],
  note: '现场核对：门牌在荆州街口，柜台东侧第二间',
  lat: 32.073558, lng: 112.151312,
  matched: '鼓楼公寓', query: '湖北省襄阳市襄城区荆州街60号',
  rel: 18, level: 11, source: '地址解析',
  stdAddr: '湖北省襄阳市襄城区荆州街60号',
  status: 'manual', off: true, hidden: false,
  alts: [{ title: '鼓楼公寓西门', lat: 32.07391, lng: 112.15162 }],
  autoSnapshot: { lat: 32.072, lng: 112.15, matched: '鼓楼公寓',
    query: '湖北省襄阳市襄城区荆州街60号', rel: 18, level: 11, source: '地址解析', status: 'auto' },
});
const richBack = (await S.unpack(await S.pack({ v: 1, k: 'share', room: 'RRICH', round: 1,
  pts: [rich, B], del: [], ts: 1 }))).pts;
ok('短格式：指纹逐位一致（合并基准不漂）',
  S.fp(richBack[0]) === S.fp(rich) && S.fp(richBack[1]) === S.fp(B),
  S.fp(rich) + ' vs ' + S.fp(richBack[0]));
ok('短格式：地址 / 备注 / 标准地址 / 查询词无损',
  richBack[0].raw === rich.raw && richBack[0].note === rich.note &&
  richBack[0].stdAddr === rich.stdAddr && richBack[0].query === rich.query,
  JSON.stringify({ raw: richBack[0].raw, note: richBack[0].note,
    stdAddr: richBack[0].stdAddr, query: richBack[0].query }));
ok('短格式：停用 / 人工校正 / 可信度都保留',
  richBack[0].off === true && richBack[0].status === 'manual' &&
  richBack[0].source === '地址解析' && richBack[0].rel === 18 && richBack[0].level === 11);
ok('短格式：坐标回到 6 位小数原值',
  richBack[0].lat === 32.073558 && richBack[0].lng === 112.151312,
  richBack[0].lat + ',' + richBack[0].lng);
ok('短格式：备选位置还在（坐标按 5 位小数存，标题回落到命中）',
  richBack[0].alts.length === 1 &&
  Math.abs(richBack[0].alts[0].lat - 32.07391) < 1e-5 &&
  Math.abs(richBack[0].alts[0].lng - 112.15162) < 1e-5 &&
  richBack[0].alts[0].title === '鼓楼公寓', JSON.stringify(richBack[0].alts));
ok('短格式：自动快照还在（还原该点仍可用）',
  !!richBack[0].autoSnapshot && richBack[0].autoSnapshot.lat === 32.072 &&
  richBack[0].autoSnapshot.source === '地址解析', JSON.stringify(richBack[0].autoSnapshot));
ok('短格式：queries 不传输但就地重建（重新解析不会把点判成无匹配）',
  Array.isArray(richBack[0].queries) && richBack[0].queries.length >= 1 &&
  richBack[0].queries[0] === rich.raw && richBack[0].queries.indexOf(rich.stdAddr) > 0,
  JSON.stringify(richBack[0].queries));

/* 老链接（不带 c:2 标记）必须照旧能打开：手工按 1.4.4 的排布造一条 */
const b64u = (u8) => Buffer.from(u8).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function oldToken(payload) {
  const raw = new TextEncoder().encode(JSON.stringify(payload));
  const z = new Uint8Array(await new Response(
    new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  const key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, z));
  const rk = new Uint8Array(await webcrypto.subtle.exportKey('raw', key));
  return '1.' + b64u(iv) + '.' + b64u(rk) + '.' + b64u(ct);
}
const oldBack = await S.unpack(await oldToken({ v: 1, k: 'share', room: 'ROLD', round: 2,
  base: { pa: S.fp(A) }, pts: [A], del: [], ts: 1 }));
ok('1.4.4 老链接仍能解析（无 c 标记走原格式）',
  oldBack.pts.length === 1 && oldBack.pts[0].short === '甲处' &&
  oldBack.base.pa === S.fp(A) && oldBack.room === 'ROLD');

/* 37 个真实形态点位：必须落进二维码容量，且基准指纹全部对得上 */
const STREET = ['荆州街', '檀溪路', '长虹路', '春园路', '航空路', '中原路'];
const POI = ['鼓楼公寓', '昭明台', '襄阳古城墙', '万达广场', '樊城客运站', '米公祠'];
let seed = 20261113;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const heavy = Array.from({ length: 37 }, (_, i) => {
  const st = STREET[i % STREET.length], poi = POI[i % POI.length], no = 60 + i * 7;
  const lat = 32.0089 + (rnd() - 0.5) * 0.35, lng = 112.1226 + (rnd() - 0.5) * 0.4;
  const std = `湖北省襄阳市襄城区${st}${no}号`;
  return Object.assign(P('h' + i, poi + '东门'), {
    no: i + 1, raw: std + poi + '东门', queries: [std, poi],
    note: i % 3 ? `现场核对：门牌在${st}口，柜台东侧第二间` : '',
    lat, lng, matched: poi, query: std, stdAddr: std,
    rel: i % 4 ? null : 12 + i, level: i % 2 ? 11 : null,
    source: ['地址解析', '关键词提示', '地点检索', '手动新增'][i % 4],
    status: i % 7 === 0 ? 'manual' : (i % 5 === 0 ? 'low' : 'auto'),
    off: i % 11 === 0,
    alts: [1, 2].slice(0, 1 + (i % 2)).map((k) => ({ title: poi + (k === 1 ? '' : '西门'),
      lat: lat + (rnd() - 0.5) * 0.004, lng: lng + (rnd() - 0.5) * 0.004 })),
    autoSnapshot: { lat, lng, matched: poi, query: std, rel: null, level: null,
      source: '地址解析', status: 'auto' },
  });
});
const heavyTok = await S.pack({ v: 1, k: 'share', room: 'RHEAVY', round: 1, pts: heavy, del: [], ts: 1 }, true);
const heavyLink = URL_HEAD + heavyTok;
const heavyBack = await S.unpack(heavyTok);
const heavyBefore = S.baseOf(heavy), heavyAfter = S.baseOf(heavyBack.pts);
const heavyDiff = Object.keys(heavyBefore).filter((k) => heavyBefore[k] !== heavyAfter[k]);
const qHeavyFit = S.qrFit(heavyLink);
ok('37 个真实点位落在还能扫的档位（≤v36）',
  qHeavyFit.ok, qHeavyFit.ok ? `v${qHeavyFit.version} ${qHeavyFit.size}x${qHeavyFit.size}` : qHeavyFit.why);
ok('37 个真实点位能编出二维码', qHeavyFit.ok && qHeavyFit.size > 0,
  qHeavyFit.ok ? `v${qHeavyFit.version}` : '编码失败');
ok('37 个真实点位基准指纹全对得上', heavyDiff.length === 0, heavyDiff.slice(0, 5).join(','));
ok('点位数量越多链接越长（单调）', heavyLink.length > 2000 && heavyLink.length < 4000,
  heavyLink.length + ' 字符');

/* 端到端：创建人分享 → 对方载入并改一个 / 加一个 / 删一个 → 回传 → 三方合并。
   这一条是短格式的真正验收：指纹只要差一位，stat 就会从 1/1/1 变成一串冲突。 */
const ownerPts = [rich, B, C];
const e2eTok = await S.pack({ v: 1, k: 'share', room: 'RE2E', round: 1,
  pts: ownerPts.map(S.copyPoint), del: [], ts: 1 });
const gBack = await S.unpack(e2eTok);
const gBase = S.baseOf(gBack.pts);
const gPts = gBack.pts.map((p) => Object.assign({}, p));
gPts[0].note = '对方补充：门牌在巷子里面';
gPts.push(P('pnew', '对方新增点'));
const e2eDelta = S.buildDelta(gPts, gBase, [gBack.pts[1].id]);
const e2eRet = await S.unpack(await S.pack({ v: 1, k: 'delta', room: 'RE2E', round: 1,
  base: gBase, pts: e2eDelta.pts, del: e2eDelta.del, ts: 1 }));
const merged = S.mergeDelta(ownerPts, e2eRet);
ok('端到端：对方改动合并成 1 增 / 1 改 / 1 删、零冲突',
  merged.stat.added === 1 && merged.stat.updated === 1 &&
  merged.stat.deleted === 1 && merged.stat.conflicts === 0, JSON.stringify(merged.stat));
ok('端到端：合并后内容正确',
  merged.points.length === 3 &&
  merged.points.find((p) => p.id === 'prich').note === '对方补充：门牌在巷子里面' &&
  merged.points.some((p) => p.id === 'pnew') &&
  !merged.points.some((p) => p.id === 'pb'));

/* ===== 1.4.8 轻量分享（只带名称和坐标） ===================================
   二维码装不下完整明细：37 个点带地址 / 备注 / 备选是 v35，屏幕上每模块只剩 6 像素，
   微信扫不出来。轻量格式只带「序号 + 坐标 + 名称」，序号就是数组下标，一个字符都不占。
   代价是地址备注不随码走、回传只覆盖坐标与名称 —— 下面这些断言就是把这两条边界钉住。 */
const lightSrc = Array.from({ length: 37 }, (_, i) => Object.assign({}, A, {
  id: 'L' + i, no: i + 1,
  short: '襄州' + ['双沟', '张湾', '伙牌', '黄集', '古驿'][i % 5] + '站',
  raw: '湖北省襄阳市襄州区航空路' + (100 + i) + '号换电站',
  note: i % 3 === 0 ? '夜间有人值守，门口好停车' : '',
  lat: 32.02 + (i * 0.0073) % 0.12, lng: 112.10 + (i * 0.0091) % 0.16,
  matched: '襄州' + ['双沟', '张湾', '伙牌', '黄集', '古驿'][i % 5],
  stdAddr: '湖北省襄阳市襄州区航空路' + (100 + i) + '号',
  status: 'auto',
}));
const lightTok = await S.pack({ v: 1, k: 'share', room: 'RLIGHT', round: 1, c: S.C3,
  pts: S.encLight(lightSrc), del: [], ts: 1 }, true);
const lightBack = await S.unpack(lightTok);
ok('轻量分享：37 点链接不超过 900 字符', lightTok.length <= 900, lightTok.length + ' 字符');
let qLight = null;
try { qLight = QR.create(URL_HEAD + lightTok, { errorCorrectionLevel: 'L' }); } catch (e) {}
ok('轻量分享：37 点能编到 v20 以内（微信随手扫）', !!qLight && qLight.version <= 20,
  qLight ? `v${qLight.version} ${qLight.modules.size}x${qLight.modules.size}` : '编码失败');
ok('轻量分享：名称与坐标逐点无损',
  lightBack.pts.length === 37 &&
  lightBack.pts.every((p, i) => p.short === lightSrc[i].short &&
    Math.abs(p.lat - lightSrc[i].lat) < 1e-6 && Math.abs(p.lng - lightSrc[i].lng) < 1e-6));
ok('轻量分享：点位标记 light，且不带地址备注',
  lightBack.pts[0].light === 1 && lightBack.pts[0].stdAddr === '' && lightBack.pts[0].note === '');
ok('轻量分享：序号就是数组下标（不额外占字符）',
  lightBack.pts.every((p, i) => p.no === i + 1));
const gapList = [Object.assign({}, A, { lat: null, lng: null, short: '待定位的点' }), B, C];
const gapBack = await S.unpack(await S.pack({ v: 1, k: 'share', room: 'RGAP', round: 1,
  c: S.C3, pts: S.encLight(gapList), del: [], ts: 1 }, true));
ok('轻量分享：没坐标的点只留名字、序号不塌',
  gapBack.pts.length === 3 && gapBack.pts[0].short === '待定位的点' &&
  gapBack.pts[0].lat === null && gapBack.pts[1].short === '乙处' && gapBack.pts[2].no === 3);

/* 对方改 1 个 / 加 1 个 / 删 1 个 → 回传 → 创建人合并 */
const lguest = lightBack.pts.map((p, i) => Object.assign({}, p, { id: 'G' + i }));
const lseq = lguest.map((p) => ({ id: p.id, la: p.lat, ln: p.lng, s: p.short }));
const lidle = S.buildDeltaLight(lguest, { seq: lseq, del: [] });
ok('轻量回传：没改动就不带内容', lidle.pts.length === 0, JSON.stringify(lidle));
lguest[3].lat = +(lguest[3].lat + 0.0021).toFixed(6);
lguest[3].short = '伙牌站（新址）';
lguest.push(Object.assign({}, A, { id: 'GNEW', short: '对方新加的点', lat: 32.0412, lng: 112.1888 }));
const ldrop = lguest[5].id; lguest.splice(5, 1);
const ldelta = S.buildDeltaLight(lguest, { seq: lseq, del: [ldrop] });
ok('轻量回传：只挑改过的点，新点序号 0，删除带原序号',
  ldelta.pts.length === 2 && ldelta.pts[0][0] === 4 && ldelta.pts[1][0] === 0 &&
  ldelta.del[0] === 6, JSON.stringify(ldelta));
const ltok2 = await S.pack({ v: 1, k: 'delta', room: 'RLIGHT', round: 1, c: S.C3,
  pts: ldelta.pts, del: ldelta.del, ts: 2 }, true);
const lback2 = await S.unpack(ltok2);
ok('轻量回传：改动表不会被当成点位解一遍',
  Array.isArray(lback2.pts[0]) && lback2.pts[0][0] === 4, JSON.stringify(lback2.pts[0]));
const lowner = lightSrc.map((p) => Object.assign({}, p));
const lmerged = S.mergeLight(lowner, lback2, lowner.map((p) => p.id));
ok('轻量合并：1 增 1 改 1 删、零冲突',
  lmerged.stat.added === 1 && lmerged.stat.updated === 1 &&
  lmerged.stat.deleted === 1 && lmerged.stat.conflicts === 0, JSON.stringify(lmerged.stat));
const lmv = lmerged.points.find((p) => p.id === 'L3');
ok('轻量合并：坐标与名称跟着更新',
  !!lmv && lmv.short === '伙牌站（新址）' && Math.abs(lmv.lat - lguest[3].lat) < 1e-6);
ok('轻量合并：备注与标准地址没被清掉',
  !!lmv && lmv.note === lightSrc[3].note && lmv.stdAddr === lightSrc[3].stdAddr &&
  lightSrc[3].note !== '', JSON.stringify({ note: lmv && lmv.note, stdAddr: lmv && lmv.stdAddr }));
const loldTok = await S.pack({ v: 1, k: 'share', room: 'ROLD', round: 1,
  pts: [rich, B], del: [], ts: 1 }, true);
const loldBack = await S.unpack(loldTok);
ok('老 c:2 完整链接仍能打开（明细都在）',
  loldBack.c === 2 && loldBack.pts.length === 2 && loldBack.pts[0].note === rich.note);

/* ===== 弹窗分支（最小 DOM stub，1.3.1） ==================================
   不启浏览器也要能证明：短链接出码 / 超长链接降级 / 提示弹窗不出码。 */
const els = new Map();
const fillOps = [];
const mkEl = () => ({ hidden: false, open: false, textContent: '', innerHTML: '', value: '',
  src: '', style: {}, width: 0, height: 0, onclick: null, classList: { remove() {} },
  removeAttribute() {}, insertAdjacentHTML() {}, focus() {}, select() {}, addEventListener() {},
  getBoundingClientRect: () => ({ height: 34, width: 300, top: 0, left: 0 }),
  getContext: () => ({ set fillStyle(v) {}, get fillStyle() { return ''; },
    fillRect(x, y, w, h) { fillOps.push([x, y, w, h]); } }) });
const $stub = (s) => { if (!els.has(s)) els.set(s, mkEl()); return els.get(s); };
const ctx2 = {
  window: { addEventListener() {}, innerWidth: 390, innerHeight: 844, devicePixelRatio: 3 }, console,
  crypto: webcrypto, btoa, atob, Blob, Response, CompressionStream, DecompressionStream,
  TextEncoder, TextDecoder, URL, URLSearchParams,
  setTimeout: () => {}, navigator: {}, history: {}, location: { href: '' },
  esc: (s) => String(s), setStatus: () => {}, LSget: () => null, LSset: () => {},
  $: $stub,
  document: {
    readyState: 'loading', addEventListener() {},
    body: { appendChild() {}, style: {} },
    createElement: (tag) => tag === 'canvas'
      ? { width: 0, height: 0, toDataURL: () => 'data:image/png;base64,TEST',
          getContext: () => ({ fillRect() {}, fillStyle: '' }) }
      : mkEl(),
  },
};
vm.createContext(ctx2);
vm.runInContext(qrCode, ctx2, { filename: 'qr-lib.js' });
vm.runInContext(code, ctx2, { filename: 'share-module.js' });
const S2 = ctx2.window.SHARE;
const card = $stub('#qrCard'), fb = $stub('#qrFallback'), save = $stub('#qrSave');
S2.showDlg('分享', '说明', shortLink, '', null);
ok('短链接弹窗真的显示二维码',
  card.hidden === false && fb.hidden === true && save.hidden === false &&
  $stub('#qrImg').src.startsWith('data:image/png'),
  JSON.stringify({ len: shortLink.length, card: card.hidden, fb: fb.hidden, save: save.hidden,
    src: $stub('#qrImg').src.slice(0, 30), cap: $stub('#qrCap').innerHTML.slice(0, 60),
    fbHtml: fb.innerHTML.slice(0, 60) }));
S2.showDlg('分享', '说明', longLink, '', null);
ok('超长链接弹窗显式降级',
  card.hidden === true && fb.hidden === false && save.hidden === true && /装不下/.test(fb.innerHTML));
S2.showDlg('分享', '说明', denseLink, '', null);
ok('密集码先引导全屏，再引导存图识别',
  card.hidden === false && fb.hidden === true &&
  /全屏/.test($stub('#qrCap').textContent) && /相册/.test($stub('#qrCap').textContent),
  $stub('#qrCap').textContent);

/* ===== 全屏扫码层（1.4.7） ================================================
   弹窗 240px ÷ 173 个含静区模块 = 1.45 px/模块，非整数缩放会让每列模块一会儿 1px
   一会儿 2px，对方相机里就更认不出。全屏层按「整数个设备像素」重画：
   k = floor(min(可用宽,可用高) / 含静区模块数)，断言每模块恰好 k 像素。 */
S2.showDlg('分享', '说明', denseLink, '', null);
fillOps.length = 0;
S2.qrFullDraw();
const fcv = $stub('#qrFullCv');
const fFit = S.qrFit(denseLink);
const fInner = fFit.ok ? fFit.size + 12 : 0;
const fK = fcv.width / fInner;
const ops = fillOps.filter((o) => o[2] > 0 && o[3] > 0 &&
  !(o[0] === 0 && o[1] === 0 && o[2] === fcv.width && o[3] === fcv.width)); /* 去掉整块白底 */
ok('全屏层按整数设备像素/模块绘制（无宽窄不均）',
  Number.isInteger(fK) && fK >= 2 && ops.length > 0 && ops.every((o) => o[2] === fK && o[3] === fK),
  `每模块 ${fK} 设备像素，共 ${ops.length} 个模块方块，画布 ${fcv.width}px`);
ok('全屏层留足静区（≥4 模块）',
  ops.length > 0 && ops[0][0] === 6 * fK && ops[0][1] === 6 * fK,
  ops.length ? `首个模块起点 ${ops[0][0]},${ops[0][1]}（静区 6 模块）` : '没有绘制任何模块');
ok('全屏层在 390×844@DPR3 手机上每模块 ≥6 设备像素',
  fK >= 6, `${fK} 设备像素/模块`);
ok('全屏层显示尺寸不超出视口',
  parseFloat(fcv.style.width) <= 390 && parseFloat(fcv.style.width) > 0,
  `CSS 显示 ${fcv.style.width}`);
S2.qrFullClose();
ok('关闭全屏层后遮罩隐藏、页面滚动恢复',
  $stub('#qrFull').hidden === true && ctx2.document.body.style.overflow === '');
S2.showDlg('提示', '内容', '', '', null);
ok('纯提示弹窗不出码、不出降级',
  card.hidden === true && fb.hidden === true && $stub('#shareCancel').textContent === '知道了');
S2.showDlg('确认', '内容', '', '合并进我的正本', null);
ok('确认弹窗保留「合并」主按钮',
  $stub('#shareApply').hidden === false && $stub('#shareApply').textContent === '合并进我的正本' &&
  $stub('#qrCard').hidden === true);

/* ===== 1.3.2 视觉回归：屏幕尺寸分档，保存图不受影响 ===================== */
const tinyLink = link(230);
S2.showDlg('分享', '说明', tinyLink, '', null);
const wSparse = $stub('#qrImg').style.width;
S2.showDlg('分享', '说明', shortLink, '', null);
const wDense = $stub('#qrImg').style.width;
ok('稀疏码显著缩小、密集码自动放宽',
  parseInt(wSparse, 10) === 168 && parseInt(wDense, 10) > parseInt(wSparse, 10),
  wSparse + ' → ' + wDense);
ok('分档边界稳定',
  S2.qrWidth(57) === 168 && S2.qrWidth(65) === 168 && S2.qrWidth(66) === 200 &&
  S2.qrWidth(85) === 200 && S2.qrWidth(86) === 240);

/* ===== ZIP 打包专项（1.4.1） ===============================================
   批量导出改成一次下载 1 个 zip，不开浏览器也要能证明字节结构合法：
   本地头 / 中央目录 / EOCD / store / UTF-8 标志 / CRC32 / 中文名 / 数据无损。 */
const za = html.indexOf('/* ===== ZIP STORE 开始');
const zb = html.indexOf('/* ===== ZIP STORE 结束', za);
const zipCode = za >= 0 && zb > za ? html.slice(za, zb) : '';
if (!zipCode) { console.error('找不到 ZIP 写入器：assets/map.html 结构变了'); process.exit(1); }
const ctx3 = { window: {}, console, TextEncoder, TextDecoder, Uint8Array, Uint32Array, DataView, Date };
vm.createContext(ctx3);
vm.runInContext(zipCode, ctx3, { filename: 'zip-store.js' });
const Z = ctx3.window.ZIP;
ok('ZIP 写入器可用', !!Z && typeof Z.build === 'function' && typeof Z.crc32 === 'function');
ok('CRC32 与标准向量一致', Z.crc32(new TextEncoder().encode('123456789')) === 0xCBF43926);
const zName = '定位给你_特写01_鼓楼公寓_20261113.png';
const zD1 = new TextEncoder().encode('FAKE-PNG-ONE');
const zD2 = new Uint8Array([137, 80, 78, 71, 0, 255, 1, 2]);
const zBuf = Z.build([{ name: zName, data: zD1 }, { name: 'b.txt', data: zD2 }]);
const zV = new DataView(Uint8Array.from(zBuf).buffer);
const u16 = (o) => zV.getUint16(o, true), u32 = (o) => zV.getUint32(o, true);
ok('本地文件头签名正确', u32(0) === 0x04034b50);
ok('store 模式 + UTF-8 文件名标志', u16(8) === 0 && u16(6) === 0x0800);
const zNLen = u16(26), zSize = u32(18);
const zPlain = Uint8Array.from(zBuf);
ok('中文文件名按 UTF-8 写入', new TextDecoder().decode(zPlain.slice(30, 30 + zNLen)) === zName);
ok('第一份数据无损', zSize === zD1.length &&
  zPlain.slice(30 + zNLen, 30 + zNLen + zSize).every((b, i) => b === zD1[i]));
ok('CRC32 写入与计算一致', u32(14) === Z.crc32(zD1));
const zEo = zPlain.length - 22;
ok('EOCD 签名与条目数', u32(zEo) === 0x06054b50 && u16(zEo + 8) === 2 && u16(zEo + 10) === 2);
const zCd = u32(zEo + 16), zCdSize = u32(zEo + 12);
ok('中央目录偏移与长度自洽', zCd + zCdSize === zEo && u32(zCd) === 0x02014b50);
const zCd2 = zCd + 46 + u16(zCd + 28) + u16(zCd + 30) + u16(zCd + 32);
ok('第二条目录项指向正确偏移',
  u32(zCd2) === 0x02014b50 && u32(zCd2 + 42) === 30 + zNLen + zSize);
ok('空文件清单也能出合法空包', Z.build([]).length === 22);

/* ===== 批量导出流程（1.4.1） ===============================================
   不开浏览器，用最小 DOM / 取图 stub 真跑一遍 exportDetailsZip()，证明核心承诺：
   只触发一次下载、失败项跳过并可重试、停止不落盘、弹窗收起不突然下载。 */
const ea = html.indexOf('/* ---------- 2b. 批量特写');
const eb = html.indexOf('/* ---------- 3. 点位图集', ea);
if (ea < 0 || eb < 0) { console.error('找不到批量导出模块：assets/map.html 结构变了'); process.exit(1); }
const flowCode = html.slice(ea, eb);
const mkE = () => ({ hidden: false, open: false, disabled: false, textContent: '', innerHTML: '',
  style: {}, scrollHeight: 0, clientHeight: 0,
  classList: { toggle() {}, add() {}, remove() {} },
  querySelector: () => mkE(), setAttribute() {}, appendChild() {}, remove() {}, click() {},
  addEventListener() {}, onclick: null });
const eMap = new Map();
const e$ = (s) => { if (!eMap.has(s)) eMap.set(s, mkE()); return eMap.get(s); };
e$('#imgdlg').style.display = 'flex';
const downloads = [], savedInfo = [];
const pts = [
  { id: 'a', no: 1, short: '甲处', lat: 32.1, lng: 112.1 },
  { id: 'b', no: 2, short: '乙处', lat: 99, lng: 112.2 },   // 模拟底图取不到
  { id: 'c', no: 3, short: '丙处', lat: 32.3, lng: 112.3 },
];
let mapBlockImpl = async () => ({ w: 1, h: 1 });
const ctx4 = {
  window: { ZIP: Z }, ZIP: Z, console, TextEncoder, Uint8Array, Blob, Date,
  $: e$, esc: (s) => String(s), setStatus: () => {}, vis: () => pts,
  IMG: { ZDETAIL: 18, CW: 750, CH: 550 },
  mapBlock: (...a) => mapBlockImpl(...a),
  detailCanvas: () => ({ width: 1, height: 1 }),
  canvasBlob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
  blobBytes: async () => new Uint8Array([1, 2, 3]),
  sleepMs: () => Promise.resolve(), today: () => '20261113',
  EXP: { run: false, stop: false, pending: null, failIds: [], names: [], dims: {} },
  expStart: () => { ctx4.EXP.stop = false; ctx4.EXP.pending = null; ctx4.EXP.failIds = []; },
  expSet: () => {}, expTrickle: () => {},
  expDone: (label) => { e$('#exprogStage').textContent = label || ''; }, expStopTick: () => {},
  expShowSaved: (list, info) => savedInfo.push(info),
  saveBlob: async (blob, name) => { downloads.push(name); return { name, size: 1, how: 'download', blob }; },
};
vm.createContext(ctx4);
vm.runInContext(flowCode, ctx4, { filename: 'export-flow.js' });
const runFlow = () => vm.runInContext('exportDetailsZip(null,false)', ctx4);
mapBlockImpl = async (lat) => { if (lat === 99) throw new Error('底图超时'); return { w: 1, h: 1 }; };
await runFlow();
ok('批量导出只触发一次下载', downloads.length === 1 && /\.zip$/.test(downloads[0]),
  JSON.stringify(downloads));
ok('ZIP 内含 2 张，失败项被跳过', savedInfo.length === 1 && savedInfo[0].zipNames.length === 2 &&
  savedInfo[0].zipNames.every(n => n.endsWith('.png')));
ok('失败点位记入可重试清单',
  ctx4.EXP.failIds.length === 1 && ctx4.EXP.failIds[0] === 'b' &&
  e$('#expFail').hidden === false && /只重试这 1 张/.test(e$('#expRetry').textContent));
/* 取第一张时就按停止：不应产生第二次下载 */
mapBlockImpl = async () => { ctx4.EXP.stop = true; return { w: 1, h: 1 }; };
await runFlow();
ok('按停止后不生成任何文件', downloads.length === 1 && /已停止/.test(e$('#exprogStage').textContent));
/* 弹窗收起：ZIP 先备好，不触发下载 */
e$('#imgdlg').style.display = 'none';
mapBlockImpl = async () => ({ w: 1, h: 1 });
await runFlow();
ok('弹窗收起时不突然下载', downloads.length === 1 && !!ctx4.EXP.pending);
ok('备好的 ZIP 可回来再存', ctx4.EXP.pending.zipNames.length === 3 &&
  /\.zip$/.test(ctx4.EXP.pending.name) && e$('#expPending').hidden === false);

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
