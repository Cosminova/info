/**
 * Builds the app, serves the build on a private port, runs the capture
 * scenarios against it, then shuts its own server down.
 *
 * Verifying against a real build (rather than a long-lived dev server) means
 * every run is guaranteed to exercise the current source.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

const PORT = Number(process.env.COSMINOVA_PORT ?? 5179);
const URL = `http://127.0.0.1:${PORT}/`;

const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
  });

async function waitForServer(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(URL);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`preview server never came up on ${URL}`);
}

console.log('building ...');
await run('npx', ['vite', 'build', '--logLevel', 'warn']);

console.log(`serving build on ${URL}`);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  stdio: ['ignore', 'ignore', 'inherit'],
});

let exitCode = 0;
try {
  await waitForServer();
  await run('node', ['scripts/shoot.mjs', ...process.argv.slice(2)], {
    env: { ...process.env, COSMINOVA_URL: URL },
  });
} catch (error) {
  console.error(String(error.message ?? error));
  exitCode = 1;
} finally {
  server.kill('SIGTERM');
}

process.exit(exitCode);
