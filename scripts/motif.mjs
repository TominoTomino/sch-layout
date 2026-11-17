#!/usr/bin/env node
// Motif templates: extract a reusable sub-circuit from a real drawing, and
// render one back as an image so the numbers can be checked by eye.
//
// A motif is "structure -> relative coordinates", not a picture. Designators and
// net names are dropped; what survives is which role connects to which role, and
// where each role sits relative to the anchor. That is what makes it reusable
// across projects (design-notes D2/D41): nothing in the file is language, so
// nothing can be lost in summarising.
//
// Judgement stays outside the tool: the caller names the roles, the tool measures
// the geometry.

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const MOTIFS = join(ROOT, 'templates/motifs');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const GRID = 5;
const snap = (v) => Math.round(v / GRID) * GRID;

const argv = process.argv.slice(2);
const cmd = argv[0];

function arg(name, fallback = null) {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : fallback;
}

// ---- extract ------------------------------------------------------------
function extract() {
  const pagePath = arg('page');
  const id = arg('id');
  const seed = arg('seed');
  const rolesArg = arg('roles');
  if (!pagePath || !id || !seed || !rolesArg) {
    console.error('用法: motif.mjs extract --page p.json --id crystal-4pin-2cap --seed X1 --roles X1:osc,XC1:cap_xi,XC2:cap_xo');
    process.exit(2);
  }
  const page = readJson(resolve(pagePath));
  const by = new Map(page.components.map((c) => [c.designator, c]));
  const roles = new Map();
  for (const part of rolesArg.split(',')) {
    const [des, role] = part.split(':');
    if (!by.has(des)) { console.error(`图上没有 ${des}`); process.exit(2); }
    roles.set(des, role);
  }

  const anchor = by.get(seed);
  const members = [...roles.keys()];
  const slotOf = new Map();
  const slots = [];
  for (const [des, role] of roles) {
    const c = by.get(des);
    slotOf.set(des, role);
    slots.push({
      role,
      pins: c.pins.length,
      symbol: (c.symbol || '').slice(0, 40),
      dx: snap(c.x - anchor.x),
      dy: snap(c.y - anchor.y),
      rotation: ((c.rotation || 0) % 360 + 360) % 360,
      mirror: !!c.mirror
    });
  }

  // nets that touch at least one member pin
  const netPins = new Map();
  for (const des of members) {
    for (const p of by.get(des).pins) {
      if (!p.net) continue;
      if (!netPins.has(p.net)) netPins.set(p.net, []);
      netPins.get(p.net).push({ role: slotOf.get(des), pin: String(p.num) });
    }
  }
  // a net is external when something outside the motif also sits on it
  const nets = [];
  for (const [name, pins] of netPins) {
    let external = false;
    for (const c of page.components) {
      if (roles.has(c.designator)) continue;
      if (c.pins.some((p) => p.net === name)) { external = true; break; }
    }
    nets.push({
      role: name,
      members: pins.map((p) => `${p.role}.${p.pin}`),
      external,
      single: pins.length === 1
    });
  }

  const xs = slots.map((s) => s.dx), ys = slots.map((s) => s.dy);
  const bbox = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };

  const motif = {
    schemaVersion: '0.1.0',
    kind: 'motif',
    id,
    grid: GRID,
    anchor: slotOf.get(seed),
    bbox,
    slots,
    nets,
    source: {
      project: page.source?.project || '',
      page: page.source?.page || '',
      pageUuid: page.source?.pageUuid || '',
      extractedFrom: members.slice().sort().join(','),
      extractedAt: new Date().toISOString()
    }
  };
  mkdirSync(MOTIFS, { recursive: true });
  const out = join(MOTIFS, `${id}.json`);
  writeFileSync(out, JSON.stringify(motif, null, 2) + '\n', 'utf8');
  console.log(`${out}`);
  console.log(`  ${slots.length} 个角色 · ${nets.length} 个网（外部 ${nets.filter((n) => n.external).length}）· 尺寸 ${bbox.x1 - bbox.x0}×${bbox.y1 - bbox.y0}`);
  for (const s of slots) console.log(`   ${s.role.padEnd(10)} (${String(s.dx).padStart(5)}, ${String(s.dy).padStart(5)}) rot${String(s.rotation).padStart(3)} ${s.symbol}`);
}

// ---- render -------------------------------------------------------------
function render() {
  const file = argv[1];
  if (!file) { console.error('用法: motif.mjs render templates/motifs/x.json'); process.exit(2); }
  const m = readJson(resolve(file));
  // scale: one grid unit -> one px, then pad
  const boxW = m.bbox.x1 - m.bbox.x0, boxH = m.bbox.y1 - m.bbox.y0;
  const cell = m.slots.length > 3 ? 70 : 90;
  const W = boxW + cell * 2, H = boxH + cell * 2;
  const PX = (x) => x - m.bbox.x0 + cell;
  const PY = (y) => H - (y - m.bbox.y0 + cell);
  const out = [`<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`];
  for (const s of m.slots) {
    const x = PX(s.dx), y = PY(s.dy);
    out.push(`<circle cx="${x}" cy="${y}" r="16" fill="#eef3f8" stroke="#7f93a8"/>`);
    out.push(`<text x="${x}" y="${y + 4}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" fill="#2b2b2b">${s.role.slice(0, 7)}</text>`);
    out.push(`<text x="${x}" y="${y + 28}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="8" fill="#8a8a86">${s.rotation}°</text>`);
  }
  // draw nets as lines between first two members; label the role
  for (const n of m.nets) {
    const pts = n.members.map((mp) => {
      const [role] = mp.split('.');
      return m.slots.find((s) => s.role === role);
    }).filter(Boolean);
    for (let i = 1; i < pts.length; i++) {
      out.push(`<line x1="${PX(pts[0].dx)}" y1="${PY(pts[0].dy)}" x2="${PX(pts[i].dx)}" y2="${PY(pts[i].dy)}" stroke="${n.external ? '#b04a2f' : '#4f7a5c'}" stroke-width="1.3" stroke-dasharray="${n.external ? '5 3' : '0'}"/>`);
    }
    if (pts.length) {
      out.push(`<text x="${PX(pts[0].dx)}" y="${PY(pts[0].dy) - 22}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="8.5" fill="${n.external ? '#b04a2f' : '#4f7a5c'}">${n.role}</text>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${out.join('\n')}</svg>`;
  const base = basename(file, '.json');
  writeFileSync(join(ROOT, 'out/motif-' + base + '.svg'), svg, 'utf8');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${m.id}</title>
<style>body{margin:0;padding:20px;background:#f4f4f2;font-family:system-ui,sans-serif}h1{font-size:13px;color:#555;margin:0 0 10px}svg{background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.12)}</style></head>
<body><h1>${m.id} · ${m.slots.length} 角色 · 虚线=对外网络</h1>${svg}</body></html>`;
  writeFileSync(join(ROOT, 'out/motif-' + base + '.html'), html, 'utf8');
  console.log(`out/motif-${base}.svg / .html`);
}

// ---- list ---------------------------------------------------------------
function list() {
  if (!mkdirSync) return;
  const dir = MOTIFS;
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { files = []; }
  if (!files.length) { console.log('(模板库为空)'); return; }
  for (const f of files) {
    const m = readJson(join(dir, f));
    console.log(`${m.id.padEnd(24)} ${m.slots.length} 角色 · ${m.nets.length} 网 · ${m.source.project}`);
  }
}

if (cmd === 'extract') extract();
else if (cmd === 'render') render();
else if (cmd === 'list') list();
else {
  console.log(`用法:
  motif.mjs extract --page <page.json> --id <name> --seed <designator> --roles A:role,B:role
  motif.mjs render  <templates/motifs/x.json>
  motif.mjs list`);
  process.exit(2);
}
