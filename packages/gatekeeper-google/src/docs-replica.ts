// The copy of a Google Doc the Doc gatekeeper keeps between reads: each tab pruned to what the
// Markdown rendering and the model of `documents.batchUpdate` read, in Google's own shape, and
// how the copy is stored. Pending edits are replayed on it (`./docs-replay`).

import type { HeldBase } from "@gadgets/gatekeeper-kit/simulation-store";
import type {
  Dimension, DocList, GoogleDocsDocument, GoogleDocsTab, NamedStyles, OptionalColor, Paragraph,
  ParagraphElement, StructuralElement, Table, TableCell, TableCellBorder, TableCellStyle,
  TableRow, TextStyle,
} from "./docs-api";
import { hasModelIndexes, type ModelParagraphStyle, type ModelTextStyle } from "./docs-model";

/**
 * Version of the stored copy: of what `pruneTab` keeps and of the bytes `encodeDocCopy` writes.
 * Bump it with any change to either. A stored copy whose revision Google confirms is served
 * without being fetched again, so under an unchanged version a copy pruned by another whitelist
 * would go on lacking a field the rendering or the model reads.
 */
export const DOC_COPY_FORMAT_VERSION = 3;

// ---------------------------------------------------------------------------
// Named ranges and write markers
// ---------------------------------------------------------------------------

/** Name prefix of the named range that marks one write. Permanent: retries match on it. */
const WRITE_MARKER_PREFIX = "gadgets-write-";

/** A named range of a tab: its id, and its name (the collection's key where it has none). */
type GoogleDocNamedRange = { id: string; name: string };

/** The named ranges of a tab as Google returned it. Throws for a collection that is malformed. */
export function googleDocNamedRanges(tab: GoogleDocsTab): GoogleDocNamedRange[] {
  let result: GoogleDocNamedRange[] = [];
  for (const [fallbackName, collection] of Object.entries<unknown>(tab.namedRanges)) {
    if (!collection || typeof collection !== "object") {
      throw new Error("Google Docs returned invalid named ranges");
    }
    let ranges = (collection as { namedRanges?: unknown }).namedRanges;
    if (!Array.isArray(ranges)) {
      throw new Error("Google Docs returned invalid named ranges");
    }
    for (const range of ranges) {
      if (!range || typeof range !== "object") {
        throw new Error("Google Docs returned an invalid named range");
      }
      let {namedRangeId, name} = range as { namedRangeId?: unknown; name?: unknown };
      if (typeof namedRangeId !== "string" || namedRangeId.length === 0 ||
          (name !== undefined && typeof name !== "string")) {
        throw new Error("Google Docs returned an invalid named range");
      }
      result.push({ id: namedRangeId, name: name ?? fallbackName });
    }
  }
  return result;
}

/** The ids of the tab's named ranges called `name`. */
export function googleDocNamedRangeIds(tab: GoogleDocsTab, name: string): string[] {
  let ids = new Set<string>();
  for (let range of googleDocNamedRanges(tab)) {
    if (range.name === name) ids.add(range.id);
  }
  return [...ids];
}

/** The named range that marks one write, named so the write is recognizable on a retry. */
export function googleDocWriteMarkerName(writeId: string): string {
  return `${WRITE_MARKER_PREFIX}${writeId}`;
}

/** A write marker a tab held when it was fetched. */
export type DocWriteMarkerCopy = {
  /** The id of the write the marker names (`googleDocWriteMarkerName`). */
  readonly writeId: string;
  /** The id of the marker's named range, which deleting it names. */
  readonly id: string;
};

/**
 * The write markers of `tab`, as Google returned it, in the order it listed them. A marker and
 * its content go up in one atomic batch, so a marker naming a write id proves that write
 * committed, also where its response was lost and its action is still pending.
 */
function googleDocWriteMarkers(tab: GoogleDocsTab): DocWriteMarkerCopy[] {
  let markers: DocWriteMarkerCopy[] = [];
  for (let { id, name } of googleDocNamedRanges(tab)) {
    if (!name.startsWith(WRITE_MARKER_PREFIX)) continue;
    let writeId = name.slice(WRITE_MARKER_PREFIX.length);
    if (!markers.some(marker => marker.writeId === writeId && marker.id === id)) {
      markers.push({ writeId, id });
    }
  }
  return markers;
}

// ---------------------------------------------------------------------------
// Pruning
//
// Every helper builds the objects and arrays it returns: a field `kept` copies is a primitive,
// and an array is mapped or spread. A pruned tab so shares nothing with the tab it came from.
// ---------------------------------------------------------------------------

/** `source` with only the fields `keys` name, those it has. */
function kept<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  let out = {} as Pick<T, K>;
  for (let key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/** `{ [key]: prune(value) }`, or nothing for a value that is not there. */
function optional<K extends string, V, P>(
  key: K, value: V | undefined, prune: (value: V) => P,
): { [key in K]?: P } {
  return value === undefined ? {} : { [key]: prune(value) } as { [key in K]?: P };
}

/** The indexes of a part, with a start index only where Google sent one. */
function prunedIndexes<T extends { startIndex: number; endIndex: number }>(
  part: T,
): { startIndex: number; endIndex: number } {
  return kept(part, ["startIndex", "endIndex"]);
}

function prunedDimension(dimension: Dimension): Dimension {
  return kept(dimension, ["magnitude", "unit"]);
}

function prunedColor({ color }: OptionalColor): OptionalColor {
  if (!color) return {};
  return { color: optional("rgbColor", color.rgbColor, rgb => kept(rgb, ["red", "green", "blue"])) };
}

/** A link's target, under whichever of Google's names it came. */
type LinkTarget = {
  url?: string; tabId?: string; bookmarkId?: string; headingId?: string;
  bookmark?: { id?: string; tabId?: string }; heading?: { id?: string; tabId?: string };
};

function prunedLink(link: LinkTarget): LinkTarget {
  return {
    ...kept(link, ["url", "tabId", "bookmarkId", "headingId"]),
    ...optional("bookmark", link.bookmark, bookmark => kept(bookmark, ["id", "tabId"])),
    ...optional("heading", link.heading, heading => kept(heading, ["id", "tabId"])),
  };
}

function prunedTextStyle(style: ModelTextStyle): ModelTextStyle {
  return {
    ...kept(style, ["bold", "italic", "strikethrough", "underline"]),
    ...optional("link", style.link, prunedLink),
    ...optional("foregroundColor", style.foregroundColor, prunedColor),
    ...optional("fontSize", style.fontSize, prunedDimension),
  } as ModelTextStyle;
}

/** The text style of an element that is not a text run, when it has one. */
function textStyle(of: { textStyle?: TextStyle }): { textStyle?: ModelTextStyle } {
  return optional("textStyle", of.textStyle, prunedTextStyle);
}

function prunedElement(element: ParagraphElement): ParagraphElement {
  let {
    textRun, autoText, horizontalRule, pageBreak, columnBreak, footnoteReference, equation,
    inlineObjectElement, person, richLink, dateElement, dropdown,
  } = element;
  let pruned: ParagraphElement = prunedIndexes(element);
  if (textRun) {
    pruned.textRun = { content: textRun.content, textStyle: prunedTextStyle(textRun.textStyle ?? {}) };
  }
  if (autoText) pruned.autoText = { ...kept(autoText, ["type"]), ...textStyle(autoText) };
  if (horizontalRule) pruned.horizontalRule = {};
  if (pageBreak) pruned.pageBreak = textStyle(pageBreak);
  if (columnBreak) pruned.columnBreak = textStyle(columnBreak);
  if (footnoteReference) {
    pruned.footnoteReference = {
      ...kept(footnoteReference, ["footnoteId", "footnoteNumber"]), ...textStyle(footnoteReference),
    };
  }
  if (equation) pruned.equation = {};
  if (inlineObjectElement) {
    pruned.inlineObjectElement = {
      ...kept(inlineObjectElement, ["inlineObjectId"]), ...textStyle(inlineObjectElement),
    };
  }
  if (person) {
    pruned.person = {
      ...textStyle(person),
      ...optional("personProperties", person.personProperties,
        properties => kept(properties, ["name", "email"])),
    };
  }
  if (richLink) {
    pruned.richLink = {
      ...textStyle(richLink),
      ...optional("richLinkProperties", richLink.richLinkProperties,
        properties => kept(properties, ["title", "uri"])),
    };
  }
  if (dateElement) {
    pruned.dateElement = {
      ...textStyle(dateElement),
      ...optional("dateElementProperties", dateElement.dateElementProperties,
        properties => kept(properties, ["displayText"])),
    };
  }
  if (dropdown) {
    pruned.dropdown = {
      ...kept(dropdown, ["dropdownId"]),
      ...textStyle(dropdown),
      ...optional("dropdownProperties", dropdown.dropdownProperties, properties =>
        kept(properties, ["dropdownDefinitionId", "selectedOptionId", "displayValue"])),
    };
  }
  return pruned;
}

function prunedParagraph(paragraph: Paragraph): Paragraph {
  let style: ModelParagraphStyle = paragraph.paragraphStyle;
  return {
    elements: paragraph.elements.map(prunedElement),
    paragraphStyle: {
      ...kept(style, ["namedStyleType", "headingId", "alignment"]),
      ...optional("indentStart", style.indentStart, prunedDimension),
      ...optional("indentFirstLine", style.indentFirstLine, prunedDimension),
    } as ModelParagraphStyle,
    ...optional("bullet", paragraph.bullet, bullet => kept(bullet, ["listId", "nestingLevel"])),
    ...optional("positionedObjectIds", paragraph.positionedObjectIds, ids => [...ids]),
  };
}

/** The ids of the suggestions that would insert or delete a table, a row or a cell. */
function prunedSuggestions(
  part: { suggestedInsertionIds?: string[]; suggestedDeletionIds?: string[] },
): { suggestedInsertionIds?: string[]; suggestedDeletionIds?: string[] } {
  return {
    ...optional("suggestedInsertionIds", part.suggestedInsertionIds, ids => [...ids]),
    ...optional("suggestedDeletionIds", part.suggestedDeletionIds, ids => [...ids]),
  };
}

function prunedBorder(border: TableCellBorder): TableCellBorder {
  return {
    ...optional("color", border.color, prunedColor),
    ...optional("width", border.width, prunedDimension),
    ...kept(border, ["dashStyle"]),
  };
}

function prunedCellStyle(style: TableCellStyle): TableCellStyle {
  return {
    ...kept(style, ["rowSpan", "columnSpan", "contentAlignment"]),
    ...optional("backgroundColor", style.backgroundColor, prunedColor),
    ...optional("paddingTop", style.paddingTop, prunedDimension),
    ...optional("paddingRight", style.paddingRight, prunedDimension),
    ...optional("paddingBottom", style.paddingBottom, prunedDimension),
    ...optional("paddingLeft", style.paddingLeft, prunedDimension),
    ...optional("borderTop", style.borderTop, prunedBorder),
    ...optional("borderRight", style.borderRight, prunedBorder),
    ...optional("borderBottom", style.borderBottom, prunedBorder),
    ...optional("borderLeft", style.borderLeft, prunedBorder),
  };
}

function prunedCell(cell: TableCell): TableCell {
  return {
    ...prunedIndexes(cell),
    ...optional("content", cell.content, prunedContent),
    ...optional("tableCellStyle", cell.tableCellStyle, prunedCellStyle),
    ...prunedSuggestions(cell),
  };
}

function prunedRow(row: TableRow): TableRow {
  return {
    ...prunedIndexes(row),
    ...optional("tableCells", row.tableCells, cells => cells.map(prunedCell)),
    ...optional("tableRowStyle", row.tableRowStyle, style => ({
      ...kept(style, ["tableHeader"]),
      ...optional("minRowHeight", style.minRowHeight, prunedDimension),
    })),
    ...prunedSuggestions(row),
  };
}

function prunedTable(table: Table): Table {
  return {
    ...optional("tableRows", table.tableRows, rows => rows.map(prunedRow)),
    ...optional("tableStyle", table.tableStyle, style => optional(
      "tableColumnProperties", style.tableColumnProperties, columns => columns.map(column => ({
        ...kept(column, ["widthType"]), ...optional("width", column.width, prunedDimension),
      })))),
    ...prunedSuggestions(table),
  };
}

function prunedContent(content: readonly StructuralElement[]): StructuralElement[] {
  return content.map(element => ({
    ...prunedIndexes(element),
    ...optional("paragraph", element.paragraph, prunedParagraph),
    ...optional("table", element.table, prunedTable),
    ...optional("sectionBreak", element.sectionBreak, () => ({})),
    ...optional("tableOfContents", element.tableOfContents, () => ({})),
  }));
}

function prunedList(list: DocList): DocList {
  return {
    listProperties: {
      nestingLevels: (list.listProperties?.nestingLevels ?? []).map(level =>
        kept(level, ["glyphType", "glyphSymbol", "startNumber"])),
    },
  };
}

function prunedNamedStyles(named: NamedStyles): NamedStyles {
  return optional("styles", named.styles, styles => styles.map(style => ({
    ...kept(style, ["namedStyleType"]),
    ...optional("textStyle", style.textStyle, text => kept(text, ["bold", "italic", "strikethrough"])),
  })));
}

/**
 * `tab` with only what `docTabToMarkdown` and `applyDocsRequests` read, in Google's own shape and
 * with Google's own indexes (a start index is kept only where Google sent one), sharing nothing
 * with `tab`. Both functions give on the pruned tab what they give on `tab`: the same rendering,
 * and, for any batch, a tab that prunes to the same. Named ranges are left out (`namedRanges` is
 * `{}`): `docCopy` keeps what the gatekeeper reads of them. Pruning a pruned tab changes nothing.
 */
export function pruneTab(tab: GoogleDocsTab): GoogleDocsTab {
  return {
    tabId: tab.tabId,
    title: tab.title,
    ...kept(tab, ["parentTabId"]),
    index: tab.index,
    nestingLevel: tab.nestingLevel,
    body: { content: prunedContent(tab.body.content) },
    lists: Object.fromEntries(
      Object.entries(tab.lists).map(([id, list]) => [id, prunedList(list)])),
    namedRanges: {},
    ...optional("namedStyles", tab.namedStyles, prunedNamedStyles),
  };
}

// ---------------------------------------------------------------------------
// The copy and its stored form
// ---------------------------------------------------------------------------

/** What names and places a tab: a tab as Google returned it and a tab of a replay both have it. */
export type GoogleDocTabIdentity =
  Pick<GoogleDocsTab, "tabId" | "title" | "parentTabId" | "index" | "nestingLevel">;

/** One tab of the copy. Never changed in place: a remembered replay is known by this object. */
export type DocTabCopy = {
  /** The tab, pruned. */
  readonly tab: GoogleDocsTab;
  /**
   * The write markers the tab held when it was fetched, one for each named range that names a
   * write, in the order Google listed them. An approval that builds its write from the copy
   * finds its own marker here, with the id that deletes it.
   */
  readonly writeMarkers: readonly DocWriteMarkerCopy[];
  /**
   * The ids of the writes whose markers the tab held when it was fetched. A marker and its
   * content go up in one batch, so the tab already holds such a write, though its action may
   * still be pending.
   */
  readonly committedWriteIds: readonly string[];
  /**
   * Whether `hasModelIndexes` fails for the tab. Such a tab is read as it is and takes no edit:
   * a request built against it could land elsewhere in the model than in the document.
   */
  readonly unindexed: boolean;
};

/** The copy of a document that pending edits are replayed over, read one tab at a time. */
export type DocCopy = {
  /**
   * Every tab's identity, in the document's order (depth-first, parents before children).
   * Never changed in place: the replay of the tab tree is known by this array.
   */
  readonly outline: readonly GoogleDocTabIdentity[];
  /**
   * One tab, or `undefined` for an id the outline does not list. A copy read from storage
   * decodes the tab when it is first asked for, and throws for a listed tab that cannot be
   * read back; the next read then fetches the document again.
   */
  tab(tabId: string): DocTabCopy | undefined;
};

/** What one stored partition of the copy decodes to. */
export type DocCopyPart = readonly GoogleDocTabIdentity[] | DocTabCopy;

/** The partition key of the outline. No tab has the empty id. */
export const DOC_OUTLINE_PARTITION = "";

/** The identity of `tab`, with nothing else of it. */
function tabIdentity(tab: GoogleDocTabIdentity): GoogleDocTabIdentity {
  return {
    tabId: tab.tabId,
    title: tab.title,
    ...kept(tab, ["parentTabId"]),
    index: tab.index,
    nestingLevel: tab.nestingLevel,
  };
}

/** One tab of the copy: `tab`, pruned, with the write markers it held when it was fetched. */
function docTabCopy(tab: GoogleDocsTab, writeMarkers: readonly DocWriteMarkerCopy[]): DocTabCopy {
  return {
    tab,
    writeMarkers,
    committedWriteIds: [...new Set(writeMarkers.map(marker => marker.writeId))],
    unindexed: !hasModelIndexes(tab),
  };
}

/** The copy of a document as `documents.get` returned it: every tab pruned. */
export function docCopy(document: GoogleDocsDocument): DocCopy {
  let tabs = new Map<string, DocTabCopy>();
  let outline = document.tabs.map(fetched => {
    let tab = pruneTab(fetched);
    tabs.set(tab.tabId, docTabCopy(tab, googleDocWriteMarkers(fetched)));
    return tabIdentity(tab);
  });
  return { outline, tab: tabId => tabs.get(tabId) };
}

/**
 * The copy as `StoredBase` stores it: the outline under `DOC_OUTLINE_PARTITION`, then one
 * partition for each tab, keyed by the tab's id, in the document's order, holding the tab and
 * its write markers as UTF-8 JSON.
 */
export function encodeDocCopy(copy: DocCopy): ReadonlyMap<string, Uint8Array> {
  let encoder = new TextEncoder();
  let parts = new Map<string, Uint8Array>();
  parts.set(DOC_OUTLINE_PARTITION, encoder.encode(JSON.stringify(copy.outline.map(tabIdentity))));
  for (let { tabId } of copy.outline) {
    let part = copy.tab(tabId);
    if (!part) {
      throw new Error(`The copy of a Google Doc lists tab "${tabId}" and does not hold it`);
    }
    let { tab, writeMarkers } = part;
    parts.set(tabId, encoder.encode(JSON.stringify({ tab, writeMarkers })));
  }
  return parts;
}

const INVALID_STORED_TAB = "The stored copy of a Google Doc holds a tab that is not one";

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Whether `value` is a tab as a partition under `key` holds one, as deep as `decodeDocCopyPart`
 * says.
 */
function isStoredTab(value: unknown, key: string): value is GoogleDocsTab {
  if (!isObject(value)) return false;
  let { tabId, title, index, nestingLevel, body, lists } = value;
  return tabId === key && typeof title === "string" &&
    typeof index === "number" && typeof nestingLevel === "number" &&
    isObject(body) && Array.isArray(body.content) && body.content.length > 0 && isObject(lists);
}

/** Whether `value` is a write marker as a tab's partition holds one. */
function isStoredWriteMarker(value: unknown): value is DocWriteMarkerCopy {
  return isObject(value) && typeof value.writeId === "string" && typeof value.id === "string";
}

/** Whether `value` is the identity of a tab as the outline partition holds one. */
function isStoredIdentity(value: unknown): value is GoogleDocTabIdentity {
  if (!isObject(value)) return false;
  let { tabId, title, parentTabId, index, nestingLevel } = value;
  return typeof tabId === "string" && typeof title === "string" &&
    (parentTabId === undefined || typeof parentTabId === "string") &&
    typeof index === "number" && typeof nestingLevel === "number";
}

/**
 * One partition `encodeDocCopy` stored. Throws for bytes that are not it (not JSON; an outline
 * that is not a list of tab identities; no tab, a tab without an id or a body, write markers
 * that are not a list of a write id and a range id each, or a key that is not its tab's id),
 * which `StoredBase` reads as a partition that cannot be read back. `committedWriteIds` and
 * `unindexed` are worked out here, from the markers and from the tab.
 */
export function decodeDocCopyPart(key: string, bytes: Uint8Array): DocCopyPart {
  let stored: unknown;
  try {
    stored = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    // The parser's own message quotes the text it stopped at, which is the document's.
    throw new Error(INVALID_STORED_TAB);
  }
  if (key === DOC_OUTLINE_PARTITION) {
    if (!Array.isArray(stored) || !stored.every(isStoredIdentity)) {
      throw new Error(INVALID_STORED_TAB);
    }
    return stored;
  }
  if (!isObject(stored) || !isStoredTab(stored.tab, key) ||
      !Array.isArray(stored.writeMarkers) || !stored.writeMarkers.every(isStoredWriteMarker)) {
    throw new Error(INVALID_STORED_TAB);
  }
  return docTabCopy(stored.tab, stored.writeMarkers);
}

/** Whether a decoded partition is the outline, as against one tab. */
function isOutline(part: DocCopyPart): part is readonly GoogleDocTabIdentity[] {
  return Array.isArray(part);
}

/** What a read answers where a tab of the stored copy cannot be served. */
export const DOC_COPY_UNREADABLE =
  "The stored copy of this Google Doc could not be read back. Read it again.";

/**
 * The copy a `StoredBase` holds, or `undefined` when its outline cannot be read back or does
 * not list exactly the tabs the copy holds. A tab is decoded when it is first asked for.
 */
export function storedDocCopy(held: HeldBase<DocCopyPart>): DocCopy | undefined {
  let outline = held.part(DOC_OUTLINE_PARTITION);
  let keys = held.keys.filter(key => key !== DOC_OUTLINE_PARTITION);
  if (outline === undefined || !isOutline(outline) || outline.length !== keys.length ||
      outline.some(({ tabId }, at) => tabId !== keys[at])) {
    return undefined;
  }
  let listed = new Set(keys);
  return {
    outline,
    tab(tabId) {
      if (!listed.has(tabId)) return undefined;
      let part = held.part(tabId);
      // Not read back, or replaced in storage since this copy was taken.
      if (part === undefined || isOutline(part)) throw new Error(DOC_COPY_UNREADABLE);
      return part;
    },
  };
}
