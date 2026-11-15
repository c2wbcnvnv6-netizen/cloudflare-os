import type { DocSuggestion, DriveComment, DriveCommentReply } from "./comment-types";
import type { GoogleDocReadSession } from "./docs-read-types";
export type { DocMetadata, GoogleDocReadSession, GoogleDocTab } from "./docs-read-types";

/** Options for {@link GoogleDocSession.comment}. */
export type DocCommentOptions = {
  /**
   * Text of the Doc this comment is about, within one paragraph and at most 500 characters, which
   * must occur exactly once in the tab as Google has it saved, not counting edits still waiting for
   * approval: the tab's text as `getContent()` shows it, without Markdown formatting (no `**`, list
   * markers or escapes) and, in a table, without HTML (`&` rather than `&amp;`, no tags). The
   * comment is attached to it, as one made in the Docs editor is, and it must still occur exactly
   * once in the tab when the comment is approved.
   */
  quote: string;
  /** The tab `quote` is in: an ID returned by `listTabs()`, omitted only when there is one tab. */
  tabId?: string;
};

/** Options for {@link GoogleDocSession.suggestEdit}. */
export type DocSuggestEditOptions = {
  /** Why, posted as a reply on the suggestion; at most 2048 bytes of UTF-8. */
  note?: string;
  /** The tab `oldText` is in: an ID returned by `listTabs()`, omitted only when there is one tab. */
  tabId?: string;
};

/** A table to add with `insertTable()`. */
export type NewDocTable = {
  /** How many rows the table has: at least 1. */
  rows: number;

  /** How many columns it has: 1 to 20. */
  columns: number;

  /**
   * `cells[row][column]` is each cell's text. Rows left out at the end, and cells left out at
   * the end of a row, are empty; an empty cell before a filled one is `""`. The text is plain:
   * nothing in it is read as Markdown or HTML. `\n` starts a new paragraph in the cell and
   * `\u000b` breaks a line within one. The cells of one call hold at most 2,000 `\n` in all.
   */
  cells?: string[][];

  /**
   * Where the table goes: Markdown that occurs exactly once in the tab, found as `replaceText()`
   * finds `oldMarkdown`. The table follows the paragraph, heading, list item or table that the
   * text ends in (text inside a table names that whole table); line breaks at the end of the
   * text only help to make it unique. To make it unique, add the text before it or the line
   * break that ends its paragraph: text added after it names a later paragraph. A line break at
   * the start of the text stands for the start of a line, the tab's first line included. Omit
   * `after` to add the table at the end of the tab.
   */
  after?: string;
};

/** Rows or columns to add to a table, for `insertTableRows()` and `insertTableColumns()`. */
export type DocTableInsertion = {
  /** The table: its position among the tab's tables, counting from 0. */
  table: number;

  /**
   * The row or column, counting from 0, that the new ones go before. Omit it, or give the
   * table's number of rows or columns, to add them after the last.
   */
  at?: number;

  /**
   * How many to add. For rows, when left out, it is as many as `cells` holds, or 1 without
   * `cells`. For columns it is 1 unless given: `cells` never sets it. `cells` may fill fewer
   * rows or columns than `count`, which leaves the rest empty, but not more.
   */
  count?: number;

  /**
   * The new cells' text, as in `NewDocTable.cells`: plain, with cells left out at the end
   * empty and an empty cell before a filled one `""`. For rows, `cells[i][column]` is the text
   * of the i-th new row's cell in that column. For columns, `cells[row][i]` is the text of the
   * i-th new column's cell in that row of the table: one array per row of the table, each
   * holding one text per new column.
   */
  cells?: string[][];
};

/** Rows or columns to delete from a table, for `deleteTableRows()` and `deleteTableColumns()`. */
export type DocTableDeletion = {
  /** The table: its position among the tab's tables, counting from 0. */
  table: number;

  /** The first row or column to delete, counting from 0. */
  at: number;

  /** How many to delete: 1 by default. */
  count?: number;
};

/** A block of cells of a table, for `setTableCellStyle()`. */
export type DocTableCells = {
  /** The table: its position among the tab's tables, counting from 0. */
  table: number;

  /** The block's first row, counting from 0. */
  row: number;

  /** The block's first column, counting from 0. */
  column: number;

  /** How many rows the block spans: 1 by default. */
  rows?: number;

  /** How many columns the block spans: 1 by default. */
  columns?: number;
};

/** One edge of a table cell. */
export type DocTableBorder = {
  /** Its width in points, from 0 to 24. An edge 0 wide is not drawn, as `getContent()`'s `none`. */
  width: number;

  /** How it is drawn: `"solid"` unless given. */
  dash?: "solid" | "dotted" | "dashed";

  /** Its colour as `#rrggbb`: black unless given. */
  color?: string;
};

/**
 * What `setTableCellStyle()` sets, at least one field of it. A field left out stays as it is.
 * Lengths are in points, with at most three decimals.
 */
export type DocTableCellStyle = {
  /** The cells' shading as `#rrggbb`, or `null` for none. */
  background?: string | null;

  /** Where the cells' text sits between their top and bottom. */
  verticalAlign?: "top" | "middle" | "bottom";

  /** Each side's padding, from 0 to 100 points. */
  padding?: { top?: number; right?: number; bottom?: number; left?: number };

  /** Every edge of every cell of the block, those between its cells included; `null` hides them. */
  border?: DocTableBorder | null;

  /**
   * Edges of the block, set after `border`, `null` hiding one: its outer `top`, `bottom`,
   * `left` and `right`, and those between its rows (`innerHorizontal`, for a block of two rows
   * or more) and between its columns (`innerVertical`, for two columns or more).
   */
  borders?: {
    top?: DocTableBorder | null;
    bottom?: DocTableBorder | null;
    left?: DocTableBorder | null;
    right?: DocTableBorder | null;
    innerHorizontal?: DocTableBorder | null;
    innerVertical?: DocTableBorder | null;
  };
};

/** Columns of a table and their width, for `setTableColumnWidths()`. */
export type DocTableColumnWidths = {
  /** The table: its position among the tab's tables, counting from 0. */
  table: number;

  /** The first column, counting from 0. Omit it, and `count`, to set every column. */
  at?: number;

  /** How many columns: 1 by default when `at` is given. */
  count?: number;

  /**
   * Each column's width in points, from 5 to 1,000 with at most three decimals, or `null` for
   * columns that share the width the fixed ones leave of the page.
   */
  width: number | null;
};

/** Rows of a table and their least height, for `setTableRowHeights()`. */
export type DocTableRowHeights = {
  /** The table: its position among the tab's tables, counting from 0. */
  table: number;

  /** The first row, counting from 0. Omit it, and `count`, to set every row. */
  at?: number;

  /** How many rows: 1 by default when `at` is given. */
  count?: number;

  /**
   * Each row's least height in points, from 0 to 1,000 with at most three decimals: a row with
   * more text than fits grows past it, and one of 0 is as tall as its text.
   */
  height: number;
};

/** A block of a table's cells to merge into one, for `mergeTableCells()`. */
export type DocTableMerge = {
  /** The table: its position among the tab's tables, counting from 0. */
  table: number;

  /** The block's top-left cell: its row and column, counting from 0. */
  row: number;
  column: number;

  /** How many rows and columns the block spans; it holds at least two cells. */
  rows: number;
  columns: number;
};

/** A merged cell to split, for `unmergeTableCells()`: its top-left cell. */
export type DocTableCell = {
  /** The table: its position among the tab's tables, counting from 0. */
  table: number;

  /** The row and column of the merged cell's top-left cell, counting from 0. */
  row: number;
  column: number;
};

/**
 * Read/write access to one native Google Doc: one bound directly, or one a Google Drive binding
 * with read and write access opened.
 *
 * Metadata covers the whole document; reads and edits each target exactly one tab, so call
 * `listTabs()` first and pass the ID of the tab to act on.
 *
 * Every edit is queued for the user's approval and shows in reads as if made. Opened from a Drive
 * binding, the Doc is checked to be still in the binding's reach, and editable by its account, both
 * when an edit is queued and when it is approved, and one edit, with what its approval card shows,
 * must fit in 100 KiB, about 50,000 characters: split a larger one into several calls. A Doc
 * opened from a Drive binding has no comment method, since the binding's own comment writes reach
 * it, and does not add tabs.
 */
export interface GoogleDocEditSession extends GoogleDocReadSession {

  /**
   * Find `oldMarkdown` in tab `tabId` and replace it with `newMarkdown`.
   * Both parameters are Markdown text.
   *
   * Matching and editing are local to that one tab: pass an ID returned by `listTabs()`, and omit
   * `tabId` only when `listTabs()` returns exactly one tab.
   *
   * The match must be unique -- if `oldMarkdown` appears zero times or more than once in the
   * selected tab, an error is thrown. If the match is ambiguous, include more surrounding context
   * in `oldMarkdown` to disambiguate.
   *
   * The gatekeeper automatically trims unchanged leading and trailing text before sending the
   * edit to Google Docs, so it's fine (and encouraged) to include extra context in `oldMarkdown`
   * and `newMarkdown` for matching purposes.
   *
   * The Markdown is mapped back to Google Docs operations using the tab's source map. The
   * following Markdown features are supported in `newMarkdown`:
   * - Headings (`# ` through `###### `)
   * - Bold (`**text**`)
   * - Italic (`*text*`)
   * - Bold+italic (`***text***`)
   * - Links (`[text](url)`)
   * - Strikethrough (`~~text~~`)
   * - Bullet lists (`- item`)
   * - Numbered lists (`1. item`)
   * - Plain paragraphs (separated by blank lines)
   * - Line breaks within a paragraph (`\u000b`, as `getContent()` returns them)
   *
   * A list item is nested by indenting its line two spaces for each level, as `getContent()`
   * writes it, and each new item is written at the nesting level it is given. A list has nine
   * levels: an item indented eighteen or more spaces is refused, so write it at most sixteen spaces
   * in. A new item shallower than the list item before it is refused where placing it would rewrite
   * an item that holds a positioned image. Write it at the level of the item before it, or move
   * the image in Google Docs first. To remove a list item, replace its line, marker included,
   * with nothing: the item goes with its line, with or without the line break after it in
   * `oldMarkdown`. A nested item's line starts with its indentation: leave it out of
   * `oldMarkdown` only together with the line break, since quoted from its marker with the line
   * break the item leaves its indentation in front of the next line, which nests an item there
   * deeper. An item that is the only one of its list leaves an empty paragraph: to remove
   * that too, replace the item together with the blank line after it, or, where the item is the
   * last paragraph of the tab, together with the two line breaks before it. An empty paragraph
   * also stays where the line break cannot go with the item: the item ends the tab or stands
   * before a table, behind an item of another level or list, or a line beside it holds an
   * image, a smart chip or a footnote. Quoted with its line break, that removal is refused or
   * leaves the paragraph too. A list item's text may start with a tab character. A new item
   * shallower than the list item before it is refused
   * where an item it has to pass (that item, or one between it and an item as shallow) starts
   * with a tab and stands before the first line the replacement changes or, for `appendText()`,
   * anywhere before the appended text: remove the tab from that item first, or write the new
   * item at its level. A paragraph break written inside a paragraph, a heading or a list item
   * splits it, and the text after the break becomes a normal paragraph unless it is written with
   * a heading or list marker. Inside a subtitle, text written with a paragraph break after it
   * can be refused where the break is not at the subtitle's end: write the break at the
   * subtitle's end, or replace the whole subtitle.
   *
   * Unsupported Markdown features (tables, images, code blocks, etc.) are inserted as plain text.
   * Existing structural content and paragraphs containing elements such as smart chips are
   * read-only. Narrow the match to plain text in another paragraph.
   *
   * A subsequent `getContent(tabId)` call reflects this replacement.
   */
  replaceText(oldMarkdown: string, newMarkdown: string, tabId?: string): Promise<void>;

  /**
   * Append Markdown content to the end of tab `tabId`. The same Markdown features and tab
   * selection rules as `replaceText()` apply. The tab must end in a paragraph; add one after a
   * final table or other structural element before appending. The append is checked when it is
   * called, against the tab with every queued change applied: where it cannot be made there
   * (the tab would not then end in a paragraph, or its result cannot be shown before approval),
   * the call is refused and nothing is queued.
   */
  appendText(markdown: string, tabId?: string): Promise<void>;
}

/**
 * Read/write access to one directly bound native Google Doc, and to its comments.
 *
 * Metadata covers the whole document; reads and edits each target exactly one tab, so call
 * `listTabs()` first and pass the ID of the tab to act on.
 *
 * When to use which:
 * - `replaceText()` and `appendText()` change the Doc's text once the user approves them.
 * - `addTab()` adds a new, empty tab, which the edits above can fill at once.
 * - `suggestEdit()` leaves a suggestion in the Doc, as one made in Suggesting mode, which someone
 *   who can edit the Doc accepts or rejects there; the text does not change until then.
 * - `comment()` is a remark on a passage of the Doc, attached to the text it quotes.
 * - `reply()` and `resolve()` answer the comments `listComments()` returns.
 * - A comment attached to no text, or an answer to one, takes a Google Drive connection to the
 *   file with read and write access: request the resource URL
 *   `https://drive.google.com/file/d/<id>/view?access=write`, where `<id>` is `getMetadata().id`.
 *
 * Every comment write is queued for the user's approval. A comment, reply or resolve returns the
 * pending item, which `listComments()` shows until it is decided; `suggestEdit()` returns a
 * `DocSuggestion`, which no listing shows, queued or made. A write needs the connected account to
 * be able to comment on the Doc, and a new comment makes Google email the Doc's owner. An email
 * address written after `@` or `+` in the text mentions that person: Google emails them the text,
 * whether or not they can open the Doc. A comment, reply or note holds at most 2048 bytes of UTF-8.
 * A Doc not created yet has no comments, and takes no comment writes until it is.
 */
export interface GoogleDocSession extends GoogleDocEditSession {
  /**
   * Add a new, empty tab titled `title` (one line, at most 50 characters): nested under the tab
   * `parentTabId` names, or top-level without one, and placed at `index` among the tabs beside it,
   * counting from 0, or last without one. Google nests tabs at most three levels deep. Resolves to
   * the new tab's ID: `listTabs()` lists the tab at once, and `getContent()`, `replaceText()`,
   * `appendText()` and `addTab()` take its ID at once.
   */
  addTab(title: string, options?: { parentTabId?: string; index?: number }): Promise<string>;

  /**
   * Every comment on the Doc, attached to text or not, with its replies, and this binding's
   * comments, replies and resolves still waiting for approval (`pending`). A suggestion is not a
   * comment, and is not listed. Fails for an account that can only view the Doc: Google shows a
   * Doc's comments only to accounts that can comment on it.
   */
  listComments(): Promise<DriveComment[]>;

  /** Queue a plain-text comment attached to the text `options.quote`. */
  comment(text: string, options: DocCommentOptions): Promise<DriveComment>;

  /**
   * Queue a suggestion that `oldText`, which must occur exactly once in the tab (matched and
   * limited as `quote` is), be replaced with `newText`: empty to delete it, otherwise at most 1000
   * characters without line breaks. At approval `oldText` must still occur exactly once in the tab.
   */
  suggestEdit(
    oldText: string, newText: string, options?: DocSuggestEditOptions,
  ): Promise<DocSuggestion>;

  /**
   * Queue a reply to comment `commentId`, an ID `listComments()` returned. Replying to a resolved
   * comment reopens it. Fails for a comment attached to no text, saying which Drive connection can
   * answer it; for one that is itself still `pending`, which takes replies once it is posted; and
   * for one with a resolve awaiting approval, which the reply would reopen (to close a comment with
   * words, resolve it with them). At approval the reply fails if the comment was edited after the
   * reply was queued.
   */
  reply(commentId: string, text: string): Promise<DriveCommentReply>;

  /**
   * Queue resolving comment `commentId`, with an optional closing reply. Fails for a comment that
   * is already resolved, that already has a resolve awaiting approval, that is itself still
   * `pending`, or that is attached to no text. At approval the resolve fails if the comment was
   * edited after the resolve was queued.
   */
  resolve(commentId: string, text?: string): Promise<DriveCommentReply>;
}
