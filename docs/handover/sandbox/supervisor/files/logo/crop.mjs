import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs'
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })
const p = await b.newPage({ viewport: { width: 1640, height: 900 }, deviceScaleFactor: 2 })
await p.goto('file://' + process.cwd() + '/sheet.html'); await p.evaluate(() => document.fonts.ready)
await (await p.$('.word')).screenshot({ path: 'word-check.png' }); await b.close()
