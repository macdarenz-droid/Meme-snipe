/**
 * Words and phrases that must never appear in the dashboard's text (CLAUDE.md, "No AI wording in the UI"; AGENTS.md,
 * "UI copy"). The same list as apps/web/test/banned-copy.ts, which still guards apps/web: add to either, never remove
 * from either. copy-guard.test.ts checks that this list keeps every entry of the apps/web list and every phrase quoted
 * in CLAUDE.md's rule.
 */
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
];

export function findBanned(text: string): string[] {
  return BANNED.filter((b) => b.pattern.test(text)).map((b) => b.label);
}
