/** Values larger than one Durable Object KV value, stored as chunks and read synchronously. */

import type { KvScannable } from "./kv";
import { requirePositiveInt } from "./positive-int";

/** Bytes per stored chunk unless configured, leaving headroom below the 2 MiB KV value limit. */
export const CHUNKED_VALUE_CHUNK_BYTES = 1024 * 1024;

// Chunk keys end in a four-digit index, and four digits number this many indexes.
const MAX_CHUNKS = 10_000;

/** Transactional Durable Object storage used by chunked values. */
export type ChunkedValueStorage = {
  /** Synchronous KV storage for manifests and chunks. */
  readonly kv: KvScannable;
  /**
   * Runs writes atomically: a throw from `callback` undoes every write it made. Must nest, as
   * `ctx.storage.transactionSync` does.
   */
  transactionSync<T>(callback: () => T): T;
};

/** Keys and chunk size for a `ChunkedValues`. */
export type ChunkedValuesOptions = {
  /**
   * Prefix of every key the store writes. Not empty, and well-formed Unicode. Stores sharing
   * one storage need prefixes none of which starts another; this convention is not checked.
   */
  readonly prefix: string;
  /**
   * Bytes per chunk: a positive integer no larger than `CHUNKED_VALUE_CHUNK_BYTES`, the default.
   * A value is read back with the size it was written with, whatever this says later.
   */
  readonly chunkBytes?: number;
};

/** A stored value as `ChunkedValues.get` returns it. Both parts are the caller's to keep. */
export type ChunkedValue = {
  /** The exact bytes that were put, in a buffer of their own. */
  readonly bytes: Uint8Array;
  /** The `meta` that was put with them, or `undefined`. */
  readonly meta: unknown;
};

type Manifest = {
  readonly version: 1;
  readonly size: number;
  readonly chunkBytes: number;
  readonly chunks: number;
  readonly meta?: unknown;
};

/**
 * Stores named byte values of any size in Durable Object KV, each as a manifest plus chunks no
 * larger than one KV value may be, and reads them back synchronously, so a read can run inside
 * `transactionSync`.
 *
 * A value is `${prefix}${name}:manifest` and `${prefix}${name}:chunk:0000` onwards. A put or a
 * delete is one transaction, so a reader finds the earlier value or the later one whole, and a
 * put that fails leaves the earlier value as it was. A read validates every chunk against the
 * manifest and answers `undefined` for a value that is absent or incomplete, never part of one;
 * it writes nothing. Values are bytes because a stored object read back and put again is stored
 * larger than it was; bytes are stored as they are.
 *
 * `put` and `delete` scan with `kv.list`, and storage keeps one `kv.list` iterator alive at a
 * time, so calling either inside a `kv.list` loop of the caller's makes that loop throw at its
 * next step: collect the scan into an array first. `get` and `meta` open no scan.
 *
 * A name is not empty, is well-formed Unicode and holds no `:`; every method throws for any
 * other. Keep a name short: it is part of every key of its value, and storage bounds a key
 * together with the value under it, so a name near a chunk's size fails the write. A value has
 * at most 10,000 chunks, the indexes four digits can number.
 *
 * @example
 * ```ts
 * #values = new ChunkedValues(this.ctx.storage, { prefix: "copy:" });
 *
 * store(tabId: string, tab: Tab): void {
 *   this.#values.put(tabId, new TextEncoder().encode(JSON.stringify(tab)), { savedAt: Date.now() });
 * }
 * ```
 */
export class ChunkedValues {
  readonly #storage: ChunkedValueStorage;
  readonly #prefix: string;
  readonly #chunkBytes: number;

  /**
   * Creates a store over a Durable Object's storage.
   * @param storage Pass `ctx.storage`; only its `kv` and `transactionSync` are used.
   * @param options Key prefix and chunk size. Throws for a prefix that is empty or not
   * well-formed Unicode, or a chunk size that is not a positive integer up to
   * `CHUNKED_VALUE_CHUNK_BYTES`.
   */
  constructor(storage: ChunkedValueStorage, options: ChunkedValuesOptions) {
    if (options.prefix === "") throw new Error("ChunkedValues prefix must not be empty.");
    // A scan returns a key that holds a lone surrogate changed, so its chunks could not be found.
    if (!options.prefix.isWellFormed()) {
      throw new Error("ChunkedValues prefix must be well-formed Unicode.");
    }
    const chunkBytes = requirePositiveInt(
      "chunkBytes",
      options.chunkBytes ?? CHUNKED_VALUE_CHUNK_BYTES,
    );
    if (chunkBytes > CHUNKED_VALUE_CHUNK_BYTES) {
      throw new Error(`chunkBytes must be at most ${CHUNKED_VALUE_CHUNK_BYTES}, got ${chunkBytes}.`);
    }
    this.#storage = storage;
    this.#prefix = options.prefix;
    this.#chunkBytes = chunkBytes;
  }

  /**
   * Stores `bytes` under `name`, replacing any value there, in one transaction: its chunks, the
   * removal of any chunk the earlier value had beyond them, then the manifest. Each chunk is
   * copied as it is written, so later changes to `bytes` do not reach storage. A throw (storage
   * refusing a write, `meta` that cannot be cloned) leaves the earlier value whole.
   * @param name Value name: not empty, well-formed Unicode and with no `:`, so that no name's
   * keys can be another's and a scan finds every key it wrote. Throws otherwise. Its length is
   * not checked: a name too long for a storage key fails the write, and so the whole put.
   * @param bytes Bytes to store; may be empty. Throws, before writing, when they need more than
   * 10,000 chunks.
   * @param meta Structured-cloneable data kept in the manifest and returned by `get` and
   * `meta`. Keep it small: the manifest is one KV value.
   */
  put(name: string, bytes: Uint8Array, meta?: unknown): void {
    requireName(name);
    const chunkBytes = this.#chunkBytes;
    const chunks = Math.ceil(bytes.byteLength / chunkBytes);
    if (chunks > MAX_CHUNKS) {
      throw new Error(
        `A chunked value holds at most ${MAX_CHUNKS} chunks of ${chunkBytes} bytes, ` +
          `got ${bytes.byteLength} bytes.`,
      );
    }
    const { kv } = this.#storage;
    const manifest: Manifest = { version: 1, size: bytes.byteLength, chunkBytes, chunks, meta };
    this.#storage.transactionSync(() => {
      for (let index = 0; index < chunks; index++) {
        const start = index * chunkBytes;
        // A view is stored with its whole underlying buffer, and `slice()` on a Node `Buffer`
        // aliases, so each chunk goes into a buffer of its own. Copying one chunk at a time
        // holds the value plus one chunk in memory, never the value twice.
        kv.put(
          this.#chunkKey(name, index),
          new Uint8Array(bytes.subarray(start, start + chunkBytes)),
        );
      }
      // The scan starts after the chunks just written, so it yields only the chunks of a longer
      // earlier value, whatever that value's manifest says.
      const stale = chunks === 0
        ? { prefix: this.#chunkPrefix(name) }
        : { prefix: this.#chunkPrefix(name), startAfter: this.#chunkKey(name, chunks - 1) };
      for (const [key] of kv.list(stale)) kv.delete(key);
      // The manifest goes last: a `meta` storage cannot clone fails here, after every chunk
      // write, and the transaction undoes them all.
      kv.put(this.#manifestKey(name), manifest);
    });
  }

  /**
   * Reads a value whole. Synchronous and read-only. Nothing that is stored makes it throw.
   * @param name Value name; throws for a name `put` would refuse.
   * @returns The bytes and meta, or `undefined` when no value is stored or the stored one is
   * incomplete: a manifest this code does not understand, or a chunk that is missing, not bytes,
   * or not the size the manifest implies.
   */
  get(name: string): ChunkedValue | undefined {
    requireName(name);
    const { kv } = this.#storage;
    const manifest = kv.get<unknown>(this.#manifestKey(name));
    if (!validManifest(manifest)) return undefined;
    const { size, chunkBytes } = manifest;
    const chunks: Uint8Array[] = [];
    for (let index = 0; index < manifest.chunks; index++) {
      const chunk = kv.get<unknown>(this.#chunkKey(name, index));
      const expected = Math.min(chunkBytes, size - index * chunkBytes);
      if (!(chunk instanceof Uint8Array) || chunk.byteLength !== expected) return undefined;
      chunks.push(chunk);
    }
    // Allocated only once every chunk is known to be there: a manifest claiming far more bytes
    // than are stored then reads as missing instead of failing the allocation.
    const bytes = new Uint8Array(size);
    for (const [index, chunk] of chunks.entries()) bytes.set(chunk, index * chunkBytes);
    return { bytes, meta: manifest.meta };
  }

  /**
   * Reads a value's meta from its manifest alone, touching no chunk. It therefore answers for a
   * value whose chunks `get` would find incomplete.
   * @param name Value name; throws for a name `put` would refuse.
   * @returns The meta, or `undefined` when no manifest is stored, it is not one this code
   * understands, or the value was put without meta.
   */
  meta(name: string): unknown {
    requireName(name);
    const manifest = this.#storage.kv.get<unknown>(this.#manifestKey(name));
    return validManifest(manifest) ? manifest.meta : undefined;
  }

  /**
   * Removes a value's manifest and every chunk in one transaction. Removing an absent value does
   * nothing.
   * @param name Value name; throws for a name `put` would refuse.
   */
  delete(name: string): void {
    requireName(name);
    const { kv } = this.#storage;
    this.#storage.transactionSync(() => {
      for (const [key] of kv.list({ prefix: this.#chunkPrefix(name) })) kv.delete(key);
      kv.delete(this.#manifestKey(name));
    });
  }

  /**
   * Runs several puts and deletes as one transaction, so a reader finds all of them or none.
   * @param run Synchronous work; a throw undoes every write it made and is rethrown.
   * @returns What `run` returned.
   */
  transaction<T>(run: () => T): T {
    return this.#storage.transactionSync(run);
  }

  #manifestKey(name: string): string {
    return `${this.#prefix}${name}:manifest`;
  }

  #chunkPrefix(name: string): string {
    return `${this.#prefix}${name}:chunk:`;
  }

  #chunkKey(name: string, index: number): string {
    return `${this.#chunkPrefix(name)}${String(index).padStart(4, "0")}`;
  }
}

function requireName(name: string): void {
  // With no `:` in a name, the first `:` after the prefix ends it, so no name's keys can be
  // another's. A key that is not well-formed Unicode comes back from a scan changed, so the
  // chunks under it could never be found again to remove.
  if (name === "" || !name.isWellFormed() || name.includes(":")) {
    throw new Error(
      `A chunked value name must be well-formed, not empty and without ":", got ${JSON.stringify(name)}.`,
    );
  }
}

function validManifest(value: unknown): value is Manifest {
  if (!value || typeof value !== "object") return false;
  const { version, size, chunkBytes, chunks } = value as Record<string, unknown>;
  // The bound on `chunkBytes` is the largest any store writes, which keeps a foreign record
  // from implying one huge chunk.
  return version === 1 &&
    Number.isSafeInteger(size) && (size as number) >= 0 &&
    Number.isSafeInteger(chunkBytes) && (chunkBytes as number) >= 1 &&
    (chunkBytes as number) <= CHUNKED_VALUE_CHUNK_BYTES &&
    chunks === Math.ceil((size as number) / (chunkBytes as number)) &&
    chunks <= MAX_CHUNKS;
}
