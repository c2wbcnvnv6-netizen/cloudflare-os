// The Google gatekeeper's subservice metrics: which service a request went to, and whether a call
// is written at once or summed into the tally of the work that made it.

import { AsyncLocalStorage } from "node:async_hooks";
import {
  recordSubserviceCall, type SubserviceCallInput, type SubserviceTally,
} from "@gadgets/observability/metrics";

/** The `source` of every Google API point. */
export const GOOGLE_API_SOURCE = "gatekeeper.google.api";

// The service behind each API host the clients here call.
const SERVICE_BY_HOST = new Map([
  ["gmail.googleapis.com", "google-gmail"],
  ["docs.googleapis.com", "google-docs"],
  ["sheets.googleapis.com", "google-sheets"],
  ["slides.googleapis.com", "google-slides"],
  ["chat.googleapis.com", "google-chat"],
  ["people.googleapis.com", "google-people"],
  ["bigquery.googleapis.com", "google-bigquery"],
  ["workspaceevents.googleapis.com", "google-events"],
  ["oauth2.googleapis.com", "google-oauth"],
]);

// www.googleapis.com serves several APIs, each under its own first path segment.
const SERVICE_BY_WWW_PATH = new Map([
  ["drive", "google-drive"],
  ["calendar", "google-calendar"],
  ["oauth2", "google-oauth"],
]);

/**
 * The service a Google API URL belongs to, from a closed table of hosts (and, for
 * www.googleapis.com, of first path segments); `google-other` for any other.
 */
export function googleService(url: string): string {
  let parsed = URL.parse(url);
  if (!parsed) return "google-other";
  if (parsed.hostname !== "www.googleapis.com") {
    return SERVICE_BY_HOST.get(parsed.hostname) ?? "google-other";
  }
  // An API's upload and batch endpoints sit one segment down, as in `/batch/drive/v3`.
  let [, first, second] = parsed.pathname.split("/");
  let api = first === "upload" || first === "batch" ? second : first;
  return SERVICE_BY_WWW_PATH.get(api) ?? "google-other";
}

/**
 * The name of every kind of request made to Google, each a literal at the call that makes it:
 * `<resource>.<method>` after Google's own method names, and in their manner where Google has
 * none. Gmail, Chat and People report a request's failure under the same name; Docs, Sheets and
 * Slides report one in words of their own, and a poll of a Workspace Events write
 * (`operations.get`) fails under the write's name. A name can serve two services, which the
 * service column tells apart, as `messages.get` is Gmail's and Chat's.
 */
export const GOOGLE_OPERATIONS = [
  // Gmail
  "threads.list", "threads.get", "threads.modify", "threads.trash", "threads.untrash",
  "messages.list", "messages.get", "messages.batchModify", "messages.send", "attachments.get",
  "drafts.list", "drafts.get", "drafts.create", "drafts.update", "drafts.delete", "drafts.send",
  "labels.list", "labels.get", "labels.create", "labels.update", "labels.delete",
  "users.getProfile", "users.watch", "history.list",
  // Drive: `files.get.media` is a download of a file's content, and `files.get.batch` one batch
  // of `files.get` requests.
  "files.list", "files.get", "files.get.media", "files.get.batch", "files.generateIds",
  "files.create", "files.update", "files.copy", "drives.list", "about.get",
  "permissions.list", "permissions.create", "permissions.update", "permissions.delete",
  "comments.list", "comments.get", "comments.create", "replies.list", "replies.create",
  // Calendar
  "calendarList.list", "calendarList.get", "events.list", "events.get", "events.insert",
  "events.patch", "events.delete", "freebusy.query",
  // BigQuery
  "projects.list", "datasets.list", "datasets.get", "tables.list", "tables.get",
  "jobs.query", "jobs.insert", "jobs.getQueryResults", "jobs.cancel",
  // Docs, Sheets and Slides: `thumbnail.download` is the download of a rendered page's image.
  "documents.create", "documents.get", "documents.batchUpdate",
  "spreadsheets.create", "spreadsheets.get", "spreadsheets.getByDataFilter",
  "spreadsheets.batchUpdate", "values.batchGet", "values.batchGetByDataFilter",
  "developerMetadata.get",
  "presentations.create", "presentations.get", "presentations.batchUpdate", "pages.get",
  "pages.getThumbnail", "thumbnail.download",
  // Chat, with People and Workspace Events. `messages.list` and `messages.get` are above.
  "spaces.list", "spaces.search", "spaces.get", "spaces.findDirectMessage",
  "spaces.findGroupChats", "spaces.setup", "messages.search", "messages.create",
  "messages.patch", "messages.delete", "members.list", "members.get",
  "reactions.list", "reactions.create", "reactions.delete", "media.download",
  "people.searchDirectoryPeople", "people.batchGet",
  "subscriptions.create", "subscriptions.list", "subscriptions.get", "subscriptions.reactivate",
  "subscriptions.patch", "subscriptions.delete", "operations.get",
  // OAuth
  "token.exchange", "token.refresh", "token.revoke", "userinfo.get",
] as const;

/** What a request to Google does: one of `GOOGLE_OPERATIONS`. */
export type GoogleOperation = (typeof GOOGLE_OPERATIONS)[number];

// The tally of the work now running, when `summedInto` started it.
const runningTally = new AsyncLocalStorage<SubserviceTally>();

/**
 * Records one call: summed into the tally `summedInto` is running under, written at once
 * otherwise.
 */
export function recordCall(input: SubserviceCallInput): void {
  let tally = runningTally.getStore();
  if (tally) tally.add(input);
  else recordSubserviceCall(input);
}

/**
 * Runs `work` with every `recordCall` made in it, however deep and across awaits, summed into
 * `tally` rather than written. Work it leaves running after it settles sums there still: what
 * that work records after the tally's last flush is never written. A stream that `work` returns
 * is read outside it: what reading it records is summed only where each read is made in
 * `summedInto` as well.
 */
export function summedInto<T>(tally: SubserviceTally, work: () => T): T {
  return runningTally.run(tally, work);
}

/**
 * `fetch` for a request to Google that is made outside `fetchWithAuthRetry`, counted as that
 * counts an attempt: by the status it was answered with, as `timeout` or `network` when it threw,
 * and not at all when its caller gave it up or it was never sent.
 */
export async function countedFetch(
  operation: GoogleOperation, url: string | URL, init: RequestInit = {},
): Promise<Response> {
  // A request begun once its caller's signal has aborted is never sent.
  let unsent = init.signal?.aborted === true;
  let startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    // A signal that timed the wait out is the service not answering; any other abort is the
    // caller giving the request up. Only the reason's name is read.
    let waitedOut = init.signal?.reason?.name === "TimeoutError";
    if (!unsent && (!init.signal?.aborted || waitedOut)) {
      recordRequest(url, operation, startedAt, waitedOut ? "timeout" : "network");
    }
    throw error;
  }
  recordRequest(url, operation, startedAt, response.status);
  return response;
}

/**
 * Counts one request to Google: `answer` is the status it was answered with, or why it threw.
 * Never throws, since a metric cannot fail the request it counts.
 */
export function recordRequest(
  url: string | URL, operation: GoogleOperation, startedAt: number,
  answer: number | "timeout" | "network",
): void {
  try {
    let call = {
      source: GOOGLE_API_SOURCE, service: googleService(url.toString()), operation,
      durationMs: Date.now() - startedAt,
    };
    if (typeof answer !== "number") {
      recordCall({ ...call, outcome: "error", reason: answer });
    } else if (answer < 400) {
      recordCall({ ...call, outcome: "success", httpStatus: answer });
    } else if (answer === 429) {
      recordCall({ ...call, outcome: "refused", reason: "rate", httpStatus: answer });
    } else {
      recordCall({ ...call, outcome: "error", reason: "http", httpStatus: answer });
    }
  } catch {
    // The request goes uncounted.
  }
}
