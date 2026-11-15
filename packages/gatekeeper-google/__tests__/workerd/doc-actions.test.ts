import { ActionApplyError } from "@gadgets/gatekeeper-kit/actions";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import type { RpcStub } from "cloudflare:workers";
import {
  assertGoogleDocDisplaySize, describeDocEdit, DOC_DEFINITIONS, DOC_REVISION_PIN_MS,
  DOC_SNAPSHOT_TTL_MS, docDefinition, docRevisionPins, forgetGoogleDocTab, googleDocSnapshot,
  replayGoogleDoc, replayGoogleDocActions, REPLAY_CONTEXT, type DocHost, type GoogleDocAction,
  type GoogleDocEditAction, type GoogleDocPendingAction, type GoogleDocReplay,
  type GoogleDocReplayQueue, type GoogleDocSnapshot,
} from "../../src/doc-actions";
import { driveDocSource, GoogleDocSessionImpl, type DocChangeQueue } from "../../src/docs";
import {
  blankDocsTab, type GoogleDocsApi, type GoogleDocsDocument, type GoogleDocsTab,
} from "../../src/docs-api";
import { replayCost } from "../../src/docs-model";
import { applyDocEdit, materializeDocEdit, renderTab, type DocEdit } from "../../src/docs-replay";
import {
  DOC_COPY_UNREADABLE, pruneTab, type DocCopy, type DocTabCopy,
} from "../../src/docs-replica";
import {
  prepareTableChange, prepareTextReplacement, type TableCall,
} from "../../src/docs-table-actions";
import { tableGateRefusal, tableIdentity } from "../../src/docs-tables";
import type { DriveApi } from "../../src/drive-api";
import { GoogleApiError } from "../../src/google-response";
import { docTabToMarkdown, MARKDOWN_RENDERING_VERSION } from "../../src/markdown-converter";
import {
  buildTab, cardField, diceOf, grid, item, NUMBERED_LIST, para, presetLevels, tableAt,
  type BlockSpec, type Dice,
} from "../doc-fixture";

type Append = Parameters<typeof DOC_DEFINITIONS.appendText.describe>[0];
type Replace = Parameters<typeof DOC_DEFINITIONS.replaceText.describe>[0];
type AddTab = Parameters<typeof DOC_DEFINITIONS.addTab.describe>[0];

const BASE = {
  tabId: "tab-1", submittedAt: 0, markdownVersion: MARKDOWN_RENDERING_VERSION, writeId: "w-1",
};
const APPEND: Append = { ...BASE, type: "appendText", markdown: "More", display: { tab: "\"Main\" (tab-1)" } };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * A host over one document whose Docs API is a stub; `landed`, `unapplyable` and `spendCopy` are
 * recorded. `held` is the copy `heldCopy` answers, until a batch is built from it.
 */
function host(
  document: GoogleDocsDocument, receipt?: { actionId: number; markerId: string },
  held?: GoogleDocSnapshot,
) {
  let api = {
    getDocument: vi.fn(async () => document),
    deleteNamedRange: vi.fn<GoogleDocsApi["deleteNamedRange"]>(async () => {}),
    batchUpdate: vi.fn<GoogleDocsApi["batchUpdate"]>(
      async () => ({ revisionId: "r-next", writeMarkerId: "marker-new", replies: [] })),
  };
  let landed = vi.fn<DocHost["landed"]>();
  let unapplyable = vi.fn<DocHost["unapplyable"]>(async () => {});
  let spendCopy = vi.fn<DocHost["spendCopy"]>(() => { held = undefined; });
  let docHost: DocHost = {
    api: api as unknown as DocHost["api"],
    documentId: "doc-1",
    mimeType: async () => "application/vnd.google-apps.document",
    receipt: () => receipt,
    clearReceipt: () => {},
    saved: () => {},
    landed,
    unapplyable,
    heldCopy: () => held,
    spendCopy,
  };
  return { api, landed, unapplyable, spendCopy, docHost };
}

function document(text: string): GoogleDocsDocument {
  return {
    documentId: "doc-1", title: "Plan", revisionId: "r1",
    tabs: [{ ...buildTab([{ runs: [`${text}\n`] }]), title: "Main" }],
  };
}

/** `document(text)` at revision `revisionId`. */
const docAt = (revisionId: string, text: string): GoogleDocsDocument =>
  ({ ...document(text), revisionId });

/** `doc` with the markers `ids` of write `writeId` in its first tab. */
function withMarkers(doc: GoogleDocsDocument, writeId: string, ...ids: string[]): GoogleDocsDocument {
  let name = `gadgets-write-${writeId}`;
  let [first, ...rest] = doc.tabs;
  let namedRanges = { [name]: { namedRanges: ids.map(namedRangeId => ({ namedRangeId, name })) } };
  return { ...doc, tabs: [{ ...first, namedRanges }, ...rest] };
}

/** What `landed` was told, call by call: the edit, its marker and the tab an add made. */
const landings = (landed: MockInstance<DocHost["landed"]>) => landed.mock.calls.map(
  ([id, marker, addedTab]) => ({ id, ...marker && { marker }, ...addedTab && { addedTab } }));

/** The lines logged of a batch built from the copy held that was not accepted. */
const copyRefusals = (warn: MockInstance<typeof console.warn>) =>
  warn.mock.calls.map(([line]) => line as Record<string, unknown>)
    .filter(line => line?.event === "google.doc.action.apply.copy-refused");

/** A refusal of a Docs batch with `status`, as the Docs API throws one. */
const docsRefusal = (status: string | undefined) =>
  new GoogleApiError("Google Docs batchUpdate failed [http=400]", status);
/** Google's refusal of a batch pinned to a revision the document has moved past. */
const STALE_PIN = () => docsRefusal("INVALID_ARGUMENT");
/** Google's answer to the batch that adds a tab. */
const ADDED_TAB_REPLY = {
  revisionId: "r-next", writeMarkerId: "marker-new",
  replies: [{ addDocumentTab: { tabProperties: { tabId: "tab-made" } } }],
};

describe("Google Doc edit definitions", () => {
  it("declares text edits, new tabs and table changes under their three kinds, applied without a claim", () => {
    for (let [name, definition] of Object.entries(DOC_DEFINITIONS)) {
      expect(definition.kind.tag, name).toBe(
        name === "addTab" ? "addDocumentTab"
          : name === "replaceText" || name === "appendText" ? "editDocument" : "document-tables");
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

    // A table change shows the card prepared when it was queued, which is stored with it.
    let rows: Parameters<typeof DOC_DEFINITIONS.insertTableRows.describe>[0] = {
      ...BASE, type: "insertTableRows", expected: "<table>\n  <tr>\n    <td>Name</td>\n  </tr>\n</table>",
      at: 1, cells: [["Ana"]],
      display: {
        title: "Add a row to a table in a Google Doc",
        description: {
          description: "Add 1 row to table 1 of tab \"Main\" (tab-1).",
          fields: [{ label: "New row", kind: "text", value: "Ana" }],
        },
      },
    };
    expect(DOC_DEFINITIONS.insertTableRows.describe(rows, undefined as never)).toEqual({
      title: "Add a row to a table in a Google Doc",
      description: "Add 1 row to table 1 of tab \"Main\" (tab-1).",
      fields: [{ label: "New row", kind: "text", value: "Ana" }],
      implementsRevert: false,
    });
    expect(() => DOC_DEFINITIONS.insertTableRows.describe({ ...rows, display: undefined }, undefined as never))
      .toThrow("This Google Doc edit has no card to show.");

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

  // -------------------------------------------------------------------------
  // An edit built from the copy the connection holds
  // -------------------------------------------------------------------------

  it("builds an edit from the copy held and pins it to the copy's revision, reading no document", async () => {
    let held = googleDocSnapshot(docAt("r-copy", "Draft"));
    let { api, landed, spendCopy, docHost } = host(docAt("r-now", "Other"), undefined, held);
    await DOC_DEFINITIONS.appendText.apply(APPEND, docHost, { id: 4 });
    expect(api.getDocument).not.toHaveBeenCalled();
    expect(api.batchUpdate).toHaveBeenCalledTimes(1);
    expect(api.batchUpdate.mock.calls[0]).toMatchObject(
      ["doc-1", expect.any(Array), "r-copy", { name: "gadgets-write-w-1", tabId: "tab-1" }]);
    expect(spendCopy).toHaveBeenCalledWith(held);
    expect(landings(landed)).toEqual([{ id: 4, marker: { id: "marker-new", tabId: "tab-1" } }]);
  });

  it.each<[string, (api: ReturnType<typeof host>["api"]) => void]>([
    ["is answered", () => {}],
    ["is refused with INVALID_ARGUMENT", api => api.batchUpdate.mockRejectedValueOnce(STALE_PIN())],
    ["is refused with no status", api => api.batchUpdate.mockRejectedValueOnce(docsRefusal(undefined))],
    ["fails with a plain Error", api => api.batchUpdate.mockRejectedValueOnce(new Error("socket closed"))],
    ["is answered without a marker id",
      api => api.batchUpdate.mockResolvedValueOnce({ revisionId: "r-next", replies: [] })],
  ])("spends the copy before its batch leaves, when the batch %s", async (_name, arrange) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let held = googleDocSnapshot(docAt("r-copy", "Draft"));
    let { api, spendCopy, docHost } = host(docAt("r-now", "Draft"), undefined, held);
    arrange(api);
    await DOC_DEFINITIONS.appendText.apply(APPEND, docHost, { id: 4 }).catch(() => {});
    expect(spendCopy).toHaveBeenCalledTimes(1);
    expect(spendCopy).toHaveBeenCalledWith(held);
    expect(api.batchUpdate.mock.calls[0][2]).toBe("r-copy");
    expect(spendCopy.mock.invocationCallOrder[0])
      .toBeLessThan(api.batchUpdate.mock.invocationCallOrder[0]);
  });

  it("does not spend a copy it builds no batch from", async () => {
    // The copy holds the write's marker.
    let settled = host(docAt("r-now", "Draft"), undefined,
      googleDocSnapshot(withMarkers(docAt("r-copy", "Draft"), "w-1", "marker-1")));
    await DOC_DEFINITIONS.appendText.apply(APPEND, settled.docHost, { id: 4 });
    expect(settled.spendCopy).not.toHaveBeenCalled();

    // The copy cannot say.
    let unpinned = host(docAt("r-now", "Draft"), undefined,
      { ...googleDocSnapshot(docAt("r-copy", "Draft")), revisionId: undefined });
    await DOC_DEFINITIONS.appendText.apply(APPEND, unpinned.docHost, { id: 4 });
    expect(unpinned.spendCopy).not.toHaveBeenCalled();

    // An add of a tab.
    let added = host(docAt("r-now", "Draft"), undefined, googleDocSnapshot(docAt("r-copy", "Draft")));
    added.api.batchUpdate.mockResolvedValueOnce(ADDED_TAB_REPLY);
    await DOC_DEFINITIONS.addTab.apply(add("pending-tab-1", {}), added.docHost, { id: 4 });
    expect(added.spendCopy).not.toHaveBeenCalled();

    // A receipt waits.
    let waiting = host(docAt("r-now", "Draft"), { actionId: 9, markerId: "marker-old" },
      googleDocSnapshot(docAt("r-copy", "Draft")));
    await DOC_DEFINITIONS.appendText.apply(APPEND, waiting.docHost, { id: 4 });
    expect(waiting.spendCopy).not.toHaveBeenCalled();
    for (let { landed } of [settled, unpinned, added, waiting]) expect(landed).toHaveBeenCalledTimes(1);
  });

  it("reads the document and builds again when Google refuses the batch built from a stale copy", async () => {
    let warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let fresh = docAt("r-now", "Draft and what a collaborator wrote since");
    let { api, landed, docHost } = host(fresh, undefined, googleDocSnapshot(docAt("r-copy", "Draft")));
    api.batchUpdate.mockRejectedValueOnce(STALE_PIN());
    await DOC_DEFINITIONS.appendText.apply(APPEND, docHost, { id: 4 });

    expect(api.getDocument).toHaveBeenCalledTimes(1);
    expect(api.batchUpdate).toHaveBeenCalledTimes(2);
    let [[, staleRequests, staleRevision, staleMarker], [, requests, revision, marker]] =
      api.batchUpdate.mock.calls;
    expect(staleRevision).toBe("r-copy");
    expect(revision).toBe("r-now");
    // Built against the document as it is: the append goes at its end, past where the copy ended.
    expect(requests).toEqual(materializeDocEdit(fresh.tabs, APPEND).requests);
    expect(requests).not.toEqual(staleRequests);
    expect(marker!.rangeStart).toBeGreaterThan(staleMarker!.rangeStart);
    expect(landings(landed)).toEqual([{ id: 4, marker: { id: "marker-new", tabId: "tab-1" } }]);

    expect(copyRefusals(warn)).toHaveLength(1);
    expect(copyRefusals(warn)[0]).toMatchObject({
      actionId: 4, operation: "appendText", failure: "absent",
      providerStatus: "INVALID_ARGUMENT", fallback: "read",
    });
  });

  it("logs a batch built from the copy that was not accepted, with nothing of the document", async () => {
    let warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let replace: Replace = {
      ...BASE, type: "replaceText", oldMarkdown: "Quokka", newMarkdown: "Numbat", display: { tab: "x" },
    };
    let held = googleDocSnapshot(docAt("revision-wombat", "Quokka wanders"));
    let { api, docHost } = host(docAt("r-now", "Quokka wanders"), undefined, held);
    // A message Google's errors never have: the caught value is not what is logged.
    api.batchUpdate.mockRejectedValueOnce(
      new GoogleApiError("Google refused to move the Tamarin past Quokka", "INVALID_ARGUMENT"));
    await DOC_DEFINITIONS.replaceText.apply(replace, docHost, { id: 7 });

    let [line, ...more] = copyRefusals(warn);
    expect(more).toEqual([]);
    // Beside what the logger writes on every line, the line holds these fields and no other.
    let { component: _c, vendorId: _v, message: _m, level: _l, ...own } = line;
    expect(own).toStrictEqual({
      event: "google.doc.action.apply.copy-refused", actionId: 7, operation: "replaceText",
      failure: "absent", providerStatus: "INVALID_ARGUMENT", fallback: "read",
    });
    let written = JSON.stringify(line);
    for (let word of ["Quokka", "wanders", "Numbat", "Tamarin", "revision-wombat"]) {
      expect(written, word).not.toContain(word);
    }
  });

  it("logs nothing of the copy where no batch built from it fails", async () => {
    let warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let copy = () => googleDocSnapshot(docAt("r-copy", "Draft"));
    // The copy's batch is answered.
    await DOC_DEFINITIONS.appendText.apply(
      APPEND, host(docAt("r-now", "Draft"), undefined, copy()).docHost, { id: 4 });
    // The copy holds the write's marker.
    await DOC_DEFINITIONS.appendText.apply(APPEND, host(docAt("r-now", "Draft"), undefined,
      googleDocSnapshot(withMarkers(docAt("r-copy", "Draft"), "w-1", "marker-1"))).docHost, { id: 4 });
    // The copy cannot say.
    await DOC_DEFINITIONS.appendText.apply(APPEND, host(docAt("r-now", "Draft"), undefined,
      { ...copy(), revisionId: undefined }).docHost, { id: 4 });
    // An add of a tab.
    let added = host(docAt("r-now", "Draft"), undefined, copy());
    added.api.batchUpdate.mockResolvedValueOnce(ADDED_TAB_REPLY);
    await DOC_DEFINITIONS.addTab.apply(add("pending-tab-1", {}), added.docHost, { id: 4 });
    // No copy is held, and the batch built from the document is refused.
    let refused = host(docAt("r-now", "Draft"));
    refused.api.batchUpdate.mockRejectedValueOnce(STALE_PIN());
    await expect(DOC_DEFINITIONS.appendText.apply(APPEND, refused.docHost, { id: 4 })).rejects.toThrow();
    expect(copyRefusals(warn)).toEqual([]);
  });

  it("fails as it does on a fresh read when the document no longer takes the edit", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    let replace: Replace = {
      ...BASE, type: "replaceText", oldMarkdown: "Draft", newMarkdown: "Final", display: { tab: "x" },
    };
    let { api, landed, unapplyable, docHost } =
      host(docAt("r-now", "Rewritten"), undefined, googleDocSnapshot(docAt("r-copy", "Draft")));
    api.batchUpdate.mockRejectedValueOnce(STALE_PIN());
    let applied = DOC_DEFINITIONS.replaceText.apply(replace, docHost, { id: 2 });
    await expect(applied).rejects.toBeInstanceOf(ActionApplyError);
    await expect(applied).rejects.toThrow("oldMarkdown was not found");
    expect(unapplyable).toHaveBeenCalledWith(
      2, replace, expect.stringMatching(/^Pending Google Doc edit could not be applied: /));
    expect(api.batchUpdate).toHaveBeenCalledTimes(1);
    expect(landed).not.toHaveBeenCalled();
  });

  it.each<[string, () => Error, string, string | undefined]>([
    ["a failure that is no answer", () => new Error("socket closed"), "unknown", undefined],
    ["a refusal for rate", () => docsRefusal("RESOURCE_EXHAUSTED"), "rateLimited", "RESOURCE_EXHAUSTED"],
    ["a refusal that carries no status", () => docsRefusal(undefined), "unknown", undefined],
  ])("reads the document at the next approval, not in this one, after %s",
    async (_name, failed, failure, providerStatus) => {
      let warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // The document as the retry finds it: without the write's marker, and with it.
      for (let fresh of [docAt("r-now", "Draft"), withMarkers(docAt("r-now", "DraftMore"), "w-1", "marker-1")]) {
        warn.mockClear();
        let { api, landed, docHost } =
          host(fresh, undefined, googleDocSnapshot(docAt("r-copy", "Draft")));
        let error = failed();
        api.batchUpdate.mockRejectedValueOnce(error);
        await expect(DOC_DEFINITIONS.appendText.apply(APPEND, docHost, { id: 4 })).rejects.toBe(error);
        expect(api.getDocument).not.toHaveBeenCalled();
        expect(api.batchUpdate).toHaveBeenCalledTimes(1);
        expect(landed).not.toHaveBeenCalled();
        let [line, ...more] = copyRefusals(warn);
        expect(more).toEqual([]);
        expect(line).toMatchObject({ actionId: 4, operation: "appendText", failure, fallback: "retry" });
        expect(line.providerStatus).toBe(providerStatus);

        await DOC_DEFINITIONS.appendText.apply(APPEND, docHost, { id: 4 });
        expect(api.getDocument).toHaveBeenCalledTimes(1);
        if (fresh.tabs[0].namedRanges["gadgets-write-w-1"]) {
          expect(api.batchUpdate).toHaveBeenCalledTimes(1);
          expect(landings(landed)).toEqual([{ id: 4, marker: { id: "marker-1", tabId: "tab-1" } }]);
        } else {
          expect(api.batchUpdate).toHaveBeenCalledTimes(2);
          expect(api.batchUpdate.mock.calls[1][2]).toBe("r-now");
          expect(landings(landed)).toEqual([{ id: 4, marker: { id: "marker-new", tabId: "tab-1" } }]);
        }
        expect(copyRefusals(warn)).toHaveLength(1);
      }
    });

  it("settles from the marker the copy holds, writing and reading nothing", async () => {
    let held = googleDocSnapshot(withMarkers(docAt("r-copy", "DraftMore"), "w-1", "marker-1"));
    let { api, landed, docHost } = host(docAt("r-now", "DraftMore"), undefined, held);
    await DOC_DEFINITIONS.appendText.apply(APPEND, docHost, { id: 4 });
    expect(landings(landed)).toEqual([{ id: 4, marker: { id: "marker-1", tabId: "tab-1" } }]);
    expect(api.batchUpdate).not.toHaveBeenCalled();
    expect(api.getDocument).not.toHaveBeenCalled();
  });

  it("finds the marker in the document when the copy predates the write", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let fresh = withMarkers(docAt("r-now", "DraftMore"), "w-1", "marker-1");
    let { api, landed, docHost } = host(fresh, undefined, googleDocSnapshot(docAt("r-copy", "Draft")));
    // The write landed and moved the document past the copy.
    api.batchUpdate.mockRejectedValueOnce(STALE_PIN());
    await DOC_DEFINITIONS.appendText.apply(APPEND, docHost, { id: 4 });
    expect(landings(landed)).toEqual([{ id: 4, marker: { id: "marker-1", tabId: "tab-1" } }]);
    expect(api.batchUpdate).toHaveBeenCalledTimes(1);
    expect(api.getDocument).toHaveBeenCalledTimes(1);
  });

  it("reads the document while a receipt waits, and deletes its marker first", async () => {
    let fresh = withMarkers(docAt("r-now", "Draft"), "w-earlier", "marker-old");
    let { api, landed, spendCopy, docHost } = host(
      fresh, { actionId: 9, markerId: "marker-old" }, googleDocSnapshot(docAt("r-copy", "Draft")));
    await DOC_DEFINITIONS.appendText.apply(APPEND, docHost, { id: 4 });
    expect(spendCopy).not.toHaveBeenCalled();
    expect(api.deleteNamedRange).toHaveBeenCalledWith("doc-1", "marker-old", "tab-1");
    // Once to find the marker, and again without it.
    expect(api.getDocument).toHaveBeenCalledTimes(2);
    expect(api.deleteNamedRange.mock.invocationCallOrder[0])
      .toBeLessThan(api.batchUpdate.mock.invocationCallOrder[0]);
    expect(api.batchUpdate).toHaveBeenCalledTimes(1);
    expect(api.batchUpdate.mock.calls[0][2]).toBe("r-now");
    expect(landings(landed)).toEqual([{ id: 4, marker: { id: "marker-new", tabId: "tab-1" } }]);
  });

  it("reads the document for an add of a tab, whatever copy is held", async () => {
    let { api, landed, spendCopy, docHost } =
      host(docAt("r-now", "Draft"), undefined, googleDocSnapshot(docAt("r-copy", "Draft")));
    api.batchUpdate.mockResolvedValueOnce(ADDED_TAB_REPLY);
    await DOC_DEFINITIONS.addTab.apply(add("pending-tab-1", {}), docHost, { id: 4 });
    expect(api.getDocument).toHaveBeenCalledTimes(1);
    expect(spendCopy).not.toHaveBeenCalled();
    expect(api.batchUpdate).toHaveBeenCalledTimes(1);
    expect(api.batchUpdate.mock.calls[0][2]).toBe("r-now");
    expect(landings(landed)).toEqual([{
      id: 4, marker: { id: "marker-new", tabId: "tab-1" },
      addedTab: { provisionalTabId: "pending-tab-1", tabId: "tab-made" },
    }]);
  });

  /** The copy of "Draft" at `r-copy`, with its tabs read through `tab`. */
  const copyReadBy = (tab: (part: DocTabCopy) => DocTabCopy | undefined): GoogleDocSnapshot => {
    let snapshot = googleDocSnapshot(docAt("r-copy", "Draft"));
    let { outline } = snapshot.copy;
    return { ...snapshot, copy: { outline, tab: tabId => tab(snapshot.copy.tab(tabId)!) } };
  };
  const REPLACE_DRAFT: Replace = {
    ...BASE, type: "replaceText", oldMarkdown: "Draft", newMarkdown: "Final", display: { tab: "x" },
  };

  it.each<[string, () => GoogleDocSnapshot, Append | Replace, GoogleDocsDocument, "written" | "nothing to write"]>([
    ["has no revision", () => ({ ...googleDocSnapshot(docAt("r-copy", "Draft")), revisionId: undefined }),
      APPEND, docAt("r-now", "Draft"), "written"],
    ["has an empty revision", () => googleDocSnapshot(docAt("", "Draft")),
      APPEND, docAt("r-now", "Draft"), "written"],
    ["lacks the edit's tab", () => googleDocSnapshot({
      ...docAt("r-copy", "Draft"), tabs: [{ ...docAt("r-copy", "Draft").tabs[0], tabId: "tab-9" }],
    }), APPEND, docAt("r-now", "Draft"), "written"],
    ["cannot index it", () => copyReadBy(part => ({ ...part, unindexed: true })),
      APPEND, docAt("r-now", "Draft"), "written"],
    ["throws reading it back", () => copyReadBy(() => { throw new Error(DOC_COPY_UNREADABLE); }),
      APPEND, docAt("r-now", "Draft"), "written"],
    // The copy lacks the text the edit replaces, and the document holds it.
    ["refuses the edit", () => googleDocSnapshot(docAt("r-copy", "Sketch")),
      REPLACE_DRAFT, docAt("r-now", "Draft"), "written"],
    ["builds no request for it", () => googleDocSnapshot(docAt("r-copy", "Draft")),
      { ...REPLACE_DRAFT, newMarkdown: "Draft" }, docAt("r-now", "Draft"), "nothing to write"],
    ["holds two markers of the write",
      () => googleDocSnapshot(withMarkers(docAt("r-copy", "Draft"), "w-1", "marker-1", "marker-2")),
      APPEND, docAt("r-now", "Draft"), "written"],
  ])("reads the document when the copy %s", async (_name, held, action, fresh, outcome) => {
    let { api, landed, spendCopy, docHost } = host(fresh, undefined, held());
    await docDefinition(action).apply(action, docHost, { id: 4 });
    expect(api.getDocument).toHaveBeenCalledTimes(1);
    expect(spendCopy).not.toHaveBeenCalled();
    if (outcome === "written") {
      // Whatever the copy's revision, the one batch sent is pinned to the document's.
      expect(api.batchUpdate.mock.calls.map(([, , revision]) => revision)).toEqual(["r-now"]);
      expect(landings(landed)).toEqual([{ id: 4, marker: { id: "marker-new", tabId: "tab-1" } }]);
    } else {
      expect(api.batchUpdate).not.toHaveBeenCalled();
      expect(landings(landed)).toEqual([{ id: 4 }]);
    }
  });
});

describe("how long a revision id pins a write", () => {
  it("pins for 24 hours after Google returned it, and not a millisecond longer", () => {
    expect(DOC_REVISION_PIN_MS).toBe(24 * 60 * 60 * 1000);
    let t = Date.UTC(2026, 0, 1);
    expect(docRevisionPins(t, t)).toBe(true);
    expect(docRevisionPins(t, t + DOC_REVISION_PIN_MS - 1)).toBe(true);
    expect(docRevisionPins(t, t + DOC_REVISION_PIN_MS)).toBe(true);
    expect(docRevisionPins(t, t + DOC_REVISION_PIN_MS + 1)).toBe(false);

    // With no time given, the clock is read.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(t + DOC_REVISION_PIN_MS);
    expect(docRevisionPins(t)).toBe(true);
    vi.setSystemTime(t + DOC_REVISION_PIN_MS + 1);
    expect(docRevisionPins(t)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The copy held and a fresh read build the same batch
// ---------------------------------------------------------------------------

const GENERATED_LISTS: GoogleDocsTab["lists"] = {
  bullets: { listProperties: { nestingLevels: presetLevels() } },
  numbers: { listProperties: { nestingLevels: presetLevels(true) } },
};

/**
 * The style of a run in an explicit font: bold, which a text style request of the builders
 * names, beside fields the copy does not keep.
 */
const EXPLICIT_FONT = {
  bold: true, smallCaps: true,
  weightedFontFamily: { fontFamily: "Lora", weight: 700 },
  backgroundColor: { color: { rgbColor: { red: 1, green: 0.9, blue: 0.6 } } },
};

/** A tab of a generated document, with the words its generators name. */
type GeneratedTab = {
  tab: GoogleDocsTab;
  /** The word of the paragraph whose run is in an explicit font. */
  fonted: string;
  /** The word of each paragraph outside the tables, the items of its lists among them. */
  paragraphs: string[];
  /** The words of the paragraphs that are no item of a list. */
  prose: string[];
  /** The tables no cell of which is merged: the index among the tab's tables, and the cells' words. */
  tables: { at: number; cells: string[][] }[];
};

/** A generated document as Google returns it. Every word in it is there once. */
type Generated = {
  document: GoogleDocsDocument;
  /** The tabs that hold text. The first one's first table has a merged region at its first cell. */
  tabs: GeneratedTab[];
  blank: GoogleDocsTab;
  /** A word the document does not hold. */
  word: () => string;
  /** The stored edit `edit` of `tab`, under a write id of its own. */
  stored: (tab: GoogleDocsTab, edit: DocEdit) => GoogleDocEditAction;
};

/**
 * A document of one or two tabs of text and a blank one, drawn from `dice`: paragraphs, one of
 * them in an explicit font, a heading, two lists and one or two tables of drawn sizes in each, a
 * merged region in the first tab, and named ranges the copy does not keep (one that marks no
 * write, one of another write).
 */
function generatedDocument(dice: Dice, seed: number): Generated {
  let fresh = 0;
  let writes = 0;
  let tabs = Array.from({ length: 1 + dice.below(2) }, (_, index): GeneratedTab => {
    let count = 0;
    let word = () => `${"ab"[index]}w${String(count++).padStart(3, "0")}`;
    let paragraphs: string[] = [];
    let prose: string[] = [];
    let outside = (words = prose) => {
      let text = word();
      paragraphs.push(text);
      if (words === prose) prose.push(text);
      return text;
    };
    let listed = (listId: string) => ({ runs: [`${outside([])}\n`], bullet: { listId } });
    let tables: GeneratedTab["tables"] = [];
    let fonted = word();
    let blocks: BlockSpec[] = [
      para(outside()), listed("bullets"), listed("bullets"),
      { runs: [`${outside()}\n`], namedStyleType: "HEADING_2" },
      { runs: [{ text: `${fonted}\n`, style: EXPLICIT_FONT }] },
    ];
    let table = (plain: boolean) => {
      let columns = 2 + dice.below(2);
      let cells = Array.from({ length: 2 + dice.below(3) }, () => Array.from({ length: columns }, word));
      if (plain) tables.push({ at: blocks.filter(block => "table" in block).length, cells });
      blocks.push(grid(...cells), para(outside()));
    };
    // The first tab's first table is the one a region is merged in.
    if (index === 0) table(false);
    blocks.push(listed("numbers"), listed("numbers"), para(outside()));
    for (let more = 1 + dice.below(2); more > 0; more--) table(true);
    let tab: GoogleDocsTab = {
      ...buildTab(blocks, GENERATED_LISTS), tabId: `tab-${index + 1}`, title: `Tab ${index + 1}`, index,
    };
    if (index === 0) {
      tab = {
        ...applyDocEdit(tab, prepareTableChange(tab, {
          method: "mergeTableCells", cells: { table: 0, row: 0, column: 0, rows: 1, columns: 2 },
        }, "x").change),
        namedRanges: {
          "someone's": { namedRanges: [{ namedRangeId: "range.1", name: "someone's" }] },
          "gadgets-write-earlier": {
            namedRanges: [{ namedRangeId: "range.2", name: "gadgets-write-earlier" }],
          },
        },
      };
    }
    return { tab, fonted, paragraphs, prose, tables };
  });
  let blank = { ...blankDocsTab("tab-blank", "Blank"), index: tabs.length };
  return {
    document: {
      documentId: "doc-1", title: "Plan", revisionId: `revision-${seed}`,
      tabs: [...tabs.map(({ tab }) => tab), blank],
    },
    tabs, blank,
    word: () => `nw${String(fresh++).padStart(3, "0")}`,
    stored: (tab, edit) => ({ ...BASE, tabId: tab.tabId, writeId: `w-${seed}-${writes++}`, ...edit }),
  };
}

/** A tab of `generated` and one of its tables that has no merged cell. */
function drawnTable(dice: Dice, generated: Generated) {
  let { tab, tables } = dice.pick(generated.tabs);
  let { at, cells } = dice.pick(tables);
  return { tab, at, cells, row: dice.below(cells.length), column: dice.below(cells[0].length) };
}

/** The stored change `call` makes to a table of `tab`, recording the table as the tab has it. */
const tableChangeOf = (generated: Generated, tab: GoogleDocsTab, call: TableCall) =>
  generated.stored(tab, prepareTableChange(tab, call, "x").change);

/**
 * The edits compared for each kind, drawn against a generated document. A kind added to
 * `DocEdit` fails the type check here until it has a generator.
 */
const EDITS = {
  replaceText(dice, generated) {
    let outside = dice.pick(generated.tabs);
    let { tab, cells, row, column } = drawnTable(dice, generated);
    let cell = `<p>${cells[row][column]}</p>`;
    let replacement = `<p>${generated.word()}</p>`;
    expect(prepareTextReplacement(tab, cell, replacement, "x").inTable).toBe(true);
    return [
      generated.stored(outside.tab, {
        type: "replaceText", oldMarkdown: dice.pick(outside.paragraphs), newMarkdown: generated.word(),
      }),
      generated.stored(tab, {
        type: "replaceText", oldMarkdown: cell, newMarkdown: replacement, inTable: true,
      }),
      // Inside the run in an explicit font, whose style the text written takes.
      generated.stored(outside.tab, {
        type: "replaceText", oldMarkdown: outside.fonted, newMarkdown: generated.word(),
      }),
    ];
  },
  appendText: (dice, generated) => [
    generated.stored(dice.pick(generated.tabs).tab, {
      type: "appendText", markdown: `${dice.pick(["", "- ", "1. "])}${generated.word()}`,
    }),
    generated.stored(generated.blank, { type: "appendText", markdown: generated.word() }),
  ],
  insertTable(dice, generated) {
    let { tab, prose } = dice.pick(generated.tabs);
    return [tableChangeOf(generated, tab, {
      method: "insertTable",
      table: {
        rows: 1 + dice.below(2), columns: 2, cells: [[generated.word(), generated.word()]],
        ...(dice.random() < 0.5 ? { after: dice.pick(prose) } : {}),
      },
    })];
  },
  insertTableRows(dice, generated) {
    let { tab, at, cells } = drawnTable(dice, generated);
    return [tableChangeOf(generated, tab, {
      method: "insertTableRows",
      lines: { table: at, at: dice.below(cells.length + 1), cells: [cells[0].map(generated.word)] },
    })];
  },
  insertTableColumns(dice, generated) {
    let { tab, at, cells } = drawnTable(dice, generated);
    return [tableChangeOf(generated, tab, {
      method: "insertTableColumns",
      lines: {
        table: at, at: dice.below(cells[0].length + 1), cells: cells.map(() => [generated.word()]),
      },
    })];
  },
  deleteTableRows(dice, generated) {
    let { tab, at, row } = drawnTable(dice, generated);
    return [tableChangeOf(generated, tab, { method: "deleteTableRows", lines: { table: at, at: row } })];
  },
  deleteTableColumns(dice, generated) {
    let { tab, at, column } = drawnTable(dice, generated);
    return [tableChangeOf(
      generated, tab, { method: "deleteTableColumns", lines: { table: at, at: column } })];
  },
  deleteTable(dice, generated) {
    let { tab, at } = drawnTable(dice, generated);
    return [tableChangeOf(generated, tab, { method: "deleteTable", table: at })];
  },
  mergeTableCells(dice, generated) {
    let { tab, at, cells } = drawnTable(dice, generated);
    let across = dice.random() < 0.5;
    return [tableChangeOf(generated, tab, {
      method: "mergeTableCells",
      cells: across
        ? { table: at, row: dice.below(cells.length), column: dice.below(cells[0].length - 1), rows: 1, columns: 2 }
        : { table: at, row: dice.below(cells.length - 1), column: dice.below(cells[0].length), rows: 2, columns: 1 },
    })];
  },
  // The region merged in the first tab's first table.
  unmergeTableCells: (_dice, generated) => [tableChangeOf(generated, generated.tabs[0].tab, {
    method: "unmergeTableCells", cell: { table: 0, row: 0, column: 0 },
  })],
  setTableCellStyle(dice, generated) {
    let { tab, at, row, column } = drawnTable(dice, generated);
    return [tableChangeOf(generated, tab, {
      method: "setTableCellStyle",
      cells: { table: at, row, column, style: { background: `#${String(100000 + dice.below(899999))}` } },
    })];
  },
  setTableColumnWidths(dice, generated) {
    let { tab, at, column } = drawnTable(dice, generated);
    return [tableChangeOf(generated, tab, {
      method: "setTableColumnWidths", columns: { table: at, at: column, width: 40 + dice.below(100) },
    })];
  },
  setTableRowHeights(dice, generated) {
    let { tab, at, row } = drawnTable(dice, generated);
    return [tableChangeOf(generated, tab, {
      method: "setTableRowHeights", rows: { table: at, at: row, height: 20 + dice.below(40) },
    })];
  },
} satisfies Record<DocEdit["type"], (dice: Dice, generated: Generated) => GoogleDocEditAction[]>;

type BatchCall = Parameters<GoogleDocsApi["batchUpdate"]>;

/**
 * The batch `call` sends as Google reads it, and what it does not read. A text style request
 * sets the fields its mask names and no other, so each one's style is cut to those in `call`,
 * and the fields cut are `unread`.
 */
function asGoogleReads([documentId, requests, ...pinAndMarker]: BatchCall) {
  let unread: string[] = [];
  let read = requests.map(request => {
    if (!("updateTextStyle" in request)) return request;
    let { textStyle, fields } = request.updateTextStyle;
    let named = fields.split(",");
    let set = Object.entries(textStyle).filter(([field]) => {
      if (!named.includes(field)) unread.push(field);
      return named.includes(field);
    });
    return { updateTextStyle: { ...request.updateTextStyle, textStyle: Object.fromEntries(set) } };
  });
  return { call: [documentId, read, ...pinAndMarker], unread };
}

// The copy keeps what the builders read of a tab, so the batch an approval builds from it is the
// batch it builds from the document at the same revision, but for one thing: a text style request
// carries the whole style of the run it was read from, of which the copy keeps a part. The mask
// of the request names the fields Google sets, the copy keeps each of those, and the two batches
// are compared as Google reads them. Held here for documents and edits nobody wrote by hand.
describe("a Doc edit built from the copy held and from a fresh read", () => {
  const SEEDS = Array.from({ length: 25 }, (_, index) => index + 1);
  /** How many edits of each kind were compared. */
  const compared = new Map<string, number>();
  /** The style fields the fresh read's batches carried unread that the copy's did not. */
  const dropped = new Set<string>();

  it.each(SEEDS)("is the same batch, pinned to the same revision (seed %i)", async seed => {
    let dice = diceOf(seed);
    let generated = generatedDocument(dice, seed);
    for (let [kind, edits] of Object.entries(EDITS)) {
      for (let action of edits(dice, generated)) {
        let fresh = host(generated.document);
        let copy = host(generated.document, undefined, googleDocSnapshot(generated.document));
        // An edit the document refuses, or that changes nothing in it, is a defect of the
        // generator: it fails here, and is never left out.
        await docDefinition(action).apply(action, fresh.docHost, { id: 4 });
        await docDefinition(action).apply(action, copy.docHost, { id: 4 });
        expect(fresh.api.batchUpdate, kind).toHaveBeenCalledTimes(1);
        expect(copy.api.getDocument, kind).not.toHaveBeenCalled();
        expect(copy.api.batchUpdate, kind).toHaveBeenCalledTimes(1);
        let fromFresh = asGoogleReads(fresh.api.batchUpdate.mock.calls[0]);
        let fromCopy = asGoogleReads(copy.api.batchUpdate.mock.calls[0]);
        // The document, the requests, the revision and the marker's name, place and tab.
        expect(fromCopy.call, kind).toStrictEqual(fromFresh.call);
        for (let field of fromFresh.unread) if (!fromCopy.unread.includes(field)) dropped.add(field);
        // No batch built from the copy leaves unpinned.
        let [, , pin] = copy.api.batchUpdate.mock.calls[0];
        expect(pin, kind).toBe(`revision-${seed}`);
        expect(landings(copy.landed), kind).toEqual(landings(fresh.landed));
        compared.set(kind, (compared.get(kind) ?? 0) + 1);
      }
    }
  });

  it("compared every kind", () => {
    for (let kind of Object.keys(EDITS)) {
      expect(compared.get(kind) ?? 0, kind).toBeGreaterThanOrEqual(SEEDS.length);
    }
  });

  it("differs from the fresh read's only in style fields no mask names", () => {
    expect(dropped).toEqual(new Set(["backgroundColor", "smallCaps", "weightedFontFamily"]));
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

const TABLE: BlockSpec[] = [para("Before"), grid(["a", "b"], ["c", "d"]), para("After")];
/** The identity of the one table of `TABLE`, as a change to it records it. */
const TABLE_IDENTITY = tableIdentity(tableAt(docTabToMarkdown(buildTab(TABLE)), 0));
const STALE_IDENTITY = tableIdentity(docTabToMarkdown(buildTab([grid(["gone"])])).markdown.trim());

/** A table change of tab `tabId`: rows added to, or deleted from, the table that reads `expected`. */
function tableChange(
  tabId: string, type: "insertTableRows" | "deleteTableRows", expected = TABLE_IDENTITY,
): GoogleDocAction {
  return type === "insertTableRows"
    ? { ...BASE, tabId, type, at: 1, cells: [["x", "y"]], expected }
    : { ...BASE, tabId, type, at: 0, count: 1, expected };
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

  it.each(INVALIDATORS)(
    "leaves out a record that carries a reason, and one it invalidated, in a queue that %s",
    invalidator => {
      // A record that carries a reason is never reduced, whatever it would do.
      let stale = { invalidatedReason: "It was dropped." };
      let carried = countedQueue([
        { id: 1, action: { ...tableChange("tab-1", "deleteTableRows", STALE_IDENTITY), ...stale } },
        { id: 2, action: { ...add("pending-tab-a", {}), ...stale } },
        { id: 3, action: { ...appendTo("pending-tab-a", "First words"), ...stale } },
        { id: 4, action: tableChange("tab-1", "insertTableRows") },
      ], invalidator);
      let tabled = googleDocSnapshot(documentOf(TABLE)).copy;
      let read = spending(() => {
        let replay = replayGoogleDoc(carried.queue, tabled, REPLAY_CONTEXT);
        expect(replay.outline.map(({ tabId }) => tabId)).toEqual(["tab-1"]);
        return markdownOf(replay, "tab-1");
      });
      expect(read.folds).toBe(1);
      expect(read.value).toContain("<td><p>x</p></td>");
      expect(carried.reasons.size).toBe(0);

      // An edit the tab tree refused is not reduced again by the fold of the only tab, though a
      // queue that removes it leaves the record in hand as it was.
      let refused = countedQueue([
        { id: 1, action: add("pending-tab-a", {}) },
        { id: 2, action: unnamed(appendTo("tab-1", "More")) },
      ], invalidator);
      let one = googleDocSnapshot(document("Draft")).copy;
      let made = spending(() => replayGoogleDoc(refused.queue, one, REPLAY_CONTEXT));
      expect(made.folds).toBe(2);
      expect([...refused.reasons]).toEqual([[2, dropped(PREDATES_TABS)]]);
      expect(spending(() => markdownOf(made.value, "tab-1"))).toMatchObject({ value: "Draft\n", folds: 0 });
      expect(refused.reasons.size).toBe(1);
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

  it("refuses the table changes behind a refused one in its tab, and none in another tab", () => {
    let copy = googleDocSnapshot(documentOf(TABLE, TABLE)).copy;
    let pending = [
      { id: 1, action: tableChange("tab-1", "deleteTableRows", STALE_IDENTITY) },
      { id: 2, action: tableChange("tab-1", "insertTableRows") },
      { id: 3, action: tableChange("tab-2", "insertTableRows") },
      { id: 4, action: appendTo("tab-1", "More") },
    ];
    let replay = replayGoogleDoc(countedQueue(pending).queue, copy, REPLAY_CONTEXT);
    expect(markdownOf(replay, "tab-1")).not.toContain("<td><p>x</p></td>");
    expect(markdownOf(replay, "tab-1")).toContain("More\n");
    expect(markdownOf(replay, "tab-2")).toContain("<td><p>x</p></td>");
    expect(pending[0].action.invalidatedReason).toMatch(
      new RegExp(`^${REPLAY_CONTEXT}: deleteTableRows: `));
    expect(pending[1].action.invalidatedReason)
      .toBe(dropped(tableGateRefusal("insertTableRows").message));
    expect(pending[2].action.invalidatedReason).toBeUndefined();
    expect(pending[3].action.invalidatedReason).toBeUndefined();
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
      writes: () => 0, newestQueued: () => newest, revisionMoves: () => 0,
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

/** A source over a stub Google that counts its requests, with the document at revision `r<n>`. */
function countedSource() {
  let state = { revision: 1, gets: 0, probes: 0, writes: 0, newest: 0, moves: 0 };
  let docsApi = {
    getDocument: async () => { state.gets++; return docAt(`r${state.revision}`, "Draft"); },
    getRevisionId: async () => { state.probes++; return `r${state.revision}`; },
  } as unknown as GoogleDocsApi;
  let source = driveDocSource(docsApi, {} as DriveApi, "doc-1", {
    writes: () => state.writes, newestQueued: () => state.newest,
    revisionMoves: () => state.moves,
  });
  return { state, source };
}

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
      writes: () => 0, newestQueued: () => newest, revisionMoves: () => 0,
    });
    let first = await source.snapshot();
    source.approved(first);
    expect(await source.snapshot()).toBe(first);
    newest = 4;
    expect((await source.snapshot()).revisionId).toBe("r2");
    expect(calls).toBe(2);
  });

  const T = Date.UTC(2026, 0, 1);

  it("is held for a write only while a read could reuse it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T);
    let { state, source } = countedSource();
    expect(source.held()).toBeUndefined();
    let first = await source.snapshot();
    // No read that used it is authorized yet.
    expect(source.held()).toBeUndefined();
    source.approved(first);
    expect(source.held()).toBe(first);
    // Past the TTL too: the pin to its revision is the check, and nothing is asked.
    vi.setSystemTime(T + DOC_SNAPSHOT_TTL_MS + 1);
    expect(source.held()).toBe(first);
    expect(state).toMatchObject({ gets: 1, probes: 0 });

    state.writes = 1;
    expect(source.held()).toBeUndefined();
    let second = await source.snapshot();
    source.approved(second);
    expect(source.held()).toBe(second);
    state.newest = 4;
    expect(source.held()).toBeUndefined();
  });

  // Deleting a write's marker moves the revision, and so does a suggestion of the binding's own.
  it("is not held for a write once the binding moved the revision since its fetch began, and is still read", async () => {
    let { state, source } = countedSource();
    let first = await source.snapshot();
    source.approved(first);
    state.moves = 1;
    expect(source.held()).toBeUndefined();
    expect(await source.snapshot()).toBe(first);
    expect(state).toMatchObject({ gets: 1, probes: 0 });

  });

  it("is not held for a write when the binding moved the revision while its fetch was out", async () => {
    let moves = 0;
    let release: (() => void) | undefined;
    let docsApi = {
      getDocument: async () => {
        let answered = docAt("r1", "Draft");
        await new Promise<void>(resolve => { release = resolve; });
        return answered;
      },
    } as unknown as GoogleDocsApi;
    let source = driveDocSource(docsApi, {} as DriveApi, "doc-1", {
      writes: () => 0, newestQueued: () => 0, revisionMoves: () => moves,
    });
    let fetched = source.snapshot();
    await vi.waitFor(() => expect(release).toBeDefined());
    moves = 1;
    release!();
    let snapshot = await fetched;
    source.approved(snapshot);
    expect(source.held()).toBeUndefined();
    // A read reuses it all the same.
    expect(await source.snapshot()).toBe(snapshot);
  });

  it("is held for a write for 24 hours after it was fetched, whatever confirmed it since", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T);
    let { state, source } = countedSource();
    let first = await source.snapshot();
    source.approved(first);
    vi.setSystemTime(T + DOC_REVISION_PIN_MS);
    expect(source.held()).toBe(first);
    vi.setSystemTime(T + DOC_REVISION_PIN_MS + 1);
    expect(source.held()).toBeUndefined();
    expect(state).toMatchObject({ gets: 1, probes: 0 });

    // A read past the TTL confirms the revision and is served the same snapshot, dated now.
    expect(await source.snapshot()).toBe(first);
    expect(state).toMatchObject({ gets: 1, probes: 1 });
    expect(first.fetchedAt).toBe(T + DOC_REVISION_PIN_MS + 1);
    // The confirmation did not make the revision id younger, and reads go on reusing it.
    expect(source.held()).toBeUndefined();
    expect(await source.snapshot()).toBe(first);
    expect(state).toMatchObject({ gets: 1, probes: 1 });

    // A snapshot fetched since is held.
    state.writes = 1;
    let second = await source.snapshot();
    expect(second).not.toBe(first);
    source.approved(second);
    expect(source.held()).toBe(second);
  });

  it("is not held again once a batch was built from it, and is still read", async () => {
    let { state, source } = countedSource();
    let first = await source.snapshot();
    source.approved(first);
    source.spend(first);
    expect(source.held()).toBeUndefined();
    source.approved(first);
    expect(source.held()).toBeUndefined();
    expect(await source.snapshot()).toBe(first);
    expect(state).toMatchObject({ gets: 1, probes: 0 });

    state.newest = 4;
    let second = await source.snapshot();
    source.approved(second);
    expect(source.held()).toBe(second);
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
