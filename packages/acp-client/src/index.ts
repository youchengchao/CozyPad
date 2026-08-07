export * from './client';
export * from './connect';
export * from './handlers';
export * from './nodeStreams';
export * from './sessionEvents';

// Re-exported so consumers get the protocol's own types and constants from one
// place, and cannot end up compiling against a second copy of the library.
//
// The library is `@agentclientprotocol/sdk`, **not**
// `@zed-industries/agent-client-protocol` — that package is deprecated
// ("renamed to @agentclientprotocol/sdk", npm's own words) and frozen at 0.4.5,
// where several spec types are narrower than the spec. See the note on
// `AcpSessionUpdate` in ./sessionEvents.
export {
  AGENT_METHODS,
  PROTOCOL_VERSION,
  RequestError,
  type Agent,
  type AuthCapabilities,
  type AuthMethod,
  type AuthMethodId,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type Client,
  type ClientCapabilities,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type ContentBlock,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type DeleteSessionRequest,
  type DeleteSessionResponse,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LogoutRequest,
  type LogoutResponse,
  type PermissionOption,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionConfigOption,
  type SessionInfo,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type StopReason,
  type ToolCall,
  type ToolCallUpdate,
  type Usage,
  type UsageUpdate,
} from '@agentclientprotocol/sdk';
