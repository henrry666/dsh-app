#!/usr/bin/env python3
"""Install the repository-owned Harness development skills for Codex and DSH Desktop."""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SOURCE_ROOT = ROOT / "skills"
SKILLS = {
    "harness-desktop-app-builder": False,
    "harness-plugin-developer": False,
    "dsh-desktop-build-verification": True,
}


def dsh_frontmatter(skill_file: Path, explicit_only: bool) -> None:
    content = skill_file.read_text(encoding="utf-8")
    marker = content.find("\n---\n", 4)
    if marker < 0:
        raise ValueError(f"invalid skill frontmatter: {skill_file}")
    extra = (
        f"\ndisable-model-invocation: {'true' if explicit_only else 'false'}"
        "\nuser-invocable: true"
    )
    skill_file.write_text(content[:marker] + extra + content[marker:], encoding="utf-8")


def replace_directory(source: Path, destination: Path, for_dsh: bool, explicit_only: bool) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    stage_parent = Path(tempfile.mkdtemp(prefix=f".{destination.name}-", dir=destination.parent))
    staged = stage_parent / destination.name
    backup = destination.with_name(f".{destination.name}.previous")
    try:
        shutil.copytree(source, staged)
        if for_dsh:
            dsh_frontmatter(staged / "SKILL.md", explicit_only)
        if backup.exists():
            shutil.rmtree(backup)
        if destination.exists():
            destination.rename(backup)
        staged.rename(destination)
        if backup.exists():
            shutil.rmtree(backup)
    except Exception:
        if not destination.exists() and backup.exists():
            backup.rename(destination)
        raise
    finally:
        shutil.rmtree(stage_parent, ignore_errors=True)


def main() -> None:
    codex_root = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "skills"
    dsh_root = Path(os.environ.get("DSH_HOME", Path.home() / ".dsh")) / "skills"
    for name, explicit_only in SKILLS.items():
        source = SOURCE_ROOT / name
        replace_directory(source, codex_root / name, False, explicit_only)
        replace_directory(source, dsh_root / name, True, explicit_only)
        print(f"installed {name}")
    print(f"Codex: {codex_root}")
    print(f"DSH Desktop: {dsh_root}")


if __name__ == "__main__":
    main()
