#!/usr/bin/env node
// Netlist self-check.
//
// Everything downstream is drawn from this netlist, so a defect here becomes a
// defect in copper that a rendered schematic cannot show. Verification later can
// only prove "the drawing matches the netlist" - never "the netlist is right".
// This is the only place that can.
//
// Each check reports a verdict and locates the offenders by designator.pin.
// Exit 1 when anything blocks the next step.
//
//   node scripts/netcheck.mjs out/target.json
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const file = process.argv[2];
if (!file) {
  console.error('用法: node scripts/netcheck.mjs <page.json>');
  process.exit(2);
}
const page = JSON.parse(readFileSync(file, 'utf8'));

// ---- collect ---------------------------------------------------------------
const pins = [];
for (const c of page.components) {
  for (const p of c.pins || []) {
    pins.push({
      ref: `${c.designator}.${p.num}`,
      d: c.designator,
      num: String(p.num),
      name: p.name || '',
      net: p.net || '',
      nc: !!p.noConnected,
      x: p.x, y: p.y
    });
  }
}

const nets = new Map();
for (const p of pins) {
  if (!p.net) continue;
  if (!nets.has(p.net)) nets.set(p.net, []);
  nets.get(p.net).push(p);
}

// Supply nets are recognised by name; this is a heuristic, so a miss is reported
// as a warning rather than a failure.
const SUPPLY = /^(GND|AGND|PGND|DGND|VSS|VSSA|VCC|VDD|AVDD|DVDD|VBAT|VREF|VREF\+|\+?\d+V\d*|V\d+V\d*|3V3|5V|12V)$/i;
const AUTONET = /^\$\d*N\d+$|^NetC\d+_\d+$/i;
const BADNAME = /[\s，。【】、]|^$/;

// Pins that are genuinely allowed to be a one-pin net: test points and debug
// headers. Everything else with a single pin is a dangling intent.
const TESTPOINT = /^(TP|J|P|CN)\d/i;
const DEBUGNET = /^(DBG|TEST|DEBUG)_/i;

function verdict(ok, warnOnly = false) {
  return ok ? 'ok' : warnOnly ? 'warn' : 'fail';
}

const results = [];

// 1. duplicate designators ---------------------------------------------------
{
  const seen = new Map();
  for (const c of page.components) seen.set(c.designator, (seen.get(c.designator) || 0) + 1);
  const dup = [...seen.entries()].filter(([, n]) => n > 1).map(([d]) => d);
  results.push({ group: '结构', name: '位号唯一', state: verdict(!dup.length), detail: dup.length ? dup.join(' ') : `${page.components.length} 个` });
}

// 2. duplicate pin references ------------------------------------------------
{
  const seen = new Map();
  for (const p of pins) seen.set(p.ref, (seen.get(p.ref) || 0) + 1);
  const dup = [...seen.entries()].filter(([, n]) => n > 1).map(([r]) => r);
  results.push({ group: '结构', name: '引脚引用唯一', state: verdict(!dup.length), detail: dup.length ? dup.slice(0, 8).join(' ') : `${pins.length} 个` });
}

// 3. components without pins -------------------------------------------------
{
  const empty = page.components.filter((c) => !(c.pins || []).length).map((c) => c.designator);
  results.push({ group: '结构', name: '元件都有引脚', state: verdict(!empty.length), detail: empty.length ? empty.join(' ') : '—' });
}

// 4. pins with no net and no NC flag ----------------------------------------
{
  const bad = pins.filter((p) => !p.net && !p.nc);
  results.push({
    group: '连接', name: '无网络的引脚已标 NC',
    state: verdict(!bad.length),
    detail: bad.length ? `${bad.length} 个: ${bad.slice(0, 10).map((p) => p.ref).join(' ')}` : '—',
    items: bad.map((p) => p.ref)
  });
}

// 5. one-pin nets ------------------------------------------------------------
{
  const singles = [...nets.entries()].filter(([, list]) => list.length === 1)
    .filter(([, list]) => !TESTPOINT.test(list[0].d))
    // A one-pin net on a debug header is deliberate: a stub to clip a probe onto.
    .filter(([n]) => !DEBUGNET.test(n));
  results.push({
    group: '连接', name: '没有单引脚网络',
    state: verdict(!singles.length, singles.length > 0),
    detail: singles.length ? singles.map(([n, l]) => `${n}(${l[0].ref})`).join(' ') : '—',
    items: singles.map(([n]) => n)
  });
}

// 6. auto-generated net names ------------------------------------------------
// An auto name inside one functional block is normal - it is a node the reader
// reaches by following a wire. The same name spanning two blocks is a defect: the
// connection exists only as a string nobody can interpret.
{
  const BLOCK_OF = {};
  const BLOCKS = {
    A: ['J3', 'RV1', 'K1', 'Q1', 'R7', 'R19', 'D4'],
    B: ['MOV', 'CX', 'CY1', 'U1', 'C1', 'C2', 'LDM', 'R8', 'L2', 'C3', 'D1', 'C4', 'U4', 'C5', 'C6'],
    C: ['L1', 'R1', 'R2', 'R3', 'R4', 'R5', 'C8', 'C9', 'D2', 'J2', 'R6', 'C10', 'D3', 'U5', 'R9', 'C11', 'C12'],
    D: ['U3'],
    E: ['U2', 'DS1', 'DS2'],
    F: ['SW1', 'R14', 'SW2', 'R15', 'SW3', 'R16', 'SW4', 'R17', 'LED1', 'R10', 'LED2', 'R11', 'LED3', 'R12', 'LED4', 'R13']
  };
  for (const [id, list] of Object.entries(BLOCKS)) for (const d of list) BLOCK_OF[d] = id;

  const auto = [...nets.keys()].filter((n) => AUTONET.test(n));
  const spanning = [];
  for (const n of auto) {
    const blocks = new Set(nets.get(n).map((p) => BLOCK_OF[p.d] || '?'));
    if (blocks.size > 1) spanning.push(`${n}(${[...blocks].join('/')})`);
  }
  results.push({
    group: '命名', name: '自动网名未跨块',
    state: verdict(!spanning.length, spanning.length > 0),
    detail: auto.length
      ? `${auto.length} 个自动名，其中跨块 ${spanning.length} 个`
      : '—',
    items: spanning
  });
}

// 7. malformed names ---------------------------------------------------------
{
  const bad = [...nets.keys()].filter((n) => BADNAME.test(n));
  results.push({
    group: '命名', name: '网名格式规范',
    state: verdict(!bad.length, bad.length > 0),
    detail: bad.length ? bad.join(' ') : '—',
    items: bad
  });
}

// 8. supply coverage ---------------------------------------------------------
{
  // The right question is not "does this part have many pins" but "does this part
  // have a supply pin at all". A 3-digit display has 11 pins and no VDD/GND - its
  // digit selects ARE the common cathode - so requiring a supply net there is a
  // false positive.
  // Judge by pin names, not pin count: a part whose pins are named GND/VDD/VIN/
  // VOUT is expected to be supplied, while a display's digit selects ARE its
  // common cathode and a relay's contacts legitimately see only mains. Counting
  // pins missed the 4-pin regulator and the 3-pin reference, and flagged the
  // 11-pin display.
  const SUPPLY_PIN = /GND|VDD|VCC|VSS|VIN|VOUT|VBAT|AVDD|DVDD|^\+V|^-V|VO$/i;
  const chips = page.components.filter((c) => (c.pins || []).some((p) => SUPPLY_PIN.test(p.name || '')));
  const missing = chips.filter((c) => !c.pins.some((p) => p.net && SUPPLY.test(p.net)));
  results.push({
    group: '电源', name: '有电源脚的元件都接了电源',
    state: verdict(!missing.length),
    detail: missing.length
      ? `${missing.length} 个: ${missing.map((c) => c.designator).join(' ')}`
      : `${chips.length} 个: ${chips.map((c) => c.designator).join(' ')}`,
    items: missing.map((c) => c.designator)
  });
}

// 9. implicit connections: two pins at the same coordinate -------------------
// A pin-to-pin touch is a real connection in the editor but invisible on the
// sheet and destroyed by any move. Worth knowing before laying out.
{
  const at = new Map();
  for (const p of pins) {
    const k = `${Math.round(p.x)}|${Math.round(p.y)}`;
    if (!at.has(k)) at.set(k, []);
    at.get(k).push(p);
  }
  const pairs = [];
  for (const [k, list] of at) {
    const others = list.filter((p) => !list.some((q) => q !== p && q.d === p.d));
    for (let i = 0; i < others.length; i++) {
      for (let j = i + 1; j < others.length; j++) pairs.push({ at: k, a: others[i].ref, b: others[j].ref });
    }
  }
  results.push({
    group: '连接', name: '无引脚重合的隐式连接',
    state: verdict(!pairs.length, pairs.length > 0),
    detail: pairs.length ? `${pairs.length} 对: ${pairs.slice(0, 6).map((p) => `${p.a}=${p.b}@${p.at}`).join(' ')}` : '—',
    items: pairs.map((p) => `${p.a}=${p.b}`)
  });
}

// 10. net size distribution (context, not a verdict) ------------------------
{
  const sized = [...nets.entries()].sort((a, b) => b[1].length - a[1].length);
  const big = sized.filter(([, l]) => l.length > 6);
  results.push({
    group: '规模', name: '大网络（>6 引脚）',
    state: 'info',
    detail: big.length ? big.map(([n, l]) => `${n}:${l.length}`).join(' ') : '—'
  });
}

// ---- report ---------------------------------------------------------------
const fails = results.filter((r) => r.state === 'fail');
const warns = results.filter((r) => r.state === 'warn');
const mark = { ok: '✓', fail: '✗', warn: '⚠', info: '·' };

console.log('网表自检报告');
console.log('='.repeat(56));
console.log(`${basename(file)}   ${page.source?.project || ''} / ${page.source?.page || 'P1'}`);
console.log(`元件 ${page.components.length} · 引脚 ${pins.length} · 网络 ${nets.size}`);
console.log('');

let group = '';
for (const r of results) {
  if (r.group !== group) { group = r.group; console.log(`${group}`); }
  console.log(`  ${mark[r.state]} ${r.name.padEnd(22)} ${r.detail}`);
}
console.log('');

// Detail the blocking items so they can be acted on without a second pass.
for (const r of results) {
  if (r.state !== 'fail' || !r.items?.length) continue;
  console.log(`需要处理 — ${r.name}`);
  if (r.group === '连接' && r.name.includes('NC')) {
    console.log('  这些引脚没有网络也没有 NC 标记：要么接上，要么在 EDA 里标 NC。');
    console.log('  未标 NC 时转 PCB 会报"引脚悬空"，且读者无法区分"漏接"和"故意空着"。');
  }
  for (const it of r.items.slice(0, 20)) console.log(`    ${it}`);
  if (r.items.length > 20) console.log(`    …还有 ${r.items.length - 20} 条`);
  console.log('');
}

console.log('='.repeat(56));
if (fails.length) {
  console.log(`结论：${fails.length} 项阻塞，${warns.length} 项提示 → 不能进入布局`);
  process.exit(1);
}
console.log(warns.length ? `结论：通过（${warns.length} 项提示）→ 可以进入布局` : '结论：全部通过 → 可以进入布局');
