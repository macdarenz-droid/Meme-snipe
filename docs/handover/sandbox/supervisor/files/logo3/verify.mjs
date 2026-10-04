import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs'
import { readFileSync } from 'node:fs'
import { MARKS } from './marks.mjs'
const maskSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${MARKS.slot.svg('#0D0F12', 'q')}</svg>`
const pathSvg = readFileSync('/home/user/Meme-snipe/brand/zeroed-mark-ink.svg', 'utf8')
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })
const p = await b.newPage()
const diff = await p.evaluate(async ([a, c]) => {
  const px = async s => { const i = new Image(); i.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s); await i.decode(); const cv = document.createElement('canvas'); cv.width = cv.height = 512; const x = cv.getContext('2d'); x.drawImage(i, 0, 0); return x.getImageData(0, 0, 512, 512).data }
  const A = await px(a), B = await px(c); let n = 0, max = 0
  for (let i = 3; i < A.length; i += 4) { const d = Math.abs(A[i] - B[i]); if (d > 32) n++; max = Math.max(max, d) }
  return { pixelsOff: n, maxAlphaDiff: max }
}, [maskSvg, pathSvg])
console.log(diff)
const s = `<body style="margin:0;background:#08090B;display:flex;gap:24px;padding:24px;align-items:center">
<img src="/home/user/Meme-snipe/brand/zeroed-app-icon-1024.png" width="220">
<img src="/home/user/Meme-snipe/brand/favicon-16.png" width="128" style="image-rendering:pixelated;background:#fff">
<div style="display:flex;flex-direction:column;gap:12px"><img src="/home/user/Meme-snipe/brand/zeroed-lockup-ink.png" width="420"><img src="/home/user/Meme-snipe/brand/zeroed-lockup-paper.png" width="420"></div></body>`
await p.setViewportSize({ width: 960, height: 270 }); await p.goto('file:///'); await p.setContent(s.replaceAll('src="/', 'src="file:///'))
await p.waitForTimeout(300); await p.screenshot({ path: 'final-check.png' }); await b.close()
