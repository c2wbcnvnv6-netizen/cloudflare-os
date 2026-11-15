// Holds the copy of a Google Doc the gatekeeper keeps to its contract: a pruned tab renders as
// the tab Google sent and takes every batch as it does, shares nothing with it, and comes back
// from its stored form as it went in.

import type { HeldBase } from "@gadgets/gatekeeper-kit/simulation-store";
import { describe, expect, it } from "vitest";
import {
  BlankGoogleDoc, NEW_DOCUMENT_NAMED_STYLES,
  type GoogleDocsDocument, type GoogleDocsTab, type Paragraph, type ParagraphElement,
  type StructuralElement, type Table, type TableCellBorder, type TextStyle,
} from "../src/docs-api";
import {
  applyDocsRequests, hasModelIndexes, type ModelParagraphStyle, type ModelTextStyle,
} from "../src/docs-model";
import {
  decodeDocCopyPart, DOC_COPY_FORMAT_VERSION, DOC_OUTLINE_PARTITION, docCopy, encodeDocCopy,
  pruneTab, storedDocCopy, type DocCopyPart, type DocTabCopy,
} from "../src/docs-replica";
import { docTabToMarkdown, type DocTabSnapshot } from "../src/markdown-converter";
import { buildTab, MODELS, type BlockSpec } from "./doc-fixture";
import { prunedTab, readFixtures } from "./docs-live-fixtures";

const FIXTURES = readFixtures();

/** Every recorded tab, named by its recording and its place in it. */
const RECORDED: { name: string; tab: GoogleDocsTab }[] = FIXTURES.flatMap(fixture => [
  { name: `${fixture.name}, before`, tab: fixture.before },
  ...fixture.steps.map(step => ({ name: `${fixture.name}, after ${step.name}`, tab: step.after })),
]);

// ---------------------------------------------------------------------------
// A tab as Google sends it: with what the gatekeeper does not read
// ---------------------------------------------------------------------------

/**
 * A deep copy of `tab` with fields the gatekeeper does not read added throughout, as
 * `documents.get` sends many: an unknown key on every object of the body, the lists and the
 * named styles, more style fields on paragraphs, text and list levels, each table's count of
 * rows and of columns, and the tab's other collections. No field the whitelist names is touched.
 */
function dressed(tab: GoogleDocsTab): GoogleDocsTab {
  let copy = structuredClone(tab);
  let dress = (value: unknown, key: string): void => {
    if (Array.isArray(value)) {
      for (let item of value) dress(item, key);
      return;
    }
    if (!value || typeof value !== "object") return;
    let held = value as Record<string, unknown>;
    for (let [name, inner] of Object.entries(held)) dress(inner, name);
    held.zzUnread = { deep: [1] };
    if (key === "paragraphStyle" && !("headingId" in held)) held.direction = "LEFT_TO_RIGHT";
    if (key === "textStyle") {
      held.weightedFontFamily = { fontFamily: "Arial", weight: 400 };
      held.baselineOffset = "NONE";
    }
    if (key === "nestingLevels") {
      held.indentStart = { magnitude: 36, unit: "PT" };
      held.bulletAlignment = "START";
    }
    if (key === "table") Object.assign(held, { rows: 2, columns: 4 });
  };
  dress(copy.body, "body");
  // The lists are keyed by their ids, so a key added beside them would be one more list.
  for (let list of Object.values(copy.lists)) dress(list, "list");
  dress(copy.namedStyles, "namedStyles");
  return Object.assign(copy, {
    documentStyle: { pageSize: { width: { magnitude: 612, unit: "PT" } } },
    inlineObjects: { "inline.1": { inlineObjectProperties: { embeddedObject: { title: "Chart" } } } },
    positionedObjects: { "positioned.1": { positionedObjectProperties: { positioning: {} } } },
    footnotes: { "footnote.1": { content: [{ endIndex: 1, paragraph: { elements: [] } }] } },
    headers: { "header.1": { content: [] } },
  });
}

// ---------------------------------------------------------------------------
// A tab of every element the rendering names
// ---------------------------------------------------------------------------

// The characters that stand, in a spec's runs, for the elements `buildTab` has no spec for.
const EQUATION = "\ue001";
const PAGE_BREAK = "\ue002";
const COLUMN_BREAK = "\ue003";
const IMAGE = "\ue004";
const DROPDOWN = "\ue005";

/**
 * The elements `buildTab` has no spec for, each under the character that stands for it:
 * `withElements` puts the element where the character is, with its indexes.
 */
const ELEMENTS: Record<string, Omit<ParagraphElement, "startIndex" | "endIndex">> = {
  [EQUATION]: { equation: {} },
  [PAGE_BREAK]: { pageBreak: { textStyle: { bold: true } } },
  [COLUMN_BREAK]: { columnBreak: { textStyle: { italic: true } } },
  [IMAGE]: { inlineObjectElement: { inlineObjectId: "inline.1", textStyle: { strikethrough: true } } },
  [DROPDOWN]: {
    dropdown: {
      dropdownId: "dropdown.1",
      textStyle: { bold: true },
      dropdownProperties: {
        dropdownDefinitionId: "definition.1", selectedOptionId: "option.2", displayValue: "Done",
      },
    },
  },
};

/** Every paragraph of `content`, in body order, those of the tables' cells included. */
function* paragraphsOf(content: readonly StructuralElement[]): Generator<Paragraph> {
  for (let { paragraph, table } of content) {
    if (paragraph) yield paragraph;
    for (let row of table?.tableRows ?? []) {
      for (let cell of row.tableCells ?? []) yield* paragraphsOf(cell.content ?? []);
    }
  }
}

/** Replace, in place, each text run that is one of `ELEMENTS`' characters by its element. */
function withElements(tab: GoogleDocsTab): void {
  for (let paragraph of paragraphsOf(tab.body.content)) {
    paragraph.elements = paragraph.elements.map(element => {
      let stands = element.textRun && ELEMENTS[element.textRun.content];
      if (!stands) return element;
      return { startIndex: element.startIndex, endIndex: element.endIndex, ...structuredClone(stands) };
    });
  }
}

/** The paragraph of `tab` whose text starts with `text`. */
function paragraphStarting(tab: GoogleDocsTab, text: string): Paragraph {
  for (let paragraph of paragraphsOf(tab.body.content)) {
    if (paragraph.elements[0]?.textRun?.content.startsWith(text)) return paragraph;
  }
  throw new Error(`no paragraph starts with ${JSON.stringify(text)}`);
}

/** The table of the body of `tab` whose first cell's text starts with `text`. */
function tableStarting(tab: GoogleDocsTab, text: string): Table {
  for (let { table } of tab.body.content) {
    let first = table?.tableRows?.[0]?.tableCells?.[0]?.content?.[0]?.paragraph;
    if (table && first?.elements[0]?.textRun?.content.startsWith(text)) return table;
  }
  throw new Error(`no table starts with ${JSON.stringify(text)}`);
}

/** A text style with the fields the model keeps beside those the gatekeeper's types name. */
const MODEL_STYLE = {
  underline: true,
  foregroundColor: { color: { rgbColor: { red: 0.5, green: 0.25, blue: 0.125 } } },
  fontSize: { magnitude: 16, unit: "PT" },
} as TextStyle;

const BORDER = {
  color: { color: { rgbColor: { red: 1, green: 0.5, blue: 0.25 } } },
  width: { magnitude: 2, unit: "PT" },
  dashStyle: "DASH",
};

const LISTS: GoogleDocsTab["lists"] = {
  bullets: {
    listProperties: {
      nestingLevels: [{ glyphSymbol: "\u25cf", startNumber: 1 }, { glyphSymbol: "\u25cb", startNumber: 1 }],
    },
  },
  checks: { listProperties: { nestingLevels: [{ glyphType: "GLYPH_TYPE_UNSPECIFIED" }] } },
  numbers: {
    listProperties: {
      nestingLevels: [{ glyphType: "DECIMAL", startNumber: 3 }, { glyphType: "ALPHA", startNumber: 2 }],
    },
  },
};

/**
 * The cases of the rendering: for each, the blocks that hold it and, where `buildTab` has no
 * spec for a field, the change that sets it on the built tab.
 */
const CASES: { name: string; blocks: BlockSpec[]; set?: (tab: GoogleDocsTab) => void }[] = [
  {
    name: "text in each style, and a link of each kind",
    blocks: [{
      runs: [
        "plain ",
        { text: "bold ", style: { bold: true } },
        { text: "italic ", style: { italic: true } },
        { text: "struck ", style: { strikethrough: true } },
        { text: "coloured ", style: MODEL_STYLE },
        { text: "web ", style: { link: { url: "https://example.com/a" } } },
        { text: "heading ", style: { link: { headingId: "h.1" } } },
        { text: "bookmark ", style: { link: { bookmarkId: "b.1" } } },
        { text: "other heading ", style: { link: { heading: { id: "h.2", tabId: "t.2" } } } },
        { text: "other bookmark ", style: { link: { bookmark: { id: "b.2", tabId: "t.2" } } } },
        { text: "tab", style: { link: { tabId: "t.3" } } },
        "\n",
      ],
    }],
  },
  {
    name: "chips and the elements that are not text",
    blocks: [
      {
        runs: [
          "chips ",
          { person: { name: "Ada Lovelace", email: "ada@example.com" }, style: { bold: true } },
          { person: { email: "grace@example.com" } },
          { richLink: { title: "Plan", uri: "https://example.com/plan" }, style: { italic: true } },
          { date: "Jan 5, 2026", style: { bold: true } },
          { dropdown: "Open" },
          DROPDOWN,
          { footnote: { id: "footnote.1", number: "1" }, style: { italic: true } },
          { autoText: "PAGE_NUMBER", style: { bold: true } },
          { autoText: "PAGE_COUNT" },
          EQUATION, PAGE_BREAK, COLUMN_BREAK, IMAGE,
          "\n",
        ],
      },
      { runs: [{ horizontalRule: true }, "\n"] },
    ],
  },
  {
    name: "a paragraph with positioned images",
    blocks: [{ runs: ["anchored\n"] }],
    set: tab => {
      paragraphStarting(tab, "anchored").positionedObjectIds = ["positioned.1", "positioned.2"];
    },
  },
  {
    name: "a title, a subtitle and a heading of each level",
    blocks: [
      { runs: ["Title\n"], namedStyleType: "TITLE" },
      { runs: ["Subtitle\n"], namedStyleType: "SUBTITLE" },
      ...[1, 2, 3, 4, 5, 6].map(level => (
        { runs: [`Level ${level}\n`], namedStyleType: `HEADING_${level}` })),
    ],
    set: tab => {
      paragraphStarting(tab, "Level 2").paragraphStyle.headingId = "h.level2";
    },
  },
  {
    name: "an aligned and an indented paragraph",
    blocks: [{ runs: ["centred\n"] }, { runs: ["indented\n"] }],
    set: tab => {
      Object.assign(paragraphStarting(tab, "centred").paragraphStyle, { alignment: "CENTER" });
      Object.assign(paragraphStarting(tab, "indented").paragraphStyle, {
        indentStart: { magnitude: 36, unit: "PT" }, indentFirstLine: { magnitude: 18, unit: "PT" },
      });
    },
  },
  {
    name: "bulleted, checkbox and numbered lists, nested",
    blocks: [
      { runs: ["bullet\n"], bullet: { listId: "bullets" } },
      { runs: ["nested bullet\n"], bullet: { listId: "bullets", nestingLevel: 1 } },
      { runs: ["between lists\n"] },
      { runs: ["check\n"], bullet: { listId: "checks" } },
      { runs: ["third\n"], bullet: { listId: "numbers" } },
      { runs: ["second letter\n"], bullet: { listId: "numbers", nestingLevel: 1 } },
      { runs: ["fourth\n"], bullet: { listId: "numbers" } },
    ],
  },
  {
    name: "a table of contents and a section break inside the body",
    blocks: [
      { runs: ["before the contents\n"] },
      { structure: "tableOfContents", length: 12 },
      { runs: ["before the break\n"] },
      { structure: "sectionBreak" },
      { runs: ["after the break\n"] },
    ],
  },
  {
    name: "tables: merged cells, a look, a header row, a table in a cell, suggestions",
    blocks: [
      {
        table: [
          [
            {
              paragraphs: [{ runs: ["merged\n"] }],
              tableCellStyle: {
                rowSpan: 1, columnSpan: 2, contentAlignment: "MIDDLE",
                backgroundColor: { color: { rgbColor: { red: 0.9, green: 0.8, blue: 0.7 } } },
                paddingTop: { magnitude: 1, unit: "PT" }, paddingRight: { magnitude: 2, unit: "PT" },
                paddingBottom: { magnitude: 3, unit: "PT" }, paddingLeft: { magnitude: 4, unit: "PT" },
                borderTop: BORDER, borderRight: BORDER, borderBottom: BORDER, borderLeft: BORDER,
              },
            },
            "\n",
            "plain\n",
          ],
          [
            { paragraphs: [{ runs: ["tall\n"] }], tableCellStyle: { rowSpan: 2, columnSpan: 1 } },
            {
              paragraphs: [
                { runs: ["holds a table\n"] },
                { table: [["inner\n", { paragraphs: [{ runs: [IMAGE, "\n"] }] }]] },
                { runs: ["\n"] },
              ],
            },
            { paragraphs: [{ runs: ["suggested cell\n"] }], suggested: "insertion" },
          ],
          ["\n", "leaving row\n", "c\n"],
          ["suggested row\n", "b\n", { paragraphs: [{ runs: ["leaving\n"] }], suggested: "deletion" }],
        ],
        headerRows: 1,
        suggestedRows: { 2: "deletion", 3: "insertion" },
        columns: [120, null, 80],
        heights: [0, 30, 0, 0],
      },
      { runs: ["between tables\n"] },
      { table: [["suggested table\n"]] },
      { runs: ["after the tables\n"] },
    ],
    set: tab => {
      Object.assign(tableStarting(tab, "suggested table"), {
        suggestedInsertionIds: ["suggest.table"], suggestedDeletionIds: ["suggest.gone"],
      });
    },
  },
  {
    name: "named styles that give bold, italic and strikethrough",
    blocks: [
      { runs: ["styled heading\n"], namedStyleType: "HEADING_1" },
      { runs: ["styled subtitle\n"], namedStyleType: "SUBTITLE" },
      { runs: ["styled text\n"] },
    ],
    set: tab => {
      tab.namedStyles = {
        styles: [
          { namedStyleType: "NORMAL_TEXT", textStyle: { strikethrough: true, bold: false } },
          { namedStyleType: "HEADING_1", textStyle: { bold: true } },
          { namedStyleType: "SUBTITLE", textStyle: { italic: true, strikethrough: false } },
          { namedStyleType: "TITLE" },
        ],
      };
    },
  },
];

/** The tab of `blocks`, with the elements and the fields set by hand in place. */
function caseTab(blocks: BlockSpec[], changes: ((tab: GoogleDocsTab) => void)[]): GoogleDocsTab {
  let tab = buildTab(structuredClone(blocks), structuredClone(LISTS));
  withElements(tab);
  for (let change of changes) change(tab);
  return tab;
}

/** One tab of every case at once, a child tab: the tab with the most kinds of element. */
const RICHEST: GoogleDocsTab = {
  ...caseTab(CASES.flatMap(({ blocks }) => blocks), CASES.flatMap(({ set }) => set ?? [])),
  title: "Every element",
  parentTabId: "t.parent",
  nestingLevel: 1,
};

const RENDERED: { name: string; tab: GoogleDocsTab }[] = [
  ...CASES.map(({ name, blocks, set }) => ({ name, tab: caseTab(blocks, set ? [set] : []) })),
  { name: "every element at once", tab: RICHEST },
];

// ---------------------------------------------------------------------------
// Walking
// ---------------------------------------------------------------------------

/** Every object and array under `value`, itself included. */
function partsOf(value: unknown, into = new Set<object>()): Set<object> {
  if (!value || typeof value !== "object") return into;
  into.add(value);
  for (let inner of Object.values(value)) partsOf(inner, into);
  return into;
}

/** `value` with every object and array under it frozen. */
function deepFrozen<T>(value: T): T {
  for (let part of partsOf(value)) Object.freeze(part);
  return value;
}

/**
 * The fields pruned `tabs` hold, by kind of object: for each key an object sits under (`tab`
 * for a tab itself, the key of the array for an object in one, and `lists.*` for a list, since
 * the lists are keyed by their ids), the keys of every such object, in order.
 */
function keptFields(tabs: readonly GoogleDocsTab[]): Record<string, string> {
  let fields = new Map<string, Set<string>>();
  let visit = (value: unknown, under: string): void => {
    if (Array.isArray(value)) {
      for (let item of value) visit(item, under);
      return;
    }
    if (!value || typeof value !== "object") return;
    let keys = fields.get(under) ?? new Set<string>();
    fields.set(under, keys);
    for (let [key, inner] of Object.entries(value)) {
      if (under === "lists") {
        visit(inner, "lists.*");
      } else {
        keys.add(key);
        visit(inner, key);
      }
    }
  };
  for (let tab of tabs) visit(tab, "tab");
  return Object.fromEntries([...fields].toSorted(([a], [b]) => a < b ? -1 : 1)
    .map(([under, keys]) => [under, [...keys].toSorted().join(" ")]));
}

/** `style` as pruning leaves the style of a text run. */
function prunedStyle(style: TextStyle): TextStyle {
  let pruned = pruneTab(buildTab([{ runs: [{ text: "\n", style }] }]));
  return pruned.body.content[1].paragraph!.elements[0].textRun!.textStyle;
}

/**
 * The rendering of `tab` as it is compared with the rendering of the pruned tab. The source
 * map hands on the style of each run as the tab holds it, whole, for a builder to read the
 * bold, italic, strikethrough and link of; so those styles are pruned here as the tab's are.
 */
function renderingOf(tab: GoogleDocsTab): DocTabSnapshot {
  let rendering = docTabToMarkdown(tab);
  for (let block of rendering.sourceMap.blocks) {
    for (let segment of block.segments) {
      if ("textStyle" in segment) segment.textStyle = prunedStyle(segment.textStyle);
    }
  }
  return rendering;
}

/** A document of `tabs`, as `documents.get` gives one. */
function documentOf(tabs: GoogleDocsTab[]): GoogleDocsDocument {
  return { documentId: "doc-1", title: "A document", revisionId: "revision-1", tabs };
}

/** The named ranges of a tab that two writes marked and something else named a range in. */
const MARKED: GoogleDocsTab["namedRanges"] = {
  "gadgets-write-first": {
    namedRanges: [
      { namedRangeId: "range.1", name: "gadgets-write-first" },
      { namedRangeId: "range.2", name: "gadgets-write-first" },
    ],
  },
  "someone else's": { namedRanges: [{ namedRangeId: "range.3", name: "someone else's" }] },
  "gadgets-write-second": { namedRanges: [{ namedRangeId: "range.4" }] },
};

/** The bytes of `value` as a partition holds JSON. */
const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

describe("pruning a tab", () => {
  it("has recordings and cases to hold it to", () => {
    expect(RECORDED.length).toBeGreaterThan(FIXTURES.length);
    expect(RENDERED.length).toBeGreaterThan(1);
  });

  it("returns a recorded tab unchanged but for its named ranges, and a pruned tab as it is", () => {
    let ranges = { foreign: { namedRanges: [{ namedRangeId: "range.1", name: "foreign" }] } };
    for (let { name, tab } of RECORDED) {
      let sent = { ...tab, title: "Meeting notes", namedRanges: ranges };
      let pruned = pruneTab(sent);
      expect(pruned, name).toStrictEqual({ ...tab, title: "Meeting notes", namedRanges: {} });
      expect(pruneTab(pruned), name).toStrictEqual(pruned);
    }
    for (let { name, tab } of RENDERED) {
      let pruned = pruneTab(dressed(tab));
      expect(pruneTab(pruned), name).toStrictEqual(pruned);
    }
  });

  it("drops everything the gatekeeper does not read and no field it does", () => {
    for (let { name, tab } of [...RECORDED, ...RENDERED]) {
      expect(pruneTab(dressed(tab)), name).toStrictEqual(pruneTab(tab));
    }
  });

  // `pruneTab` stands in front of every read, so a field of the rendering that the whitelist
  // forgot would show here as a rendering that changed.
  describe("leaves the rendering as it is", () => {
    for (let { name, tab } of RENDERED) {
      it(name, () => {
        let sent = dressed(tab);
        expect(docTabToMarkdown(pruneTab(sent))).toStrictEqual(renderingOf(sent));
      });
    }

    it("every recorded tab", () => {
      for (let { name, tab } of RECORDED) {
        let sent = dressed(tab);
        expect(docTabToMarkdown(pruneTab(sent)), name).toStrictEqual(renderingOf(sent));
      }
    });
  });

  describe("commutes with the model", () => {
    for (let fixture of FIXTURES) {
      it(`in the recording ${fixture.name}`, () => {
        let before = fixture.before;
        for (let step of fixture.steps) {
          let sent = dressed(before);
          for (let options of MODELS) {
            expect(
              pruneTab(applyDocsRequests(sent, step.requests, options)),
              `${step.name} ${JSON.stringify(options)}`,
            ).toStrictEqual(applyDocsRequests(pruneTab(sent), step.requests, options));
          }
          before = step.after;
        }
      });
    }
  });

  it("keeps a tab's title, a person's name and address and a rich link's title and address", () => {
    let pruned = pruneTab(dressed(RICHEST));
    expect(pruned.title).toBe("Every element");
    expect(pruned.parentTabId).toBe("t.parent");
    let elements = [...paragraphsOf(pruned.body.content)].flatMap(paragraph => paragraph.elements);
    expect(elements.flatMap(element => element.person?.personProperties ?? [])).toStrictEqual([
      { name: "Ada Lovelace", email: "ada@example.com" },
      { email: "grace@example.com" },
    ]);
    expect(elements.flatMap(element => element.richLink?.richLinkProperties ?? []))
      .toStrictEqual([{ title: "Plan", uri: "https://example.com/plan" }]);
  });

  it("returns a tab that holds one of each kept field as it is", () => {
    // One of each field a pruned tab may hold and nothing else, none at a value pruning could
    // write without reading it. Its indexes are no document's: pruning reads none.
    let look: ModelTextStyle = {
      bold: true, italic: true, strikethrough: true, underline: true,
      link: { url: "https://example.com/" },
      foregroundColor: { color: { rgbColor: { red: 0.5, green: 0.25, blue: 1 } } },
      fontSize: { magnitude: 16, unit: "PT" },
    };
    let chipLook: TextStyle = { italic: true };
    let links: TextStyle["link"][] = [
      { tabId: "t.other" }, { bookmarkId: "kix.bookmark" }, { headingId: "h.heading" },
      { bookmark: { id: "kix.bookmark", tabId: "t.other" } },
      { heading: { id: "h.heading", tabId: "t.other" } },
    ];
    let paragraphStyle: ModelParagraphStyle = {
      namedStyleType: "HEADING_2", headingId: "h.heading", alignment: "CENTER",
      indentStart: { magnitude: 36, unit: "PT" }, indentFirstLine: { magnitude: 18, unit: "PT" },
    };
    let kinds: Omit<ParagraphElement, "startIndex" | "endIndex">[] = [
      { textRun: { content: "Text", textStyle: look } },
      ...links.map(link => ({ textRun: { content: "to", textStyle: { link } } })),
      { autoText: { type: "PAGE_NUMBER", textStyle: chipLook } },
      { horizontalRule: {} },
      { pageBreak: { textStyle: chipLook } },
      { columnBreak: { textStyle: chipLook } },
      { footnoteReference: { footnoteId: "kix.note", footnoteNumber: "7", textStyle: chipLook } },
      { equation: {} },
      { inlineObjectElement: { inlineObjectId: "kix.inline", textStyle: chipLook } },
      {
        person: {
          textStyle: chipLook, personProperties: { name: "Person 1", email: "person1@example.com" },
        },
      },
      {
        richLink: {
          textStyle: chipLook, richLinkProperties: { title: "Link 1", uri: "https://example.com/1" },
        },
      },
      { dateElement: { textStyle: chipLook, dateElementProperties: { displayText: "Jan 5, 2026" } } },
      {
        dropdown: {
          dropdownId: "kix.dropdown", textStyle: chipLook,
          dropdownProperties: {
            dropdownDefinitionId: "kix.definition", selectedOptionId: "kix.option", displayValue: "Open",
          },
        },
      },
      { textRun: { content: "\n", textStyle: {} } },
    ];
    let paragraph: Paragraph = {
      elements: kinds.map((kind, index) => ({ startIndex: 1 + index, endIndex: 2 + index, ...kind })),
      paragraphStyle,
      bullet: { listId: "kix.list", nestingLevel: 1 },
      positionedObjectIds: ["kix.positioned"],
    };
    let border: TableCellBorder = {
      color: { color: { rgbColor: { red: 1, green: 0.5, blue: 0.25 } } },
      width: { magnitude: 2, unit: "UNIT_UNSPECIFIED" }, dashStyle: "DASH",
    };
    let padding = { magnitude: 8, unit: "PT" };
    let suggested = { suggestedInsertionIds: ["suggest.in"], suggestedDeletionIds: ["suggest.out"] };
    let table: Table = {
      tableRows: [{
        startIndex: 31, endIndex: 35,
        tableCells: [{
          startIndex: 32, endIndex: 35,
          content: [{
            startIndex: 33, endIndex: 35,
            paragraph: {
              elements: [{ startIndex: 33, endIndex: 35, textRun: { content: "a\n", textStyle: {} } }],
              paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
            },
          }],
          tableCellStyle: {
            rowSpan: 2, columnSpan: 3, contentAlignment: "MIDDLE",
            backgroundColor: { color: { rgbColor: { red: 0.25, green: 1, blue: 0.5 } } },
            paddingTop: padding, paddingRight: padding, paddingBottom: padding, paddingLeft: padding,
            borderTop: border, borderRight: border, borderBottom: border, borderLeft: border,
          },
          ...suggested,
        }],
        tableRowStyle: { tableHeader: true, minRowHeight: { magnitude: 24, unit: "PT" } },
        ...suggested,
      }],
      tableStyle: {
        tableColumnProperties: [{ widthType: "FIXED_WIDTH", width: { magnitude: 120, unit: "PT" } }],
      },
      ...suggested,
    };
    let tab: GoogleDocsTab = {
      tabId: "t.child", title: "Every field", parentTabId: "t.parent", index: 2, nestingLevel: 1,
      body: {
        content: [
          { startIndex: 0, endIndex: 1, sectionBreak: {} },
          { startIndex: 1, endIndex: 30, paragraph },
          { startIndex: 30, endIndex: 36, table },
          { startIndex: 36, endIndex: 37, tableOfContents: {} },
        ],
      },
      lists: {
        "kix.list": {
          listProperties: { nestingLevels: [{ glyphType: "DECIMAL", glyphSymbol: "●", startNumber: 3 }] },
        },
      },
      namedRanges: {},
      namedStyles: {
        styles: [
          { namedStyleType: "HEADING_2", textStyle: { bold: true, italic: true, strikethrough: true } },
        ],
      },
    };
    // Google leaves out the start index of the section break that opens a body.
    Reflect.deleteProperty(tab.body.content[0], "startIndex");

    expect(pruneTab(tab)).toStrictEqual(tab);
    expect(pruneTab(dressed(tab))).toStrictEqual(tab);
    // Its names are their own stand-ins, so a recording changes its title alone.
    expect(prunedTab(tab)).toStrictEqual({ ...tab, title: "" });
  });

  it("shares no object or array with the tab it was given", () => {
    let recorded = FIXTURES.find(fixture => fixture.name === "around-tables")!.steps.at(-1)!.after;
    for (let tab of [recorded, RICHEST, dressed(RICHEST)]) {
      let sent = partsOf(tab);
      let shared = [...partsOf(pruneTab(tab))].filter(part => sent.has(part));
      expect(shared).toStrictEqual([]);

      // And so a tab that cannot change prunes to one that can, everywhere.
      let pruned = pruneTab(deepFrozen(structuredClone(tab)));
      for (let part of partsOf(pruned)) {
        if (Array.isArray(part)) part.push(null);
        else Object.assign(part, { changed: true });
      }
    }
  });
});

// The whitelist and the version of the stored copy move together: a stored copy whose revision
// Google confirms is not fetched again, so one pruned by another whitelist would be served
// under an unchanged version for as long as its document stood. A change to this list is a
// change to what a stored copy holds, and `DOC_COPY_FORMAT_VERSION` changes with it.
it("keeps exactly these fields under this format version", () => {
  let tabs = [RICHEST, ...RECORDED.map(({ tab }) => tab)].map(tab => pruneTab(dressed(tab)));
  expect({ version: DOC_COPY_FORMAT_VERSION, fields: keptFields(tabs) }).toStrictEqual({
    version: 3,
    fields: {
      autoText: "textStyle type",
      backgroundColor: "color",
      body: "content",
      bookmark: "id tabId",
      borderBottom: "color dashStyle width",
      borderLeft: "color dashStyle width",
      borderRight: "color dashStyle width",
      borderTop: "color dashStyle width",
      bullet: "listId nestingLevel",
      color: "color rgbColor",
      columnBreak: "textStyle",
      content: "endIndex paragraph sectionBreak startIndex table tableOfContents",
      dateElement: "dateElementProperties textStyle",
      dateElementProperties: "displayText",
      dropdown: "dropdownId dropdownProperties textStyle",
      dropdownProperties: "displayValue dropdownDefinitionId selectedOptionId",
      elements: "autoText columnBreak dateElement dropdown endIndex equation footnoteReference " +
        "horizontalRule inlineObjectElement pageBreak person richLink startIndex textRun",
      equation: "",
      fontSize: "magnitude unit",
      footnoteReference: "footnoteId footnoteNumber textStyle",
      foregroundColor: "color",
      heading: "id tabId",
      horizontalRule: "",
      indentFirstLine: "magnitude unit",
      indentStart: "magnitude unit",
      inlineObjectElement: "inlineObjectId textStyle",
      link: "bookmark bookmarkId heading headingId tabId url",
      listProperties: "nestingLevels",
      // The keys of `lists` are the lists' ids, which no version names.
      lists: "",
      "lists.*": "listProperties",
      minRowHeight: "magnitude unit",
      namedRanges: "",
      namedStyles: "styles",
      nestingLevels: "glyphSymbol glyphType startNumber",
      paddingBottom: "magnitude unit",
      paddingLeft: "magnitude unit",
      paddingRight: "magnitude unit",
      paddingTop: "magnitude unit",
      pageBreak: "textStyle",
      paragraph: "bullet elements paragraphStyle positionedObjectIds",
      paragraphStyle: "alignment headingId indentFirstLine indentStart namedStyleType",
      person: "personProperties textStyle",
      personProperties: "email name",
      rgbColor: "blue green red",
      richLink: "richLinkProperties textStyle",
      richLinkProperties: "title uri",
      sectionBreak: "",
      styles: "namedStyleType textStyle",
      tab: "body index lists namedRanges namedStyles nestingLevel parentTabId tabId title",
      table: "suggestedDeletionIds suggestedInsertionIds tableRows tableStyle",
      tableCellStyle: "backgroundColor borderBottom borderLeft borderRight borderTop columnSpan " +
        "contentAlignment paddingBottom paddingLeft paddingRight paddingTop rowSpan",
      tableCells: "content endIndex startIndex suggestedDeletionIds suggestedInsertionIds " +
        "tableCellStyle",
      tableColumnProperties: "width widthType",
      tableOfContents: "",
      tableRowStyle: "minRowHeight tableHeader",
      tableRows: "endIndex startIndex suggestedDeletionIds suggestedInsertionIds tableCells " +
        "tableRowStyle",
      tableStyle: "tableColumnProperties",
      textRun: "content textStyle",
      textStyle: "bold fontSize foregroundColor italic link strikethrough underline",
      width: "magnitude unit",
    },
  });
});

// ---------------------------------------------------------------------------
// The copy and its stored form
// ---------------------------------------------------------------------------

/** What `StoredBase` hands out over `parts`: a partition that cannot be decoded reads as none. */
function heldOf(parts: ReadonlyMap<string, Uint8Array>): HeldBase<DocCopyPart> {
  return {
    keys: [...parts.keys()],
    fetchedAt: 0,
    part(key) {
      let bytes = parts.get(key);
      if (!bytes) return undefined;
      try {
        return decodeDocCopyPart(key, bytes);
      } catch {
        return undefined;
      }
    },
  };
}

describe("the copy of a document", () => {
  let recorded = FIXTURES[0].before;
  let marked: GoogleDocsTab = { ...RICHEST, tabId: "t.marked", namedRanges: MARKED };
  let plain: GoogleDocsTab = { ...recorded, tabId: "t.plain", title: "Café ✓ 🙂" };
  let emptyRun: GoogleDocsTab = { ...buildTab([{ runs: ["a", "", "b\n"] }]), tabId: "t.empty-run" };
  let child: GoogleDocsTab = { ...plain, tabId: "t.child", parentTabId: "t.plain", nestingLevel: 1 };
  /** The identity the outline holds of `tab`: its place and name, and no key for a parent it lacks. */
  let identityOf = ({ tabId, title, parentTabId, index, nestingLevel }: GoogleDocsTab) =>
    ({ tabId, title, ...(parentTabId === undefined ? {} : { parentTabId }), index, nestingLevel });

  it("holds each tab pruned, in the document's order, without its named ranges", () => {
    let tabs = [dressed(marked), plain, child, emptyRun];
    let copy = docCopy(documentOf(tabs));
    expect(copy.outline).toStrictEqual([marked, plain, child, emptyRun].map(identityOf));
    expect(copy.outline).toBe(copy.outline);
    for (let tab of [marked, plain, child, emptyRun]) {
      expect(copy.tab(tab.tabId)?.tab).toStrictEqual(pruneTab(tab));
      expect(copy.tab(tab.tabId)?.tab.namedRanges).toStrictEqual({});
      expect(copy.tab(tab.tabId)).toBe(copy.tab(tab.tabId));
    }
    expect(copy.tab("t.other")).toBeUndefined();
  });

  it("holds the ids of the writes whose markers a tab came with", () => {
    let copy = docCopy(documentOf([marked, plain]));
    expect(copy.tab("t.marked")?.committedWriteIds).toStrictEqual(["first", "second"]);
    expect(copy.tab("t.plain")?.committedWriteIds).toStrictEqual([]);
  });

  it("keeps each write marker's write and range id, and works the committed writes out of them", () => {
    // Two markers of one write, a named range that marks no write, and a marker of another.
    let copy = docCopy(documentOf([marked, plain]));
    let markers = [
      { writeId: "first", id: "range.1" },
      { writeId: "first", id: "range.2" },
      { writeId: "second", id: "range.4" },
    ];
    expect(copy.tab("t.marked")?.writeMarkers).toStrictEqual(markers);
    expect(copy.tab("t.marked")?.committedWriteIds).toStrictEqual(["first", "second"]);
    expect(copy.tab("t.plain")?.writeMarkers).toStrictEqual([]);

    let read = decodeDocCopyPart("t.marked", encodeDocCopy(copy).get("t.marked")!) as DocTabCopy;
    expect(read.writeMarkers).toStrictEqual(markers);
    expect(read.committedWriteIds).toStrictEqual(["first", "second"]);

    // A range Google lists twice is one marker.
    let twice: GoogleDocsTab = { ...plain, namedRanges: {
      "gadgets-write-first": { namedRanges: [
        { namedRangeId: "range.1", name: "gadgets-write-first" },
        { namedRangeId: "range.1", name: "gadgets-write-first" },
      ] },
    } };
    expect(docCopy(documentOf([twice])).tab("t.plain")?.writeMarkers)
      .toStrictEqual([{ writeId: "first", id: "range.1" }]);
  });

  it("names the tabs that are not indexed as the model indexes them", () => {
    expect(hasModelIndexes(recorded)).toBe(true);
    let copy = docCopy(documentOf([plain, emptyRun]));
    expect(copy.tab("t.plain")?.unindexed).toBe(false);
    expect(copy.tab("t.empty-run")?.unindexed).toBe(true);
  });

  it("is stored as its outline and then one partition for each tab, and read back as it was", () => {
    let copy = docCopy(documentOf([dressed(marked), plain, child, emptyRun]));
    let parts = encodeDocCopy(copy);
    expect([...parts.keys()]).toStrictEqual(
      [DOC_OUTLINE_PARTITION, "t.marked", "t.plain", "t.child", "t.empty-run"]);
    let json = (key: string): unknown => JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(parts.get(key)));
    expect(json(DOC_OUTLINE_PARTITION)).toStrictEqual(copy.outline);
    expect(decodeDocCopyPart(DOC_OUTLINE_PARTITION, parts.get(DOC_OUTLINE_PARTITION)!))
      .toStrictEqual(copy.outline);
    for (let { tabId } of copy.outline) {
      let { tab, writeMarkers } = copy.tab(tabId)!;
      expect(json(tabId)).toStrictEqual({ tab, writeMarkers });
      expect(decodeDocCopyPart(tabId, parts.get(tabId)!)).toStrictEqual(copy.tab(tabId));
    }

    let read = storedDocCopy(heldOf(parts));
    expect(read?.outline).toStrictEqual(copy.outline);
    expect(read?.outline[1].title).toBe("Café ✓ 🙂");
    expect(read?.tab("t.empty-run")).toStrictEqual(copy.tab("t.empty-run"));
    expect(read?.tab("t.empty-run")?.unindexed).toBe(true);
    expect(read?.tab("t.other")).toBeUndefined();
    // The outline is no tab, whatever its key.
    expect(read?.tab(DOC_OUTLINE_PARTITION)).toBeUndefined();
  });

  it("decodes a tab only when it is asked for", () => {
    let parts = encodeDocCopy(docCopy(documentOf([marked, plain])));
    let asked: string[] = [];
    let held = heldOf(parts);
    let read = storedDocCopy({ ...held, part: key => (asked.push(key), held.part(key)) });
    expect(asked).toEqual([DOC_OUTLINE_PARTITION]);
    read?.tab("t.plain");
    expect(asked).toEqual([DOC_OUTLINE_PARTITION, "t.plain"]);
  });

  it("is no copy where the outline cannot be read back or does not list the tabs held", () => {
    let copy = docCopy(documentOf([marked, plain]));
    let parts = encodeDocCopy(copy);
    let withOutline = (outline: unknown) =>
      new Map(parts).set(DOC_OUTLINE_PARTITION, bytesOf(outline));
    expect(storedDocCopy(heldOf(parts))).toBeDefined();

    let [first, second] = copy.outline;
    for (let [name, held] of Object.entries({
      "no outline": new Map([...parts].filter(([key]) => key !== DOC_OUTLINE_PARTITION)),
      "an outline that is not one": new Map(parts).set(
        DOC_OUTLINE_PARTITION, new TextEncoder().encode("{ a secret")),
      "one tab too few": withOutline([first]),
      "one tab too many": withOutline([first, second, { ...second, tabId: "t.more" }]),
      "another tab": withOutline([first, { ...second, tabId: "t.more" }]),
      "another order": withOutline([second, first]),
      "a tab with no partition": new Map([...parts].filter(([key]) => key !== "t.plain")),
    })) {
      expect(storedDocCopy(heldOf(held)), name).toBeUndefined();
    }
  });

  it("throws the read-back error for a listed tab whose partition is gone or is not one", () => {
    let parts = encodeDocCopy(docCopy(documentOf([marked, plain])));
    let unreadable = "The stored copy of this Google Doc could not be read back. Read it again.";
    let held = heldOf(parts);
    // Replaced in storage since the copy was taken: the kit serves nothing for the key.
    let gone = storedDocCopy({ ...held, part: key => key === "t.plain" ? undefined : held.part(key) });
    expect(gone?.tab("t.marked")).toBeDefined();
    expect(() => gone?.tab("t.plain")).toThrow(unreadable);

    let broken = storedDocCopy(heldOf(new Map(parts).set("t.plain", bytesOf({ tab: [] }))));
    expect(() => broken?.tab("t.plain")).toThrow(unreadable);
  });

  it("is not read from a partition that is not one", () => {
    let tab = pruneTab(plain);
    let invalid = /^The stored copy of a Google Doc holds a tab that is not one$/;
    let writeMarkers = [{ writeId: "first", id: "range.1" }];
    expect(decodeDocCopyPart("t.plain", bytesOf({ tab, writeMarkers })))
      .toStrictEqual({ tab, writeMarkers, committedWriteIds: ["first"], unindexed: false });

    // Never the parser's own text, which quotes what it stopped at.
    for (let key of ["t.plain", DOC_OUTLINE_PARTITION]) {
      expect(() => decodeDocCopyPart(key, new TextEncoder().encode("{ a secret"))).toThrow(invalid);
    }
    for (let partition of [
      null,
      [],
      { writeMarkers: [] },
      { tab: [], writeMarkers: [] },
      { tab: { ...tab, title: undefined }, writeMarkers: [] },
      { tab: { ...tab, index: "0" }, writeMarkers: [] },
      { tab: { ...tab, nestingLevel: undefined }, writeMarkers: [] },
      { tab: { ...tab, body: undefined }, writeMarkers: [] },
      { tab: { ...tab, body: { content: [] } }, writeMarkers: [] },
      { tab: { ...tab, lists: undefined }, writeMarkers: [] },
      { tab },
      { tab, writeMarkers: "first" },
      { tab, writeMarkers: ["first"] },
      { tab, writeMarkers: [null] },
      { tab, writeMarkers: [{ writeId: "first" }] },
      { tab, writeMarkers: [{ id: "range.1" }] },
      { tab, writeMarkers: [{ writeId: "first", id: 1 }] },
      { tab, writeMarkers: [{ writeId: 1, id: "range.1" }] },
      { tab, writeMarkers: [...writeMarkers, { writeId: "second" }] },
      // The form that held the write ids alone.
      { tab, committedWriteIds: ["first"] },
    ]) {
      expect(() => decodeDocCopyPart("t.plain", bytesOf(partition)),
        JSON.stringify(partition)?.slice(0, 80)).toThrow(invalid);
    }
    expect(() => decodeDocCopyPart("t.other", bytesOf({ tab, writeMarkers: [] })))
      .toThrow(invalid);

    let identity = identityOf(child);
    expect(decodeDocCopyPart(DOC_OUTLINE_PARTITION, bytesOf([identity]))).toStrictEqual([identity]);
    for (let outline of [
      null,
      {},
      { tab, writeMarkers: [] },
      [null],
      [[]],
      [{ ...identity, tabId: 1 }],
      [{ ...identity, title: undefined }],
      [{ ...identity, parentTabId: 1 }],
      [{ ...identity, index: "0" }],
      [{ ...identity, nestingLevel: undefined }],
      [identity, "t.plain"],
    ]) {
      expect(() => decodeDocCopyPart(DOC_OUTLINE_PARTITION, bytesOf(outline)),
        JSON.stringify(outline)?.slice(0, 80)).toThrow(invalid);
    }
  });
});

describe("the named styles of a new document", () => {
  it("are those every recording began with", () => {
    for (let fixture of FIXTURES) {
      expect(fixture.before.namedStyles, fixture.name).toStrictEqual(NEW_DOCUMENT_NAMED_STYLES);
    }
  });

  it("hold nothing pruning drops", () => {
    let tab = { ...buildTab([{ runs: ["\n"] }]), namedStyles: NEW_DOCUMENT_NAMED_STYLES };
    expect(pruneTab(tab).namedStyles).toStrictEqual(NEW_DOCUMENT_NAMED_STYLES);
  });

  it("a document not created yet has the named styles of a new one", async () => {
    let { tabs: [tab] } = await new BlankGoogleDoc("Notes").getDocument("");
    expect(tab.namedStyles).toStrictEqual(NEW_DOCUMENT_NAMED_STYLES);
    // Its own copy of them: a tab is never changed, and neither is the constant.
    expect(tab.namedStyles).not.toBe(NEW_DOCUMENT_NAMED_STYLES);
    expect(hasModelIndexes(tab)).toBe(true);
    expect(pruneTab(tab)).toStrictEqual(tab);
  });
});
