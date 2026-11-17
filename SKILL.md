---
name: sch-layout
description: 原理图布局与可读性检查（嘉立创EDA专业版 / EasyEDA Pro）。当任务涉及把网表画成原理图、原理图太乱需要重排、评估一张原理图的可读性、提取样板间距与朝向常量、或维护原理图模板库时使用。触发词：原理图、画图、布局、可读性、连线、网表、schematic、EasyEDA、嘉立创、立创EDA、autolayout、lint 原理图。
---

# sch-layout

确定性布局 + 可读性校验。**模型不做二维摆放**，只做分块决策与结果解释。

## 开工自检

0. **先读 `STATUS.md`**（仓库根目录）。里面有版本、待办、阻塞和已知坑。没有它你会重做已完成的事、重踩已踩过的坑。
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

本仓库只产出坐标，不直接写 EDA。真实落图需要一层 adapter，官方 API 已经把原语给全了：

1. `sch_PrimitiveComponent.getAllPrimitiveId()` 拿元件，`getAllPinsByPrimitiveId(id)` 拿**真实引脚坐标**——不要自己按外框推算
2. 用 plan 的 `component.x/y` 作锚点，把抽象外框映射到真实符号几何
3. `sch_PrimitiveComponent.create(component, x, y, ...)` 放器件，`sch_PrimitiveWire.create` 画块内短线
4. **跨块连接改用 `createNetFlag('Power'|'Ground'|'AnalogGround'|'ProtectGround')` 与 `createNetPort('IN'|'OUT'|'BI')`**，不要用 wire + 文本标签（design-notes D12）
5. 落图后跑 `sys_Tool.netlistComparison(源网表, sch_ManufactureData.getNetlistFile())` 做往返校验，差异必须为空（design-notes D11）
6. 再 `measure` 一次，比对实际间距与 plan 的偏差

在 adapter 存在之前，**不要把 plan 坐标直接写进 EDA**，外框模型和真实符号几何不一致。

## 官方 autoLayout 是基线，不是对手

`sch_Document.autoLayout()`（Beta）确实存在，但只接受 `uuids` / `netlist` / `designatorDeviceTypeMap` 三个参数——**没有任何间距、分区、朝向的入口**（design-notes D10）。

所以：**先跑它一遍，记录分数当基线。** 自研布局必须跑赢这个基线，跑不赢就说明方向错了。

原理图侧没有任何 DRC（`SCH_Document` 只有 autoLayout / autoRouting / importChanges / save），`lint` 是补空白，不是重复造轮子（design-notes D13）。

## 改造本 skill 的流程

用户说「这张图还是不好看」「改成这样」时，**不要直接改代码**。按这个顺序：

1. **先复现** — 把问题做成一个最小的 `page.json` 放进 `fixtures/<name>/`，附 `expect.json` 和一句 `note.md` 说明当时的问题。没有可复现的输入，改完无法判断是否真的改好了。
2. **归类** — 只问一个问题：这是哪一层的缺陷？
   - 几何可判定（参差、重叠、穿体、斜线）→ 加 `lint` 规则
   - 布局策略不对（分区、流向、绕路）→ 改 `layout.mjs`
   - 数值不对（间距、净空、短桩）→ 重新 `measure`，不手调
   - 只有人能判断（分区合不合理、命名习惯）→ 写 `references/style.md`
3. **只改一层** — 一次动多层，就不知道是谁修好的。
4. **回归** — 跑完 `fixtures/` 全部用例，对比改前改后。
5. **收尾** — 更新 `STATUS.md`；有新的设计取舍就追加进 `design-notes.md`；commit message 写「为什么」而不是「改了什么」。

**反模式**：为了让分数好看去改图，而不是让图变好看。分数是度量，不是目标。权重未校准时尤其如此（design-notes D7）。

## 会话收尾

结束前必须做两件事，否则下个对话等于从零开始：

1. 更新 `STATUS.md` 的「已完成 / 待办 / 阻塞 / 最近一次改动」
2. 若这次动了 `constants.json` 或 `lint-rules.json`，确认 version 已递增

## 失败处理

| 现象 | 看这里 |
|---|---|
| lint 报 `数据不完整` / 规则被 skipped | `docs/schema.md` 的字段要求，dump 缺 pins/labels |
| `pin-unconnected` 报了但设计上就该悬空 | **别改规则**，让用户在 EDA 里给该引脚标 NC（noConnected）。标了之后规则自动跳过，转 PCB 也不会再警告 |
| 分数低但看不出问题 | `lint -v` 看明细；仍不符直觉 → 该条 lint 权重可能错了，记进 design-notes |
| 布局结果很挤 | 常量没测过（provenance 是 PLACEHOLDER），先 measure |
| 跨项目行为不一致 | 检查 `constants.json` 的 version，不同版本分数不可比 |

## 文件索引

- `docs/schema.md` — 页面 dump 与 design.json 的字段定义
- `references/design-notes.md` — 每个设计决定的理由。**改动前先读，改完必须追加。**
- `references/style.md` — 制图惯例（分区、命名、常见 motif 清单）
- `rules/` — 常量与规则，机器读
- `fixtures/` — 回归用例与人工评分
