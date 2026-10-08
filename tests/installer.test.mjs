import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { configPath, configEnvironment, validateConfig, effectiveConfig, readConfig } from '../scripts/config.mjs';
import { supportedNode, chromeCandidates, parseArgs, ROOT, dependencyInstalled, findLark, bundledLarkBinary, ensureLarkNative } from '../scripts/setup.mjs';
import { invocation } from '../scripts/run.mjs';
const valid = { profile: 'work', identity: 'user', host: 'tenant.feishu.cn', baseToken: 'base-example', tableId: 'tbl-example', accountMarker: 'example-account' };

test('runtime release permits Node 26.x only', () => {
  assert.equal(supportedNode('26.0.0'), true);
  assert.equal(supportedNode('26.9.0'), true);
  assert.equal(supportedNode('25.9.0'), false);
  assert.equal(supportedNode('27.0.0'), false);
});
test('user configuration lives outside repository on every platform', () => {
  assert.equal(configPath('win32', { APPDATA: '/roaming' }, '/home'), join('/roaming', 'KOC Roster Update', 'config.json'));
  assert.equal(configPath('darwin', {}, '/home'), join('/home', 'Library', 'Application Support', 'KOC Roster Update', 'config.json'));
  assert.equal(configPath('linux', { XDG_CONFIG_HOME: '/settings' }, '/home'), join('/settings', 'koc-roster-update', 'config.json'));
});
test('configuration validation and explicit environment precedence', () => {
  assert.deepEqual(validateConfig(valid), []);
  assert.ok(validateConfig({ ...valid, identity: 'administrator' }).length);
  assert.ok(validateConfig({ ...valid, identity: 'bot' }).some(error => error.includes('bot is unsupported')));
  assert.ok(validateConfig({ ...valid, host: 'https://tenant.feishu.cn/path' }).length);
  assert.ok(validateConfig({ ...valid, profile: 'a\nb' }).length);
  const env = configEnvironment(valid, { KOC_FEISHU_PROFILE: 'override', KEEP: 'keep' });
  assert.equal(env.KOC_FEISHU_PROFILE, 'override');
  assert.equal(env.KOC_FEISHU_TABLE_ID, valid.tableId);
  assert.equal(env.KOC_BUYIN_ACCOUNT_MARKER, valid.accountMarker);
  assert.equal(env.KEEP, 'keep');
  assert.equal(effectiveConfig(valid, env).profile, 'override');
});
test('CLI configuration flags preserve account marker and reject missing/unknown arguments', () => {
  assert.equal(parseArgs(['--profile', 'work', '--account-marker', '店铺 A']).values.accountMarker, '店铺 A');
  assert.throws(() => parseArgs(['--profile', '--doctor']), /Missing value/);
  assert.throws(() => parseArgs(['--secret', 'secret']), /Unknown argument/);
  assert.equal(parseArgs(['--doctor']).configure, false);
});
test('Windows Chrome detection honors install directories and explicit override', () => {
  assert.deepEqual(chromeCandidates('win32', { CHROME_PATH: 'C:\\Custom Chrome\\chrome.exe' }), ['C:\\Custom Chrome\\chrome.exe']);
  assert.equal(chromeCandidates('win32', { LOCALAPPDATA: '/user-local' })[0], join('/user-local', 'Google', 'Chrome', 'Application', 'chrome.exe'));
});
test('runtime wrapper preserves arguments as data and validates configuration before launch', () => {
  const marker = '店铺 & $(echo nope)';
  const call = invocation('readiness', ['--example', marker], { ...valid, accountMarker: marker }, {});
  assert.equal(call.env.KOC_BUYIN_ACCOUNT_MARKER, marker);
  assert.deepEqual(call.args.slice(1), ['--example', marker]);
  assert.match(call.args[0], /readiness-live-server\.mjs$/);
  assert.match(invocation('capture-session', [], valid, {}).args[0], /runtime[/\\]capture-source-session\.mjs$/);
  assert.match(invocation('connect', [], valid, {}).args[0], /runtime[/\\]connect-browser\.mjs$/);
  assert.match(invocation('initialize-base', ['--apply'], valid, {}).args[0], /runtime[/\\]initialize-base\.mjs$/);
  assert.match(invocation('bootstrap-background', [], valid, {}).args[0], /runtime[/\\]bootstrap-background\.mjs$/);
  assert.throws(() => invocation('daily', [], {}, {}), /configure this machine/);
  assert.throws(() => invocation('../wrong', [], valid, {}), /Choose/);
});
test('noninteractive setup persists only known configuration fields in user data directory', { skip: !supportedNode() }, () => {
  const folder = mkdtempSync(join(tmpdir(), 'koc-setup-'));
  try {
    // Override user-directory environment per native platform, never touch real user configuration.
    const env = { ...process.env, APPDATA: folder, XDG_CONFIG_HOME: folder, HOME: folder, USERPROFILE: folder };
    const args = ['--configure', '--profile', valid.profile, '--identity', valid.identity, '--host', valid.host, '--base-token', valid.baseToken, '--table-id', valid.tableId, '--account-marker', valid.accountMarker];
    const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'setup.mjs'), ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const savedPath = configPath(process.platform, env, folder);
    assert.deepEqual(readConfig(savedPath), valid);
    assert.equal(readFileSync(savedPath, 'utf8').includes('access_token'), false);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
test('Windows setup.cmd help executes native wrapper without invoking runtime', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync('cmd.exe', ['/d', '/c', 'setup.cmd --help'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: node scripts\/setup.mjs/);
});
test('PowerShell setup wrapper uses normal policy and forwards help', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-File', join(ROOT, 'scripts', 'setup.ps1'), '--help'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: node scripts\/setup.mjs/);
});
test('configuration failure does not write a partial file', { skip: !supportedNode() }, () => {
  const folder = mkdtempSync(join(tmpdir(), 'koc-incomplete-'));
  try {
    const env = { ...process.env, APPDATA: folder, XDG_CONFIG_HOME: folder, HOME: folder, USERPROFILE: folder };
    const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'setup.mjs'), '--configure', '--profile', 'work'], { env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Configuration incomplete/);
    assert.deepEqual(readConfig(configPath(process.platform, env, folder)), {});
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('doctor recognizes CLI-only packages and rejects missing bin files', () => {
  const folder = mkdtempSync(join(tmpdir(), 'koc-cli-doctor-'));
  try {
    const pkg = join(folder, 'node_modules', '@example', 'cli');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(folder, 'package.json'), '{}');
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@example/cli', bin: { cli: './bin.cjs' } }));
    assert.equal(dependencyInstalled('@example/cli', folder), false);
    writeFileSync(join(pkg, 'bin.cjs'), 'console.log("example");');
    assert.equal(dependencyInstalled('@example/cli', folder), true);
    assert.equal(dependencyInstalled('missing-package', folder), false);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
test('doctor detects actual pinned CLI installations after npm ci', () => {
  assert.equal(dependencyInstalled('@playwright/cli'), true, 'Run npm ci before tests');
  assert.equal(dependencyInstalled('@larksuite/cli'), true, 'Run npm ci before tests');
  assert.equal(findLark(), bundledLarkBinary());
  const version = spawnSync(findLark(), ['--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
});

test('setup explicitly installs missing native CLI and verifies it before success', () => {
  const calls = [];
  const binary = ensureLarkNative({ invoke(command, args, options) {
    calls.push({ command, args, options });
    if (calls.length === 1) return { status: null, error: new Error('ENOENT') };
    return { status: 0, stdout: 'lark-cli version 1.0.97' };
  } });
  assert.equal(binary, bundledLarkBinary());
  assert.equal(calls.length, 3);
  assert.equal(calls[1].command, process.execPath);
  assert.deepEqual(calls[1].args, [join(ROOT, 'node_modules', '@larksuite', 'cli', 'scripts', 'install.js')]);
  assert.equal(calls[1].options.env.LARK_CLI_RUN, 'true');
  assert.deepEqual(calls[2].args, ['--version']);
  assert.throws(() => ensureLarkNative({ invoke() { return { status: 1 }; } }), /native installation failed/);
});
