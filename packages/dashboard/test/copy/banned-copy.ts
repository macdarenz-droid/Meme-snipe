/**
 * Words and phrases that must never appear in the dashboard's text (CLAUDE.md, "No AI wording in the UI"; AGENTS.md,
 * "UI copy"). The same list as apps/web/test/banned-copy.ts, which still guards apps/web: add to either, never remove
 * from either. copy-guard.test.ts checks that this list keeps every entry of the apps/web list and every phrase quoted
 * in CLAUDE.md's rule.
 */
import { CHEROKEE_SMALL, GENERATED_LOOKALIKE, L_OR_I, SMALL_CAPITALS } from './lookalikes.ts';

export interface Banned {
  label: string;
  pattern: RegExp;
}

const word = (w: string): Banned => ({ label: w, pattern: new RegExp(`\\b${w}\\b`, 'i') });
const apostrophe = (w: string): Banned => ({ label: `${w}'s`, pattern: new RegExp(`\\b${w}['’]s\\b`, 'i') });

export const BANNED: Banned[] = [
  { label: 'AI', pattern: /\bAI\b/ },
  { label: 'A.I.', pattern: /\bA\.I\./i },
  { label: 'artificial intelligence', pattern: /\bartificial intelligence\b/i },
  { label: 'models', pattern: /\bmodels?\b/i },
  { label: 'LLM', pattern: /\bLLMs?\b/i },
  { label: 'assistants', pattern: /\bassistants?\b/i },
  { label: 'smart', pattern: /\bsmart(er|est|ly)?\b/i },
  { label: 'intelligent', pattern: /\bintelligen(t|tly|ce)\b/i },
  word('at a glance'),
  { label: 'seamless', pattern: /\bseamless(ly)?\b/i },
  { label: 'effortless', pattern: /\beffortless(ly)?\b/i },
  { label: 'unlock', pattern: /\bunlock(s|ed|ing)?\b/i },
  { label: 'elevate', pattern: /\belevat(e|es|ed|ing)\b/i },
  { label: 'empower', pattern: /\bempower(s|ed|ing|ment)?\b/i },
  { label: 'leverage', pattern: /\bleverag(e|es|ed|ing)\b/i },
  { label: 'delve', pattern: /\bdelv(e|es|ed|ing)\b/i },
  word('dive in'),
  word('dive into'),
  word('deep dive'),
  word('robust'),
  word('cutting-edge'),
  word('cutting edge'),
  { label: 'harness', pattern: /\bharness(es|ed|ing)?\b/i },
  { label: 'supercharge', pattern: /\bsupercharg(e|es|ed|ing)\b/i },
  { label: 'streamline', pattern: /\bstreamlin(e|es|ed|ing)\b/i },
  word('insights'),
  word('insight'),
  word('journey'),
  { label: 'game-changer', pattern: /\bgame[- ]chang(er|ing)\b/i },
  word('powered by'),
  apostrophe('Let'),
  apostrophe('Here'),
  { label: 'sparkles', pattern: /[✨\u{1F31F}\u{1F4AB}]|\bsparkles?\b/iu },
  word('magic'),
  word('magical'),
  word('in plain words'),
  word('not medical advice'),
  // Z05 round 2 (red team m1): AI in any letter case ("Ai", "ai"), on top of the apps/web entry above.
  { label: 'AI (any case)', pattern: /\bai\b/i },
];

/**
 * Latin look-alikes from other scripts (Cyrillic, Greek, Armenian and others) that NFKC leaves as they are, mapped to the
 * Latin letter they imitate, so "Ѕmart" (Cyrillic S) or "sеamless" (Cyrillic e) are caught (Z05 round 2, red team m1).
 */
const LOOKALIKE: Readonly<Record<string, string>> = {
  'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'з': '3', 'і': 'i', 'ї': 'i', 'ј': 'j', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o',
  'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'ѕ': 's', 'ԁ': 'd', 'һ': 'h', 'ӏ': 'l', 'ԛ': 'q', 'ԝ': 'w', 'ү': 'y',
  'А': 'A', 'В': 'B', 'Е': 'E', 'І': 'I', 'Ј': 'J', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T',
  'У': 'Y', 'Х': 'X', 'Ѕ': 'S', 'Ԁ': 'D', 'Ӏ': 'I', 'Ү': 'Y', 'Ԛ': 'Q', 'Ԝ': 'W',
  'α': 'a', 'β': 'b', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x', 'γ': 'y',
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T',
  'Υ': 'Y', 'Χ': 'X', 'ı': 'i', 'ɡ': 'g', 'ɑ': 'a', 'օ': 'o', 'ս': 'u', 'ց': 'g', 'ⅼ': 'l', 'ǀ': 'l',
};

/**
 * The text a reader sees, for matching (Z05 round 2, red team m1; round 3, ruling 14): NFKC (fullwidth and
 * compatibility letters become plain ones), format characters and other default-ignorable code points removed, and
 * look-alike letters (the table above, then every single-letter skeleton of Unicode's confusables.txt, lookalikes.ts)
 * mapped to Latin; combining marks dropped after NFD.
 */
export function normaliseCopy(text: string, lOrI: 'l' | 'I' = 'l'): string {
  // Format characters and every default-ignorable code point (combining grapheme joiner, Hangul fillers, variation
  // selectors, tag characters: Z05 round 3, ruling 14) are invisible, so a reader sees the text without them. Combining
  // marks are dropped after NFD (round 4, ruling 17), so an overlay such as s\u0337mart or s\u0336mart reads as smart.
  // Look-alikes are mapped before NFKC and again after it: NFKC turns some of them into other letters first (the lunate
  // sigma U+03F2 becomes a final sigma), and turns others into look-alikes (a compatibility form of a Greek letter).
  const one = (c: string): string => LOOKALIKE[c] ?? (L_OR_I.has(c) ? lOrI : GENERATED_LOOKALIKE[c] ?? SMALL_CAPITALS[c] ?? CHEROKEE_SMALL[c]) ?? c;
  const map = (t: string): string => [...t].map(one).join('');
  // The first pass leaves a character NFKC turns into plain ASCII (full-width \uFF29 is I, not an l look-alike).
  const early = (t: string): string => [...t].map((c) => (/^[\x00-\x7f]+$/.test(c.normalize('NFKC')) ? c : one(c))).join('');
  const visible = text.replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '');
  const plain = early(visible).normalize('NFKC').replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '').normalize('NFD').replace(/\p{Mn}/gu, '');
  return map(plain).normalize('NFKC');
}

/** The banned labels `text` hits, read both ways where a look-alike could be `l` or `I` (round 4, ruling 17). */
export function findBanned(text: string): string[] {
  const readings = [normaliseCopy(text, 'l'), normaliseCopy(text, 'I')];
  return BANNED.filter((b) => readings.some((r) => b.pattern.test(r))).map((b) => b.label);
}

/**
 * Exact strings in the built bundle that match the list but are not copy: each was read and judged, and no other
 * string is excused. Reviewed in Z05 round 2: React DOM's table of HTML attribute names includes the iframe attribute
 * `seamless`, which is never shown to anyone.
 */
export const BUNDLE_ALLOWED: readonly string[] = ['seamless'];
