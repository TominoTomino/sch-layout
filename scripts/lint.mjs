#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isOrthogonal, rectsOverlap, rectContainsPoint, segmentCrossesRect,
  properCrossing, countBends, polylineLength, deflate, median
} from './lib/geometry.mjs';
import {
  loadPage, indexPins, wireSegments, buildEndpointIndex, capabilities,
  contentBBox, labelBBox
} from './lib/page.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const SEVERITY_RANK = { error: 0, warn: 1, info: 2 };

function parseArgs(argv) {
  const args = { file: null, format: 'text', verbose: false, rules: null, constants: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.format = 'json';
    else if (a === '--md') args.format = 'md';
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '--rules') args.rules = argv[++i];
    else if (a === '--constants') args.constants = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else if (!a.startsWith('-')) args.file = a;
  }
  return args;
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function fmt(n, d = 1) {
  return Number.isFinite(n) ? Number(n.toFixed(d)) : '-';
}

// ---------- rules ----------

const RULE_IMPL = {
  'grid-off': (page, C) => {
    const g = page.grid || C.grid;
    const items = [];
    for (const c of page.components) {
      if (Math.abs(c.x % g) > 1e-6 || Math.abs(c.y % g) > 1e-6) {
        items.push({ ref: c.designator || c.id, detail: `元件原点 (${c.x}, ${c.y}) 不在 ${g} 栅格` });
      }
      for (const p of c.pins || []) {
        if (Math.abs(p.x % g) > 1e-6 || Math.abs(p.y % g) > 1e-6) {
          items.push({ ref: `${c.designator}.${p.num}`, detail: `引脚 (${p.x}, ${p.y}) 不在 ${g} 栅格` });
        }
      }
    }
    for (const w of page.wires) {
      for (const p of w.points) {
        if (Math.abs(p[0] % g) > 1e-6 || Math.abs(p[1] % g) > 1e-6) {
          items.push({ ref: `wire:${w.id}`, detail: `导线点 (${p[0]}, ${p[1]}) 不在 ${g} 栅格` });
        }
      }
    }
    return items;
  },

  'overlap': (page) => {
    const items = [];
    const cs = page.components.filter(c => c.bbox && (c.bbox.w || c.bbox.h));
    for (let i = 0; i < cs.length; i++) {
      for (let j = i + 1; j < cs.length; j++) {
        if (rectsOverlap(cs[i].bbox, cs[j].bbox, 0.5)) {
          items.push({
            ref: `${cs[i].designator || cs[i].id} / ${cs[j].designator || cs[j].id}`,
            detail: '包围盒相交'
          });
        }
      }
    }
    return items;
  },

  'dangling-wire': (page) => {
    const idx = buildEndpointIndex(page);
    const items = [];
    for (const w of page.wires) {
      if (w.points.length < 2) {
        items.push({ ref: `wire:${w.id}`, detail: '导线少于两个点' });
        continue;
      }
      for (const [tag, pt] of [['起点', w.points[0]], ['终点', w.points[w.points.length - 1]]]) {
        const hits = idx.lookup(pt).filter(h => !(h.kind === 'wire-end' && h.ref.wireId === w.id));
        if (!hits.length) {
          items.push({ ref: `wire:${w.id}`, detail: `${tag} (${pt[0]}, ${pt[1]}) 悬空，未落在引脚/导线端点/标签上` });
        }
      }
    }
    return items;
  },

  'diagonal': (page) => {
    const items = [];
    for (const w of page.wires) {
      for (let i = 1; i < w.points.length; i++) {
        if (!isOrthogonal(w.points[i - 1], w.points[i])) {
          items.push({ ref: `wire:${w.id}`, detail: `第 ${i} 段为斜线` });
        }
      }
    }
    return items;
  },

  'too-many-bends': (page, C) => {
    const max = C.routing.maxBendsPerWire;
    const items = [];
    for (const w of page.wires) {
      const b = countBends(w.points);
      if (b > max) items.push({ ref: `wire:${w.id}`, detail: `${b} 个拐点，上限 ${max}` });
    }
    return items;
  },

  'wire-through-body': (page, C) => {
    const inset = C.grid;
    const minLen = C.grid * 2;
    const items = [];
    const pinSet = new Set();
    for (const c of page.components) {
      for (const p of c.pins || []) pinSet.add(`${Math.round(p.x)}|${Math.round(p.y)}|${c.id}`);
    }
    for (const w of page.wires) {
      for (let i = 1; i < w.points.length; i++) {
        const a = w.points[i - 1], b = w.points[i];
        for (const c of page.components) {
          if (!c.bbox) continue;
          const ownsA = pinSet.has(`${Math.round(a[0])}|${Math.round(a[1])}|${c.id}`);
          const ownsB = pinSet.has(`${Math.round(b[0])}|${Math.round(b[1])}|${c.id}`);
          if (ownsA && ownsB) continue;
          const shrink = deflate(c.bbox, inset);
          if (!shrink) continue;
          if ((ownsA || ownsB) && (rectContainsPoint(shrink, a) || rectContainsPoint(shrink, b))) continue;
          if (segmentCrossesRect(a, b, c.bbox, minLen, inset)) {
            items.push({
              ref: `wire:${w.id} → ${c.designator || c.id}`,
              detail: `第 ${i} 段穿过元件本体（包围盒内缩 ${inset} 判定，可能误报）`
            });
          }
        }
      }
    }
    return items;
  },

  'density': (page, C) => {
    const max = C.limits.maxComponentsPerPage;
    const n = page.components.length;
    return n > max ? [{ ref: 'page', detail: `${n} 个元件，上限 ${max}，建议拆页` }] : [];
  },

  'label-overlap': (page) => {
    const items = [];
    const lb = page.labels.map(l => ({ l, r: labelBBox(l) }));
    for (const { l, r } of lb) {
      for (const c of page.components) {
        if (c.bbox && rectsOverlap(r, c.bbox, 0.5)) {
          items.push({ ref: `label:${l.id}`, detail: `标签 "${l.text}" 压在 ${c.designator || c.id} 上` });
        }
      }
      for (const w of page.wires) {
        // A label anchored on a wire endpoint is normal, not a defect.
        const anchored = w.points.some(p => Math.abs(p[0] - l.x) <= 1 && Math.abs(p[1] - l.y) <= 1);
        if (anchored) continue;
        let hit = false;
        for (let i = 1; i < w.points.length && !hit; i++) {
          if (segmentCrossesRect(w.points[i - 1], w.points[i], r, 1, 0)) hit = true;
        }
        if (hit) items.push({ ref: `label:${l.id}`, detail: `标签 "${l.text}" 压在 wire:${w.id} 上` });
      }
    }
    return items;
  }
};

// ---------- metrics ----------

function computeMetrics(page) {
  const segs = wireSegments(page);
  let crossings = 0;
  const byWire = new Map();
  for (const s of segs) {
    if (!byWire.has(s.wireId)) byWire.set(s.wireId, []);
    byWire.get(s.wireId).push(s);
  }
  const wireIds = [...byWire.keys()];
  for (let i = 0; i < wireIds.length; i++) {
    for (let j = i + 1; j < wireIds.length; j++) {
      const A = byWire.get(wireIds[i]), B = byWire.get(wireIds[j]);
      const netA = A[0]?.net, netB = B[0]?.net;
      if (netA && netB && netA === netB) continue;
      for (const a of A) for (const b of B) if (properCrossing(a.a, a.b, b.a, b.b)) crossings++;
    }
  }

  let bends = 0, wireLength = 0;
  for (const w of page.wires) {
    bends += countBends(w.points);
    wireLength += polylineLength(w.points);
  }

  const cb = contentBBox(page);
  const contentArea = Math.max(cb.w * cb.h, 1);
  const sumComp = page.components.reduce((s, c) => s + (c.bbox ? c.bbox.w * c.bbox.h : 0), 0);
  const compactness = Math.min(sumComp / contentArea, 1);

  const n = Math.max(page.components.length, 1);
  return {
    crossings, bends, wireLength, compactness,
    perComponent: {
      crossings: crossings / n,
      bends: bends / n,
      wireLength: wireLength / n
    },
    counts: {
      components: page.components.length,
      wires: page.wires.length,
      labels: page.labels.length,
      segments: segs.length
    },
    contentBox: cb
  };
}

function scoreOf(ruleResults, metrics, R) {
  const mult = R.scoring.severityMult;
  let violationPenalty = 0;
  for (const r of ruleResults) {
    if (r.status !== 'fail') continue;
    violationPenalty += r.weight * (mult[r.severity] ?? 0.5) * 4 * Math.log2(1 + r.count);
  }

  const ref = R.scoring.metricReference;
  const norm = {
    crossings: Math.min(metrics.perComponent.crossings / ref.crossings_perComponent, 1.5),
    bends: Math.min(metrics.perComponent.bends / ref.bends_perComponent, 1.5),
    wireLength: Math.min(metrics.perComponent.wireLength / ref.wireLength_perComponent, 1.5),
    compactness: Math.max(0, 1 - metrics.compactness / ref.compactness_idealMin)
  };

  let metricPenalty = 0;
  for (const m of R.metrics) metricPenalty += m.weight * (norm[m.id] ?? 0) * 40;

  const score = Math.max(0, Math.min(100, 100 - violationPenalty - metricPenalty));
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : 'D';
  return { score, grade, violationPenalty, metricPenalty, normalized: norm };
}

// ---------- report ----------

function renderText(rep, verbose) {
  const L = [];
  L.push(`原理图可读性报告  ${rep.source?.project || ''} ${rep.source?.page || ''}`.trim());
  L.push(`skill v${rep.skillVersion} · 规则 v${rep.rulesVersion}`);
  L.push('');
  L.push(`总分 ${fmt(rep.score.score)} / 100  (${rep.score.grade})${rep.score.calibrated ? '' : '  [权重未校准]'}`);
  L.push(`元件 ${rep.metrics.counts.components} · 导线 ${rep.metrics.counts.wires} · 标签 ${rep.metrics.counts.labels}`);
  L.push('');
  const failed = rep.rules.filter(r => r.status === 'fail');
  const skipped = rep.rules.filter(r => r.status === 'skipped');
  if (!failed.length) {
    L.push('全部检查通过。');
  } else {
    L.push(`问题（${failed.length} 项）`);
    for (const r of failed.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])) {
      L.push(`  [${r.severity}] ${r.id}  ×${r.count}  — ${r.desc}`);
      if (verbose) for (const it of r.items.slice(0, 10)) L.push(`      · ${it.ref}: ${it.detail}`);
    }
  }
  if (skipped.length) {
    L.push('');
    L.push(`跳过（${skipped.length} 项，缺数据）`);
    for (const r of skipped) L.push(`  ${r.id} — 需要 ${r.missing.join(', ')}`);
  }
  L.push('');
  L.push('指标');
  L.push(`  交叉 ${rep.metrics.crossings} · 拐点 ${rep.metrics.bends} · 总线长 ${fmt(rep.metrics.wireLength, 0)} · 填充率 ${fmt(rep.metrics.compactness, 2)}`);
  if (rep.pageIssues?.length) {
    L.push('');
    L.push('数据质量');
    for (const i of rep.pageIssues) L.push(`  [${i.level}] ${i.code}: ${i.msg}`);
  }
  return L.join('\n');
}

function renderMd(rep) {
  const L = [];
  L.push(`## 原理图可读性报告`);
  L.push('');
  L.push(`**${fmt(rep.score.score)} / 100 (${rep.score.grade})**${rep.score.calibrated ? '' : ' · 权重未校准'}`);
  L.push('');
  L.push(`skill v${rep.skillVersion} · 规则 v${rep.rulesVersion} · 元件 ${rep.metrics.counts.components} · 导线 ${rep.metrics.counts.wires}`);
  L.push('');
  const failed = rep.rules.filter(r => r.status === 'fail');
  if (!failed.length) {
    L.push('全部检查通过。');
  } else {
    L.push('| 级别 | 检查项 | 次数 | 说明 |');
    L.push('|---|---|---|---|');
    for (const r of failed.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])) {
      L.push(`| ${r.severity} | \`${r.id}\` | ${r.count} | ${r.desc} |`);
    }
  }
  L.push('');
  L.push(`指标：交叉 ${rep.metrics.crossings} · 拐点 ${rep.metrics.bends} · 总线长 ${fmt(rep.metrics.wireLength, 0)} · 填充率 ${fmt(rep.metrics.compactness, 2)}`);
  return L.join('\n');
}

// ---------- main ----------

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.file) {
    console.log(`用法: sch-lint <page.json> [--json|--md] [-v] [--rules rules/lint-rules.json] [--constants rules/constants.json]

  <page.json>   页面 dump（见 docs/schema.md）
  --json        机器可读输出
  --md          Markdown 输出（适合贴到对话/手机查看）
  -v            展开每条问题的明细

退出码: 0 通过 / 1 有 error 级问题 / 2 输入或内部错误`);
    process.exit(args.help ? 0 : 2);
  }

  const rulesPath = args.rules ? resolve(args.rules) : join(ROOT, 'rules/lint-rules.json');
  const constPath = args.constants ? resolve(args.constants) : join(ROOT, 'rules/constants.json');
  if (!existsSync(args.file)) {
    console.error(`找不到页面文件: ${args.file}`);
    process.exit(2);
  }

  const R = readJson(rulesPath);
  const C = readJson(constPath);
  const { page, issues } = loadPage(args.file);
  const caps = capabilities(page);

  const ruleResults = R.rules.map(rule => {
    const missing = (rule.requires || []).filter(k => !caps[k]);
    if (missing.length) {
      return { id: rule.id, severity: rule.severity, weight: rule.weight, desc: rule.desc, status: 'skipped', count: 0, items: [], missing };
    }
    const impl = RULE_IMPL[rule.id];
    if (!impl) {
      return { id: rule.id, severity: rule.severity, weight: rule.weight, desc: rule.desc, status: 'skipped', count: 0, items: [], missing: ['实现缺失'] };
    }
    let items = [];
    try {
      items = impl(page, C) || [];
    } catch (e) {
      return { id: rule.id, severity: rule.severity, weight: rule.weight, desc: rule.desc, status: 'skipped', count: 0, items: [], missing: [`执行异常: ${e.message}`] };
    }
    return {
      id: rule.id, severity: rule.severity, weight: rule.weight, desc: rule.desc,
      status: items.length ? 'fail' : 'pass', count: items.length, items
    };
  });

  const metrics = computeMetrics(page);
  const score = scoreOf(ruleResults, metrics, R);

  const rep = {
    schemaVersion: '0.1.0',
    skillVersion: C.version,
    rulesVersion: R.version,
    file: args.file,
    source: page.source,
    capabilities: caps,
    pageIssues: issues,
    rules: ruleResults,
    metrics,
    score: { ...score, calibrated: false }
  };

  if (args.format === 'json') {
    console.log(JSON.stringify(rep, null, 2));
  } else if (args.format === 'md') {
    console.log(renderMd(rep));
  } else {
    console.log(renderText(rep, args.verbose));
  }

  const hasError = ruleResults.some(r => r.status === 'fail' && r.severity === 'error');
  process.exit(hasError ? 1 : 0);
}

main();
