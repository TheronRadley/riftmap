/** Sortable, searchable file table with the shared inspector. */

import { useMemo, useState } from 'react';
import { formatBytes, formatCount, formatRelative } from '@riftmap/shared';
import type { AnalyzedFile } from '@riftmap/shared';
import { useApp } from '../state/store.js';
import { EmptyState, Panel, ScoreBadge, cx } from '../components/primitives.js';
import { FilterBar, useFilteredFiles } from '../components/FilterBar.js';
import { DetailsPanel } from '../components/DetailsPanel.js';

type SortKey =
  | 'path'
  | 'language'
  | 'bytes'
  | 'lines'
  | 'cyclomatic'
  | 'changes'
  | 'lastModified'
  | 'score'
  | 'dependentCount';

const COLUMNS: Array<{ key: SortKey; label: string; align?: 'right'; width?: string }> = [
  { key: 'path', label: 'Path' },
  { key: 'language', label: 'Language', width: '8rem' },
  { key: 'lines', label: 'Lines', align: 'right', width: '5rem' },
  { key: 'bytes', label: 'Size', align: 'right', width: '6rem' },
  { key: 'cyclomatic', label: 'Complexity', align: 'right', width: '6rem' },
  { key: 'changes', label: 'Changes', align: 'right', width: '6rem' },
  { key: 'lastModified', label: 'Last change', align: 'right', width: '7rem' },
  { key: 'dependentCount', label: 'Used by', align: 'right', width: '6rem' },
  { key: 'score', label: 'Attention', align: 'right', width: '6rem' },
];

export function FilesView(): JSX.Element {
  const { analysis, selectedPath, select } = useApp();
  const files = analysis?.files ?? [];
  const filtered = useFilteredFiles(files);
  const [sortKey, setSortKey] = useState<SortKey>('score');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const sorted = useMemo(() => {
    const rows = [...filtered];
    rows.sort((a, b) => compare(a, b, sortKey));
    if (sortDir === 'asc') rows.reverse();
    return rows;
  }, [filtered, sortKey, sortDir]);

  const selected = useMemo(
    () => (analysis ? (analysis.files.find((file) => file.path === selectedPath) ?? null) : null),
    [analysis, selectedPath],
  );

  const toggle = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((value) => (value === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'path' || key === 'language' ? 'asc' : 'desc');
    }
  };

  if (!analysis) {
    return (
      <div className="p-6">
        <EmptyState title="No repository analysed yet" description="Open a folder to browse its files." />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-col">
      <FilterBar files={files} />
      <div className="grid min-h-0 flex-1 gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Panel
          title="Files"
          note={`${formatCount(sorted.length)} of ${formatCount(files.length)} files shown · click a column header to sort`}
          className="min-h-[24rem]"
          bodyClassName="overflow-auto"
        >
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {COLUMNS.map((column) => (
                  <th
                    key={column.key}
                    className={cx('th cursor-pointer hover:text-graphite-200', column.align === 'right' && 'text-right')}
                    style={column.width ? { width: column.width } : undefined}
                    onClick={() => toggle(column.key)}
                    aria-sort={sortKey === column.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    scope="col"
                  >
                    {column.label}
                    {sortKey === column.key ? <span aria-hidden="true">{sortDir === 'asc' ? ' ▲' : ' ▼'}</span> : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.slice(0, 2000).map((file) => (
                <Row
                  key={file.path}
                  file={file}
                  selected={file.path === selectedPath}
                  onSelect={select}
                />
              ))}
            </tbody>
          </table>
          {sorted.length > 2000 ? (
            <p className="p-3 text-2xs text-graphite-500">
              Showing the first 2000 rows of {formatCount(sorted.length)}. Narrow the filters to see the rest.
            </p>
          ) : null}
          {sorted.length === 0 ? (
            <EmptyState compact title="No files match these filters" description="Try resetting the filters." />
          ) : null}
        </Panel>

        <div className="min-h-0 overflow-auto">
          <DetailsPanel file={selected} analysis={analysis} />
        </div>
      </div>
    </div>
  );
}

function Row({
  file,
  selected,
  onSelect,
}: {
  file: AnalyzedFile;
  selected: boolean;
  onSelect: (path: string) => void;
}): JSX.Element {
  return (
    <tr
      className={cx('cursor-pointer hover:bg-graphite-800', selected && 'bg-graphite-800')}
      onClick={() => onSelect(file.path)}
    >
      <td className="td font-mono text-2xs" title={file.path}>
        {file.path}
      </td>
      <td className="td text-graphite-300">{file.languageName}</td>
      <td className="td num text-right">{formatCount(file.lines)}</td>
      <td className="td num text-right">{formatBytes(file.bytes)}</td>
      <td className="td num text-right">{file.cyclomatic ?? '—'}</td>
      <td className="td num text-right">{file.git ? formatCount(file.git.changeCount) : '—'}</td>
      <td className="td num text-right text-graphite-300">
        {file.git?.lastModified ? formatRelative(file.git.lastModified) : '—'}
      </td>
      <td className="td num text-right">{formatCount(file.dependentCount)}</td>
      <td className="td text-right">
        <ScoreBadge score={file.score.score} band={file.score.band} />
      </td>
    </tr>
  );
}

function compare(a: AnalyzedFile, b: AnalyzedFile, key: SortKey): number {
  switch (key) {
    case 'path':
      return a.path.localeCompare(b.path);
    case 'language':
      return a.languageName.localeCompare(b.languageName) || a.path.localeCompare(b.path);
    case 'bytes':
      return a.bytes - b.bytes;
    case 'lines':
      return a.lines - b.lines;
    case 'cyclomatic':
      return (a.cyclomatic ?? -1) - (b.cyclomatic ?? -1);
    case 'changes':
      return (a.git?.changeCount ?? -1) - (b.git?.changeCount ?? -1);
    case 'lastModified':
      return (a.git?.lastModified ?? -1) - (b.git?.lastModified ?? -1);
    case 'dependentCount':
      return a.dependentCount - b.dependentCount;
    case 'score':
      return a.score.score - b.score.score;
    default:
      return 0;
  }
}
