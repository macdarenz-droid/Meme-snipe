// A double-ended FIFO on one array with a moving head: O(1) push at the back and pop at either end. The array is
// compacted when its dead front is at least half of it, so memory follows the live length, not the history.

export class Fifo<T> {
  private items: Array<T | undefined> = [];
  private head = 0;

  get length(): number {
    return this.items.length - this.head;
  }

  push(v: T): void {
    this.items.push(v);
  }

  peekFront(): T | undefined {
    return this.length > 0 ? this.items[this.head] : undefined;
  }

  popFront(): T | undefined {
    if (this.length === 0) return undefined;
    const v = this.items[this.head];
    this.items[this.head] = undefined;
    this.head++;
    if (this.head === this.items.length) {
      this.items = [];
      this.head = 0;
    } else if (this.head >= 1024 && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return v;
  }

  popBack(): T | undefined {
    if (this.length === 0) return undefined;
    const v = this.items.pop();
    if (this.head === this.items.length) {
      this.items = [];
      this.head = 0;
    }
    return v;
  }
}
