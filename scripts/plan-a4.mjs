#!/usr/bin/env node
// Lay a page out on A4 (1169 x 826 in 0.01-inch units).
//
// Two things are different from the A3 version:
//   1. blocks are packed by measured size instead of being given fixed
//      rectangles - on A4 a coarse rectangle wastes more than it organises;
//   2. the power block is translated as a rigid body rather than re-flowed,
//      because its internal arrangement is intentional and it is the part most
//      likely to break if rearranged.
//
// Space is reserved for text (footprintBBox includes the designator and name)
// even though the text itself is positioned after routing (D48). Reserving is a
// placement concern; positioning is not.
//
//   node scripts/plan-a4.mjs [--page page.json] [--symbols symbols.json]
//                            [--out plan.json] [--sheet 1169x826]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { footprintBBox, pinSides } from './lib/page.mjs';
import { bboxToPage } from './epro.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const args = {
  page: join(ROOT, 'out/a4-clean.json'),
  symbols: join(ROOT, 'out/symbols-ouya.json'),
  out: join(ROOT, 'out/plan.json'),
  sheet: '1169x826'
};
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i];
  if (t === '--page') args.page = process.argv[++i];
  else if (t === '--symbols') args.symbols = process.argv[++i];
  else if (t === '--out') args.out = process.argv[++i];
  else if (t === '--sheet') args.sheet = process.argv[++i];
}

const [SHEET_W, SHEET_H] = args.sheet.split('x').map(Number);
const SHEET = { w: SHEET_W, h: SHEET_H, margin: 30 };
// The A4 frame carries a title block (Drawing-Symbol_A4, showTitleBlock=true).
// Its symbol lives in the system library, so its bbox is not reachable through
// .epro - the height below is read off the rendered sheet. Nothing may go under
// it; on this page that leaves 571 units of height.
const TITLE_BLOCK_H = 215;
const FLOOR_Y = SHEET.margin + TITLE_BLOCK_H;

const GAP_COL = 16;   // vertical lane between components in a row
const GAP_ROW = 15;   // horizontal lane between rows - wires need this
const GAP_BLOCK = 10; // between blocks
const PAD = 3;
const TITLE_H = 10;

// A block is as wide as its widest row, capped here. Fixed-width columns wasted
// the sheet: a one-part block occupied a full column height. Packing measured
// widths lets a 7-part block sit beside a 1-part block in the same shelf.
const TARGET_W = 700;


const BLOCKS = [
  { id: 'A', title: '市电输入与保护', maxW: 400, members: ['J3', 'RV1', 'K1', 'Q1', 'R7', 'R19', 'D4'] },
  { id: 'B', title: '辅助电源', rigid: true, members: ['MOV', 'CX', 'CY1', 'U1', 'C1', 'C2', 'LDM', 'R8', 'L2', 'C3', 'D1', 'C4', 'U4', 'C5', 'C6'] },
  { id: 'C', title: '测量前端', members: ['L1', 'R1', 'R2', 'R3', 'R4', 'R5', 'C8', 'C9', 'D2', 'J2', 'R6', 'C10', 'D3', 'U5', 'R9', 'C11', 'C12'] },
  { id: 'D', title: '主控', members: ['U3'] },
  { id: 'E', title: '显示', members: ['U2', 'DS1', 'DS2'] },
  { id: 'F', title: '按键与指示', members: ['SW1', 'R14', 'SW2', 'R15', 'SW3', 'R16', 'SW4', 'R17', 'LED1', 'R10', 'LED2', 'R11', 'LED3', 'R12', 'LED4', 'R13'] }
];

const snap = (v) => Math.round(v / 5) * 5;

// Property text moves with its part. Without this the footprint of a moved
// component merges the new body position with the old text position and spans
// the whole sheet.
function shifted(c, nx, ny) {
  return (c.attrs || []).map((a) => ({
    ...a,
    x: Number.isFinite(a.x) ? a.x - c.x + nx : a.x,
    y: Number.isFinite(a.y) ? a.y - c.y + ny : a.y
  }));
}

function main() {
  const page = readJson(args.page);
  const sym = readJson(args.symbols).symbols;
  const by = new Map(page.components.map((c) => [c.designator, c]));

  const bodyOf = (c) => {
    const s = sym[c.symbolUuid];
    if (!s || !s.bbox) return null;
    return bboxToPage(s.bbox, { x: 0, y: 0, rotation: c.rotation || 0, mirror: !!c.mirror });
  };
  // Offset box relative to the component origin (bboxToPage with origin 0,0).
  const relOf = (c) => bodyOf(c);
  const absFootprint = (c) => {
    const s = sym[c.symbolUuid];
    if (!s || !s.bbox) return null;
    const body = bboxToPage(s.bbox, { x: c.x, y: c.y, rotation: c.rotation || 0, mirror: !!c.mirror });
    return footprintBBox({ ...c, bbox: body });
  };

  // ---- 1. size each block ---------------------------------------------------
  const sized = [];
  for (const b of BLOCKS) {
    const items = b.members.map((d) => by.get(d)).filter(Boolean);
    if (!items.length) continue;

    if (b.rigid) {
      // Translate, do not re-flow: keep the arrangement the user built.
      const fps = items.map(absFootprint).filter(Boolean);
      const x0 = Math.min(...fps.map((f) => f.x)), x1 = Math.max(...fps.map((f) => f.x + f.w));
      const y0 = Math.min(...fps.map((f) => f.y)), y1 = Math.max(...fps.map((f) => f.y + f.h));
      sized.push({
        b, rigid: true, items,
        w: (x1 - x0) + PAD * 2, h: (y1 - y0) + PAD * 2 + TITLE_H,
        inner: { x0, y0, w: x1 - x0, h: y1 - y0 }
      });
      continue;
    }

    const entry = items.map((c) => ({ c, box: relOf(c), fp: absFootprint(c) }));
    // Bigger parts first keeps rows even; ties keep declaration order so the
    // result is stable between runs.
    entry.sort((p, q) => (q.fp ? q.fp.w * q.fp.h : 0) - (p.fp ? p.fp.w * p.fp.h : 0));

    const limit = b.maxW || TARGET_W;
    const rows = [];
    let row = [], rowW = 0;
    for (const it of entry) {
      const w = it.fp ? it.fp.w : 20;
      if (row.length && rowW + GAP_COL + w > limit) { rows.push(row); row = []; rowW = 0; }
      rowW += (row.length ? GAP_COL : 0) + w;
      row.push(it);
    }
    if (row.length) rows.push(row);

    const rowSizes = rows.map((r) => ({
      w: r.reduce((t, it) => t + (it.fp ? it.fp.w : 20), 0) + GAP_COL * (r.length - 1),
      h: Math.max(...r.map((it) => (it.fp ? it.fp.h : 20)))
    }));
    sized.push({
      b, rigid: false, rows, rowSizes,
      w: Math.max(...rowSizes.map((r) => r.w)) + PAD * 2,
      h: rowSizes.reduce((t, r) => t + r.h, 0) + GAP_ROW * Math.max(0, rows.length - 1) + PAD * 2 + TITLE_H
    });
  }

  // ---- 2. first-fit decreasing -------------------------------------------
  // Plain shelf packing (only ever try the current shelf) wasted the 434 units
  // left beside a wide block because the next block in height order did not fit
  // there - while a shorter one would have. Trying every open shelf first is a
  // one-line change that removes most of that waste.
  const order = sized.map((s, i) => ({ s, i })).sort((p, q) => q.s.h - p.s.h);
  const shelfW = SHEET.w - SHEET.margin * 2;
  const shelves = [];
  for (const { s } of order) {
    let placed = null;
    for (const sh of shelves) {
      if (sh.used + s.w > shelfW) continue;
      placed = sh;
      break;
    }
    if (!placed) {
      placed = { yTop: 0, used: 0, h: 0 };
      shelves.push(placed);
    }
    s.x = SHEET.margin + placed.used;
    placed.used += s.w + GAP_BLOCK;
    placed.h = Math.max(placed.h, s.h);
    s._shelf = placed;
  }
  let cursor = SHEET.h - SHEET.margin;
  for (const sh of shelves) {
    for (const { s } of order) if (s._shelf === sh) s.yTop = cursor;
    cursor -= sh.h + GAP_BLOCK;
  }
  sized.sort((p, q) => BLOCKS.findIndex((b) => b.id === p.b.id) - BLOCKS.findIndex((b) => b.id === q.b.id));
  const maxBottom = Math.min(...sized.map((s) => s.yTop - s.h));
  const totalH = SHEET.h - SHEET.margin - maxBottom + SHEET.margin;


  // ---- 3. emit coordinates -------------------------------------------------
  const plan = { sheet: { w: SHEET.w, h: SHEET.h, name: 'A4' }, blocks: [], components: {}, fixed: [] };

  for (const s of sized) {
    if (s.rigid) {
      const dx = snap(s.x + PAD - s.inner.x0);
      const dy = snap(s.yTop - PAD - TITLE_H - s.inner.h - s.inner.y0);
      for (const c of s.items) {
        plan.components[c.designator] = {
          x: snap(c.x + dx), y: snap(c.y + dy),
          rotation: c.rotation || 0, mirror: !!c.mirror
        };
      }
    } else {
      let yTop = s.yTop - PAD - TITLE_H;
      for (let r = 0; r < s.rows.length; r++) {
        const rowH = s.rowSizes[r].h;
        const usedW = s.rowSizes[r].w;
        let x = s.x + PAD + Math.max(0, (s.w - PAD * 2 - usedW) / 2);
        for (const it of s.rows[r]) {
          const fp = it.fp;
          // Position by the footprint's edges, then convert back to the origin.
          const originX = x - (fp.x - it.c.x);
          const originY = yTop - fp.h - (fp.y - it.c.y);
          plan.components[it.c.designator] = {
            x: snap(originX), y: snap(originY),
            rotation: it.c.rotation || 0, mirror: !!it.c.mirror
          };
          x += (fp ? fp.w : 20) + GAP_COL;
        }
        yTop -= rowH + GAP_ROW;
      }
    }
    plan.blocks.push({
      id: s.b.id, title: s.b.title,
      x: snap(s.x), y: snap(s.yTop - s.h), w: snap(s.w), h: snap(s.h)
    });
  }

  // ---- 4. verify -----------------------------------------------------------
  const problems = [];
  const fs = [];
  for (const c of page.components) {
    const p = plan.components[c.designator];
    if (!p) continue;
    const s = sym[c.symbolUuid];
    if (!s || !s.bbox) continue;
    const body = bboxToPage(s.bbox, { x: p.x, y: p.y, rotation: p.rotation, mirror: p.mirror });
    const fp = footprintBBox({ ...c, x: p.x, y: p.y, attrs: shifted(c, p.x, p.y), bbox: body });
    if (!fp) continue;
    fs.push({ d: c.designator, ...fp });
    if (fp.x < SHEET.margin || fp.y < FLOOR_Y ||
        fp.x + fp.w > SHEET.w - SHEET.margin || fp.y + fp.h > SHEET.h - SHEET.margin) {
      problems.push(`出纸 ${c.designator}`);
    }
  }
  for (let i = 0; i < fs.length; i++) {
    for (let j = i + 1; j < fs.length; j++) {
      const a = fs[i], b = fs[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > 0.5 && oy > 0.5) problems.push(`重叠 ${a.d}/${b.d} ${ox.toFixed(0)}×${oy.toFixed(0)}`);
    }
  }
  const blockArea = plan.blocks.reduce((t, b) => t + b.w * b.h, 0);
  const drawable = (SHEET.w - SHEET.margin * 2) * (SHEET.h - SHEET.margin * 2);
  const contentArea = fs.reduce((t, f) => t + f.w * f.h, 0);

  writeFileSync(args.out, JSON.stringify(plan, null, 2) + '\n');

  console.log(`画布 ${SHEET.w}×${SHEET.h}（A4），可画区 ${drawable}`);
  console.log('');
  console.log('块  尺寸        位置            内容面积');
  for (const b of plan.blocks) {
    console.log(` ${b.id}  ${String(b.w + '×' + b.h).padEnd(11)} (${String(b.x).padStart(4)},${String(b.y).padStart(4)})`);
  }
  console.log('');
  console.log(`元件内容面积 ${Math.round(contentArea)}  块矩形面积 ${blockArea}  可画区 ${drawable}`);
  console.log(`块填充率 ${(blockArea / drawable * 100).toFixed(1)}%  内容/块 ${(contentArea / blockArea * 100).toFixed(1)}%`);
  console.log(`垂直占用 ${Math.round(totalH)} / 可用 ${SHEET.h - SHEET.margin - FLOOR_Y}${totalH > SHEET.h - SHEET.margin * 2 ? '  ✗ 超出' : '  ✓'}`);
  for (const s of sized) if (s.conflict) problems.push(`${s.b.id} 块${s.conflict}`);
  if (problems.length) {
    console.log('');
    for (const p of problems.slice(0, 12)) console.log('  ✗ ' + p);
    if (problems.length > 12) console.log(`  …还有 ${problems.length - 12} 条`);
  } else {
    console.log('校验: 无重叠、无出纸 ✓');
  }
  console.log(`→ ${args.out}`);
}

main();
