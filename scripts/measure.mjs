#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gcdInt, median, quantile, modeOf, rectContainsPoint } from './lib/geometry.mjs';
import { loadPage, indexPins, labelBBox } from './lib/page.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

function parseArgs(argv) {
  const a = { files: [], write: false, format: 'text', out: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--write') a.write = true;
    else if (t === '--json') a.format = 'json';
    else if (t === '--out') a.out = argv[++i];
    else if (t === '--help' || t === '-h') a.help = true;
    else if (!t.startsWith('-')) a.files.push(t);
  }
  return a;
}

const fmt = (n, d = 1) => (Number.isFinite(n) ? Number(n.toFixed(d)) : '-');

function detectGrid(page) {
  const vals = [];
  for (const c of page.components) {
    vals.push(c.x, c.y);
    for (const p of c.pins || []) vals.push(p.x, p.y);
  }
  for (const w of page.wires) for (const p of w.points) vals.push(p[0], p[1]);
  if (!vals.length) return { grid: page.grid ?? null, coverage: null, note: '无坐标' };

  const rounded = vals.map(v => Math.round(v));
  if (vals.some((v, i) => Math.abs(v - rounded[i]) > 1e-6)) {
    return { grid: null, coverage: null, note: '存在非整数坐标，栅格无法推断' };
  }

  const candidates = [...new Set([page.grid, 100, 50, 25, 20, 10, 5, 2, 1].filter(Boolean))];
  for (const g of candidates) {
    const ok = rounded.filter(v => v % g === 0).length / rounded.length;
    if (ok >= 0.75) {
      return {
        grid: g,
        coverage: ok,
        note: ok < 0.999 ? `${((1 - ok) * 100).toFixed(1)}% 坐标偏离该栅格（可能是缺陷，也可能实际栅格更细）` : null
      };
    }
  }
  return { grid: 1, coverage: null, note: '未找到一致的栅格' };
}

// Nearest separation between two component boxes along the axis where projections overlap.
function pairGaps(components) {
  const gaps = [];
  const cs = components.filter(c => c.bbox && (c.bbox.w || c.bbox.h));
  for (let i = 0; i < cs.length; i++) {
    for (let j = i + 1; j < cs.length; j++) {
      const a = cs[i].bbox, b = cs[j].bbox;
      const xOverlap = !(a.x + a.w <= b.x || b.x + b.w <= a.x);
      const yOverlap = !(a.y + a.h <= b.y || b.y + b.h <= a.y);
      if (yOverlap && !xOverlap) {
        gaps.push(Math.max(0, Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w))));
      } else if (xOverlap && !yOverlap) {
        gaps.push(Math.max(0, Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h))));
      }
    }
  }
  return gaps.filter(v => v > 0);
}

function twoPeaks(gaps, grid) {
  if (!gaps.length) return { small: null, large: null, hist: {} };
  const bin = (v) => Math.round(v / (grid || 1)) * (grid || 1);
  const freq = new Map();
  for (const g of gaps) {
    const k = bin(g);
    freq.set(k, (freq.get(k) || 0) + 1);
  }
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const small = sorted[0]?.[0] ?? null;
  const second = sorted.find(([v]) => small && v >= small * 2);
  const large = second ? second[0] : (gaps.length ? Math.max(...gaps) : null);
  return {
    small,
    large,
    hist: Object.fromEntries(sorted.slice(0, 8))
  };
}

function stubLengths(page) {
  const labelPoints = new Set(page.labels.map(l => `${Math.round(l.x)}|${Math.round(l.y)}`));
  const pins = indexPins(page);
  const pinAt = (p) => pins.find(q => Math.round(q.point[0]) === Math.round(p[0]) && Math.round(q.point[1]) === Math.round(p[1]));
  const out = [];
  for (const w of page.wires) {
    if (w.points.length !== 2) continue;
    const [a, b] = w.points;
    const aLabel = labelPoints.has(`${Math.round(a[0])}|${Math.round(a[1])}`);
    const bLabel = labelPoints.has(`${Math.round(b[0])}|${Math.round(b[1])}`);
    const aPin = pinAt(a), bPin = pinAt(b);
    if ((aLabel && bPin) || (bLabel && aPin)) {
      out.push(Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]));
    }
  }
  return out;
}

function labelClearances(page) {
  const out = [];
  for (const l of page.labels) {
    const p = [l.x, l.y];
    let best = Infinity;
    for (const c of page.components) {
      if (!c.bbox) continue;
      const b = c.bbox;
      const dx = Math.max(b.x - p[0], 0, p[0] - (b.x + b.w));
      const dy = Math.max(b.y - p[1], 0, p[1] - (b.y + b.h));
      best = Math.min(best, Math.hypot(dx, dy));
    }
    if (Number.isFinite(best)) out.push(best);
  }
  return out;
}

function analyse(page, file) {
  const gridInfo = detectGrid(page);
  const grid = gridInfo.grid || page.grid || 10;
  const gaps = pairGaps(page.components);
  const peaks = twoPeaks(gaps, grid);
  const stubs = stubLengths(page);
  const clears = labelClearances(page);

  const rotations = new Map();
  for (const c of page.components) {
    const r = ((c.rotation ?? 0) % 360 + 360) % 360;
    rotations.set(r, (rotations.get(r) || 0) + 1);
  }

  const stats = {
    file,
    source: page.source,
    counts: {
      components: page.components.length,
      wires: page.wires.length,
      labels: page.labels.length,
      pins: page.components.reduce((s, c) => s + (c.pins?.length || 0), 0)
    },
    grid: { detected: gridInfo.grid, coverage: gridInfo.coverage, note: gridInfo.note },
    gaps: {
      n: gaps.length,
      min: gaps.length ? Math.min(...gaps) : null,
      p25: quantile(gaps, 0.25),
      median: median(gaps),
      p90: quantile(gaps, 0.9),
      max: gaps.length ? Math.max(...gaps) : null,
      peakSmall: peaks.small,
      peakLarge: peaks.large,
      histogram: peaks.hist
    },
    pinStubLength: { n: stubs.length, median: median(stubs), p25: quantile(stubs, 0.25), p75: quantile(stubs, 0.75) },
    labelClearance: { n: clears.length, median: median(clears), p25: quantile(clears, 0.25) },
    rotationDistribution: Object.fromEntries([...rotations.entries()].sort((a, b) => a[0] - b[0]))
  };

  const suggested = {
    grid,
    spacing: {
      componentMin: peaks.small ?? 20,
      blockGap: peaks.large ?? 40,
      labelClearance: clears.length ? Math.max(4, Math.round(quantile(clears, 0.25))) : 6,
      pinStubLength: stubs.length ? Math.round(median(stubs)) : 10
    }
  };

  const prov = {
    componentMin: { source: file, method: 'pairwise-gap mode', n: gaps.length },
    blockGap: { source: file, method: 'second peak (>=2x first)', n: gaps.length },
    labelClearance: { source: file, method: 'p25 of label-to-body clearance', n: clears.length },
    pinStubLength: { source: file, method: 'median of label-to-pin stubs', n: stubs.length }
  };

  return { stats, suggested, prov };
}

function render(a) {
  const { stats: s, suggested } = a;
  const L = [];
  L.push(`测量  ${s.file}`);
  L.push(`元件 ${s.counts.components} · 导线 ${s.counts.wires} · 标签 ${s.counts.labels} · 引脚 ${s.counts.pins}`);
  L.push('');
  L.push(`栅格          ${s.grid.detected ?? '未能推断'}${s.grid.coverage != null ? `（覆盖 ${(s.grid.coverage * 100).toFixed(1)}%）` : ''}`);
  if (s.grid.note) L.push(`              ${s.grid.note}`);
  L.push(`元件间距      min ${fmt(s.gaps.min, 0)} / p25 ${fmt(s.gaps.p25, 0)} / 中位 ${fmt(s.gaps.median, 0)} / p90 ${fmt(s.gaps.p90, 0)}`);
  L.push(`间距峰值      小 ${s.gaps.peakSmall ?? '-'}（块内） · 大 ${s.gaps.peakLarge ?? '-'}（块间）`);
  L.push(`引脚短桩长度  中位 ${fmt(s.pinStubLength.median, 0)} (n=${s.pinStubLength.n})`);
  L.push(`标签净空      中位 ${fmt(s.labelClearance.median, 0)} (n=${s.labelClearance.n})`);
  L.push(`旋转分布      ${JSON.stringify(s.rotationDistribution)}`);
  L.push('');
  L.push('建议常量');
  L.push(JSON.stringify(suggested, null, 2));
  if (s.counts.components < 5) {
    L.push('');
    L.push('注意: 元件数少于 5，间距峰值不可靠，建议多测几张再定常量。');
  }
  return L.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.files.length) {
    console.log(`用法: sch-measure <page.json> [more.json...] [--write] [--json] [--out stats.json]

  --write   把测得的常量写回 rules/constants.json（保留 version，递增 patch，
            并在 provenance 里记录每个数字的来源文件与方法）`);
    process.exit(args.help ? 0 : 2);
  }

  const results = args.files.map(f => {
    const { page } = loadPage(f);
    return analyse(page, f);
  });

  if (args.format === 'json') {
    const payload = results.length === 1 ? results[0] : results;
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(results.map(render).join('\n\n' + '-'.repeat(60) + '\n\n'));
  }

  if (args.write) {
    const target = args.out || join(ROOT, 'rules/constants.json');
    const cur = JSON.parse(readFileSync(target, 'utf8'));
    const r = results[0];
    const [maj, min, pat] = cur.version.split('.').map(Number);
    cur.version = `${maj}.${min}.${pat + 1}`;
    cur.grid = r.suggested.grid;
    Object.assign(cur.spacing, r.suggested.spacing);
    cur.provenance = { _note: cur.provenance?._note, ...r.prov };
    writeFileSync(target, JSON.stringify(cur, null, 2) + '\n', 'utf8');
    console.error(`已写入 ${target}（version → ${cur.version}）`);
  }
}

main();
