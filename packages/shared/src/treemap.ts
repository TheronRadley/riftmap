/**
 * Squarified treemap layout (Bruls, Huizing & van Wijk, 2000) plus the
 * directory tree builder that feeds it.
 *
 * Implemented here rather than pulled from a dependency because the layout has
 * to be deterministic, unit-testable and cheap enough to re-run on every
 * filter change for repositories with tens of thousands of files.
 */

import type { AnalyzedFile, DirectoryNode, DirectoryStat } from './model.js';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TreeMapItem<T> {
  value: number;
  data: T;
}

export interface TreeMapCell<T> extends Rect {
  value: number;
  data: T;
}

/** Directory path helpers. Directory paths never start or end with `/`. */
export function dirNameOf(filePath: string): string {
  const index = filePath.lastIndexOf('/');
  return index === -1 ? '' : filePath.slice(0, index);
}

export function baseNameOf(filePath: string): string {
  const index = filePath.lastIndexOf('/');
  return index === -1 ? filePath : filePath.slice(index + 1);
}

export function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  if (!name) return dir;
  return `${dir}/${name}`;
}

/**
 * Builds a nested directory tree from the engine's flat per-directory stats.
 *
 * The engine reports *direct* statistics only; this function rolls them up so
 * that every node also carries the totals for its whole subtree.
 */
export function buildDirectoryTree(
  files: readonly AnalyzedFile[],
  directories: readonly DirectoryStat[],
): DirectoryNode {
  const nodes = new Map<string, DirectoryNode>();

  const ensure = (path: string): DirectoryNode => {
    const existing = nodes.get(path);
    if (existing) return existing;
    const node: DirectoryNode = {
      path,
      name: path === '' ? '/' : baseNameOf(path) || '/',
      fileCount: 0,
      bytes: 0,
      codeLines: 0,
      totalLines: 0,
      totalFileCount: 0,
      totalBytes: 0,
      children: [],
      files: [],
    };
    nodes.set(path, node);
    if (path !== '') {
      // Recursively create every ancestor so intermediate directories that the
      // engine did not report still exist in the tree.
      const parent = ensure(dirNameOf(path));
      parent.children.push(node);
    }
    return node;
  };

  const root = ensure('');

  // Seed with the engine's per-directory statistics (may include empty dirs).
  for (const dir of directories) {
    const node = ensure(dir.path);
    node.fileCount = dir.fileCount;
    node.bytes = dir.bytes;
    node.codeLines = dir.codeLines;
    node.totalLines = dir.totalLines;
  }

  // Attach files, creating any missing directory chain as we go.
  const bytesByPath = new Map<string, number>();
  for (const file of files) bytesByPath.set(file.path, file.bytes);
  for (const file of files) {
    ensure(dirNameOf(file.path)).files.push(file.path);
  }

  // Direct stats are recomputed from the attached files so that the tree is
  // always self-consistent, even when a directory was missing from the engine
  // output or the file list is filtered by the UI.
  for (const node of nodes.values()) {
    let bytes = 0;
    for (const filePath of node.files) bytes += bytesByPath.get(filePath) ?? 0;
    node.fileCount = node.files.length;
    node.bytes = bytes;
    node.files.sort((a, b) => a.localeCompare(b));
    node.children.sort((a, b) => a.name.localeCompare(b.name));
  }

  rollUp(root);
  return root;
}

function rollUp(node: DirectoryNode): void {
  let fileCount = node.files.length;
  let bytes = node.bytes;
  for (const child of node.children) {
    rollUp(child);
    fileCount += child.totalFileCount;
    bytes += child.totalBytes;
  }
  node.totalFileCount = fileCount;
  node.totalBytes = bytes;
}

/** Depth-first list of every node, parents before children. */
export function flattenTree(node: DirectoryNode): DirectoryNode[] {
  const out: DirectoryNode[] = [node];
  for (const child of node.children) out.push(...flattenTree(child));
  return out;
}

export function findNode(root: DirectoryNode, path: string): DirectoryNode | null {
  if (root.path === path) return root;
  for (const child of root.children) {
    const found = findNode(child, path);
    if (found) return found;
  }
  return null;
}

/**
 * Squarified treemap layout.
 *
 * `items` must be sorted by descending value and contain only positive values;
 * both are enforced by the caller (`layoutTreeMap`).
 */
export function squarify<T>(items: readonly TreeMapItem<T>[], rect: Rect): Array<TreeMapCell<T>> {
  const cells: Array<TreeMapCell<T>> = [];
  const total = items.reduce((acc, item) => acc + item.value, 0);
  if (total <= 0 || rect.width <= 0 || rect.height <= 0) return cells;

  const scale = (rect.width * rect.height) / total;
  const areas = items.map((item) => ({ value: item.value * scale, data: item.data }));

  let free: Rect = { ...rect };
  let index = 0;

  while (index < areas.length) {
    const shortSide = Math.min(free.width, free.height);
    if (shortSide <= 0) break;

    // Grow the current row while it improves the worst aspect ratio.
    const row: Array<{ value: number; data: T }> = [areas[index]!];
    let rowSum = areas[index]!.value;
    let minValue = rowSum;
    let maxValue = rowSum;
    let best = worstAspect(rowSum, minValue, maxValue, shortSide);
    let next = index + 1;
    while (next < areas.length) {
      const candidateSum = rowSum + areas[next]!.value;
      const candidateMin = Math.min(minValue, areas[next]!.value);
      const candidateMax = Math.max(maxValue, areas[next]!.value);
      const candidateAspect = worstAspect(candidateSum, candidateMin, candidateMax, shortSide);
      if (candidateAspect > best) break;
      row.push(areas[next]!);
      rowSum = candidateSum;
      minValue = candidateMin;
      maxValue = candidateMax;
      best = candidateAspect;
      next += 1;
    }

    const thickness = rowSum / shortSide;
    let offset = 0;
    const stackAlongHeight = free.width >= free.height;
    for (const item of row) {
      const extent = thickness > 0 ? item.value / thickness : 0;
      if (stackAlongHeight) {
        cells.push({
          x: free.x,
          y: free.y + offset,
          width: thickness,
          height: extent,
          value: item.value / scale,
          data: item.data,
        });
      } else {
        cells.push({
          x: free.x + offset,
          y: free.y,
          width: extent,
          height: thickness,
          value: item.value / scale,
          data: item.data,
        });
      }
      offset += extent;
    }

    if (stackAlongHeight) {
      free = { x: free.x + thickness, y: free.y, width: Math.max(0, free.width - thickness), height: free.height };
    } else {
      free = { x: free.x, y: free.y + thickness, width: free.width, height: Math.max(0, free.height - thickness) };
    }

    index = next;
  }

  return cells;
}

/**
 * Worst aspect ratio in a row, computed in closed form so that growing a row
 * costs O(1) instead of re-scanning it.
 */
function worstAspect(rowSum: number, minValue: number, maxValue: number, side: number): number {
  if (rowSum <= 0 || side <= 0 || minValue <= 0) return Number.POSITIVE_INFINITY;
  const side2 = side * side;
  const sum2 = rowSum * rowSum;
  return Math.max(sum2 / (side2 * minValue), (side2 * maxValue) / sum2);
}

export interface TreeMapOptions<T> {
  value: (item: T) => number;
  /** Nodes smaller than this many pixels on both axes are dropped. */
  minCellSize?: number;
}

/**
 * Sorts by value, drops non-positive and (optionally) invisible entries, then
 * lays the remainder out inside `rect`.
 */
export function layoutTreeMap<T>(items: readonly T[], rect: Rect, options: TreeMapOptions<T>): Array<TreeMapCell<T>> {
  const prepared: Array<TreeMapItem<T>> = [];
  for (const item of items) {
    const value = options.value(item);
    if (value > 0) prepared.push({ value, data: item });
  }
  prepared.sort((a, b) => b.value - a.value || 0);
  const cells = squarify(prepared, rect);
  const min = options.minCellSize ?? 0;
  if (min <= 0) return cells;
  return cells.filter((cell) => cell.width >= min && cell.height >= min);
}
