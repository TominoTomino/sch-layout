#!/usr/bin/env node
// Render a page.json to SVG so a drawing can be judged without opening EDA.
//
// Used for two things: seeing the current state before changing it, and
// reviewing a placement plan before writing coordinates. It draws symbol
// bodies, wires, net labels and designators - enough to judge structure, not a
// pixel-accurate reproduction.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bboxToPage } from './epro.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

function parseArgs(argv) {
  const a = { file: null, out: null, symbols: null, title: null, plan: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--out' || t === '-o') a.out = argv[++i];
    else if (t === '--symbols') a.symbols = argv[++i];
    else if (t === '--title') a.title = argv[++i];
    else if (t === '--plan') a.plan = argv[++i];
    else if (!t.startsWith('-')) a.file = t;
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (!args.file) {
  console.log(`用法: node scripts/preview.mjs <page.json> [--symbols symbols.json]
                                        [--plan plan.json] [--out x.svg] [--title 标题]

--plan 会把元件画在方案坐标上（不读文件里的位置），用于审查放置方案。`);
  process.exit(2);
}

const page = readJson(resolve(args.file));
const symbols = args.symbols ? readJson(resolve(args.symbols)).symbols : {};
const plan = args.plan ? readJson(resolve(args.plan)) : null;

const boxOf = (c) => {
  const s = symbols[c.symbolUuid];
  if (s && s.bbox) return bboxToPage(s.bbox, { x: 0, y: 0, rotation: c.rotation || 0, mirror: !!c.mirror });
  // fall back to the pin cloud, same rule as lint (D19: no padding)
  const px = (c.pins || []).map((p) => p.x), py = (c.pins || []).map((p) => p.y);
  if (!px.length) return { x: c.x - 10, y: c.y - 10, w: 20, h: 20 };
  return { x: Math.min(...px) - c.x, y: Math.min(...py) - c.y, w: Math.max(...px) - Math.min(...px), h: Math.max(...py) - Math.min(...py) };
};

// every element in sheet coordinates
const items = [];
for (const c of page.components) {
  const pos = plan ? plan.components[c.designator] : c;
  if (!pos) continue;
  const b = boxOf(c);
  items.push({ kind: 'comp', d: c.designator, x: pos.x + b.x, y: pos.y + b.y, w: b.w, h: b.h, live: (c.pins || []).some((p) => p.net) });
}
if (!plan) {
  for (const w of page.wires) for (const s of w.segments) items.push({ kind: 'wire', x1: s[0], y1: s[1], x2: s[2], y2: s[3] });
  for (const l of page.labels) {
    const p = l.conn || { x: l.x, y: l.y };
    items.push({ kind: 'label', x: p.x, y: p.y, text: l.text || '' });
  }
}
for (const f of (plan ? plan.blocks : [])) items.push({ kind: 'frame', ...f });

const xs = [], ys = [];
for (const it of items) {
  if (it.kind === 'comp' || it.kind === 'frame') { xs.push(it.x, it.x + it.w); ys.push(it.y, it.y + it.h); }
  else if (it.kind === 'wire') { xs.push(it.x1, it.x2); ys.push(it.y1, it.y2); }
  else { xs.push(it.x); ys.push(it.y); }
}
const pad = 50;
const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad;
const y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
const W = Math.round(x1 - x0), H = Math.round(y1 - y0);
const X = (v) => (v - x0).toFixed(1);
const Y = (v) => (y1 - v).toFixed(1);

const ink = '#2b2b2b', faint = '#8a8a86';
const out = [`<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`];

for (const it of items) {
  if (it.kind === 'frame') {
    out.push(`<rect x="${X(it.x)}" y="${Y(it.y + it.h)}" width="${it.w.toFixed(0)}" height="${it.h.toFixed(0)}" rx="6" fill="none" stroke="#9c9a90" stroke-width="1.2" stroke-dasharray="6 4"/>`);
    out.push(`<text x="${(+X(it.x) + 14).toFixed(1)}" y="${(+Y(it.y + it.h) + 22).toFixed(1)}" font-family="system-ui,sans-serif" font-size="16" font-weight="600" fill="${ink}">${it.title}</text>`);
    out.push(`<text x="${(+X(it.x) + 14).toFixed(1)}" y="${(+Y(it.y + it.h) + 38).toFixed(1)}" font-family="system-ui,sans-serif" font-size="10.5" fill="${faint}">${it.subtitle || ''}</text>`);
  } else if (it.kind === 'wire') {
    out.push(`<line x1="${X(it.x1)}" y1="${Y(it.y1)}" x2="${X(it.x2)}" y2="${Y(it.y2)}" stroke="#2f6f4f" stroke-width="1.4"/>`);
  } else if (it.kind === 'label') {
    out.push(`<text x="${X(it.x)}" y="${(+Y(it.y) - 5).toFixed(1)}" font-family="system-ui,sans-serif" font-size="9" fill="#b04a2f">${it.text}</text>`);
  } else {
    const fill = it.live ? '#e8f0e9' : '#eef3f8';
    const stroke = it.live ? '#4f7a5c' : '#7f93a8';
    out.push(`<rect x="${X(it.x)}" y="${Y(it.y + it.h)}" width="${it.w.toFixed(1)}" height="${it.h.toFixed(1)}" rx="2" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`);
    const fs = Math.min(it.w, it.h) < 16 ? 8 : 12;
    out.push(`<text x="${(+X(it.x) + it.w / 2).toFixed(1)}" y="${(+Y(it.y + it.h) + it.h / 2 + fs * 0.35).toFixed(1)}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="${fs}" fill="${ink}">${it.d}</text>`);
  }
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${out.join('\n')}</svg>\n`;
const outPath = resolve(args.out || join(ROOT, 'out/preview.svg'));
writeFileSync(outPath, svg, 'utf8');
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${args.title || 'preview'}</title>
<style>body{margin:0;padding:20px;background:#f4f4f2;font-family:system-ui,sans-serif}
h1{font-size:14px;color:#555;margin:0 0 12px}svg{max-width:100%;height:auto;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.12)}</style></head>
<body><h1>${args.title || ''}</h1>${svg}</body></html>`;
writeFileSync(outPath.replace(/\.svg$/, '.html'), html, 'utf8');
console.log(`${outPath}  (${W}×${H})  元件 ${page.components.length}`);
