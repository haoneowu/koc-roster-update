import {DATA_DIR} from '../shared/config.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pageFingerprint} from './roster-domain.mjs';

export const CHECKPOINT_VERSION = 2;
export const DEFAULT_STATE_DIR = DATA_DIR;
const MAX_RESUME_AGE_MS = 2 * 60 * 60 * 1000;

export async function ensurePrivateStateDir(stateDir = DEFAULT_STATE_DIR) {
  await fs.mkdir(stateDir, {recursive: true, mode: 0o700});
  await fs.chmod(stateDir, 0o700);
  return stateDir;
}

export async function writePrivateJson(filePath, value) {
  const directory = path.dirname(filePath);
  await ensurePrivateStateDir(directory);
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, 0o600);
  return filePath;
}

export async function readPrivateJson(filePath) {
  const text = await fs.readFile(filePath, 'utf8');
  return JSON.parse(text);
}

export function createCheckpoint({scopeKey, startedAt = new Date().toISOString(), pageSize = 50, targetCount = 500}) {
  if (!scopeKey) throw new Error('KOC_CHECKPOINT_SCOPE_REQUIRED');
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('KOC_CHECKPOINT_PAGE_SIZE_INVALID');
  if (!Number.isInteger(targetCount) || targetCount < 1) throw new Error('KOC_CHECKPOINT_TARGET_INVALID');
  return {version: CHECKPOINT_VERSION, scopeKey, startedAt, pageSize, targetCount, status: 'collecting', lastPage: 0,
    pages: [], rawRowCount: 0, sourceComplete: false};
}

export function assertResumableCheckpoint(checkpoint, {scopeKey, now = new Date(), maxAgeMs = MAX_RESUME_AGE_MS}) {
  if (!checkpoint || checkpoint.version !== CHECKPOINT_VERSION) throw new Error('KOC_CHECKPOINT_VERSION_UNSUPPORTED');
  if (checkpoint.scopeKey !== scopeKey) throw new Error('KOC_CHECKPOINT_SCOPE_MISMATCH');
  const age = now.getTime() - Date.parse(checkpoint.startedAt);
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) throw new Error('KOC_CHECKPOINT_EXPIRED');
  const storedLastPage=checkpoint.pages?.at(-1)?.page ?? 0;
  if (!Array.isArray(checkpoint.pages) || checkpoint.lastPage !== storedLastPage ||
      checkpoint.pages.some((item,index)=>item.page!==index+1)) {
    throw new Error('KOC_CHECKPOINT_PAGE_SEQUENCE_INVALID');
  }
  return true;
}

export function appendCheckpointPage(checkpoint, {page, rows, pageSize = checkpoint.pageSize, capturedAt = new Date().toISOString(), totalPages = null}) {
  if (!Number.isInteger(page) || page < 1 || !Array.isArray(rows) || !rows.length) throw new Error('KOC_CHECKPOINT_PAGE_INVALID');
  if (page !== checkpoint.lastPage + 1) throw new Error('KOC_CHECKPOINT_PAGE_NOT_SEQUENTIAL');
  if (rows.length > pageSize) throw new Error('KOC_CHECKPOINT_PAGE_OVERFLOW');
  const fingerprint = pageFingerprint(rows);
  const next = {
    ...checkpoint,
    lastPage: page,
    rawRowCount: checkpoint.rawRowCount + rows.length,
    pages: [...checkpoint.pages, {page, capturedAt, fingerprint, firstCreatorId: rows[0]?.creatorId || '',
      lastCreatorId: rows.at(-1)?.creatorId || '', rows}],
    totalPages: Number.isInteger(totalPages) && totalPages > 0 ? totalPages : checkpoint.totalPages ?? null,
  };
  return next;
}

export function verifyResumedPage(checkpoint, {page, rows}) {
  const stored = checkpoint.pages.find(item => item.page === page);
  if (!stored) {
    if (page !== checkpoint.lastPage + 1) throw new Error('KOC_CHECKPOINT_RESUME_GAP');
    return {matches: null, nextPage: true};
  }
  const fingerprint = pageFingerprint(rows);
  if (stored.fingerprint !== fingerprint) throw new Error(`KOC_CHECKPOINT_PAGE_CHANGED:${page}`);
  return {matches: true, nextPage: false};
}

export function finishCheckpoint(checkpoint, {status, targetReached = false, sourceComplete = false, finishedAt = new Date().toISOString()} = {}) {
  if (!['partial', 'target_reached', 'source_exhausted', 'failed'].includes(status)) throw new Error('KOC_CHECKPOINT_STATUS_INVALID');
  return {...checkpoint, status, targetReached: targetReached === true, sourceComplete: sourceComplete === true, finishedAt};
}
