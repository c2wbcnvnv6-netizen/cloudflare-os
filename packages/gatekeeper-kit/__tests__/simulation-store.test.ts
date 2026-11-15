import * as fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { PROPERTY_RUN_OPTIONS } from "@gadgets/scripts/property-runs";
import { ChunkedValues } from "../src/chunked-value";
import type { CursorInjection } from "../src/cursors";
import { createSimulationView, ProvisionalIds, type SimulationRecord } from "../src/simulation";
import {
  createSimulationStore,
  simulatedList,
  StoredBase,
  type EntityContext,
  type EntityFold,
  type EntityStep,
  type HeldBase,
  type StoredBaseOptions,
} from "../src/simulation-store";
import { fakeKv, fakeStorage, type FakeStorage } from "./fake-kv";

// The fixture is a gatekeeper whose entities are pages of lines. Its reducer refuses what it
// cannot replay on a page and goes on, and the caller marks the refused records afterwards:
// a marked record carries the reason and is left out of the lists handed to `fold`.
type Action = {
  /** The pages the record changes. One with none targets page `a`. */
  readonly on?: readonly string[];
} & (
  | { kind: "add"; text: string }
  | { kind: "noop" }
  | { kind: "refuse"; why: string; closes?: true }
  | { kind: "needs"; text: string }
  | { kind: "gated"; text: string }
  | { kind: "create" }
  | { kind: "delete" }
  | { kind: "stop"; why: string; over?: number }
);
type Queued = SimulationRecord<Action> & { readonly invalid?: string };
type Base = { readonly seed: readonly string[] };
type Page = { readonly lines: readonly string[] };
/** `closes` is on a refusal after which a `gated` record of the same call is refused. */
type Refusal = { readonly reason: string; readonly closes?: true };
type Context = EntityContext<string, Base, Refusal>;
type Fold = EntityFold<Page, Queued, Refusal>;

const initial = (base: Base): Page => ({ lines: base.seed });
const wrote = (page: Page, text: string): EntityStep<Page, Refusal> =>
  ({ kind: "applied", value: { lines: [...page.lines, text] } });
const declined = (reason: string, closes?: true): EntityStep<Page, Refusal> =>
  ({ kind: "refused", refusal: closes ? { reason, closes } : { reason } });

/**
 * `needs` is applied or refused by the base, as a document's refusals are, and `gated` by the
 * page and by the refusals of the call, as a change to a document's tables is.
 */
function reduce(page: Page | undefined, record: Queued, context: Context): EntityStep<Page, Refusal> {
  const { action } = record;
  switch (action.kind) {
    case "add": return page === undefined ? declined("no page") : wrote(page, action.text);
    case "noop": return { kind: "known-no-effect" };
    case "refuse": return declined(action.why, action.closes);
    case "needs":
      if (page === undefined) return declined("no page");
      return context.base?.seed.includes(action.text)
        ? wrote(page, action.text)
        : declined(`no ${action.text}`);
    case "gated":
      if (page === undefined || page.lines.length % 4 === 3) return declined("no room", true);
      return context.refusals.some(({ closes }) => closes)
        ? declined("gate closed")
        : wrote(page, action.text);
    case "create":
      return page === undefined
        ? { kind: "applied", value: { lines: [`made by ${record.id}`] } }
        : { kind: "known-no-effect" };
    case "delete": return page === undefined ? { kind: "known-no-effect" } : { kind: "deleted" };
    case "stop":
      return action.over === undefined || (page?.lines.length ?? 0) > action.over
        ? { kind: "unsupported", reason: action.why }
        : { kind: "known-no-effect" };
  }
}

/** The oracle: one pass over the records with the reducer itself, through no store. */
function fresh(id: string, base: Base | undefined, records: readonly Queued[]): Fold {
  let entity = base === undefined ? undefined : initial(base);
  const refused: { record: Queued; refusal: Refusal }[] = [];
  for (const record of records) {
    const refusals = refused.map(({ refusal }) => refusal);
    const step = reduce(entity, record, { id, base, refusals });
    if (step.kind === "applied") entity = step.value;
    else if (step.kind === "deleted") entity = undefined;
    else if (step.kind === "refused") refused.push({ record, refusal: step.refusal });
    else if (step.kind === "unsupported") {
      return { entity, refused, stopped: { record, reason: step.reason } };
    }
  }
  return { entity, refused };
}

const targets = (action: Action): readonly string[] => action.on ?? ["a"];
const unmarked = (record: Queued): boolean => record.invalid === undefined;
/** The list with every record of `ids` marked, as a journal hands it back after the marks. */
const marked = (records: readonly Queued[], ids: Iterable<number>): Queued[] => {
  const which = new Set(ids);
  return records.map(record => (which.has(record.id) ? { ...record, invalid: "refused" } : record));
};
const refusedIds = (result: Fold): number[] => result.refused.map(({ record }) => record.id);

const on = (record: Queued, ...pages: string[]): Queued =>
  ({ ...record, action: { ...record.action, on: pages } });
const add = (id: number, text = `line ${id}`): Queued => ({ id, action: { kind: "add", text } });
const noop = (id: number): Queued => ({ id, action: { kind: "noop" } });
const refuse = (id: number, why: string, closes?: true): Queued =>
  ({ id, action: { kind: "refuse", why, ...(closes && { closes }) } });
const needs = (id: number, text: string): Queued => ({ id, action: { kind: "needs", text } });
const gated = (id: number, text = `line ${id}`): Queued =>
  ({ id, action: { kind: "gated", text } });
const create = (id: number): Queued => ({ id, action: { kind: "create" } });
const remove = (id: number): Queued => ({ id, action: { kind: "delete" } });
const stop = (id: number, why: string): Queued => ({ id, action: { kind: "stop", why } });
const clones = (records: readonly Queued[]): Queued[] => records.map(record => ({ ...record }));

/** A store over the fixture that notes what `reduce` and `initial` were called with. */
function counting() {
  const calls: number[] = [];
  const contexts: Context[] = [];
  const initials: Base[] = [];
  const store = createSimulationStore<string, Base, Page, Queued, Refusal>({
    initial: base => {
      initials.push(base);
      return initial(base);
    },
    reduce: (page, record, context) => {
      calls.push(record.id);
      contexts.push({ ...context, refusals: [...context.refusals] });
      return reduce(page, record, context);
    },
  });
  const reset = () => {
    calls.length = 0;
    contexts.length = 0;
    initials.length = 0;
  };
  return { store, calls, contexts, initials, reset };
}

/** A store whose `initial` and reducer run a hook first, as only impure ones would. */
function impure() {
  const calls: number[] = [];
  const hook: { starting?: () => void; during?: (record: Queued) => void } = {};
  const store = createSimulationStore<string, Base, Page, Queued, Refusal>({
    initial: base => {
      hook.starting?.();
      return initial(base);
    },
    reduce: (page, record, context) => {
      calls.push(record.id);
      hook.during?.(record);
      return reduce(page, record, context);
    },
  });
  return { store, calls, hook };
}

// Property: whatever one long-lived store remembers, its fold of an entity equals one pass over
// that entity's records with no memory. fast-check generates three pages (`c` is one the
// provider does not hold, until a base is given for it) and a sequence in which a gatekeeper
// submits records for one page or two, reads any of the pages, marks what its reads refused
// and records they did not, removes refused and live records, replaces a page's base with
// another object, and forgets. A marked record is left out of the list handed to `fold`, and
// neither a mark nor a removal is followed by `forget()`. A record rewritten under its id and an
// id that passes to another record are each followed by `forget()`. A regression shows as a
// read that presents a queue's changes over the wrong page, or without one of them.
const PAGES = ["a", "b", "c"] as const;
type Op =
  | { do: "append"; action: Action }
  | { do: "mark-refused" }
  | { do: "mark"; at: number }
  | { do: "remove"; at: number }
  | { do: "remove-refused" }
  | { do: "rebase"; page: number; seed: readonly string[] | null }
  | { do: "forget" }
  | { do: "forget-id"; page: number }
  | { do: "rewrite"; at: number; action: Action }
  | { do: "resubmit"; action: Action };
/** One thing the gatekeeper does, and the pages it then reads. */
type Step = { op: Op; read: readonly boolean[] };

const alphabet = ["a", "b", "c"];
const letter = fc.constantFrom(...alphabet);
const pages = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...PAGES).map(page => [page]) },
  { weight: 1, arbitrary: fc.shuffledSubarray([...PAGES], { minLength: 2, maxLength: 2 }) },
);
const anyChange: fc.Arbitrary<Action> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("add" as const), text: letter }) },
  { weight: 1, arbitrary: fc.constant({ kind: "noop" as const }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("refuse" as const), why: letter }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("refuse" as const), why: letter, closes: fc.constant(true as const),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("needs" as const), text: letter }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("gated" as const), text: letter }) },
  { weight: 1, arbitrary: fc.constant({ kind: "create" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "delete" as const }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("stop" as const), why: letter, over: fc.constantFrom(2, 4),
    }),
  },
);
const anyAction: fc.Arbitrary<Action> =
  fc.tuple(anyChange, pages).map(([action, where]) => ({ ...action, on: where }));
const anyOp: fc.Arbitrary<Op> = fc.oneof(
  { weight: 8, arbitrary: fc.record({ do: fc.constant("append" as const), action: anyAction }) },
  { weight: 3, arbitrary: fc.constant({ do: "mark-refused" as const }) },
  { weight: 1, arbitrary: fc.record({ do: fc.constant("mark" as const), at: fc.nat() }) },
  { weight: 2, arbitrary: fc.record({ do: fc.constant("remove" as const), at: fc.nat() }) },
  { weight: 1, arbitrary: fc.constant({ do: "remove-refused" as const }) },
  {
    weight: 2,
    arbitrary: fc.record({
      do: fc.constant("rebase" as const),
      page: fc.nat(2),
      seed: fc.option(fc.subarray(alphabet), { freq: 4 }),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ do: "forget" as const }) },
  { weight: 1, arbitrary: fc.record({ do: fc.constant("forget-id" as const), page: fc.nat(2) }) },
  {
    weight: 1,
    arbitrary: fc.record({ do: fc.constant("rewrite" as const), at: fc.nat(), action: anyAction }),
  },
  { weight: 1, arbitrary: fc.record({ do: fc.constant("resubmit" as const), action: anyAction }) },
);
const anyStep: fc.Arbitrary<Step> = fc.record({
  op: anyOp,
  read: fc.tuple(fc.boolean(), fc.boolean(), fc.boolean()),
});

function replay(steps: readonly Step[]): void {
  const bases = new Map<string, Base | undefined>([["a", { seed: ["a"] }], ["b", { seed: [] }]]);
  const store = createSimulationStore<string, Base, Page, Queued, Refusal>({ initial, reduce });
  let list: Queued[] = [];
  // Ids are distinct and increasing, as a journal's are.
  let nextId = 1;
  // What the reads since the last mark or removal of refused records refused.
  let lately = new Set<number>();

  for (const { op, read } of steps) {
    switch (op.do) {
      case "append":
        list = [...list, { id: nextId++, action: op.action }];
        break;
      case "mark-refused":
        list = marked(list, lately);
        lately = new Set();
        break;
      case "mark":
        // A mark no read asked for: of a record a fold applied, as often as not.
        if (list.length > 0) list = marked(list, [list[op.at % list.length].id]);
        break;
      case "remove":
        list = list.filter((_, index) => index !== op.at % list.length);
        break;
      case "remove-refused":
        list = list.filter(({ id }) => !lately.has(id));
        lately = new Set();
        break;
      case "rebase":
        // Another object, whether or not it holds the same: `null` is a page the provider lacks.
        bases.set(PAGES[op.page], op.seed === null ? undefined : { seed: op.seed });
        break;
      case "forget":
        store.forget();
        break;
      case "forget-id":
        store.forget(PAGES[op.page]);
        break;
      case "rewrite":
        // The record's action changes under its id, and any mark goes with it.
        list = list.map((record, index) =>
          index === op.at % list.length ? { id: record.id, action: op.action } : record);
        store.forget();
        break;
      case "resubmit":
        // A submit that rolled back: the journal gives the last id out again, to another record.
        if (list.length > 0) {
          list = [...list.slice(0, -1), { id: list[list.length - 1].id, action: op.action }];
          store.forget();
        }
        break;
    }
    PAGES.forEach((page, index) => {
      if (!read[index]) return;
      const own = list.filter(record => unmarked(record) && targets(record.action).includes(page));
      const result = store.fold(page, bases.get(page), clones(own));
      expect(result).toEqual(fresh(page, bases.get(page), own));
      for (const id of refusedIds(result)) lately.add(id);
    });
  }
}

const doing = (op: Op, ...read: string[]): Step =>
  ({ op, read: PAGES.map(page => read.includes(page)) });
const append = (action: Action, ...read: string[]): Step =>
  doing({ do: "append", action }, ...read);

// Scenarios a seed might miss.
const examples: [Step[]][] = [
  // A record of two pages is refused on one and applied on the other, and is then marked.
  [[
    append({ kind: "needs", text: "a", on: ["a", "b"] }, "a", "b"),
    doing({ do: "mark-refused" }, "a", "b"),
    append({ kind: "add", text: "c", on: ["b"] }, "a", "b"),
  ]],
  // A refusal closes the gate, the record behind it is refused for that, and only the first is
  // marked: the second is presented again and applies.
  [[
    append({ kind: "refuse", why: "a", closes: true }),
    append({ kind: "gated", text: "b" }, "a"),
    doing({ do: "mark", at: 0 }, "a"),
    append({ kind: "add", text: "c" }, "a"),
  ]],
  // A stop is remembered, the record it stopped at is withdrawn, and the queue grows past it.
  [[
    append({ kind: "add", text: "b" }), append({ kind: "stop", why: "c" }),
    append({ kind: "add", text: "c" }, "a"), doing({ do: "remove", at: 1 }, "a"),
    append({ kind: "needs", text: "b" }, "a"), doing({ do: "mark-refused" }, "a"),
  ]],
  // A page the provider lacks is made, deleted and made again, and is then given a base.
  [[
    append({ kind: "create", on: ["c"] }, "c"), append({ kind: "add", text: "a", on: ["c"] }, "c"),
    append({ kind: "delete", on: ["c"] }, "c"), append({ kind: "create", on: ["c"] }, "c"),
    doing({ do: "rebase", page: 2, seed: ["b"] }, "c"), doing({ do: "forget-id", page: 2 }, "c"),
  ]],
];

/** An entity as the whole-queue reference leaves it: what it refused and stopped at, by id. */
type Seen = { entity: Page | undefined; refused: number[]; refusals: Refusal[]; stopped?: number };
/** The reference of the second property: every unmarked record once, for each entity it targets. */
const wholeQueue = (
  bases: ReadonlyMap<string, Base>,
  records: readonly Queued[],
  resolved: (action: Action) => readonly string[],
): Map<string, Seen> => {
  const seen = new Map<string, Seen>();
  for (const [id, base] of bases) {
    seen.set(id, { entity: initial(base), refused: [], refusals: [] });
  }
  for (const record of records) {
    if (!unmarked(record)) continue;
    for (const id of new Set(resolved(record.action))) {
      let state = seen.get(id);
      if (state === undefined) {
        state = { entity: undefined, refused: [], refusals: [] };
        seen.set(id, state);
      }
      if (state.stopped !== undefined) continue;
      const step = reduce(
        state.entity, record, { id, base: bases.get(id), refusals: [...state.refusals] });
      if (step.kind === "applied") state.entity = step.value;
      else if (step.kind === "deleted") state.entity = undefined;
      else if (step.kind === "refused") {
        state.refused.push(record.id);
        state.refusals.push(step.refusal);
      } else if (step.kind === "unsupported") state.stopped = record.id;
    }
  }
  return seen;
};

/** A generator of numbers in [0, 1) that gives the same sequence for the same seed. */
const seeded = (seed: number) => {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
/** The changes a generated record is picked from. */
const changes = (text: string): Action[] => [
  { kind: "create" }, { kind: "delete" },
  { kind: "add", text }, { kind: "add", text }, { kind: "add", text },
  { kind: "gated", text }, { kind: "gated", text },
  { kind: "needs", text: "a" }, { kind: "refuse", why: text, closes: true },
  { kind: "noop" }, { kind: "stop", why: text, over: 3 },
];

describe("createSimulationStore", () => {
  const base: Base = { seed: ["seed"] };

  it("folds like one pass with no memory when nothing is remembered", () => {
    const complete = [add(1), noop(2), refuse(3, "no"), add(4)];
    expect(counting().store.fold("a", base, complete)).toEqual(fresh("a", base, complete));
    expect(fresh("a", base, complete)).toEqual({
      entity: { lines: ["seed", "line 1", "line 4"] },
      refused: [{ record: complete[2], refusal: { reason: "no" } }],
    });

    const stopping = [add(1), stop(2, "cannot"), add(3)];
    expect(counting().store.fold("a", base, stopping)).toEqual(fresh("a", base, stopping));
    expect(fresh("a", base, stopping).stopped).toEqual({ record: stopping[1], reason: "cannot" });
  });

  it("folds nothing for an entity with no base and no record", () => {
    const { store, calls, initials } = counting();

    expect(store.fold("a", undefined, [])).toEqual({ entity: undefined, refused: [] });
    expect(store.fold("a", undefined, [])).not.toHaveProperty("stopped");
    expect(calls).toEqual([]);
    expect(initials).toEqual([]);
  });

  it("gives every reduce call the id, the base and the refusals of the call so far", () => {
    const { store, contexts } = counting();
    store.fold("a", base, [add(1), refuse(2, "first"), noop(3), refuse(4, "second", true), add(5)]);

    expect(contexts).toHaveLength(5);
    for (const context of contexts) {
      expect(context.id).toBe("a");
      expect(context.base).toBe(base);
    }
    expect(contexts.map(({ refusals }) => refusals)).toEqual([
      [],
      [],
      [{ reason: "first" }],
      [{ reason: "first" }],
      [{ reason: "first" }, { reason: "second", closes: true }],
    ]);
  });

  it("reduces only the records added to a remembered fold", () => {
    const { store, calls } = counting();
    store.fold("a", base, [add(1), add(2), add(3)]);
    const list = [add(1), add(2), add(3), add(4)];
    const result = store.fold("a", base, list);

    expect(calls).toEqual([1, 2, 3, 4]);
    expect(result).toEqual(fresh("a", base, list));
    expect(result.entity?.lines).toHaveLength(5);
  });

  it("reduces nothing for the same base and ids", () => {
    const { store, calls, initials } = counting();
    const list = [add(1), noop(2), add(3)];
    const first = store.fold("a", base, list);
    const again = store.fold("a", base, clones(list));

    expect(calls).toEqual([1, 2, 3]);
    expect(initials).toEqual([base]);
    expect(again).toEqual(first);
    expect(again.entity).toBe(first.entity);
    expect(again).toEqual(fresh("a", base, list));
  });

  it.each<[string, Queued[]]>([
    ["a record is removed from the middle", [add(1), add(3), add(4)]],
    ["the first record is removed", [add(2), add(3), add(4)]],
    ["the last record is removed", [add(1), add(2), add(3)]],
    ["the order changes", [add(1), add(3), add(2), add(4)]],
    ["an id is replaced", [add(1), add(2), add(9), add(4)]],
    ["a record is added before the end", [add(1), add(2), add(9), add(3), add(4)]],
  ])("folds from the beginning when %s", (_, list) => {
    const { store, calls, initials, reset } = counting();
    store.fold("a", base, [add(1), add(2), add(3), add(4)]);
    reset();
    const result = store.fold("a", base, list);

    expect(initials).toEqual([base]);
    expect(calls).toEqual(list.map(({ id }) => id));
    expect(result).toEqual(fresh("a", base, list));
  });

  it("never serves one base's fold for another", () => {
    const { store, calls, contexts, initials, reset } = counting();
    const twin: Base = { seed: ["seed"] };
    expect(twin).toEqual(base);
    const list = [add(1), add(2)];
    store.fold("a", base, list);
    reset();
    const result = store.fold("a", twin, list);

    expect(initials).toHaveLength(1);
    expect(initials[0]).toBe(twin);
    expect(calls).toEqual([1, 2]);
    for (const { base: given } of contexts) expect(given).toBe(twin);
    expect(result).toEqual(fresh("a", twin, list));
  });

  it("keeps the folds of two bases of one entity", () => {
    const { store, calls, contexts, initials, reset } = counting();
    const other: Base = { seed: ["other"] };
    store.fold("a", base, [add(1), add(2)]);
    store.fold("a", other, [add(1), add(2)]);
    reset();

    const list = [add(1), add(2), add(3)];
    expect(store.fold("a", base, list)).toEqual(fresh("a", base, list));
    expect(store.fold("a", other, list)).toEqual(fresh("a", other, list));
    expect(initials).toEqual([]);
    expect(calls).toEqual([3, 3]);
    expect(contexts.map(({ base: given }) => given)).toEqual([base, other]);
  });

  it("folds the same base object afresh under another id", () => {
    const { store, calls, contexts, initials, reset } = counting();
    const list = [add(1), add(2)];
    store.fold("a", base, list);
    reset();

    expect(store.fold("b", base, list)).toEqual(fresh("b", base, list));
    expect(initials).toEqual([base]);
    expect(calls).toEqual([1, 2]);
    for (const { id } of contexts) expect(id).toBe("b");
    // One base object holds one fold, the latest: the first entity's went with the second's.
    reset();
    expect(store.fold("a", base, list)).toEqual(fresh("a", base, list));
    expect(calls).toEqual([1, 2]);
  });

  it("goes on past a record with no effect", () => {
    const { store, calls } = counting();
    expect(store.fold("a", base, [add(1), noop(2), add(3)])).toEqual({
      entity: { lines: ["seed", "line 1", "line 3"] },
      refused: [],
    });

    // The record with no effect is covered by what is remembered.
    const longer = [add(1), noop(2), add(3), noop(4), add(5)];
    expect(store.fold("a", base, longer)).toEqual(fresh("a", base, longer));
    expect(calls).toEqual([1, 2, 3, 4, 5]);
  });

  it("makes an entity the provider does not hold from a record that creates it", () => {
    const { store, calls, initials, reset } = counting();
    expect(store.fold("p1", undefined, [add(1), create(2), add(3)])).toEqual({
      entity: { lines: ["made by 2", "line 3"] },
      refused: [{ record: add(1), refusal: { reason: "no page" } }],
    });
    expect(initials).toEqual([]);
    reset();

    // The fold of an entity with no base is remembered by its id. The record refused before
    // the create is left out, and the fold is extended all the same.
    const longer = [create(2), add(3), add(4)];
    expect(store.fold("p1", undefined, longer)).toEqual(fresh("p1", undefined, longer));
    expect(calls).toEqual([4]);
    reset();
    expect(store.fold("p2", undefined, longer)).toEqual(fresh("p2", undefined, longer));
    expect(calls).toEqual([2, 3, 4]);
  });

  it("re-creates an entity after a record deleted it", () => {
    const { store, calls } = counting();
    const deleting = [add(1), remove(2)];
    expect(store.fold("a", base, deleting)).toEqual({ entity: undefined, refused: [] });

    const list = [...deleting, add(3), create(4), add(5)];
    expect(store.fold("a", base, list)).toEqual({
      entity: { lines: ["made by 4", "line 5"] },
      refused: [{ record: list[2], refusal: { reason: "no page" } }],
    });
    expect(calls).toEqual([1, 2, 3, 4, 5]);
  });

  it("stops at the first unsupported record", () => {
    const { store, calls } = counting();
    const list = [add(1), refuse(2, "no"), stop(3, "cannot"), add(4)];
    const result = store.fold("a", base, list);

    expect(result).toEqual({
      entity: { lines: ["seed", "line 1"] },
      refused: [{ record: list[1], refusal: { reason: "no" } }],
      stopped: { record: list[2], reason: "cannot" },
    });
    expect(result.stopped?.record).toBe(list[2]);
    expect(calls).toEqual([1, 2, 3]);
  });

  it("remembers a stop while the record it stopped at is presented", () => {
    const { store, calls, reset } = counting();
    const list = [add(1), stop(2, "cannot"), add(3)];
    const first = store.fold("a", base, list);
    reset();

    const same = clones(list);
    const again = store.fold("a", base, same);
    expect(again).toEqual(first);
    expect(again.stopped?.record).toBe(same[1]);

    const longer = [...clones(list), add(4), stop(5, "later")];
    const extended = store.fold("a", base, longer);
    expect(extended).toEqual(first);
    expect(extended.stopped?.record).toBe(longer[1]);
    expect(calls).toEqual([]);

    // The record the fold stopped at has left the list: the entity is folded from the beginning.
    const without = [add(1), add(3)];
    expect(store.fold("a", base, without)).toEqual(fresh("a", base, without));
    expect(fresh("a", base, without)).not.toHaveProperty("stopped");
    expect(calls).toEqual([1, 3]);

    // A stop reached by extending a remembered fold covers the whole list, not only the records
    // added.
    const grown = counting();
    grown.store.fold("a", base, [add(1)]);
    const stopping = [add(1), add(2), stop(3, "cannot"), add(4)];
    const stopped = grown.store.fold("a", base, stopping);
    expect(stopped).toEqual(fresh("a", base, stopping));
    expect(grown.calls).toEqual([1, 2, 3]);
    grown.reset();

    const repeated = clones(stopping);
    const served = grown.store.fold("a", base, repeated);
    expect(served).toEqual(stopped);
    expect(served.stopped?.record).toBe(repeated[2]);
    expect(grown.calls).toEqual([]);
  });

  it("serves a remembered stop without the records refused before it, once they are left out", () => {
    const { store, calls, reset } = counting();
    const list = [add(1), refuse(2, "no"), stop(3, "cannot"), add(4)];
    expect(refusedIds(store.fold("a", base, list))).toEqual([2]);
    reset();

    const without = [list[0], list[2], list[3]];
    expect(store.fold("a", base, without)).toEqual({
      entity: { lines: ["seed", "line 1"] },
      refused: [],
      stopped: { record: list[2], reason: "cannot" },
    });
    expect(store.fold("a", base, without)).toEqual(fresh("a", base, without));
    expect(calls).toEqual([]);
  });

  it("goes on past a refused record and reports it", () => {
    const { store } = counting();
    const list = [add(1), refuse(2, "not here"), add(3)];
    const result = store.fold("a", base, list);

    expect(result).toEqual({
      entity: { lines: ["seed", "line 1", "line 3"] },
      refused: [{ record: list[1], refusal: { reason: "not here" } }],
    });
    expect(result.refused[0].record).toBe(list[1]);
  });

  it("extends the fold of an entity when a refused record was left out", () => {
    const list = [add(1), refuse(2, "not here"), needs(3, "absent"), add(4)];
    // Left out because the caller marked it, or removed: the store sees the same list.
    for (const leave of [
      (records: Queued[], ids: number[]) => marked(records, ids).filter(unmarked),
      (records: Queued[], ids: number[]) => records.filter(({ id }) => !ids.includes(id)),
    ]) {
      const { store, calls, initials, reset } = counting();
      const refused = refusedIds(store.fold("a", base, list));
      expect(refused).toEqual([2, 3]);
      reset();

      const left = leave(list, refused);
      const again = store.fold("a", base, left);
      expect(again).toEqual(fresh("a", base, left));
      expect(again.refused).toEqual([]);

      const longer = [...left, add(5)];
      expect(store.fold("a", base, longer)).toEqual(fresh("a", base, longer));
      expect(initials).toEqual([]);
      expect(calls).toEqual([5]);
    }

    // One of two refused records left out, the other presented again: folded from the beginning.
    const { store, calls, reset } = counting();
    store.fold("a", base, list);
    reset();
    const one = [list[0], list[2], list[3]];
    expect(store.fold("a", base, one)).toEqual(fresh("a", base, one));
    expect(calls).toEqual([1, 3, 4]);
  });

  it("folds an entity from the beginning when a refused record is presented again", () => {
    const { store, calls, contexts, initials, reset } = counting();
    const list = [add(1), refuse(2, "first", true), noop(3), refuse(4, "second")];
    const first = store.fold("a", base, list);
    reset();

    const longer = [...list, gated(5)];
    const again = store.fold("a", base, longer);
    expect(initials).toEqual([base]);
    expect(calls).toEqual([1, 2, 3, 4, 5]);
    expect(again).toEqual(fresh("a", base, longer));
    expect(again.refused.slice(0, 2)).toEqual(first.refused);
    // The refusals are those of this call, in order, so the gate the first one closes is found
    // closed.
    expect(contexts[4].refusals).toEqual([{ reason: "first", closes: true }, { reason: "second" }]);
    expect(again.refused[2]).toEqual({ record: longer[4], refusal: { reason: "gate closed" } });
  });

  it("folds an entity from the beginning when the last record, refused, is presented again", () => {
    // A read that refuses the newest record, then a read before the caller marked it. The list
    // begins with every remembered id, so only the refused record presented again tells the
    // store to start over.
    const { store, calls, initials, reset } = counting();
    const list = [add(1), refuse(2, "no")];
    const first = store.fold("a", base, list);
    reset();

    const longer = [...list, add(3)];
    const again = store.fold("a", base, longer);
    expect(initials).toEqual([base]);
    expect(calls).toEqual([1, 2, 3]);
    expect(again).toEqual(fresh("a", base, longer));
    expect(again.refused).toEqual(first.refused);
  });

  it("gives a record added after a refused one was left out none of its refusals", () => {
    const { store, calls, contexts, reset } = counting();
    const list = [add(1), refuse(2, "first", true)];
    store.fold("a", base, list);
    reset();

    const longer = [list[0], gated(3)];
    const result = store.fold("a", base, longer);
    expect(calls).toEqual([3]);
    expect(contexts[0].refusals).toEqual([]);
    expect(result).toEqual(fresh("a", base, longer));
    expect(result.entity).toEqual({ lines: ["seed", "line 1", "line 3"] });
  });

  it("folds afresh without a record that was applied and is then left out", () => {
    const { store, calls, initials, reset } = counting();
    const list = [add(1), add(2), add(3)];
    store.fold("a", base, list);
    reset();

    const left = marked(list, [2]).filter(unmarked);
    expect(store.fold("a", base, left)).toEqual(fresh("a", base, left));
    expect(fresh("a", base, left).entity).toEqual({ lines: ["seed", "line 1", "line 3"] });
    expect(initials).toEqual([base]);
    expect(calls).toEqual([1, 3]);
  });

  it("folds only the entity whose record was removed", () => {
    const { store, calls, contexts, reset } = counting();
    const other: Base = { seed: ["other"] };
    const pending = [add(1), on(add(2), "b"), add(3), on(add(4), "b"), on(refuse(5, "no"), "b")];
    const read = (list: readonly Queued[]) => {
      const view = createSimulationView(list, targets);
      return [
        store.fold("a", base, view.forTarget("a")),
        store.fold("b", other, view.forTarget("b")),
      ];
    };
    read(pending);
    expect(calls).toEqual([1, 3, 2, 4, 5]);
    reset();

    // A record of `a` is rejected, and the record `b` refused is removed.
    const left = pending.filter(({ id }) => id !== 1 && id !== 5);
    const [a, b] = read(left);
    expect(a).toEqual(fresh("a", base, [left[1]]));
    expect(b).toEqual(fresh("b", other, [left[0], left[2]]));
    expect(calls).toEqual([3]);
    expect(contexts[0].id).toBe("a");
  });

  it("folds a record that targets several entities for each alone: refused on one, it still " +
    "applies to the other until it is left out", () => {
    const { store, calls, reset } = counting();
    const has: Base = { seed: ["x"] };
    const lacks: Base = { seed: [] };
    const pending = [add(1), on(needs(2, "x"), "a", "b"), on(add(3), "b")];
    const view = createSimulationView(pending, targets);
    expect(view.forTarget("a").map(({ id }) => id)).toEqual([1, 2]);
    expect(view.forTarget("b").map(({ id }) => id)).toEqual([2, 3]);

    const a = store.fold("a", lacks, view.forTarget("a"));
    expect(a).toEqual({
      entity: { lines: ["line 1"] },
      refused: [{ record: pending[1], refusal: { reason: "no x" } }],
    });
    // The other entity's fold knows nothing of that refusal.
    expect(store.fold("b", has, view.forTarget("b"))).toEqual({
      entity: { lines: ["x", "x", "line 3"] },
      refused: [],
    });
    reset();

    // The caller marks what the fold of `a` refused and leaves it out of every list: `a` keeps
    // its fold, and `b` is folded again without the record.
    const left = createSimulationView(marked(pending, refusedIds(a)).filter(unmarked), targets);
    expect(store.fold("a", lacks, left.forTarget("a"))).toEqual(
      { entity: { lines: ["line 1"] }, refused: [] });
    expect(calls).toEqual([]);
    expect(store.fold("b", has, left.forTarget("b"))).toEqual(
      { entity: { lines: ["x", "line 3"] }, refused: [] });
    expect(calls).toEqual([3]);
  });

  it("does not notice a record rewritten to reduce differently until it forgets", () => {
    const { store } = counting();
    const first = store.fold("a", base, [add(1), add(2, "before"), add(3)]);
    const rewritten = [add(1), add(2, "after"), add(3)];
    expect(store.fold("a", base, rewritten)).toEqual(first);
    store.forget();
    expect(store.fold("a", base, rewritten)).toEqual(fresh("a", base, rewritten));
    expect(fresh("a", base, rewritten).entity?.lines).toContain("after");

    // An id given out again: a journal that counts ids in storage does that once the transaction
    // that stored the first record under the id has rolled back.
    const reused = counting();
    const stored = reused.store.fold("a", base, [add(1), add(2), add(3)]);
    const resubmitted = [add(1), add(2), refuse(3, "another record")];
    expect(reused.store.fold("a", base, resubmitted)).toEqual(stored);
    reused.store.forget();
    expect(reused.store.fold("a", base, resubmitted)).toEqual(fresh("a", base, resubmitted));
    expect(refusedIds(fresh("a", base, resubmitted))).toEqual([3]);
  });

  it("forgets every fold, over a base and with none", () => {
    const { store, calls, initials, reset } = counting();
    const list = [add(1), add(2)];
    const made = [create(1), add(2)];
    store.fold("a", base, list);
    store.fold("p1", undefined, made);
    reset();
    store.forget();

    expect(store.fold("a", base, list)).toEqual(fresh("a", base, list));
    expect(initials).toEqual([base]);
    expect(calls).toEqual([1, 2]);
    reset();
    expect(store.fold("p1", undefined, made)).toEqual(fresh("p1", undefined, made));
    expect(calls).toEqual([1, 2]);
  });

  it("forgets, by id, only the fold of that entity made with no base", () => {
    const { store, calls, reset } = counting();
    const made = [create(1), add(2)];
    store.fold("p1", undefined, made);
    store.fold("p2", undefined, made);
    reset();

    // Each entity folded with no base keeps its own fold: the second did not displace the first.
    expect(store.fold("p1", undefined, made)).toEqual(fresh("p1", undefined, made));
    expect(store.fold("p2", undefined, made)).toEqual(fresh("p2", undefined, made));
    expect(calls).toEqual([]);

    store.forget("p1");
    store.fold("p2", undefined, made);
    expect(calls).toEqual([]);
    expect(store.fold("p1", undefined, made)).toEqual(fresh("p1", undefined, made));
    expect(calls).toEqual([1, 2]);
  });

  it("forget(id) leaves the fold of that entity over a base", () => {
    const { store, calls, initials, reset } = counting();
    const list = [add(1), add(2)];
    store.fold("a", base, list);
    reset();
    store.forget("a");

    const longer = [...list, add(3)];
    expect(store.fold("a", base, longer)).toEqual(fresh("a", base, longer));
    expect(initials).toEqual([]);
    expect(calls).toEqual([3]);
  });

  it("does not remember a fold that forget interrupted", () => {
    const list = [add(1), add(2), add(3)];
    const forgetful = impure();
    forgetful.hook.during = record => {
      if (record.id === 2) forgetful.store.forget();
    };
    expect(forgetful.store.fold("a", base, list)).toEqual(fresh("a", base, list));
    forgetful.hook.during = undefined;
    forgetful.calls.length = 0;
    forgetful.store.fold("a", base, list);
    expect(forgetful.calls).toEqual([1, 2, 3]);

    // `initial` runs before any record is reduced, and a `forget()` it makes wins as well.
    const restarting = impure();
    restarting.hook.starting = () => restarting.store.forget();
    expect(restarting.store.fold("a", base, list)).toEqual(fresh("a", base, list));
    restarting.hook.starting = undefined;
    restarting.calls.length = 0;
    restarting.store.fold("a", base, list);
    expect(restarting.calls).toEqual([1, 2, 3]);

    // So does one made while an entity with no base is folded.
    const made = [create(1), add(2)];
    const unbased = impure();
    unbased.hook.during = () => unbased.store.forget();
    expect(unbased.store.fold("p1", undefined, made)).toEqual(fresh("p1", undefined, made));
    unbased.hook.during = undefined;
    unbased.calls.length = 0;
    unbased.store.fold("p1", undefined, made);
    expect(unbased.calls).toEqual([1, 2]);
  });

  it("lets a throw from initial or reduce pass and keeps what it remembered", () => {
    const calls: number[] = [];
    const broken: Base = { seed: ["broken"] };
    const store = createSimulationStore<string, Base, Page, Queued, Refusal>({
      initial: given => {
        if (given === broken) throw new Error("no initial entity");
        return initial(given);
      },
      reduce: (page, record, context) => {
        calls.push(record.id);
        if (record.action.kind === "add" && record.action.text === "boom") throw new Error("boom");
        return reduce(page, record, context);
      },
    });
    store.fold("a", base, [add(1), add(2)]);
    expect(() => store.fold("a", base, [add(1), add(2), add(3, "boom")])).toThrow("boom");
    calls.length = 0;
    const fixed = [add(1), add(2), add(3)];
    expect(store.fold("a", base, fixed)).toEqual(fresh("a", base, fixed));
    expect(calls).toEqual([3]);

    // A base that cannot be folded costs the folds of the others nothing.
    expect(() => store.fold("a", broken, fixed)).toThrow("no initial entity");
    calls.length = 0;
    const longer = [...fixed, add(4)];
    expect(store.fold("a", base, longer)).toEqual(fresh("a", base, longer));
    expect(calls).toEqual([4]);

    // Nor does a throw part way through a fold from the beginning replace what was remembered.
    expect(() => store.fold("a", base, [add(1), add(9, "boom")])).toThrow("boom");
    calls.length = 0;
    expect(store.fold("a", base, [...longer, add(5)]).entity?.lines).toHaveLength(6);
    expect(calls).toEqual([5]);
  });

  it("refuses an applied step that returns the entity it was given", () => {
    const inPlace = createSimulationStore<string, Base, string[], Queued>({
      initial: given => [...given.seed],
      reduce: (lines, record) => {
        lines?.push(`line ${record.id}`);
        return { kind: "applied", value: lines ?? [] };
      },
    });
    expect(() => inPlace.fold("a", base, [add(1)])).toThrow(
      "A simulation reducer returned the entity it was given as applied. Return known-no-effect " +
        "for a record that changes nothing, and a new value otherwise.");

    const unchanged = createSimulationStore<string, Base, Base, Queued>({
      initial: given => given,
      reduce: () => ({ kind: "known-no-effect" }),
    });
    const left = unchanged.fold("a", base, [add(1), add(2)]);
    expect(left).toEqual({ entity: base, refused: [] });
    expect(left.entity).toBe(base);

    const primitive = createSimulationStore<string, Base, number, Queued>({
      initial: () => 0,
      reduce: count => ({ kind: "applied", value: count ?? 0 }),
    });
    expect(primitive.fold("a", base, [add(1), add(2)])).toEqual({ entity: 0, refused: [] });
  });

  it("returns a frozen store", () => {
    expect(Object.isFrozen(counting().store)).toBe(true);
  });

  it("a remembered fold of an entity equals a fresh one", () => {
    fc.assert(
      fc.property(fc.array(anyStep, { maxLength: 40, size: "max" }), replay),
      { ...PROPERTY_RUN_OPTIONS, numRuns: 1000, examples });
  }, 120_000);

  // Property: reading an entity through the view and the store equals one pass over the whole
  // queue. The reference (`wholeQueue`) has no memory and no index: it walks every pending
  // record that is not marked once, in id order, and gives each to every entity it targets.
  // Each seed runs a gatekeeper that submits records for one entity or two (provisional ids
  // among them, bound part way through the queue, when the create that made them leaves it),
  // marks what its reads refused and records they did not, removes records, replaces a base
  // with another object and forgets, and after each step reads some of the entities. A
  // regression shows as an entity read with another entity's change, without one of its own,
  // or with a refusal unreported.
  it("an entity read through the view equals one pass over the whole queue", () => {
    const SEEDS = 600;
    let reads = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const random = seeded(seed);
      const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
      // The provider holds `a`, `b` and `c`. `p1` and `p2` are entities pending creates will
      // make: once a create is applied the provider holds the entity as `x1` or `x2`.
      const ids = new ProvisionalIds<string>(fakeKv(), {
        namespace: "sim:",
        isProvisional: id => id.startsWith("p"),
      });
      const provisional = [ids.allocate(n => `p${n}`), ids.allocate(n => `p${n}`)];
      const resolved = (action: Action): readonly string[] =>
        targets(action).map(id => ids.resolve(id));
      const bases = new Map<string, Base>(
        [["a", { seed: ["a"] }], ["b", { seed: [] }], ["c", { seed: ["a", "b"] }]]);
      const store = createSimulationStore<string, Base, Page, Queued, Refusal>({ initial, reduce });
      let pending: Queued[] = [];
      let nextId = 1;
      let lately = new Set<number>();

      for (let step = 0; step < 40; step++) {
        const roll = random();
        if (roll < 0.45 || pending.length === 0) {
          const first = pick(["a", "b", "c", ...provisional]);
          const where = random() < 0.25 ? [first, pick(["a", "b", "c", provisional[0]])] : [first];
          const id = nextId++;
          pending = [...pending, { id, action: { ...pick(changes(`line ${id}`)), on: where } }];
        } else if (roll < 0.53) {
          pending = marked(pending, lately);
          lately = new Set();
        } else if (roll < 0.6) {
          // A mark no read asked for: of a record a fold applied, as often as not.
          pending = marked(pending, [pick(pending).id]);
        } else if (roll < 0.75) {
          const removed = pick(pending).id;
          pending = pending.filter(({ id }) => id !== removed);
        } else if (roll < 0.85) {
          // Another base object, which holds the same as the earlier one half the time.
          const id = pick(["a", "b", "c"]);
          const held = bases.get(id)?.seed ?? [];
          bases.set(id, { seed: random() < 0.5 ? [...held] : [...held, "b"] });
        } else if (roll < 0.92) {
          // A create is applied: its records leave the queue, the provisional id is bound to the
          // provider's, and the provider holds the entity.
          const made = pick(provisional);
          if (!ids.isResolved(made)) {
            const real = `x${made.slice(1)}`;
            ids.bind(made, real);
            bases.set(real, { seed: ["a"] });
            pending = pending.filter(({ action }) =>
              !(action.kind === "create" && targets(action).includes(made)));
            if (random() < 0.5) store.forget(made);
          }
        } else if (roll < 0.96) {
          store.forget();
        } else {
          store.forget(pick(provisional));
        }

        const view = createSimulationView(pending, resolved);
        const expected = wholeQueue(bases, pending, resolved);
        const entities = new Set([...bases.keys(), ...pending.flatMap(r => resolved(r.action))]);
        for (const id of entities) {
          if (random() >= 0.6) continue;
          const got = store.fold(id, bases.get(id), view.forTarget(id).filter(unmarked));
          const want = expected.get(id) ?? { entity: undefined, refused: [], refusals: [] };
          const where = `seed ${seed}, step ${step}, entity ${id}`;
          expect(got.entity, where).toEqual(want.entity);
          expect(refusedIds(got), where).toEqual(want.refused);
          expect(got.stopped?.record.id, where).toBe(want.stopped);
          for (const refused of refusedIds(got)) lately.add(refused);
          reads++;
        }
      }
    }
    // Enough was compared for the property to mean something.
    expect(reads).toBeGreaterThan(60_000);
  }, 120_000);
});

// The fixture is a document kept one tab per partition. `scratch` is on what the provider
// answers and is not stored, which tells a served copy from a fetched one.
type Tab = { id: string; text: string; scratch?: string };
type Doc = { tabs: Tab[] };
type Answer = { base: Doc; revision?: string };

const TTL = 100;
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const encodeDoc = (doc: Doc): Map<string, Uint8Array> =>
  new Map(doc.tabs.map(({ id, text }) => [id, utf8(JSON.stringify({ id, text }))]));
const decodeTab = (_key: string, bytes: Uint8Array): Tab =>
  JSON.parse(new TextDecoder().decode(bytes)) as Tab;
/** A document as the provider answers it, one tab per text. */
const fetched = (...texts: string[]): Doc =>
  ({ tabs: texts.map((text, index) => ({ id: `t.${index}`, text, scratch: "not stored" })) });
/** The same document as it is stored and served. */
const kept = (...texts: string[]): Doc =>
  ({ tabs: texts.map((text, index) => ({ id: `t.${index}`, text })) });
/** A document of one tab per id, as the provider answers it and as it is stored. */
const named = (...ids: string[]): Doc =>
  ({ tabs: ids.map(id => ({ id, text: `the text of ${id}` })) });

/** Every partition of a copy, joined, or `undefined` when the copy serves one of them no more. */
const whole = (held: HeldBase<Tab> | undefined): Doc | undefined => {
  const tabs = held?.keys.map(key => held.part(key));
  return tabs?.every(tab => tab !== undefined) ? { tabs } : undefined;
};
/** A copy as the tests compare it: its partitions joined, when it was fetched and its revision. */
const seen = (held: HeldBase<Tab> | undefined) =>
  held && {
    base: whole(held),
    fetchedAt: held.fetchedAt,
    ...(held.revision === undefined ? {} : { revision: held.revision }),
  };
/** Whether two copies list the same keys and serve the same object for each, or both are absent. */
const identical = (a: HeldBase<Tab> | undefined, b: HeldBase<Tab> | undefined): boolean =>
  a === undefined || b === undefined
    ? a === b
    : a.keys.join("\n") === b.keys.join("\n") &&
      a.keys.every(key => a.part(key) !== undefined && a.part(key) === b.part(key));

/** One turn of the timer queue, by which every microtask queued so far has run. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
/** Every stored key with its value, to tell whether anything in storage changed. */
const snapshot = ({ kv }: FakeStorage): unknown[] => kv.keys().map(key => [key, kv.get(key)]);

/** What outlives a Durable Object activation (storage, the clock) and the provider's stubs. */
type World = {
  readonly storage: FakeStorage;
  now: number;
  /** How many times the provider was asked for the base. */
  fetches: number;
  /** What the next fetches answer, in order. A fetch with nothing queued rejects. */
  readonly answers: (Answer | Error | Promise<Answer>)[];
  /** The revisions `unchanged` was asked about. */
  readonly asked: string[];
  /** What the next revision checks answer, in order. A check with nothing queued rejects. */
  readonly verdicts: (boolean | Error | Promise<boolean>)[];
};

function world(storage: FakeStorage = fakeStorage()): World {
  return { storage, now: 1_000, fetches: 0, answers: [], asked: [], verdicts: [] };
}

/** A `StoredBase` over the world's storage. A second one over the same world is an eviction. */
function open(w: World, overrides: Partial<StoredBaseOptions<Doc, Tab>> = {}): {
  copy: StoredBase<Doc, Tab>;
  values: ChunkedValues;
} {
  const values = new ChunkedValues(w.storage, { prefix: "copy:", chunkBytes: 8 });
  const copy = new StoredBase<Doc, Tab>({
    values,
    name: "doc",
    formatVersion: 1,
    ttlMs: TTL,
    encode: encodeDoc,
    decode: decodeTab,
    fetch: async () => {
      w.fetches++;
      const next = w.answers.shift() ?? new Error("unexpected fetch");
      if (next instanceof Error) throw next;
      return next;
    },
    unchanged: async revision => {
      w.asked.push(revision);
      const next = w.verdicts.shift() ?? new Error("unexpected revision check");
      if (next instanceof Error) throw next;
      return next;
    },
    now: () => w.now,
    ...overrides,
  });
  return { copy, values };
}

// Storage that refuses a write to any key `rejects` names, as storage out of room would, and a
// delete of any key `keeps` names.
function refusing(
  storage: FakeStorage,
  rejects: (key: string) => boolean,
  keeps: (key: string) => boolean = () => false,
): FakeStorage {
  const { kv } = storage;
  return {
    transactionSync: callback => storage.transactionSync(callback),
    kv: {
      ...kv,
      put: (key, value) => {
        if (rejects(key)) throw new Error("storage refused the write");
        kv.put(key, value);
      },
      delete: key => {
        if (keeps(key)) throw new Error("storage refused the delete");
        kv.delete(key);
      },
    },
  };
}

/** A `ChunkedValues` that lists the names it was asked to put, in order. */
class CountingValues extends ChunkedValues {
  readonly puts: string[] = [];

  override put(name: string, bytes: Uint8Array, meta?: unknown): void {
    this.puts.push(name);
    super.put(name, bytes, meta);
  }
}

/** What a test can make fail in one `StoredBase`. */
type Knobs = {
  encode: (doc: Doc) => Map<string, Uint8Array>;
  refuse: (key: string) => boolean;
};
/** The knobs of a copy nothing fails for. */
const sound = (): Knobs => ({ encode: encodeDoc, refuse: () => false });
/** Queues a changed revision and the base the fetch that follows answers. */
const changed = (w: World, base: Doc = fetched("uno", "a second tab of several chunks")): void => {
  w.verdicts.push(false);
  w.answers.push({ base, revision: "r1" });
};

// An earlier copy for the rows that have one: past `ttlMs` and with no revision, so the next
// `current()` fetches.
const withEarlierCopy = async (w: World, copy: StoredBase<Doc, Tab>) => {
  w.answers.push({ base: fetched("zero") });
  const earlier = await copy.current();
  w.now += TTL;
  return earlier;
};
// Two fetches the test answers when it chooses, so storage can be read between the answers.
const twoFetches = (w: World) => {
  const answers = [Promise.withResolvers<Answer>(), Promise.withResolvers<Answer>()] as const;
  w.answers.push(answers[0].promise, answers[1].promise);
  return answers;
};

describe("StoredBase", () => {
  it("fetches and stores when nothing is held", async () => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: fetched("one"), revision: "r1" });

    expect(copy.held()).toBeUndefined();
    const got = await copy.current();

    expect(w.fetches).toBe(1);
    expect(seen(got)).toEqual({ base: kept("one"), fetchedAt: 1_000, revision: "r1" });
    expect(seen(copy.held())).toEqual(seen(got));
  });

  it("serves what it stored, not what was fetched", async () => {
    const w = world();
    const { copy } = open(w);
    const answer = Promise.withResolvers<Answer>();
    w.answers.push(answer.promise);
    const base = fetched("one");

    const reading = copy.current();
    w.now = 1_050;
    answer.resolve({ base });
    const got = await reading;

    expect(got.keys).toEqual(["t.0"]);
    expect(got.part("t.0")).not.toBe(base.tabs[0]);
    expect(got.part("t.0")).toEqual({ id: "t.0", text: "one" });
    expect(got.part("t.0")).not.toHaveProperty("scratch");
    expect(got.part("t.1")).toBeUndefined();
    expect(got.fetchedAt).toBe(1_000);
    expect(got).not.toHaveProperty("revision");
    expect(seen(copy.held())).toEqual(seen(got));

    // The copy ages from when the fetch began as well, not from when it was answered.
    w.answers.push({ base: fetched("two") });
    w.now = 1_000 + TTL - 1;
    await copy.current();
    expect(w.fetches).toBe(1);
    w.now = 1_000 + TTL;
    await copy.current();
    expect(w.fetches).toBe(2);
  });

  it("stores one value per partition and an index", async () => {
    const w = world();
    const { copy, values } = open(w);
    const ids = ["t.0", "a:b", "a/b", "", "éß中", "\u{1F600}"];
    const tabs = ids.map(id => ({ id, text: `the text of ${id}` }));
    w.answers.push({ base: { tabs } });

    await copy.current();

    for (const tab of tabs) {
      expect(values.get(`doc/${encodeURIComponent(tab.id)}`)).toEqual(
        { bytes: utf8(JSON.stringify(tab)), meta: undefined });
    }
    expect(values.get("doc")?.bytes).toEqual(new Uint8Array(0));
    expect(values.meta("doc")).toMatchObject({ partitions: ids.map(key => ({ key })) });
    expect(whole(copy.held())).toEqual({ tabs });
  });

  it("serves the held copy while it is younger than ttlMs", async () => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: fetched("one"), revision: "r1" });
    const first = await copy.current();

    w.now += TTL - 1;
    const again = await copy.current();

    expect(w.fetches).toBe(1);
    expect(w.asked).toEqual([]);
    expect(identical(again, first)).toBe(true);
    expect(identical(copy.held(), first)).toBe(true);
    expect(identical(await copy.current(), first)).toBe(true);
  });

  it("confirms an old copy by its revision and restarts its age", async () => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: fetched("one", "two"), revision: "r1" });
    const first = await copy.current();
    const written = w.storage.kv.writes.length;
    const verdict = Promise.withResolvers<boolean>();
    w.verdicts.push(verdict.promise);

    w.now = 1_000 + TTL;
    const reading = copy.current();
    // The provider answers later than it was asked.
    w.now += 30;
    verdict.resolve(true);
    const confirmed = await reading;

    expect(w.asked).toEqual(["r1"]);
    expect(w.fetches).toBe(1);
    expect(identical(confirmed, first)).toBe(true);
    expect(confirmed.fetchedAt).toBe(1_000);
    expect(seen(copy.held())).toEqual(seen(first));
    expect(w.storage.kv.writes.slice(written)).toEqual(["copy:doc:manifest"]);

    w.now = 1_000 + TTL + TTL - 1;
    await copy.current();
    expect(w.asked).toEqual(["r1"]);

    w.now = 1_000 + TTL + TTL;
    w.verdicts.push(true);
    await copy.current();
    expect(w.asked).toEqual(["r1", "r1"]);
    expect(w.fetches).toBe(1);
  });

  it("fetches again when the revision changed", async () => {
    const w = world();
    const { copy, values } = open(w);
    w.answers.push({ base: fetched("one", "two"), revision: "r1" });
    const first = await copy.current();

    w.now += TTL;
    w.verdicts.push(false);
    w.answers.push({ base: fetched("uno"), revision: "r2" });
    const second = await copy.current();

    expect(w.asked).toEqual(["r1"]);
    expect(w.fetches).toBe(2);
    expect(identical(second, first)).toBe(false);
    expect(seen(second)).toEqual({ base: kept("uno"), fetchedAt: 1_000 + TTL, revision: "r2" });
    expect(seen(copy.held())).toEqual(seen(second));
    expect(values.get("doc/t.1")).toBeUndefined();
    expect(w.storage.kv.keys().filter(key => key.startsWith("copy:doc/t.1"))).toEqual([]);
    expect(values.meta("doc")).toMatchObject({ partitions: [{ key: "t.0" }] });
  });

  it("fetches an old copy that has no revision", async () => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: fetched("one") }, { base: fetched("uno") });
    await copy.current();

    w.now += TTL;
    const second = await copy.current();

    expect(w.asked).toEqual([]);
    expect(w.fetches).toBe(2);
    expect(whole(second)).toEqual(kept("uno"));
  });

  it("fetches an old copy when unchanged is not given", async () => {
    const w = world();
    const { copy } = open(w, { unchanged: undefined });
    w.answers.push({ base: fetched("one"), revision: "r1" }, { base: fetched("uno"), revision: "r2" });
    await copy.current();

    w.now += TTL;
    const second = await copy.current();

    expect(w.fetches).toBe(2);
    expect(seen(second)).toEqual({ base: kept("uno"), fetchedAt: 1_000 + TTL, revision: "r2" });
  });

  it("shares one fetch between concurrent calls", async () => {
    const w = world();
    const { copy } = open(w);
    const answer = Promise.withResolvers<Answer>();
    w.answers.push(answer.promise);

    const readings = [copy.current(), copy.current()];
    answer.resolve({ base: fetched("one"), revision: "r1" });
    const [first, second] = await Promise.all(readings);

    expect(w.fetches).toBe(1);
    expect(seen(second)).toEqual(seen(first));
    expect(identical(second, first)).toBe(true);
  });

  it.each([
    ["is unchanged", true, 1],
    ["changed", false, 2],
  ])("shares one revision check between concurrent calls when the revision %s", async (_, same, fetches) => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: fetched("one"), revision: "r1" }, { base: fetched("uno"), revision: "r2" });
    const held = await copy.current();
    const verdict = Promise.withResolvers<boolean>();
    w.verdicts.push(verdict.promise);

    w.now += TTL;
    const readings = [copy.current(), copy.current()];
    verdict.resolve(same);
    const [first, second] = await Promise.all(readings);

    expect(w.asked).toEqual(["r1"]);
    expect(w.fetches).toBe(fetches);
    expect(identical(second, first)).toBe(true);
    expect(identical(first, held)).toBe(same);
    expect(whole(first)).toEqual(same ? kept("one") : kept("uno"));
  });

  it.each<[string, (w: World, knobs: Knobs) => void, string]>([
    ["fetch", w => {
      w.verdicts.push(false);
      w.answers.push(new Error("fetch failed"));
    }, "fetch failed"],
    ["unchanged", w => {
      w.verdicts.push(new Error("check failed"));
    }, "check failed"],
    ["encode", (w, knobs) => {
      changed(w);
      knobs.encode = () => {
        throw new Error("encode failed");
      };
    }, "encode failed"],
    ["a partition key that is not well formed", w => {
      changed(w, { tabs: [{ id: "t.0", text: "uno" }, { id: "t\uD800", text: "dos" }] });
    }, "A StoredBase partition key must be well-formed Unicode."],
    ["storage, in the middle of the store", (w, knobs) => {
      changed(w);
      knobs.refuse = key => key === "copy:doc/t.1:chunk:0001";
    }, "storage refused the write"],
    ["storage, at the index that ends the store", (w, knobs) => {
      changed(w);
      knobs.refuse = key => key === "copy:doc:manifest";
    }, "storage refused the write"],
  ])("leaves the stored copy as it was when %s fails", async (_, arm, message) => {
    const knobs = sound();
    const w = world(refusing(fakeStorage(), key => knobs.refuse(key)));
    const { copy } = open(w, { encode: doc => knobs.encode(doc) });
    w.answers.push({ base: fetched("one", "two", "three"), revision: "r0" });
    const earlier = await copy.current();
    const before = snapshot(w.storage);

    w.now += TTL;
    arm(w, knobs);
    const error: unknown = await copy.current().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(URIError);
    expect((error as Error).message).toBe(message);
    const held = copy.held();
    expect(seen(held)).toEqual(seen(earlier));
    expect(identical(held, earlier)).toBe(true);
    expect(snapshot(w.storage)).toEqual(before);

    Object.assign(knobs, sound());
    w.verdicts.push(false);
    w.answers.push({ base: fetched("again"), revision: "r2" });
    expect(seen(await copy.current())).toEqual(
      { base: kept("again"), fetchedAt: 1_000 + TTL, revision: "r2" });
  });

  it.each([
    ["nothing is", false],
    ["an earlier copy is", true],
  ])("neither stores nor serves a fetch in flight when a write lands and %s stored", async (_, has) => {
    const w = world();
    const { kv } = w.storage;
    const { copy } = open(w);
    if (has) await withEarlierCopy(w, copy);
    const began = w.fetches;
    const [a, b] = twoFetches(w);
    let settled = false;
    const mark = (): void => {
      settled = true;
    };

    const first = copy.current();
    void first.then(mark, mark);
    copy.noteWrite();
    const keys = kv.keys();
    const written = kv.writes.length;

    a.resolve({ base: fetched("A"), revision: "ra" });
    // The superseded fetch is encoded and digested before it is refused, and only then does the
    // next one begin.
    await vi.waitFor(() => expect(w.fetches - began).toBe(2));
    await settle();

    expect(kv.keys()).toEqual(keys);
    expect(kv.writes).toHaveLength(written);
    // A copy stored before the write lacks it, so it is held for no one.
    expect(copy.held()).toBeUndefined();
    expect(w.fetches - began).toBe(2);
    expect(settled).toBe(false);

    b.resolve({ base: fetched("B"), revision: "rb" });
    const got = await first;

    expect(whole(got)).toEqual(kept("B"));
    expect(got.revision).toBe("rb");
    expect(seen(copy.held())).toEqual(seen(got));
    expect(identical(copy.held(), got)).toBe(true);
  });

  it("joins a call that a write superseded to the fetch begun after the write", async () => {
    const w = world();
    const { kv } = w.storage;
    const { copy } = open(w);
    const [a, b] = twoFetches(w);

    const first = copy.current();
    copy.noteWrite();
    const second = copy.current();
    expect(w.fetches).toBe(2);
    const keys = kv.keys();
    const written = kv.writes.length;

    a.resolve({ base: fetched("A"), revision: "ra" });
    await settle();

    expect(kv.keys()).toEqual(keys);
    expect(kv.writes).toHaveLength(written);
    expect(copy.held()).toBeUndefined();

    b.resolve({ base: fetched("B"), revision: "rb" });
    const [one, two] = await Promise.all([first, second]);

    expect(w.fetches).toBe(2);
    expect(whole(one)).toEqual(kept("B"));
    expect(identical(two, one)).toBe(true);
  });

  const overtakers = (["in one turn", "in two microtasks"] as const).flatMap(form => [
    { method: "noteWrite", form, same: undefined, how: "noteWrite" },
    { method: "recheck", form, same: false, how: "recheck, the revision changed" },
    { method: "recheck", form, same: true, how: "recheck, the revision unchanged" },
    { method: "drop", form, same: undefined, how: "drop" },
  ] as const);

  it.each(overtakers)(
    "never answers a call made after $how with work begun before it, $form",
    async ({ method, form, same }) => {
      const w = world();
      const { copy } = open(w);
      w.answers.push({ base: fetched("v1"), revision: "r1" }, { base: fetched("v2"), revision: "r2" });
      const v1 = await copy.current();
      if (same !== undefined) w.verdicts.push(same);

      let before: Promise<unknown>;
      let after: Promise<Awaited<ReturnType<typeof copy.current>>>;
      if (form === "in one turn") {
        before = copy.current();
        copy[method]();
        after = copy.current();
      } else {
        // How a read and an apply interleave in a Durable Object.
        const gate = Promise.resolve();
        before = gate.then(() => copy.current());
        after = gate.then(() => {
          copy[method]();
          return copy.current();
        });
      }
      await Promise.allSettled([before, after]);
      const got = await after;

      if (same === true) {
        expect(w.fetches).toBe(1);
        expect(identical(got, v1)).toBe(true);
      } else {
        expect(w.fetches).toBe(2);
        expect(seen(got)).toEqual({ base: kept("v2"), fetchedAt: 1_000, revision: "r2" });
      }
      expect(w.asked).toEqual(method === "recheck" ? ["r1"] : []);
      const held = copy.held();
      expect(seen(held)).toEqual(seen(got));
      expect(identical(held, got)).toBe(true);
    },
  );

  it("does not credit a revision check that a write overtook", async () => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: fetched("v1"), revision: "r1" }, { base: fetched("v2"), revision: "r2" });
    await copy.current();
    const verdict = Promise.withResolvers<boolean>();
    w.verdicts.push(verdict.promise);

    w.now += TTL;
    const reading = copy.current();
    copy.noteWrite();
    verdict.resolve(true);
    const got = await reading;

    expect(w.asked).toEqual(["r1"]);
    expect(w.fetches).toBe(2);
    expect(whole(got)).toEqual(kept("v2"));
    expect(seen(copy.held())).toEqual(seen(got));
  });

  it("fetches after a write without asking for the revision, and holds the copy from before it for no one", async () => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: fetched("v1"), revision: "r1" }, { base: fetched("v2"), revision: "r2" });
    await copy.current();

    copy.noteWrite();

    expect(copy.held()).toBeUndefined();
    // What an eviction finds is the same: the mark is stored.
    expect(open(w).copy.held()).toBeUndefined();

    const v2 = await copy.current();

    expect(w.fetches).toBe(2);
    expect(w.asked).toEqual([]);
    expect(whole(v2)).toEqual(kept("v2"));
    expect(seen(copy.held())).toEqual(seen(v2));
    expect(identical(copy.held(), v2)).toBe(true);

    // The fetched copy is fresh: the write marked the copy it replaced.
    expect(identical(await copy.current(), v2)).toBe(true);
    expect(w.fetches).toBe(2);
    expect(w.asked).toEqual([]);
  });

  it("rechecks on demand whatever the age", async () => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: fetched("v1"), revision: "r1" });
    const v1 = await copy.current();

    copy.recheck();
    w.now += 10;
    w.verdicts.push(true);
    const confirmed = await copy.current();

    expect(w.asked).toEqual(["r1"]);
    expect(w.fetches).toBe(1);
    expect(identical(confirmed, v1)).toBe(true);

    // The age restarted at the check: nothing is asked for another `ttlMs`.
    w.now += TTL - 1;
    await copy.current();
    expect(w.asked).toEqual(["r1"]);
    w.now += 1;
    w.verdicts.push(true);
    await copy.current();
    expect(w.asked).toEqual(["r1", "r1"]);
  });

  it("fetches on a recheck when the copy has no revision", async () => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: fetched("v1") }, { base: fetched("v2") });
    await copy.current();

    copy.recheck();
    const got = await copy.current();

    expect(w.asked).toEqual([]);
    expect(w.fetches).toBe(2);
    expect(whole(got)).toEqual(kept("v2"));
  });

  // An approval and then a rejection with no read between them: the write's mark and the
  // recheck's are kept apart, so the provider's revision is not asked about a copy a write
  // outdated.
  it.each([
    ["a write and then a recheck", ["noteWrite", "recheck"]],
    ["a recheck and then a write", ["recheck", "noteWrite"]],
  ] as const)("fetches without asking for the revision after %s", async (_, calls) => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: fetched("v1"), revision: "r1" }, { base: fetched("v2"), revision: "r2" });
    await copy.current();

    for (const call of calls) copy[call]();
    const got = await open(w).copy.current();

    expect(w.asked).toEqual([]);
    expect(w.fetches).toBe(2);
    expect(whole(got)).toEqual(kept("v2"));
  });

  it("asks again when a recheck comes while a check is in flight", async () => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: fetched("v1"), revision: "r1" });
    const v1 = await copy.current();
    const verdict = Promise.withResolvers<boolean>();
    w.verdicts.push(verdict.promise, true);

    w.now += TTL;
    const reading = copy.current();
    copy.recheck();
    verdict.resolve(true);
    const got = await reading;

    expect(w.asked).toEqual(["r1", "r1"]);
    expect(w.fetches).toBe(1);
    expect(identical(got, v1)).toBe(true);
  });

  it("asks again when a second recheck comes while the check the first asked for is in flight", async () => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: fetched("v1"), revision: "r1" });
    const v1 = await copy.current();
    const verdict = Promise.withResolvers<boolean>();
    w.verdicts.push(verdict.promise, true);

    copy.recheck();
    const reading = copy.current();
    copy.recheck();
    verdict.resolve(true);
    const got = await reading;

    expect(w.asked).toEqual(["r1", "r1"]);
    expect(w.fetches).toBe(1);
    expect(identical(got, v1)).toBe(true);
  });

  it("joins a check that a recheck superseded to the check begun after the recheck", async () => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: fetched("v1"), revision: "r1" });
    const v1 = await copy.current();
    const verdicts = [Promise.withResolvers<boolean>(), Promise.withResolvers<boolean>()] as const;
    w.verdicts.push(verdicts[0].promise, verdicts[1].promise);

    w.now += TTL;
    const first = copy.current();
    copy.recheck();
    const second = copy.current();
    const both = Promise.allSettled([first, second]);

    verdicts[0].resolve(true);
    await settle();

    // The superseded call waits on the check the later call began: it asks nothing itself.
    expect(w.asked).toEqual(["r1", "r1"]);

    verdicts[1].resolve(true);

    expect((await both).map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);
    expect(seen(await first)).toEqual(seen(v1));
    expect(seen(await second)).toEqual(seen(v1));
    expect(identical(await first, v1)).toBe(true);
    expect(identical(await second, v1)).toBe(true);
    expect(w.asked).toEqual(["r1", "r1"]);
    expect(w.fetches).toBe(1);
  });

  it("drops the copy", async () => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: fetched("one", "two"), revision: "r1" }, { base: fetched("uno") });
    await copy.current();

    copy.drop();

    expect(w.storage.kv.keys()).toEqual([]);
    expect(copy.held()).toBeUndefined();
    expect(whole(await copy.current())).toEqual(kept("uno"));
    expect(w.fetches).toBe(2);
  });

  it("removes nothing when storage refuses part of a drop", async () => {
    let keep = false;
    const w = world(refusing(fakeStorage(), () => false, key => keep && key === "copy:doc:manifest"));
    const { copy } = open(w);
    w.answers.push({ base: fetched("one", "two"), revision: "r1" });
    const got = await copy.current();
    const before = snapshot(w.storage);

    keep = true;
    expect(() => copy.drop()).toThrow("storage refused the delete");

    expect(snapshot(w.storage)).toEqual(before);
    expect(seen(open(w).copy.held())).toEqual(seen(got));

    keep = false;
    copy.drop();

    expect(w.storage.kv.keys()).toEqual([]);
  });

  it.each([
    ["nothing is", false],
    ["an earlier copy is", true],
  ])("neither stores nor serves a fetch in flight when the copy is dropped and %s stored", async (_, has) => {
    const w = world();
    const { kv } = w.storage;
    const { copy } = open(w);
    if (has) await withEarlierCopy(w, copy);
    const began = w.fetches;
    const [a, b] = twoFetches(w);
    let settled = false;
    const mark = (): void => {
      settled = true;
    };

    const first = copy.current();
    void first.then(mark, mark);
    copy.drop();
    expect(kv.keys()).toEqual([]);
    const written = kv.writes.length;

    a.resolve({ base: fetched("A"), revision: "ra" });
    // The superseded fetch is encoded and digested before it is refused, and only then does the
    // next one begin.
    await vi.waitFor(() => expect(w.fetches - began).toBe(2));
    await settle();

    expect(copy.held()).toBeUndefined();
    expect(kv.keys()).toEqual([]);
    expect(kv.writes).toHaveLength(written);
    expect(w.fetches - began).toBe(2);
    expect(settled).toBe(false);

    b.resolve({ base: fetched("B"), revision: "rb" });
    const got = await first;

    expect(whole(got)).toEqual(kept("B"));
    expect(seen(copy.held())).toEqual(seen(got));
    expect(identical(copy.held(), got)).toBe(true);
  });

  // A call that finds nothing to mark, or its mark already there, writes nothing and still makes
  // the work in flight worthless.
  it.each([
    ["a second write, the copy already stale", "noteWrite", true],
    ["a recheck with nothing stored", "recheck", false],
  ] as const)("starts a fetch in flight over after %s", async (_, method, stale) => {
    const w = world();
    const { kv } = w.storage;
    const { copy } = open(w);
    if (stale) {
      w.answers.push({ base: fetched("v1"), revision: "r1" });
      await copy.current();
      copy.noteWrite();
    }
    const earlier = copy.held();
    const began = w.fetches;
    const [a, b] = twoFetches(w);

    const first = copy.current();
    const written = kv.writes.length;
    copy[method]();
    expect(kv.writes).toHaveLength(written);

    a.resolve({ base: fetched("A"), revision: "ra" });
    // The superseded fetch is encoded and digested before it is refused, and only then does the
    // next one begin.
    await vi.waitFor(() => expect(w.fetches - began).toBe(2));
    await settle();

    expect(w.fetches - began).toBe(2);
    expect(kv.writes).toHaveLength(written);
    expect(identical(copy.held(), earlier)).toBe(true);

    b.resolve({ base: fetched("B"), revision: "rb" });

    expect(whole(await first)).toEqual(kept("B"));
    expect(w.asked).toEqual([]);
    expect(copy.held()?.revision).toBe("rb");
  });

  it.each(["noteWrite", "recheck", "drop"] as const)(
    "does nothing to storage when nothing is held: %s",
    method => {
      const w = world();
      const { copy } = open(w);

      copy[method]();

      expect(w.storage.kv.keys()).toEqual([]);
      expect(w.storage.kv.writes).toEqual([]);
      expect(copy.held()).toBeUndefined();
    },
  );

  it("reads a copy of another format version as absent, and replaces it whole", async () => {
    const w = world();
    const { kv } = w.storage;
    w.answers.push({ base: fetched("one", "two"), revision: "r1" }, { base: fetched("uno"), revision: "r2" });
    await open(w).copy.current();
    const { copy, values } = open(w, { formatVersion: 2 });

    expect(copy.held()).toBeUndefined();
    const got = await copy.current();

    expect(w.fetches).toBe(2);
    expect(whole(got)).toEqual(kept("uno"));
    expect(seen(copy.held())).toEqual(seen(got));
    expect(values.get("doc/t.1")).toBeUndefined();
    expect(kv.keys().filter(key => key.startsWith("copy:doc/t.1"))).toEqual([]);
    expect(open(w).copy.held()).toBeUndefined();
  });

  it("marks a copy of another format version", async () => {
    const w = world();
    w.answers.push({ base: fetched("v1"), revision: "r1" }, { base: fetched("v2"), revision: "r2" });
    await open(w).copy.current();
    const other = open(w, { formatVersion: 2 }).copy;

    other.recheck();
    w.verdicts.push(true);
    await open(w).copy.current();

    expect(w.asked).toEqual(["r1"]);
    expect(w.fetches).toBe(1);

    other.noteWrite();
    const got = await open(w).copy.current();

    expect(w.asked).toEqual(["r1"]);
    expect(w.fetches).toBe(2);
    expect(whole(got)).toEqual(kept("v2"));
  });

  it.each<[string, (kv: FakeStorage["kv"]) => void]>([
    ["incomplete", kv => kv.delete("copy:doc/t.0:chunk:0001")],
    ["missing", kv => {
      for (const key of kv.keys()) if (key.startsWith("copy:doc/t.0:")) kv.delete(key);
    }],
  ])("answers undefined for a partition that is %s, then fetches", async (_, damage) => {
    const w = world();
    const { kv } = w.storage;
    const warm = open(w).copy;
    const text = "a text of several chunks";
    w.answers.push({ base: fetched(text, "two") }, { base: fetched(text, "two") });
    const got = await warm.current();
    const first = got.part("t.0");
    const keys = kv.keys();

    damage(kv);

    // The instance that decoded the partition does not read it again.
    expect(warm.held()?.part("t.0")).toBe(first);
    // Another reads the index alone until the partition is asked for.
    const cold = open(w).copy;
    const held = cold.held();
    expect(held?.keys).toEqual(["t.0", "t.1"]);
    expect(held?.part("t.1")).toEqual({ id: "t.1", text: "two" });
    expect(cold.held()).toBeDefined();
    expect(held?.part("t.0")).toBeUndefined();
    expect(cold.held()).toBeUndefined();
    expect(w.storage.transactionSync(() => cold.held())).toBeUndefined();

    const repaired = await cold.current();

    expect(w.fetches).toBe(2);
    expect(kv.keys()).toEqual(keys);
    expect(seen(cold.held())).toEqual(seen(repaired));
    expect(whole(repaired)).toEqual(kept(text, "two"));
  });

  it("reads a copy as absent once a partition of it does not decode, and replaces it", async () => {
    const w = world();
    w.answers.push({ base: fetched("unreadable", "two") }, { base: fetched("readable", "two") });
    await open(w).copy.current();
    const { copy } = open(w, {
      decode: (key, bytes) => {
        const tab = decodeTab(key, bytes);
        if (tab.text === "unreadable") throw new Error("cannot decode");
        return tab;
      },
    });

    const held = copy.held();
    expect(held?.part("t.1")).toEqual({ id: "t.1", text: "two" });
    expect(held?.part("t.0")).toBeUndefined();
    expect(copy.held()).toBeUndefined();
    expect(w.storage.transactionSync(() => copy.held())).toBeUndefined();

    const got = await copy.current();

    expect(w.fetches).toBe(2);
    expect(whole(got)).toEqual(kept("readable", "two"));
    expect(seen(copy.held())).toEqual(seen(got));
  });

  it("removes the partitions listed by an index it does not understand", async () => {
    const w = world();
    const { kv } = w.storage;
    const { copy, values } = open(w);
    const foreign = (): void => {
      values.put("doc/old", utf8("left by other code"));
      values.put("doc", new Uint8Array(0), { version: 3, partitions: ["old"] });
    };
    foreign();
    const written = kv.writes.length;

    expect(copy.held()).toBeUndefined();
    copy.noteWrite();
    copy.recheck();
    expect(kv.writes).toHaveLength(written);

    w.answers.push({ base: fetched("one") });
    const got = await copy.current();

    expect(values.get("doc/old")).toBeUndefined();
    expect(seen(copy.held())).toEqual(seen(got));

    copy.drop();
    foreign();
    copy.drop();

    expect(kv.keys()).toEqual([]);
  });

  it("never throws for a stored partition key that is not well formed", async () => {
    const w = world();
    const { kv } = w.storage;
    const { copy, values } = open(w);
    const foreign = (): void => {
      values.put("doc/ok", utf8("left by other code"));
      values.put("doc", new Uint8Array(0), {
        version: 2,
        formatVersion: 1,
        stamp: "a stamp",
        fetchedAt: 1_000,
        checkedAt: 1_000,
        partitions: [{ key: "ok", digest: "00" }, { key: "t\uD800", digest: "00" }],
      });
    };
    foreign();
    const written = kv.writes.length;

    expect(copy.held()).toBeUndefined();
    expect(w.storage.transactionSync(() => copy.held())).toBeUndefined();
    copy.noteWrite();
    copy.recheck();
    expect(kv.writes).toHaveLength(written);

    w.answers.push({ base: fetched("one") });
    const got = await copy.current();

    expect(w.fetches).toBe(1);
    expect(values.get("doc/ok")).toBeUndefined();
    expect(seen(copy.held())).toEqual(seen(got));

    copy.drop();
    foreign();
    copy.drop();

    expect(kv.keys()).toEqual([]);
  });

  it.each<[string, Record<string, unknown>]>([
    ["another version", { version: 3 }],
    ["a stamp that is not a string", { stamp: 3 }],
    ["no stamp", { stamp: undefined }],
    ["a fetchedAt that is not a number", { fetchedAt: "x" }],
    ["a fetchedAt that is not finite", { fetchedAt: Number.NaN }],
    ["a revision that is not a string", { revision: 5 }],
    ["a checkedAt that is not a number", { checkedAt: "x" }],
    ["a checkedAt that is not finite", { checkedAt: Number.POSITIVE_INFINITY }],
    ["a formatVersion that is not a number", { formatVersion: "1" }],
    ["no formatVersion", { formatVersion: undefined }],
  ])("reads a stored record with %s as absent, and replaces it", async (_, change) => {
    const w = world();
    const { kv } = w.storage;
    const { copy: warm, values } = open(w);
    w.answers.push({ base: fetched("one", "two"), revision: "r1" }, { base: fetched("uno"), revision: "r2" });
    await warm.current();
    // The record a fetch stored, its partitions beside it, wrong in this one respect.
    values.put("doc", new Uint8Array(0), { ...(values.meta("doc") as object), ...change });
    const written = kv.writes.length;
    const { copy } = open(w);

    expect(copy.held()).toBeUndefined();
    expect(w.storage.transactionSync(() => copy.held())).toBeUndefined();
    copy.noteWrite();
    copy.recheck();
    expect(kv.writes).toHaveLength(written);

    const got = await copy.current();

    expect(w.fetches).toBe(2);
    expect(seen(got)).toEqual({ base: kept("uno"), fetchedAt: 1_000, revision: "r2" });
    expect(seen(copy.held())).toEqual(seen(got));
    expect(values.get("doc/t.1")).toBeUndefined();
  });

  it.each<[string, unknown]>([
    ["a string", "t.0"],
    ["absent", undefined],
    ["an object with a length", { length: 1 }],
    ["a list of keys without digests", ["t.0"]],
    ["a list of digests without keys", [{ digest: "00" }]],
    ["a list holding nothing to read", [null]],
  ])("never throws for a stored record whose partitions is %s", async (_, partitions) => {
    const w = world();
    const { kv } = w.storage;
    const { copy: warm, values } = open(w);
    w.answers.push({ base: fetched("one"), revision: "r1" }, { base: fetched("uno"), revision: "r2" });
    await warm.current();
    // The record a fetch stored, its partition beside it, listing nothing a reader can walk.
    values.put("doc", new Uint8Array(0), { ...(values.meta("doc") as object), partitions });
    const written = kv.writes.length;
    const { copy } = open(w);

    expect(copy.held()).toBeUndefined();
    expect(w.storage.transactionSync(() => copy.held())).toBeUndefined();
    copy.noteWrite();
    copy.recheck();
    expect(kv.writes).toHaveLength(written);

    const got = await copy.current();

    expect(w.fetches).toBe(2);
    expect(seen(got)).toEqual({ base: kept("uno"), fetchedAt: 1_000, revision: "r2" });
    expect(seen(copy.held())).toEqual(seen(got));

    copy.drop();

    expect(kv.keys()).toEqual([]);
  });

  it.each<[string, unknown]>([
    ["null", null],
    ["a string", "t.0"],
    ["a number", 7],
    ["an array", ["t.0"]],
  ])("never throws for a stored record that is %s", async (_, meta) => {
    const w = world();
    const { kv } = w.storage;
    const { copy, values } = open(w);
    w.answers.push({ base: fetched("uno"), revision: "r2" });
    // A record under the index name that is no object with fields to read.
    const foreign = (): void => values.put("doc", new Uint8Array(0), meta);
    foreign();
    const written = kv.writes.length;

    expect(copy.held()).toBeUndefined();
    expect(w.storage.transactionSync(() => copy.held())).toBeUndefined();
    copy.noteWrite();
    copy.recheck();
    expect(kv.writes).toHaveLength(written);

    const got = await copy.current();

    expect(w.fetches).toBe(1);
    expect(seen(got)).toEqual({ base: kept("uno"), fetchedAt: 1_000, revision: "r2" });
    expect(seen(copy.held())).toEqual(seen(got));

    copy.drop();
    foreign();
    copy.drop();

    expect(kv.keys()).toEqual([]);
  });

  it("works after an eviction", async () => {
    const w = world();
    w.answers.push({ base: fetched("v1"), revision: "r1" });
    const got = await open(w).copy.current();

    const second = open(w).copy;
    const held = second.held();
    expect(seen(held)).toEqual(seen(got));
    expect(identical(held, got)).toBe(false);
    w.now += TTL - 1;
    expect(seen(await second.current())).toEqual(seen(got));
    expect(w.fetches).toBe(1);
    expect(w.asked).toEqual([]);

    second.recheck();
    const third = open(w).copy;
    w.verdicts.push(true);
    expect(seen(await third.current())).toEqual(seen(got));
    expect(w.asked).toEqual(["r1"]);
    expect(w.fetches).toBe(1);

    third.noteWrite();
    const fourth = open(w).copy;
    w.answers.push({ base: fetched("v2"), revision: "r2" });
    expect(whole(await fourth.current())).toEqual(kept("v2"));
    expect(w.asked).toEqual(["r1"]);
    expect(w.fetches).toBe(2);
  });

  it("decodes again once another instance replaced the stored copy", async () => {
    const w = world();
    const first = open(w).copy;
    const second = open(w).copy;
    w.answers.push({ base: fetched("v1"), revision: "r1" }, { base: fetched("v2"), revision: "r2" });
    const v1 = await first.current();

    second.noteWrite();
    const v2 = await second.current();

    const held = first.held();
    expect(seen(held)).toEqual(seen(v2));
    expect(identical(held, v1)).toBe(false);
    expect(identical(first.held(), held)).toBe(true);
  });

  it("reads and marks inside a transaction, and is undone with it", async () => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: fetched("v1"), revision: "r1" });
    const got = await copy.current();

    expect(() => w.storage.transactionSync(() => {
      expect(seen(copy.held())).toEqual(seen(got));
      copy.recheck();
      throw new Error("undone");
    })).toThrow("undone");

    expect(identical(await copy.current(), got)).toBe(true);
    expect(w.asked).toEqual([]);
    expect(w.fetches).toBe(1);

    expect(() => w.storage.transactionSync(() => {
      copy.drop();
      expect(copy.held()).toBeUndefined();
      throw new Error("undone");
    })).toThrow("undone");

    expect(seen(copy.held())).toEqual(seen(got));
    expect(identical(copy.held(), got)).toBe(true);
  });

  it("keeps two bases on one store apart", async () => {
    const w = world();
    const first = open(w).copy;
    const second = open(w, { name: "doc-2" }).copy;
    w.answers.push({ base: fetched("first") }, { base: fetched("second") });
    const one = await first.current();
    const two = await second.current();

    expect(seen(first.held())).toEqual(seen(one));
    expect(seen(second.held())).toEqual(seen(two));

    first.drop();

    expect(first.held()).toBeUndefined();
    expect(seen(second.held())).toEqual(seen(two));
    expect(seen(open(w, { name: "doc-2" }).copy.held())).toEqual(seen(two));
    expect(w.storage.kv.keys().every(key => key.startsWith("copy:doc-2"))).toBe(true);

    second.drop();

    expect(w.storage.kv.keys()).toEqual([]);
  });

  it("lists the partitions in the order encode gave them", async () => {
    const w = world();
    const tabs = [{ id: "b", text: "second by key" }, { id: "a", text: "first by key" }];
    w.answers.push({ base: { tabs } });
    const warm = await open(w).copy.current();
    const given: string[] = [];
    const cold = open(w, {
      decode: (key, bytes) => {
        given.push(key);
        return decodeTab(key, bytes);
      },
    }).copy;

    const held = cold.held();

    expect(warm.keys).toEqual(["b", "a"]);
    expect(held?.keys).toEqual(["b", "a"]);
    expect(given).toEqual([]);
    expect(whole(held)).toEqual({ tabs });
    expect(given).toEqual(["b", "a"]);
    expect(identical(await cold.current(), held)).toBe(true);
    expect(w.fetches).toBe(1);
  });

  it("decodes only the partition that is read", async () => {
    const w = world();
    w.answers.push({ base: fetched("one", "two", "three"), revision: "r1" });
    await open(w).copy.current();
    const decoded: string[] = [];
    const { copy } = open(w, {
      decode: (key, bytes) => {
        decoded.push(key);
        return decodeTab(key, bytes);
      },
    });

    const held = copy.held();

    expect(held?.keys).toEqual(["t.0", "t.1", "t.2"]);
    expect(decoded).toEqual([]);
    expect(held?.part("t.1")).toEqual({ id: "t.1", text: "two" });
    expect((await copy.current()).part("t.1")).toBe(held?.part("t.1"));
    expect(decoded).toEqual(["t.1"]);
    expect(w.fetches).toBe(1);
  });

  it("gives the same object for a partition a refetch brought unchanged", async () => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: fetched("one", "two") }, { base: fetched("one", "dos") });
    const first = await copy.current();
    const [one, two] = [first.part("t.0"), first.part("t.1")];

    w.now += TTL;
    const second = await copy.current();

    expect(w.fetches).toBe(2);
    expect(second.part("t.0")).toBe(one);
    expect(second.part("t.1")).not.toBe(two);
    expect(second.part("t.1")).toEqual({ id: "t.1", text: "dos" });
    expect(copy.held()?.part("t.0")).toBe(one);
  });

  it("does not rewrite a partition a fetch returned unchanged", async () => {
    const w = world();
    const values = new CountingValues(w.storage, { prefix: "copy:", chunkBytes: 8 });
    const { copy } = open(w, { values });
    w.answers.push(
      { base: fetched("one", "two", "three"), revision: "r1" },
      { base: fetched("one", "dos", "three"), revision: "r2" },
    );
    await copy.current();
    expect(values.puts).toEqual(["doc/t.0", "doc/t.1", "doc/t.2", "doc"]);

    values.puts.length = 0;
    w.now += TTL;
    w.verdicts.push(false);
    const got = await copy.current();

    expect(values.puts).toEqual(["doc/t.1", "doc"]);
    expect(seen(got)).toEqual(
      { base: kept("one", "dos", "three"), fetchedAt: 1_000 + TTL, revision: "r2" });
    // What an eviction finds is the later copy whole: two partitions left alone and one put.
    expect(seen(open(w).copy.held())).toEqual(seen(got));
  });

  it("stores again only the partitions a noted write changed, and serves none of the copy from before it", async () => {
    const w = world();
    const values = new CountingValues(w.storage, { prefix: "copy:", chunkBytes: 8 });
    const { copy } = open(w, { values });
    w.answers.push(
      { base: fetched("one", "two", "three"), revision: "r1" },
      { base: fetched("one", "dos", "three"), revision: "r2" },
    );
    const before = await copy.current();
    const one = before.part("t.0");
    values.puts.length = 0;

    copy.noteWrite();

    // Only the index is put, and the copy from before the write serves what it had decoded.
    expect(values.puts).toEqual(["doc"]);
    expect(copy.held()).toBeUndefined();
    expect(before.part("t.0")).toBe(one);
    expect(before.part("t.1")).toBeUndefined();
    expect(before.part("t.2")).toBeUndefined();

    values.puts.length = 0;
    const got = await copy.current();

    expect(w.asked).toEqual([]);
    expect(values.puts).toEqual(["doc/t.1", "doc"]);
    expect(seen(got)).toEqual({ base: kept("one", "dos", "three"), fetchedAt: 1_000, revision: "r2" });
    // A partition the write left alone keeps its decoded object.
    expect(got.part("t.0")).toBe(one);
    expect(seen(open(w).copy.held())).toEqual(seen(got));
  });

  it("rewrites every partition after one could not be read back", async () => {
    const w = world();
    const values = new CountingValues(w.storage, { prefix: "copy:", chunkBytes: 8 });
    const { copy } = open(w, { values });
    w.answers.push({ base: fetched("one", "two") }, { base: fetched("one", "two") });
    await copy.current();
    values.delete("doc/t.1");
    values.puts.length = 0;

    expect(copy.held()?.part("t.1")).toBeUndefined();
    const got = await copy.current();

    expect(w.fetches).toBe(2);
    expect(values.puts).toEqual(["doc/t.0", "doc/t.1", "doc"]);
    expect(whole(got)).toEqual(kept("one", "two"));
  });

  it("keeps the same objects across a drop and a fetch of the same bytes", async () => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: fetched("one", "two") }, { base: fetched("one", "two") });
    const first = await copy.current();
    const [one, two] = [first.part("t.0"), first.part("t.1")];

    copy.drop();
    const second = await copy.current();

    expect(w.fetches).toBe(2);
    expect(second.part("t.0")).toBe(one);
    expect(second.part("t.1")).toBe(two);
  });

  it.each(["noteWrite", "recheck", "drop"] as const)(
    "stores nothing of a fetch a %s() came after",
    async method => {
      const w = world();
      const { copy } = open(w);
      await withEarlierCopy(w, copy);
      const began = w.fetches;
      const [a, b] = twoFetches(w);

      const reading = copy.current();
      copy[method]();
      const left = snapshot(w.storage);
      a.resolve({ base: fetched("A"), revision: "ra" });
      await vi.waitFor(() => expect(w.fetches - began).toBe(2));
      await settle();

      expect(snapshot(w.storage)).toEqual(left);

      b.resolve({ base: fetched("B"), revision: "rb" });

      expect(seen(await reading)).toEqual(
        { base: kept("B"), fetchedAt: 1_000 + TTL, revision: "rb" });
      expect(w.fetches - began).toBe(2);
    },
  );

  it("forgets the decoded partition of a key a later copy does not list", async () => {
    const w = world();
    const decoded: string[] = [];
    const { copy } = open(w, {
      decode: (key, bytes) => {
        decoded.push(key);
        return decodeTab(key, bytes);
      },
    });
    w.answers.push({ base: named("a", "b") }, { base: named("a") }, { base: named("a", "b") });
    const first = await copy.current();
    const [a, b] = [first.part("a"), first.part("b")];

    w.now += TTL;
    await copy.current();
    w.now += TTL;
    const third = await copy.current();

    expect(third.part("a")).toBe(a);
    expect(third.part("b")).toEqual(b);
    expect(third.part("b")).not.toBe(b);
    expect(decoded).toEqual(["a", "b", "b"]);
  });

  it("a copy held across a later keep never serves the later copy's bytes", async () => {
    const w = world();
    const { copy } = open(w);
    w.answers.push(
      { base: fetched("one", "two") },
      { base: fetched("uno", "two") },
      { base: fetched("one", "two") },
    );
    // Held with neither partition decoded.
    const first = await copy.current();

    w.now += TTL;
    const second = await copy.current();

    expect(first.part("t.0")).toBeUndefined();
    expect(copy.held()).toBeDefined();
    expect(first.part("t.1")).toEqual({ id: "t.1", text: "two" });
    expect(second.part("t.0")).toEqual({ id: "t.0", text: "uno" });
    expect(second.part("t.1")).toBe(first.part("t.1"));
    expect(copy.held()).toBeDefined();

    // The first bytes of the partition come back, and are decoded as what they are.
    w.now += TTL;
    const third = await copy.current();

    expect(third.part("t.0")).toEqual({ id: "t.0", text: "one" });
    expect(first.part("t.0")).toBe(third.part("t.0"));
    expect(second.part("t.0")).toBeUndefined();
    expect(copy.held()).toBeDefined();
    expect(w.fetches).toBe(3);
  });

  it("a copy held across a drop serves nothing it had not decoded, and what it had", async () => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: fetched("one", "two") });
    const got = await copy.current();
    const one = got.part("t.0");

    copy.drop();

    expect(got.keys).toEqual(["t.0", "t.1"]);
    expect(got.part("t.0")).toBe(one);
    expect(got.part("t.1")).toBeUndefined();
    expect(copy.held()).toBeUndefined();
    expect(w.storage.kv.keys()).toEqual([]);
  });

  it("reads a copy stored under the earlier index layout as absent, and removes its partitions at the next keep", async () => {
    const w = world();
    const { kv } = w.storage;
    const { copy, values } = open(w);
    values.put("doc/t.0", utf8(JSON.stringify({ id: "t.0", text: "one" })));
    values.put("doc/gone", utf8(JSON.stringify({ id: "gone", text: "left behind" })));
    values.put("doc", new Uint8Array(0), {
      version: 1,
      formatVersion: 1,
      stamp: "a stamp",
      fetchedAt: 900,
      checkedAt: 900,
      partitions: ["t.0", "gone"],
    });
    const written = kv.writes.length;

    expect(copy.held()).toBeUndefined();
    copy.noteWrite();
    copy.recheck();
    expect(kv.writes).toHaveLength(written);

    w.answers.push({ base: fetched("one") });
    const got = await copy.current();

    expect(w.fetches).toBe(1);
    expect(seen(got)).toEqual({ base: kept("one"), fetchedAt: 1_000 });
    // The partition whose bytes the earlier layout already held is put all the same.
    expect(kv.writes.slice(written)).toContain("copy:doc/t.0:manifest");
    expect(kv.keys().filter(key => key.startsWith("copy:doc/gone"))).toEqual([]);
    expect(values.meta("doc")).toMatchObject({ version: 2, partitions: [{ key: "t.0" }] });
  });

  it("refuses a name outside letters, digits, _ and -, a formatVersion that is not an integer, and a ttlMs that is not a positive integer", () => {
    const w = world();

    for (const name of ["", "a/b", "a:b", "a b", "a.b", "é"]) {
      expect(() => open(w, { name })).toThrow(
        `A StoredBase name must be letters, digits, "_" or "-", got ${JSON.stringify(name)}.`);
    }
    expect(() => open(w, { name: "Doc_2-b" })).not.toThrow();

    for (const formatVersion of [Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => open(w, { formatVersion })).toThrow(
        `formatVersion must be a safe integer, got ${formatVersion}.`);
    }
    for (const formatVersion of [0, 1]) expect(() => open(w, { formatVersion })).not.toThrow();

    for (const ttlMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => open(w, { ttlMs })).toThrow(
        `ttlMs must be a positive safe integer, got ${ttlMs}.`);
    }
  });

  it("gives a simulation store the same partition until a fetch changes its bytes", async () => {
    const w = world();
    const { copy } = open(w);
    w.answers.push(
      { base: fetched("v1", "other"), revision: "r1" },
      { base: fetched("v1", "changed"), revision: "r2" },
      { base: fetched("v2", "changed"), revision: "r3" },
    );
    let reduced = 0;
    const store = createSimulationStore<"t.0", Tab, number, SimulationRecord<string>>({
      initial: () => 0,
      reduce: (count = 0) => {
        reduced++;
        return { kind: "applied", value: count + 1 };
      },
    });
    const pending = [{ id: 1, action: "edit" }];
    const fold = async (): Promise<void> => {
      store.fold("t.0", (await copy.current()).part("t.0"), pending);
    };

    await fold();
    await fold();
    expect(reduced).toBe(1);

    w.now += TTL;
    w.verdicts.push(true);
    await fold();
    expect(w.asked).toEqual(["r1"]);
    expect(reduced).toBe(1);

    // A fetch that changed another partition leaves this one's fold remembered.
    w.now += TTL;
    w.verdicts.push(false);
    await fold();
    expect(w.fetches).toBe(2);
    expect(reduced).toBe(1);

    w.now += TTL;
    w.verdicts.push(false);
    await fold();
    expect(w.fetches).toBe(3);
    expect(reduced).toBe(2);
  });
});

// The fixture is a listing of tasks, newest first, that leaves finished tasks out. A pending
// `open` makes a task under a temporary id, which later records may name.
type Task = {
  readonly id: string;
  readonly at: number;
  readonly title: string;
  readonly done?: true;
};
type Change =
  | { kind: "open"; ref: string; title: string; at: number }
  | { kind: "retitle"; tasks: readonly string[]; title: string }
  | { kind: "finish"; task: string }
  | { kind: "discard"; task: string };
type Staged = SimulationRecord<Change>;

const task = (id: string, at: number, title = `task ${id}`): Task => ({ id, at, title });
const opens = (id: number, ref: string, at: number, title = `task ${ref}`): Staged =>
  ({ id, action: { kind: "open", ref, title, at } });
const retitles = (id: number, title: string, ...tasks: string[]): Staged =>
  ({ id, action: { kind: "retitle", tasks, title } });
const finishes = (id: number, target: string): Staged =>
  ({ id, action: { kind: "finish", task: target } });
const discards = (id: number, target: string): Staged =>
  ({ id, action: { kind: "discard", task: target } });

const taskIds = (action: Change): readonly string[] =>
  action.kind === "open" ? [action.ref] : action.kind === "retitle" ? action.tasks : [action.task];
const newestFirst = (a: Task, b: Task): number => b.at - a.at;
const unfinished = (row: Task): boolean => !row.done;

/**
 * A listing over a `journal` the test changes as a gatekeeper's would change: the view is built
 * on each call from `journal.staged`, and `journal.created` is read as it then is.
 */
function listing(staged: Staged[], created: string[] = []) {
  const journal = { staged, created };
  const reduced: number[] = [];
  let views = 0;
  const store = createSimulationStore<string, Task, Task, Staged>({
    initial: row => row,
    reduce: (row, { id, action }) => {
      reduced.push(id);
      if (action.kind === "open") {
        return row === undefined
          ? { kind: "applied", value: task(action.ref, action.at, action.title) }
          : { kind: "known-no-effect" };
      }
      if (row === undefined) return { kind: "known-no-effect" };
      if (action.kind === "discard") return { kind: "deleted" };
      return {
        kind: "applied",
        value: action.kind === "finish" ? { ...row, done: true } : { ...row, title: action.title },
      };
    },
  });
  const list = simulatedList({
    store,
    view: () => {
      views++;
      return createSimulationView(journal.staged, taskIds);
    },
    id: row => row.id,
    compare: newestFirst,
    keeps: unfinished,
    created: () => journal.created,
  });
  return { journal, store, list, reduced, views: () => views };
}

describe("simulatedList", () => {
  it("folds a provider row and drops one its records delete or the listing no longer keeps", () => {
    const { list } = listing([retitles(1, "renamed", "a"), discards(2, "b"), finishes(3, "c")]);
    const untouched = task("d", 4);

    expect(list.overlay(task("a", 1))).toEqual([task("a", 1, "renamed")]);
    expect(list.overlay(task("b", 2))).toEqual([]);
    expect(list.overlay(task("c", 3))).toEqual([]);
    // A row no record targets is served as the provider gave it.
    expect(list.overlay(untouched)[0]).toBe(untouched);
    expect(Object.isFrozen(list)).toBe(true);
    expect(Object.isFrozen(list.inject)).toBe(true);
    expect(Object.isFrozen(list.inject.items)).toBe(true);
  });

  it("shows every row when the listing has no filter", () => {
    const store = createSimulationStore<string, Task, Task, Staged>({
      initial: row => row,
      reduce: row => ({ kind: "applied", value: { ...row!, done: true } }),
    });
    const list = simulatedList({
      store,
      view: () => createSimulationView([finishes(1, "a")], taskIds),
      id: row => row.id,
      compare: newestFirst,
    });

    expect(list.overlay(task("a", 1))).toEqual([{ ...task("a", 1), done: true }]);
    expect(list.inject.items).toEqual([]);
  });

  it("lists a stand-in for a pending create, with the later records on it folded in", () => {
    const { list } = listing([opens(1, "~1", 5, "draft"), retitles(2, "final", "~1")], ["~1"]);

    expect(list.inject.items).toEqual([task("~1", 5, "final")]);
    expect(list.inject.revalidate(list.inject.items[0])).toEqual(task("~1", 5, "final"));
  });

  it("sorts the stand-ins with the caller's compare", () => {
    const staged = [opens(1, "~1", 5), opens(2, "~2", 9), opens(3, "~3", 7)];
    const { list } = listing(staged, ["~1", "~2", "~3"]);

    expect(list.inject.items.map(({ id }) => id)).toEqual(["~2", "~3", "~1"]);
    expect(list.inject.compare).toBe(newestFirst);
  });

  it("revalidates a stand-in to null once its create is no longer pending", () => {
    const { journal, list } = listing([opens(1, "~1", 5)], ["~1"]);
    const [standIn] = list.inject.items;

    // The create applied: its record left the queue, and its id the pending creates.
    journal.staged = [];
    journal.created = [];
    // A stand-in is what the last refresh left.
    expect(list.inject.revalidate(standIn)).toEqual(task("~1", 5));
    list.refresh();
    expect(list.inject.revalidate(standIn)).toBeNull();
  });

  it("revalidates a stand-in to null once a later record deletes it", () => {
    const { journal, list } = listing([opens(1, "~1", 5)], ["~1"]);
    const [standIn] = list.inject.items;

    journal.staged = [...journal.staged, discards(2, "~1")];
    list.refresh();
    expect(list.inject.revalidate(standIn)).toBeNull();
  });

  it("revalidates a stand-in to null once the listing no longer keeps it", () => {
    const { journal, list } = listing([opens(1, "~1", 5)], ["~1"]);
    const [standIn] = list.inject.items;

    journal.staged = [...journal.staged, finishes(2, "~1")];
    list.refresh();
    expect(list.inject.revalidate(standIn)).toBeNull();
  });

  it("revalidates a stand-in as the records staged since leave it", () => {
    const { journal, list } = listing([opens(1, "~1", 5)], ["~1"]);
    const [standIn] = list.inject.items;

    journal.staged = [...journal.staged, retitles(2, "renamed", "~1")];
    list.refresh();
    expect(list.inject.revalidate(standIn)).toEqual(task("~1", 5, "renamed"));
    // What a cursor read when it was built stays as it was.
    expect(list.inject.items).toEqual([task("~1", 5)]);
  });

  it("revalidates any row that is not a stand-in to null", () => {
    const { list } = listing([opens(1, "~1", 5), retitles(2, "renamed", "a")], ["~1"]);

    expect(list.inject.revalidate(task("a", 1))).toBeNull();
    expect(list.inject.revalidate(task("b", 2))).toBeNull();
  });

  it("forgets the fold of a stand-in whose create is no longer pending", () => {
    const first = [opens(1, "~1", 5), retitles(2, "final", "~1", "a")];
    const { journal, store, list, reduced } = listing([...first, opens(3, "~2", 7)], ["~1", "~2"]);
    const provided = task("a", 1);
    expect(list.overlay(provided)).toEqual([task("a", 1, "final")]);
    // The two stand-ins, then the provider's row.
    expect(reduced).toEqual([1, 2, 3, 2]);

    // While the creates are pending, the stand-ins' folds are remembered.
    list.refresh();
    expect(reduced).toEqual([1, 2, 3, 2]);

    // One create leaves. The other stand-in and the provider's row are served from memory.
    journal.created = ["~2"];
    list.refresh();
    expect(list.inject.revalidate(task("~2", 7))).toEqual(task("~2", 7));
    expect(list.overlay(provided)).toEqual([task("a", 1, "final")]);
    expect(reduced).toEqual([1, 2, 3, 2]);

    // The one that left is folded from the beginning.
    expect(store.fold("~1", undefined, first).entity).toEqual(task("~1", 5, "final"));
    expect(reduced).toEqual([1, 2, 3, 2, 1, 2]);
  });

  it("gives a cursor's inject its items, compare and revalidate", () => {
    const { list } = listing([opens(1, "~1", 5)], ["~1"]);
    const inject: Pick<CursorInjection<Task>, "items" | "compare" | "revalidate"> = list.inject;
    const complete: CursorInjection<Task> = { ...list.inject, authorize: true, identity: row => row.id };

    expect(inject.items).toEqual([task("~1", 5)]);
    expect(complete.revalidate?.(inject.items[0])).toEqual(task("~1", 5));
  });

  it("reads the view at every fold, and the pending creates only at refresh", () => {
    const { journal, list, views } = listing([opens(1, "~1", 5)], ["~1"]);
    // One fold made the stand-in.
    expect(views()).toBe(1);

    // A view that answers other records is seen by the next fold, with no refresh.
    journal.staged = [...journal.staged, retitles(2, "renamed", "a")];
    expect(list.overlay(task("a", 1))).toEqual([task("a", 1, "renamed")]);
    expect(list.overlay(task("b", 2))).toEqual([task("b", 2)]);
    expect(views()).toBe(3);

    // A create staged since is listed once the gatekeeper refreshes.
    journal.staged = [...journal.staged, opens(3, "~2", 8)];
    journal.created = ["~1", "~2"];
    expect(list.inject.revalidate(task("~2", 8))).toBeNull();
    expect(views()).toBe(3);
    list.refresh();
    expect(list.inject.revalidate(task("~2", 8))).toEqual(task("~2", 8));
    // One fold for each stand-in.
    expect(views()).toBe(5);
  });

  it("folds a record that targets several rows into each", () => {
    const staged = [opens(1, "~1", 5), retitles(2, "shared", "a", "b", "~1")];
    const { list } = listing(staged, ["~1"]);

    expect(list.overlay(task("a", 1))).toEqual([task("a", 1, "shared")]);
    expect(list.overlay(task("b", 2))).toEqual([task("b", 2, "shared")]);
    expect(list.overlay(task("c", 3))).toEqual([task("c", 3)]);
    expect(list.inject.items).toEqual([task("~1", 5, "shared")]);
  });
});
