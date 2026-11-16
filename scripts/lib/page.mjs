import { readFileSync } from 'node:fs';
import { bboxOfRects, ptEq } from './geometry.mjs';

export const SCHEMA_VERSION = '0.1.0';

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
    grid: raw.grid ?? 10,
    source: raw.source || {},
    components: raw.components || [],
    wires: raw.wires || [],
    labels: raw.labels || [],
    texts: raw.texts || [],
    notes: raw.notes || []
  };

  for (const c of page.components) {
    c.pins = c.pins || [];
    c.rotation = c.rotation ?? 0;
    if (!c.bbox) c.bbox = deriveBBoxFromPins(c) || { x: c.x, y: c.y, w: 0, h: 0 };
  }
  for (const w of page.wires) {
    w.points = w.points || [];
  }
  return page;
}

function deriveBBoxFromPins(c) {
  if (!c.pins.length) return null;
  const pts = c.pins.map(p => [p.x, p.y]);
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  return { x: x0, y: y0, w: Math.max(x1 - x0, 0), h: Math.max(y1 - y0, 0) };
}

export function validatePage(page) {
  const issues = [];
  if (page.schemaVersion !== SCHEMA_VERSION) {
    issues.push({
      level: 'warn',
      code: 'schema-version',
      msg: `页面 schemaVersion=${page.schemaVersion}，本工具为 ${SCHEMA_VERSION}，字段可能不兼容`
    });
  }
  if (!page.components.length) {
    issues.push({ level: 'error', code: 'empty', msg: '页面没有任何元件，无法分析' });
  }
  const noPins = page.components.filter(c => !c.pins || !c.pins.length).length;
  if (noPins) {
    issues.push({
      level: 'warn',
      code: 'pins-missing',
      msg: `${noPins} 个元件缺少引脚坐标，dangling-wire / wire-through-body 精度会下降`
    });
  }
  const noBBox = page.components.filter(c => !c.bbox || (!c.bbox.w && !c.bbox.h)).length;
  if (noBBox) {
    issues.push({
      level: 'warn',
      code: 'bbox-missing',
      msg: `${noBBox} 个元件包围盒缺失或为零，overlap / wire-through-body 会漏报`
    });
  }
  if (!page.labels.length) {
    issues.push({ level: 'warn', code: 'labels-missing', msg: '页面没有网络标签数据，label-overlap 将被跳过' });
  }
  return issues;
}

export function capabilities(page) {
  return {
    pins: page.components.some(c => c.pins && c.pins.length),
    labels: page.labels.length > 0,
    components: page.components.length > 0,
    wires: page.wires.length > 0
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
        point: [p.x, p.y]
      });
    }
  }
  return all;
}

export function wireSegments(page) {
  const segs = [];
  for (const w of page.wires) {
    for (let i = 1; i < w.points.length; i++) {
      segs.push({
        wireId: w.id,
        net: w.net ?? null,
        index: i - 1,
        a: w.points[i - 1],
        b: w.points[i],
        bendCount: 0
      });
    }
  }
  return segs;
}

// An endpoint is considered connected if it lands on a pin, another wire endpoint,
// or a net label anchor.
export function buildEndpointIndex(page) {
  const keys = new Map();
  const key = (p) => `${Math.round(p[0] * 1000)}|${Math.round(p[1] * 1000)}`;
  const add = (p, kind, ref) => {
    const k = key(p);
    if (!keys.has(k)) keys.set(k, []);
    keys.get(k).push({ kind, ref });
  };
  for (const pin of indexPins(page)) add(pin.point, 'pin', pin);
  for (const w of page.wires) {
    if (!w.points.length) continue;
    add(w.points[0], 'wire-end', { wireId: w.id });
    add(w.points[w.points.length - 1], 'wire-end', { wireId: w.id });
  }
  for (const l of page.labels) add([l.x, l.y], 'label', { labelId: l.id, text: l.text });
  return { lookup: (p) => keys.get(key(p)) || [] };
}

export function contentBBox(page) {
  const rects = page.components.map(c => c.bbox).filter(Boolean);
  const labelRects = page.labels.map(l => labelBBox(l));
  return bboxOfRects([...rects, ...labelRects]);
}

export function labelBBox(l) {
  const text = l.text || '';
  // Chinese chars ~ full width, latin ~ half. Rough but stable in 0.01in units.
  let textW = 0;
  for (const ch of text) textW += /[\u4e00-\u9fff]/.test(ch) ? 12 : 7;
  const textH = 12;
  const rot = ((l.rotation ?? 0) % 360 + 360) % 360;
  const vertical = rot === 90 || rot === 270;
  const w = vertical ? textH : textW;
  const h = vertical ? textW : textH;
  const align = l.align || 'start';
  const x = align === 'end' ? l.x - w : align === 'middle' ? l.x - w / 2 : l.x;
  return { x, y: l.y - h / 2, w, h };
}

export function samePoint(a, b) {
  return ptEq(a, b);
}
