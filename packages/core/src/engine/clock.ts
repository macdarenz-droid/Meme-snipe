import { checkMoment, compareMoments, type Moment } from './moment.ts';

/** The only source of "now" for the engine. Live: an adapter over the system clock and slot feed. Backtest: `SimClock`. */
export interface Clock {
  now(): Moment;
}

/** A simulated clock. Only its owner (the replay driver) can move it, and only forward. */
export class SimClock implements Clock {
  #now: Moment;

  constructor(start: Moment) {
    this.#now = checkMoment(start);
  }

  now(): Moment {
    return this.#now;
  }

  advanceTo(m: Moment): void {
    checkMoment(m);
    if (compareMoments(m, this.#now) < 0) throw new RangeError('the clock never moves backwards');
    this.#now = m;
  }
}
