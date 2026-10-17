/**
 * The Riftmap maintenance-attention score.
 *
 * ## What it is
 *
 * A transparent, repository-relative ranking that combines four measurable
 * indicators into a single 0-100 number so that a developer has a starting
 * point for manual investigation.
 *
 * ## What it is NOT
 *
 * It is not a defect prediction, not a quality judgement and not evidence that
 * a file is "bad". Busy, large or intricate files are often exactly the files
 * that are supposed to be busy, large or intricate. Riftmap always labels the
 * result as *attention*, never as risk or quality.
 *
 * ## Normalisation
 *
 * Raw values are wildly skewed (a few files dominate size and churn counts), so
 * every component is converted with `log1p` and then mapped to a percentile
 * rank *within the analysed repository*. Percentile ranking is robust to
 * outliers and makes the score comparable across repositories of any size.
 *
 * Complexity is ranked **within the file's language group**, because the
 * lexical complexity estimate is not comparable between, say, TypeScript and
 * Markdown (which has no complexity estimate at all).
 *
 * ## Missing data
 *
 * A file with no Git history, or a language without a complexity estimate,
 * simply has that component marked unavailable. Its weight is redistributed
 * proportionally over the components that *are* available, so a file is never
 * penalised for data Riftmap does not have. If no component is available the
 * score is 0 and `measurable` is false.
 */

import {
  ATTENTION_BAND_LABEL,
  DEFAULT_SCORE_WEIGHTS,
  SCORE_COMPONENT_LABELS,
  type AttentionBand,
  type AttentionScore,
  type ScoreComponent,
  type ScoreWeights,
} from './model.js';

export interface ScoreInput {
  path: string;
  language: string;
  bytes: number;
  /** Estimated cyclomatic complexity, or null when unavailable. */
  cyclomatic: number | null;
  /** Commits touching the file inside the selected window. */
  changeCount: number;
  /** Distinct authors inside the window. */
  authors: number;
  /** Author concentration (0..1), or null when there is too little history. */
  contributorConcentration: number | null;
  /** Whether Git history was available at all for this repository. */
  hasGitHistory: boolean;
}

export interface ScoreOptions {
  weights?: Partial<ScoreWeights>;
  /** Score at or above this value is "high attention". */
  highThreshold?: number;
  /** Score at or above this value is "moderate attention". */
  moderateThreshold?: number;
}

const COMPONENT_ORDER: Array<ScoreComponentKeyType> = [
  'changeFrequency',
  'complexity',
  'size',
  'contributorConcentration',
];

type ScoreComponentKeyType = ScoreComponent['key'];

/**
 * Percentile rank of `value` within `values`.
 *
 * `values` need not be sorted. Ties share a rank. Returns 0.5 for a
 * single-element population so that a one-file repository does not report
 * either extreme.
 */
export function percentileRank(values: readonly number[], value: number): number {
  if (values.length === 0) return 0;
  let below = 0;
  let equal = 0;
  for (const other of values) {
    if (other < value) below += 1;
    else if (other === value) equal += 1;
  }
  return (below + 0.5 * equal) / values.length;
}

/**
 * Vectorised percentile ranks. Computes a rank lookup once and reuses it, so
 * scoring N files with M distinct values costs O(N log M) rather than O(N^2).
 */
export function percentileRankLookup(values: readonly number[]): (value: number) => number {
  if (values.length === 0) return () => 0;
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.length;
  return (value: number) => {
    let lo = 0;
    let hi = total;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid]! < value) lo = mid + 1;
      else hi = mid;
    }
    const firstEqual = lo;
    hi = total;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid]! <= value) lo = mid + 1;
      else hi = mid;
    }
    const afterEqual = lo;
    const below = firstEqual;
    const equal = afterEqual - firstEqual;
    return (below + 0.5 * equal) / total;
  };
}

function normalizeWeights(weights: Partial<ScoreWeights> | undefined): ScoreWeights {
  const merged = { ...DEFAULT_SCORE_WEIGHTS, ...(weights ?? {}) };
  const sum = COMPONENT_ORDER.reduce((acc, key) => acc + Math.max(0, merged[key] || 0), 0);
  if (sum <= 0) return { ...DEFAULT_SCORE_WEIGHTS };
  return {
    changeFrequency: Math.max(0, merged.changeFrequency) / sum,
    complexity: Math.max(0, merged.complexity) / sum,
    size: Math.max(0, merged.size) / sum,
    contributorConcentration: Math.max(0, merged.contributorConcentration) / sum,
  };
}

export function bandFor(score: number, high = 66, moderate = 33): AttentionBand {
  if (score >= high) return 'high';
  if (score >= moderate) return 'moderate';
  return 'lower';
}

export { ATTENTION_BAND_LABEL, DEFAULT_SCORE_WEIGHTS };

export interface ScoreComputation {
  /** Map from file path to score, preserving input order in `scores`. */
  byPath: Map<string, AttentionScore>;
  scores: AttentionScore[];
  weights: ScoreWeights;
  thresholds: { high: number; moderate: number };
}

/**
 * Scores every file with a single pass of normalisation.
 *
 * Complexity ranks are computed per language group; size and change-frequency
 * ranks are computed across the whole repository.
 */
export function computeAttentionScores(inputs: readonly ScoreInput[], options: ScoreOptions = {}): ScoreComputation {
  const weights = normalizeWeights(options.weights);
  const high = options.highThreshold ?? 66;
  const moderate = options.moderateThreshold ?? 33;

  const sizeRank = percentileRankLookup(inputs.map((f) => Math.log1p(Math.max(0, f.bytes))));
  const changeRank = percentileRankLookup(
    inputs.filter((f) => f.hasGitHistory).map((f) => Math.log1p(Math.max(0, f.changeCount))),
  );
  const concentrationRank = percentileRankLookup(
    inputs
      .filter((f) => f.contributorConcentration !== null)
      .map((f) => f.contributorConcentration as number),
  );

  // Complexity is only comparable within a language.
  const byLanguage = new Map<string, number[]>();
  for (const input of inputs) {
    if (input.cyclomatic === null) continue;
    const list = byLanguage.get(input.language);
    if (list) list.push(Math.log1p(Math.max(0, input.cyclomatic)));
    else byLanguage.set(input.language, [Math.log1p(Math.max(0, input.cyclomatic))]);
  }
  const complexityRanks = new Map<string, (value: number) => number>();
  for (const [language, values] of byLanguage) {
    complexityRanks.set(language, percentileRankLookup(values));
  }

  const scores: AttentionScore[] = inputs.map((input) => {
    const complexityRank = complexityRanks.get(input.language) ?? null;

    const raw: Record<ScoreComponentKeyType, number | null> = {
      changeFrequency: input.hasGitHistory ? input.changeCount : null,
      complexity: input.cyclomatic,
      size: input.bytes,
      contributorConcentration: input.contributorConcentration,
    };

    const normalized: Record<ScoreComponentKeyType, number | null> = {
      changeFrequency: input.hasGitHistory ? changeRank(Math.log1p(Math.max(0, input.changeCount))) : null,
      complexity:
        input.cyclomatic !== null && complexityRank ? complexityRank(Math.log1p(Math.max(0, input.cyclomatic))) : null,
      size: sizeRank(Math.log1p(Math.max(0, input.bytes))),
      contributorConcentration:
        input.contributorConcentration !== null ? concentrationRank(input.contributorConcentration) : null,
    };

    const unavailableReason: Partial<Record<ScoreComponentKeyType, string>> = {};
    if (!input.hasGitHistory) {
      unavailableReason.changeFrequency = 'no Git history for this repository';
      unavailableReason.contributorConcentration = 'no Git history for this repository';
    } else if (input.changeCount === 0) {
      unavailableReason.contributorConcentration = 'file has no commits in the selected window';
    } else if (input.authors < 2) {
      unavailableReason.contributorConcentration = 'only one contributor in the selected window';
    }
    if (input.cyclomatic === null) {
      unavailableReason.complexity = 'no complexity estimate for this language';
    }

    // Redistribute the weight of unavailable components proportionally.
    let availableWeight = 0;
    for (const key of COMPONENT_ORDER) {
      if (normalized[key] !== null) availableWeight += weights[key];
    }

    const components: ScoreComponent[] = COMPONENT_ORDER.map((key) => {
      const value = normalized[key];
      const available = value !== null && availableWeight > 0;
      const appliedWeight = available ? weights[key] / availableWeight : 0;
      return {
        key,
        label: SCORE_COMPONENT_LABELS[key],
        weight: weights[key],
        appliedWeight,
        normalized: available ? (value as number) : null,
        contribution: available ? (value as number) * appliedWeight * 100 : 0,
        raw: raw[key],
        rawLabel: rawLabelFor(key, raw[key]),
        available,
        ...(available ? {} : { unavailableReason: unavailableReason[key] ?? 'not measured' }),
      };
    });

    const score = components.reduce((acc, component) => acc + component.contribution, 0);
    const measurable = availableWeight > 0;

    return {
      score: measurable ? clamp(round2(score), 0, 100) : 0,
      band: bandFor(measurable ? score : 0, high, moderate),
      components,
      measurable,
    };
  });

  const byPath = new Map<string, AttentionScore>();
  inputs.forEach((input, index) => byPath.set(input.path, scores[index]!));

  return { byPath, scores, weights, thresholds: { high, moderate } };
}

function rawLabelFor(key: ScoreComponentKeyType, raw: number | null): string {
  if (raw === null) return 'n/a';
  switch (key) {
    case 'changeFrequency':
      return `${raw} ${raw === 1 ? 'commit' : 'commits'}`;
    case 'complexity':
      return `${raw} decision points`;
    case 'size':
      return `${raw} bytes`;
    case 'contributorConcentration':
      return `${Math.round(raw * 100)}% concentrated`;
    default:
      return String(raw);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Authorship concentration in 0..1.
 *
 * `1` means a single author wrote every commit in the window; `0` means
 * authorship is perfectly spread across the contributors seen. Returns `null`
 * when there is not enough history to say anything meaningful (fewer than two
 * commits, or a single contributor).
 */
export function authorshipConcentration(authorCounts: ReadonlyMap<string, number>): number | null {
  let total = 0;
  let distinct = 0;
  for (const count of authorCounts.values()) {
    if (count > 0) {
      total += count;
      distinct += 1;
    }
  }
  if (total < 2 || distinct < 2) return null;

  let entropy = 0;
  for (const count of authorCounts.values()) {
    if (count <= 0) continue;
    const p = count / total;
    entropy -= p * Math.log(p);
  }
  const max = Math.log(distinct);
  if (max <= 0) return null;
  return clamp(round2(1 - entropy / max), 0, 1);
}
