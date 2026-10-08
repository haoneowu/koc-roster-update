import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { CONFIG_ENV, configPath, readConfig, effectiveConfig, validateConfig } from './config.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function supportedNode(version = process.versions.node) { return Number(version.split('.')[0]) === 26; }
export function chromeCandidates(platform = process.platform, env = process.env) {
  if (env.CHROME_PATH) return [env.CHROME_PATH];
  if (platform === 'win32') return [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean).map(base => join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  if (platform === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
}
export function parseArgs(args) {
  const result = { values: {}, install: false, doctor: false, configure: false, help: false };
  const fields = { '--profile': 'profile', '--identity': 'identity', '--host': 'host', '--base-token': 'baseToken', '--table-id': 'tableId', '--account-marker': 'accountMarker' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (fields[arg]) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`);
      result.values[fields[arg]] = args[++i].trim();
    } else if (['--install', '--doctor', '--configure', '--help'].includes(arg)) result[arg.slice(2)] = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (Object.keys(result.values).length) result.configure = true;
  if (!args.length) { result.install = true; result.configure = true; }
  return result;
}
function npmInstall() {
  const action = existsSync(join(ROOT, 'package-lock.json')) ? 'ci' : 'install';
  console.log(`Installing bundled runtime dependencies: npm ${action}`);
  // npm is launched as a JS file to avoid Windows .cmd quoting and shell execution.
  const npmCli = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const args = [action, '--no-audit', '--no-fund'];
  const result = existsSync(npmCli)
    ? spawnSync(process.execPath, [npmCli, ...args], { cwd: ROOT, stdio: 'inherit' })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error || result.status !== 0) throw new Error(`Dependency installation failed. Install Node.js 26.x with npm, then run npm ${action} in this folder. ${result.error?.message || ''}`);
  ensureLarkNative();
}
export function bundledLarkBinary(root = ROOT, platform = process.platform) {
  return join(root, 'node_modules', '@larksuite', 'cli', 'bin', platform === 'win32' ? 'lark-cli.exe' : 'lark-cli');
}
export function ensureLarkNative({ root = ROOT, invoke = spawnSync } = {}) {
  const binary = bundledLarkBinary(root);
  const probe = () => invoke(binary, ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  const first = probe();
  if (!first.error && first.status === 0) return binary;
  const installer = join(root, 'node_modules', '@larksuite', 'cli', 'scripts', 'install.js');
  if (!existsSync(installer)) throw new Error('Pinned lark-cli installer is missing. Run npm ci and try setup --install again.');
  console.log('Installing the pinned official lark-cli native executable (checksum verified by its installer).');
  const installed = invoke(process.execPath, [installer], { cwd: root, stdio: 'inherit', env: { ...process.env, LARK_CLI_RUN: 'true' } });
  if (installed.error || installed.status !== 0) throw new Error('Official lark-cli native installation failed. Check download/network output and retry setup --install.');
  const final = probe();
  if (final.error || final.status !== 0) throw new Error('lark-cli native executable failed its version check after installation.');
  return binary;
}
export function findLark() {
  const localLark = bundledLarkBinary();
  if (existsSync(localLark)) return localLark;
  // A present package with no native payload is an incomplete installation.
  if (existsSync(join(ROOT, 'node_modules', '@larksuite', 'cli', 'package.json'))) return null;
  const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['lark-cli'], { encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : null;
}
export function dependencyInstalled(dependency, root = ROOT) {
  const require = createRequire(join(root, 'package.json'));
  try { require.resolve(dependency); return true; } catch {}
  // CLI-only packages can intentionally omit a main export. Validate their
  // package metadata and actual executable rather than treating that as absent.
  let manifest;
  try { manifest = require.resolve(`${dependency}/package.json`); }
  catch { manifest = join(root, 'node_modules', dependency, 'package.json'); }
  try {
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    const bins = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin || {});
    return bins.length > 0 && bins.every(bin => typeof bin === 'string' && existsSync(resolve(dirname(manifest), bin)));
  } catch { return false; }
}
export function doctor() {
  const checks = [];
  checks.push(['Node.js 26.x', supportedNode(), process.versions.node]);
  const require = createRequire(join(ROOT, 'package.json'));
  let dependencies = {};
  try { dependencies = require('./package.json').dependencies || {}; } catch { checks.push(['package.json', false, 'Missing or invalid package.json']); }
  for (const dependency of Object.keys(dependencies)) {
    const installed = dependencyInstalled(dependency);
    checks.push([dependency, installed, installed ? 'installed' : 'Run node scripts/setup.mjs --install']);
  }
  const chrome = chromeCandidates().find(existsSync);
  checks.push(['Chrome', Boolean(chrome), chrome || 'Install Google Chrome or set CHROME_PATH to its executable']);
  const lark = findLark();
  const version = lark && spawnSync(lark, ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  const larkWorks = Boolean(version && !version.error && version.status === 0);
  checks.push(['lark-cli', larkWorks, larkWorks ? `${lark} (${version.stdout.trim()})` : 'Native executable missing or unusable. Run node scripts/setup.mjs --install; authentication is a separate step']);
  const errors = validateConfig(effectiveConfig(readConfig()));
  checks.push(['Configuration', !errors.length, errors.length ? errors.join('; ') : configPath()]);
  for (const [name, okay, detail] of checks) console.log(`${okay ? 'OK' : 'MISSING'} ${name}: ${detail}`);
  console.log('This local check does not verify Feishu authorization, resource access, Chrome login, or production readiness.');
  return checks.every(([, okay]) => okay);
}
async function configure(values) {
  const config = { ...readConfig(), ...values };
  if (process.stdin.isTTY) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      for (const key of Object.keys(CONFIG_ENV)) if (!values[key]) {
        const answer = (await prompt.question(`${key}${config[key] ? ` [${config[key]}]` : ''}: `)).trim();
        if (answer) config[key] = answer;
      }
    } finally { prompt.close(); }
  }
  const errors = validateConfig(config);
  if (errors.length) throw new Error(`Configuration incomplete: ${errors.join('; ')}. Use --configure interactively or supply all six configuration flags.`);
  const safe = Object.fromEntries(Object.keys(CONFIG_ENV).map(key => [key, config[key]]));
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(safe, null, 2)}\n`, { mode: 0o600 });
  console.log(`Configuration saved: ${path}. No login credentials are stored by this installer.`);
}
export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    console.log('Usage: node scripts/setup.mjs [--install] [--configure] [--doctor]\nConfiguration flags: --profile NAME --identity user --host TENANT.feishu.cn --base-token TOKEN --table-id ID --account-marker TEXT\nNo flags: install dependencies and prompt for configuration. --doctor only reads local state.');
    return;
  }
  if (!supportedNode()) throw new Error('Node.js 26.x is required. Install it from https://nodejs.org/ and reopen your terminal.');
  if (options.install) npmInstall();
  if (options.configure) await configure(options.values);
  if (options.doctor && !doctor()) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
