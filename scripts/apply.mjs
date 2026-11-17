#!/usr/bin/env node
// Write layer: turn a computed plan into EDA edits, with the netlist as gate.
//
// Every operation must survive one test: the per-pin net map is identical
// before and after. If it is not, the edit is rolled back automatically
// (design-notes D30/D11). There is no flag to skip this check on purpose -
// a write that cannot prove it preserved connectivity is not a valid write.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PORTS = Array.from({ length: 10 }, (_, i) => 49620 + i);

function parseArgs(argv) {
  const a = { file: null, port: null, page: null, grid: null, commit: false, op: 'snap-grid' };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--port') a.port = Number(argv[++i]);
    else if (t === '--page') a.page = argv[++i];
    else if (t === '--from') a.from = argv[++i];
    else if (t === '--to') a.to = argv[++i];
    else if (t === '--grid') a.grid = Number(argv[++i]);
    else if (t === '--op') a.op = argv[++i];
    else if (t === '--commit') a.commit = true;
    else if (t === '--help' || t === '-h') a.help = true;
    else if (!t.startsWith('-')) a.file = t;
  }
  return a;
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

// Collect every coordinate that carries meaning: wire vertices and the
// electrical points of net labels. Symbol pins are deliberately excluded - a
// pin that is off-grid means the component is off-grid, and moving a component
// breaks every wire attached to it, so that is a different operation.
function collectPoints(page) {
  const pts = new Map();
  const add = (x, y, why) => {
    const k = `${x}|${y}`;
    if (!pts.has(k)) pts.set(k, { x, y, why: new Set() });
    pts.get(k).why.add(why);
  };
  for (const w of page.wires) {
    for (const s of w.segments) {
      add(s[0], s[1], 'wire');
      add(s[2], s[3], 'wire');
    }
  }
  for (const l of page.labels) {
    const p = l.conn || { x: l.x, y: l.y };
    add(p.x, p.y, 'label');
  }
  return pts;
}

function buildSnapOps(page, grid) {
  const pts = collectPoints(page);
  const pinKeys = new Set();
  for (const c of page.components) {
    for (const p of c.pins || []) pinKeys.add(`${p.x}|${p.y}`);
  }
  const occupied = new Set(pts.keys());
  const ops = [];
  const skipped = { onPin: [], collision: [], already: [] };

  for (const [k, p] of pts) {
    const onGrid = p.x % grid === 0 && p.y % grid === 0;
    if (onGrid) { skipped.already.push(k); continue; }
    if (pinKeys.has(k)) { skipped.onPin.push(k); continue; }
    const tx = Math.round(p.x / grid) * grid;
    const ty = Math.round(p.y / grid) * grid;
    const target = `${tx}|${ty}`;
    if (occupied.has(target)) { skipped.collision.push(`${k} → ${target}`); continue; }
    occupied.add(target);
    ops.push({ kind: 'snap-point', from: [p.x, p.y], to: [tx, ty], why: [...p.why].join('+') });
  }
  return { ops, skipped };
}

async function findBridge(preferred) {
  const ports = preferred ? [preferred, ...PORTS.filter((p) => p !== preferred)] : PORTS;
  for (const port of ports) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
      const j = await r.json();
      if (j && j.service === 'easyeda-bridge') return { port, health: j };
    } catch { /* port closed */ }
  }
  return null;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.file) {
  console.log(`用法: node scripts/apply.mjs <page.json> [--op snap-grid] [--grid 5]
                          [--page <docUuid>] [--port 49620] [--commit]

默认是预演（dry-run），只打印将要改什么。加 --commit 才真正写入 EDA。

每个操作写完后都会逐引脚比对网表；不一致则整批回滚。没有跳过校验的开关。`);
  process.exit(args.help ? 0 : 2);
}

const page = readJson(resolve(args.file));
const grid = args.grid ?? page.grid ?? 5;
if (!Number.isFinite(grid) || grid <= 0) {
  console.error(`栅格无效: ${grid}`);
  process.exit(2);
}

if (args.op !== 'snap-grid' && args.op !== 'point') {
  console.error(`未知操作: ${args.op}（支持 snap-grid / point）`);
  process.exit(2);
}

let ops;
let skipped = { onPin: [], collision: [], already: [] };
if (args.op === 'point') {
  const parse = (s) => {
    if (!s) return null;
    const [x, y] = s.split(',').map(Number);
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
  };
  const from = parse(args.from), to = parse(args.to);
  if (!from || !to) {
    console.error('--op point 需要 --from x,y 与 --to x,y');
    process.exit(2);
  }
  ops = [{ kind: 'snap-point', from, to, why: 'explicit' }];
} else {
  const built = buildSnapOps(page, grid);
  ops = built.ops;
  skipped = built.skipped;
}

console.log(`页面 ${page.source?.project ?? '?'} / ${page.source?.page ?? '?'}   栅格 ${grid}`);
console.log(`脱离栅格的点 ${ops.length} 个${ops.length ? ':' : ''}`);
for (const o of ops.slice(0, 20)) {
  console.log(`  (${o.from[0]}, ${o.from[1]}) → (${o.to[0]}, ${o.to[1]})   [${o.why}]`);
}
if (ops.length > 20) console.log(`  … 另 ${ops.length - 20} 个`);
if (skipped.onPin.length) console.log(`跳过（落在引脚上，需移动元件）${skipped.onPin.length} 个`);
if (skipped.collision.length) console.log(`跳过（目标点已被占用，合并会短路）${skipped.collision.length} 个`);
for (const s of skipped.collision.slice(0, 5)) console.log(`  ${s}`);

if (!ops.length) {
  console.log('\n无需改动。');
  process.exit(0);
}
if (!args.commit) {
  console.log('\n预演结束。加 --commit 写入 EDA。');
  process.exit(0);
}

const found = await findBridge(args.port);
if (!found) {
  console.error('\n找不到 bridge（49620-49629 均无响应）。');
  process.exit(2);
}
if (!found.health.edaConnected) {
  console.error(`\nbridge 在 ${found.port}，但 EDA 未连接。请在 EasyEDA 中重新加载 run-api-gateway 扩展。`);
  process.exit(2);
}

let code = readFileSync(join(HERE, 'eda/apply-ops.js'), 'utf8')
  .replaceAll('__OPS__', JSON.stringify(ops))
  .replaceAll('__GRID__', String(grid));
if (args.page) code = `await eda.dmt_EditorControl.openDocument('${args.page}');\n` + code;

const res = await fetch(`http://127.0.0.1:${found.port}/execute`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code }),
  signal: AbortSignal.timeout(120000)
});
const payload = await res.json();

if (!payload.success) {
  console.error('\n执行失败:', payload.error || JSON.stringify(payload).slice(0, 400));
  console.error('未确认写入，建议在 EDA 里检查该页。');
  process.exit(1);
}

const r = payload.result;
writeFileSync(join(ROOT, 'out/apply-report.json'), JSON.stringify(r, null, 2) + '\n', 'utf8');

console.log(`\n写入: 重建导线 ${r.wiresRebuilt} 根（先删后建，不原地改几何）· 移动标签 ${r.labelsMoved} 个`);
if (r.errors && r.errors.length) for (const e of r.errors.slice(0, 5)) console.log(`  错误 ${e}`);

if (r.netlistChanged === 0) {
  console.log(`网表校验: 通过（逐引脚一致）`);
  console.log(`\n改动已生效。重跑 lint 确认：node scripts/lint.mjs ${args.file}`);
  process.exit(0);
}

console.log(`网表校验: 失败，${r.netlistChanged} 个引脚网络变化`);
for (const c of r.changedSample) console.log(`  ${c.pin}: "${c.before}" → "${c.after}"`);
if (r.rolledBack) {
  console.log(`已回滚。回滚后残留差异: ${r.residualAfterRollback}`);
  for (const c of r.residualSample) console.log(`  ${c.pin}: "${c.before}" → "${c.after}"`);
}
process.exit(1);
