// Renders the Android launcher icons and splash mark from the Zeroed mark. Run once; the PNGs are committed.
// Run: node brand/android-icons.mjs   (needs the Playwright + Chromium this environment preinstalls; no repo dependency)
import { readFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RES = join(HERE, '..', 'apps/web/android/app/src/main/res')
const MARK = readFileSync(join(HERE, 'zeroed-mark.svg'), 'utf8').match(/ d="([^"]+)"/)[1]
const INK = '#0D0F12'
const PAPER = '#ECEFF3'
const TILE = '#1B1C20' // flat tile colour behind the adaptive foreground (the app icon's tile runs 2B2D31 to 0E0F11)

const metal = `<defs><linearGradient id="m" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#C4C9D0"/></linearGradient></defs>`
// Mark centred on a size x size canvas, disc diameter = frac * size (the mark's disc is 416 of 512).
const markAt = (size, frac, fill) => {
  const k = (frac * size) / 416
  return `<g transform="translate(${size / 2} ${size / 2}) scale(${k}) translate(-256 -256)" fill="${fill}"><path fill-rule="evenodd" d="${MARK}"/></g>`
}
const svg = (size, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${body}</svg>`

const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }
const { chromium } = await import('/opt/node-tools/node_modules/playwright/index.mjs')
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })
const page = await browser.newPage()
const shot = async (markup, px, file, transparent = true) => {
  await page.setViewportSize({ width: px, height: px })
  await page.setContent(`<html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${Buffer.from(markup).toString('base64')}" width="${px}" height="${px}" style="display:block"></body></html>`)
  await page.waitForFunction(() => document.images[0].complete)
  await page.screenshot({ path: file, omitBackground: transparent })
}

for (const [d, scale] of Object.entries(DENSITIES)) {
  const dir = join(RES, `mipmap-${d}`)
  mkdirSync(dir, { recursive: true })
  const fg = Math.round(108 * scale) // adaptive layer: 108 dp, safe zone 66 dp
  const leg = Math.round(48 * scale) // legacy launcher: 48 dp
  // Foreground: mark disc 50 dp inside the 66 dp safe zone, on transparent.
  await shot(svg(fg, metal + markAt(fg, 50 / 108, 'url(#m)')), fg, join(dir, 'ic_launcher_foreground.png'))
  // Legacy square (rounded tile) and round icons: tile plus mark.
  const tile = (r) => `<rect width="${leg}" height="${leg}" rx="${r}" fill="${TILE}"/>`
  await shot(svg(leg, metal + tile(leg * 0.225) + markAt(leg, 0.58, 'url(#m)')), leg, join(dir, 'ic_launcher.png'))
  await shot(svg(leg, metal + tile(leg / 2) + markAt(leg, 0.56, 'url(#m)')), leg, join(dir, 'ic_launcher_round.png'))
}

// Splash mark: 288 dp canvas at xxxhdpi, disc 120 dp so it sits inside the 192 dp circle the system masks to.
for (const [dir, ink] of [['drawable-nodpi', INK], ['drawable-night-nodpi', PAPER]]) {
  mkdirSync(join(RES, dir), { recursive: true })
  await shot(svg(1152, markAt(1152, 120 / 288, ink)), 1152, join(RES, dir, 'splash_mark.png'))
}
await browser.close()
console.log('done')
