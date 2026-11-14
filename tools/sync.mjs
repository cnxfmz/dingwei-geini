#!/usr/bin/env node
// dingwei-geini -> GitHub 长期同步器
//
//   node tools/sync.mjs              同步 + 生成提交 + 推送 + 校验远端
//   node tools/sync.mjs --no-push    只同步并提交，不推送（首次登录前用）
//   node tools/sync.mjs --check      只检查有没有未同步的改动，不提交
//   node tools/sync.mjs --dry-run    只打印将要生成的提交消息
//
// 原则：技能目录只读；仓库是独立镜像；所有变更以 git 的真实 diff 为准；
//       提交消息优先取 CHANGELOG.md 的新增条目，没写日志才回退到 diff。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(TOOLS, '..');
const GIT = process.platform === 'win32' ? 'git.exe' : 'git';
const args = new Set(process.argv.slice(2));
const NO_PUSH = args.has('--no-push');
const CHECK = args.has('--check');
const DRY_RUN = args.has('--dry-run');

function fail(msg) {
  console.error(`[sync] 中止：${msg}`);
  process.exit(1);
}

function git(...a) {
  return execFileSync(GIT, ['-C', REPO, ...a], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitMaybe(...a) {
  try {
    return git(...a);
  } catch {
    return null;
  }
}

function readConfig() {
  const p = path.join(TOOLS, 'sync.local.json');
  if (!fs.existsSync(p)) {
    fail('缺少 tools/sync.local.json，请照 sync.paths.example.json 填一份（该文件已被 .gitignore 排除）');
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    fail(`sync.local.json 不是合法 JSON：${e.message}`);
  }
  for (const k of ['skillDir', 'remote', 'branch']) {
    if (!cfg[k]) fail(`sync.local.json 缺少字段 ${k}`);
  }
  return cfg;
}

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === '.git' || ent.name === 'node_modules') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile()) out.push(p);
  }
  return out;
}

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.gitignore', 'tools', 'site', 'sync.local.json'].includes(ent.name)) continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyTree(s, d);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

const TEXT_FILE = /\.(html?|bak|js|mjs|cjs|css|json|md|txt|svg|py)$/i;

// 公开仓库专属的入口说明：追加在 README 末尾，标记保证重复同步不会叠加
const NOTE_MARKER = '<!-- github-repo-notes -->';
const REPO_NOTES = [
  '## 关于这个 GitHub 仓库',
  '',
  '这里是「定位给你」技能包的公开版本库，用于版本记录与收集使用反馈。',
  '',
  '- 在线体验：https://xiangyang-9points.app.workbuddy.host/?sharecode=NNNTEDLJEX',
  '- 想直接用页面：双击 `assets/map.html` 即可，无需安装任何环境',
  '- 想装成 WorkBuddy 技能：`dist/dingwei-geini.zip` 是技能市场提交包',
  '- 每次改了什么、为什么改，见 `CHANGELOG.md` 与提交历史',
  '- 使用问题、建议、bug 请开 Issue，作者会在这里跟进',
  '',
  '注：仓库中的地图页面已移除内置的腾讯位置服务 Key（避免被批量抓取滥用），',
  '首次打开按页面提示填入自己的 Key 即可；线上体验链接不受影响。',
].join('\n');

function appendRepoNotes() {
  const p = path.join(REPO, 'README.md');
  if (!fs.existsSync(p)) return;
  const src = fs.readFileSync(p, 'utf8').split(NOTE_MARKER)[0].replace(/\s+$/, '');
  fs.writeFileSync(p, `${src}\n\n${NOTE_MARKER}\n${REPO_NOTES}\n`, 'utf8');
}

function main() {
  const cfg = readConfig();
  const skillDir = cfg.skillDir;
  const siteHtml = cfg.siteHtml;
  const siteExists = !!siteHtml && fs.existsSync(siteHtml);

  if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) {
    fail(`技能目录不可用：${skillDir}`);
  }
  if (gitMaybe('rev-parse', '--is-inside-work-tree') === null) {
    fail(`${REPO} 不是 git 仓库`);
  }
  if (!siteExists) {
    console.warn(`[sync] 警告：站点副本不存在（${siteHtml || '未配置'}），本次跳过 site/index.html，仓库内旧副本保持不动`);
  }

  // 1. 从源文件里取出内嵌 key，仅用于校验，绝不写进仓库或日志
  const srcMap = path.join(skillDir, 'assets', 'map.html');
  const srcText = fs.existsSync(srcMap) ? fs.readFileSync(srcMap, 'utf8') : '';
  const keyMatch = srcText.match(/const\s+TXK_DEFAULT\s*=\s*'([^']+)'/);
  const embeddedKey = keyMatch ? keyMatch[1] : '';

  // 2. 清空镜像工作树里的已同步内容，再按源重建（这样删除也能被 git 捕捉）
  const keep = new Set(['.git', 'tools', '.gitignore', 'node_modules']);
  if (!siteExists) keep.add('site');
  for (const ent of fs.readdirSync(REPO, { withFileTypes: true })) {
    if (keep.has(ent.name)) continue;
    fs.rmSync(path.join(REPO, ent.name), { recursive: true, force: true });
  }
  copyTree(skillDir, REPO);
  if (siteExists) {
    fs.mkdirSync(path.join(REPO, 'site'), { recursive: true });
    fs.copyFileSync(siteHtml, path.join(REPO, 'site', 'index.html'));
  }
  appendRepoNotes();

  // 3. 脱敏：11 处 TXK_DEFAULT 统一置空；随后全仓校验 key 明文不残留
  let sanitized = 0;
  for (const f of walk(REPO)) {
    if (f.startsWith(path.join(REPO, 'tools') + path.sep)) continue;
    if (!TEXT_FILE.test(f)) continue;
    const raw = fs.readFileSync(f);
    const before = raw.toString('utf8');
    // 非 UTF-8 文本不做字符串改写，避免往返损坏字节；若其中藏有 key，下面的全仓校验会拦下
    if (!Buffer.from(before, 'utf8').equals(raw)) continue;
    let after = before.replace(/const\s+TXK_DEFAULT\s*=\s*'[^']*'/g, "const TXK_DEFAULT=''");
    if (embeddedKey) after = after.split(embeddedKey).join('');
    if (after !== before) {
      fs.writeFileSync(f, after, 'utf8');
      sanitized++;
    }
  }
  if (embeddedKey) {
    const needle = Buffer.from(embeddedKey, 'utf8');
    const leaked = walk(REPO)
      .filter((f) => !f.startsWith(path.join(REPO, 'tools') + path.sep))
      .filter((f) => fs.readFileSync(f).includes(needle));
    if (leaked.length) {
      fail(`内嵌 key 仍残留在 ${leaked.length} 个文件中，拒绝提交：${leaked.slice(0, 3).map((f) => path.relative(REPO, f)).join(', ')}`);
    }
  }
  console.log(`[sync] 同步完成；脱敏 ${sanitized} 个文件；内嵌 key 校验通过`);

  // 4. 自检模式：只看工作树有没有变化
  if (CHECK) {
    const st = git('status', '--porcelain').trim();
    console.log(st ? `[sync] 有未同步改动：\n${st}` : '[sync] 无未同步改动');
    return;
  }

  git('add', '-A');
  const stat = git('diff', '--cached', '--stat').trim();
  if (!stat) {
    console.log('[sync] 无 diff，跳过提交');
    return;
  }
  const changed = git('diff', '--cached', '--name-only').trim().split('\n').filter(Boolean);
  const nameStatus = git('diff', '--cached', '--name-status').trim().split('\n');
  const hasHead = gitMaybe('rev-parse', '--verify', 'HEAD') !== null;
  const { subject, body } = buildMessage(hasHead, changed, stat, nameStatus);

  console.log(`\n[sync] 提交消息：\n  ${subject}\n${body.split('\n').map((l) => `  ${l}`).join('\n')}\n`);
  if (DRY_RUN) {
    git('reset', '-q');
    console.log('[sync] dry-run，已撤销暂存');
    return;
  }

  git('commit', '-q', '-m', subject, '-m', body);
  const sha = git('rev-parse', 'HEAD').trim();
  console.log(`[sync] 已提交 ${sha.slice(0, 12)}（${changed.length} 个文件）`);

  if (NO_PUSH) {
    console.log('[sync] --no-push：未推送');
    return;
  }

  // 5. 推送 + 远端 sha 校验
  git('push', cfg.remote, `HEAD:refs/heads/${cfg.branch}`);
  const remote = (gitMaybe('ls-remote', cfg.remote, `refs/heads/${cfg.branch}`) || '').trim().split(/\s+/)[0];
  if (remote !== sha) {
    fail(`远端 ${cfg.branch} 是 ${remote || '空'}，本地是 ${sha}，推送后校验未通过`);
  }
  console.log(`[sync] 推送完成并校验通过：${cfg.remote}/${cfg.branch} @ ${sha.slice(0, 12)}`);
}

function buildMessage(hasHead, changed, stat, nameStatus) {
  const changelog = path.join(REPO, 'CHANGELOG.md');
  const cur = fs.existsSync(changelog) ? fs.readFileSync(changelog, 'utf8') : '';
  const headings = [...cur.matchAll(/^###\s+([\d.]+)\s+[—–-]\s*(.+)$/gm)].map((m) => ({ ver: m[1], title: m[2].trim() }));

  if (!hasHead) {
    const v = headings[0]?.ver || '未知版本';
    const totalMB = (walk(REPO).reduce((n, f) => n + fs.statSync(f).size, 0) / 1048576).toFixed(2);
    return {
      subject: `chore(dingwei-geini): 建立版本基线（v${v} 全量导入）`,
      body: [
        `完整导入技能目录与线上站点副本，共 ${changed.length} 个文件 / ${totalMB} MB。`,
        '推送前已将内嵌的腾讯位置服务 Key 在全部副本中置空；页面自带「填入 Key」兜底。',
        '',
        stat.split('\n').slice(0, 25).join('\n'),
      ].join('\n'),
    };
  }

  const headLog = gitMaybe('show', 'HEAD:CHANGELOG.md') || '';
  const oldVers = new Set([...headLog.matchAll(/^###\s+([\d.]+)\s+[—–-]/gm)].map((m) => m[1]));
  const fresh = headings.filter((h) => !oldVers.has(h.ver));

  if (fresh.length) {
    const h = fresh[0];
    const block = cur.split(/^###\s+/m).find((b) => b.startsWith(`${h.ver} `)) || '';
    const bullets = block.split('\n').filter((l) => /^\s*-\s+/.test(l)).map((l) => l.trim()).slice(0, 12);
    return {
      subject: `feat(dingwei-geini): ${h.ver} ${h.title}`,
      body: [
        ...(bullets.length ? bullets : [`CHANGELOG 新增 ${h.ver} 条目`]),
        ...(fresh.length > 1 ? [`本次一并合入：${fresh.slice(1).map((x) => x.ver).join('、')}`] : []),
        '',
        stat.split('\n').slice(0, 25).join('\n'),
      ].join('\n'),
    };
  }

  // 回退到 diff：按改动路径推断类型，并在消息里如实标注未写日志
  const joined = changed.join(' ');
  let type = 'chore';
  let what = `更新 ${changed.length} 个文件`;
  if (/(^|\s)(assets\/|site\/)/.test(joined) || /map\.html/.test(joined)) {
    type = 'fix';
    what = '更新地图页面';
  } else if (/(^|\s)(SKILL|README|CHANGELOG|docs\/)/.test(joined)) {
    type = 'docs';
    what = '更新说明文档';
  } else if (/(^|\s)scripts\//.test(joined)) {
    type = 'refactor';
    what = '调整脚本';
  }
  return {
    subject: `${type}(dingwei-geini): ${what}（未写变更日志）`,
    body: [
      '本次 CHANGELOG.md 没有新增版本条目，以下改动说明由 diff 自动生成，建议补写日志。',
      '',
      ...nameStatus.slice(0, 30),
      '',
      stat.split('\n').slice(0, 25).join('\n'),
    ].join('\n'),
  };
}

main();
