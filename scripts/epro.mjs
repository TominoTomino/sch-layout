#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

function parseArgs(argv) {
  const a = { file: null, out: null, keep: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--out' || t === '-o') a.out = argv[++i];
    else if (t === '--keep') a.keep = true;
    else if (t === '--quiet' || t === '-q') a.quiet = true;
    else if (t === '--help' || t === '-h') a.help = true;
    else if (!t.startsWith('-')) a.file = t;
  }
  return a;
}

function extract(eproPath, dest) {
  mkdirSync(dest, { recursive: true });
  // Windows bsdtar and unzip both handle these archives; try both.
  for (const [cmd, args] of [
    ['tar', ['-xf', eproPath, '-C', dest]],
    ['unzip', ['-o', '-q', eproPath, '-d', dest]]
  ]) {
    const r = spawnSync(cmd, args, { stdio: 'ignore' });
    if (r.status === 0) return cmd;
  }
  throw new Error('解压失败：tar 与 unzip 都不可用');
}

// .esym is one JSON array per line: ["PART", name, {BBOX:[...]}] / ["PIN", ...] / ["POLY", ...]
function parseEsym(text) {
  const out = { partName: null, bbox: null, pins: [], polys: 0, lines: 0 };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('[')) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    out.lines++;
    const kind = rec[0];
    if (kind === 'PART') {
      out.partName = rec[1];
      const meta = rec[2];
      if (meta && Array.isArray(meta.BBOX)) out.bbox = meta.BBOX;
    } else if (kind === 'PIN') {
      out.pins.push({ id: rec[1], x: rec[4], y: rec[5], len: rec[6], rotation: rec[7] });
    } else if (kind === 'POLY') {
      out.polys++;
    }
  }
  return out;
}

export function loadSymbols(eproPath, opts = {}) {
  const work = opts.workdir || join(ROOT, 'out/symbols-work');
  if (existsSync(work) && !opts.keep) rmSync(work, { recursive: true, force: true });
  const how = extract(eproPath, work);
  const dir = join(work, 'SYMBOL');
  if (!existsSync(dir)) throw new Error('压缩包里没有 SYMBOL/ 目录');

  const symbols = {};
  let withBbox = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.esym')) continue;
    const uuid = basename(f, '.esym');
    const s = parseEsym(readFileSync(join(dir, f), 'utf8'));
    symbols[uuid] = s;
    if (s.bbox) withBbox++;
  }
  return { symbols, meta: { archive: eproPath, extractedWith: how, dir, count: Object.keys(symbols).length, withBbox } };
}

// Symbol-local bbox -> page-space rect, honouring rotation and mirror.
// Units are identical (0.01in) in both spaces; verified against the A3 frame
// whose symbol bbox is 1633x1150 on a 1655x1170 page.
export function bboxToPage(symBbox, comp) {
  if (!symBbox) return null;
  const [x0, y0, x1, y1] = symBbox;
  const rot = ((comp.rotation ?? 0) % 360 + 360) % 360;
  const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => {
    let px = comp.mirror ? -x : x;
    let py = y;
    switch (rot) {
      case 90: [px, py] = [-py, px]; break;
      case 180: [px, py] = [-px, -py]; break;
      case 270: [px, py] = [py, -px]; break;
      default: break;
    }
    return [px + comp.x, py + comp.y];
  });
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const bx = Math.min(...xs), by = Math.min(...ys);
  return { x: bx, y: by, w: Math.max(...xs) - bx, h: Math.max(...ys) - by };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.file) {
    console.log(`用法: sch-epro <project.epro> [--out out/symbols.json] [--keep]

把立创EDA导出的工程包解开，解析 SYMBOL/*.esym 里的真实外框与引脚。
-esym 是逐行 JSON：["PART", 名称, {BBOX:[x0,y0,x1,y1]}] / ["PIN",...] / ["POLY",...]

导出方式（在 EDA 内执行）：
  const p = await eda.dmt_Project.getCurrentProjectInfo();
  const f = await eda.sys_FileManager.getProjectFileByProjectUuid(p.uuid, 'proj', undefined, 'epro');
  await eda.sys_FileSystem.saveFile(f, 'proj.epro');   // 落到浏览器下载目录`);
    process.exit(args.help ? 0 : 2);
  }
  const { symbols, meta } = loadSymbols(resolve(args.file), { keep: args.keep });
  const outPath = args.out || join(ROOT, 'out/symbols.json');
  writeFileSync(outPath, JSON.stringify({ meta, symbols }, null, 2) + '\n', 'utf8');
  if (!args.quiet) {
    console.log(`符号 ${meta.count} 个，其中有 BBOX 的 ${meta.withBbox} 个 → ${outPath}`);
    if (meta.count !== meta.withBbox) console.log(`  注意: ${meta.count - meta.withBbox} 个没有 BBOX，需回落到引脚云`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('epro.mjs')) main();
