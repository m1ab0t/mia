#!/usr/bin/env node

/**
 * Simple streaming test for MIA
 *
 * Tests the streaming capabilities by asking the agent a simple question
 * and displaying the response token-by-token as it arrives.
 */

import { Agent } from './src/agent.js';
import { readMiaConfig } from './src/claude/config.js';

async function testStreaming() {
  console.log('🚀 MIA Streaming Test\n');
  console.log('━'.repeat(50));

  // Load config to get API key
  const config = await readMiaConfig();
  const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.error('❌ No API key found. Set ANTHROPIC_API_KEY or configure via mia config');
    process.exit(1);
  }

  // Track streaming
  let tokenCount = 0;
  let startTime = Date.now();

  // Create agent with streaming callback
  const agent = new Agent({
    apiKey,
    model: 'claude-sonnet-4-6-20250929',
    maxTokens: 1024,
    mode: 'general',
    onStreamToken: (token) => {
      // Print each token as it arrives (no newline)
      process.stdout.write(token);
      tokenCount++;
    },
    onToolCall: (toolName, params) => {
      console.log(`\n\n🔧 Tool: ${toolName}`);
      console.log(`   Params: ${JSON.stringify(params, null, 2)}`);
    },
    onToolResult: (toolName, result, isError) => {
      const emoji = isError ? '❌' : '✅';
      console.log(`${emoji} Result: ${result.substring(0, 100)}${result.length > 100 ? '...' : ''}`);
    }
  });

  console.log('\n📝 Question: "Write a haiku about streaming data"\n');
  console.log('💬 Response:\n');

  try {
    // Run the agent with a simple prompt
    await agent.run('Write a haiku about streaming data');

    const elapsed = Date.now() - startTime;
    const tokensPerSec = (tokenCount / (elapsed / 1000)).toFixed(1);

    console.log('\n\n' + '━'.repeat(50));
    console.log(`\n✨ Streaming completed!`);
    console.log(`   Tokens: ${tokenCount}`);
    console.log(`   Time: ${elapsed}ms`);
    console.log(`   Speed: ${tokensPerSec} tokens/sec`);
    console.log(`\n${agent.getUsageSummary()}`);

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  }
}

// Run the test
testStreaming().catch(console.error);
