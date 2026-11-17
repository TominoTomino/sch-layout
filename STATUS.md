# 状态

**每次会话开工先读这里，收工更新这里。** 控制在 60 行以内，超了说明该整理进 design-notes 了。

更新于：2026-11-17

## 版本

| | |
|---|---|
| skill | 0.2.1 |
| 规则 | 0.1.0 |
| schema | 0.2.0 |
| 常量 | 0.2.1 — **仍是 PLACEHOLDER，尚未从真实样板测出** |

## 已完成

- `lint.mjs` — 8 条规则 + 指标（交叉/拐点/分支点/总线长/填充率），缺数据标 skipped
- `measure.mjs` — 栅格覆盖率 / 间距双峰 / 短桩 / 净空；`--write` 递增 version 并写 provenance
- `layout.mjs` — 连通性分层（排除电源网）、跨层用网络标签、L 型避障路由
- **`dump.mjs` + `scripts/eda/dump-page.js`** — 从 EDA 直接取 `page.json`，自动扫 49620-49629
- schema 0.2 — 段式导线、标签连接点、浮点取整、覆盖率栅格（D14–D17）
- **D18 已确认**：`(x,y)` 是引脚外端＝连接点，`rotation` 朝外，`len` 向内收。极简页 `samples/min-two-resistors.json`（91 分 A，零问题）作为金标准
- 修掉 D19/D20 两处假阳性：包围盒去掉 padding（大图 overlap 9 → **0**）；零长线段不再计入拐点与结点
- 第一张真实页面跑通：59 元件 / 236 段 / 27.3 分 D 级（存 `fixtures/private/`，未提交）

## 待办（按优先级）

1. **判定大图那 42 个悬空端点是不是真的。** 切回那一页，用 `sch_Netlist.getNetlist()` 取网表，看这些端点所在的 net 是否真的缺连接。极简页已证明模型没错，所以它们**很可能真是断开的**——如果是，那是一个比可读性更严重的发现。
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
- 引脚 `(x,y)` 是**外端连接点**，`len` 向本体内收，别加 `+len·dir`（D18）
- 电源标识直接贴引脚时用**零长线段**表示，必须忽略（D18）
- 包围盒**不加 padding**，引脚框就是外轮廓（D19）
- `compactness` 实测 0.04，参考值 0.25 不适用，只能看趋势不能横向比（D20）
- 坐标是浮点，`915` 可能是 `914.9999999999999`，不取整则一切皆错（D16）
- 栅格别用严格 gcd，用覆盖率 ≥95% 的最大候选（D17）
- `sch_Document.autoLayout()` 是黑盒，只吃 uuids/netlist/deviceTypeMap（D10）
- 原理图没有 DRC（D13）
- 沙箱代理只放通 `api.github.com`，不放通 `github.com`。git 需 `env -u https_proxy -u HTTPS_PROXY -u http_proxy -u HTTP_PROXY` + `-c http.version=HTTP/1.1` + **重试 3–5 次**
- WorkBuddy 的 GitHub MCP connector 只读，推代码走 git CLI
- 本环境 `cmd` 被禁，建 junction 用 `New-Item -ItemType Junction`
- `wire-through-body` / `overlap` 用包围盒近似，会误报，级别是 warn（D8）

## 最近一次改动

2026-11-17 用极简页锁定 D18 引脚语义，顺带修掉 D19/D20 两处假阳性。下一步是判定大图 42 个悬空端点的真伪。
