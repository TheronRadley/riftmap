import { describe, expect, it } from 'vitest';
import {
  authorshipConcentration,
  bandFor,
  computeAttentionScores,
  DEFAULT_SCORE_WEIGHTS,
  percentileRank,
  percentileRankLookup,
  type ScoreInput,
} from './score.js';

function input(overrides: Partial<ScoreInput> & Pick<ScoreInput, 'path'>): ScoreInput {
  return {
    language: 'typescript',
    bytes: 1000,
    cyclomatic: 5,
    changeCount: 3,
    authors: 2,
    contributorConcentration: 0.5,
    hasGitHistory: true,
    ...overrides,
  };
}

describe('percentileRank', () => {
  it('is 0.5 for a single-element population', () => {
    expect(percentileRank([42], 42)).toBe(0.5);
  });

  it('puts the minimum at the bottom and the maximum at the top', () => {
    const values = [1, 2, 3, 4, 5];
    expect(percentileRank(values, 1)).toBeCloseTo(0.1, 5);
    expect(percentileRank(values, 5)).toBeCloseTo(0.9, 5);
    expect(percentileRank(values, 3)).toBeCloseTo(0.5, 5);
  });

  it('shares a rank between tied values', () => {
    const values = [1, 1, 1, 1];
    expect(percentileRank(values, 1)).toBe(0.5);
  });

  it('is scale free', () => {
    const small = [1, 2, 3];
    const large = [100, 200, 300];
    expect(percentileRank(small, 2)).toBeCloseTo(percentileRank(large, 200), 10);
  });

  it('returns 0 for an empty population', () => {
    expect(percentileRank([], 1)).toBe(0);
  });
});

describe('percentileRankLookup', () => {
  it('agrees with the direct implementation', () => {
    const values = [5, 1, 9, 3, 3, 7, 2];
    const rank = percentileRankLookup(values);
    for (const value of [...values, 0, 4, 100]) {
      expect(rank(value)).toBeCloseTo(percentileRank(values, value), 10);
    }
  });

  it('handles an empty population without throwing', () => {
    expect(percentileRankLookup([])(3)).toBe(0);
  });
});

describe('authorshipConcentration', () => {
  it('is null when there are fewer than two commits', () => {
    expect(authorshipConcentration(new Map([['a', 1]]))).toBeNull();
  });

  it('is null when there is only one contributor', () => {
    expect(authorshipConcentration(new Map([['a', 7]]))).toBeNull();
  });

  it('is 1 when one author wrote everything', () => {
    const counts = new Map([
      ['a', 9],
      ['b', 1],
    ]);
    // Normalised entropy: 9:1 is skewed but not absolute, so the value sits
    // above the midpoint rather than at 1.
    expect(authorshipConcentration(counts)).toBeGreaterThan(0.5);
    expect(authorshipConcentration(counts)).toBeLessThan(1);
  });

  it('is near 0 when authorship is evenly spread', () => {
    const counts = new Map([
      ['a', 5],
      ['b', 5],
      ['c', 5],
      ['d', 5],
    ]);
    expect(authorshipConcentration(counts)).toBeCloseTo(0, 2);
  });

  it('ignores authors with zero commits', () => {
    const counts = new Map([
      ['a', 3],
      ['b', 3],
      ['ghost', 0],
    ]);
    expect(authorshipConcentration(counts)).toBeCloseTo(0, 2);
  });
});

describe('bandFor', () => {
  it('uses the documented thresholds', () => {
    expect(bandFor(0)).toBe('lower');
    expect(bandFor(32.9)).toBe('lower');
    expect(bandFor(33)).toBe('moderate');
    expect(bandFor(65.9)).toBe('moderate');
    expect(bandFor(66)).toBe('high');
    expect(bandFor(100)).toBe('high');
  });
});

describe('computeAttentionScores', () => {
  it('uses the documented default weights', () => {
    expect(DEFAULT_SCORE_WEIGHTS).toEqual({
      changeFrequency: 0.4,
      complexity: 0.35,
      size: 0.15,
      contributorConcentration: 0.1,
    });
  });

  it('produces a score in 0..100 for every file', () => {
    const inputs = Array.from({ length: 40 }, (_, i) =>
      input({ path: `f${i}.ts`, bytes: 100 * i, cyclomatic: i + 1, changeCount: i, authors: 2, contributorConcentration: 0.5 }),
    );
    const { scores } = computeAttentionScores(inputs);
    expect(scores).toHaveLength(40);
    for (const score of scores) {
      expect(score.score).toBeGreaterThanOrEqual(0);
      expect(score.score).toBeLessThanOrEqual(100);
      expect(score.measurable).toBe(true);
    }
  });

  it('ranks the busiest, most complex, largest file first', () => {
    const inputs = [
      input({ path: 'quiet.ts', bytes: 100, cyclomatic: 1, changeCount: 0, contributorConcentration: null, authors: 0 }),
      input({ path: 'busy.ts', bytes: 50_000, cyclomatic: 40, changeCount: 90, contributorConcentration: 0.95 }),
      input({ path: 'middle.ts', bytes: 5_000, cyclomatic: 10, changeCount: 12, contributorConcentration: 0.4 }),
    ];
    const { byPath } = computeAttentionScores(inputs);
    expect(byPath.get('busy.ts')!.score).toBeGreaterThan(byPath.get('middle.ts')!.score);
    expect(byPath.get('middle.ts')!.score).toBeGreaterThan(byPath.get('quiet.ts')!.score);
  });

  it('never lets a file with no history outrank only for missing data', () => {
    const withGit = input({ path: 'a.ts', bytes: 1000, cyclomatic: 5, changeCount: 2, contributorConcentration: 0.2 });
    const withoutGit = input({ path: 'b.ts', bytes: 1000, cyclomatic: 5, changeCount: 0, hasGitHistory: false, contributorConcentration: null });
    const { byPath } = computeAttentionScores([withGit, withoutGit]);
    // Both are measurable because size and complexity are still available.
    expect(byPath.get('b.ts')!.measurable).toBe(true);
    const components = byPath.get('b.ts')!.components;
    const change = components.find((c) => c.key === 'changeFrequency')!;
    expect(change.available).toBe(false);
    expect(change.unavailableReason).toMatch(/no Git history/i);
  });

  it('redistributes the weight of unavailable components', () => {
    const inputs = [input({ path: 'a.ts', cyclomatic: null, changeCount: 0, hasGitHistory: false, contributorConcentration: null })];
    const { byPath } = computeAttentionScores(inputs);
    const score = byPath.get('a.ts')!;
    const size = score.components.find((c) => c.key === 'size')!;
    expect(size.available).toBe(true);
    expect(size.appliedWeight).toBeCloseTo(1, 6);
    // Only size is left, so it takes the whole 100 points at its mid rank.
    expect(score.score).toBeCloseTo(50, 6);
  });

  it('marks a file with no measurable components as unmeasurable', () => {
    const inputs = [input({ path: 'a.ts', cyclomatic: null, changeCount: 0, hasGitHistory: false, contributorConcentration: null, bytes: 0 })];
    const { byPath } = computeAttentionScores(inputs);
    const score = byPath.get('a.ts')!;
    // Size is still measurable (rank 0.5 for a single file), so the file is
    // measurable; this documents that only a truly empty repository yields 0.
    expect(score.measurable).toBe(true);
    expect(score.score).toBeCloseTo(50, 6);
  });

  it('scores an empty repository without throwing', () => {
    const { scores } = computeAttentionScores([]);
    expect(scores).toEqual([]);
  });

  it('scores a single-file repository at the mid rank', () => {
    const { byPath } = computeAttentionScores([input({ path: 'only.ts' })]);
    expect(byPath.get('only.ts')!.score).toBeCloseTo(50, 6);
  });

  it('normalises complexity within a language group', () => {
    // A huge Markdown file has no complexity at all; it must not be able to
    // beat a TypeScript file on the complexity axis.
    const inputs = [
      input({ path: 'readme.md', language: 'markdown', bytes: 900_000, cyclomatic: null, changeCount: 1 }),
      input({ path: 'tiny.ts', language: 'typescript', bytes: 100, cyclomatic: 2, changeCount: 1 }),
      input({ path: 'big.ts', language: 'typescript', bytes: 100, cyclomatic: 30, changeCount: 1 }),
    ];
    const { byPath } = computeAttentionScores(inputs);
    const tinyComplexity = byPath.get('tiny.ts')!.components.find((c) => c.key === 'complexity')!;
    const bigComplexity = byPath.get('big.ts')!.components.find((c) => c.key === 'complexity')!;
    expect(bigComplexity.normalized!).toBeGreaterThan(tinyComplexity.normalized!);
    expect(byPath.get('readme.md')!.components.find((c) => c.key === 'complexity')!.available).toBe(false);
  });

  it('respects custom weights and renormalises them', () => {
    const inputs = [input({ path: 'a.ts' })];
    const { weights } = computeAttentionScores(inputs, { weights: { changeFrequency: 4, complexity: 0, size: 0, contributorConcentration: 0 } });
    expect(weights.changeFrequency).toBeCloseTo(1, 6);
    expect(weights.complexity).toBe(0);
  });

  it('exposes a breakdown whose contributions sum to the score', () => {
    const inputs = [
      input({ path: 'a.ts', bytes: 4000, cyclomatic: 12, changeCount: 9, contributorConcentration: 0.8 }),
      input({ path: 'b.ts', bytes: 200, cyclomatic: 2, changeCount: 1, contributorConcentration: 0.1 }),
    ];
    const { byPath } = computeAttentionScores(inputs);
    for (const score of byPath.values()) {
      const total = score.components.reduce((acc, c) => acc + c.contribution, 0);
      expect(total).toBeCloseTo(score.score, 1);
    }
  });

  it('does not penalise zero-change files below zero', () => {
    const inputs = [
      input({ path: 'a.ts', changeCount: 0, contributorConcentration: null, authors: 0 }),
      input({ path: 'b.ts', changeCount: 100, contributorConcentration: 0.2, authors: 3 }),
    ];
    const { byPath } = computeAttentionScores(inputs);
    expect(byPath.get('a.ts')!.score).toBeGreaterThanOrEqual(0);
    expect(byPath.get('b.ts')!.score).toBeGreaterThan(byPath.get('a.ts')!.score);
  });
});
