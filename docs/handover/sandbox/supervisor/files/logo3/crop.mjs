import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs'
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })
const p = await b.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 })
await p.goto('file://' + process.cwd() + '/sheet.html'); await p.evaluate(() => document.fonts.ready)
await p.evaluate(async () => { for (const c of document.querySelectorAll('canvas[data-svg]')) {
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + c.dataset.svg; await img.decode()
  const x = c.getContext('2d'); x.fillStyle = '#0A0B0D'; x.fillRect(0, 0, 16, 16); x.drawImage(img, 0, 0, 16, 16) } })
const els = await p.$$('.fav'); for (let i = 0; i < els.length; i++) await els[i].screenshot({ path: `fav-check-${i}.png` }); await b.close()
