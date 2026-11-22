// Expected-Value Radar (token-radar-01): one sealed snapshot in, one ranked board out.
//
// The board prices every launch candidate the snapshot holds — pre-token protocols that
// pass the same screen the house's watchlist rule draws — and ranks them by EXPECTED
// value, the product of two fitted models that share nothing but the snapshot's figures:
//
//   price   what a launch would be worth if it came: TVL x the peer set's shrunk category
//           median of market cap / TVL, adjusted by a robust size slope. The peers are the
//           snapshot's launch-type tokens that trade today (94 of them; wrapper, bridge,
//           liquid-staking and exchange tokens are set aside, because their market caps
//           price an underlying asset, not a launch).
//   odds    the chance a protocol with this record ever lists a token at all: a logistic
//           fit on every dated protocol in the snapshot (645), on tokenless age, size and
//           seven-day growth — the record's own answer to "who lists, in the end".
//
//   expected value = price x odds, and the board ranks by it, showing both factors.
//
// Every other term the builders tried is absent on evidence, not on taste: a momentum /
// mean-reversion regime split of the pricing, an age slope inside the price, a growth
// term and a doubled shrink were each fitted and graded on two holdouts (leave-one-out
// and an older-to-newer time split) and each failed to beat the model above on both.
// The odds faced the same trial with per-category offsets and kept its shipped form
// the same way. lib/validate.ts recomputes that whole term table at run time and the
// dashboard prints it, so the claim "tested and dropped" is itself checked every run.
//
// And every pre-token protocol the screen sets aside is still on the page: the
// dashboard's register names each one with the reason the screen caught it, so the
// radar's coverage can be checked line by line instead of taken on faith.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export class SnapshotError extends Error {}

/** The model's version label: the dashboard names it and the dossier quotes it. */
export const MODEL_VERSION = 'expected-value-radar-2';

/** Categories whose tokens price an underlying asset, set aside from the peer set. */
export const WRAPPER_CATEGORIES: ReadonlySet<string> = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** Shrink weight: a category's median counts this many peers toward the peer median. */
export const SHRINK_K = 4;

/** How many board rows the radar carries before the watchlist union, by expected value. */
export const BOARD_TOP = 220;

/** How many live-token protocols the dashboard's reference strip carries, by market cap. */
export const LIVE_ROWS = 24;

/** Whole days between the snapshot's as-of date and a protocol's listing day, or null. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((a - b) / 86_400_000);
}

/** True when the snapshot records no token for the protocol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null && p.mcap_usd === null;
}

/** True when the snapshot records a token for the protocol. */
export function hasToken(p: SnapshotProtocol): boolean {
  return p.gecko_id !== null;
}

const VERSION_MARKER = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/**
 * Why the screen sets a pre-token protocol aside, or null when it is a launch candidate.
 * One function is the whole screen, so the board and the dashboard's screened register
 * can never disagree about a protocol's fate: a wrapped, staked or bridged product of a
 * token that already trades (the wrapper categories, or a name carrying wrapped/staked/
 * staking), a versioned clone of one, or an exchange's own product. WBTC records no
 * token in the snapshot, but it is Bitcoin on Ethereum, not a launch still to come, and
 * a radar that ranks it as one has misread its own data — so it is set aside, named in
 * the register with this reason, never silently dropped.
 */
export function screenReason(p: SnapshotProtocol): string | null {
  if (!isPreToken(p)) return null;
  if (WRAPPER_CATEGORIES.has(p.category ?? '')) return 'wrapper, bridge or staking category — its value prices an underlying asset, not a launch of its own';
  if (VERSION_MARKER.test(p.name)) return 'a versioned clone of a protocol that already trades';
  if (WRAPPED_WORD.test(p.name)) return 'a wrapped or staked product of a token that already trades';
  if (EXCHANGE_PREFIXES.some((x) => p.name.startsWith(x))) return 'an exchange\u2019s own product, not an independent launch';
  return null;
}

/**
 * A launch candidate: a pre-token protocol the screen passes (see screenReason).
 * screenReason alone returns null for token-holders too, so the pre-token test
 * stays here, exactly as the shipped screen drew it.
 */
export function isLaunchCandidate(p: SnapshotProtocol): boolean {
  return isPreToken(p) && screenReason(p) === null;
}

/** The peer set: live launch-type tokens whose market cap can price a launch. */
export function peerPool(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && !WRAPPER_CATEGORIES.has(p.category ?? ''),
  );
}

function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function mean(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** Solve a small linear system by Gaussian elimination with partial pivoting. */
function solveLinear(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[piv]![col]!)) piv = r;
    const tmp = m[col]!;
    m[col] = m[piv]!;
    m[piv] = tmp;
    for (let r = col + 1; r < n; r++) {
      const f = m[r]![col]! / m[col]![col]!;
      for (let c = col; c <= n; c++) m[r]![c] = m[r]![c]! - f * m[col]![c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = m[i]![n]!;
    for (let j = i + 1; j < n; j++) s -= m[i]![j]! * x[j]!;
    x[i] = s / m[i]![i]!;
  }
  return x;
}

/** Weighted least squares through the normal equations, with a whisper of ridge. */
function wls(x: number[][], y: number[], w: number[]): number[] {
  const n = x[0]!.length;
  const a: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const b = new Array<number>(n).fill(0);
  for (let k = 0; k < x.length; k++) {
    for (let i = 0; i < n; i++) {
      b[i]! += w[k]! * x[k]![i]! * y[k]!;
      for (let j = 0; j < n; j++) a[i]![j]! += w[k]! * x[k]![i]! * x[k]![j]!;
    }
  }
  for (let i = 0; i < n; i++) a[i]![i]! += 1e-8;
  return solveLinear(a, b);
}

/** Robust regression: least squares, then three Huber reweighting passes. */
function irls(x: number[][], y: number[]): number[] {
  let beta = wls(x, y, x.map(() => 1));
  for (let iter = 0; iter < 3; iter++) {
    const residuals = x.map((row, k) => y[k]! - row.reduce((s, v, j) => s + v * beta[j]!, 0));
    const scale = median(residuals.map((r) => Math.abs(r))) * 1.4826 + 1e-9;
    const w = residuals.map((r) => (Math.abs(r) <= 1.345 * scale ? 1 : (1.345 * scale) / Math.abs(r)));
    beta = wls(x, y, w);
  }
  return beta;
}

function categoryOf(p: SnapshotProtocol): string {
  return p.category ?? 'Uncategorized';
}

/** Seven-day growth, clipped to the range the fits are stable in; unreported reads 0. */
export function growthOf(p: SnapshotProtocol): number {
  return Math.max(-60, Math.min(120, p.change_7d ?? 0));
}

// ---------------------------------------------------------------------------
// The pricing model: shrunk category multiples plus one robust size slope.
// ---------------------------------------------------------------------------

/** The fitted pricing model, everything the dashboard needs to recompute a row. */
export interface PriceModel {
  peerCount: number;
  /** Category -> shrunk median of mcap / TVL among the peers. */
  multiples: Map<string, number>;
  /** The peer set's own median ratio, for categories with no peer. */
  fallbackMultiple: number;
  /** The pure empirical baseline's single number: the peer set's median mcap / TVL. */
  globalMedianRatio: number;
  /** Mean log TVL across the peer set, the size slope's centre. */
  meanLogTvl: number;
  /** The pooled intercept (log residual at the centre) and the size slope. */
  intercept: number;
  sizeSlope: number;
}

/** Fit the pricing model on an explicit peer list (validation resamples it). */
export function fitPriceOnPeers(peers: SnapshotProtocol[], shrinkK: number = SHRINK_K): PriceModel {
  const peerMedian = median(peers.map((p) => p.mcap_usd! / p.tvl_usd));
  const byCategory = new Map<string, number[]>();
  for (const p of peers) {
    const key = categoryOf(p);
    const list = byCategory.get(key) ?? [];
    list.push(p.mcap_usd! / p.tvl_usd);
    byCategory.set(key, list);
  }
  const multiples = new Map<string, number>();
  for (const key of [...byCategory.keys()].sort()) {
    const list = byCategory.get(key)!;
    const shrunk = Math.exp((list.length * Math.log(median(list)) + shrinkK * Math.log(peerMedian)) / (list.length + shrinkK));
    multiples.set(key, shrunk);
  }
  const meanLogTvl = mean(peers.map((p) => Math.log(p.tvl_usd)));
  const x: number[][] = [];
  const y: number[] = [];
  for (const p of peers) {
    const mult = multiples.get(categoryOf(p)) ?? peerMedian;
    x.push([1, Math.log(p.tvl_usd) - meanLogTvl]);
    y.push(Math.log(p.mcap_usd! / (p.tvl_usd * mult)));
  }
  const beta = irls(x, y);
  return {
    peerCount: peers.length,
    multiples,
    fallbackMultiple: peerMedian,
    globalMedianRatio: peerMedian,
    meanLogTvl,
    intercept: beta[0]!,
    sizeSlope: beta[1]!,
  };
}

/** Fit the pricing model on the snapshot's peer set. Deterministic. */
export function fitPrice(snapshot: Snapshot): PriceModel {
  return fitPriceOnPeers(peerPool(snapshot));
}

/** The pieces of one launch price, so the dashboard can show the arithmetic. */
export interface PriceParts {
  price: number;
  categoryMultiple: number;
  adjustment: number;
}

/** Price one protocol under the fitted model: what its launch would be worth. */
export function priceOf(model: PriceModel, p: SnapshotProtocol): PriceParts {
  const mult = model.multiples.get(categoryOf(p)) ?? model.fallbackMultiple;
  const adj = Math.exp(model.intercept + model.sizeSlope * (Math.log(p.tvl_usd) - model.meanLogTvl));
  return { price: Math.max(1, Math.round(p.tvl_usd * mult * adj)), categoryMultiple: mult, adjustment: adj };
}

/** The pure empirical baseline's price: TVL times one median, nothing else. */
export function baselineOf(model: PriceModel, p: SnapshotProtocol): number {
  return Math.max(1, Math.round(p.tvl_usd * model.globalMedianRatio));
}

// ---------------------------------------------------------------------------
// The odds model: who ever lists a token, fitted on the snapshot's own record.
//
// Every protocol whose listing day the snapshot reports (645 of 758) is one draw from
// the record: it either records a token today or it does not. A logistic fit on three
// figures the snapshot carries for all of them — tokenless age in years, size (log10
// TVL, centred) and seven-day growth — gives each pre-token protocol the odds that a
// protocol with its record is one that lists. The fit is plain gradient descent on
// standardised features with fixed iterations: no clock, no randomness, same bytes
// every run. lib/validate.ts grades it on a time split (fit the earlier-listed half,
// score the later half) against the base rate, and the dashboard prints that grade.
// ---------------------------------------------------------------------------

/** Gradient steps and step size of the odds fit: fixed, so the fit is deterministic. */
export const ODDS_STEPS = 400;
export const ODDS_RATE = 0.1;

/** The fitted odds model: raw-feature coefficients plus its training counts. */
export interface OddsModel {
  /** [intercept, per year of age, per log10 TVL above 1e7, per 10 points of growth]. */
  coef: [number, number, number, number];
  trainedOn: number;
  withToken: number;
}

/** The odds features of one protocol, in raw units; null when its age is unreported. */
export function oddsFeatures(p: SnapshotProtocol, asOf: string): [number, number, number] | null {
  const days = ageDays(asOf, p.listed_at);
  if (days === null || p.tvl_usd <= 0) return null;
  return [days / 365.25, Math.log10(p.tvl_usd) - 7, growthOf(p) / 10];
}

/** Fit the odds model on an explicit protocol list (validation resamples it). */
export function fitOddsOnRows(rows: SnapshotProtocol[], asOf: string): OddsModel {
  const usable = rows
    .map((p) => ({ f: oddsFeatures(p, asOf), y: hasToken(p) ? 1 : 0 }))
    .filter((r): r is { f: [number, number, number]; y: number } => r.f !== null);
  const n = usable.length;
  const dims = 3;
  const mu = new Array<number>(dims).fill(0);
  for (const r of usable) for (let j = 0; j < dims; j++) mu[j]! += r.f[j] / n;
  const sd = new Array<number>(dims).fill(1);
  for (let j = 0; j < dims; j++) {
    const varSum = usable.reduce((s, r) => s + (r.f[j] - mu[j]!) ** 2, 0) / n;
    sd[j] = Math.sqrt(varSum) || 1;
  }
  // Standardised gradient descent with a whisper of ridge on the slopes.
  let w = new Array<number>(dims + 1).fill(0);
  for (let step = 0; step < ODDS_STEPS; step++) {
    const grad = new Array<number>(dims + 1).fill(0);
    for (const r of usable) {
      let s = w[0]!;
      for (let j = 0; j < dims; j++) s += w[j + 1]! * ((r.f[j] - mu[j]!) / sd[j]!);
      const pr = 1 / (1 + Math.exp(-s));
      grad[0]! += r.y - pr;
      for (let j = 0; j < dims; j++) grad[j + 1]! += (r.y - pr) * ((r.f[j] - mu[j]!) / sd[j]!);
    }
    w = w.map((v, j) => v + (ODDS_RATE * grad[j]!) / n - (j === 0 ? 0 : ODDS_RATE * 0.001 * v));
  }
  // Back to raw units, so the dashboard can print coefficients a reader can check.
  const coef: [number, number, number, number] = [
    w[0]! - w.slice(1).reduce((s, wj, j) => s + (wj / sd[j]!) * mu[j]!, 0),
    w[1]! / sd[0]!,
    w[2]! / sd[1]!,
    w[3]! / sd[2]!,
  ];
  return { coef, trainedOn: n, withToken: usable.reduce((s, r) => s + r.y, 0) };
}

/** Fit the odds model on every dated protocol in the snapshot. */
export function fitOdds(snapshot: Snapshot): OddsModel {
  return fitOddsOnRows(snapshot.protocols, snapshot.as_of);
}

/**
 * The odds that a protocol with this record ever lists a token. A protocol whose
 * listing day is unreported gets the record's base rate: the honest middle.
 */
export function oddsOf(model: OddsModel, p: SnapshotProtocol, asOf: string): number {
  const f = oddsFeatures(p, asOf);
  if (f === null) return model.withToken / model.trainedOn;
  const s = model.coef[0] + model.coef[1] * f[0] + model.coef[2] * f[1] + model.coef[3] * f[2];
  return 1 / (1 + Math.exp(-s));
}

// ---------------------------------------------------------------------------
// The odds variant on trial in lib/validate.ts: per-category intercept offsets.
//
// Categories plainly differ in how often their protocols list, so v3 tried giving
// the odds a per-category nudge: each category's mean residual under the shipped
// fit, shrunk by n / (n + K) toward no nudge at all. The trial is graded on both
// holdouts at run time (leave-one-out is too slow to re-run in the sandbox, so
// the second holdout there is a ten-fold split); a variant ships only when it
// beats the shipped odds on both. The shipped odds carry no offsets — the trial's
// verdict, printed on the dashboard, is the evidence.
// ---------------------------------------------------------------------------

/** Shrink weight of the offsets trial: a category's residual counts n/(n+K). */
export const OFFSET_K = 40;

/**
 * Fit the trial's per-category offsets on training rows under a fitted base
 * model: the category's mean probability residual, shrunk toward zero.
 */
export function fitCategoryOffsets(base: OddsModel, rows: SnapshotProtocol[], asOf: string, K: number = OFFSET_K): Map<string, number> {
  const sums = new Map<string, { r: number; n: number }>();
  for (const p of rows) {
    const key = categoryOf(p);
    const cur = sums.get(key) ?? { r: 0, n: 0 };
    cur.r += (hasToken(p) ? 1 : 0) - oddsOf(base, p, asOf);
    cur.n += 1;
    sums.set(key, cur);
  }
  const out = new Map<string, number>();
  for (const [key, { r, n }] of sums) out.set(key, r / (n + K));
  return out;
}

/** The trial's odds for one protocol: the shipped odds, nudged in logit space. */
export function oddsWithOffsets(base: OddsModel, offsets: Map<string, number>, p: SnapshotProtocol, asOf: string): number {
  const off = offsets.get(categoryOf(p)) ?? 0;
  if (off === 0) return oddsOf(base, p, asOf);
  const pr = Math.min(1 - 1e-9, Math.max(1e-9, oddsOf(base, p, asOf)));
  return 1 / (1 + Math.exp(-(Math.log(pr / (1 - pr)) + off)));
}

// ---------------------------------------------------------------------------
// Farm plans. One generator for board.json and the dashboard alike: category,
// chain, TVL tier and age decide the action, the capital, the hold and every
// cost and time. Each step is built from parts, so the plan's totals the
// dashboard prints are the exact sums of the figures in the steps' own text.
// No protocol name is ever special-cased.
// ---------------------------------------------------------------------------

/** One farm step: its text, and the cost and time the text states. */
export interface FarmStep {
  text: string;
  cost_usd: number;
  minutes: number;
}

/** A whole farm plan: its steps and their summed cost and time. */
export interface FarmPlan {
  steps: FarmStep[];
  capital_usd: number;
  hold_days: number;
  cost_usd: number;
  minutes: number;
}

function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

function capitalFor(tvl: number): number {
  if (tvl >= 5e9) return 250;
  if (tvl >= 1e9) return 150;
  if (tvl >= 1e8) return 100;
  if (tvl >= 1e7) return 50;
  return 25;
}

function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

type Playbook = 'lending' | 'trading' | 'bridge' | 'staking' | 'vault' | 'rwa' | 'exchange' | 'play' | 'generic';

function playbookOf(p: SnapshotProtocol): Playbook {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'lending';
  if (c.includes('bridge')) return 'bridge';
  if (c.includes('staking') || c.includes('restaking')) return 'staking';
  if (c.includes('dex') || c.includes('derivat') || c.includes('option') || c.includes('perpetual')) return 'trading';
  if (c.includes('yield') || c.includes('aggregator') || c.includes('allocator') || c.includes('curator')) return 'vault';
  if (c.includes('rwa') || c.includes('real world')) return 'rwa';
  if (c === 'cex' || c.includes('exchange')) return 'exchange';
  if (c.includes('nft') || c.includes('gaming') || c.includes('game')) return 'play';
  return 'generic';
}

/** The farm plan for one protocol: five concrete steps, each costed and timed. */
export function farmPlan(p: SnapshotProtocol, age: number | null): FarmPlan {
  const chain = chainOf(p);
  const capital = capitalFor(p.tvl_usd);
  const hold = holdDaysFor(age);
  const name = p.name;
  const weeks = Math.max(1, Math.round(hold / 7));
  const keep: FarmStep = {
    text: `Keep the ${name} position open for ${hold} days and check it once a week. Cost: $0 beyond the opening gas. Time: 5 minutes a week.`,
    cost_usd: 0,
    minutes: 5 * weeks,
  };
  const record: FarmStep = {
    text: `Log every ${name} transaction hash and a balance screenshot in a dated farm diary. Cost: $0. Time: 5 minutes a week, and it is your proof of early activity if a snapshot is ever announced.`,
    cost_usd: 0,
    minutes: 5 * weeks,
  };
  const review: FarmStep = {
    text: `On day ${hold}, review ${name}: if no token or points program has appeared, withdraw and pay the exit gas. Cost: about $4 in gas on ${chain}. Time: 15 minutes.`,
    cost_usd: 4,
    minutes: 15,
  };
  let steps: FarmStep[];
  switch (playbookOf(p)) {
    case 'lending':
      steps = [
        { text: `Supply $${capital} of USDC as collateral to ${name} on ${chain} and leave it supplied. Cost: about $6 in gas. Time: 10 minutes.`, cost_usd: 6, minutes: 10 },
        { text: `Borrow about $${Math.round(capital / 3)} of USDC against the collateral, repay it within the hour, and repeat the loop twice more this week. Cost: about $9 in gas across the loops. Time: 30 minutes.`, cost_usd: 9, minutes: 30 },
        keep, record, review,
      ];
      break;
    case 'trading':
      steps = [
        { text: `Swap $${capital} of USDC into ETH and back on ${name} on ${chain}, in two separate sessions a day apart. Cost: about $8 in gas and slippage. Time: 20 minutes in all.`, cost_usd: 8, minutes: 20 },
        { text: `Add $${capital} of two-sided liquidity to ${name}'s busiest pool and leave the position open. Cost: about $5 in gas. Time: 10 minutes.`, cost_usd: 5, minutes: 10 },
        keep, record, review,
      ];
      break;
    case 'bridge': {
      const runs = Math.min(hold, 28) / 7;
      steps = [
        { text: `Bridge $${capital} of USDC from Ethereum to ${chain} through ${name}. Cost: about $7 in bridge and gas fees. Time: 15 minutes including the wait for finality.`, cost_usd: 7, minutes: 15 },
        { text: `Use the bridged funds in one ${chain} app the same day (a swap or a supply), so the trip reads as use, not a pass-through. Cost: about $4 in gas. Time: 10 minutes.`, cost_usd: 4, minutes: 10 },
        { text: `Repeat the bridge run once a week for ${Math.min(hold, 28)} days, alternating direction. Cost: about $7 a run. Time: 15 minutes a run.`, cost_usd: 7 * runs, minutes: 15 * runs },
        record, review,
      ];
      break;
    }
    case 'staking':
      steps = [
        { text: `Stake $${capital} of ETH through ${name} on ${chain} and hold the receipt token in the same wallet. Cost: about $6 in gas. Time: 10 minutes.`, cost_usd: 6, minutes: 10 },
        { text: `Use the receipt token once in a ${chain} lending market or pool, so the position counts as activity in two places. Cost: about $5 in gas. Time: 10 minutes.`, cost_usd: 5, minutes: 10 },
        keep, record, review,
      ];
      break;
    case 'vault':
      steps = [
        { text: `Deposit $${capital} of USDC into ${name}'s main vault on ${chain} and hold the vault shares. Cost: about $5 in gas. Time: 10 minutes.`, cost_usd: 5, minutes: 10 },
        { text: `Split a second $${Math.round(capital / 2)} across one more ${name} vault or strategy, so your activity is not a single deposit. Cost: about $5 in gas. Time: 10 minutes.`, cost_usd: 5, minutes: 10 },
        keep, record, review,
      ];
      break;
    case 'rwa':
      steps = [
        { text: `Complete ${name}'s onboarding or KYC if it asks for one, then buy $${capital} of its smallest tokenised asset on ${chain}. Cost: about $6 in gas plus any onboarding fee shown before you sign. Time: 25 minutes.`, cost_usd: 6, minutes: 25 },
        { text: `Hold the asset and claim or reinvest any yield it pays out during the hold. Cost: about $3 in gas a claim. Time: 5 minutes a claim.`, cost_usd: 3, minutes: 5 },
        keep, record, review,
      ];
      break;
    case 'exchange': {
      const fees = Math.max(1, Math.round(capital * 0.02));
      steps = [
        { text: `Open an account at ${name}, pass its verification, and deposit $${capital} of USDC. Cost: $0 to deposit on most rails. Time: 20 minutes including verification.`, cost_usd: 0, minutes: 20 },
        { text: `Make two spot trades a week (USDC into BTC or ETH and back) for ${Math.min(hold, 28)} days, so the account shows real use. Cost: about $${fees} in trading fees across the month. Time: 5 minutes a trade.`, cost_usd: fees, minutes: 5 * 2 * Math.min(hold, 28) / 7 },
        { text: `Keep a small balance (about $${Math.round(capital / 5)}) on the exchange for the whole ${hold} days rather than withdrawing after each trade. Cost: $0. Time: none, it sits.`, cost_usd: 0, minutes: 0 },
        record, review,
      ];
      break;
    }
    case 'play': {
      const sessions = Math.min(hold, 28) / 7;
      steps = [
        { text: `Create a ${name} account, connect the wallet you farm with, and finish its opening quest or first mint on ${chain}. Cost: about $4 in gas. Time: 20 minutes.`, cost_usd: 4, minutes: 20 },
        { text: `Play or mint once a week for ${Math.min(hold, 28)} days; steady weekly activity is what these snapshots usually count. Cost: about $3 in gas a session. Time: 15 minutes a session.`, cost_usd: 3 * sessions, minutes: 15 * sessions },
        keep, record, review,
      ];
      break;
    }
    default: {
      const sessions = Math.min(hold, 28) / 7;
      steps = [
        { text: `Use ${name}'s core feature on ${chain} with $${capital} of USDC (a deposit, a swap or a stake, whichever it offers first). Cost: about $6 in gas. Time: 15 minutes.`, cost_usd: 6, minutes: 15 },
        { text: `Repeat the core action once a week for ${Math.min(hold, 28)} days, varying the amount slightly each time. Cost: about $5 in gas a session. Time: 10 minutes a session.`, cost_usd: 5 * sessions, minutes: 10 * sessions },
        keep, record, review,
      ];
    }
  }
  return {
    steps,
    capital_usd: capital,
    hold_days: hold,
    cost_usd: steps.reduce((s, x) => s + x.cost_usd, 0),
    minutes: steps.reduce((s, x) => s + x.minutes, 0),
  };
}

/** The lockup cost of a plan's capital for its hold, at a stated 5% a year. */
export function lockupCost(plan: FarmPlan): number {
  return Math.round(plan.capital_usd * 0.05 * (plan.hold_days / 365) * 100) / 100;
}

/** A plan's full cost: its steps' fees plus the capital's lockup for the hold. */
export function planCost(plan: FarmPlan): number {
  return Math.round((plan.cost_usd + lockupCost(plan)) * 100) / 100;
}

export type Verdict = 'FARM' | 'THIN' | 'SKIP';

/**
 * The verdict rule, stated once and applied to every row alike. A plan earns
 * FARM when the row clears all three hurdles: at least $1,000,000 of expected
 * launch value, at least 10% fitted odds that a launch ever comes, and an
 * expected value at least 1,000x the plan's all-in cost. THIN is the same
 * shape at the lower marks ($250,000, 4%, 100x). Below that, SKIP: the plan's
 * money and weeks buy too little expectation, or the launch is too unlikely
 * for the plan to be the way to spend them.
 */
export function verdictOf(expectedUsd: number, odds: number, costUsd: number): Verdict {
  const ratio = expectedUsd / Math.max(1, costUsd);
  if (expectedUsd >= 1_000_000 && odds >= 0.1 && ratio >= 1000) return 'FARM';
  if (expectedUsd >= 250_000 && odds >= 0.04 && ratio >= 100) return 'THIN';
  return 'SKIP';
}

// ---------------------------------------------------------------------------
// The board.
// ---------------------------------------------------------------------------

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  watchlist: boolean;
  /** The board ranks by expected value; this is the row's implied_value_usd. */
  implied_value_usd: number;
  /** What a launch would be worth if it came, before the odds. */
  launch_value_usd: number;
  /** The fitted odds that a protocol with this record ever lists a token. */
  odds: number;
  rank_lo: number;
  rank_hi: number;
  model: { category_multiple: number; adjustment: number };
  plan: { capital_usd: number; hold_days: number; cost_usd: number; minutes: number; verdict: Verdict };
  farm_steps: string[];
}

/** Build the ranked board: top rows by expected value, unioned with the watchlist. */
export function buildBoard(snapshot: Snapshot, price: PriceModel, odds: OddsModel): BoardRow[] {
  const watch = new Set(snapshot.watchlist);
  const scored = snapshot.protocols
    .filter(isLaunchCandidate)
    .map((p) => {
      const parts = priceOf(price, p);
      // The board carries the odds at the precision the dashboard prints, and the
      // expected value is computed from that printed figure, so the page's own
      // recomputation of a row lands on the board's number to the dollar.
      const o = Math.round(oddsOf(odds, p, snapshot.as_of) * 10000) / 10000;
      const expected = Math.max(1, Math.round(parts.price * o));
      return { p, parts, odds: o, expected };
    })
    .sort((a, b) => b.expected - a.expected || (a.p.slug < b.p.slug ? -1 : 1));
  const chosen = new Map<string, (typeof scored)[number]>();
  for (const s of scored.slice(0, BOARD_TOP)) chosen.set(s.p.slug, s);
  for (const s of scored) if (watch.has(s.p.slug)) chosen.set(s.p.slug, s);
  const rows = [...chosen.values()].sort((a, b) => b.expected - a.expected || (a.p.slug < b.p.slug ? -1 : 1));
  return rows.map((s, i) => {
    const age = ageDays(snapshot.as_of, s.p.listed_at);
    const plan = farmPlan(s.p, age);
    const cost = planCost(plan);
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      mcap_usd: null,
      listed_at: s.p.listed_at,
      gecko_id: null,
      symbol: null,
      token_status: 'pre-token' as const,
      age_days: age,
      watchlist: watch.has(s.p.slug),
      implied_value_usd: s.expected,
      launch_value_usd: s.parts.price,
      odds: Math.round(s.odds * 10000) / 10000,
      rank_lo: i + 1,
      rank_hi: i + 1,
      model: { category_multiple: s.parts.categoryMultiple, adjustment: s.parts.adjustment },
      plan: {
        capital_usd: plan.capital_usd,
        hold_days: plan.hold_days,
        cost_usd: cost,
        minutes: plan.minutes,
        verdict: verdictOf(s.expected, s.odds, cost),
      },
      farm_steps: plan.steps.map((x) => x.text),
    };
  });
}

/** The first gate failure in a board, or null when the board is gate-clean. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'a slug appears twice';
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) if (!known.has(r.slug)) return `row names an invented slug: ${r.slug}`;
  for (const slug of snapshot.watchlist) if (!slugs.has(slug)) return `watchlist slug missing from the board: ${slug}`;
  for (let i = 0; i < board.length; i++) {
    const r = board[i]!;
    if (r.rank !== i + 1) return `rank ${r.rank} out of place at row ${i}`;
    if (i > 0 && board[i - 1]!.implied_value_usd < r.implied_value_usd) return 'implied value rises as rank ascends';
    if (!(r.implied_value_usd > 0)) return `implied value not positive at ${r.slug}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `farm_steps count ${r.farm_steps.length} at ${r.slug}`;
    for (const step of r.farm_steps) {
      const len = step.trim().length;
      if (len < 20 || len > 600) return `farm step of ${len} chars at ${r.slug}`;
    }
  }
  if (board.length >= 2 && board.every((r) => r.implied_value_usd === board[0]!.implied_value_usd)) return 'every implied value is the same';
  return null;
}

/** Parse and lightly validate the sealed snapshot text. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot is not JSON');
  }
  const doc = raw as Partial<Snapshot>;
  if (typeof doc.as_of !== 'string' || typeof doc.floor_usd !== 'number' || !Array.isArray(doc.protocols) || !Array.isArray(doc.watchlist)) {
    throw new SnapshotError('snapshot is missing as_of, floor_usd, protocols or watchlist');
  }
  for (const p of doc.protocols) {
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Array.isArray(p.chains)) {
      throw new SnapshotError(`protocol entry is malformed at ${String((p as SnapshotProtocol).slug)}`);
    }
  }
  return doc as Snapshot;
}
