#!/usr/bin/env node
// Apply a placement plan to the open page.
//
// Only coordinates change. Wires attached to components that do not move stay
// valid; everything else is expected to have no real connection (the user
// cleared it). Orphan wires - nets with fewer than two pins - are deleted
// first, because they are the debris of that deletion and would otherwise be
// dragged around as dangling stubs.
//
// Verification: every pin that had a real net before must still have the same
// net after. That is the only thing that matters at this stage, since the plan
// deliberately does not touch connectivity.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PORTS = Array.from({ length: 10 }, (_, i) => 49620 + i);
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const args = { plan: join(ROOT, 'out/plan.json'), commit: false, port: null, page: null, project: null };
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i];
  if (t === '--commit') args.commit = true;
  else if (t === '--port') args.port = Number(process.argv[++i]);
  else if (t === '--page') args.page = process.argv[++i];
  else if (t === '--project') args.project = process.argv[++i];
  else if (t === '--plan') args.plan = process.argv[++i];
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

const plan = readJson(args.plan);
const moves = Object.entries(plan.components).filter(([, p]) => !p.fixed);
console.log(`方案: 移动 ${moves.length} 个 · 固定 ${plan.fixed.length} 个`);

if (!args.commit) {
  for (const [d, p] of moves.slice(0, 8)) console.log(`  ${d} → (${p.x}, ${p.y})`);
  console.log('预演结束，加 --commit 写入。');
  process.exit(0);
}

const found = await findBridge(args.port);
if (!found?.health.edaConnected) { console.error('EDA 未连接。'); process.exit(2); }

const code = `
const PLAN = ${JSON.stringify(Object.fromEntries(moves))};
const OPEN = ${args.page ? JSON.stringify(args.page) : 'null'};
const PROJ = ${args.project ? JSON.stringify(args.project) : 'null'};

// Page UUIDs are NOT unique across projects: importing a project keeps them, so
// openDocument(pageUuid) resolves inside whatever project happens to be open.
// This guard exists because that exact ambiguity wrote to the wrong project once.
if (PROJ) {
  let cur = await eda.dmt_Project.getCurrentProjectInfo();
  if (!cur || cur.uuid !== PROJ) {
    await eda.dmt_Project.openProject(PROJ);
    await new Promise(r => setTimeout(r, 3200));
    cur = await eda.dmt_Project.getCurrentProjectInfo();
  }
  if (!cur || cur.uuid !== PROJ) {
    return { aborted: 'project-mismatch', want: PROJ, got: cur ? cur.uuid : null, name: cur ? cur.friendlyName : null };
  }
}
if (OPEN) { await eda.dmt_EditorControl.openDocument(OPEN); await new Promise(r => setTimeout(r, 2000)); }

function snapshotNets(nl) {
  const m = {};
  for (const uid of Object.keys(nl.components || {})) {
    const pim = nl.components[uid].pinInfoMap || {};
    for (const pk of Object.keys(pim)) m[uid + '.' + pk] = pim[pk].net || '';
  }
  return m;
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

let nl = JSON.parse(await eda.sch_Netlist.getNetlist('JLCEDA'));
const before = snapshotNets(nl);

// pin count per net, to find orphans
const size = {};
for (const uid of Object.keys(nl.components || {})) {
  const pim = nl.components[uid].pinInfoMap || {};
  for (const pk of Object.keys(pim)) {
    const n = pim[pk].net || '';
    if (n) size[n] = (size[n] || 0) + 1;
  }
}
const orphans = new Set(Object.keys(size).filter(n => size[n] < 2));

const wireIds = await eda.sch_PrimitiveWire.getAllPrimitiveId();
const wires = wireIds && wireIds.length ? await eda.sch_PrimitiveWire.get(wireIds) : [];
const kill = wires.filter(w => orphans.has(w.net || '')).map(w => w.primitiveId);
if (kill.length) {
  await eda.sch_PrimitiveWire.delete(kill);
  await wait(500);
}

// move
const ids = await eda.sch_PrimitiveComponent.getAllPrimitiveId('part');
const comps = await eda.sch_PrimitiveComponent.get(ids);
const byDes = new Map(comps.map(c => [c.designator, c]));
const moved = [], missing = [], errors = [];
for (const d of Object.keys(PLAN)) {
  const c = byDes.get(d);
  if (!c) { missing.push(d); continue; }
  const p = PLAN[d];
  if (c.x === p.x && c.y === p.y) continue;
  try {
    await eda.sch_PrimitiveComponent.modify(c.primitiveId, { x: p.x, y: p.y });
    moved.push(d);
  } catch (e) { errors.push(d + ': ' + (e && e.message ? e.message : e)); }
  await wait(25);
}

let saved = null;
try { saved = await eda.sch_Document.save(); } catch (e) { saved = 'err:' + (e && e.message ? e.message : e); }
await wait(900);

nl = JSON.parse(await eda.sch_Netlist.getNetlist('JLCEDA'));
const after = snapshotNets(nl);

const broken = [];
for (const k of Object.keys(before)) {
  if (!before[k]) continue;
  if ((after[k] || '') !== before[k]) broken.push({ pin: k, before: before[k], after: after[k] || '' });
}

const partsAfter = (await eda.sch_PrimitiveComponent.getAllPrimitiveId('part')) || [];
return {
  orphanNets: [...orphans],
  wiresDeleted: kill.length,
  moved: moved.length, missing, errors, saved,
  partsBefore: comps.length, partsAfter: partsAfter.length,
  brokenCount: broken.length, brokenSample: broken.slice(0, 10)
};
`;

const res = await fetch(`http://127.0.0.1:${found.port}/execute`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code }), signal: AbortSignal.timeout(120000)
});
const payload = await res.json();
if (!payload.success) { console.error('执行失败:', payload.error || JSON.stringify(payload).slice(0, 400)); process.exit(1); }

const r = payload.result;
if (r && r.aborted) {
  console.error(`\n中止：目标工程不匹配（需要 ${r.want}，当前 ${r.got} ${r.name || ''}）`);
  process.exit(3);
}
writeFileSync(join(ROOT, 'out/apply-plan-report.json'), JSON.stringify(r, null, 2) + '\n', 'utf8');
console.log(`\n孤立网络 ${r.orphanNets.length} 个，删除残线 ${r.wiresDeleted} 根`);
console.log(`移动 ${r.moved} 个元件 · 缺失 ${r.missing.length} · 错误 ${r.errors.length}`);
console.log(`保存 ${r.saved === true ? '成功' : r.saved}`);
console.log(`元件数 ${r.partsBefore} → ${r.partsAfter}`);
if (r.brokenCount) {
  console.log(`\n原有网络变化 ${r.brokenCount} 处：`);
  for (const b of r.brokenSample) console.log(`  ${b.pin}: "${b.before}" → "${b.after}"`);
  process.exit(1);
}
console.log('校验: 原有连接全部保持');
