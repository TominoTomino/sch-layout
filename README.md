# sch-layout

给嘉立创 EDA 专业版（EasyEDA Pro）用的**确定性原理图布局 + 可读性校验**工具。

核心主张：**别让大模型做二维摆放。**

模型的空间推理不可靠，让它逐个坐标去猜，结果是连通性对、可读性差。这个仓库把布局交给算法，把「好看」变成可测的数字，把「可测的数字」变成不会腐化的常量。

---

## 它解决什么

自动生成原理图的通病：每个引脚拉一根带网名的短桩，图能看，但读不出结构。

这个仓库反过来做：

1. 先把「可读性」拆成 8 条可判定规则 + 4 个几何指标
2. 用规则的通过情况给页面打分，问题定位到具体元件和导线段
3. 常量从你认可的样板里**测量**出来，不靠人猜、不靠模型总结
4. 布局按连通性分层，跨层用网络标签而不是长导线

---

## 快速开始

```bash
git clone https://github.com/TominoTomino/sch-layout.git ~/code/sch-layout
cd ~/code/sch-layout

# 1. 看一份故意画坏的演示页
node scripts/lint.mjs samples/demo-page.json -v

# 2. 从样板测常量（导出 stats，不写盘）
node scripts/measure.mjs samples/demo-page.json

# 3. 从抽象网表生成布局方案，并合成页面自检
node scripts/layout.mjs samples/demo-design.json --emit-page out/page.json
node scripts/lint.mjs out/page.json
```

演示页会得到 C 级（62.9 分，6 类问题）；布局管线产出的合成页得到 B 级（83.9 分，1 类问题）。这个差值就是工具的用处。

---

## 命令行

| 命令 | 输入 | 输出 |
|---|---|---|
| `measure.mjs <page.json>` | 页面 dump | 常量建议 + 统计；`--write` 落盘并递增 version |
| `lint.mjs <page.json>` | 页面 dump | 报告；`--md` / `--json` / `-v`；exit 1 = 有 error |
| `layout.mjs <design.json>` | 抽象网表 | `plan.json`；`--emit-page` 额外产出可自检的合成页面 |

格式定义见 [`docs/schema.md`](docs/schema.md)。

---

## 8 条规则

`grid-off` · `overlap` · `dangling-wire` · `diagonal` · `too-many-bends` · `wire-through-body` · `density` · `label-overlap`

外加 4 个指标：交叉数、拐点数、总线长、填充率。

**总分目前是 UNFIT 状态。**权重是主观先验，没有用人工评分校准过。在看清它的可靠边界之前，请看具体检查项，不要看总分。理由见 `references/design-notes.md` 的 D7。

---

## 还没做完的部分

诚实列出，避免误用：

- **adapter 未实现。** `layout.mjs` 用的是抽象外框模型（元件当 30×40 矩形），和真实符号几何不一致。plan 只能用于自检，**不能直接写进 EDA**。
- **布局引擎是 naive 版。** 按连通性分层 + L 型避障直连，没有 Sugiyama 的层内排序优化，也没有 A* 绕障。
- **模板库是空的。** 格式已定（`docs/schema.md` 第 4 节），`templates/` 下只有占位。
- **权重未校准。** 需要至少 8 张带人工评分的页面。

---

## 目录

```
STATUS.md     进度、待办、阻塞、已知坑 —— 开工先读，收工更新
scripts/      measure / lint / layout + lib
rules/        constants.json（measure 产出）· lint-rules.json（只增不减）
references/   design-notes.md（决定与理由）· style.md（不可判定的惯例）
docs/         schema.md
templates/    motifs/ 模块级 · pages/ 整页级
fixtures/     回归用例与人工评分
samples/      演示数据
```

---

## 把它装成 skill

```bash
./install.sh          # macOS / Linux / Git Bash
powershell -File install.ps1   # Windows
```

会把仓库链接到 `~/.workbuddy/skills/sch-layout`（用链接不用复制，`git pull` 即全局生效）。

装好后任何新对话、任何工作区，提到「原理图画得太乱」「检查一下这页原理图」都会自动命中。

---

## 许可

MIT。不含任何客户数据；`samples/` 全部是编造的演示电路。
