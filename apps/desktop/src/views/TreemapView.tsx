/**
 * Codebase treemap.
 *
 * Nested directories, area proportional to source bytes. Click a directory to
 * drill into it, use the breadcrumb to come back. The layout is the shared
 * squarified implementation in `@riftmap/shared`, so it is deterministic and
 * unit-tested; rendering is plain SVG with cells below a size threshold
 * dropped, which keeps very large repositories responsive.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  buildDirectoryTree,
  findNode,
  formatBytes,
  layoutTreeMap,
  type DirectoryNode,
  type TreeMapCell,
} from '@riftmap/shared';
import type { AnalyzedFile } from '@riftmap/shared';
import { useApp } from '../state/store.js';
import { useElementSize } from '../hooks/useElementSize.js';
import { EmptyState, Panel, cx } from '../components/primitives.js';
import { BAND_COLOR } from '../components/primitives.js';
import { FilterBar, Toggle, useFilteredFiles } from '../components/FilterBar.js';
import { DetailsPanel } from '../components/DetailsPanel.js';

type Cell =
  | { kind: 'file'; path: string; value: number; file: AnalyzedFile }
  | { kind: 'dir'; path: string; value: number; node: DirectoryNode };

const MIN_CELL = 3;

export function TreemapView(): JSX.Element {
  const { analysis, selectedPath, select } = useApp();
  const files = analysis?.files ?? [];
  const filtered = useFilteredFiles(files);
  const [containerRef, size] = useElementSize<HTMLDivElement>();
  const [focus, setFocus] = useState<string>('');
  const [colorBy, setColorBy] = useState<'attention' | 'language' | 'changes'>('attention');
  const [hovered, setHovered] = useState<Cell | null>(null);

  // Reset the drill-down whenever the analysed repository changes.
  useEffect(() => {
    setFocus('');
  }, [analysis?.repository.path, analysis?.repository.analyzedAt]);

  const tree = useMemo(() => {
    if (!analysis) return null;
    return buildDirectoryTree(filtered, analysis.directories);
  }, [analysis, filtered]);

  const current = useMemo(() => {
    if (!tree) return null;
    if (focus === '') return tree;
    return findNode(tree, focus) ?? tree;
  }, [tree, focus]);

  const cells = useMemo<TreeMapCell<Cell>[]>(() => {
    if (!current) return [];
    const width = Math.max(120, size.width);
    const height = Math.max(120, size.height);
    const items: Cell[] = [
      ...current.children.map<Cell>((child) => ({
        kind: 'dir',
        path: child.path,
        value: Math.max(1, child.totalBytes),
        node: child,
      })),
      ...current.files.map<Cell>((path) => {
        const file = filtered.find((candidate) => candidate.path === path);
        return { kind: 'file', path, value: Math.max(1, file?.bytes ?? 1), file: file as AnalyzedFile };
      }),
    ].filter((item) => (item.kind === 'file' ? Boolean(item.file) : true));

    return layoutTreeMap(items, { x: 0, y: 0, width, height }, { value: (item) => item.value, minCellSize: MIN_CELL });
  }, [current, filtered, size.width, size.height]);

  const languageColors = useMemo(() => {
    const palette = ['#22d3ee', '#a78bfa', '#34d399', '#f472b6', '#fbbf24', '#60a5fa', '#f87171', '#4ade80'];
    const map = new Map<string, string>();
    (analysis?.languages ?? []).forEach((language, index) => {
      map.set(language.id, palette[index % palette.length] ?? '#22d3ee');
    });
    return map;
  }, [analysis]);

  const selected = useMemo(
    () => (analysis ? (analysis.files.find((file) => file.path === selectedPath) ?? null) : null),
    [analysis, selectedPath],
  );

  const breadcrumbs = useMemo(() => {
    if (!tree || !current) return [];
    const parts = current.path === '' ? [] : current.path.split('/');
    const trail: Array<{ path: string; label: string }> = [{ path: '', label: tree.name || 'root' }];
    let accumulated = '';
    for (const part of parts) {
      accumulated = accumulated ? `${accumulated}/${part}` : part;
      trail.push({ path: accumulated, label: part });
    }
    return trail;
  }, [tree, current]);

  if (!analysis || !tree || !current) {
    return (
      <div className="p-6">
        <EmptyState title="No repository analysed yet" description="Open a folder to see its structure." />
      </div>
    );
  }

  const dropped = Math.max(
    0,
    current.files.length + current.children.length - cells.length,
  );

  return (
    <div className="flex min-h-0 flex-col">
      <FilterBar
        files={files}
        showBand={false}
        showMinChanges={false}
        extra={
          <div className="ml-auto">
            <Toggle
              label="Colour by"
              value={colorBy}
              onChange={(value) => setColorBy(value as typeof colorBy)}
              options={[
                { value: 'attention', label: 'Attention', hint: 'Colour by attention band' },
                { value: 'language', label: 'Language', hint: 'Colour by language' },
                { value: 'changes', label: 'Changes', hint: 'Colour by change frequency' },
              ]}
            />
          </div>
        }
      />

      <nav className="flex flex-wrap items-center gap-1 border-b border-graphite-800 bg-graphite-900/60 px-4 py-2 text-2xs" aria-label="Breadcrumb">
        {breadcrumbs.map((crumb, index) => (
          <span key={crumb.path || 'root'} className="flex items-center gap-1">
            {index > 0 ? <span className="text-graphite-600">/</span> : null}
            <button
              type="button"
              className={cx(
                'rounded px-1 py-0.5 font-mono',
                index === breadcrumbs.length - 1 ? 'text-graphite-100' : 'text-graphite-400 hover:text-accent',
              )}
              onClick={() => setFocus(crumb.path)}
              disabled={index === breadcrumbs.length - 1}
            >
              {crumb.label}
            </button>
          </span>
        ))}
        <span className="ml-auto text-graphite-500">
          {formatBytes(current.totalBytes)} · {current.totalFileCount} files (subtree)
        </span>
      </nav>

      <div className="grid min-h-0 flex-1 gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Panel
          title="Size map"
          note="Area = source bytes. Click a directory to drill in; click a file to inspect it."
          className="min-h-[26rem]"
          bodyClassName="relative min-h-0"
        >
          <div ref={containerRef} className="absolute inset-0">
            {size.width > 0 ? (
              <svg width={size.width} height={size.height} role="img" aria-label={`Treemap of ${current.path || 'the repository root'}`}>
                {cells.map((cell) => {
                  const data = cell.data;
                  const fill = cellColor(data, colorBy, languageColors);
                  const isSelected = data.kind === 'file' && data.path === selectedPath;
                  return (
                    <g key={`${data.kind}-${data.path}`}>
                      <rect
                        x={cell.x}
                        y={cell.y}
                        width={Math.max(0, cell.width - 1)}
                        height={Math.max(0, cell.height - 1)}
                        fill={fill}
                        fillOpacity={data.kind === 'dir' ? 0.18 : 0.5}
                        stroke={isSelected ? '#67e8f9' : fill}
                        strokeWidth={isSelected ? 2 : 1}
                        className={data.kind === 'dir' ? 'cursor-zoom-in' : 'cursor-pointer'}
                        onMouseEnter={() => setHovered(data)}
                        onMouseLeave={() => setHovered((value) => (value === data ? null : value))}
                        onClick={() => (data.kind === 'dir' ? setFocus(data.path) : select(data.path))}
                      >
                        <title>
                          {data.kind === 'dir'
                            ? `${data.path}\n${data.node.totalFileCount} files · ${formatBytes(data.node.totalBytes)}`
                            : `${data.path}\n${formatBytes(data.file.bytes)} · score ${data.file.score.score.toFixed(0)}`}
                        </title>
                      </rect>
                      {cell.width > 60 && cell.height > 16 ? (
                        <text
                          x={cell.x + 4}
                          y={cell.y + 13}
                          fill="#e7ebf1"
                          fontSize={10}
                          className="pointer-events-none select-none"
                          style={{ fontFamily: 'ui-monospace, monospace' }}
                        >
                          {truncate(data.kind === 'dir' ? data.node.name : data.file.name, Math.floor(cell.width / 6))}
                        </text>
                      ) : null}
                    </g>
                  );
                })}
              </svg>
            ) : null}
          </div>
          {hovered ? (
            <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-graphite-700 bg-graphite-950/95 px-3 py-2 text-2xs">
              <p className="font-mono text-graphite-100">{hovered.path}</p>
              {hovered.kind === 'file' ? (
                <p className="mt-0.5 text-graphite-400">
                  {formatBytes(hovered.file.bytes)} · {hovered.file.lines} lines · score{' '}
                  {hovered.file.score.score.toFixed(0)} · {hovered.file.git?.changeCount ?? 0} changes
                </p>
              ) : (
                <p className="mt-0.5 text-graphite-400">
                  {hovered.node.totalFileCount} files · {formatBytes(hovered.node.totalBytes)} · click to drill in
                </p>
              )}
            </div>
          ) : null}
          {dropped > 0 ? (
            <p className="pointer-events-none absolute bottom-3 right-3 text-2xs text-graphite-500">
              {dropped} cells too small to draw at this size
            </p>
          ) : null}
        </Panel>

        <div className="min-h-0 overflow-auto">
          <DetailsPanel file={selected} analysis={analysis} />
        </div>
      </div>
    </div>
  );
}

function cellColor(
  cell: Cell,
  mode: 'attention' | 'language' | 'changes',
  languageColors: Map<string, string>,
): string {
  if (cell.kind === 'dir') return mode === 'language' ? '#55606f' : BAND_COLOR.moderate;
  if (mode === 'language') return languageColors.get(cell.file.language) ?? '#55606f';
  if (mode === 'changes') {
    const changes = cell.file.git?.changeCount ?? 0;
    if (changes === 0) return '#3a4350';
    // Blues through cyan: more activity reads as brighter.
    const t = Math.min(1, Math.log10(changes + 1) / Math.log10(60));
    return mix('#2a313a', '#f59e0b', t);
  }
  return BAND_COLOR[cell.file.score.band];
}

function mix(from: string, to: string, t: number): string {
  const parse = (hex: string) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
  const [r1, g1, b1] = parse(from);
  const [r2, g2, b2] = parse(to);
  const channel = (a: number, b: number) => Math.round(a + (b - a) * t);
  return `rgb(${channel(r1 ?? 0, r2 ?? 0)}, ${channel(g1 ?? 0, g2 ?? 0)}, ${channel(b1 ?? 0, b2 ?? 0)})`;
}

function truncate(value: string, max: number): string {
  if (max <= 1) return '';
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(1, max - 1))}…`;
}
