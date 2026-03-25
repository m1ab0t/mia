import { build } from 'esbuild';
import { chmod } from 'fs/promises';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

// Read version from package.json
const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
const version = pkg.version;

// Get git commit hash
let gitCommit = 'unknown';
try {
  gitCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
} catch {
  // Not in a git repo or git not available
}

const shared = {
  bundle: true,
  packages: 'external',
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  sourcemap: 'linked',
  define: {
    '__MIA_VERSION__': JSON.stringify(version),
    '__MIA_COMMIT__': JSON.stringify(gitCommit),
  },
};

const shebang = '#!/usr/bin/env node';

// Polyfill require() for CJS modules bundled into ESM output.
// esbuild's __require shim checks `typeof require !== "undefined"`.
const cjsShim = `import { createRequire as __createRequire } from 'module';
const require = __createRequire(import.meta.url);`;

await Promise.all([
  // CLI entry point
  build({
    ...shared,
    entryPoints: ['src/cli.ts'],
    outfile: 'dist/cli.js',
    banner: { js: `${shebang}\n${cjsShim}` },
  }),
  // Daemon entry point
  build({
    ...shared,
    entryPoints: ['src/daemon/index.ts'],
    outfile: 'dist/daemon.js',
    banner: { js: `${shebang}\n${cjsShim}` },
  }),
  // P2P sub-agent — spawned by daemon, owns Hyperswarm connectivity
  build({
    ...shared,
    entryPoints: ['src/p2p/p2p-agent.ts'],
    outfile: 'dist/p2p-agent.js',
    banner: { js: `${shebang}\n${cjsShim}` },
  }),
  // Library export
  build({
    ...shared,
    entryPoints: ['src/index.ts'],
    outfile: 'dist/index.js',
  }),
]);

// Make entry points executable
await chmod('dist/cli.js', 0o755);
await chmod('dist/daemon.js', 0o755);
await chmod('dist/p2p-agent.js', 0o755);
