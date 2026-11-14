/**
 * Durable Object KV fake. Cloning catches in-place mutation and reference comparisons; sorted scans
 * match KV's key order rather than `Map` insertion order. Writes are recorded for ordering assertions.
 * `fakeStorage()` is the same fake with the synchronous transaction surface, which rolls back.
 */
export type FakeKv = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): void;
  list<T>(options: { prefix: string; startAfter?: string; end?: string; limit?: number }): Iterable<[string, T]>;
  /** Test-only: every key ever written, in write order, including repeats. */
  readonly writes: string[];
  /** Test-only: the keys currently present, lexicographically. */
  keys(): string[];
};

/** Test-only: a `fakeKv()` with the synchronous transaction surface, which rolls back. */
export type FakeStorage = {
  readonly kv: FakeKv;
  /** Runs `callback`; a throw restores every key to what it held on entry, and is rethrown. Nests. */
  transactionSync<T>(callback: () => T): T;
};

const byKey = ([a]: [string, unknown], [b]: [string, unknown]): number =>
  a < b ? -1 : a > b ? 1 : 0;

function fakeKvOver(values: Map<string, unknown>): FakeKv {
  const writes: string[] = [];
  return {
    get: <T>(key: string) => {
      const stored = values.get(key);
      return stored === undefined ? undefined : structuredClone(stored) as T;
    },
    put: (key, value) => {
      writes.push(key);
      values.set(key, structuredClone(value));
    },
    delete: (key: string) => void values.delete(key),
    list: <T>({ prefix, startAfter, end, limit }:
      { prefix: string; startAfter?: string; end?: string; limit?: number }) => {
      const found = [...values.entries()]
        .filter(([key]) => key.startsWith(prefix)
          && (startAfter === undefined || key > startAfter) && (end === undefined || key < end))
        .toSorted(byKey)
        .map(([key, value]) => [key, structuredClone(value)] as [string, T]);
      return limit === undefined ? found : found.slice(0, limit);
    },
    writes,
    keys: () => [...values.keys()].toSorted(),
  };
}

export function fakeKv(): FakeKv {
  return fakeKvOver(new Map());
}

/** A `fakeKv()` whose `transactionSync` undoes the writes of a callback that throws. */
export function fakeStorage(): FakeStorage {
  const values = new Map<string, unknown>();
  return {
    kv: fakeKvOver(values),
    transactionSync<T>(callback: () => T): T {
      // Stored values are clones nothing changes in place, so a copy of the map is a snapshot.
      const onEntry = new Map(values);
      try {
        return callback();
      } catch (error) {
        values.clear();
        for (const [key, value] of onEntry) values.set(key, value);
        throw error;
      }
    },
  };
}
