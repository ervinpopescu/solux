export type RankedItem<T> = {
  value: T;
  distanceSquared: number;
  key: string;
};

function compareRank<T>(a: RankedItem<T>, b: RankedItem<T>): number {
  return a.distanceSquared - b.distanceSquared || a.key.localeCompare(b.key);
}

function swap<T>(items: RankedItem<T>[], a: number, b: number): void {
  const value = items[a];
  items[a] = items[b];
  items[b] = value;
}

/**
 * Retain only the nearest `limit` items while scanning. The max-heap bounds
 * retained candidates to O(limit), then the result is sorted nearest-first for
 * deterministic downstream preparation.
 */
export function selectNearestBounded<T>(
  items: Iterable<RankedItem<T>>,
  limit: number,
): RankedItem<T>[] {
  const cap = Math.max(0, Math.floor(limit));
  if (cap === 0) return [];
  const heap: RankedItem<T>[] = [];

  function siftUp(index: number): void {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareRank(heap[parent], heap[index]) >= 0) break;
      swap(heap, parent, index);
      index = parent;
    }
  }

  function siftDown(index: number): void {
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let largest = index;
      if (left < heap.length && compareRank(heap[left], heap[largest]) > 0) largest = left;
      if (right < heap.length && compareRank(heap[right], heap[largest]) > 0) largest = right;
      if (largest === index) return;
      swap(heap, index, largest);
      index = largest;
    }
  }

  for (const item of items) {
    if (!Number.isFinite(item.distanceSquared)) continue;
    if (heap.length < cap) {
      heap.push(item);
      siftUp(heap.length - 1);
    } else if (compareRank(item, heap[0]) < 0) {
      heap[0] = item;
      siftDown(0);
    }
  }

  return heap.sort(compareRank);
}
