import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs'
import { MARKS, wordO } from './marks.mjs'
import { writeFileSync } from 'node:fs'

const DARK = { bg: '#0D0F12', fg: '#ECEFF3', ac: '#5B8CFF', mute: '#4A525E' }
const LIGHT = { bg: '#F6F7F9', fg: '#0D0F12', ac: '#2F6BFF', mute: '#C9CED6' }
const MONO = { bg: '#FFFFFF', fg: '#0D0F12', ac: '#0D0F12', mute: '#C9CED6' }

const icon = (k, t, size, radius = true) => `<svg width="${size}" height="${size}" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="g${k}${size}${t.bg.slice(1)}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.bg === DARK.bg ? '#171A20' : t.bg}"/><stop offset="1" stop-color="${t.bg}"/></linearGradient></defs>
  ${radius ? `<rect x="2" y="2" width="508" height="508" rx="114" fill="url(#g${k}${size}${t.bg.slice(1)})" stroke="${t.bg === DARK.bg ? '#262B33' : '#E1E4E9'}" stroke-width="4"/>` : ''}
  ${MARKS[k].svg(t)}</svg>`
const mark = (k, t, size) => `<svg width="${size}" height="${size}" viewBox="0 0 512 512">${MARKS[k].svg(t)}</svg>`

// save standalone SVGs
for (const k of Object.keys(MARKS)) {
  writeFileSync(`zeroed-${k}-icon.svg`, icon(k, DARK, 512))
}

const cell = k => `<div class="cell">
  <div class="hero">${icon(k, DARK, 208)}</div>
  <div class="sizes">${icon(k, DARK, 64)}${icon(k, DARK, 40)}${icon(k, DARK, 24)}${icon(k, LIGHT, 64)}</div>
  <div class="lockup">${mark(k, DARK, 40)}<span>zeroed</span></div>
  <div class="label"><b>${MARKS[k].name}</b><br>${MARKS[k].note}</div>
</div>`

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>@font-face{font-family:Geist;src:url(geist-600.woff2) format("woff2");font-weight:100 900;}</style>
<style>
  body { margin:0; background:#0B0D10; color:#ECEFF3; font-family: Geist, system-ui, sans-serif; }
  .wrap { padding:48px; }
  h1 { font-weight:600; font-size:28px; letter-spacing:-0.02em; margin:0 0 28px; }
  .grid { display:grid; grid-template-columns:repeat(5, 1fr); gap:20px; }
  .cell { background:#14171C; border:1px solid #262B33; border-radius:16px; padding:22px; display:flex; flex-direction:column; gap:18px; }
  .hero { display:flex; justify-content:center; }
  .sizes { display:flex; align-items:center; gap:12px; justify-content:center; }
  .lockup { display:flex; align-items:center; gap:8px; justify-content:center; }
  .lockup span { font-weight:600; font-size:30px; letter-spacing:-0.035em; }
  .label { font-size:14px; line-height:1.45; color:#9AA3AF; text-align:center; }
  .label b { color:#ECEFF3; font-weight:600; }
  .word { margin-top:20px; display:grid; grid-template-columns:1fr 1fr 240px; gap:20px; align-items:center; }
  .wm { border-radius:16px; padding:34px; text-align:center; font-weight:600; font-size:88px; letter-spacing:-0.045em; line-height:1; }
  .wm.dark { background:#14171C; border:1px solid #262B33; color:#ECEFF3; }
  .wm.light { background:#F6F7F9; color:#0D0F12; }
  .wl { font-size:14px; line-height:1.45; color:#9AA3AF; } .wl b { color:#ECEFF3; }
  .mono { margin-top:20px; background:#fff; border-radius:16px; padding:24px; display:flex; justify-content:space-around; }
  .mono svg { display:block; }
</style></head><body><div class="wrap">
<h1>Zeroed · logo concepts</h1>
<div class="grid">${Object.keys(MARKS).map(cell).join('')}</div>
<div class="word">${['dark','light'].map(m => { const t = m === 'dark' ? DARK : LIGHT; return `<div class="wm ${m}">zer<svg width="60" height="60" viewBox="0 0 512 512" style="vertical-align:-4px;margin:0 3px 0 2px">${wordO(t)}</svg>ed</div>` }).join('')}<div class="wl"><b>F · Wordmark</b><br>The reticle stands in for the o.</div></div>
<div class="mono">${Object.keys(MARKS).map(k => mark(k, MONO, 96)).join('')}</div>
</div></body></html>`
writeFileSync('sheet.html', html)

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })
const page = await browser.newPage({ viewport: { width: 1640, height: 900 }, deviceScaleFactor: 2 })
await page.goto('file://' + process.cwd() + '/sheet.html', { waitUntil: 'networkidle' })
await page.evaluate(() => document.fonts.ready)
await page.screenshot({ path: 'zeroed-logo-concepts.png', fullPage: true })
// one big render per concept
for (const k of Object.keys(MARKS)) {
  await page.setContent(`<html><body style="margin:0;background:#0B0D10;display:grid;place-items:center;height:100vh">${icon(k, DARK, 512)}</body></html>`)
  await page.setViewportSize({ width: 640, height: 640 })
  await page.screenshot({ path: `zeroed-${k}.png` })
}
await browser.close()
console.log('done')
