#!/usr/bin/env node
import Hyperswarm from 'hyperswarm';
import b4a from 'b4a';
import readline from 'readline';
import type { Duplex } from 'stream';
import { getErrorMessage } from '../utils/error-message';

const key = process.argv[2];

if (!key) {
  console.log('Usage: npx tsx src/p2p/client.ts <topic-key>');
  console.log('Get the topic key from mia by running the "p2p" command');
  process.exit(1);
}

const swarm = new Hyperswarm({
  firewall: () => false
});
const topicKey = b4a.from(key, 'hex');

console.log('🔗 Connecting to P2P swarm...');
console.log(`🔑 Topic: ${key}`);

const discovery = swarm.join(topicKey, { server: false, client: true });

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

let activeConnection: Duplex | null = null;

swarm.on('connection', (conn: Duplex) => {
  console.log('✅ Connected to mia!');
  console.log('Type your messages and press Enter to send.\n');
  activeConnection = conn;

  conn.on('data', (data: Buffer) => {
    const response = b4a.toString(data);
    console.log(`\n🤖 mia: ${response}\n`);
    rl.prompt();
  });

  conn.on('close', () => {
    console.log('❌ Disconnected from mia');
    activeConnection = null;
    process.exit(0);
  });

  conn.on('error', (err: Error) => {
    console.error('Connection error:', getErrorMessage(err));
  });

  rl.prompt();
});

rl.on('line', (input: string) => {
  const trimmed = input.trim();
  if (!trimmed) {
    rl.prompt();
    return;
  }

  if (trimmed === 'exit' || trimmed === 'quit') {
    console.log('Goodbye!');
    if (activeConnection) {
      activeConnection.destroy();
    }
    swarm.destroy();
    process.exit(0);
  }

  if (activeConnection) {
    console.log(`📤 Sending: ${trimmed}`);
    activeConnection.write(b4a.from(trimmed));
  } else {
    console.log('❌ Not connected yet. Waiting for connection...');
  }
});

rl.on('close', () => {
  swarm.destroy();
  process.exit(0);
});

discovery.flushed().then(() => {
  console.log('📡 Waiting for connection...');
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  swarm.destroy();
  process.exit(0);
});
