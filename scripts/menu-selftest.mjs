/* 「更多」菜单收起路径的行为验证（1.4.11 起）。
   背景：菜单原来只在 document 冒泡阶段听 mousedown，手机点地图时腾讯地图 SDK 在 touchstart 里
   preventDefault，合成的 mousedown 根本不会出现 —— 点开就收不回去；桌面上也没有鼠标移出这条路径。
   check-defaults 只能锁住代码形状，这里用最小 DOM 桩真跑 map.html 里的 bindMore()，
   锁住六条收起路径：指针按下（capture）、焦点离开、窗口失焦、鼠标移出宽限、Esc、地图滚轮。

   用法：node scripts/menu-selftest.mjs [map.html 路径] */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || path.join(here, '..', 'assets', 'map.html');
const src = fs.readFileSync(file, 'utf8');

function slice(a, b, what) {
  const i = src.indexOf(a);
  if (i < 0) throw new Error('找不到起点：' + what);
  const j = src.indexOf(b, i);
  if (j < 0) throw new Error('找不到终点：' + what);
  return src.slice(i, j + b.length);
}
const body = slice('function moreClose(){', "if(e.target.closest('button'))close();\n  });\n}", '菜单开关');

/* ---------- 最小 DOM 桩 ---------- */
class EM {
  constructor() { this.m = new Map(); this.cap = new Set(); }
  addEventListener(type, fn, opt) {
    if (!this.m.has(type)) this.m.set(type, []);
    this.m.get(type).push(fn);
    if (opt === true || (opt && opt.capture)) this.cap.add(fn);
  }
  fire(type, ev) {
    const list = this.m.get(type) || [];
    for (const fn of list) fn(ev);
  }
}
class El extends EM {
  constructor(id, parent, tag) {
    super();
    this.id = id;
    this.tag = (tag || 'div').toLowerCase();
    this.parentNode = parent || null;
    this.children = [];
    this.attrs = {};
    this.cls = new Set();
    this.focused = 0;
    if (parent) parent.children.push(this);
    const self = this;
    this.classList = {
      contains: (c) => self.cls.has(c),
      add: (c) => { self.cls.add(c); },
      remove: (c) => { self.cls.delete(c); },
      toggle: (c) => (self.cls.has(c) ? (self.cls.delete(c), false) : (self.cls.add(c), true)),
    };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  focus() { this.focused++; doc.activeElement = this; }
  contains(node) {
    if (node === this) return true;
    return this.children.some((c) => c.contains && c.contains(node));
  }
  closest(sel) {
    if (sel.charAt(0) === '#') return this.id === sel.slice(1) ? this : null;
    return this.tag === sel.toLowerCase() ? this : null;
  }
}

const doc = new EM();
doc.activeElement = null;
doc.focusState = false;          /* 真实浏览器里窗口失焦时 hasFocus() 就是 false */
doc.hasFocus = () => doc.focusState;
const wrap = new El('morewrap');
const btn = new El('btnMore', wrap);
const menu = new El('moremenu', wrap);
const mapEl = new El('map');
const elsewhere = new El('elsewhere');
const nodes = { '#btnMore': btn, '#moremenu': menu, '#map': mapEl };
const $ = (sel) => nodes[sel] || null;
const win = new EM();
win.hasFocus = () => false;
const nav = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' };

const api = new Function('$', 'document', 'window', 'navigator', 'setTimeout', 'clearTimeout',
  body + '\n  return { bindMore, moreIsOpen, moreClose };')(
  $, doc, win, nav, setTimeout, clearTimeout);

api.bindMore();

/* 事件对象：指针 / 鼠标 / 滚轮 / 键盘 */
const ptr = (target) => ({ target, pointerType: 'mouse' });
const isOpen = () => menu.classList.contains('open');
const aria = () => btn.getAttribute('aria-expanded');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
const add = (ok, name, detail) => rows.push({ ok, name, detail });

/* 每次从「打开」状态开始 */
async function fresh() {
  if (!isOpen()) btn.onclick({ stopPropagation() {} });
  if (!isOpen()) throw new Error('按钮点不开菜单');
}

await fresh();
add(isOpen() && aria() === 'true', '点按钮打开', 'open + aria-expanded=true');

btn.onclick({ stopPropagation() {} });
add(!isOpen() && aria() === 'false', '再点按钮收起', 'open 撤掉 + aria=false');

/* ① 指针按下（capture 阶段注册，触屏也算） */
await fresh();
const downFns = doc.m.get('pointerdown') || [];
add(downFns.length > 0 && doc.cap.has(downFns[0]), '指针按下用 capture 注册',
  `pointerdown 监听 ${downFns.length} 个，capture=${doc.cap.has(downFns[0])}`);

doc.fire('pointerdown', ptr(elsewhere));
add(!isOpen(), '点菜单外收起', '地图/清单/别处按下即收');

await fresh();
doc.fire('pointerdown', ptr(menu));
add(isOpen(), '点菜单内不收', '菜单项按下时保持展开');

/* ② 焦点离开 */
await fresh();
doc.activeElement = elsewhere;
wrap.fire('focusout', {});
await sleep(5);
add(!isOpen(), '焦点离开收起', 'activeElement 落到菜单与按钮之外');

await fresh();
doc.activeElement = btn;
wrap.fire('focusout', {});
await sleep(5);
add(isOpen(), '焦点仍在按钮不收', 'Tab 回到按钮时保持展开');

/* ③ 窗口失焦（桌面 UA） */
await fresh();
doc.focusState = false;          /* 窗口真的不在前台 */
win.fire('blur', {});
await sleep(180);
add(!isOpen(), '窗口失焦收起', '切到别的应用 / 点地址栏');

/* ④ 鼠标移出：260ms 宽限 */
await fresh();
wrap.fire('mouseleave', {});
await sleep(120);
add(isOpen(), '移出 120ms 内还开着', '宽限期没过，给穿过按钮与菜单间隙留时间');
await sleep(220);
add(!isOpen(), '移出 260ms 后收起', '指针真离开就收');

await fresh();
wrap.fire('mouseleave', {});
await sleep(150);
wrap.fire('mouseenter', {});
await sleep(300);
add(isOpen(), '移出后又移回则不收', 'mouseenter 取消待收计时');

/* ⑤ Esc */
await fresh();
let stopped = false;
const escFn = (doc.m.get('keydown') || []).find((f) => {
  const before = isOpen();
  f({ key: 'Escape', stopPropagation() { stopped = true; } });
  return before && !isOpen();
}) || null;
add(!isOpen() && stopped, 'Esc 收起并拦下冒泡', 'stopPropagation 防止顺带关掉别的弹层');
add(btn.focused > 0 && doc.activeElement === btn, 'Esc 后焦点回按钮', `focus 调用 ${btn.focused} 次`);

/* ⑥ 地图滚轮缩放不产生 pointerdown，单独收 */
await fresh();
mapEl.fire('wheel', {});
add(!isOpen(), '地图滚轮收起', '滚轮缩放地图时菜单一起收');

/* 点菜单项收起（先收再执行，避免弹窗压在菜单上） */
const item = new El('btnCsv', menu, 'button');
await fresh();
menu.fire('click', { target: item });
add(!isOpen(), '点菜单项收起', '先收起再执行动作');

/* 状态一致性：类名与 aria 必须同步 */
add(aria() === 'false' && !isOpen(), '收起后 aria 与类名同步', `aria=${aria()} open=${isOpen()}`);

let bad = 0;
console.log(`\n菜单自检：${path.relative(process.cwd(), file)}\n`);
for (const r of rows) {
  if (!r.ok) bad++;
  console.log(`${r.ok ? '  OK  ' : ' FAIL '} ${r.name.padEnd(22)} ${r.detail}`);
}
console.log(`\n${rows.length - bad} 通过 / ${bad} 失败`);
process.exit(bad ? 1 : 0);
