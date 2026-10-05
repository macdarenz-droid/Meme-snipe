// A map that keeps at most `max` keys, the oldest-inserted forgotten first. Eviction is O(1) whatever was deleted
// before: the keys' insertion order is kept in a ring, never by iterating the map. (`map.keys().next()` after many
// deletes walks the deleted slots V8 keeps until a rehash: 600,000 inserts at a cap of 50,000 took 17 s against 0.2 s.)
// Setting a key already present replaces its value and keeps its place, as `Map.set` does.
export class CappedMap<K, V> {
  readonly #max: number;
  readonly #map = new Map<K, V>();
  readonly #ring: K[] = [];
  #head = 0;

  constructor(max: number) {
    if (!Number.isSafeInteger(max) || max < 1) throw new RangeError('CappedMap needs a positive whole cap');
    this.#max = max;
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

  set(key: K, value: V): this {
    if (!this.#map.has(key)) {
      if (this.#ring.length < this.#max) this.#ring.push(key);
      else {
        this.#map.delete(this.#ring[this.#head]!);
        this.#ring[this.#head] = key;
        this.#head = (this.#head + 1) % this.#max;
      }
    }
    this.#map.set(key, value);
    return this;
  }
}
