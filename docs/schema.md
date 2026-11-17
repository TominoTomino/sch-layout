# 数据格式

三种数据，三种用途，不要混用。

| 文件 | 谁产出 | 谁消费 | 说明 |
|---|---|---|---|
| `page.json` | adapter 从 EDA dump | `lint` / `measure` | 真实页面的全量快照 |
| `design.json` | 人或模型 | `layout` | 抽象盒模型，不含真实几何 |
| `plan.json` | `layout` | adapter / 人工检查 | 坐标方案，尚未落地 |

坐标统一用 **0.01 英寸（10 mil）** 为单位，与嘉立创 EDA 专业版原理图一致。

---

## 1. page.json — 页面 dump

**schemaVersion 0.2.0**（0.1 → 0.2 的变化见 `references/design-notes.md` D14–D18，全部来自真实数据）

```jsonc
{
  "schemaVersion": "0.2.0",
  "unit": "0.01in",
  "grid": 5,                       // 覆盖率推断所得；null 表示无法推断，lint 回落到 constants.grid
  "gridCoverage": 0.983,
  "source": { "platform": "easyeda-pro", "project": "...", "page": "P1", "pageUuid": "..." },

  "components": [{
    "id": "fd4e8ff3dbb73e33",      // primitiveId，稳定唯一
    "designator": "U3",
    "x": 270, "y": 915,            // 元件原点，浮点已取整
    "rotation": 0, "mirror": false,
    "symbol": "CMS8S6990N-TSSOP20",
    "footprint": "TSSOP-20_L6.5-W4.4-P0.65-LS6.4-BL",
    "pins": [{
      "num": "1", "name": "C0P5/C1P5",
      "x": 120, "y": 960,
      "len": 10,                   // pinLength
      "rotation": 180,
      "noConnected": false         // EDA 自己标的未连接标记，可作交叉验证
    }]
  }],

  "labels": [{
    "id": "6dc8866d2b26d49a",
    "kind": "netport",             // netflag | netport | netlabel
    "text": "TM_SDA",
    "x": 90, "y": 950,             // 图形锚点
    "conn": { "x": 90, "y": 950 }, // 电连接点（符号引脚）；标签电气的就是这个点
    "rotation": 0
  }],

  "wires": [{
    "id": "26505adcaaaa2976",
    "net": "N",
    "segments": [[1045,305,1045,300],[1125,300,1045,300]]   // 每项一个独立线段，不是一个折线
  }],

  "texts": [{ "id": "3448fd6fdf5a3fbf", "text": "EMS", "x": 990, "y": 370, "rotation": 0, "alignMode": 3 }]
}
```

### 三个必须知道的坑

**坐标是浮点。** `915` 会返回成 `914.9999999999999`。dump 时必须 `Math.round(v*1000)/1000`，否则栅格推断退化成 1、结点索引全部错位。

**`segments` 不是折线。** 一个 wire 图元常是从某个结点发散的星形，按四点一段读。拐点按「度为 2 且方向不共线的结点」算，分支点（度 ≥3）单独统计。

**标签的电连接点不等于锚点。** `netflag` / `netport` 是组件，`(x, y)` 是图形位置，电气连接在它们的引脚上（`conn`）。用锚点匹配导线端点会产生大量假悬空。

### 字段缺失的实际影响

缺 `pins` → `dangling-wire` 精度下降。
缺 `bbox` → 由引脚外接框 + 10 padding 推导，`overlap` 与 `wire-through-body` 会误报（真实符号轮廓 API 不提供，D8）。
缺 `labels` → `label-overlap` 整条规则被跳过。

lint 会把这些缺失作为 `pageIssues` 报出来，不会静默降级。

---

## 2. design.json — 抽象盒模型

```jsonc
{
  "design": "DEMO_LDO_3V3",
  "components": [
    { "id": "U1", "ref": "U1", "kind": "ic",
      "leftPins": 2, "rightPins": 3, "topPins": 0, "bottomPins": 0 }
  ],
  "nets": [
    { "name": "VCC_5V", "pins": ["J1.1", "C1.1", "U1.1"] }
  ]
}
```

引脚编号按 `left → right → top → bottom` 顺序自动分配（1 起）。
也可以直接给 `pins: [{num, side, ord, sideCount}]` 覆盖默认分配。

**全局网络的判定**（不参与信号流分层，一律用标签连接）：

- 引脚数 > 4
- 名称含 `GND/AGND/DGND/PGND/VSS/VCC/VDD/VBUS/VEE`（须作为独立词段）
- 以 `+数字` 或 `-数字` 开头

---

## 3. plan.json — 布局方案

```jsonc
{
  "engine": "naive-layered-v0",
  "components": [{ "id": "U1", "x": 40, "y": 40, "w": 30, "h": 40, "layer": 0,
                   "pins": [{ "num": "1", "side": "left", "x": 40, "y": 55 }] }],
  "wires":    [{ "id": "w1", "net": "...", "points": [[40,55],[60,55]] }],
  "labels":   [{ "id": "l1", "text": "...", "x": 30, "y": 55, "align": "end" }]
}
```

`--emit-page` 会把 plan 转成 `page.json` 供 `lint` 自检。合成页面的 `source.platform` 为 `layout-plan`，`synthetic: true`，**不可写回 EDA**。

---

## 4. 模板（未启用，格式先定）

```jsonc
{
  "schemaVersion": "0.1.0",
  "kind": "motif",                  // motif | page
  "name": "LDO_SOT23_3V3",
  "matches": { "components": 3, "pattern": "cap+ic+cap" },
  "relative": {
    "C1": { "dx": -60, "dy": 0,  "rotation": 0 },
    "U1": { "dx": 0,   "dy": 0,  "rotation": 0 },
    "C2": { "dx": 60,  "dy": 0,  "rotation": 0 }
  },
  "constraints": ["C1.pin1 → U1.IN 距离 ≤ 120"],
  "source": {
    "platform": "oshwhub", "projectId": "...", "license": "CERN-OHL-S",
    "extracted": ["gap", "orientation", "relativeOrder"]
  },
  "review": {
    "good": "去耦贴在电源脚旁，一眼看出供电关系",
    "dislike": "右侧接口略挤",
    "complexity": "10-20"
  }
}
```

`source.extracted` 是许可边界的凭证：只记提取了什么，不记复制了什么。
`review` 三行是人工标注，**必填**——没有它的模板不入库（见 design-notes D6）。
