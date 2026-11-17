// Probe: can a component's designator / value text be read and moved?
//
// SCH_PrimitiveAttribute is the primitive behind "位号" and "型号" text. Unlike
// wires and net flags, this class has a real modify() with x / y / rotation /
// alignMode / fontSize, so text placement is adjustable after the fact.
//
// Reading is harmless; run this before trusting the integration.
const ids = await eda.sch_PrimitiveComponent.getAllPrimitiveId('part');
const comps = await eda.sch_PrimitiveComponent.get(ids);
const pick = comps.slice(0, 3);

const out = [];
for (const c of pick) {
  const attrs = (await eda.sch_PrimitiveAttribute.getAll(c.primitiveId)) || [];
  out.push({
    designator: c.designator,
    componentId: c.primitiveId,
    at: { x: c.x, y: c.y },
    attributes: attrs.map((a) => ({
      id: a.primitiveId,
      key: a.key,
      value: a.value,
      x: a.x,
      y: a.y,
      dx: Math.round((a.x - c.x) * 100) / 100,
      dy: Math.round((a.y - c.y) * 100) / 100,
      rotation: a.rotation,
      alignMode: a.alignMode,
      fontSize: a.fontSize,
      keyVisible: a.keyVisible,
      valueVisible: a.valueVisible
    }))
  });
}
return { sampled: out.length, detail: out };
