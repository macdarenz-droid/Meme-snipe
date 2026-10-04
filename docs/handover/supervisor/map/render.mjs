// Renders spec.json (lanes, nodes, edges, callouts, today) into poster.html, poster.png and poster.pdf.
// Usage: NODE_PATH=/opt/node22/lib/node_modules node render.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const dir = new URL('.', import.meta.url).pathname;
const spec = JSON.parse(readFileSync(dir + 'spec.json', 'utf8'));
const font = readFileSync(dir + 'geist-semibold.woff2').toString('base64');
const logo = readFileSync(dir + 'zeroed-lockup-ink.svg', 'utf8');

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const byId = Object.fromEntries(spec.nodes.map((n) => [n.id, n]));
const card = (id) => {
  const n = byId[id];
  if (!n) return '';
  return `<div class="node k-${esc(n.kind)}" id="n-${esc(id)}"><div class="lbl">${esc(n.label)}</div><div class="dtl">${esc(n.detail)}</div></div>`;
};
const lane = (l, cls) => `<section class="lane ${cls}" id="lane-${esc(l.id)}">
  <header><h2>${esc(l.title)}</h2><p>${esc(l.blurb)}</p></header>
  <div class="rows">${l.rows.map((r) => `<div class="row" style="--n:${r.length}">${r.map(card).join('')}</div>`).join('')}</div>
</section>`;

const [data, bot, phone, proof] = spec.lanes;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Zeroed map</title>
<style>
@font-face{font-family:Geist;src:url(data:font/woff2;base64,${font}) format('woff2');font-weight:600}
:root{--bg:#F7F7F5;--surface:#FFFFFF;--raised:#F1F1EE;--border:#E3E3DF;--text:#0D0F12;--text2:#5E636B;--accent:#2B61E8;--gain:#0D7C44;--loss:#C53939;--amber:#A86A00}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font:12px/1.35 -apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;width:1900px;padding:28px 32px 26px}
h1,h2,.lbl{font-family:Geist,-apple-system,sans-serif;font-weight:600;letter-spacing:-.01em}
.top{display:grid;grid-template-columns:auto 1fr 520px;gap:28px;align-items:start;margin-bottom:18px}
.top .logo svg{height:46px;width:auto;display:block}
.top h1{font-size:26px;line-height:1.15}
.top .sub{color:var(--text2);font-size:13.5px;margin-top:4px;max-width:820px}
.today{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:10px 14px}
.today h3{font:600 11px/1 Geist,sans-serif;text-transform:uppercase;letter-spacing:.06em;color:var(--text2);margin-bottom:6px}
.today li{list-style:none;padding-left:14px;position:relative;margin:2px 0}
.today li:before{content:"";position:absolute;left:2px;top:6px;width:6px;height:6px;border-radius:50%;background:var(--accent)}
.grid{display:grid;grid-template-columns:300px 1fr 300px;gap:96px;position:relative}
.lane{background:rgba(255,255,255,.55);border:1px solid var(--border);border-radius:16px;padding:14px 14px 16px}
.lane header{margin-bottom:10px}
.lane h2{font-size:16px}
.lane header p{color:var(--text2);font-size:12px;margin-top:2px}
.rows{display:flex;flex-direction:column;gap:22px}
.row{display:grid;grid-template-columns:repeat(var(--n),1fr);gap:18px}
.proof{margin-top:30px}
.proof .rows{gap:0}
.proof .row{gap:24px}
.node{position:relative;z-index:2;background:var(--surface);border:1.5px solid var(--border);border-radius:10px;padding:8px 10px 9px;box-shadow:0 1px 0 rgba(13,15,18,.03)}
.lbl{font-size:13.5px;line-height:1.2;margin-bottom:3px}
.dtl{color:var(--text2);font-size:11.2px}
.k-source{border-left:5px solid #7A8494}
.k-step{border-left:5px solid var(--accent)}
.k-check{border-left:5px solid var(--amber)}
.k-safety{border-left:5px solid var(--loss)}
.k-store{border-left:5px solid #8A6FD1;background:#FBFAFF}
.k-screen{border-left:5px solid var(--gain)}
.k-owner{background:var(--text);border-color:var(--text);color:#ECEFF3}.k-owner .dtl{color:#C4C9D1}
.k-planned{border-style:dashed;border-left:5px dashed #7A8494;background:#FBFBFA}
.bottom{display:grid;grid-template-columns:1fr 330px;gap:28px;margin-top:22px;align-items:start}
.callouts{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:14px}
.callout{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:10px 12px}
.callout h4{font:600 13px/1.2 Geist,sans-serif;margin-bottom:4px}
.callout p{color:var(--text2);font-size:11.5px}
.legend{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:10px 12px;display:grid;grid-template-columns:1fr 1fr;gap:6px 14px;font-size:11.5px}
.legend h4{grid-column:1/-1;font:600 11px/1 Geist,sans-serif;text-transform:uppercase;letter-spacing:.06em;color:var(--text2);margin-bottom:2px}
.sw{display:inline-block;width:22px;height:12px;border-radius:3px;border:1.5px solid var(--border);vertical-align:-2px;margin-right:6px;background:#fff}
svg#wires{position:absolute;left:0;top:0;pointer-events:none;z-index:1;overflow:visible}
.elabel{font:10.5px/1 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;fill:var(--text2)}
.foot{color:var(--text2);font-size:10.5px;margin-top:12px}
</style></head><body>
<div class="top">
  <div class="logo">${logo}</div>
  <div><h1>${esc(spec.title)}</h1><div class="sub">${esc(spec.subtitle)}</div></div>
  <div class="today"><h3>Today</h3><ul>${spec.today.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>
</div>
<div id="board" style="position:relative">
  <div class="grid">${lane(data, 'data')}${lane(bot, 'bot')}${lane(phone, 'phone')}</div>
  ${lane(proof, 'proof')}
  <svg id="wires"></svg>
</div>
<div class="bottom">
  <div class="callouts">${spec.callouts.map((c) => `<div class="callout"><h4>${esc(c.title)}</h4><p>${esc(c.text)}</p></div>`).join('')}</div>
  <div class="legend"><h4>Key</h4>
    <div><span class="sw" style="border-left:5px solid #7A8494"></span>Outside data</div>
    <div><span class="sw" style="border-left:5px solid #2B61E8"></span>Bot step</div>
    <div><span class="sw" style="border-left:5px solid #A86A00"></span>Check</div>
    <div><span class="sw" style="border-left:5px solid #C53939"></span>Safety stop</div>
    <div><span class="sw" style="border-left:5px solid #8A6FD1;background:#FBFAFF"></span>Saved record</div>
    <div><span class="sw" style="border-left:5px solid #0D7C44"></span>Phone or alert</div>
    <div><span class="sw" style="background:#0D0F12;border-color:#0D0F12"></span>Only you</div>
    <div><span class="sw" style="border-style:dashed"></span>Not built yet</div>
  </div>
</div>
<div class="foot">Zeroed · how the bot works · ${esc(spec.stamp || '')}</div>
<script>
const EDGES = ${JSON.stringify(spec.edges)}; const SHOW_LABELS = false;
const board = document.getElementById('board'), svg = document.getElementById('wires');
const B = board.getBoundingClientRect();
svg.setAttribute('width', B.width); svg.setAttribute('height', B.height);
const NS = 'http://www.w3.org/2000/svg';
const defs = document.createElementNS(NS, 'defs');
defs.innerHTML = '<marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#8A9099"/></marker>';
svg.appendChild(defs);
const box = (id) => { const e = document.getElementById('n-' + id); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left - B.left, t: r.top - B.top, r: r.right - B.left, b: r.bottom - B.top, cx: (r.left + r.right) / 2 - B.left, cy: (r.top + r.bottom) / 2 - B.top }; };
const placed = [];
for (const e of EDGES) {
  const a = box(e.from), b = box(e.to); if (!a || !b) continue;
  let x1, y1, x2, y2, horiz;
  if (b.l >= a.r - 4) { x1 = a.r; y1 = a.cy; x2 = b.l; y2 = b.cy; horiz = true; }
  else if (b.r <= a.l + 4) { x1 = a.l; y1 = a.cy; x2 = b.r; y2 = b.cy; horiz = true; }
  else if (b.t >= a.b - 4) { x1 = a.cx; y1 = a.b; x2 = b.cx; y2 = b.t; horiz = false; }
  else { x1 = a.cx; y1 = a.t; x2 = b.cx; y2 = b.b; horiz = false; }
  const d = horiz ? Math.max(24, Math.abs(x2 - x1) / 2) : Math.max(18, Math.abs(y2 - y1) / 2);
  const p = document.createElementNS(NS, 'path');
  const c = horiz ? \`M\${x1},\${y1} C\${x1 + Math.sign(x2 - x1) * d},\${y1} \${x2 - Math.sign(x2 - x1) * d},\${y2} \${x2},\${y2}\` : \`M\${x1},\${y1} C\${x1},\${y1 + Math.sign(y2 - y1) * d} \${x2},\${y2 - Math.sign(y2 - y1) * d} \${x2},\${y2}\`;
  p.setAttribute('d', c); p.setAttribute('fill', 'none'); p.setAttribute('stroke', '#9AA0A8'); p.setAttribute('stroke-width', '1.4'); p.setAttribute('marker-end', 'url(#ah)');
  svg.appendChild(p);
  if (e.label && SHOW_LABELS) {
    const len = p.getTotalLength(); const m = p.getPointAtLength(len / 2);
    let mx = m.x, my = m.y;
    if (horiz && Math.abs(x2 - x1) < 110) my = Math.min(y1, y2) - 10;
    if (!horiz && Math.abs(y2 - y1) < 40) mx = Math.max(x1, x2) + 6 + e.label.length * 2.6;
    for (const q of placed) if (Math.abs(q.x - mx) < 70 && Math.abs(q.y - my) < 12) my += 13;
    placed.push({ x: mx, y: my });
    const t = document.createElementNS(NS, 'text'); t.setAttribute('class', 'elabel'); t.setAttribute('x', mx); t.setAttribute('y', my + 3.5); t.setAttribute('text-anchor', 'middle'); t.textContent = e.label;
    svg.appendChild(t);
    const bb = t.getBBox(); const bg = document.createElementNS(NS, 'rect');
    bg.setAttribute('x', bb.x - 3); bg.setAttribute('y', bb.y - 1.5); bg.setAttribute('width', bb.width + 6); bg.setAttribute('height', bb.height + 3); bg.setAttribute('rx', 3); bg.setAttribute('fill', '#F7F7F5');
    svg.insertBefore(bg, t);
  }
}
document.body.dataset.ready = '1';
</script></body></html>`;

writeFileSync(dir + 'poster.html', html);
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
const page = await browser.newPage({ viewport: { width: 1900, height: 1200 }, deviceScaleFactor: 2 });
await page.goto('file://' + dir + 'poster.html');
await page.waitForSelector('body[data-ready="1"]');
const h = Math.ceil(await page.evaluate(() => document.querySelector('.foot').getBoundingClientRect().bottom + 24));
await page.setViewportSize({ width: 1900, height: h });
await page.screenshot({ path: dir + 'zeroed-map.png', fullPage: true });
await page.pdf({ path: dir + 'zeroed-map.pdf', width: '1900px', height: h + 'px', printBackground: true, pageRanges: '1' });
const missing = spec.edges.filter((e) => !byId[e.from] || !byId[e.to]).map((e) => e.from + '->' + e.to);
const unplaced = spec.nodes.filter((n) => !spec.lanes.some((l) => l.rows.flat().includes(n.id))).map((n) => n.id);
console.log(JSON.stringify({ height: h, missingEdges: missing, unplacedNodes: unplaced }));
await browser.close();
