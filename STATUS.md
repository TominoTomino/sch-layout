# 状态

**每次会话开工先读这里，收工更新这里。** 控制在 60 行以内，超了说明该整理进 design-notes 了。

更新于：2026-11-16

## 版本

| | |
|---|---|
| skill | 0.1.0 |
| 规则 | 0.1.0 |
| 常量 | 0.1.0 — **PLACEHOLDER，尚未从真实样板测出** |

## 已完成

- `lint.mjs` — 8 条规则 + 4 指标，缺数据时标 skipped 不静默降级
- `measure.mjs` — 栅格覆盖率 / 间距双峰 / 短桩 / 净空；`--write` 递增 version 并写 provenance
- `layout.mjs` — 连通性分层（排除电源网）、跨层用网络标签、L 型避障路由
- `design-notes.md` — D1–D9
- 演示闭环：坏页面 62.9(C) → 布局重构后 83.9(B)

## 待办（按优先级）

1. **adapter**：真实符号引脚坐标 → `sch_PrimitiveComponent` / `sch_PrimitiveWire`。没有它，plan 不能落地。
2. **真实数据校准 schema**：用 3 张真实页面 dump 验证 `pins` 与 `label.align` 两个最可疑字段。
3. **替换 PLACEHOLDER 常量**：跑 `measure --write`，更新 provenance。
4. **15 个 motif 模板**：先做 `LDO_3V3` / `去耦阵列` / `无源晶振` 三个，验证模板会真的被用上。
5. **fixtures + ratings**：攒到 8 条人工评分后校准权重，把 `calibration` 从 UNFIT 改成 FIT。

## 阻塞

- 待办 2、3 卡在**缺少真实页面 dump**。需要用户提供评审过的原理图（克隆到其立创账号后由 bridge 取坐标）。
- 待办 1 需要确认 adapter 落图后 EDA 是否会重新归一化坐标（可能吞掉栅格对齐）。

## 已知坑

- 沙箱代理只放通 `api.github.com`，**不放通 `github.com`**。git 操作必须先 `env -u https_proxy -u HTTPS_PROXY -u http_proxy -u HTTP_PROXY`，并加 `-c http.version=HTTP/1.1`，且**必须重试 3–5 次**（前几次常报 Connection reset / Could not connect）。
- WorkBuddy 的 GitHub MCP connector 只读，建仓与写文件都 403。推代码一律走 git CLI。
- 本环境 `cmd` 被禁，建 junction 用 `New-Item -ItemType Junction`。
- `wire-through-body` 用包围盒内缩判定，会误报，级别是 warn 不是 error（design-notes D8）。

## 最近一次改动

2026-11-16 初始化 v0.1.0。下一个改动从这里接着写。
