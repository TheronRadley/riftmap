import { describe, expect, it } from 'vitest';
import {
  baseNameOf,
  buildDirectoryTree,
  dirNameOf,
  findNode,
  flattenTree,
  joinPath,
  layoutTreeMap,
  squarify,
  type Rect,
} from './treemap.js';
import type { AnalyzedFile, DirectoryStat } from './model.js';

const RECT: Rect = { x: 0, y: 0, width: 800, height: 600 };

describe('path helpers', () => {
  it('splits paths on the last separator', () => {
    expect(dirNameOf('src/app/main.ts')).toBe('src/app');
    expect(dirNameOf('main.ts')).toBe('');
    expect(baseNameOf('src/app/main.ts')).toBe('main.ts');
    expect(baseNameOf('main.ts')).toBe('main.ts');
  });

  it('joins without duplicating separators', () => {
    expect(joinPath('', 'main.ts')).toBe('main.ts');
    expect(joinPath('src', 'main.ts')).toBe('src/main.ts');
    expect(joinPath('src', '')).toBe('src');
  });
});

describe('squarify', () => {
  it('returns no cells for an empty input', () => {
    expect(squarify([], RECT)).toEqual([]);
  });

  it('fills a single item completely', () => {
    const cells = squarify([{ value: 10, data: 'a' }], RECT);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.width).toBeCloseTo(800, 6);
    expect(cells[0]!.height).toBeCloseTo(600, 6);
  });

  it('never overlaps and stays inside the rectangle', () => {
    const items = [40, 25, 15, 10, 6, 4].map((value, index) => ({ value, data: index }));
    const cells = squarify(items, RECT);
    expect(cells).toHaveLength(6);
    for (const cell of cells) {
      expect(cell.x).toBeGreaterThanOrEqual(-1e-9);
      expect(cell.y).toBeGreaterThanOrEqual(-1e-9);
      expect(cell.x + cell.width).toBeLessThanOrEqual(RECT.width + 1e-6);
      expect(cell.y + cell.height).toBeLessThanOrEqual(RECT.height + 1e-6);
    }
    for (let i = 0; i < cells.length; i += 1) {
      for (let j = i + 1; j < cells.length; j += 1) {
        const a = cells[i]!;
        const b = cells[j]!;
        const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        // Overlaps of at most a floating-point epsilon are acceptable.
        expect(Math.min(overlapX, overlapY)).toBeLessThan(1e-6);
      }
    }
  });

  it('preserves area proportionally', () => {
    const values = [50, 30, 12, 8];
    const cells = squarify(values.map((value, index) => ({ value, data: index })), RECT);
    const totalArea = RECT.width * RECT.height;
    cells.forEach((cell, index) => {
      const expected = (values[index]! / 100) * totalArea;
      expect(cell.width * cell.height).toBeCloseTo(expected, 3);
    });
  });

  it('produces reasonably square cells for a power-law distribution', () => {
    const values = [1000, 500, 250, 120, 60, 30, 15, 8, 4, 2, 1];
    const cells = squarify(values.map((value, index) => ({ value, data: index })), RECT);
    for (const cell of cells) {
      const aspect = Math.max(cell.width / cell.height, cell.height / cell.width);
      expect(aspect).toBeLessThan(12);
    }
  });

  it('handles degenerate rectangles without throwing', () => {
    expect(squarify([{ value: 1, data: 'a' }], { x: 0, y: 0, width: 0, height: 0 })).toEqual([]);
    expect(squarify([{ value: 1, data: 'a' }], { x: 0, y: 0, width: -5, height: 10 })).toEqual([]);
  });

  it('ignores zero and negative values via layoutTreeMap', () => {
    const cells = layoutTreeMap([{ v: 10 }, { v: 0 }, { v: -3 }, { v: 5 }], RECT, {
      value: (item) => item.v,
    });
    expect(cells).toHaveLength(2);
  });

  it('drops cells below the minimum size', () => {
    const cells = layoutTreeMap([1000, 999, 1, 1, 1, 1].map((v) => ({ v })), RECT, {
      value: (item) => item.v,
      minCellSize: 20,
    });
    expect(cells.length).toBeLessThan(6);
    expect(cells.length).toBeGreaterThan(0);
  });
});

function file(path: string, bytes: number): AnalyzedFile {
  return {
    path,
    name: baseNameOf(path),
    dir: dirNameOf(path),
    ext: 'ts',
    language: 'typescript',
    languageName: 'TypeScript',
    bytes,
    lines: Math.max(1, Math.round(bytes / 20)),
    codeLines: 1,
    blankLines: 0,
    commentLines: 0,
    cyclomatic: 1,
    branchCount: 0,
    loopCount: 0,
    logicalCount: 0,
    maxNesting: 0,
    functionCount: 0,
    tokenCount: 1,
    complexityAvailable: true,
    importsAvailable: true,
    contentScanned: true,
    importCount: 0,
    resolvedImportCount: 0,
    git: null,
    score: { score: 0, band: 'lower', components: [], measurable: false },
    dependentCount: 0,
    dependencyCount: 0,
  };
}

describe('buildDirectoryTree', () => {
  const files = [
    file('src/a.ts', 100),
    file('src/b.ts', 200),
    file('src/deep/c.ts', 50),
    file('README.md', 10),
  ];
  const directories: DirectoryStat[] = [
    { path: '', name: '/', fileCount: 1, bytes: 10, codeLines: 1, totalLines: 1 },
    { path: 'src', name: 'src', fileCount: 2, bytes: 300, codeLines: 2, totalLines: 2 },
    { path: 'src/deep', name: 'deep', fileCount: 1, bytes: 50, codeLines: 1, totalLines: 1 },
  ];

  it('creates a root node', () => {
    const tree = buildDirectoryTree(files, directories);
    expect(tree.path).toBe('');
    expect(tree.name).toBe('/');
  });

  it('rolls subtree totals up', () => {
    const tree = buildDirectoryTree(files, directories);
    expect(tree.totalFileCount).toBe(4);
    expect(tree.totalBytes).toBe(360);
    const src = findNode(tree, 'src')!;
    expect(src.totalFileCount).toBe(3);
    expect(src.totalBytes).toBe(350);
    expect(src.fileCount).toBe(2); // direct children only
  });

  it('attaches files to the right directory', () => {
    const tree = buildDirectoryTree(files, directories);
    expect(findNode(tree, 'src')!.files).toEqual(['src/a.ts', 'src/b.ts']);
    expect(findNode(tree, 'src/deep')!.files).toEqual(['src/deep/c.ts']);
    expect(tree.files).toEqual(['README.md']);
  });

  it('creates missing intermediate directories', () => {
    const tree = buildDirectoryTree([file('a/b/c/d.ts', 5)], []);
    expect(findNode(tree, 'a')).not.toBeNull();
    expect(findNode(tree, 'a/b')).not.toBeNull();
    expect(findNode(tree, 'a/b/c')).not.toBeNull();
    expect(tree.totalFileCount).toBe(1);
  });

  it('handles a flat repository', () => {
    const tree = buildDirectoryTree([file('main.ts', 10), file('other.ts', 20)], []);
    expect(tree.children).toHaveLength(0);
    expect(tree.totalFileCount).toBe(2);
  });

  it('handles an empty repository', () => {
    const tree = buildDirectoryTree([], []);
    expect(tree.totalFileCount).toBe(0);
    expect(tree.children).toHaveLength(0);
  });

  it('flattens parents before children', () => {
    const tree = buildDirectoryTree(files, directories);
    const flat = flattenTree(tree);
    expect(flat[0]!.path).toBe('');
    expect(flat.map((node) => node.path)).toContain('src');
    expect(flat.map((node) => node.path)).toContain('src/deep');
    expect(flat.findIndex((n) => n.path === 'src')).toBeLessThan(flat.findIndex((n) => n.path === 'src/deep'));
  });

  it('returns null for a missing node', () => {
    const tree = buildDirectoryTree(files, directories);
    expect(findNode(tree, 'nope')).toBeNull();
  });
});
