#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PORTS = Array.from({ length: 10 }, (_, i) => 49620 + i);

function parseArgs(argv) {
  const a = { out: null, port: null, script: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--out' || t === '-o') a.out = argv[++i];
    else if (t === '--port') a.port = Number(argv[++i]);
    else if (t === '--script') a.script = argv[++i];
    else if (t === '--help' || t === '-h') a.help = true;
  }
  return a;
}

async function findBridge() {
  for (const port of PORTS) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
      const j = await r.json();
      if (j && j.service === 'easyeda-bridge') return { port, health: j };
    } catch { /* port closed */ }
  }
  return null;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`用法: sch-dump [--out page.json] [--port 49620] [--script scripts/eda/dump-page.js]

需要 EasyEDA Pro 打开着，并已加载 run-api-gateway.eext 扩展。
工具会自动在 49620-49629 扫描 bridge。`);
  process.exit(0);
}

const found = await findBridge();
if (!found) {
  console.error('找不到 bridge（49620-49629 均无响应）。');
  console.error('先启动: node "' + join(ROOT, '..', 'easyeda-api__skillhub', 'scripts/bridge-server.mjs') + '"');
  console.error('并在 EasyEDA 中加载 run-api-gateway.eext 扩展。');
  process.exit(2);
}
if (!found.health.edaConnected) {
  console.error(`bridge 在 ${found.port} 上，但 EDA 未连接（edaConnected=false）。`);
  console.error('请在 EasyEDA 专业版中安装并加载 run-api-gateway.eext：https://ext.lceda.cn/item/oshwhub/run-api-gateway');
  process.exit(2);
}

const scriptPath = args.script ? resolve(args.script) : join(HERE, 'eda/dump-page.js');
const code = readFileSync(scriptPath, 'utf8');

const res = await fetch(`http://127.0.0.1:${found.port}/execute`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code }),
  signal: AbortSignal.timeout(120000)
});
const payload = await res.json();

if (!payload.success) {
  console.error('dump 失败:', payload.error || JSON.stringify(payload).slice(0, 500));
  process.exit(1);
}

const page = payload.result;
const outPath = args.out || join(ROOT, 'out/page.json');
writeFileSync(outPath, JSON.stringify(page, null, 2) + '\n', 'utf8');

const pins = page.components.reduce((s, c) => s + c.pins.length, 0);
const segs = page.wires.reduce((s, w) => s + w.segments.length, 0);
console.log(`页面 ${page.source.project} / ${page.source.page} → ${outPath}`);
console.log(`  元件 ${page.components.length} · 引脚 ${pins} · 导线 ${page.wires.length}（${segs} 段）`);
console.log(`  标签 ${page.labels.length} · 文本 ${page.texts.length} · 推断栅格 ${page.grid ?? '未知'}`);
const kinds = {};
for (const l of page.labels) kinds[l.kind] = (kinds[l.kind] || 0) + 1;
if (Object.keys(kinds).length) console.log(`  标签类型 ${JSON.stringify(kinds)}`);
