#!/usr/bin/env node
// Place designator and part-name text for components on a schematic page.
//
// Rules (user-specified, 2026-11-17):
//   1. both texts are visible by default
//   2. designator prefers top-left, then top-right
//   3. part name prefers bottom-left, then bottom-right
//
// What makes this more than a preference list: each candidate is rejected when
// it would leave the block, land on a pin stub, or land on a neighbour - and a
// second, wider clearance is tried before giving up. Text that is wider than its
// own symbol body is shrunk to fit, because a name longer than the part it
// belongs to is how two adjacent parts end up with overlapping labels.
//
//   node scripts/labels.mjs <page.json> --symbols <symbols.json> [options]
//     --only DS1,DS2        only these designators
//     --rect x,y,w,h        constrain to a block rectangle
//     --commit              write to EDA (default is a dry run)
//     --project <uuid>      required with --commit, guards against the wrong project
//     --page <docUuid>      page to open before writing
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPage, chooseTextSlot, pinSegments, textExtent, attrBBox, wireSegments } from './lib/page.mjs';
import { bboxToPage } from './epro.mjs';
import { findBridge, exec } from './bridge.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

function parseArgs(argv) {
  const a = { file: null, symbols: null, only: null, rect: null, commit: false, page: null, project: null, port: null, json: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--symbols') a.symbols = argv[++i];
    else if (t === '--only') a.only = argv[++i].split(',').map((x) => x.trim());
    else if (t === '--rect') a.rect = argv[++i].split(',').map(Number);
    else if (t === '--commit') a.commit = true;
    else if (t === '--page') a.page = argv[++i];
    else if (t === '--project') a.project = argv[++i];
    else if (t === '--port') a.port = Number(argv[++i]);
    else if (t === '--json') a.json = argv[++i];
    else if (t === '--help' || t === '-h') a.help = true;
    else if (!t.startsWith('-')) a.file = t;
  }
  return a;
}

const NAME_LINE = 12;

// Shrink a name only when it genuinely cannot be placed at full size.
//
// Sizing it to the symbol body first looked reasonable and was wrong: a 0805
// capacitor's body is 21 units wide while "100nF" is 35, so every passive would
// have been printed at font 6. What actually matters is whether the text fits in
// the available space, so size is tried from large to small and the first
// placement that works wins.
const FONT_STEPS = [null, 11, 10, 9, 8, 7, 6];

function plan(page, sym, opts) {
  const rect = opts.rect ? { x: opts.rect[0], y: opts.rect[1], w: opts.rect[2], h: opts.rect[3] } : null;
  const targets = page.components.filter((c) => !opts.only || opts.only.includes(c.designator));

  const bodyOf = (c) => {
    const s = sym[c.symbolUuid];
    if (!s || !s.bbox) return c.bbox || null;
    return bboxToPage(s.bbox, { x: c.x, y: c.y, rotation: c.rotation || 0, mirror: !!c.mirror });
  };

  const all = page.components
    .map((c) => ({ c, body: bodyOf(c) }))
    .filter((o) => o.body && (o.body.w || o.body.h));

  // Text placed earlier in this pass becomes an obstacle for everything later,
  // otherwise two neighbours each "cleanly" pick the same gap.
  // Text is the last thing placed on a page, so it has to dodge the wires that
  // are already there (D48). Empty on a page that has not been routed yet.
  const wires = wireSegments(page).map((sg) => ({ a: sg.a, b: sg.b }));
  const placed = [];
  const out = [];

  for (const t of targets) {
    const self = all.find((o) => o.c === t);
    if (!self) continue;
    const body = self.body;
    const pins = pinSegments(t);
    const others = all.filter((o) => o.c !== t).map((o) => o.body).concat(placed);

    const row = { designator: t.designator, designatorSide: null, name: null, nameSide: null, notes: [] };

    const desAttr = (t.attrs || []).find((a) => a.key === 'Designator');
    const desText = desAttr ? (desAttr.rendered != null ? desAttr.rendered : desAttr.value) : t.designator;
    const ds = chooseTextSlot(body, {
      textW: textExtent(desText).w, neighbours: others, rect, kind: 'designator', pins, wires
    });
    if (ds) {
      row.designatorSide = ds.side;
      row.designatorAt = [Math.round(ds.rect.x), Math.round(ds.rect.y + ds.rect.h / 2)];
      if (!ds.clean) row.notes.push('位号无干净位置');
      placed.push(ds.rect);
    } else {
      row.notes.push('位号无可用位置');
    }

    const nameAttr = (t.attrs || []).find((a) => a.key === 'Name');
    const nameText = nameAttr ? (nameAttr.rendered != null ? nameAttr.rendered : null) : null;
    if (nameAttr && nameText != null && nameText !== '') {
      row.name = nameText;
      // Cap the width at the part's own body, but never below 90 units - a 0805
      // body is 21 wide and "100nF" is 35, so a body-width cap would shrink every
      // passive. 90 is roughly the point where a name stops reading as a label
      // and starts acting like a paragraph.
      const capW = Math.max(body.w, 90);
      let chosen = null;
      for (const fs of FONT_STEPS) {
        const w = textExtent(nameText, fs).w;
        if (w > capW && fs !== 6) continue;
        const ns = chooseTextSlot(body, {
          textW: w, neighbours: others.concat(placed), rect, kind: 'name', pins, wires
        });
        if (ns && ns.clean) { chosen = { ...ns, fontSize: fs }; break; }
        if (!chosen && ns) chosen = { ...ns, fontSize: fs };
      }
      if (chosen) {
        row.nameSide = chosen.side;
        row.nameFontSize = chosen.fontSize;
        row.nameAt = [Math.round(chosen.rect.x), Math.round(chosen.rect.y + chosen.rect.h / 2)];
        if (!chosen.clean) row.notes.push('名称无干净位置');
        placed.push(chosen.rect);
      } else {
        row.notes.push('名称无可用位置');
      }
    } else {
      row.notes.push('无可显示名称');
    }

    // What the texts will actually occupy, for the summary.
    row.body = { x: Math.round(body.x), y: Math.round(body.y), w: Math.round(body.w), h: Math.round(body.h) };
    out.push(row);
  }
  return out;
}

function printPlan(rows) {
  console.log('位号 / 名称摆放计划');
  console.log('');
  for (const r of rows) {
    const des = r.designatorAt ? `${r.designatorSide} (${r.designatorAt[0]},${r.designatorAt[1]})` : '—';
    const nm = r.nameAt ? `${r.nameSide} (${r.nameAt[0]},${r.nameAt[1]})${r.nameFontSize ? ' fs' + r.nameFontSize : ''}` : '—';
    console.log(`  ${r.designator.padEnd(6)} 位号 ${des.padEnd(26)} 名称 ${nm}`);
    if (r.name) console.log(`  ${''.padEnd(6)}   "${r.name.slice(0, 40)}"`);
    for (const n of r.notes) console.log(`  ${''.padEnd(6)}   ! ${n}`);
  }
  const bad = rows.filter((r) => r.notes.length).length;
  console.log('');
  console.log(`共 ${rows.length} 个元件，${bad} 个有未解决项`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.file) {
    console.log(`用法: node scripts/labels.mjs <page.json> --symbols <symbols.json>
         [--only DS1,DS2] [--rect x,y,w,h] [--commit --project <uuid> [--page <docUuid>]]`);
    process.exit(args.help ? 0 : 2);
  }

  const { page } = loadPage(args.file);
  const sym = args.symbols ? readJson(resolve(args.symbols)).symbols : {};
  // bboxes come from the symbol library; without it side selection is blind.
  for (const c of page.components) {
    const s = sym[c.symbolUuid];
    if (s && s.bbox) c.bbox = bboxToPage(s.bbox, { x: c.x, y: c.y, rotation: c.rotation || 0, mirror: !!c.mirror });
  }

  const rows = plan(page, sym, args);
  if (args.json) writeFileSync(resolve(args.json), JSON.stringify(rows, null, 2) + '\n');
  printPlan(rows);

  if (!args.commit) {
    console.log('');
    console.log('（预演。加 --commit --project <uuid> 才会写入 EDA）');
    return;
  }
  if (!args.project) {
    console.error('\n拒绝写入：缺少 --project。页面 UUID 跨工程重复，必须先锁定工程（D39）。');
    process.exit(3);
  }

  const found = await findBridge(args.port);
  if (!found || !found.health.edaConnected) {
    console.error('EDA 未连接。');
    process.exit(2);
  }

  const payload = rows.map((r) => ({
    designator: r.designator,
    des: r.designatorAt || null,
    name: r.nameAt || null,
    fontSize: r.nameFontSize || null
  }));

  // A single bridge request dies at 30 s, so the batch is sized to finish well
  // inside it. Writing is idempotent (absolute coordinates), so a partial run can
  // simply be repeated rather than rolled back.
  const CHUNK = 8;
  let written = 0;
  let saved = null;
  for (let i = 0; i < payload.length; i += CHUNK) {
    const batch = payload.slice(i, i + CHUNK);
    const res = await exec(found.port, `
      const PROJ = ${JSON.stringify(args.project)};
      const OPEN = ${JSON.stringify(args.page)};
      const PLAN = ${JSON.stringify(batch)};
      let cur = await eda.dmt_Project.getCurrentProjectInfo();
      if (!cur || cur.uuid !== PROJ) {
        await eda.dmt_Project.openProject(PROJ);
        await new Promise(r => setTimeout(r, 3200));
        cur = await eda.dmt_Project.getCurrentProjectInfo();
      }
      if (!cur || cur.uuid !== PROJ) return { aborted: 'project-mismatch', got: cur ? cur.uuid : null };
      if (OPEN) { await eda.dmt_EditorControl.openDocument(OPEN); await new Promise(r => setTimeout(r, 1200)); }

      const ids = await eda.sch_PrimitiveComponent.getAllPrimitiveId('part');
      const comps = await eda.sch_PrimitiveComponent.get(ids);
      const by = new Map(comps.map(c => [c.designator, c]));
      const log = [];
      for (const p of PLAN) {
        const c = by.get(p.designator);
        if (!c) { log.push(p.designator + ':missing'); continue; }
        const attrs = (await eda.sch_PrimitiveAttribute.getAll(c.primitiveId)) || [];
        for (const a of attrs) {
          if (a.key === 'Designator' && p.des) {
            try { await eda.sch_PrimitiveAttribute.modify(a.primitiveId, { x: p.des[0], y: p.des[1], valueVisible: true }); log.push(p.designator + '.des'); }
            catch (e) { log.push(p.designator + '.des err'); }
          }
          if (a.key === 'Name' && p.name) {
            const prop = { x: p.name[0], y: p.name[1], valueVisible: true };
            if (p.fontSize) prop.fontSize = p.fontSize;
            try { await eda.sch_PrimitiveAttribute.modify(a.primitiveId, prop); log.push(p.designator + '.name'); }
            catch (e) { log.push(p.designator + '.name err'); }
          }
          await new Promise(r => setTimeout(r, 60));
        }
      }
      let s2 = null;
      try { s2 = await eda.sch_Document.save(); } catch (e) { s2 = 'err'; }
      await new Promise(r => setTimeout(r, 400));
      return { log, saved: s2 };
    `, 90000);
    if (res && res.aborted) {
      console.error(`\n中止：工程不匹配（需要 ${args.project}，当前 ${res.got}）`);
      process.exit(3);
    }
    written += (res.log || []).length;
    saved = res.saved;
    process.stdout.write(`\r写入 ${Math.min(i + CHUNK, payload.length)}/${payload.length} · 属性字 ${written}   `);
  }
  console.log('');
  console.log(`保存: ${saved}`);
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
