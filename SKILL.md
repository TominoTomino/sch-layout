---
name: sch-layout
description: 原理图布局与可读性检查（嘉立创EDA专业版 / EasyEDA Pro）。当任务涉及把网表画成原理图、原理图太乱需要重排、评估一张原理图的可读性、提取样板间距与朝向常量、或维护原理图模板库时使用。触发词：原理图、画图、布局、可读性、连线、网表、schematic、EasyEDA、嘉立创、立创EDA、autolayout、lint 原理图。
---

# sch-layout

确定性布局 + 可读性校验。**模型不做二维摆放**，只做分块决策与结果解释。

## 开工自检

1. 读 `rules/constants.json` 的 `version`。若 `provenance.*.source === "PLACEHOLDER"`，说明常量还没从真实样板测出来，**先跑 measure，不要直接布局**。
2. 目录不存在 `rules/` 或 `scripts/` → 环境不完整，让用户执行仓库里的 `install.sh` / `install.ps1`。

## 三个命令

```bash
node scripts/measure.mjs <page.json> [--write]     # 从样板测常量
node scripts/lint.mjs    <page.json> [--md|-v]     # 可读性检查，exit 1 = 有 error
node scripts/layout.mjs  <design.json> [--out plan.json] [--emit-page page.json]
```

`measure` 和 `lint` 吃同一个东西：**页面 dump**（格式见 `docs/schema.md`）。
`layout` 吃的是**抽象盒模型**（只有引脚分布与连通性，不含真实符号几何）。

## 标准流程

1. **有样板要采** → `measure --write`，常量落盘。这是唯一允许改 `constants.json` 的途径。
2. **要画新图** → 准备 `design.json` → `layout --emit-page out/p.json`
3. **自检** → `lint out/p.json`，这一步**不可跳过**
4. **落图** → 由 adapter 用真实符号坐标写入 EDA（见下）
5. **回归** → `fixtures/` 里的用例跑一遍，确认没有退化

## 硬规则

- **lint 有 error 级问题不得交付。** 这不是建议，是流程闸门。
- 常量只从 `measure` 得出，不许手编。手编的值没有 provenance，半年后无人能解释。
- 新增检查项只能追加到 `rules/lint-rules.json` 的 `rules[]`，并同步在 `scripts/lint.mjs` 的 `RULE_IMPL` 里实现。删规则必须写进 `references/design-notes.md` 并说明理由。
- 模板只存**相对坐标与朝向**，不存位号、网名、器件参数。

## 跨层连接

一律用**网络标签 + 短桩**，不用跨块长导线。这是可读性收益最大的一条，`layout.mjs` 已内置（`isGlobalNet` 全用标签，跨 2 层以上用标签）。

## adapter（尚未实现）

本仓库只产出坐标，不直接写 EDA。真实落图需要一层 adapter：

1. 用 `lib_Symbol.get()` 取每个器件的真实引脚坐标
2. 用本仓库的 plan 里 `component.x/y` 作为外框左上角，按引脚 `side` 比例映射到真实 pin
3. 调 `sch_PrimitiveComponent.create` / `sch_PrimitiveWire.create`
4. 落图后再 `measure` 一次，比对实际间距与 plan 的偏差

在 adapter 存在之前，**不要把 plan 坐标直接写进 EDA**，外框模型和真实符号几何不一致。

## 失败处理

| 现象 | 看这里 |
|---|---|
| lint 报 `数据不完整` / 规则被 skipped | `docs/schema.md` 的字段要求，dump 缺 pins/labels |
| 分数低但看不出问题 | `lint -v` 看明细；仍不符直觉 → 该条 lint 权重可能错了，记进 design-notes |
| 布局结果很挤 | 常量没测过（provenance 是 PLACEHOLDER），先 measure |
| 跨项目行为不一致 | 检查 `constants.json` 的 version，不同版本分数不可比 |

## 文件索引

- `docs/schema.md` — 页面 dump 与 design.json 的字段定义
- `references/design-notes.md` — 每个设计决定的理由。**改动前先读，改完必须追加。**
- `references/style.md` — 制图惯例（分区、命名、常见 motif 清单）
- `rules/` — 常量与规则，机器读
- `fixtures/` — 回归用例与人工评分
