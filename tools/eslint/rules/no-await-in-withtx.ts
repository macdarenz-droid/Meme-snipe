// B-M24-01 logic 3 / ARCH 7.1: a `withTx` callback is synchronous, so no `await` can run while the SQLite transaction
// is open. The rule rejects an async or generator function passed to `withTx(...)` or `<anything>.withTx(...)`, and an
// `await` or `for await` whose nearest enclosing function is such a callback. A callback passed by name is not seen
// here; `withTx` itself throws at run time when its callback returns a promise (packages/engine/src/m24/db.ts).
import type { Rule } from 'eslint';
import { memberName, type AstNode } from './ast.ts';

interface FnNode extends AstNode { async?: boolean; generator?: boolean; parent?: unknown }
interface CallNode extends AstNode { callee: AstNode; arguments: AstNode[] }

const FUNCTIONS = new Set(['FunctionExpression', 'ArrowFunctionExpression', 'FunctionDeclaration']);

function isWithTx(callee: AstNode): boolean {
  if (callee.type === 'Identifier') return callee.name === 'withTx';
  return callee.type === 'MemberExpression' && memberName(callee) === 'withTx';
}

/** True when `fn` is passed directly as an argument of a withTx call. */
function isTxCallback(fn: FnNode): boolean {
  const call = fn.parent as CallNode;
  return call.type === 'CallExpression' && call.arguments.includes(fn) && isWithTx(call.callee);
}

/** The nearest function that encloses `node` (null at the top level of a module). */
function enclosingFunction(node: { parent?: unknown }): FnNode | null {
  let n = node.parent as FnNode | null;
  while (n !== null && !FUNCTIONS.has(n.type)) n = n.parent as FnNode | null;
  return n;
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Forbid await, async and generator callbacks inside withTx' },
    schema: [],
    messages: {
      asyncCallback: 'A withTx callback must be a plain synchronous function: no async or generator (ARCH 7.1, B-M24-01).',
      awaitInTx: 'No await inside a withTx callback: the transaction would stay open across it (ARCH 7.1, B-M24-01).',
    },
  },
  create(context) {
    const checkFn = (node: Rule.Node): void => {
      const fn = node as unknown as FnNode;
      if ((fn.async === true || fn.generator === true) && isTxCallback(fn)) context.report({ node, messageId: 'asyncCallback' });
    };
    const checkAwait = (node: Rule.Node): void => {
      const fn = enclosingFunction(node as unknown as { parent?: unknown });
      if (fn !== null && isTxCallback(fn)) context.report({ node, messageId: 'awaitInTx' });
    };
    return {
      FunctionExpression: checkFn,
      ArrowFunctionExpression: checkFn,
      AwaitExpression: checkAwait,
      'ForOfStatement[await=true]': checkAwait,
    };
  },
};
export default rule;
