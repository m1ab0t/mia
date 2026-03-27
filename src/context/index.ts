/**
 * Context Management - Exports
 */

export {
  resolveCwd,
  scanWorkspace,
  scanWorkspaceAsync,
  scanGitState,
  scanGitStateAsync,
  resetCacheTtls,
  flushSnapshotCache,
  type GitState,
  type FileStructure,
  type WorkspaceSnapshot,
} from './workspace-scanner';

export {
  loadWorkspaceContext,
  refreshWorkspaceContext,
  loadConversationContext,
  buildHandoffContext,
  formatHandoffPrompt,
  enhanceClaudeCodePrompt,
  storeLastClaudeResult,
  cacheCodebaseContext,
  type ConversationContext,
  type WorkspaceContext,
  type HandoffContext,
} from './context-builder';
