// Browser-side executor for sch-layout write operations.
//
// __OPS__ and __GRID__ are substituted by scripts/apply.mjs before this code is
// sent to the EDA bridge.
//
// Ground rules, each one paid for by an experiment (see references/design-notes):
//
//   D30  Moving a component does NOT move its wires; 60 pins lost their nets.
//        A move is nevertheless reversible and verifiable, so it is a usable
//        primitive - as long as the wires are rebuilt around it.
//   D31  SCH_PrimitiveWire.modify({line}) is NOT safe: the editor re-merges
//        wires on write, can leave a stray spur, and "writing the original back"
//        does not restore the netlist (one pin ended up on a phantom net).
//        So wires are never edited in place - they are deleted and recreated
//        with an explicit net, which is correct by construction.
//   D31  Rollback therefore cannot use inverse modifies. The snapshot must be
//        enough to REBUILD: original line + net for every touched wire.
//
// The netlist is the only authority. Per-pin compare before/after; any
// difference triggers a full rebuild-based rollback.

const OPS = __OPS__;
const GRID = __GRID__;

const r0 = (v) => Math.round(v);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// `get()` returns `line` as a flat array of consecutive points, which for a
// multi-segment wire is longer than one segment. `create()` rejects that shape
// ("create failed!"), and in a rollback that means the wire is gone for good -
// measured, not assumed. So always recreate as an explicit segment list.
function toSegments(flat) {
  const segs = [];
  for (let i = 0; i + 3 < flat.length; i += 2) {
    const a = [flat[i], flat[i + 1]];
    const b = [flat[i + 2], flat[i + 3]];
    if (a[0] === b[0] && a[1] === b[1]) continue; // zero-length from repeated points
    segs.push([a[0], a[1], b[0], b[1]]);
  }
  if (!segs.length && flat.length >= 4) segs.push([flat[0], flat[1], flat[2], flat[3]]);
  return segs;
}

async function pinNets() {
  const nl = JSON.parse(await eda.sch_Netlist.getNetlist('JLCEDA'));
  const m = {};
  for (const uid of Object.keys(nl.components || {})) {
    const pim = nl.components[uid].pinInfoMap || {};
    for (const pk of Object.keys(pim)) m[uid + '.' + pk] = pim[pk].net || '';
  }
  return m;
}

function diffNets(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out = [];
  for (const k of keys) {
    if ((a[k] ?? '') !== (b[k] ?? '')) out.push({ pin: k, before: a[k] ?? '', after: b[k] ?? '' });
  }
  return out;
}

// create() right after delete() fails with a bare "create failed!". The editor
// needs a beat to settle its geometry cache. Measured: without this wait the
// first create always failed, which also broke rollback (the wire vanished).
async function createWire(segs, net, tries = 5) {
  // `net` is deliberately NOT passed: after the original wire is deleted the net
  // may have no remaining geometry, and create(line, net) then fails with a bare
  // "create failed!" - measured twice during rehearsal. Letting the editor infer
  // the net from what the wire touches is both more robust and verified by the
  // per-pin comparison that follows.
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      const w = await eda.sch_PrimitiveWire.create(segs);
      if (w) return w;
    } catch (e) {
      last = e;
    }
    await wait(350);
  }
  if (last) throw last;
  return null;
}

const wireIds = (await eda.sch_PrimitiveWire.getAllPrimitiveId()) || [];
const wires = wireIds.length ? await eda.sch_PrimitiveWire.get(wireIds) : [];

const labelIds = [];
for (const kind of ['netflag', 'netport', 'netlabel']) {
  const ids = (await eda.sch_PrimitiveComponent.getAllPrimitiveId(kind)) || [];
  for (const id of ids) labelIds.push(id);
}
const labels = labelIds.length ? await eda.sch_PrimitiveComponent.get(labelIds) : [];

async function partIds() {
  const ids = (await eda.sch_PrimitiveComponent.getAllPrimitiveId('part')) || [];
  return ids.slice().sort();
}

const partsBefore = await partIds();
const before = await pinNets();

// ---- plan ----
// A snap point may be shared by several wires and one label. All of them must
// move together or the junction comes apart.
const rebuild = [];   // { id, line(original), net, next }
const moveLabels = []; // { id, original:{x,y}, next:{x,y} }

for (const op of OPS) {
  const [fx, fy] = op.from;
  const [tx, ty] = op.to;

  for (const w of wires) {
    if (!Array.isArray(w.line) || w.line.length < 4) continue;
    if (rebuild.some((r) => r.id === w.primitiveId)) continue;
    let hit = false;
    const next = w.line.slice();
    for (let i = 0; i + 1 < next.length; i += 2) {
      if (r0(next[i]) === fx && r0(next[i + 1]) === fy) {
        next[i] = tx;
        next[i + 1] = ty;
        hit = true;
      }
    }
    if (hit) rebuild.push({ id: w.primitiveId, line: w.line.slice(), net: w.net || '', next });
  }

  for (const l of labels) {
    if (r0(l.x) !== fx || r0(l.y) !== fy) continue;
    if (moveLabels.some((t) => t.id === l.primitiveId)) continue;
    moveLabels.push({ id: l.primitiveId, original: { x: l.x, y: l.y }, next: { x: tx, y: ty } });
  }
}

if (!rebuild.length && !moveLabels.length) {
  return { opsRequested: OPS.length, wiresRebuilt: 0, labelsMoved: 0, netlistChanged: 0, rolledBack: false };
}

// ---- apply: delete -> move -> recreate ----
const errors = [];
if (rebuild.length) {
  try {
    await eda.sch_PrimitiveWire.delete(rebuild.map((r) => r.id));
  } catch (e) {
    errors.push('delete: ' + (e && e.message ? e.message : e));
  }
  await wait(500);
}
for (const t of moveLabels) {
  try {
    await eda.sch_PrimitiveComponent.modify(t.id, t.next);
  } catch (e) {
    errors.push('label ' + t.id + ': ' + (e && e.message ? e.message : e));
  }
}
const created = [];
for (const r of rebuild) {
  try {
    const w = await createWire(toSegments(r.next), r.net);
    created.push(w && w.primitiveId ? w.primitiveId : null);
    await wait(150); // back-to-back creates also collide occasionally
  } catch (e) {
    errors.push('create: ' + (e && e.message ? e.message : e));
    created.push(null);
  }
}

await wait(900);
let after = await pinNets();
let changed = diffNets(before, after);

// Edits live in memory until the document is saved; reopening the page (which
// every dump does) throws them away. Verified: two re-created wires vanished on
// the next openDocument, and persisted only after SCH_Document.save().
let saved = null;
if (!changed.length) {
  try { saved = await eda.sch_Document.save(); } catch (e) { saved = 'err:' + (e && e.message ? e.message : e); }
}

// An edit is allowed to move wires and rotate symbols. It is never allowed to
// add or remove parts - if the inventory changes, something went wrong and the
// netlist diff alone may not notice (a deleted part takes its pins with it,
// so there is nothing left to compare).
const partsAfter = await partIds();
const partsLost = partsBefore.filter((id) => !partsAfter.includes(id));
const partsGained = partsAfter.filter((id) => !partsBefore.includes(id));
const inventoryChanged = partsLost.length + partsGained.length;
if (inventoryChanged) changed = changed.concat([{ pin: '<inventory>', before: String(partsBefore.length), after: String(partsAfter.length) }]);

// ---- rollback by rebuild, never by inverse modify (D31) ----
let rolledBack = false;
if (changed.length) {
  try { await eda.sch_PrimitiveWire.delete(created.filter(Boolean)); } catch { /* continue */ }
  await wait(500);
  for (const t of moveLabels) {
    try { await eda.sch_PrimitiveComponent.modify(t.id, t.original); } catch { /* continue */ }
  }
  for (const r of rebuild) {
    try { await createWire(toSegments(r.line), r.net); } catch { /* continue */ }
  }
  await wait(900);
  after = await pinNets();
  rolledBack = true;
  try { saved = await eda.sch_Document.save(); } catch (e) { saved = 'err:' + (e && e.message ? e.message : e); }
}

const residual = diffNets(before, after);

return {
  opsRequested: OPS.length,
  wiresRebuilt: rebuild.length,
  labelsMoved: moveLabels.length,
  createdIds: created,
  errors,
  netlistChanged: changed.length,
  saved,
  partsBefore: partsBefore.length,
  partsAfter: partsAfter.length,
  partsLost,
  partsGained,
  changedSample: changed.slice(0, 8),
  rolledBack,
  residualAfterRollback: residual.length,
  residualSample: residual.slice(0, 8)
};
