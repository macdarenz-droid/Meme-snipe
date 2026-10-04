# Zeroed: logo research (Linear, Vercel, Height and peers)

Date: 2026-10-03. Purpose: give the Zeroed logo redesign a factual base. The goal is a mark in the league of Linear, Vercel and Height, not a Figma-template look.

How this was checked: wherever possible I downloaded the official SVG/PNG brand kits and measured the vector paths myself (local copies are in `research/assets/`). Anything taken from a secondary source is marked **[secondary]**. Anything I could not confirm is marked **[unverified]**.

---

## 1. The three reference brands

### 1.1 Linear

Sources: brand page https://linear.app/brand (also served at https://linear.app/docs/brand-guidelines), official kit https://static.linear.app/design-assets/Linear-Brand-Assets.zip, favicon https://linear.app/static/favicon.svg, touch icon https://linear.app/static/apple-touch-icon.png.

**Mark: how it is built (measured from `logo-dark.svg`, viewBox 0 0 100 100)**
- It is one circle cut by three parallel 45° gaps, which leaves **4 solid filled pieces**. Running from the lower-left: a small lens, two thin bands, then the large body (the rest of the disc). The gaps run from upper-left to lower-right.
- I measured along the diagonal through the centre at 1000 px. As a share of the diameter: lens 9.2%, gap 7.4%, band 7.5%, gap 7.4%, band 7.4%, gap 7.5%, body 53.7%. **Bands and gaps are the same width**, which gives an even rhythm, and the body takes about half the disc.
- All pieces are filled and none are stroked. The meaning sits in the gaps (negative space): it reads as a sphere or "sunset" with speed lines.
- Every band end has a tiny rounded corner (curves of about 0.2 to 0.9 units out of 100). The ends are softened but still look sharp.
- Colour: one flat colour. The kit uses `#222326` ("Nordic Gray") on light backgrounds and white on dark ones. The brand page names Mercury White `#F4F5F8` and Nordic Gray `#222326` and calls the brand colour "a subtle desaturated blue". The page says the accent colours are "preferred for monochrome wordmark usage".

**Wordmark**
- "Linear" in a neutral grotesk with tight spacing, set beside the mark. The mark is roughly as tall as the cap height plus descender space (see `wordmark-dark.png`).
- Typeface: Linear does **not** name it in its guidelines. Secondary sources say it is set in Inter **[secondary: designyourway.net/blog/linear-logo]**, and the letterforms match Inter or Inter Display. Whether it was custom-drawn is **[unverified]**.
- From the guidelines: "the Linear wordmark has stronger brand recognition". Use the wordmark when there is space, and the mark when space is tight. "A stylized icon with appropriate corner radius is acceptable" for social media and chips.
- Origin: secondary sources say co-founder Karri Saarinen designed it in-house in 2019 **[secondary]**.

**App icon compared with the flat mark (`linear-icon.svg`, 512 px canvas, and `linear-app-icon.png`)**
- Background: a dark vertical gradient from `#2D2E31` to `#0F1012`. The mark spans 96 to 416 px, so it fills **62.5% of the tile**.
- The mark has a white-to-`#CCC` vertical gradient, a radial white highlight from the top, a 5 px **50%-white inner edge stroke in soft-light blend** (a bevelled rim), a blurred copy behind it, and a −5 px upward glow in "plus-lighter" blend.
- The macOS PNG renders this as **brushed or anodised metal** with lit bevels on a dark squircle. Depth comes only from light and material. The shape is unchanged.

**16 px favicon**
- `favicon.svg` is drawn on its own 16×16 viewBox: a black square with `rx=2` and a white mark spanning 2 to 14 px (12 px diameter). At that size each gap is about 0.9 px, so the stripes only just survive. The shape still reads as "a circle with a hatched corner". My 16 px render confirms this.

**Motion:** I found no official brand-motion spec **[not found]**.

### 1.2 Vercel

Sources: brand page https://vercel.com/geist/brands, official kit https://k2mkucxia43oc7fa.public.blob.vercel-storage.com/front/press/vercel-assets.zip, font page https://vercel.com/font, basement.studio write-ups https://basement.studio/post/scaling-vercel-years-of-building-refining-and-elevating and https://basement.studio/showcase/geist-strengthening-vercels-visual-identity, rename post https://vercel.com/blog/zeit-is-now-vercel.

**Mark (measured from `vercel-icon-light.svg`)**
- A single filled triangle pointing up: `M577.344 0 L1154.69 1000 H0 Z`. The width-to-height ratio is 1.1547, which is exactly **equilateral**. It has **sharp corners with no radius**, no stroke and no internal detail, so it is one element.
- Colour: pure black or pure white only. From the guidelines: "Choose the variant for the destination's background", and "Preserve the artwork, proportions, and colors."
- The guidelines also allow the mark to be typed as text: "The Vercel symbol can be used as a Unicode symbol (▲ U+25B2)". The mark is simple enough to exist as a single character.
- Clear space: "The safety area surrounding the Primary Logo is defined by the height of our symbol."

**Logotype (measured from `vercel-logotype-light.svg`, 2048×407)**
- The triangle is 406.5 units tall and the cap height is 369.5, so the triangle is **1.10× the cap height**. It overshoots the cap line by 18.5 units at the top and the baseline by 18.5 at the bottom, **an equal optical overshoot on both sides**. A pointed shape looks smaller than a flat-topped letter, so it is drawn bigger to look equal.
- The V is kerned in tight: its top-left corner (x≈460) sits left of the triangle's bottom-right corner (x≈467).
- The letters are a tight geometric grotesk with flat, slightly angled cut terminals on e, c and r.
- Typeface: basement.studio says it redesigned the logo "alongside developing Geist", Vercel's custom typeface. Vercel says Geist draws "inspiration from the renowned Swiss design movement". Basement says the original mark "carried inconsistencies, with irregular glyphs and structural imbalances" and that the result has "cleaner geometry, improved balance, and optimized scalability". Neither primary source says outright that the logotype is set in Geist, so it may be custom lettering derived from Geist **[unverified]**.

**App icon / touch icon**
- `apple-touch-icon-180x180.png` is a flat white triangle centred on a flat black square. It has **no gradient, light or glass**. Vercel adds no depth at all.

**16 px favicon**
- The ICO has 48 and 32 px sizes. A solid triangle stays perfectly legible at 16 px (checked by rendering). Of all the marks here it scales best.

**Motion:** I found no official logo-motion spec **[not found]**. Vercel's site uses triangle and prism imagery, but I did not verify that as a brand rule.

### 1.3 Height (shut down 24 Sep 2025)

Sources: shutdown news https://alternativeto.net/news/2025/3/height-project-management-tool-to-shut-down-by-september-2025/, founder's post https://x.com/michaelvillar/status/1903820617683501100, logo copy https://techround.co.uk/wp-content/uploads/2025/01/height-transparent-logo.png (third-party copy, Jan 2025) **[secondary]**.

**Caveat:** height.app no longer answers. web.archive.org and archive.ph are blocked from this environment (connection reset and "unable to fetch"). I could therefore **not** check the logo against an archived height.app page. The description below comes from the 2025 third-party copy.

**Mark (from the TechRound copy)**
- One **thick monoline ribbon with round caps** loops twice into a lowercase-"h"-like knot (two linked rounded loops). It is **stroked, not filled**.
- It is split into **six colour segments**: orange, amber, green, blue, magenta and pink-red. That makes it a full-spectrum multicolour mark, which sets it apart from the monochrome Linear and Vercel.
- Wordmark: lowercase "height" in a geometric sans with flat-cut terminals. The mark's cap height roughly matches the wordmark's ascender height. The typeface name is **[unverified]**.

**App icon, 16 px and motion:** all **[unverified]**. I could not retrieve the official icon or favicon (Google and DuckDuckGo favicon caches return 404 or placeholders).

**What Height adds to the brief:** a stroked, multicolour mark *can* look premium if the stroke is very thick, the caps are round and the path is one continuous line. It is also the hardest of the three to keep legible at 16 px and in one colour. It is the riskiest model to copy.

---

## 2. Peer brands in the same league (built from their official files)

| Brand | Mark construction (1–2 lines) | Source |
|---|---|---|
| **Raycast** | An axis-aligned solid square inside a 45° diamond of **parallel diagonal bands ("rays")**. The light and dark versions swap which parts are solid (figure and ground). Brand red `#FF6363` on `#151515`. The app icon is a dark glossy squircle with a red glowing rim. | https://www.raycast.com/press (logo PNGs on fz1sd71lwhbqy6sh.public.blob.vercel-storage.com/press/images/logo/) |
| **Cursor** | A rounded-corner **hexagon (isometric cube) with a cursor-arrow triangle cut out** as negative space. It is one even-odd path. Officially it comes in 2D (default), 2.5D and 3D: "Logos are available in 2D (default) and 2.5D", and app icons in "2.5D (default), 2D, and 3D". The 2.5D icon shades each cube face a different grey. | https://cursor.com/brand plus the kit zip |
| **Stripe** | The official logo is the **wordmark only**, a custom heavy lowercase "stripe" with every cut slanted at one shared angle (t top, i dot, p descender). Colour `#533AFD`. The favicon reduces it to **one slanted parallelogram (the "stripe")** on a `#533AFD` tile with radius 12.5%. | https://stripe.com/newsroom/brand-assets, favicon SVG on images.stripeassets.com |
| **Supabase** | A lightning bolt made of **two offset filled halves with softly rounded corners**. The top half is flat `#3ECF8E`. The bottom half has a `#249361`→`#3ECF8E` gradient plus a 20% shadow overlay, giving a slight fold. | https://supabase.com/brand-assets plus `brand-assets.zip` |
| **Resend** | A single filled **geometric "R"**: square top bar and bowl, a pointed wedge, and a diagonal leg. Black or white only. The SVG puts the mark in the middle 50% of an 1800 px canvas, so padding is built in. "Use the Resend wordmark for stronger brand recognition." | https://resend.com/brand, https://cdn.resend.com/brand/resend-icon-black.svg |
| **Clerk** | A "C" built from **three filled pieces around one centre point**: a solid dot (r 20 of 128), a lower arc band, and an upper C-arc at **40% opacity**. Two values of one colour `#131316` give depth without a gradient. | https://clerk.com/design, `/v2/downloads/symbol-dark.svg` |
| **Attio** | **Two rounded parallelogram or rhombus blocks** (one tall, one small), each with an inner outline, forming an abstract "A" shape. Solid black. The guidelines say: "do not warp, stretch, recolor, or redraw". | https://attio.com/brand, `/brand/v1/attio-logomark.svg` |
| **Mercury** | A **symmetrical interlaced roundel**: a ring holding a four-way knot of loops, drawn as filled outlines in one colour (`#272735`, which flips to `#F4F5F9` in dark mode inside the SVG). It is the ornate exception and works because it is strictly symmetrical and single-colour. | https://mercury.com/icon.svg (from the mercury.com `<head>`) |
| **Zed** (reference for a "Z" mark) | A **Z inside a square outline**, drawn in strokes. Brand blue plus black or white. | https://zed.dev/brand |

I checked these marks at 16 px by rendering them locally. Vercel, Supabase, Stripe's parallelogram and Clerk survive cleanly. Linear's stripes just survive (gaps of about 0.9 px). Attio's inner outlines vanish, and Mercury's interlace turns into a grey ring.

---

## 3. Construction rules these marks share

1. **One idea, one silhouette.** Each mark is a single geometric idea: triangle, sliced sphere, bolt, cube with a cut, sliced parallelogram. You could describe each in five words.
2. **Solid fill beats thin strokes.** Linear, Vercel, Supabase, Resend, Clerk, Cursor and Stripe are all filled shapes. The two stroked marks (Height, Zed) are the hardest to read small. If you use a stroke, make it very heavy (at least 10–12% of the mark's width), as Height does.
3. **Meaning lives in negative space or a single cut.** Linear's gaps, Cursor's arrow cut-out, Supabase's split and Stripe's slanted cuts all work this way. The idea is made by *removing* something, not by adding parts.
4. **Few parts (1–4).** Vercel has 1, Resend 1, Cursor 1 (with a hole), Supabase 2, Clerk 3, Linear 4. None of them uses more than about 4 separate pieces.
5. **A strict internal rhythm.** In Linear the band and gap widths are equal (about 7.4% of the diameter each). Stripe uses one cut angle for every slant. Vercel's triangle is exactly equilateral. Pick one module and one angle and reuse them.
6. **Optical corrections, not raw maths.** Vercel's triangle is 1.10× the cap height and overshoots the top and bottom equally. Linear rounds every band end very slightly. Pointed and round shapes must be drawn larger than flat ones to look the same size.
7. **Works in one flat colour first.** Every flat mark ships in black and white (Vercel, Resend, Attio and Linear officially). Colour is an extra layer on top. Clerk gets depth from two opacities of one colour, not from two colours.
8. **Depth belongs to the app icon, not the mark.** Linear (brushed metal, bevel, top light), Cursor (2.5D and 3D shaded faces) and Raycast (glossy glow rim) add material and light *only* in the app icon. The flat mark keeps the same shape.
9. **The app icon is the mark on a dark tile with generous margin.** Linear's mark fills 62.5% of the tile. Vercel's touch icon uses about 50%, and Resend's SVG 50%. Most use dark neutral grounds (`#0F1012`–`#2D2E31`, `#151515`, black).
10. **Draw a dedicated 16 px version.** Linear's favicon is redrawn on a 16×16 grid with its own tile and `rx=2`. Stripe's favicon cuts the wordmark down to one parallelogram. Test at 16 px and simplify until the shape survives.
11. **The wordmark is a quiet, tight grotesk.** Inter-like or Geist-like letters with negative tracking. Only Stripe's wordmark carries a custom quirk (the slant cuts). The mark does the talking.
12. **Strict usage rules.** "Preserve the artwork, proportions, and colors" (Vercel), "do not warp, stretch, recolor, or redraw" (Attio), plus clear space set by the mark's own height (Vercel).

### Avoid: things that make a mark look like a template
- Stock-icon geometry, especially for Zeroed: a plain **crosshair** or **concentric target**. These exist as free icons in Lucide (`crosshair`, `target` = three concentric circles), Material (`gps_fixed`) and Font Awesome (`crosshairs`). A mark built from them will look like an icon pack.
- Thin uniform strokes with no cut or twist (a hairline circle with a plus through it).
- Letter-in-a-box or letter-in-a-circle with no idea in the negative space (the Zed-style "Z in a square" is already taken in tech).
- Generic purple-to-blue or neon gradients on the flat mark, glows, bevels or glass on the logo itself. Keep those for the app icon.
- More than about 4 parts, mixed corner radii, or angles that do not repeat.
- Default-font wordmarks with default tracking, or a wordmark with a coloured gradient.
- Literal sniper props: scopes, bullets, skulls, rifle silhouettes. Also crypto clichés: coin edges, ₿-style strokes, rockets.
- A design that only works in colour, or only works large.

---

## 4. Name and look-alike check: "Zeroed"

### Conflicts found

| Name / mark | What it is | Risk | Link |
|---|---|---|---|
| **ZEROED** (USPTO serial 90571035) | A design mark: "a target symbol with the word 'zeroed' placed right of center", for firearm attachments and accessories (Class 13). Filed 2021-03-10. Last status seen: "Response After Non-Final Action – Entered" (2022-02-04). The current status is **[unverified]**: the USPTO TSDR API now needs a key, Justia returned 403, and the status came from search snippets. This is the **same idea as ours (target + "zeroed")** in a sniping-related field. | **High** for visual and concept confusion. The goods class is different (firearms, not software or finance). | https://trademarks.justia.com/905/71/zeroed-90571035.html |
| **ZEROED** (USPTO serial 90562546) | A standard-character "ZEROED" mark, same applicant and goods, filed 2021-03-05, same status as above **[unverified current status]**. | **Medium** | https://trademarks.justia.com/905/62/zeroed-90562546.html |
| **ZeroedIn Technologies** (zeroedin.com) | A workforce analytics and decision-intelligence software company, founded 2004. A close name variant ("Zeroed In") in software. | **Medium** (software, though not trading) | https://www.zeroedin.com/ , https://www.appsruntheworld.com/hcm-top-500-software-vendors/zeroed-in-technologies/ |
| **ZERO-IN ASSN.** (USPTO 97597998) | "A shape of a zero with two arrows across the middle", for apparel. A zero-plus-aim idea. | **Low–medium** (visual concept) | https://trademarks.justia.com/975/97/zero-in-97597998.html |
| **Target Corporation bullseye** | A red ring plus a centre dot, one of the most famous marks in the world. Any "0 with a dot in the middle", especially in red, will read as Target. | **High** if we use ring + dot | https://upload.wikimedia.org/wikipedia/commons/9/9a/Target_logo.svg |
| **Zerion** (crypto wallet) | A "Z" made of two white wedges on a blue squircle. A Z mark in crypto. | **Medium** for a Z-based mark | https://zerion.io/ |
| **Zed** (code editor) | A Z inside a square outline. | **Low–medium** for a Z-in-frame mark | https://zed.dev/brand |
| **runZero** | A glyph merging "r" and a zero with a skew. Its blog post is titled "Zeroing in on our logo". | **Low** | https://www.runzero.com/blog/runzero-logo-design/ |
| **zerohash** | Crypto and stablecoin infrastructure, "zero" prefix, valued at $1B. | **Low** (name prefix only) | https://zerohash.com/ |
| Stock icons (Lucide crosshair/target, Material gps_fixed, Font Awesome crosshairs) | Free generic icons, not trademarks. | **High "template" risk** (see the Avoid list) | https://lucide.dev/icons/crosshair |

### Not found
- No App Store app (iOS or macOS) named "Zeroed". I searched Apple's search API for `term=zeroed` with `entity=software` and `entity=macSoftware`, 25 results each.
- No crypto, Solana or trading product named "Zeroed", "Zero'd" or "Zerod" turned up in web searches. ("Zerod" only returned ZeroDev, an unrelated wallet SDK.)

### How I searched
- Web searches: `"Zeroed" app crypto OR trading OR fintech`, `"Zeroed" company OR startup OR app logo`, `"Zeroed In" app OR company OR trademark`, `"zeroed" solana OR memecoin OR sniper bot`, `"Zero'd" OR "Zerod" app OR crypto OR company`, `"ZEROED" trademark USPTO`, `"zeroed" github OR producthunt trading app`, `crypto trading bot crosshair logo solana sniper target logo brand`.
- Apple iTunes Search API, as above.
- Domain probes for zeroed.com, .app, .io, .xyz, .fi and .trade. All failed at the proxy (502 or reset), so this is **inconclusive**: it does not show the domains are free. zeroedin.com resolves (ZeroedIn Technologies).
- **Not checked** (blocked or out of scope): USPTO TSDR (API key needed), Justia detail pages (403), EUIPO, WIPO Global Brand Database and IP Australia. The owner deals in AUD, so **IP Australia** (https://search.ipaustralia.gov.au/trademarks/search) should be checked by hand before any public use.

### What this means for the mark
- Do **not** pair the word "zeroed" with a target or crosshair symbol. That is exactly what the firearm-accessory application describes.
- Avoid a ring plus a centre dot, especially in red, because of Target.
- If the mark is Z-based, keep clear of "Z in a square" (Zed) and "Z from two wedges on a squircle" (Zerion).
- Stronger direction, based on the rules above: express "zeroed" through **one cut or alignment in a solid shape**. For example, a filled form whose negative-space slot or notch lines up exactly on centre, which reads as "aligned and proven" rather than "aim". Show depth only in the app icon, and draw a dedicated 16 px version.

---

## Local evidence files
All in `/tmp/claude-0/-home-user-Meme-snipe/bfe97b8d-9361-5e1a-a5d2-7a95e7d0e23b/scratchpad/research/assets/`:
- `linear/` (official kit), `linear-favicon.svg`, `linear-touch.png`
- `vercel/` (official kit), `vercel-touch180.png`
- `height-techround.png` (third-party copy of the Height logo)
- `marks/` (Raycast, Cursor kit, Stripe kit, Supabase kit, Resend, Clerk, Attio, Mercury, Zed, Zerion, Target), `marks/sheet1.png` (contact sheet) and `marks/sheet16.png` (16 px test)
