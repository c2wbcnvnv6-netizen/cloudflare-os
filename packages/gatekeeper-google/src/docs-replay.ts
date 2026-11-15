// Pending edits to a Google Doc, replayed on the gatekeeper's copy of it: the one place an edit
// becomes `documents.batchUpdate` requests, for approval and for replay alike, the edit made in
// a tab by the model of Google Docs, and the reducer that folds one tab's edits over that tab of
// the copy.
// Everything here is pure but for the counts of what it spends (`replayCost`) and what it
// remembers of the tabs it was given (a tab's rendering, and the last edit made in it): nothing
// reads storage, logs, or changes a tab it was given.

import type { SimulationStoreOptions } from "@gadgets/gatekeeper-kit/simulation-store";
import type { GoogleDocsRequest, GoogleDocsTab } from "./docs-api";
import {
  applyDocsRequests, NotModelledError, replayCost, sameValue, unindexedTabRefusal,
} from "./docs-model";
import type { DocTabCopy } from "./docs-replica";
import {
  closesTableGate, commonPrefix, commonSuffix, namesTable, tableChangeRequests, tableGateRefusal,
  textReplacementRequests, type TableChange,
} from "./docs-tables";
import {
  docTabToMarkdown, lineStart, markdownToDocRequests, MARKDOWN_RENDERING_VERSION,
  REPLAYABLE_TEXT_EDIT_VERSIONS, type DocTabSnapshot,
} from "./markdown-converter";

/** An edit to one tab, as it is stored with its pending action and as approval sends it. */
export type DocEdit =
  | {
    type: "replaceText";
    oldMarkdown: string;
    newMarkdown: string;
    /**
     * Set when the replacement was queued as a change to the text of table cells. Such an edit
     * applies only while its text is still in a table; any other applies outside tables.
     */
    inTable?: true;
  }
  | { type: "appendText"; markdown: string }
  | TableChange;

/** What replay reads of a stored action beside its edit. */
export type QueuedDocEdit = DocEdit & {
  /** The tab the edit targets. Absent only on records stored before tabs could be named. */
  tabId?: string;
  /** Why the edit no longer applies, once something found that it does not. */
  invalidatedReason?: string;
  /** The Markdown version the edit was previewed under. */
  markdownVersion?: number;
  /** Names the write, and its marker in the document once it is sent. */
  writeId?: string;
};

/** One pending action of a document, as the journal lists it. */
export type QueuedDocRecord = { readonly id: number; readonly action: QueuedDocEdit };

// ---------------------------------------------------------------------------
// The tab an edit targets
// ---------------------------------------------------------------------------

/**
 * The tab an operation names among `tabs`, or a refusal telling the agent how to name one;
 * `operation` is the session method, as the refusal names it. Omission is resolved from the
 * flattened tab list, so a single root with any child counts as multi-tab. An unknown id never
 * falls back to the first tab: the caller meant a specific one.
 */
export function resolveDocTab<T extends { tabId: string }>(
  tabs: readonly T[], tabId: string | undefined, operation: string,
): T {
  if (tabId === undefined) {
    if (tabs.length !== 1) {
      throw new Error(
        `${operation}: tabId is required for documents with multiple tabs. ` +
        `Call listTabs() to choose a tab.`);
    }
    return tabs[0];
  }
  let tab = tabs.find(candidate => candidate.tabId === tabId);
  if (!tab) {
    throw new Error(
      `${operation}: no tab with ID "${tabId}" exists in this document. ` +
      `Call listTabs() to refresh the tab list.`);
  }
  return tab;
}

/**
 * The tab a stored edit targets. A record stored before tabs could be named names none; it was
 * approved against a document of one tab, so it resolves while the document still has one, and
 * is refused once it has more.
 */
export function docEditTab<T extends { tabId: string }>(tabs: readonly T[], action: QueuedDocEdit): T {
  if (action.tabId === undefined && tabs.length !== 1) {
    throw new Error(
      "Pending Google Doc edit predates tab support and the document has gained tabs since, " +
      "so the tab it was approved against is unknown. Reject it and retry on a selected tab.");
  }
  return resolveDocTab(tabs, action.tabId, action.type);
}

/**
 * Throws for a stored edit that no longer replays: with its stored reason when it has one, and
 * otherwise unless it was previewed under the current Markdown version, or is a text edit (a
 * replacement outside tables, an append) previewed under an earlier version that reads the same
 * outside tables (`REPLAYABLE_TEXT_EDIT_VERSIONS`).
 */
export function assertDocEditReplayable(action: QueuedDocEdit): void {
  if (action.invalidatedReason) throw new Error(action.invalidatedReason);
  let { markdownVersion } = action;
  if (markdownVersion === MARKDOWN_RENDERING_VERSION) return;
  let textEdit = action.type === "replaceText" || action.type === "appendText";
  if (!textEdit || markdownVersion === undefined ||
      !REPLAYABLE_TEXT_EDIT_VERSIONS.includes(markdownVersion)) {
    throw new Error(
      "Pending Google Doc edit was queued under an earlier Markdown format and may no longer " +
      "apply as previewed. Reject it and retry.");
  }
}

const renderings = new WeakMap<GoogleDocsTab, DocTabSnapshot>();

/** The Markdown rendering of a tab. Remembered for the tab object, which is never changed. */
export function renderTab(tab: GoogleDocsTab): DocTabSnapshot {
  let rendering = renderings.get(tab);
  if (!rendering) {
    replayCost.renders++;
    renderings.set(tab, rendering = docTabToMarkdown(tab));
  }
  return rendering;
}

// ---------------------------------------------------------------------------
// An edit as requests
// ---------------------------------------------------------------------------

/**
 * The start of the one place `oldMarkdown` stands in `markdown`. Throws the refusal of a
 * replacement whose text is empty, is not there, or is there more than once.
 */
export function findUniqueMarkdown(markdown: string, oldMarkdown: string, tabId: string): number {
  if (oldMarkdown.length === 0) {
    throw new Error("replaceText: oldMarkdown must not be empty.");
  }

  let index = markdown.indexOf(oldMarkdown);
  if (index === -1) {
    throw new Error(
      `replaceText: oldMarkdown was not found in the current simulated tab "${tabId}". ` +
      `Make sure the text exactly matches content returned by getContent("${tabId}").`);
  }

  let secondIndex = markdown.indexOf(oldMarkdown, index + 1);
  if (secondIndex !== -1) {
    throw new Error(
      `replaceText: oldMarkdown matches multiple locations in the current simulated tab ` +
      `"${tabId}". Include more surrounding context to make the match unique.`);
  }

  return index;
}

/**
 * Whether `render` is of a tab with no content: no text and nothing protected. An append to such
 * a tab writes the tab's whole text, where to any other it adds a paragraph after the last. A
 * tab whose only content renders as nothing (a chip with no label) is protected, so it is not
 * blank. Empty Markdown counts as `"\n"` does: a tab keeps its final paragraph whatever is
 * removed from it.
 */
export function isBlankDocTab(render: DocTabSnapshot): boolean {
  return (render.markdown === "" || render.markdown === "\n") &&
    render.sourceMap.protectedRanges.length === 0;
}

/**
 * The `documents.batchUpdate` requests that make `edit` in the tab `render` renders: the one
 * place an edit becomes requests. Approval sends them and replay applies them to the copy, so
 * a read of a pending edit and its approval come from the same requests. Throws the refusal of
 * an edit the tab does not take, in the words the caller reads; an edit that changes nothing
 * gives none.
 */
export function docEditRequests(render: DocTabSnapshot, edit: DocEdit): GoogleDocsRequest[] {
  switch (edit.type) {
    case "replaceText": {
      let { oldMarkdown, newMarkdown, inTable } = edit;
      let matchStart = findUniqueMarkdown(render.markdown, oldMarkdown, render.tabId);
      return textReplacementRequests(
        render, { matchStart, oldMarkdown, newMarkdown, ...(inTable ? { inTable } : {}) });
    }
    case "appendText": {
      if (render.sourceMap.blocks.at(-1)?.docEnd !== render.bodyEndIndex) {
        throw new Error(
          "appendText: the selected tab does not end in a paragraph. " +
          "Add a paragraph after its final table or structural element and retry.");
      }
      let index = render.bodyEndIndex - 1;
      return isBlankDocTab(render)
        ? markdownToDocRequests(edit.markdown, index, render.tabId, { resetParagraphs: true })
        : markdownToDocRequests("\n" + edit.markdown, index, render.tabId, {
          resetParagraphs: true, preserveLeadingParagraph: true,
          tabBlocks: render.sourceMap.blocks,
        });
    }
    default:
      return tableChangeRequests(render, edit);
  }
}

/**
 * The stored edit `action` against the document's tabs as fetched: the tab it targets, rendered,
 * and the requests approval sends. Throws what replay refuses the edit with: its stored reason,
 * an earlier Markdown version that no longer replays, a tab that is gone, or a builder's refusal.
 */
export function materializeDocEdit(
  tabs: readonly GoogleDocsTab[], action: QueuedDocEdit,
): { tab: DocTabSnapshot; requests: GoogleDocsRequest[] } {
  assertDocEditReplayable(action);
  let tab = renderTab(docEditTab(tabs, action));
  return { tab, requests: docEditRequests(tab, action) };
}

// ---------------------------------------------------------------------------
// An edit made in a tab
// ---------------------------------------------------------------------------

/**
 * Thrown by `applyDocRequests` where the model of Google Docs did not apply a batch. The message
 * is the refusal the caller reads; `cause` is what the model threw.
 */
export class DocModelError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "DocModelError";
  }
}

const NOT_SHOWN_TAIL = "so it cannot be made through this connection. Make it in Google Docs.";

/** The refusal of the batch `operation` made, worded by what the model threw for it. */
function modelRefusal(operation: string, thrown: unknown): string {
  if (thrown instanceof NotModelledError) {
    return `${operation}: this change cannot be shown as it will read once applied ` +
      `(${thrown.what}), ${NOT_SHOWN_TAIL}`;
  }
  // The model throws a plain `Error`, in Google's words, where Google would refuse the batch.
  if (thrown instanceof Error && Object.getPrototypeOf(thrown) === Error.prototype) {
    return `${operation}: Google Docs would refuse this change: ${thrown.message}`;
  }
  // A fault of the model: what it threw is internal and may quote the document.
  return `${operation}: this change cannot be shown as it will read once applied, ${NOT_SHOWN_TAIL}`;
}

/**
 * `tab` with `requests`, the batch of an edit `operation` made, applied as Google Docs applies
 * them (`applyDocsRequests`); `tab` itself when there are none. Throws a `DocModelError`, worded
 * for `operation`: in Google's words where Google would refuse the batch, and without what the
 * model threw where the model has no answer or is at fault.
 */
export function applyDocRequests(
  tab: GoogleDocsTab, operation: string, requests: readonly GoogleDocsRequest[],
): GoogleDocsTab {
  if (requests.length === 0) return tab;
  try {
    return applyDocsRequests(tab, requests);
  } catch (thrown) {
    throw new DocModelError(modelRefusal(operation, thrown), thrown);
  }
}

/** An edit made in a tab: the requests that make it, and the tab with them applied. */
export type MadeDocEdit = {
  readonly requests: readonly GoogleDocsRequest[];
  /** The tab given, itself, for an edit that changes nothing. */
  readonly after: GoogleDocsTab;
};

/** The keys of every member of a union. */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;

/** Every field a `DocEdit` may carry: what `docEditRequests` builds an edit's requests from. */
const DOC_EDIT_FIELDS: Record<KeysOfUnion<DocEdit>, true> = {
  type: true, oldMarkdown: true, newMarkdown: true, inTable: true, markdown: true, rows: true,
  columns: true, cells: true, after: true, at: true, count: true, expected: true, unshown: true,
  suggested: true, style: true, row: true, column: true, width: true, height: true,
};

/** Whether two edits have the same `DocEdit` fields, whatever else each object carries. */
function sameDocEdit(left: DocEdit, right: DocEdit): boolean {
  let leftFields: Partial<Record<string, unknown>> = left;
  let rightFields: Partial<Record<string, unknown>> = right;
  return Object.keys(DOC_EDIT_FIELDS).every(field =>
    sameValue(leftFields[field], rightFields[field]));
}

/** An edit and what it made. Both are let go together, and the entry stays. */
type Made = { edit?: DocEdit; made?: MadeDocEdit };

/** The last edit made in a tab, by that tab. */
const lastMade = new WeakMap<GoogleDocsTab, Made>();

/** What remembers a tab the model returned, by that tab: emptied once an edit is made in it. */
const madeBy = new WeakMap<GoogleDocsTab, Made>();

/**
 * `edit` made in `tab`: `docEditRequests` on the tab's rendering, applied by
 * `applyDocRequests`. The last edit made in each tab object is remembered, weakly by the tab,
 * and asked again for an edit with the same fields (`DocEdit`'s, whatever else the object
 * carries) it answers what it made, building and applying nothing: the fold of a record just
 * stored takes the tab its prepare made. A refusal is not remembered. What is remembered of a
 * tab is let go once an edit is made in the tab it gave, so a queue keeps one tab beyond those
 * its fold holds, not one for each edit.
 */
export function makeDocEdit(tab: GoogleDocsTab, edit: DocEdit): MadeDocEdit {
  let last = lastMade.get(tab);
  if (last?.edit && last.made && sameDocEdit(last.edit, edit)) return last.made;
  let requests = docEditRequests(renderTab(tab), edit);
  let made: MadeDocEdit = { requests, after: applyDocRequests(tab, edit.type, requests) };
  let entry: Made = { edit, made };
  lastMade.set(tab, entry);
  if (made.after !== tab) madeBy.set(made.after, entry);
  // The entry whose result is `tab` lets it go: that entry's own tab lives as long as the copy
  // does, and would hold every tab of the queue through the entries that follow it.
  let source = madeBy.get(tab);
  if (source) source.edit = source.made = undefined;
  return made;
}

/** `tab` with `edit` made in it: `makeDocEdit(tab, edit).after`. */
export function applyDocEdit(tab: GoogleDocsTab, edit: DocEdit): GoogleDocsTab {
  return makeDocEdit(tab, edit).after;
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/** Why replay refused an edit. At most one of `unindexed`, `unmodelled` and `modelError` is set. */
export type DocRefusal = {
  /** The refusal, in the words the caller reads, without who asked for the replay. */
  readonly reason: string;
  /** Set when the edit's tab is one the copy cannot index. */
  readonly unindexed?: true;
  /**
   * Set when the model had no answer: the shape it names, which never holds document text, and
   * whether nothing the builders send should reach that shape.
   */
  readonly unmodelled?: { readonly what: string; readonly invariant: boolean };
  /**
   * Set when the model threw anything else. `name` is the name of the error's class: `"Error"`
   * is a batch Google Docs would refuse, which is a fault of the builder that sent it; any other
   * name is a fault of the model. `frames` is where it was thrown: the frames of the error's
   * stack without the line or lines of its message, which may quote the document; absent where
   * what was thrown has no stack.
   */
  readonly modelError?: { readonly name: string; readonly frames?: string };
  /** Set when the refused edit closes its tab's table gate (`closesTableGate`, on a named tab). */
  readonly closesGate?: true;
};

/**
 * Where `thrown` was thrown: the frames of its stack. The engine writes a stack as the error's
 * own line, then the frames, so that line is taken off the head and only the trailing run of
 * frames is kept: a message that spans lines, or was changed after the throw, stays out.
 */
function thrownAt(thrown: unknown): string | undefined {
  if (!(thrown instanceof Error) || typeof thrown.stack !== "string") return undefined;
  let head = String(thrown);
  let lines = (thrown.stack.startsWith(head) ? thrown.stack.slice(head.length) : thrown.stack)
    .split("\n");
  let first = lines.length;
  while (first > 0 && /^\s+at /.test(lines[first - 1])) first--;
  return first === lines.length ? undefined : lines.slice(first).join("\n");
}

/**
 * The refusal an error thrown while an edit was made or replayed stands for: its message, and,
 * for a `DocModelError`, what the model did. Any other error is a builder's refusal or the
 * gate's, and gives the reason alone.
 */
export function docRefusal(error: unknown): DocRefusal {
  let reason = error instanceof Error ? error.message : String(error);
  if (!(error instanceof DocModelError)) return { reason };
  let { cause } = error;
  if (cause instanceof NotModelledError) {
    return { reason, unmodelled: { what: cause.what, invariant: cause.invariant } };
  }
  let frames = thrownAt(cause);
  return {
    reason,
    modelError: {
      name: cause instanceof Error ? cause.name : typeof cause,
      ...(frames === undefined ? {} : { frames }),
    },
  };
}

/**
 * The reducer of one tab's edits. It is given no record that carries `invalidatedReason`: the
 * replay leaves those out of what it folds. An edit is refused, with the reason the caller reads,
 * where the tab is not in the document (`resolveDocTab`'s refusal), the copy cannot index it, an
 * earlier refusal of this fold closed the tab's table gate and the edit names a table, or
 * `materializeDocEdit` or the model refuses it; otherwise the tab becomes `applyDocEdit` of it, or
 * the edit has no effect. A refused edit that changes tables otherwise than in their look closes
 * the gate of the tab it names. It never returns `unsupported`: a tab's queue is folded to its end.
 */
export const docTabReducer:
  SimulationStoreOptions<string, DocTabCopy, GoogleDocsTab, QueuedDocRecord, DocRefusal> = {
    initial: part => part.tab,
    reduce(tab, { action }, { id, base, refusals }) {
      replayCost.folds++;
      let refusal: DocRefusal;
      try {
        assertDocEditReplayable(action);
        let target = tab ?? resolveDocTab<GoogleDocsTab>([], id, action.type);
        // Asked before the gate, which the first table change refused for such a tab closes: every
        // edit of the tab is then refused for the one reason, whatever came before it.
        if (base?.unindexed) {
          refusal = { reason: unindexedTabRefusal(action.type).message, unindexed: true };
        } else {
          if (refusals.some(earlier => earlier.closesGate) && namesTable(action)) {
            throw tableGateRefusal(action.type);
          }
          let after = applyDocEdit(target, action);
          return after === target ? { kind: "known-no-effect" } : { kind: "applied", value: after };
        }
      } catch (error) {
        refusal = docRefusal(error);
      }
      return {
        kind: "refused",
        refusal: closesTableGate(action) && action.tabId !== undefined
          ? { ...refusal, closesGate: true }
          : refusal,
      };
    },
  };

/**
 * The records of `pending` a read of tab `part` replays: all but those whose write the tab
 * already holds (its marker is among `part.committedWriteIds`). Such a record stays pending, and
 * approving it settles it from the same marker. With no `part` (a tab the copy lacks), every
 * record. The records come back as they were given, so a caller that lists stored records gets
 * stored records.
 */
export function replayableDocEdits<R extends QueuedDocRecord>(
  part: DocTabCopy | undefined, pending: readonly R[],
): R[] {
  return pending.filter(({ action: { writeId } }) =>
    writeId === undefined || !part?.committedWriteIds.includes(writeId));
}

// ---------------------------------------------------------------------------
// What an edit changes in a rendering
// ---------------------------------------------------------------------------

/** Whether `index` is where a line of `text` starts. */
function atLineStart(text: string, index: number): boolean {
  return index === 0 || text[index - 1] === "\n";
}

/** How many spaces `text` holds from `index` on. */
function indentAt(text: string, index: number): number {
  let end = index;
  while (text[end] === " ") end++;
  return end - index;
}

/**
 * The span of a tab's rendering an edit changes: `start` to `beforeEnd` in `before` and `start`
 * to `afterEnd` in `after`, the renderings before and after it. Outside the span the two are the
 * same text. With `named`, the range of `before` the caller's text stands at, the span holds
 * that range, and is widened to whole lines only on a side where the difference reaches past it.
 * Without it the span is the lines that differ, each whole. Lines that are only added, and could
 * stand several lines earlier with the same result (a table row added before a row that begins
 * as it does), are placed where their first line is indented least, at the latest such place.
 */
export function changedSpan(
  before: string, after: string, named?: { start: number; end: number },
): { start: number; beforeEnd: number; afterEnd: number } {
  let left = commonPrefix(before, after);
  let start = named && left >= named.start ? named.start : lineStart(before, left);
  // Bounded by the span's start, not by the common prefix: text between the two may belong to
  // the suffix, as where an insertion repeats the text after it.
  let changedEnd = before.length - commonSuffix(before, after, start);
  let beforeEnd: number;
  if (named && changedEnd <= named.end) {
    beforeEnd = named.end;
  } else if (atLineStart(before, changedEnd)) {
    beforeEnd = changedEnd;
  } else {
    let lineEnd = before.indexOf("\n", changedEnd);
    beforeEnd = lineEnd === -1 ? before.length : lineEnd;
  }
  let afterEnd = after.length - (before.length - beforeEnd);

  if (!named && start === beforeEnd && afterEnd > start && after[afterEnd - 1] === "\n") {
    // Whole lines were added and nothing removed. While the line before the span is also the
    // span's last line, the same lines stand one line earlier with the same result.
    let moved = 0;
    let least = indentAt(after, start);
    for (let shift = 0; start - shift > 0;) {
      let from = start - shift;
      let line = after.slice(lineStart(after, from - 1), from);
      let last = afterEnd - shift - line.length;
      if (last < from || !atLineStart(after, last) || !after.startsWith(line, last)) break;
      shift += line.length;
      let indent = indentAt(after, start - shift);
      if (indent < least) {
        least = indent;
        moved = shift;
      }
    }
    start -= moved;
    beforeEnd -= moved;
    afterEnd -= moved;
  }
  return { start, beforeEnd, afterEnd };
}
