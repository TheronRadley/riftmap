/**
 * Hotspot Explorer - the flagship view.
 *
 * X = change frequency (commits in the selected window)
 * Y = estimated complexity (cyclomatic)
 * Bubble area = file size
 * Colour = attention band
 *
 * The scatter is drawn as plain SVG so it stays fast for thousands of files,
 * and every point is also listed in a real table (the "Table" toggle) so the
 * same information is reachable with a keyboard or a screen reader.
 */

import { useMemo, useState } from 'react';
import { ATTENTION_BAND_LABEL, formatBytes, formatCount, formatRelative } from '@riftmap/shared';
import type { AnalyzedFile } from '@riftmap/shared';
import { useApp } from '../state/store.js';
import { useElementSize } from '../hooks/useElementSize.js';
import { BandPill, EmptyState, Panel, ScoreBadge, cx } from '../components/primitives.js';
import { BAND_COLOR } from '../components/primitives.js';
import { FilterBar, Toggle, useFilteredFiles } from '../components/FilterBar.js';
import { DetailsPanel } from '../components/DetailsPanel.js';

const MARGIN = { top: 16, right: 20, bottom: 46, left: 56 };
const MIN_R = 3;
const MAX_R = 26;

export function HotspotsView(): JSX.Element {
  const { analysis, selectedPath, select } = useApp();
  const [mode, setMode] = useState<'chart' | 'table'>('chart');
  const [hovered, setHovered] = useState<AnalyzedFile | null>(null);
  const [containerRef, size] = useElementSize<HTMLDivElement>();

  const files = analysis?.files ?? [];
  const filtered = useFilteredFiles(files);

  const points = useMemo(() => {
    const maxBytes = Math.max(1, ...filtered.map((file) => file.bytes));
    return filtered.map((file) => ({
      file,
      x: file.git?.changeCount ?? 0,
      y: Math.max(1, file.cyclomatic ?? 1),
      // Area is proportional to size, so radius follows a square root.
      r: MIN_R + (MAX_R - MIN_R) * Math.sqrt(file.bytes / maxBytes),
    }));
  }, [filtered]);

  const scales = useMemo(() => {
    const maxX = Math.max(2, ...points.map((point) => point.x));
    const maxY = Math.max(2, ...points.map((point) => point.y));
    // Both axes are logarithmic: change counts and complexity are heavily
    // right-skewed, and a linear axis would crush most files into a corner.
    // `log10(v + 1)` keeps files with zero commits in the window on the axis.
    const xDenominator = Math.log10(maxX + 1) || 1;
    const yDenominator = Math.log10(maxY * 1.1) || 1;
    return {
      maxX,
      maxY,
      xOf: (value: number) => Math.log10(value + 1) / xDenominator,
      yOf: (value: number) => Math.log10(value) / yDenominator,
    };
  }, [points]);

  const width = Math.max(320, size.width);
  const height = Math.max(320, size.height);
  const plotWidth = Math.max(10, width - MARGIN.left - MARGIN.right);
  const plotHeight = Math.max(10, height - MARGIN.top - MARGIN.bottom);

  const sorted = useMemo(
    () => [...filtered].sort((a, b) => b.score.score - a.score.score),
    [filtered],
  );

  const selected = useMemo(
    () => (analysis ? (analysis.files.find((file) => file.path === selectedPath) ?? null) : null),
    [analysis, selectedPath],
  );

  if (!analysis) {
    return (
      <div className="p-6">
        <EmptyState title="No repository analysed yet" description="Open a folder to explore its hotspots." />
      </div>
    );
  }

  const xTicks = buildChangeTicks(scales.maxX);
  const yTicks = buildTicks(scales.maxY);

  return (
    <div className="flex min-h-0 flex-col">
      <FilterBar
        files={files}
        extra={
          <div className="ml-auto">
            <Toggle
              label="Presentation"
              value={mode}
              onChange={(value) => setMode(value as 'chart' | 'table')}
              options={[
                { value: 'chart', label: 'Chart', hint: 'Scatter plot' },
                { value: 'table', label: 'Table', hint: 'Accessible table of the same data' },
              ]}
            />
          </div>
        }
      />

      <div className="grid min-h-0 flex-1 gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Panel
          title="Attention map"
          note={`${formatCount(filtered.length)} of ${formatCount(files.length)} files · X change frequency (log) · Y estimated complexity (log) · area file size · colour attention band`}
          className="min-h-[26rem]"
          bodyClassName="flex min-h-0 flex-col"
          actions={
            <div className="flex items-center gap-2">
              {(Object.keys(ATTENTION_BAND_LABEL) as Array<keyof typeof ATTENTION_BAND_LABEL>).map((band) => (
                <span key={band} className="inline-flex items-center gap-1 text-2xs text-graphite-400">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: BAND_COLOR[band] }} />
                  {ATTENTION_BAND_LABEL[band]}
                </span>
              ))}
            </div>
          }
        >
          {mode === 'chart' ? (
            <div ref={containerRef} className="relative min-h-0 flex-1">
              {size.width > 0 ? (
                <svg
                  width={width}
                  height={height}
                  role="img"
                  aria-label={`Scatter plot of ${filtered.length} files: change frequency against estimated complexity`}
                >
                  {/* grid + ticks */}
                  {xTicks.map((tick) => {
                    const px = MARGIN.left + scales.xOf(tick) * plotWidth;
                    return (
                      <g key={`x-${tick}`}>
                        <line x1={px} y1={MARGIN.top} x2={px} y2={MARGIN.top + plotHeight} stroke="#22282f" />
                        <text x={px} y={MARGIN.top + plotHeight + 16} fill="#7c879a" fontSize={10} textAnchor="middle">
                          {tick}
                        </text>
                      </g>
                    );
                  })}
                  {yTicks.map((tick) => {
                    const py = MARGIN.top + plotHeight - scales.yOf(tick) * plotHeight;
                    return (
                      <g key={`y-${tick}`}>
                        <line x1={MARGIN.left} y1={py} x2={MARGIN.left + plotWidth} y2={py} stroke="#22282f" />
                        <text x={MARGIN.left - 8} y={py + 3} fill="#7c879a" fontSize={10} textAnchor="end">
                          {tick}
                        </text>
                      </g>
                    );
                  })}
                  <text
                    x={MARGIN.left + plotWidth / 2}
                    y={height - 8}
                    fill="#a6b0c0"
                    fontSize={11}
                    textAnchor="middle"
                  >
                    Commits in the selected window (log scale; 0 = none in window)
                  </text>
                  <text
                    x={14}
                    y={MARGIN.top + plotHeight / 2}
                    fill="#a6b0c0"
                    fontSize={11}
                    textAnchor="middle"
                    transform={`rotate(-90, 14, ${MARGIN.top + plotHeight / 2})`}
                  >
                    Estimated cyclomatic complexity (log scale)
                  </text>
                  {/* "1 commit" is x=1 -> log10(1)=0, so files with no history
                      sit on the left edge and are drawn as hollow rings. */}
                  {points.map((point) => {
                    const cxPos = MARGIN.left + scales.xOf(point.x) * plotWidth;
                    const cyPos = MARGIN.top + plotHeight - scales.yOf(point.y) * plotHeight;
                    const isSelected = point.file.path === selectedPath;
                    const hasHistory = (point.file.git?.changeCount ?? 0) > 0;
                    return (
                      <circle
                        key={point.file.path}
                        cx={cxPos}
                        cy={cyPos}
                        r={isSelected ? point.r + 2 : point.r}
                        fill={hasHistory ? BAND_COLOR[point.file.score.band] : 'transparent'}
                        fillOpacity={isSelected ? 0.75 : 0.42}
                        stroke={BAND_COLOR[point.file.score.band]}
                        strokeWidth={isSelected ? 2 : 1}
                        className="cursor-pointer transition-[r] duration-75"
                        onMouseEnter={() => setHovered(point.file)}
                        onMouseLeave={() => setHovered((current) => (current === point.file ? null : current))}
                        onClick={() => select(point.file.path)}
                      >
                        <title>
                          {`${point.file.path}\nscore ${point.file.score.score.toFixed(0)} (${ATTENTION_BAND_LABEL[point.file.score.band]})\nchanges ${point.file.git?.changeCount ?? 'no history'}\ncomplexity ${point.file.cyclomatic ?? 'not measured'}\nsize ${formatBytes(point.file.bytes)}`}
                        </title>
                      </circle>
                    );
                  })}
                </svg>
              ) : null}
              {hovered ? <Tooltip file={hovered} /> : null}
              {filtered.length === 0 ? (
                <EmptyState compact title="No files match these filters" description="Widen the filters to see files." />
              ) : null}
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto">
              <HotspotTable files={sorted} onSelect={select} selectedPath={selectedPath} />
            </div>
          )}
        </Panel>

        <div className="min-h-0 overflow-auto">
          <DetailsPanel file={selected} analysis={analysis} />
        </div>
      </div>
    </div>
  );
}

function Tooltip({ file }: { file: AnalyzedFile }): JSX.Element {
  return (
    <div className="pointer-events-none absolute right-3 top-3 w-72 rounded-md border border-graphite-700 bg-graphite-950/95 p-3 shadow-lg">
      <p className="truncate font-mono text-2xs text-graphite-200" title={file.path}>
        {file.path}
      </p>
      <div className="mt-1.5 flex items-center gap-2">
        <ScoreBadge score={file.score.score} band={file.score.band} />
        <BandPill band={file.score.band} />
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-2xs">
        <dt className="text-graphite-400">Changes</dt>
        <dd className="num text-right text-graphite-100">{file.git ? `${file.git.changeCount}` : 'no history'}</dd>
        <dt className="text-graphite-400">Complexity</dt>
        <dd className="num text-right text-graphite-100">{file.cyclomatic ?? 'not measured'}</dd>
        <dt className="text-graphite-400">Size</dt>
        <dd className="num text-right text-graphite-100">{formatBytes(file.bytes)}</dd>
        <dt className="text-graphite-400">Last change</dt>
        <dd className="num text-right text-graphite-100">
          {file.git?.lastModified ? formatRelative(file.git.lastModified) : '—'}
        </dd>
      </dl>
    </div>
  );
}

function HotspotTable({
  files,
  onSelect,
  selectedPath,
}: {
  files: AnalyzedFile[];
  onSelect: (path: string) => void;
  selectedPath: string | null;
}): JSX.Element {
  return (
    <table className="w-full border-collapse">
      <caption className="sr-only">Files sorted by attention score</caption>
      <thead>
        <tr>
          <th className="th w-16">Score</th>
          <th className="th">File</th>
          <th className="th w-28">Band</th>
          <th className="th w-20 text-right">Changes</th>
          <th className="th w-24 text-right">Complexity</th>
          <th className="th w-20 text-right">Size</th>
          <th className="th w-24 text-right">Last change</th>
        </tr>
      </thead>
      <tbody>
        {files.map((file) => (
          <tr
            key={file.path}
            onClick={() => onSelect(file.path)}
            className={cx('cursor-pointer hover:bg-graphite-800', file.path === selectedPath && 'bg-graphite-800')}
          >
            <td className="td">
              <ScoreBadge score={file.score.score} band={file.score.band} />
            </td>
            <td className="td font-mono text-2xs" title={file.path}>
              {file.path}
            </td>
            <td className="td">
              <BandPill band={file.score.band} />
            </td>
            <td className="td num text-right">{file.git ? file.git.changeCount : '—'}</td>
            <td className="td num text-right">{file.cyclomatic ?? '—'}</td>
            <td className="td num text-right">{formatBytes(file.bytes)}</td>
            <td className="td num text-right">
              {file.git?.lastModified ? formatRelative(file.git.lastModified) : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function buildChangeTicks(max: number): number[] {
  const ticks: number[] = [0, 1, 2, 5, 10, 20, 50, 100].filter((tick) => tick <= max);
  if (ticks.length === 0) return [0];
  let value = 200;
  while (value <= max && ticks.length < 12) {
    ticks.push(value);
    value *= 2;
  }
  if (ticks[ticks.length - 1] !== max && max > 1) ticks.push(max);
  return ticks.slice(0, 12);
}

function buildTicks(max: number): number[] {
  const ticks: number[] = [1];
  let value = 2;
  while (value <= max) {
    ticks.push(value);
    value *= 2;
  }
  if (ticks[ticks.length - 1] !== max && max > 1) ticks.push(max);
  return ticks.slice(0, 10);
}

export function formatHotspotCount(count: number): string {
  return formatCount(count);
}
