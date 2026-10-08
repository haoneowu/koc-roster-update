import {createHash, randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const AUTH_CODES = new Set(['AUTH_REQUIRED', 'AUTH_EXPIRED', 'KOC_SOURCE_LOGIN_REQUIRED']);
const BINDING_CODES = new Set([
  'BROWSER_BINDING_MISSING', 'PAGE_BINDING_MISSING', 'TARGET_PAGE_CLOSED',
  'TARGET_PAGE_AMBIGUOUS', 'BACKGROUND_TARGET_CLOSED', 'BACKGROUND_TARGET_VISIBLE',
  'EXECUTION_CONTEXT_CHANGED',
]);
const TRANSIENT_CODES = new Set([
  'BROWSER_ERROR', 'TIMEOUT', 'TOTAL_TIMEOUT', 'NETWORK_ERROR',
  'WECHAT_ROW_NOT_READY', 'DETAIL_NOT_OPENED', 'POPUP_NOT_OPENED',
]);

const ACTIONS = Object.freeze({
  website_auth_failure: 'login',
  browser_binding_missing: 'restore_browser_binding',
  exhausted_transient_failure: 'maintainer_recovery',
  unknown_write: 'reconcile_write',
});

const PLATFORM_LABELS = Object.freeze({chanmama: 'ChanMama', buyin: 'Buyin'});

const ACTION_LABELS = Object.freeze({
  maintainer_recovery: '由维护者检查脱敏运行回执并决定下一次有界恢复；不要盲目重试。',
  reconcile_write: '先读取并对账平台当前值及原操作回执；确认前不要重放写入。',
});

const SUBJECTS = Object.freeze({
  website_auth_failure: 'KOC 脚本异常：网站认证需要处理',
  browser_binding_missing: 'KOC 脚本异常：浏览器页面绑定缺失',
  exhausted_transient_failure: 'KOC 脚本异常：临时故障重试已耗尽',
  unknown_write: 'KOC 脚本异常：写入结果需要对账',
});

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u;
const MAX_INCIDENT_KEY_LENGTH = 1024;
const DEFAULT_LOCK_TIMEOUT_MS = 3000;

function codeFrom(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/u.test(value)
    ? value
    : 'UNKNOWN_ERROR';
}

function normalizeOutcome(value) {
  return typeof value === 'string' ? value.trim().toLocaleLowerCase('en-US').replaceAll('-', '_') : '';
}

function safePlatform(value) {
  if (typeof value !== 'string') return 'unknown';
  const key = value.trim().toLocaleLowerCase('en-US');
  return Object.hasOwn(PLATFORM_LABELS, key) ? key : 'unknown';
}

function isUnknownWrite(incident) {
  return incident?.writeState === 'uncertain' || incident?.writeOutcome === 'unknown' ||
    normalizeOutcome(incident?.outcome) === 'uncertain';
}

/** Classify only explicit, machine-verifiable conditions. Raw error text is ignored. */
export function classifyKocError(incident = {}) {
  if (isUnknownWrite(incident)) {
    return {shouldAlert: true, category: 'unknown_write', action: ACTIONS.unknown_write,
      code: 'WRITE_OUTCOME_UNCERTAIN'};
  }

  const outcome = normalizeOutcome(incident.outcome ?? incident.contactStatus ?? incident.status);
  if (outcome === 'not_shown' || outcome === 'no_match') {
    return {shouldAlert: false, disposition: 'suppressed', reason: 'BUSINESS_RESULT'};
  }

  const code = codeFrom(incident.errorCode ?? incident.reason);
  if (incident.authFailureVerified === true && AUTH_CODES.has(code)) {
    return {shouldAlert: true, category: 'website_auth_failure', action: ACTIONS.website_auth_failure,
      code, platform: safePlatform(incident.platform)};
  }
  if (incident.browserBindingMissingVerified === true && BINDING_CODES.has(code)) {
    return {shouldAlert: true, category: 'browser_binding_missing',
      action: ACTIONS.browser_binding_missing, code, platform: safePlatform(incident.platform)};
  }
  if (incident.cliConnectionTimeoutVerified === true && code === 'CLI_CONNECTION_TIMEOUT') {
    return {shouldAlert: true, category: 'browser_binding_missing',
      action: ACTIONS.browser_binding_missing, code, platform: safePlatform(incident.platform)};
  }
  if (incident.transientFailureVerified === true && incident.attemptsExhausted === true &&
      TRANSIENT_CODES.has(code)) {
    return {shouldAlert: true, category: 'exhausted_transient_failure',
      action: ACTIONS.maintainer_recovery, code, platform: safePlatform(incident.platform)};
  }
  if (incident.transientFailureVerified === true && incident.attemptsExhausted !== true) {
    return {shouldAlert: false, disposition: 'suppressed', reason: 'RETRY_AVAILABLE'};
  }
  return {shouldAlert: false, disposition: 'suppressed', reason: 'NOT_ACTIONABLE'};
}

function validateRecipient(recipient) {
  if (typeof recipient !== 'string' || recipient.length > 254 || !EMAIL_RE.test(recipient)) {
    throw new Error('KOC_ALERT_RECIPIENT_INVALID');
  }
  return recipient;
}

function validateIncidentKey(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_INCIDENT_KEY_LENGTH) {
    throw new Error('KOC_ALERT_INCIDENT_KEY_INVALID');
  }
  return value;
}

function incidentDigest(incidentKey, classification) {
  return createHash('sha256')
    .update(`${incidentKey}\0${classification.category}\0${classification.code}`, 'utf8')
    .digest('hex');
}

/** Build a fixed, minimal email. No caller-supplied exception, page, target, or contact data is copied. */
export function buildKocErrorAlertMessage({classification, incidentRef, recipient} = {}) {
  const to = validateRecipient(recipient);
  if (!classification?.shouldAlert || !SUBJECTS[classification.category] ||
      ACTIONS[classification.category] !== classification.action ||
      typeof incidentRef !== 'string' || !/^[a-f0-9]{12,64}$/u.test(incidentRef)) {
    throw new Error('KOC_ALERT_MESSAGE_INPUT_INVALID');
  }
  const platform = PLATFORM_LABELS[classification.platform] || '';
  let action;
  if (classification.action === 'login') {
    action = platform
      ? `由在线操作者检查并恢复 ${platform} 登录状态，然后从原检查点继续。`
      : '目标站点未确认；请维护者先核对本地运行配置，再决定登录处理，不要直接要求用户重新登录。';
  } else if (classification.action === 'restore_browser_binding') {
    action = platform
      ? `核对并恢复 ${platform} 对应的原有浏览器和页面绑定；这不证明网站已登出，不要要求重新登录或新建页面。`
      : '目标站点未确认；维护者先核对既有浏览器和页面绑定。这不证明网站已登出，不要要求重新登录或新建页面。';
  } else {
    action = ACTION_LABELS[classification.action];
  }
  if (!action || codeFrom(classification.code) !== classification.code) {
    throw new Error('KOC_ALERT_MESSAGE_INPUT_INVALID');
  }
  const text = [
    'KOC 自动化检测到需要处理的异常。',
    `目标站点：${platform || '未确认（请维护者从本地运行配置判断）'}`,
    `类型：${SUBJECTS[classification.category].replace(/^KOC 脚本异常：/u, '')}`,
    `机器码：${classification.code}`,
    `事件编号：${incidentRef}`,
    `建议动作：${action}`,
    '此消息是异常通知；邮件接受状态不代表收件人已收到。',
  ].join('\n');
  return {to, subject: SUBJECTS[classification.category], text, incidentRef};
}

function timestamp(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('KOC_ALERT_CLOCK_INVALID');
  return date.toISOString();
}

function emptyState() {
  return {version: 1, incidents: {}};
}

async function readState(statePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, 'utf8'));
    if (parsed?.version !== 1 || !parsed.incidents || typeof parsed.incidents !== 'object' ||
        Array.isArray(parsed.incidents)) throw new Error('KOC_ALERT_STATE_INVALID');
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyState();
    if (error?.message === 'KOC_ALERT_STATE_INVALID') throw error;
    if (error instanceof SyntaxError) throw new Error('KOC_ALERT_STATE_INVALID');
    throw new Error('KOC_ALERT_STATE_READ_FAILED');
  }
}

async function writeState(statePath, state) {
  const directory = path.dirname(statePath);
  await fs.mkdir(directory, {recursive: true, mode: 0o700});
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(state));
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, statePath);
    await fs.chmod(statePath, 0o600);
  } catch {
    await handle?.close().catch(() => {});
    await fs.unlink(temporaryPath).catch(() => {});
    throw new Error('KOC_ALERT_STATE_WRITE_FAILED');
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function acquireStateLock(statePath, timeoutMs) {
  const lockPath = `${statePath}.lock`;
  const deadline = Date.now() + timeoutMs;
  await fs.mkdir(path.dirname(statePath), {recursive: true, mode: 0o700});
  while (true) {
    try {
      await fs.mkdir(lockPath, {mode: 0o700});
      return async () => fs.rmdir(lockPath).catch(() => {});
    } catch (error) {
      if (error?.code !== 'EEXIST') throw new Error('KOC_ALERT_STATE_LOCK_FAILED');
      if (Date.now() >= deadline) throw new Error('KOC_ALERT_STATE_LOCK_TIMEOUT');
      await delay(10);
    }
  }
}

async function withStateLock(statePath, timeoutMs, action) {
  const release = await acquireStateLock(statePath, timeoutMs);
  try {
    return await action();
  } finally {
    await release();
  }
}

function duplicateResult(record, incidentRef) {
  const status = record.status === 'send_started' ? 'outcome_unknown' : record.status;
  return {status, duplicate: true, incidentRef};
}

/**
 * Persist a send reservation before calling the injected transport. Any interrupted
 * or ambiguous send is deduplicated as unknown so callers never blindly resend it.
 */
export async function notifyKocError({
  incident,
  incidentKey,
  statePath,
  config,
  transport,
  now = () => new Date(),
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
} = {}) {
  const classification = classifyKocError(incident);
  if (!classification.shouldAlert) {
    return {status: 'suppressed', reason: classification.reason};
  }
  if (config?.enabled !== true) return {status: 'disabled'};
  const recipient = validateRecipient(config?.recipient);
  const key = validateIncidentKey(incidentKey);
  if (typeof statePath !== 'string' || statePath.length === 0) throw new Error('KOC_ALERT_STATE_PATH_REQUIRED');
  if (typeof transport !== 'function') throw new Error('KOC_ALERT_TRANSPORT_REQUIRED');
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 0 || lockTimeoutMs > 30000) {
    throw new Error('KOC_ALERT_LOCK_TIMEOUT_INVALID');
  }

  const digest = incidentDigest(key, classification);
  const incidentRef = digest.slice(0, 12);
  const message = buildKocErrorAlertMessage({classification, incidentRef, recipient});
  const reservation = await withStateLock(statePath, lockTimeoutMs, async () => {
    const state = await readState(statePath);
    const existing = state.incidents[digest];
    if (existing) return {duplicate: duplicateResult(existing, incidentRef)};
    const at = timestamp(now);
    state.incidents[digest] = {
      category: classification.category,
      action: classification.action,
      code: classification.code,
      status: 'send_started',
      createdAt: at,
      updatedAt: at,
    };
    await writeState(statePath, state);
    return {reserved: true};
  });
  if (reservation.duplicate) return reservation.duplicate;

  let transportResult;
  try {
    transportResult = await transport(message);
  } catch {
    transportResult = {status: 'outcome_unknown'};
  }
  const outcome = transportResult?.status === 'accepted' ? 'accepted' :
    transportResult?.status === 'rejected' ? 'rejected' : 'outcome_unknown';
  try {
    await withStateLock(statePath, lockTimeoutMs, async () => {
      const state = await readState(statePath);
      const record = state.incidents[digest];
      if (!record) throw new Error('KOC_ALERT_STATE_ENTRY_MISSING');
      record.status = outcome;
      record.updatedAt = timestamp(now);
      await writeState(statePath, state);
    });
  } catch {
    return {status: 'outcome_unknown', incidentRef};
  }
  return {status: outcome, duplicate: false, incidentRef};
}
