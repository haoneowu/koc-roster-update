import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configEnvironment, effectiveConfig, readConfig, validateConfig } from './config.mjs';
import { supportedNode } from './setup.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ENTRYPOINTS = Object.freeze({
  readiness: 'koc-contact/readiness-live-server.mjs', daily: 'koc-contact/run-daily-inventory.mjs', 'one-shot': 'koc-contact/run-koc-one-shot.mjs',
  'capture-session': 'capture-source-session.mjs', connect: 'connect-browser.mjs',
  'initialize-base': 'initialize-base.mjs', 'bootstrap-background': 'bootstrap-background.mjs',
});
export function invocation(mode, args, config, env = process.env) {
  if (!Object.hasOwn(ENTRYPOINTS, mode)) throw new Error('Choose readiness, daily, one-shot, capture-session, connect, initialize-base, or bootstrap-background');
  const errors = validateConfig(effectiveConfig(config, env));
  if (errors.length) throw new Error(`Run npm run setup to configure this machine: ${errors.join('; ')}`);
  return { executable: process.execPath, args: [join(ROOT, 'runtime', ENTRYPOINTS[mode]), ...args], env: configEnvironment(config, env) };
}
export function main(args = process.argv.slice(2)) {
  if (!supportedNode()) throw new Error('This runtime requires Node.js 26.x.');
  const call = invocation(args[0], args.slice(1), readConfig());
  const child = spawn(call.executable, call.args, { cwd: ROOT, env: call.env, stdio: 'inherit', shell: false });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
