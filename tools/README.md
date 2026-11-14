# 同步工具

`dingwei-geini` 技能的 GitHub 镜像同步器。技能目录只读，本仓库是独立镜像；每次同步先按源文件重建工作树，再用 git 的真实 diff 判断改了什么。

## 用法

```bash
node tools/sync.mjs                # 同步 + 生成提交 + 推送 + 校验远端 sha
node tools/sync.mjs --no-push      # 只同步并提交（首次 GitHub 登录前用）
node tools/sync.mjs --check        # 只看有没有未同步改动，不提交
node tools/sync.mjs --dry-run      # 只打印将要生成的提交消息
```

## 配置

`tools/sync.local.json`（已被 `.gitignore` 排除，不会公开）填写本机路径，格式见 `sync.paths.example.json`：

| 字段 | 说明 |
|---|---|
| `skillDir` | 技能源目录，例如 `C:/Users/admin/.workbuddy/skills/dingwei-geini` |
| `siteHtml` | 线上站点副本路径，同步为仓库内的 `site/index.html`；文件不存在时跳过并保留旧副本 |
| `remote` / `branch` | 默认 `origin` / `main` |

## 提交消息：分级取源

1. **CHANGELOG 优先** —— `CHANGELOG.md` 出现相对 HEAD 的新增 `### 版本 — 标题` 条目时，用最新条目做 `feat(dingwei-geini): <版本> <标题>`，取该条目的要点做 body。
2. **diff 兜底** —— 没写日志时按改动路径推断类型生成 `fix/docs/refactor/chore(...)` 消息，附 `--name-status` 与 `--stat`，并在标题标注「未写变更日志」。
3. 首次运行生成 `chore(...): 建立版本基线`。

## 安全自检

推送前把 11 个副本里的 `TXK_DEFAULT` 统一置空（页面自带「填入 Key」兜底），并对全仓做 key 明文残留扫描，命中即拒绝提交。无 diff 不产生空提交；推送后用 `ls-remote` 比对 sha。
