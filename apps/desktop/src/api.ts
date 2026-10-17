/**
 * Renderer-side access to the Riftmap API.
 *
 * In the packaged app this is the Electron `contextBridge` surface. In the
 * browser-only dev preview it is a small HTTP bridge to a Node process that
 * runs the *same* pipeline - the same Zig engine, the same Git calls, the same
 * validation. No analysis data is mocked at any layer.
 */

import type { AnalysisProgress } from '@riftmap/shared';
import type {
  AnalyzeRequest,
  AnalyzeResult,
  AppInfo,
  FilePreviewRequest,
  FilePreviewResult,
  PickFolderResult,
  RiftmapApi,
} from '../shared/ipc.js';

const DEV_BASE = '/__api';

type ProgressListener = (event: AnalysisProgress & { runId: string }) => void;

function createWebBridge(): RiftmapApi {
  const progressListeners = new Set<ProgressListener>();
  let currentSource: EventSource | null = null;

  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await fetch(`${DEV_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    if (!response.ok) throw new Error(`Dev API ${path} failed with ${response.status}`);
    return (await response.json()) as T;
  };

  return {
    async getAppInfo(): Promise<AppInfo> {
      const response = await fetch(`${DEV_BASE}/app-info`);
      return (await response.json()) as AppInfo;
    },

    async pickFolder(): Promise<PickFolderResult> {
      // A browser cannot open a native folder picker. Type the absolute path
      // instead; it is handed straight to the same analysis code.
      const value = window.prompt('Absolute path to a repository folder:');
      if (!value) return { canceled: true, path: null };
      return { canceled: false, path: value.trim() };
    },

    async analyze(request: AnalyzeRequest): Promise<AnalyzeResult> {
      // Start the job first, then subscribe: the dev backend buffers every
      // progress frame for the run and replays them from the beginning, so
      // nothing is lost even on very fast scans.
      const { runId } = await post<{ runId: string }>('/analyze', request);

      const source = new EventSource(`${DEV_BASE}/events?runId=${encodeURIComponent(runId)}`);
      currentSource?.close();
      currentSource = source;
      source.addEventListener('progress', (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent).data);
          for (const listener of progressListeners) listener(payload);
        } catch {
          /* ignore malformed frame */
        }
      });

      const result = await new Promise<AnalyzeResult>((resolvePromise, reject) => {
        const finish = (value: AnalyzeResult) => {
          source.close();
          if (currentSource === source) currentSource = null;
          resolvePromise(value);
        };
        source.addEventListener('done', (event) => {
          try {
            finish(JSON.parse((event as MessageEvent).data) as AnalyzeResult);
          } catch (error) {
            finish({ ok: false, code: 'unknown', message: String(error) });
          }
        });
        source.onerror = () => {
          // The stream closes normally once `done` has been delivered; only
          // surface an error if that has not happened yet.
          reject(new Error('Lost connection to the local analysis service.'));
        };
      });

      return result;
    },

    async cancelAnalysis(runId: string): Promise<boolean> {
      const result = await fetch(`${DEV_BASE}/cancel?runId=${encodeURIComponent(runId)}`);
      const body = (await result.json()) as { canceled: boolean };
      return body.canceled;
    },

    onAnalysisProgress(listener: ProgressListener): () => void {
      progressListeners.add(listener);
      return () => {
        progressListeners.delete(listener);
      };
    },

    readFilePreview(request: FilePreviewRequest): Promise<FilePreviewResult> {
      return post<FilePreviewResult>('/preview', request);
    },
  };
}

let cached: RiftmapApi | null = null;

export function api(): RiftmapApi {
  if (cached) return cached;
  cached = window.riftmap ?? createWebBridge();
  return cached;
}

export function isElectronShell(): boolean {
  return typeof window !== 'undefined' && typeof window.riftmap !== 'undefined';
}
