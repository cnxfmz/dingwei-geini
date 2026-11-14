#!/usr/bin/env python3
"""「定位给你」技能包 —— 提交市场前的自检。

用法：
    python scripts/quick_validate.py .

检查项：
    1. SKILL.md 存在、YAML frontmatter 合法
    2. 必需字段齐全（含市场提交额外要求的字段）
    3. name 为拉丁 kebab-case、description 不含尖括号
    4. SKILL.md 里引用的技能内资源（scripts、assets、references 三目录下的文件）都真实存在

第 4 项专门用来挡住市场审核的「资产包缺少必需资源 / 内置文件缺失」：
SKILL.md 里若写了指向别的技能、或包内并不存在的文件路径，整包会被驳回。
只依赖 Python 标准库；显式按 UTF-8 读取（中文 Windows 的默认编码不是 UTF-8）。
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REQUIRED_FIELDS = (
    "name",
    "description",
    "agent_created",
    "version",
    "display_name",
    "display_name_en",
    "description_zh",
    "description_en",
)

# 只核对技能内的相对路径；外部路径、URL、占位符路径不在此列，交给人工审阅。
RESOURCE_REF = re.compile(
    r"(?<![A-Za-z0-9_./\\-])"
    r"((?:scripts|assets|references)/[A-Za-z0-9_][A-Za-z0-9_./-]*\.[A-Za-z0-9]+)"
)


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: python scripts/quick_validate.py <skill_directory>")
        return 1

    root = Path(sys.argv[1]).resolve()
    skill_md = root / "SKILL.md"
    if not skill_md.is_file():
        print("[FAIL] SKILL.md not found")
        return 1

    text = skill_md.read_text(encoding="utf-8")
    fm_match = re.match(r"^---\r?\n(.*?)\r?\n---", text, re.DOTALL)
    if not fm_match:
        print("[FAIL] No valid YAML frontmatter found")
        return 1

    fields = {}
    for line in fm_match.group(1).splitlines():
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$", line)
        if m:
            fields[m.group(1)] = m.group(2).strip().strip('"').strip("'").strip()

    errors: list[str] = []
    for key in REQUIRED_FIELDS:
        if not fields.get(key):
            errors.append(f"frontmatter 缺字段或字段为空: {key}")

    name = fields.get("name", "")
    if name and not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name):
        errors.append(f"name '{name}' should be hyphen-case (lowercase letters, digits, hyphens)")

    desc = fields.get("description", "")
    if "<" in desc or ">" in desc:
        errors.append("description cannot contain angle brackets (< or >)")

    refs = sorted(set(RESOURCE_REF.findall(text)))
    for ref in refs:
        if not (root / ref).is_file():
            errors.append(f"SKILL.md 引用了包内不存在的文件: {ref}")

    print(f"[OK]   SKILL.md / frontmatter / {len(REQUIRED_FIELDS)} 个字段 / name / description")
    print(f"[OK]   资源引用检查: {len(refs)} 个技能内文件全部存在 ({', '.join(refs)})")
    if errors:
        for err in errors:
            print("[FAIL] " + err)
        print(f"\n{len(errors)} 项未通过，请勿提交")
        return 1
    print("\nSkill is valid!")
    return 0


if __name__ == "__main__":
    sys.exit(main())
