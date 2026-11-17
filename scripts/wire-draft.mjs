#!/usr/bin/env node
// Draw the wires. EasyEDA Pro only.
//
// Strategy per net (design-notes D43):
//   1. cluster the pins by proximity - a net like GND has 27 pins all over the
//      sheet, and drawing one trunk across the page is how drawings die;
//   2. inside a cluster, route along a trunk placed *outside* the pin row, with
//      vertical drops - never along the row itself, or the trunk shorts every
//      pin it passes;
//   3. one label per cluster (power nets get a ground/power symbol, signals get
//      a net port). That is what names the net.
//
// Clusters that are too scattered to route safely fall back to per-pin labels.
// Every wire and label is emitted, applied in batches (the bridge caps a single
// call at 30 s), then the netlist is compared pin by pin against the target.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const PORTS = Array.from({ length: 10 }, (_, i) => 49620 + i);

const args = { page: join(ROOT, 'out/copy-placed.json'), target: join(ROOT, 'out/target.json'), commit: false, project: null, pageUuid: null, port: null, chunk: 10 };
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i];
  if (t === '--commit') args.commit = true;
  else if (t === '--project') args.project = process.argv[++i];
  else if (t === '--page-uuid') args.pageUuid = process.argv[++i];
  else if (t === '--port') args.port = Number(process.argv[++i]);
  else if (t === '--page') args.page = process.argv[++i];
  else if (t === '--chunk') args.chunk = Number(process.argv[++i]);
}

const STUB = 15;
const TRUNK_GAP = 20;
const CLUSTER_R = 240;

const FLAG_OF = { GND: 'Ground', '+5V': 'Power', '+12V': 'Power' };

function dirOf(rot) {
  const r = ((rot % 360) + 360) % 360;
  return r === 0 ? [1, 0] : r === 90 ? [0, 1] : r === 180 ? [-1, 0] : [0, -1];
}

// single-linkage clustering on pin positions
function cluster(pins, radius) {
  const groups = [];
  const used = new Set();
  for (let i = 0; i < pins.length; i++) {
    if (used.has(i)) continue;
    const g = [pins[i]];
    used.add(i);
    for (let k = 0; k < g.length; k++) {
      for (let j = 0; j < pins.length; j++) {
        if (used.has(j)) continue;
        if (Math.hypot(pins[j].x - g[k].x, pins[j].y - g[k].y) <= radius) { g.push(pins[j]); used.add(j); }
      }
    }
    groups.push(g);
  }
  return groups;
}

function buildOps(page, target) {
  const byDes = new Map(page.components.map((c) => [c.designator, c]));
  const netPins = new Map();
  for (const c of target.components) {
    for (const p of c.pins) {
      if (!p.net) continue;
      if (!netPins.has(p.net)) netPins.set(p.net, []);
      netPins.get(p.net).push({ ref: `${c.designator}.${p.num}`, designator: c.designator, num: String(p.num) });
    }
  }

  const ops = [];
  const stats = { nets: 0, clusters: 0, trunks: 0, labels: 0, fallback: 0, skipped: [] };

  for (const [net, members] of netPins) {
    stats.nets++;
    const pins = [];
    for (const m of members) {
      const c = byDes.get(m.designator);
      const p = c && c.pins.find((q) => String(q.num) === m.num);
      if (!p) { stats.skipped.push(m.ref); continue; }
      pins.push({ ref: m.ref, x: p.x, y: p.y, rot: p.rotation || 0 });
    }
    if (!pins.length) continue;

    for (const g of cluster(pins, CLUSTER_R)) {
      stats.clusters++;
      const flagKind = FLAG_OF[net] || null;

      // One pin, or too scattered to route safely -> label each pin separately.
      const xs = g.map((p) => p.x), ys = g.map((p) => p.y);
      const spreadX = Math.max(...xs) - Math.min(...xs);
      const spreadY = Math.max(...ys) - Math.min(...ys);
      const mess = g.length > 1 && spreadX > 120 && spreadY > 120;

      if (g.length === 1 || mess) {
        if (g.length > 1) stats.fallback++;
        for (const p of g) {
          const [ux, uy] = dirOf(p.rot);
          const sx = p.x + ux * STUB, sy = p.y + uy * STUB;
          ops.push({ kind: 'wire', segments: [[p.x, p.y, sx, sy]] });
          ops.push({ kind: 'label', net, x: sx, y: sy, rot: ux !== 0 ? 0 : 90, flag: flagKind });
        }
        continue;
      }

      // Horizontal row -> trunk below; vertical column -> trunk to the left.
      const horizontal = spreadX >= spreadY;
      const trunkY = Math.min(...ys) - TRUNK_GAP;
      const trunkX = Math.min(...xs) - TRUNK_GAP;
      const drops = [];

      for (const p of g) {
        const [ux, uy] = dirOf(p.rot);
        const sx = p.x + ux * STUB, sy = p.y + uy * STUB;
        if (sx !== p.x || sy !== p.y) ops.push({ kind: 'wire', segments: [[p.x, p.y, sx, sy]] });
        if (horizontal) {
          // drop straight down to the trunk, then the trunk carries the net
          if (sy !== trunkY) ops.push({ kind: 'wire', segments: [[sx, sy, sx, trunkY]] });
          drops.push([sx, trunkY]);
        } else {
          if (sx !== trunkX) ops.push({ kind: 'wire', segments: [[sx, sy, trunkX, sy]] });
          drops.push([trunkX, sy]);
        }
      }

      // trunk segments between consecutive drops
      const sorted = drops.slice().sort((a, b) => (horizontal ? a[0] - b[0] : a[1] - b[1]));
      for (let i = 1; i < sorted.length; i++) {
        const a = sorted[i - 1], b = sorted[i];
        if (a[0] === b[0] && a[1] === b[1]) continue;
        ops.push({ kind: 'wire', segments: [[a[0], a[1], b[0], b[1]]] });
      }
      stats.trunks++;
      const at = sorted[0];
      ops.push({ kind: 'label', net, x: at[0], y: at[1], rot: horizontal ? 0 : 90, flag: flagKind });
      stats.labels++;
    }
  }
  // labels on single-pin clusters were pushed inside the loop; count them
  stats.labels = ops.filter((o) => o.kind === 'label').length;
  stats.wires = ops.filter((o) => o.kind === 'wire').length;
  return { ops, stats };
}

async function findBridge(preferred) {
  const ports = preferred ? [preferred, ...PORTS.filter((p) => p !== preferred)] : PORTS;
  for (const port of ports) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
      const j = await r.json();
      if (j && j.service === 'easyeda-bridge') return { port, health: j };
    } catch { /* closed */ }
  }
  return null;
}

const page = readJson(resolve(args.page));
const target = readJson(resolve(args.target));
const { ops, stats } = buildOps(page, target);

console.log(`网络 ${stats.nets} · 聚簇 ${stats.clusters}（主干 ${stats.trunks} · 退化标签 ${stats.fallback}）`);
console.log(`待创建 ${stats.wires} 段导线 + ${stats.labels} 个标签`);
if (stats.skipped.length) console.log(`跳过引脚 ${stats.skipped.length}: ${stats.skipped.slice(0, 6).join(' ')}`);

if (!args.commit) { console.log('\n预演结束，加 --commit 写入。'); process.exit(0); }

const found = await findBridge(args.port);
if (!found?.health.edaConnected) { console.error('EDA 未连接。'); process.exit(2); }

// Dedupe against what is already on the page. Each create() takes ~1 s, so a
// batch can hit the bridge's 30 s cap and leave a partial result; re-running
// must not double everything.
async function existingGeometry() {
  return run(guard + `
    const wIds = (await eda.sch_PrimitiveWire.getAllPrimitiveId()) || [];
    const ws = wIds.length ? await eda.sch_PrimitiveWire.get(wIds) : [];
    const segs = [];
    for (const w of ws) {
      const line = w.line || [];
      for (let i = 0; i + 3 < line.length; i += 2) segs.push([Math.round(line[i]), Math.round(line[i + 1]), Math.round(line[i + 2]), Math.round(line[i + 3])]);
    }
    const labels = [];
    for (const kind of ['netflag', 'netport', 'netlabel']) {
      const ids = (await eda.sch_PrimitiveComponent.getAllPrimitiveId(kind)) || [];
      const arr = ids.length ? await eda.sch_PrimitiveComponent.get(ids) : [];
      for (const a of arr) labels.push([kind, Math.round(a.x), Math.round(a.y), a.net || '']);
    }
    return { segs, labels };
  `);
}

// project guard: page uuids are shared across projects (D39)
const guard = `
  const PROJ = ${args.project ? JSON.stringify(args.project) : 'null'};
  if (PROJ) {
    let cur = await eda.dmt_Project.getCurrentProjectInfo();
    if (!cur || cur.uuid !== PROJ) { await eda.dmt_Project.openProject(PROJ); await new Promise(r => setTimeout(r, 3200)); cur = await eda.dmt_Project.getCurrentProjectInfo(); }
    if (!cur || cur.uuid !== PROJ) return { aborted: 'project-mismatch', want: PROJ, got: cur ? cur.uuid : null, name: cur ? cur.friendlyName : null };
  }
  ${args.pageUuid ? `await eda.dmt_EditorControl.openDocument(${JSON.stringify(args.pageUuid)}); await new Promise(r => setTimeout(r, 2200));` : ''}
`;

async function run(code) {
  const res = await fetch(`http://127.0.0.1:${found.port}/execute`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }), signal: AbortSignal.timeout(120000)
  });
  const j = await res.json();
  if (!j.success) throw new Error(j.error || 'execute failed');
  return j.result;
}

const have = await existingGeometry();
const segKey = (a) => {
  const k1 = `${a[0]},${a[1]}|${a[2]},${a[3]}`;
  const k2 = `${a[2]},${a[3]}|${a[0]},${a[1]}`;
  return k1 < k2 ? k1 : k2;
};
const haveSeg = new Set((have.segs || []).map(segKey));
const haveLab = new Set((have.labels || []).map((l) => `${l[1]},${l[2]},${l[3]}`));
const todo = ops.filter((o) => {
  if (o.kind === 'wire') return !o.segments.every((sg) => haveSeg.has(segKey(sg)));
  return !haveLab.has(`${Math.round(o.x)},${Math.round(o.y)},${o.net}`);
});
console.log(`页面上已有 ${(have.segs || []).length} 段线 / ${(have.labels || []).length} 个标签；本次实际创建 ${todo.length} 个操作`);

let totalW = 0, totalL = 0, errors = [];
for (let i = 0; i < todo.length; i += args.chunk) {
  const batch = todo.slice(i, i + args.chunk);
  const code = guard + `
    const BATCH = ${JSON.stringify(batch)};
    const out = { wires: 0, labels: 0, errors: [] };
    for (const op of BATCH) {
      try {
        if (op.kind === 'wire') {
          const r = await eda.sch_PrimitiveWire.create(op.segments);
          if (r) out.wires++; else out.errors.push('wire-null');
        } else if (op.flag) {
          const r = await eda.sch_PrimitiveComponent.createNetFlag(op.flag, op.net, op.x, op.y, op.rot);
          if (r) out.labels++; else out.errors.push('flag-null');
        } else {
          const r = await eda.sch_PrimitiveComponent.createNetPort('BI', op.net, op.x, op.y, op.rot);
          if (r) out.labels++; else out.errors.push('port-null');
        }
      } catch (e) { out.errors.push(String(e && e.message ? e.message : e).slice(0, 60)); }
      await new Promise(r => setTimeout(r, 40));
    }
    return out;
  `;
  const r = await run(code);
  if (r && r.aborted) { console.error(`中止：工程不匹配（需要 ${r.want}，当前 ${r.got}）`); process.exit(3); }
  totalW += r.wires; totalL += r.labels;
  errors = errors.concat(r.errors);
  process.stdout.write(`\r写入 ${i + batch.length}/${todo.length} · 线 ${totalW} · 标签 ${totalL}   `);
}
console.log('');

const verdict = await run(guard + `
  const ids = await eda.sch_PrimitiveComponent.getAllPrimitiveId('part');
  const cs = await eda.sch_PrimitiveComponent.get(ids);
  const byUid = new Map(cs.map(c => [c.uniqueId, c.designator]));
  let saved = null;
  try { saved = await eda.sch_Document.save(); } catch (e) { saved = 'err'; }
  await new Promise(r => setTimeout(r, 900));
  const nl = JSON.parse(await eda.sch_Netlist.getNetlist('JLCEDA'));
  const map = {};
  for (const uid of Object.keys(nl.components || {})) {
    const d = byUid.get(uid); if (!d) continue;
    const pim = nl.components[uid].pinInfoMap || {};
    for (const pk of Object.keys(pim)) map[d + '.' + pk] = pim[pk].net || '';
  }
  return { saved, map };
`);
if (verdict.aborted) { console.error('中止：工程不匹配'); process.exit(3); }

// compare against target
const want = {};
for (const c of target.components) for (const p of c.pins) if (p.net) want[`${c.designator}.${p.num}`] = p.net;

const bad = [];
for (const k of Object.keys(want)) {
  if ((verdict.map[k] || '') !== want[k]) bad.push({ pin: k, want: want[k], got: verdict.map[k] || '' });
}
writeFileSync(join(ROOT, 'out/wire-verify.json'), JSON.stringify({ stats, errors: errors.slice(0, 40), mismatch: bad }, null, 2) + '\n', 'utf8');

console.log(`保存 ${verdict.saved === true ? '成功' : verdict.saved}`);
if (errors.length) console.log(`创建报错 ${errors.length} 条：${errors.slice(0, 4).join(' | ')}`);
console.log(`网表比对：${Object.keys(want).length} 个引脚，不一致 ${bad.length}`);
for (const b of bad.slice(0, 12)) console.log(`  ${b.pin}: 期望 ${b.want} → 实际 ${b.got || '(空)'}`);
process.exit(bad.length ? 1 : 0);
