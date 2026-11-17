#!/usr/bin/env node
// Draw by net label, one stub per pin. EasyEDA Pro only.
//
// This is the safe baseline. A trunk router was tried first and shorted 163 pins
// together (a trunk that passes a pin row joins every pin it crosses), so the
// rule here is: no wire is longer than one stub, and no wire may touch anything
// except its own pin. Connectivity is carried entirely by net labels, which is
// how a schematic names nets anyway.
//
// Steps: wipe wires and labels -> one stub + one label per pin -> verify the
// netlist pin by pin against the target -> save.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const PORTS = Array.from({ length: 10 }, (_, i) => 49620 + i);

const args = { page: join(ROOT, 'out/copy-placed.json'), target: join(ROOT, 'out/target.json'), commit: false, reset: false, project: null, pageUuid: null, port: null, chunk: 10 };
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i];
  if (t === '--commit') args.commit = true;
  else if (t === '--reset') args.reset = true;
  else if (t === '--project') args.project = process.argv[++i];
  else if (t === '--page-uuid') args.pageUuid = process.argv[++i];
  else if (t === '--port') args.port = Number(process.argv[++i]);
  else if (t === '--chunk') args.chunk = Number(process.argv[++i]);
}

const STUB = 15;
const FLAG_OF = { GND: 'Ground', '+5V': 'Power', '+12V': 'Power' };

const dirOf = (rot) => {
  const r = ((rot % 360) + 360) % 360;
  return r === 0 ? [1, 0] : r === 90 ? [0, 1] : r === 180 ? [-1, 0] : [0, -1];
};

const page = readJson(resolve(args.page));
const target = readJson(resolve(args.target));
const byDes = new Map(page.components.map((c) => [c.designator, c]));

const ops = [];
for (const c of target.components) {
  const live = byDes.get(c.designator);
  if (!live) continue;
  for (const p of c.pins) {
    if (!p.net) continue;
    const pin = live.pins.find((q) => String(q.num) === String(p.num));
    if (!pin) continue;
    const [ux, uy] = dirOf(pin.rotation || 0);
    const sx = pin.x + ux * STUB;
    const sy = pin.y + uy * STUB;
    if (sx !== pin.x || sy !== pin.y) ops.push({ kind: 'wire', segments: [[pin.x, pin.y, sx, sy]] });
    ops.push({ kind: 'label', net: p.net, x: sx, y: sy, rot: ux !== 0 ? 0 : 90, flag: FLAG_OF[p.net] || null });
  }
}

console.log(`引脚 ${ops.filter((o) => o.kind === 'wire').length} 个 · 标签 ${ops.filter((o) => o.kind === 'label').length} 个`);
if (!args.commit) { console.log('预演结束，加 --commit 写入（--reset 会先清空页面上的导线与标签）。'); process.exit(0); }

async function findBridge() {
  const ports = args.port ? [args.port, ...PORTS.filter((p) => p !== args.port)] : PORTS;
  for (const port of ports) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
      const j = await r.json();
      if (j && j.service === 'easyeda-bridge') return { port, health: j };
    } catch { /* closed */ }
  }
  return null;
}

const found = await findBridge();
if (!found?.health.edaConnected) { console.error('EDA 未连接。'); process.exit(2); }

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

if (args.reset) {
  const r = await run(guard + `
    let wires = 0, labels = 0;
    const wIds = (await eda.sch_PrimitiveWire.getAllPrimitiveId()) || [];
    if (wIds.length) { await eda.sch_PrimitiveWire.delete(wIds); wires = wIds.length; }
    await new Promise(r => setTimeout(r, 600));
    for (const kind of ['netflag', 'netport', 'netlabel']) {
      const ids = (await eda.sch_PrimitiveComponent.getAllPrimitiveId(kind)) || [];
      if (!ids.length) continue;
      for (let i = 0; i < ids.length; i += 20) {
        try { await eda.sch_PrimitiveComponent.delete(ids.slice(i, i + 20)); labels += Math.min(20, ids.length - i); } catch (e) { /* keep going */ }
      }
      await new Promise(r => setTimeout(r, 400));
    }
    return { wires, labels };
  `);
  if (r && r.aborted) { console.error('中止：工程不匹配'); process.exit(3); }
  console.log(`已清空：导线 ${r.wires} 根 · 标签 ${r.labels} 个`);
}

let w = 0, l = 0;
const errors = [];
for (let i = 0; i < ops.length; i += args.chunk) {
  const batch = ops.slice(i, i + args.chunk);
  const r = await run(guard + `
    const BATCH = ${JSON.stringify(batch)};
    const out = { wires: 0, labels: 0, errors: [] };
    for (const op of BATCH) {
      try {
        if (op.kind === 'wire') {
          const x = await eda.sch_PrimitiveWire.create(op.segments);
          if (x) out.wires++; else out.errors.push('wire-null');
        } else if (op.flag) {
          const x = await eda.sch_PrimitiveComponent.createNetFlag(op.flag, op.net, op.x, op.y, op.rot);
          if (x) out.labels++; else out.errors.push('flag-null');
        } else {
          const x = await eda.sch_PrimitiveComponent.createNetPort('BI', op.net, op.x, op.y, op.rot);
          if (x) out.labels++; else out.errors.push('port-null');
        }
      } catch (e) { out.errors.push(String(e && e.message ? e.message : e).slice(0, 50)); }
      await new Promise(r => setTimeout(r, 30));
    }
    return out;
  `);
  w += r.wires; l += r.labels; errors.push(...r.errors);
  process.stdout.write(`\r${i + batch.length}/${ops.length} · 线 ${w} · 标签 ${l}   `);
}
console.log('');

const v = await run(guard + `
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
if (v.aborted) { console.error('中止：工程不匹配'); process.exit(3); }

const want = {};
for (const c of target.components) for (const p of c.pins) if (p.net) want[`${c.designator}.${p.num}`] = p.net;
const bad = [];
for (const k of Object.keys(want)) if ((v.map[k] || '') !== want[k]) bad.push({ pin: k, want: want[k], got: v.map[k] || '' });

writeFileSync(join(ROOT, 'out/wire-verify.json'), JSON.stringify({ errors: errors.slice(0, 40), mismatch: bad }, null, 2) + '\n', 'utf8');
console.log(`保存 ${v.saved === true ? '成功' : v.saved}`);
if (errors.length) console.log(`创建报错 ${errors.length} 条：${errors.slice(0, 5).join(' | ')}`);
console.log(`网表比对：${Object.keys(want).length} 引脚，不一致 ${bad.length}`);
for (const b of bad.slice(0, 10)) console.log(`  ${b.pin}: 期望 ${b.want} → 实际 ${b.got || '(空)'}`);
