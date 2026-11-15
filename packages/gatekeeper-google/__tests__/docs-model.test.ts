import { describe, expect, it } from "vitest";
import type {
  GoogleDocsRequest, GoogleDocsTab, NestingLevel, Paragraph, StructuralElement, TableCell,
  TableCellLocation, TableCellStyle, TableRow,
} from "../src/docs-api";
import contentSource from "../src/docs-content.ts?raw";
import {
  applyDocsRequests, hasModelIndexes, LINK_COLOR, modelPlaceAfter, NotModelledError, replayCost,
  sameValue, unindexedTabRefusal,
} from "../src/docs-model";
import type {
  ModelCost, ModelParagraphStyle, ModelPlace, ModelTextStyle,
} from "../src/docs-model";
import modelSource from "../src/docs-model.ts?raw";
import {
  MAX_TAB_TABLE_CELLS, MAX_TABLE_TEXT_REQUESTS, tableChangeRequests, tableIdentity,
  tableTextRequests, textReplacementRequests,
} from "../src/docs-tables";
import { docTabToMarkdown } from "../src/markdown-converter";
import { BULLET_LIST, buildTab, cellOf, diceOf, para, presetLevels } from "./doc-fixture";
import type { BlockSpec, Dice, ParagraphSpec, TableSpec } from "./doc-fixture";
import {
  alignmentAt, fontSizeAt, hasLinkLook, indentedParagraphs, pinnedHeaderRows, tableElement,
  tableTexts,
} from "./docs-model-probes";

const TAB = "tab-1";
const LINK_A = { url: "https://a.example" };
const LINK_B = { url: "https://b.example" };
const CHIP_PLACEHOLDER = "\uE907";
const FOUR_FIELDS = "bold,italic,strikethrough,link";

const OUTSIDE_PARAGRAPH = "The insertion index must be inside the bounds of an existing paragraph.";
const INVALID_DELETION = "Invalid deletion range. Cannot delete the requested range.";
const EMPTY_RANGE = "The range should not be empty";

const at = (index: number) => ({ index, tabId: TAB });
const range = (startIndex: number, endIndex: number) => ({ startIndex, endIndex, tabId: TAB });
const cellAt = (table: number, rowIndex: number, columnIndex = 0): TableCellLocation =>
  ({ tableStartLocation: at(table), rowIndex, columnIndex });

const insertText = (index: number, text: string): GoogleDocsRequest =>
  ({ insertText: { location: at(index), text } });
const deleteRange = (start: number, end: number): GoogleDocsRequest =>
  ({ deleteContentRange: { range: range(start, end) } });
const styleText = (
  start: number, end: number, textStyle: ModelTextStyle, fields: string,
): GoogleDocsRequest => ({ updateTextStyle: { range: range(start, end), textStyle, fields } });
const styleParagraphs = (
  start: number, end: number, paragraphStyle: Record<string, unknown>, fields: string,
): GoogleDocsRequest =>
  ({ updateParagraphStyle: { range: range(start, end), paragraphStyle, fields } });
const deleteBullets = (start: number, end: number): GoogleDocsRequest =>
  ({ deleteParagraphBullets: { range: range(start, end) } });
const bullets = (start: number, end: number, bulletPreset: string): GoogleDocsRequest =>
  ({ createParagraphBullets: { range: range(start, end), bulletPreset } });
const insertTable = (index: number, rows: number, columns: number): GoogleDocsRequest =>
  ({ insertTable: { rows, columns, location: at(index) } });
const insertRow = (table: number, rowIndex: number, insertBelow: boolean): GoogleDocsRequest =>
  ({ insertTableRow: { tableCellLocation: cellAt(table, rowIndex), insertBelow } });
const insertColumn = (
  table: number, columnIndex: number, insertRight: boolean,
): GoogleDocsRequest =>
  ({ insertTableColumn: { tableCellLocation: cellAt(table, 0, columnIndex), insertRight } });
const deleteRow = (table: number, rowIndex: number): GoogleDocsRequest =>
  ({ deleteTableRow: { tableCellLocation: cellAt(table, rowIndex) } });
const deleteColumn = (table: number, columnIndex: number): GoogleDocsRequest =>
  ({ deleteTableColumn: { tableCellLocation: cellAt(table, 0, columnIndex) } });
const pinRows = (table: number, pinnedHeaderRowsCount: number): GoogleDocsRequest =>
  ({ pinTableHeaderRows: { tableStartLocation: at(table), pinnedHeaderRowsCount } });

const points = (magnitude: number) => ({ magnitude, unit: "PT" as const });
const sized = (magnitude: number): ModelTextStyle => ({ fontSize: points(magnitude) });

type Span = [number, number];
const span = (part: { startIndex: number; endIndex: number }): Span =>
  [part.startIndex, part.endIndex];

function paragraphOf(element: StructuralElement | undefined): Paragraph {
  if (!element?.paragraph) throw new Error("Expected a paragraph");
  return element.paragraph;
}

/** The paragraphs of the tab's body, those of its tables left out. */
function bodyParagraphs(tab: GoogleDocsTab): Paragraph[] {
  return tab.body.content.flatMap(element => element.paragraph ? [element.paragraph] : []);
}

function rowsOf(tab: GoogleDocsTab, position = 0): TableRow[] {
  return tableElement(tab, position).table?.tableRows ?? [];
}

function cellsOf(tab: GoogleDocsTab, position = 0): TableCell[][] {
  return rowsOf(tab, position).map(row => row.tableCells ?? []);
}

function cellParagraphs(cell: TableCell): Paragraph[] {
  return (cell.content ?? []).map(paragraphOf);
}

function textOf(paragraph: Paragraph): string {
  return paragraph.elements.map(element => element.textRun?.content ?? "").join("");
}

/** A paragraph's text runs, each with the style it carries. */
function runsOf(paragraph: Paragraph): [string, ModelTextStyle][] {
  return paragraph.elements.flatMap((element): [string, ModelTextStyle][] =>
    element.textRun ? [[element.textRun.content, element.textRun.textStyle]] : []);
}

/** A paragraph's text runs as Google returns them: adjacent runs of one style as one run. */
function joinedRunsOf(paragraph: Paragraph): [string, ModelTextStyle][] {
  let joined: [string, ModelTextStyle][] = [];
  for (let [text, style] of runsOf(paragraph)) {
    let last = joined.at(-1);
    if (last && JSON.stringify(last[1]) === JSON.stringify(style)) last[0] += text;
    else joined.push([text, style]);
  }
  return joined;
}

function modelStyle(paragraph: Paragraph): ModelParagraphStyle {
  return paragraph.paragraphStyle;
}

const markdownOf = (tab: GoogleDocsTab) => docTabToMarkdown(tab).markdown;

describe("table geometry", () => {
  it("puts a table inserted at the start of a paragraph after a new empty paragraph", () => {
    let tab = buildTab([{ runs: ["Before\n"] }, { runs: ["After\n"] }]);
    let result = applyDocsRequests(tab, [insertTable(8, 2, 3)]);

    expect(result.body.content.map(span)).toEqual([[0, 1], [1, 8], [8, 9], [9, 25], [25, 31]]);
    expect(bodyParagraphs(result).map(textOf)).toEqual(["Before\n", "\n", "After\n"]);
    let [firstRow, secondRow] = rowsOf(result);
    expect(span(firstRow)).toEqual([10, 17]);
    expect(span(secondRow)).toEqual([17, 24]);
    let firstCell = cellsOf(result)[0][0];
    expect(span(firstCell)).toEqual([11, 13]);
    expect((firstCell.content ?? []).map(span)).toEqual([[12, 13]]);
    expect(tableTexts(result)).toEqual([["\n", "\n", "\n"], ["\n", "\n", "\n"]]);
  });

  it("gives every row a cell of two indexes beside the named column", () => {
    let tab = buildTab([
      { runs: ["Before\n"] },
      { runs: ["\n"] },
      { table: [["\n", "\n"], ["r0c0\n", "r0c1\n"], ["\n", "\n"], ["r1c0\n", "r1c1\n"]] },
      { runs: ["After\n"] },
    ]);
    expect(span(tableElement(tab))).toEqual([9, 47]);

    let result = applyDocsRequests(tab, [insertColumn(9, 0, true)]);

    expect(cellsOf(result).map(row => span(row[1]))).toEqual([
      [13, 15], [24, 26], [35, 37], [46, 48],
    ]);
    expect(span(tableElement(result))).toEqual([9, 55]);
    expect(tableTexts(result)).toEqual([
      ["\n", "\n", "\n"], ["r0c0\n", "\n", "r0c1\n"], ["\n", "\n", "\n"],
      ["r1c0\n", "\n", "r1c1\n"],
    ]);
  });

  it("adds a row above or below the named row, and a column left or right of the named one", () => {
    let tab = buildTab([
      { runs: ["\n"] }, { table: [["a\n", "b\n"], ["c\n", "d\n"]] }, { runs: ["\n"] },
    ]);

    expect(tableTexts(applyDocsRequests(tab, [insertRow(2, 1, false)])))
      .toEqual([["a\n", "b\n"], ["\n", "\n"], ["c\n", "d\n"]]);
    expect(tableTexts(applyDocsRequests(tab, [insertRow(2, 1, true)])))
      .toEqual([["a\n", "b\n"], ["c\n", "d\n"], ["\n", "\n"]]);
    expect(tableTexts(applyDocsRequests(tab, [insertColumn(2, 1, false)])))
      .toEqual([["a\n", "\n", "b\n"], ["c\n", "\n", "d\n"]]);
    expect(tableTexts(applyDocsRequests(tab, [insertColumn(2, 1, true)])))
      .toEqual([["a\n", "b\n", "\n"], ["c\n", "d\n", "\n"]]);
    expect(tableTexts(applyDocsRequests(tab, [deleteRow(2, 0)]))).toEqual([["c\n", "d\n"]]);
    expect(tableTexts(applyDocsRequests(tab, [deleteColumn(2, 0)]))).toEqual([["b\n"], ["d\n"]]);
  });

  it("applies each request of a batch to what the one before it left", () => {
    let tab = buildTab([{ runs: ["\n"] }, { table: [["a\n"]] }, { runs: ["\n"] }]);
    // The table is [2, 8): its row is [3, 7), and a row added below it starts where it ends.
    let result = applyDocsRequests(tab, [
      insertRow(2, 0, true), insertRow(2, 1, true),
      insertText(12, "third"), insertText(9, "second"),
    ]);

    expect(tableTexts(result)).toEqual([["a\n"], ["second\n"], ["third\n"]]);
  });

  it("leaves the tab it is given as it was", () => {
    let tab = buildTab([{ runs: ["Before\n"] }, { runs: ["After\n"] }]);
    let copy = structuredClone(tab);
    applyDocsRequests(tab, [insertTable(8, 1, 1), insertText(1, "x")]);

    expect(tab).toEqual(copy);
  });
});

const threeRowTable = () => buildTab([
  { runs: ["Before\n"] },
  { table: [["ab\n", "cd\n"], ["\n", "\n"], ["\n", "\n"]] },
  { runs: ["After\n"] },
]);

// The table is [8, 29): row 0 [9, 18), cell (0,0) [10, 14) with its paragraph at 11, cell (0,1)
// [14, 18) with its paragraph at 15.
const refusal = (requests: GoogleDocsRequest[], tab = threeRowTable()) =>
  () => applyDocsRequests(tab, requests);

describe("what Google refuses", () => {
  it("refuses text at a cell's, a row's or a table's own index", () => {
    let message = `${OUTSIDE_PARAGRAPH} You can still create new paragraphs by inserting newlines.`;
    expect(span(cellsOf(threeRowTable())[0][0])).toEqual([10, 14]);
    expect(refusal([insertText(10, "x")])).toThrow(message);
    expect(refusal([insertText(9, "x")])).toThrow(message);
    expect(refusal([insertText(8, "x")])).toThrow(message);
  });

  // Each request is sent alone to the table of three rows.
  it.each<[string, GoogleDocsRequest[], string]>([
    ["a deletion that starts in one cell and ends in the next",
      [deleteRange(11, 16)], INVALID_DELETION],
    ["the deletion of a cell's final line break, of a whole cell and of a whole row",
      [deleteRange(11, 14), deleteRange(10, 14), deleteRange(9, 18)], INVALID_DELETION],
    ["a deletion that crosses a table's edge without holding the whole table",
      [deleteRange(5, 12), deleteRange(15, 33)], INVALID_DELETION],
    ["the deletion of the line break before a table, and of the last one of the body",
      [deleteRange(1, 8), deleteRange(31, 35)], INVALID_DELETION],
    ["an empty range", [deleteRange(11, 11), styleText(11, 11, {}, "bold")], EMPTY_RANGE],
    ["a table location that is not the table's start index",
      [insertRow(9, 0, true), insertColumn(7, 0, true), deleteRow(10, 0), deleteColumn(11, 0),
        pinRows(9, 1)],
      "Invalid table start location. Must specify the start index of the table."],
    ["the deletion of a row past the last",
      [deleteRow(8, 99)], "The row index 99 should be less than the total number of rows 3."],
    ["a row added beside a row past the last",
      [insertRow(8, 3, true)], "The row index 3 should be less than the total number of rows 3."],
    ["a column added beside a column past the last",
      [insertColumn(8, 2, true)],
      "The column index 2 should be less than the total number of columns 2."],
    ["a table of no rows",
      [insertTable(1, 0, 2)], "The number of table rows should be greater than zero."],
    ["a table at a table's start index", [insertTable(8, 1, 1)], OUTSIDE_PARAGRAPH],
  ])("refuses %s", (_, requests, message) => {
    for (let request of requests) expect(refusal([request])).toThrow(message);
  });

  it("refuses to delete the paragraph between two tables", () => {
    let tab = buildTab([
      { runs: ["\n"] }, { table: [["\n"]] }, { runs: ["\n"] }, { table: [["\n"]] },
      { runs: ["\n"] },
    ]);
    expect(span(tab.body.content[3])).toEqual([7, 8]);
    expect(refusal([deleteRange(7, 8)], tab)).toThrow(INVALID_DELETION);
  });

  it("refuses to delete half of a surrogate pair, or to insert between its halves", () => {
    // "a" is at 1, the pair at 2 and 3, "b" at 4.
    let tab = buildTab([{ runs: ["a\u{1F600}b\n"] }]);
    expect(refusal([deleteRange(2, 3)], tab)).toThrow(INVALID_DELETION);
    expect(refusal([deleteRange(3, 5)], tab)).toThrow(INVALID_DELETION);
    expect(refusal([insertText(3, "x")], tab))
      .toThrow("The insertion index cannot be within a grapheme cluster.");
    expect(textOf(bodyParagraphs(applyDocsRequests(tab, [deleteRange(2, 4)]))[0])).toBe("ab\n");
  });

  it("applies nothing of a batch when it throws", () => {
    let tab = threeRowTable();
    let copy = structuredClone(tab);
    expect(refusal([insertText(1, "x"), deleteRange(11, 16)], tab)).toThrow(INVALID_DELETION);
    expect(tab).toEqual(copy);
  });
});

describe("deletions Google accepts", () => {
  it("deletes text inside a cell's paragraph short of its line break", () => {
    let tab = buildTab([{ runs: ["\n"] }, { table: [["abc\n"]] }, { runs: ["\n"] }]);
    let result = applyDocsRequests(tab, [deleteRange(5, 8), insertText(5, "new")]);

    expect(tableTexts(result)).toEqual([["new\n"]]);
  });

  it("deletes exactly a table and leaves the paragraphs around it", () => {
    let tab = buildTab([
      { runs: ["Before\n"] }, { table: [["a\n", "b\n"]] }, { runs: ["After\n"] },
    ]);
    let result = applyDocsRequests(tab, [deleteRange(8, 17)]);

    expect(result.body.content.map(span)).toEqual([[0, 1], [1, 8], [8, 14]]);
    expect(bodyParagraphs(result).map(textOf)).toEqual(["Before\n", "After\n"]);
  });

  it("deletes the paragraph that follows a table when another follows it", () => {
    let tab = buildTab([
      { runs: ["Before\n"] }, { table: [["\n"]] }, { runs: ["mid\n"] }, { runs: ["After\n"] },
    ]);
    expect(span(tableElement(tab))).toEqual([8, 13]);
    let result = applyDocsRequests(tab, [deleteRange(13, 17)]);

    expect(span(tableElement(result))).toEqual([8, 13]);
    expect(result.body.content.map(span)).toEqual([[0, 1], [1, 8], [8, 13], [13, 19]]);
    expect(bodyParagraphs(result).map(textOf)).toEqual(["Before\n", "After\n"]);
  });

  it("joins two paragraphs under the style and bullet of the one whose line break remains", () => {
    let tab = buildTab([
      { runs: ["Head\n"], namedStyleType: "HEADING_1" },
      { runs: ["item\n"], bullet: { listId: "L1" } },
    ], BULLET_LIST);
    let result = applyDocsRequests(tab, [deleteRange(3, 8)]);

    let [joined] = bodyParagraphs(result);
    expect(bodyParagraphs(result)).toHaveLength(1);
    expect(textOf(joined)).toBe("Heem\n");
    expect(joined.paragraphStyle.namedStyleType).toBe("NORMAL_TEXT");
    expect(joined.bullet).toEqual({ listId: "L1" });
  });

  // Inferred, not on record: nothing of the positioned paragraph changes, so its image stays.
  it("keeps a positioned image's paragraph when whole paragraphs in front of it are deleted", () => {
    let tab = buildTab([{ runs: ["O\n"] }, { runs: ["P\n"] }, { runs: ["Q\n"] }]);
    bodyParagraphs(tab)[2].positionedObjectIds = ["image-1"];
    let result = applyDocsRequests(tab, [deleteRange(3, 5)]);

    expect(bodyParagraphs(result).map(paragraph =>
      [textOf(paragraph), paragraph.positionedObjectIds])).toEqual([
      ["O\n", undefined], ["Q\n", ["image-1"]],
    ]);
  });
});

const pinnedTable = () => buildTab([
  { runs: ["\n"] }, { table: [["H\n"], ["a\n"], ["b\n"]], headerRows: 1 }, { runs: ["\n"] },
]);

describe("rows, columns and header rows", () => {

  it("pins a row added above or below a pinned header row", () => {
    expect(pinnedHeaderRows(pinnedTable(), 2)).toBe(1);
    let above = applyDocsRequests(pinnedTable(), [insertRow(2, 0, false)]);
    let below = applyDocsRequests(pinnedTable(), [insertRow(2, 0, true)]);

    expect(pinnedHeaderRows(above, 2)).toBe(2);
    expect(pinnedHeaderRows(below, 2)).toBe(2);
    expect(tableTexts(above)).toEqual([["\n"], ["H\n"], ["a\n"], ["b\n"]]);
    expect(tableTexts(below)).toEqual([["H\n"], ["\n"], ["a\n"], ["b\n"]]);
  });

  it("refuses a merge of a pinned header row with a row below the header, as probe M4 saw", () => {
    let tab = () => buildTab([
      { runs: ["\n"] },
      { table: [["H1\n", "H2\n"], ["a\n", "b\n"], ["c\n", "d\n"]], headerRows: 1 },
      { runs: ["\n"] },
    ]);
    expect(thrownBy(tab(), [mergeCells(2, 0, 0, 2, 1)]).message)
      .toBe("A non-rectangular collection of cells cannot be merged.");
    expect(thrownBy(tab(), [mergeCells(2, 0, 0, 3, 2)]).message)
      .toBe("A non-rectangular collection of cells cannot be merged.");

    let header = applyDocsRequests(tab(), [mergeCells(2, 0, 0, 1, 2)]);
    expect(cellsOf(header)[0][0].tableCellStyle).toMatchObject({ rowSpan: 1, columnSpan: 2 });
    let below = applyDocsRequests(tab(), [mergeCells(2, 1, 0, 2, 1)]);
    expect(cellsOf(below)[1][0].tableCellStyle).toMatchObject({ rowSpan: 2, columnSpan: 1 });
    // Two pinned rows merge with each other: inferred, the probe pinned one.
    let both = applyDocsRequests(tab(), [pinRows(2, 2), mergeCells(2, 0, 0, 2, 1)]);
    expect(cellsOf(both)[0][0].tableCellStyle).toMatchObject({ rowSpan: 2, columnSpan: 1 });
    expect(thrownBy(tab(), [pinRows(2, 2), mergeCells(2, 1, 0, 2, 1)]).message)
      .toBe("A non-rectangular collection of cells cannot be merged.");
  });

  it("does not pin a row added above the first row under the header", () => {
    let result = applyDocsRequests(pinnedTable(), [insertRow(2, 1, false)]);

    expect(pinnedHeaderRows(result, 2)).toBe(1);
    expect(rowsOf(result).map(row => row.tableRowStyle?.tableHeader === true))
      .toEqual([true, false, false, false]);
  });

  it("pins exactly the count of rows a pin request names, from the first", () => {
    let above = applyDocsRequests(pinnedTable(), [insertRow(2, 0, false), pinRows(2, 1)]);
    let below = applyDocsRequests(pinnedTable(), [insertRow(2, 0, true), pinRows(2, 1)]);

    for (let result of [above, below]) {
      expect(rowsOf(result).map(row => row.tableRowStyle?.tableHeader === true))
        .toEqual([true, false, false, false]);
    }
    expect(pinnedHeaderRows(applyDocsRequests(pinnedTable(), [pinRows(2, 2)]), 2)).toBe(2);
    expect(pinnedHeaderRows(applyDocsRequests(pinnedTable(), [pinRows(2, 0)]), 2)).toBe(0);
    // Pinning moves no index.
    expect(span(tableElement(above))).toEqual(
      span(tableElement(applyDocsRequests(pinnedTable(), [insertRow(2, 0, false)]))));
  });

  it("removes the table with its last row, and with its last column", () => {
    let tab = buildTab([
      { runs: ["Before\n"] }, { table: [["a\n", "b\n"]] }, { runs: ["After\n"] },
    ]);
    let withoutRow = applyDocsRequests(tab, [deleteRow(8, 0)]);
    let withoutColumns = applyDocsRequests(tab, [deleteColumn(8, 0), deleteColumn(8, 0)]);

    for (let result of [withoutRow, withoutColumns]) {
      expect(result.body.content.map(span)).toEqual([[0, 1], [1, 8], [8, 14]]);
      expect(bodyParagraphs(result).map(textOf)).toEqual(["Before\n", "After\n"]);
    }
  });
});

describe("chips beside a new row or column", () => {
  const PERSON = { person: { name: "Ana", email: "ana@example.com" } };
  let chips = () => buildTab([
    { runs: ["\n"] },
    {
      table: [[
        cellOf({ runs: [{ dropdown: "Open" }, "\n"] }),
        cellOf({ runs: [PERSON, "\n"] }),
        cellOf({ runs: [{ date: "Sep 16, 2026" }, "\n"] }),
        cellOf({ runs: [`${CHIP_PLACEHOLDER}\n`] }),
      ]],
    },
    { runs: ["\n"] },
  ]);

  it.each([["below", true, 1], ["above", false, 0]] as const)(
    "copies a chip that stands alone in a cell into a row added %s it",
    (_side, insertBelow, newRow) => {
      let tab = chips();
      let definition = paragraphOf(cellsOf(tab)[0][0].content?.[0]).elements[0].dropdown;
      if (!definition) throw new Error("Expected a dropdown");
      definition.dropdownProperties = {
        dropdownDefinitionId: "definition-1", selectedOptionId: "option-2", displayValue: "Open",
      };
      let result = applyDocsRequests(tab, [insertRow(2, 0, insertBelow)]);

      let [dropdown, person, date, placeholder] = cellsOf(result)[newRow];
      // Each copy takes one index, so the new cells are three indexes long.
      for (let cell of [dropdown, person, date, placeholder]) {
        expect(cell.endIndex - cell.startIndex).toBe(3);
        expect(cell.content).toHaveLength(1);
      }
      let [copy, lineBreak] = cellParagraphs(dropdown)[0].elements;
      expect(copy.dropdown?.dropdownProperties).toEqual({ dropdownDefinitionId: "definition-1" });
      expect(lineBreak.textRun?.content).toBe("\n");
      for (let cell of [person, date, placeholder]) {
        let [paragraph] = cellParagraphs(cell);
        expect(paragraph.elements.every(element => element.textRun)).toBe(true);
        expect(textOf(paragraph)).toBe(`${CHIP_PLACEHOLDER}\n`);
      }
      expect(tableElement(result).endIndex - tableElement(tab).endIndex).toBe(1 + 4 * 3);
    },
  );

  it("copies no chip into a new column", () => {
    for (let column = 0; column < 4; column++) {
      for (let insertRight of [false, true]) {
        let result = applyDocsRequests(chips(), [insertColumn(2, column, insertRight)]);
        let added = cellsOf(result)[0][insertRight ? column + 1 : column];

        expect(added.endIndex - added.startIndex).toBe(2);
        expect(cellParagraphs(added).map(textOf)).toEqual(["\n"]);
        expect(cellParagraphs(added)[0].elements).toHaveLength(1);
      }
    }
  });

  it("adds a plain row beside a chip with text, a chip among paragraphs and a lone image", () => {
    let tab = buildTab([
      { runs: ["\n"] },
      {
        table: [[
          cellOf({ runs: ["Owner ", PERSON, "\n"] }),
          cellOf({ runs: [{ dropdown: "Open" }, " now\n"] }),
          cellOf({ runs: [{ dropdown: "Open" }, "\n"] }, { runs: ["\n"] }),
          cellOf({ runs: ["\n"] }, { runs: [{ date: "Sep 16, 2026" }, "\n"] }),
          cellOf({ runs: [{ date: "" }, "\n"] }),
        ]],
      },
      { runs: ["\n"] },
    ]);
    // The last cell holds an inline image alone, which the fixture has no part for.
    let image = paragraphOf(cellsOf(tab)[0][4].content?.[0]).elements[0];
    delete image.dateElement;
    image.inlineObjectElement = { inlineObjectId: "image-1" };

    for (let insertBelow of [false, true]) {
      let result = applyDocsRequests(tab, [insertRow(2, 0, insertBelow)]);
      let added = cellsOf(result)[insertBelow ? 1 : 0];

      expect(added.map(cell => cell.endIndex - cell.startIndex)).toEqual([2, 2, 2, 2, 2]);
      expect(added.map(cell => cellParagraphs(cell).map(textOf))).toEqual(
        [["\n"], ["\n"], ["\n"], ["\n"], ["\n"]]);
    }
  });

  it("does not model a row beside a cell of two chips and no text", () => {
    let tab = buildTab([
      { runs: ["\n"] },
      { table: [[cellOf({ runs: [{ dropdown: "Open" }, PERSON, "\n"] }), "plain\n"]] },
      { runs: ["\n"] },
    ]);

    expect(() => applyDocsRequests(tab, [insertRow(2, 0, true)])).toThrow("not modelled");
    expect(tableTexts(applyDocsRequests(tab, [insertColumn(2, 0, true)])))
      .toEqual([["\n", "\n", "plain\n"]]);
  });
});

/**
 * One row: a centred, indented heading whose first character is bold and 18 points, above a
 * second paragraph; an item of a list at its second level, which states no indent; and plain
 * text.
 */
const styledRow = () => {
  let tab = buildTab([
    { runs: ["\n"] },
    {
      table: [[
        cellOf(
          {
            runs: [
              { text: "H", style: { bold: true, ...sized(18) } as ModelTextStyle }, "ead\n",
            ],
            namedStyleType: "HEADING_2",
          },
          { runs: ["second\n"] },
        ),
        cellOf({ runs: ["item\n"], bullet: { listId: "L1", nestingLevel: 1 } }),
        "plain\n",
      ]],
    },
    { runs: ["\n"] },
  ], BULLET_LIST);
  let heading = modelStyle(cellParagraphs(cellsOf(tab)[0][0])[0]);
  heading.alignment = "CENTER";
  heading.indentStart = points(20);
  return tab;
};

describe("what a new cell copies from the cell beside it", () => {

  it("copies the first paragraph's style, and its first character's onto the line break", () => {
    let tab = styledRow();
    let result = applyDocsRequests(tab, [insertRow(2, 0, true)], { copyStyles: true });
    let [fromHeading, fromItem, fromPlain] = cellsOf(result)[1];

    // One empty paragraph each, whatever the cell beside it holds.
    for (let cell of [fromHeading, fromItem, fromPlain]) {
      expect(cellParagraphs(cell).map(textOf)).toEqual(["\n"]);
      expect(cellParagraphs(cell)[0].bullet).toBeUndefined();
    }
    let [heading] = cellParagraphs(fromHeading);
    expect(modelStyle(heading)).toEqual({
      namedStyleType: "HEADING_2", alignment: "CENTER", indentStart: points(20),
    });
    expect(runsOf(heading)).toEqual([["\n", { bold: true, ...sized(18) }]]);
    expect(alignmentAt(result, fromHeading.startIndex + 1)).toBe("CENTER");
    expect(fontSizeAt(result, fromHeading.startIndex + 1)).toBe(18);

    expect(modelStyle(cellParagraphs(fromPlain)[0])).toEqual({ namedStyleType: "NORMAL_TEXT" });
    expect(runsOf(cellParagraphs(fromPlain)[0])).toEqual([["\n", {}]]);
  });

  it("indents a cell copied from a list item that states no indent", () => {
    let tab = styledRow();
    expect(indentedParagraphs(tab)).toEqual([cellsOf(tab)[0][0].startIndex + 1]);
    let result = applyDocsRequests(tab, [insertRow(2, 0, false)], { copyStyles: true });
    let [fromHeading, fromItem] = cellsOf(result)[0];

    expect(modelStyle(cellParagraphs(fromItem)[0])).toEqual({
      namedStyleType: "NORMAL_TEXT", indentStart: points(72), indentFirstLine: points(54),
    });
    expect(indentedParagraphs(result)).toEqual([
      fromHeading.startIndex + 1, fromItem.startIndex + 1, cellsOf(result)[1][0].startIndex + 1,
    ]);
  });

  it("copies into a new column from the cell of the same row in the named column", () => {
    let tab = buildTab([
      { runs: ["\n"] },
      {
        table: [
          [cellOf({ runs: [{ text: "big", style: sized(18) as ModelTextStyle }, "\n"] }), "x\n"],
          [cellOf({ runs: ["title\n"], namedStyleType: "TITLE" }), "y\n"],
        ],
      },
      { runs: ["\n"] },
    ]);
    let result = applyDocsRequests(tab, [insertColumn(2, 0, true)], { copyStyles: true });
    let [first, second] = cellsOf(result).map(row => row[1]);

    expect(runsOf(cellParagraphs(first)[0])).toEqual([["\n", sized(18)]]);
    expect(modelStyle(cellParagraphs(first)[0])).toEqual({ namedStyleType: "NORMAL_TEXT" });
    expect(runsOf(cellParagraphs(second)[0])).toEqual([["\n", {}]]);
    expect(modelStyle(cellParagraphs(second)[0])).toEqual({ namedStyleType: "TITLE" });
  });

  it("gives text put into a new cell the look the cell copied", () => {
    let tab = styledRow();
    let newParagraph = rowsOf(tab)[0].endIndex + 2;
    let copied = applyDocsRequests(
      tab, [insertRow(2, 0, true), insertText(newParagraph, "new")], { copyStyles: true });

    expect(runsOf(cellParagraphs(cellsOf(copied)[1][0])[0]))
      .toEqual([["new\n", { bold: true, ...sized(18) }]]);
    expect(fontSizeAt(copied, newParagraph)).toBe(18);
  });

  it("copies none of it otherwise", () => {
    let tab = styledRow();
    for (let options of [undefined, {}, { copyStyles: false }]) {
      let result = applyDocsRequests(
        tab, [insertRow(2, 0, true), insertColumn(2, 0, false)], options);
      let added = [...cellsOf(result)[1], cellsOf(result)[0][0]];

      for (let cell of added) {
        let [paragraph] = cellParagraphs(cell);
        expect(modelStyle(paragraph)).toEqual({ namedStyleType: "NORMAL_TEXT" });
        expect(runsOf(paragraph)).toEqual([["\n", {}]]);
        expect(paragraph.bullet).toBeUndefined();
      }
      expect(indentedParagraphs(result)).toHaveLength(1);
    }
  });
});

/** A centred paragraph whose first two characters are bold and 14 points, the rest linked. */
const formattedParagraph = () => {
  let tab = buildTab([{
    runs: [
      { text: "He", style: { bold: true, italic: true, ...sized(14) } as ModelTextStyle },
      { text: "llo", style: { link: LINK_A, underline: true } as ModelTextStyle },
      "\n",
    ],
  }]);
  modelStyle(bodyParagraphs(tab)[0]).alignment = "CENTER";
  return tab;
};

describe("the paragraph requests", () => {

  it("drops a paragraph's alignment, and the look all its text has alike, when a request names the style", () => {
    for (let namedStyleType of ["NORMAL_TEXT", "HEADING_2"]) {
      let result = applyDocsRequests(formattedParagraph(), [
        styleParagraphs(1, 7, { namedStyleType }, "namedStyleType"),
      ]);
      let [paragraph] = bodyParagraphs(result);

      expect(modelStyle(paragraph)).toEqual({ namedStyleType });
      expect(alignmentAt(result, 1)).toBeUndefined();
      // A look on part of the text stays, and so does a link (probes P2, P6).
      expect(fontSizeAt(result, 1)).toBe(14);
      expect(runsOf(paragraph)).toEqual([
        ["He", { bold: true, italic: true, ...sized(14) }],
        ["llo", { link: LINK_A, underline: true }],
        ["\n", {}],
      ]);

      // One every run has, the break's included, goes (probes P5, P6).
      let whole = buildTab([{
        runs: [
          { text: "Hel", style: { bold: true, ...sized(18) } as ModelTextStyle },
          { text: "lo", style: { bold: true, italic: true, ...sized(18) } as ModelTextStyle },
          { text: "\n", style: { bold: true, ...sized(18) } as ModelTextStyle },
        ],
      }]);
      let renamed = applyDocsRequests(whole, [styleParagraphs(1, 7, { namedStyleType }, "namedStyleType")]);
      expect(runsOf(bodyParagraphs(renamed)[0])).toEqual([["Hel", {}], ["lo", { italic: true }], ["\n", {}]]);
    }
  });

  it("keeps both when a request names only the indents, which it sets", () => {
    let result = applyDocsRequests(formattedParagraph(), [
      styleParagraphs(1, 7, { indentStart: points(10), indentFirstLine: points(4) },
        "indentStart,indentFirstLine"),
    ]);
    let [paragraph] = bodyParagraphs(result);

    expect(modelStyle(paragraph)).toEqual({
      namedStyleType: "NORMAL_TEXT", alignment: "CENTER",
      indentStart: points(10), indentFirstLine: points(4),
    });
    expect(runsOf(paragraph)).toEqual(runsOf(bodyParagraphs(formattedParagraph())[0]));
    expect(fontSizeAt(result, 1)).toBe(14);
    expect(indentedParagraphs(result)).toEqual([1]);
  });

  it("styles every paragraph a range touches", () => {
    let tab = buildTab([{ runs: ["one\n"] }, { runs: ["two\n"] }, { runs: ["three\n"] }]);
    let result = applyDocsRequests(tab, [
      styleParagraphs(4, 6, { namedStyleType: "HEADING_3" }, "namedStyleType"),
    ]);

    expect(bodyParagraphs(result).map(paragraph => paragraph.paragraphStyle.namedStyleType))
      .toEqual(["HEADING_3", "HEADING_3", "NORMAL_TEXT"]);
  });

  it("leaves a paragraph indented when its bullet is removed, and a plain one as it was", () => {
    let tab = buildTab([
      { runs: ["first\n"], bullet: { listId: "L1" } },
      { runs: ["nested\n"], bullet: { listId: "L1", nestingLevel: 1 } },
      { runs: ["plain\n"] },
    ], BULLET_LIST);
    let result = applyDocsRequests(tab, [deleteBullets(1, 20)]);
    let [first, nested, plain] = bodyParagraphs(result);

    expect(first.bullet).toBeUndefined();
    expect(nested.bullet).toBeUndefined();
    expect(modelStyle(first)).toEqual({
      namedStyleType: "NORMAL_TEXT", indentStart: points(36), indentFirstLine: points(18),
    });
    expect(modelStyle(nested)).toEqual({
      namedStyleType: "NORMAL_TEXT", indentStart: points(72), indentFirstLine: points(54),
    });
    expect(plain).toEqual(bodyParagraphs(tab)[2]);
    expect(indentedParagraphs(result)).toEqual([1, 7]);
  });

  it("keeps a list item's indent when its style is named", () => {
    // Inferred: every recorded list item is indented as its level is, and no recorded document
    // names the style of a paragraph while it is a list item.
    let tab = buildTab([{ runs: ["first\n"] }]);
    let result = applyDocsRequests(tab, [
      bullets(1, 7, "BULLET_DISC_CIRCLE_SQUARE"),
      styleParagraphs(1, 7, { namedStyleType: "HEADING_2" }, "namedStyleType"),
    ]);
    let [item] = bodyParagraphs(result);

    expect(item.bullet).toBeDefined();
    expect(modelStyle(item)).toEqual({
      namedStyleType: "HEADING_2", indentStart: points(36), indentFirstLine: points(18),
    });
  });

  it("sets an indent the same request names, also when it names the style", () => {
    let tab = buildTab([{ runs: ["first\n"], bullet: { listId: "L1" } }], BULLET_LIST);
    let both = applyDocsRequests(tab, [
      deleteBullets(1, 7),
      styleParagraphs(1, 7,
        { namedStyleType: "HEADING_1", indentStart: points(10), indentFirstLine: points(4) },
        "namedStyleType,indentStart,indentFirstLine"),
    ]);
    let one = applyDocsRequests(tab, [
      deleteBullets(1, 7),
      styleParagraphs(1, 7, { namedStyleType: "HEADING_1", indentStart: points(10) },
        "namedStyleType,indentStart"),
    ]);

    expect(modelStyle(bodyParagraphs(both)[0])).toEqual({
      namedStyleType: "HEADING_1", indentStart: points(10), indentFirstLine: points(4),
    });
    // The indent the removed bullet left goes with the style; the one named is set.
    expect(modelStyle(bodyParagraphs(one)[0]))
      .toEqual({ namedStyleType: "HEADING_1", indentStart: points(10) });
  });

  it("takes a look given up to a paragraph's line break away when the style is then named", () => {
    // The batches of probe P6. A replay that chains batches relies on the order of the third:
    // the text styled first and the style named after it, where the looks the whole paragraph
    // holds go. The second is the builders' order, the style named first, where they stay.
    let red = { color: { rgbColor: { red: 1 } } };
    let styled = applyDocsRequests(
      applyDocsRequests(buildTab([{ runs: ["\n"] }]), [insertText(1, "Alpha beta\nGamma\n")]),
      [
        styleParagraphs(1, 18, { namedStyleType: "HEADING_2" }, "namedStyleType"),
        styleText(1, 12, { bold: true, ...sized(18) }, "bold,fontSize"),
        styleText(7, 11, { italic: true }, "italic"),
        styleText(1, 11, { foregroundColor: red }, "foregroundColor"),
        styleText(12, 17, { bold: true }, "bold"),
      ],
    );
    let look = { bold: true, ...sized(18), foregroundColor: red };

    // The red and the italic end where the break begins and reach it, and so does the second
    // paragraph's bold.
    expect(bodyParagraphs(styled).map(joinedRunsOf)).toEqual([
      [["Alpha ", look], ["beta\n", { ...look, italic: true }]],
      [["Gamma\n", { bold: true }]],
      [["\n", {}]],
    ]);

    let renamed = applyDocsRequests(styled, [
      styleParagraphs(1, 18, { namedStyleType: "NORMAL_TEXT" }, "namedStyleType"),
    ]);
    expect(bodyParagraphs(renamed).map(joinedRunsOf)).toEqual([
      [["Alpha ", {}], ["beta\n", { italic: true }]],
      [["Gamma\n", {}]],
      [["\n", {}]],
    ]);
    expect(bodyParagraphs(renamed).map(paragraph => paragraph.paragraphStyle.namedStyleType))
      .toEqual(["NORMAL_TEXT", "NORMAL_TEXT", "NORMAL_TEXT"]);
    expect(markdownOf(renamed)).toBe("Alpha *beta*\n\nGamma\n\n\n");
  });

  it("rewrites a paragraph as a heading before a paragraph that holds only a chip", () => {
    let tab = buildTab([{ runs: ["Before\n"] }, { runs: [{ date: "Sep 16, 2026" }, "\n"] }]);
    let result = applyDocsRequests(tab, [
      deleteRange(1, 7),
      insertText(1, "Before"),
      styleParagraphs(1, 8, { namedStyleType: "HEADING_1" }, "namedStyleType"),
      styleText(1, 7, {}, FOUR_FIELDS),
    ]);

    expect(markdownOf(result)).toBe("# Before\n\nSep 16, 2026\n");
    let chip = paragraphOf(result.body.content[2]);
    expect(span(result.body.content[2])).toEqual([8, 10]);
    expect(chip.elements[0].dateElement).toEqual(
      paragraphOf(tab.body.content[2]).elements[0].dateElement);
    expect(chip.elements.map(span)).toEqual([[8, 9], [9, 10]]);
  });

  it("appends a paragraph after one whose only content is a chip with no label", () => {
    let tab = buildTab([{ runs: [{ date: "" }, "\n"] }]);
    let result = applyDocsRequests(tab, [
      insertText(2, "\nadded"),
      deleteBullets(3, 9),
      styleParagraphs(3, 9, { namedStyleType: "NORMAL_TEXT" }, "namedStyleType"),
      styleText(3, 8, {}, FOUR_FIELDS),
    ]);

    expect(markdownOf(result)).toBe("\n\nadded\n");
    let [chip, added] = bodyParagraphs(result);
    expect(chip.elements.map(span)).toEqual([[1, 2], [2, 3]]);
    expect(chip.elements[0].dateElement).toBeDefined();
    expect(textOf(chip)).toBe("\n");
    expect(textOf(added)).toBe("added\n");
    expect(span(result.body.content[2])).toEqual([3, 9]);
  });
});

const expectNotModelled = (tab: GoogleDocsTab, request: GoogleDocsRequest) =>
  expect(() => applyDocsRequests(tab, [request])).toThrow(/^not modelled: /);

/** Three rows of three cells; the first cell is merged over two rows and two columns. */
const merged = () => buildTab([
  { runs: ["\n"] },
  {
    table: [
      [
        { paragraphs: [{ runs: ["head\n"] }], tableCellStyle: { rowSpan: 2, columnSpan: 2 } },
        "\n", "c\n",
      ],
      ["\n", "\n", "f\n"],
      ["g\n", "h\n", "i\n"],
    ],
  },
  { runs: ["\n"] },
]);

/** The index of the first paragraph of the cell at `row`, `column` of the tab's first table. */
const paragraphIn = (tab: GoogleDocsTab, row: number, column: number) =>
  cellsOf(tab)[row][column].startIndex + 1;

describe("what the model does not cover", () => {
  it("throws for a row or column request on a table that holds a suggestion", () => {
    let suggestedRow = buildTab([
      { runs: ["\n"] },
      { table: [["a\n", "b\n"], ["c\n", "d\n"]], suggestedRows: { 1: "insertion" } },
      { runs: ["\n"] },
    ]);
    let suggestedCell = buildTab([
      { runs: ["\n"] },
      { table: [["a\n", { paragraphs: [{ runs: ["b\n"] }], suggested: "deletion" }]] },
      { runs: ["\n"] },
    ]);
    let suggestedTable = buildTab([{ runs: ["\n"] }, { table: [["a\n"]] }, { runs: ["\n"] }]);
    Object.assign(
      tableElement(suggestedTable).table ?? {}, { suggestedInsertionIds: ["suggest.1"] });

    for (let tab of [suggestedRow, suggestedCell, suggestedTable]) {
      expectNotModelled(tab, insertRow(2, 0, true));
      expectNotModelled(tab, insertColumn(2, 0, true));
      expectNotModelled(tab, deleteRow(2, 0));
      expectNotModelled(tab, deleteColumn(2, 0));
    }
  });

  it("throws for a row or column request on a line that crosses a merged cell", () => {
    let tab = buildTab([
      { runs: ["\n"] },
      {
        table: [
          [{ paragraphs: [{ runs: ["a\n"] }], tableCellStyle: { columnSpan: 2 } }, "\n"],
          ["c\n", "d\n"],
        ],
      },
      { runs: ["\n"] },
    ]);

    expectNotModelled(tab, insertRow(2, 0, true));
    expectNotModelled(tab, insertColumn(2, 0, true));
    expectNotModelled(tab, deleteRow(2, 0));
    expectNotModelled(tab, deleteColumn(2, 1));
    // A row beside the merged cell crosses none.
    expect(() => applyDocsRequests(tab, [insertRow(2, 1, true)])).not.toThrow();
    expect(() => applyDocsRequests(tab, [deleteRow(2, 1)])).not.toThrow();
  });

  describe("in a cell that a merged cell covers", () => {
    const COVERED: [number, number][] = [[0, 1], [1, 0], [1, 1]];

    it.each(COVERED)("throws for text and for a new table at row %i, column %i", (row, column) => {
      let tab = merged();
      let paragraph = paragraphIn(tab, row, column);

      expectNotModelled(tab, insertText(paragraph, "X"));
      expectNotModelled(tab, insertTable(paragraph, 1, 1));
    });

    it.each(COVERED)("throws for a style or bullet request at row %i, column %i", (row, column) => {
      let tab = merged();
      let paragraph = paragraphIn(tab, row, column);

      expectNotModelled(tab, styleText(paragraph, paragraph + 1, { bold: true }, "bold"));
      expectNotModelled(tab, styleParagraphs(
        paragraph, paragraph + 1, { namedStyleType: "NORMAL_TEXT" }, "namedStyleType"));
      expectNotModelled(tab, deleteBullets(paragraph, paragraph + 1));
    });

    it("throws for a deletion that starts or ends there", () => {
      // The covered cell beside the merged one holds text here, so that a range can end in it.
      let tab = buildTab([
        { runs: ["\n"] },
        {
          table: [[
            { paragraphs: [{ runs: ["head\n"] }], tableCellStyle: { columnSpan: 2 } },
            cellOf({ runs: ["one\n"] }, { runs: ["two\n"] }),
          ]],
        },
        { runs: ["\n"] },
      ]);
      let covered = paragraphIn(tab, 0, 1);

      expectNotModelled(tab, deleteRange(covered, covered + 2));
      expectNotModelled(tab, deleteRange(covered + 2, covered + 5));
      expectNotModelled(tab, deleteRange(paragraphIn(tab, 0, 0), covered + 1));
    });

    it("applies a request to the merged cell itself and to the cells beside the merge", () => {
      let tab = merged();
      let result = applyDocsRequests(tab, [
        insertText(paragraphIn(tab, 2, 2), "X"), insertText(paragraphIn(tab, 2, 0), "X"),
        insertText(paragraphIn(tab, 1, 2), "X"), insertText(paragraphIn(tab, 0, 2), "X"),
        insertText(paragraphIn(tab, 0, 0), "X"),
      ]);

      expect(tableTexts(result)).toEqual([
        ["Xhead\n", "\n", "Xc\n"], ["\n", "\n", "Xf\n"], ["Xg\n", "h\n", "Xi\n"],
      ]);
    });

    it("deletes the whole table all the same", () => {
      let tab = merged();
      let [start, end] = span(tableElement(tab));
      let result = applyDocsRequests(tab, [deleteRange(start, end)]);

      expect(bodyParagraphs(result).map(textOf)).toEqual(["\n", "\n"]);
      expect(result.body.content.filter(element => element.table)).toEqual([]);
    });
  });

  it("throws for a row request on a table inside a cell", () => {
    let tab = buildTab([
      { runs: ["\n"] },
      { table: [[{ paragraphs: [{ runs: ["\n"] }, { table: [["in\n"]] }, { runs: ["\n"] }] }]] },
      { runs: ["\n"] },
    ]);
    // The outer table is at 2 and its cell at 4; the cell holds a paragraph at 5 and the inner
    // table at 6.
    expectNotModelled(tab, insertRow(6, 0, true));
    let lengths = rowsOf(applyDocsRequests(tab, [insertRow(2, 0, true)]))
      .map(row => row.endIndex - row.startIndex);
    // The new row holds one empty cell: no table is copied into it.
    expect(lengths)
      .toEqual([11, 3]);
  });

  // Inferred, not on record, that the empty first line of the split keeps the image. The
  // builders refuse the edit that would send this batch (`POSITIONED_ITEM_BEFORE`), so what
  // Google does with the image of the deleted line is not answered here.
  it("has no answer for the empty paragraph of a bulleted range that holds a positioned image", () => {
    let tab = buildTab([
      { runs: ["a\n"], bullet: { listId: "made" } },
      { runs: ["b\n"], bullet: { listId: "made", nestingLevel: 2 } },
      { runs: ["\tc\n"] },
    ], presetList(BULLETED));
    bodyParagraphs(tab)[1].positionedObjectIds = ["image-1"];
    expect(tab.body.content.slice(1).map(span)).toEqual([[1, 3], [3, 5], [5, 8]]);
    let copy = structuredClone(tab);
    let untilEmptyLine = [
      deleteBullets(3, 5),
      styleParagraphs(
        3, 5, { indentStart: points(0), indentFirstLine: points(0) }, "indentStart,indentFirstLine"),
      insertText(3, "\t\t"),
      insertText(3, "\n"),
    ];

    expect(bodyParagraphs(applyDocsRequests(tab, untilEmptyLine)).map(paragraph =>
      [textOf(paragraph), paragraph.positionedObjectIds])).toEqual([
      ["a\n", undefined], ["\n", ["image-1"]], ["\t\tb\n", undefined], ["\tc\n", undefined],
    ]);
    expect(notModelledBy(tab, [...untilEmptyLine, bullets(3, 11, BULLETED), deleteRange(3, 4)]))
      .toMatchObject({
        what: "a deletion that removes a paragraph that anchors a positioned object, or joins " +
          "text into one",
        invariant: false,
      });
    expect(tab).toEqual(copy);
  });

  // Inferred, not on record: nobody has seen what Google does with the image of a paragraph
  // that is removed, or that text is joined into.
  it("does not answer for a positioned paragraph that loses its text or that text is joined into", () => {
    let positioned = (texts: string[], index: number) => {
      let tab = buildTab(texts.map(text => ({ runs: [text] })));
      bodyParagraphs(tab)[index].positionedObjectIds = ["image-1"];
      return tab;
    };

    for (let [tab, request] of [
      // It holds text and is the first paragraph of the range.
      [positioned(["O\n", "P\n", "Q\n"], 1), deleteRange(3, 5)],
      // It holds text and lies between the first and the last.
      [positioned(["O\n", "P\n", "Q\n"], 1), deleteRange(2, 6)],
      // It is empty and is removed in front of another paragraph.
      [positioned(["O\n", "\n", "Q\n"], 1), deleteRange(3, 4)],
      // It is the one that remains, and the range starts inside the first paragraph.
      [positioned(["O\n", "P\n"], 1), deleteRange(2, 3)],
    ] as const) {
      expect(notModelledBy(tab, [request])).toMatchObject({
        what: "a deletion that removes a paragraph that anchors a positioned object, or joins " +
          "text into one",
        invariant: false,
      });
    }
  });

  // Each request is sent alone.
  it.each<[string, GoogleDocsTab, GoogleDocsRequest[]]>([
    ["a table inserted strictly inside a paragraph's text",
      buildTab([{ runs: ["Before\n"] }]), [insertTable(3, 1, 1)]],
    // The table is [8, 14).
    ["a deletion that takes a table together with text beside it",
      buildTab([{ runs: ["Before\n"] }, { table: [["a\n"]] }, { runs: ["After\n"] }]),
      [deleteRange(7, 14), deleteRange(8, 15), deleteRange(3, 16)]],
    ["a coordinate that names another tab",
      buildTab([{ runs: ["text\n"] }]),
      [{ insertText: { location: { index: 1, tabId: "tab-2" }, text: "x" } }]],
    ["a field it does not know",
      buildTab([{ runs: ["text\n"] }]),
      [styleText(1, 3, {}, "bold,baselineOffset"),
        styleParagraphs(1, 3, { alignment: "CENTER" }, "alignment")]],
  ])("throws for %s", (_, tab, requests) => {
    for (let request of requests) expectNotModelled(tab, request);
  });
});

/** What applying `requests` to `tab` throws. */
function thrownBy(tab: GoogleDocsTab, requests: GoogleDocsRequest[]): Error {
  try {
    applyDocsRequests(tab, requests);
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("Expected the model to throw an error");
}

function notModelledBy(tab: GoogleDocsTab, requests: GoogleDocsRequest[]): NotModelledError {
  let error = thrownBy(tab, requests);
  if (!(error instanceof NotModelledError)) throw new Error("Expected a NotModelledError");
  return error;
}

/** The module specifiers a TypeScript source imports from. */
function importedSpecifiers(source: string): string[] {
  return [...source.matchAll(/\bfrom\s+"([^"]+)"|\bimport\s*\(?\s*"([^"]+)"/g)]
    .map(match => match[1] ?? match[2]);
}

describe("what the model refuses to answer", () => {
  it("throws NotModelledError, with what it names and whether it is an invariant", () => {
    let suggested = buildTab([
      { runs: ["\n"] },
      { table: [["secret one\n", "secret two\n"]], suggestedRows: { 0: "insertion" } },
      { runs: ["\n"] },
    ]);
    let unrecorded = notModelledBy(suggested, [insertRow(2, 0, true)]);

    expect(unrecorded).toMatchObject({
      name: "NotModelledError",
      what: "insertTableRow on a table that holds a suggestion",
      invariant: false,
      message: "not modelled: insertTableRow on a table that holds a suggestion",
    });

    let otherTab = notModelledBy(buildTab([{ runs: ["secret text\n"] }]), [
      { insertText: { location: { index: 1, tabId: "tab-2" }, text: "secret insertion" } },
    ]);

    expect(otherTab).toMatchObject({
      what: `a coordinate that does not name tab "${TAB}"`,
      invariant: true,
      message: `not modelled: a coordinate that does not name tab "${TAB}" ` +
        "(an internal invariant: nothing the gatekeeper sends reaches this)",
    });
    // A kind of request the model has no answer for, as it would come off the wire.
    let unknownKind: GoogleDocsRequest = JSON.parse(
      '{"replaceAllText":{"containsText":{"text":"secret text"},"replaceText":"secret"}}');
    let unanswered = notModelledBy(buildTab([{ runs: ["secret text\n"] }]), [unknownKind]);

    expect(unanswered).toMatchObject({ what: "the request replaceAllText", invariant: true });
    for (let error of [unrecorded, otherTab, unanswered]) {
      expect(error.what).not.toContain("secret");
      expect(error.message).toMatch(/^not modelled: /);
      expect(error.message).not.toContain("secret");
    }
  });

  it("passes Google's own refusals on as plain errors", () => {
    let googles = thrownBy(buildTab([{ runs: ["text\n"] }]), [deleteRange(2, 2)]);

    expect(googles).not.toBeInstanceOf(NotModelledError);
    expect(googles.message).toBe(EMPTY_RANGE);
  });
});

describe("the model as a module", () => {
  it("imports nothing but the document types and the shared character rules", () => {
    expect(new Set(importedSpecifiers(modelSource)))
      .toEqual(new Set(["./docs-api", "./docs-content"]));
    expect(importedSpecifiers(contentSource)).toEqual(["./docs-api"]);
    // The document types are erased: the two modules load nothing else at run time.
    expect(modelSource).toMatch(/import type \{[^}]*\} from "\.\/docs-api";/);
    expect(contentSource).toMatch(/import type \{[^}]*\} from "\.\/docs-api";/);
  });

  it("leaves a tab as it is when a change sends no request", () => {
    let tab = buildTab([{ runs: [{ text: "x", style: { italic: true } }, "\n"] }]);
    let result = applyDocsRequests(tab, []);

    expect(result).toEqual(tab);
    expect(result).not.toBe(tab);
    expect(markdownOf(result)).toBe("*x*\n");
  });
});

const BULLETED = "BULLET_DISC_CIRCLE_SQUARE";
const NUMBERED = "NUMBERED_DECIMAL_ALPHA_ROMAN";

/** A list as Google makes one for a preset, under the id `made`. */
const presetList = (preset: string): GoogleDocsTab["lists"] =>
  ({ made: { listProperties: { nestingLevels: presetLevels(preset === NUMBERED) } } });

const levelsOf = (tab: GoogleDocsTab) =>
  bodyParagraphs(tab).map(paragraph => paragraph.bullet && (paragraph.bullet.nestingLevel ?? 0));
const listIdsOf = (tab: GoogleDocsTab) =>
  bodyParagraphs(tab).map(paragraph => paragraph.bullet?.listId);

describe("bullets the gatekeeper creates", () => {
  /** A tab of `lead` and the paragraphs after it, each of which the request is to bullet. */
  function afterLead(
    lead: ParagraphSpec, texts: string[], lists: GoogleDocsTab["lists"] = presetList(BULLETED),
  ): { tab: GoogleDocsTab; start: number; end: number } {
    let tab = buildTab([lead, ...texts.map(text => ({ runs: [text] }))], lists);
    let paragraphs = tab.body.content.slice(2);
    return { tab, start: paragraphs[0].startIndex, end: paragraphs[paragraphs.length - 1].endIndex };
  }

  it.each<[string, number | undefined, number[], number[]]>([
    ["a range of its own", undefined, [0], [0]],
    ["a range of its own written in tabs", undefined, [1, 2], [0, 1]],
    // Recorded: bullets-nesting-2 / a child under the middle item.
    ["a nested item written alone, which lands flat", 0, [1], [0]],
    // Recorded: outdent-after-nested / a top-level item appended after the nested one.
    ["a paragraph of no tabs behind a nested item", 2, [0], [2]],
    ["a range that starts as deep in tabs as the item before it", 1, [1, 2, 3], [1, 2, 3]],
    ["a range whose tabs skip a level", 1, [0, 2], [1, 3]],
  ])(
    "lands each paragraph at the joined item's level plus its tabs, less the fewest in the " +
    "range: %s",
    (_, before, tabs, levels) => {
      let lead: ParagraphSpec = before === undefined
        ? { runs: ["lead\n"] }
        : { runs: ["lead\n"], bullet: { listId: "made", nestingLevel: before } };
      let { tab, start, end } = afterLead(lead, tabs.map(count => "\t".repeat(count) + "x\n"));
      let result = applyDocsRequests(tab, [bullets(start, end, BULLETED)]);

      expect(levelsOf(result).slice(1)).toEqual(levels);
      expect(bodyParagraphs(result).slice(1).map(textOf)).toEqual(tabs.map(() => "x\n"));
      expect(listIdsOf(result).slice(1))
        .toEqual(tabs.map(() => before === undefined ? "model.1" : "made"));
    });

  it("removes the tabs it counted, also when they are split over text runs", () => {
    let tab = buildTab([
      { runs: ["\t", { text: "\tb", style: { bold: true } }, "\tc\n"] },
      { runs: ["d\n"] },
      { runs: ["after\n"] },
    ]);
    expect(tab.body.content.slice(1).map(span)).toEqual([[1, 7], [7, 9], [9, 15]]);
    let result = applyDocsRequests(tab, [bullets(1, 9, BULLETED)]);
    let [item] = bodyParagraphs(result);

    expect(runsOf(item)).toEqual([["b", { bold: true }], ["\tc\n", {}]]);
    expect(item.elements.map(span)).toEqual([[1, 2], [2, 5]]);
    expect(levelsOf(result)).toEqual([2, 0, undefined]);
    expect(result.body.content.slice(1).map(span)).toEqual([[1, 5], [5, 7], [7, 13]]);
  });

  // Recorded: nesting-deeper / a child under the middle item.
  it("counts an empty paragraph of tabs like any other, so the paragraphs behind it land deeper", () => {
    let { tab, start, end } = afterLead(
      { runs: ["a\n"], bullet: { listId: "made", nestingLevel: 1 } }, ["\t\n", "\t\tdeep\n"]);
    let bulleted = applyDocsRequests(tab, [bullets(start, end, BULLETED)]);

    expect(bodyParagraphs(bulleted).map(textOf)).toEqual(["a\n", "\n", "deep\n"]);
    expect(levelsOf(bulleted)).toEqual([1, 1, 2]);

    let result = applyDocsRequests(
      tab, [bullets(start, end, BULLETED), deleteRange(start, start + 1)]);

    expect(bodyParagraphs(result).map(textOf)).toEqual(["a\n", "deep\n"]);
    expect(levelsOf(result)).toEqual([1, 2]);
    expect(listIdsOf(result)).toEqual(["made", "made"]);
  });

  // Inferred, not on record: this is how a list made in the Docs editor, which the request has
  // not been seen to meet, is told from one a preset made. The Markdown preview reads an item
  // written after any list of its kind as joined to it (`- a`, `- b`), where the model reads a
  // list of its own after one whose glyphs differ (`- a`, a blank line, `- b`).
  it("joins a list of fewer levels whose glyphs are the preset's, and not one whose glyphs differ", () => {
    let listAfter = (preset: string, nestingLevels: NestingLevel[]) => {
      let { tab, start, end } = afterLead(
        { runs: ["a\n"], bullet: { listId: "made" } }, ["b\n"],
        { made: { listProperties: { nestingLevels } } });
      return listIdsOf(applyDocsRequests(tab, [bullets(start, end, preset)]))[1];
    };

    expect(listAfter(BULLETED, [{ glyphSymbol: "●" }])).toBe("made");
    expect(listAfter(BULLETED, [{ glyphSymbol: "●", glyphType: "GLYPH_TYPE_UNSPECIFIED" }]))
      .toBe("made");
    expect(listAfter(NUMBERED, [{ glyphType: "DECIMAL" }, { glyphType: "ALPHA" }])).toBe("made");
    expect(listAfter(BULLETED, [{ glyphType: "NONE" }])).toBe("model.1");
    expect(listAfter(BULLETED, [{ glyphSymbol: "●" }, { glyphSymbol: "■" }]))
      .toBe("model.1");
    expect(listAfter(NUMBERED, [{ glyphType: "DECIMAL" }, { glyphType: "ROMAN" }])).toBe("model.1");
    expect(listAfter(BULLETED, [])).toBe("model.1");
    // A level that shows the preset's symbol and counts as well is not the bulleted preset's.
    expect(listAfter(BULLETED, [{ glyphSymbol: "●", glyphType: "DECIMAL" }])).toBe("model.1");
    // Nor is a list of more levels than the nine a preset makes, whatever the tenth shows.
    for (let preset of [BULLETED, NUMBERED]) {
      let nine = presetLevels(preset === NUMBERED);
      expect(listAfter(preset, nine)).toBe("made");
      expect(listAfter(preset, [...nine, nine[0]])).toBe("model.1");
    }
  });

  // Not on record: no recorded item lies deeper than the levels a list has. The builders
  // refuse to write such an item.
  it("has no answer for a level past the ninth", () => {
    let lead = { runs: ["a\n"], bullet: { listId: "made", nestingLevel: 8 } };
    let { tab, start, end } = afterLead(lead, ["x\n", "\ty\n"]);
    let unanswered = notModelledBy(tab, [bullets(start, end, BULLETED)]);

    expect(unanswered).toMatchObject({ invariant: false });
    expect(unanswered.what).not.toContain("y");

    // The range without the deeper paragraph lands at the ninth level.
    let alone = afterLead(lead, ["x\n"]);
    let result = applyDocsRequests(alone.tab, [bullets(alone.start, alone.end, BULLETED)]);
    expect(levelsOf(result)).toEqual([8, 8]);
    expect(bodyParagraphs(result).map(textOf)).toEqual(["a\n", "x\n"]);
  });

  it("makes list items of the paragraphs of one cell", () => {
    let tab = buildTab([
      { runs: ["a\n"], bullet: { listId: "made" } },
      { table: [[cellOf({ runs: ["x\n"] }, { runs: ["\ty\n"] })]] },
      { runs: ["\n"] },
    ], presetList(BULLETED));
    let cell = cellsOf(tab)[0][0];
    let result = applyDocsRequests(tab, [bullets(cell.startIndex + 1, cell.endIndex, BULLETED)]);
    let paragraphs = cellParagraphs(cellsOf(result)[0][0]);

    // The first paragraph of a cell has no paragraph before it, so the list is its own.
    expect(paragraphs.map(paragraph => paragraph.bullet)).toEqual(
      [{ listId: "model.1" }, { listId: "model.1", nestingLevel: 1 }]);
    expect(paragraphs.map(textOf)).toEqual(["x\n", "y\n"]);
    expect(span(cellsOf(result)[0][0])).toEqual([cell.startIndex, cell.endIndex - 1]);
  });

  it("joins the list of the item before the range inside a cell", () => {
    let tab = buildTab([
      { table: [[cellOf(
        { runs: ["a\n"], bullet: { listId: "made", nestingLevel: 1 } }, { runs: ["\tb\n"] },
      )]] },
      { runs: ["\n"] },
    ], presetList(BULLETED));
    let [, second] = cellsOf(tab)[0][0].content ?? [];
    let result = applyDocsRequests(tab, [bullets(second.startIndex, second.endIndex, BULLETED)]);
    let paragraphs = cellParagraphs(cellsOf(result)[0][0]);

    expect(paragraphs.map(paragraph => paragraph.bullet)).toEqual(
      [{ listId: "made", nestingLevel: 1 }, { listId: "made", nestingLevel: 1 }]);
    expect(paragraphs.map(textOf)).toEqual(["a\n", "b\n"]);
    expect(result.lists).toEqual(tab.lists);
  });

  it("gives each list it makes levels of its own", () => {
    let tab = buildTab([{ runs: ["a\n"] }]);
    let requests = [bullets(1, 3, BULLETED)];
    let first = applyDocsRequests(tab, requests);
    first.lists["model.1"].listProperties.nestingLevels[0].glyphSymbol = "x";

    expect(applyDocsRequests(tab, requests).lists["model.1"]).toEqual(presetList(BULLETED).made);
  });

  it("mints the same list id for the same tab and requests, and one no list of the tab has", () => {
    let tab = buildTab(
      [{ runs: ["a\n"] }, { runs: ["gap\n"] }, { runs: ["b\n"] }],
      { "model.1": presetList(NUMBERED).made });
    let requests = [bullets(7, 9, BULLETED), bullets(1, 3, BULLETED)];
    let result = applyDocsRequests(tab, requests);

    expect(listIdsOf(result)).toEqual(["model.3", undefined, "model.2"]);
    expect(Object.keys(result.lists)).toEqual(["model.1", "model.2", "model.3"]);
    expect(applyDocsRequests(tab, requests)).toEqual(result);
  });

  it("refuses a range that holds a list item, a range that is not within the paragraphs of one body or cell, and a preset the gatekeeper never sends", () => {
    let tab = buildTab([
      { runs: ["a\n"], bullet: { listId: "made" } },
      { runs: ["b\n"] },
      { table: [["c\n"]] },
      { runs: ["\n"] },
    ], presetList(BULLETED));
    expect(span(cellsOf(tab)[0][0])).toEqual([7, 10]);

    expect(notModelledBy(tab, [bullets(1, 5, BULLETED)])).toMatchObject({
      what: "createParagraphBullets over a range that holds a list item", invariant: true,
    });
    expect(notModelledBy(tab, [bullets(3, 9, BULLETED)])).toMatchObject({
      what: "createParagraphBullets over a range that is not within the paragraphs of one body " +
        "or cell",
      invariant: true,
    });
    // A preset named as a member every object has is no more one of the two than any other.
    for (let preset of ["BULLET_CHECKBOX", "toString", "__proto__"]) {
      expect(notModelledBy(tab, [bullets(3, 5, preset)])).toMatchObject({
        what: "createParagraphBullets with a preset the gatekeeper does not send", invariant: true,
      });
    }
  });
});

describe("a new table and the paragraph it cuts", () => {
  it("leaves a positioned object on the part of the paragraph before the table", () => {
    let tab = buildTab([{ runs: ["Before\n"] }]);
    bodyParagraphs(tab)[0].positionedObjectIds = ["image-1"];

    let atLineBreak = applyDocsRequests(tab, [insertTable(7, 1, 1)]);
    expect(bodyParagraphs(atLineBreak).map(paragraph =>
      [textOf(paragraph), paragraph.positionedObjectIds])).toEqual([
      ["Before\n", ["image-1"]], ["\n", undefined],
    ]);
    expect(span(tableElement(atLineBreak))).toEqual([8, 13]);

    let atStart = applyDocsRequests(tab, [insertTable(1, 1, 1)]);
    expect(bodyParagraphs(atStart).map(paragraph =>
      [textOf(paragraph), paragraph.positionedObjectIds])).toEqual([
      ["\n", ["image-1"]], ["Before\n", undefined],
    ]);
    expect(span(tableElement(atStart))).toEqual([2, 7]);
  });

  it.each([{}, { copyStyles: true }])(
    "leaves a bulleted paragraph on each side of a table that cuts a list item (%o)",
    options => {
      let empty = buildTab(
        [{ runs: ["\n"], bullet: { listId: "L1", nestingLevel: 1 } }], BULLET_LIST);
      let item = buildTab([{ runs: ["item\n"], bullet: { listId: "L1" } }], BULLET_LIST);
      modelStyle(bodyParagraphs(item)[0]).indentStart = points(36);

      let aroundEmpty = bodyParagraphs(applyDocsRequests(empty, [insertTable(1, 1, 1)], options));
      expect(aroundEmpty.map(paragraph => [textOf(paragraph), paragraph.bullet])).toEqual([
        ["\n", { listId: "L1", nestingLevel: 1 }], ["\n", { listId: "L1", nestingLevel: 1 }],
      ]);

      let aroundItem = bodyParagraphs(applyDocsRequests(item, [insertTable(5, 1, 1)], options));
      expect(aroundItem.map(paragraph => [textOf(paragraph), paragraph.bullet])).toEqual([
        ["item\n", { listId: "L1" }], ["\n", { listId: "L1" }],
      ]);
      // Both parts carry the indent as well.
      expect(aroundItem.map(modelStyle)).toEqual([
        { namedStyleType: "NORMAL_TEXT", indentStart: points(36) },
        { namedStyleType: "NORMAL_TEXT", indentStart: points(36) },
      ]);
    },
  );

  it("gives both parts of a heading the heading's style", () => {
    let tab = buildTab([{ runs: ["Title\n"], namedStyleType: "HEADING_2" }, { runs: ["\n"] }]);

    for (let index of [1, 6]) {
      let [before, after] = bodyParagraphs(applyDocsRequests(tab, [insertTable(index, 1, 1)]));
      expect([before, after].map(paragraph => paragraph.paragraphStyle.namedStyleType))
        .toEqual(["HEADING_2", "HEADING_2"]);
      expect([before, after].map(textOf))
        .toEqual(index === 1 ? ["\n", "Title\n"] : ["Title\n", "\n"]);
    }
  });

  it("writes a heading's look onto the cells of a table inserted at the heading's start", () => {
    let tab = buildTab([{ runs: ["Title\n"], namedStyleType: "HEADING_2" }, { runs: ["\n"] }]);
    let lineBreaks = (index: number, copyStyles: boolean) => cellsOf(
      applyDocsRequests(tab, [insertTable(index, 2, 2)], { copyStyles }),
    ).flat().map(cell => {
      let [paragraph] = cellParagraphs(cell);
      expect(paragraph.paragraphStyle.namedStyleType).toBe("NORMAL_TEXT");
      let [[text, style]] = runsOf(paragraph);
      expect(text).toBe("\n");
      return style;
    });

    for (let style of lineBreaks(1, true)) {
      expect(style.italic).toBe(true);
      expect(style.fontSize?.magnitude).toBeGreaterThan(0);
    }
    // Not at the heading's line break, not at the start of normal text, and not without copying.
    expect(lineBreaks(6, true)).toEqual([{}, {}, {}, {}]);
    expect(lineBreaks(7, true)).toEqual([{}, {}, {}, {}]);
    expect(lineBreaks(1, false)).toEqual([{}, {}, {}, {}]);
  });

  it("puts a table inserted at a table's end after a new paragraph between the two", () => {
    let tab = buildTab([{ runs: ["\n"] }, { table: [["a\n"]] }, { runs: ["After\n"] }]);
    // The first table is [2, 8), and "After" starts at its end.
    let result = applyDocsRequests(tab, [insertTable(8, 1, 1)]);

    expect(result.body.content.map(span))
      .toEqual([[0, 1], [1, 2], [2, 8], [8, 9], [9, 14], [14, 20]]);
    expect(bodyParagraphs(result).map(textOf)).toEqual(["\n", "\n", "After\n"]);
  });
});

const runsAfter = (tab: GoogleDocsTab, ...requests: GoogleDocsRequest[]) =>
  runsOf(bodyParagraphs(applyDocsRequests(tab, requests))[0]);

const linked = (text: string, extra: ModelTextStyle = {}) =>
  ({ text, style: { link: LINK_A, ...extra } as ModelTextStyle });

describe("how inserted text is styled", () => {
  // The runs of a tab's one paragraph, the index text is typed at, the text, and the runs after.
  it.each<[string, ParagraphSpec["runs"], number, string, [string, ModelTextStyle][]]>([
    ["loses the characters Google strips",
      ["\n"], 1, "a\u0001b\uE000c\u001fd\tE\u000bf", [["abcd\tE\u000bf\n", {}]]],
    ["is linked inside a link",
      [linked("abcd"), " tail\n"], 3, "X", [["abXcd", { link: LINK_A }], [" tail\n", {}]]],
    ["takes the style of the line break after a link that ends the paragraph's text",
      ["x", linked("ab", sized(14)), { text: "\n", style: sized(7) as ModelTextStyle }], 4, "X",
      [["x", {}], ["ab", { link: LINK_A, ...sized(14) }], ["X\n", sized(7)]]],
    ["has no style before a link at the start of a paragraph",
      [linked("ab", sized(14)), "\n"], 1, "X",
      [["X", {}], ["ab", { link: LINK_A, ...sized(14) }], ["\n", {}]]],
    ["takes the style of the text before a link it is typed in front of",
      [{ text: "x", style: sized(9) as ModelTextStyle }, linked("ab"), "\n"], 2, "X",
      [["xX", sized(9)], ["ab", { link: LINK_A }], ["\n", {}]]],
    ["takes the second link's style where two links meet",
      [linked("ab"), { text: "cd", style: { link: LINK_B, ...sized(9) } as ModelTextStyle }, "\n"],
      3, "X", [["ab", { link: LINK_A }], ["Xcd", { link: LINK_B, ...sized(9) }], ["\n", {}]]],
    ["is bold after bold text that is not linked",
      [{ text: "ab", style: { bold: true } }, " c\n"], 3, "X",
      [["abX", { bold: true }], [" c\n", {}]]],
  ])("%s", (_, runs, index, text, expected) => {
    expect(runsAfter(buildTab([{ runs }]), insertText(index, text))).toEqual(expected);
  });

  it("joins the text run it is typed into, with that run's size", () => {
    let tab = buildTab([{ runs: [{ text: "Hello", style: sized(14) as ModelTextStyle }, "\n"] }]);
    let result = applyDocsRequests(tab, [insertText(3, "XY")]);

    expect(runsOf(bodyParagraphs(result)[0])).toEqual([["HeXYllo", sized(14)], ["\n", {}]]);
    expect(fontSizeAt(result, 3)).toBe(14);
  });

  it("takes the style of the text that follows a link, not the link", () => {
    let tab = buildTab([{
      runs: [linked("ab", sized(14)), { text: " tail", style: sized(9) as ModelTextStyle }, "\n"],
    }]);
    let result = applyDocsRequests(tab, [insertText(3, "X")]);

    expect(runsOf(bodyParagraphs(result)[0])).toEqual([
      ["ab", { link: LINK_A, ...sized(14) }], ["X tail", sized(9)], ["\n", {}],
    ]);
    expect(fontSizeAt(result, 3)).toBe(9);
  });

  it("starts a paragraph of the same style and bullet at every line break", () => {
    let tab = buildTab([
      { runs: ["\n"] },
      {
        table: [[cellOf({
          runs: [{ text: "ab", style: { bold: true } }, "\n"], bullet: { listId: "L1" },
        })]],
      },
      { runs: ["\n"] },
    ], BULLET_LIST);
    let cell = cellsOf(tab)[0][0];
    let result = applyDocsRequests(tab, [insertText(cell.startIndex + 2, "1\n2\n")]);
    let paragraphs = cellParagraphs(cellsOf(result)[0][0]);

    expect(paragraphs.map(textOf)).toEqual(["a1\n", "2\n", "b\n"]);
    expect(paragraphs.map(paragraph => paragraph.bullet)).toEqual(
      [{ listId: "L1" }, { listId: "L1" }, { listId: "L1" }]);
    expect((cellsOf(result)[0][0].content ?? []).map(span)).toEqual([[5, 8], [8, 10], [10, 12]]);
  });
});

const linkRun = (tab: GoogleDocsTab) => runsOf(bodyParagraphs(tab)[0])[1];

describe("links", () => {
  let look = { underline: true, foregroundColor: LINK_COLOR };
  /** Bold 14-point text, then a 10-point link with a link's look, then plain text. */
  let afterBold = () => buildTab([{
    runs: [
      { text: "B", style: { bold: true, ...sized(14) } as ModelTextStyle },
      {
        text: "link",
        style: { link: LINK_A, italic: true, ...look, ...sized(10) } as ModelTextStyle,
      },
      " tail\n",
    ],
  }]);
  /** The same link after another link. */
  let afterLink = () => buildTab([{
    runs: [
      { text: "A", style: { link: LINK_B, bold: true, ...sized(14) } as ModelTextStyle },
      { text: "link", style: { link: LINK_A, ...look, ...sized(10) } as ModelTextStyle },
      "\n",
    ],
  }]);
  const SIX_FIELDS = `${FOUR_FIELDS},underline,foregroundColor`;

  it("repoints a whole link when another is set on part of it", () => {
    let tab = buildTab([{ runs: ["x", { text: "abcd", style: { link: LINK_A } }, "y\n"] }]);
    let result = applyDocsRequests(tab, [styleText(2, 4, { link: LINK_B }, "link")]);

    expect(runsOf(bodyParagraphs(result)[0]).map(([text, style]) => [text, style.link])).toEqual([
      ["x", undefined], ["ab", LINK_B], ["cd", LINK_B], ["y\n", undefined],
    ]);
  });

  it("changes only the cleared part when a link is cleared first", () => {
    let tab = buildTab([{ runs: [{ text: "abcd", style: { link: LINK_A } }, "\n"] }]);
    let result = applyDocsRequests(tab, [
      styleText(1, 3, {}, "link"), styleText(1, 3, { link: LINK_B }, "link"),
    ]);

    expect(runsOf(bodyParagraphs(result)[0]).map(([text, style]) => [text, style.link])).toEqual([
      ["ab", LINK_B], ["cd", LINK_A], ["\n", undefined],
    ]);
  });

  it("leaves a link beside the one named as it was", () => {
    let result = applyDocsRequests(afterLink(), [styleText(2, 6, { link: LINK_B }, "link")]);
    let again = applyDocsRequests(afterLink(), [
      styleText(2, 6, { link: { url: "https://c.example" } }, "link"),
    ]);

    expect(runsOf(bodyParagraphs(result)[0]).map(([, style]) => style.link))
      .toEqual([LINK_B, LINK_B, undefined]);
    expect(runsOf(bodyParagraphs(again)[0]).map(([, style]) => style.link))
      .toEqual([LINK_B, { url: "https://c.example" }, undefined]);
  });

  it("gives linked text an underline and the link colour unless the request names them", () => {
    let tab = buildTab([{ runs: ["plain text\n"] }]);
    let result = applyDocsRequests(tab, [styleText(1, 6, { link: LINK_A }, "link")]);

    expect(runsOf(bodyParagraphs(result)[0])).toEqual([
      ["plain", { link: LINK_A, ...look }], [" text\n", {}],
    ]);
    expect(hasLinkLook(result, 1)).toBe(true);
    expect(hasLinkLook(result, 5)).toBe(true);
    expect(hasLinkLook(result, 6)).toBe(false);

    let named = applyDocsRequests(tab, [styleText(1, 6, { link: LINK_A }, SIX_FIELDS)]);
    expect(hasLinkLook(named, 1)).toBe(false);
  });

  describe("cleared, when Google restyles the text like the text before it", () => {
    let options = { unlinkRestyles: true };

    it("leaves the text bold like the text before it when the request names the link alone", () => {
      let result = applyDocsRequests(afterBold(), [styleText(2, 6, {}, "link")], options);

      expect(linkRun(result)).toEqual(["link", { bold: true, ...sized(14) }]);
      expect(hasLinkLook(result, 2)).toBe(false);
    });

    it("leaves bold as the request states it when the request names it", () => {
      let cleared = applyDocsRequests(afterBold(), [styleText(2, 6, {}, "bold,link")], options);
      let kept = applyDocsRequests(
        afterBold(), [styleText(2, 6, { italic: true }, FOUR_FIELDS)], options);

      expect(linkRun(cleared)).toEqual(["link", sized(14)]);
      expect(linkRun(cleared)[1].bold).toBeUndefined();
      expect(linkRun(kept)).toEqual(["link", { italic: true, ...sized(14) }]);
    });

    it("gives the text the size of the text before it, whatever else the request names", () => {
      for (let fields of ["link", "bold,link", FOUR_FIELDS, SIX_FIELDS]) {
        let result = applyDocsRequests(afterBold(), [styleText(2, 6, {}, fields)], options);
        expect(fontSizeAt(result, 2)).toBe(14);
        expect(fontSizeAt(result, 5)).toBe(14);
      }
    });

    it("loses its own size when the text before it is a link", () => {
      for (let fields of ["link", FOUR_FIELDS, SIX_FIELDS]) {
        let result = applyDocsRequests(afterLink(), [styleText(2, 6, {}, fields)], options);
        expect(linkRun(result)).toEqual(["link", {}]);
        expect(fontSizeAt(result, 2)).toBeUndefined();
      }
    });

    /** A 10-point link that starts a paragraph. */
    let sizedLink = { text: "link", style: { link: LINK_A, ...sized(10) } as ModelTextStyle };

    it("loses its own size where no character stands before it", () => {
      // At the start of a tab's first paragraph, and at the start of a cell.
      let first = buildTab([{ runs: [sizedLink, "\n"] }]);
      let inCell = buildTab([
        { runs: [{ text: "\n", style: sized(30) as ModelTextStyle }] },
        { table: [[cellOf({ runs: [sizedLink, "\n"] })]] },
        { runs: ["\n"] },
      ]);
      let cellText = cellsOf(inCell)[0][0].startIndex + 1;

      expect(fontSizeAt(first, 1)).toBe(10);
      expect(fontSizeAt(applyDocsRequests(first, [styleText(1, 5, {}, "link")], options), 1))
        .toBeUndefined();
      expect(fontSizeAt(inCell, cellText)).toBe(10);
      expect(fontSizeAt(
        applyDocsRequests(inCell, [styleText(cellText, cellText + 4, {}, "link")], options),
        cellText,
      )).toBeUndefined();
    });

    it("takes the size of the line break before it at the start of a later paragraph", () => {
      // "one" is at 1 to 3 and its line break, of 30 points, at 4; the link starts at 5.
      let tab = buildTab([
        { runs: ["one", { text: "\n", style: sized(30) as ModelTextStyle }] },
        { runs: [sizedLink, "\n"] },
      ]);
      let result = applyDocsRequests(tab, [styleText(5, 9, {}, "link")], options);

      expect(runsOf(bodyParagraphs(result)[1])).toEqual([["link", sized(30)], ["\n", {}]]);
      expect(fontSizeAt(result, 5)).toBe(30);
    });

    it("restyles only text that had a link", () => {
      let result = applyDocsRequests(afterBold(), [styleText(6, 9, {}, FOUR_FIELDS)], options);

      expect(runsOf(bodyParagraphs(result)[0]).slice(2)).toEqual([[" ta", {}], ["il\n", {}]]);
    });
  });

  describe("cleared, when Google leaves the rest of the text's style alone", () => {
    it("leaves the underline and colour unless the request names them", () => {
      for (let fields of ["link", FOUR_FIELDS]) {
        let result = applyDocsRequests(afterBold(), [styleText(2, 6, {}, fields)]);
        expect(linkRun(result)[1].link).toBeUndefined();
        expect(linkRun(result)[1]).toMatchObject(look);
        expect(hasLinkLook(result, 2)).toBe(true);
      }
      let named = applyDocsRequests(afterBold(), [styleText(2, 6, {}, SIX_FIELDS)]);
      expect(linkRun(named)).toEqual(["link", sized(10)]);
      expect(hasLinkLook(named, 2)).toBe(false);
    });

    it("leaves bold, italic and size as they were where the request names none", () => {
      let result = applyDocsRequests(afterBold(), [styleText(2, 6, {}, "link")]);

      expect(linkRun(result)).toEqual(["link", { italic: true, ...look, ...sized(10) }]);
    });
  });

  it.each([{}, { unlinkRestyles: true }])(
    "leaves the size of text as it was when a link is set on it, or set again (%o)",
    options => {
      let tab = buildTab([{
        runs: [{ text: "word", style: sized(10) as ModelTextStyle }, " tail\n"],
      }]);
      let set = applyDocsRequests(tab, [styleText(1, 5, { link: LINK_A }, "link")], options);
      let again = applyDocsRequests(set, [
        styleText(1, 5, { link: LINK_A }, FOUR_FIELDS), styleText(2, 4, { link: LINK_A }, "link"),
      ], options);

      for (let result of [set, again]) {
        for (let index of [1, 2, 3, 4]) expect(fontSizeAt(result, index)).toBe(10);
        expect(hasLinkLook(result, 1)).toBe(true);
      }
      expect(runsOf(bodyParagraphs(again)[0]).map(([, style]) => style.link))
        .toEqual([LINK_A, LINK_A, LINK_A, undefined]);
    },
  );

  it("sets and clears exactly the fields a request names, between the range's ends", () => {
    let tab = buildTab([{
      runs: [{ text: "r0c0", style: { bold: true, underline: true } as ModelTextStyle }, "\n"],
    }]);
    let result = applyDocsRequests(tab, [
      styleText(2, 4, { italic: true }, "bold,italic"), styleText(1, 2, { bold: false }, "bold"),
    ]);

    expect(runsOf(bodyParagraphs(result)[0])).toEqual([
      ["r", { bold: false, underline: true }],
      ["0c", { italic: true, underline: true }],
      ["0", { bold: true, underline: true }],
      ["\n", {}],
    ]);
  });
});

describe("a text style that ends at a paragraph's line break", () => {
  let look = { underline: true, foregroundColor: LINK_COLOR };

  it("leaves the line break after linked text as it was", () => {
    // Recorded: bullets-in-cell-2 / bold and a link in a cell.
    let tab = buildTab([{ runs: ["see link\n"] }]);
    let result = applyDocsRequests(tab, [styleText(5, 9, { link: LINK_A }, "link")]);

    expect(runsOf(bodyParagraphs(result)[0]))
      .toEqual([["see ", {}], ["link", { link: LINK_A, ...look }], ["\n", {}]]);
    expect(hasLinkLook(result, 9)).toBe(false);

    // The two rules together: what a request names beside a link reaches the break.
    let bold = applyDocsRequests(tab, [styleText(5, 9, { link: LINK_A, bold: true }, "bold,link")]);
    expect(runsOf(bodyParagraphs(bold)[0])).toEqual([
      ["see ", {}], ["link", { link: LINK_A, bold: true, ...look }], ["\n", { bold: true }],
    ]);

    // A link cleared up to the break restyles the text like the text before it, never the break.
    let afterBold = buildTab([{
      runs: [
        { text: "B", style: { bold: true } },
        { text: "link", style: { link: LINK_A, ...look } as ModelTextStyle },
        "\n",
      ],
    }]);
    let cleared = applyDocsRequests(
      afterBold, [styleText(2, 6, {}, "link")], { unlinkRestyles: true });
    expect(joinedRunsOf(bodyParagraphs(cleared)[0]))
      .toEqual([["Blink", { bold: true }], ["\n", {}]]);
  });

  it("leaves the line break alone when the range ends before it or holds it", () => {
    let tab = buildTab([{ runs: ["some word\n"] }, { runs: ["\n"] }]);
    let short = applyDocsRequests(tab, [styleText(6, 9, { bold: true }, "bold")]);
    expect(runsOf(bodyParagraphs(short)[0]))
      .toEqual([["some ", {}], ["wor", { bold: true }], ["d\n", {}]]);

    // A range that holds the break is applied to it like any text, a link included, and ends
    // where the next paragraph's break begins without reaching that one.
    let whole = applyDocsRequests(tab, [styleText(6, 11, { link: LINK_A }, "link")]);
    expect(bodyParagraphs(whole).map(runsOf)).toEqual([
      [["some ", {}], ["word\n", { link: LINK_A, ...look }]],
      [["\n", {}]],
    ]);
  });
});

/** A solid border one point wide, of this colour. */
const border = (rgbColor: Record<string, number>) =>
  ({ width: points(1), dashStyle: "SOLID", color: { color: { rgbColor } } });
/** A style for one cell of the first column of the table at index 2. */
const styleCell = (
  rowIndex: number, tableCellStyle: TableCellStyle, fields: string,
): GoogleDocsRequest => ({
  updateTableCellStyle: {
    tableRange: { tableCellLocation: cellAt(2, rowIndex), rowSpan: 1, columnSpan: 1 },
    tableCellStyle,
    fields,
  },
});

describe("colours", () => {
  it("stores a colour without its components of 0", () => {
    // Recorded: table-looks / partial borders.
    let tab = buildTab([
      { runs: ["\n"] }, { table: [["a\n"], ["b\n"], ["c\n"]] }, { runs: ["\n"] },
    ]);
    let result = applyDocsRequests(tab, [
      styleCell(1, {
        borderTop: border({ red: 1, green: 0, blue: 0 }),
        borderBottom: border({ red: 0, green: 0, blue: 0 }),
        backgroundColor: { color: { rgbColor: { red: 0, green: 0.5, blue: 0 } } },
      }, "borderTop,borderBottom,backgroundColor"),
      styleText(5, 6, { foregroundColor: { color: { rgbColor: { red: 0, green: 0, blue: 1 } } } },
        "foregroundColor"),
    ]);
    let [[above], [named], [below]] = cellsOf(result);

    expect(named.tableCellStyle?.borderTop).toEqual(border({ red: 1 }));
    expect(named.tableCellStyle?.borderBottom).toEqual(border({}));
    expect(named.tableCellStyle?.backgroundColor).toEqual({ color: { rgbColor: { green: 0.5 } } });
    // The cells beside it take each border on the side that faces it.
    expect(above.tableCellStyle?.borderBottom).toEqual(border({ red: 1 }));
    expect(below.tableCellStyle?.borderTop).toEqual(border({}));
    expect(joinedRunsOf(cellParagraphs(above)[0]))
      .toEqual([["a\n", { foregroundColor: { color: { rgbColor: { blue: 1 } } } }]]);
  });
});

const notedCell = (text: string, number: string) =>
  cellOf({ runs: [text, { footnote: { id: `footnote-${number}`, number } }, "\n"] });

/** Every paragraph of `content` in document order, those of table cells included. */
function paragraphsIn(content: StructuralElement[]): Paragraph[] {
  return content.flatMap(element => element.paragraph
    ? [element.paragraph]
    : (element.table?.tableRows ?? []).flatMap(row =>
      (row.tableCells ?? []).flatMap(cell => paragraphsIn(cell.content ?? []))));
}

/** The tab's footnote references in document order, body and cells. */
const footnoteReferences = (from: GoogleDocsTab) => paragraphsIn(from.body.content)
  .flatMap(paragraph => paragraph.elements)
  .flatMap(element => element.footnoteReference ? [element.footnoteReference] : []);

/** Each footnote reference of the tab as its ID and the number it shows, in document order. */
const footnoteNumbers = (from: GoogleDocsTab) => footnoteReferences(from)
  .map(reference => [reference.footnoteId, reference.footnoteNumber]);

const footnote = (number: string) => ({ footnote: { id: `footnote-${number}`, number } });

describe("footnotes", () => {
  it("numbers the footnotes after a deleted table one lower", () => {
    let tab = buildTab([
      { runs: ["a", footnote("1"), "\n"] },
      { table: [[notedCell("in", "2")]] },
      { runs: ["tail", footnote("3"), "\n"] },
    ]);
    let [start, end] = span(tableElement(tab));
    let result = applyDocsRequests(tab, [deleteRange(start, end)]);

    expect(footnoteNumbers(result)).toEqual([["footnote-1", "1"], ["footnote-3", "2"]]);
    expect(markdownOf(result)).toBe("a\\[1\\]\n\ntail\\[2\\]\n");
  });

  it("numbers the footnotes after a deleted column one lower, in cells and in the body", () => {
    let tab = buildTab([
      { runs: ["\n"] },
      { table: [[notedCell("x", "1"), notedCell("y", "2")], ["\n", notedCell("z", "3")]] },
      { runs: ["tail", footnote("4"), "\n"] },
    ]);
    let result = applyDocsRequests(tab, [deleteColumn(2, 0)]);

    expect(footnoteNumbers(result)).toEqual([
      ["footnote-2", "1"], ["footnote-3", "2"], ["footnote-4", "3"],
    ]);
    expect(markdownOf(result)).toContain("<td><p>y[1]</p></td>");
    expect(markdownOf(result)).toContain("<td><p>z[2]</p></td>");
    expect(markdownOf(result)).toContain("tail\\[3\\]");
  });

  it("numbers the footnotes after deleted text one lower", () => {
    // "one" is at 1 to 3, its footnote at 4 and its line break at 5; "two" starts at 6.
    let tab = buildTab([
      { runs: ["one", footnote("1"), "\n"] },
      { runs: ["two\n"] },
      { runs: ["tail", footnote("2"), "\n"] },
    ]);
    let withinParagraph = applyDocsRequests(tab, [deleteRange(4, 5)]);
    let acrossParagraphs = applyDocsRequests(tab, [deleteRange(3, 7)]);

    expect(bodyParagraphs(withinParagraph).map(textOf)).toEqual(["one\n", "two\n", "tail\n"]);
    expect(bodyParagraphs(acrossParagraphs).map(textOf)).toEqual(["onwo\n", "tail\n"]);
    for (let result of [withinParagraph, acrossParagraphs]) {
      expect(footnoteNumbers(result)).toEqual([["footnote-2", "1"]]);
      expect(markdownOf(result)).toContain("tail\\[1\\]");
    }
  });

  it("numbers the footnotes after a deleted row one lower, in cells and in the body", () => {
    let tab = buildTab([
      { runs: ["\n"] },
      {
        table: [
          [notedCell("first", "1")], [notedCell("second", "2")], [notedCell("third", "3")],
        ],
      },
      { runs: ["tail", { footnote: { id: "footnote-4", number: "4" } }, "\n"] },
    ]);
    let result = applyDocsRequests(tab, [deleteRow(2, 0)]);

    expect(footnoteReferences(result)).toEqual([
      { footnoteId: "footnote-2", footnoteNumber: "1", textStyle: {} },
      { footnoteId: "footnote-3", footnoteNumber: "2", textStyle: {} },
      { footnoteId: "footnote-4", footnoteNumber: "3", textStyle: {} },
    ]);
    expect(markdownOf(result)).toContain("<td><p>second[1]</p></td>");
    expect(markdownOf(result)).toContain("tail\\[3\\]");
  });

  it("keeps a footnote reference in place, one index long, when text beside it changes", () => {
    let tab = buildTab([{ runs: ["ab", { footnote: { id: "footnote-1", number: "1" } }, "cd\n"] }]);
    let result = applyDocsRequests(tab, [insertText(2, "XY"), deleteRange(6, 7)]);
    let [paragraph] = bodyParagraphs(result);

    expect(paragraph.elements.map(span)).toEqual([[1, 5], [5, 6], [6, 8]]);
    expect(textOf(paragraph)).toBe("aXYbd\n");
    expect(paragraph.elements[1].footnoteReference?.footnoteNumber).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// Indexes kept by what a request touches
// ---------------------------------------------------------------------------

const mergeCells = (
  table: number, rowIndex: number, columnIndex: number, rowSpan: number, columnSpan: number,
): GoogleDocsRequest => ({
  mergeTableCells: {
    tableRange: { tableCellLocation: cellAt(table, rowIndex, columnIndex), rowSpan, columnSpan },
  },
});
const unmergeCells = (table: number, rowIndex: number, columnIndex: number): GoogleDocsRequest => ({
  unmergeTableCells: {
    tableRange: { tableCellLocation: cellAt(table, rowIndex, columnIndex), rowSpan: 1, columnSpan: 1 },
  },
});

/** What a run throws, as its message; nothing for a run that returns. */
function refusalOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

/** A paragraph or table of a tab, with the list of elements that holds it. */
type Spot = { element: StructuralElement; container: StructuralElement[]; position: number };

/** Every paragraph of `content` in document order, those of table cells included. */
function paragraphSpots(content: StructuralElement[]): Spot[] {
  return content.flatMap((element, position): Spot[] => element.paragraph
    ? [{ element, container: content, position }]
    : tableCells(element).flatMap(cell => paragraphSpots(cell.content ?? [])));
}

/** Every table of `content` in document order, those nested in cells included. */
function tableSpots(content: StructuralElement[]): Spot[] {
  return content.flatMap((element, position): Spot[] => element.table
    ? [
      { element, container: content, position },
      ...tableCells(element).flatMap(cell => tableSpots(cell.content ?? [])),
    ]
    : []);
}

function tableCells(element: StructuralElement): TableCell[] {
  return (element.table?.tableRows ?? []).flatMap(row => row.tableCells ?? []);
}

/** The last paragraph of every table cell of `content`, in document order. */
function cellEndSpots(content: StructuralElement[]): Spot[] {
  return paragraphSpots(content).filter(({ container, position }) =>
    container !== content && position === container.length - 1);
}

/** Every paragraph that lies in a cell of a table that itself lies in a cell. */
function nestedParagraphSpots(content: StructuralElement[]): Spot[] {
  return content.flatMap(tableCells)
    .flatMap(cell => (cell.content ?? []).flatMap(tableCells))
    .flatMap(cell => paragraphSpots(cell.content ?? []));
}

/** Lines longer than what follows a paragraph of a random tab's nested table in its holders. */
const NESTED_LINES = "one\ntwo\nthree\nfour\n".repeat(2);

const hasMergedCell = (element: StructuralElement) => tableCells(element).some(cell =>
  (cell.tableCellStyle?.rowSpan ?? 1) > 1 || (cell.tableCellStyle?.columnSpan ?? 1) > 1);

/** The two lists a random tab's items belong to: one as a preset makes it, one of one level. */
const RANDOM_LISTS = (): GoogleDocsTab["lists"] => ({
  made: { listProperties: { nestingLevels: presetLevels() } },
  N1: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }] } },
});

const PARAGRAPH_TEXTS = [
  "alpha", "two words", "\u{1F600} smile", "\tindented", "x", "", "a longer line of text",
];
const CELL_TEXTS = ["a", "cell", "", "two words", "\u{1F7E2} ok", "\ttabbed"];
const INSERTED_TEXTS = [
  "x", "two words", "a\nb", "\n", "\tdeep", "\t", "a\u0001b", "\u0001", "\u{1F600}",
  "one\ntwo\nthree",
];
const TEXT_STYLES: [ModelTextStyle, string][] = [
  [{ bold: true }, "bold"], [{ italic: true }, "bold,italic"], [{ link: LINK_A }, "link"],
  [{}, "link"], [{ foregroundColor: { color: { rgbColor: { red: 1 } } } }, "foregroundColor"],
];
const PARAGRAPH_STYLES: [Record<string, unknown>, string][] = [
  [{ namedStyleType: "HEADING_2" }, "namedStyleType"],
  [{ namedStyleType: "NORMAL_TEXT" }, "namedStyleType"],
  [{ indentStart: points(0), indentFirstLine: points(0) }, "indentStart,indentFirstLine"],
];

/**
 * A tab of three to eight blocks of every kind the model indexes. A noted tab also holds
 * footnote references, numbered by their place as Google numbers them: in a paragraph before
 * a table, in two cells of that table that share neither row nor column, and in a paragraph
 * after it, or in two or three of those four.
 */
function randomTab({ below, pick }: Dice, noted: boolean): GoogleDocsTab {
  let line = (text: string) => ({ runs: [`${text}\n`] });
  let grid = (): TableSpec => ({
    table: Array.from({ length: 1 + below(3) }, () =>
      Array.from({ length: 1 + below(3) }, () => below(5) === 0
        ? { paragraphs: [line(pick(CELL_TEXTS)), line(pick(CELL_TEXTS))] }
        : `${pick(CELL_TEXTS)}\n`)),
  });
  let kinds: (() => BlockSpec)[] = [
    () => line(pick(PARAGRAPH_TEXTS)),
    () => line(pick(PARAGRAPH_TEXTS)),
    () => ({ ...line(pick(PARAGRAPH_TEXTS)), namedStyleType: "HEADING_2" }),
    () => ({ ...line(pick(PARAGRAPH_TEXTS)), bullet: { listId: "made", nestingLevel: below(3) } }),
    () => ({ ...line(pick(PARAGRAPH_TEXTS)), bullet: { listId: "N1" } }),
    grid,
    () => ({
      table: [[
        {
          paragraphs: [
            line("outer"),
            { table: [[{ paragraphs: [line("in a"), line("\tin tab")] }, "in b\n"]] },
            line(""),
          ],
        },
        "side\n",
      ]],
    }),
    () => below(2) === 0
      ? { structure: "tableOfContents", length: 2 + below(3) }
      : { structure: "sectionBreak", length: 2 },
    () => ({ runs: ["Owner ", { person: { name: "Ana", email: "" } }, " here\n"] }),
  ];
  let blocks = Array.from({ length: 3 + below(6) }, () => pick(kinds)());
  blocks[below(blocks.length)] = grid();
  if (noted) {
    let places = below(5) < 3 ? [0, 1, 2, 3] : [0, 1, 2, 3].filter(() => below(3) > 0);
    while (places.length < 2) places = [...new Set([...places, below(4)])];
    let note = (place: number, text: string) => ({
      runs: [text, ...(places.includes(place) ? [{ footnote: { id: `fn.${place}`, number: "0" } }] : []), "\n"],
    });
    let rows = 2 + below(2);
    let columns = 2 + below(2);
    let table = Array.from({ length: rows }, (_, row) =>
      Array.from({ length: columns }, (__, column) => ({
        paragraphs: [
          row === 0 && column === 1 ? note(1, "right") : row === 1 && column === 0
            ? note(2, "below") : line(pick(CELL_TEXTS)),
        ],
      })));
    blocks.splice(below(blocks.length + 1), 0, note(0, "intro"), { table }, note(3, "tail"));
  }
  // As in a document of Google's, a paragraph stands before and after every table and at the end.
  let spaced: BlockSpec[] = [];
  for (let block of blocks) {
    let previous = spaced.at(-1);
    if ("table" in block && (!previous || !("runs" in previous))) spaced.push(line(""));
    spaced.push(block);
  }
  let last = spaced.at(-1);
  if (!last || !("runs" in last)) spaced.push(line(""));
  let tab = buildTab(spaced, RANDOM_LISTS());
  footnoteReferences(tab).forEach((reference, index) => {
    reference.footnoteNumber = String(index + 1);
  });
  return tab;
}

/** What a random request draws on: the tab as it stands, and how to choose a place in it. */
type Draw = Dice & {
  doc: GoogleDocsTab;
  /** One of `spots`: any of them, or, back to front, one no later than the place before. */
  choose: (spots: Spot[]) => Spot | undefined;
};

/** One request of each kind the model takes, at a place of the tab as it stands. */
const REQUEST_KINDS: ((draw: Draw) => GoogleDocsRequest | undefined)[] = [
  function insertTextAt({ doc, choose, below, pick }) {
    let spot = choose(paragraphSpots(doc.body.content));
    if (!spot) return undefined;
    let { startIndex, endIndex } = spot.element;
    // Sometimes the index before the paragraph, which may be no paragraph's.
    let index = below(12) === 0 ? startIndex - 1 : startIndex + below(endIndex - startIndex);
    return insertText(index, pick(INSERTED_TEXTS));
  },
  function deleteInsideParagraph({ doc, choose, below }) {
    let spot = choose(paragraphSpots(doc.body.content)
      .filter(({ element }) => element.endIndex - element.startIndex >= 2));
    if (!spot) return undefined;
    let { startIndex, endIndex } = spot.element;
    let start = startIndex + below(endIndex - startIndex - 1);
    return deleteRange(start, start + 1 + below(endIndex - 1 - start));
  },
  function deleteAcrossParagraphs({ doc, choose, below }) {
    let spot = choose(paragraphSpots(doc.body.content)
      .filter(({ container, position }) => container[position + 1]?.paragraph));
    if (!spot) return undefined;
    let { startIndex, endIndex } = spot.element;
    // Up to the next paragraph's start, into it, or over its line break.
    let next = spot.container[spot.position + 1 + below(2)] ?? spot.container[spot.position + 1];
    let into = [0, 0, below(next.endIndex - next.startIndex), next.endIndex - next.startIndex];
    return deleteRange(
      startIndex + below(endIndex - startIndex), next.startIndex + into[below(into.length)]);
  },
  function deleteWholeTable({ doc, choose }) {
    let spot = choose(tableSpots(doc.body.content));
    return spot && deleteRange(spot.element.startIndex, spot.element.endIndex);
  },
  function styleTextAt({ doc, choose, below, pick }) {
    let spot = choose(paragraphSpots(doc.body.content));
    if (!spot) return undefined;
    let { startIndex, endIndex } = spot.element;
    let start = startIndex + below(endIndex - startIndex);
    // Within the paragraph, its line break included, or on into the next one.
    let end = start + 1 + below(endIndex - start + (below(6) === 0 ? 2 : 0));
    return styleText(start, end, ...pick(TEXT_STYLES));
  },
  function styleParagraphsAt({ doc, choose, below, pick }) {
    let spot = choose(paragraphSpots(doc.body.content));
    if (!spot) return undefined;
    let { startIndex, endIndex } = spot.element;
    return styleParagraphs(startIndex, endIndex + below(3), ...pick(PARAGRAPH_STYLES));
  },
  function deleteBulletsAt({ doc, choose, below }) {
    let spot = choose(paragraphSpots(doc.body.content));
    return spot && deleteBullets(spot.element.startIndex, spot.element.endIndex + below(2));
  },
  function createBulletsAt({ doc, choose, below, pick }) {
    let spots = paragraphSpots(doc.body.content);
    let plain = spots.filter(({ element }) => !element.paragraph?.bullet);
    let spot = choose(plain.length > 0 && below(4) > 0 ? plain : spots);
    if (!spot) return undefined;
    let last = spot.container[spot.position + below(3)] ?? spot.element;
    return bullets(
      spot.element.startIndex, last.endIndex,
      below(20) === 0 ? "BULLET_CHECKBOX" : pick([BULLETED, NUMBERED]));
  },
  function insertTableAt({ doc, choose, below }) {
    let spot = choose(paragraphSpots(doc.body.content));
    if (!spot) return undefined;
    let { startIndex, endIndex } = spot.element;
    let index = [startIndex, endIndex - 1, endIndex - 1, startIndex + 1][below(4)];
    return insertTable(index, below(10) === 0 ? 0 : 1 + below(2), 1 + below(2));
  },
  ...([
    (table, row) => insertRow(table, row, true),
    (table, row) => insertRow(table, row, false),
    (table, _, column) => insertColumn(table, column, true),
    (table, _, column) => insertColumn(table, column, false),
    (table, row) => deleteRow(table, row),
    (table, _, column) => deleteColumn(table, column),
    (table, row) => pinRows(table, row),
    (table, _, column) => ({
      updateTableColumnProperties: {
        tableStartLocation: at(table), columnIndices: [column],
        tableColumnProperties: { widthType: "FIXED_WIDTH", width: points(40 + column) },
        fields: "widthType,width",
      },
    }),
    (table, row, column) => ({
      updateTableCellStyle: {
        tableRange: { tableCellLocation: cellAt(table, row, column), rowSpan: 1, columnSpan: 1 },
        tableCellStyle: { backgroundColor: { color: { rgbColor: { green: 1 } } } },
        fields: "backgroundColor",
      },
    }),
    (table, row) => ({
      updateTableRowStyle: {
        tableStartLocation: at(table), rowIndices: [row],
        tableRowStyle: { minRowHeight: points(20 + row) }, fields: "minRowHeight",
      },
    }),
    (table, row, column, rows, columns, below) =>
      mergeCells(table, row, column, 1 + below(rows - row), 1 + below(columns - column)),
    (table, row, column) => unmergeCells(table, row, column),
  ] satisfies ((
    table: number, row: number, column: number, rows: number, columns: number,
    below: Dice["below"],
  ) => GoogleDocsRequest)[]).map(build => ({ doc, choose, below }: Draw) => {
    let spot = choose(tableSpots(doc.body.content));
    let rows = spot?.element.table?.tableRows ?? [];
    let columns = rows[0]?.tableCells?.length ?? 0;
    if (!spot || columns === 0) return undefined;
    return build(
      spot.element.startIndex, below(rows.length), below(columns), rows.length, columns, below);
  }),
];

/** A footnote reference of the tab, and for one in a cell of a body's table, that cell. */
type ReferencePlace = { startIndex: number; table?: number; row?: number; column?: number };

function referencePlaces(doc: GoogleDocsTab): ReferencePlace[] {
  let references = (content: StructuralElement[]) => paragraphsIn(content)
    .flatMap(paragraph => paragraph.elements.filter(element => element.footnoteReference));
  return doc.body.content.flatMap((element): ReferencePlace[] => element.table
    ? (element.table.tableRows ?? []).flatMap((tableRow, row) =>
      (tableRow.tableCells ?? []).flatMap((cell, column) =>
        references(cell.content ?? []).map(({ startIndex }) =>
          ({ startIndex, table: element.startIndex, row, column }))))
    : references([element]).map(({ startIndex }) => ({ startIndex })));
}

/**
 * A request that removes a footnote reference, or moves one past another: a deletion over one,
 * the row or the column of one, or a merge of a cell that holds one into the cell above it.
 */
function notedRequest({ doc, below, pick }: Draw): GoogleDocsRequest | undefined {
  let places = referencePlaces(doc);
  let inCells = places.filter(place => place.table !== undefined);
  let kind = below(5);
  if (kind === 0 || inCells.length === 0) {
    let place = places.length > 0 ? pick(places) : undefined;
    return place && deleteRange(place.startIndex, place.startIndex + 1);
  }
  let { table = 0, row = 0, column = 0 } = pick(inCells);
  if (kind === 1) return deleteRow(table, row);
  if (kind === 2) return deleteColumn(table, column);
  let below1 = inCells.find(place => (place.row ?? 0) > 0);
  return below1 && mergeCells(below1.table ?? 0, (below1.row ?? 0) - 1, below1.column ?? 0, 2, 1);
}

/** What random sequences reached, so that a test can say its generator covers what it is for. */
type Tally = {
  applied: number;
  refused: number;
  /** Applied requests of each kind after which a footnote that stayed shows another number. */
  renumbered: { deleteContentRange: number; deleteTableRow: number; deleteTableColumn: number };
  /** Applied merges that changed the order of the tab's footnote references. */
  mergesThatMoved: number;
  /** A change to a paragraph's length and then a deletion up to the next paragraph's start. */
  joinsAfterTouch: number;
  /** Requests refused at a cell that a merge, sent after a request into its table, covers. */
  coveredRefusals: number;
  /** Requests applied at such a cell once it was split again. */
  uncovered: number;
  /** Lines inserted in a cell of a table in a cell, and then a request inside those lines. */
  nestedGrowths: number;
  /** Tabbed paragraphs at the end of a cell made list items, then a request at the cell's end. */
  bulletedCellEnds: number;
  /** A table put into the last paragraph of a cell, and then a request at the cell's end. */
  tablesAtCellEnds: number;
};

const COVERED_CELL = "a request at a paragraph of a cell that a merged cell covers";

/**
 * The property: after every request of a random sequence, the requests so far applied as one
 * batch give the tab that the same requests give one batch each, which leaves every index
 * exact and numbers the footnotes after each. A request the one refuses, the other refuses alike.
 */
function runSequences(seed: number, sequences: number, backToFront: boolean): Tally {
  let dice = diceOf(seed);
  let { random, below, pick } = dice;
  let tally: Tally = {
    applied: 0, refused: 0,
    renumbered: { deleteContentRange: 0, deleteTableRow: 0, deleteTableColumn: 0 },
    mergesThatMoved: 0, joinsAfterTouch: 0, coveredRefusals: 0, uncovered: 0,
    nestedGrowths: 0, bulletedCellEnds: 0, tablesAtCellEnds: 0,
  };
  for (let sequence = 0; sequence < sequences; sequence++) {
    let noted = sequence % 2 === 0;
    let tab = randomTab(dice, noted);
    let eager = tab;
    let applied: GoogleDocsRequest[] = [];
    let where = () => `seed ${seed}, sequence ${sequence}, after ${JSON.stringify(applied)}`;

    /** Hold one request to the property. Gives the refusal's message when it is refused. */
    let step = (request: GoogleDocsRequest): string | undefined => {
      let after: GoogleDocsTab;
      try {
        after = applyDocsRequests(eager, [request]);
      } catch (error) {
        let message = error instanceof Error ? error.message : String(error);
        expect(refusalOf(() => applyDocsRequests(tab, [...applied, request])), where())
          .toBe(message);
        tally.refused++;
        return message;
      }
      let numbers = new Map(footnoteNumbers(eager).map(([id, number]) => [id, number]));
      let renumbered = footnoteNumbers(after).some(([id, number]) => numbers.get(id) !== number);
      for (let kind of ["deleteContentRange", "deleteTableRow", "deleteTableColumn"] as const) {
        if (kind in request && renumbered) tally.renumbered[kind]++;
      }
      let order = (from: GoogleDocsTab) => footnoteNumbers(from).map(([id]) => id).join();
      if ("mergeTableCells" in request && order(after) !== order(eager)) tally.mergesThatMoved++;
      applied.push(request);
      eager = after;
      expect(applyDocsRequests(tab, applied), where()).toEqual(eager);
      expect(hasModelIndexes(eager), where()).toBe(true);
      tally.applied++;
      return undefined;
    };

    let count = 6 + below(7);
    // Back to front, each place is drawn no later in the tab than the one before it.
    let fractions = Array.from({ length: count }, random).toSorted((a, b) => b - a);
    let limit = Infinity;
    let turn = 0;
    let choose = (spots: Spot[]): Spot | undefined => {
      if (!backToFront) return spots[below(spots.length)];
      let target = Math.min(limit, fractions[turn] * (eager.body.content.at(-1)?.endIndex ?? 0));
      let chosen = spots.filter(({ element }) => element.startIndex <= target).at(-1) ?? spots[0];
      if (chosen) limit = Math.min(limit, chosen.element.startIndex);
      return chosen;
    };

    /**
     * The pair that tells a deletion's lookup from a styled range's: the deletion ends where
     * the paragraph just changed ends, at the paragraph that survives it.
     */
    let lengthThenJoin = () => {
      let spots = paragraphSpots(eager.body.content)
        .filter(({ container, position }) => container[position + 1]?.paragraph);
      let spot = spots[below(spots.length)];
      if (!spot) return;
      let { startIndex, endIndex } = spot.element;
      let first = endIndex - startIndex >= 3 && below(2) === 0
        ? deleteRange(startIndex, startIndex + 1)
        : insertText(startIndex + below(endIndex - startIndex), "xy");
      if (step(first) !== undefined) return;
      let changed = paragraphSpots(eager.body.content)
        .find(({ element }) => element.startIndex === startIndex);
      if (!changed) return;
      let end = changed.element.endIndex;
      if (step(deleteRange(startIndex + below(end - startIndex), end)) === undefined) {
        tally.joinsAfterTouch++;
      }
    };

    /**
     * What the skipped look for covered cells must survive: a table known to hold no merged
     * cell, then a merge in it, then a request at a cell the merge covers.
     */
    let coverThenRequest = () => {
      let tables = tableSpots(eager.body.content).filter(({ element, container }) =>
        container === eager.body.content && !hasMergedCell(element) &&
        tableCells(element).length >= 2);
      let spot = tables[below(tables.length)];
      if (!spot) return;
      let table = spot.element.startIndex;
      let rows = spot.element.table?.tableRows ?? [];
      let columns = rows[0]?.tableCells?.length ?? 0;
      let firstIndex = (row: number, column: number) => eager.body.content
        .find(element => element.startIndex === table)
        ?.table?.tableRows?.[row]?.tableCells?.[column]?.content?.[0]?.startIndex ?? 0;
      if (step(insertText(firstIndex(below(rows.length), below(columns)), "x")) !== undefined) {
        return;
      }
      let across = columns >= 2 && (rows.length < 2 || below(2) === 0);
      let top = below(across ? rows.length : rows.length - 1);
      let left = below(across ? columns - 1 : columns);
      if (step(mergeCells(table, top, left, across ? 1 : 2, across ? 2 : 1)) !== undefined) return;
      let covered = (): number => firstIndex(across ? top : top + 1, across ? left + 1 : left);
      let index = covered();
      let answer = step(pick([
        insertText(index, "x"), styleText(index, index + 1, { bold: true }, "bold"),
        styleParagraphs(index, index + 1, { namedStyleType: "HEADING_2" }, "namedStyleType"),
        deleteBullets(index, index + 1), deleteRange(index, index + 1),
      ]));
      expect(answer, where()).toContain(COVERED_CELL);
      tally.coveredRefusals++;
      if (below(2) === 0) return;
      expect(step(unmergeCells(table, top, left)), where()).toBeUndefined();
      expect(step(insertText(covered(), "y")), where()).toBeUndefined();
      tally.uncovered++;
    };

    /** A request at the line break that ends the cell whose paragraph starts at `start`. */
    let atCellEnd = (start: number): string | undefined => {
      let cell = paragraphSpots(eager.body.content)
        .find(({ element }) => element.startIndex === start)?.container;
      let index = (cell?.at(-1)?.endIndex ?? 0) - 1;
      return step(pick([
        insertText(index, "x"), styleText(index, index + 1, { bold: true }, "bold"),
        styleParagraphs(index, index + 1, { namedStyleType: "HEADING_2" }, "namedStyleType"),
      ]));
    };

    /**
     * The three pairs below tell whether a change of length reached the end of every cell,
     * row and table that holds it: the second request of each lies below the watermark the
     * first left and at or past the end a holder had before it.
     */
    let growNestedThenInside = () => {
      let spots = nestedParagraphSpots(eager.body.content);
      let spot = spots[below(spots.length)];
      if (!spot) return;
      let { startIndex, endIndex } = spot.element;
      let index = startIndex + below(endIndex - startIndex);
      if (step(insertText(index, NESTED_LINES)) !== undefined) return;
      // In the last of the lines, which no holder reached before they were inserted.
      let inside = index + NESTED_LINES.length - 2 - below(3);
      let second = pick([
        insertText(inside, "x"), styleText(inside, inside + 1, { bold: true }, "bold"),
        deleteRange(inside, inside + 1),
      ]);
      if (step(second) === undefined) tally.nestedGrowths++;
    };
    let bulletCellEndThenBreak = () => {
      let ends = cellEndSpots(eager.body.content)
        .filter(({ element }) => !element.paragraph?.bullet);
      let spot = ends[below(ends.length)];
      if (!spot) return;
      let { container } = spot;
      let from = spot.position;
      while (from > 0 && below(2) === 0 && container[from - 1].paragraph &&
        !container[from - 1].paragraph?.bullet) from--;
      let start = container[from].startIndex;
      // A tab ahead of one of them, when none starts with one: bullets take the tabs off.
      let tabbed = container.slice(from).some(({ paragraph }) =>
        paragraph?.elements[0]?.textRun?.content.startsWith("\t"));
      let untabbed = container[from + below(container.length - from)].startIndex;
      if (!tabbed && step(insertText(untabbed, "\t")) !== undefined) return;
      let end = paragraphSpots(eager.body.content)
        .find(({ element }) => element.startIndex === start)?.container.at(-1)?.endIndex ?? 0;
      if (step(bullets(start, end, pick([BULLETED, NUMBERED]))) !== undefined) return;
      if (atCellEnd(start) === undefined) tally.bulletedCellEnds++;
    };
    let tableAtCellEndThenBreak = () => {
      let ends = cellEndSpots(eager.body.content);
      let spot = ends[below(ends.length)];
      if (!spot) return;
      let { startIndex, endIndex } = spot.element;
      let index = below(2) === 0 ? startIndex : endIndex - 1;
      if (step(insertTable(index, 1 + below(2), 1 + below(2))) !== undefined) return;
      if (atCellEnd(startIndex) === undefined) tally.tablesAtCellEnds++;
    };
    let holderPairs = [growNestedThenInside, bulletCellEndThenBreak, tableAtCellEndThenBreak];

    let scripted = below(3);
    for (; turn < count; turn++) {
      if (turn === scripted && sequence % 3 === 1) lengthThenJoin();
      else if (turn === scripted && sequence % 4 === 0) coverThenRequest();
      if (turn === scripted + 2) holderPairs[sequence % holderPairs.length]();
      let draw: Draw = { ...dice, doc: eager, choose };
      let request = (noted && below(3) === 0 ? notedRequest(draw) : undefined) ??
        pick(REQUEST_KINDS)(draw);
      if (request) step(request);
    }
  }
  return tally;
}

describe("indexes kept by what a request touches", () => {
  it("gives the same document as a full re-index after every request, on random sequences", () => {
    let tally = runSequences(20261113, 320, false);

    expect(tally.applied).toBeGreaterThanOrEqual(1500);
    expect(tally.refused).toBeGreaterThanOrEqual(100);
    // The equality covers every footnote's number, which each of these four moves.
    expect(tally.renumbered.deleteContentRange).toBeGreaterThanOrEqual(20);
    expect(tally.renumbered.deleteTableRow).toBeGreaterThanOrEqual(20);
    expect(tally.renumbered.deleteTableColumn).toBeGreaterThanOrEqual(20);
    expect(tally.mergesThatMoved).toBeGreaterThanOrEqual(20);
    expect(tally.joinsAfterTouch).toBeGreaterThanOrEqual(50);
    expect(tally.coveredRefusals).toBeGreaterThanOrEqual(20);
    expect(tally.uncovered).toBeGreaterThan(0);
    // The ends of the cells, rows and tables that hold a change, a nested table's included.
    expect(tally.nestedGrowths).toBeGreaterThanOrEqual(20);
    expect(tally.bulletedCellEnds).toBeGreaterThanOrEqual(20);
    expect(tally.tablesAtCellEnds).toBeGreaterThanOrEqual(20);
  });

  it("does the same when requests run back to front, as the builders send them", () => {
    let tally = runSequences(20261114, 320, true);

    expect(tally.applied).toBeGreaterThanOrEqual(1500);
    expect(tally.refused).toBeGreaterThanOrEqual(100);
  });

  it("moves the end of every cell, row and table that holds a table a merge made longer", () => {
    let grid = Array.from({ length: 3 }, (_, row) =>
      Array.from({ length: 3 }, (__, column) => `r${row}c${column}\n`));
    let tab = buildTab([
      { runs: ["\n"] },
      {
        table: [
          [{
            paragraphs: [
              { runs: ["outer\n"] },
              { table: [[{ paragraphs: [{ runs: ["in\n"] }, { table: grid }, { runs: ["\n"] }] }]] },
              { runs: ["\n"] },
            ],
          }],
          ["next\n"],
        ],
      },
      { runs: ["tail\n"] },
    ]);
    // The table of nine cells, two cells deep.
    let innermost = (doc: GoogleDocsTab): StructuralElement => {
      let inFirstCell = (element: StructuralElement) => {
        let held = element.table?.tableRows?.[0]?.tableCells?.[0]?.content
          ?.find(inner => inner.table);
        if (!held) throw new Error("Expected a table in the first cell");
        return held;
      };
      return inFirstCell(inFirstCell(tableElement(doc)));
    };
    let merge = mergeCells(innermost(tab).startIndex, 0, 0, 3, 2);
    let grown = applyDocsRequests(tab, [merge]);
    expect(innermost(grown).endIndex - innermost(tab).endIndex).toBe(5);
    // At the line break of the last cell, past where every holder ended before the merge. A
    // request at the paragraph's start lies before those ends and reads none of them.
    let lastCell = innermost(grown).table?.tableRows?.[2]?.tableCells?.[2]?.content ?? [];
    let atBreak = insertText((lastCell.at(-1)?.endIndex ?? 0) - 1, "x");

    expect(applyDocsRequests(tab, [merge, atBreak]))
      .toEqual(applyDocsRequests(grown, [atBreak]));
  });

  it("re-indexes the whole tab only at the start and the end of what a builder sends", () => {
    let tab = buildTab([
      { runs: ["Intro\n"] },
      { table: [["a one\n", "b one\n", "c one\n"], ["a two\n", "b two\n", "c two\n"]] },
      { runs: ["Tail\n"] },
    ]);
    let view = docTabToMarkdown(tab);
    let [table] = view.sourceMap.tables;
    let html = view.markdown.slice(table.mdStart, table.mdEnd);
    let named = { expected: tableIdentity(html) };
    let batches = [
      tableTextRequests(
        view, table.mdStart, html, html.replaceAll("one", "<strong>1</strong>st")) ?? [],
      tableChangeRequests(
        view, { type: "insertTableRows", at: 1, cells: [["x", "y", "z"], ["p", "q", "r"]], ...named }),
      tableChangeRequests(
        view, { type: "insertTableColumns", at: 3, cells: [["x"], ["y"]], ...named }),
      tableChangeRequests(view, {
        type: "insertTable", rows: 2, columns: 2, cells: [["a", "b"], ["c", "d"]], after: "Intro",
      }),
    ];
    for (let requests of batches) {
      expect(requests.length).toBeGreaterThanOrEqual(5);
      expect(costOf(tab, requests)).toBe(2);
    }

    // A paragraph write that makes list items pays for the items it reaches above what it
    // wrote. These three runs of bullets lie inside the paragraphs the write changed.
    let item = (text: string, nestingLevel = 0): BlockSpec =>
      ({ runs: [`${text}\n`], bullet: { listId: "made", nestingLevel } });
    let listed = (...blocks: BlockSpec[]) => buildTab(
      [{ runs: ["Lead\n"] }, ...blocks, { runs: ["Tail\n"] }], presetList(BULLETED));
    let written = (from: GoogleDocsTab, oldMarkdown: string, newMarkdown: string) => {
      let before = docTabToMarkdown(from);
      let requests = textReplacementRequests(
        before, { matchStart: before.markdown.indexOf(oldMarkdown), oldMarkdown, newMarkdown });
      let made = requests.filter(request => "createParagraphBullets" in request).length;
      expect(made).toBeGreaterThan(0);
      return { cost: costOf(from, requests), made, kinds: requests.map(request => Object.keys(request)[0]) };
    };
    // New items at the level of the item before them.
    let level = written(listed(item("a"), { runs: ["P\n"] }), "P", "- b\n- c");
    expect(level.cost).toBeLessThanOrEqual(2 + level.made);
    // A nested item written alone after an item: an empty paragraph is bulleted and deleted.
    let nested = written(listed(item("a")), "- a", "- a\n  - b");
    expect(nested.kinds.slice(-3))
      .toEqual(["insertText", "createParagraphBullets", "deleteContentRange"]);
    expect(nested.cost).toBeLessThanOrEqual(2 + nested.made);
    // A top-level item written after two nested ones, which are taken in with it.
    let outdent = written(listed(item("a"), item("b", 1), item("c", 2)), "    - c", "    - c\n- d");
    expect(outdent.kinds.slice(-3)).toEqual(["insertText", "insertText", "createParagraphBullets"]);
    expect(outdent.cost).toBeLessThanOrEqual(2 + outdent.made);

    // In general a run costs up to two: here it lies below a paragraph the same write changed,
    // past the watermark that change left, so its first request pays a pass as well.
    let below = written(
      buildTab([{ runs: ["A\n"] }, { runs: ["B\n"] }, { runs: ["C\n"] }, { runs: ["Tail\n"] }]),
      "A\n\nB\n\nC", "A2\n\nB\n\nC\n\n  - x");
    expect(below.cost).toBeGreaterThan(2);
    expect(below.cost).toBeLessThanOrEqual(2 + 2 * below.made);
  });

  it("takes the largest replacement in a table of the most cells a tab may hold", () => {
    let columns = 50;
    let rows = MAX_TAB_TABLE_CELLS / columns;
    let tab = buildTab([
      { runs: ["Intro\n"] },
      {
        table: Array.from({ length: rows }, (_, row) =>
          Array.from({ length: columns }, (__, column) => `r${row}c${column}\n`)),
      },
      { runs: ["Tail\n"] },
    ]);
    let view = docTabToMarkdown(tab);
    let [table] = view.sourceMap.tables;
    let html = view.markdown.slice(table.mdStart, table.mdEnd);
    // Every second column's cells get other text.
    let changed = html.replace(/r(\d+)c(\d+)</g, (cell, row, column) =>
      Number(column) % 2 === 0 ? `r${row}x${column}<` : cell);
    let requests = tableTextRequests(view, table.mdStart, html, changed) ?? [];
    expect(requests.length).toBeGreaterThan(5000);
    expect(requests.length).toBeLessThanOrEqual(MAX_TABLE_TEXT_REQUESTS);

    let cost: ModelCost = { fullReindexes: 0 };
    let applied = applyDocsRequests(tab, requests, {}, cost);

    expect(cost.fullReindexes).toBe(2);
    // Each cell reads as it was written.
    expect(markdownOf(applied)).toBe(view.markdown.replace(html, changed));
  });

  /** A tab with references in two paragraphs, in seven cells of a table and after it. */
  const notedTab = () => {
    let cell = (number: number) => notedCell(`c${number}`, String(number));
    return buildTab([
      { runs: ["a", footnote("1"), "\n"] },
      { runs: ["b", footnote("2"), "\n"] },
      {
        table: [
          ["x\n", cell(3), cell(4)],
          [cell(5), "y\n", cell(6)],
          [cell(7), cell(8), cell(9)],
        ],
      },
      { runs: ["tail", footnote("10"), "\n"] },
    ]);
  };
  // Each request is built on the tab as the ones before it left it.
  const overFirstReference = (doc: GoogleDocsTab) => {
    let [first] = referencePlaces(doc);
    return deleteRange(first.startIndex, first.startIndex + 1);
  };
  const tableOf = (doc: GoogleDocsTab) => tableElement(doc).startIndex;
  const lastRow = (doc: GoogleDocsTab) => deleteRow(tableOf(doc), 2);
  const lastColumn = (doc: GoogleDocsTab) => deleteColumn(tableOf(doc), 2);
  const leftColumn = (doc: GoogleDocsTab) => mergeCells(tableOf(doc), 0, 0, 2, 1);

  it("numbers footnotes once a batch is applied", () => {
    for (let steps of [
      [overFirstReference, lastRow, lastColumn, leftColumn],
      [leftColumn, overFirstReference, lastRow, lastColumn],
    ]) {
      let tab = notedTab();
      let eager = tab;
      let requests: GoogleDocsRequest[] = [];
      for (let build of steps) {
        let before = footnoteNumbers(eager);
        requests.push(build(eager));
        eager = applyDocsRequests(eager, requests.slice(-1));
        // Each of them changes the number a footnote that stays shows, or their order.
        expect(footnoteNumbers(eager)).not.toEqual(before.slice(0, footnoteNumbers(eager).length));
      }
      let batch = footnoteNumbers(applyDocsRequests(tab, requests));

      expect(batch).toEqual(footnoteNumbers(eager));
      expect(batch.map(([id]) => id)).toEqual(
        ["footnote-2", "footnote-5", "footnote-3", "footnote-10"]);
      expect(batch.map(([, number]) => number)).toEqual(["1", "2", "3", "4"]);
    }
  });

  it("numbers the footnotes a merge moves by where they stand", () => {
    let tab = buildTab([
      { runs: ["\n"] },
      { table: [["x\n", notedCell("right", "1")], [notedCell("below", "2"), "y\n"]] },
      { runs: ["\n"] },
    ]);
    let result = applyDocsRequests(tab, [mergeCells(2, 0, 0, 2, 1)]);

    // Inferred: Google numbers footnotes by where they stand, and no recorded document holds
    // a merge over one. The request builders refuse a merge over a cell that holds one.
    expect(footnoteNumbers(result)).toEqual([["footnote-2", "1"], ["footnote-1", "2"]]);
  });

  it("leaves footnote numbers as they are when no request removes or moves a reference", () => {
    // Numbers that are not by place, which a numbering would change.
    let tab = buildTab([
      { runs: ["a", footnote("5"), "\n"] },
      { table: [["x\n", notedCell("right", "7")], [notedCell("below", "3"), "y\n"]] },
      { runs: ["\n"] },
    ]);
    let result = applyDocsRequests(tab, [
      insertText(1, "new "), styleText(1, 4, { bold: true }, "bold"), insertRow(8, 0, true),
    ]);

    expect(rowsOf(result)).toHaveLength(3);
    expect(footnoteNumbers(result))
      .toEqual([["footnote-5", "5"], ["footnote-7", "7"], ["footnote-3", "3"]]);
  });

  it("leaves the tab it was given as it was, also when a request is refused midway", () => {
    let tab = notedTab();
    let given = structuredClone(tab);
    // Neither moves the table, so both are built on the tab as given.
    let requests = [leftColumn, lastRow].map(build => build(tab));

    expect(applyDocsRequests(tab, requests)).not.toEqual(given);
    expect(tab).toEqual(given);
    expect(() => applyDocsRequests(tab, [requests[0], insertText(0, "x"), requests[1]]))
      .toThrow(OUTSIDE_PARAGRAPH);
    expect(tab).toEqual(given);
  });

  it("counts one clone and two full re-indexes for a batch on a tab as it was fetched into " +
    "`replayCost`", () => {
    let tab = buildTab([{ runs: ["Hello\n"] }]);
    for (let cost of [undefined, { fullReindexes: 0 }]) {
      let before = { ...replayCost };
      applyDocsRequests(tab, [insertText(1, "x")], {}, cost);
      expect(replayCost).toMatchObject(
        { tabClones: before.tabClones + 1, fullReindexes: before.fullReindexes + 2 });
      if (cost) expect(cost.fullReindexes).toBe(2);
    }
  });

  it("re-indexes a tab it returned once for a batch that moves an index, and not at all for " +
    "one that moves none", () => {
    let first = applyDocsRequests(buildTab([{ runs: ["Hello\n"] }]), [insertText(1, "x")]);
    let styled = [styleText(2, 4, { bold: true }, "bold")];

    expect(costOf(first, [insertText(1, "y")])).toBe(1);
    expect(costOf(first, styled)).toBe(0);
    // A copy is another object, which the model does not know it returned.
    expect(costOf(structuredClone(first), [insertText(1, "y")])).toBe(2);
    expect(costOf(structuredClone(first), styled)).toBe(1);
    // The runs the style cut carry their indexes with no pass over the tab.
    let unmoved = applyDocsRequests(first, styled);
    expect(runsOf(bodyParagraphs(unmoved)[0]).map(([text]) => text)).toEqual(["x", "He", "llo\n"]);
    expect(hasModelIndexes(unmoved)).toBe(true);
    expect(unmoved).toEqual(applyDocsRequests(structuredClone(first), styled));
  });

  it("gives for a tab it returned what it gives for a copy of that tab", () => {
    let dice = diceOf(20261115);
    let { below, pick } = dice;
    let requestIn = (doc: GoogleDocsTab) =>
      pick(REQUEST_KINDS)({ ...dice, doc, choose: spots => spots[below(spots.length)] });
    let run = (
      from: GoogleDocsTab, batch: GoogleDocsRequest[],
    ): { tab: GoogleDocsTab; passes: number } | { refusal: string } => {
      let cost: ModelCost = { fullReindexes: 0 };
      try {
        return { tab: applyDocsRequests(from, batch, {}, cost), passes: cost.fullReindexes };
      } catch (error) {
        return { refusal: error instanceof Error ? error.message : String(error) };
      }
    };
    let tally = { applied: 0, refused: 0, unmoved: 0, unmovedAtEnd: 0 };
    for (let round = 0; round < 900; round++) {
      let tab = randomTab(dice, round % 2 === 0);
      let request = requestIn(tab);
      let first = request && run(tab, [request]);
      if (!first || !("tab" in first)) continue;
      let returned = first.tab;
      // One request or two, each at a place of the tab as it was returned.
      let batch = [requestIn(returned), below(2) === 0 ? requestIn(returned) : undefined]
        .flatMap(drawn => drawn ? [drawn] : []);
      if (batch.length === 0) continue;
      let where = `round ${round}, ${JSON.stringify(batch)}`;
      let known = run(returned, batch);
      let copied = run(structuredClone(returned), batch);
      if (!("tab" in known) || !("tab" in copied)) {
        expect(known, where).toEqual(copied);
        tally.refused++;
        continue;
      }
      expect(known.tab, where).toEqual(copied.tab);
      expect(hasModelIndexes(known.tab) && hasModelIndexes(copied.tab), where).toBe(true);
      // The copy pays the pass before its first request, and nothing else differs.
      expect(known.passes, where).toBe(copied.passes - 1);
      tally.applied++;
      let last = run(returned, batch.slice(-1));
      if (known.passes === 0) tally.unmoved++;
      // A batch whose last request moves no index, after one that moved some.
      else if ("tab" in last && last.passes === 0) tally.unmovedAtEnd++;
    }

    expect(tally.applied).toBeGreaterThanOrEqual(400);
    expect(tally.refused).toBeGreaterThanOrEqual(100);
    expect(tally.unmoved).toBeGreaterThanOrEqual(100);
    expect(tally.unmovedAtEnd).toBeGreaterThanOrEqual(20);
  });
});

describe("two values of plain data", () => {
  it("are the same when they hold the same keys and values, however deep", () => {
    let value = { type: "insertTable", cells: [["a", "b"], ["c"]], look: { width: null, at: 2 } };

    expect(sameValue(value, structuredClone(value))).toBe(true);
    expect(sameValue(value, { ...value, cells: [["a", "b"], ["d"]] })).toBe(false);
    expect(sameValue(value, { ...value, cells: [["a", "b"], ["c"], []] })).toBe(false);
    expect(sameValue(value, { ...value, look: { width: null, at: 3 } })).toBe(false);
    expect(sameValue([1, [2, 3]], [1, [2, 3]])).toBe(true);
    expect(sameValue(["a"], { 0: "a" })).toBe(false);
    expect(sameValue("a", "a")).toBe(true);
    expect(sameValue(null, {})).toBe(false);
    // A key that holds `undefined` is not a key left out, on either side.
    expect(sameValue({ after: undefined }, {})).toBe(false);
    expect(sameValue({}, { after: undefined })).toBe(false);
    expect(sameValue({ after: undefined, at: 1 }, { at: 1, count: undefined })).toBe(false);
  });
});

/** How many times the model recomputed every index of the tab for these requests. */
function costOf(tab: GoogleDocsTab, requests: readonly GoogleDocsRequest[]): number {
  let cost: ModelCost = { fullReindexes: 0 };
  applyDocsRequests(tab, requests, {}, cost);
  return cost.fullReindexes;
}

describe("the index guard", () => {
  const indexed = () => buildTab([
    { runs: ["Plain ", { text: "bold", style: { bold: true } }, " \u{1F600}\n"] },
    { structure: "tableOfContents", length: 4 },
    { runs: ["Owner ", { person: { name: "Ana", email: "" } }, { dropdown: "Open" }, "\n"] },
    {
      table: [
        ["a\n", { paragraphs: [{ runs: ["outer\n"] }, { table: [["in\n"]] }, { runs: ["\n"] }] }],
        [notedCell("noted", "1"), "\n"],
      ],
    },
    { structure: "sectionBreak", length: 2 },
    { runs: [{ date: "Nov 8, 2026" }, { horizontalRule: true }, "\n"] },
  ]);
  const paragraphAt = (tab: GoogleDocsTab, position: number) =>
    paragraphOf(tab.body.content[position]);

  it("holds for tabs as Google indexes them", () => {
    expect(hasModelIndexes(indexed())).toBe(true);
    expect(hasModelIndexes(buildTab([]))).toBe(true);
  });

  it("takes a start index Google leaves out as 0", () => {
    let tab = indexed();
    let opening: { startIndex?: number } = tab.body.content[0];
    delete opening.startIndex;

    expect(hasModelIndexes(tab)).toBe(true);
  });

  it("fails a tab with an index the model would compute differently", () => {
    let longRun = indexed();
    paragraphAt(longRun, 1).elements[1].endIndex++;
    let lateRow = indexed();
    rowsOf(lateRow)[1].startIndex++;
    let overlap = indexed();
    overlap.body.content[1].endIndex++;
    let emptyRun = indexed();
    let [first] = paragraphAt(emptyRun, 1).elements;
    paragraphAt(emptyRun, 1).elements.unshift(
      { startIndex: first.startIndex, endIndex: first.startIndex, textRun: { content: "", textStyle: {} } });

    for (let tab of [longRun, lateRow, overlap, emptyRun]) expect(hasModelIndexes(tab)).toBe(false);
  });

  it("changes nothing in the tab it reads", () => {
    let tab = indexed();
    paragraphAt(tab, 1).elements.push(
      { startIndex: 0, endIndex: 0, textRun: { content: "", textStyle: {} } });
    let given = structuredClone(tab);

    expect(hasModelIndexes(tab)).toBe(false);
    expect(tab).toEqual(given);
  });

  it("holds for every tab the model returns", () => {
    // The random sequences above assert it after each of their requests; this is one batch.
    let result = applyDocsRequests(indexed(), [
      insertText(3, "one\ntwo"), deleteRange(2, 5), insertTable(1, 2, 2),
    ]);

    expect(hasModelIndexes(result)).toBe(true);
  });

  it("says the tab can be read and not changed", () => {
    let error = unindexedTabRefusal("replaceText");

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(
      "replaceText: this tab holds content whose place in the document cannot be worked out " +
      "here, so a change to it could not be shown as it will read once applied. The tab can be " +
      "read but not changed through this connection. Make the change in Google Docs.");
  });
});

/** `value`, which a fixture is built to hold. */
function present<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("The fixture does not hold what the test names");
  return value;
}

/** The cell at `row` and `column` of the table `element`. */
const cellIn = (element: StructuralElement, row: number, column: number): TableCell =>
  present(element.table?.tableRows?.[row]?.tableCells?.[column]);

/** Where the first paragraph of `cell` starts. */
const textStart = (cell: TableCell): number => present(cell.content?.[0]).startIndex;

/**
 * Where a walk of `tab` from its first element finds `index`: the first element that ends past
 * it, then, in a table, the first row and the first cell that do, and so on into the cell.
 */
function scannedPlace(tab: GoogleDocsTab, index: number): ModelPlace {
  let place: ModelPlace = {};
  let scan = (content: StructuralElement[], path: number[]): void => {
    let position = content.findIndex(element => element.endIndex > index);
    let element = content.at(position);
    if (position < 0 || !element || index < element.startIndex) return;
    if (element.paragraph) place = { paragraph: [...path, position] };
    else if (element.table && element.startIndex === index) place = { table: [...path, position] };
    else if (element.table) {
      let rows = element.table.tableRows ?? [];
      let rowIndex = rows.findIndex(row => row.endIndex > index);
      let cells = rows.at(rowIndex)?.tableCells ?? [];
      let columnIndex = cells.findIndex(cell => cell.endIndex > index);
      let cell = cells.at(columnIndex);
      if (rowIndex >= 0 && columnIndex >= 0 && cell && cell.startIndex < index) {
        scan(cell.content ?? [], [...path, position, rowIndex, columnIndex]);
      }
    }
  };
  scan(tab.body.content, []);
  return place;
}

/**
 * A tab for the lookups: paragraphs of several runs around three tables of the body. `wide` has
 * three rows or more and two columns or more, `holder` a table in a cell of its first row,
 * between two paragraphs, and `single` one cell. Their cells hold one paragraph or two.
 */
function lookupTab({ below, pick }: Dice): GoogleDocsTab {
  let words = ["al", "be", "ga de", "eps"];
  let runs = (): ParagraphSpec => ({
    runs: [
      ...Array.from({ length: below(3) }, (_, run) =>
        ({ text: `${pick(words)} `, style: run % 2 === 0 ? { bold: true } : {} })),
      `${pick(words)}\n`,
    ],
  });
  let cell = () => cellOf(...Array.from({ length: 1 + below(2) }, runs));
  let table = (rows: number, columns: number): TableSpec =>
    ({ table: Array.from({ length: rows }, () => Array.from({ length: columns }, cell)) });
  let between = (): BlockSpec[] => Array.from({ length: 1 + below(2) }, runs);
  let wide = table(3 + below(2), 2 + below(2));
  let holder: TableSpec = {
    table: [
      [cell(), cellOf(runs(), table(1 + below(2), 1 + below(2)), runs())],
      [cell(), cell()],
    ],
  };
  return buildTab([
    runs(), runs(), { runs: ["\tin\n"] }, ...between(),
    ...(below(2) === 0 ? [wide, ...between(), holder] : [holder, ...between(), wide]),
    ...between(), table(1, 1), runs(), runs(),
  ]);
}

/** Batches that lower the watermark of `tab`, a tab of `lookupTab`, in each way the model does. */
function lookupBatches(tab: GoogleDocsTab): [string, GoogleDocsRequest[]][] {
  let body = tab.body.content;
  let [first, second, indented] = body.filter(element => element.paragraph);
  let tail = present(body.at(-1));
  let tables = body.filter(element => element.table);
  let ofRows = (count: (rows: number) => boolean) =>
    present(tables.find(element => count(element.table?.tableRows?.length ?? 0)));
  let wide = ofRows(rows => rows >= 3);
  let holder = ofRows(rows => rows === 2);
  let single = ofRows(rows => rows === 1);
  let inner = present(cellIn(holder, 0, 1).content?.[1]);
  let grown = textStart(cellIn(wide, 0, 1));
  // Longer than the tab: every index stored past it is then smaller than the watermark.
  let long = "x".repeat(present(body.at(-1)).endIndex);
  return [
    ["no request", []],
    ["insertText in the body", [insertText(second.startIndex + 1, "new")]],
    ["insertText in a cell", [insertText(textStart(cellIn(wide, 1, 1)) + 1, "new")]],
    ["insertText in a nested table's cell",
      [insertText(textStart(cellIn(inner, 0, 0)) + 1, "new")]],
    ["a long insertText in the body", [insertText(second.startIndex, long)]],
    ["a long insertText in a cell", [insertText(textStart(cellIn(wide, 0, 0)), long)]],
    ["a long insertText in a nested table's cell",
      [insertText(textStart(cellIn(inner, 0, 0)), long)]],
    ["insertText with line breaks", [insertText(second.startIndex + 1, "one\ntwo\nthree")]],
    ["insertText with line breaks in a cell",
      [insertText(textStart(cellIn(wide, 0, 0)), "one\ntwo\n")]],
    ["deleteContentRange inside a paragraph",
      [deleteRange(second.startIndex, second.startIndex + 1)]],
    ["deleteContentRange across paragraphs",
      [deleteRange(first.startIndex + 1, second.startIndex + 1)]],
    ["deleteContentRange inside a cell", [deleteRange(grown, grown + 1)]],
    ["deleteContentRange of a whole body table", [deleteRange(wide.startIndex, wide.endIndex)]],
    ["createParagraphBullets that takes a tab off",
      [bullets(indented.startIndex, indented.endIndex, BULLETED)]],
    ["insertTable at a paragraph's start", [insertTable(second.startIndex, 2, 2)]],
    ["insertTable at a paragraph's end", [insertTable(second.endIndex - 1, 1, 2)]],
    ["insertTableRow", [insertRow(wide.startIndex, 1, true)]],
    ["insertTableColumn", [insertColumn(wide.startIndex, 0, true)]],
    ["deleteTableColumn", [deleteColumn(wide.startIndex, 0)]],
    ["deleteTableColumn of a table's last column", [deleteColumn(single.startIndex, 0)]],
    ["deleteTableRow of a middle row", [deleteRow(wide.startIndex, 1)]],
    ["deleteTableRow of the first row", [deleteRow(wide.startIndex, 0)]],
    ["deleteTableRow of a table's last row", [deleteRow(single.startIndex, 0)]],
    // The row deleted lies past the watermark, and the start it carries below it.
    ["deleteTableRow after an insertText in an earlier row",
      [insertText(grown, long), deleteRow(wide.startIndex, 2)]],
    ["deleteTableRow after a deletion in an earlier row",
      [deleteRange(grown, grown + 1), deleteRow(wide.startIndex, 2)]],
    ["deleteTableRow of a later then an earlier row",
      [deleteRow(wide.startIndex, 2), deleteRow(wide.startIndex, 0)]],
    ["deleteTableRow twice at one row",
      [deleteRow(wide.startIndex, 1), deleteRow(wide.startIndex, 1)]],
    ["deleteTableRow of the row an insertText grew",
      [insertText(textStart(cellIn(wide, 1, 0)), "x"), deleteRow(wide.startIndex, 1)]],
    ["deleteTableRow before the row an insertText grew",
      [insertText(textStart(cellIn(wide, 2, 0)), "x"), deleteRow(wide.startIndex, 0)]],
    ["insertText below an earlier one",
      [insertText(tail.startIndex, "late"), insertText(second.startIndex, "early")]],
    ["insertText in a cell after one in the table nested in it",
      [insertText(textStart(cellIn(inner, 0, 0)), "in"),
        insertText(textStart(cellIn(holder, 0, 1)), "out")]],
  ];
}

describe("lookups by index", () => {
  it("finds every index where a linear scan of the result finds it, on generated tabs, below " +
    "and past the watermark", () => {
    for (let seed of [20261114, 7, 4096]) {
      let tab = lookupTab(diceOf(seed));
      for (let [name, requests] of lookupBatches(tab)) {
        let result = applyDocsRequests(tab, requests);
        // The batch's re-indexes without the one that ends it, which a batch pays once a
        // request has moved an index: all that a lookup below the watermark spends.
        let unasked = costOf(tab, requests) - (requests.length > 0 ? 1 : 0);
        let below = 0;
        let past = 0;
        let end = present(result.body.content.at(-1)).endIndex;
        for (let index = 0; index <= end + 1; index++) {
          let before = replayCost.fullReindexes;
          let place = modelPlaceAfter(tab, requests, index);
          if (replayCost.fullReindexes - before === unasked) below++;
          else past++;
          expect(place, `seed ${seed}, ${name}, index ${index}`)
            .toEqual(scannedPlace(result, index));
        }
        expect(below, `seed ${seed}, ${name}, below the watermark`).toBeGreaterThan(0);
        if (requests.length > 0) {
          expect(past, `seed ${seed}, ${name}, past the watermark`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("finds the boundaries", () => {
    // A paragraph, a table whose second cell holds a table between two paragraphs, a second row
    // and a paragraph. The text put in the nested cell brings the watermark to 18, where that
    // cell's paragraph ends.
    let tab = buildTab([
      para("ab"),
      { table: [["c\n", cellOf(para("d"), { table: [["e\n"]] }, para(""))], ["f\n", "g\n"]] },
      para("tail"),
    ]);
    let requests = [insertText(15, "x")];
    let nestedCell = [2, 0, 1, 1, 0, 0];
    let cases: [string, number, ModelPlace][] = [
      ["the section break", 0, {}],
      ["a paragraph's start", 1, { paragraph: [1] }],
      ["a paragraph's last index", 3, { paragraph: [1] }],
      ["a paragraph's end, where a table starts", 4, { table: [2] }],
      ["a row's own index", 5, {}],
      ["a cell's own index", 6, {}],
      ["the first index of a cell's content", 7, { paragraph: [2, 0, 0, 0] }],
      ["a cell's end, the next cell's own index", 9, {}],
      ["a paragraph of a cell before a nested table", 11, { paragraph: [2, 0, 1, 0] }],
      ["a nested table's start", 12, { table: [2, 0, 1, 1] }],
      ["a nested table's cell's own index", 14, {}],
      ["an index in a nested table's cell", 16, { paragraph: [...nestedCell, 0] }],
      ["the last index below the watermark", 17, { paragraph: [...nestedCell, 0] }],
      ["the watermark, the nested table's last index", 18, {}],
      ["one past the watermark, the paragraph after the nested table", 19,
        { paragraph: [2, 0, 1, 2] }],
      ["the own index of the row past the watermark", 20, {}],
      ["a cell of the row past the watermark", 23, { paragraph: [2, 1, 0, 0] }],
      ["the table's last index", 27, {}],
      ["the paragraph after the table", 28, { paragraph: [3] }],
      ["the tab's end", 33, {}],
    ];

    for (let [name, index, place] of cases) {
      expect(modelPlaceAfter(tab, requests, index), name).toEqual(place);
      expect(scannedPlace(applyDocsRequests(tab, requests), index), name).toEqual(place);
    }
  });

  it("compares about log2 of a body's elements for a lookup", () => {
    let tab = buildTab(Array.from({ length: 4096 }, (_, line) => para(`line ${line}`)));
    let index = tab.body.content[4090].startIndex + 1;
    let before = replayCost.lookupSteps;

    applyDocsRequests(tab, [insertText(index, "x")]);

    // The request looks up three indexes: the paragraph the text goes into, and the code unit
    // on each side of it. The body's 4,097 elements halve down to one in 12 comparisons or 13,
    // and to this paragraph in 12, where a walk from the first element would compare 4,091.
    expect(replayCost.lookupSteps - before).toBe(3 * 12);
  });
});
