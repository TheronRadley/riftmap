/** Collapsible left navigation: repository switcher + view navigation. */

import { useApp, type ViewId } from '../state/store.js';
import { formatRelative } from '@riftmap/shared';
import { cx } from './primitives.js';

const NAV: Array<{ id: ViewId; label: string; hint: string; glyph: string }> = [
  { id: 'overview', label: 'Overview', hint: 'Repository summary and data coverage', glyph: '◎' },
  { id: 'hotspots', label: 'Hotspots', hint: 'Change frequency against complexity', glyph: '◈' },
  { id: 'dependencies', label: 'Dependencies', hint: 'Import graph between files', glyph: '⌗' },
  { id: 'treemap', label: 'Treemap', hint: 'Size and directory structure', glyph: '▤' },
  { id: 'files', label: 'Files', hint: 'Sortable file table and inspector', glyph: '☰' },
  { id: 'history', label: 'History', hint: 'Commits, churn and contributors', glyph: '◷' },
];

export function Sidebar(): JSX.Element {
  const {
    view,
    setView,
    sidebarCollapsed,
    toggleSidebar,
    openFolder,
    recent,
    repoPath,
    analyzePath,
    status,
    appInfo,
    cancel,
  } = useApp();

  return (
    <nav
      className={cx(
        'flex shrink-0 flex-col border-r border-graphite-800 bg-graphite-900 transition-[width] duration-150',
        sidebarCollapsed ? 'w-14' : 'w-64',
      )}
      aria-label="Main navigation"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-graphite-800 px-3">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-accent-dim/30 text-sm font-bold text-accent">
          R
        </div>
        {!sidebarCollapsed ? (
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-graphite-100">Riftmap</p>
            <p className="truncate text-2xs text-graphite-500">local repository analysis</p>
          </div>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost shrink-0 px-1.5"
          onClick={toggleSidebar}
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {sidebarCollapsed ? '»' : '«'}
        </button>
      </div>

      <div className="shrink-0 p-2">
        <button
          type="button"
          className={cx('btn btn-accent w-full', sidebarCollapsed && 'px-0')}
          onClick={() => void openFolder()}
          title="Choose a folder to analyse"
        >
          {sidebarCollapsed ? '+' : 'Open repository…'}
        </button>
      </div>

      <ul className="space-y-0.5 px-2">
        {NAV.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => setView(item.id)}
              title={sidebarCollapsed ? `${item.label} — ${item.hint}` : item.hint}
              aria-current={view === item.id ? 'page' : undefined}
              className={cx(
                'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                view === item.id
                  ? 'bg-accent-dim/20 text-accent-strong'
                  : 'text-graphite-300 hover:bg-graphite-800 hover:text-graphite-100',
              )}
            >
              <span className="w-4 shrink-0 text-center text-sm" aria-hidden="true">
                {item.glyph}
              </span>
              {!sidebarCollapsed ? <span className="truncate">{item.label}</span> : null}
            </button>
          </li>
        ))}
      </ul>

      {!sidebarCollapsed && recent.length > 0 ? (
        <div className="mt-4 min-h-0 flex-1 overflow-auto px-2">
          <p className="label px-2 pb-1">Recent</p>
          <ul className="space-y-0.5">
            {recent.map((item) => (
              <li key={item.path}>
                <button
                  type="button"
                  onClick={() => void analyzePath(item.path)}
                  className={cx(
                    'block w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-graphite-800',
                    item.path === repoPath ? 'bg-graphite-800' : '',
                  )}
                  title={item.path}
                >
                  <span className="block truncate text-xs text-graphite-200">{item.name}</span>
                  <span className="block truncate text-2xs text-graphite-500">
                    {formatRelative(item.lastAnalyzedAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="flex-1" />
      )}

      <div className="shrink-0 border-t border-graphite-800 p-2">
        {!sidebarCollapsed ? (
          <p className="px-1 text-2xs leading-relaxed text-graphite-500">
            Runs fully offline. Read-only scans; nothing is uploaded.
            {appInfo?.webPreview ? ' Browser dev preview.' : ''}
          </p>
        ) : null}
        {status === 'running' ? (
          <button type="button" className="btn mt-2 w-full" onClick={cancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </nav>
  );
}
