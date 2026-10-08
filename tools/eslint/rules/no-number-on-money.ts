// UI-T01 (docs/UI.md, Front-end stack "Number handling" and Number, unit and identifier formatting): in the dashboard,
// forbid converting a view-model money or slot field to a JS number. A money name ends in `_lamports`, `_base`,
// `_usd_e6`, `_slot` or `_micro_lamports_per_cu` (identifiers, member properties and computed string keys). The rule
// follows a field's value through code in the same file:
// - variables: a renamed destructure (`const { net_pnl_lamports: pnl } = vm`), a plain alias (`const pnl =
//   vm.net_pnl_lamports`), an assigned one (`p = vm.net_pnl_lamports`), a computed key held in a variable
//   (`const k = 'net_pnl_lamports'; vm[k]`), and object and array literals read back by key, index or destructure
//   (`const o = { p: r.size_base }; o.p`);
// - arrays of fields: array literals and spreads, `.map` and `.flatMap` callback returns, `.filter`, `.slice`,
//   `.sort`, `.toSorted`, `.reverse`, `.toReversed`, `.concat`, `Array.from`, and one element read with `.at`,
//   `.find`, `.findLast`, `.pop` or `.shift`;
// - parameters: a callback's element parameters (`.map((s) => …)`, `.forEach`, `.filter`, `.some`, `.every`, `.find*`,
//   both `.sort` parameters, `.reduce((acc, s) => …)` and its accumulator when there is no initial value, the
//   `Array.from` map function), destructured or not, inline or named (`xs.map(toNum)`), a function's parameter at a
//   direct call (`f(vm.size_base)`, an IIFE), and `for (const s of xs)`.
// The conversions are Number(), parseFloat() and parseInt() (also as Number.*), unary `+`, `-` and `~` (TypeScript
// accepts `-` and `~` on a string), and every Math.* call (Math functions coerce to number; on a bigint they throw),
// called directly or through `.call` or `.apply`. Number, parseFloat and parseInt used as values (`[vm.x_lamports].map(
// Number)`, `.bind`, `Reflect.apply(Number, …)`) are refused outright: the field they convert is out of sight. These
// fields are u64/i64 decimal strings; a JS number loses precision above 2^53, so they are parsed with BigInt in the
// money module (UI-T03).
// Not seen (residual): a value computed from a field rather than the field itself (`` `${r.size_base}` ``,
// `BigInt(r.size_base)` returned from a callback, then converted), values crossing a module boundary (imports, exported
// functions called elsewhere), functions reached through `.call`, `.apply`, `.bind`, methods, classes or object
// properties, spread arguments, `Object.values` and `Object.entries`, Map and Set contents, a `.reduce` accumulator
// fed by the callback's own return value, `for (s of xs)` with `s` declared outside the loop, chains deeper than
// MAX_STEPS steps, a callback's third (array) parameter (`.map((_s, _i, arr) => Number(arr[0]))`), pairs from
// `.entries()` or `.values()` in a `for...of`, and a rest parameter (`.map((...s) => Number(s[0]))`) (red team RT5-1).
// The money module and code review remain the guard for those.
// Enabled for packages/dashboard in eslint.config.mjs, beside the repository-wide no-number-on-units rule.
import type { Rule, Scope, SourceCode } from 'eslint';
import { findNode, globalName, globalPath, globalValueReferences, memberName, stringValue, type AstNode, type LinkedNode } from './ast.ts';
import { converterName } from './no-number-on-units.ts';

/** The view-model field names the rule protects (UI-T01). */
export const MONEY_FIELD = /_(lamports|base|usd_e6|slot|micro_lamports_per_cu)$/;

/** A node with the parent link ESLint sets on every AST node, and the ESTree fields the value flow reads. */
interface Linked extends AstNode {
  parent?: Linked; key?: Linked; left?: Linked; right?: Linked; id?: Linked | null; init?: Linked | null; shorthand?: boolean;
  expression?: Linked; argument?: Linked | null; callee?: Linked; arguments?: Linked[]; elements?: Array<Linked | null>;
  properties?: Linked[]; params?: Linked[]; body?: Linked;
}

/** One step into a value: an object key, an array index, or any element of an array. */
type Step = { key: string } | { index: number } | 'element';

/** The longest path the value flow follows (a guard against chains such as `o = o.next` that never end). */
const MAX_STEPS = 8;
const FUNCTIONS: ReadonlySet<string> = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration']);
/** Expressions whose value is their inner expression's: `x!`, `x as T`, `<T>x`, `x satisfies T`, `a?.b`. */
const WRAPPERS: ReadonlySet<string> = new Set(['TSAsExpression', 'TSNonNullExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'ChainExpression']);
/** Array methods whose callback's first parameter is an element (`xs.map((x) => …)`). */
const EACH_ELEMENT: ReadonlySet<string> = new Set(['map', 'flatMap', 'forEach', 'filter', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex']);
/** Array methods whose callback's first two parameters are elements (`xs.sort((a, b) => …)`). */
const PAIR_ELEMENTS: ReadonlySet<string> = new Set(['sort', 'toSorted']);
/** Array methods whose callback takes the accumulator, then an element. */
const FOLDS: ReadonlySet<string> = new Set(['reduce', 'reduceRight']);
/** Array methods that return an array of the receiver's and the arguments' elements (`xs.filter(…)`, `xs.concat(ys)`). */
const SAME_ELEMENTS: ReadonlySet<string> = new Set(['filter', 'slice', 'sort', 'toSorted', 'reverse', 'toReversed', 'concat']);
/** Array methods that return one element of the receiver (`xs.at(0)`, `xs.find(…)`). */
const ONE_ELEMENT: ReadonlySet<string> = new Set(['at', 'find', 'findLast', 'pop', 'shift']);

/** True when an identifier names a property (`a.b`, `{ b: 1 }`), not a variable. */
function isPropertyName(n: Linked): boolean {
  const p = n.parent as Linked;
  if (p.type === 'MemberExpression') return p.property === n && p.computed !== true;
  return p.type === 'Property' && p.key === n && p.computed !== true && p.shorthand !== true;
}

/** The variable `name` resolves to from `scope`, or null for an undeclared global. */
function findVariable(scope: Scope.Scope, name: string): Scope.Variable | null {
  for (let s: Scope.Scope | null = scope; s !== null; s = s.upper) {
    const v = s.set.get(name);
    if (v !== undefined) return v;
  }
  return null;
}

/** The key of a property: `{ k }`, `{ k: v }`, `{ 'k': v }` and `{ ['k']: v }` → "k"; else null. */
function keyName(property: Linked): string | null {
  const key = property.key as Linked;
  return property.computed === true ? stringValue(key) : key.type === 'Identifier' ? (key.name as string) : stringValue(key);
}

/** The first non-null result of `f` over `items`, or null. */
function first<T>(items: readonly T[], f: (item: T) => string | null): string | null {
  for (const item of items) {
    const found = f(item);
    if (found !== null) return found;
  }
  return null;
}

/** The function a node is: an inline function, or a name bound to one (`function f() {}`, `const f = () => …`). */
function functionOf(n: Linked, scopeOf: (n: Linked) => Scope.Scope): Linked | null {
  if (FUNCTIONS.has(n.type)) return n;
  if (n.type !== 'Identifier') return null;
  const def = findVariable(scopeOf(n), n.name as string)?.defs[0];
  const node = def?.node as Linked | undefined;
  // A parameter's def node is the function that declares it, not the function the parameter holds.
  const fn = def?.type === 'FunctionName' ? node : def?.type === 'Variable' ? node?.init : null;
  return fn !== undefined && fn !== null && FUNCTIONS.has(fn.type) ? fn : null;
}

/** The values a function returns: an arrow's expression body, or the argument of each `return` of its own body. */
function returnsOf(fn: Linked): Linked[] {
  const body = fn.body as Linked;
  if (body.type !== 'BlockStatement') return [body];
  const owner = (n: Linked): Linked => (FUNCTIONS.has(n.type) ? n : owner(n.parent as Linked));
  const out: Linked[] = [];
  findNode(body, (n) => {
    const r = n as Linked;
    if (r.type === 'ReturnStatement' && r.argument !== null && owner(r) === fn) out.push(r.argument as Linked);
    return false;
  });
  return out;
}

/**
 * The money field a node's value is, or holds at `path`, in the file it is in: `vm.size_base` → "size_base"; with
 * path ["element"], `rows.map((r) => r.size_base)` → "size_base". Null when no money field reaches it.
 */
function moneyFlow(sourceCode: SourceCode): (n: AstNode) => string | null {
  type Seen = Map<object, Set<string>>;
  const scopeOf = (n: Linked): Scope.Scope => sourceCode.getScope(n as unknown as Rule.Node);
  /** False when `key` was already followed with `path` (a cycle), or the path is too long. */
  const visit = (seen: Seen, key: object, path: readonly Step[]): boolean => {
    const at = JSON.stringify(path);
    const done = seen.get(key) ?? new Set<string>();
    if (path.length > MAX_STEPS || done.has(at)) return false;
    seen.set(key, done.add(at));
    return true;
  };

  /** A money field name a computed key variable holds: a string it is initialised or assigned (`const k = 'x_base'`). */
  function keyHeld(key: Linked): string | null {
    if (key.type !== 'Identifier') return null;
    const variable = findVariable(scopeOf(key), key.name as string);
    for (const ref of variable?.references ?? []) {
      const held = ref.writeExpr === undefined || ref.writeExpr === null ? null : stringValue(ref.writeExpr as unknown as AstNode);
      if (held !== null && MONEY_FIELD.test(held)) return held;
    }
    return null;
  }

  function valueAt(n: Linked, path: readonly Step[], seen: Seen): string | null {
    if (WRAPPERS.has(n.type)) return valueAt(n.expression as Linked, path, seen);
    if (n.type === 'Identifier') return identifierAt(n, path, seen);
    if (n.type === 'MemberExpression') return memberAt(n, path, seen);
    if (n.type === 'CallExpression') return callAt(n, path, seen);
    const [step, ...rest] = path;
    if (step === undefined) return null;
    if (n.type === 'ArrayExpression') return arrayAt(n, step, rest, seen);
    return n.type === 'ObjectExpression' && typeof step === 'object' && 'key' in step ? objectAt(n, step.key, rest, seen) : null;
  }

  /** A money name, or a variable bound to a value that holds money at `path`. */
  function identifierAt(n: Linked, path: readonly Step[], seen: Seen): string | null {
    const name = n.name as string;
    if (MONEY_FIELD.test(name)) return name;
    if (isPropertyName(n)) return null;
    const variable = findVariable(scopeOf(n), name);
    if (variable === null || !visit(seen, variable, path)) return null;
    return first(variable.defs.map((d) => d.name as unknown as Linked), (b) => boundFrom(b, path, seen))
      ?? first(variable.references.filter((r) => r.isWrite()).map((r) => r.identifier as unknown as Linked), (b) => boundFrom(b, path, seen));
  }

  /** A money member (`vm.size_base`, `vm[k]` with k holding one), or a member of a value that holds money there. */
  function memberAt(n: Linked, path: readonly Step[], seen: Seen): string | null {
    const name = memberName(n) ?? keyHeld(n.property as Linked);
    if (name !== null && MONEY_FIELD.test(name)) return name;
    return valueAt(n.object as Linked, [name === null ? 'element' : { key: name }, ...path], seen);
  }

  /** An element of an array literal: the one at an index when no spread shifts it, else any. */
  function arrayAt(n: Linked, step: Step, rest: readonly Step[], seen: Seen): string | null {
    if (typeof step === 'object' && 'key' in step) return null;
    const elements = n.elements as Array<Linked | null>;
    const index = typeof step === 'object' && !elements.some((e) => e?.type === 'SpreadElement') ? step.index : null;
    return first(elements.filter((e, i): e is Linked => e !== null && (index === null || i === index)),
      (e) => (e.type === 'SpreadElement' ? valueAt(e.argument as Linked, ['element', ...rest], seen) : valueAt(e, rest, seen)));
  }

  /** The value of an object literal's key, or of the key in an object it spreads. */
  function objectAt(n: Linked, key: string, rest: readonly Step[], seen: Seen): string | null {
    return first(n.properties as Linked[], (p) => (p.type === 'SpreadElement' ? valueAt(p.argument as Linked, [{ key }, ...rest], seen)
      : keyName(p) === key ? valueAt(p.value as Linked, rest, seen) : null));
  }

  /** The elements of an array a method call returns, or the one element it returns. */
  function callAt(n: Linked, path: readonly Step[], seen: Seen): string | null {
    const callee = n.callee as Linked;
    const args = n.arguments as Linked[];
    if (callee.type !== 'MemberExpression') return null;
    const method = memberName(callee) ?? '';
    const receiver = callee.object as Linked;
    if (ONE_ELEMENT.has(method)) return valueAt(receiver, ['element', ...path], seen);
    const [step, ...rest] = path;
    if (step === undefined || (typeof step === 'object' && 'key' in step)) return null;
    if (method === 'map' || method === 'flatMap') return returnsAt(args[0], method === 'map' ? rest : ['element', ...rest], seen);
    if (SAME_ELEMENTS.has(method)) return first([receiver, ...args], (a) => valueAt(a, ['element', ...rest], seen));
    if (method !== 'from' || globalName(receiver) !== 'Array') return null;
    return args[1] === undefined ? valueAt(args[0] as Linked, ['element', ...rest], seen) : returnsAt(args[1], rest, seen);
  }

  /** What a callback returns, at `path`. */
  function returnsAt(callback: Linked | undefined, path: readonly Step[], seen: Seen): string | null {
    const fn = callback === undefined ? null : functionOf(callback, scopeOf);
    return fn === null ? null : first(returnsOf(fn), (r) => valueAt(r, path, seen));
  }

  /**
   * The money a binding holds at `path`: from the key it destructures (a money key is money), its default, or the
   * value it is declared with, assigned, iterated from or passed as a parameter.
   */
  function boundFrom(binding: Linked, path: readonly Step[], seen: Seen): string | null {
    let node = binding;
    let inner = path;
    for (let p = node.parent as Linked; ; p = node.parent as Linked) {
      if (p.type === 'Property' && p.value === node) {
        const key = keyName(p);
        if (key !== null && MONEY_FIELD.test(key)) return key;
        inner = [key === null ? 'element' : { key }, ...inner];
        node = p.parent as Linked;
      } else if (p.type === 'ArrayPattern') {
        inner = [{ index: (p.elements as Array<Linked | null>).indexOf(node) }, ...inner];
        node = p;
      } else if (p.type === 'AssignmentPattern' && p.left === node) {
        const fallback = valueAt(p.right as Linked, inner, seen);
        if (fallback !== null) return fallback;
        node = p;
      } else break;
    }
    const p = node.parent as Linked;
    if (p.type === 'VariableDeclarator' && p.id === node) {
      const init = p.init ?? null;
      if (init !== null) return valueAt(init, inner, seen);
      const loop = (p.parent as Linked).parent as Linked;
      return loop.type === 'ForOfStatement' ? valueAt(loop.right as Linked, ['element', ...inner], seen) : null;
    }
    if (p.type === 'AssignmentExpression' && p.left === node) return valueAt(p.right as Linked, inner, seen);
    const index = FUNCTIONS.has(p.type) ? (p.params as Linked[]).indexOf(node) : -1;
    return index < 0 ? null : paramAt(p, index, inner, seen);
  }

  /** The money parameter `i` of `fn` receives at `path`: as a callback, an IIFE, or a named function's calls. */
  function paramAt(fn: Linked, i: number, path: readonly Step[], seen: Seen): string | null {
    const site = fn.parent as Linked;
    if (site.type === 'CallExpression') return site.callee === fn ? argAt(site, i, path, seen) : callbackAt(site, fn, i, path, seen);
    const owner = fn.type === 'FunctionDeclaration' ? fn : site.type === 'VariableDeclarator' && site.init === fn ? site : null;
    const variable = owner === null ? undefined : sourceCode.getDeclaredVariables(owner as unknown as Rule.Node).find((v) => (v.identifiers as unknown[]).includes(owner.id));
    return first(variable?.references ?? [], (ref) => {
      const id = ref.identifier as unknown as Linked;
      const call = id.parent as Linked;
      if (call.type !== 'CallExpression') return null;
      return call.callee === id ? argAt(call, i, path, seen) : callbackAt(call, id, i, path, seen);
    });
  }

  /** The argument a direct call passes at position `i` (unknown after a spread argument). */
  function argAt(call: Linked, i: number, path: readonly Step[], seen: Seen): string | null {
    const args = call.arguments as Linked[];
    const arg = args[i];
    return arg === undefined || args.slice(0, i + 1).some((a) => a.type === 'SpreadElement') ? null : valueAt(arg, path, seen);
  }

  /** What an array method passes its callback `arg` as parameter `i`: an element of the receiver, or the initial value. */
  function callbackAt(call: Linked, arg: Linked, i: number, path: readonly Step[], seen: Seen): string | null {
    const callee = call.callee as Linked;
    const args = call.arguments as Linked[];
    if (callee.type !== 'MemberExpression') return null;
    const method = memberName(callee) ?? '';
    const receiver = callee.object as Linked;
    const element: Step[] = ['element', ...path];
    if (args[1] === arg) return method === 'from' && globalName(receiver) === 'Array' && i === 0 ? valueAt(args[0] as Linked, element, seen) : null;
    if (args[0] !== arg) return null;
    if (FOLDS.has(method) && i === 0) return args[1] === undefined ? valueAt(receiver, element, seen) : valueAt(args[1], path, seen);
    const takes = FOLDS.has(method) || PAIR_ELEMENTS.has(method) ? 2 : EACH_ELEMENT.has(method) ? 1 : 0;
    return i < takes ? valueAt(receiver, element, seen) : null;
  }

  return (n) => valueAt(n as Linked, [], new Map());
}

/** The Math function a callee names (`Math.round`, `globalThis.Math['max']`), "Math[…]" for a computed key; else null. */
function mathName(callee: AstNode): string | null {
  if (callee.type !== 'MemberExpression' || globalName(callee.object as AstNode) !== 'Math') return null;
  return `Math.${memberName(callee) ?? '[…]'}`;
}

/** The conversion a callee calls: a converter or Math function, directly or through `.call` or `.apply`; else null. */
function calledConversion(callee: AstNode): string | null {
  const direct = converterName(callee) ?? mathName(callee);
  if (direct !== null || callee.type !== 'MemberExpression') return direct;
  const via = memberName(callee);
  const inner = via === 'call' || via === 'apply' ? converterName(callee.object as AstNode) ?? mathName(callee.object as AstNode) : null;
  return inner === null ? null : `${inner}.${via as string}`;
}

/**
 * True unless a declarator destructures only named members that convert nothing (`const { isFinite } = Number`): a rest
 * element, a computed key or a parseFloat/parseInt key can take a converter.
 */
function destructuresConverter(declarator: LinkedNode): boolean {
  const id = (declarator as { id?: { type: string; properties: Linked[] } }).id;
  if (id?.type !== 'ObjectPattern') return true;
  return id.properties.some((q) => {
    const key = q.type === 'Property' ? keyName(q) : null;
    return key === null || key === 'parseFloat' || key === 'parseInt';
  });
}

/** The globals a converter is reached through: the converters and the global object's names. */
const CONVERTER_ROOTS: ReadonlySet<string> = new Set(['Number', 'parseFloat', 'parseInt', 'globalThis', 'global', 'window', 'self']);

/**
 * The converter `ref` names when it is used as a value (passed, stored, bound), not called: `Number` in `xs.map(Number)`
 * → "Number". Direct calls and calls through `.call` or `.apply` are checked by their arguments instead; `Number.isInteger`
 * and other members, and `typeof Number` in a type, convert nothing.
 */
function converterValue(ref: LinkedNode): string | null {
  let node = globalPath(ref);
  const up = node.parent as LinkedNode & { callee?: unknown };
  if (up.type === 'MemberExpression' && up.object === node && converterName(up) !== null) node = up;
  const fn = converterName(node);
  const p = node.parent as LinkedNode & { callee?: unknown };
  if (fn === null || p.type === 'TSTypeQuery' || ((p.type === 'CallExpression' || p.type === 'NewExpression') && p.callee === node)) return null;
  if (p.type === 'VariableDeclarator' && (p as { init?: unknown }).init === node) return destructuresConverter(p) ? fn : null;
  if (p.type !== 'MemberExpression' || p.object !== node) return fn;
  const via = memberName(p);
  const calledVia = (via === 'call' || via === 'apply') && (p.parent as { callee?: unknown }).callee === p;
  return via === 'bind' || ((via === 'call' || via === 'apply') && !calledVia) ? fn : null;
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Forbid converting dashboard money and slot fields to JS numbers' },
    schema: [],
    messages: {
      moneyToNumber: 'Money rule: {{fn}}() on "{{name}}" loses precision above 2^53; parse it with BigInt in the money module (docs/UI.md UI-T01, UI-T03).',
      unary: 'Money rule: unary {{op}} on "{{name}}" loses precision above 2^53; parse it with BigInt in the money module (docs/UI.md UI-T01, UI-T03).',
      converterValue: 'Money rule: {{fn}} used as a value converts a field out of sight (`xs.map(Number)`); call it on a named value so the money rule can see it (docs/UI.md UI-T01, UI-T03).',
    },
  },
  create(context) {
    const moneyOf = moneyFlow(context.sourceCode);
    const firstMoney = (root: AstNode): string | null => {
      const hit = findNode(root, (n) => moneyOf(n) !== null);
      return hit === null ? null : moneyOf(hit);
    };
    function check(node: Rule.Node): void {
      const call = node as unknown as { callee: AstNode; arguments: AstNode[] };
      const fn = calledConversion(call.callee);
      if (fn === null) return;
      for (const arg of call.arguments) {
        const name = firstMoney(arg);
        if (name !== null) context.report({ node, messageId: 'moneyToNumber', data: { fn, name } });
      }
    }
    return {
      CallExpression: check,
      NewExpression: check,
      UnaryExpression(node) {
        if (node.operator !== '+' && node.operator !== '-' && node.operator !== '~') return;
        const name = firstMoney(node.argument as unknown as AstNode);
        if (name !== null) context.report({ node, messageId: 'unary', data: { op: node.operator, name } });
      },
      'Program:exit'(node) {
        for (const ref of globalValueReferences(context.sourceCode.getScope(node), CONVERTER_ROOTS)) {
          const fn = converterValue(ref);
          if (fn !== null) context.report({ node: ref as unknown as Rule.Node, messageId: 'converterValue', data: { fn } });
        }
      },
    };
  },
};
export default rule;
