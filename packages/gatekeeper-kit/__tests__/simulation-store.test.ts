import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PROPERTY_RUN_OPTIONS } from "@gadgets/scripts/property-runs";
import { createSimulationView, ProvisionalIds, type SimulationRecord } from "../src/simulation";
import {
  createSimulationStore,
  type EntityContext,
  type EntityFold,
  type EntityStep,
} from "../src/simulation-store";
import { fakeKv } from "./fake-kv";

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
