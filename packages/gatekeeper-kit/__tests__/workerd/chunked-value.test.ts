import { env } from "cloudflare:test";
import { expect, it } from "vitest";

// What only real storage shows: a transaction that rolls back, and how bytes are stored. This
// runtime accepts a single value larger than a deployed Durable Object may hold, so a round trip
// alone does not show chunking; the size of what sits under each key does.
const MIB = 1024 * 1024;

const chunk = (name: string, index: number, bytes: number) =>
  ({ key: `values:${name}:chunk:000${index}`, bytes, buffer: bytes });
const manifest = (name: string) => ({ key: `values:${name}:manifest`, bytes: 0, buffer: 0 });
// The failure of a call, as text. `then` alone is read from the call's promise: any other
// property of it is a pipelined call, which would fail unhandled alongside this one.
const failure = (call: PromiseLike<void>) => call.then(() => undefined, (error: unknown) => String(error));

it("round trips a value larger than one KV value in chunks no larger than 1 MiB", async () => {
  const host = env.CHUNKED_VALUE_HOST.getByName("round-trips");

  await host.put("copy", 2_500_000, 3);

  expect(await host.matches("copy", 2_500_000, 3)).toBe(true);
  // A chunk put as a view of the whole value would report these `bytes` over a `buffer` of
  // 2,500,000 under every key.
  expect(await host.stored("copy")).toEqual([
    chunk("copy", 0, MIB),
    chunk("copy", 1, MIB),
    chunk("copy", 2, 2_500_000 - 2 * MIB),
    manifest("copy"),
  ]);
});

it("leaves no stale chunk when a smaller value replaces a larger one", async () => {
  const host = env.CHUNKED_VALUE_HOST.getByName("replaces");
  await host.put("copy", 2_500_000, 3);

  await host.put("copy", 10, 5);

  expect(await host.stored("copy")).toEqual([chunk("copy", 0, 10), manifest("copy")]);
  expect(await host.matches("copy", 10, 5)).toBe(true);
});

// The meta is refused at the manifest, the last write, so the chunks of the later value were
// already over the earlier one's.
it("leaves the earlier value whole when a put fails after its chunks were written", async () => {
  const host = env.CHUNKED_VALUE_HOST.getByName("fails-midway");
  await host.put("copy", MIB + 100, 3);
  const earlier = await host.stored("copy");

  expect(await failure(host.put("copy", 2_500_000, 5, false))).toContain("could not be cloned");

  expect(await host.matches("copy", MIB + 100, 3)).toBe(true);
  expect(await host.stored("copy")).toEqual(earlier);
  expect(earlier).toEqual([chunk("copy", 0, MIB), chunk("copy", 1, 100), manifest("copy")]);
});

// Storage keeps one `kv.list` iterator alive, so a read that scanned would end the caller's scan
// with a throw at its next step.
it("reads inside a scan the caller holds open without ending it", async () => {
  const host = env.CHUNKED_VALUE_HOST.getByName("reads-in-scan");
  await host.put("copy", MIB + 100, 3);

  expect(await host.readDuringScan("copy")).toEqual([
    "values:copy:chunk:0000",
    "values:copy:chunk:0001",
    "values:copy:manifest",
  ]);
});

it("rolls back with a transaction around it", async () => {
  const host = env.CHUNKED_VALUE_HOST.getByName("outer-transaction");
  await host.put("copy", MIB + 100, 3);

  expect(await failure(host.putThenFail("copy", 2_500_000, 5)))
    .toContain("The transaction around the put failed.");

  expect(await host.matches("copy", MIB + 100, 3)).toBe(true);
  expect(await host.stored("copy")).toHaveLength(3);
});
