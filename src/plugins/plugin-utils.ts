/**
 * Shared utilities for CodingPlugin implementations.
 */

import type { DispatchOptions, PluginContext } from './types';

/**
 * Base system prompt injected into every plugin dispatch.
 *
 * Tells the agent it is running inside Mia — a persistent AI workspace daemon
 * with full file system and shell access granted by the user. Permissions are
 * pre-approved so the agent must never ask for confirmation before acting.
 */
export const MIA_SYSTEM_PROMPT = `You are operating as a coding agent inside Mia — a persistent AI workspace daemon running on the user's machine.

Key facts about your environment:
- You have been granted full, unrestricted access to the file system, shell, and all developer tools on this machine. Do not ask for permission before reading files, writing files, running commands, or installing dependencies — all actions are pre-approved.
- You are invoked remotely via a secure peer-to-peer channel from the user's mobile device. The user cannot type interactively; complete tasks autonomously and report back clearly.
- Mia maintains persistent memory across sessions. Important facts, preferences, and project context you learn will be stored and surfaced in future conversations.
- You may be switched between different coding agents (Claude Code, Codex, opencode) at any time. Write durable, well-documented code that any agent can pick up and continue.
- When a task is ambiguous, make a reasonable decision and explain your choice rather than stalling with clarifying questions.`.trim();

/**
 * Build the system prompt string that is injected into every plugin dispatch.
 *
 * Both claude-code and opencode plugins assemble an identical prompt from the
 * same PluginContext sections in the same order.  Centralising the logic here
 * keeps the two implementations in sync and makes future changes a one-line edit.
 *
 * @param baseSystemPrompt - Optional plugin-level system prompt (e.g. from PluginConfig.systemPrompt).
 *                           Prepended before all other sections.
 * @param context          - Runtime context prepared by the Mia harness.
 * @param options          - Dispatch options; `systemPromptSuffix` is appended last.
 * @returns                  The fully assembled system prompt, or `undefined` when nothing was added.
 */
export function buildSystemPrompt(
  baseSystemPrompt: string | undefined,
  context: PluginContext,
  options: Pick<DispatchOptions, 'systemPromptSuffix'>
): string | undefined {
  const parts: string[] = [];

  if (baseSystemPrompt) {
    parts.push(baseSystemPrompt);
  }

  if (context.projectInstructions) {
    parts.push(context.projectInstructions);
  }

  const contextSections: string[] = [];
  if (context.memoryFacts.length > 0) {
    contextSections.push(`## Memory Facts\n${context.memoryFacts.join('\n')}`);
  }
  if (context.codebaseContext) {
    contextSections.push(`## Codebase\n${context.codebaseContext}`);
  }
  if (context.gitContext) {
    contextSections.push(`## Git\n${context.gitContext}`);
  }
  if (context.workspaceSnapshot) {
    contextSections.push(`## Workspace\n${context.workspaceSnapshot}`);
  }
  if (context.conversationSummary) {
    contextSections.push(`## Prior Conversation\n${context.conversationSummary}`);
  }

  if (contextSections.length > 0) {
    parts.push(`## Mia Context\n\n${contextSections.join('\n\n')}`);
  }

  if (options.systemPromptSuffix) {
    parts.push(options.systemPromptSuffix);
  }

  return parts.length > 0 ? parts.join('\n\n') : undefined;
}
