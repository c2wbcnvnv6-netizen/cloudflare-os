import {
  createSimulationStore, type EntityFold,
} from "@gadgets/gatekeeper-kit/simulation-store";
import { describe, expect, it } from "vitest";
import type { GoogleDocsRequest, GoogleDocsTab } from "../src/docs-api";
import {
  applyDocsRequests, NotModelledError, replayCost, unindexedTabRefusal,
} from "../src/docs-model";
import {
  applyDocEdit, applyDocRequests, changedSpan, docEditRequests, docEditTab, DocModelError,
  docRefusal, docTabReducer, isBlankDocTab, makeDocEdit, materializeDocEdit, renderTab,
  replayableDocEdits,
} from "../src/docs-replay";
import type { DocEdit, DocRefusal, QueuedDocEdit, QueuedDocRecord } from "../src/docs-replay";
import { docCopy } from "../src/docs-replica";
import type { DocCopy, DocTabCopy } from "../src/docs-replica";
import { prepareTableChange, prepareTextReplacement } from "../src/docs-table-actions";
import {
  tableChangeRequests, tableGateRefusal, tableIdentity, textReplacementRequests,
} from "../src/docs-tables";
import {
  docTabToMarkdown, markdownToDocRequests, MARKDOWN_RENDERING_VERSION,
} from "../src/markdown-converter";
import type { DocTabSnapshot } from "../src/markdown-converter";
import { buildTab, diceOf, grid, para, tableAt, thrownMessage } from "./doc-fixture";

const TAB = "tab-1";
const OTHER = "tab-2";

/** A tab of the fixture under another id. */
const tabAs = (tabId: string, tab: GoogleDocsTab): GoogleDocsTab => ({ ...tab, tabId });

const copyOf = (...tabs: GoogleDocsTab[]): DocCopy =>
  docCopy({ documentId: "doc-1", title: "Test document", tabs });

/** The identity of the tab's table `index`, as a change to it records it. */
const expectedOf = (tab: GoogleDocsTab, index = 0) =>
  tableIdentity(tableAt(docTabToMarkdown(tab), index));

/** What `run` throws. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected a throw");
}

const PROSE = () => buildTab([para("Hello world"), para("End")]);
const TABLED = () => buildTab([para("Before"), grid(["a", "b"], ["c", "d"]), para("After")]);

describe("docEditRequests", () => {
  const CELL = { oldMarkdown: "<p>a</p>", newMarkdown: "<p>A</p>" };
  const ROWS: DocEdit = {
    type: "insertTableRows", at: 1, cells: [["x", "y"]], expected: expectedOf(TABLED()),
  };

  it.each<[string, () => GoogleDocsTab, DocEdit, (render: DocTabSnapshot) => GoogleDocsRequest[]]>([
    ["builds a paragraph replacement at the one place its text stands", PROSE,
      { type: "replaceText", oldMarkdown: "world", newMarkdown: "there" },
      render => textReplacementRequests(
        render, { matchStart: 6, oldMarkdown: "world", newMarkdown: "there" })],
    ["builds a replacement queued for table cells as a change to the cells", TABLED,
      { type: "replaceText", ...CELL, inTable: true },
      render => textReplacementRequests(
        render, { matchStart: render.markdown.indexOf("<p>a</p>"), ...CELL, inTable: true })],
    ["writes the whole text of a blank tab", () => buildTab([para("")]),
      { type: "appendText", markdown: "# Title\n\nText" },
      render => markdownToDocRequests(
        "# Title\n\nText", render.bodyEndIndex - 1, TAB, { resetParagraphs: true })],
    ["writes a paragraph after the last of a tab that is not blank", PROSE,
      { type: "appendText", markdown: "- item" },
      render => markdownToDocRequests("\n- item", render.bodyEndIndex - 1, TAB, {
        resetParagraphs: true, preserveLeadingParagraph: true, tabBlocks: render.sourceMap.blocks,
      })],
    ["builds a table change with the table builder", TABLED, ROWS,
      render => tableChangeRequests(render, ROWS)],
  ])("%s", (_name, tab, edit, built) => {
    let render = docTabToMarkdown(tab());
    let requests = docEditRequests(render, edit);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests).toEqual(built(render));
  });

  it("builds nothing for an edit that changes nothing", () => {
    expect(docEditRequests(
      docTabToMarkdown(PROSE()), { type: "replaceText", oldMarkdown: "world", newMarkdown: "world" },
    )).toEqual([]);
  });

  it("tells a tab with no content from one whose content renders as nothing", () => {
    expect(isBlankDocTab(docTabToMarkdown(buildTab([para("")])))).toBe(true);
    expect(isBlankDocTab({ ...docTabToMarkdown(buildTab([para("")])), markdown: "" })).toBe(true);
    expect(isBlankDocTab(docTabToMarkdown(PROSE()))).toBe(false);

    // A chip with no label renders as nothing, and is protected.
    let chip = docTabToMarkdown(
      buildTab([{ runs: [{ richLink: { title: "", uri: "https://example.com/" } }, "\n"] }]));
    expect(chip.markdown).toBe("\n");
    expect(isBlankDocTab(chip)).toBe(false);
    expect(docEditRequests(chip, { type: "appendText", markdown: "Text" })).toEqual(
      markdownToDocRequests("\nText", chip.bodyEndIndex - 1, TAB, {
        resetParagraphs: true, preserveLeadingParagraph: true, tabBlocks: chip.sourceMap.blocks,
      }));
  });

  it("refuses a replacement whose text is empty, missing or there twice", () => {
    let render = docTabToMarkdown(buildTab([para("same"), para("same")]));
    let replace = (oldMarkdown: string) => thrownMessage(() =>
      docEditRequests(render, { type: "replaceText", oldMarkdown, newMarkdown: "other" }));
    expect(replace("")).toBe("replaceText: oldMarkdown must not be empty.");
    expect(replace("missing")).toBe(
      `replaceText: oldMarkdown was not found in the current simulated tab "${TAB}". ` +
      `Make sure the text exactly matches content returned by getContent("${TAB}").`);
    expect(replace("same")).toBe(
      `replaceText: oldMarkdown matches multiple locations in the current simulated tab ` +
      `"${TAB}". Include more surrounding context to make the match unique.`);
  });

  it("refuses an append to a tab that ends in a table", () => {
    let render = docTabToMarkdown(buildTab([para("Text"), grid(["a"])]));
    expect(thrownMessage(() => docEditRequests(render, { type: "appendText", markdown: "More" }))).toBe(
      "appendText: the selected tab does not end in a paragraph. " +
      "Add a paragraph after its final table or structural element and retry.");
  });

  it("refuses a replacement queued for table cells whose text is no longer in a table", () => {
    let render = docTabToMarkdown(TABLED());
    expect(thrownMessage(() => docEditRequests(
      render, { type: "replaceText", oldMarkdown: "Before", newMarkdown: "Earlier", inTable: true },
    ))).toBe(
      "replaceText: this change was queued for text in a table, and that text is no longer in one.");
  });
});

/** A request of a kind the builders never send, a batch Google refuses, and no request at all. */
const UNMODELLED = [{ replaceAllText: {} }] as unknown as GoogleDocsRequest[];
const lastLineBreak = (tab: GoogleDocsTab): GoogleDocsRequest[] => {
  let end = docTabToMarkdown(tab).bodyEndIndex;
  return [{ deleteContentRange: { range: { startIndex: end - 2, endIndex: end, tabId: TAB } } }];
};
const FAULTY = [undefined] as unknown as GoogleDocsRequest[];

describe("applyDocRequests", () => {
  it("returns the tab it was given when there is nothing to apply", () => {
    let tab = PROSE();
    expect(applyDocRequests(tab, "replaceText", [])).toBe(tab);
  });

  it("applies a batch as the model does, leaving the tab as it was", () => {
    let tab = PROSE();
    let before = structuredClone(tab);
    let after = applyDocRequests(tab, "replaceText", docEditRequests(
      docTabToMarkdown(tab), { type: "replaceText", oldMarkdown: "world", newMarkdown: "there" }));
    expect(docTabToMarkdown(after).markdown).toBe("Hello there\n\nEnd\n");
    expect(tab).toEqual(before);
  });

  it("says that a batch the model has no answer for cannot be shown, naming the shape", () => {
    let error = thrownBy(() => applyDocRequests(PROSE(), "replaceText", UNMODELLED));
    expect(error).toBeInstanceOf(DocModelError);
    let { message, cause, name } = error as DocModelError;
    expect(name).toBe("DocModelError");
    expect(cause).toBeInstanceOf(NotModelledError);
    expect(message).toBe(
      "replaceText: this change cannot be shown as it will read once applied " +
      `(${(cause as NotModelledError).what}), so it cannot be made through this connection. ` +
      "Make it in Google Docs.");
    expect(docRefusal(error)).toStrictEqual({
      reason: message, unmodelled: { what: "the request replaceAllText", invariant: true },
    });
  });

  it("says in Google's words what Google would refuse", () => {
    let tab = PROSE();
    let error = thrownBy(() => applyDocRequests(tab, "deleteTable", lastLineBreak(tab)));
    expect(error).toBeInstanceOf(DocModelError);
    let { message, cause } = error as DocModelError;
    expect(Object.getPrototypeOf(cause)).toBe(Error.prototype);
    expect(message).toBe(
      `deleteTable: Google Docs would refuse this change: ${(cause as Error).message}`);
    let refusal = docRefusal(error);
    expect(refusal.reason).toBe(message);
    expect(refusal.modelError?.name).toBe("Error");
    expect(refusal.unmodelled).toBeUndefined();
  });

  it("says nothing of what the model threw where the model is at fault", () => {
    let tab = PROSE();
    let fault = thrownBy(() => applyDocsRequests(tab, FAULTY));
    expect(fault).toBeInstanceOf(TypeError);
    let error = thrownBy(() => applyDocRequests(tab, "appendText", FAULTY));
    expect(error).toBeInstanceOf(DocModelError);
    let { message, cause } = error as DocModelError;
    expect(cause).toBeInstanceOf(TypeError);
    expect(message).toBe(
      "appendText: this change cannot be shown as it will read once applied, so it cannot be " +
      "made through this connection. Make it in Google Docs.");
    expect(message).not.toContain((cause as Error).message);
    let refusal = docRefusal(error);
    expect(refusal.modelError?.name).toBe("TypeError");
    expect(refusal.unmodelled).toBeUndefined();
    expect(JSON.stringify(refusal)).not.toContain((cause as Error).message);
  });
});

/** What a refusal keeps of `cause`, thrown by the model for a batch. */
const modelErrorOf = (cause: unknown) => docRefusal(new DocModelError("refused", cause)).modelError;
const framesOf = (cause: unknown) => modelErrorOf(cause)?.frames;

describe("docRefusal", () => {
  it("gives the reason alone for any error that is not the model's", () => {
    expect(docRefusal(new Error("a builder said no"))).toStrictEqual({ reason: "a builder said no" });
    expect(docRefusal(new Error("x", { cause: new TypeError("y") }))).toStrictEqual({ reason: "x" });
    expect(docRefusal("not an error")).toStrictEqual({ reason: "not an error" });
  });

  it("names what was thrown that is no error by its type, with no frames", () => {
    expect(modelErrorOf("a string")).toStrictEqual({ name: "string" });
  });

  it("locates a throw by the frames of its stack", () => {
    let frames = framesOf(thrownBy(() => { throw new TypeError("boom"); }));
    expect(frames).toBeTruthy();
    for (let line of frames!.split("\n")) expect(line).toMatch(/^\s+at /);
    expect(frames).toContain("docs-replay.test");
    expect(frames).not.toContain("boom");
  });

  it("keeps out a message that spans lines, one of them written as a frame", () => {
    let frames = framesOf(thrownBy(() => { throw new TypeError("secret one\n    at secret two"); }));
    expect(frames).not.toContain("secret one");
    expect(frames).not.toContain("secret two");
    expect(frames).toContain("docs-replay.test");
  });

  it("keeps out a message that was changed after the throw", () => {
    // Two lines, the second not written as a frame: taking one line off the head would keep it.
    let cause = thrownBy(() => { throw new TypeError("first words\nmore words"); }) as TypeError;
    // The stack is written when it is first read, with the message the error has then.
    expect(cause.stack).toContain("first words\nmore words\n");
    cause.message = "second words";
    expect(cause.stack?.startsWith(String(cause))).toBe(false);
    let frames = framesOf(cause);
    expect(frames).toBeTruthy();
    for (let line of frames!.split("\n")) expect(line).toMatch(/^\s+at /);
    expect(frames).not.toContain("first words");
    expect(frames).not.toContain("more words");
    expect(frames).not.toContain("second words");
    expect(frames).toContain("docs-replay.test");
  });

  it("has no frames for an error without a stack, or whose stack holds none", () => {
    let stackless = new TypeError("x");
    delete stackless.stack;
    expect(modelErrorOf(stackless)).toStrictEqual({ name: "TypeError" });
    let frameless = new TypeError("x");
    frameless.stack = "TypeError: x";
    expect(modelErrorOf(frameless)).toStrictEqual({ name: "TypeError" });
  });

  it("keeps no frames of a shape the model refuses on purpose", () => {
    let refusal = docRefusal(new DocModelError("refused", new NotModelledError("a shape", false)));
    expect(refusal).toStrictEqual({
      reason: "refused", unmodelled: { what: "a shape", invariant: false },
    });
  });
});

const CURRENT = { markdownVersion: MARKDOWN_RENDERING_VERSION };
const EARLIER_FORMAT = "Pending Google Doc edit was queued under an earlier Markdown format and " +
  "may no longer apply as previewed. Reject it and retry.";

describe("materializeDocEdit", () => {
  const replace: DocEdit = { type: "replaceText", oldMarkdown: "world", newMarkdown: "there" };
  const append: DocEdit = { type: "appendText", markdown: "More" };

  it("throws the reason stored with an edit that no longer applies", () => {
    expect(thrownMessage(() => materializeDocEdit(
      [PROSE()], { ...replace, ...CURRENT, tabId: TAB, invalidatedReason: "It was dropped." },
    ))).toBe("It was dropped.");
  });

  it("refuses an edit previewed under a Markdown version that no longer replays", () => {
    let tab = TABLED();
    let rows: DocEdit = { type: "deleteTableRows", at: 0, count: 1, expected: expectedOf(tab) };
    let refused: QueuedDocEdit[] = [
      { ...rows, tabId: TAB, markdownVersion: 6 },
      { ...replace, tabId: TAB, markdownVersion: 5 },
      { ...append, tabId: TAB, markdownVersion: 5 },
      { ...replace, tabId: TAB },
      { ...append, tabId: TAB },
      { ...rows, tabId: TAB },
    ];
    for (let action of refused) {
      expect(thrownMessage(() => materializeDocEdit([tab], action))).toBe(EARLIER_FORMAT);
    }
    expect(materializeDocEdit([tab], { ...rows, tabId: TAB, ...CURRENT }).requests.length)
      .toBeGreaterThan(0);
  });

  it("builds a text edit previewed under the version before, as approval does", () => {
    let tab = PROSE();
    for (let edit of [replace, append]) {
      expect(materializeDocEdit([tab], { ...edit, tabId: TAB, markdownVersion: 6 }).requests)
        .toEqual(docEditRequests(docTabToMarkdown(tab), edit));
    }
  });

  it("gives the rendering of the tab the edit targets and the requests for it", () => {
    let first = PROSE();
    let second = tabAs(OTHER, buildTab([para("Another world")]));
    let { tab, requests } = materializeDocEdit([first, second], { ...replace, ...CURRENT, tabId: OTHER });
    expect(tab).toEqual(docTabToMarkdown(second));
    expect(tab).toBe(renderTab(second));
    expect(requests).toEqual(docEditRequests(docTabToMarkdown(second), replace));
    expect(requests).not.toEqual(docEditRequests(docTabToMarkdown(first), replace));
  });
});

// A stored edit with no tab was stored before tabs could be named, by code that refused to read
// a document of more than one tab: it was approved against the one tab such a document had.
describe("docEditTab", () => {
  const main = PROSE();
  const storedAppend: QueuedDocEdit = { type: "appendText", markdown: "added" };

  it("retargets a record naming no tab when the document still has exactly one", () => {
    expect(docEditTab([main], storedAppend)).toBe(main);
  });

  it("refuses a record naming no tab once the document has gained tabs", () => {
    expect(thrownMessage(() => docEditTab([main, tabAs(OTHER, main)], storedAppend))).toBe(
      "Pending Google Doc edit predates tab support and the document has gained tabs since, " +
      "so the tab it was approved against is unknown. Reject it and retry on a selected tab.");
  });

  it("refuses a vanished tab rather than retargeting to the first", () => {
    expect(thrownMessage(() => docEditTab([main], { ...storedAppend, tabId: "ghost" }))).toBe(
      'appendText: no tab with ID "ghost" exists in this document. ' +
      "Call listTabs() to refresh the tab list.");
  });

  it("resolves a record that names a live tab", () => {
    let second = tabAs(OTHER, main);
    expect(docEditTab([main, second], { ...storedAppend, tabId: OTHER })).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

/**
 * A pending record of tab `tabId`, previewed under the current Markdown version; `null` for a
 * record that names no tab.
 */
function record(
  id: number, edit: DocEdit, tabId: string | null = TAB,
  more: { invalidatedReason?: string; markdownVersion?: number; writeId?: string } = {},
): QueuedDocRecord {
  return { id, action: { ...edit, ...CURRENT, ...(tabId === null ? {} : { tabId }), ...more } };
}

/** One tab with its records folded over it. */
type TabFold = EntityFold<GoogleDocsTab, QueuedDocRecord, DocRefusal>;

/** What a store with no memory folds `records` to over tab `tabId` of `copy`. */
function foldOf(copy: DocCopy, records: readonly QueuedDocRecord[], tabId = TAB): TabFold {
  let result = createSimulationStore(docTabReducer).fold(tabId, copy.tab(tabId), records);
  if (result.stopped || !result.entity) {
    throw new Error("Expected the fold to reach the end of the tab's queue");
  }
  return result;
}

const markdownOf = (fold: TabFold) => renderTab(fold.entity!).markdown;

/** `value` with every object, array, map and set in it frozen. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  let parts = value instanceof Map ? [...value.values()]
    : value instanceof Set ? [...value] : Object.values(value);
  for (let part of parts) deepFreeze(part);
  return value;
}

const replaceWorld: DocEdit = { type: "replaceText", oldMarkdown: "world", newMarkdown: "there" };
const NOT_FOUND = (tabId = TAB) =>
  `replaceText: oldMarkdown was not found in the current simulated tab "${tabId}". ` +
  `Make sure the text exactly matches content returned by getContent("${tabId}").`;
const missing: DocEdit = { type: "replaceText", oldMarkdown: "missing", newMarkdown: "other" };

/** Table changes of the table `TABLED` holds, and ones recorded for a table that read otherwise. */
const STALE = tableIdentity(docTabToMarkdown(buildTab([grid(["gone"])])).markdown.trim());
const addRows = (expected = expectedOf(TABLED())): DocEdit =>
  ({ type: "insertTableRows", at: 1, cells: [["x", "y"]], expected });
const deleteRows = (expected = expectedOf(TABLED())): DocEdit =>
  ({ type: "deleteTableRows", at: 0, count: 1, expected });
const shade = (expected: string): DocEdit => ({
  type: "setTableCellStyle", row: 0, column: 0, rows: 1, columns: 1,
  style: { background: "#ffcc00" }, expected,
});
const newTable: DocEdit = { type: "insertTable", rows: 1, columns: 1, cells: [["new"]] };
const unindexed = (type: string) => ({ reason: unindexedTabRefusal(type).message, unindexed: true });

describe("docTabReducer", () => {
  /** A fold's refusals by record id. */
  const refusedOf = (fold: TabFold) =>
    new Map(fold.refused.map(({ record: { id }, refusal }) => [id, refusal]));
  /** The refusal of the gate a refused table change closed, for an edit that closes it in turn. */
  const gate = (type: string, closes = true) =>
    ({ reason: tableGateRefusal(type).message, ...(closes ? { closesGate: true } : {}) });

  it("starts from the copy's tab, with nothing refused", () => {
    let copy = copyOf(PROSE(), tabAs(OTHER, TABLED()));
    for (let tabId of [TAB, OTHER]) {
      let fold = foldOf(copy, [], tabId);
      expect(fold.entity).toBe(copy.tab(tabId)!.tab);
      expect(fold.refused).toEqual([]);
    }
  });

  it("makes each edit in its tab, one after another, as the model applies them", () => {
    let copy = copyOf(PROSE(), tabAs(OTHER, buildTab([para("Another world")])));
    let main = foldOf(copy, [
      record(1, replaceWorld),
      record(3, { type: "replaceText", oldMarkdown: "End", newMarkdown: "## Finish" }),
    ]);
    let other = foldOf(copy, [
      record(2, { type: "appendText", markdown: "More" }, OTHER),
      record(4, replaceWorld, OTHER),
    ], OTHER);
    expect(markdownOf(main)).toBe("Hello there\n\n## Finish\n");
    expect(markdownOf(other)).toBe("Another there\n\nMore\n");
    expect(main.refused).toEqual([]);
    expect(other.refused).toEqual([]);
  });

  it("records a refused edit with the builder's own words and goes on", () => {
    let copy = copyOf(PROSE());
    let fold = foldOf(copy, [record(1, missing), record(2, replaceWorld)]);
    expect(refusedOf(fold)).toStrictEqual(new Map([[1, { reason: NOT_FOUND() }]]));
    expect(fold.entity).toEqual(foldOf(copy, [record(2, replaceWorld)]).entity);
    expect(markdownOf(fold)).toBe("Hello there\n\nEnd\n");
  });

  it("closes a tab behind a table change that failed, for the changes that name a table", () => {
    let copy = copyOf(TABLED(), tabAs(OTHER, TABLED()));
    let queue = [
      record(1, deleteRows(STALE)),
      record(2, addRows()),
      record(3, newTable),
      record(4, { type: "replaceText", oldMarkdown: "Before", newMarkdown: "Earlier" }),
      record(6, shade(expectedOf(TABLED()))),
    ];
    let fold = foldOf(copy, queue);
    let refused = refusedOf(fold);
    expect([...refused.keys()]).toEqual([1, 2, 6]);
    expect(refused.get(1)?.reason).toMatch(/^deleteTableRows: /);
    expect(refused.get(1)?.reason).not.toBe(tableGateRefusal("deleteTableRows").message);
    expect(refused.get(1)?.closesGate).toBe(true);
    expect(refused.get(2)).toStrictEqual(gate("insertTableRows"));
    // A change to a table's look closes no gate, refused or not.
    expect(refused.get(6)).toStrictEqual(gate("setTableCellStyle", false));
    // The new table and the paragraph are placed by their text.
    expect(markdownOf(fold)).toContain("Earlier\n");
    expect(markdownOf(fold)).toContain("<td><p>new</p></td>");
    expect(markdownOf(fold)).not.toContain("<td><p>x</p></td>");

    // The other tab is its own: a fold of it knows nothing of the first tab's refusals.
    let other = foldOf(copy, [record(5, addRows(), OTHER)], OTHER);
    expect(other.refused).toEqual([]);
    expect(markdownOf(other)).toContain("<td><p>x</p></td>");
    let closed = foldOf(copy, [
      record(5, addRows(), OTHER), record(7, deleteRows(STALE), OTHER), record(8, addRows(), OTHER),
    ], OTHER);
    expect([...refusedOf(closed).keys()]).toEqual([7, 8]);
    expect(refusedOf(closed).get(7)?.reason).toMatch(/^deleteTableRows: /);
    expect(refusedOf(closed).get(8)).toStrictEqual(gate("insertTableRows"));
  });

  it("closes a tab for a failed replacement in table cells, and for no other text edit or look", () => {
    let copy = copyOf(TABLED());
    let behind = (failed: DocEdit) => foldOf(copy, [record(1, failed), record(2, addRows())]);

    let cells = refusedOf(behind({ ...missing, inTable: true }));
    expect(cells.get(1)).toStrictEqual({ reason: NOT_FOUND(), closesGate: true });
    expect(cells.get(2)).toStrictEqual(gate("insertTableRows"));

    for (let failed of [missing, shade(STALE)]) {
      let open = behind(failed);
      expect([...refusedOf(open).keys()]).toEqual([1]);
      expect(refusedOf(open).get(1)?.closesGate).toBeUndefined();
      expect(markdownOf(open)).toContain("<td><p>x</p></td>");
    }
  });

  it("opens the gate again in a fold that is given the refused records no more", () => {
    let part = copyOf(TABLED()).tab(TAB)!;
    let store = createSimulationStore(docTabReducer);
    let first = store.fold(TAB, part, [record(1, deleteRows(STALE)), record(2, addRows())]);
    expect(first.refused.map(({ record: { id } }) => id)).toEqual([1, 2]);
    expect(first.entity).toBe(part.tab);

    // The replay leaves out what it invalidated: the change queued next finds the table as it is.
    let next = store.fold(TAB, part, [record(3, addRows())]);
    expect(next.refused).toEqual([]);
    expect(next).toEqual(createSimulationStore(docTabReducer).fold(TAB, part, [record(3, addRows())]));
    expect(renderTab(next.entity!).markdown).toContain("<td><p>x</p></td>");
  });

  it("makes an edit that names no tab in the tab it is folded for, and closes no gate with it", () => {
    let prose = foldOf(copyOf(PROSE()), [record(1, replaceWorld, null)]);
    expect(markdownOf(prose)).toBe("Hello there\n\nEnd\n");
    expect(prose.refused).toEqual([]);

    let tabled = foldOf(copyOf(TABLED()), [record(1, deleteRows(STALE), null), record(2, addRows())]);
    expect([...refusedOf(tabled).keys()]).toEqual([1]);
    expect(refusedOf(tabled).get(1)?.closesGate).toBeUndefined();
    expect(markdownOf(tabled)).toContain("<td><p>x</p></td>");
  });

  it("refuses a record whose tab is gone, or whose Markdown version no longer replays", () => {
    let ghost = createSimulationStore(docTabReducer)
      .fold("ghost", undefined, [record(1, replaceWorld, "ghost")]);
    expect(ghost.entity).toBeUndefined();
    expect(refusedOf(ghost)).toStrictEqual(new Map([[1, {
      reason: 'replaceText: no tab with ID "ghost" exists in this document. ' +
        "Call listTabs() to refresh the tab list.",
    }]]));

    let fold = foldOf(copyOf(PROSE()), [
      record(2, replaceWorld, TAB, { markdownVersion: 5 }),
      record(3, replaceWorld, TAB, { markdownVersion: 6 }),
    ]);
    expect(refusedOf(fold)).toStrictEqual(new Map([[2, { reason: EARLIER_FORMAT }]]));
    expect(markdownOf(fold)).toBe("Hello there\n\nEnd\n");
  });

  it("refuses every edit of a tab the copy cannot index, before it asks the gate", () => {
    let part: DocTabCopy = { ...copyOf(TABLED()).tab(TAB)!, unindexed: true };
    let fold = createSimulationStore(docTabReducer).fold(TAB, part, [
      record(1, deleteRows()),
      record(2, addRows()),
      record(3, { type: "replaceText", oldMarkdown: "Before", newMarkdown: "Earlier" }),
    ]);
    // A table change so refused closes its tab as any refused table change does.
    expect(refusedOf(fold)).toStrictEqual(new Map<number, unknown>([
      [1, { ...unindexed("deleteTableRows"), closesGate: true }],
      [2, { ...unindexed("insertTableRows"), closesGate: true }],
      [3, unindexed("replaceText")],
    ]));
    expect(refusedOf(fold).get(2)?.reason).not.toBe(tableGateRefusal("insertTableRows").message);
    expect(fold.entity).toBe(part.tab);
  });

  it("records a fault of the model as a refusal that holds nothing of what it threw", () => {
    // A tab with no lists is not one Google returns: the model throws where it makes a list.
    let listless = { ...PROSE(), lists: undefined } as unknown as GoogleDocsTab;
    let part: DocTabCopy = { tab: listless, writeMarkers: [], committedWriteIds: [], unindexed: false };
    let item: DocEdit = { type: "appendText", markdown: "- item" };
    let fault = thrownBy(() => applyDocsRequests(listless, docEditRequests(renderTab(listless), item)));
    expect(fault).toBeInstanceOf(TypeError);

    let fold = createSimulationStore(docTabReducer)
      .fold(TAB, part, [record(1, item), record(2, replaceWorld)]);
    let refusal = refusedOf(fold).get(1);
    expect(refusal?.reason).toBe(
      "appendText: this change cannot be shown as it will read once applied, so it cannot be " +
      "made through this connection. Make it in Google Docs.");
    expect(refusal?.modelError?.name).toBe("TypeError");
    expect(refusal?.modelError?.frames).toContain("docs-model");
    expect(JSON.stringify(refusal)).not.toContain((fault as Error).message);
    expect(refusal?.unindexed).toBeUndefined();
    expect(refusal?.unmodelled).toBeUndefined();
    expect(markdownOf(fold)).toBe("Hello there\n\nEnd\n");
  });

  it("leaves the tab itself for an edit that changes nothing", () => {
    let part = copyOf(PROSE()).tab(TAB)!;
    let store = createSimulationStore(docTabReducer);
    let without = store.fold(TAB, part, [record(1, replaceWorld)]);
    let unchanged = store.fold(TAB, part, [
      record(1, replaceWorld),
      record(2, { type: "replaceText", oldMarkdown: "there", newMarkdown: "there" }),
    ]);
    expect(without.entity).toBeDefined();
    expect(unchanged.entity).toBe(without.entity);
    expect(docTabReducer.reduce(
      without.entity, record(2, { type: "replaceText", oldMarkdown: "End", newMarkdown: "End" }),
      { id: TAB, base: part, refusals: [] },
    )).toEqual({ kind: "known-no-effect" });
  });

  it("changes neither the copy's tab nor the tab it is given", () => {
    let part = deepFreeze(copyOf(TABLED()).tab(TAB)!);
    let records = [
      record(1, addRows()),
      record(2, deleteRows(STALE)),
      record(3, addRows()),
      record(4, { type: "replaceText", oldMarkdown: "Before", newMarkdown: "Earlier" }),
      record(5, missing),
      record(7, { type: "appendText", markdown: "More" }),
    ];
    let tab = docTabReducer.initial(part);
    let refusals: DocRefusal[] = [];
    let refused: number[] = [];
    let partBefore = structuredClone(part);
    for (let pending of records) {
      let before = structuredClone(tab);
      let step = docTabReducer.reduce(tab, pending, { id: TAB, base: part, refusals });
      expect(step.kind).not.toBe("unsupported");
      expect(tab).toEqual(before);
      if (step.kind === "applied") {
        expect(step.value).not.toBe(tab);
        tab = deepFreeze(step.value);
      } else if (step.kind === "refused") {
        refusals = [...refusals, step.refusal];
        refused.push(pending.id);
      }
    }
    expect(part).toEqual(partBefore);
    expect(refused).toEqual([2, 3, 5]);
    expect(tab).toEqual(createSimulationStore(docTabReducer).fold(TAB, part, records).entity);
  });

  it("folds a longer queue from a remembered fold to what a fresh store gives", () => {
    let part = copyOf(TABLED()).tab(TAB)!;
    let [a, b, c] = [
      record(1, addRows()), record(2, missing),
      record(3, { type: "replaceText", oldMarkdown: "Before", newMarkdown: "Earlier" }),
    ];
    let store = createSimulationStore(docTabReducer);
    store.fold(TAB, part, [a, b]);
    // The refused record is presented no more, as a replay that invalidated it leaves it out.
    let extended = store.fold(TAB, part, [a, c]);
    expect(extended.stopped).toBeUndefined();
    expect(extended).toEqual(createSimulationStore(docTabReducer).fold(TAB, part, [a, c]));
  });

  it("counts a reducer step for each record it reduces", () => {
    let copy = copyOf(TABLED());
    let before = replayCost.folds;
    // Applied or refused, a record that is reduced is a step.
    foldOf(copy, [record(1, replaceWorld), record(2, missing), record(3, addRows())]);
    expect(replayCost.folds - before).toBe(3);
  });
});

describe("an edit made in a tab", () => {
  /** A stored action: the edit, and what the queue keeps beside it. */
  type Stored = QueuedDocEdit & { submittedAt: number; display: { title: string } };
  const storedAs = (edit: DocEdit): Stored => ({
    ...structuredClone(edit), ...CURRENT, tabId: TAB, writeId: "w1", submittedAt: 3,
    display: { title: "Card" },
  });
  /** The whole-tab passes spent since `before`: clones, full re-indexes and renders. */
  const passesSince = (before: typeof replayCost) => ({
    tabClones: replayCost.tabClones - before.tabClones,
    fullReindexes: replayCost.fullReindexes - before.fullReindexes,
    renders: replayCost.renders - before.renders,
  });
  const NO_PASS = { tabClones: 0, fullReindexes: 0, renders: 0 };

  it("answers what it made for the same tab and the same edit, whatever else the edit " +
    "carries", () => {
    let tab = PROSE();
    let before = { ...replayCost };
    let made = makeDocEdit(tab, replaceWorld);

    expect(makeDocEdit(tab, storedAs(replaceWorld))).toBe(made);
    expect(applyDocEdit(tab, storedAs(replaceWorld))).toBe(made.after);
    expect(passesSince(before).tabClones).toBe(1);
    expect(made.requests).toEqual(docEditRequests(renderTab(tab), replaceWorld));
    expect(made.after).toEqual(applyDocsRequests(tab, made.requests));
  });

  it("makes the edit again for another tab object, another edit, or one field that " +
    "differs", () => {
    let tab = TABLED();
    let cell: DocEdit = { type: "replaceText", oldMarkdown: "<p>a</p>", newMarkdown: "<p>A</p>" };
    let rows = addRows();
    let table: DocEdit = { ...newTable, after: "Before" };
    let pairs: [DocEdit, DocEdit][] = [
      // One cell of a table change's `cells`.
      [rows, {
        type: "insertTableRows", at: 1, cells: [["x", "z"]], expected: expectedOf(TABLED()),
      }],
      // `after` set against left out.
      [table, newTable],
      [rows, deleteRows()],
    ];
    for (let [first, second] of pairs) {
      let made = makeDocEdit(tab, first);
      let before = replayCost.tabClones;
      let other = makeDocEdit(tab, second);
      expect(other).not.toBe(made);
      expect(other.after).not.toEqual(made.after);
      // The tab remembers the edit made last, and the one before it no more.
      expect(makeDocEdit(tab, second)).toBe(other);
      expect(makeDocEdit(tab, first)).not.toBe(made);
      expect(replayCost.tabClones - before).toBe(2);
    }

    // `inTable` set against left out: the text of a cell is replaced only as a cell's.
    let inCell = makeDocEdit(tab, { ...cell, inTable: true });
    expect(thrownMessage(() => makeDocEdit(tab, cell))).toContain("structured content");
    expect(makeDocEdit(tab, { ...cell, inTable: true })).toBe(inCell);

    let made = makeDocEdit(tab, rows);
    let copied = makeDocEdit(structuredClone(tab), rows);
    expect(copied).not.toBe(made);
    expect(copied).toEqual(made);
  });

  it("remembers no refusal", () => {
    let tab = PROSE();
    let before = replayCost.tabClones;

    for (let attempt = 0; attempt < 2; attempt++) {
      expect(thrownMessage(() => makeDocEdit(tab, missing))).toBe(NOT_FOUND());
      // Another builder's refusal: the tab holds no table.
      expect(thrownBy(() => makeDocEdit(tab, addRows()))).toBeInstanceOf(Error);
    }
    let made = makeDocEdit(tab, replaceWorld);
    expect(replayCost.tabClones - before).toBe(1);
    expect(renderTab(made.after).markdown).toBe("Hello there\n\nEnd\n");
    // A refusal after it leaves what the tab remembers as it was.
    expect(thrownMessage(() => makeDocEdit(tab, missing))).toBe(NOT_FOUND());
    expect(makeDocEdit(tab, replaceWorld)).toBe(made);
  });

  it("remembers an edit that changes nothing, as the tab it was given", () => {
    let tab = PROSE();
    let same: DocEdit = { type: "replaceText", oldMarkdown: "End", newMarkdown: "End" };
    let made = makeDocEdit(tab, replaceWorld);
    let unchanged = makeDocEdit(made.after, same);

    expect(unchanged).toEqual({ requests: [], after: made.after });
    expect(makeDocEdit(made.after, storedAs(same))).toBe(unchanged);
    expect(docTabReducer.reduce(
      made.after, record(2, same), { id: TAB, base: copyOf(tab).tab(TAB), refusals: [] },
    )).toEqual({ kind: "known-no-effect" });
  });

  it("lets go of the tab it made once an edit is made in that tab", () => {
    let t0 = PROSE();
    let t1 = applyDocEdit(t0, replaceWorld);
    applyDocEdit(t1, { type: "appendText", markdown: "More" });
    let again = applyDocEdit(t0, replaceWorld);

    expect(again).not.toBe(t1);
    expect(again).toEqual(t1);
  });

  it("folds a record from the tab its prepare made", () => {
    let tab = PROSE();
    let part = copyOf(tab).tab(TAB);
    let prepared = prepareTextReplacement(tab, "world", "there", "the document");
    let before = { ...replayCost };
    let step = docTabReducer.reduce(
      tab, record(1, storedAs(replaceWorld)), { id: TAB, base: part, refusals: [] });

    if (step.kind !== "applied") throw new Error(`Expected an applied step, not ${step.kind}`);
    expect(step.value).toBe(applyDocEdit(tab, replaceWorld));
    // The rendering the card was made from is the read's.
    expect(renderTab(step.value).markdown).toBe("Hello there\n\nEnd\n");
    expect(renderTab(step.value).markdown).toContain(prepared.shown.rendered);
    expect(passesSince(before)).toEqual(NO_PASS);
  });

  it("folds the record of a new table from the tab its prepare made", () => {
    let tab = PROSE();
    let part = copyOf(tab).tab(TAB);
    let { change } = prepareTableChange(
      tab, { method: "insertTable", table: { rows: 1, columns: 2, cells: [["a", "b"]] } },
      "the document");
    let before = { ...replayCost };
    let step = docTabReducer.reduce(
      tab, record(1, storedAs(change)), { id: TAB, base: part, refusals: [] });

    if (step.kind !== "applied") throw new Error(`Expected an applied step, not ${step.kind}`);
    expect(step.value).toBe(applyDocEdit(tab, change));
    expect(renderTab(step.value).sourceMap.tables).toHaveLength(1);
    expect(passesSince(before)).toEqual(NO_PASS);
  });
});

describe("renderTab", () => {
  it("counts a render once for a tab object", () => {
    let tab = PROSE();
    let before = replayCost.renders;
    expect(renderTab(tab)).toBe(renderTab(tab));
    expect(replayCost.renders - before).toBe(1);
    // A tab that reads the same is another object, and is rendered for itself.
    expect(renderTab(PROSE())).toEqual(renderTab(tab));
    expect(replayCost.renders - before).toBe(2);
  });
});

describe("replayableDocEdits", () => {
  const part: DocTabCopy = {
    ...copyOf(PROSE()).tab(TAB)!,
    writeMarkers: [{ writeId: "w1", id: "range.1" }],
    committedWriteIds: ["w1"],
  };

  it("leaves out a record whose write the tab already holds", () => {
    let held = record(1, replaceWorld, TAB, { writeId: "w1" });
    let elsewhere = record(2, replaceWorld, TAB, { writeId: "w2" });
    let noTab = record(3, replaceWorld, null, { writeId: "w1" });
    let unsent = record(4, replaceWorld);
    let kept = replayableDocEdits(part, [held, elsewhere, noTab, unsent]);
    expect(kept.map(({ id }) => id)).toEqual([2, 4]);
    expect(kept[0]).toBe(elsewhere);
    expect(kept[1]).toBe(unsent);
  });

  it("keeps every record of a tab the copy lacks", () => {
    let records = [record(1, replaceWorld, "ghost", { writeId: "w1" }), record(2, replaceWorld, "ghost")];
    expect(replayableDocEdits(undefined, records)).toEqual(records);
  });

  it("gives back the records it was given, typed as they were", () => {
    type Stored = { id: number; action: QueuedDocEdit & { submittedAt: number } };
    let stored: Stored[] = [
      { id: 1, action: { ...replaceWorld, tabId: TAB, writeId: "w1", submittedAt: 3 } },
      { id: 2, action: { ...replaceWorld, tabId: TAB, submittedAt: 7 } },
    ];
    let kept: Stored[] = replayableDocEdits(part, stored);
    expect(kept).toEqual([stored[1]]);
    expect(kept[0]).toBe(stored[1]);
    expect(kept[0].action.submittedAt).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// changedSpan
// ---------------------------------------------------------------------------

/** The two sides of the span `changedSpan` gives, after checking that the rest is the same text. */
function sides(
  before: string, after: string, named?: { start: number; end: number },
): [string, string] {
  let { start, beforeEnd, afterEnd } = changedSpan(before, after, named);
  expect(before.slice(0, start)).toBe(after.slice(0, start));
  expect(before.slice(beforeEnd)).toBe(after.slice(afterEnd));
  return [before.slice(start, beforeEnd), after.slice(start, afterEnd)];
}

/** The range `text` stands at in `markdown`. */
function rangeOf(markdown: string, text: string): { start: number; end: number } {
  let start = markdown.indexOf(text);
  return { start, end: start + text.length };
}

/**
 * A call of `changedSpan` and what it gives: the two sides of the span and, where the texts
 * leave more than one span with those sides, the span itself.
 */
type SpanCase = [
  name: string, before: string, after: string, named: { start: number; end: number } | undefined,
  sides: [string, string], span?: ReturnType<typeof changedSpan>,
];

/** Holds `changedSpan` to a case. */
function expectSpan(...[, before, after, named, expected, span]: SpanCase): void {
  expect(sides(before, after, named)).toEqual(expected);
  if (span) expect(changedSpan(before, after, named)).toEqual(span);
}

describe("changedSpan with the range the caller's text stands at", () => {
  const BEFORE = "first\none two three\nlast\n";
  const TWO = rangeOf(BEFORE, "two");
  // U+1F600 and U+1F601 share their high surrogate; U+1F600 and U+1F200 their low one.
  const [GRIN, BEAM, SQUARE] = ["\u{1F600}", "\u{1F601}", "\u{1F200}"];

  it.each<SpanCase>([
    ["is that range where the renderings are the same", BEFORE, BEFORE, TWO,
      ["two", "two"], { start: 10, beforeEnd: 13, afterEnd: 13 }],
    ["is that range where the change lies inside it", BEFORE, "first\none 2 and more three\nlast\n", TWO,
      ["two", "2 and more"], { start: 10, beforeEnd: 13, afterEnd: 20 }],
    ["is that range where its text is removed", BEFORE, "first\none  three\nlast\n", TWO, ["two", ""]],
    ["starts at the line's start where the change begins before the range",
      BEFORE, "first\nONE 2 three\nlast\n", TWO, ["one two", "ONE 2"]],
    ["starts at the start of the earlier line a change begins in",
      BEFORE, "First\none 2 three\nlast\n", TWO, ["first\none two", "First\none 2"]],
    ["ends at the line's end where the change ends after the range in the middle of a line",
      BEFORE, "first\none 2 thrEe\nlast\n", TWO, ["two three", "2 thrEe"]],
    ["ends at the end of the later line a change ends in",
      BEFORE, "first\none 2 three\nLast\n", TWO, ["two three\nlast", "2 three\nLast"]],
    ["ends after the line break where the change ends at one",
      "x\ny\n", "zy\n", { start: 0, end: 1 }, ["x\n", "z"], { start: 0, beforeEnd: 2, afterEnd: 1 }],
    ["is the text an insertion adds", "x a", "x b a", { start: 1, end: 1 }, ["", " b"]],
    ["is the text an insertion adds, though it repeats the text after it",
      "x a", "x a a", { start: 1, end: 1 }, ["", " a"], { start: 1, beforeEnd: 1, afterEnd: 3 }],
    ["splits neither of two emoji that share their high surrogate",
      `a ${GRIN} b`, `a ${BEAM} b`, { start: 2, end: 4 }, [GRIN, BEAM]],
    ["splits neither of two emoji that share their low surrogate",
      `a ${GRIN} b`, `a ${SQUARE} b`, { start: 2, end: 4 }, [GRIN, SQUARE]],
    ["splits no emoji of the line it widens to",
      `${GRIN}${BEAM}\n`, `${GRIN}${GRIN}\n`, { start: 0, end: 2 }, [`${GRIN}${BEAM}`, `${GRIN}${GRIN}`]],
  ])("%s", expectSpan);
});

describe("changedSpan with no range", () => {
  it.each<SpanCase>([
    ["is empty where the renderings are the same", "a\nb\n", "a\nb\n", undefined,
      ["", ""], { start: 4, beforeEnd: 4, afterEnd: 4 }],
    ["is what an append adds", "a\n", "a\n\nb\n", undefined, ["", "\nb\n"]],
    ["is what an append adds to a blank tab", "\n", "Hello\n", undefined, ["", "Hello"]],
    ["is the whole of a line that differs",
      "one\ntwo\nthree\n", "one\ntWo\nthree\n", undefined, ["two", "tWo"]],
    ["is the whole of a line that gains a character",
      "one\ntwo words\nthree\n", "one\ntwo  words\nthree\n", undefined, ["two words", "two  words"]],
    ["runs from the first line that differs to the last",
      "one\ntwo\nthree\nfour\n", "oNe\ntwo\nthrEe\nfour\n", undefined,
      ["one\ntwo\nthree", "oNe\ntwo\nthrEe"]],
    ["is empty on the after side for lines that are only removed",
      "one\ntwo\nthree\n", "one\nthree\n", undefined, ["two\n", ""]],
  ])("%s", expectSpan);
});

/** A table row of one paragraph to a cell, as the rendering writes it. */
const ROW = (...cells: string[]) =>
  `  <tr>\n${cells.map(cell => `    <td><p>${cell}</p></td>\n`).join("")}  </tr>\n`;

describe("changedSpan of lines that are only added", () => {
  const tab = TABLED();
  const before = docTabToMarkdown(tab).markdown;
  const afterEdit = (edit: DocEdit) => docTabToMarkdown(applyDocEdit(tab, edit)).markdown;

  it("gives a row added between two rows, at the top of the table or after its last row", () => {
    for (let at of [0, 1, 2]) {
      let after = afterEdit({
        type: "insertTableRows", at, cells: [["x", "y"]], expected: expectedOf(tab),
      });
      expect(sides(before, after)).toEqual(["", ROW("x", "y")]);
    }
  });

  it("gives a row that reads as the row before it, whole", () => {
    let after = afterEdit({
      type: "insertTableRows", at: 1, cells: [["a", "b"]], expected: expectedOf(tab),
    });
    expect(sides(before, after)).toEqual(["", ROW("a", "b")]);
  });

  it("gives a table added in front of a table, with the paragraph Google adds after it", () => {
    let after = afterEdit({
      type: "insertTable", rows: 1, columns: 1, cells: [["new"]], after: "Before",
    });
    expect(sides(before, after)).toEqual(["", `<table>\n${ROW("new")}</table>\n\n\n\n`]);
  });

  it("leaves a line appended that repeats the last line where it is", () => {
    let repeated = buildTab([para("same")]);
    let after = docTabToMarkdown(applyDocEdit(repeated, { type: "appendText", markdown: "same" })).markdown;
    expect(after).toBe("same\n\nsame\n");
    expect(changedSpan("same\n", after)).toEqual({ start: 5, beforeEnd: 5, afterEnd: 11 });
  });

  it("places lines that could stand earlier where their first line is indented least", () => {
    // The added lines could start at `  b`, at the second `a` or at `    c`.
    expect(sides("a\n  b\n", "a\n  b\na\n  b\n")).toEqual(["", "a\n  b\n"]);
    expect(sides("a\n    c\n  b\n", "a\n    c\n  b\n    c\n  b\n")).toEqual(["", "  b\n    c\n"]);
  });
});

const atLineStart = (text: string, index: number) => index === 0 || text[index - 1] === "\n";
const textOf = (lines: string[]) => lines.map(line => `${line}\n`).join("");

describe("changedSpan of any two texts", () => {
  const LINES = ["a", "  b", "    c", "", "  b", "a"];
  const TEXTS = ["", "q", "\n", "a\n  b"];

  it("leaves the same text outside the span, which holds the named range", () => {
    let { below } = diceOf(7);
    let lines = (count: number) => Array.from({ length: count }, () => LINES[below(LINES.length)]);
    for (let round = 0; round < 4000; round++) {
      let beforeLines = lines(below(9));
      let before = textOf(beforeLines);
      let after: string;
      if (below(2) === 0) {
        // Whole lines added at a line start.
        let at = below(beforeLines.length + 1);
        after = textOf([...beforeLines.slice(0, at), ...lines(1 + below(4)), ...beforeLines.slice(at)]);
        let { start, beforeEnd, afterEnd } = changedSpan(before, after);
        expect(beforeEnd).toBe(start);
        expect(atLineStart(after, start)).toBe(true);
        expect(after[afterEnd - 1]).toBe("\n");
        expect(after.length - (afterEnd - start)).toBe(before.length);
      } else {
        after = textOf(lines(below(9)));
      }
      sides(before, after);

      let start = below(before.length + 1);
      let named = { start, end: start + below(before.length - start + 1) };
      let span = changedSpan(before, after, named);
      sides(before, after, named);
      expect(span.start).toBeLessThanOrEqual(named.start);
      expect(span.beforeEnd).toBeGreaterThanOrEqual(named.end);

      // The named range replaced by any text: the span is that range, and the text.
      let written = TEXTS[below(TEXTS.length)];
      let replaced = before.slice(0, named.start) + written + before.slice(named.end);
      expect(changedSpan(before, replaced, named)).toEqual({
        start: named.start, beforeEnd: named.end, afterEnd: named.start + written.length,
      });
    }
  });
});
