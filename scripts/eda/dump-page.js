const pageInfo = await eda.dmt_SelectControl.getCurrentDocumentInfo();
const project = await eda.dmt_Project.getCurrentProjectInfo();

function rnd(v) {
  if (typeof v !== 'number' || !isFinite(v)) return v;
  return Math.round(v * 1000) / 1000;
}

const out = {
  schemaVersion: '0.2.0',
  unit: '0.01in',
  grid: null,
  source: {
    platform: 'easyeda-pro',
    project: (project && project.friendlyName) || '',
    page: (pageInfo && (pageInfo.title || pageInfo.name || pageInfo.displayName)) || '',
    pageUuid: (pageInfo && pageInfo.uuid) || '',
    dumpedAt: new Date().toISOString()
  },
  components: [],
  labels: [],
  wires: [],
  texts: []
};

const partIds = (await eda.sch_PrimitiveComponent.getAllPrimitiveId('part')) || [];
for (const id of partIds) {
  const arr = await eda.sch_PrimitiveComponent.get([id]);
  const c = arr && arr[0];
  if (!c) continue;
  const pins = (await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(id)) || [];
  out.components.push({
    id: c.primitiveId,
    designator: c.designator || '',
    x: rnd(c.x),
    y: rnd(c.y),
    rotation: c.rotation || 0,
    mirror: !!c.mirror,
    symbol: (c.symbol && c.symbol.name) || '',
    footprint: (c.footprint && c.footprint.name) || '',
    net: c.net || '',
    pins: pins.map(function (p) {
      return {
        num: String(p.pinNumber),
        name: p.pinName || '',
        x: rnd(p.x),
        y: rnd(p.y),
        len: p.pinLength || 0,
        rotation: p.rotation || 0,
        noConnected: !!p.noConnected
      };
    })
  });
}

const labelKinds = ['netflag', 'netport', 'netlabel'];
for (const kind of labelKinds) {
  const ids = (await eda.sch_PrimitiveComponent.getAllPrimitiveId(kind)) || [];
  for (const id of ids) {
    const arr = await eda.sch_PrimitiveComponent.get([id]);
    const l = arr && arr[0];
    if (!l) continue;
    const lpins = (await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(id)) || [];
    const conn = lpins.length ? { x: rnd(lpins[0].x), y: rnd(lpins[0].y) } : null;
    out.labels.push({
      id: l.primitiveId,
      kind: kind,
      text: l.net || l.name || '',
      x: rnd(l.x),
      y: rnd(l.y),
      conn: conn,
      rotation: l.rotation || 0,
      mirror: !!l.mirror,
      symbol: (l.symbol && l.symbol.name) || ''
    });
  }
}

const wireIds = (await eda.sch_PrimitiveWire.getAllPrimitiveId()) || [];
for (const id of wireIds) {
  const arr = await eda.sch_PrimitiveWire.get([id]);
  const w = arr && arr[0];
  if (!w) continue;
  const flat = w.line || [];
  const segs = [];
  for (let i = 0; i + 3 < flat.length; i += 4) {
    segs.push([rnd(flat[i]), rnd(flat[i + 1]), rnd(flat[i + 2]), rnd(flat[i + 3])]);
  }
  out.wires.push({ id: w.primitiveId, net: w.net || '', segments: segs });
}

const textIds = (await eda.sch_PrimitiveText.getAllPrimitiveId()) || [];
for (const id of textIds) {
  const arr = await eda.sch_PrimitiveText.get([id]);
  const t = arr && arr[0];
  if (!t) continue;
  out.texts.push({
    id: t.primitiveId,
    text: t.content || '',
    x: rnd(t.x),
    y: rnd(t.y),
    rotation: t.rotation || 0,
    alignMode: t.alignMode,
    fontSize: t.fontSize
  });
}

function gcd(a, b) {
  a = Math.abs(Math.round(a));
  b = Math.abs(Math.round(b));
  while (b) { const t = a % b; a = b; b = t; }
  return a;
}

const vals = [];
function feed(v) { if (typeof v === 'number' && isFinite(v)) vals.push(Math.round(v)); }
for (const c of out.components) { feed(c.x); feed(c.y); for (const p of c.pins) { feed(p.x); feed(p.y); } }
for (const l of out.labels) { feed(l.x); feed(l.y); if (l.conn) { feed(l.conn.x); feed(l.conn.y); } }
for (const w of out.wires) for (const s of w.segments) for (const v of s) feed(v);

const cands = [100, 50, 25, 20, 10, 5, 2, 1];
let best = null;
for (const g of cands) {
  const ok = vals.filter(function (v) { return v % g === 0; }).length;
  if (vals.length && ok / vals.length >= 0.95) { best = g; break; }
}
out.grid = best;
out.gridCoverage = vals.length ? (vals.filter(function (v) { return v % best === 0; }).length / vals.length) : null;

return out;
