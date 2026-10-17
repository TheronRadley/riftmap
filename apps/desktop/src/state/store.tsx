/**
 * Application state.
 *
 * One small React context holds everything the views need: the current
 * repository, the analysis, the history window, filters, and the selection.
 * There is no data fetching in the views themselves - all of it happens here
 * through the validated IPC bridge.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { recomputeForWindow, type AnalysisProgress, type RepositoryAnalysis } from '@riftmap/shared';
import type { AnalyzeFailure, AppInfo, FilePreviewResult } from '../../shared/ipc.js';
import { api } from '../api.js';

export type ViewId = 'overview' | 'hotspots' | 'dependencies' | 'treemap' | 'files' | 'history';
export type HistoryWindowValue = 30 | 90 | 180 | 'all';

export interface RecentRepo {
  path: string;
  name: string;
  lastAnalyzedAt: number;
}

export interface Filters {
  search: string;
  language: string;
  directory: string;
  minChanges: number;
  band: 'all' | 'high' | 'moderate' | 'lower';
}

const DEFAULT_FILTERS: Filters = {
  search: '',
  language: 'all',
  directory: 'all',
  minChanges: 0,
  band: 'all',
};

export interface AppState {
  appInfo: AppInfo | null;
  view: ViewId;
  setView: (view: ViewId) => void;

  repoPath: string | null;
  analysis: RepositoryAnalysis | null;
  status: 'idle' | 'running' | 'ready' | 'error';
  progress: (AnalysisProgress & { runId: string }) | null;
  error: AnalyzeFailure | null;

  recent: RecentRepo[];
  openFolder: () => Promise<void>;
  analyzePath: (path: string) => Promise<void>;
  cancel: () => void;

  windowDays: HistoryWindowValue;
  setWindowDays: (days: HistoryWindowValue) => void;

  filters: Filters;
  setFilters: (update: Partial<Filters>) => void;
  resetFilters: () => void;

  selectedPath: string | null;
  select: (path: string | null) => void;

  preview: FilePreviewResult | null;
  previewLoading: boolean;
  requestPreview: (path: string | null) => void;

  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
}

const AppContext = createContext<AppState | null>(null);
const RECENT_KEY = 'riftmap.recentRepos';
const SIDEBAR_KEY = 'riftmap.sidebarCollapsed';

function loadRecent(): RecentRepo[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is RecentRepo => typeof item?.path === 'string');
  } catch {
    return [];
  }
}

export function AppProvider({ children }: { children: ReactNode }): JSX.Element {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [view, setView] = useState<ViewId>('overview');
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<RepositoryAnalysis | null>(null);
  const [status, setStatus] = useState<AppState['status']>('idle');
  const [progress, setProgress] = useState<(AnalysisProgress & { runId: string }) | null>(null);
  const [error, setError] = useState<AnalyzeFailure | null>(null);
  const [recent, setRecent] = useState<RecentRepo[]>(loadRecent);
  const [windowDays, setWindowDays] = useState<HistoryWindowValue>('all');
  const [filters, setFiltersState] = useState<Filters>(DEFAULT_FILTERS);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_KEY) === '1';
    } catch {
      return false;
    }
  });

  const runIdRef = useRef<string | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    void api()
      .getAppInfo()
      .then(setAppInfo)
      .catch(() => setAppInfo(null));
  }, []);

  useEffect(() => {
    unsubscribeRef.current = api().onAnalysisProgress((event) => {
      setProgress(event);
    });
    return () => {
      unsubscribeRef.current?.();
    };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, 8)));
    } catch {
      /* storage unavailable - recents simply do not persist */
    }
  }, [recent]);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((value) => {
      try {
        window.localStorage.setItem(SIDEBAR_KEY, value ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !value;
    });
  }, []);

  const remember = useCallback((path: string) => {
    const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
    setRecent((items) => [{ path, name, lastAnalyzedAt: Date.now() }, ...items.filter((item) => item.path !== path)].slice(0, 8));
  }, []);

  const analyzePath = useCallback(
    async (path: string) => {
      const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      runIdRef.current = runId;
      setRepoPath(path);
      setStatus('running');
      setError(null);
      setProgress(null);
      setSelectedPath(null);
      setPreview(null);

      try {
        const result = await api().analyze({
          runId,
          repoPath: path,
          historyWindowDays: windowDays,
        });
        if (runIdRef.current !== runId) return; // superseded by a newer run
        if (result.ok) {
          setAnalysis(result.analysis);
          setStatus('ready');
          remember(path);
          setView((current) => (current === 'overview' ? 'overview' : current));
        } else {
          setAnalysis(null);
          setStatus('error');
          setError(result);
        }
      } catch (caught) {
        if (runIdRef.current !== runId) return;
        setAnalysis(null);
        setStatus('error');
        setError({
          ok: false,
          code: 'unknown',
          message: caught instanceof Error ? caught.message : String(caught),
        });
      } finally {
        if (runIdRef.current === runId) setProgress(null);
      }
    },
    [remember, windowDays],
  );

  const openFolder = useCallback(async () => {
    const result = await api().pickFolder();
    if (result.canceled || !result.path) return;
    await analyzePath(result.path);
  }, [analyzePath]);

  const cancel = useCallback(() => {
    const runId = runIdRef.current;
    if (!runId) return;
    runIdRef.current = null;
    void api().cancelAnalysis(runId);
    setStatus('idle');
    setProgress(null);
  }, []);

  /**
   * Switching the history window never re-runs the source scan. The full
   * retrieved commit list already lives in the analysis, so the new window is
   * a pure recomputation of per-file Git statistics and attention scores.
   */
  const setWindowDaysWrapped = useCallback(
    (days: HistoryWindowValue) => {
      setWindowDays(days);
      setAnalysis((current) => {
        if (!current) return current;
        try {
          return recomputeForWindow(current, days);
        } catch {
          return current;
        }
      });
    },
    [],
  );

  const setFilters = useCallback((update: Partial<Filters>) => {
    setFiltersState((current) => ({ ...current, ...update }));
  }, []);

  const resetFilters = useCallback(() => setFiltersState(DEFAULT_FILTERS), []);

  const select = useCallback((path: string | null) => {
    setSelectedPath(path);
  }, []);

  const requestPreview = useCallback(
    (path: string | null) => {
      if (!path || !repoPath) {
        setPreview(null);
        return;
      }
      setPreviewLoading(true);
      void api()
        .readFilePreview({ repoPath, relativePath: path })
        .then((result) => {
          setPreview(result);
        })
        .catch(() => setPreview(null))
        .finally(() => setPreviewLoading(false));
    },
    [repoPath],
  );

  const value = useMemo<AppState>(
    () => ({
      appInfo,
      view,
      setView,
      repoPath,
      analysis,
      status,
      progress,
      error,
      recent,
      openFolder,
      analyzePath,
      cancel,
      windowDays,
      setWindowDays: setWindowDaysWrapped,
      filters,
      setFilters,
      resetFilters,
      selectedPath,
      select,
      preview,
      previewLoading,
      requestPreview,
      sidebarCollapsed,
      toggleSidebar,
    }),
    [
      appInfo,
      view,
      repoPath,
      analysis,
      status,
      progress,
      error,
      recent,
      openFolder,
      analyzePath,
      cancel,
      windowDays,
      setWindowDaysWrapped,
      filters,
      setFilters,
      resetFilters,
      selectedPath,
      select,
      preview,
      previewLoading,
      requestPreview,
      sidebarCollapsed,
      toggleSidebar,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppState {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside <AppProvider>');
  return value;
}
