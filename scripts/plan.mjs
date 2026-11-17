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
const GAP_X = 60;   // a vertical lane for wires
const ROW_GAP = 70; // a horizontal lane: without it, every wire must cross a body
const PAD = 26;
const TITLE_H = 42;

// Blocks are packed by measured size, not pinned to fixed regions: pinning was
// what left a 30% empty band down the middle of the sheet last time.
const BLOCKS = [
  { id: 'A', title: '市电输入与保护', subtitle: 'J3 进线 · RV1 压敏 · K1 继电器输出',
    rect: { x: 60, y: 739, w: 440, h: 390 },
    members: ['J3', 'RV1', 'K1', 'Q1', 'R7', 'R19', 'D4'] },
  { id: 'C', title: '测量前端', subtitle: 'L1 电压互感器 · R1-R4 分压 · J2 电流输入 · U5 基准',
    rect: { x: 580, y: 739, w: 580, h: 390 },
    members: ['L1', 'R1', 'R2', 'R3', 'R4', 'R5', 'C8', 'C9', 'D2', 'J2', 'R6', 'C10', 'D3', 'U5', 'R9', 'C11', 'C12'] },
  { id: 'D', title: '主控', subtitle: 'U3 CMS8S6990',
    rect: { x: 1220, y: 739, w: 380, h: 390 },
    members: ['U3'] },
  { id: 'F', title: '按键与指示', subtitle: 'SW1-4 上拉 · LED1-4 限流',
    rect: { x: 60, y: 370, w: 620, h: 320 },
    members: ['SW1', 'R14', 'SW2', 'R15', 'SW3', 'R16', 'SW4', 'R17', 'LED1', 'R10', 'LED2', 'R11', 'LED3', 'R12', 'LED4', 'R13'] },
  { id: 'E', title: '显示', subtitle: 'U2 TM1652 · DS1/DS2',
    rect: { x: 760, y: 370, w: 420, h: 320 },
    members: ['U2', 'DS1', 'DS2'] }
];

const BLOCK_GAP = 80;
const MAX_ROW_W = 1500;

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

  // ---- fixed set: declared, never inferred ----
  // Inferring it from "pins that still have a net" drifted every time the page
  // changed (a single GND wire made twenty components 'fixed'). The power chain
  // that must not move is a decision, so it is written down here.
  const FIXED = ['MOV', 'CX', 'CY1', 'U1', 'C1', 'C2', 'LDM', 'R8', 'L2', 'C3', 'D1', 'C4', 'U4', 'C5', 'C6'];
  const fixed = current.components.filter((c) => FIXED.includes(c.designator));
  const fixedSet = new Set(fixed.map((c) => c.designator));

  const plan = {};
  for (const c of fixed) plan[c.designator] = { x: c.x, y: c.y, rotation: c.rotation || 0, mirror: !!c.mirror, fixed: true };

  const frames = [];
  const unplaced = [];

  // Space is allocated first: each block owns a rectangle. Components are then
  // laid inside it in rows, with a 70-unit horizontal lane between rows and a
  // 60-unit vertical lane between components, so wires have somewhere to run.
  for (const b of BLOCKS) {
    const items = b.members
      .map((d) => targetBy.get(d))
      .filter((c) => c && !fixedSet.has(c.designator))
      .map((c) => ({ c, box: boxOf(c) }));
    if (!items.length) continue;

    const innerW = b.rect.w - PAD * 2;
    const rows = [];
    let row = [], rowW = 0;
    for (const it of items) {
      if (row.length && rowW + GAP_X + it.box.w > innerW) { rows.push(row); row = []; rowW = 0; }
      rowW += (row.length ? GAP_X : 0) + it.box.w;
      row.push(it);
    }
    if (row.length) rows.push(row);

    const rowSizes = rows.map((r) => ({
      w: r.reduce((t, it) => t + it.box.w, 0) + GAP_X * (r.length - 1),
      h: Math.max(...r.map((it) => it.box.h))
    }));
    const needH = rowSizes.reduce((t, r) => t + r.h, 0) + ROW_GAP * Math.max(0, rowSizes.length - 1) + PAD * 2 + TITLE_H;
    if (needH > b.rect.h) console.warn(`  ! ${b.id} 需要高 ${Math.round(needH)}，矩形只有 ${b.rect.h}`);

    // stack rows from the top of the rect down, centred horizontally
    let yTop = b.rect.y + b.rect.h - PAD - TITLE_H;
    for (let r = 0; r < rows.length; r++) {
      const rowH = rowSizes[r].h;
      const offset = (innerW - rowSizes[r].w) / 2;
      let x = b.rect.x + PAD + Math.max(0, offset);
      for (const it of rows[r]) {
        plan[it.c.designator] = {
          x: snap(x - it.box.x),
          y: snap(yTop - it.box.h - it.box.y),
          rotation: it.c.rotation || 0,
          mirror: !!it.c.mirror
        };
        x += it.box.w + GAP_X;
      }
      yTop -= rowH + ROW_GAP;
    }
    frames.push({ id: b.id, title: b.title, subtitle: b.subtitle, x: b.rect.x, y: b.rect.y, w: b.rect.w, h: b.rect.h });
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

  // block rectangles must not overlap, and must not sit on the fixed strip
  const fr = frames.slice();
  for (let i = 0; i < fr.length; i++) {
    for (let j = i + 1; j < fr.length; j++) {
      const a = fr[i], b2 = fr[j];
      const ix = Math.min(a.x + a.w, b2.x + b2.w) - Math.max(a.x, b2.x);
      const iy = Math.min(a.y + a.h, b2.y + b2.h) - Math.max(a.y, b2.y);
      if (ix > 0 && iy > 0) problems.push(`块矩形重叠 ${a.id}/${b2.id} ${ix.toFixed(0)}×${iy.toFixed(0)}`);
    }
  }
  let blockArea = 0;
  for (const f of fr) {
    blockArea += f.w * f.h;
    if (f.x < SHEET.margin || f.y < SHEET.margin || f.x + f.w > SHEET.w - SHEET.margin || f.y + f.h > SHEET.h - SHEET.margin) {
      problems.push(`块越界 ${f.id}`);
    }
  }
  const drawable = (SHEET.w - SHEET.margin * 2) * (SHEET.h - SHEET.margin * 2);
  const utilisation = blockArea / drawable;
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i];
    if (a.x < SHEET.margin || a.y < SHEET.margin || a.x + a.w > SHEET.w - SHEET.margin || a.y + a.h > SHEET.h - SHEET.margin) {
      problems.push(`越界 ${a.d} @ (${a.x.toFixed(0)}, ${a.y.toFixed(0)}) ${a.w.toFixed(0)}×${a.h.toFixed(0)}`);
    }
    for (const f of frames) {
      const c2 = target.components.find((t) => t.designator === a.d);
      const bm = plan[a.d];
      const blk = BLOCKS.find((bb) => bb.id === f.id);
      if (blk && blk.members.includes(a.d) && !fixedSet.has(a.d)) {
        if (a.x < f.x || a.y < f.y || a.x + a.w > f.x + f.w || a.y + a.h > f.y + f.h) {
          problems.push(`出块 ${a.d} 在 ${f.id} 之外`);
        }
      }
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
  console.log(`纸面利用率 ${(utilisation * 100).toFixed(1)}%（块矩形面积 / 可画区域）`);
  if (problems.length) { console.log(''); for (const p of problems.slice(0, 12)) console.log('  ✗ ' + p); process.exitCode = 1; }
  else console.log('校验: 无重叠、无越界');
  console.log('→ out/plan.json');
}

main();
