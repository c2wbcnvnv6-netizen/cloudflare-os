/**
 * A remembered fold of pending actions over one entity at a time, a stored, revision-checked
 * base, and the values a kit cursor takes for a listing folded that way.
 */

import type { ChunkedValues } from "./chunked-value";
import { requirePositiveInt } from "./positive-int";
import type { SimulationRecord, SimulationStep, SimulationView } from "./simulation";
import { SingleFlight } from "./single-flight";

/**
 * What one record does to one entity: `applied` with the entity as it then is, `deleted`,
 * `refused` (the record cannot be replayed on this entity; the entity stays as it was),
 * `known-no-effect`, or `unsupported`, which ends the entity's fold at that record.
 */
export type EntityStep<Entity, Refusal = never> =
  | SimulationStep<Entity>
  | { kind: "deleted" }
  | { kind: "refused"; refusal: Refusal };

/** What a reducer is given beside the entity and the record. */
export type EntityContext<Id extends string, Base extends object, Refusal> = {
  /** The entity being folded. */
  readonly id: Id;
  /** What the provider holds of the entity, or `undefined` for one it does not hold. */
  readonly base: Base | undefined;
  /**
   * The refusals this call of `fold` has recorded on the entity so far, oldest first. A record
   * that depends on an earlier one having applied reads them to REFUSE (a gate a refusal
   * closes), and for nothing else: a step that applies, deletes or has no effect must be the
   * same whatever they hold, because a remembered fold stands once its refused records have
   * left the list. They are not remembered: a later call starts with none.
   */
  readonly refusals: readonly Refusal[];
};

/** The reducer of a simulation store. */
export type SimulationStoreOptions<
  Id extends string,
  Base extends object,
  Entity,
  R extends SimulationRecord<unknown>,
  Refusal = never,
> = {
  /**
   * The entity with no record applied, from what the provider holds of it. Called once per fold
   * that starts from the beginning. May return `base` itself. Must be pure, as `reduce` is.
   */
  readonly initial: (base: Base) => Entity;
  /**
   * Projects one record onto one entity. `entity` is `undefined` for an entity the provider does
   * not hold and no earlier record made, and after a `deleted` step: a record that creates the
   * entity returns it as `applied`. Must be pure: the same step for the same arguments, no
   * change to any of them, no effect outside them and no call to the store, because a
   * remembered fold does not call it again. `refused` leaves the entity as it was and the fold
   * goes on; `unsupported` ends the fold at that record. An `applied` step whose value is the
   * very object `reduce` was given makes `fold` throw, since an entity changed in place cannot
   * be told from one left alone: return `known-no-effect` for a record that changes nothing. A
   * throw passes through `fold`.
   */
  readonly reduce: (
    entity: Entity | undefined,
    record: R,
    context: EntityContext<Id, Base, Refusal>,
  ) => EntityStep<Entity, Refusal>;
};

/** One entity with its pending records folded over it. */
export type EntityFold<Entity, R, Refusal> = {
  /**
   * The entity as it stands, or `undefined` for one the provider does not hold and no record
   * made, and for one a record deleted. The store keeps it: do not change it.
   */
  readonly entity: Entity | undefined;
  /** The records THIS call refused, in order, each with what `reduce` returned for it. */
  readonly refused: readonly { readonly record: R; readonly refusal: Refusal }[];
  /**
   * Set when `reduce` reported a record unsupported: that record and the reason. `entity` is
   * then the entity before it, and no later record was folded.
   */
  readonly stopped?: { readonly record: R; readonly reason: string };
};

/** A fold of pending records over entities, one entity at a time, that remembers each. */
export type SimulationStore<
  Id extends string,
  Base extends object,
  Entity,
  R extends SimulationRecord<unknown>,
  Refusal = never,
> = {
  /**
   * Folds the records that target one entity over what the provider holds of it, in the order
   * given. Synchronous, with no effect but the memory. The result is what a store with no
   * memory would return.
   *
   * `records` are the entity's own: `createSimulationView(pending, targets).forTarget(id)`,
   * where `targets` names every entity a record changes, each id already resolved through
   * `ProvisionalIds` where a pending create will make it. A record that targets several
   * entities is folded once for each, by the call that folds that entity, and each of those
   * folds stands alone: refused on one entity, the record still applies to the others, unless
   * the caller leaves it out or removes it before it folds them. A caller whose record must
   * take effect on all of its entities or none folds the entity that can refuse it first and
   * leaves what that fold refused out of the lists it folds next. A record that targets none
   * of the entities read is never reduced.
   *
   * A record the caller has marked as not to be replayed (a stored reason) is one it leaves
   * out of `records`: the store reads no mark, and reduces every record it is given.
   *
   * Memory is per entity: the latest fold over each base OBJECT (weakly), and the latest fold
   * of each entity folded with no base. A later call with the same base object extends that
   * fold when its records begin with the remembered ones, by id and in the same order, once
   * the remembered records this store refused that are no longer in the list are set aside.
   * Anything else (a record removed, left out or added before the end, a refused record
   * presented again, another base object) folds that entity from the beginning. Nothing one
   * entity's records do reaches another entity's memory.
   *
   * A record is known by its id alone. So after a fold refuses a record, leave it out (having
   * marked it) or remove it, and the next fold costs nothing for it; presented again, the
   * entity is folded from the beginning and the record refused again. Call `forget` only when
   * a record is rewritten under its id in a way `reduce` reads, or when a folded record's id
   * may be given to another record.
   * @param id The entity, by the provider's own id (or the provisional id of a pending create).
   * @param base What the provider holds of it, never changed in place; `undefined` for none.
   * @param records The pending records to replay that target the entity, oldest first, with
   *   distinct ids.
   * @returns The entity as it stands, what this call refused, and where the fold stopped.
   * @throws Error when `reduce` returns an `applied` step whose value is the object it was
   *   given. That error, and whatever `initial` or `reduce` throws, leaves the memory as it
   *   was.
   */
  readonly fold: (
    id: Id,
    base: Base | undefined,
    records: readonly R[],
  ) => EntityFold<Entity, R, Refusal>;
  /**
   * With no id, drops everything remembered. With an id, drops the fold of that entity made
   * with NO base, and only that: a fold over a base object is found by the object and goes
   * with it, so `forget(id)` leaves it. A fold with no base is held by its id until it is
   * forgotten, so a caller that folds entities the provider does not hold (the stand-in of a
   * pending create) calls `forget(id)` once the id will not be folded again: its create was
   * rejected, or applied and the provider's id took its place. A fold that is running when
   * `forget()` is called with no id is not remembered.
   */
  readonly forget: (id?: Id) => void;
};

// What a fold of one entity left behind. `ids` are the records it covers, in order, reduced and
// refused alike; `refused` are those of them the store refused; `entity` is the entity after
// them. `stop` is the reason when the fold stopped at the last covered record, whose `entity`
// is then the one before that record.
type Memo<Id, Entity> = {
  readonly id: Id;
  readonly ids: readonly number[];
  readonly refused: ReadonlySet<number>;
  readonly entity: Entity | undefined;
  readonly stop?: string;
};

// The ids of `memo` that a fold of `records` starts from: its ids less the refused ones the list
// no longer carries, when the list begins with them. `undefined` when it does not, and when the
// list carries a record the memo's fold refused, which is then folded, and refused, again.
function remembered(
  memo: Memo<unknown, unknown>,
  records: readonly SimulationRecord<unknown>[],
): readonly number[] | undefined {
  let ids = memo.ids;
  if (memo.refused.size > 0) {
    if (records.some(record => memo.refused.has(record.id))) return undefined;
    ids = ids.filter(id => !memo.refused.has(id));
  }
  return ids.length <= records.length && ids.every((id, index) => records[index].id === id)
    ? ids
    : undefined;
}

/**
 * Creates a store that folds pending journal records over one entity at a time with a
 * gatekeeper's own pure reducer, remembers each entity's latest fold so that a newly submitted
 * record costs one step and another entity's records cost none, and reports what could not be
 * replayed. The gatekeeper keeps the reducer and the listing; the store keeps no storage, runs
 * no callback but the reducer's and has no effect outside its memory. Keep one per Durable
 * Object activation for each kind of entity replayed, or one per listing where the reducer
 * reads what only that call knows (who is asking, the folder listed).
 * @param options The reducer and the entity with nothing applied.
 * @returns A frozen store.
 *
 * @example
 * ```ts
 * // An editor whose state is one thing folds it as its one entity.
 * #replay = createSimulationStore<"deck", Deck, Deck, QueuedChange>({
 *   initial: deck => deck,
 *   reduce: (deck, change) => step(deck!, change.action),
 * });
 *
 * const deck = this.#replay.fold("deck", fetched, this.#journal.listUndecided());
 * return deck.stopped
 *   ? { deck: deck.entity, conflict: conflictReason(deck.stopped.record, deck.stopped.reason) }
 *   : { deck: deck.entity };
 *
 * // A document read one tab at a time folds the records of the tab it reads.
 * const view = createSimulationView(pending, action => [action.tabId]);
 * const { entity, refused } = store.fold(tabId, tab, view.forTarget(tabId));
 * ```
 */
export function createSimulationStore<
  Id extends string,
  Base extends object,
  Entity,
  R extends SimulationRecord<unknown>,
  Refusal = never,
>(
  options: SimulationStoreOptions<Id, Base, Entity, R, Refusal>,
): SimulationStore<Id, Base, Entity, R, Refusal> {
  // One entry per base object, the latest fold over it, and one per entity folded with no base.
  // A `WeakMap` keyed by the base, rather than a `WeakRef` beside the entity: an entity usually
  // reaches its base, so a memo that held its base would keep one fetched for a single read
  // alive for the activation's life. Replaced whole by `forget()`, which is how a fold that was
  // running then knows not to remember itself.
  let byBase = new WeakMap<Base, Memo<Id, Entity>>();
  const unbased = new Map<Id, Memo<Id, Entity>>();

  const fold = (
    id: Id,
    base: Base | undefined,
    records: readonly R[],
  ): EntityFold<Entity, R, Refusal> => {
    const began = byBase;
    const memo = base === undefined ? unbased.get(id) : began.get(base);
    // The same base object folded under another id is another entity's.
    const from = memo?.id === id ? remembered(memo, records) : undefined;
    let entity =
      from !== undefined ? memo?.entity : base === undefined ? undefined : options.initial(base);
    if (from !== undefined && memo?.stop !== undefined) {
      // The match proved the record the fold stopped at, its last, is still presented.
      return {
        entity,
        refused: [],
        stopped: { record: records[from.length - 1], reason: memo.stop },
      };
    }

    const ids = [...(from ?? [])];
    const refusedIds = new Set<number>();
    const refused: { record: R; refusal: Refusal }[] = [];
    const refusals: Refusal[] = [];
    let stopped: { record: R; reason: string } | undefined;
    for (const record of records.slice(ids.length)) {
      const step = options.reduce(entity, record, { id, base, refusals });
      ids.push(record.id);
      if (step.kind === "applied") {
        // An entity changed in place would look right while remembered and wrong once folded
        // afresh.
        if (step.value === entity && Object(entity) === entity) {
          throw new Error(
            "A simulation reducer returned the entity it was given as applied. Return " +
              "known-no-effect for a record that changes nothing, and a new value otherwise.",
          );
        }
        entity = step.value;
      } else if (step.kind === "deleted") {
        entity = undefined;
      } else if (step.kind === "refused") {
        refused.push({ record, refusal: step.refusal });
        refusals.push(step.refusal);
        refusedIds.add(record.id);
      } else if (step.kind === "unsupported") {
        stopped = { record, reason: step.reason };
        break;
      }
    }

    // A `forget()` that ran while this fold ran wins, and this fold is not remembered.
    if (byBase === began) {
      const next: Memo<Id, Entity> = {
        id,
        ids,
        refused: refusedIds,
        entity,
        ...(stopped && { stop: stopped.reason }),
      };
      if (base === undefined) unbased.set(id, next);
      else began.set(base, next);
    }
    return { entity, refused, ...(stopped && { stopped }) };
  };

  return Object.freeze({
    fold,
    forget: (id?: Id) => {
      if (id !== undefined) {
        unbased.delete(id);
        return;
      }
      byBase = new WeakMap();
      unbased.clear();
    },
  });
}

/**
 * A base as `StoredBase` holds it, one partition at a time. It says when the copy was fetched,
 * not whether the provider still holds it so: `held()` returns a copy of any age.
 */
export type HeldBase<Part> = {
  /** The partition keys, in `encode`'s order. Reading them decodes nothing. */
  readonly keys: readonly string[];
  /**
   * One partition, decoded on first use. One `StoredBase` gives the same object for the same
   * stored bytes of a key, across reads and across fetches that brought those bytes again, so a
   * simulation store can remember a fold over it. Do not change it.
   *
   * A copy is a view of what is stored, and a later fetch, a `noteWrite()` or a `drop()` replaces
   * or retires what is stored. A partition is served while storage still holds this copy's bytes
   * for it (the stored index lists the key with this copy's digest, and no write was noted
   * since) or its decoded object is still remembered, so a copy held across a later fetch never
   * serves the later copy's bytes, and may serve none: read the partitions wanted before
   * awaiting, or call `current()` again.
   * @param key A partition key, one of `keys`.
   * @returns The partition, or `undefined` for a key the copy does not list, for a partition
   * storage no longer holds as this copy had it (nothing is remembered of that, and `held()` is
   * unaffected), and for a partition of the stored copy that cannot be read back (missing,
   * incomplete, or `decode` throws), after which `held()` reads the copy as absent and the
   * next `current()` fetches.
   */
  part(key: string): Part | undefined;
  /** The clock when the fetch that produced this copy began. A revision check does not move it. */
  readonly fetchedAt: number;
  /** The provider's revision of the copy, when the fetch reported one. */
  readonly revision?: string;
};

/** Storage, encoding, source and freshness of a `StoredBase`. */
export type StoredBaseOptions<Base, Part> = {
  /** Where the copy is kept. */
  readonly values: ChunkedValues;
  /**
   * Names this base among those sharing `values`: letters, digits, `_` and `-`. The base owns
   * the value named `name` and every value whose name starts `${name}/`.
   */
  readonly name: string;
  /**
   * The version of `encode`'s output, an integer. A copy stored under another version reads as
   * absent.
   */
  readonly formatVersion: number;
  /**
   * Splits a base into named partitions (a document's tabs), each stored as its own value so
   * that none is bounded by another's size and each is read and rewritten alone. A partition
   * key is any well-formed Unicode string, the empty one included; `current()` rejects, storing
   * nothing, for a key that is not. Equal bytes under a key are the same partition: give a
   * partition the same bytes whenever its content is the same.
   */
  readonly encode: (base: Base) => ReadonlyMap<string, Uint8Array>;
  /**
   * Rebuilds one partition from the bytes `encode` produced under `key`. What is served is
   * always `decode` of the stored bytes, never the fetched object, so reads agree before and
   * after an eviction. A throw reads as a partition that cannot be read back.
   */
  readonly decode: (key: string, bytes: Uint8Array) => Part;
  /** Fetches the base from the provider, with its revision if the provider reports one. */
  readonly fetch: () => Promise<{ base: Base; revision?: string }>;
  /** How long a copy is served without asking the provider anything. A positive integer. */
  readonly ttlMs: number;
  /**
   * Whether the provider still holds this revision; cheaper than `fetch`. Asked once a copy with
   * a revision is older than `ttlMs`. Absent, or with no revision held, an old copy is fetched
   * again.
   */
  readonly unchanged?: (revision: string) => Promise<boolean>;
  /** Clock, for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
};

// The record that names a stored copy, kept as the meta of the value named `name`, whose bytes
// are empty. `stamp` is random per stored fetch. `partitions` lists every partition in `encode`'s
// order with the lowercase hex SHA-256 of its bytes. `checkedAt` is the clock when the copy was
// last fetched or confirmed, and a copy without one is due for a check; `stale` says a write
// reached the provider since the copy was fetched: such a copy is served to no one, and its
// digests say which partitions the next fetch need not store again.
type Index = {
  readonly version: 2;
  readonly formatVersion: number;
  readonly stamp: string;
  readonly fetchedAt: number;
  readonly revision?: string;
  readonly partitions: readonly { readonly key: string; readonly digest: string }[];
  readonly checkedAt?: number;
  readonly stale?: true;
};

/** A base fetched and encoded, not stored: what `#keep` takes. */
type Fetched = {
  readonly epoch: number;
  readonly fetchedAt: number;
  readonly revision?: string;
  /** Partition key to bytes, in `encode`'s order, and to the digest of those bytes. */
  readonly parts: ReadonlyMap<string, Uint8Array>;
  readonly digests: ReadonlyMap<string, string>;
};

const EMPTY = new Uint8Array(0);

// `encodeURIComponent` throws for a string that is not well-formed Unicode, so no partition is
// ever stored under such a key and none is looked for under one.
const wellFormed = (key: unknown): key is string => typeof key === "string" && key.isWellFormed();

function validIndex(value: unknown): value is Index {
  if (!value || typeof value !== "object") return false;
  const { version, formatVersion, stamp, fetchedAt, revision, partitions, checkedAt } =
    value as Record<string, unknown>;
  return version === 2 &&
    typeof formatVersion === "number" &&
    typeof stamp === "string" &&
    Number.isFinite(fetchedAt) &&
    (revision === undefined || typeof revision === "string") &&
    (checkedAt === undefined || Number.isFinite(checkedAt)) &&
    Array.isArray(partitions) &&
    partitions.every(entry =>
      !!entry && typeof entry === "object" && wellFormed(entry.key) &&
      typeof entry.digest === "string"
    );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A provider's state kept in Durable Object storage one partition at a time, served while
 * fresh, checked against the provider's revision when old, and readable synchronously inside a
 * transaction. A partition is loaded when it is read, and rewritten only when a fetch brought
 * other bytes for it. It suits a base that is bounded (a document), not one read by range (a
 * spreadsheet's cells).
 *
 * Storage is the truth: a partition is always decoded from its stored bytes, and a decoded
 * partition in memory is served only for the digest of the bytes it was decoded from, so nothing
 * is lost when the Durable Object is evicted. A fetch is encoded and digested before anything is
 * stored, and stored in a second step. What is in memory only is the fetch in flight, so build
 * one `StoredBase` per Durable Object activation and share it.
 *
 * `noteWrite()`, `recheck()`, `drop()` and a `current()` that stores or confirms the copy write
 * through `ChunkedValues`, whose writes scan: none may run while a `kv.list` loop of the
 * caller's is open (see `ChunkedValues`). `held()` and a copy's `part()` may.
 *
 * @example
 * ```ts
 * #copy = new StoredBase<Doc, Tab>({
 *   values: new ChunkedValues(this.ctx.storage, { prefix: "copy:" }),
 *   name: "doc", formatVersion: 1, ttlMs: 10_000,
 *   encode: doc => new Map(doc.tabs.map(tab => [tab.id, encodeTab(tab)])),
 *   decode: (key, bytes) => decodeTab(bytes),
 *   fetch: async () => { const doc = await this.#api.get(); return { base: doc, revision: doc.revisionId }; },
 *   unchanged: async revision => await this.#api.revision() === revision,
 * });
 *
 * async tab(tabId: string): Promise<Tab | undefined> {
 *   // Read at once: a copy is a view of what is stored, and a later fetch replaces that.
 *   return (await this.#copy.current()).part(tabId);
 * }
 * ```
 */
export class StoredBase<Base, Part> {
  readonly #values: ChunkedValues;
  readonly #name: string;
  readonly #formatVersion: number;
  readonly #encode: (base: Base) => ReadonlyMap<string, Uint8Array>;
  readonly #decode: (key: string, bytes: Uint8Array) => Part;
  readonly #source: () => Promise<{ base: Base; revision?: string }>;
  readonly #ttlMs: number;
  readonly #unchanged: ((revision: string) => Promise<boolean>) | undefined;
  readonly #now: () => number;
  // The latest partition this instance decoded under each key, with the digest of the bytes it
  // was decoded from. An entry is served to any copy that lists its key with that digest. It
  // holds no key the stored copy does not list once a fetch has been stored.
  readonly #decoded = new Map<string, { readonly digest: string; readonly part: Part }>();
  // The stamp of a stored copy one of whose partitions could not be read back. That copy reads
  // as absent.
  #unreadable: string | undefined;
  // Counts the calls that made work in flight worthless.
  #epoch = 0;
  readonly #flights = new SingleFlight<"current">();

  /**
   * @param options Storage, encoding, source and freshness. Throws for a `name` outside
   * `[A-Za-z0-9_-]+`, a `formatVersion` that is not an integer, or a `ttlMs` that is not a
   * positive integer.
   */
  constructor(options: StoredBaseOptions<Base, Part>) {
    if (!/^[A-Za-z0-9_-]+$/.test(options.name)) {
      throw new Error(
        `A StoredBase name must be letters, digits, "_" or "-", got ${JSON.stringify(options.name)}.`,
      );
    }
    // `NaN` never equals itself, so a copy stored under it would be fetched again on every read.
    if (!Number.isSafeInteger(options.formatVersion)) {
      throw new Error(`formatVersion must be a safe integer, got ${options.formatVersion}.`);
    }
    this.#values = options.values;
    this.#name = options.name;
    this.#formatVersion = options.formatVersion;
    this.#encode = options.encode;
    this.#decode = options.decode;
    this.#source = options.fetch;
    this.#ttlMs = requirePositiveInt("ttlMs", options.ttlMs);
    this.#unchanged = options.unchanged;
    this.#now = options.now ?? Date.now;
  }

  /**
   * The base, as fresh as `ttlMs` asks. Serves the stored copy while it was fetched or confirmed
   * less than `ttlMs` ago. Past that, a copy with a revision is confirmed with `unchanged`, which
   * restarts its age without storing it again; otherwise the base is fetched, and the index and
   * every partition whose bytes are not the stored ones are stored in one transaction. A fetched
   * base is not decoded before it is stored: `decode` runs per partition, on first use, from the
   * stored bytes, so a partition that cannot be decoded shows as `part()` answering `undefined`,
   * and the next `current()` fetches. Calls share one fetch as long as no `noteWrite()`,
   * `recheck()` or `drop()` comes between them; a call made after one of those is never answered
   * by work begun before it. A failed `fetch`, `unchanged`, `encode` or store rejects and leaves
   * the stored copy as it was.
   * @returns The copy that was served or stored. Read the partitions wanted from it before
   * awaiting anything else.
   */
  current(): Promise<HeldBase<Part>> {
    return this.#flights.run("current", () => this.#load());
  }

  /**
   * The stored copy, whatever its age. Synchronous and read-only in storage, for use inside
   * `transactionSync` and while the provider is unreachable. It never throws for what is
   * stored. It reads the index only: a partition is read when `part` asks, so this does not
   * prove every partition readable. Nothing this class does changes a partition without
   * replacing the index, so a listed partition is missing only if storage was damaged. It does
   * not judge the copy's age. A copy `noteWrite()` was called after is not returned: it lacks a
   * write the provider holds, so nothing may be replayed over it.
   * @returns The copy, or `undefined` when none is stored, it was stored under another
   * `formatVersion`, a write was noted since it was fetched, or a partition of it was asked for
   * and could not be read back.
   */
  held(): HeldBase<Part> | undefined {
    const index = this.#stored();
    return index && !index.stale ? this.#view(index) : undefined;
  }

  /**
   * Records that a write reached the provider. The stored copy lacks it and is served to no one
   * again: `held()` answers `undefined`, a copy handed out earlier serves only the partitions it
   * had decoded, and the next `current()` fetches without asking `unchanged`. The copy's bytes
   * stay stored for that fetch to be compared with, so it stores again only the partitions the
   * write changed, where a fetch after `drop()` stores them all. Work `current()` has in flight
   * began before the write: its answer is neither stored nor served, its callers get the fetch
   * that follows, and a `current()` called after this never joins it. Synchronous.
   */
  noteWrite(): void {
    this.#supersede();
    const index = this.#index();
    if (index !== undefined && !index.stale) this.#putIndex({ ...index, stale: true });
  }

  /**
   * Makes the next `current()` confirm the stored copy with `unchanged` (or fetch) whatever its
   * age. Work `current()` has in flight starts over, and a `current()` called after this never
   * joins it. Synchronous.
   */
  recheck(): void {
    this.#supersede();
    const index = this.#index();
    if (index === undefined) return;
    const { checkedAt, ...unchecked } = index;
    if (checkedAt !== undefined) this.#putIndex(unchecked);
  }

  /**
   * Removes the stored copy, its index and every partition the index lists, in one
   * transaction, so the next fetch is stored whole: for a copy that is wrong or cannot be read,
   * where `noteWrite()` is for one a write outdated. Work `current()` has in flight starts over,
   * and a `current()` called after this never joins it. Synchronous.
   */
  drop(): void {
    this.#supersede();
    // The decoded partitions stay in memory: each is served only for the digest it was decoded
    // from, so a drop that a caller's transaction undoes, and a fetch that brings the same bytes,
    // give the same objects again.
    this.#values.transaction(() => {
      for (const key of this.#listed()) this.#values.delete(this.#partition(key));
      this.#values.delete(this.#name);
    });
  }

  // Makes work in flight worthless to every `current()` called from here on. The epoch alone is
  // not enough: it tells work past an `await` that its answer predates this call, but work that
  // has already answered stays joinable until its release microtask runs, and would hand a call
  // made in that window the copy from before. So the flight is forgotten as well.
  #supersede(): void {
    this.#epoch++;
    this.#flights.forget("current");
  }

  async #load(): Promise<HeldBase<Part>> {
    // Read before anything else and compared after the `await`. Where it moved, this work was
    // superseded and its flight forgotten, so `current()` joins the flight begun since or begins
    // one, and every superseded caller shares that one.
    const epoch = this.#epoch;
    const index = this.#stored();
    if (index !== undefined && !index.stale) {
      const now = this.#now();
      if (index.checkedAt !== undefined && now - index.checkedAt < this.#ttlMs) {
        return this.#view(index);
      }
      if (index.revision !== undefined && this.#unchanged !== undefined) {
        const same = await this.#unchanged(index.revision);
        if (epoch !== this.#epoch) return this.current();
        if (same) {
          // The age restarts from when the question was asked, and only the index is put.
          this.#putIndex({ ...index, checkedAt: now });
          return this.#view(index);
        }
      }
    }
    return this.#keep(await this.#fetch()) ?? this.current();
  }

  /** Fetches the base and encodes it, storing nothing. */
  async #fetch(): Promise<Fetched> {
    const epoch = this.#epoch;
    const fetchedAt = this.#now();
    const { base, revision } = await this.#source();
    const parts = this.#encode(base);
    if (![...parts.keys()].every(wellFormed)) {
      throw new Error("A StoredBase partition key must be well-formed Unicode.");
    }
    const digests = new Map(
      await Promise.all(
        [...parts].map(async ([key, bytes]) => [key, await sha256Hex(bytes)] as const),
      ),
    );
    return { epoch, fetchedAt, ...(revision === undefined ? {} : { revision }), parts, digests };
  }

  /**
   * Stores what `#fetch` returned, in one transaction, or stores nothing and answers `undefined`
   * when a `noteWrite()`, `recheck()` or `drop()` came after the fetch began.
   */
  #keep(fetched: Fetched): HeldBase<Part> | undefined {
    // The epoch is the whole check: `current()` runs one flight at a time and each of those
    // calls moves the epoch, so no fetch is stored behind a later one without it having moved.
    if (fetched.epoch !== this.#epoch) return undefined;
    const { parts, digests } = fetched;
    // The digests of the stored copy. A copy that reads as absent has none, so every partition
    // is put over it.
    const had = new Map(this.#stored()?.partitions.map(({ key, digest }) => [key, digest]));
    const listed = this.#listed();
    const index: Index = {
      version: 2,
      formatVersion: this.#formatVersion,
      stamp: crypto.randomUUID(),
      fetchedAt: fetched.fetchedAt,
      ...(fetched.revision === undefined ? {} : { revision: fetched.revision }),
      partitions: Array.from(digests, ([key, digest]) => ({ key, digest })),
      checkedAt: fetched.fetchedAt,
    };
    // One transaction, the index last, so a reader finds the earlier copy or this one whole.
    this.#values.transaction(() => {
      for (const key of listed) {
        if (!parts.has(key)) this.#values.delete(this.#partition(key));
      }
      for (const [key, bytes] of parts) {
        if (had.get(key) !== digests.get(key)) this.#values.put(this.#partition(key), bytes);
      }
      this.#putIndex(index);
    });
    for (const key of this.#decoded.keys()) {
      if (!parts.has(key)) this.#decoded.delete(key);
    }
    return this.#view(index);
  }

  // The copy `index` names, as a view of storage: it holds the copy's digests and no bytes.
  #view(index: Index): HeldBase<Part> {
    const digests = new Map(index.partitions.map(({ key, digest }) => [key, digest]));
    return {
      keys: [...digests.keys()],
      part: key => this.#part(key, digests.get(key)),
      fetchedAt: index.fetchedAt,
      ...(index.revision === undefined ? {} : { revision: index.revision }),
    };
  }

  // The partition under `key` whose bytes have `digest`, for a copy that lists it so: the
  // decoded object in memory, else the stored bytes decoded, and only while the stored index
  // still lists the key with that digest, so the bytes read are the ones the digest names, and
  // no write was noted since, after which the stored bytes are kept to be compared, not served.
  #part(key: string, digest: string | undefined): Part | undefined {
    if (digest === undefined) return undefined;
    const decoded = this.#decoded.get(key);
    if (decoded?.digest === digest) return decoded.part;
    const index = this.#index();
    if (
      index === undefined || index.formatVersion !== this.#formatVersion || index.stale ||
      !index.partitions.some(entry => entry.key === key && entry.digest === digest)
    ) return undefined;
    let part: Part;
    try {
      const stored = this.#values.get(this.#partition(key));
      if (stored === undefined) throw new Error("The partition is missing or incomplete.");
      part = this.#decode(key, stored.bytes);
    } catch {
      this.#unreadable = index.stamp;
      return undefined;
    }
    this.#decoded.set(key, { digest, part });
    return part;
  }

  // The index of the stored copy, or `undefined` for a copy that reads as absent: none, one of
  // another format version, or one a partition of which could not be read back.
  #stored(): Index | undefined {
    const index = this.#index();
    return index === undefined || index.formatVersion !== this.#formatVersion ||
        index.stamp === this.#unreadable
      ? undefined
      : index;
  }

  // The stored index, of any format version, or `undefined` when the record under the index name
  // is not one this code understands.
  #index(): Index | undefined {
    const meta = this.#values.meta(this.#name);
    return validIndex(meta) ? meta : undefined;
  }

  // The partition keys that whatever record is stored under the index name lists, for cleanup
  // only: the record need not be an index this code understands, and an entry is a key or an
  // object holding one. A key this class could not have stored a partition under is skipped.
  #listed(): string[] {
    const meta = this.#values.meta(this.#name);
    if (!meta || typeof meta !== "object") return [];
    const { partitions } = meta as Record<string, unknown>;
    if (!Array.isArray(partitions)) return [];
    return partitions
      .map((entry: unknown) =>
        entry && typeof entry === "object" ? (entry as Record<string, unknown>).key : entry
      )
      .filter(wellFormed);
  }

  // The name of a partition's value. Neither `:` nor `/` survives `encodeURIComponent`, so the
  // name is one `ChunkedValues` accepts and no two keys share one.
  #partition(key: string): string {
    return `${this.#name}/${encodeURIComponent(key)}`;
  }

  #putIndex(index: Index): void {
    this.#values.put(this.#name, EMPTY, index);
  }
}

/** What `simulatedList` needs of a listing whose rows are entities of a simulation store. */
export type SimulatedListOptions<
  Id extends string,
  Row extends object,
  R extends SimulationRecord<unknown>,
> = {
  /**
   * The store that folds a row: its base and its entity are both the listing's row. Where its
   * reducer reads what only this listing knows (who is asking, the folder listed, names read
   * ahead of the walk), build the store with the listing.
   */
  readonly store: SimulationStore<Id, Row, Row, R, unknown>;
  /**
   * The index of the pending records by the entity each targets, ids resolved. Read each time
   * a row is folded (every `overlay`, every stand-in) and never kept. A gatekeeper whose
   * targets cannot change between two refreshes answers a view it keeps and rebuilds in its
   * own refresh. One whose targets resolve provisional ids that a create applied mid-walk
   * binds answers a view built on the call, so a pending record on a provisional id reaches
   * the provider's row as soon as the id is bound.
   */
  readonly view: () => SimulationView<R, Id>;
  /** The entity a row is. A folded row is the entity its provider row was. */
  readonly id: (row: Row) => Id;
  /** The provider's sort order, as `CursorInjection.compare` takes it. */
  readonly compare: (a: Row, b: Row) => number;
  /**
   * Whether the listing shows a row as folded: the gatekeeper's own filter. Read at serve
   * time, so it may close over state the gatekeeper refreshes. Absent, every row is shown.
   */
  readonly keeps?: (row: Row) => boolean;
  /**
   * The entities pending creates will make that this listing may show, by their provisional
   * ids, oldest first. Read when the hooks are made and at every `refresh()`; the gatekeeper
   * leaves out an id whose create has applied (`ProvisionalIds.isResolved`).
   */
  readonly created?: () => readonly Id[];
};

/** The values a kit cursor takes for a listing with pending changes. */
export type SimulatedList<Row> = {
  /**
   * For `overlay`: a provider row with its pending records folded in, none when a record
   * deleted it or `keeps` no longer holds. A gatekeeper also passes it the provider rows it
   * read itself because a pending change moves them into the listing.
   */
  readonly overlay: (row: Row) => readonly Row[];
  /** For `inject`. The caller adds `authorize` and `identity`, which are its own to decide. */
  readonly inject: {
    /**
     * The stand-ins of the pending creates as the hooks were made: each folded from nothing
     * with the records that target it, kept when `keeps` holds, sorted by `compare`.
     */
    readonly items: readonly Row[];
    /** The caller's `compare`. */
    readonly compare: (a: Row, b: Row) => number;
    /**
     * A stand-in as the last `refresh()` left it, or `null` once its create is no longer
     * pending, a record deleted it or `keeps` no longer holds. `null` for any other row: a
     * gatekeeper that injects rows of its own revalidates those itself.
     */
    readonly revalidate: (row: Row) => Row | null;
  };
  /**
   * Reads the pending creates again, folds their stand-ins again, and forgets the fold of a
   * stand-in whose id left `created`. Call it from the cursor's `refresh`, after whatever the
   * gatekeeper refreshes itself (what `view`, `keeps` and `created` read).
   */
  readonly refresh: () => void;
};

/**
 * The stand-in, per-row fold and hide mechanics of a listing over a simulation store, as the
 * values a kit cursor's `inject`, `overlay` and `refresh` take. It holds no filter, order or
 * paging of its own: `keeps` and `compare` are the gatekeeper's, and so is every decision
 * about which provider rows to read.
 * @param options The store, the index of the pending records, and the listing's own id,
 *   order, filter and pending creates.
 * @returns The frozen hooks.
 *
 * @example
 * ```ts
 * // Built with the listing: the reducer assigns an acknowledged incident to whoever is asking.
 * const store = createSimulationStore<string, Incident, Incident, Queued>({
 *   initial: row => row,
 *   reduce: (incident, { action }) => step(incident, action, me),
 * });
 * // A pending create targets its temporary id until the provider's takes its place.
 * const targets = (action: IncidentAction) => action.kind === "createIncident"
 *   ? ids.isResolved(action.ref) ? [] : [action.ref]
 *   : [ids.resolve(action.incident.id)];
 * const list = simulatedList({
 *   store,
 *   // Built on the call, so a record on a temporary id follows it once it is bound.
 *   view: () => createSimulationView(pending, targets),
 *   id: row => row.id,
 *   compare: newestFirst,
 *   keeps: row => matchesFilter(row, filter),
 *   created: () => pending.flatMap(({ action }) =>
 *     action.kind === "createIncident" && !ids.isResolved(action.ref) ? [action.ref] : []),
 * });
 * return new OffsetCursor<Incident>({
 *   pageSize,
 *   fetchPage,
 *   authorizePage,
 *   overlay: list.overlay,
 *   inject: { ...list.inject, authorize: true, identity: row => ids.resolve(row.id) },
 *   refresh: async () => {
 *     pending = journal.listPending();
 *     list.refresh();
 *   },
 * });
 * ```
 */
export function simulatedList<
  Id extends string,
  Row extends object,
  R extends SimulationRecord<unknown>,
>(options: SimulatedListOptions<Id, Row, R>): SimulatedList<Row> {
  const { store, view, id, compare, keeps, created } = options;

  // A row as its pending records leave it, when the listing shows it.
  const shown = (entity: Id, base: Row | undefined): Row | undefined => {
    const row = store.fold(entity, base, view().forTarget(entity)).entity;
    return row !== undefined && (keeps?.(row) ?? true) ? row : undefined;
  };

  // The pending creates as last read, and the stand-ins of those the listing shows.
  let creates: ReadonlySet<Id> = new Set();
  let standIns = new Map<Id, Row>();
  const refresh = (): void => {
    const now = new Set(created?.() ?? []);
    // The fold of a stand-in has no base to be collected with, so it is dropped by its id.
    for (const gone of creates) if (!now.has(gone)) store.forget(gone);
    creates = now;
    standIns = new Map(
      [...now].flatMap((entity): [Id, Row][] => {
        const row = shown(entity, undefined);
        return row === undefined ? [] : [[entity, row]];
      }),
    );
  };
  refresh();

  return Object.freeze({
    overlay: (row: Row) => {
      const folded = shown(id(row), row);
      return folded === undefined ? [] : [folded];
    },
    inject: Object.freeze({
      items: Object.freeze([...standIns.values()].toSorted(compare)),
      compare,
      revalidate: (row: Row) => standIns.get(id(row)) ?? null,
    }),
    refresh,
  });
}
