#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { segmentCrossesRect } from './lib/geometry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const args = { file: null, out: null, emitPage: null, constants: null, verbose: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out') args.out = argv[++i];
  else if (a === '--emit-page') args.emitPage = argv[++i];
  else if (a === '--constants') args.constants = argv[++i];
  else if (a === '-v') args.verbose = true;
  else if (a === '--help' || a === '-h') args.help = true;
  else if (!a.startsWith('-')) args.file = a;
}

if (args.help || !args.file) {
  console.log(`用法: sch-layout <design.json> [--out plan.json] [--emit-page page.json] [--constants rules/constants.json]

输入是"抽象盒模型"网表（不依赖具体符号库）:
{
  "design": "my-board",
  "components": [
    { "id": "U1", "ref": "U1", "kind": "ic",
      "leftPins": 2, "rightPins": 3, "topPins": 1, "bottomPins": 1 }
  ],
  "nets": [
    { "name": "VCC_3V3", "pins": ["U1.1", "C1.1"] },
    { "name": "SPI1_MOSI", "pins": ["U1.3", "J1.2"] }
  ]
}

输出布局计划（栅格单位）。--emit-page 额外生成可被 sch-lint 直接检查的合成页面。
注意: 合成页面用于自检，不写入 EDA；真正落图由 adapter 用真实符号坐标完成。`);
  process.exit(args.help ? 0 : 2);
}

const C = JSON.parse(readFileSync(args.constants ? resolve(args.constants) : join(ROOT, 'rules/constants.json'), 'utf8'));
const design = JSON.parse(readFileSync(args.file, 'utf8'));

const GRID = C.grid;
const snap = (v) => Math.round(v / GRID) * GRID;
const BOX = { w: 30, h: 40 };

function pinSlots(c) {
  const slots = [];
  const L = c.leftPins || 0, R = c.rightPins || 0, T = c.topPins || 0, B = c.bottomPins || 0;
  const n = L + R + T + B;
  if (!n) return slots;
  for (let i = 0; i < L; i++) slots.push({ num: String(slots.length + 1), side: 'left', ord: i, sideCount: L });
  for (let i = 0; i < R; i++) slots.push({ num: String(slots.length + 1), side: 'right', ord: i, sideCount: R });
  for (let i = 0; i < T; i++) slots.push({ num: String(slots.length + 1), side: 'top', ord: i, sideCount: T });
  for (let i = 0; i < B; i++) slots.push({ num: String(slots.length + 1), side: 'bottom', ord: i, sideCount: B });
  return slots;
}

// Expand shorthand pin counts into an explicit pin table.
for (const c of design.components) {
  c.pins = c.pins && c.pins.length ? c.pins : pinSlots(c);
  c.byNum = new Map(c.pins.map(p => [p.num, p]));
}

const POWER_RE = /(^|[_\-\s])(GND|AGND|DGND|PGND|VSS|VCC|VDD|VBUS|VEE)([_\-\s]|$)/i;
function isGlobalNet(net) {
  if ((net.pins?.length || 0) > 4) return true;
  return POWER_RE.test(net.name) || /^[+\-]\d/.test(net.name);
}

// ---- connectivity (power/ground nets excluded: they must not drive signal flow) ----
const compById = new Map(design.components.map(c => [c.id, c]));
const adj = new Map(design.components.map(c => [c.id, new Set()]));
const netOfPin = new Map();
for (const net of design.nets) {
  const owners = new Set();
  for (const pin of net.pins) {
    const [ref, num] = splitPin(pin);
    netOfPin.set(`${ref}.${num}`, net.name);
    if (compById.has(ref)) owners.add(ref);
  }
  if (isGlobalNet(net)) continue;
  for (const a of owners) for (const b of owners) if (a !== b) {
    adj.get(a)?.add(b);
    adj.get(b)?.add(a);
  }
}

function splitPin(s) {
  const i = s.lastIndexOf('.');
  return i < 0 ? [s, '1'] : [s.slice(0, i), s.slice(i + 1)];
}

// ---- layering: BFS from the highest-degree component, i.e. the hub ----
const order = [...design.components].sort((a, b) => (adj.get(b.id)?.size ?? 0) - (adj.get(a.id)?.size ?? 0));
const root = order[0]?.id;
const layer = new Map();
if (root) {
  layer.set(root, 0);
  const q = [root];
  while (q.length) {
    const cur = q.shift();
    for (const nb of adj.get(cur) || []) {
      if (!layer.has(nb)) { layer.set(nb, layer.get(cur) + 1); q.push(nb); }
    }
  }
}
let maxLayer = 0;
for (const v of layer.values()) maxLayer = Math.max(maxLayer, v);
for (const c of design.components) if (!layer.has(c.id)) layer.set(c.id, ++maxLayer);

// ---- order within layer: barycenter of already-placed neighbours ----
const layers = new Map();
for (const c of design.components) {
  const l = layer.get(c.id);
  if (!layers.has(l)) layers.set(l, []);
  layers.get(l).push(c);
}
const yIndex = new Map();
const colWidth = snap(BOX.w + C.spacing.blockGap);
for (const l of [...layers.keys()].sort((a, b) => a - b)) {
  const items = layers.get(l);
  items.sort((a, b) => {
    const bary = (c) => {
      const ys = [...(adj.get(c.id) || [])].map(n => yIndex.get(n)).filter(v => v !== undefined);
      return ys.length ? ys.reduce((s, v) => s + v, 0) / ys.length : 0;
    };
    return bary(a) - bary(b);
  });
  items.forEach((c, i) => yIndex.set(c.id, i));
}

// ---- place ----
const placed = new Map();
for (const l of [...layers.keys()].sort((a, b) => a - b)) {
  for (const c of layers.get(l)) {
    const x = snap(40 + l * colWidth);
    const y = snap(40 + (yIndex.get(c.id) || 0) * (BOX.h + C.spacing.componentMin));
    placed.set(c.id, { x, y, w: BOX.w, h: BOX.h, layer: l });
  }
}

function pinPoint(comp, pin) {
  const p = placed.get(comp.id);
  const n = Math.max(pin.sideCount, 1);
  const t = (pin.ord + 1) / (n + 1);
  switch (pin.side) {
    case 'left': return [p.x, snap(p.y + p.h * t)];
    case 'right': return [snap(p.x + p.w), snap(p.y + p.h * t)];
    case 'top': return [snap(p.x + p.w * t), snap(p.y + p.h)];
    default: return [snap(p.x + p.w * t), p.y];
  }
}

for (const c of design.components) {
  c.pinPoints = c.pins.map(pin => ({ ...pin, point: pinPoint(c, pin) }));
}

// ---- route ----
const wires = [];
const labels = [];
let wid = 0, lid = 0;

for (const net of design.nets) {
  const ends = net.pins.map(pin => {
    const [ref, num] = splitPin(pin);
    const c = compById.get(ref);
    if (!c) return null;
    const pp = c.pinPoints.find(q => q.num === num);
    return pp ? { ref, num, point: pp.point, compId: c.id, side: pp.side } : null;
  }).filter(Boolean);

  if (ends.length < 2) continue;

  const ls = ends.map(e => placed.get(e.compId).layer);
  const hop = Math.max(...ls) - Math.min(...ls);
  const useLabels = isGlobalNet(net) || ends.length > 3 || (C.routing.preferNetLabelAcrossBlocks && hop >= 2);

  if (useLabels) {
    for (const e of ends) {
      const stub = stubEnd(e.point, e.side);
      wires.push({ id: `w${++wid}`, net: net.name, points: [e.point, stub] });
      labels.push({
        id: `l${++lid}`, text: net.name, x: stub[0], y: stub[1],
        rotation: 0,
        align: e.side === 'left' ? 'end' : e.side === 'right' ? 'start' : 'middle',
        anchor: 'wire-end'
      });
    }
    continue;
  }

  for (let i = 1; i < ends.length; i++) {
    const a = ends[i - 1].point, b = ends[i].point;
    wires.push({ id: `w${++wid}`, net: net.name, points: routeL(a, b, ends[i - 1].compId, ends[i].compId) });
  }
}

// Two-segment Manhattan route, choosing the elbow that avoids crossing component bodies.
function routeL(a, b, ownerA, ownerB) {
  if (a[0] === b[0] || a[1] === b[1]) return [a, b];
  const cands = [
    [a, [b[0], a[1]], b],
    [a, [a[0], b[1]], b]
  ];
  let best = cands[0], bestScore = Infinity;
  for (const pts of cands) {
    let score = 0;
    for (let k = 1; k < pts.length; k++) {
      for (const c of design.components) {
        if (c.id === ownerA || c.id === ownerB) continue;
        const p = placed.get(c.id);
        if (segmentCrossesRect(pts[k - 1], pts[k], { x: p.x, y: p.y, w: p.w, h: p.h }, GRID, GRID)) score += 1;
      }
    }
    if (score < bestScore) { bestScore = score; best = pts; }
  }
  return dedupe(best);
}

function stubEnd(p, side) {
  const L = C.spacing.pinStubLength;
  return offset(p, side, L);
}

function offset(p, side, L) {
  switch (side) {
    case 'left': return [p[0] - L, p[1]];
    case 'right': return [p[0] + L, p[1]];
    case 'top': return [p[0], p[1] + L];
    default: return [p[0], p[1] - L];
  }
}

function dedupe(pts) {
  const out = [];
  for (const p of pts) {
    if (!out.length || out[out.length - 1][0] !== p[0] || out[out.length - 1][1] !== p[1]) out.push(p);
  }
  return out.length >= 2 ? out : [pts[0], pts[1]];
}

const plan = {
  schemaVersion: '0.1.0',
  skillVersion: C.version,
  design: design.design || null,
  unit: C.unit,
  grid: GRID,
  engine: 'naive-layered-v0',
  components: design.components.map(c => ({
    id: c.id, ref: c.ref || c.id, kind: c.kind || 'generic',
    x: placed.get(c.id).x, y: placed.get(c.id).y,
    w: BOX.w, h: BOX.h, layer: placed.get(c.id).layer,
    pins: c.pinPoints.map(p => ({ num: p.num, side: p.side, x: p.point[0], y: p.point[1] }))
  })),
  wires,
  labels,
  notes: [
    '引擎为 naive-layered-v0：按连通性分层，非最终质量。',
    '真实落图需要 adapter 用符号库的真实引脚坐标替换这里的外框估算。'
  ]
};

const outPath = args.out || join(ROOT, 'out/plan.json');
writeFileSync(outPath, JSON.stringify(plan, null, 2) + '\n', 'utf8');
console.log(`布局计划 → ${outPath}`);
console.log(`  ${plan.components.length} 元件 / ${plan.wires.length} 导线 / ${plan.labels.length} 标签（跨层连接用网络标签，不用长导线）`);
console.log(`  分层 ${[...layers.keys()].sort((a,b)=>a-b).map(l => `L${l}:${layers.get(l).length}`).join('  ')}`);

if (args.emitPage) {
  const page = {
    schemaVersion: '0.1.0',
    unit: C.unit,
    grid: GRID,
    source: { platform: 'layout-plan', project: plan.design || '', page: 'synthetic', synthetic: true },
    components: plan.components.map(c => ({
      id: c.id, designator: c.ref,
      x: c.x, y: c.y, rotation: 0, mirror: false,
      bbox: { x: c.x, y: c.y, w: c.w, h: c.h },
      pins: c.pins.map(p => ({ num: p.num, name: '', x: p.x, y: p.y }))
    })),
    wires: plan.wires,
    labels: plan.labels.map(l => ({ id: l.id, text: l.text, x: l.x, y: l.y, rotation: l.rotation, align: l.align })),
    texts: [],
    notes: ['合成页面，仅用于自检，不代表真实符号几何。']
  };
  writeFileSync(args.emitPage, JSON.stringify(page, null, 2) + '\n', 'utf8');
  console.log(`合成页面 → ${args.emitPage}（可交给 sch-lint 检查）`);
}
