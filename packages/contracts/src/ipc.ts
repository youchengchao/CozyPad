export const IpcChannels = {
  listProfiles: 'cozypad:profiles:list',
  connect: 'cozypad:connection:connect',
  disconnect: 'cozypad:connection:disconnect',
  connectionState: 'cozypad:connection:state',
  terminalOpen: 'cozypad:terminal:open',
  terminalWrite: 'cozypad:terminal:write',
  terminalResize: 'cozypad:terminal:resize',
  terminalClose: 'cozypad:terminal:close',
  terminalOutput: 'cozypad:terminal:output',
  terminalClosed: 'cozypad:terminal:closed',
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];
