# 状态

**每次会话开工先读这里，收工更新这里。** 控制在 60 行以内，超了说明该整理进 design-notes 了。

更新于：2026-11-17

## 版本

| | |
|---|---|
| skill | 0.2.0 |
| 规则 | 0.1.0 |
| schema | 0.2.0 |
| 常量 | 0.2.0 — **仍是 PLACEHOLDER，尚未从真实样板测出** |

## 已完成

- `lint.mjs` — 8 条规则 + 指标（交叉/拐点/分支点/总线长/填充率），缺数据标 skipped
- `measure.mjs` — 栅格覆盖率 / 间距双峰 / 短桩 / 净空；`--write` 递增 version 并写 provenance
- `layout.mjs` — 连通性分层（排除电源网）、跨层用网络标签、L 型避障路由
- **`dump.mjs` + `scripts/eda/dump-page.js`** — 从 EDA 直接取 `page.json`，自动扫 49620-49629
- schema 0.2 — 段式导线、标签连接点、浮点取整、覆盖率栅格（D14–D17）
- 第一张真实页面跑通：59 元件 / 236 段 / 15.7 分 D 级（存 `fixtures/private/`，未提交）

## 待办（按优先级）

1. **查清引脚坐标语义（D18）** — 42 条 dangling 里 24 个距引脚正好 `pinLength`。拿一张两三个元件的极小页面做对照，确认 `(x,y)` / `pinLength` / `rotation` 的几何关系。**在此之前 dangling 的数字只能当提示。**
2. **adapter 落图** — `getAllPinsByPrimitiveId` → `sch_PrimitiveComponent.create` / `sch_PrimitiveWire` / `createNetFlag` / `createNetPort`
3. **官方基线** — 跑 `sch_Document.autoLayout()` 记分数，与 15.7 对比
4. **替换 PLACEHOLDER 常量** — 用真实页跑 `measure --write`，看测出的间距是否合理
5. **15 个 motif 模板** — 先做 `LDO_3V3` / `去耦阵列` / `无源晶振`
6. **fixtures + ratings** — 攒 8 条人工评分后校准权重（15.7 分低于直觉，权重明显偏严）

## 阻塞

- 待办 1 需要一张极简页面做对照：「两个电阻串联」即可，一分钟的事。
- 待办 6 需要人工评分，只能由用户给。

## 已知坑

- `line` 是**段列表**不是折线；`netflag`/`netport` 是**组件**不是文本，电连接点在它们的引脚上（D14/D15）
- 坐标是浮点，`915` 可能是 `914.9999999999999`，不取整则一切皆错（D16）
- 栅格别用严格 gcd，用覆盖率 ≥95% 的最大候选（D17）
- 引脚坐标语义未确认（D18），`dangling-wire` 有已知假阳性
- `sch_Document.autoLayout()` 是黑盒，只吃 uuids/netlist/deviceTypeMap（D10）
- 原理图没有 DRC（D13）
- 沙箱代理只放通 `api.github.com`，不放通 `github.com`。git 需 `env -u https_proxy -u HTTPS_PROXY -u http_proxy -u HTTP_PROXY` + `-c http.version=HTTP/1.1` + **重试 3–5 次**
- WorkBuddy 的 GitHub MCP connector 只读，推代码走 git CLI
- 本环境 `cmd` 被禁，建 junction 用 `New-Item -ItemType Junction`
- `wire-through-body` / `overlap` 用包围盒近似，会误报，级别是 warn（D8）

## 最近一次改动

2026-11-17 接通 dump → lint 全链路，schema 升到 0.2，补 D14–D18。下一步是 D18 的引脚语义。
