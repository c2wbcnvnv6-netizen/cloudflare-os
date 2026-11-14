// Fixture for the suites that need real Durable Object storage rather than the cloning Node fake.

import { DurableObject, RpcTarget, WorkerEntrypoint, type RpcStub } from "cloudflare:workers";
import { ChunkedValues } from "../../src/chunked-value";
import { HookRegistry } from "../../src/hook-registry";
import { ObserverTracker } from "../../src/observers";
export { ConformanceAccount, ConformanceResource, ConformanceVerifier } from "./conformance/gatekeeper";

type VerifierProps = { allowed: readonly string[]; dropVerdicts?: number };

/**
 * A verifier reached the way the overseer's is: a `WorkerEntrypoint` behind a service binding, which
 * is what makes it a *persistent* stub. An ad-hoc `RpcTarget` has no durable address and Durable
 * Object storage refuses it outright, flag or no flag.
 */
export class FixtureVerifier extends WorkerEntrypoint<unknown, VerifierProps> {
  async hasSets(collectionIds: readonly string[]): Promise<boolean[]> {
    const verdicts = collectionIds.map(collectionId => this.ctx.props.allowed.includes(collectionId));
    return verdicts.slice(0, verdicts.length - (this.ctx.props.dropVerdicts ?? 0));
  }
}

type Verifier = { hasSets(collectionIds: readonly string[]): Promise<boolean[]> };

/** Drives a tracker whose storage is a real DO's, so a persisted stub is a persisted stub. */
export class TrackerHost extends DurableObject {
  readonly #tracker = this.#newTracker();

  /** Built the way a gatekeeper that rebuilds one per accessor gets it: fresh from
   *  `this.ctx.storage.kv`, whose durable markers every tracker over it reads. */
  #newTracker(): ObserverTracker<Verifier> {
    return new ObserverTracker<Verifier>({
      kv: this.ctx.storage.kv,
      hasCollectionAccess: (verifier, collectionIds) => verifier.hasSets(collectionIds),
    });
  }

  async admit(id: string, props: VerifierProps): Promise<void> {
    await this.#tracker.addObserver(id, this.ctx.exports.FixtureVerifier({ props }));
  }

  /** Holds a withheld read open and reports what admitting through a *second* tracker did. */
  async admitDuringWithheldRead(id: string, props: VerifierProps): Promise<string> {
    const check = this.#tracker.prepareWithheld();
    try {
      await this.#newTracker().addObserver(id, this.ctx.exports.FixtureVerifier({ props }));
      return "admitted";
    } catch (error) {
      return String(error);
    } finally {
      check.discard?.();
    }
  }

  observerIds(): string[] {
    return this.#tracker.observerIds();
  }

  /** Reveals `collectionIds`, commits, and reports who the read had to be hidden from. */
  async reveal(collectionIds: string[]): Promise<string[]> {
    const check = await this.#tracker.prepareObservation(collectionIds);
    const excluded = [...(check.excludeObservers ?? [])];
    check.commit();
    return excluded;
  }

  /** Proves the stub survived the write: re-read from storage and call it. */
  async askStored(id: string, collectionIds: string[]): Promise<boolean[] | undefined> {
    return await this.ctx.storage.kv.get<Verifier>(`observer:${id}`)?.hasSets(collectionIds);
  }
}

/** The hook a firing calls, which tells its `HookHost` what it received. */
class FixtureHook extends RpcTarget {
  readonly #host: DurableObjectStub<HookHost>;

  constructor(host: DurableObjectStub<HookHost>) {
    super();
    this.#host = host;
  }

  async receive(message: string): Promise<void> {
    await this.#host.received(message);
  }
}

class FixtureApprovalQueue extends RpcTarget {}

/** Starts a firing as the Workshop's `HookInitiator` does, behind a persistent stub. */
export class FixtureHookInitiator extends WorkerEntrypoint<unknown, { host: string }> {
  async startHook() {
    const host = this.ctx.exports.HookHost.getByName(this.ctx.props.host);
    return { callback: new FixtureHook(host), approvalQueue: new FixtureApprovalQueue() };
  }
}

/** A binding's delivery stub, which admits every message. */
export class FixtureHookDelivery extends WorkerEntrypoint {
  async deliver(callback: RpcStub<FixtureHook>, _approvalQueue: unknown, message: string): Promise<void> {
    await callback.receive(message);
  }
}

/** A driver's registry over a real DO's storage, which hands back a fresh stub on every read. */
export class HookHost extends DurableObject {
  readonly #hooks = new HookRegistry<FixtureHook, string, unknown>(this.ctx.storage.kv, () => {});
  readonly #received: string[] = [];

  /** Enables `key` in a transaction, with a registration storage refuses unless `storable`. */
  enable(key: string, storable = true): void {
    this.ctx.storage.transactionSync(() => this.#hooks.set(key, storable ? "registration" : () => {}, {
      delivery: this.ctx.exports.FixtureHookDelivery({}),
      initiator: this.ctx.exports.FixtureHookInitiator({ props: { host: this.ctx.id.name! } }),
    } as never));
  }

  holdsStubs(key: string): boolean {
    return this.ctx.storage.kv.get(`caps:${key}`) !== undefined;
  }

  /** Queues and runs `message`, and reports everything the hook has received. */
  async deliver(key: string, message: string): Promise<string[]> {
    this.#hooks.enqueue(key, message, message, Date.now());
    await this.#hooks.run(Date.now());
    return this.#received;
  }

  received(message: string): void {
    this.#received.push(message);
  }
}

/**
 * Chunked values over a real DO's storage. Large byte arrays stay inside the Durable Object: a
 * test passes a length and a seed, and reads back small results.
 */
export class ChunkedValueHost extends DurableObject {
  readonly #values = new ChunkedValues(this.ctx.storage, { prefix: "values:" });

  /** Puts `length` bytes made from `seed`, with a meta storage refuses unless `storableMeta`. */
  put(name: string, length: number, seed: number, storableMeta = true): void {
    this.#values.put(name, fixtureBytes(length, seed), storableMeta ? { seed } : () => {});
  }

  /** Whether the value reads back as exactly what `put` stored, or `undefined` when it is missing. */
  matches(name: string, length: number, seed: number): boolean | undefined {
    const value = this.#values.get(name);
    if (!value) return undefined;
    const expected = fixtureBytes(length, seed);
    return JSON.stringify(value.meta) === JSON.stringify({ seed }) &&
      value.bytes.byteLength === length &&
      value.bytes.every((byte, index) => byte === expected[index]);
  }

  /** Every key of the value. `buffer` is what a chunk key really holds: `bytes` is only its view. */
  stored(name: string): { key: string; bytes: number; buffer: number }[] {
    return [...this.ctx.storage.kv.list<unknown>({ prefix: `values:${name}:` })].map(([key, value]) =>
      value instanceof Uint8Array
        ? { key, bytes: value.byteLength, buffer: value.buffer.byteLength }
        : { key, bytes: 0, buffer: 0 });
  }

  /** Reads the value at every step of a scan this method holds open; answers the keys it was given. */
  readDuringScan(name: string): string[] {
    const visited: string[] = [];
    for (const [key] of this.ctx.storage.kv.list({ prefix: `values:${name}:` })) {
      this.#values.get(name);
      this.#values.meta(name);
      visited.push(key);
    }
    return visited;
  }

  /** Puts inside a transaction of the caller's that then fails. */
  putThenFail(name: string, length: number, seed: number): void {
    this.ctx.storage.transactionSync(() => {
      this.put(name, length, seed);
      throw new Error("The transaction around the put failed.");
    });
  }
}

function fixtureBytes(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) bytes[index] = (index * 31 + seed) % 251;
  return bytes;
}

export default {
  fetch: () => new Response("fixture", { status: 404 }),
};
