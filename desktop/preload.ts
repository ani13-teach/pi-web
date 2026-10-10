/**
 * Preload bridge.
 *
 * The renderer gets exactly the methods on `DesktopBridge` — no generic IPC
 * channel, no filesystem access, no ability to run commands. It runs sandboxed,
 * so everything it touches must be bundleable and may only use `electron`.
 */

import { contextBridge, ipcRenderer } from "electron";

import {
  DESKTOP_CHANNEL,
  type BackendMethod,
  type BackendPush,
  type DesktopBridge,
  type ParamsOf,
  type ResultOf,
} from "../shared/contract";

const bridge: DesktopBridge = {
  app: {
    version: process.env.PI_DESKTOP_VERSION ?? "0.0.0",
    platform: process.platform,
  },

  pickDirectory: async (defaultPath?: string): Promise<string | null> =>
    (await ipcRenderer.invoke(DESKTOP_CHANNEL.pickDirectory, defaultPath)) as string | null,

  openLocalFile: async (options): Promise<void> => {
    await ipcRenderer.invoke(DESKTOP_CHANNEL.openLocalFile, options);
  },

  backupBoot: () => ipcRenderer.invoke(DESKTOP_CHANNEL.backupBoot),
  backupSelectProjects: () => ipcRenderer.invoke(DESKTOP_CHANNEL.backupSelectProjects),
  backupSelectMappingTarget: (options) => ipcRenderer.invoke(DESKTOP_CHANNEL.backupSelectMappingTarget, options),
  backupScan: (options) => ipcRenderer.invoke(DESKTOP_CHANNEL.backupScan, options),
  backupExport: (options) => ipcRenderer.invoke(DESKTOP_CHANNEL.backupExport, options),
  backupInspect: (options) => ipcRenderer.invoke(DESKTOP_CHANNEL.backupInspect, options),
  backupRestore: (options) => ipcRenderer.invoke(DESKTOP_CHANNEL.backupRestore, options),
  backupCancel: (options) => ipcRenderer.invoke(DESKTOP_CHANNEL.backupCancel, options),
  onBackupProgress: (listener) => {
    const wrapped = (_event: unknown, value: import("../shared/backup").BackupProgress) => listener(value);
    ipcRenderer.on(DESKTOP_CHANNEL.backupProgress, wrapped);
    return () => ipcRenderer.removeListener(DESKTOP_CHANNEL.backupProgress, wrapped);
  },

  /** One request/response round trip to the backend. */
  invoke: <M extends BackendMethod>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> =>
    ipcRenderer.invoke(DESKTOP_CHANNEL.invoke, method, params) as Promise<ResultOf<M>>,

  restartBackend: async (): Promise<void> => {
    await ipcRenderer.invoke(DESKTOP_CHANNEL.restartBackend);
  },

  /** Subscribe to backend pushes (agent events, terminal output, status). */
  onPush: (listener: (push: BackendPush) => void): (() => void) => {
    const wrapped = (_event: unknown, push: BackendPush): void => listener(push);
    ipcRenderer.on(DESKTOP_CHANNEL.push, wrapped);
    return () => {
      ipcRenderer.removeListener(DESKTOP_CHANNEL.push, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld("piDesktop", bridge);
