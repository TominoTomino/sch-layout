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

const pinNet = new Map();
try {
  const rawNl = await eda.sch_Netlist.getNetlist('JLCEDA');
  const j = JSON.parse(rawNl);
  const comps = j.components || {};
  for (const id of Object.keys(comps)) {
    const props = comps[id].props || {};
    const des = props['Designator'];
    const pm = comps[id].pinInfoMap || {};
    for (const k of Object.keys(pm)) {
      const e = pm[k];
      pinNet.set(des + '.' + String(e.number), e.net || '');
    }
  }
} catch (e) {
  out.connectivityError = String(e);
}
out.connectivitySource = pinNet.size ? 'netlist' : 'none';

const partIds = (await eda.sch_PrimitiveComponent.getAllPrimitiveId('part')) || [];
for (const id of partIds) {
  const arr = await eda.sch_PrimitiveComponent.get([id]);
  const c = arr && arr[0];
  if (!c) continue;
  const pins = (await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(id)) || [];
  // Property text (designator, part name) is a separate primitive with its own
  // coordinates, so a component's visual footprint is larger than its symbol
  // BBOX. Without this, placing two parts 10 units apart looks fine in the data
  // and reads as an overlap on the sheet (D46).
  let attrs = [];
  try {
    const raw = (await eda.sch_PrimitiveAttribute.getAll(id)) || [];
    // `={Value}` and `={Manufacturer Part}` are templates, not text. Width is
    // judged downstream, so resolve them here where the part data is at hand:
    // Value is the short, schematic-appropriate string; the symbol name is the
    // part number; the LCSC name is the long, human-readable one (D47).
    const op = c.otherProperty || {};
    // Symbol names often carry the LCSC catalogue number (1N4148W_C2892570).
    // That suffix is procurement data, not a part designation, and it is what
    // pushes the name so wide that the font has to shrink below legibility.
    const stripCatalogue = function (t) {
      return String(t || '').replace(/_C\d+$/, '').trim();
    };
    const resolve = function (tpl) {
      if (tpl === '={Value}') return op['Value'] || stripCatalogue(c.symbol && c.symbol.name);
      if (tpl === '={Manufacturer Part}') return stripCatalogue(c.symbol && c.symbol.name) || op['LCSC Part Name'] || '';
      return null;
    };
    attrs = raw
      .filter(function (a) {
        return a.key === 'Designator' || a.key === 'Name' || a.key === 'Value';
      })
      .map(function (a) {
        const rawText = a.value == null ? '' : String(a.value);
        const hit = /^=\{.*\}$/.test(rawText) ? resolve(rawText) : null;
        return {
          key: a.key,
          value: rawText,
          // What the sheet actually prints, when we could work it out.
          rendered: hit,
          x: rnd(a.x),
          y: rnd(a.y),
          rotation: a.rotation || 0,
          fontSize: a.fontSize || null,
          // keyVisible/valueVisible decide whether the glyphs are drawn at all.
          visible: a.valueVisible !== false
        };
      });
  } catch (e) {
    out.attributeError = String(e && e.message ? e.message : e);
  }
  out.components.push({
    id: c.primitiveId,
    designator: c.designator || '',
    x: rnd(c.x),
    y: rnd(c.y),
    rotation: c.rotation || 0,
    mirror: !!c.mirror,
    symbol: (c.symbol && c.symbol.name) || '',
    symbolUuid: (c.symbol && c.symbol.uuid) || '',
    deviceUuid: (c.component && c.component.uuid) || '',
    subPart: c.subPartName || '',
    footprint: (c.footprint && c.footprint.name) || '',
    net: c.net || '',
    attrs: attrs,
    pins: pins.map(function (p) {
      return {
        num: String(p.pinNumber),
        name: p.pinName || '',
        x: rnd(p.x),
        y: rnd(p.y),
        len: p.pinLength || 0,
        rotation: p.rotation || 0,
        net: pinNet.has(c.designator + '.' + String(p.pinNumber)) ? pinNet.get(c.designator + '.' + String(p.pinNumber)) : null,
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
const TOL = 0.1; // sub-unit drift after writes is noise, not a drawing error (D34)
function onGrid(v, g) {
  const r = ((v % g) + g) % g;
  return Math.min(r, g - r) <= TOL;
}
let best = null;
for (const g of cands) {
  const ok = vals.filter(function (v) { return onGrid(v, g); }).length;
  if (vals.length && ok / vals.length >= 0.95) { best = g; break; }
}
out.grid = best;
out.gridCoverage = vals.length ? (vals.filter(function (v) { return onGrid(v, best); }).length / vals.length) : null;

const allPins = out.components.reduce(function (s, c) { return s.concat(c.pins); }, []);
out.connectivity = {
  source: out.connectivitySource,
  totalPins: allPins.length,
  pinsWithoutNet: allPins.filter(function (p) { return p.net === ''; }).length,
  pinsUnknown: allPins.filter(function (p) { return p.net === null; }).length
};
delete out.connectivitySource;
delete out.connectivityError;

return out;
