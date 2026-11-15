/** A remembered fold of pending actions over one entity at a time. */

import type { SimulationRecord, SimulationStep } from "./simulation";

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
