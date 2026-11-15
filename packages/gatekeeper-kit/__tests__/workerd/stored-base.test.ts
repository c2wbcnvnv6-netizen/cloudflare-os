import { env } from "cloudflare:test";
import { expect, it } from "vitest";

// What only real storage shows of a stored base: a keep that puts some partitions and not others
// inside one transaction, and what an activation after an eviction reads.

// Every key of a partition as the host stores it: three chunks and a manifest.
const partition = (key: string): string[] => [
  `copy:doc/${key}:chunk:0000`,
  `copy:doc/${key}:chunk:0001`,
  `copy:doc/${key}:chunk:0002`,
  `copy:doc/${key}:manifest`,
];
const INDEX = "copy:doc:manifest";
// The failure of a call, as text. `then` alone is read from the call's promise: any other
// property of it is a pipelined call, which would fail unhandled alongside this one.
const failure = (call: PromiseLike<unknown>) =>
  call.then(() => undefined, (error: unknown) => String(error));

// The changed partition is put before the index is, and the index is what storage refuses.
it("leaves the earlier copy whole when a put fails part way through a keep", async () => {
  const host = env.STORED_BASE_HOST.getByName("fails-midway");
  await host.read({ a: 3, b: 5 });
  const earlier = await host.keys();

  expect(await failure(host.read({ a: 3, b: 7 }, false))).toContain("could not be cloned");

  await host.evict();
  expect(await host.keys()).toEqual(earlier);
  expect(await host.part("a")).toBe(3);
  expect(await host.part("b")).toBe(5);

  // The copy that follows is stored whole as well.
  expect(await host.read({ a: 3, b: 7 })).toEqual(["a", "b"]);
  await host.evict();
  expect(await host.part("a")).toBe(3);
  expect(await host.part("b")).toBe(7);
});

it("leaves no stranded value when a partition goes or is renamed between fetches", async () => {
  const host = env.STORED_BASE_HOST.getByName("renames");
  await host.read({ a: 3, b: 5 });
  expect(await host.keys()).toEqual([...partition("a"), ...partition("b"), INDEX]);

  expect(await host.read({ a: 3, c: 5 })).toEqual(["a", "c"]);

  expect(await host.keys()).toEqual([...partition("a"), ...partition("c"), INDEX]);
  expect(await host.part("b")).toBeNull();
  expect(await host.part("c")).toBe(5);
});

it("decodes one partition after an eviction", async () => {
  const host = env.STORED_BASE_HOST.getByName("evicted");
  await host.read({ a: 3, b: 5, c: 7 });
  expect(await host.decodes()).toBe(0);

  await host.evict();

  expect(await host.part("b")).toBe(5);
  expect(await host.part("b")).toBe(5);
  expect(await host.decodes()).toBe(1);
});
