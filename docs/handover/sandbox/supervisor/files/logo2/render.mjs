import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs'
import { MARKS } from './marks.mjs'
import { writeFileSync } from 'node:fs'
let n = 0
const uid = () => `m${n++}`
const flat = (k, ink, size) => `<svg width="${size}" height="${size}" viewBox="0 0 512 512">${MARKS[k].svg(ink, uid())}</svg>`
// App icon: dark squircle, soft top light, hairline inner edge, mark in a light-to-grey gradient.
const appIcon = (k, size) => { const g = uid(), s = uid(), h = uid(); return `<svg width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1B1F26"/><stop offset="1" stop-color="#0B0D10"/></linearGradient>
    <radialGradient id="${h}" cx="0.5" cy="0" r="0.9"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.10"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>
    <linearGradient id="${s}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#B9C0CA"/></linearGradient>
  </defs>
  <rect width="512" height="512" rx="115" fill="url(#${g})"/>
  <rect width="512" height="512" rx="115" fill="url(#${h})"/>
  <rect x="1.5" y="1.5" width="509" height="509" rx="113.5" fill="none" stroke="#FFFFFF" stroke-opacity="0.09" stroke-width="3"/>
  <g transform="translate(256 256) scale(0.62) translate(-256 -256)">${MARKS[k].svg(`url(#${s})`, uid())}</g>
</svg>` }

for (const k of Object.keys(MARKS)) writeFileSync(`zeroed-${k}.svg`, appIcon(k, 512))

const cell = k => `<div class="cell">
  <div class="hero">${appIcon(k, 200)}</div>
  <div class="row">
    <div class="tile dark">${flat(k, '#ECEFF3', 72)}</div>
    <div class="tile light">${flat(k, '#0D0F12', 72)}</div>
  </div>
  <div class="row small">${appIcon(k, 48)}${appIcon(k, 32)}<span class="fav">${flat(k, '#ECEFF3', 16)}</span><span class="fav l">${flat(k, '#0D0F12', 16)}</span></div>
  <div class="lockup">${flat(k, '#ECEFF3', 30)}<span>Zeroed</span></div>
  <div class="label"><b>${MARKS[k].name}</b><br>${MARKS[k].note}</div>
</div>`

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Geist;src:url(geist-600.woff2) format("woff2");font-weight:100 900;}
body{margin:0;background:#08090B;color:#ECEFF3;font-family:Geist,system-ui,sans-serif}
.wrap{padding:48px}
h1{font-weight:600;font-size:26px;letter-spacing:-0.025em;margin:0 0 6px}
.sub{color:#8A93A0;font-size:15px;margin:0 0 28px}
.grid{display:grid;grid-template-columns:repeat(5,1fr);gap:18px}
.cell{background:#111318;border:1px solid #23272F;border-radius:18px;padding:24px 20px;display:flex;flex-direction:column;gap:18px;align-items:center}
.row{display:flex;gap:12px;align-items:center}
.tile{width:104px;height:104px;border-radius:14px;display:grid;place-items:center}
.tile.dark{background:#0B0D10;border:1px solid #23272F}.tile.light{background:#F4F5F7}
.small{gap:14px}.fav{display:grid;place-items:center;width:28px;height:28px;border-radius:6px;background:#0B0D10;border:1px solid #23272F}.fav.l{background:#F4F5F7;border-color:#F4F5F7}
.lockup{display:flex;align-items:center;gap:10px}.lockup span{font-weight:600;font-size:30px;letter-spacing:-0.04em}
.label{font-size:13.5px;line-height:1.45;color:#8A93A0;text-align:center}.label b{color:#ECEFF3;font-weight:600}
</style></head><body><div class="wrap"><h1>Zeroed · logo concepts, round 2</h1>
<p class="sub">Solid marks, meaning in the negative space, one colour first. App icon, flat marks, 48/32 px icons and real 16 px favicons.</p>
<div class="grid">${Object.keys(MARKS).map(cell).join('')}</div></div></body></html>`
writeFileSync('sheet.html', html)
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })
const p = await b.newPage({ viewport: { width: 1640, height: 800 }, deviceScaleFactor: 2 })
await p.goto('file://' + process.cwd() + '/sheet.html'); await p.evaluate(() => document.fonts.ready)
await p.screenshot({ path: 'zeroed-logo-round2.png', fullPage: true })
await b.close(); console.log('done')
