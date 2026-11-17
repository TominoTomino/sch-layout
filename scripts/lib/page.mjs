import { readFileSync } from 'node:fs';
import { bboxOfRects, ptEq } from './geometry.mjs';

export const SCHEMA_VERSION = '0.2.0';

export function loadPage(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const page = normalizePage(raw);
  const issues = validatePage(page);
  return { page, issues };
}

function normalizePage(raw) {
  const page = {
    schemaVersion: raw.schemaVersion || 'unknown',
    unit: raw.unit || '0.01in',
    grid: raw.grid ?? null,
    source: raw.source || {},
    components: raw.components || [],
    wires: raw.wires || [],
    labels: raw.labels || [],
    texts: raw.texts || []
  };

  for (const c of page.components) {
    c.pins = c.pins || [];
    c.rotation = c.rotation ?? 0;
    if (!c.bbox) c.bbox = deriveBBoxFromPins(c);
  }
  for (const w of page.wires) {
    if (!w.segments && w.points) w.segments = pointsToSegments(w.points);
    w.segments = w.segments || [];
  }
  return page;
}

function pointsToSegments(points) {
  const out = [];
  for (let i = 1; i < points.length; i++) {
    out.push([points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]]);
  }
  return out;
}

// Symbol body estimate from the pin cloud. Pins extend inward from their
// connection point, so the pin cloud is already the outer envelope — no padding.
// Real symbol outlines are not exposed by the API (design-notes D8).
function deriveBBoxFromPins(c) {
  if (!c.pins.length) return { x: c.x, y: c.y, w: 0, h: 0 };
  const xs = c.pins.map(p => p.x), ys = c.pins.map(p => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function validatePage(page) {
  const issues = [];
  if (page.schemaVersion !== SCHEMA_VERSION) {
    issues.push({ level: 'warn', code: 'schema-version', msg: `页面 schemaVersion=${page.schemaVersion}，本工具为 ${SCHEMA_VERSION}` });
  }
  if (!page.components.length) {
    issues.push({ level: 'error', code: 'empty', msg: '页面没有任何元件，无法分析' });
  }
  const noPins = page.components.filter(c => !c.pins || !c.pins.length).length;
  if (noPins) {
    issues.push({ level: 'warn', code: 'pins-missing', msg: `${noPins} 个元件缺少引脚坐标，dangling-wire 精度会下降` });
  }
  if (!page.labels.length) {
    issues.push({ level: 'warn', code: 'labels-missing', msg: '页面没有网络标识/端口数据，标签相关检查会被跳过' });
  }
  return issues;
}

export function capabilities(page) {
  const pins = page.components.flatMap(c => c.pins || []);
  return {
    pins: pins.length > 0,
    pinNet: pins.some(p => p.net !== undefined && p.net !== null),
    labels: page.labels.length > 0,
    components: page.components.length > 0,
    wires: page.wires.some(w => (w.segments || []).length)
  };
}

export function indexPins(page) {
  const all = [];
  for (const c of page.components) {
    for (const p of c.pins || []) {
      all.push({
        compId: c.id,
        designator: c.designator,
        pinNum: p.num,
        pinName: p.name,
        point: [p.x, p.y],
        noConnected: !!p.noConnected
      });
    }
  }
  return all;
}

export function wireSegments(page) {
  const segs = [];
  for (const w of page.wires) {
    (w.segments || []).forEach((s, i) => {
      segs.push({ wireId: w.id, net: w.net || null, index: i, a: [s[0], s[1]], b: [s[2], s[3]] });
    });
  }
  return segs;
}

export function pointKey(p) {
  return `${Math.round(p[0] * 1000)}|${Math.round(p[1] * 1000)}`;
}

// One node per distinct coordinate, holding everything that touches it.
export function buildNodeIndex(page) {
  const nodes = new Map();
  const ensure = (p) => {
    const k = pointKey(p);
    if (!nodes.has(k)) nodes.set(k, { point: p, segments: [], pins: [], labels: [] });
    return nodes.get(k);
  };
  for (const pin of indexPins(page)) ensure(pin.point).pins.push(pin);
  for (const l of page.labels) ensure(labelAnchor(l)).labels.push({ id: l.id, text: l.text, kind: l.kind });
  for (const s of wireSegments(page)) {
    ensure(s.a).segments.push(s);
    if (pointKey(s.a) !== pointKey(s.b)) ensure(s.b).segments.push(s);
  }
  return nodes;
}

// Corners per wire: nodes where exactly two non-collinear segments meet.
// Junctions (3+) are counted separately; they are branch points, not bends.
export function wireCorners(segments) {
  const at = new Map();
  const dir = (from, to) => {
    if (Math.abs(from[1] - to[1]) < 1e-6) return to[0] > from[0] ? 'R' : 'L';
    if (Math.abs(from[0] - to[0]) < 1e-6) return to[1] > from[1] ? 'U' : 'D';
    return 'X';
  };
  const push = (p, d) => {
    const k = pointKey(p);
    if (!at.has(k)) at.set(k, []);
    at.get(k).push(d);
  };
  for (const s of segments) {
    if (pointKey(s.a) === pointKey(s.b)) continue;
    push(s.a, dir(s.a, s.b));
    push(s.b, dir(s.b, s.a));
  }
  const opposite = (a, b) =>
    (a === 'R' && b === 'L') || (a === 'L' && b === 'R') ||
    (a === 'U' && b === 'D') || (a === 'D' && b === 'U');
  let corners = 0, junctions = 0;
  for (const dirs of at.values()) {
    if (dirs.length === 2) {
      if (!opposite(dirs[0], dirs[1])) corners++;
    } else if (dirs.length > 2) {
      junctions++;
    }
  }
  return { corners, junctions };
}

export function contentBBox(page) {
  const rects = page.components.map(c => c.bbox).filter(Boolean);
  const labelRects = page.labels.map(labelBBox);
  return bboxOfRects([...rects, ...labelRects]);
}

// Where a label actually touches the net. netflag/netport are symbols, so their
// origin is the graphic anchor and the electrical point is the symbol pin.
export function labelAnchor(l) {
  return l.conn ? [l.conn.x, l.conn.y] : [l.x, l.y];
}

export function labelBBox(l) {
  const a = labelAnchor(l);
  if (l.conn) {
    return { x: a[0] - 6, y: a[1] - 6, w: 12, h: 12 };
  }
  const text = l.text || '';
  let textW = 0;
  for (const ch of text) textW += /[\u4e00-\u9fff]/.test(ch) ? 12 : 7;
  const textH = 12;
  const rot = ((l.rotation ?? 0) % 360 + 360) % 360;
  const vertical = rot === 90 || rot === 270;
  const w = vertical ? textH : textW;
  const h = vertical ? textW : textH;
  return { x: a[0] - w / 2, y: a[1] - h / 2, w, h };
}

export function samePoint(a, b) {
  return ptEq(a, b);
}

// A run of >=3 identical symbols sharing one axis with constant pitch is a
// deliberate array (e.g. seven ESD diodes feeding one bus), not clutter.
// Only these members are eligible for the info-level overlap treatment (D27).
export function detectArrays(page) {
  const bySym = new Map();
  for (const c of page.components) {
    if (!c.symbolUuid) continue;
    if (!bySym.has(c.symbolUuid)) bySym.set(c.symbolUuid, []);
    bySym.get(c.symbolUuid).push(c);
  }
  const inArray = new Set();
  for (const list of bySym.values()) {
    if (list.length < 3) continue;
    for (const axis of ['x', 'y']) {
      const rows = new Map();
      for (const c of list) {
        const key = axis === 'x' ? Math.round(c.y) : Math.round(c.x);
        if (!rows.has(key)) rows.set(key, []);
        rows.get(key).push(c);
      }
      for (const row of rows.values()) {
        if (row.length < 3) continue;
        const sorted = [...row].sort((a, b) => (axis === 'x' ? a.x - b.x : a.y - b.y));
        const gaps = [];
        for (let i = 1; i < sorted.length; i++) {
          gaps.push(axis === 'x' ? sorted[i].x - sorted[i - 1].x : sorted[i].y - sorted[i - 1].y);
        }
        const constant = gaps.length > 0 && gaps.every(g => g === gaps[0]) && gaps[0] > 0;
        if (constant) for (const c of sorted) inArray.add(c.id);
      }
    }
  }
  return inArray;
}

// ---- property text -------------------------------------------------------
// The same glyph-width estimate used for net labels, applied to component
// property text. Latin ~7 units per char, CJK ~12, line height 12 at the default
// font size; these are the same numbers the label checker uses, so the two
// agree instead of drifting apart.
export function textExtent(text, fontSize) {
  const scale = fontSize ? Math.min(2, Math.max(0.6, fontSize / 12)) : 1;
  let w = 0;
  for (const ch of String(text || '')) {
    w += /[\u4e00-\u9fff]/.test(ch) ? 12 : 7;
  }
  return { w: w * scale, h: 12 * scale };
}

// Visible property text of one component, in page coordinates. `align` is not
// exposed by the API (it came back null), so the anchor is treated as the
// left edge - the conservative choice: it may over-estimate on the right, but
// never under-estimates where the glyphs actually fall.
export function attrBBox(attr) {
  if (!attr || attr.visible === false) return null;
  const { w, h } = textExtent(attr.value, attr.fontSize);
  if (!w) return null;
  const rot = ((attr.rotation ?? 0) % 360 + 360) % 360;
  const vertical = rot === 90 || rot === 270;
  const bw = vertical ? h : w;
  const bh = vertical ? w : h;
  return { x: attr.x, y: attr.y - bh / 2, w: bw, h: bh };
}

// Everything a component visually occupies: symbol body plus its visible text.
export function footprintBBox(c) {
  // Never silently collapse to the text box alone: a missing bbox means the
  // caller skipped loadPage(), and returning a 14x12 rect there would make a
  // whole component look empty (and every collision check pass).
  let box = c.bbox ? { ...c.bbox } : (c.pins && c.pins.length ? deriveBBoxFromPins(c) : null);
  for (const a of c.attrs || []) {
    const t = attrBBox(a);
    if (!t) continue;
    if (!box) { box = { ...t }; continue; }
    const x0 = Math.min(box.x, t.x), y0 = Math.min(box.y, t.y);
    const x1 = Math.max(box.x + box.w, t.x + t.w);
    const y1 = Math.max(box.y + box.h, t.y + t.h);
    box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  return box;
}

// ---- designator placement ------------------------------------------------
// A designator belongs on a side of the symbol that has neither pins nor a
// neighbour. Both facts are computable, which is why this is a rule and not a
// prompt: "put the reference somewhere sensible" cannot be executed, but
// "skip sides with pins, then sides with neighbours" can.
//
// Pin rotation points outward (D18), so rotation encodes the side the pin
// leaves from: 0 = right, 90 = top, 180 = left, 270 = bottom.
export function pinSides(c) {
  const sides = new Set();
  for (const p of c.pins || []) {
    const r = ((p.rotation ?? 0) % 360 + 360) % 360;
    if (r === 0) sides.add('right');
    else if (r === 90) sides.add('top');
    else if (r === 180) sides.add('left');
    else if (r === 270) sides.add('bottom');
  }
  return sides;
}

// Candidate text box for one side. `gap` is clearance from the body, `h` the
// line height; the box is centred along the side it sits on.
export function sideSlot(box, side, textW, opts = {}) {
  const gap = opts.gap ?? 5;
  const h = opts.h ?? 12;
  if (side === 'right') return { x: box.x + box.w + gap, y: box.y + box.h / 2 - h / 2, w: textW, h };
  if (side === 'left') return { x: box.x - gap - textW, y: box.y + box.h / 2 - h / 2, w: textW, h };
  if (side === 'top') return { x: box.x + box.w / 2 - textW / 2, y: box.y + box.h + gap, w: textW, h };
  return { x: box.x + box.w / 2 - textW / 2, y: box.y - gap - h, w: textW, h };
}

const rectHit = (a, b) => !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
const inside = (a, r) => a.x >= r.x && a.y >= r.y && a.x + a.w <= r.x + r.w && a.y + a.h <= r.y + r.h;

// Decide where a designator goes. Returns { side, rect } or null when no side
// is free - in which case the caller should grow the clearance, not guess.
// `prefer` lets a layout express symmetry: passing ['left'] for one member of a
// pair and ['right'] for its mirror gives outward-facing labels.
export function chooseDesignatorSide(c, box, textW, neighbours = [], rect = null, prefer = null) {
  const blocked = pinSides(c);
  const order = prefer || ['bottom', 'top', 'right', 'left'];
  const fallback = [];
  for (const side of order) {
    const slot = sideSlot(box, side, textW);
    if (blocked.has(side)) continue;
    if (rect && !inside(slot, rect)) continue;
    if (neighbours.some((n) => n && rectHit(slot, n))) { fallback.push(side); continue; }
    return { side, rect: slot, clean: true };
  }
  // Nothing clean: return the first geometrically possible side so the caller
  // can report it instead of silently leaving the label where it was.
  for (const side of order) {
    if (blocked.has(side)) continue;
    const slot = sideSlot(box, side, textW);
    if (rect && !inside(slot, rect)) continue;
    return { side, rect: slot, clean: false };
  }
  return null;
}
