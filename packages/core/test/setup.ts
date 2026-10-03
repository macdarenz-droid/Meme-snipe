// Vitest setup: every engine test runs its engine code inside the runtime trap (test/trap.ts).
// Engine.drain covers the event loop, strategies, effect runners and the feed; the clock, store and
// reconcile guard are trapped for the tests that call them directly. The Function constructor is closed
// for the whole run, so config and every other module are covered too.
import { AsOfStore, Engine, ReconcileGuard, SimClock } from '../src/engine/index.ts';
import { closeFunctionConstructors, trapMethods } from './trap.ts';

trapMethods(Engine.prototype, ['drain', 'logHash']);
trapMethods(ReconcileGuard.prototype, ['admit']);
trapMethods(AsOfStore.prototype, ['record', 'lookup', 'history']);
trapMethods(SimClock.prototype, ['now', 'advanceTo']);
closeFunctionConstructors();
