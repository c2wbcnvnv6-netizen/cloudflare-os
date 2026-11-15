import { ActionApplyError } from "@gadgets/gatekeeper-kit/actions";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import type { RpcStub } from "cloudflare:workers";
import {
  assertGoogleDocDisplaySize, describeDocEdit, DOC_DEFINITIONS, forgetGoogleDocTab,
  googleDocSnapshot, replayGoogleDoc, replayGoogleDocActions, REPLAY_CONTEXT, type DocHost,
  type GoogleDocAction, type GoogleDocPendingAction, type GoogleDocReplay,
  type GoogleDocReplayQueue,
} from "../../src/doc-actions";
import { driveDocSource, GoogleDocSessionImpl, type DocChangeQueue } from "../../src/docs";
import {
  blankDocsTab, type GoogleDocsApi, type GoogleDocsDocument, type GoogleDocsTab,
} from "../../src/docs-api";
import { replayCost } from "../../src/docs-model";
import { renderTab } from "../../src/docs-replay";
import { pruneTab, type DocCopy } from "../../src/docs-replica";
import type { DriveApi } from "../../src/drive-api";
import { MARKDOWN_RENDERING_VERSION } from "../../src/markdown-converter";
import {
  buildTab, cardField, grid, item, NUMBERED_LIST, para, type BlockSpec,
} from "../doc-fixture";

type Append = Parameters<typeof DOC_DEFINITIONS.appendText.describe>[0];
type Replace = Parameters<typeof DOC_DEFINITIONS.replaceText.describe>[0];
type AddTab = Parameters<typeof DOC_DEFINITIONS.addTab.describe>[0];

const BASE = {
  tabId: "tab-1", submittedAt: 0, markdownVersion: MARKDOWN_RENDERING_VERSION, writeId: "w-1",
};
const APPEND: Append = { ...BASE, type: "appendText", markdown: "More", display: { tab: "\"Main\" (tab-1)" } };

/** A host over one document whose Docs API is a stub; `landed` and `unapplyable` are recorded. */
function host(document: GoogleDocsDocument, receipt?: { actionId: number; markerId: string }) {
  let api = {
    getDocument: vi.fn(async () => document),
    deleteNamedRange: vi.fn(async () => {}),
    batchUpdate: vi.fn(async () => ({ writeMarkerId: "marker-new", replies: [] })),
  };
  let landed = vi.fn<DocHost["landed"]>();
  let unapplyable = vi.fn<DocHost["unapplyable"]>(async () => {});
  let docHost: DocHost = {
    api: api as unknown as DocHost["api"],
    documentId: "doc-1",
    mimeType: async () => "application/vnd.google-apps.document",
    receipt: () => receipt,
    clearReceipt: () => {},
    saved: () => {},
    landed,
    unapplyable,
  };
  return { api, landed, unapplyable, docHost };
}

function document(text: string): GoogleDocsDocument {
  return {
    documentId: "doc-1", title: "Plan", revisionId: "r1",
    tabs: [{ ...buildTab([{ runs: [`${text}\n`] }]), title: "Main" }],
  };
}

describe("Google Doc edit definitions", () => {
  it("declares text edits and new tabs under their two kinds, applied without a claim", () => {
    for (let [name, definition] of Object.entries(DOC_DEFINITIONS)) {
      expect(definition.kind.tag, name).toBe(name === "addTab" ? "addDocumentTab" : "editDocument");
      expect(definition.autoApprovable, name).toBe(true);
      expect(definition.delivery, name).toBe("continue-with-simulation");
      // A retried approval settles from the write's own marker instead.
      expect(definition.claimBeforeApply, name).toBeUndefined();
    }
  });

  it("builds each card from the stored edit and its display fields", () => {
    expect(DOC_DEFINITIONS.appendText.describe(APPEND, undefined as never)).toMatchObject({
      title: "Append to Google Doc",
      description: "Append content to the end of tab \"Main\" (tab-1).",
      fields: [{ label: "Content", value: "More" }],
    });

    // Only what differs from the stored text is recorded for the card.
    let replace: Replace = {
      ...BASE, type: "replaceText", oldMarkdown: "a", newMarkdown: "*b*",
      display: { tab: "\"Main\" (tab-1)", rendered: "_b_" },
    };
    expect(DOC_DEFINITIONS.replaceText.describe(replace, undefined as never)).toMatchObject({
      title: "Edit Google Doc",
      description: "Replace text in tab \"Main\" (tab-1).",
      fields: [
        { label: "Old", value: "a" }, { label: "Requested New", value: "*b*" },
        { label: "New", value: "_b_" },
      ],
    });

    let add: AddTab = {
      submittedAt: 0, writeId: "w-2", type: "addTab", provisionalTabId: "pending-tab-1", title: "Notes",
      display: { placement: "Add a new, empty tab at the top level, after the tabs already there." },
    };
    expect(DOC_DEFINITIONS.addTab.describe(add, undefined as never)).toMatchObject({
      title: "Add tab to Google Doc",
      description: "Add a new, empty tab at the top level, after the tabs already there.",
      fields: [{ label: "Title", value: "Notes" }],
    });

    // A record stored before cards were built from records is never described again.
    expect(() => DOC_DEFINITIONS.appendText.describe({ ...APPEND, display: undefined }, undefined as never))
      .toThrow("This Google Doc edit has no card to show.");
  });

  it("builds a replacement's card around the text named, and a cell's as the table's HTML", () => {
    // The card's old and requested texts are the edit's own between the context stored with it.
    let widened: Replace = {
      ...BASE, type: "replaceText", oldMarkdown: "b", newMarkdown: "b\n\nplain",
      display: {
        tab: "\"Main\" (tab-1)", context: { before: "", after: "\n1. c" },
        rendered: "b\n\nplain\n\n3. c",
      },
    };
    expect(describeDocEdit(widened).fields).toEqual([
      cardField("Old", "b\n1. c", "markdown"),
      cardField("Requested New", "b\n\nplain\n1. c", "markdown"),
      cardField("New", "b\n\nplain\n\n3. c", "markdown"),
    ]);

    // With no rendering stored, a read returns the requested text, context included.
    let { rendered: _, ...context } = widened.display!;
    expect(describeDocEdit({ ...widened, display: context })
      .fields).toEqual([
        cardField("Old", "b\n1. c", "markdown"),
        cardField("New", "b\n\nplain\n1. c", "markdown"),
      ]);

    let cell: Replace = {
      ...BASE, type: "replaceText", oldMarkdown: "alpha", newMarkdown: "A & B", inTable: true,
      display: { tab: "x", prose: "Replace text in a table.", rendered: "A &amp; B" },
    };
    expect(DOC_DEFINITIONS.replaceText.describe(cell, undefined as never)).toMatchObject({
      title: "Edit Google Doc",
      description: "Replace text in a table.",
      fields: [
        cardField("Old", "alpha", "html"), cardField("Requested New", "A & B", "html"),
        cardField("New", "A &amp; B", "html"),
      ],
    });
  });

  it("shows on an append's card the rendering stored with it, or the canonical form", () => {
    let stored: Append = { ...APPEND, markdown: "\nplain", display: { tab: "x", rendered: "\n\nplain" } };
    expect(describeDocEdit(stored).fields).toEqual([
      cardField("Requested", "\nplain", "markdown"), cardField("Resulting", "\n\nplain", "markdown"),
    ]);
    // A record stored with no rendering reads as the canonical form of its text.
    let escaped: Append = { ...APPEND, markdown: String.raw`\# title`, display: { tab: "x" } };
    expect(describeDocEdit(escaped).fields).toEqual([
      cardField("Requested", String.raw`\# title`, "markdown"),
      cardField("Resulting", "# title", "markdown"),
    ]);
  });

  it("holds what a card shows beyond the edit to the bytes the edit's own texts are held to", () => {
    const MIB = 1024 * 1024;
    let rendered = "r".repeat(MIB - 20);
    let context = { before: "b".repeat(10), after: "a".repeat(10) };
    expect(() => assertGoogleDocDisplaySize("replaceText", { tab: "x", rendered, context }))
      .not.toThrow();
    // The tab's label is the card's own and is not counted.
    expect(() => assertGoogleDocDisplaySize("replaceText", { tab: "x".repeat(2 * MIB) })).not.toThrow();
    expect(() => assertGoogleDocDisplaySize(
      "replaceText", { tab: "x", rendered, context: { ...context, after: "a".repeat(11) } },
    )).toThrow(
      "replaceText: what this edit's approval card would show exceeds the 1048576-byte safe " +
      "submission limit. Split the edit into smaller ones.");
    // Bytes, not characters: a character of two bytes counts twice.
    expect(() => assertGoogleDocDisplaySize("appendText", { tab: "x", rendered: "é".repeat(MIB / 2) }))
      .not.toThrow();
    expect(() => assertGoogleDocDisplaySize("appendText", { tab: "x", rendered: "é".repeat(MIB / 2) + "a" }))
      .toThrow(/^appendText: what this edit's approval card would show exceeds/);
  });

  it("writes an edit once, with a marker, and reports where it landed", async () => {
    let { api, landed, docHost } = host(document("Draft"));
    await DOC_DEFINITIONS.appendText.apply(APPEND, docHost, { id: 4 });
    expect(api.batchUpdate).toHaveBeenCalledTimes(1);
    expect(api.batchUpdate.mock.calls[0]).toMatchObject(
      ["doc-1", expect.any(Array), "r1", { name: "gadgets-write-w-1", tabId: "tab-1" }]);
    expect(landed).toHaveBeenCalledWith(4, { id: "marker-new", tabId: "tab-1" }, undefined);
  });

  // A connection whose record outlives its receipt, as a Drive binding's does until the kit
  // retires it, can be approved again in between: it must not clean up its own marker first.
  it("settles from a receipt that names the edit, without cleaning up or writing", async () => {
    let { api, landed, docHost } = host(document("Draft"), { actionId: 4, markerId: "marker-old" });
    await DOC_DEFINITIONS.appendText.apply(APPEND, docHost, { id: 4 });
    expect(api.deleteNamedRange).not.toHaveBeenCalled();
    expect(api.batchUpdate).not.toHaveBeenCalled();
    expect(landed).toHaveBeenCalledWith(4, undefined);
  });

  it("fails for good an edit that no longer applies, recording why first", async () => {
    let { api, unapplyable, docHost } = host(document("Draft"));
    let replace: Replace = {
      ...BASE, type: "replaceText", oldMarkdown: "Gone", newMarkdown: "New", display: { tab: "x" },
    };
    let applied = DOC_DEFINITIONS.replaceText.apply(replace, docHost, { id: 2 });
    await expect(applied).rejects.toBeInstanceOf(ActionApplyError);
    await expect(applied).rejects.toThrow("oldMarkdown was not found");
    expect(unapplyable).toHaveBeenCalledWith(
      2, replace, expect.stringMatching(/^Pending Google Doc edit could not be applied: /));
    expect(api.batchUpdate).not.toHaveBeenCalled();
  });
});

/** A queue over `pending` that marks a refused record as a bound Doc's store does. */
function queueOf(pending: GoogleDocPendingAction[]): GoogleDocReplayQueue {
  return {
    pending: () => pending,
    invalidate: (record, reason) => { record.action.invalidatedReason = reason; },
    cache: { writes: 0 },
  };
}

/** The add of a tab titled "Notes" under `provisionalTabId`, placed by `placement`. */
function add(provisionalTabId: string, placement: { parentTabId?: string; index?: number }): AddTab {
  return {
    submittedAt: 0, writeId: `w-${provisionalTabId}`, type: "addTab", provisionalTabId,
    title: "Notes", ...placement,
  };
}

/** An append of `markdown` to tab `tabId`. */
function appendTo(tabId: string, markdown: string): Append {
  return { ...APPEND, tabId, markdown };
}

/** A replacement in tab `tabId` of text no fixture holds, which a replay refuses. */
function goneIn(tabId: string): Replace {
  return {
    ...BASE, tabId, type: "replaceText", oldMarkdown: "Gone", newMarkdown: "Back",
    display: { tab: `"Main" (${tabId})` },
  };
}

/** `action` naming no tab, as a record stored before tabs could be named. */
function unnamed<T extends { tabId?: string }>(action: T): T {
  let { tabId: _, ...rest } = action;
  return rest as T;
}

/** The reason a replay stores with an edit it dropped for `refusal`. */
const dropped = (refusal: string) =>
  `${REPLAY_CONTEXT}: ${refusal} This edit was dropped from the document. ` +
  "Reject it and retry if it is still needed.";

const EARLIER_FORMAT =
  "Pending Google Doc edit was queued under an earlier Markdown format and may no longer " +
  "apply as previewed. Reject it and retry.";
const PREDATES_TABS =
  "Pending Google Doc edit predates tab support and the document has gained tabs since, so " +
  "the tab it was approved against is unknown. Reject it and retry on a selected tab.";

/** A document of the tabs `contents` lists, `tab-1` onwards, at the top level. */
function documentOf(...contents: BlockSpec[][]): GoogleDocsDocument {
  return {
    documentId: "doc-1", title: "Plan", revisionId: "r1",
    tabs: contents.map((blocks, index) => ({
      ...buildTab(blocks), tabId: `tab-${index + 1}`, title: `Tab ${index + 1}`, index,
    })),
  };
}

/** How a queue invalidates: in the record in hand (a bound Doc), or by removing it (Drive). */
type Invalidator = "marks the record" | "removes the record";
const INVALIDATORS: Invalidator[] = ["marks the record", "removes the record"];

/**
 * A queue over `pending` with the reasons it was given, by record. One that removes leaves the
 * record in hand as it was, and both throw for a record invalidated twice, as a journal does
 * for one that is gone.
 */
function countedQueue(
  pending: GoogleDocPendingAction[], invalidator: Invalidator = "marks the record",
) {
  let list = [...pending];
  let reasons = new Map<number, string>();
  let queue: GoogleDocReplayQueue = {
    pending: () => [...list],
    invalidate(record, reason) {
      if (reasons.has(record.id)) throw new Error(`Edit ${record.id} was invalidated twice`);
      reasons.set(record.id, reason);
      if (invalidator === "marks the record") record.action.invalidatedReason = reason;
      else list = list.filter(({ id }) => id !== record.id);
    },
    cache: { writes: 0 },
  };
  return {
    queue, reasons,
    /** The ids still listed. */
    listed: () => list.map(({ id }) => id),
    /** Removes records from outside the replay, as an approval or a rejection does. */
    remove: (...ids: number[]) => { list = list.filter(({ id }) => !ids.includes(id)); },
    push: (record: GoogleDocPendingAction) => { list.push(record); },
  };
}

/** What `run` adds to the reducer steps and the queue reads counted. */
function spending<T>(run: () => T): { value: T; folds: number; queueReads: number } {
  let before = { ...replayCost };
  let value = run();
  return {
    value, folds: replayCost.folds - before.folds,
    queueReads: replayCost.queueReads - before.queueReads,
  };
}

/** `copy` with its tab reads counted. */
function watched(copy: DocCopy) {
  let read: string[] = [];
  let watching: DocCopy = { outline: copy.outline, tab: tabId => (read.push(tabId), copy.tab(tabId)) };
  return { copy: watching, read };
}
describe("a Doc's pending actions replayed on a copy of it", () => {
  it("puts a queued tab where Google will, under its provisional ID, and replays edits into it", () => {
    let { copy } = googleDocSnapshot(document("Draft"));
    let pending = [
      { id: 1, action: add("pending-tab-a", { index: 0 }) },
      { id: 2, action: appendTo("pending-tab-a", "First words") },
      { id: 3, action: add("pending-tab-b", { parentTabId: "pending-tab-a" }) },
    ];
    let replay = replayGoogleDoc(queueOf(pending), copy, REPLAY_CONTEXT);

    // The document's order, the new tab before the tab it displaced and its child after it.
    expect(replay.outline.map(({ tabId, index, nestingLevel, parentTabId }) =>
      ({ tabId, index, nestingLevel, parentTabId }))).toEqual([
      { tabId: "pending-tab-a", index: 0, nestingLevel: 0, parentTabId: undefined },
      { tabId: "pending-tab-b", index: 0, nestingLevel: 1, parentTabId: "pending-tab-a" },
      { tabId: "tab-1", index: 1, nestingLevel: 0, parentTabId: undefined },
    ]);
    expect(renderTab(replay.tab("pending-tab-a")!).markdown).toBe("First words\n");
    expect(renderTab(replay.tab("tab-1")!).markdown).toBe("Draft\n");
    expect(pending.map(({ action }) => action.invalidatedReason)).toEqual([undefined, undefined, undefined]);
    // The copy is never changed: its one tab stays where it was fetched.
    expect(copy.outline.map(({ tabId, index }) => ({ tabId, index }))).toEqual([{ tabId: "tab-1", index: 0 }]);
  });

  it("refuses an add whose parent is gone, and the edit queued for its tab with it", () => {
    let { copy } = googleDocSnapshot(document("Draft"));
    let pending = [
      { id: 1, action: add("pending-tab-a", { parentTabId: "gone" }) },
      { id: 2, action: appendTo("pending-tab-a", "First words") },
      { id: 3, action: appendTo("tab-1", "More") },
    ];
    let replay = replayGoogleDoc(queueOf(pending), copy, REPLAY_CONTEXT);

    // Both are refused by the replay itself, before any tab is asked for.
    expect(pending[0].action.invalidatedReason).toBe(
      `${REPLAY_CONTEXT}: addTab: no tab with ID "gone" exists in this document. Call listTabs() ` +
      "to refresh the tab list. This edit was dropped from the document. Reject it and retry if " +
      "it is still needed.");
    expect(pending[1].action.invalidatedReason).toContain(
      `${REPLAY_CONTEXT}: appendText: no tab with ID "pending-tab-a" exists in this document.`);
    expect(replay.outline.map(({ tabId }) => tabId)).toEqual(["tab-1"]);
    expect(renderTab(replay.tab("tab-1")!).markdown).toBe("Draft\n\nMore\n");
    expect(pending[2].action.invalidatedReason).toBeUndefined();
  });

  it("keeps replaying an add whose write marker the copy holds, and skips such an edit", () => {
    let marked = document("Draft");
    marked.tabs[0].namedRanges = Object.fromEntries(["w-pending-tab-a", "w-1"].map(writeId => [
      `gadgets-write-${writeId}`,
      { namedRanges: [{ namedRangeId: `marker-${writeId}`, name: `gadgets-write-${writeId}` }] },
    ]));
    let { copy } = googleDocSnapshot(marked);
    let pending = [
      // Only its approval can tell the add's reply was lost, so it stays a tab of the replay.
      { id: 1, action: add("pending-tab-a", {}) },
      // The tab already holds this append, which a replay would show twice.
      { id: 2, action: appendTo("tab-1", "Draft") },
      { id: 3, action: { ...appendTo("tab-1", "More"), writeId: "w-3" } },
    ];
    let replay = replayGoogleDoc(queueOf(pending), copy, REPLAY_CONTEXT);

    expect(replay.outline.map(({ tabId }) => tabId)).toEqual(["tab-1", "pending-tab-a"]);
    expect(renderTab(replay.tab("tab-1")!).markdown).toBe("Draft\n\nMore\n");
    expect(replay.tab("pending-tab-a")).toEqual(pruneTab(blankDocsTab("pending-tab-a", "Notes")));
    expect(pending.map(({ action }) => action.invalidatedReason)).toEqual([undefined, undefined, undefined]);
  });

  it("counts one read of the queue for a replay, whatever it drops", () => {
    let { copy } = googleDocSnapshot(document("Draft"));
    /** What replaying `actions` over the copy, every tab read, adds to the counts. */
    let spent = (...actions: GoogleDocAction[]) => {
      let pending = actions.map((action, index) => ({ id: index + 1, action }));
      let before = { ...replayCost };
      let replay = replayGoogleDoc(queueOf(pending), copy, REPLAY_CONTEXT);
      for (let { tabId } of replay.outline) replay.tab(tabId);
      return {
        queueReads: replayCost.queueReads - before.queueReads,
        folds: replayCost.folds - before.folds,
        dropped: pending.filter(({ action }) => action.invalidatedReason).map(({ id }) => id),
      };
    };

    expect(spent(appendTo("tab-1", "More"), appendTo("tab-1", "Again")))
      .toEqual({ queueReads: 1, folds: 2, dropped: [] });
    // The tab's fold drops the edit and stands: each record is a step once.
    expect(spent(goneIn("tab-1"), appendTo("tab-1", "More")))
      .toEqual({ queueReads: 1, folds: 2, dropped: [1] });
    // An add is a step of the tab tree, refused or not, and one more where its tab is made; an
    // edit of a tab the document lacks is one.
    expect(spent(add("pending-tab-a", { parentTabId: "gone" }), appendTo("ghost", "More")))
      .toEqual({ queueReads: 1, folds: 2, dropped: [1, 2] });
    expect(spent(add("pending-tab-a", {}), { ...add("pending-tab-b", {}), invalidatedReason: "Stale." }))
      .toEqual({ queueReads: 1, folds: 2, dropped: [2] });
  });
});

describe("replaying a Doc's queue one tab at a time", () => {
  const two = () => googleDocSnapshot(documentOf([para("Draft")], [para("Other")])).copy;
  const markdownOf = (replay: GoogleDocReplay, tabId: string) => renderTab(replay.tab(tabId)!).markdown;

  it("folds only the records of the tab that is read", () => {
    let { copy, read } = watched(two());
    let { queue } = countedQueue([
      { id: 1, action: appendTo("tab-1", "More") },
      { id: 2, action: appendTo("tab-2", "Else") },
      { id: 3, action: appendTo("tab-1", "Again") },
    ]);
    let made = spending(() => replayGoogleDoc(queue, copy, REPLAY_CONTEXT));
    expect(made).toMatchObject({ folds: 0, queueReads: 1 });
    expect(read).toEqual([]);

    let first = spending(() => markdownOf(made.value, "tab-1"));
    expect(first).toEqual({ value: "Draft\n\nMore\n\nAgain\n", folds: 2, queueReads: 0 });
    expect(read).toEqual(["tab-1"]);
    expect(spending(() => markdownOf(made.value, "tab-2")))
      .toEqual({ value: "Other\n\nElse\n", folds: 1, queueReads: 0 });
  });

  it("folds a tab once when the replay drops one of its edits", () => {
    let copy = two();
    let pending = [{ id: 1, action: goneIn("tab-1") }, { id: 2, action: appendTo("tab-1", "More") }];
    let { queue, reasons } = countedQueue(pending);
    let first = spending(() => markdownOf(replayGoogleDoc(queue, copy, REPLAY_CONTEXT), "tab-1"));
    expect(first).toEqual({ value: "Draft\n\nMore\n", folds: 2, queueReads: 1 });
    expect([...reasons.keys()]).toEqual([1]);
    expect(pending[0].action.invalidatedReason).toBe(dropped(
      'replaceText: oldMarkdown was not found in the current simulated tab "tab-1". ' +
      'Make sure the text exactly matches content returned by getContent("tab-1").'));

    // The dropped edit carries its reason and is left out: the tab's fold stands.
    expect(spending(() => markdownOf(replayGoogleDoc(queue, copy, REPLAY_CONTEXT), "tab-1")))
      .toEqual({ value: "Draft\n\nMore\n", folds: 0, queueReads: 1 });
  });

  it("does not fold a tab again because another tab's edit was dropped or removed", () => {
    let copy = two();
    let { queue, remove } = countedQueue([
      { id: 1, action: appendTo("tab-1", "More") },
      { id: 2, action: goneIn("tab-2") },
      { id: 3, action: appendTo("tab-2", "Else") },
      { id: 4, action: appendTo("tab-2", "Last") },
    ]);
    let first = replayGoogleDoc(queue, copy, REPLAY_CONTEXT);
    expect(spending(() => [markdownOf(first, "tab-1"), markdownOf(first, "tab-2")]))
      .toMatchObject({ value: ["Draft\n\nMore\n", "Other\n\nElse\n\nLast\n"], folds: 4 });

    // Edit 2 was dropped from the second tab.
    let after = replayGoogleDoc(queue, copy, REPLAY_CONTEXT);
    expect(spending(() => markdownOf(after, "tab-1")).folds).toBe(0);

    // An edit of the second tab is applied or rejected: that tab alone is folded afresh.
    remove(3);
    let removed = replayGoogleDoc(queue, copy, REPLAY_CONTEXT);
    expect(spending(() => markdownOf(removed, "tab-1")).folds).toBe(0);
    expect(spending(() => markdownOf(removed, "tab-2")))
      .toMatchObject({ value: "Other\n\nLast\n", folds: 1 });
  });

  it("folds a tab's queue once when the dropped edit is removed from the queue instead of marked", () => {
    let copy = two();
    let pending = [{ id: 1, action: goneIn("tab-1") }, { id: 2, action: appendTo("tab-1", "More") }];
    let { queue, reasons, listed } = countedQueue(pending, "removes the record");
    expect(spending(() => markdownOf(replayGoogleDoc(queue, copy, REPLAY_CONTEXT), "tab-1")))
      .toEqual({ value: "Draft\n\nMore\n", folds: 2, queueReads: 1 });
    expect([...reasons.keys()]).toEqual([1]);
    expect(listed()).toEqual([2]);
    expect(pending[0].action.invalidatedReason).toBeUndefined();

    expect(spending(() => markdownOf(replayGoogleDoc(queue, copy, REPLAY_CONTEXT), "tab-1")))
      .toEqual({ value: "Draft\n\nMore\n", folds: 0, queueReads: 1 });
  });

  it("marks an edit that names a tab the document does not hold, reading no tab", () => {
    let { copy, read } = watched(two());
    let pending = [
      { id: 1, action: appendTo("ghost", "More") },
      { id: 2, action: appendTo("tab-1", "More") },
    ];
    let replay = replayGoogleDoc(countedQueue(pending).queue, copy, REPLAY_CONTEXT);
    expect(pending[0].action.invalidatedReason).toBe(dropped(
      'appendText: no tab with ID "ghost" exists in this document. ' +
      "Call listTabs() to refresh the tab list."));
    expect(pending[1].action.invalidatedReason).toBeUndefined();
    expect(read).toEqual([]);
    expect(replay.tab("ghost")).toBeUndefined();
  });

  it("leaves an unreplayable edit of a tab that is not read unmarked, and marks it when its tab is read", () => {
    let pending = [
      { id: 1, action: goneIn("tab-2") },
      { id: 2, action: appendTo("tab-1", "More") },
    ];
    let replay = replayGoogleDoc(countedQueue(pending).queue, two(), REPLAY_CONTEXT);
    expect(markdownOf(replay, "tab-1")).toBe("Draft\n\nMore\n");
    expect(pending[0].action.invalidatedReason).toBeUndefined();

    expect(markdownOf(replay, "tab-2")).toBe("Other\n");
    expect(pending[0].action.invalidatedReason).toContain(
      `${REPLAY_CONTEXT}: replaceText: oldMarkdown was not found in the current simulated tab "tab-2".`);
  });

  it("lists a queued add in the outline at its place and shifts its siblings", () => {
    let { copy, read } = watched(two());
    let { queue } = countedQueue([{ id: 1, action: add("pending-tab-a", { index: 1 }) }]);
    let { outline } = replayGoogleDoc(queue, copy, REPLAY_CONTEXT);
    expect(outline).toEqual([
      { tabId: "tab-1", title: "Tab 1", index: 0, nestingLevel: 0 },
      { tabId: "pending-tab-a", title: "Notes", index: 1, nestingLevel: 0 },
      { tabId: "tab-2", title: "Tab 2", index: 2, nestingLevel: 0 },
    ]);
    // Identities only: no tab's content was read, and the copy's own outline is as it was.
    expect(read).toEqual([]);
    expect(copy.outline.map(({ tabId, index }) => [tabId, index])).toEqual([["tab-1", 0], ["tab-2", 1]]);
  });

  it.each(INVALIDATORS)(
    "makes no tab for an add whose place is gone, and refuses the edits queued for it in the same replay, in a queue that %s",
    invalidator => {
      let pending = [
        { id: 1, action: add("pending-tab-a", { parentTabId: "gone" }) },
        { id: 2, action: appendTo("pending-tab-a", "First words") },
        { id: 3, action: goneIn("pending-tab-a") },
        { id: 4, action: appendTo("tab-1", "More") },
      ];
      let { queue, reasons, listed } = countedQueue(pending, invalidator);
      let { copy, read } = watched(two());
      let made = spending(() => replayGoogleDoc(queue, copy, REPLAY_CONTEXT));

      // One replay, and no tab asked for.
      expect(made.queueReads).toBe(1);
      expect(read).toEqual([]);
      expect([...reasons]).toEqual([
        [1, dropped('addTab: no tab with ID "gone" exists in this document. ' +
          "Call listTabs() to refresh the tab list.")],
        [2, dropped('appendText: no tab with ID "pending-tab-a" exists in this document. ' +
          "Call listTabs() to refresh the tab list.")],
        [3, dropped('replaceText: no tab with ID "pending-tab-a" exists in this document. ' +
          "Call listTabs() to refresh the tab list.")],
      ]);
      expect(made.value.outline.map(({ tabId }) => tabId)).toEqual(["tab-1", "tab-2"]);
      expect(made.value.tab("pending-tab-a")).toBeUndefined();
      if (invalidator === "removes the record") expect(listed()).toEqual([4]);
      else expect(pending.map(({ action }) => !!action.invalidatedReason)).toEqual([true, true, true, false]);
    });

  it("applies an edit that names no tab to a document of one tab", () => {
    let pending = [{ id: 1, action: unnamed(appendTo("tab-1", "More")) }];
    let replay = replayGoogleDoc(
      countedQueue(pending).queue, googleDocSnapshot(document("Draft")).copy, REPLAY_CONTEXT);
    expect(markdownOf(replay, "tab-1")).toBe("Draft\n\nMore\n");
    expect(pending[0].action.invalidatedReason).toBeUndefined();
  });

  it("refuses it once an add precedes it", () => {
    let pending = [
      { id: 1, action: unnamed(appendTo("tab-1", "Kept")) },
      { id: 2, action: add("pending-tab-a", {}) },
      { id: 3, action: unnamed(appendTo("tab-1", "More")) },
    ];
    let replay = replayGoogleDoc(
      countedQueue(pending).queue, googleDocSnapshot(document("Draft")).copy, REPLAY_CONTEXT);
    expect(pending.map(({ action }) => action.invalidatedReason))
      .toEqual([undefined, undefined, dropped(PREDATES_TABS)]);
    expect(markdownOf(replay, "tab-1")).toBe("Draft\n\nKept\n");
  });

  it("refuses it in a document of several tabs", () => {
    let pending = [{ id: 1, action: unnamed(appendTo("tab-1", "More")) }];
    let replay = replayGoogleDoc(countedQueue(pending).queue, two(), REPLAY_CONTEXT);
    expect(pending[0].action.invalidatedReason).toBe(dropped(PREDATES_TABS));
    expect(markdownOf(replay, "tab-1")).toBe("Draft\n");
  });

  it("leaves it out when a tab already holds its write", () => {
    let marker = { "gadgets-write-w-1": {
      namedRanges: [{ namedRangeId: "marker-w-1", name: "gadgets-write-w-1" }] } };
    let one = document("Draft");
    one.tabs[0].namedRanges = marker;
    let several = documentOf([para("Draft")], [para("Other")]);
    several.tabs[1].namedRanges = marker;
    for (let fetched of [one, several]) {
      let pending = [{ id: 1, action: unnamed(appendTo("tab-1", "More")) }];
      let spent = spending(() => {
        let replay = replayGoogleDoc(
          countedQueue(pending).queue, googleDocSnapshot(fetched).copy, REPLAY_CONTEXT);
        return markdownOf(replay, "tab-1");
      });
      expect(spent).toMatchObject({ value: "Draft\n", folds: 0 });
      expect(pending[0].action.invalidatedReason).toBeUndefined();
    }
  });

  describe.each([
    ["a document of several tabs", () => documentOf([para("Draft")], [para("Other")]), []],
    ["a document of one tab behind a queued add", () => document("Draft"),
      [{ id: 1, action: add("pending-tab-a", {}) }]],
  ] as const)("in %s", (_name, fetched, ahead) => {
    it.each([undefined, 5])(
      "refuses an edit that names no tab for its earlier Markdown format before it asks which tab it meant (version %s)",
      markdownVersion => {
        let pending: GoogleDocPendingAction[] = [
          ...ahead,
          { id: 2, action: { ...unnamed(appendTo("tab-1", "Old")), markdownVersion } },
          { id: 3, action: unnamed(appendTo("tab-1", "More")) },
        ];
        // One replay, and no tab asked for.
        replayGoogleDoc(countedQueue(pending).queue, googleDocSnapshot(fetched()).copy, REPLAY_CONTEXT);
        expect(pending.at(-2)!.action.invalidatedReason).toBe(dropped(EARLIER_FORMAT));
        expect(pending.at(-1)!.action.invalidatedReason).toBe(dropped(PREDATES_TABS));
      });
  });

  it.each([undefined, 5])(
    "refuses an edit that names no tab for its earlier Markdown format in a document of one tab, once (version %s)",
    markdownVersion => {
      let pending = [{ id: 1, action: { ...unnamed(appendTo("tab-1", "Old")), markdownVersion } }];
      let { queue, reasons } = countedQueue(pending);
      let made = spending(() =>
        replayGoogleDoc(queue, googleDocSnapshot(document("Draft")).copy, REPLAY_CONTEXT));
      expect(made.folds).toBe(1);
      expect([...reasons]).toEqual([[1, dropped(EARLIER_FORMAT)]]);
      // The tab tree refused it, so the fold of the only tab is not given it.
      expect(spending(() => markdownOf(made.value, "tab-1"))).toMatchObject({ value: "Draft\n", folds: 0 });
    });

  it("replays every tab a pending edit targets after an approval, over one read of the queue", () => {
    let { copy, read } = watched(
      googleDocSnapshot(documentOf([para("Draft")], [para("Other")], [para("Third")])).copy);
    let pending = [
      { id: 1, action: goneIn("tab-1") },
      { id: 2, action: goneIn("tab-2") },
      { id: 3, action: appendTo("tab-2", "Else") },
    ];
    let spent = spending(() =>
      replayGoogleDocActions(countedQueue(pending).queue, copy, "After an approval"));
    expect(spent).toMatchObject({ queueReads: 1, folds: 3 });
    expect(pending.map(({ action }) => action.invalidatedReason?.split(":")[0]))
      .toEqual(["After an approval", "After an approval", undefined]);
    // A tab with no pending edit is not read.
    expect(read).toEqual(["tab-1", "tab-2"]);
  });

  it.each(INVALIDATORS)(
    "answers a tab asked for twice from one replay without folding or invalidating again, in a queue that %s",
    invalidator => {
      let { queue, reasons } = countedQueue(
        [{ id: 1, action: goneIn("tab-1") }, { id: 2, action: appendTo("tab-1", "More") }], invalidator);
      let replay = replayGoogleDoc(queue, two(), REPLAY_CONTEXT);
      let first = replay.tab("tab-1");
      let again = spending(() => replay.tab("tab-1"));
      expect(again).toEqual({ value: first, folds: 0, queueReads: 0 });
      expect(again.value).toBe(first);
      expect([...reasons.keys()]).toEqual([1]);
    });

  it("forgets the tab of an add that is rejected", () => {
    let copy = two();
    let { queue, remove, push } = countedQueue([
      { id: 1, action: add("pending-tab-a", {}) },
      { id: 2, action: appendTo("pending-tab-a", "First words") },
      { id: 3, action: appendTo("tab-1", "More") },
    ]);
    let read = () => spending(() => {
      let replay = replayGoogleDoc(queue, copy, REPLAY_CONTEXT);
      return [replay.tab("pending-tab-a"), replay.tab("tab-1")].map(tab => tab && renderTab(tab).markdown);
    });
    // The add is a step of the tab tree and one of its tab.
    expect(read()).toMatchObject({ value: ["First words\n", "Draft\n\nMore\n"], folds: 4 });
    expect(read().folds).toBe(0);

    // Forgotten, the tab the add makes is folded from nothing, and no other tab is.
    forgetGoogleDocTab(queue.cache, "pending-tab-a");
    expect(read()).toMatchObject({ value: ["First words\n", "Draft\n\nMore\n"], folds: 2 });

    // The add is rejected with the edit queued for its tab; another add takes the same id.
    remove(1, 2);
    forgetGoogleDocTab(queue.cache, "pending-tab-a");
    push({ id: 4, action: add("pending-tab-a", { index: 0 }) });
    let replay = replayGoogleDoc(queue, copy, REPLAY_CONTEXT);
    expect(replay.outline.map(({ tabId }) => tabId)).toEqual(["pending-tab-a", "tab-1", "tab-2"]);
    expect(replay.tab("pending-tab-a")).toEqual(pruneTab(blankDocsTab("pending-tab-a", "Notes")));
  });
});

describe("a Doc edit prepared through a read that is authorized", () => {
  /**
   * A session over one tab, "Draft" unless given, with `pending` queued, whose next read's
   * authorization runs `during`.
   */
  function session(
    pending: { id: number; action: GoogleDocAction }[],
    tab: GoogleDocsTab = buildTab([{ runs: ["Draft\n"] }]),
  ) {
    let during: (() => void) | undefined;
    let queued: GoogleDocAction[] = [];
    let document = {
      documentId: "doc-1", title: "Plan", revisionId: "r1",
      tabs: [{ ...tab, title: "Main" }],
    };
    let changes: DocChangeQueue = {
      pending: () => pending,
      invalidate: () => {},
      cache: { writes: 0 },
      queue: async prepare => {
        let { action, result } = await prepare();
        queued.push(action);
        return result;
      },
      afterTurns: async () => {},
      adoptedTabId: tabId => tabId,
      authorizesPreparation: true,
      simulates: true,
    };
    let docs = new GoogleDocSessionImpl({
      docsApi: {
        getDocument: async () => structuredClone(document),
        getRevisionId: async () => "r1",
        getDocumentMetadata: async () => ({ title: "Plan", revisionId: "r1" }),
      } as unknown as GoogleDocsApi,
      driveApi: {} as DriveApi,
      documentId: "doc-1",
      approvalQueue: {} as RpcStub<ApprovalQueue>,
      // The authorization is awaited after the fetch, as a Drive binding's is.
      read: async (fetch, observe) => {
        let value = await fetch();
        observe(value);
        let decide = during;
        during = undefined;
        decide?.();
        return value;
      },
      changes,
      source: {
        snapshot: async () => googleDocSnapshot(structuredClone(document)),
        approved: () => {},
        metadata: async () => ({ title: "Plan", modifiedAt: 0 }),
        metadataObservation: { title: "t", description: "d" },
      },
    });
    return { docs, queued, decideDuringNextRead: (decide: () => void) => { during = decide; } };
  }

  // The read's authorization is awaited after the check: an edit rejected meanwhile would leave
  // the new one queued against content that will never exist.
  it("is refused when an edit it was checked against is decided meanwhile", async () => {
    let pending = [{ id: 1, action: { ...APPEND, markdown: "More" } }];
    let { docs, queued, decideDuringNextRead } = session(pending);
    decideDuringNextRead(() => pending.splice(0));

    await expect(docs.replaceText("More", "Most")).rejects.toThrow("was approved or rejected");
    expect(queued).toEqual([]);
  });

  // Checked again, the caller's text would be matched over another queue than
  // the one it read, and could name other content: the caller reads again instead.
  it("is refused even where a fresh check over the moved queue would pass", async () => {
    let pending = [{ id: 1, action: { ...APPEND, markdown: "More" } }];
    let { docs, queued, decideDuringNextRead } = session(pending);
    decideDuringNextRead(() => pending.splice(0));

    await expect(docs.replaceText("Draft", "Final")).rejects.toThrow("was approved or rejected");
    expect(queued).toEqual([]);
  });

  it("is queued when nothing it was checked against moved", async () => {
    let pending = [{ id: 1, action: { ...APPEND, markdown: "More" } }];
    let { docs, queued } = session(pending);
    await docs.replaceText("More", "Most");
    expect(queued).toMatchObject([{ type: "replaceText", oldMarkdown: "More", newMarkdown: "Most" }]);
  });

  // A card is built from the stored edit, so what it shows beyond the edit's own texts is stored
  // with it, and nothing else is: the texts themselves are never stored twice.
  it("stores with an edit only what its card shows beyond the edit", async () => {
    let label = "\"Main\" (tab-1)";
    let plain = session([]);
    await plain.docs.replaceText("Draft", "Final");
    await plain.docs.appendText("More");
    expect(plain.queued.map(({ display }) => display)).toEqual([{ tab: label }, { tab: label }]);

    // Splitting a numbered item renumbers the item after it, so the card shows that item too.
    let list = session([], buildTab(
      [item("a", "N1"), item("b", "N1"), item("c", "N1")], NUMBERED_LIST));
    await list.docs.replaceText("b", "b\n\nplain");
    expect(list.queued[0]).toMatchObject({ oldMarkdown: "b", newMarkdown: "b\n\nplain" });
    expect(list.queued[0]).not.toHaveProperty("inTable");
    expect(list.queued[0].display).toEqual({
      tab: label, context: { before: "", after: "\n1. c" }, rendered: "b\n\nplain\n\n3. c",
    });
    expect(describeDocEdit(list.queued[0] as Replace).fields)
      .toEqual([
        cardField("Old", "b\n1. c", "markdown"),
        cardField("Requested New", "b\n\nplain\n1. c", "markdown"),
        cardField("New", "b\n\nplain\n\n3. c", "markdown"),
      ]);

    // In a table cell the values are the table's HTML, and the card's prose says so.
    let table = session([], buildTab([para("top"), grid(["alpha", "b"], ["c", "d"]), para("end")]));
    await table.docs.replaceText("alpha", "A & B");
    expect(table.queued[0]).toMatchObject({ inTable: true });
    expect(table.queued[0].display).toEqual({
      tab: label, rendered: "A &amp; B",
      prose: `Replace text in a table of tab ${label}. The values below are the table's HTML: ` +
        "Markdown syntax in them is written to the cells as typed.",
    });
    expect(describeDocEdit(table.queued[0] as Replace).fields)
      .toEqual([
        cardField("Old", "alpha", "html"), cardField("Requested New", "A & B", "html"),
        cardField("New", "A &amp; B", "html"),
      ]);

    // An append reads otherwise than the canonical form of its text where the tab's named styles
    // already give what its markers ask for, and then stores how it reads.
    let styled = session([], {
      ...buildTab([para("Intro")]),
      namedStyles: { styles: [{ namedStyleType: "NORMAL_TEXT", textStyle: { bold: true } }] },
    });
    await styled.docs.appendText("*a* **b**");
    expect(styled.queued[0].display).toEqual({ tab: label, rendered: "*a* b" });
    expect(describeDocEdit(styled.queued[0] as Append).fields)
      .toEqual([
        cardField("Requested", "*a* **b**", "markdown"), cardField("Resulting", "*a* b", "markdown"),
      ]);
  });
});

describe("a Drive binding's Doc snapshot", () => {
  // Another session on the binding can queue an edit checked against a newer revision while this
  // one's request is out: replayed over the older answer, that valid edit would fail for good.
  it("is fetched again when an edit is queued while the fetch is out", async () => {
    let revision = "r1";
    let calls = 0;
    let release: (() => void) | undefined;
    let docsApi = {
      getDocument: async () => {
        calls++;
        let answered = { ...document("Draft"), revisionId: revision };
        if (calls === 1) await new Promise<void>(resolve => { release = resolve; });
        return answered;
      },
    } as unknown as GoogleDocsApi;
    let newest = 0;
    let source = driveDocSource(docsApi, {} as DriveApi, "doc-1", {
      writes: () => 0, newestQueued: () => newest,
    });

    let fetched = source.snapshot();
    await vi.waitFor(() => expect(release).toBeDefined());
    revision = "r2";
    newest = 7;
    release!();
    expect((await fetched).revisionId).toBe("r2");
    expect(calls).toBe(2);
  });
});

describe("a Drive binding's Doc snapshot, reused", () => {
  // An edit is stamped while it is prepared and may enter the queue only after a snapshot fetched
  // later than that: its time cannot tell the snapshot holds what the edit was checked against.
  it("is not reused once an edit has been queued since it was fetched", async () => {
    let calls = 0;
    let docsApi = {
      getDocument: async () => { calls++; return { ...document("Draft"), revisionId: `r${calls}` }; },
    } as unknown as GoogleDocsApi;
    let newest = 0;
    let source = driveDocSource(docsApi, {} as DriveApi, "doc-1", {
      writes: () => 0, newestQueued: () => newest,
    });
    let first = await source.snapshot();
    source.approved(first);
    expect(await source.snapshot()).toBe(first);
    newest = 4;
    expect((await source.snapshot()).revisionId).toBe("r2");
    expect(calls).toBe(2);
  });
});

describe("a Doc read a write lands during", () => {
  // The source checks the writes landed while it fetches, but the session's replay runs after the
  // source has answered: a write landing in between leaves the queue without its edit, and the
  // edits built on it would not replay over the older snapshot.
  it("takes the snapshot again when a write lands after the source answered", async () => {
    let replace: Replace = {
      ...BASE, type: "replaceText", oldMarkdown: "More", newMarkdown: "Final", display: { tab: "x" },
    };
    let pending = [{ id: 1, action: APPEND as GoogleDocAction }, { id: 2, action: replace }];
    let cache = { writes: 0 };
    let invalidated: number[] = [];
    let before = document("Draft");
    let after = {
      ...before, revisionId: "r2",
      tabs: [{ ...buildTab([{ runs: ["Draft\n"] }, { runs: ["More\n"] }]), title: "Main" }],
    };
    let snapshots = 0;
    let docs = new GoogleDocSessionImpl({
      docsApi: {} as GoogleDocsApi,
      driveApi: {} as DriveApi,
      documentId: "doc-1",
      approvalQueue: {} as RpcStub<ApprovalQueue>,
      read: async (fetch, observe) => {
        let value = await fetch();
        observe(value);
        return value;
      },
      changes: {
        pending: () => pending,
        invalidate: ({ id }) => { invalidated.push(id); },
        cache,
        queue: () => Promise.reject(new Error("nothing is queued here")),
        afterTurns: async () => {},
        adoptedTabId: tabId => tabId,
        authorizesPreparation: false,
        simulates: true,
      },
      source: {
        snapshot: async () => {
          snapshots++;
          if (snapshots > 1) return googleDocSnapshot(structuredClone(after));
          // The append lands, and leaves the queue, once the source has answered.
          queueMicrotask(() => { cache.writes++; pending.splice(0, 1); });
          return googleDocSnapshot(structuredClone(before));
        },
        approved: () => {},
        metadata: async () => ({ title: "Plan", modifiedAt: 0 }),
        metadataObservation: { title: "t", description: "d" },
      },
    });

    expect(await docs.getContent()).toContain("Final");
    expect(snapshots).toBe(2);
    expect(invalidated).toEqual([]);
  });

  // Another session's edit can enter the queue there too, checked against a newer revision.
  it("takes the snapshot again when another session queues an edit after the source answered", async () => {
    let pending: { id: number; action: GoogleDocAction }[] = [];
    let invalidated: number[] = [];
    let before = document("Draft");
    let after = {
      ...before, revisionId: "r2",
      tabs: [{ ...buildTab([{ runs: ["Draft\n"] }, { runs: ["External\n"] }]), title: "Main" }],
    };
    let snapshots = 0;
    let docs = new GoogleDocSessionImpl({
      docsApi: {} as GoogleDocsApi,
      driveApi: {} as DriveApi,
      documentId: "doc-1",
      approvalQueue: {} as RpcStub<ApprovalQueue>,
      read: async (fetch, observe) => {
        let value = await fetch();
        observe(value);
        return value;
      },
      changes: {
        pending: () => pending,
        invalidate: ({ id }) => { invalidated.push(id); },
        cache: { writes: 0 },
        queue: () => Promise.reject(new Error("nothing is queued here")),
        afterTurns: async () => {},
        adoptedTabId: tabId => tabId,
        authorizesPreparation: false,
        simulates: true,
      },
      source: {
        snapshot: async () => {
          snapshots++;
          if (snapshots > 1) return googleDocSnapshot(structuredClone(after));
          queueMicrotask(() => {
            pending.push({ id: 3, action: {
              ...BASE, type: "replaceText", oldMarkdown: "External", newMarkdown: "Final",
              display: { tab: "x" },
            } });
          });
          return googleDocSnapshot(structuredClone(before));
        },
        approved: () => {},
        metadata: async () => ({ title: "Plan", modifiedAt: 0 }),
        metadataObservation: { title: "t", description: "d" },
      },
    });

    expect(await docs.getContent()).toContain("Final");
    expect(snapshots).toBe(2);
    expect(invalidated).toEqual([]);
  });
});
