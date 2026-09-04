#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

function argumentValue(argv, name) {
  const index = argv.indexOf(name);
  const value = index === -1 ? undefined : argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const argv = process.argv.slice(2);
const previousTag = argumentValue(argv, "--previous-tag");
const releaseRef = argumentValue(argv, "--release-ref");
const upstreamRef = argumentValue(argv, "--upstream-ref");
const outputPath = argumentValue(argv, "--output");

const previousBase = git(["merge-base", previousTag, upstreamRef]);
const releaseBase = git(["merge-base", releaseRef, upstreamRef]);
const commits = git([
  "log",
  "--first-parent",
  "--format=- %s (%h)",
  `${previousBase}..${releaseBase}`,
]);
const compareUrl = `https://github.com/pingdotgg/t3code/compare/${previousBase}...${releaseBase}`;

const body = [
  "## Upstream changes",
  "",
  commits || "- No upstream commits since the previous release.",
  "",
  `Upstream base: \`${releaseBase}\``,
  `Full upstream comparison: ${compareUrl}`,
  "",
].join("\n");

writeFileSync(outputPath, body);
