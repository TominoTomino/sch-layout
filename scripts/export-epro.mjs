#!/usr/bin/env node
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { loadSymbols } from './epro.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PORTS = Array.from({ length: 10 }, (_, i) => 49620 + i);

function parseArgs(argv) {
  const a = { out: null, epro: null, timeout: 90, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--out' || t === '-o') a.out = argv[++i];
    else if (t === '--epro') a.epro = argv[++i];
    else if (t === '--timeout') a.timeout = Number(argv[++i]);
    else if (t === '--quiet' || t === '-q') a.quiet = true;
    else if (t === '--help' || t === '-h') a.help = true;
  }
  return a;
}

async function findBridge() {
  for (const port of PORTS) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1200) });
      const j = await r.json();
      if (j && j.service === 'easyeda-bridge' && j.edaConnected) return port;
    } catch { /* closed */ }
  }
  return null;
}

const DOWNLOAD_DIRS = [
  join(homedir(), 'Downloads'),
  join(homedir(), 'Desktop'),
  join(homedir(), 'Documents')
];

function findNewest(name, since) {
  let best = null;
  for (const d of DOWNLOAD_DIRS) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      if (!f.startsWith(name)) continue;
      const p = join(d, f);
      try {
        const st = statSync(p);
        if (st.mtimeMs >= since - 2000 && (!best || st.mtimeMs > best.mtime)) {
          best = { path: p, mtime: st.mtimeMs, size: st.size };
        }
      } catch { /* vanished */ }
    }
  }
  return best;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`用法: sch-export-epro [--out out/symbols.json] [--epro 已有.epro路径]

两种用法：
  1. 不传 --epro：让 EasyEDA 导出当前工程，等文件落到下载目录，再解析
  2. 传 --epro：直接解析一个已有的工程包（离线可用）

产物是 symbols.json：{ uuid: { bbox, pins, polys } }，供 lint --symbols 使用。`);
  process.exit(0);
}

if (!args.epro) {
  const port = await findBridge();
  if (!port) {
    console.error('找不到已连接的 bridge。先启动 bridge 并加载 run-api-gateway 扩展。');
    process.exit(2);
  }
  const stamp = Date.now();
  const name = `schsym_${stamp}`;
  const code = `const p = await eda.dmt_Project.getCurrentProjectInfo();
const f = await eda.sys_FileManager.getProjectFileByProjectUuid(p.uuid, '${name}', undefined, 'epro');
if (!f) return { error: 'export returned no file' };
await eda.sys_FileSystem.saveFile(f, '${name}.epro');
return { project: p.friendlyName || p.name, size: f.size };`;

  const before = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(180000)
  });
  const payload = await res.json();
  if (!payload.success) {
    console.error('导出失败:', payload.error || JSON.stringify(payload).slice(0, 300));
    process.exit(1);
  }
  if (!args.quiet) console.error(`工程 ${payload.result.project} 已导出 ${(payload.result.size / 1048576).toFixed(1)}MB，等待落盘…`);

  const deadline = Date.now() + args.timeout * 1000;
  let found = null;
  while (Date.now() < deadline) {
    found = findNewest(name, before);
    if (found && found.size === payload.result.size) break;
    await new Promise(r => setTimeout(r, 600));
  }
  if (!found) {
    console.error(`等了 ${args.timeout}s 没在下载目录找到 ${name}.epro`);
    console.error(`找过: ${DOWNLOAD_DIRS.join(' / ')}`);
    process.exit(1);
  }
  if (!args.quiet) console.error(`落盘: ${found.path}`);
  args.epro = found.path;
}

const { symbols, meta } = loadSymbols(resolve(args.epro));
const outPath = args.out || join(ROOT, 'out/symbols.json');
writeFileSync(outPath, JSON.stringify({ meta, symbols }, null, 2) + '\n', 'utf8');
console.log(`符号 ${meta.count} 个（有 BBOX ${meta.withBbox}）→ ${outPath}`);
