export interface HostRpcRequest {
  readonly type: 'request';
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface HostRpcResponse {
  readonly type: 'response';
  readonly id: number;
  readonly result?: unknown;
  readonly error?: string;
}

export interface HostRpcLineEvent {
  readonly type: 'event';
  readonly requestId: number;
  readonly event: 'line';
  readonly line: string;
}

export interface HostRpcProcessEvent {
  readonly type: 'process';
  readonly processId: string;
  readonly event: 'stdout' | 'stderr' | 'exit' | 'error';
  readonly data?: string;
  readonly code?: number | null;
  readonly signal?: string | null;
  readonly error?: string;
}

export type HostRpcMessage =
  | HostRpcResponse
  | HostRpcLineEvent
  | HostRpcProcessEvent;
