#!/usr/bin/env node
/* 「定位给你」默认值体检 —— 纯静态，不依赖浏览器。
   检查页面是否还处在「出厂默认」：默认配色、默认标记、侧栏默认、reset 入口、Key 内置状态，
   并把 HTML 里出现的全部 xy_* 存储键与登记清单比对，防止新增键后漏进 wipeLocalAll 的覆盖范围。

   用法：
     node scripts/check-defaults.mjs [html 路径]
   不带参数时，检查技能自带的 assets/map.html（技能目录内相对定位，换机器也能跑）。
   退出码：0 全部通过；1 有 FAIL（有 WARN 仍为 0）。
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_HTML = path.join(SKILL_ROOT, 'assets', 'map.html');
const file = process.argv[2] || DEFAULT_HTML;

/* 登记在案的「只存本机」键：新增键时必须同步这里和 SKILL.md */
const KNOWN_KEYS = [
  'xy_points_v1',       // 全部点位（名称/地址/坐标/停用/校正），默认空
  'xy_search_hist_v1',  // 搜索历史（最多 6 条）
  'xy_pin_style_v1',    // 标记样式，默认 halo
  'xy_detail_hold_v1',  // 标记详情停留，默认 3000ms
  'xy_theme_v1',        // 配色，默认 p1 夜蓝
  'xy_fw_v1',           // 框架布局，默认 island（浮岛）；float = 原 F2 浮层
  'xy_side_off_v1',     // 桌面侧栏偏好，默认展开
  'xy_side_off_m_v1',   // 窄屏侧栏偏好，默认收起
  'xy_side_hint_v1',    // 首次侧栏手柄提示已看过
  'xy_tx_key_v1',       // 自填的腾讯 Key，默认空 → 用内置
  'xy_share_v1',        // 分享房间号 / 轮次 / 基准指纹 / 删除墓碑，默认空
];
/* 老版本把点位拆在三个键里，现在只在迁移时读一次，不再写入 */
const LEGACY_KEYS = ['xy_9points_v1', 'xy_list_v1', 'xy_extras_v1'];

if (!fs.existsSync(file)) {
  console.error(`找不到文件：${file}`);
  process.exit(1);
}
const src = fs.readFileSync(file, 'utf8');
const rows = [];
const add = (level, name, detail) => rows.push({ level, name, detail });
const has = (re) => re.test(src);

/* 1. 清个人数据的两个入口 */
add(has(/function wipeLocalAll\s*\(/) ? 'PASS' : 'FAIL', 'wipeLocalAll()',
  has(/function wipeLocalAll\s*\(/) ? '统一清空函数在位' : '缺少统一清空函数，恢复默认会漏键');

const resetParam = has(/searchParams\.get\('reset'\)\s*===\s*'1'/) && has(/indexOf\('xy_'\)\s*===\s*0/);
add(resetParam ? 'PASS' : 'FAIL', '?reset=1 链接',
  resetParam ? '链接参数可在读偏好之前清库' : '链接参数缺失：交付时没法一键给别人清干净');

const uiBtn = has(/id="btnResetAll"/) && has(/#btnResetAll/);
add(uiBtn ? 'PASS' : 'FAIL', '设置 → 恢复默认设置',
  uiBtn ? '页面内有入口（点两次确认）' : '设置面板缺少恢复默认入口');

/* 2. 出厂默认值（改默认时这里会亮红） */
const themeKey = has(/var ok=\{p0:1,p1:1,p2:1,p3:1,p4:1\}/) && has(/k='p1'/) && has(/legacy=\{g1:'p0'/);
add(themeKey ? 'PASS' : 'FAIL', '默认配色',
  themeKey ? 'P1 夜蓝（首帧白名单 + 老 gX 映射）' : '首屏默认不是 P1 夜蓝，或缺老主题映射');

const tokenLayer = /:root\{[\s\S]{0,1600}?--acc:#5ab9fc;/.test(src);
add(tokenLayer ? 'PASS' : 'FAIL', '配色令牌层',
  tokenLayer ? ':root 本身就是夜蓝，JS 不跑也是夜蓝' : ':root 不是夜蓝：脚本被拦时会退回另一套颜色');

const themes5 = /const THEMES=\[[\s\S]{0,700}?\{k:'p4'/.test(src) &&
  has(/LEGACY_THEME=\{g1:'p0'/) && !/html\[data-theme="g\d"\]\{/.test(src);
add(themes5 ? 'PASS' : 'FAIL', '五套配色 + 老设备映射',
  themes5 ? 'P0–P4 在位，旧 gX 键有映射，无残留旧主题块' : '配色套数不对，或老设备会悄悄变灰');

const f2 = has(/aside#sidebar\{position:absolute/) && has(/\.mapwrap\{position:absolute;inset:0/) &&
  has(/html\.side-off aside#sidebar\{transform:translateX/) &&
  has(/#detail,#sdetail\{right:calc\(var\(--side-w\) \+ 26px\)\}/);
add(f2 ? 'PASS' : 'FAIL', 'F2 地图优先框架',
  f2 ? '地图铺满、清单右侧浮层、详情卡避让都在位' : 'F2 布局缺件：清单会盖住地图或详情卡');

add(has(/return PIN_STYLES\[v\]\s*\?\s*v\s*:\s*'halo'/) ? 'PASS' : 'WARN', '默认标记样式',
  has(/return PIN_STYLES\[v\]\s*\?\s*v\s*:\s*'halo'/) ? 'halo 水滴光环' : '回退样式不是 halo');

const pinGrid = /\.pinstyles\{display:grid;grid-template-columns:repeat\(3,/.test(src);
add(pinGrid ? 'PASS' : 'WARN', '标记样式布局',
  pinGrid ? '设置里一排三列，整块约 100px 高' : '标记样式不是三列排布（设置面板会明显变高）');

add(has(/raw\s*==\s*null\s*\|\|\s*raw\s*===\s*''\)\s*return\s*3000/) ? 'PASS' : 'WARN', '默认详情停留',
  '3000ms（3 秒）');

add(has(/SIDE_STORE\s*=\s*'xy_side_off_v1'/) && has(/SIDE_STORE_M\s*=\s*'xy_side_off_m_v1'/)
  ? 'PASS' : 'FAIL', '侧栏双偏好',
  '桌面展开 / 窄屏收起，两套键各记各的');

/* 3. 内置 Key */
const m = src.match(/const TXK_DEFAULT\s*=\s*'([^']*)'/);
const keyVal = m ? m[1] : '';
if (!m) add('FAIL', '内置 Key', '找不到 TXK_DEFAULT 常量');
else if (keyVal) add('PASS', '内置 Key', `已内置 ${keyVal.slice(0, 5)}-••••-${keyVal.slice(-6)}（公开可见）`);
else add('WARN', '内置 Key', '当前没内置：每个人打开都要自己填一把');

/* 4. 出厂必须是一张空白地图：没有任何内置点位 */
const bootEmpty = /function boot\(\)\{[\s\S]{0,120}?points=\[\]/.test(src);
add(bootEmpty ? 'PASS' : 'FAIL', '出厂点位',
  bootEmpty ? 'boot() 从空清单起步，打开就是空白地图' : 'boot() 仍在预置点位：公开给别人用会带上作者的数据');

const noSeed = !/points\s*=\s*RAW\.map\(/.test(src);
add(noSeed ? 'PASS' : 'FAIL', '无内置点位装载',
  noSeed ? 'RAW/PRESET 只在「载入示例」时使用' : '仍有地方把 RAW 直接装进 points');

const sampleOk = /function loadSample\s*\(/.test(src) && has(/id="btnSample"/);
add(sampleOk ? 'PASS' : 'WARN', '示例入口',
  sampleOk ? '「更多 → 载入示例」可按需装载示例点位' : '没有示例入口：新用户打开是空的，缺少「看一眼效果」的路径');

const storageOne = /PTS_STORE\s*=\s*'xy_points_v1'/.test(src) && /function savePoints\s*\(/.test(src);
add(storageOne ? 'PASS' : 'FAIL', '点位存储',
  storageOne ? '全部点位一份存储（xy_points_v1），改完就存' : '点位存储不是单一 key，容易出现刷新丢改动');

/* 5. 语音防卡死三件套（微信内置浏览器里 onresult/onerror/onend 可能一个都不来） */
const vWait = /const VOICE_WAIT\s*=\s*\d{4,6}/.test(src);
const vGuard = /VOICE\.rec\s*!==\s*rec/.test(src);
const vCancel = /function vCancel\s*\(/.test(src);
const vMiss = [vWait ? '' : '缺 10 秒哨兵', vGuard ? '' : '缺迟到回调守卫', vCancel ? '' : '缺立即退出函数'].filter(Boolean);
if (!vMiss.length) add('PASS', '语音防卡死', '哨兵 + 回调守卫 + 点两次即退出，三件套在位');
else add('FAIL', '语音防卡死', `${vMiss.join('、')}（微信里会卡在「在听」且退不出）`);

/* 6. 存储键清单比对 */
const found = [...new Set((src.match(/'xy_[a-z0-9_]+'/g) || []).map((s) => s.slice(1, -1)))];
const unknown = found.filter((k) => !KNOWN_KEYS.includes(k) && !LEGACY_KEYS.includes(k));
const missing = KNOWN_KEYS.filter((k) => !found.includes(k));
if (unknown.length) add('FAIL', '存储键清单', `出现未登记的键：${unknown.join('、')}（补进 KNOWN_KEYS 与 SKILL.md）`);
else if (missing.length) add('WARN', '存储键清单', `登记了但页面没用上：${missing.join('、')}（可能已被移除，清理时一并退场）`);
else add('PASS', '存储键清单', `${found.filter((k) => KNOWN_KEYS.includes(k)).length} 个在用键全部登记在案`);

/* 7. 零服务器分享链路（1.3.1） */
const shareOk = has(/window\.SHARE\s*=\s*API/) && has(/function mergeDelta\s*\(/) &&
  has(/function buildDelta\s*\(/) && has(/id="btnShare"/) && has(/id="btnReturn"/) &&
  has(/markDeleted\(id\)/) && has(/LSdel\('xy_share_v1'\)/);
add(shareOk ? 'PASS' : 'FAIL', '分享与回传',
  shareOk ? '加密链接、按 id 合并、删除墓碑、清库钩子都在位' : '分享链路缺件，跑 share-selftest.mjs 定位');
const selftest = fs.existsSync(path.join(SKILL_ROOT, 'scripts', 'share-selftest.mjs'));
add(selftest ? 'PASS' : 'FAIL', '分享逻辑回归',
  selftest ? 'share-selftest.mjs 已随包提供' : '缺少分享逻辑自检脚本');

/* 7b. 二维码分享（1.3.1） */
const qrLib = has(/<script id="qr-lib">/) && has(/window\.QRCodeCore=require\('qrcode'\)/) &&
  has(/qrcode 1\.5\.4/) && !/<script id="qr-lib"[^>]*\bsrc=/.test(src);
add(qrLib ? 'PASS' : 'FAIL', '内联 QR 编码器',
  qrLib ? 'qrcode 1.5.4 已内联，无 CDN、离线可用' : '编码器缺失或引用了 CDN（会破离线与隐私）');
const qrUi = has(/id="qrImg"/) && has(/id="qrFallback"/) && has(/id="qrSave"/) &&
  has(/function qrEligible\(/) && has(/function qrFit\(/) &&
  has(/g\.fillStyle='#ffffff'/) && has(/g\.fillStyle='#000000'/);
add(qrUi ? 'PASS' : 'FAIL', '二维码与降级',
  qrUi ? '白底黑码、先试编看版本、超限降级、保存图片都在位' : '二维码链路缺件，跑 share-selftest.mjs 定位');

/* 7b-2. 二维码门槛（1.4.6）
   不再按字符数拍门槛：先真编一次，按 version 判 —— >v36 不出码，≥v33 判「密」。
   字符数与容量在换字母表后已经不成比例，任何字符数魔数都会重新过期。 */
const qrCap = has(/QR_MAXV=36/) && has(/QR_DENSEV=33/) &&
  has(/qr\.version>QR_MAXV/) && has(/r\.version>=QR_DENSEV/) &&
  has(/码很密（v/) && has(/二维码装不下（码已经到 v/);
add(qrCap ? 'PASS' : 'FAIL', '二维码门槛按真实版本',
  qrCap ? 'v36 上限、v33 判密、超限文案写清版本，不再依赖字符数魔数' : '版本门槛或密集码文案缺失');

/* 7b-2b. 全屏扫码层（1.4.7）
   实测：弹窗 240px ÷ 173 模块 = 1.45 px/模块，非整数缩放会让模块宽窄不均；对方相机里
   每模块只剩 3~4 像素，扫不出来。全屏层按整数个设备像素重画，并把静区从 4 提到 6。 */
const qrFull = has(/id="qrFull"/) && has(/id="qrFullCv"/) && has(/id="qrFullBtn"/) &&
  has(/function qrFullDraw\(/) && has(/var k=Math\.max\(1,Math\.floor\(/) &&
  has(/quiet=6,scale=12/) && has(/z-index:4000/);
add(qrFull ? 'PASS' : 'FAIL', '全屏扫码层与整数缩放',
  qrFull ? '全屏层、整数设备像素/模块、静区 6、高清存图 12px/模块' : '全屏层缺件：密集码在屏幕上仍然扫不出来');
/* 7b-2a. 轻量分享（1.4.8）
   二维码装不下 37 个点的完整明细，所以分享只带「序号 + 坐标 + 名称」。
   回传按序号对齐、只覆盖坐标与名称；老 c:2 完整链接仍要能打开 —— 这两条都不能掉。 */
const shareLight = has(/var payload=\{v:PROTO,k:'share',room:room,round:round,c:C3,/) &&
  has(/pts:encLight\(points\)/) && has(/function encLight\(/) && has(/function decLight\(/) &&
  has(/function mergeLight\(/) && has(/function buildDeltaLight\(/) &&
  has(/d\.c===C3\)\?mergeLight\(points,d,m\.seq\):mergeDelta\(points,d\)/) &&
  has(/obj\.c===C3&&obj\.k==='share'&&Array\.isArray\(obj\.pts\)\)obj\.pts=decLight/) &&
  has(/obj\.c===C2&&Array\.isArray\(obj\.pts\)\)obj\.pts=decPts/) &&
  has(/writeMeta\(\{role:'owner',room:room,round:round,/) &&
  has(/role:'guest',room:d\.room,round:d\.round,light:1,seq:seq,del:\[\]/);
add(shareLight ? 'PASS' : 'FAIL', '轻量分享与按序号回传',
  shareLight ? 'share 只带坐标+名称、回传按序号合并、老 c:2 链接仍可读' :
    '轻量编解码或 c:2 兼容分支缺失：要么码又变密，要么老链接打不开');

/* 7b-3. 短格式（1.4.5）
   只换明文排布，加密与合并语义不动。这里做静态断言，确认编解码两端和指纹字段都在；
   真正的等价性（37 点位指纹逐位一致、端到端三方合并）由 share-selftest.mjs 跑。 */
const shortFmt = has(/var SHARE_STORE='xy_share_v1', PROTO=1, C2=2, C3=3;/) &&
  has(/function encPts\(/) && has(/function decPts\(/) &&
  has(/body\.c=C2;body\.pts=encPts\(payload\.pts\)/) &&
  has(/obj\.c===C2&&Array\.isArray\(obj\.pts\)\)obj\.pts=decPts\(obj\.pts\)/) &&
  has(/function s36\(/) && has(/function p36\(/);
add(shortFmt ? 'PASS' : 'FAIL', '分享短格式编解码',
  shortFmt ? 'c:2 标记 + encPts/decPts 两端在位，老链接走原分支' : '短格式缺件：分享链接会退回长度或解不开');
/* 指纹字段一个都不能丢：F_FIELDS 是基准指纹的输入，短格式必须把它们全带上 */
const fpFields = ['id', 'short', 'raw', 'note', 'lat', 'lng', 'matched', 'query', 'status', 'off', 'hidden', 'source', 'stdAddr', 'rel', 'level'];
const fpKeep = has(/var F_FIELDS=\['id','short','raw','note','lat','lng','matched','query','status','off','hidden','source','stdAddr','rel','level'\];/) &&
  has(/function qCode\(p\)/) && has(/function stdEnc\(std,raw\)/) && has(/function srcEnc\(s\)/) &&
  has(/\(p\.off\?1:0\)\|\(p\.hidden\?2:0\)\|\(stCode\(p\.status\)<<2\)/);
add(fpKeep ? 'PASS' : 'FAIL', '短格式不丢指纹字段',
  fpKeep ? `${fpFields.length} 个指纹字段全在：query/source/status/off/hidden 用映射而非丢弃` :
    '短格式砍到了指纹字段，对方算出的基准会和创建人对不上');

/* 7b-4. 41 进制字母表（1.4.6）
   base64 大小写混合 → 二维码只能 byte 模式（8 bit/字符）；换成「全大写 + 数字 + $ * - / :」
   就能进 alphanumeric（5.5 bit/字符），37 点位 v40(177) → v35(157)。字符集是硬编码的
   41 个，任何一个字符变动都会让二维码退回 byte 模式，所以这里逐字比对。 */
const r41Set = has(/var R41='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ\$\*-\/:'/) &&
  has(/function r41\(u8\)/) && has(/function unr41\(s\)/);
add(r41Set ? 'PASS' : 'FAIL', '41 进制字母表',
  r41Set ? '字母表 41 个、编解码两端在位' : '字母表被改短或编码函数缺失（会退回 byte 模式，码突然变密）');
const r41Bad = ['.', '+', '%', ' '].filter((c) => src.includes("R41='" + c)) ;
const r41Safe = !/var R41=[^;]*[.+% ]/.test(src.split('\n').find((l) => l.startsWith("var R41=")) || '') &&
  has(/R41\.indexOf\(seg\.charAt\(j\)\)<0\)throw/);
add(r41Safe ? 'PASS' : 'FAIL', '字母表避开 . + % 空格',
  r41Safe ? '不含分段符 .（会撕碎 token）、+（URLSearchParams 变空格）、%（百分号解码）、空格' :
    '字母表混进了 . + % 或空格：链接一复制就烂，或二维码退回 byte 模式');

/* 7c. 分享弹窗：标题带技能名 + 朴素风格（1.3.3）
   1.3.2 那套眉标 / chips / 渐变 / 动效已被判定为 AI 味并移除，
   这几条是反向断言：以后谁再加回装饰，体检会直接拦下。 */
const brandHd = has(/id="shareTitle">定位给你 · /) && has(/'定位给你 · '\+title/) &&
  has(/class="share-x" id="shareClose"/);
add(brandHd ? 'PASS' : 'FAIL', '标题带技能名',
  brandHd ? '一行「定位给你 · 功能名」，无眉标 / 英文装饰' : '标题丢了技能名，或又加回了眉标');
const qrVisual = has(/function qrWidth\(/) && has(/img\.style\.width=qrWidth/) &&
  has(/\.qr-card\{width:fit-content/) && has(/\.qr-frame img\{display:block;width:190px/) &&
  has(/share-lede/) && has(/share-warn/) && has(/\.sbtn\.main\{background:var\(--acc\)/) &&
  !has(/share-kicker/) && !has(/sm-chip/) && !has(/@keyframes shareIn/) && !has(/animation:shareRise/);
add(qrVisual ? 'PASS' : 'FAIL', '二维码分档与朴素风格',
  qrVisual ? '分档尺寸在、渐变 / chips / 动效已清空' : '视觉链路缺件或装饰回潮，检查 shareDlg 样式');
const plainCopy = !/不用服务器、不用登录|<b>注意<\/b>|SHARE<\/span>|<span class="sm-chip"/.test(src) &&
  has(/码里只有<b>名称和位置<\/b>/) && has(/二维码装不下/);
add(plainCopy ? 'PASS' : 'FAIL', '文案无 AI 腔',
  plainCopy ? '短句、无排比加粗、无内部术语堆砌' : '又出现排比 / 加粗警示 / 技术黑话堆砌');

/* 7d. 批量特写打包 ZIP（1.4.1）
   逐张 <a download> 在「下载前询问保存位置」的浏览器上会逐张弹系统框，
   所以批量改成一次下载 1 个 ZIP；单张导出保持原样。 */
const zipLib = has(/const ZIP=\(function\(\)\{/) && has(/0x04034b50/) && has(/0x02014b50/) &&
  has(/0x06054b50/) && has(/setUint16\(6,0x0800,true\)/) && has(/window\.ZIP=ZIP/);
add(zipLib ? 'PASS' : 'FAIL', '内联 ZIP 写入器',
  zipLib ? '本地头 / 中央目录 / EOCD 齐全，UTF-8 标志在位，零依赖' : '写入器缺件：中文名会乱码或压缩包打不开');
const zipOne = has(/async function exportDetailsZip\(/) && has(/new Blob\(\[ZIP\.build\(files\)\]/) &&
  !has(/saved\.push\(await saveImage/) && !has(/function exportAllDetails\(/) &&
  has(/function exportViewPng\(/) && has(/function exportDetail\(/);
add(zipOne ? 'PASS' : 'FAIL', '批量只下一次',
  zipOne ? 'N 张先在内存编码、最后一次落盘；三种单张导出不受影响' : '仍在逐张下载，或把单张导出也改坏了');
const zipUi = has(/id="expStop"/) && has(/id="expRetry"/) && has(/id="expPendingSave"/) &&
  has(/id="expZipBox"/) && has(/function expAbort\(/) && has(/EXP\.stop=false/) &&
  has(/expShowFail\(failed/);
add(zipUi ? 'PASS' : 'FAIL', '停止 / 重试 / 收起弹窗',
  zipUi ? '停止不落盘、失败可只重试、弹窗收起不突然弹框' : '缺停止 / 重试 / 待保存之一');
const zipEnv = has(/how==='ios'/) && has(/在浏览器中打开/) && has(/「文件」App/) &&
  has(/'sandbox'/) && has(/Math\.max\(90000,n\*12000\)/);
add(zipEnv ? 'PASS' : 'FAIL', '四环境降级与动态超时',
  zipEnv ? '微信 / 沙箱 / iOS 各有引导，遮罩超时按张数延长' : '降级文案或超时兜底缺件');

/* 7e. 顶栏层级与一级分享入口（1.4.2）
   F2 把清单改成 z-index:1200 的浮层后，它是 <main> 的直接子元素（main 无 z-index），
   与 header 同层比较时 1200 完胜 60，把「更多」下拉菜单整个压在底下 —— 菜单末两项
   「生成分享链接 / 生成回传链接」存在但点不到。1.4.2 提 header 到 2000，并把两者提到顶栏。 */
const headerLayer = has(/header\{z-index:2000\}/) &&
  src.indexOf('header{z-index:2000}') > src.indexOf('header{position:relative;z-index:60}') &&
  has(/aside#sidebar\{position:absolute;z-index:1200/);
add(headerLayer ? 'PASS' : 'FAIL', '顶栏层级盖过浮层',
  headerLayer ? 'header 2000 > 浮层 1200，且写在旧 60 之后（弹窗 3000 / 99999 不受影响）'
    : '层级没提或写反了：「更多」菜单会被右侧清单压住');

const toolsSlice = (() => {
  const a = src.indexOf('<div class="tools">'), b = src.indexOf('<div class="morewrap">', a);
  return a >= 0 && b > a ? src.slice(a, b) : '';
})();
const menuSlice = (() => {
  const a = src.indexOf('id="moremenu"'), b = src.indexOf('</header>', a);
  return a >= 0 && b > a ? src.slice(a, b) : '';
})();
const topEntries = /id="btnShare"[\s\S]{0,800}?<span class="bl">分享<\/span>/.test(toolsSlice) &&
  /id="btnReturn"[\s\S]{0,800}?<span class="bl">回传<\/span>/.test(toolsSlice) &&
  !/id="btnShare"/.test(menuSlice) && !/id="btnReturn"/.test(menuSlice) &&
  has(/var b1=\$\('#btnShare'\),b2=\$\('#btnReturn'\)/);
add(topEntries ? 'PASS' : 'FAIL', '分享 / 回传一级入口',
  topEntries ? '顶栏两个按钮在位（1.4.9 起是图标 + .bl 文字双份）、菜单已删重、id 事件绑定不变'
    : '一级按钮缺失、菜单仍有重复项，或分享模块绑定被改坏');

const noDanglingSep = !/切到静态底图<\/button>\s*<div class="sep">/.test(src) &&
  /id="btnMode">切到静态底图<\/button>/.test(menuSlice);
add(noDanglingSep ? 'PASS' : 'FAIL', '菜单尾部无悬空分隔线',
  noDanglingSep ? '删掉末两项后，最后一条 sep 一并移除' : '菜单末尾留着一条空分隔线');

const narrowFit = has(/\.tools\{gap:5px;flex-wrap:nowrap;flex:0 0 auto\}/) &&
  has(/\.tools>\.btn,\.tools \.morewrap>\.btn\{width:34px;height:34px;padding:0;gap:0\}/) &&
  has(/\.tools>\.btn \.bl,\.tools \.morewrap>\.btn \.bl\{display:none\}/);
add(narrowFit ? 'PASS' : 'FAIL', '窄屏五按钮不掉行',
  narrowFit ? '手机顶栏五个功能收成 34×34 图标（文字 .bl 隐藏），搜索框独占第二行'
    : '窄屏尺寸规则缺失：五个按钮会挤成两三行或藏进「更多」');

/* 7f. 手机底部抽屉（1.4.9）
   手机上原来的浮层是上下左右各 8px 的整屏卡，清单默认展开时把地图全遮住。
   改成贴底 56% 的抽屉、顶上一根把手上拉到 88%，收起时向下平移出屏（桌面端不动）。 */
const sheet = has(/aside#sidebar\{right:8px;left:8px;top:auto;bottom:8px;width:auto;height:56%/) &&
  has(/aside#sidebar\.sheet-tall\{height:88%\}/) &&
  has(/html\.side-off aside#sidebar\{transform:translateY\(calc\(100% \+ 20px\)\)\}/) &&
  has(/id="sheetGrab"/) && has(/html\.sheet-tall \.side-tab\{bottom:calc\(88% \+ 12px\)\}/);
add(sheet ? 'PASS' : 'FAIL', '手机底部抽屉',
  sheet ? '贴底 56% / 把手上拉到 88% / 收起向下出屏，手柄跟着抽屉走'
    : '仍是整屏浮层：手机上清单会盖住整张地图');

/* 7g. 状态图标 + 名称缩短（1.4.9）
   一行原本「序号 + 名称 + 坐标 + 四个字的状态」，窄屏上名称只剩 6~8 字。
   状态改 11px 图标（悬停气泡 + aria-label），名称去括号并截断，全名进 title。 */
const stIco = has(/const ST_ICO=\{/) && has(/function badgeHtml\(st,off\)/) &&
  has(/class="badge ico b-'/) && has(/\.badge\.ico\[data-tip\]::after/) &&
  has(/function dispName\(s\)/) && has(/const cap=sideNarrow\(\)\?12:22;/) &&
  has(/<div class="nm" title="'\+esc\(p\.short\|\|''\)\+'">'\+esc\(dispName\(p\.short\)\)/);
add(stIco ? 'PASS' : 'FAIL', '状态图标与名称缩短',
  stIco ? '状态收成 11px 图标（tooltip + aria-label），名称去括号后按屏宽 12/22 字截断'
    : '状态仍是文字或名称未缩短：一行名称会被挤到 6~8 字');
/* 7h. 标记样式表自愈 + base64 PNG（1.4.10）
   腾讯地图 GL 的 MarkerStyle.src 只承诺「url 或 base64」，百分号编码的 SVG 在 iOS / 微信里
   会被丢掉 → SDK 退回内置白色默认钉子（钉里连序号都没有）；另外分享链接导入时 points 换了新 id，
   样式表还是建图层那一刻的旧表，同样落到默认样式，表现也是「一片白钉子」。 */
const pinPng = has(/function pinPng\(color,num,style\)/) &&
  has(/cv\.width=PIN_W\*PIN_PNG_S; cv\.height=PIN_H\*PIN_PNG_S;/) &&
  has(/out=cv\.toDataURL\('image\/png'\)/) && has(/if\(!out\)out=pinSvg\(color,num,st\);/) &&
  has(/const PIN_PNG_S=3, PIN_PNG_CACHE=new Map\(\);/);
add(pinPng ? 'PASS' : 'FAIL', '标记图 base64 PNG',
  pinPng ? '3 倍 PNG base64 + 缓存，画布不可用时退回 SVG'
    : '仍在用 SVG data URI：iOS / 微信可能整张丢掉，地图上只剩白色默认钉子');

const pinSync = has(/function pinStyleId\(p\)\{return p\.id\+\(p\.off\?'_off':'_'\+p\.status\);\}/) &&
  has(/function syncPinStyles\(\)/) && has(/markerLayer\.setStyles\(buildStyles\(\)\)/) &&
  has(/function renderMarkers\(\)\{[\s\S]{0,220}?syncPinStyles\(\);\s*markerLayer\.setGeometries/) &&
  has(/src:pinPng\(p\.off\?OFF_COLOR:\(COLORS\[p\.status\]\|\|COLORS\.missing\),p\.no\)/);
add(pinSync ? 'PASS' : 'FAIL', '标记样式自愈',
  pinSync ? '点位 / 序号 / 状态 / 配色一变就 setStyles 重建，分享导入不再全白'
    : 'renderMarkers 仍只 setGeometries：导入的点没有样式条目，会画成默认白色标记');

/* 7i. 更多菜单的六条收起路径（1.4.11）
   菜单原来只在冒泡阶段听 mousedown：手机点地图时 SDK 在 touchstart 里 preventDefault，
   合成的 mousedown 收不到，点开就收不回去；桌面上也没有移出收起的路径。 */
const moreClose = has(/function moreClose\(\)\{[\s\S]{0,200}?classList\.remove\('open'\)[\s\S]{0,120}?setAttribute\('aria-expanded','false'\)/) &&
  has(/function moreIsOpen\(\)/);
add(moreClose ? 'PASS' : 'FAIL', '菜单关闭只走一处',
  moreClose ? 'moreClose() 同时清类名与 aria-expanded，重复调不报错'
    : '类名与 aria 各改各的，读屏会说「已展开」而眼前已收起');

const moreTriggers = has(/document\.addEventListener\('pointerdown',outDown,true\)/) &&
  has(/wrap\.addEventListener\('focusout'/) &&
  has(/window\.addEventListener\('blur'/) &&
  has(/wrap\.addEventListener\('mouseleave'/) &&
  has(/e\.key==='Escape'\|\|e\.key==='Esc'/) &&
  has(/mp\.addEventListener\('wheel'/);
add(moreTriggers ? 'PASS' : 'FAIL', '菜单六条收起路径',
  moreTriggers ? '指针按下(capture) / 焦点离开 / 窗口失焦 / 鼠标移出 / Esc / 地图滚轮'
    : '缺路径：手机上点别处或桌面移开鼠标后，菜单还会挂在屏幕上');

const moreLeaves = has(/hoverT=setTimeout\(moreClose,260\)/) &&
  has(/wrap\.addEventListener\('mouseenter',\(\)=>\{clearTimeout\(hoverT\);hoverT=0;\}\)/) &&
  has(/\.morewrap>\.btn\[aria-expanded="true"\]/);
add(moreLeaves ? 'PASS' : 'FAIL', '移出宽限与打开态',
  moreLeaves ? '260ms 宽限可穿过 7px 间隙，移回即取消；「更多」按钮随之高亮'
    : '移出即收会闪，或按钮看不出菜单已展开');

/* 手机端菜单项放大到 ~40px，且这组规则必须排在主题覆盖之后：
   1229 行那组 .moremenu{border-radius:5px} / button{font-size:11.5px} 与它同优先级，
   靠源码顺序决胜负，写早了会被盖掉 —— 这是「改了字号却没变大」的经典坑。 */
const iThemeMenu = src.indexOf('.moremenu{background:linear-gradient(');
const iTouchMenu = src.indexOf('min-width:200px;padding:6px;border-radius:11px');
const touchMenu = iThemeMenu > 0 && iTouchMenu > iThemeMenu &&
  has(/@media\(max-width:600px\)\{\s*\.moremenu\{min-width:200px/) &&
  has(/\.moremenu button\{padding:12px 13px;font-size:13px/);
add(touchMenu ? 'PASS' : 'FAIL', '手机菜单项 40px 触控',
  touchMenu ? '窄屏 13px 字号 + 12px 内边距 ≈ 40px，且排在主题覆盖之后生效'
    : `菜单项仍是 33px，或这组规则写在主题块之前被盖掉（theme@${iThemeMenu} / touch@${iTouchMenu}）`);

/* 7j. 框架浮岛（1.4.12）：地图铺满，顶栏/状态条/清单/详情都浮在上面
   全部规则挂在 html[data-fw="island"] 前缀下，设置里切回 float 就整块失效，是可回滚的分支。 */
const island = has(/html\[data-fw="island"\] header\{[\s\S]{0,200}?position:absolute/) &&
  has(/html\[data-fw="island"\] header\{[\s\S]{0,400}?border-radius:14px/) &&
  has(/html\[data-fw="island"\] \.statusbar\{[\s\S]{0,200}?position:absolute/) &&
  has(/html\[data-fw="island"\] aside#sidebar\{[\s\S]{0,160}?left:20px;right:auto/) &&
  has(/html\[data-fw="island"\] #detail\{right:20px;top:auto;bottom:20px/) &&
  has(/html\[data-fw="island"\]\.side-off aside#sidebar\{transform:translateX\(calc\(-100% - 24px\)\)/);
add(island ? 'PASS' : 'FAIL', '浮岛框架',
  island ? '顶栏胶囊 / 状态条胶囊 / 左下清单卡 / 右下详情卡，收起方向跟着卡片走'
    : '缺一块：地图没铺满，或某块还是旧的横带/贴边面板');

const fwSwitch = has(/<html lang="zh-CN" data-fw="island">/) &&
  has(/const FW_STORE='xy_fw_v1';/) && has(/\{k:'float', name:'浮层'/) &&
  has(/function applyFw\(k,opt\)/) && has(/initTheme\(\); initFw\(\)/) &&
  has(/<div class="segset" id="setFw"/) && has(/\[data-fwk\]/);
add(fwSwitch ? 'PASS' : 'FAIL', '框架可切回浮层',
  fwSwitch ? '设置里「框架布局」两档，island 默认、float 回原 F2；首屏就带 data-fw 不闪'
    : '开关缺件：属性没写到 <html>、没绑定、或没进 boot，切了不生效');

/* 7k. 地图原生控件避让（1.4.13）：浮岛把顶栏和状态条浮在地图上，腾讯自带的缩放 ±、旋转罗盘
   正好压在下面；左下比例尺 + logo 被清单浮卡压半边。做法是量出遮挡物边界、推控件所在的那个角
   容器（同角控件共用一个绝对定位容器），并在切回浮层时还原。 */
const ctrlAvoid = has(/function mapCorner\(sel\)/) &&
  has(/function syncMapCtrl\(\)/) &&
  has(/const tr=mapCorner\('\.tmap-zoom-control'\)/) &&
  has(/const bl=mapCorner\('\.tmap-scale-control'\)/) &&
  has(/syncMapCtrl\(\);\s*\n\}/) &&
  has(/setTimeout\(syncMapCtrl,340\)/) &&
  has(/\[120,400,1200\]\.forEach\(ms=>setTimeout\(syncStatusOffset,ms\)\)/) &&
  has(/html\[data-fw="island"\] \.tmap-zoom-control\{margin-top:20px\}/);
add(ctrlAvoid ? 'PASS' : 'FAIL', '地图控件避让浮岛',
  ctrlAvoid ? '右上(罗盘+缩放)推到状态胶囊下方、左下(比例尺+logo)让开清单卡，位置按实测；浮层下还原'
    : '缺件：没找角容器、没在状态条定位后调用、清单收放后没重量，或切回浮层不还原');

if (/[\\/]site[\\/]/.test(file)) {
  const og = (src.match(/<meta property="og:image" content="([^"]+)"/) || [])[1] || '';
  add(/^https:\/\//.test(og) ? 'PASS' : 'FAIL', '分享卡片 og:image',
    /^https:\/\//.test(og) ? '绝对地址 + sharecode 已在' : '还是相对路径：cp 覆盖后忘了重打补丁');
} else {
  add('PASS', '发布副本', '当前检查的是主文件，og 补丁在 site/index.html 上单独校验');
}

/* 输出 */
const icon = { PASS: '✅', WARN: '⚠️ ', FAIL: '❌' };
const w = Math.max(...rows.map((r) => [...r.name].length));
console.log(`\n体检对象：${path.relative(process.cwd(), file) || file}\n`);
for (const r of rows) console.log(`${icon[r.level]} ${r.name.padEnd(w)}  ${r.detail}`);
const fails = rows.filter((r) => r.level === 'FAIL').length;
const warns = rows.filter((r) => r.level === 'WARN').length;
console.log(`\n${rows.length - fails - warns} 通过 / ${warns} 提醒 / ${fails} 失败`);
process.exit(fails ? 1 : 0);
