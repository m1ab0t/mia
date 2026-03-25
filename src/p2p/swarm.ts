/**
 * swarm.ts — public re-export barrel.
 *
 * All implementation has been split into focused modules:
 *   swarm-connection-manager.ts  — connections Map, sendToAll, enforceAnonCap
 *   swarm-message-handler.ts     — echo detection, message routing, conversation handlers
 *   swarm-core.ts                — mutable state, register callbacks, sendP2P* API, lifecycle
 *
 * External callers (p2p-agent.ts, index.ts, swarm.test.ts) continue to import
 * from './swarm' without any changes.
 */
export * from './swarm-core';
