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

```jsonc
{
  "schemaVersion": "0.1.0",
  "unit": "0.01in",
  "grid": 10,                      // 编辑器的栅格，lint 的 grid-off 用它
  "source": { "platform": "easyeda", "project": "...", "page": "P1" },

  "components": [{
    "id": "u1",                    // 稳定唯一 ID，不用位号（位号会变）
    "designator": "U1",
    "x": 200, "y": 300,            // 元件原点，必须在栅格上
    "rotation": 0,                 // 0/90/180/270
    "mirror": false,
    "bbox": { "x": 200, "y": 300, "w": 80, "h": 60 },   // 缺省时由引脚外接框推导
    "pins": [
      { "num": "1", "name": "IN", "x": 200, "y": 320 }
    ]
  }],

  "wires": [{
    "id": "w1",
    "net": "VCC_5V",               // 可为 null
    "points": [[120,320],[160,310]] // 折线，首尾必须落在引脚/标签/其它导线端点
  }],

  "labels": [{
    "id": "l1", "text": "VCC_5V",
    "x": 120, "y": 320,
    "rotation": 0,
    "align": "start"               // start | middle | end，决定 bbox 从锚点向哪边长
  }],

  "texts": [{ "id": "t1", "text": "LDO 3V3", "x": 200, "y": 270 }]
}
```

### 字段要求的实际影响

缺 `pins` → `dangling-wire` 精度下降（无法区分「接在引脚上」和「悬空」）。
缺 `bbox` → 由引脚外接框推导，`overlap` 与 `wire-through-body` 会漏报。
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
