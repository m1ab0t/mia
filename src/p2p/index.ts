// ── Transport / swarm (used only by p2p-agent.ts) ────────────────────────
export {
  createP2PSwarm,
  joinP2PSwarm,
  disconnectP2P,
  registerP2PMessageHandler,
  unregisterP2PMessageHandler,
  registerNewConversationCallback,
  unregisterNewConversationCallback,
  registerLoadConversationCallback,
  unregisterLoadConversationCallback,
  registerSwitchPluginCallback,
  registerGetPluginsCallback,
  registerSchedulerActionCallback,
} from './swarm';

// ── Daemon-side sender (used by daemon, router, plugins) ─────────────────
// All outbound P2P calls go through sender.ts which forwards them to the
// P2P sub-agent process via stdin IPC instead of writing to Hyperswarm
// connections directly.
export {
  configureP2PSender,
  clearP2PSender,
  sendDaemonToAgent,
  getP2PStatus,
  getCurrentConversationId,
  getResumedConversationId,
  setCurrentConversationId,
  setResumedConversationId,
  setPeerCount,
  setP2PKey,
  sendP2PMessage,
  sendP2PRawToken,
  sendP2PToolCall,
  sendP2PToolResult,
  sendP2PThinking,
  sendP2PChatMessage,
  sendP2PResponse,
  sendP2PResponseForConversation,
  sendP2PPluginError,
  sendP2PDispatchCost,
  sendP2PTokenUsage,
  sendP2PRouteInfo,
  sendP2PBashStream,
  broadcastConversationList,
  storeSchedulerConversation,
  storeSchedulerResult,
  storeUserMessage,
  sendP2PSchedulerLog,
  requestRecentMessages,
  handleRecentMessagesResponse,
} from './sender';

// ── IPC types (single source of truth for shared P2P message shapes) ─────
export type {
  AgentToDaemon,
  DaemonToAgent,
  ImageAttachment,
  PluginInfo,
  ScheduledTaskInfo,
} from './ipc-types';

// ── Structured P2P errors ─────────────────────────────────────────────────
export {
  P2PError,
  P2PTimeoutError,
  P2PConnectionError,
  P2PAuthError,
  P2PStoreError,
  P2PShutdownError,
  isP2PError,
} from './errors';
export type { P2PErrorCode, AnyP2PError } from './errors';
