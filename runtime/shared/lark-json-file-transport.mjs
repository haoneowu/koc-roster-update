import fs from 'node:fs/promises';
import fsConstants from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from './child-process.mjs';

const ERROR_CODES = new Set([
  'LARK_JSON_TRANSPORT_ARGUMENT_INVALID',
  'LARK_JSON_TRANSPORT_BODY_INVALID',
  'LARK_JSON_TRANSPORT_TEMP_PARENT_UNSAFE',
  'LARK_JSON_TRANSPORT_TEMP_UNSAFE',
  'LARK_JSON_TRANSPORT_FILE_UNSAFE',
  'LARK_JSON_TRANSPORT_COMMAND_FAILED',
  'LARK_JSON_TRANSPORT_PROJECTION_FAILED',
  'LARK_JSON_TRANSPORT_PROJECTION_INVALID',
  'LARK_JSON_TRANSPORT_PROJECTION_LOGGED',
  'LARK_JSON_TRANSPORT_PROJECTION_UNSAFE',
  'LARK_JSON_TRANSPORT_CLEANUP_FAILED',
]);

const SAFE_ARGUMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeError(error) {
  try {
    if (ERROR_CODES.has(error?.code)) return fail(error.code);
  } catch {
    // A hostile thrown value must not be able to replace the stable error.
  }
  return fail('LARK_JSON_TRANSPORT_COMMAND_FAILED');
}

function validArgument(value) {
  return typeof value === 'string' && SAFE_ARGUMENT.test(value);
}

function assertJsonData(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('invalid JSON number');
    return;
  }
  if (typeof value !== 'object' || ancestors.has(value)) throw new Error('invalid JSON value');

  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (isArray ? prototype !== Array.prototype
    : prototype !== Object.prototype && prototype !== null) throw new Error('invalid JSON prototype');
  ancestors.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string')) throw new Error('symbol JSON key');
    if (isArray) {
      const allowed = new Set(['length']);
      for (let index = 0; index < value.length; index += 1) {
        const key = String(index);
        allowed.add(key);
        if (!Object.hasOwn(value, key)) throw new Error('sparse JSON array');
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('non-data JSON array item');
        assertJsonData(descriptor.value, ancestors);
      }
      if (keys.some(key => !allowed.has(key))) throw new Error('extra JSON array property');
    } else {
      if (keys.length === 0) throw new Error('empty JSON object');
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('non-data JSON property');
        assertJsonData(descriptor.value, ancestors);
      }
    }
  } finally {
    ancestors.delete(value);
  }
}

function serializedBody(body) {
  try {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid body');
    assertJsonData(body);
    const text = JSON.stringify(body);
    if (typeof text !== 'string' || text === '{}') throw new Error('invalid body');
    return {text, snapshot:JSON.parse(text)};
  } catch {
    throw fail('LARK_JSON_TRANSPORT_BODY_INVALID');
  }
}

function bodyStringValues(value, output = []) {
  if (typeof value === 'string') {
    if (value.length > 0) output.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) bodyStringValues(item, output);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) bodyStringValues(item, output);
  }
  return output;
}

function cloneProjection(value, body) {
  let text;
  try { text = JSON.stringify(value); }
  catch { throw fail('LARK_JSON_TRANSPORT_PROJECTION_INVALID'); }
  if (typeof text !== 'string') throw fail('LARK_JSON_TRANSPORT_PROJECTION_INVALID');
  // This catches direct echoes as a defense in depth; transformed or encoded
  // copies need the caller's trusted projection to be excluded by design.
  if (bodyStringValues(body).some(secret => text.includes(secret))) {
    throw fail('LARK_JSON_TRANSPORT_PROJECTION_UNSAFE');
  }
  try { return JSON.parse(text); }
  catch { throw fail('LARK_JSON_TRANSPORT_PROJECTION_INVALID'); }
}

async function removePrivateWorkingDirectory(directory) {
  let stat;
  try { stat = await fs.lstat(directory); }
  catch (error) {
    if (error?.code === 'ENOENT') return;
    throw fail('LARK_JSON_TRANSPORT_CLEANUP_FAILED');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw fail('LARK_JSON_TRANSPORT_CLEANUP_FAILED');
  }
  try {
    // The child process may have tightened permissions on its cwd. Restore
    // owner access before recursive removal, then confirm the path is still
    // the private directory we inspected.
    await fs.chmod(directory, 0o700);
    stat = await fs.lstat(directory);
    const resolved = await fs.realpath(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700) || resolved !== directory) {
      throw new Error('directory changed before cleanup');
    }
    await fs.rm(directory, {recursive:true, force:true});
  } catch {
    throw fail('LARK_JSON_TRANSPORT_CLEANUP_FAILED');
  }
}

function projectQuietly(projectResponse, response) {
  try {
    if (Object.getPrototypeOf(projectResponse) === Object.getPrototypeOf(async function() {})) {
      throw fail('LARK_JSON_TRANSPORT_PROJECTION_INVALID');
    }
  } catch {
    throw fail('LARK_JSON_TRANSPORT_PROJECTION_INVALID');
  }

  const writes = {attempted:false};
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  const consoleMethods = ['log','info','warn','error','debug'];
  const originalConsole = new Map(consoleMethods.map(name => [name, console[name]]));
  const suppress = () => {
    writes.attempted = true;
    return true;
  };

  let projected;
  let projectionError;
  try {
    process.stdout.write = suppress;
    process.stderr.write = suppress;
    for (const name of consoleMethods) console[name] = suppress;
    projected = projectResponse(response);
    if (projected && (typeof projected === 'object' || typeof projected === 'function') &&
        typeof projected.then === 'function') {
      throw fail('LARK_JSON_TRANSPORT_PROJECTION_INVALID');
    }
  } catch (error) {
    projectionError = error;
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    for (const name of consoleMethods) console[name] = originalConsole.get(name);
  }
  if (projectionError) {
    let code;
    try { code = projectionError?.code; } catch { /* Keep the stable failure below. */ }
    if (code === 'LARK_JSON_TRANSPORT_PROJECTION_INVALID') throw fail(code);
    throw fail('LARK_JSON_TRANSPORT_PROJECTION_FAILED');
  }
  if (writes.attempted) throw fail('LARK_JSON_TRANSPORT_PROJECTION_LOGGED');
  return projected;
}

async function createPrivateWorkingDirectory(tempParent) {
  if (typeof tempParent !== 'string' || !path.isAbsolute(tempParent)) {
    throw fail('LARK_JSON_TRANSPORT_TEMP_PARENT_UNSAFE');
  }
  const canonicalParent = path.resolve(tempParent);
  if (canonicalParent !== tempParent) throw fail('LARK_JSON_TRANSPORT_TEMP_PARENT_UNSAFE');
  const root = path.parse(canonicalParent).root;
  let cursor = root;
  const components = canonicalParent.slice(root.length).split(path.sep).filter(Boolean);
  for (const component of components) {
    cursor = path.join(cursor, component);
    let stat;
    try { stat = await fs.lstat(cursor); }
    catch { throw fail('LARK_JSON_TRANSPORT_TEMP_PARENT_UNSAFE'); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw fail('LARK_JSON_TRANSPORT_TEMP_PARENT_UNSAFE');
    }
  }

  let directory;
  try { directory = await fs.mkdtemp(path.join(canonicalParent, 'lark-json-transport-')); }
  catch { throw fail('LARK_JSON_TRANSPORT_TEMP_UNSAFE'); }
  try {
    await fs.chmod(directory, 0o700);
    const stat = await fs.lstat(directory);
    const resolved = await fs.realpath(directory);
    const relative = path.relative(canonicalParent, directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700) ||
        resolved !== directory || !relative || relative === '..' ||
        relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw fail('LARK_JSON_TRANSPORT_TEMP_UNSAFE');
    }
  } catch {
    try { await removePrivateWorkingDirectory(directory); }
    catch { throw fail('LARK_JSON_TRANSPORT_CLEANUP_FAILED'); }
    throw fail('LARK_JSON_TRANSPORT_TEMP_UNSAFE');
  }
  return directory;
}

async function writePrivateBody(directory, text) {
  const filename = path.join(directory, 'payload.json');
  const noFollow = fsConstants.constants.O_NOFOLLOW || 0;
  let handle;
  try {
    handle = await fs.open(filename,
      fsConstants.constants.O_WRONLY | fsConstants.constants.O_CREAT |
      fsConstants.constants.O_EXCL | noFollow,
      0o600);
    await handle.writeFile(text, 'utf8');
    await handle.chmod(0o600);
    await handle.close();
    handle = undefined;
  } catch {
    await handle?.close().catch(() => {});
    throw fail('LARK_JSON_TRANSPORT_FILE_UNSAFE');
  }

  let stat;
  let resolved;
  try {
    stat = await fs.lstat(filename);
    resolved = await fs.realpath(filename);
  } catch {
    throw fail('LARK_JSON_TRANSPORT_FILE_UNSAFE');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) ||
      resolved !== filename || path.dirname(resolved) !== directory) {
    throw fail('LARK_JSON_TRANSPORT_FILE_UNSAFE');
  }
}

/**
 * Run one existing-record Base update with the JSON body kept out of argv and
 * environment variables. `projectResponse` receives raw CLI output only in
 * memory and must be trusted synchronous code that returns only the minimal
 * JSON-safe result needed by its caller. Ordinary synchronous writes through
 * stdout, stderr, and console are suppressed and rejected. The callback must
 * not schedule deferred work, write files, use other logging channels, or
 * expose body values in transformed form: it runs in this process, so this
 * helper cannot sandbox arbitrary callback side effects or detect transformed
 * copies of sensitive values. Direct body-string echoes are rejected.
 */
export async function runLarkRecordUpsert({
  executable = 'lark-cli',
  tempParent,
  profile,
  identity,
  baseToken,
  tableId,
  recordId,
  body,
  projectResponse,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof executable !== 'string' || !executable || executable.includes('\0') ||
      !validArgument(profile) || !['user', 'bot'].includes(identity) ||
      !validArgument(baseToken) || !validArgument(tableId) || !validArgument(recordId) ||
      typeof projectResponse !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw fail('LARK_JSON_TRANSPORT_ARGUMENT_INVALID');
  }

  const {text:bodyText, snapshot:bodySnapshot} = serializedBody(body);
  let directory;
  let projected;
  let operationError;
  try {
    const parent = tempParent === undefined ? await fs.realpath(os.tmpdir()) : tempParent;
    directory = await createPrivateWorkingDirectory(parent);
    await writePrivateBody(directory, bodyText);

    const args = [
      'base', '+record-upsert',
      '--profile', profile,
      '--as', identity,
      '--base-token', baseToken,
      '--table-id', tableId,
      '--record-id', recordId,
      '--json', '@payload.json',
      '--format', 'json',
  ];
    let child;
    try {
      child = spawnSync(executable, args, {
        cwd: directory,
        env: {...process.env},
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      });
    } catch {
      throw fail('LARK_JSON_TRANSPORT_COMMAND_FAILED');
    }

    const stdout = typeof child.stdout === 'string' ? child.stdout : '';
    const stderr = typeof child.stderr === 'string' ? child.stderr : '';
    if (child.error || child.status !== 0) {
      throw fail('LARK_JSON_TRANSPORT_COMMAND_FAILED');
    }

    try {
      await removePrivateWorkingDirectory(directory);
      directory = undefined;
    } catch {
      throw fail('LARK_JSON_TRANSPORT_CLEANUP_FAILED');
    }
    projected = projectQuietly(projectResponse, Object.freeze({stdout, stderr, status:child.status, signal:child.signal}));
    projected = cloneProjection(projected, bodySnapshot);
  } catch (error) {
    operationError = normalizeError(error);
  }

  let cleanupFailed = false;
  if (directory) {
    try { await removePrivateWorkingDirectory(directory); }
    catch { cleanupFailed = true; }
  }
  if (cleanupFailed) throw fail('LARK_JSON_TRANSPORT_CLEANUP_FAILED');
  if (operationError) throw operationError;
  return projected;
}
