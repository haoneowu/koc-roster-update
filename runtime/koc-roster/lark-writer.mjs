import {FEISHU_ROUTE,assertFeishuRoute} from '../shared/config.mjs';
import {spawnSync} from '../shared/child-process.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {
  CONTACT_PATCH_ALLOWLIST, ROSTER_FIELD_ALLOWLIST, assertContactPatch, assertRosterPatch,
  buildRosterRecordFields, formatLarkDateTime, normalizeText, ROSTER_SCOPE_KEY, ROSTER_SCOPE_LABEL,
} from './roster-domain.mjs';
import {DEFAULT_STATE_DIR, ensurePrivateStateDir, readPrivateJson, writePrivateJson} from './checkpoint.mjs';
import {runLarkRecordUpsert} from '../shared/lark-json-file-transport.mjs';

export {FEISHU_ROUTE} from '../shared/config.mjs';

export const ROSTER_READ_FIELDS = Object.freeze([
  'Text', '抖音号', '蝉妈妈来源', '采集批次', '榜单验证状态',
  '首次收录时间', '首次收录排名', '首次收录榜期', '最近观测排名',
  '最近观测榜期', '最近观测时间', '榜单筛选口径', '视频销售额',
  '蝉妈妈榜单指标原文', '当期在榜状态',
]);

export const REQUIRED_FIELD_DEFINITIONS = Object.freeze([
  {name:'首次收录时间', type:'datetime', style:{format:'yyyy-MM-dd HH:mm'}},
  {name:'首次收录排名', type:'number', style:{type:'plain', precision:0, thousands_separator:false}},
  {name:'首次收录榜期', type:'text', style:{type:'plain'}},
  {name:'最近观测排名', type:'number', style:{type:'plain', precision:0, thousands_separator:false}},
  {name:'最近观测榜期', type:'text', style:{type:'plain'}},
  {name:'最近观测时间', type:'datetime', style:{format:'yyyy-MM-dd HH:mm'}},
  {name:'榜单筛选口径', type:'text', style:{type:'plain'}},
  {name:'视频销售额', type:'text', style:{type:'plain'}},
  {name:'蝉妈妈榜单指标原文', type:'text', style:{type:'plain'}},
  {name:'当期在榜状态', type:'text', style:{type:'plain'}},
  {name:'联系方式最近错误', type:'text', style:{type:'plain'}},
  {name:'联系方式来源', type:'text', style:{type:'url'}},
]);

function parseJsonOutput(output) {
  const text = String(output || '').trim();
  if (!text) throw new Error('LARK_EMPTY_RESPONSE');
  try { return JSON.parse(text); } catch {}
  const lines = text.split(/\r?\n/).reverse();
  for (const line of lines) {
    try { return JSON.parse(line); } catch {}
  }
  throw new Error('LARK_RESPONSE_NOT_JSON');
}

export class LarkBaseClient {
  constructor({route = FEISHU_ROUTE, executable = 'lark-cli', invoke = spawnSync,
    privateRecordUpsert = runLarkRecordUpsert,
    recordLockDir = path.join(DEFAULT_STATE_DIR, 'record-locks'), pendingCreateMarkerDir = DEFAULT_STATE_DIR} = {}) {
    this.route = route;
    this.executable = executable;
    this.invoke = invoke;
    this.privateRecordUpsert = privateRecordUpsert;
    this.recordLockDir = recordLockDir;
    this.pendingCreateMarkerDir = pendingCreateMarkerDir;
  }

  call(args) {
    assertFeishuRoute(this.route);
    const fullArgs = [...args, '--profile', this.route.profile, '--as', this.route.as, '--format', 'json'];
    const result = this.invoke(this.executable, fullArgs, {encoding:'utf8', maxBuffer:32 * 1024 * 1024, timeout:120000});
    if (result.error || result.status !== 0) throw new Error('LARK_CLI_FAILED');
    return parseJsonOutput(result.stdout);
  }

  listFields() {
    return this.call(['base', '+field-list', '--base-token', this.route.baseToken, '--table-id', this.route.tableId]);
  }

  createField(definition) {
    return this.call(['base', '+field-create', '--base-token', this.route.baseToken, '--table-id', this.route.tableId,
      '--json', JSON.stringify(definition)]);
  }

  listRecordsPage({offset = 0, limit = 200, fieldNames = ROSTER_READ_FIELDS, filterJson = null} = {}) {
    const args = ['base', '+record-list', '--base-token', this.route.baseToken, '--table-id', this.route.tableId,
      '--offset', String(offset), '--limit', String(limit)];
    for (const field of fieldNames) args.push('--field-id', field);
    if (filterJson) args.push('--filter-json', typeof filterJson === 'string' ? filterJson : JSON.stringify(filterJson));
    return this.call(args);
  }

  getRecord(recordId, fieldNames = ROSTER_READ_FIELDS) {
    return this.call(['base', '+record-get', '--base-token', this.route.baseToken, '--table-id', this.route.tableId,
      '--record-id', recordId, '--fields', fieldNames.join(',')]);
  }

  recordHistoryList({recordId, pageSize = 50, maxVersion} = {}) {
    if (typeof recordId !== 'string' || !recordId.trim() || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50 ||
        maxVersion !== undefined && (!Number.isSafeInteger(maxVersion) || maxVersion < 0)) {
      throw new Error('LARK_RECORD_HISTORY_ARGUMENTS_INVALID');
    }
    const args = ['base', '+record-history-list', '--base-token', this.route.baseToken, '--table-id', this.route.tableId,
      '--record-id', recordId, '--page-size', String(pageSize)];
    if (maxVersion !== undefined) args.push('--max-version', String(maxVersion));
    return this.call(args);
  }

  async upsertRecord(fields, recordId = '') {
    assertFeishuRoute(this.route);
    if (recordId) {
      return this.privateRecordUpsert({
        executable:this.executable,
        profile:this.route.profile,
        identity:this.route.as,
        baseToken:this.route.baseToken,
        tableId:this.route.tableId,
        recordId,
        body:fields,
        timeoutMs:120000,
        projectResponse:({stdout})=>{
          const response=parseJsonOutput(stdout);
          const data=getData(response);
          return {
            ok:response?.ok===true,
            identity:response?.identity===this.route.as?this.route.as:'mismatch',
            data:{created:data?.created===true,updated:data?.updated===true},
          };
        },
      });
    }
    if (fields && Object.keys(fields).some(field=>CONTACT_PATCH_ALLOWLIST.has(field))) {
      throw new Error('KOC_CONTACT_EXISTING_RECORD_REQUIRED');
    }
    const args = ['base', '+record-upsert', '--base-token', this.route.baseToken, '--table-id', this.route.tableId];
    args.push('--json', JSON.stringify(fields));
    return this.call(args);
  }
}

function getData(payload) {
  return payload?.data ?? payload;
}

function getFieldDefinitions(payload) {
  const data = getData(payload);
  return data?.fields ?? data?.items ?? data?.field_list ?? [];
}

function fieldName(field) { return field?.field_name ?? field?.name ?? ''; }
function fieldType(field) { return field?.type ?? field?.field_type ?? field?.type_name ?? ''; }

const EXISTING_REQUIRED_FIELD_TYPES = Object.freeze({
  'Text':'text', '抖音号':'text', '蝉妈妈来源':'text', '采集批次':'text', '榜单验证状态':'text',
});

function getRecordItems(payload) {
  const data = getData(payload);
  if (Array.isArray(data?.data) && Array.isArray(data?.fields)) {
    return data.data.map((cells, index) => {
      if (!Array.isArray(cells)) return cells;
      const fields=Object.fromEntries(data.fields.map((name,fieldIndex)=>[name,cells[fieldIndex] ?? null]));
      return {record_id:data.record_id_list?.[index] ?? '', fields};
    });
  }
  return data?.records ?? data?.items ?? data?.record_list ?? [];
}

function projectedRecordFields(payload) {
  const data=getData(payload);
  if (data?.record?.fields) return data.record.fields;
  if (data?.fields && !Array.isArray(data.fields)) return data.fields;
  if (Array.isArray(data?.data) && Array.isArray(data?.fields)) {
    const row=data.data[0] || [];
    return Object.fromEntries(data.fields.map((name,index)=>[name,row[index] ?? null]));
  }
  return {};
}

function getCellValue(fields, field) {
  let value = fields?.[field];
  if (value && typeof value === 'object' && !Array.isArray(value) && 'value' in value) value = value.value;
  if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : item?.text ?? item?.value ?? item?.name ?? '').join(', ');
  if (value && typeof value === 'object') return value.text ?? value.name ?? '';
  return value ?? '';
}

const DATETIME_READBACK_FIELDS = new Set([
  '首次收录时间','最近观测时间','联系方式最近尝试','联系方式最近成功',
]);

function normalizeDateTimeForReadback(value) {
  if (value === null || value === undefined || value === '') return '';
  let candidate = value;
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(text)) candidate = `${text.replace(' ', 'T')}:00+08:00`;
    else if (/^\d+$/.test(text)) candidate = Number(text);
    else candidate = text;
  }
  const date = new Date(candidate);
  if (!Number.isFinite(date.getTime())) return null;
  return formatLarkDateTime(date);
}

function recordIdOf(record) {
  return record?.record_id ?? record?.recordId ?? record?.id ?? '';
}

export async function ensureRosterFields(client) {
  const payload = await client.listFields();
  const fields = getFieldDefinitions(payload);
  const byName = new Map();
  for (const field of fields) {
    const name = fieldName(field);
    if (byName.has(name)) throw new Error('LARK_DUPLICATE_FIELD_NAME');
    byName.set(name, field);
  }
  for (const [name, expectedType] of Object.entries(EXISTING_REQUIRED_FIELD_TYPES)) {
    const field = byName.get(name);
    if (!field || String(fieldType(field)).toLowerCase() !== expectedType) throw new Error('LARK_REQUIRED_BASE_FIELD_SCHEMA_MISMATCH');
  }
  const created = [];
  for (const definition of REQUIRED_FIELD_DEFINITIONS) {
    const present = byName.get(definition.name);
    if (present) {
      if (String(fieldType(present)).toLowerCase() !== definition.type) throw new Error('LARK_REQUIRED_BASE_FIELD_SCHEMA_MISMATCH');
      continue;
    }
    const response = await client.createField(definition);
    created.push({name:definition.name, result:response?.created === true || getData(response)?.created === true});
  }
  let refreshedByName = new Map();
  let missingDefinition = null;
  for (let attempt=0; attempt<3; attempt+=1) {
    const refreshed = getFieldDefinitions(await client.listFields());
    refreshedByName = new Map(refreshed.map(field => [fieldName(field),field]));
    missingDefinition = REQUIRED_FIELD_DEFINITIONS.find(definition => {
      const field=refreshedByName.get(definition.name);
      return !field || String(fieldType(field)).toLowerCase() !== definition.type;
    }) || null;
    if (!missingDefinition) break;
    if (attempt<2) await new Promise(resolve=>setTimeout(resolve,250*(attempt+1)));
  }
  if (missingDefinition) throw new Error(`LARK_FIELD_CREATE_READBACK_FAILED:${missingDefinition.name}`);
  return {created:created.map(item => item.name), existing:REQUIRED_FIELD_DEFINITIONS.map(item => item.name).filter(name => byName.has(name))};
}

export async function validateRosterFields(client) {
  const fields=getFieldDefinitions(await client.listFields());
  const byName=new Map();
  for (const field of fields) {
    const name=fieldName(field);
    if (byName.has(name)) throw new Error('LARK_DUPLICATE_FIELD_NAME');
    byName.set(name,field);
  }
  for (const [name,expectedType] of Object.entries(EXISTING_REQUIRED_FIELD_TYPES)) {
    const field=byName.get(name);
    if (!field || String(fieldType(field)).toLowerCase()!==expectedType) throw new Error('LARK_REQUIRED_BASE_FIELD_SCHEMA_MISMATCH');
  }
  for (const definition of REQUIRED_FIELD_DEFINITIONS) {
    const field=byName.get(definition.name);
    if (!field || String(fieldType(field)).toLowerCase()!==definition.type) throw new Error('LARK_REQUIRED_BASE_FIELD_SCHEMA_MISMATCH');
  }
  return {created:[],existing:REQUIRED_FIELD_DEFINITIONS.map(item=>item.name).filter(name=>byName.has(name))};
}

export async function listRosterIndex(client, {limit = 200} = {}) {
  const index = new Map();
  let offset = 0;
  while (true) {
    const payload = await client.listRecordsPage({offset, limit, fieldNames:ROSTER_READ_FIELDS});
    const data = getData(payload);
    const records = getRecordItems(payload);
    for (const record of records) {
      const fields = record?.fields ?? {};
      const creatorId = normalizeText(getCellValue(fields, '抖音号'));
      if (!creatorId) continue;
      if (index.has(creatorId)) throw new Error('LARK_DUPLICATE_EXISTING_CREATOR_ID');
      const recordId=recordIdOf(record);
      if (!recordId) throw new Error('LARK_EXISTING_CREATOR_RECORD_ID_MISSING');
      index.set(creatorId, {creatorId, recordId, safeFields:fields});
    }
    const hasMore = data?.has_more ?? data?.hasMore;
    if (hasMore === false || (!records.length) || (hasMore === undefined && records.length < limit)) break;
    offset += records.length;
    if (offset > 100000) throw new Error('LARK_RECORD_PAGINATION_LIMIT');
  }
  return index;
}

export function findRosterRecordByCreatorId(client, creatorId) {
  const id=normalizeText(creatorId);
  if (!id) throw new Error('KOC_CREATOR_ID_REQUIRED');
  const matches=[];
  let offset=0;
  const lookupPageSize=200;
  const lookupMaxRows=2000;
  while (true) {
    const payload=client.listRecordsPage({offset,limit:lookupPageSize,fieldNames:ROSTER_READ_FIELDS,
      filterJson:{logic:'and',conditions:[['抖音号','==',id]]}});
    const data=getData(payload);
    const records=getRecordItems(payload);
    matches.push(...records.filter(record=>normalizeText(getCellValue(record?.fields,'抖音号'))===id));
    if (matches.length>1) throw new Error('LARK_DUPLICATE_EXISTING_CREATOR_ID');
    const hasMore=data?.has_more ?? data?.hasMore;
    if (matches.length===1 && hasMore===true) throw new Error('LARK_CREATOR_ID_LOOKUP_AMBIGUOUS');
    if (hasMore===false || !records.length || (hasMore===undefined && records.length<lookupPageSize)) break;
    offset+=records.length;
    if (offset>=lookupMaxRows) throw new Error('LARK_CREATOR_ID_LOOKUP_LIMIT');
  }
  if (matches.length>1) throw new Error('LARK_DUPLICATE_EXISTING_CREATOR_ID');
  if (!matches.length) return null;
  const recordId=recordIdOf(matches[0]);
  if (!recordId) throw new Error('LARK_EXISTING_CREATOR_RECORD_ID_MISSING');
  return {creatorId:id,recordId,safeFields:matches[0].fields||{}};
}

function verifyExpectedProjection(record, expected) {
  const fields = projectedRecordFields(record);
  for (const [key, value] of Object.entries(expected)) {
    let actual = getCellValue(fields, key);
    let target = value;
    if (['蝉妈妈来源','联系方式来源'].includes(key)) {
      const link=String(actual).match(/^\[[^\]]*\]\((https?:\/\/[^)]+)\)$/);
      if (link) actual=link[1];
    }
    let matches;
    if (DATETIME_READBACK_FIELDS.has(key)) {
      const normalizedActual=normalizeDateTimeForReadback(actual);
      const normalizedTarget=normalizeDateTimeForReadback(target);
      matches=normalizedActual!==null&&normalizedTarget!==null&&normalizedActual===normalizedTarget;
    } else matches=String(actual) === String(target);
    if (!matches) {
      const describeType = candidate => candidate === null ? 'null' : Array.isArray(candidate) ? 'array' : typeof candidate;
      const error = new Error(`LARK_READBACK_MISMATCH:${key}`);
      error.readbackDiagnostic = {field:key, expectedType:describeType(target), actualType:describeType(actual), semanticMatches:false};
      throw error;
    }
  }
  return true;
}

async function verifyRosterReadbackWithRetry(client, recordId, expected) {
  const delays = [200, 500];
  let lastMismatch = null;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    const readback = await client.getRecord(recordId, ROSTER_READ_FIELDS);
    try {
      verifyExpectedProjection(readback, expected);
      return true;
    } catch (error) {
      if (!/^LARK_READBACK_MISMATCH:/.test(error?.message || '')) throw error;
      lastMismatch = error;
      if (attempt < delays.length) await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    }
  }
  throw lastMismatch;
}

async function verifyExpectedProjectionWithRetry(client, recordId, fieldNames, expected) {
  const delays = [200, 500];
  let lastMismatch = null;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    const readback = await client.getRecord(recordId, fieldNames);
    try {
      verifyExpectedProjection(readback, expected);
      return true;
    } catch (error) {
      if (!/^LARK_READBACK_MISMATCH:/.test(error?.message || '')) throw error;
      lastMismatch = error;
      if (attempt < delays.length) await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    }
  }
  throw lastMismatch;
}

function extractUpsertResult(payload) {
  const data = getData(payload);
  const record = data?.record ?? payload?.record ?? {};
  return {recordId:recordIdOf(record) || data?.record_id_list?.[0] || payload?.record_id_list?.[0] || '', created:data?.created ?? payload?.created ?? false,
    updated:data?.updated ?? payload?.updated ?? false};
}

async function refreshIndexAfterUncertainWrite(client, creatorId) {
  const delays = [200, 500];
  let lastReadError=null;
  for (let attempt=0; attempt<delays.length+1; attempt+=1) {
    try {
      const item = findRosterRecordByCreatorId(client,creatorId);
      if (item?.recordId) return item;
      lastReadError=null;
    } catch (error) {
      if (/^(?:LARK_DUPLICATE_EXISTING_CREATOR_ID|LARK_EXISTING_CREATOR_RECORD_ID_MISSING)$/.test(error?.message||'')) throw error;
      lastReadError=error;
    }
    if (attempt<delays.length) await new Promise(resolve=>setTimeout(resolve,delays[attempt]));
  }
  throw new Error('LARK_WRITE_OUTCOME_UNKNOWN',{cause:lastReadError||undefined});
}

export function createKeyedSerialQueue() {
  const tails = new Map();
  return {
    async run(key, operation) {
      const previous = tails.get(key) ?? Promise.resolve();
      const current = previous.catch(() => {}).then(operation);
      tails.set(key, current);
      try { return await current; }
      finally { if (tails.get(key) === current) tails.delete(key); }
    },
  };
}

export const rosterWriteQueue = createKeyedSerialQueue();

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

async function removeStaleRecordLock(lockPath, now = Date.now()) {
  const reaperPath=`${lockPath}.reap`;
  let reaperHandle;
  try { reaperHandle=await fs.open(reaperPath,'wx',0o600); }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let reaperStat;
    let reaperOwner=null;
    try {
      reaperStat=await fs.stat(reaperPath);
      reaperOwner=JSON.parse(await fs.readFile(reaperPath,'utf8'));
    } catch (readError) {
      if (readError?.code === 'ENOENT') return false;
    }
    if (reaperStat && Number.isInteger(reaperOwner?.pid) && reaperOwner.pid > 0 &&
        !processIsAlive(reaperOwner.pid) && now-reaperStat.mtimeMs >= 1000) {
      throw new Error('KOC_CREATOR_REAPER_LOCK_STALE_REQUIRES_MANUAL_CLEANUP');
    }
    return false;
  }

  let stat;
  try {
    await reaperHandle.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}),'utf8');
    await reaperHandle.sync();
    let owner = null;
    try { stat=await fs.stat(lockPath); }
    catch (error) { if (error?.code === 'ENOENT') return true; throw error; }
    try { owner = JSON.parse(await fs.readFile(lockPath, 'utf8')); }
    catch { /* A just-created lock may not contain its owner yet. */ }
    const age = now - stat.mtimeMs;
    if (Number.isInteger(owner?.pid) && owner.pid > 0) {
      if (processIsAlive(owner.pid) || age < 1000) return false;
    } else if (age < 30 * 60 * 1000) return false;
    try { await fs.unlink(lockPath); return true; }
    catch (error) { if (error?.code === 'ENOENT') return true; throw error; }
  } finally {
    await reaperHandle.close().catch(() => {});
    await fs.unlink(reaperPath).catch(error => { if (error?.code !== 'ENOENT') throw error; });
  }
}

export async function withRecordProcessLock(key, operation, {
  lockDir = path.join(DEFAULT_STATE_DIR, 'record-locks'), waitMs = 120000, pollMs = 100,
} = {}) {
  const normalizedKey = normalizeText(key);
  if (!normalizedKey) throw new Error('KOC_CREATOR_WRITE_LOCK_KEY_REQUIRED');
  await ensurePrivateStateDir(lockDir);
  const lockPath = path.join(lockDir, `${createHash('sha256').update(normalizedKey).digest('hex')}.lock`);
  const deadline = Date.now() + waitMs;
  while (true) {
    let handle;
    try { handle = await fs.open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      await removeStaleRecordLock(lockPath);
      if (Date.now() >= deadline) throw new Error('KOC_CREATOR_WRITE_LOCK_TIMEOUT');
      await new Promise(resolve => setTimeout(resolve, pollMs));
      continue;
    }
    try {
      await handle.writeFile(JSON.stringify({pid:process.pid, startedAt:new Date().toISOString()}), 'utf8');
      await handle.sync();
      return await operation();
    } finally {
      await handle.close().catch(() => {});
      await fs.unlink(lockPath).catch(error => { if (error?.code !== 'ENOENT') throw error; });
    }
  }
}

function runRosterWrite(key, client, operation) {
  return rosterWriteQueue.run(key, () => withRecordProcessLock(key, operation,
    {lockDir:client.recordLockDir || path.join(DEFAULT_STATE_DIR, 'record-locks')}));
}

function pendingDailyCreateMarkerPath(stateDir, creatorId) {
  return path.join(stateDir,'daily-add-only-pending',
    `${createHash('sha256').update(normalizeText(creatorId)).digest('hex')}.json`);
}

async function readPendingDailyCreateMarker(stateDir, creatorId) {
  try { return await readPrivateJson(pendingDailyCreateMarkerPath(stateDir,creatorId)); }
  catch (error) { if (error?.code==='ENOENT') return null; throw error; }
}

async function writePendingDailyCreateMarker(stateDir, marker) {
  return writePrivateJson(pendingDailyCreateMarkerPath(stateDir,marker.creatorId),marker);
}

async function clearPendingDailyCreateMarker(stateDir, creatorId) {
  try { await fs.unlink(pendingDailyCreateMarkerPath(stateDir,creatorId)); }
  catch (error) { if (error?.code!=='ENOENT') throw error; }
}

export async function syncRosterBatch(client, rows, {
  batchId, capturedAt = new Date(), fullSnapshot = false,
  expectedNewOnly = false, receiptPath = '', stateDir = '',
  verificationStatus = '', scopeKey = ROSTER_SCOPE_KEY, scope = ROSTER_SCOPE_LABEL, preserveCreatorIds = [], sourceEvidence = {},
} = {}) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('KOC_ROSTER_BATCH_EMPTY');
  if (!batchId) throw new Error('KOC_BATCH_ID_REQUIRED');
  if (scopeKey !== ROSTER_SCOPE_KEY || scope !== ROSTER_SCOPE_LABEL) throw new Error('KOC_ROSTER_SCOPE_MISMATCH');
  const pendingStateDir=client.pendingCreateMarkerDir||stateDir||
    (receiptPath?path.dirname(receiptPath):client.recordLockDir||DEFAULT_STATE_DIR);
  for (const row of rows) assertRosterPatch(buildRosterRecordFields(row, {batchId, capturedAt, existing:false,
    fullSnapshot, verificationStatus}));
  const ids = new Set();
  for (const row of rows) {
    if (ids.has(row.creatorId)) throw new Error('KOC_DUPLICATE_CREATOR_ID_IN_BATCH');
    ids.add(row.creatorId);
  }
  if (fullSnapshot && rows.length < 500) throw new Error('KOC_FULL_SNAPSHOT_REQUIRES_500_ROWS');

  const index = await listRosterIndex(client);
  const receipt = {version:1, batchId, status:'writing', scope, scopeKey,
    startedAt:new Date().toISOString(), plannedCount:rows.length, completedCount:0, createdCount:0, updatedCount:0,
    recoveredWriteCount:0, reconciledCount:0, readbackVerifiedCount:0,
    plannedCreators:rows.map(row=>({creatorId:normalizeText(row.creatorId),sourceRank:row.sourceRank})),
    fullSnapshot:fullSnapshot===true, creatorRecordIds:{}, outcomes:[], preservedCurrentReviewCount:new Set(preserveCreatorIds.map(normalizeText)).size,
    sourceEvidence,contactDataIncluded:false};
  const persist = async () => {
    if (!receiptPath) return;
    await writePrivateJson(receiptPath, receipt);
  };
  let lastReadbackDiagnostic = null;
  await persist();
  try {
    for (const row of rows) {
      const key = normalizeText(row.creatorId);
      await runRosterWrite(key, client, async () => {
        let existing = index.get(key);
        if (!existing) existing=findRosterRecordByCreatorId(client,key);
        const pendingDailyCreate=await readPendingDailyCreateMarker(pendingStateDir,key);
        if (pendingDailyCreate) {
          if (!existing) throw new Error('KOC_DAILY_WRITE_OUTCOME_UNKNOWN_PENDING');
          const firstPeriod=normalizeText(getCellValue(existing.safeFields,'首次收录榜期'));
          if (firstPeriod!==normalizeText(pendingDailyCreate.batchId)) {
            throw new Error('KOC_DAILY_WRITE_OUTCOME_UNKNOWN_PENDING');
          }
          await clearPendingDailyCreateMarker(pendingStateDir,key);
        }
        const existedBeforeWrite = !!existing;
        let recoveredAfterUncertainWrite = false;
        if (expectedNewOnly && existing) throw new Error('KOC_EXPECTED_NEW_CREATOR_ALREADY_EXISTS');
        const rowCapturedAt=row.capturedAt||capturedAt;
        let fields = buildRosterRecordFields(row, {batchId, capturedAt:rowCapturedAt,
          existing:!!existing, fullSnapshot, scope, verificationStatus});
        if (existing && normalizeText(getCellValue(existing.safeFields,'采集批次'))===batchId) {
          const wasFirstCollectedInThisBatch = normalizeText(getCellValue(existing.safeFields,'首次收录榜期'))===batchId;
          const reconcileExpected = wasFirstCollectedInThisBatch
            ? buildRosterRecordFields(row, {batchId, capturedAt:rowCapturedAt, existing:false,
              fullSnapshot, scope, verificationStatus})
            : fields;
          try {
            await verifyRosterReadbackWithRetry(client,existing.recordId,reconcileExpected);
            receipt.creatorRecordIds[key]=existing.recordId;
            receipt.completedCount+=1;
            receipt.reconciledCount+=1;
            receipt.readbackVerifiedCount+=1;
            receipt.outcomes.push({creatorId:key,recordId:existing.recordId,sourceRank:row.sourceRank,
              outcome:'reconciled_same_batch',readbackVerified:true,upsertSkipped:true});
            index.set(key,{creatorId:key,recordId:existing.recordId,safeFields:existing.safeFields});
            await persist();
            return;
          } catch (error) {
            if (!/^LARK_READBACK_MISMATCH:/.test(error?.message||'')) throw error;
            lastReadbackDiagnostic = error.readbackDiagnostic || null;
            if (wasFirstCollectedInThisBatch) throw error;
            lastReadbackDiagnostic = null;
          }
        }
        assertRosterPatch(fields);
        const createMarker=!existing?{version:1,creatorId:key,batchId,sourceRank:row.sourceRank,
          status:'in_flight',startedAt:new Date().toISOString()}:null;
        if (createMarker) await writePendingDailyCreateMarker(pendingStateDir,createMarker);
        let upsert;
        let recordId = existing?.recordId || '';
        try {
          upsert = extractUpsertResult(await client.upsertRecord(fields, recordId));
          recordId = upsert.recordId || recordId;
        } catch (writeError) {
          const found = await refreshIndexAfterUncertainWrite(client, key).catch(() => null);
          if (!found?.recordId) {
            if (createMarker) await writePendingDailyCreateMarker(pendingStateDir,
              {...createMarker,status:'outcome_unknown',updatedAt:new Date().toISOString()});
            throw new Error('LARK_WRITE_OUTCOME_UNKNOWN');
          }
          recordId = found.recordId;
          existing = found;
          recoveredAfterUncertainWrite = true;
          upsert = {created:false, updated:true, recoveredAfterUncertainWrite:true};
        }
        if (!recordId) {
          const found = await refreshIndexAfterUncertainWrite(client, key);
          recordId = found.recordId;
          existing = found;
          recoveredAfterUncertainWrite = true;
          upsert = {...upsert, recoveredAfterUncertainWrite:true};
        }
        if (createMarker) {
          const found=await refreshIndexAfterUncertainWrite(client,key);
          if (normalizeText(getCellValue(found.safeFields,'首次收录榜期'))!==batchId) {
            throw new Error('KOC_DAILY_WRITE_OUTCOME_UNKNOWN_PENDING');
          }
          recordId=found.recordId;
          existing=found;
        }
        try {
          await verifyRosterReadbackWithRetry(client,recordId,fields);
        } catch (error) {
          lastReadbackDiagnostic = error.readbackDiagnostic || null;
          throw error;
        }
        index.set(key, {creatorId:key, recordId, safeFields:fields});
        receipt.creatorRecordIds[key] = recordId;
        receipt.completedCount += 1;
        receipt.readbackVerifiedCount += 1;
        if (recoveredAfterUncertainWrite) receipt.recoveredWriteCount += 1;
        else if (existedBeforeWrite || upsert.updated) receipt.updatedCount += 1;
        else receipt.createdCount += 1;
        receipt.outcomes.push({creatorId:key, recordId, sourceRank:row.sourceRank,
          outcome:recoveredAfterUncertainWrite ? 'recovered_after_uncertain_write' : existedBeforeWrite || upsert.updated ? 'updated' : 'created',
          recoveredAfterUncertainWrite,
          readbackVerified:true});
        await persist();
        if (createMarker) await clearPendingDailyCreateMarker(pendingStateDir,key);
      });
    }

    if (fullSnapshot) {
      const currentIds = new Set([...rows.map(row => normalizeText(row.creatorId)), ...preserveCreatorIds.map(normalizeText)]);
      for (const [creatorId, existing] of index) {
        if (currentIds.has(creatorId)) continue;
        if (normalizeText(getCellValue(existing.safeFields, '榜单筛选口径')) !== scope) continue;
        const fields = {'当期在榜状态':'不在当期Top500'};
        assertRosterPatch({'抖音号':creatorId, Text:normalizeText(getCellValue(existing.safeFields, 'Text')) || creatorId, ...fields});
        await runRosterWrite(creatorId, client, async () => {
          const pendingDailyCreate=await readPendingDailyCreateMarker(pendingStateDir,creatorId);
          if (pendingDailyCreate) {
            const firstPeriod=normalizeText(getCellValue(existing.safeFields,'首次收录榜期'));
            if (firstPeriod!==normalizeText(pendingDailyCreate.batchId)) {
              throw new Error('KOC_DAILY_WRITE_OUTCOME_UNKNOWN_PENDING');
            }
            await clearPendingDailyCreateMarker(pendingStateDir,creatorId);
          }
          await client.upsertRecord(fields, existing.recordId);
          try {
            await verifyRosterReadbackWithRetry(client,existing.recordId,fields);
          } catch (error) {
            lastReadbackDiagnostic = error.readbackDiagnostic || null;
            throw error;
          }
          receipt.readbackVerifiedCount+=1;
          receipt.outcomes.push({creatorId, recordId:existing.recordId, outcome:'marked_absent_from_full_snapshot',readbackVerified:true});
          await persist();
        });
      }
    }
    receipt.status = 'complete';
    receipt.finishedAt = new Date().toISOString();
    await persist();
    return {status:receipt.status, plannedCount:receipt.plannedCount, completedCount:receipt.completedCount,
      createdCount:receipt.createdCount, updatedCount:receipt.updatedCount, recoveredWriteCount:receipt.recoveredWriteCount,
      reconciledCount:receipt.reconciledCount, readbackVerifiedCount:receipt.readbackVerifiedCount,
      creatorRecordIds:{...receipt.creatorRecordIds}, receiptPath};
  } catch (error) {
    receipt.status = 'interrupted';
    receipt.failureReason = /^KOC_|^LARK_/.test(error?.message || '') ? error.message.split(':')[0] : 'KOC_ROSTER_WRITE_FAILED';
    if (lastReadbackDiagnostic && ROSTER_FIELD_ALLOWLIST.has(lastReadbackDiagnostic.field)) {
      receipt.failureDiagnostic = lastReadbackDiagnostic;
    }
    receipt.finishedAt = new Date().toISOString();
    await persist();
    throw error;
  }
}

export async function syncRosterAddOnlyBatch(client, rows, {
  batchId, capturedAt = new Date(), receiptPath = '', stateDir = '', priorReceipt = null,
  verificationStatus = '已核验完整当期Top500', sourceEvidence = {},
  scopeKey = ROSTER_SCOPE_KEY, scope = ROSTER_SCOPE_LABEL,
} = {}) {
  if (!Array.isArray(rows)) throw new Error('KOC_ROSTER_BATCH_INVALID');
  if (!batchId) throw new Error('KOC_BATCH_ID_REQUIRED');
  if (scopeKey !== ROSTER_SCOPE_KEY || scope !== ROSTER_SCOPE_LABEL) throw new Error('KOC_ROSTER_SCOPE_MISMATCH');
  const markerStateDir=client.pendingCreateMarkerDir||stateDir||
    (receiptPath?path.dirname(receiptPath):client.recordLockDir||DEFAULT_STATE_DIR);
  if (priorReceipt && (priorReceipt.mode !== 'daily-add-only' || priorReceipt.batchId !== batchId)) {
    throw new Error('KOC_DAILY_PRIOR_RECEIPT_MODE_MISMATCH');
  }
  for (const row of rows) assertRosterPatch(buildRosterRecordFields(row, {batchId, capturedAt, existing:false,
    verificationStatus, currentTop500:true, scope}));
  const plannedIds = rows.map(row => normalizeText(row.creatorId));
  if (new Set(plannedIds).size !== plannedIds.length) throw new Error('KOC_DUPLICATE_CREATOR_ID_IN_BATCH');
  if (priorReceipt) {
    const receiptPlan=(priorReceipt.plannedCreators||[]).map(item=>({creatorId:normalizeText(item.creatorId),sourceRank:item.sourceRank}));
    const currentPlan=rows.map(row=>({creatorId:normalizeText(row.creatorId),sourceRank:row.sourceRank}));
    if (JSON.stringify(receiptPlan)!==JSON.stringify(currentPlan)) throw new Error('KOC_DAILY_PRIOR_RECEIPT_PLAN_MISMATCH');
  }

  const index = await listRosterIndex(client);
  const receipt = priorReceipt ? structuredClone(priorReceipt) : {
    version:1, mode:'daily-add-only', batchId, status:'writing', scope, scopeKey,
    startedAt:new Date().toISOString(), plannedCount:rows.length, completedCount:0, createdCount:0,
    updatedCount:0, skippedExistingCount:0, recoveredWriteCount:0, reconciledCount:0, readbackVerifiedCount:0,
    plannedCreators:rows.map(row=>({creatorId:normalizeText(row.creatorId),sourceRank:row.sourceRank})),
    fullSnapshot:false, dailyAddOnly:true, zeroAdditions:rows.length===0, sourceEvidence,
    creatorRecordIds:{}, outcomes:[], contactDataIncluded:false,
  };
  receipt.mode='daily-add-only';
  receipt.dailyAddOnly=true;
  receipt.fullSnapshot=false;
  receipt.sourceEvidence=sourceEvidence;
  receipt.outcomes=Array.isArray(receipt.outcomes)?receipt.outcomes:[];
  receipt.creatorRecordIds=receipt.creatorRecordIds&&typeof receipt.creatorRecordIds==='object'?receipt.creatorRecordIds:{};
  const completedReceiptReplay=priorReceipt?.status==='complete';
  const persist = async () => {
    if (!receiptPath) return;
    await writePrivateJson(receiptPath,receipt);
  };
  const setOutcome = outcome => {
    const found=receipt.outcomes.findIndex(item=>item.creatorId===outcome.creatorId);
    if (found===-1) receipt.outcomes.push(outcome);
    else receipt.outcomes[found]={...receipt.outcomes[found],...outcome};
    if (outcome.recordId) receipt.creatorRecordIds[outcome.creatorId]=outcome.recordId;
  };
  const refreshCounts = () => {
    receipt.completedCount=receipt.outcomes.filter(item=>plannedIds.includes(item.creatorId) &&
      item.outcome!=='write_outcome_unknown').length;
    receipt.createdCount=receipt.outcomes.filter(item=>item.outcome==='created').length;
    receipt.updatedCount=0;
    receipt.skippedExistingCount=receipt.outcomes.filter(item=>item.outcome==='skipped_existing' ||
      item.outcome==='skipped_existing_after_uncertain_write').length;
    receipt.unknownWriteCount=receipt.outcomes.filter(item=>item.outcome==='write_outcome_unknown').length;
    receipt.recoveredWriteCount=receipt.outcomes.filter(item=>item.outcome==='recovered_after_uncertain_write').length;
    receipt.reconciledCount=receipt.outcomes.filter(item=>item.outcome==='reconciled_same_batch').length;
    receipt.readbackVerifiedCount=receipt.outcomes.filter(item=>item.readbackVerified===true).length;
  };
  if (completedReceiptReplay && rows.length===0) {
    refreshCounts();
    return {status:'complete',plannedCount:0,completedCount:0,createdCount:0,updatedCount:0,
      skippedExistingCount:0,recoveredWriteCount:0,reconciledCount:0,readbackVerifiedCount:0,
      creatorRecordIds:{...receipt.creatorRecordIds},zeroAdditions:true,replay:true,receiptPath};
  }
  receipt.status='writing';
  receipt.zeroAdditions=rows.length===0;
  await persist();
  let lastReadbackDiagnostic=null;
  try {
    for (const row of rows) {
      const key=normalizeText(row.creatorId);
      await runRosterWrite(key,client,async()=>{
        let existing=index.get(key);
        if (!existing) existing=findRosterRecordByCreatorId(client,key);
        const pendingMarker=await readPendingDailyCreateMarker(markerStateDir,key);
        if (pendingMarker) {
          if (!existing) throw new Error('KOC_DAILY_WRITE_OUTCOME_UNKNOWN_PENDING');
          const firstPeriod=normalizeText(getCellValue(existing.safeFields,'首次收录榜期'));
          if (firstPeriod!==normalizeText(pendingMarker.batchId)) {
            throw new Error('KOC_DAILY_WRITE_OUTCOME_UNKNOWN_PENDING');
          }
          await clearPendingDailyCreateMarker(markerStateDir,key);
        }
        const rowCapturedAt=row.capturedAt||capturedAt;
        const expected=buildRosterRecordFields(row,{batchId,capturedAt:rowCapturedAt,existing:false,
          verificationStatus,currentTop500:true,scope});
        const priorOutcome=priorReceipt?.outcomes?.find(item=>item.creatorId===key);
        if (priorOutcome?.outcome==='write_outcome_unknown' && !existing) {
          throw new Error('KOC_DAILY_WRITE_OUTCOME_UNKNOWN_PENDING');
        }
        if (existing) {
          const firstPeriod=normalizeText(getCellValue(existing.safeFields,'首次收录榜期'));
          if (firstPeriod===batchId) {
            try {
              await verifyRosterReadbackWithRetry(client,existing.recordId,expected);
            } catch (error) {
              lastReadbackDiagnostic=error.readbackDiagnostic||null;
              throw error;
            }
            index.set(key,{creatorId:key,recordId:existing.recordId,safeFields:existing.safeFields});
            setOutcome({creatorId:key,recordId:existing.recordId,sourceRank:row.sourceRank,
              outcome:priorOutcome?.outcome==='write_outcome_unknown'?'recovered_after_uncertain_write':
                ['created','recovered_after_uncertain_write','reconciled_same_batch'].includes(priorOutcome?.outcome)
                  ? priorOutcome.outcome : 'reconciled_same_batch',
              readbackVerified:true,upsertSkipped:true});
            await persist();
            return;
          }
          if (completedReceiptReplay && !['skipped_existing','skipped_existing_after_uncertain_write'].includes(priorOutcome?.outcome)) {
            throw new Error('KOC_DAILY_REPLAY_CREATOR_PERIOD_MISMATCH');
          }
          setOutcome({creatorId:key,recordId:existing.recordId,sourceRank:row.sourceRank,
            outcome:priorOutcome?.outcome==='write_outcome_unknown'
              ? 'skipped_existing_after_uncertain_write' : 'skipped_existing',
            readbackVerified:false,upsertSkipped:true});
          index.set(key,{creatorId:key,recordId:existing.recordId,safeFields:existing.safeFields});
          await persist();
          return;
        }
        if (completedReceiptReplay) throw new Error('KOC_DAILY_REPLAY_RECORD_MISSING');
        const attemptMarker={version:1,creatorId:key,batchId,sourceRank:row.sourceRank,
          status:'in_flight',startedAt:new Date().toISOString()};
        await writePendingDailyCreateMarker(markerStateDir,attemptMarker);
        let recordId='';
        let writeResult;
        try {
          writeResult=extractUpsertResult(await client.upsertRecord(expected));
          recordId=writeResult.recordId;
        } catch (writeError) {
          const found=await refreshIndexAfterUncertainWrite(client,key).catch(()=>null);
          if (!found?.recordId) {
            await writePendingDailyCreateMarker(markerStateDir,{...attemptMarker,status:'outcome_unknown',updatedAt:new Date().toISOString()});
            setOutcome({creatorId:key,sourceRank:row.sourceRank,outcome:'write_outcome_unknown',
              readbackVerified:false,upsertSkipped:true,uncertainWriteAt:new Date().toISOString()});
            refreshCounts();
            await persist();
            throw new Error('LARK_WRITE_OUTCOME_UNKNOWN');
          }
          const firstPeriod=normalizeText(getCellValue(found.safeFields,'首次收录榜期'));
          index.set(key,found);
          if (firstPeriod!==batchId) {
            setOutcome({creatorId:key,recordId:found.recordId,sourceRank:row.sourceRank,
              outcome:'skipped_existing_after_uncertain_write',readbackVerified:false,upsertSkipped:true});
            await persist();
            await clearPendingDailyCreateMarker(markerStateDir,key);
            return;
          }
          recordId=found.recordId;
          writeResult={created:false,updated:false,recoveredAfterUncertainWrite:true};
        }
        if (!recordId) {
          const found=await refreshIndexAfterUncertainWrite(client,key).catch(()=>null);
          if (!found?.recordId) {
            await writePendingDailyCreateMarker(markerStateDir,{...attemptMarker,status:'outcome_unknown',updatedAt:new Date().toISOString()});
            setOutcome({creatorId:key,sourceRank:row.sourceRank,outcome:'write_outcome_unknown',
              readbackVerified:false,upsertSkipped:true,uncertainWriteAt:new Date().toISOString()});
            refreshCounts();
            await persist();
            throw new Error('LARK_WRITE_OUTCOME_UNKNOWN');
          }
          const firstPeriod=normalizeText(getCellValue(found.safeFields,'首次收录榜期'));
          index.set(key,found);
          if (firstPeriod!==batchId) {
            setOutcome({creatorId:key,recordId:found.recordId,sourceRank:row.sourceRank,
              outcome:'skipped_existing_after_uncertain_write',readbackVerified:false,upsertSkipped:true});
            await persist();
            await clearPendingDailyCreateMarker(markerStateDir,key);
            return;
          }
          recordId=found.recordId;
          writeResult={...writeResult,recoveredAfterUncertainWrite:true};
        }
        if (writeResult.updated===true) throw new Error('KOC_DAILY_CREATE_ONLY_UPDATE_REPORTED');
        try {
          await verifyRosterReadbackWithRetry(client,recordId,expected);
        } catch (error) {
          lastReadbackDiagnostic=error.readbackDiagnostic||null;
          throw error;
        }
        const safeFields=expected;
        index.set(key,{creatorId:key,recordId,safeFields});
        setOutcome({creatorId:key,recordId,sourceRank:row.sourceRank,
          outcome:writeResult.recoveredAfterUncertainWrite?'recovered_after_uncertain_write':'created',
          recoveredAfterUncertainWrite:writeResult.recoveredAfterUncertainWrite===true,readbackVerified:true});
        refreshCounts();
        await persist();
        await clearPendingDailyCreateMarker(markerStateDir,key);
      });
    }
    refreshCounts();
    receipt.status='complete';
    receipt.zeroAdditions=rows.length===0;
    receipt.finishedAt=new Date().toISOString();
    await persist();
    return {status:receipt.status,plannedCount:receipt.plannedCount,completedCount:receipt.completedCount,
      createdCount:receipt.createdCount,updatedCount:0,skippedExistingCount:receipt.skippedExistingCount,
      recoveredWriteCount:receipt.recoveredWriteCount,reconciledCount:receipt.reconciledCount,
      readbackVerifiedCount:receipt.readbackVerifiedCount,creatorRecordIds:{...receipt.creatorRecordIds},
      zeroAdditions:receipt.zeroAdditions,replay:!!priorReceipt,receiptPath};
  } catch (error) {
    refreshCounts();
    receipt.status='interrupted';
    receipt.failureReason=/^KOC_|^LARK_/.test(error?.message||'')?error.message.split(':')[0]:'KOC_ROSTER_WRITE_FAILED';
    if (lastReadbackDiagnostic&&ROSTER_FIELD_ALLOWLIST.has(lastReadbackDiagnostic.field)) receipt.failureDiagnostic=lastReadbackDiagnostic;
    receipt.finishedAt=new Date().toISOString();
    await persist();
    throw error;
  }
}

export async function patchContactRecord({creatorId, recordId, fields}, client = new LarkBaseClient()) {
  const id = normalizeText(creatorId);
  const rid = normalizeText(recordId);
  if (!id || !rid) throw new Error('KOC_CONTACT_CREATOR_AND_RECORD_ID_REQUIRED');
  assertContactPatch(fields);
  if (Object.keys(fields).some(key => !CONTACT_PATCH_ALLOWLIST.has(key))) throw new Error('KOC_CONTACT_FIELD_NOT_ALLOWED');
  return runRosterWrite(id, client, async () => {
    const lookup = await client.getRecord(rid, ['抖音号']);
    const foundId = normalizeText(getCellValue(projectedRecordFields(lookup), '抖音号'));
    if (foundId !== id) throw new Error('KOC_CONTACT_RECORD_CREATOR_MISMATCH');
    const fieldNames = Object.keys(fields);
    const result = extractUpsertResult(await client.upsertRecord(fields, rid));
    await verifyExpectedProjectionWithRetry(client, rid, fieldNames, fields);
    return {updated:true, creatorId:id, recordId:rid, status:normalizeText(fields['本次联系方式状态']),
      fieldNames, resultFlag:result.updated === true};
  });
}
