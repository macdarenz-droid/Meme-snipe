# Brand

## Name
Zeroed (owner, 2026-10-03). A rifle is zeroed when the shot lands exactly where it aims: precision earned by checking first.

## Mark
"Slot" (owner, 2026-10-03): a solid zero with a Z cut into it. The Z passes through dead centre and stops short of the edge, so the mark is one piece.

Construction (512 grid, `brand/build.mjs` is the source of truth):
- Disc diameter 416, centred.
- Cut width 37 (8.9% of the diameter). Arms at y 164 and 348; top arm x 144–348, bottom arm x 164–368; one 45° diagonal through the centre. The cut is symmetric under a 180° turn.
- The two acute corners of the cut are bevelled, not mitred, so they stay crisp when small.
- The 16 px favicon is drawn separately on a 16 grid, with the cut on whole pixels.

Why this mark: research into Linear, Vercel, Height, Raycast, Cursor, Resend and Stripe found that premium marks are one solid idea, with the meaning carried by what is cut away, in one colour first, and with depth only on the app icon. Of the three cuts shown (Split, Slot, Tall zero), the owner chose Slot. Crosshairs and targets were rejected: they are free stock icons, a ring with a dot reads as Target's bullseye, and a target symbol beside "ZEROED" is a pending US firearm-accessory trademark (serial 90571035).

## Files (`brand/`)
| File | Use |
|---|---|
| `zeroed-mark.svg` | Mark in `currentColor`, for the app UI |
| `zeroed-mark-ink.svg`, `zeroed-mark-paper.svg` | Mark in ink (#0D0F12) or paper (#ECEFF3) |
| `zeroed-favicon.svg` | Browser tab; switches ink for dark tabs |
| `favicon-16.png`, `favicon-32.png` | Fallback favicons |
| `zeroed-app-icon.svg`, `zeroed-app-icon-{1024,512,192}.png`, `apple-touch-icon.png` | App and home-screen icons |
| `zeroed-lockup-ink.svg/png`, `zeroed-lockup-paper.svg/png` | Mark with the word "Zeroed" |
| `geist-semibold.woff2` | Geist SemiBold (SIL Open Font License 1.1), embedded in the lockups |

Rebuild: `node brand/build.mjs --png`.

## Rules
- One colour: ink on light, paper on dark. Depth (tile, light, metal gradient) belongs only to the app icon.
- Wordmark: Geist SemiBold, tracking −0.045 em, mark at about 1.1× cap height, gap about 0.1 em.
- Clear space around the mark: at least a quarter of its diameter.
- Never stretch, rotate, outline, recolour the halves differently, add effects to the flat mark, or put it inside another shape.
- Smallest sizes: the 16 px favicon file below 24 px; the main mark from 24 px up.

## Open item
Before public launch, check "Zeroed" on IP Australia's trademark search (not reachable from the research tools).
