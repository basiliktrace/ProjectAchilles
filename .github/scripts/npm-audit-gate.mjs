#!/usr/bin/env node
// Fails when an npm project has a production advisory at or above
// AUDIT_LEVEL (default: high) that isn't in .github/audit-allowlist.json.
//
// Usage: node .github/scripts/npm-audit-gate.mjs <project-dir> [<project-dir> ...]
//
// Allow-list entries need a reason and an expiry date. An expired entry fails
// the gate, so "no fix available" gets re-checked instead of being silently
// accepted forever. Entries that no longer match anything are reported so they
// can be deleted.
//
// Only needs package-lock.json (npm audit reads the lockfile); no install.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const level = process.env.AUDIT_LEVEL ?? 'high';
if (!(level in SEVERITY_RANK)) {
  console.error(`Unknown AUDIT_LEVEL "${level}"`);
  process.exit(2);
}

const projects = process.argv.slice(2);
if (projects.length === 0) {
  console.error('Usage: npm-audit-gate.mjs <project-dir> [...]');
  process.exit(2);
}

const allowlistPath = join(import.meta.dirname, '..', 'audit-allowlist.json');
const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8')).advisories ?? [];
const today = new Date().toISOString().slice(0, 10);

/** Unique advisories (by GHSA id) at or above the threshold, from `npm audit --json`. */
function auditProject(dir) {
  const result = spawnSync('npm', ['audit', '--json', '--omit=dev'], { cwd: dir, encoding: 'utf8' });
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(`npm audit produced no JSON in ${dir}: ${result.stderr.trim()}`);
  }
  if (report.error) {
    throw new Error(`npm audit failed in ${dir}: ${report.error.summary ?? JSON.stringify(report.error)}`);
  }

  const advisories = new Map();
  for (const vuln of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vuln.via) {
      if (typeof via !== 'object') continue; // a string means "vulnerable through <dep>"
      if (SEVERITY_RANK[via.severity] < SEVERITY_RANK[level]) continue;
      const id = via.url?.split('/').pop() ?? String(via.source);
      advisories.set(id, { id, package: via.name, severity: via.severity, title: via.title, url: via.url });
    }
  }
  return [...advisories.values()];
}

let failed = false;
const usedEntries = new Set();

for (const entry of allowlist) {
  if (!entry.reason || !entry.expires) {
    console.error(`::error::Allow-list entry ${entry.id} needs both "reason" and "expires"`);
    failed = true;
  } else if (entry.expires < today) {
    console.error(`::error::Allow-list entry ${entry.id} (${entry.package}) expired on ${entry.expires}. Re-check whether a fix exists, then renew or remove it.`);
    failed = true;
  }
}

for (const dir of projects) {
  let advisories;
  try {
    advisories = auditProject(dir);
  } catch (err) {
    console.error(`::error::${err.message}`);
    failed = true;
    continue;
  }

  const blocking = [];
  for (const adv of advisories) {
    // An expired entry excuses nothing: the advisory is reported as blocking too.
    const entry = allowlist.find(
      (e) => e.id === adv.id && e.projects?.includes(dir) && e.expires && e.expires >= today,
    );
    if (entry) {
      usedEntries.add(entry);
      console.log(`  allowed  ${dir}: ${adv.severity} ${adv.package} ${adv.id} (until ${entry.expires}): ${entry.reason}`);
    } else {
      blocking.push(adv);
    }
  }

  if (blocking.length === 0) {
    console.log(`OK ${dir}: no unallowed ${level}+ production advisories`);
    continue;
  }
  failed = true;
  for (const adv of blocking) {
    console.error(`::error::${dir}: ${adv.severity} ${adv.package}: ${adv.title} ${adv.url}`);
  }
}

for (const entry of allowlist) {
  const relevant = entry.projects?.some((p) => projects.includes(p));
  const expired = !entry.expires || entry.expires < today; // already reported as an error
  if (relevant && !expired && !usedEntries.has(entry)) {
    console.log(`::warning::Allow-list entry ${entry.id} (${entry.package}) matched nothing in ${projects.join(', ')}. Delete it if it is no longer needed.`);
  }
}

process.exit(failed ? 1 : 0);
