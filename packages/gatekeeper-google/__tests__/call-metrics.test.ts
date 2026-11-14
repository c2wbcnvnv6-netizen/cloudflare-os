import { env } from "cloudflare:workers";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMMON_SLOTS, encodeSubserviceCallPoint, SUBSERVICE_V1_SLOTS, subserviceTally,
  type BlobSlot, type DoubleSlot, type SubserviceCallInput, type SubserviceTally,
} from "@gadgets/observability/metrics";
import ts from "typescript6";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  countedFetch, GOOGLE_API_SOURCE, GOOGLE_OPERATIONS, googleService, recordCall, summedInto,
} from "../src/call-metrics";
import {
  exchangeAuthCode, getAccessToken, getGoogleVerifiedEmail, revokeGoogleToken,
} from "../src/google-api";
import { GoogleSlidesApi } from "../src/slides-api";

const SOURCE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../src");
const README = readFileSync(join(SOURCE_DIR, "../README.md"), "utf8");

// The client file that makes each service's requests.
const CLIENT_OF: Record<string, string> = {
  "google-gmail": "google-api.ts", "google-oauth": "google-api.ts",
  "google-drive": "drive-api.ts", "google-calendar": "calendar-api.ts",
  "google-bigquery": "bigquery-api.ts", "google-docs": "docs-api.ts",
  "google-sheets": "sheets-api.ts", "google-events": "chat-hooks.ts",
  "google-slides": "slides-api.ts", "google-other": "slides-api.ts",
  "google-chat": "chat-api.ts", "google-people": "chat-api.ts",
};

// The names of the list that a source file passes with a request, read from its syntax so that a
// name in a comment or a type is not one: each string that is an argument of a call or an
// `operation` option, less where it is only what a failure is reported under.
function namesPassed(file: string): string[] {
  let names = new Set<string>();
  let visit = (node: ts.Node): void => {
    let { parent } = node;
    if (!ts.isStringLiteral(node)) {
      node.forEachChild(visit);
    } else if (ts.isCallExpression(parent)) {
      if (!parent.expression.getText().endsWith("ApiFailure")) names.add(node.text);
    } else if (ts.isPropertyAssignment(parent) && parent.name.getText() === "operation") {
      if (!parent.parent.properties.some(other => other.name?.getText() === "provider")) {
        names.add(node.text);
      }
    }
  };
  visit(ts.createSourceFile(
    file, readFileSync(join(SOURCE_DIR, file), "utf8"), ts.ScriptTarget.ESNext, true));
  return GOOGLE_OPERATIONS.filter(operation => names.has(operation));
}

// The README's operation table: each row's service and the names beside it.
function operationRows(): [string, string[]][] {
  let lines = README.split("\n");
  let rows = lines.slice(lines.indexOf("| Service | Operations |") + 2);
  return rows.slice(0, rows.findIndex(row => !row.startsWith("|"))).map(row => {
    let [service, ...names] = (row.match(/`[^`]+`/g) ?? []).map(word => word.slice(1, -1));
    return [service, names];
  });
}

const CALL: SubserviceCallInput = {
  source: GOOGLE_API_SOURCE, service: "google-drive", operation: "GET", outcome: "success",
  httpStatus: 200,
};

// Makes a call after an await, as a client deep in the work does.
async function later(operation: string): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 1));
  recordCall({ ...CALL, operation });
}

describe("googleService", () => {
  // The base URL each client builds its requests on, as the file that holds it writes it.
  it.each([
    ["google-api.ts", "https://gmail.googleapis.com/gmail/v1/users/me/", "google-gmail"],
    ["google-api.ts", "https://www.googleapis.com/oauth2/v3/userinfo", "google-oauth"],
    ["google-api.ts", "https://oauth2.googleapis.com/token", "google-oauth"],
    ["google-api.ts", "https://oauth2.googleapis.com/revoke", "google-oauth"],
    ["drive-api.ts", "https://www.googleapis.com/drive/v3", "google-drive"],
    ["drive-api.ts", "https://www.googleapis.com/batch/drive/v3", "google-drive"],
    ["calendar-api.ts", "https://www.googleapis.com/calendar/v3", "google-calendar"],
    ["docs-api.ts", "https://docs.googleapis.com/v1/documents", "google-docs"],
    ["sheets-api.ts", "https://sheets.googleapis.com/v4/spreadsheets", "google-sheets"],
    ["slides-api.ts", "https://slides.googleapis.com/v1/presentations", "google-slides"],
    ["chat-api.ts", "https://chat.googleapis.com/v1", "google-chat"],
    ["chat-api.ts", "https://people.googleapis.com/v1", "google-people"],
    ["bigquery-api.ts", "https://bigquery.googleapis.com/bigquery/v2", "google-bigquery"],
    ["chat-hooks.ts", "https://workspaceevents.googleapis.com/v1", "google-events"],
  ])("%s: %s is %s", (file, base, service) => {
    expect(readFileSync(join(SOURCE_DIR, file), "utf8")).toContain(base);
    expect(googleService(base)).toBe(service);
    expect(googleService(`${base}/1aBcD:batchUpdate?fields=id&q=name`)).toBe(service);
  });

  it("names Drive's upload endpoint, one segment down like its batch endpoint", () => {
    expect(googleService("https://www.googleapis.com/upload/drive/v3/files?uploadType=media"))
        .toBe("google-drive");
  });

  it.each([
    "https://lh3.googleusercontent.com/a/thumbnail",
    "https://www.googleapis.com/storage/v1/b",
    "https://www.googleapis.com/batch",
    "https://www.googleapis.com/",
    "https://www.googleapis.com/constructor/v1",
    "https://gmail.googleapis.com.example.com/gmail/v1/users/me/profile",
    "https://example.com/drive/v3/files",
    "/drive/v3/files",
    "",
  ])("%j is google-other", url => {
    expect(googleService(url)).toBe("google-other");
  });
});

describe("recordCall", () => {
  let ambient = env as { METRICS?: AnalyticsEngineDataset; SUBSERVICE_METRICS?: string };
  let points: AnalyticsEngineDataPoint[];
  beforeEach(() => {
    points = [];
    ambient.METRICS = { writeDataPoint: point => { points.push(point!); } };
    ambient.SUBSERVICE_METRICS = "true";
  });
  afterEach(() => {
    delete ambient.METRICS;
    delete ambient.SUBSERVICE_METRICS;
  });

  // The `calls` column of each point written, beside its operation.
  function written(): [unknown, unknown][] {
    return points.map(point => [point.blobs![9], point.doubles![4]]);
  }

  it("writes a call at once outside `summedInto`", () => {
    recordCall(CALL);
    expect(written()).toEqual([["GET", 1]]);
  });

  it("sums the calls made in `summedInto`, across an await and in a nested call", async () => {
    let tally = subserviceTally();
    let answer = await summedInto(tally, async () => {
      recordCall(CALL);
      await later("GET");
      await Promise.all([later("GET"), later("POST")]);
      return "answer";
    });
    expect(answer).toBe("answer");
    expect(written()).toEqual([]);

    tally.flush();
    expect(written()).toEqual([["GET", 3], ["POST", 1]]);
  });

  it("keeps apart the calls of two tallies at once, and of work under neither", async () => {
    let first = subserviceTally();
    let second = subserviceTally();
    await Promise.all([
      summedInto(first, () => later("GET")),
      summedInto(second, async () => { await later("POST"); await later("POST"); }),
      later("DELETE"),
    ]);
    expect(written()).toEqual([["DELETE", 1]]);

    first.flush();
    second.flush();
    expect(written()).toEqual([["DELETE", 1], ["GET", 1], ["POST", 2]]);
  });
});

describe("GOOGLE_OPERATIONS", () => {
  it("holds each name once, as a word the metrics write as given", () => {
    expect(new Set(GOOGLE_OPERATIONS).size).toBe(GOOGLE_OPERATIONS.length);
    for (let operation of GOOGLE_OPERATIONS) {
      expect(encodeSubserviceCallPoint({ ...CALL, operation }).blobs![9]).toBe(operation);
    }
  });

  it("has a call that makes a request under each name", () => {
    let passed = new Set(readdirSync(SOURCE_DIR)
      .filter(file => file.endsWith(".ts") && file !== "call-metrics.ts")
      .flatMap(namesPassed));
    expect(GOOGLE_OPERATIONS.filter(operation => !passed.has(operation))).toEqual([]);
  });

  it("is what the README's operation table lists, no more and no less", () => {
    let listed = operationRows().flatMap(([, names]) => names);
    expect(listed.length).toBeGreaterThan(0);
    expect([...new Set(listed)].toSorted()).toEqual(GOOGLE_OPERATIONS.toSorted());
  });

  it("is listed in the README beside the service whose client makes the request", () => {
    let rows = operationRows();
    expect(rows.map(([service]) => service).toSorted()).toEqual(Object.keys(CLIENT_OF).toSorted());
    // Two services can share a client: their rows together hold what it passes.
    for (let file of new Set(Object.values(CLIENT_OF))) {
      let listed = rows.filter(([service]) => CLIENT_OF[service] === file)
        .flatMap(([, names]) => names);
      expect(listed.toSorted(), file).toEqual(namesPassed(file).toSorted());
    }
  });

  it("is not asked of the one request a library makes, which the README says is not counted", () => {
    // `jose` downloads Google's signing keys itself, outside `fetchWithAuthRetry` and
    // `countedFetch`. Once it is given a counted `fetch`, the README's sentence goes.
    expect(readFileSync(join(SOURCE_DIR, "pubsub-push.ts"), "utf8"))
        .toContain('createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"))');
    let uncounted = README.split("\n")
      .find(line => line.startsWith("Some calls are not counted."));
    expect(uncounted).toContain(
      "Nor is the download of Google's signing keys (`www.googleapis.com/oauth2/v3/certs`)");
  });
});

describe("countedFetch", () => {
  const TOKEN_URL = "https://oauth2.googleapis.com/token";
  let ambient = env as { METRICS?: AnalyticsEngineDataset; SUBSERVICE_METRICS?: string };
  let points: AnalyticsEngineDataPoint[];
  beforeEach(() => {
    points = [];
    ambient.METRICS = { writeDataPoint: point => { points.push(point!); } };
    ambient.SUBSERVICE_METRICS = "true";
  });
  afterEach(() => {
    delete ambient.METRICS;
    delete ambient.SUBSERVICE_METRICS;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // A written point's value in one column.
  function column(point: AnalyticsEngineDataPoint, slot: BlobSlot | DoubleSlot) {
    let values = slot.startsWith("blob") ? point.blobs! : point.doubles!;
    return values[Number(slot.replace(/\D+/, "")) - 1];
  }

  // Each point written, as its source, service, operation, outcome, reason and HTTP status.
  function calls() {
    return points.map(point => [
      SUBSERVICE_V1_SLOTS.source, SUBSERVICE_V1_SLOTS.service, SUBSERVICE_V1_SLOTS.operation,
      COMMON_SLOTS.outcome, SUBSERVICE_V1_SLOTS.reason, SUBSERVICE_V1_SLOTS.httpStatus,
    ].map(slot => column(point, slot)));
  }

  // A fetch that is never answered, and fails with its signal's reason once that aborts.
  function unanswered() {
    vi.stubGlobal("fetch", (_url: string, init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal!.throwIfAborted();
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
      }));
  }

  it("makes the request as given and counts it by its answer, with how long it took", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let statuses = [200, 302, 429, 400];
    let fetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => {
      now += 250;
      return new Response("answer", { status: statuses.shift()! });
    });
    vi.stubGlobal("fetch", fetch);
    let init = { method: "POST", body: "grant" };

    let answer = await countedFetch("token.refresh", TOKEN_URL, init);
    await countedFetch("token.refresh", TOKEN_URL);
    await countedFetch("token.exchange", TOKEN_URL);
    await countedFetch("thumbnail.download", new URL("https://lh3.googleusercontent.com/thumb"));

    expect([answer.status, await answer.text()]).toEqual([200, "answer"]);
    expect(fetch.mock.calls[0]).toEqual([TOKEN_URL, init]);
    expect(calls()).toEqual([
      [GOOGLE_API_SOURCE, "google-oauth", "token.refresh", "success", "", 200],
      [GOOGLE_API_SOURCE, "google-oauth", "token.refresh", "success", "", 302],
      [GOOGLE_API_SOURCE, "google-oauth", "token.exchange", "refused", "rate", 429],
      [GOOGLE_API_SOURCE, "google-other", "thumbnail.download", "error", "http", 400],
    ]);
    expect(points.map(point => column(point, COMMON_SLOTS.durationMs))).toEqual([250, 250, 250, 250]);
  });

  it("counts a request that threw, as a timeout when its signal timed the wait out", async () => {
    vi.stubGlobal("fetch", async () => { throw new TypeError("network down"); });
    await expect(countedFetch("token.revoke", TOKEN_URL)).rejects.toThrow("network down");
    unanswered();
    await expect(countedFetch("token.refresh", TOKEN_URL, { signal: AbortSignal.timeout(5) }))
        .rejects.toMatchObject({ name: "TimeoutError" });

    expect(calls()).toEqual([
      [GOOGLE_API_SOURCE, "google-oauth", "token.revoke", "error", "network", 0],
      [GOOGLE_API_SOURCE, "google-oauth", "token.refresh", "error", "timeout", 0],
    ]);
  });

  it("does not count a request its caller gave up, or one that was never sent", async () => {
    unanswered();
    let caller = new AbortController();
    let request = expect(countedFetch("token.refresh", TOKEN_URL, { signal: caller.signal }))
        .rejects.toThrow("stop");
    caller.abort(new Error("stop"));
    await request;
    let waitedOut = AbortSignal.abort(new DOMException("too slow", "TimeoutError"));
    await expect(countedFetch("token.refresh", TOKEN_URL, { signal: waitedOut }))
        .rejects.toThrow("too slow");

    expect(calls()).toEqual([]);
  });

  it("answers, or fails as it would have, a request that could not be counted", async () => {
    let broken: SubserviceTally = { add() { throw new Error("no room"); }, flush() {} };
    vi.stubGlobal("fetch", async () => new Response("answer"));
    let answer = await summedInto(broken, () => countedFetch("token.refresh", TOKEN_URL));
    expect(await answer.text()).toBe("answer");

    vi.stubGlobal("fetch", async () => { throw new TypeError("network down"); });
    await expect(summedInto(broken, () => countedFetch("token.refresh", TOKEN_URL)))
        .rejects.toThrow("network down");
  });

  it("counts each request made outside the wrapper once, under its own name", async () => {
    vi.stubGlobal("fetch", async (url: string | URL) =>
      Response.json(url.toString().endsWith("/thumbnail?thumbnailProperties.mimeType=PNG" +
        "&thumbnailProperties.thumbnailSize=LARGE")
        ? { contentUrl: "https://lh7-us.googleusercontent.com/slidesz/thumb" } : {}));
    // Only the request is looked at, not what its caller makes of an empty answer.
    let asked = (answer: Promise<unknown>) => answer.catch(() => {});

    await asked(exchangeAuthCode("code", "client", "secret", "https://example.com/callback"));
    await asked(getAccessToken("refresh", "client", "secret"));
    await asked(getGoogleVerifiedEmail("token"));
    await asked(revokeGoogleToken("refresh"));
    await asked(new GoogleSlidesApi(async () => "token").getThumbnail("deck-1", "slide-1", "LARGE"));

    expect(calls().map(([, service, operation]) => [service, operation])).toEqual([
      ["google-oauth", "token.exchange"],
      ["google-oauth", "token.refresh"],
      ["google-oauth", "userinfo.get"],
      ["google-oauth", "token.revoke"],
      ["google-slides", "pages.getThumbnail"],
      ["google-other", "thumbnail.download"],
    ]);
  });
});
