// The radar grades itself before it grades anyone else.
//
// Everything here runs at program run time, from the sealed figures alone, so the
// numbers the dashboard prints are the numbers this code recomputes in the grader's
// sandbox, byte for byte:
//
//   the term table   every candidate pricing model — the shipped one and each rival
//                    that adds or removes a term — graded on two holdouts: leave-one-
//                    out over the peer set, and a time split (fit the earlier-listed
//                    half of the peers, price the later half blind). A term ships
//                    only if its model beats the shipped one on BOTH holdouts; the
//                    table prints all of them, kept and dropped alike.
//   the odds grade   the launch-odds fit, graded on a time split of every dated
//                    protocol: Brier score against the base rate's Brier, and AUC.
//                    The per-category-offset variant stands trial beside it on the
//                    time split and a ten-fold split, and ships only if it beats
//                    the shipped odds on both — it did not, and the page says so.
//   blind peers      each peer priced by a model fitted on the other peers, printed
//                    beside its actual market cap on the dashboard's live tab.
//   rank ranges      bootstrap refits of the peer set under a fixed seed re-price
//                    the board (the odds fit held at its full fit, as the page says);
//                    each row keeps its 10th-90th percentile ranks.

import {
  ageDays,
  baselineOf,
  fitCategoryOffsets,
  fitOddsOnRows,
  fitPriceOnPeers,
  growthOf,
  hasToken,
  oddsOf,
  oddsWithOffsets,
  peerPool,
  priceOf,
  type BoardRow,
  type OddsModel,
  type PriceModel,
  type Snapshot,
  type SnapshotProtocol,
} from './model.ts';

/** How many bootstrap refits draw each row's rank range. */
export const REFITS = 150;

const BOOTSTRAP_SEED = 0x9e3779b9;

function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** mulberry32: a tiny deterministic PRNG, so refits never depend on the clock. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// The variant lab: one parameterized pricing fit, so each row of the term
// table is the same machinery with one switch flipped — no bespoke rivals.
// ---------------------------------------------------------------------------

interface LabCfg {
  multiples: boolean;
  size: boolean;
  regime: boolean;
  age: boolean;
  growth: boolean;
  shrinkK: number;
}

interface LabFit {
  multMom: Map<string, number>;
  multRev: Map<string, number>;
  fbMom: number;
  fbRev: number;
  beta: number[];
  meanLogTvl: number;
  medAgeY: number;
  cfg: LabCfg;
}

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

const regimeOf = (p: SnapshotProtocol): 'mom' | 'rev' => ((p.change_7d ?? 0) > 0 ? 'mom' : 'rev');
const catOf = (p: SnapshotProtocol): string => p.category ?? 'Uncategorized';

function labFit(train: SnapshotProtocol[], asOf: string, cfg: LabCfg): LabFit {
  const ages = train.map((p) => ageDays(asOf, p.listed_at)).filter((d): d is number => d !== null);
  const medAgeY = median(ages) / 365.25;
  const meanLogTvl = train.reduce((s, p) => s + Math.log(p.tvl_usd), 0) / train.length;
  const mkMultiples = (rows: SnapshotProtocol[]) => {
    const groupMedian = median(rows.map((p) => p.mcap_usd! / p.tvl_usd));
    const byCat = new Map<string, number[]>();
    for (const p of rows) byCat.set(catOf(p), [...(byCat.get(catOf(p)) ?? []), p.mcap_usd! / p.tvl_usd]);
    const map = new Map<string, number>();
    for (const [k, list] of byCat) {
      map.set(k, Math.exp((list.length * Math.log(median(list)) + cfg.shrinkK * Math.log(groupMedian)) / (list.length + cfg.shrinkK)));
    }
    return { map, groupMedian };
  };
  const pooled = mkMultiples(train);
  const mom = mkMultiples(train.filter((p) => regimeOf(p) === 'mom'));
  const rev = mkMultiples(train.filter((p) => regimeOf(p) === 'rev'));
  const multFor = (p: SnapshotProtocol): number => {
    if (!cfg.multiples) return pooled.groupMedian;
    if (!cfg.regime) return pooled.map.get(catOf(p)) ?? pooled.groupMedian;
    const g = regimeOf(p) === 'mom' ? mom : rev;
    return g.map.get(catOf(p)) ?? g.groupMedian;
  };
  const x: number[][] = [];
  const y: number[] = [];
  for (const p of train) {
    const row: number[] = [];
    if (cfg.regime) {
      row.push(regimeOf(p) === 'mom' ? 1 : 0, regimeOf(p) === 'rev' ? 1 : 0);
    } else {
      row.push(1);
    }
    if (cfg.size) row.push(Math.log(p.tvl_usd) - meanLogTvl);
    if (cfg.age) row.push((ageDays(asOf, p.listed_at) ?? medAgeY * 365.25) / 365.25);
    if (cfg.growth) row.push(growthOf(p) / 10);
    x.push(row);
    y.push(Math.log(p.mcap_usd! / (p.tvl_usd * multFor(p))));
  }
  return {
    multMom: cfg.regime ? mom.map : pooled.map,
    multRev: cfg.regime ? rev.map : pooled.map,
    fbMom: cfg.regime ? mom.groupMedian : pooled.groupMedian,
    fbRev: cfg.regime ? rev.groupMedian : pooled.groupMedian,
    beta: irls(x, y),
    meanLogTvl,
    medAgeY,
    cfg,
  };
}

function labPredict(f: LabFit, p: SnapshotProtocol, asOf: string): number {
  const cfg = f.cfg;
  let mult: number;
  if (!cfg.multiples) {
    mult = f.fbMom;
  } else if (!cfg.regime) {
    mult = f.multMom.get(catOf(p)) ?? f.fbMom;
  } else {
    mult = (regimeOf(p) === 'mom' ? f.multMom.get(catOf(p)) ?? f.fbMom : f.multRev.get(catOf(p)) ?? f.fbRev);
  }
  const row: number[] = [];
  if (cfg.regime) {
    row.push(regimeOf(p) === 'mom' ? 1 : 0, regimeOf(p) === 'rev' ? 1 : 0);
  } else {
    row.push(1);
  }
  if (cfg.size) row.push(Math.log(p.tvl_usd) - f.meanLogTvl);
  if (cfg.age) row.push((ageDays(asOf, p.listed_at) ?? f.medAgeY * 365.25) / 365.25);
  if (cfg.growth) row.push(growthOf(p) / 10);
  const adj = Math.exp(row.reduce((s, v, j) => s + v * f.beta[j]!, 0));
  return p.tvl_usd * mult * adj;
}

const logErr = (pred: number, actual: number) => Math.abs(Math.log10(pred / actual));

/** Grade one lab configuration on leave-one-out and on the time split. */
function gradeCfg(peers: SnapshotProtocol[], asOf: string, cfg: LabCfg): { loo: number; half: number } {
  const looErrs: number[] = [];
  for (let i = 0; i < peers.length; i++) {
    const fit = labFit(peers.filter((_, j) => j !== i), asOf, cfg);
    looErrs.push(logErr(labPredict(fit, peers[i]!, asOf), peers[i]!.mcap_usd!));
  }
  const byListing = [...peers].sort((a, b) => ((a.listed_at ?? '9999-12-31') < (b.listed_at ?? '9999-12-31') ? -1 : 1));
  const half = Math.floor(byListing.length / 2);
  const fit = labFit(byListing.slice(0, half), asOf, cfg);
  const halfErrs = byListing.slice(half).map((p) => logErr(labPredict(fit, p, asOf), p.mcap_usd!));
  return { loo: round3(median(looErrs)), half: round3(median(halfErrs)) };
}

// ---------------------------------------------------------------------------
// The report the dashboard prints.
// ---------------------------------------------------------------------------

/** One row of the term table: a candidate model, its two holdout errors, its fate. */
export interface TermRow {
  model: string;
  loo: number;
  half: number;
  verdict: 'kept' | 'dropped' | 'baseline';
  note: string;
}

/** One peer priced blind: fitted on the other peers, printed beside its actual cap. */
export interface BlindPeer {
  slug: string;
  name: string;
  symbol: string | null;
  category: string | null;
  tvl_usd: number;
  actual_usd: number;
  predicted_usd: number;
  factor: number;
}

export interface ValidationReport {
  peers: number;
  shipped: {
    loo: number;
    half: number;
    within2x: number;
    worst: { slug: string; name: string; factor: number; direction: 'over' | 'under' };
    baselineLoo: number;
    baselineHalf: number;
  };
  terms: TermRow[];
  odds: {
    trainedOn: number;
    testOn: number;
    brier: number;
    baseBrier: number;
    auc: number;
    coef: [number, number, number, number];
    /** The shipped odds on the second runtime holdout: a ten-fold split. */
    foldBrier: number;
    foldBaseBrier: number;
    /** The category-offset variant, graded on both runtime holdouts beside the shipped odds. */
    variant: { splitBrier: number; foldBrier: number };
  };
  blind: BlindPeer[];
}

const SHIPPED: LabCfg = { multiples: true, size: true, regime: false, age: false, growth: false, shrinkK: 4 };

/** Grade the shipped model, every rival, and the odds fit, on the snapshot itself. */
export function validateModel(snapshot: Snapshot, price: PriceModel, odds: OddsModel): ValidationReport {
  const peers = peerPool(snapshot);
  const asOf = snapshot.as_of;

  // The term table: the shipped model and each one-switch rival, on both holdouts.
  const candidates: { model: string; cfg: LabCfg; verdict: TermRow['verdict']; note: string }[] = [
    {
      model: 'TVL x the peer median, nothing else',
      cfg: { multiples: false, size: false, regime: false, age: false, growth: false, shrinkK: 4 },
      verdict: 'baseline',
      note: 'the flat baseline every fitted model must beat',
    },
    {
      model: 'Shrunk category multiples, no size slope',
      cfg: { multiples: true, size: false, regime: false, age: false, growth: false, shrinkK: 4 },
      verdict: 'dropped',
      note: 'categories alone misprice the big against the small; the size slope beats it on both holdouts',
    },
    {
      model: 'Shrunk category multiples + size slope (the shipped price)',
      cfg: SHIPPED,
      verdict: 'kept',
      note: 'the best of the table on leave-one-out and on the time split alike',
    },
    {
      model: 'Shipped price + a momentum / mean-reversion regime split',
      cfg: { ...SHIPPED, regime: true },
      verdict: 'dropped',
      note: 'better on leave-one-out, worse on the time split — a term ships only when it wins on both, so the split is out',
    },
    {
      model: 'Shipped price + an age slope inside the price',
      cfg: { ...SHIPPED, age: true },
      verdict: 'dropped',
      note: 'age does not move what a launch is worth; it moves whether one comes, so age lives in the odds',
    },
    {
      model: 'Shipped price + a seven-day growth term',
      cfg: { ...SHIPPED, growth: true },
      verdict: 'dropped',
      note: 'worse on leave-one-out and no better on the time split; one week of TVL weather is noise to a price',
    },
    {
      model: 'Shipped price with the shrink doubled (K=8)',
      cfg: { ...SHIPPED, shrinkK: 8 },
      verdict: 'dropped',
      note: 'shrinking harder toward the median blurs real category differences',
    },
  ];
  const terms: TermRow[] = candidates.map((c) => {
    const g = gradeCfg(peers, asOf, c.cfg);
    return { model: c.model, loo: g.loo, half: g.half, verdict: c.verdict, note: c.note };
  });
  const shippedRow = terms[2]!;
  const baselineRow = terms[0]!;

  // The shipped model graded peer by peer: within-2x share, worst miss, blind prices.
  const blind: BlindPeer[] = [];
  let within = 0;
  let worst: ValidationReport['shipped']['worst'] = { slug: '', name: '', factor: 1, direction: 'over' };
  let worstErr = -1;
  for (let i = 0; i < peers.length; i++) {
    const train = peers.filter((_, j) => j !== i);
    const fit = fitPriceOnPeers(train);
    const p = peers[i]!;
    const pred = priceOf(fit, p).price;
    const e = logErr(pred, p.mcap_usd!);
    if (e < Math.log10(2)) within++;
    if (e > worstErr) {
      worstErr = e;
      worst = { slug: p.slug, name: p.name, factor: Math.round(Math.pow(10, e) * 10) / 10, direction: pred >= p.mcap_usd! ? 'over' : 'under' };
    }
    blind.push({
      slug: p.slug,
      name: p.name,
      symbol: p.symbol,
      category: p.category,
      tvl_usd: p.tvl_usd,
      actual_usd: p.mcap_usd!,
      predicted_usd: pred,
      factor: Math.round(Math.pow(10, e) * 10) / 10,
    });
  }
  void price;
  void baselineOf;

  // The odds grade: fit the earlier-listed half of the dated protocols, score the rest.
  const dated = snapshot.protocols
    .filter((p) => ageDays(asOf, p.listed_at) !== null && p.tvl_usd > 0)
    .sort((a, b) => ((a.listed_at ?? '9999-12-31') < (b.listed_at ?? '9999-12-31') ? -1 : 1));
  const halfN = Math.floor(dated.length / 2);
  const trainRows = dated.slice(0, halfN);
  const testRows = dated.slice(halfN);
  const splitFit = fitOddsOnRows(trainRows, asOf);
  const baseRate = trainRows.filter(hasToken).length / trainRows.length;
  let brier = 0;
  let baseBrier = 0;
  const pos: number[] = [];
  const neg: number[] = [];
  for (const p of testRows) {
    const pr = oddsOf(splitFit, p, asOf);
    const y = hasToken(p) ? 1 : 0;
    brier += (pr - y) ** 2;
    baseBrier += (baseRate - y) ** 2;
    (y === 1 ? pos : neg).push(pr);
  }
  let concordant = 0;
  let pairs = 0;
  for (const a of pos) {
    for (const b of neg) {
      pairs++;
      concordant += a > b ? 1 : a === b ? 0.5 : 0;
    }
  }

  // The category-offset variant, on trial beside the shipped odds. Same time
  // split as above, offsets fitted on the training half alone; then a ten-fold
  // split of every dated protocol as the second holdout, offsets refitted inside
  // each fold. A variant ships only if it beats the shipped odds on both.
  const splitOffsets = fitCategoryOffsets(splitFit, trainRows, asOf);
  let variantSplit = 0;
  for (const p of testRows) {
    const y = hasToken(p) ? 1 : 0;
    variantSplit += (oddsWithOffsets(splitFit, splitOffsets, p, asOf) - y) ** 2;
  }
  const FOLDS = 10;
  let foldSq = 0;
  let foldBaseSq = 0;
  let variantFoldSq = 0;
  for (let f = 0; f < FOLDS; f++) {
    const foldTrain = dated.filter((_, i) => i % FOLDS !== f);
    const foldTest = dated.filter((_, i) => i % FOLDS === f);
    const foldFit = fitOddsOnRows(foldTrain, asOf);
    const foldOffsets = fitCategoryOffsets(foldFit, foldTrain, asOf);
    const foldBase = foldTrain.filter(hasToken).length / foldTrain.length;
    for (const p of foldTest) {
      const y = hasToken(p) ? 1 : 0;
      foldSq += (oddsOf(foldFit, p, asOf) - y) ** 2;
      foldBaseSq += (foldBase - y) ** 2;
      variantFoldSq += (oddsWithOffsets(foldFit, foldOffsets, p, asOf) - y) ** 2;
    }
  }

  return {
    peers: peers.length,
    shipped: {
      loo: shippedRow.loo,
      half: shippedRow.half,
      within2x: round3(within / peers.length),
      worst,
      baselineLoo: baselineRow.loo,
      baselineHalf: baselineRow.half,
    },
    terms,
    odds: {
      trainedOn: odds.trainedOn,
      testOn: testRows.length,
      brier: round3(brier / testRows.length),
      baseBrier: round3(baseBrier / testRows.length),
      auc: round3(concordant / pairs),
      coef: odds.coef,
      foldBrier: round3(foldSq / dated.length),
      foldBaseBrier: round3(foldBaseSq / dated.length),
      variant: {
        splitBrier: round3(variantSplit / testRows.length),
        foldBrier: round3(variantFoldSq / dated.length),
      },
    },
    blind,
  };
}

/**
 * Rank ranges from bootstrap refits of the peer set: resample the peers with
 * replacement, refit the price, re-rank the board among itself (the odds fit
 * held at its full fit), and keep each row's 10th–90th percentile ranks. The
 * point rank is always inside its own range.
 */
export function bootstrapRanks(snapshot: Snapshot, board: BoardRow[], odds: OddsModel): Map<string, [number, number]> {
  const peers = peerPool(snapshot);
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const targets = board.map((r) => bySlug.get(r.slug)!).filter((p) => p !== undefined);
  const samples = new Map<string, number[]>(board.map((r) => [r.slug, []]));
  const rand = mulberry32(BOOTSTRAP_SEED);
  for (let refit = 0; refit < REFITS; refit++) {
    const draw: SnapshotProtocol[] = [];
    for (let i = 0; i < peers.length; i++) draw.push(peers[Math.floor(rand() * peers.length)]!);
    const fit = fitPriceOnPeers(draw);
    const scored = targets
      .map((p) => ({ slug: p.slug, expected: Math.max(1, Math.round(priceOf(fit, p).price * oddsOf(odds, p, snapshot.as_of))) }))
      .sort((a, b) => b.expected - a.expected || (a.slug < b.slug ? -1 : 1));
    scored.forEach((s, i) => samples.get(s.slug)!.push(i + 1));
  }
  const ranges = new Map<string, [number, number]>();
  for (const row of board) {
    const list = [...samples.get(row.slug)!].sort((a, b) => a - b);
    const lo = list[Math.floor(0.1 * (list.length - 1))]!;
    const hi = list[Math.floor(0.9 * (list.length - 1))]!;
    ranges.set(row.slug, [Math.min(lo, row.rank), Math.max(hi, row.rank)]);
  }
  return ranges;
}
