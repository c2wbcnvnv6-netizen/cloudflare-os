import { describe, expect, it, vi } from "vitest";
import {
  CHUNKED_VALUE_CHUNK_BYTES,
  ChunkedValues,
  type ChunkedValuesOptions,
} from "../src/chunked-value";
import { fakeStorage, type FakeKv, type FakeStorage } from "./fake-kv";

const PREFIX = "test:";
const META = { tag: "kept" };

function chunkedValues(options: Partial<ChunkedValuesOptions> = {}, storage = fakeStorage()): {
  values: ChunkedValues;
  kv: FakeKv;
} {
  const values = new ChunkedValues(storage, { prefix: PREFIX, chunkBytes: 4, ...options });
  return { values, kv: storage.kv };
}

type Operation = "get" | "put" | "delete" | "list";

// Tells `on` of every KV call before it runs. A throw from `on` fails that call, as storage
// refusing it would.
function watched(
  storage: FakeStorage,
  on: (operation: Operation, key: string) => void,
): FakeStorage {
  const { kv } = storage;
  return {
    transactionSync: callback => storage.transactionSync(callback),
    kv: {
      ...kv,
      get: <T>(key: string) => {
        on("get", key);
        return kv.get<T>(key);
      },
      put: (key, value) => {
        on("put", key);
        kv.put(key, value);
      },
      delete: key => {
        on("delete", key);
        kv.delete(key);
      },
      list: <T>(options: { prefix: string; startAfter?: string }) => {
        on("list", options.prefix);
        return kv.list<T>(options);
      },
    },
  };
}

function keyOf(name: string, suffix: string): string {
  return `${PREFIX}${name}:${suffix}`;
}

function chunkKeys(name: string, chunks: number): string[] {
  return Array.from({ length: chunks }, (_, index) => keyOf(name, `chunk:${String(index).padStart(4, "0")}`));
}

// Every key of a value of `chunks` chunks, in key order.
function keysOf(name: string, chunks: number): string[] {
  return [...chunkKeys(name, chunks), keyOf(name, "manifest")];
}

function bytes(length: number, seed = 0): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index + seed) % 251);
}

// `toEqual` walks a typed array element by element, which is too slow for multi-MiB inputs.
function bytesEqual(left: Uint8Array | undefined, right: Uint8Array): boolean {
  return left !== undefined && left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index]);
}

describe("ChunkedValues", () => {
  it.each([
    ["an empty value", 0, 0],
    ["a value under one chunk", 3, 1],
    ["a value of exactly one chunk", 4, 1],
    ["a value of several chunks with a short last one", 10, 3],
    ["a value of several exact chunks", 12, 3],
  ])("round trips %s", (_name, length, chunks) => {
    const { values, kv } = chunkedValues();
    const input = bytes(length);

    values.put("a", input);

    expect(bytesEqual(values.get("a")?.bytes, input)).toBe(true);
    expect(kv.keys()).toEqual(keysOf("a", chunks));
  });

  it("returns the meta it was given, from get and from meta", () => {
    const { values } = chunkedValues();

    values.put("with", bytes(10), { tabs: ["t.0", "t.1"], savedAt: 17 });
    values.put("without", bytes(10));

    expect(values.get("with")?.meta).toEqual({ tabs: ["t.0", "t.1"], savedAt: 17 });
    expect(values.meta("with")).toEqual({ tabs: ["t.0", "t.1"], savedAt: 17 });
    expect(values.get("without")?.meta).toBeUndefined();
    expect(values.meta("without")).toBeUndefined();
    expect(bytesEqual(values.get("without")?.bytes, bytes(10))).toBe(true);
  });

  it("reads meta without reading a chunk", () => {
    const calls: string[] = [];
    const storage = watched(fakeStorage(), (operation, at) => calls.push(`${operation} ${at}`));
    const { values, kv } = chunkedValues({}, storage);
    values.put("a", bytes(10), META);
    calls.length = 0;

    expect(values.meta("a")).toEqual(META);
    expect(calls).toEqual([`get ${keyOf("a", "manifest")}`]);

    kv.delete(keyOf("a", "chunk:0001"));
    expect(values.meta("a")).toEqual(META);
    expect(values.get("a")).toBeUndefined();
  });

  it("stores an empty value as a manifest alone", () => {
    const { values, kv } = chunkedValues();

    values.put("a", new Uint8Array(), META);

    expect(kv.keys()).toEqual([keyOf("a", "manifest")]);
    expect(values.get("a")).toEqual({ bytes: new Uint8Array(), meta: META });
  });

  it("leaves no stale chunk when a smaller value replaces a larger one", () => {
    const { values, kv } = chunkedValues();
    values.put("a", bytes(20));
    expect(kv.keys()).toEqual(keysOf("a", 5));

    values.put("a", bytes(7, 100));
    expect(kv.keys()).toEqual(keysOf("a", 2));
    expect(bytesEqual(values.get("a")?.bytes, bytes(7, 100))).toBe(true);

    values.put("a", new Uint8Array());
    expect(kv.keys()).toEqual(keysOf("a", 0));
    expect(values.get("a")?.bytes.byteLength).toBe(0);
  });

  // Each row fails after the put overwrote at least one chunk of the earlier value, so only a
  // rollback restores it: a failure at the first write would pass with no transaction at all.
  it.each([
    ["its second chunk is put", "put", keyOf("a", "chunk:0001"), chunkKeys("a", 1)],
    ["the first stale chunk is deleted", "delete", keyOf("a", "chunk:0002"), chunkKeys("a", 2)],
    ["its manifest is put", "put", keyOf("a", "manifest"), chunkKeys("a", 2)],
  ])("leaves the earlier value whole when a put fails as %s", (_name, operation, failingKey, written) => {
    let failing = false;
    const storage = watched(fakeStorage(), (at, atKey) => {
      if (failing && at === operation && atKey === failingKey) throw new Error("storage refused");
    });
    const { values, kv } = chunkedValues({}, storage);
    values.put("a", bytes(20), META);
    const writesBefore = kv.writes.length;

    failing = true;
    expect(() => values.put("a", bytes(8, 100), { tag: "later" })).toThrow("storage refused");
    failing = false;

    expect(kv.writes.slice(writesBefore)).toEqual(written);
    expect(values.get("a")).toEqual({ bytes: bytes(20), meta: META });
    expect(kv.keys()).toEqual(keysOf("a", 5));
  });

  // The manifest is the last write, so every chunk was written before the failure.
  it("stores nothing when the first put of a name fails", () => {
    const storage = watched(fakeStorage(), (operation, at) => {
      if (operation === "put" && at === keyOf("a", "manifest")) throw new Error("storage refused");
    });
    const { values, kv } = chunkedValues({}, storage);

    expect(() => values.put("a", bytes(10), META)).toThrow("storage refused");

    expect(kv.writes).toEqual(chunkKeys("a", 3));
    expect(values.get("a")).toBeUndefined();
    expect(values.meta("a")).toBeUndefined();
    expect(kv.keys()).toEqual([]);
  });

  // The stored value is 10 bytes in chunks of 4, 4 and 2. The last column says whether the
  // manifest is still one the store understands, and so whether `meta` answers.
  it.each<[string, (kv: FakeKv) => void, boolean]>([
    ["a chunk is missing", kv => kv.delete(keyOf("a", "chunk:0001")), true],
    ["a chunk is short", kv => kv.put(keyOf("a", "chunk:0001"), bytes(3)), true],
    ["a chunk is long", kv => kv.put(keyOf("a", "chunk:0002"), bytes(4)), true],
    // Both hold the four bytes the manifest implies, so only their type tells them from a chunk.
    ["a chunk is a buffer, not a view of one", kv => kv.put(keyOf("a", "chunk:0000"), bytes(4).buffer), true],
    ["a chunk is an array of wider elements", kv => kv.put(keyOf("a", "chunk:0000"), new Uint16Array(2)), true],
    [
      "its manifest's size is negative",
      kv => kv.put(keyOf("a", "manifest"), { version: 1, size: -4, chunkBytes: 4, chunks: -1, meta: META }),
      false,
    ],
    [
      "its manifest's size is not an integer",
      kv => kv.put(keyOf("a", "manifest"), { version: 1, size: 9.5, chunkBytes: 4, chunks: 3, meta: META }),
      false,
    ],
    [
      "its manifest's chunk size is negative",
      kv => kv.put(keyOf("a", "manifest"), { version: 1, size: 4, chunkBytes: -4, chunks: -1, meta: META }),
      false,
    ],
    [
      "its manifest's chunk size is not an integer",
      kv => kv.put(keyOf("a", "manifest"), { version: 1, size: 10, chunkBytes: 3.5, chunks: 3, meta: META }),
      false,
    ],
    [
      "its manifest counts more chunks than a value may have",
      kv => kv.put(
        keyOf("a", "manifest"),
        { version: 1, size: 10_001, chunkBytes: 1, chunks: 10_001, meta: META },
      ),
      false,
    ],
    [
      "its manifest's size disagrees with its chunk count",
      kv => kv.put(keyOf("a", "manifest"), { version: 1, size: 10, chunkBytes: 4, chunks: 2, meta: META }),
      false,
    ],
    [
      "its manifest has another version",
      kv => kv.put(keyOf("a", "manifest"), { version: 2, size: 10, chunkBytes: 4, chunks: 3, meta: META }),
      false,
    ],
    ["its manifest is not an object", kv => kv.put(keyOf("a", "manifest"), "manifest"), false],
    [
      "its manifest's chunk size is larger than a chunk may be",
      kv => kv.put(
        keyOf("a", "manifest"),
        { version: 1, size: 2 ** 40, chunkBytes: 2 ** 40, chunks: 1, meta: META },
      ),
      false,
    ],
    [
      "its manifest claims far more bytes than are stored",
      kv => {
        for (const chunkKey of chunkKeys("a", 3)) kv.delete(chunkKey);
        kv.put(
          keyOf("a", "manifest"),
          { version: 1, size: 10_000 * 2 ** 20, chunkBytes: 2 ** 20, chunks: 10_000, meta: META },
        );
      },
      true,
    ],
  ])("reads a value as missing when %s", (_name, damage, manifestUnderstood) => {
    const { values, kv } = chunkedValues();
    values.put("a", bytes(10), META);
    damage(kv);
    const writes = kv.writes.length;
    const keys = kv.keys();

    expect(values.get("a")).toBeUndefined();
    expect(values.meta("a")).toEqual(manifestUnderstood ? META : undefined);

    expect(kv.writes).toHaveLength(writes);
    expect(kv.keys()).toEqual(keys);
  });

  // A manifest may claim up to 10,000 MiB, so a read that allocated before it had found every
  // chunk could fail for want of memory on a value that is simply incomplete.
  it("allocates the value only once every chunk is found", () => {
    const { values, kv } = chunkedValues();
    values.put("a", bytes(10));
    const allocated: number[] = [];
    vi.stubGlobal("Uint8Array", new Proxy(Uint8Array, {
      construct(target, args: unknown[], newTarget) {
        if (typeof args[0] === "number") allocated.push(args[0]);
        return Reflect.construct(target, args, newTarget) as object;
      },
    }));
    try {
      expect(values.get("a")?.bytes.byteLength).toBe(10);
      expect(allocated).toEqual([10]);

      kv.delete(keyOf("a", "chunk:0002"));
      expect(values.get("a")).toBeUndefined();
      expect(allocated).toEqual([10]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reads back with the chunk size a value was written with", () => {
    const storage = fakeStorage();
    chunkedValues({ chunkBytes: 4 }, storage).values.put("a", bytes(10), META);

    const { values } = chunkedValues({ chunkBytes: 8 }, storage);

    expect(values.get("a")).toEqual({ bytes: bytes(10), meta: META });
  });

  it("stores each chunk in a buffer of its own", () => {
    const { values, kv } = chunkedValues();
    const whole = bytes(32);

    values.put("a", whole.subarray(5, 15));

    const chunks = [...kv.list<Uint8Array>({ prefix: keyOf("a", "chunk:") })].map(([, chunk]) => chunk);
    expect(chunks.map(chunk => chunk.byteLength)).toEqual([4, 4, 2]);
    expect(chunks.map(chunk => chunk.buffer.byteLength)).toEqual([4, 4, 2]);
    expect(values.get("a")?.bytes).toEqual(whole.slice(5, 15));
  });

  it("does not see changes made to the bytes after put", () => {
    const { values } = chunkedValues();
    const input = bytes(10);

    values.put("a", input);
    input.fill(255);

    expect(values.get("a")?.bytes).toEqual(bytes(10));
  });

  it("returns bytes the caller may change", () => {
    const { values } = chunkedValues();
    values.put("a", bytes(10));

    values.get("a")?.bytes.fill(255);

    expect(values.get("a")?.bytes).toEqual(bytes(10));
  });

  it("deletes a value's manifest and chunks, and ignores an absent one", () => {
    const { values, kv } = chunkedValues();
    values.put("a", bytes(10), META);

    values.delete("a");

    expect(kv.keys()).toEqual([]);
    expect(values.get("a")).toBeUndefined();
    expect(values.meta("a")).toBeUndefined();
    expect(() => values.delete("a")).not.toThrow();
    expect(() => values.delete("never-stored")).not.toThrow();
  });

  // The manifest is deleted last, so every chunk was removed before the failure and only a
  // rollback restores them.
  it("leaves the value whole when a delete fails", () => {
    const deleted: string[] = [];
    const storage = watched(fakeStorage(), (operation, at) => {
      if (operation !== "delete") return;
      if (at === keyOf("a", "manifest")) throw new Error("storage refused");
      deleted.push(at);
    });
    const { values, kv } = chunkedValues({}, storage);
    values.put("a", bytes(10), META);

    expect(() => values.delete("a")).toThrow("storage refused");

    expect(deleted).toEqual(chunkKeys("a", 3));
    expect(values.get("a")).toEqual({ bytes: bytes(10), meta: META });
    expect(kv.keys()).toEqual(keysOf("a", 3));
  });

  it("keeps names apart", () => {
    const { values, kv } = chunkedValues();
    const others = ["a.chunk", "a/0000", "ab"];
    for (const [index, name] of others.entries()) values.put(name, bytes(10, index + 1), name);
    const othersWhole = (): void => {
      for (const [index, name] of others.entries()) {
        expect(values.get(name)).toEqual({ bytes: bytes(10, index + 1), meta: name });
      }
      expect(kv.keys().filter(at => !at.startsWith(`${PREFIX}a:`)))
        .toEqual(others.flatMap(name => keysOf(name, 3)).toSorted());
    };

    values.put("a", bytes(20));
    othersWhole();

    values.put("a", bytes(3));
    expect(kv.keys().filter(at => at.startsWith(`${PREFIX}a:`))).toEqual(keysOf("a", 1));
    othersWhole();

    values.delete("a");
    expect(values.get("a")).toBeUndefined();
    othersWhole();
  });

  it.each([
    ["empty", ""],
    ["holding a colon", "a:b"],
    ["holding a lone surrogate", "a\uD800"],
  ])("refuses a name that is %s", (_name, name) => {
    const { values, kv } = chunkedValues();
    const refusal = "A chunked value name must be well-formed, not empty and without \":\", " +
      `got ${JSON.stringify(name)}.`;

    expect(() => values.put(name, bytes(3))).toThrow(refusal);
    expect(() => values.get(name)).toThrow(refusal);
    expect(() => values.meta(name)).toThrow(refusal);
    expect(() => values.delete(name)).toThrow(refusal);

    expect(kv.writes).toEqual([]);
  });

  it.each([
    ["outside ASCII", "café 文書"],
    ["holding a surrogate pair", "tab 📄"],
  ])("accepts a name that is %s", (_name, name) => {
    const { values, kv } = chunkedValues();

    values.put(name, bytes(10), META);

    expect(values.get(name)).toEqual({ bytes: bytes(10), meta: META });
    expect(kv.keys()).toEqual(keysOf(name, 3));
    values.delete(name);
    expect(kv.keys()).toEqual([]);
  });

  it("refuses a value needing more than 10,000 chunks before writing", () => {
    const { values, kv } = chunkedValues({ chunkBytes: 1 });
    values.put("a", bytes(3), META);
    const writes = kv.writes.length;

    expect(() => values.put("a", bytes(10_001))).toThrow("at most 10000 chunks");

    expect(kv.writes).toHaveLength(writes);
    expect(values.get("a")).toEqual({ bytes: bytes(3), meta: META });

    values.put("a", bytes(10_000, 7));
    expect(kv.keys().at(-2)).toBe(keyOf("a", "chunk:9999"));
    expect(kv.keys()).toHaveLength(10_001);
    expect(bytesEqual(values.get("a")?.bytes, bytes(10_000, 7))).toBe(true);
  });

  it("refuses an empty or malformed prefix and a chunk size that is not a positive integer up to the default", () => {
    const storage = fakeStorage();

    expect(() => new ChunkedValues(storage, { prefix: "" }))
      .toThrow("ChunkedValues prefix must not be empty.");
    expect(() => new ChunkedValues(storage, { prefix: "copy:\uD800:" }))
      .toThrow("ChunkedValues prefix must be well-formed Unicode.");
    for (const chunkBytes of [0, 1.5, CHUNKED_VALUE_CHUNK_BYTES + 1]) {
      expect(() => new ChunkedValues(storage, { prefix: PREFIX, chunkBytes })).toThrow("chunkBytes must be");
    }
    expect(() => new ChunkedValues(storage, { prefix: PREFIX, chunkBytes: CHUNKED_VALUE_CHUNK_BYTES }))
      .not.toThrow();
  });

  it("runs several puts and deletes as one transaction", () => {
    const { values, kv } = chunkedValues();
    values.put("replaced", bytes(10), "earlier");
    values.put("removed", bytes(6));
    const before = kv.keys();
    const change = (fail: boolean): string => values.transaction(() => {
      values.put("replaced", bytes(3, 100), "later");
      values.put("added", bytes(5));
      values.delete("removed");
      if (fail) throw new Error("a later step failed");
      return "done";
    });

    expect(() => change(true)).toThrow("a later step failed");
    expect(kv.keys()).toEqual(before);
    expect(values.get("replaced")).toEqual({ bytes: bytes(10), meta: "earlier" });
    expect(values.get("added")).toBeUndefined();
    expect(values.get("removed")?.bytes).toEqual(bytes(6));

    expect(change(false)).toBe("done");
    expect(values.get("replaced")).toEqual({ bytes: bytes(3, 100), meta: "later" });
    expect(values.get("added")?.bytes).toEqual(bytes(5));
    expect(values.get("removed")).toBeUndefined();
    expect(kv.keys()).toEqual([...keysOf("added", 2), ...keysOf("replaced", 1)]);
  });

  it("uses 1 MiB chunks by default", () => {
    const storage = fakeStorage();
    const values = new ChunkedValues(storage, { prefix: PREFIX });
    const input = bytes(CHUNKED_VALUE_CHUNK_BYTES + 17);

    values.put("a", input);

    expect(storage.kv.keys()).toEqual(keysOf("a", 2));
    const sizes = [...storage.kv.list<Uint8Array>({ prefix: keyOf("a", "chunk:") })]
      .map(([, chunk]) => chunk.byteLength);
    expect(sizes).toEqual([CHUNKED_VALUE_CHUNK_BYTES, 17]);
    expect(bytesEqual(values.get("a")?.bytes, input)).toBe(true);
  });
});
