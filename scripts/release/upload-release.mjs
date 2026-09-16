#!/usr/bin/env node

// Mirrors a built release directory (see build-release.mjs) to R2 via the S3 API.
//
// Blobs are content-addressed, so unchanged files dedupe across releases: each key is HEAD'd
// first and skipped if present. The manifest is uploaded LAST — its presence under
// releases/<id>/manifest.json is what marks a release complete, so a crashed upload never
// leaves a manifest pointing at missing blobs.
//
// With --candidate the manifest lands under candidates/<id>/manifest.json instead — invisible
// to the deploy service (which scans only releases/) until promote-release.mjs copies it over
// after the e2e gate passes. Blob handling is identical either way.
//
// Env: R2_ENDPOINT (https://<account>.r2.cloudflarestorage.com), R2_BUCKET,
//      R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
// Usage: node scripts/release/upload-release.mjs --release <dir> [--candidate]

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { assetR2Key, moduleR2Key } from "./manifest-lib.mjs";

const UPLOAD_CONCURRENCY = 8;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable: ${name}`);
  return value;
}

// Canonical workspace SigV4 R2 client (aws4fetch retired). Relative import of
// the sibling stt-engine checkout, not a package dep; loaded lazily so this
// module stays importable where that checkout is absent.
async function r2Client(endpoint, bucket) {
  let R2Client;
  try {
    ({ R2Client } = await import("../../../stt-engine/src/r2.js"));
  } catch (err) {
    throw new Error(
      "cannot load ../../../stt-engine/src/r2.js — these release scripts expect " +
      `a sibling stt-engine checkout next to this repo: ${err.message}`,
      { cause: err });
  }
  return new R2Client({
    endpoint,
    bucket,
    accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
  });
}

function parseArgs(argv) {
  const args = { release: undefined, candidate: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--release") args.release = resolve(argv[++i]);
    else if (argv[i] === "--candidate") args.candidate = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!args.release) throw new Error("--release <dir> is required");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const endpoint = requireEnv("R2_ENDPOINT").replace(/\/$/, "");
  const bucket = requireEnv("R2_BUCKET");
  const r2 = await r2Client(endpoint, bucket);

  const manifest = JSON.parse(readFileSync(join(args.release, "manifest.json"), "utf8"));

  const blobs = [
    ...readdirSync(join(args.release, "modules")).map((sha256) => ({
      key: moduleR2Key(sha256),
      path: join(args.release, "modules", sha256),
    })),
    ...readdirSync(join(args.release, "assets")).map((hash) => ({
      key: assetR2Key(hash),
      path: join(args.release, "assets", hash),
    })),
  ];

  let uploaded = 0;
  let skipped = 0;
  const queue = [...blobs];
  async function worker() {
    for (;;) {
      const blob = queue.shift();
      if (!blob) return;
      // headObject: null on 404 (upload below), throws on any other failure.
      if (await r2.headObject(blob.key)) {
        skipped++;
        continue;
      }
      await r2.putObject(blob.key, readFileSync(blob.path));
      uploaded++;
    }
  }
  await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, worker));
  console.log(`blobs: ${uploaded} uploaded, ${skipped} already present`);

  const manifestKey =
    `${args.candidate ? "candidates" : "releases"}/${manifest.releaseId}/manifest.json`;
  await r2.putObject(manifestKey, readFileSync(join(args.release, "manifest.json")), "application/json");
  console.log(args.candidate
    ? `candidate uploaded (not yet visible to the deploy service): ${manifestKey}`
    : `release complete: ${manifestKey}`);
}

await main();
