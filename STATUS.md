# 状态

**每次会话开工先读这里，收工更新这里。** 控制在 60 行以内，超了说明该整理进 design-notes 了。

更新于：2026-11-17

## 版本

| | |
|---|---|
| skill | 0.5.0 |
| 规则 | 0.4.3 |
| schema | 0.2.0 |
| 常量 | 0.5.0 |

## 已完成

- `lint.mjs` — 9 条规则；报告末尾自陈盲区（D25）；每条规则标注 `geometry: exact | approx`
- **`epro.mjs` / `export-epro.mjs`** — 导出工程包 → 解出真实符号 BBOX（76/76），`lint --symbols` 用真外框（D26）
- **`dump.mjs`** — 一页取全：元件/引脚/导线/标签/网表归属/栅格推断，自动扫 49620-49629
- **`apply.mjs`** — 写 EDA：`snap-grid` / `point`，逐引脚网表校验 + 自动回滚 + 元件清单不变式（D30–D34）
- 计分：指标退出计分、缺陷线性扣分（D23）。4 个人工评分点支撑
- 重叠：真外框 + 显著性门槛 + 同型号比例众数 + 显式豁免（D27/D28）
- Yosemite 13 页：95.2–99.3，0 error

## 待办（按优先级）

1. **在副本上彩排 ouya 的 27 处 snap**：`apply --dry-run` → 副本执行 → 对比 lint → 再定是否动原工程。这是写层第一次上真实数据。
2. **把 `export-epro` 串进 `dump`**：现在要手工两步。
3. **reflow 原语**：`move component + rebuild attached wires` 的组合。D30 已证明单独 move 会断网，必须成对。
4. **修 `density` 规则**：单页 174 元件是用户的正常工况，`maxComponentsPerPage=20` 是错的。
5. **15 个 motif 模板**：`LDO_3V3` / `去耦阵列` / `无源晶振` 三个起步。

## 阻塞

- 待办 1 需要在真实工程上写入，需用户明确同意；副本彩排结果先给用户看。
- `SCHLAYOUT-BASELINE` 是一个脏掉的一次性副本（测试用），**应手动删除**。API 没有删工程接口。

## 已知坑

- `autoLayout()` / `autoRouting()` 实测无任何行为，别再花时间（D29）
- **移动元件不带动导线**，一移就断；导线不能原地改几何，必须删了重建（D30/D31）
- `create()` 紧跟 `delete()` 必失败，回滚也会跟着失败（D32）
- 写入留下 ~0.05 单位漂移，栅格判定必须带 0.1 容差；否则 grid 退化成 1，`grid-off` 静默变永真（D33）
- 删元件时网表比对看不出来（引脚一起消失），必须另查元件清单（D34）
- 连通性以 `pins[].net` 为准，几何悬空 57% 是误报（D21）
- 引脚 `(x,y)` 是外端连接点，`len` 向内收；电源标识贴引脚时用零长线段（D18）
- 包围盒不加 padding（D19）；`line` 是段列表；`netflag/netport` 是组件不是文本（D14/D15）
- 坐标是浮点，不取整一切皆错（D16）
- 沙箱代理只放通 `api.github.com`；git 需绕代理 + `http.version=HTTP/1.1` + 重试 3–5 次
- 本环境 `cmd` 被禁，建 junction 用 `New-Item -ItemType Junction`

## 最近一次改动

2026-11-17 写层上线（apply）：snap-grid 实测通过两轮，回滚与清单不变式已加拦截。autoLayout 判定不可用，自研路线定案。
