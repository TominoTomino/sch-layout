# templates

两级模板。格式见 `docs/schema.md` 第 4 节。

## motifs/ — 模块级

LDO、去耦、晶振、复位、USB、SWD……**全世界通用**，可以对开源平台提取通用惯例。

目标是 15 个，清单在 `references/style.md`。每个模板只存相对坐标与朝向。

## pages/ — 整页级

分区方案、信号流向、标题与留白。**高度个人化**，只能从你自己的项目里来。

三档就够：`<10` / `10-20` / `20+` 元件。再多也不会更准。

## 入库条件（两条都要满足）

1. `lint` 分数不低于同档位的已有模板
2. `review` 三行人工标注齐全：好在哪 / 不喜欢什么 / 复杂度档

只有第 1 条会收进一堆几何干净但意图混乱的图。只有第 2 条会收进你个人喜欢但画得乱的图。

---

## 实际格式（0.1.0，由 `scripts/motif.mjs extract` 生成，不手写）

```jsonc
{
  "schemaVersion": "0.1.0",
  "kind": "motif",
  "id": "crystal-4pin-2cap",
  "grid": 5,
  "anchor": "osc",                       // 坐标原点落在哪个角色上
  "bbox": { "x0": 0, "y0": -25, "x1": 85, "y1": 10 },   // 相对 anchor 的外接框，布局时预留空间用
  "slots": [                             // 角色，不是位号
    { "role": "osc", "pins": 4, "symbol": "...", "dx": 0, "dy": 0, "rotation": 0, "mirror": false },
    { "role": "cap_xi", "pins": 2, "symbol": "...", "dx": 85, "dy": 10, "rotation": 0, "mirror": false }
  ],
  "nets": [                              // 角色.引脚号，不含网名（网名是项目相关的）
    { "role": "HUB_XI", "members": ["osc.3", "cap_xi.1"], "external": true },
    { "role": "GND",    "members": ["osc.2", "osc.4", "cap_xi.2", "cap_xo.2"], "external": true }
  ],
  "source": { "project": "...", "extractedFrom": "X1,XC1,XC2", "extractedAt": "..." }
}
```

三个关键约定：

1. **不留位号、不留网名。** `role` 是功能名（`osc` / `cap_xi` / `en_pullup`），网络只记"哪些角色的哪些脚连在一起"。网名换项目就变，结构不变。
2. **`dx/dy` 是相对 `anchor` 的栅格倍数**，不是绝对坐标。所以模板能落到任何位置。
3. **`external`** 标记这个网要连到模板外面去。布局时外部网走标签，内部网走实线——正好对应连线策略。

`symbol` 只作提示，不作匹配依据：同一个角色在不同项目里可能是不同型号（8MHz 晶振和 16MHz 晶振结构相同）。

## 已有模板

| id | 角色 | 内/外网 | 来源 |
|---|---|---|---|
| `crystal-4pin-2cap` | osc · cap_xi · cap_xo | 3 外 | CW32 集线器 X1/XC1/XC2 |
| `ldo-3v3-4cap` | ldo · cap_in · cap_in_bulk · cap_out · cap_out_bulk · en_pullup | 3 外 1 内 | CW32 集线器 U4 邻域 |

第二个值得看一眼：`en_pullup` 的上端接在 `5VOUT` 上、下端接 `ldo.3`，而这个 EN 节点**没有连到模板外面**，所以自动判成内部网。这种"局部小网"恰恰是最容易被总结掉的信息——用文字描述"EN 要上拉"不会告诉你在哪个引脚、拉多远。
