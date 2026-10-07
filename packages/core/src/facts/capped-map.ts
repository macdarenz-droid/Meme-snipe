// A map that keeps at most `max` keys, the oldest-inserted forgotten first. Eviction is O(1) whatever was deleted
// before: the keys' insertion order is kept in a ring, never by iterating the map. (`map.keys().next()` after many
// deletes walks the deleted slots V8 keeps until a rehash: 600,000 inserts at a cap of 50,000 took 17 s against 0.2 s.)
// Setting a key already present replaces its value and keeps its place, as `Map.set` does.
// POOL-FIRST-READ: `delete` costs no memory per key (OOM-MINT's per-entry budget): the deleted key's ring place is left
// as it is and frees nothing until the ring comes round to it. A key set again after a delete takes a new place, and is
// forgotten at the older one if that comes round first: early, never late, so the cap always holds.
export class CappedMap<K, V> {
  readonly #max: number;
  readonly #map = new Map<K, V>();
  readonly #ring: K[] = [];
  readonly #onEvict: ((key: K, value: V) => void) | undefined;
  #head = 0;

  /** `onEvict` hears of each key forgotten to make room (never of a `delete`). */
  constructor(max: number, onEvict?: (key: K, value: V) => void) {
    if (!Number.isSafeInteger(max) || max < 1) throw new RangeError('CappedMap needs a positive whole cap');
    this.#max = max;
    this.#onEvict = onEvict;
  }

  get size(): number {
    return this.#map.size;
  }

  get(key: K): V | undefined {
    return this.#map.get(key);
  }

  has(key: K): boolean {
    return this.#map.has(key);
  }

  delete(key: K): boolean {
    return this.#map.delete(key);
  }

  set(key: K, value: V): this {
    if (!this.#map.has(key)) {
      if (this.#ring.length < this.#max) this.#ring.push(key);
      else {
        const old = this.#ring[this.#head]!;
        if (this.#map.has(old)) {
          const v = this.#map.get(old) as V;
          this.#map.delete(old);
          this.#onEvict?.(old, v);
        }
        this.#ring[this.#head] = key;
        this.#head = (this.#head + 1) % this.#max;
      }
    }
    this.#map.set(key, value);
    return this;
  }
}
