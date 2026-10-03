// Builds every Zeroed brand file from one geometry. Run: node brand/build.mjs
// Needs the Playwright + Chromium that this environment preinstalls (for PNG export only); no repo dependency.
import { writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = dirname(fileURLToPath(import.meta.url))
const INK = '#0D0F12'
const PAPER = '#ECEFF3'

// The mark: a solid zero with a Z cut into it. The Z stops short of the edge, so the mark is one piece.
// Arms at C±a from x0 to x3 (butt ends), one 45° diagonal through the centre, cut width w,
// bevelled joins at the two acute corners. The cut is symmetric under a 180° turn.
export function slotPath(C, R, a, x0, x3, w) {
  const h = w / 2, s = h * Math.SQRT2, q = h / Math.SQRT2
  const yA = C - a, yB = C + a
  const hole = [
    [x0, yA - h], [C + a, yA - h], [C + a + q, yA + q],
    [2 * C + s - (yB - h), yB - h], [x3, yB - h], [x3, yB + h],
    [C - a, yB + h], [C - a - q, yB - q],
    [2 * C - s - (yA + h), yA + h], [x0, yA + h],
  ]
  const n = v => String(Number(v.toFixed(3)))
  const disc = `M${n(C - R)} ${n(C)}A${n(R)} ${n(R)} 0 1 1 ${n(C + R)} ${n(C)}A${n(R)} ${n(R)} 0 1 1 ${n(C - R)} ${n(C)}Z`
  return disc + 'M' + hole.map(([x, y]) => `${n(x)} ${n(y)}`).join('L') + 'Z'
}

const MARK = slotPath(256, 208, 92, 144, 368, 37)   // 512 grid: disc 416, cut 37 (8.9% of the diameter)
const FAV = slotPath(8, 7, 2.5, 4.5, 11.5, 1)        // 16 grid: drawn for real 16 px, cut on whole pixels

const markSvg = fill => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><path fill="${fill}" fill-rule="evenodd" d="${MARK}"/></svg>\n`
const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"><style>path{fill:${INK}}@media (prefers-color-scheme:dark){path{fill:${PAPER}}}</style><path fill-rule="evenodd" d="${FAV}"/></svg>\n`
const appIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
<defs>
<linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2B2D31"/><stop offset="1" stop-color="#0E0F11"/></linearGradient>
<radialGradient id="light" cx="0.5" cy="0" r="0.85"><stop offset="0" stop-color="#fff" stop-opacity="0.13"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
<linearGradient id="edge" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.22"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.04"/><stop offset="1" stop-color="#fff" stop-opacity="0.10"/></linearGradient>
<linearGradient id="metal" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#C4C9D0"/></linearGradient>
</defs>
<rect width="1024" height="1024" rx="230" fill="url(#tile)"/>
<rect width="1024" height="1024" rx="230" fill="url(#light)"/>
<rect x="4" y="4" width="1016" height="1016" rx="226" fill="none" stroke="url(#edge)" stroke-width="8"/>
<g transform="translate(512 540) scale(1.28) translate(-256 -256)" fill="#000" opacity="0.18"><path fill-rule="evenodd" d="${MARK}"/></g>
<g transform="translate(512 512) scale(1.28) translate(-256 -256)" fill="url(#metal)"><path fill-rule="evenodd" d="${MARK}"/></g>
</svg>\n`

// Wordmark lockup: mark at 1.1x cap height, Geist SemiBold, tight tracking. Font embedded (Geist is SIL OFL 1.1).
const font = readFileSync(join(OUT, 'geist-semibold.woff2')).toString('base64')
const lockupSvg = (ink, bg) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 160" width="560" height="160">
<style>@font-face{font-family:"Geist";src:url(data:font/woff2;base64,${font}) format("woff2");font-weight:600}text{font-family:"Geist",sans-serif;font-weight:600;font-size:96px;letter-spacing:-4.3px}</style>
${bg ? `<rect width="560" height="160" fill="${bg}"/>` : ''}
<g transform="translate(40 37) scale(0.1680)" fill="${ink}"><path fill-rule="evenodd" d="${MARK}"/></g>
<text x="138" y="114" fill="${ink}">Zeroed</text>
</svg>\n`

const files = {
  'zeroed-mark.svg': markSvg('currentColor'),
  'zeroed-mark-ink.svg': markSvg(INK),
  'zeroed-mark-paper.svg': markSvg(PAPER),
  'zeroed-favicon.svg': faviconSvg,
  'zeroed-app-icon.svg': appIconSvg,
  'zeroed-lockup-ink.svg': lockupSvg(INK),
  'zeroed-lockup-paper.svg': lockupSvg(PAPER),
}
for (const [name, body] of Object.entries(files)) writeFileSync(join(OUT, name), body)

if (process.argv.includes('--png')) {
  const { chromium } = await import('/opt/node-tools/node_modules/playwright/index.mjs')
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })
  const page = await browser.newPage()
  const shot = async (svg, size, file, bg = 'transparent') => {
    await page.setViewportSize({ width: size, height: size })
    await page.setContent(`<html><body style="margin:0;background:${bg}"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}" style="display:block"></body></html>`)
    await page.waitForFunction(() => document.images[0].complete)
    await page.screenshot({ path: join(OUT, file), omitBackground: bg === 'transparent' })
  }
  for (const s of [1024, 512, 192, 180]) await shot(appIconSvg, s, s === 180 ? 'apple-touch-icon.png' : `zeroed-app-icon-${s}.png`)
  await shot(faviconSvg.replace(/<style>.*<\/style>/, `<style>path{fill:${INK}}</style>`), 16, 'favicon-16.png')
  await shot(markSvg(INK), 32, 'favicon-32.png')
  for (const [name, ink, bg] of [['zeroed-lockup-ink.png', INK, '#FFFFFF'], ['zeroed-lockup-paper.png', PAPER, INK]]) {
    await page.setViewportSize({ width: 560, height: 160 }); await page.setContent(`<html><body style="margin:0">${lockupSvg(ink, bg)}</body></html>`)
    await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(100)
    await page.screenshot({ path: join(OUT, name), scale: 'device' })
  }
  await browser.close()
}
console.log(Object.keys(files).join('\n'))
