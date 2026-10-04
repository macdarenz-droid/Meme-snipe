// Round 3: one idea (a solid zero split by a Z-shaped cut), drawn three ways.
// 512 grid. Disc diameter 416. Cut width = 7.5% of the diameter (Linear-like rhythm). One 45° angle throughout.
const C = 256, R = 208, G = 31, A = 72
const mask = (id, solid, holes) => `<defs><mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512"><rect width="512" height="512" fill="black"/>${solid}${holes}</mask></defs>`
const zcut = (x0, x3, a, w, limit) => `<polyline points="${x0},${C - a} ${C + a},${C - a} ${C - a},${C + a} ${x3},${C + a}" fill="none" stroke="black" stroke-width="${w}" stroke-linejoin="miter" stroke-miterlimit="${limit}"/>`

export const MARKS = {
  split: { name: 'Split', note: 'The cut runs edge to edge: two identical halves, turned 180°.',
    svg: (ink, id) => mask(id, `<circle cx="${C}" cy="${C}" r="${R}" fill="white"/>`, zcut(0, 512, A, G, 2.4)) + `<rect width="512" height="512" fill="${ink}" mask="url(#${id})"/>` },
  slot: { name: 'Slot', note: 'The Z is cut into the zero but stops short: one solid piece.',
    svg: (ink, id) => mask(id, `<circle cx="${C}" cy="${C}" r="${R}" fill="white"/>`, zcut(C - 112, C + 112, 92, G + 6, 2.4)) + `<rect width="512" height="512" fill="${ink}" mask="url(#${id})"/>` },
  tall: { name: 'Tall zero', note: 'The same cut through the digit 0 instead of a disc.',
    svg: (ink, id) => mask(id, `<rect x="${C - 148}" y="${C - R}" width="296" height="${2 * R}" rx="148" fill="white"/>`, zcut(0, 512, 84, G, 2.4)) + `<rect width="512" height="512" fill="${ink}" mask="url(#${id})"/>` },
}

// Hand-tuned 16 px favicons (16 grid): fewer, wider features so the cut survives at real size.
export const FAV = {
  split: ink => `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><defs><mask id="f1" maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16"><rect width="16" height="16" fill="black"/><circle cx="8" cy="8" r="7" fill="white"/><polyline points="0,5.5 10.5,5.5 5.5,10.5 16,10.5" fill="none" stroke="black" stroke-width="1" stroke-linejoin="miter" stroke-miterlimit="2.4"/></mask></defs><rect width="16" height="16" fill="${ink}" mask="url(#f1)"/></svg>`,
  slot: ink => `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><defs><mask id="f2" maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16"><rect width="16" height="16" fill="black"/><circle cx="8" cy="8" r="7" fill="white"/><polyline points="4.5,5.5 10.5,5.5 5.5,10.5 11.5,10.5" fill="none" stroke="black" stroke-width="1" stroke-linejoin="miter" stroke-miterlimit="2.4"/></mask></defs><rect width="16" height="16" fill="${ink}" mask="url(#f2)"/></svg>`,
  tall: ink => `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><defs><mask id="f3" maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16"><rect width="16" height="16" fill="black"/><rect x="3" y="1" width="10" height="14" rx="5" fill="white"/><polyline points="0,5.5 10.5,5.5 5.5,10.5 16,10.5" fill="none" stroke="black" stroke-width="1" stroke-linejoin="miter" stroke-miterlimit="2.4"/></mask></defs><rect width="16" height="16" fill="${ink}" mask="url(#f3)"/></svg>`,
}
