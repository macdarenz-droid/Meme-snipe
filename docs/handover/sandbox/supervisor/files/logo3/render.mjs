import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs'
import { MARKS, FAV } from './marks.mjs'
import { writeFileSync } from 'node:fs'
let n = 0; const uid = () => `u${n++}`
const flat = (k, ink, size) => `<svg width="${size}" height="${size}" viewBox="0 0 512 512">${MARKS[k].svg(ink, uid())}</svg>`
// App icon after Linear: dark gradient tile, top light, hairline bevel, mark in a white-to-silver gradient at 60%.
const appIcon = (k, size) => { const t = uid(), h = uid(), m = uid(), e = uid(); return `<svg width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="${t}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2B2D31"/><stop offset="1" stop-color="#0E0F11"/></linearGradient>
    <radialGradient id="${h}" cx="0.5" cy="0" r="0.85"><stop offset="0" stop-color="#fff" stop-opacity="0.13"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <linearGradient id="${m}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#C4C9D0"/></linearGradient>
    <linearGradient id="${e}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.22"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.04"/><stop offset="1" stop-color="#fff" stop-opacity="0.10"/></linearGradient>
  </defs>
  <rect width="512" height="512" rx="115" fill="url(#${t})"/>
  <rect width="512" height="512" rx="115" fill="url(#${h})"/>
  <rect x="2" y="2" width="508" height="508" rx="113" fill="none" stroke="url(#${e})" stroke-width="4"/>
  <g transform="translate(256 262) scale(0.6) translate(-256 -256)" opacity="0.18" filter="blur(0)"><g transform="translate(0 14)">${MARKS[k].svg('#000', uid())}</g></g>
  <g transform="translate(256 256) scale(0.6) translate(-256 -256)">${MARKS[k].svg(`url(#${m})`, uid())}</g>
</svg>` }
for (const k of Object.keys(MARKS)) { writeFileSync(`zeroed-${k}-app-icon.svg`, appIcon(k, 512)); writeFileSync(`zeroed-${k}-mark.svg`, flat(k, '#0D0F12', 512)); writeFileSync(`zeroed-${k}-favicon.svg`, FAV[k]('#0D0F12')) }

const col = k => `<div class="col">
  <div class="hero">${appIcon(k, 232)}</div>
  <div class="pair"><div class="tile d">${flat(k, '#EDEFF2', 92)}</div><div class="tile l">${flat(k, '#0D0F12', 92)}</div></div>
  <div class="fav">
    <div class="px"><canvas class="z" width="16" height="16" data-svg="${encodeURIComponent(FAV[k]('#EDEFF2'))}"></canvas><span>Real 16 px pixels, enlarged</span></div>
    <div class="real"><span class="tab d">${FAV[k]('#EDEFF2')}</span><span class="tab l">${FAV[k]('#0D0F12')}</span>${appIcon(k, 32)}${appIcon(k, 48)}</div>
  </div>
  <div class="lock d">${flat(k, '#EDEFF2', 34)}<span>Zeroed</span></div>
  <div class="lock l">${flat(k, '#0D0F12', 34)}<span>Zeroed</span></div>
  <div class="label"><b>${MARKS[k].name}</b><br>${MARKS[k].note}</div>
</div>`
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Geist;src:url(geist-600.woff2) format("woff2");font-weight:100 900}
body{margin:0;background:#08090B;color:#EDEFF2;font-family:Geist,system-ui,sans-serif}
.wrap{padding:52px 56px}
h1{font-weight:600;font-size:28px;letter-spacing:-0.03em;margin:0 0 8px}
.sub{color:#8A93A0;font-size:15px;line-height:1.5;margin:0 0 32px;max-width:980px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:22px}
.col{background:#101216;border:1px solid #22262D;border-radius:20px;padding:30px 26px;display:flex;flex-direction:column;align-items:center;gap:22px}
.pair{display:flex;gap:14px}.tile{width:128px;height:128px;border-radius:16px;display:grid;place-items:center}
.tile.d{background:#0A0B0D;border:1px solid #22262D}.tile.l{background:#F3F4F6}
.fav{display:flex;align-items:center;gap:22px}
.px{display:flex;flex-direction:column;align-items:center;gap:6px;color:#6B7380;font-size:12px}
.px .z{width:96px;height:96px;background:#0A0B0D;border:1px solid #22262D;border-radius:12px;image-rendering:pixelated}
.real{display:flex;align-items:center;gap:12px}
.tab{display:grid;place-items:center;width:28px;height:28px;border-radius:7px}.tab.d{background:#0A0B0D;border:1px solid #22262D}.tab.l{background:#F3F4F6}
.lock{display:flex;align-items:center;gap:11px;padding:14px 22px;border-radius:14px;width:100%;justify-content:center;box-sizing:border-box}
.lock span{font-weight:600;font-size:36px;letter-spacing:-0.045em;line-height:1}
.lock.d{background:#0A0B0D;border:1px solid #22262D}.lock.l{background:#F3F4F6;color:#0D0F12}
.label{font-size:14px;line-height:1.5;color:#8A93A0;text-align:center}.label b{color:#EDEFF2;font-weight:600;font-size:15px}
</style></head><body><div class="wrap">
<h1>Zeroed · logo, round 3</h1>
<p class="sub">One idea in three cuts: a solid zero split by a Z that passes through dead centre. Built the way Linear and Vercel build theirs: solid shapes, the meaning in the negative space, one 45° angle, one colour first, depth only on the app icon, and a separate 16 px drawing.</p>
<div class="grid">${Object.keys(MARKS).map(col).join('')}</div></div></body></html>`
writeFileSync('sheet.html', html)
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })
const p = await b.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 })
await p.goto('file://' + process.cwd() + '/sheet.html'); await p.evaluate(() => document.fonts.ready)
await p.evaluate(async () => { for (const c of document.querySelectorAll('canvas[data-svg]')) {
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + c.dataset.svg; await img.decode()
  const x = c.getContext('2d'); x.fillStyle = '#0A0B0D'; x.fillRect(0, 0, 16, 16); x.drawImage(img, 0, 0, 16, 16) } })
await p.screenshot({ path: 'zeroed-logo-round3.png', fullPage: true })
await b.close(); console.log('done')
