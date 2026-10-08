// Compile-time checks (run by `pnpm typecheck`): the state columns of the schema hold exactly the state unions of
// @bot/types (ARCH 5.0a), money columns are bigint, and versioned rows change only by compare-and-set (ARCH 7.1).
import type {
  ActionClass, AttemptState, CandidateState, CommandType, ExitReason, FailureClass, Mode, OrderState, PositionState, StrategyStage, TokenClass, TradingState,
} from '@bot/types';
import type { MutableRepo, Repos, RowOf, VersionedRepo } from '../../src/m24/repos.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
function assertType<T extends true>(): T | undefined { return undefined; }

assertType<Equal<RowOf<'order_intent'>['state'], OrderState>>();
assertType<Equal<RowOf<'position'>['state'], PositionState>>();
assertType<Equal<RowOf<'candidate'>['state'], CandidateState>>();
assertType<Equal<RowOf<'candidate_event'>['toState'], CandidateState>>();
assertType<Equal<RowOf<'system_state'>['tradingState'], TradingState>>();
assertType<Equal<RowOf<'strategy_stage'>['stage'], StrategyStage>>();
assertType<Equal<RowOf<'tx_attempt'>['status'], AttemptState>>();
assertType<Equal<RowOf<'tx_attempt'>['failureClass'], FailureClass | null>>();
assertType<Equal<RowOf<'trade'>['exitReason'], ExitReason>>();
assertType<Equal<RowOf<'command'>['type'], CommandType>>();
assertType<Equal<RowOf<'command'>['actionClass'], ActionClass>>();
assertType<Equal<RowOf<'mint_class'>['class'], TokenClass>>();
assertType<Equal<RowOf<'position'>['mode'], Mode>>();
assertType<Equal<RowOf<'fill'>['solDeltaLamports'], bigint>>();
assertType<Equal<RowOf<'position'>['entryCostLamports'], bigint>>();
assertType<Equal<RowOf<'position'>['sizeBase'], string>>();
assertType<Equal<RowOf<'tx_attempt'>['signature'], string | null>>();

declare const repos: Repos;
assertType<Equal<Repos['order_intent'], VersionedRepo<'order_intent'>>>();
assertType<Equal<Repos['tx_attempt'], VersionedRepo<'tx_attempt'>>>();
assertType<Equal<Repos['position'], VersionedRepo<'position'>>>();
assertType<Equal<Repos['candidate'], VersionedRepo<'candidate'>>>();
assertType<Equal<Repos['strategy'], MutableRepo<'strategy'>>>();
// @ts-expect-error a versioned row has no plain update
void repos.order_intent.update;
// @ts-expect-error a versioned row has no upsert
void repos.position.upsert;
// @ts-expect-error a table without a version column has no compare-and-set update
void repos.kv_state.updateVersioned;
