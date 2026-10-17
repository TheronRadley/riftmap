/** Window chrome: repository identity, history window selector, engine status. */

import { HISTORY_WINDOWS, formatDuration } from '@riftmap/shared';
import { useApp, type HistoryWindowValue } from '../state/store.js';
import { cx, Tag } from './primitives.js';

export function WindowSelector(): JSX.Element {
  const { windowDays, setWindowDays } = useApp();
  return (
    <div
      className="inline-flex overflow-hidden rounded-md border border-graphite-700"
      role="group"
      aria-label="History window"
    >
      {HISTORY_WINDOWS.map((option) => (
        <button
          key={String(option)}
          type="button"
          onClick={() => setWindowDays(option as HistoryWindowValue)}
          aria-pressed={windowDays === option}
          className={cx(
            'px-2.5 py-1 text-2xs font-medium transition-colors',
            windowDays === option
              ? 'bg-accent-dim/30 text-accent-strong'
              : 'bg-graphite-800 text-graphite-400 hover:bg-graphite-750 hover:text-graphite-200',
          )}
          title={option === 'all' ? 'All retrieved history' : `Last ${option} days`}
        >
          {option === 'all' ? 'All' : `${option}d`}
        </button>
      ))}
    </div>
  );
}

export function TopBar({ children }: { children?: React.ReactNode }): JSX.Element {
  const { analysis, repoPath, status, progress, appInfo, view } = useApp();

  const title =
    view === 'overview'
      ? 'Overview'
      : view === 'hotspots'
        ? 'Hotspot Explorer'
        : view === 'dependencies'
          ? 'Dependency graph'
          : view === 'treemap'
            ? 'Codebase treemap'
            : view === 'files'
              ? 'Files'
              : 'Change history';

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-graphite-800 bg-graphite-900 px-4">
      <h1 className="text-sm font-semibold text-graphite-100">{title}</h1>

      {repoPath ? (
        <span className="hidden min-w-0 truncate font-mono text-2xs text-graphite-400 md:inline" title={repoPath}>
          {repoPath}
        </span>
      ) : null}

      {status === 'running' && progress ? (
        <span className="flex items-center gap-2 text-2xs text-graphite-300">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
          {progress.label}
          {progress.files !== undefined ? ` · ${progress.files} files` : ''}
        </span>
      ) : null}

      {analysis ? (
        <span className="hidden text-2xs text-graphite-500 lg:inline">
          scan {formatDuration(analysis.engine.elapsedMs)} · {analysis.repository.name}
        </span>
      ) : null}

      <div className="ml-auto flex items-center gap-2">
        {children}
        {analysis ? <WindowSelector /> : null}
        {appInfo && appInfo.engine && !appInfo.engine.ok ? (
          <Tag tone="warn" >engine unavailable</Tag>
        ) : null}
      </div>
    </header>
  );
}
