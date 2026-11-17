#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isOrthogonal, rectsOverlap, rectIntersectionArea, rectArea, segmentCrossesRect,
  properCrossing, segmentLength, pointOnSegment, deflate
} from './lib/geometry.mjs';
import {
  loadPage, wireSegments, buildNodeIndex, wireCorners,
  capabilities, contentBBox, labelBBox, labelAnchor, pointKey, detectArrays
} from './lib/page.mjs';
import { bboxToPage } from './epro.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const SEVERITY_RANK = { error: 0, warn: 1, info: 2 };

function parseArgs(argv) {
  const args = { files: [], format: 'text', verbose: false, rules: null, constants: null, symbols: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.format = 'json';
    else if (a === '--md') args.format = 'md';
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '--rules') args.rules = argv[++i];
    else if (a === '--constants') args.constants = argv[++i];
    else if (a === '--symbols') args.symbols = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else if (!a.startsWith('-')) args.files.push(a);
  }
  return args;
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

function loadWaivers() {
  const f = join(ROOT, 'rules/waivers.json');
  if (!existsSync(f)) return [];
  try { return readJson(f).waivers || []; } catch { return []; }
}

// A waiver names a rule and a designator pair; the item's ref is 'A / B'.
// Order-insensitive so the pair means the same thing however it was found.
function isWaived(waivers, ruleId, item) {
  const parts = String(item.ref || '').split('/').map(x => x.trim());
  if (parts.length !== 2) return false;
  const key = [parts[0], parts[1]].sort().join('|');
  return waivers.some(w => {
    if (w.rule !== ruleId || !Array.isArray(w.pair)) return false;
    return [...w.pair].sort().join('|') === key;
  });
}
const fmt = (n, d = 1) => (Number.isFinite(n) ? Number(n.toFixed(d)) : '-');


// Designers stack identical parts at a characteristic pitch; the overlap ratio of
// such a pair repeats across the page, while a genuine collision is an outlier.
// So: the modal ratio per symbol defines "intentional adjacency" (D27).
function computeOverlaps(page, C) {
  const need = C.limits.minOverlapRatio ?? 0.35;
  const cs = page.components.filter(c => c.bbox && (c.bbox.w || c.bbox.h));
  const pairs = [];
  for (let i = 0; i < cs.length; i++) {
    for (let j = i + 1; j < cs.length; j++) {
      if (!rectsOverlap(cs[i].bbox, cs[j].bbox, 1)) continue;
      const inter = rectIntersectionArea(cs[i].bbox, cs[j].bbox);
      const smaller = Math.min(rectArea(cs[i].bbox), rectArea(cs[j].bbox));
      const ratio = smaller > 0 ? inter / smaller : 1;
      if (ratio < need) continue;
      pairs.push({
        a: cs[i].designator || cs[i].id,
        b: cs[j].designator || cs[j].id,
        symA: cs[i].symbolUuid, symB: cs[j].symbolUuid,
        ratio,
        bucket: Math.round(ratio * 20) / 20,
        array: false
      });
    }
  }
  return pairs;
}

// Style is a property of the designer, not of one sheet: a ratio that looks
// unique on page 7 may occur 18 times across the project (D28).
function overlapTally(pairsList) {
  const tally = new Map();
  for (const pairs of pairsList) {
    for (const p of pairs) {
      if (!p.symA || p.symA !== p.symB) continue;
      const k = p.symA + '@' + p.bucket;
      tally.set(k, (tally.get(k) || 0) + 1);
    }
  }
  return tally;
}

function applyTally(pairs, tally) {
  for (const p of pairs) {
    p.array = false;
    if (!p.symA || p.symA !== p.symB) continue;
    const k = p.symA + '@' + p.bucket;
    if ((tally.get(k) || 0) >= 2) p.array = true;
  }
  return pairs;
}

const RULE_IMPL = {
  'array-overlap': (page) => {
    return (page.__overlaps || []).filter(o => o.array).map(o => ({
      ref: `${o.a} / ${o.b}`,
      detail: `等距排布内交叠 ${(o.ratio * 100).toFixed(0)}%，与同型号其它成对一致，视为有意排版`
    }));
  },

  'grid-off': (page, C) => {
    const g = page.grid || C.grid;
    const tol = C.limits?.gridTolerance ?? 0.1;
    const items = [];
    // Tolerance is not sloppiness: writes leave sub-unit drift (~0.05 units) that
    // is numerical noise, not a drawing mistake. Real off-grid errors are >= 1 unit.
    const bad = (v) => {
      const r = ((v % g) + g) % g;
      return Math.min(r, g - r) > tol;
    };
    for (const c of page.components) {
      if (bad(c.x) || bad(c.y)) items.push({ ref: c.designator || c.id, detail: `元件原点 (${c.x}, ${c.y}) 不在 ${g} 栅格` });
      for (const p of c.pins || []) {
        if (bad(p.x) || bad(p.y)) items.push({ ref: `${c.designator}.${p.num}`, detail: `引脚 (${p.x}, ${p.y}) 不在 ${g} 栅格` });
      }
    }
    for (const s of wireSegments(page)) {
      for (const pt of [s.a, s.b]) {
        if (bad(pt[0]) || bad(pt[1])) items.push({ ref: `wire:${s.wireId}`, detail: `导线端点 (${pt[0]}, ${pt[1]}) 不在 ${g} 栅格` });
      }
    }
    for (const l of page.labels) {
      const a = labelAnchor(l);
      if (bad(a[0]) || bad(a[1])) items.push({ ref: `label:${l.id}`, detail: `标签连接点 (${a[0]}, ${a[1]}) 不在 ${g} 栅格` });
    }
    return items;
  },

  'overlap': (page) => {
    return (page.__overlaps || []).filter(o => !o.array).map(o => ({
      ref: `${o.a} / ${o.b}`,
      detail: `重叠面积占较小者的 ${(o.ratio * 100).toFixed(0)}%`
    }));
  },

  'dangling-wire': (page) => {
    const nodes = buildNodeIndex(page);
    const allSegs = wireSegments(page);
    const items = [];
    for (const [k, node] of nodes) {
      if (!node.segments.length) continue;
      if (node.pins.length || node.labels.length) continue;
      if (node.segments.length >= 2) continue;
      const tJunction = allSegs.some(s =>
        pointKey(s.a) !== k && pointKey(s.b) !== k && pointOnSegment(node.point, s.a, s.b));
      if (tJunction) continue;
      items.push({ ref: `wire:${node.segments[0].wireId}`, detail: `端点 (${node.point[0]}, ${node.point[1]}) 悬空` });
    }
    return items;
  },

  'diagonal': (page) => {
    const items = [];
    for (const s of wireSegments(page)) {
      if (!isOrthogonal(s.a, s.b)) items.push({ ref: `wire:${s.wireId}`, detail: `段 (${s.a}) → (${s.b}) 为斜线` });
    }
    return items;
  },

  'too-many-bends': (page, C) => {
    const max = C.routing.maxBendsPerWire;
    const items = [];
    for (const w of page.wires) {
      const segs = (w.segments || []).map((s, i) => ({ wireId: w.id, index: i, a: [s[0], s[1]], b: [s[2], s[3]] }));
      const { corners } = wireCorners(segs);
      if (corners > max) items.push({ ref: `wire:${w.id}`, detail: `${corners} 个拐点，上限 ${max}` });
    }
    return items;
  },

  'wire-through-body': (page, C) => {
    const items = [];
    const pinSet = new Set();
    for (const c of page.components) {
      for (const p of c.pins || []) pinSet.add(`${Math.round(p.x)}|${Math.round(p.y)}|${c.id}`);
    }
    const minLen = C.grid * 2;
    for (const s of wireSegments(page)) {
      for (const c of page.components) {
        if (!c.bbox) continue;
        const ownsA = pinSet.has(`${Math.round(s.a[0])}|${Math.round(s.a[1])}|${c.id}`);
        const ownsB = pinSet.has(`${Math.round(s.b[0])}|${Math.round(s.b[1])}|${c.id}`);
        if (ownsA || ownsB) continue;
        const inset = Math.min(20, Math.max(C.grid, Math.min(c.bbox.w, c.bbox.h) / 3));
        if (segmentCrossesRect(s.a, s.b, c.bbox, minLen, inset)) {
          items.push({ ref: `wire:${s.wireId} → ${c.designator || c.id}`, detail: '段穿过元件本体（包围盒近似，可能误报）' });
        }
      }
    }
    return items;
  },

  'density': (page, C) => {
    const max = C.limits.maxComponentsPerPage;
    const n = page.components.length;
    return n > max ? [{ ref: 'page', detail: `${n} 个元件，上限 ${max}` }] : [];
  },

  'label-overlap': (page) => {
    const items = [];
    for (const l of page.labels) {
      const r = labelBBox(l);
      const a = labelAnchor(l);
      for (const c of page.components) {
        if (!c.bbox) continue;
        const attached = a[0] >= c.bbox.x - 1 && a[0] <= c.bbox.x + c.bbox.w + 1 &&
                         a[1] >= c.bbox.y - 1 && a[1] <= c.bbox.y + c.bbox.h + 1;
        if (attached) continue;
        if (rectsOverlap(r, c.bbox, 1)) {
          items.push({ ref: `label:${l.id}`, detail: `"${l.text}" 压在 ${c.designator || c.id} 上` });
        }
      }
      // Wires the label is actually attached to are not "overlaps" — a power flag
      // sitting on a wire corner always covers the wire's other arm.
      const ownWires = new Set();
      for (const s of wireSegments(page)) {
        const atEnd = [s.a, s.b].some(p => Math.abs(p[0] - a[0]) <= 1 && Math.abs(p[1] - a[1]) <= 1);
        if (atEnd || pointOnSegment(a, s.a, s.b)) ownWires.add(s.wireId);
      }
      for (const s of wireSegments(page)) {
        if (ownWires.has(s.wireId)) continue;
        if (segmentCrossesRect(s.a, s.b, r, 1, 0)) {
          items.push({ ref: `label:${l.id}`, detail: `"${l.text}" 压在 wire:${s.wireId} 上` });
        }
      }
    }
    return items;
  }
};

function computeMetrics(page) {
  const segs = wireSegments(page);
  const byWire = new Map();
  for (const s of segs) {
    if (!byWire.has(s.wireId)) byWire.set(s.wireId, []);
    byWire.get(s.wireId).push(s);
  }
  const ids = [...byWire.keys()];
  let crossings = 0;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const A = byWire.get(ids[i]), B = byWire.get(ids[j]);
      const na = A[0]?.net, nb = B[0]?.net;
      if (na && nb && na === nb) continue;
      for (const a of A) for (const b of B) if (properCrossing(a.a, a.b, b.a, b.b)) crossings++;
    }
  }

  let bends = 0, junctions = 0, wireLength = 0;
  for (const [, list] of byWire) {
    const r = wireCorners(list);
    bends += r.corners;
    junctions += r.junctions;
    for (const s of list) wireLength += segmentLength(s.a, s.b);
  }

  const cb = contentBBox(page);
  const contentArea = Math.max(cb.w * cb.h, 1);
  const sumComp = page.components.reduce((s, c) => s + (c.bbox ? c.bbox.w * c.bbox.h : 0), 0);
  const compactness = Math.min(sumComp / contentArea, 1);
  const n = Math.max(page.components.length, 1);

  return {
    crossings, bends, junctions, wireLength, compactness,
    perComponent: { crossings: crossings / n, bends: bends / n, wireLength: wireLength / n },
    counts: {
      components: page.components.length,
      wires: page.wires.length,
      segments: segs.length,
      labels: page.labels.length,
      texts: page.texts.length,
      pins: page.components.reduce((s, c) => s + (c.pins?.length || 0), 0)
    },
    contentBox: cb
  };
}

function scoreOf(ruleResults, metrics, R) {
  const mult = R.scoring.severityMult;
  // Penalty is linear in the number of instances, capped per rule.
  // Rationale (design-notes D23): log2 compression flattened real differences
  // (27 grid violations cost less than they look), while the metric penalties
  // measured page SIZE rather than readability — 12 pages rated equally good by
  // the designer scored 73.6-85.4 because of them, and 94.5-99.4 without.
  let violationPenalty = 0;
  for (const r of ruleResults) {
    if (r.status !== 'fail') continue;
    const raw = r.weight * (mult[r.severity] ?? 0.5) * r.count;
    violationPenalty += Math.min(raw, R.scoring.perRuleCap ?? 40);
  }

  // Metrics stay as reported numbers; they no longer move the score.
  const ref = R.scoring.metricReference;
  const norm = {
    crossings: Math.min(metrics.perComponent.crossings / ref.crossings_perComponent, 1.5),
    bends: Math.min(metrics.perComponent.bends / ref.bends_perComponent, 1.5),
    wireLength: Math.min(metrics.perComponent.wireLength / ref.wireLength_perComponent, 1.5),
    compactness: Math.max(0, 1 - metrics.compactness / ref.compactness_idealMin)
  };
  const metricPenalty = 0;

  const score = Math.max(0, Math.min(100, 100 - violationPenalty - metricPenalty));
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : 'D';
  return { score, grade, violationPenalty, metricPenalty, normalized: norm };
}

function renderText(rep, verbose) {
  const L = [];
  L.push(`原理图可读性报告  ${rep.source?.project || ''} ${rep.source?.page || ''}`.trim());
  L.push(`skill v${rep.skillVersion} · 规则 v${rep.rulesVersion} · schema v${rep.schemaVersion}`);
  L.push('');
  L.push(`总分 ${fmt(rep.score.score)} / 100  (${rep.score.grade})${rep.score.calibrated ? '' : '  [权重未校准]'}`);
  L.push(`元件 ${rep.metrics.counts.components} · 引脚 ${rep.metrics.counts.pins} · 导线 ${rep.metrics.counts.wires}（${rep.metrics.counts.segments} 段）· 标签 ${rep.metrics.counts.labels}`);
  L.push('');
  const failed = rep.rules.filter(r => r.status === 'fail');
  const skipped = rep.rules.filter(r => r.status === 'skipped');
  if (!failed.length) L.push('全部检查通过。');
  else {
    L.push(`问题（${failed.length} 项）`);
    for (const r of failed.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])) {
      L.push(`  [${r.severity}] ${r.id}  ×${r.count}  — ${r.desc}`);
      if (verbose) {
        for (const it of r.items.slice(0, 12)) L.push(`      · ${it.ref}: ${it.detail}`);
        if (r.items.length > 12) L.push(`      · …还有 ${r.items.length - 12} 条`);
      }
    }
  }
  if (skipped.length) {
    L.push('');
    L.push(`跳过（${skipped.length} 项）`);
    for (const r of skipped) L.push(`  ${r.id} — ${r.missing.join(', ')}`);
  }
  L.push('');
  L.push('指标');
  L.push(`  交叉 ${rep.metrics.crossings} · 拐点 ${rep.metrics.bends} · 分支点 ${rep.metrics.junctions} · 总线长 ${fmt(rep.metrics.wireLength, 0)} · 填充率 ${fmt(rep.metrics.compactness, 2)}`);

  // Honesty about blind spots: rules that need symbol outlines are only
  // approximations, so a zero there does not mean "verified clean" (D24).
  const approx = rep.rules.filter(r => (r.geometry || 'exact') === 'approx');
  const approxPassed = approx.filter(r => r.status === 'pass');
  if (approxPassed.length && rep.bboxSource === 'pin-cloud') {
    L.push('');
    L.push('本报告看不见什么');
    L.push(`  ${approxPassed.map(r => r.id).join(' / ')} 报 0，是"用引脚云近似没查到"，不是"确认没问题"。`);
    L.push('  符号本体轮廓拿不到（D24），图形复杂的符号上可能漏报重叠与穿体。');
  }
  if (rep.suppressed) {
    L.push('');
    L.push(`已按 rules/waivers.json 抑制 ${rep.suppressed} 条（每条都有理由与日期，见文件）`);
  }
  if (rep.pageIssues?.length) {
    L.push('');
    L.push('数据质量');
    for (const i of rep.pageIssues) L.push(`  [${i.level}] ${i.code}: ${i.msg}`);
  }
  return L.join('\n');
}

function renderMd(rep) {
  const L = [];
  L.push('## 原理图可读性报告');
  L.push('');
  L.push(`**${fmt(rep.score.score)} / 100 (${rep.score.grade})**${rep.score.calibrated ? '' : ' · 权重未校准'}`);
  L.push('');
  L.push(`skill v${rep.skillVersion} · 规则 v${rep.rulesVersion} · 元件 ${rep.metrics.counts.components} · 导线 ${rep.metrics.counts.wires}`);
  L.push('');
  const failed = rep.rules.filter(r => r.status === 'fail');
  if (!failed.length) L.push('全部检查通过。');
  else {
    L.push('| 级别 | 检查项 | 次数 | 说明 |');
    L.push('|---|---|---|---|');
    for (const r of failed.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])) {
      L.push(`| ${r.severity} | \`${r.id}\` | ${r.count} | ${r.desc} |`);
    }
  }
  L.push('');
  L.push(`指标：交叉 ${rep.metrics.crossings} · 拐点 ${rep.metrics.bends} · 分支点 ${rep.metrics.junctions} · 总线长 ${fmt(rep.metrics.wireLength, 0)}`);
  return L.join('\n');
}

function runOne(file, args, R, C, symbols, tally) {
  const { page, issues } = loadPage(file);
  const caps = capabilities(page);

  // Real symbol outlines, if the project was exported to .epro and parsed (D26).
  let bboxSource = 'pin-cloud';
  if (symbols) {
    let real = 0, missing = 0;
    for (const c of page.components) {
      const s = symbols[c.symbolUuid];
      const box = s ? bboxToPage(s.bbox, c) : null;
      if (box && box.w > 0 && box.h > 0) { c.bbox = box; c.bboxReal = true; real++; }
      else missing++;
    }
    bboxSource = missing ? `epro (${real} 真 / ${missing} 回落引脚云)` : 'epro';
    issues.push({ level: missing ? 'warn' : 'info', code: 'bbox-source', msg: `外形来源: ${bboxSource}` });
  }

  page.__overlaps = applyTally(computeOverlaps(page, C), tally);

  const waivers = loadWaivers();
  let suppressed = 0;

  const ruleResults = R.rules.map(rule => {
    const missing = (rule.requires || []).filter(k => !caps[k]);
    if (missing.length) return { id: rule.id, severity: rule.severity, weight: rule.weight, desc: rule.desc, status: 'skipped', count: 0, items: [], missing };

    // A grid of 1 makes this rule vacuous - every integer is a multiple of 1, so
    // it would report "clean" no matter how ragged the drawing is. Grid inference
    // is a page-level heuristic and does collapse to 1 after heavy edits (D33),
    // so refuse to run rather than pass silently.
    if (rule.id === 'grid-off') {
      const g = page.grid || C.grid;
      if (!g || g <= 1) {
        return { id: rule.id, severity: rule.severity, weight: rule.weight, desc: rule.desc, status: 'skipped', count: 0, items: [], missing: ['栅格推断退化为 1，本规则无意义；用 --grid 指定后重跑'] };
      }
    }
    const impl = RULE_IMPL[rule.id];
    if (!impl) return { id: rule.id, severity: rule.severity, weight: rule.weight, desc: rule.desc, status: 'skipped', count: 0, items: [], missing: ['实现缺失'] };
    try {
      let items = impl(page, C) || [];
      const before = items.length;
      items = items.filter(it => !isWaived(waivers, rule.id, it));
      suppressed += before - items.length;
      return { id: rule.id, severity: rule.severity, weight: rule.weight, desc: rule.desc, status: items.length ? 'fail' : 'pass', count: items.length, items };
    } catch (e) {
      return { id: rule.id, severity: rule.severity, weight: rule.weight, desc: rule.desc, status: 'skipped', count: 0, items: [], missing: [`执行异常: ${e.message}`] };
    }
  });

  const metrics = computeMetrics(page);
  const score = scoreOf(ruleResults, metrics, R);

  for (const r of ruleResults) {
    const def = R.rules.find(x => x.id === r.id);
    r.geometry = def ? (def.geometry || 'exact') : 'exact';
  }

  const rep = {
    schemaVersion: page.schemaVersion,
    skillVersion: C.version,
    rulesVersion: R.version,
    file,
    source: page.source,
    capabilities: caps,
    pageIssues: issues,
    rules: ruleResults,
    metrics,
    bboxSource,
    suppressed,
    score: { ...score, calibrated: false }
  };

  return rep;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.files.length) {
    console.log(`用法: sch-lint <page.json> [更多 page.json ...] [--json|--md] [-v]
              [--symbols symbols.json] [--rules ...] [--constants ...]

给多个页面时，'同型号重叠比例' 的统计跨全部页面进行——画法习惯是跨页的，
只看单页会把设计间距误判成碰撞（D28）。

退出码: 0 通过 / 1 有 error 级问题 / 2 输入或内部错误`);
    process.exit(args.help ? 0 : 2);
  }
  for (const f of args.files) {
    if (!existsSync(f)) { console.error(`找不到页面文件: ${f}`); process.exit(2); }
  }

  const R = readJson(args.rules ? resolve(args.rules) : join(ROOT, 'rules/lint-rules.json'));
  const C = readJson(args.constants ? resolve(args.constants) : join(ROOT, 'rules/constants.json'));
  const symbols = args.symbols ? readJson(resolve(args.symbols)).symbols : null;

  // First pass: compute overlap ratios for every page so the style tally is global.
  const perPage = args.files.map(f => {
    const { page } = loadPage(f);
    if (symbols) {
      for (const c of page.components) {
        const s = symbols[c.symbolUuid];
        const box = s ? bboxToPage(s.bbox, c) : null;
        if (box && box.w > 0 && box.h > 0) c.bbox = box;
      }
    }
    return computeOverlaps(page, C);
  });
  const tally = overlapTally(perPage);

  let anyError = false;
  const reps = [];
  for (const f of args.files) {
    const rep = runOne(f, args, R, C, symbols, tally);
    reps.push(rep);
    if (rep.rules.some(r => r.status === 'fail' && r.severity === 'error')) anyError = true;
  }

  if (args.format === 'json') console.log(JSON.stringify(reps.length === 1 ? reps[0] : reps, null, 2));
  else if (args.format === 'md') reps.forEach(r => console.log(renderMd(r)));
  else reps.forEach((r, i) => { if (i) console.log(''); console.log(renderText(r, args.verbose)); });

  process.exit(anyError ? 1 : 0);
}

main();
