// Solid marks on a 512 grid. Meaning is carried by negative space, cut with an SVG mask.
// Each returns inner SVG; `ink` fills the mark, `id` keeps mask ids unique per render.
const C = 256
const cut = (id, ink, solid, holes) => `
  <defs><mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
    <rect width="512" height="512" fill="black"/>${solid('white')}${holes('black')}
  </mask></defs>
  <rect width="512" height="512" fill="${ink}" mask="url(#${id})"/>`

export const MARKS = {
  zcut: { name: 'A · Z cut', note: 'A solid zero split by one Z-shaped cut through dead centre.',
    svg: (ink, id) => cut(id, ink,
      f => `<circle cx="${C}" cy="${C}" r="208" fill="${f}"/>`,
      f => `<polyline points="20,180 332,180 180,332 492,332" fill="none" stroke="${f}" stroke-width="40" stroke-linejoin="miter" stroke-miterlimit="8"/>`) },
  zhole: { name: 'B · Z, centre shot', note: 'A heavy Z with one clean hole through the centre.',
    svg: (ink, id) => cut(id, ink,
      f => `<polyline points="108,148 404,148 108,364 404,364" fill="none" stroke="${f}" stroke-width="84" stroke-linejoin="miter" stroke-miterlimit="10"/>`,
      f => `<circle cx="${C}" cy="${C}" r="50" fill="${f}"/>`) },
  quad: { name: 'C · Sight', note: 'A solid zero quartered by a crosshair, centre point left standing.',
    svg: (ink, id) => cut(id, ink,
      f => `<circle cx="${C}" cy="${C}" r="208" fill="${f}"/>`,
      f => `<rect x="0" y="${C - 18}" width="512" height="36" fill="${f}"/><rect x="${C - 18}" y="0" width="36" height="512" fill="${f}"/>`)
      + `<circle cx="${C}" cy="${C}" r="30" fill="${ink}"/>` },
  split: { name: 'D · Split zero', note: 'A tall 0 broken by the horizontal wire, with the aim point inside.',
    svg: (ink, id) => cut(id, ink,
      f => `<ellipse cx="${C}" cy="${C}" rx="150" ry="210" fill="${f}"/>`,
      f => `<ellipse cx="${C}" cy="${C}" rx="78" ry="138" fill="${f}"/><rect x="0" y="${C - 16}" width="512" height="32" fill="${f}"/>`)
      + `<circle cx="${C}" cy="${C}" r="28" fill="${ink}"/>` },
  index: { name: 'E · Index', note: 'A dial set to zero: a solid disc, one cut at twelve o’clock.',
    svg: (ink, id) => cut(id, ink,
      f => `<circle cx="${C}" cy="${C}" r="208" fill="${f}"/>`,
      f => `<rect x="${C - 20}" y="0" width="40" height="${C}" fill="${f}"/><circle cx="${C}" cy="${C}" r="20" fill="${f}"/>`) },
}
