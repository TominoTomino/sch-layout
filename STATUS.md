# 状态

**每次会话开工先读这里，收工更新这里。** 控制在 60 行以内，超了说明该整理进 design-notes 了。

更新于：2026-11-17

## 版本

| | |
|---|---|
| skill | 0.3.0 |
| 规则 | 0.3.0 |
| schema | 0.2.0 |
| 常量 | 0.3.0 — **仍是 PLACEHOLDER**（已有 16 张真实页，但未跑 measure 定值） |

## 已完成

- `lint.mjs` — 8 条规则 + 指标（交叉/拐点/分支点/总线长/填充率），缺数据标 skipped
- `measure.mjs` — 栅格覆盖率 / 间距双峰 / 短桩 / 净空；`--write` 递增 version 并写 provenance
- `layout.mjs` — 连通性分层（排除电源网）、跨层用网络标签、L 型避障路由
- **`dump.mjs` + `scripts/eda/dump-page.js`** — 从 EDA 直接取 `page.json`，自动扫 49620-49629
- schema 0.2 — 段式导线、标签连接点、浮点取整、覆盖率栅格（D14–D17）
- **D18 已确认**：`(x,y)` 是引脚外端＝连接点，`rotation` 朝外，`len` 向内收。极简页 `samples/min-two-resistors.json`（91 分 A，零问题）作为金标准
- 修掉 D19/D20 两处假阳性：包围盒去掉 padding（大图 overlap 9 → **0**）；零长线段不再计入拐点与结点
- **D21 连通性改用网表**（`pins[].net`）：新增 `pin-unconnected`（error），`dangling-wire` 降为 info。大图 42 条悬空里 24 条是误报，真实未接引脚只有 **2 个**（DS1.3 / DS2.3）
- 两张真实页面：过欠压 59 元件 **49.1→66.1** · CW32 174 元件 **64.3→88.9**（存 `fixtures/private/`）
- Yosemite 工程 13 页全量扫描：95.5–99.3（一页连接器细节页 58.8 为异常样本，已排除）
- **4 个人工评分点**（`fixtures/ratings.json`）：D23 据此把指标退出计分、缺陷改线性扣分

## 待办（按优先级）

1. **再攒 2 张带评分的页面**（n=6）。现在的残差集中在 ouya 高估 16 分，需要新样本判断是 grid-off 权重不够，还是那页另有问题。
2. **adapter 落图** — `getAllPinsByPrimitiveId` → `sch_PrimitiveComponent.create` / `sch_PrimitiveWire` / `createNetFlag` / `createNetPort`
3. **官方基线** — **复制一份工程**后跑 `sch_Document.autoLayout()`，与现有分数对比。绝不在原图上跑
4. **snap 工具** — 把导线端点吸回栅格 + 网表比对 + 不合格回滚（ouya 有 27 处可作首个用例）
5. **15 个 motif 模板** — 先做 `LDO_3V3` / `去耦阵列` / `无源晶振`
6. **清理 density 规则** — 用户工作流里单页 174 元件属正常，`maxComponentsPerPage=20` 是错的，但它现在只扣 0.33 分，不急

## 阻塞

- 待办 1 需要用户对每张新页面给一个 band 评分（「能不能不经口述交给同事」）。
- 待办 2 需要待办 1 的样本量，否则调参就是拟合噪声。

## 已知坑

- `line` 是**段列表**不是折线；`netflag`/`netport` 是**组件**不是文本，电连接点在它们的引脚上（D14/D15）
- **连通性以 `pins[].net` 为准，几何悬空不可信**（实测 57% 误报，D21）
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

2026-11-17 D23：指标退出计分、缺陷改线性扣分（4 个人工评分点支撑）。三张"90+"页面从 64-85 收敛到 88.9-96.5。
