# fixtures

回归用例。**每次改 layout 或 lint，都必须把这批全跑一遍**，否则你不知道改动是修好了还是搞坏了。

## 一个用例包含什么

```
fixtures/<name>/
  page.json     该项目的页面 dump
  expect.json   期望结果（可只记 error 级规则的有无，不必记分数）
  note.md       这个项目当时的问题是什么、为什么留作回归
```

## expect.json 的最小形式

```json
{
  "mustFail": ["wire-through-body", "label-overlap"],
  "mustPass": ["grid-off", "diagonal"]
}
```

只断言规则的有无，不锁定分数。分数会随权重调整而漂移，锁死它会让你每次校准都要改一堆期望值。

## ratings.json

人工评分，用于校准权重（见 `references/design-notes.md` D7）。

```json
[
  { "page": "fixtures/board-a/page.json", "human": 85, "comment": "能直接给同事看，不需要解释" },
  { "page": "fixtures/board-b/page.json", "human": 45, "comment": "得配合口述才看得懂" }
]
```

评分标准用一句话锚定：**「这份图能不能不经口述就交给同事」**，10 分一档。
凑到 8 条以上才有校准意义，少于 8 条拟合出来的权重是噪声。
