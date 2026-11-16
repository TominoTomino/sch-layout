#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${SCH_LAYOUT_REPO:-https://github.com/TominoTomino/sch-layout.git}"
SRC="${SCH_LAYOUT_SRC:-$HOME/code/sch-layout}"
SKILLS_DIR="${SCH_LAYOUT_SKILLS:-$HOME/.workbuddy/skills}"
DEST="$SKILLS_DIR/sch-layout"

echo "sch-layout 安装"
echo "  源目录 : $SRC"
echo "  目标   : $DEST"

if [ ! -d "$SRC/.git" ]; then
  echo "→ 克隆仓库"
  mkdir -p "$(dirname "$SRC")"
  git clone "$REPO_URL" "$SRC"
else
  echo "→ 源目录已存在，跳过克隆"
fi

mkdir -p "$SKILLS_DIR"

if [ -L "$DEST" ]; then
  echo "→ 已存在链接，更新指向"
  rm "$DEST"
elif [ -e "$DEST" ]; then
  echo "! $DEST 已存在且不是链接。"
  echo "  如果是旧的复制安装，请先备份后删除： mv \"$DEST\" \"$DEST.bak\""
  echo "  然后重新运行本脚本。"
  exit 1
fi

ln -s "$SRC" "$DEST"
echo "→ 已链接"

if command -v node >/dev/null 2>&1; then
  echo "→ 自检"
  node "$SRC/scripts/lint.mjs" "$SRC/samples/demo-page.json" >/dev/null 2>&1 || true
  node "$SRC/scripts/lint.mjs" "$SRC/samples/demo-page.json" | head -4
else
  echo "! 未找到 node（需要 >= 20）"
fi

echo "完成。新对话中提到「原理图」会自动命中本 skill。"
