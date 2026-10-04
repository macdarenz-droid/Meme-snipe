import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs'
const v = (w, y1, y2, x1, x2) => `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><defs><mask id="f" maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16"><rect width="16" height="16" fill="black"/><circle cx="8" cy="8" r="7" fill="white"/><polyline points="0,${y1} ${x1},${y1} ${x2},${y2} 16,${y2}" fill="none" stroke="black" stroke-width="${w}" stroke-linejoin="miter" stroke-miterlimit="2.4"/></mask></defs><rect width="16" height="16" fill="#EDEFF2" mask="url(#f)"/></svg>`
const variants = { now: v(1.5, 5.75, 10.25, 10.25, 5.75), w1: v(1, 5.5, 10.5, 10.5, 5.5), w2: v(2, 5, 11, 11, 5), w15: v(1.5, 5.25, 10.75, 10.75, 5.25) }
const html = `<body style="margin:0;background:#08090B;display:flex;gap:20px;padding:20px;color:#999;font:12px sans-serif">${Object.entries(variants).map(([k, s]) => `<div><canvas width="16" height="16" data-svg="${encodeURIComponent(s)}" style="width:128px;height:128px;image-rendering:pixelated"></canvas><div>${k}</div><canvas width="16" height="16" data-svg="${encodeURIComponent(s)}"></canvas></div>`).join('')}</body>`
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })
const p = await b.newPage({ viewport: { width: 640, height: 220 } })
await p.setContent(html)
await p.evaluate(async () => { for (const c of document.querySelectorAll('canvas')) { const i = new Image(); i.src = 'data:image/svg+xml;charset=utf-8,' + c.dataset.svg; await i.decode(); const x = c.getContext('2d'); x.fillStyle = '#0A0B0D'; x.fillRect(0, 0, 16, 16); x.drawImage(i, 0, 0, 16, 16) } })
await p.screenshot({ path: 'favtest.png' }); await b.close()
