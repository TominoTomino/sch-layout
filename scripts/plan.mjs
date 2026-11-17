#!/usr/bin/env node
// Placement planner: target netlist -> concrete component coordinates.
//
// Scope: PLACEMENT ONLY. No wires. Routing is a separate stage because every
// wire-geometry primitive we have is unsafe (design-notes D30/D31/D35).
//
// Two inputs decide the shape of the result:
//
//   1. The partition. Connectivity clustering is useless here - 44 of 59 parts
//      land in one blob because almost everything shares PT_OUT/VBIAS/RLY_DRV.
//      The blocks below follow the circuit's power flow instead, which is what
//      a reader actually needs.
//   2. The fixed set. Components that still carry a real connection (a net with
//      >=2 pins) are power parts the user deliberately kept. They stay exactly
//      where they are; everything else is arranged around them.
//
// Single-pin nets are ignored: they are orphan stubs left over from deletion,
// not connections (R14.2=$1N1111, L1.2=$1N1192 and friends).

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bboxToPage } from './epro.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const GRID = 5;
const snap = (v) => Math.round(v / GRID) * GRID;

const SHEET = { w: 1654, h: 1169, margin: 40 };
const GAP_X = 45;
const ROW_GAP = 28;
const PAD = 26;
const TITLE_H = 42;

// region = where a block may grow, anchored top-left (sheet y points up)
const BLOCKS = [
  {
    id: 'A',
    title: '市电输入与保护',
    subtitle: 'J3 进线 · RV1 压敏 · K1 继电器输出',
    region: { x: 1130, top: 560, maxW: 470 },
    members: ['J3', 'RV1', 'K1', 'Q1', 'R7', 'R19', 'D4']
  },
  {
    id: 'C',
    title: '测量前端',
    subtitle: 'L1 电压互感器 · R1-R4 分压 · J2 电流输入 · U5 基准',
    region: { x: 620, top: 1120, maxW: 470 },
    members: ['L1', 'R1', 'R2', 'R3', 'R4', 'R5', 'C8', 'C9', 'D2', 'J2', 'R6', 'C10', 'D3', 'U5', 'R9', 'C11', 'C12']
  },
  {
    id: 'D',
    title: '主控',
    subtitle: 'U3 CMS8S6990',
    region: { x: 1130, top: 1120, maxW: 470 },
    members: ['U3']
  },
  {
    id: 'E',
    title: '显示',
    subtitle: 'U2 TM1652 · DS1/DS2',
    region: { x: 620, top: 640, maxW: 470 },
    members: ['U2', 'DS1', 'DS2']
  },
  {
    id: 'F',
    title: '按键与指示',
    subtitle: 'SW1-4 上拉 · LED1-4 限流',
    region: { x: 60, top: 560, maxW: 520 },
    members: ['SW1', 'R14', 'SW2', 'R15', 'SW3', 'R16', 'SW4', 'R17', 'LED1', 'R10', 'LED2', 'R11', 'LED3', 'R12', 'LED4', 'R13']
  }
];

function main() {
  const target = readJson(join(ROOT, 'out/target.json'));
  const current = readJson(join(ROOT, 'out/work-copy.json'));
  const sym = readJson(join(ROOT, 'out/symbols-ouya.json')).symbols;

  const targetBy = new Map(target.components.map((c) => [c.designator, c]));

  const boxOf = (c) => {
    const s = sym[c.symbolUuid];
    if (!s || !s.bbox) return { x: -10, y: -10, w: 20, h: 20 };
    return bboxToPage(s.bbox, { x: 0, y: 0, rotation: c.rotation || 0, mirror: !!c.mirror });
  };

  // ---- fixed set ----
  const netCount = {};
  for (const c of current.components) for (const p of c.pins) if (p.net) netCount[p.net] = (netCount[p.net] || 0) + 1;
  const realNets = new Set(Object.entries(netCount).filter(([, n]) => n >= 2).map(([n]) => n));
  const fixed = current.components.filter((c) => c.pins.some((p) => realNets.has(p.net)));
  const fixedSet = new Set(fixed.map((c) => c.designator));

  const plan = {};
  for (const c of fixed) plan[c.designator] = { x: c.x, y: c.y, rotation: c.rotation || 0, mirror: !!c.mirror, fixed: true };

  const frames = [];
  const unplaced = [];
  for (const b of BLOCKS) {
    const items = b.members
      .map((d) => targetBy.get(d))
      .filter((c) => c && !fixedSet.has(c.designator))
      .map((c) => ({ c, box: boxOf(c) }));
    if (!items.length) continue;

    const rows = [];
    let row = [];
    let rowW = 0;
    for (const it of items) {
      if (row.length && rowW + GAP_X + it.box.w > b.region.maxW) { rows.push(row); row = []; rowW = 0; }
      rowW += (row.length ? GAP_X : 0) + it.box.w;
      row.push(it);
    }
    if (row.length) rows.push(row);

    let yTop = b.region.top - TITLE_H;
    let maxRight = b.region.x + PAD;
    for (const r of rows) {
      const rowH = Math.max(...r.map((it) => it.box.h));
      let x = b.region.x + PAD;
      for (const it of r) {
        const ox = snap(x - it.box.x);
        const oy = snap(yTop - it.box.h - it.box.y);
        plan[it.c.designator] = { x: ox, y: oy, rotation: it.c.rotation || 0, mirror: !!it.c.mirror };
        x += it.box.w + GAP_X;
        maxRight = Math.max(maxRight, x - GAP_X);
      }
      yTop -= rowH + ROW_GAP;
    }
    const bottom = yTop + ROW_GAP - PAD;
    frames.push({
      id: b.id, title: b.title, subtitle: b.subtitle,
      x: b.region.x, y: bottom,
      w: maxRight - b.region.x + PAD,
      h: b.region.top - bottom
    });
  }

  // ---- verify ----
  const boxes = [];
  for (const c of target.components) {
    const p = plan[c.designator];
    if (!p) { unplaced.push(c.designator); continue; }
    const bx = boxOf(c);
    boxes.push({ d: c.designator, x: p.x + bx.x, y: p.y + bx.y, w: bx.w, h: bx.h });
  }
  const problems = [];
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i];
    if (a.x < SHEET.margin || a.y < SHEET.margin || a.x + a.w > SHEET.w - SHEET.margin || a.y + a.h > SHEET.h - SHEET.margin) {
      problems.push(`越界 ${a.d} @ (${a.x.toFixed(0)}, ${a.y.toFixed(0)}) ${a.w.toFixed(0)}×${a.h.toFixed(0)}`);
    }
    for (let j = i + 1; j < boxes.length; j++) {
      const b2 = boxes[j];
      const ix = Math.min(a.x + a.w, b2.x + b2.w) - Math.max(a.x, b2.x);
      const iy = Math.min(a.y + a.h, b2.y + b2.h) - Math.max(a.y, b2.y);
      if (ix > 0.5 && iy > 0.5) problems.push(`重叠 ${a.d}/${b2.d} ${ix.toFixed(1)}×${iy.toFixed(1)}`);
    }
  }

  const out = { grid: GRID, sheet: SHEET, blocks: frames, fixed: [...fixedSet], components: plan, problems };
  writeFileSync(join(ROOT, 'out/plan.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');

  console.log(`固定 ${fixedSet.size} 个 · 重排 ${Object.keys(plan).length - fixedSet.size} 个 · 未落位 ${unplaced.length}`);
  for (const f of frames) console.log(`  ${f.id} ${f.title.padEnd(8)} ${String(Math.round(f.w)).padStart(4)}×${String(Math.round(f.h)).padStart(4)}  @ (${Math.round(f.x)}, ${Math.round(f.y)})`);
  if (unplaced.length) console.log('  未落位: ' + unplaced.join(' '));
  if (problems.length) { console.log(''); for (const p of problems.slice(0, 12)) console.log('  ✗ ' + p); process.exitCode = 1; }
  else console.log('校验: 无重叠、无越界');
  console.log('→ out/plan.json');
}

main();
