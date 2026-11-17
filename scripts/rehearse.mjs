#!/usr/bin/env node
// Rehearse a write operation on a disposable copy of a project.
//
// The operating rule established in design-notes D32: never write to a real
// drawing first. Import a copy (D29), run the operation there, compare lint
// before/after and read the netlist verdict, show the user - only then touch
// the original.
//
// This script automates that whole loop so the rehearsal costs a command
// instead of a checklist.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = join(ROOT, 'out/rehearsal');
const PORTS = Array.from({ length: 10 }, (_, i) => 49620 + i);

function parseArgs(argv) {
  const a = { project: null, name: null, grid: 5, op: 'snap-grid', maxPages: 3, port: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--project') a.project = argv[++i];
    else if (t === '--name') a.name = argv[++i];
    else if (t === '--grid') a.grid = Number(argv[++i]);
    else if (t === '--op') a.op = argv[++i];
    else if (t === '--max-pages') a.maxPages = Number(argv[++i]);
    else if (t === '--port') a.port = Number(argv[++i]);
    else if (t === '--help' || t === '-h') a.help = true;
  }
  return a;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function findBridge(preferred) {
  const ports = preferred ? [preferred, ...PORTS.filter((p) => p !== preferred)] : PORTS;
  for (const port of ports) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
      const j = await r.json();
      if (j && j.service === 'easyeda-bridge') return { port, health: j };
    } catch { /* port closed */ }
  }
  return null;
}

async function exec(port, code) {
  const r = await fetch(`http://127.0.0.1:${port}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(28000)
  });
  const j = await r.json();
  if (!j.success) throw new Error(j.error || 'execute failed');
  return j.result;
}

// lint exits 1 when it finds errors and apply exits 1 when it rolls back, so a
// non-zero exit is a normal result here, not a crash. Only the absence of output
// is a real failure.
function cli(args) {
  try {
    return execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    if (e.stdout && String(e.stdout).trim()) return String(e.stdout);
    throw e;
  }
}

// --- 1. copy the project -------------------------------------------------
const NAME_RE = /[^a-zA-Z0-9-]/g;

async function findCopy(port, name) {
  const r = await exec(port, `
    const p = await eda.dmt_Project.getCurrentProjectInfo();
    const ids = await eda.dmt_Project.getAllProjectsUuid(p.teamUuid);
    const rows = [];
    for (const id of ids || []) {
      const it = await eda.dmt_Project.getProjectInfo(id);
      if (it && String(it.friendlyName || '') === ${JSON.stringify(name)}) rows.push(id);
    }
    return { ids: rows };
  `);
  return r && r.ids && r.ids.length ? r.ids[0] : null;
}

async function importCopy(port, projectUuid, name) {
  // Reuse an existing rehearsal copy instead of piling up new ones on every run.
  const existing = await findCopy(port, name);
  if (existing) return { uuid: existing, reused: true };

  // A 6 MB import outlives the bridge's 30 s request budget, so start it and
  // watch the project list instead of awaiting the call (D29).
  await exec(port, `
    const full = await eda.dmt_Project.getCurrentProjectInfo();
    let f = await eda.sys_FileManager.getProjectFileByProjectUuid('${projectUuid}', 'rehearsal_src', undefined, 'epro');
    if (!f) {
      await eda.dmt_Project.openProject('${projectUuid}');
      await new Promise(r => setTimeout(r, 2500));
      f = await eda.sys_FileManager.getProjectFileByProjectUuid('${projectUuid}', 'rehearsal_src', undefined, 'epro');
    }
    if (!f) throw new Error('project file unavailable');
    eda.sys_FileManager.importProjectByProjectFile(f, 'JLCEDA Pro',
      { importOption: 'ImportDocumentExtractLibraries', associateFootprint: true },
      { operation: 'New Project', newProjectOwnerTeamUuid: full.teamUuid,
        newProjectName: ${JSON.stringify(name)}, newProjectFriendlyName: ${JSON.stringify(name)},
        newProjectDescription: 'sch-layout 彩排副本，可随时删除' },
      { ownerTeamUuid: full.teamUuid, createDeviceForSingleSymbol: true })
      .catch(() => {});
    return { started: true };
  `);

  const deadline = Date.now() + 6 * 60 * 1000;
  while (Date.now() < deadline) {
    await wait(8000);
    process.stdout.write('.');
    const hit = await findCopy(port, name);
    if (hit) return { uuid: hit, reused: false };
  }
  throw new Error('副本创建超时（6 分钟）');
}

// --- 2. rehearse one page ------------------------------------------------
function lintOf(file, symbols) {
  const args = ['scripts/lint.mjs', file, '--json'];
  if (symbols) args.push('--symbols', symbols);
  const rep = JSON.parse(cli(args));
  const r = Array.isArray(rep) ? rep[0] : rep;
  const rule = (id) => r.rules.find((x) => x.id === id) || { count: 0, status: 'pass' };
  return {
    score: r.score.score,
    grade: r.score.grade,
    grid: r.metrics.counts.grid ?? null,
    components: r.metrics.counts.components,
    gridOff: rule('grid-off').count,
    gridOffStatus: rule('grid-off').status,
    errors: r.rules.filter((x) => x.status === 'fail' && x.severity === 'error').map((x) => `${x.id}×${x.count}`)
  };
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.project) {
  console.log(`用法: node scripts/rehearse.mjs --project <uuid> [--name SCHLAYOUT-REHEARSAL]
                [--grid 5] [--max-pages 3] [--port 49620]

流程: 导入副本 → 逐页 dump/lint → 在副本上执行写操作 → 再 dump/lint → 出对比。
原工程全程只读。副本用完需手动删除（API 没有删工程接口）。`);
  process.exit(args.help ? 0 : 2);
}

const name = args.name || 'SCHLAYOUT-REHEARSAL';
mkdirSync(OUT, { recursive: true });

const found = await findBridge(args.port);
if (!found) { console.error('找不到 bridge。'); process.exit(2); }
if (!found.health.edaConnected) {
  console.error('EDA 未连接（edaConnected=false）。请在 EasyEDA 里重新加载 run-api-gateway 扩展。');
  process.exit(2);
}
console.log(`bridge ${found.port} · 工程 ${args.project} → 副本 ${name}`);

const copy = await importCopy(found.port, args.project, name);
const copyUuid = copy.uuid;
console.log(`\n副本${copy.reused ? '（复用已有）' : '已建'}: ${copyUuid}`);

await exec(found.port, `await eda.dmt_Project.openProject('${copyUuid}'); await new Promise(r => setTimeout(r, 3000)); return true;`);
const pages = await exec(found.port, `
  const all = await eda.dmt_Schematic.getAllSchematicPagesInfo();
  return (all || []).map(x => ({ name: x.name, uuid: x.uuid }));
`);
console.log(`副本页数 ${pages.length}`);

// symbols for the copy: its own export, since uuids are regenerated on import
let symbols = null;
try {
  cli(['scripts/export-epro.mjs', '--out', 'out/rehearsal/symbols.json']);
  if (existsSync(join(OUT, 'symbols.json'))) symbols = 'out/rehearsal/symbols.json';
} catch (e) {
  console.log('符号导出失败，改用引脚云近似（overlap 会不准）:', String(e.message).split('\n')[0]);
}

const rows = [];
let done = 0;
for (let i = 0; i < pages.length && done < args.maxPages; i++) {
  const p = pages[i];
  const before = join(OUT, `p${i + 1}-before.json`);
  const after = join(OUT, `p${i + 1}-after.json`);
  try {
    cli(['scripts/dump.mjs', '--page', p.uuid, '--out', before]);
  } catch (e) {
    console.log(`  第 ${i + 1} 页 dump 失败: ${String(e.message).split('\n')[0]}`);
    continue;
  }
  const b = lintOf(before, symbols);
  if (b.gridOff === 0) {
    rows.push({ name: p.name, index: i + 1, before: b, after: null, skipped: '无脱栅格点' });
    continue;
  }
  done++;

  let applyOut = '';
  try {
    applyOut = cli(['scripts/apply.mjs', before, '--grid', String(args.grid), '--op', args.op,
      '--page', p.uuid, '--commit']);
  } catch (e) {
    applyOut = String(e.stdout || '') + String(e.stderr || '');
  }
  if (!applyOut.trim()) applyOut = '（apply 无输出）';
  const okPass = /网表校验:\s*通过/.test(applyOut);
  const rebuilt = (applyOut.match(/重建导线 (\d+)/) || [])[1] || '?';
  const residual = (applyOut.match(/回滚后残留差异:\s*(\d+)/) || [])[1];

  cli(['scripts/dump.mjs', '--page', p.uuid, '--out', after]);
  const a = lintOf(after, symbols);
  rows.push({ name: p.name, index: i + 1, before: b, after: a, okPass, rebuilt, residual, applyOut });
}

// --- 3. report -----------------------------------------------------------
console.log('\n彩排结果');
console.log('页            元件  grid-off   分数            网表  重建');
for (const r of rows) {
  const nm = String(r.name || '?').slice(0, 10).padEnd(10);
  if (r.skipped) {
    console.log(`${nm} ${String(r.before.components).padStart(4)}  ${String(r.before.gridOff).padStart(4)}        ${r.before.score.toFixed(1)} →  (${r.skipped})`);
    continue;
  }
  const arrow = `${r.before.score.toFixed(1)} → ${r.after.score.toFixed(1)}`;
  console.log(`${nm} ${String(r.before.components).padStart(4)}  ${String(r.before.gridOff).padStart(4)}→${String(r.after.gridOff).padStart(2)}   ${arrow.padEnd(16)} ${r.okPass ? '通过' : '失败'}  ${r.rebuilt}`);
}

const touched = rows.filter((r) => r.after);
const bad = touched.filter((r) => !r.okPass || (r.residual && r.residual !== '0'));
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(rows.map(({ applyOut, ...r }) => r), null, 2) + '\n', 'utf8');

console.log(`\n改了 ${touched.length} 页，其中 ${bad.length} 页需要人工看。`);
if (bad.length) {
  for (const r of bad) {
    console.log(`\n--- 第 ${r.index} 页 ${r.name} ---`);
    console.log(String(r.applyOut).split('\n').slice(-8).join('\n'));
  }
  process.exit(1);
}
console.log(`\n副本工程 ${name}（${copyUuid}）保留着，可打开人工核对；确认无损后再决定是否动原工程。`);
