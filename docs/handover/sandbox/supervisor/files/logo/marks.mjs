// Each mark draws on a 512x512 canvas. fg = main ink, ac = accent, mute = faint ink.
export const MARKS = {
  reticle: { name: 'A · Reticle', note: 'The O of "zeroed" as a scope reticle.', svg: ({ fg, ac }) => `
    <circle cx="256" cy="256" r="146" fill="none" stroke="${fg}" stroke-width="30"/>
    <g stroke="${fg}" stroke-width="22" stroke-linecap="butt">
      <line x1="256" y1="110" x2="256" y2="196"/><line x1="256" y1="316" x2="256" y2="402"/>
      <line x1="110" y1="256" x2="196" y2="256"/><line x1="316" y1="256" x2="402" y2="256"/>
    </g>
    <circle cx="256" cy="256" r="20" fill="${ac}"/>` },
  zmark: { name: 'B · Z on target', note: 'A Z whose diagonal runs through dead centre.', svg: ({ fg, ac }) => `
    <polyline points="146,152 366,152 146,360 366,360" fill="none" stroke="${fg}" stroke-width="44" stroke-linejoin="miter" stroke-miterlimit="10"/>
    <g stroke="${ac}" stroke-width="12">
      <line x1="256" y1="70" x2="256" y2="112"/><line x1="256" y1="400" x2="256" y2="442"/>
      <line x1="70" y1="256" x2="112" y2="256"/><line x1="400" y1="256" x2="442" y2="256"/>
    </g>
    <circle cx="256" cy="256" r="30" fill="none" stroke="${ac}" stroke-width="10"/>` },
  group: { name: 'C · Tight group', note: 'Three shots in one hole: what a zeroed rifle does.', svg: ({ fg, ac, mute, bg }) => `
    <circle cx="256" cy="256" r="168" fill="none" stroke="${mute}" stroke-width="14"/>
    <g stroke="${mute}" stroke-width="14">
      <line x1="256" y1="62" x2="256" y2="150"/><line x1="256" y1="362" x2="256" y2="450"/>
      <line x1="62" y1="256" x2="150" y2="256"/><line x1="362" y1="256" x2="450" y2="256"/>
    </g>
    <g stroke="${bg}" stroke-width="12">
      <circle cx="236" cy="244" r="46" fill="${fg}"/>
      <circle cx="278" cy="240" r="46" fill="${fg}"/>
      <circle cx="258" cy="280" r="46" fill="${ac}"/>
    </g>` },
  turret: { name: 'D · Turret', note: 'A scope turret dialled to 0.', svg: ({ fg, ac, mute }) => {
    let ticks = ''
    for (let i = 0; i < 40; i++) {
      if (i === 0) continue
      const a = (i / 40) * Math.PI * 2 - Math.PI / 2
      const major = i % 10 === 0
      const r1 = 176, r2 = major ? 140 : 156
      ticks += `<line x1="${(256 + r1 * Math.cos(a)).toFixed(1)}" y1="${(256 + r1 * Math.sin(a)).toFixed(1)}" x2="${(256 + r2 * Math.cos(a)).toFixed(1)}" y2="${(256 + r2 * Math.sin(a)).toFixed(1)}" stroke="${major ? fg : mute}" stroke-width="${major ? 10 : 7}"/>`
    }
    return `${ticks}
    <line x1="256" y1="62" x2="256" y2="128" stroke="${ac}" stroke-width="16"/>
    <ellipse cx="256" cy="268" rx="62" ry="86" fill="none" stroke="${fg}" stroke-width="30"/>` } },
  slashed: { name: 'E · Crosshair zero', note: 'A zero split by a crosshair.', svg: ({ fg, ac }) => `
    <ellipse cx="256" cy="256" rx="112" ry="154" fill="none" stroke="${fg}" stroke-width="36"/>
    <g stroke="${ac}" stroke-width="12">
      <line x1="256" y1="58" x2="256" y2="214"/><line x1="256" y1="298" x2="256" y2="454"/>
      <line x1="58" y1="256" x2="214" y2="256"/><line x1="298" y1="256" x2="454" y2="256"/>
    </g>
    <circle cx="256" cy="256" r="11" fill="${ac}"/>` },
}
// Heavier reticle sized to replace the o in the wordmark (stroke matches Geist SemiBold stems).
export const wordO = ({ fg, ac }) => `
  <circle cx="256" cy="256" r="178" fill="none" stroke="${fg}" stroke-width="58"/>
  <g stroke="${fg}" stroke-width="38">
    <line x1="256" y1="100" x2="256" y2="196"/><line x1="256" y1="316" x2="256" y2="412"/>
    <line x1="100" y1="256" x2="196" y2="256"/><line x1="316" y1="256" x2="412" y2="256"/>
  </g>
  <circle cx="256" cy="256" r="30" fill="${ac}"/>`
