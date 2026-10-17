/**
 * Preload bridge.
 *
 * Exposes a small, explicitly typed API on `contextBridge`. The renderer has
 * no `require`, no `process`, no `fs` and no `child_process` - only the
 * methods below, and each one validates its arguments in the main process.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type {
  AnalyzeRequest,
  AnalyzeResult,
  AppInfo,
  FilePreviewRequest,
  FilePreviewResult,
  PickFolderResult,
  RiftmapApi,
} from '../../shared/ipc.js';
import { IPC } from '../../shared/ipc.js';

const api: RiftmapApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo) as Promise<AppInfo>,

  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder) as Promise<PickFolderResult>,

  analyze: (request: AnalyzeRequest) => ipcRenderer.invoke(IPC.analyze, request) as Promise<AnalyzeResult>,

  cancelAnalysis: (runId: string) => ipcRenderer.invoke(IPC.cancel, runId) as Promise<boolean>,

  onAnalysisProgress: (listener) => {
    const handler = (_event: unknown, payload: Parameters<typeof listener>[0]) => listener(payload);
    ipcRenderer.on(IPC.progress, handler);
    return () => {
      ipcRenderer.removeListener(IPC.progress, handler);
    };
  },

  readFilePreview: (request: FilePreviewRequest) =>
    ipcRenderer.invoke(IPC.readPreview, request) as Promise<FilePreviewResult>,
};

contextBridge.exposeInMainWorld('riftmap', api);
