# 设计笔记

每个决定记三行：**当时想怎么做 / 为什么不行 / 现在怎么做**。
读这份文件的目的是：不要重新掉进已经排除过的坑。改代码前先读，改完必须追加。

---

## D1 — 不让模型做二维布局

**想这么做**：把网表丢给模型，让它直接输出每个元件的坐标。
**为什么不行**：可读性是全局空间约束问题，模型没有画布，只能逐个坐标猜。2026 年的 Weave 论文在同一测试集上量化过：确定性分层布局 + round-trip 校验达到 100% 连通等价，LLM 方案（Schemato）编译率 76%，超过 5 个元件后连通性崩塌。
**现在**：`layout.mjs` 只用确定性算法。模型的职责缩小到「分块决策 + 结果解释」。

---

## D2 — 不让模型"总结样板"，改成代码"测量样板"

**想这么做**：让 agent 读几张好图，总结出间距、朝向、分区规则，写成文档。
**为什么不行**：自然语言概括有损。样板里的事实是「块间距 600 mil」，一总结就变成「保持适当间距」——可执行的信息被压缩成形容词。
**现在**：`measure.mjs` 从坐标直接统计，输出 `constants.json`。审美判断不参与常量生成。

---

## D3 — 硬规则进代码，不进文档

**想这么做**：写一份规则文档，让 agent 每次开工前通读。
**为什么不行**：长文本进上下文会被压缩；规则一多互相冲突，模型开始选择性遵守且不可预测。靠读的规则会被违反。
**现在**：能写成 boolean 的规则全部进 `scripts/lint.mjs`。`SKILL.md` 只保留流程，不装规则。

判据：一条规则能写成 boolean 判断 → 进代码；需要"看情况" → 进 `references/style.md`。

---

## D4 — 先做 lint，后做布局引擎

**想这么做**：先写布局器。
**为什么不行**：没有验收标准时，写出来的布局器自己都无法评判好坏，改一处不知道是变好还是变差。
**现在**：lint 先行。它是纯读的、零风险的，而且每把一个新的"难看"翻译成检查项，规则库就自己长出来。
顺序反了会陷入震荡调参。

---

## D5 — 模板分两级：motif 与 page

**想这么做**：一个模板库装所有样板。
**为什么不行**：整页布局高度个人化，跨项目复用率低；而局部电路（LDO、去耦、晶振）全世界通用，复用率极高。混在一起会导致库既不够通用也不够贴合。
**现在**：`templates/motifs/` 放模块级（可从开源平台提取通用惯例），`templates/pages/` 放整页风格（只能自建，按复杂度 3 档，够用即可）。

---

## D6 — 模板准入用 lint 打分 + 人工标注

**想这么做**：靠 lint 分数自动筛选好图。
**为什么不行**：lint 测「乱不乱」，测不了「这个分区合不合理」。意图判断只有人能提供。
**现在**：两道闸。lint 分数过滤明显不合格的；人工三行标注（好在哪 / 不喜欢什么 / 复杂度档）随模板一起入库，否则三个月后没人知道当初为什么选它。

---

## D7 — 评分权重未校准，标注为 UNFIT

**现状**：`rules/lint-rules.json` 里的权重是主观先验，`calibration` 字段明确写着 UNFIT，报告里也打印「权重未校准」。
**为什么重要**：一个没有校准过的分数被当成客观指标使用，会反过来扭曲判断——为了让分数好看去改图，而不是让图变好看。
**校准方法**：攒到 8 张以上带人工评分的页面（存 `fixtures/ratings.json`），最小二乘拟合权重，把结果和拟合残差写进这里，再把 `calibration` 改成 FIT。在此之前，看**具体检查项**，不要看总分。

---

## D8 — 页面 dump 的包围盒是外框近似

**现状**：`wire-through-body` 用包围盒内缩 `grid` 来判定，会误报——导线穿过符号外框但没有压到图形本体时会报。
**为什么接受**：真实符号轮廓需要解析库里的 polygon，成本远高于收益，且误报方向是保守的（宁多报不漏报），规则级别定为 `warn` 而非 `error`。
**什么时候改**：如果某个项目的误报超过 30%，再引入真实轮廓。

---

## D9 — layout 只输出坐标，不直接写 EDA

**为什么**：`layout.mjs` 用的是抽象外框模型（元件当成 30×40 的矩形），与真实符号几何不一致。直接把外框坐标写进 EDA 会得到一张错位的图。
**现在**：plan 是中间产物，落图由未实现的 adapter 完成（见 `SKILL.md` 的 adapter 一节）。在 adapter 存在之前，plan 只能用于自检，不能落地。

---

## D10 — 官方 autoLayout 存在，但不可参数化

**发现**：`SCH_Document.autoLayout(props?)`（Beta）确实存在，配套还有 `autoRouting`。参数只有三个：`uuids`、`netlist`（`{component:{[id]:{pinInfoMap}}}`）、`designatorDeviceTypeMap`（把位号映射成 resistor/capacitor/chip 等 8 类）。

**结论**：它是黑盒。间距、分区、朝向、跨块策略——一个入口都没有。所以它只能产出「连得上但不合你习惯」的图，而这恰好就是本项目要解决的问题本身。

**用法**：**保留它当基线**。任何自研布局必须跑赢官方 autoLayout，跑不赢说明方向错了。这是一次免费对照组，不要跳过。

---

## D11 — round-trip 用官方 netlistComparison，不自己写解析

`SYS_Tool.netlistComparison(n1, n2)` 直接返回差异数组（`type: 'Net' | 'Component'`）。
`SCH_ManufactureData.getNetlistFile(name, type)` 可导出 `JLCEDA_PRO` / `EASYEDA_PRO` / `ALTIUM_DESIGNER` / `PADS` / `ALLEGRO` / `PROTEL2`。

**结论**：Weave 论文里那套「生成后回读、逐网比对」的连通性证书，官方已经给了原语。**不要自己写网表解析器**——那是纯浪费。

**注意**：`SCH_Netlist.getNetlist` 已标记 obsolete（改用 `SCH_ManufactureData.getNetlistFile`）；`setNetlist` 是 BETA，写回网表要谨慎。

---

## D12 — 跨块连接用正式符号，不用 wire + 文本标签

`SCH_PrimitiveComponent.createNetFlag('Power' | 'Ground' | 'AnalogGround' | 'ProtectGround', net, x, y, rotation, mirror)`
`SCH_PrimitiveComponent.createNetPort('IN' | 'OUT' | 'BI', net, x, y, rotation, mirror)`

**结论**：`layout.mjs` 现在输出「短桩 + 文本标签」，落图时应替换成这两类符号。朝向由 `rotation` 控制，正好用来表达「电源朝上、地朝下」，比纯文本标签更符合制图惯例。

---

## D13 — 原理图没有 DRC

PCB 侧有 `PCB_Drc.check()`，原理图侧**没有任何**电气或可读性检查接口。`SCH_Document` 的方法总共只有四个：`autoLayout` / `autoRouting` / `importChanges` / `save`。

**结论**：本项目的 lint 不是重复造轮子，是补空白。这条是继续投入 lint 的最强理由。

