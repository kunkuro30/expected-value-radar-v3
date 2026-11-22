// Expected-Value Radar (token-radar-01 entry, Node 22, standard library only).
//
// Reads the sealed snapshot from /input/snapshot.json (or --input <file|dir>), fits the
// pricing and odds models in lib/model.ts on the snapshot's own figures, grades them
// with lib/validate.ts, writes the ranked board to /output/board.json and the
// dashboard's data to /output/data.js, copies dashboard/ and screenshots/ to /output,
// and writes /output/dossier.json last with the vendored make.fun library.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
//
// The run is deterministic: no clock reads (ages count from the snapshot's own as_of),
// no unseeded randomness (the refits use a fixed seed), no network.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIVE_ROWS,
  MODEL_VERSION,
  WRAPPER_CATEGORIES,
  ageDays,
  boardIssue,
  buildBoard,
  fitOdds,
  fitPrice,
  isLaunchCandidate,
  isPreToken,
  parseSnapshot,
  peerPool,
  screenReason,
  type Snapshot,
} from './lib/model.ts';
import { bootstrapRanks, validateModel } from './lib/validate.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps: the text cap shapes the dossier, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`expected-value radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot: Snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const price = fitPrice(snapshot);
const odds = fitOdds(snapshot);
const validation = validateModel(snapshot, price, odds);
let board = buildBoard(snapshot, price, odds);
const ranges = bootstrapRanks(snapshot, board, odds);
board = board.map((r) => {
  const range = ranges.get(r.slug);
  return range === undefined ? r : { ...r, rank_lo: range[0], rank_hi: range[1] };
});
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`expected-value radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

// The whole universe, accounted for: every one of the snapshot's protocols is
// trading, ranked here, or set aside by the screen — and the page says which.
const peers = peerPool(snapshot);
// "Records a token" is the complement of pre-token (any of gecko id, symbol or a
// market cap present), so the page's three counts sum to the whole snapshot.
const trading = snapshot.protocols.filter((p) => !isPreToken(p)).length;
const pretoken = snapshot.protocols.filter(isPreToken).length;
const candidates = snapshot.protocols.filter(isLaunchCandidate).length;
const setAsideWrapper = snapshot.protocols.filter((p) => isPreToken(p) && WRAPPER_CATEGORIES.has(p.category ?? '')).length;
const verdicts = { FARM: 0, THIN: 0, SKIP: 0 };
for (const r of board) verdicts[r.plan.verdict]++;

// The screened register: every pre-token protocol the screen set aside, named
// with its reason, so the page's coverage can be checked line by line. Sorted
// by TVL, largest first — the biggest screened names are the ones a reader
// would ask about (a wrapped Bitcoin outranks most launches by size alone).
const screened = snapshot.protocols
  .filter((p) => isPreToken(p) && !isLaunchCandidate(p))
  .map((p) => ({
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    age_days: ageDays(snapshot.as_of, p.listed_at),
    reason: screenReason(p)!,
  }))
  .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1));
const setAsideKinds = { category: 0, versioned: 0, wrapped_name: 0, exchange: 0 };
for (const s of screened) {
  if (s.reason.startsWith('wrapper, bridge or staking')) setAsideKinds.category++;
  else if (s.reason.startsWith('a versioned clone')) setAsideKinds.versioned++;
  else if (s.reason.startsWith('a wrapped or staked')) setAsideKinds.wrapped_name++;
  else setAsideKinds.exchange++;
}

// Peer anchors for the drawer: the traded peers a row's price was learned
// from. Its own category's peers come first (they set the multiple), nearest
// by size; any remaining slots fill with the nearest traded peers overall,
// marked as such, so a thin category still shows its context.
function anchorsFor(category: string | null, tvl: number) {
  const bySize = (a: (typeof peers)[number], b: (typeof peers)[number]) =>
    Math.abs(Math.log(a.tvl_usd) - Math.log(tvl)) - Math.abs(Math.log(b.tvl_usd) - Math.log(tvl)) || (a.slug < b.slug ? -1 : 1);
  const inCat = peers.filter((p) => (p.category ?? 'Uncategorized') === (category ?? 'Uncategorized')).sort(bySize);
  const rest = peers.filter((p) => (p.category ?? 'Uncategorized') !== (category ?? 'Uncategorized')).sort(bySize);
  return [...inCat, ...rest]
    .slice(0, 4)
    .map((p) => {
      const blind = blindBySlug.get(p.slug);
      return {
        name: p.name,
        symbol: p.symbol,
        category: p.category,
        same_category: (p.category ?? 'Uncategorized') === (category ?? 'Uncategorized'),
        tvl_usd: p.tvl_usd,
        mcap_usd: p.mcap_usd!,
        ratio: Math.round((p.mcap_usd! / p.tvl_usd) * 1000) / 1000,
        blind_factor: blind ? blind.factor : null,
      };
    });
}
const catPeerCounts = new Map<string, number>();
for (const p of peers) catPeerCounts.set(p.category ?? 'Uncategorized', (catPeerCounts.get(p.category ?? 'Uncategorized') ?? 0) + 1);

const blindBySlug = new Map(validation.blind.map((b) => [b.slug, b]));
const live = peers
  .slice()
  .sort((a, b) => b.mcap_usd! - a.mcap_usd! || (a.slug < b.slug ? -1 : 1))
  .slice(0, LIVE_ROWS)
  .map((p) => {
    const blind = blindBySlug.get(p.slug);
    return {
      name: p.name,
      symbol: p.symbol,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      ratio: p.tvl_usd > 0 ? p.mcap_usd! / p.tvl_usd : null,
      blind_usd: blind ? blind.predicted_usd : null,
      blind_factor: blind ? blind.factor : null,
    };
  });

const radar = {
  version: MODEL_VERSION,
  as_of: snapshot.as_of,
  source: snapshot.source,
  floor_usd: snapshot.floor_usd,
  counts: {
    protocols: snapshot.protocols.length,
    peers: price.peerCount,
    trading,
    pretoken,
    candidates,
    set_aside: pretoken - candidates,
    set_aside_wrapper: setAsideWrapper,
    set_aside_kinds: setAsideKinds,
    watchlist: snapshot.watchlist.length,
    board: board.length,
    verdicts,
  },
  price: {
    peer_count: price.peerCount,
    global_median_ratio: price.globalMedianRatio,
    mean_log_tvl: price.meanLogTvl,
    intercept: price.intercept,
    size_slope: price.sizeSlope,
    multiples: Object.fromEntries([...price.multiples.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
  },
  odds: {
    trained_on: odds.trainedOn,
    with_token: odds.withToken,
    coef: odds.coef,
  },
  validation,
  rows: board.map((r) => ({
    rank: r.rank,
    slug: r.slug,
    name: r.name,
    category: r.category,
    chains: r.chains,
    tvl_usd: r.tvl_usd,
    change_7d: r.change_7d,
    age_days: r.age_days,
    listed_at: r.listed_at,
    watchlist: r.watchlist,
    launch_value_usd: r.launch_value_usd,
    odds: r.odds,
    implied_value_usd: r.implied_value_usd,
    rank_lo: r.rank_lo,
    rank_hi: r.rank_hi,
    multiple: r.model.category_multiple,
    adjustment: r.model.adjustment,
    plan: r.plan,
    farm_steps: r.farm_steps,
    cat_peers: catPeerCounts.get(r.category ?? 'Uncategorized') ?? 0,
    anchors: anchorsFor(r.category, r.tvl_usd),
  })),
  screened,
  live,
};

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), `window.RADAR = ${JSON.stringify(radar)};\n`);

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`expected-value radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`expected-value radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

const v = validation;
process.stdout.write(
  `expected-value radar: ${snapshot.protocols.length} protocols, ${price.peerCount} peers, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows ranked by expected value\n` +
    `expected-value radar: shipped price leave-one-out ${v.shipped.loo} vs baseline ${v.shipped.baselineLoo}; time split ${v.shipped.half} vs baseline ${v.shipped.baselineHalf}; odds Brier ${v.odds.brier} vs base rate ${v.odds.baseBrier}, AUC ${v.odds.auc}; worst miss ${v.shipped.worst.name} x${v.shipped.worst.factor}\n` +
    `expected-value radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')}, ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
