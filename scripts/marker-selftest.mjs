/* 标记样式自愈的行为验证（1.4.10 起）。
   背景：腾讯地图 GL 的 MultiMarker 样式表是**建图层那一刻**按当时的 points 生成的；
   分享链接走 applyShare → importData，点位全是新 id，而 importData 结尾只 setGeometries 不重建样式表，
   SDK 找不到 styleId 就画内置的白色默认钉子。地图上看起来是「一片白钉子、钉里连序号都没有」。
   check-defaults 只能锁住代码形状，这里用假 TMap 真跑一遍 map.html 的代码片段，
   锁住行为：导入后补样式、状态变了重建、签名没变不重复重建、样式图是 base64 PNG。

   用法：node scripts/marker-selftest.mjs [map.html 路径] */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || path.join(here, '..', 'assets', 'map.html');
const src = fs.readFileSync(file, 'utf8');

/* 只取需要的三段代码：配色常量、标记画笔（PIN_* / pinOps / pinSVGMarkup / pinSvg / pinPng / paintPinOps）、
   样式表与渲染（pinStyleId / pinSig / buildStyles / syncPinStyles / renderMarkers）。 */
function slice(a, b, what) {
  const i = src.indexOf(a);
  if (i < 0) throw new Error('找不到起点：' + what);
  const j = src.indexOf(b, i);
  if (j < 0) throw new Error('找不到终点：' + what);
  return src.slice(i, j + b.length);
}
/* 切片终点必须落在「整段注释之后」，否则留下半个 /* 会把后面的代码全吃掉 */
const colors = slice('const COLORS = {', 'syncThemeColors();\n', '配色常量');
const pins = slice('const PIN_W=44', 'if(o.shadow)g.restore();\n  });\n}', '标记画笔');
const render = slice('function pinStyleId(', 'markerLayer.setGeometries(geometries());\n}', '样式表与渲染');
const body = 'var markerLayer=null, points=[];\n' + colors + '\n' + pins + '\n' + render;

const stats = { sets: 0, styles: {}, geo: null };
const TMap = {
  MarkerStyle: function (o) { Object.assign(this, o); },
  LatLng: function (a, b) { this.lat = a; this.lng = b; },
  MultiMarker: function (o) {
    if (o && o.styles) stats.styles = o.styles;
    this.setMap = () => {};
    this.setStyles = (s) => { stats.sets++; stats.styles = s; };
    this.setGeometries = (g) => { stats.geo = g; };
  },
};
const ctx = new Proxy({}, {
  get: (t, p) => (p === 'canvas' ? {} : (typeof p === 'string' ? () => ctx : undefined)),
  set: () => true,
});
const documentStub = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ctx, toDataURL: () => 'data:image/png;base64,stub' }),
  documentElement: { getAttribute: () => 'p1' },
};

const api = new Function('TMap', 'document', 'Path2D', 'FB', body + `
  return {
    renderMarkers,
    newLayer(){ markerLayer = new TMap.MultiMarker({ styles: buildStyles() }); PIN_SIG = pinSig(); },
    setPoints(v){ points = v; },
  };`)(TMap, documentStub, function () { this.arc = () => {}; this.rect = () => {}; }, undefined);

const mk = (id, status, no, off) => ({ id, status, no, lat: 32, lng: 112, off: !!off, hidden: false, short: 'x', raw: 'x' });
const rows = [];
const add = (ok, name, detail) => rows.push({ ok, name, detail });

/* 1. 首屏只建当前用到的 styleId（原来每个点画全 5 种状态，每张都是十几 KB 的 base64） */
api.setPoints([mk('a', 'auto', 1)]);
api.newLayer();
api.renderMarkers();
let keys = Object.keys(stats.styles);
add(keys.length === 1 && keys[0] === 'a_auto', '首屏样式表按需生成', keys.join(',') || '(空)');

/* 2. 签名没变就别重复建样式（每拖动一次都重建会卡） */
const before = stats.sets;
api.renderMarkers();
api.renderMarkers();
add(stats.sets === before, '签名未变不重建', `setStyles 多调 ${stats.sets - before} 次`);

/* 3. 分享导入：新 id 进来必须补样式 —— 这正是「一片白钉子」的场景 */
api.setPoints([mk('a', 'auto', 1), mk('b', 'manual', 2)]);
api.renderMarkers();
keys = Object.keys(stats.styles).sort();
add(keys.join(',') === 'a_auto,b_manual', '导入新点位后补样式', keys.join(','));
add((stats.geo || []).length === 2, '几何随之更新', `geometries=${(stats.geo || []).length}`);

/* 4. 状态变化 / 停用都要重建 */
api.setPoints([mk('a', 'manual', 1)]);
api.renderMarkers();
add(Object.keys(stats.styles).includes('a_manual'), '改状态后重建', Object.keys(stats.styles).join(','));
api.setPoints([mk('a', 'auto', 1, true)]);
api.renderMarkers();
add(Object.keys(stats.styles).includes('a_off'), '停用后重建', Object.keys(stats.styles).join(','));

/* 5. 样式图必须是 base64 PNG（SVG data URI 在 iOS / 微信里可能整张被丢掉） */
const any = Object.values(stats.styles)[0];
const anySrc = String(any && any.src);
add(anySrc.startsWith('data:image/png;base64,'), '样式图是 base64 PNG', anySrc.slice(0, 26) + '…');

/* 6. 锚点仍是针尖 (22,53)，否则拖到哪都偏 */
add(any && any.anchor && any.anchor.x === 22 && any.anchor.y === 53, '锚点在针尖', JSON.stringify(any && any.anchor));

let bad = 0;
console.log(`\n标记自检：${path.relative(process.cwd(), file)}\n`);
for (const r of rows) {
  if (!r.ok) bad++;
  console.log(`${r.ok ? '  OK  ' : ' FAIL '} ${r.name.padEnd(22)} ${r.detail}`);
}
console.log(`\n${rows.length - bad} 通过 / ${bad} 失败`);
process.exit(bad ? 1 : 0);
