import { useApp, type ViewId } from './state/store.js';
import { Sidebar } from './components/Sidebar.js';
import { TopBar } from './components/TopBar.js';
import { OverviewView } from './views/OverviewView.js';
import { HotspotsView } from './views/HotspotsView.js';
import { DependenciesView } from './views/DependenciesView.js';
import { TreemapView } from './views/TreemapView.js';
import { FilesView } from './views/FilesView.js';
import { HistoryView } from './views/HistoryView.js';
import { WelcomeScreen, RunningScreen } from './components/Screens.js';

const VIEWS: Record<ViewId, () => JSX.Element> = {
  overview: OverviewView,
  hotspots: HotspotsView,
  dependencies: DependenciesView,
  treemap: TreemapView,
  files: FilesView,
  history: HistoryView,
};

export function App(): JSX.Element {
  const { view, status, analysis, error, repoPath, openFolder, cancel, progress, appInfo } = useApp();
  const Current = VIEWS[view];

  return (
    <div className="flex h-full w-full overflow-hidden bg-graphite-950">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <div className="min-h-0 flex-1 overflow-hidden">
          {status === 'running' ? (
            <RunningScreen progress={progress} onCancel={cancel} />
          ) : status === 'error' && error ? (
            <div className="p-6">
              <ErrorScreen error={error} onRetry={repoPath ? () => void openFolder() : undefined} />
            </div>
          ) : !analysis ? (
            <WelcomeScreen
              onOpen={() => void openFolder()}
              appInfo={appInfo}
              busy={false}
            />
          ) : (
            <div className="h-full overflow-hidden">
              <Current />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export function ErrorScreen({
  error,
  onRetry,
}: {
  error: { code: string; message: string; hint?: string; stderr?: string };
  onRetry?: () => void;
}): JSX.Element {
  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <div className="panel border-attention-high/40 bg-attention-high/5 p-4">
        <p className="text-xs uppercase tracking-wide text-attention-high">{error.code}</p>
        <p className="mt-1 text-sm font-semibold text-graphite-100">{error.message}</p>
        {error.hint ? <p className="mt-2 text-xs text-graphite-300">{error.hint}</p> : null}
        {error.stderr ? (
          <pre className="mt-3 max-h-48 overflow-auto rounded border border-graphite-700 bg-graphite-950 p-2 text-2xs text-graphite-300">
            {error.stderr}
          </pre>
        ) : null}
        {onRetry ? (
          <button type="button" className="btn btn-accent mt-3" onClick={onRetry}>
            Choose another folder
          </button>
        ) : null}
      </div>
      <p className="text-2xs leading-relaxed text-graphite-500">
        Riftmap reports failures rather than guessing. If the engine is missing, run{' '}
        <code className="font-mono text-graphite-300">npm run engine:build</code>; if Git is missing, install it and
        restart the app.
      </p>
    </div>
  );
}
