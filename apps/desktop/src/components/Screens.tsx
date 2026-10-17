/** Full-surface states: first run, in-progress scan. */

import type { AnalysisProgress } from '@riftmap/shared';
import type { AppInfo } from '../../shared/ipc.js';
import { Skeleton, SkeletonGrid } from './primitives.js';

export function WelcomeScreen({
  onOpen,
  appInfo,
  busy,
}: {
  onOpen: () => void;
  appInfo: AppInfo | null;
  busy: boolean;
}): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center overflow-auto p-8">
      <div className="max-w-2xl text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-accent-dim/25 text-xl font-bold text-accent">
          R
        </div>
        <h2 className="text-xl font-semibold text-graphite-100">See where your codebase is under pressure</h2>
        <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-graphite-400">
          Riftmap reads a local Git repository and shows its structure, dependencies and change activity. A native
          Zig engine scans the source; the installed <code className="font-mono text-graphite-300">git</code>{' '}
          executable provides the history. Everything runs on this machine, read-only, with no network access and no
          telemetry.
        </p>

        <button type="button" className="btn btn-accent mx-auto mt-5 px-4 py-2 text-sm" onClick={onOpen} disabled={busy}>
          Choose a repository folder…
        </button>

        <div className="mt-8 grid gap-3 text-left sm:grid-cols-3">
          <Feature title="Hotspot Explorer" body="Change frequency against estimated complexity, sized by file size, coloured by attention score - with the maths shown for every point." />
          <Feature title="Dependency graph" body="Resolved imports between files, with external and unresolved specifiers listed separately rather than guessed at." />
          <Feature title="Honest coverage" body="Where metrics could not be measured, Riftmap says so and drops that component from the score instead of faking a zero." />
        </div>

        {appInfo ? (
          <p className="mt-6 text-2xs text-graphite-600">
            {appInfo.webPreview ? 'Browser dev preview · ' : ''}
            Node {appInfo.nodeVersion} · Git {appInfo.gitVersion ?? 'not found'} · Engine{' '}
            {appInfo.engine?.ok ? (appInfo.engine.version ?? 'ready') : (appInfo.engine?.message ?? 'not found')}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function RunningScreen({
  progress,
  onCancel,
}: {
  progress: (AnalysisProgress & { runId: string }) | null;
  onCancel: () => void;
}): JSX.Element {
  const stage = progress?.stage ?? 'preparing';
  const order: Array<AnalysisProgress['stage']> = ['preparing', 'source', 'history', 'scoring', 'complete'];
  const index = Math.max(0, order.indexOf(stage));

  return (
    <div className="h-full overflow-auto p-6">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-graphite-100">{progress?.label ?? 'Preparing…'}</p>
            <p className="mt-0.5 text-2xs text-graphite-400">
              {progress?.files !== undefined ? `${progress.files} files · ` : ''}
              {progress?.directories !== undefined ? `${progress.directories} directories · ` : ''}
              {progress?.elapsedMs !== undefined ? `${(progress.elapsedMs / 1000).toFixed(1)} s` : ''}
            </p>
          </div>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        </div>

        <ol className="mt-4 space-y-1.5">
          {order.map((item, itemIndex) => (
            <li key={item} className="flex items-center gap-2 text-xs">
              <span
                className={
                  itemIndex < index
                    ? 'text-accent'
                    : itemIndex === index
                      ? 'animate-pulse text-accent'
                      : 'text-graphite-600'
                }
                aria-hidden="true"
              >
                {itemIndex < index ? '✓' : itemIndex === index ? '●' : '○'}
              </span>
              <span className={itemIndex <= index ? 'text-graphite-200' : 'text-graphite-500'}>
                {LABELS[item]}
              </span>
            </li>
          ))}
        </ol>

        <div className="mt-6">
          <SkeletonGrid rows={3} cols={3} />
        </div>
        <div className="mt-3">
          <Skeleton className="h-56 w-full" />
        </div>
      </div>
    </div>
  );
}

const LABELS: Record<AnalysisProgress['stage'], string> = {
  preparing: 'Check the path and locate the native engine',
  source: 'Scan source files (Zig engine)',
  history: 'Read Git history (read-only)',
  scoring: 'Combine metrics and compute attention scores',
  complete: 'Done',
};

function Feature({ title, body }: { title: string; body: string }): JSX.Element {
  return (
    <div className="panel p-3">
      <p className="text-xs font-semibold text-graphite-100">{title}</p>
      <p className="mt-1 text-2xs leading-relaxed text-graphite-400">{body}</p>
    </div>
  );
}
