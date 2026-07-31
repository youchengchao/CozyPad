/**
 * 建立在「能在遠端執行一條命令」之上的服務層。
 * 桌面（Electron + ssh2）與手機（Capacitor + 原生 SSH）共用同一份實作，
 * 唯一的平台差異是傳進來的 exec 函式。
 */
export * from './RemoteFilesPort';
export * from './shellRemoteFiles';
export * from './telemetryService';
export * from './tmuxProvisioner';
export * from './remoteSettingsService';
