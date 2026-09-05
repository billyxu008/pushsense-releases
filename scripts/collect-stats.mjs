#!/usr/bin/env node
// Collects a daily snapshot of GitHub-side metrics for this repo and appends it
// to stats/history.json. Node 20+, no dependencies.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The traffic endpoints (views / clones / popular) require *user* push access.
// The built-in Actions GITHUB_TOKEN does not qualify, so set a STATS_TOKEN
// secret (a fine-grained PAT with Administration: read) to collect traffic.
// Without it everything else is still collected and traffic degrades to null.
const token = process.env.STATS_TOKEN || process.env.GITHUB_TOKEN;
const trafficToken = process.env.STATS_TOKEN || process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY || 'billyxu008/pushsense-releases';
if (!token) {
  console.error('GITHUB_TOKEN is required');
  process.exit(1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const historyPath = resolve(root, 'stats/history.json');

async function api(path, auth = token) {
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${auth}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'pushsense-stats-collector',
    },
  });
  if (!res.ok) {
    throw new Error(`GET ${path} -> ${res.status} ${res.statusText}: ${await res.text()}`);
  }
  return res.json();
}

const num = (value) => (Number.isFinite(value) ? value : 0);

// A 403 here means the token lacks traffic access; keep the rest of the
// snapshot rather than failing the whole run.
async function traffic(path, fallback) {
  try {
    return await api(path, trafficToken);
  } catch (error) {
    console.warn(`skipping ${path}: ${error.message.split('\n')[0]}`);
    return fallback;
  }
}

const [info, releases, views, clones, referrers, paths] = await Promise.all([
  api(''),
  api('/releases?per_page=100'),
  traffic('/traffic/views', null),
  traffic('/traffic/clones', null),
  traffic('/traffic/popular/referrers', null),
  traffic('/traffic/popular/paths', null),
]);

const assets = [];
const byRelease = {};
for (const release of releases) {
  const tag = release.tag_name || release.name || 'untagged';
  byRelease[tag] = byRelease[tag] || 0;
  for (const asset of release.assets || []) {
    const count = num(asset.download_count);
    assets.push({ release: tag, name: asset.name, count });
    byRelease[tag] += count;
  }
}
const total = assets.reduce((sum, asset) => sum + asset.count, 0);

const now = new Date();
const snapshot = {
  date: now.toISOString().slice(0, 10),
  collectedAt: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
  stars: num(info.stargazers_count),
  watchers: num(info.subscribers_count ?? info.watchers_count),
  forks: num(info.forks_count),
  downloads: { total, byRelease, assets },
  traffic: {
    views: num(views && views.count),
    viewUniques: num(views && views.uniques),
    clones: num(clones && clones.count),
    cloneUniques: num(clones && clones.uniques),
    daily: ((views && views.views) || []).map((day) => ({
      date: String(day.timestamp).slice(0, 10),
      views: num(day.count),
      uniques: num(day.uniques),
    })),
  },
  referrers: (referrers || []).map((r) => ({
    referrer: r.referrer,
    count: num(r.count),
    uniques: num(r.uniques),
  })),
  paths: (paths || []).map((p) => ({
    path: p.path,
    count: num(p.count),
    uniques: num(p.uniques),
  })),
};

let history = [];
try {
  const parsed = JSON.parse(await readFile(historyPath, 'utf8'));
  if (Array.isArray(parsed)) history = parsed;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

// If traffic was unavailable this run, keep whatever the most recent snapshot
// already recorded rather than writing zeroes over real numbers.
if (!views && !clones && !referrers && !paths) {
  const previous = [...history].reverse().find((entry) => entry && entry.traffic);
  if (previous) {
    snapshot.traffic = previous.traffic;
    snapshot.referrers = previous.referrers || [];
    snapshot.paths = previous.paths || [];
    snapshot.trafficStale = true;
  }
}

// Re-runs on the same day replace that day's entry rather than piling up.
history = history.filter((entry) => entry && entry.date !== snapshot.date);
history.push(snapshot);
history.sort((a, b) => String(a.date).localeCompare(String(b.date)));

await mkdir(dirname(historyPath), { recursive: true });
await writeFile(historyPath, JSON.stringify(history, null, 2) + '\n');

console.log(
  `stats: ${snapshot.date} downloads=${total} stars=${snapshot.stars} views=${snapshot.traffic.views} (${history.length} snapshots)`,
);
