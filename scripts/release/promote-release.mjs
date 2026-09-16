#!/usr/bin/env node

// Promotes an e2e-verified candidate release: copies candidates/<id>/manifest.json to
// releases/<id>/manifest.json. The blobs are already in place — content-addressed and uploaded
// by upload-release.mjs before its manifest PUT — so publishing is this single manifest copy.
// The copy is all-or-nothing (manifest-last protocol: the deploy service scans only releases/),
// but NOT isolated: the newer-release guard below is check-then-act, so concurrent promotions
// could still interleave between its LIST and the copy. The caller must serialize runs of this
// script — gadgets-internal's CI runs it in a resource group — and the guard then catches the
// remaining hazard, a promote that starts after a newer release has already published.
//
// Exit-0 guards (benign races must not fail the pipeline):
//   - already promoted: releases/<id>/manifest.json exists (idempotent re-runs)
//   - superseded: a CI-format id (r<run#>-<sha>) with a HIGHER run number already exists under
//     releases/. "Latest" is decided by manifest upload time (deploy's release.ts), so promoting
//     an older candidate after a newer one shipped would ROLL PRODUCTION BACK — the stale PUT
//     would carry the newest timestamp.
//
// A missing candidate manifest is a hard error: the caller asked to promote something that was
// never uploaded (or was cleaned up), and silently succeeding would report a phantom publish.
//
// Env: R2_ENDPOINT (https://<account>.r2.cloudflarestorage.com), R2_BUCKET,
//      R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
// Usage: node scripts/release/promote-release.mjs --release-id <id>

import { pathToFileURL } from "node:url";

/** The CI run number of an `r<run#>-<sha>` release id, or null for any other id shape
 *  (dev-<ts> releases carry no ordering claim). */
export function ciRunNumber(releaseId) {
  const match = /^r(\d+)-/.exec(releaseId);
  return match ? Number(match[1]) : null;
}

/** The already-published CI release id that supersedes this candidate, or null. Non-CI ids
 *  (either side) never participate: only run numbers are comparable. */
export function supersededBy(candidateId, publishedIds) {
  const candidateRun = ciRunNumber(candidateId);
  if (candidateRun === null) return null;
  for (const id of publishedIds) {
    const run = ciRunNumber(id);
    if (run !== null && run > candidateRun) return id;
  }
  return null;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable: ${name}`);
  return value;
}

// Canonical workspace SigV4 R2 client (aws4fetch retired). Relative import of
// the sibling stt-engine checkout, loaded lazily so this module stays
// importable where that checkout is absent — release-promote.test.js pulls
// ciRunNumber/supersededBy from here with no R2 access in this repo's CI.
async function loadR2() {
  try {
    return await import("../../../stt-engine/src/r2.js");
  } catch (err) {
    throw new Error(
      "cannot load ../../../stt-engine/src/r2.js — these release scripts expect " +
      `a sibling stt-engine checkout next to this repo: ${err.message}`,
      { cause: err });
  }
}

function parseArgs(argv) {
  const args = { releaseId: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--release-id") args.releaseId = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!args.releaseId) throw new Error("--release-id <id> is required");
  return args;
}

// Key names only (paginated ListObjectsV2); manifest bodies are never fetched.
async function listPublishedReleaseIds(r2) {
  const ids = [];
  for (const obj of await r2.listObjects("releases/")) {
    const match = /^releases\/([^/]+)\/manifest\.json$/.exec(obj.key);
    if (match) ids.push(match[1]);
  }
  return ids;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const endpoint = requireEnv("R2_ENDPOINT").replace(/\/$/, "");
  const bucket = requireEnv("R2_BUCKET");
  const { R2Client, R2Error } = await loadR2();
  const r2 = new R2Client({
    endpoint,
    bucket,
    accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
  });

  const publishedKey = `releases/${args.releaseId}/manifest.json`;
  const candidateKey = `candidates/${args.releaseId}/manifest.json`;

  // headObject: falsy on 404, throws R2Error on any other failure.
  if (await r2.headObject(publishedKey)) {
    console.log(`already promoted: ${publishedKey}`);
    return;
  }

  let manifestBody;
  try {
    manifestBody = await r2.getObject(candidateKey);
  } catch (err) {
    if (err instanceof R2Error && err.status === 404) {
      throw new Error(`candidate not found: ${candidateKey} — was the release uploaded ` +
        "with --candidate?", { cause: err });
    }
    throw err;
  }

  const superseder = supersededBy(args.releaseId, await listPublishedReleaseIds(r2));
  if (superseder) {
    console.warn(`WARNING: not promoting ${args.releaseId} — a newer release ` +
      `(${superseder}) is already published; promoting now would roll the deploy ` +
      "service back to this older candidate.");
    return;
  }

  // Server-side CopyObject first (no second body transfer); the buffered GET above doubles as
  // the fallback PUT body if the copy path is ever unavailable. Only an R2Error falls back —
  // a network-level failure propagates, exactly as a failed fetch did before.
  try {
    await r2.copyObject(publishedKey, candidateKey);
    console.log(`promoted (copy): ${candidateKey} -> ${publishedKey}`);
    return;
  } catch (err) {
    if (!(err instanceof R2Error)) throw err;
    console.warn(`CopyObject unavailable (${err.message}); falling back to PUT`);
  }
  await r2.putObject(publishedKey, manifestBody, "application/json");
  console.log(`promoted (put): ${candidateKey} -> ${publishedKey}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
