#!/usr/bin/env node
/* 「定位给你」· 真浏览器验一遍「清除个人数据、采用默认设置」。
   做法：先往 localStorage 灌一堆脏数据（配色、标记、侧栏、点位、搜索历史、自填 Key），
   确认页面确实吃到了这些偏好；再用 ?reset=1 打开，确认全部回到默认 —— 点位清空、地图空白。

   用法：
     node scripts/verify-reset.mjs                      # 默认检查技能自带 assets/map.html（file:// 打开）
     node scripts/verify-reset.mjs http://127.0.0.1:8899/map.html
     node scripts/verify-reset.mjs https://xiangyang-9points.app.workbuddy.host/?sharecode=NNNTEDLJEX
   选项：
     --chrome      使用本机安装的 Chrome（channel:'chrome'），默认用 Playwright 自带内核

   依赖：playwright。缺失时打印安装方法并以 2 退出（静态检查请用 check-defaults.mjs）。
*/
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_HTML = path.join(SKILL_ROOT, 'assets', 'map.html');
const argv = process.argv.slice(2);
const useChrome = argv.includes('--chrome');
const target = argv.find((a) => !a.startsWith('--')) || DEFAULT_HTML;
const url = /^https?:/.test(target) ? target : pathToFileURL(path.resolve(target)).href;
const sep = url.includes('?') ? '&' : '?';

/* playwright 一般装在「使用者的某个项目」里，不在技能目录。
   顺序：环境变量 PLAYWRIGHT_ROOT → cwd 及其上溯 → 技能目录及其上溯 → cwd 的兄弟项目（常见于工作区）。
   都不行时提示用 PLAYWRIGHT_ROOT 指定，避免要求使用者把依赖装进技能目录。 */
function siblingProbes() {
  const out = [];
  try {
    const parent = path.dirname(process.cwd());
    for (const ent of fs.readdirSync(parent, { withFileTypes: true }).slice(0, 60)) {
      if (!ent.isDirectory()) continue;
      const cand = path.join(parent, ent.name);
      if (fs.existsSync(path.join(cand, 'node_modules', 'playwright'))) out.push(cand + path.sep);
    }
  } catch {}
  return out;
}
function loadPlaywright() {
  const probes = [];
  if (process.env.PLAYWRIGHT_ROOT) probes.push(path.resolve(process.env.PLAYWRIGHT_ROOT) + path.sep);
  for (const start of [process.cwd(), SKILL_ROOT]) {
    let dir = start;
    for (let i = 0; i < 5; i++) {
      probes.push(dir + path.sep);
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  probes.push(...siblingProbes());
  for (const base of probes) {
    try { return createRequire(base)('playwright'); } catch {}
  }
  return null;
}
const pw = loadPlaywright();
if (!pw || !pw.chromium) {
  console.error('缺少 playwright：npm i -D playwright && npx playwright install chromium');
  console.error('已装在别处时用环境变量指过去：PLAYWRIGHT_ROOT=/path/to/project node scripts/verify-reset.mjs');
  console.error('只想做静态体检：node scripts/check-defaults.mjs');
  process.exit(2);
}
const { chromium } = pw;

/* 脏数据：点两个、配色 g8、标记 hex、侧栏收起、详情 6 秒、有历史、有自填 Key */
const DIRTY = {
  xy_theme_v1: 'g8',
  xy_pin_style_v1: 'hex',
  xy_side_off_v1: '1',
  xy_detail_hold_v1: '6000',
  xy_search_hist_v1: JSON.stringify(['襄阳市', '昭明台']),
  xy_points_v1: JSON.stringify([
    { id: 't1', no: 1, short: '测试点甲', raw: '湖北省襄阳市襄城区示例路 1 号', lat: 32.0183, lng: 112.1513, status: 'auto', source: '手动新增' },
    { id: 't2', no: 2, short: '测试点乙', raw: '湖北省襄阳市樊城区示例路 2 号', lat: 32.0431, lng: 112.1351, status: 'manual', source: '人工校正' },
  ]),
  xy_tx_key_v1: 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF',
  xy_side_hint_v1: '1',
};

const rows = [];
const check = (name, ok, detail) => rows.push({ name, ok, detail });

const browser = await chromium.launch(useChrome ? { channel: 'chrome' } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

try {
  /* ① 灌脏数据 → 刷新一次，确认偏好真的生效 */
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof points !== 'undefined', null, { timeout: 30000 });
  await page.evaluate((d) => { for (const [k, v] of Object.entries(d)) localStorage.setItem(k, v); }, DIRTY);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof points !== 'undefined', null, { timeout: 30000 });
  await page.waitForTimeout(1200);

  const before = await page.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    side: document.documentElement.classList.contains('side-off'),
    points: points.length,
    cards: document.querySelectorAll('#list .card').length,
    keys: Object.keys(localStorage).filter((k) => k.indexOf('xy_') === 0).length,
  }));
  check('脏数据已生效', before.theme === 'g8' && before.points === 2,
    `theme=${before.theme} 侧栏收起=${before.side} 点位=${before.points} 卡片=${before.cards} 键=${before.keys}`);

  /* ② ?reset=1 → 回到默认（空白地图） */
  await page.goto(url + sep + 'reset=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof points !== 'undefined', null, { timeout: 30000 });
  await page.waitForTimeout(1600);

  const after = await page.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    pin: typeof PIN_STYLE === 'string' ? PIN_STYLE : '',
    side: document.documentElement.classList.contains('side-off'),
    points: points.length,
    cards: document.querySelectorAll('#list .card').length,
    store: localStorage.getItem('xy_points_v1'),
    empty: !!document.querySelector('#list .listempty'),
    hist: (() => { try { return JSON.parse(localStorage.getItem('xy_search_hist_v1') || '[]').length; } catch { return -1; } })(),
    key: localStorage.getItem('xy_tx_key_v1'),
    url: location.href,
    status: (document.querySelector('#statustext') || {}).textContent || '',
  }));

  check('配色回默认 g1 深空青', after.theme === 'g1', `theme=${after.theme}`);
  check('标记回默认 halo', after.pin === 'halo', `pin=${after.pin}`);
  check('侧栏回默认', after.side === false, `窄屏=false 桌面收起=${after.side}`);
  check('点位清空为空白地图', after.points === 0 && after.cards === 0 && after.store === null,
    `points=${after.points} 卡片=${after.cards} 存储=${after.store === null ? '已删' : after.store}`);
  check('显示空白清单引导', after.empty, after.empty ? '有「还没有点位」引导' : '缺少空白引导');
  check('搜索历史已清', after.hist === 0, `hist=${after.hist}`);
  check('自填 Key 已清（回到内置）', !after.key, `key=${after.key || '空'}`);
  check('reset 参数已从地址栏移除', !/reset=1/.test(after.url), after.url.slice(-40));
  check('给了「已恢复默认」回执', /恢复默认/.test(after.status), after.status || '（无提示）');
  check('无新增 JS 报错', errors.filter((e) => !/Invalid URL|鉴权失败|不支持在file协议/.test(e)).length === 0,
    errors.filter((e) => !/Invalid URL|鉴权失败|不支持在file协议/.test(e)).slice(0, 2).join(' / ') || '干净');
} finally {
  await browser.close();
}

const w = Math.max(...rows.map((r) => [...r.name].length));
console.log(`\n验证地址：${url}\n`);
for (const r of rows) console.log(`${r.ok ? '✅' : '❌'} ${r.name.padEnd(w)}  ${r.detail}`);
const bad = rows.filter((r) => !r.ok).length;
console.log(`\n${rows.length - bad} 通过 / ${bad} 失败\n`);
process.exit(bad ? 1 : 0);
