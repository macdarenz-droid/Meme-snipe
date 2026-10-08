// Waiting-call structures for the gateway (A-M14-02 logic 2; review C03 R1): a FIFO list per (priority, method) and a
// deadline heap, both with O(1) or O(log n) insert and removal, so a burst of queued calls costs O(n log n) in all
// and a P0 call never waits behind a scan of the P4 queue.
// Ported from Snipe-solana card C03 (#6 @ 6ae4d62).

/** An entry of both structures. `list` and `heapAt` are owned by them. */
export interface QueueEntry {
  readonly seq: number;
  readonly deadline: number;
  list: FifoList<this> | null;
  prev: this | null;
  next: this | null;
  heapAt: number;
}

/** A doubly linked FIFO: push at the tail, read the head, remove any entry in O(1). */
export class FifoList<T extends QueueEntry> {
  head: T | null = null;
  private tail: T | null = null;
  push(e: T): void {
    e.list = this;
    e.prev = this.tail;
    e.next = null;
    if (this.tail === null) this.head = e; else this.tail.next = e;
    this.tail = e;
  }
  remove(e: T): void {
    if (e.list !== this) return;
    if (e.prev === null) this.head = e.next; else e.prev.next = e.next;
    if (e.next === null) this.tail = e.prev; else e.next.prev = e.prev;
    e.list = null;
    e.prev = null;
    e.next = null;
  }
}

const earlier = (a: QueueEntry, b: QueueEntry): boolean => a.deadline < b.deadline || (a.deadline === b.deadline && a.seq < b.seq);

/** A binary min-heap on (deadline, seq) that knows each entry's position, so any entry is removed in O(log n). */
export class DeadlineHeap<T extends QueueEntry> {
  private readonly a: T[] = [];
  peek(): T | undefined { return this.a[0]; }
  push(e: T): void {
    e.heapAt = this.a.length;
    this.a.push(e);
    this.up(e.heapAt);
  }
  remove(e: T): void {
    const i = e.heapAt;
    if (i < 0 || this.a[i] !== e) return;
    const last = this.a.pop() as T;
    e.heapAt = -1;
    if (last === e) return;
    this.a[i] = last;
    last.heapAt = i;
    this.up(i);
    this.down(last.heapAt);
  }
  private swap(i: number, j: number): void {
    const x = this.a[i] as T;
    const y = this.a[j] as T;
    this.a[i] = y;
    this.a[j] = x;
    y.heapAt = i;
    x.heapAt = j;
  }
  private up(i: number): void {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!earlier(this.a[i] as T, this.a[p] as T)) return;
      this.swap(i, p);
      i = p;
    }
  }
  private down(i: number): void {
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < this.a.length && earlier(this.a[l] as T, this.a[m] as T)) m = l;
      if (r < this.a.length && earlier(this.a[r] as T, this.a[m] as T)) m = r;
      if (m === i) return;
      this.swap(i, m);
      i = m;
    }
  }
}
