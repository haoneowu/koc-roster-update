import {createHash} from 'node:crypto';
import {isExplicitMerchant} from './merchant-eligibility.mjs';

export const ROSTER_FIELD_ALLOWLIST = new Set([
  'Text', '抖音号', '蝉妈妈来源', '采集批次', '榜单验证状态',
  '首次收录时间', '首次收录排名', '首次收录榜期',
  '最近观测排名', '最近观测榜期', '最近观测时间', '榜单筛选口径',
  '视频销售额', '蝉妈妈榜单指标原文', '当期在榜状态',
]);

export const CONTACT_PATCH_ALLOWLIST = new Set([
  '微信号', '本次联系方式状态', '联系方式最近尝试', '联系方式最近错误',
  '联系方式最近成功', '联系方式来源',
]);

export const ROSTER_SCOPE_KEY = 'chanmama|萌宠|宠物猫|视频达人|近30天|视频销售额:desc|merchant-filter:v4';
export const ROSTER_SCOPE_LABEL = '萌宠→宠物猫→视频达人→近30天视频销售额降序';

const CONTACT_FAILURE_STATES = new Set(['not_found', 'not_shown', 'login_required', 'captcha', 'error', 'forbidden_by_platform']);
const REVIEW_SUBJECT_PATTERN = /有限公司|有限责任公司|集团|企业号|企业账号|工厂|供应链|官方账号|官方号|品牌号|自营/;
const SUBJECT_TYPE_HEADER_PATTERN = /主体(?:类型|性质)?|账号类型|达人类型|账号性质/;
const BUSINESS_SIGNAL_HEADER_PATTERN = /店铺|认证|品牌|商家/;
const POSITIVE_CREATOR_TYPE_PATTERN = /^(?:达人|达人账号|普通达人|视频达人|短视频达人|个人|个人账号|个人达人|创作者|内容创作者|个体创作者)$/;

export function normalizeText(value) {
  return value === null || value === undefined ? '' : String(value).replace(/\s+/g, ' ').trim();
}

function normalizeLines(value) {
  return String(value ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function sameOriginSourceUrl(value) {
  if (!value) return '';
  const url = new URL(value, 'https://www.chanmama.com');
  if (url.origin !== 'https://www.chanmama.com' || !/^\/bloggerRank\/[^/]+\.html$/.test(url.pathname)) {
    throw new Error('KOC_SOURCE_PROFILE_URL_OUT_OF_SCOPE');
  }
  return url.href;
}

export function parseRankingRow({headers, cells, sourceRank, sourceProfileUrl = ''}) {
  if (!Array.isArray(headers) || !Array.isArray(cells) || headers.length !== cells.length) {
    throw new Error('KOC_RANKING_ROW_SHAPE_MISMATCH');
  }
  if (!Number.isInteger(sourceRank) || sourceRank < 1) throw new Error('KOC_INVALID_SOURCE_RANK');

  const row = Object.fromEntries(headers.map((header, index) => [normalizeText(header), String(cells[index] ?? '').trim()]));
  const identityLines = normalizeLines(row['达人']);
  const creatorName = identityLines[0] || '';
  const rawCreatorId = identityLines[1] || '';
  const creatorId = /^[A-Za-z0-9._-]+$/.test(rawCreatorId) ? rawCreatorId : '';
  const metrics = Object.fromEntries(headers
    .filter(header => !['达人', '操作'].includes(normalizeText(header)))
    .map(header => [normalizeText(header), String(row[normalizeText(header)] ?? '').trim()]));
  const normalizedHeaders = headers.map(normalizeText);
  const subjectEvidence = Object.fromEntries(normalizedHeaders
    .filter(header => SUBJECT_TYPE_HEADER_PATTERN.test(header) || BUSINESS_SIGNAL_HEADER_PATTERN.test(header))
    .filter(header => String(row[header] ?? '').trim())
    .map(header => [header, String(row[header]).trim()]));
  const creatorSubjectEvidence = Object.fromEntries(normalizedHeaders
    .filter(header => SUBJECT_TYPE_HEADER_PATTERN.test(header))
    .filter(header => String(row[header] ?? '').trim())
    .map(header => [header, String(row[header]).trim()]));
  const businessEvidence = Object.fromEntries(normalizedHeaders
    .filter(header => BUSINESS_SIGNAL_HEADER_PATTERN.test(header))
    .filter(header => String(row[header] ?? '').trim())
    .map(header => [header, String(row[header]).trim()]));

  return {
    creatorId,
    creatorName,
    ...(rawCreatorId && !creatorId ? {reviewReason: 'invalid_creator_id'} : {}),
    sourceProfileUrl: sameOriginSourceUrl(sourceProfileUrl),
    sourceRank,
    videoSalesRaw: metrics['视频销售额'] || '',
    metrics,
    subjectEvidence,
    creatorSubjectEvidence,
    businessEvidence,
  };
}

function stableRowFingerprint(row) {
  return JSON.stringify({
    creatorId: normalizeText(row.creatorId),
    creatorName: normalizeText(row.creatorName),
    sourceProfileUrl: normalizeText(row.sourceProfileUrl),
    sourceRank: row.sourceRank,
    metrics: row.metrics || {},
  });
}

export function dedupeRankedRows(rows) {
  const sorted = [...rows].sort((a, b) => a.sourceRank - b.sourceRank);
  const seen = new Map();
  const unique = [];
  const duplicates = [];
  for (const row of sorted) {
    if (!row.creatorId) {
      unique.push({...row, reviewReason: row.reviewReason || 'missing_creator_id'});
      continue;
    }
    const previous = seen.get(row.creatorId);
    if (!previous) {
      seen.set(row.creatorId, row);
      unique.push(row);
      continue;
    }
    if (stableRowFingerprint(previous) !== stableRowFingerprint(row)) {
      throw new Error(`KOC_SOURCE_CREATOR_ID_CONFLICT:${row.creatorId}`);
    }
    duplicates.push({...row, reviewReason: 'duplicate_source_row'});
  }
  return {unique, duplicates};
}

export function classifyRankedRows(rows, {existingIds = [], requireSubjectEvidence = false} = {}) {
  const {unique, duplicates} = dedupeRankedRows(rows);
  const known = new Set([...existingIds].map(value => normalizeText(value)).filter(Boolean));
  const eligible = [];
  const excluded = [];
  const review = [];
  const existing = [];
  let rowsWithSubjectEvidence = 0;

  for (const row of unique) {
    if (!row.creatorId || !row.creatorName || !row.sourceProfileUrl) {
      review.push({...row, reviewReason: row.reviewReason || (!row.creatorId || !row.creatorName ? 'missing_creator_identity' : 'missing_source_profile_url')});
      continue;
    }
    const subjectValues = Object.values(row.subjectEvidence || {});
    const creatorTypeValues = Object.values(row.creatorSubjectEvidence || {});
    const businessValues = Object.values(row.businessEvidence || {});
    const positiveCreatorType = creatorTypeValues.some(value => POSITIVE_CREATOR_TYPE_PATTERN.test(normalizeText(value)));
    if (positiveCreatorType) rowsWithSubjectEvidence += 1;
    const subjectText = [row.creatorName, ...subjectValues].join(' ');
    const explicitMerchant = isExplicitMerchant({
      names: [row.creatorName, ...subjectValues],
      typeValues: [...creatorTypeValues, ...businessValues],
    });
    if (explicitMerchant) {
      excluded.push({...row, exclusionReason: 'excluded_merchant'});
      continue;
    }
    if (REVIEW_SUBJECT_PATTERN.test(subjectText) || businessValues.some(value => /商家|店铺|企业|工厂|供应链|品牌方|商户|官方|自营/.test(value))) {
      review.push({...row, reviewReason: 'ambiguous_business_subject'});
      continue;
    }
    if (requireSubjectEvidence && !positiveCreatorType) {
      review.push({...row, reviewReason: creatorTypeValues.length ? 'creator_subject_type_not_whitelisted' : 'merchant_subject_evidence_missing'});
      continue;
    }
    if (known.has(row.creatorId)) existing.push(row);
    else eligible.push(row);
  }
  return {eligible, existing, excluded, review, duplicates,
    subjectEvidenceCoverage: unique.length ? rowsWithSubjectEvidence / unique.length : 0};
}

export function chooseNewSample(rows, {existingIds = [], limit = 5} = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('KOC_INVALID_SAMPLE_LIMIT');
  const result = classifyRankedRows(rows, {existingIds});
  return {...result, sample: result.eligible.slice(0, limit)};
}

function parseBandBound(value) {
  const firstLine = normalizeLines(value)[0] || '';
  if (!firstLine) return {recognized: false, value: null};
  if (/^(?:-|—|–|−|无|暂无|0)$/.test(firstLine)) return {recognized: true, value: null};
  const token = firstLine.split(/[~～至到—–-]/)[0].replace(/[，,]/g, '').trim();
  const match = token.match(/^(\d+(?:\.\d+)?)(w|W|万|亿)?\+?$/);
  if (!match) return {recognized: false, value: null};
  const amount = Number(match[1]);
  const multiplier = /亿/.test(match[2] || '') ? 100_000_000 : /(?:w|W|万)/.test(match[2] || '') ? 10_000 : 1;
  return {recognized: true, value: amount * multiplier};
}

export function verifyDescendingByMetric(rows, metricName = '视频销售额') {
  let previous = null;
  let verified = 0;
  let unparsed = 0;
  let missing = 0;
  let missingSeen = false;
  for (const row of rows) {
    const raw = row.metrics?.[metricName] ?? row[metricName] ?? '';
    const parsed = parseBandBound(raw);
    if (!parsed.recognized) {
      unparsed += 1;
      continue;
    }
    if (parsed.value === null) {
      missing += 1;
      missingSeen = true;
      continue;
    }
    if (missingSeen) {
      return {ok: false, metricName, currentRank: row.sourceRank, reason: 'missing_metric_before_later_value',
        verified, unparsed, missing, coverage: rows.length ? verified / rows.length : 0};
    }
    if (previous !== null && parsed.value > previous.value) {
      return {ok: false, metricName, previousRank: previous.rank, previousValue: previous.value,
        currentRank: row.sourceRank, currentValue: parsed.value, verified, unparsed, missing,
        coverage: rows.length ? verified / rows.length : 0};
    }
    previous = {value: parsed.value, rank: row.sourceRank};
    verified += 1;
  }
  const minimumVerified = Math.max(3, Math.ceil(rows.length * 0.75));
  return {ok: verified >= minimumVerified && unparsed === 0, metricName, verified, unparsed, missing,
    minimumVerified, missingAtEnd: missingSeen, coverage: rows.length ? verified / rows.length : 0};
}

export function pageFingerprint(rows) {
  const stableRows = rows.map(row => ({
    sourceRank: row.sourceRank,
    creatorId: normalizeText(row.creatorId),
    creatorName: normalizeText(row.creatorName),
    sourceProfileUrl: normalizeText(row.sourceProfileUrl),
    metrics: Object.fromEntries(Object.entries(row.metrics || {}).sort(([a], [b]) => a.localeCompare(b))),
    subjectEvidence: Object.fromEntries(Object.entries(row.subjectEvidence || {}).sort(([a], [b]) => a.localeCompare(b))),
    creatorSubjectEvidence: Object.fromEntries(Object.entries(row.creatorSubjectEvidence || {}).sort(([a], [b]) => a.localeCompare(b))),
    businessEvidence: Object.fromEntries(Object.entries(row.businessEvidence || {}).sort(([a], [b]) => a.localeCompare(b))),
  }));
  return createHash('sha256').update(JSON.stringify(stableRows)).digest('hex');
}

export function formatLarkDateTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('KOC_INVALID_DATETIME');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
}

export function buildRosterRecordFields(row, {
  batchId, capturedAt = new Date(), existing = false,
  scope = ROSTER_SCOPE_LABEL,
  fullSnapshot = false,
  verificationStatus = '', currentTop500 = false,
} = {}) {
  if (!row?.creatorId || !row?.creatorName || !row?.sourceProfileUrl) throw new Error('KOC_CREATOR_ID_NAME_AND_SOURCE_REQUIRED');
  if (!batchId) throw new Error('KOC_BATCH_ID_REQUIRED');
  const captured = formatLarkDateTime(capturedAt);
  const fields = {
    Text: row.creatorName,
    抖音号: row.creatorId,
    蝉妈妈来源: sameOriginSourceUrl(row.sourceProfileUrl),
    采集批次: batchId,
    最近观测排名: row.sourceRank,
    最近观测榜期: batchId,
    最近观测时间: captured,
    榜单筛选口径: scope,
  };
  if (verificationStatus) fields['榜单验证状态'] = verificationStatus;
  else if (fullSnapshot) fields['榜单验证状态'] = '已核验完整当期Top500';
  else if (!existing) fields['榜单验证状态'] = '真实榜单样本；未完成当期Top500验收';
  const videoSalesRaw = row.videoSalesRaw ?? row.metrics?.['视频销售额'];
  if (videoSalesRaw !== undefined && videoSalesRaw !== null && String(videoSalesRaw).trim() !== '') fields['视频销售额'] = String(videoSalesRaw);
  else if (existing) fields['视频销售额'] = '';
  const visibleMetrics = row.metrics && Object.values(row.metrics).some(value => String(value ?? '').trim() !== '');
  if (visibleMetrics) fields['蝉妈妈榜单指标原文'] = JSON.stringify(row.metrics);
  else if (existing) fields['蝉妈妈榜单指标原文'] = '';
  if (!existing) {
    fields['首次收录时间'] = captured;
    fields['首次收录排名'] = row.sourceRank;
    fields['首次收录榜期'] = batchId;
  }
  if (fullSnapshot || currentTop500) fields['当期在榜状态'] = '在榜';
  assertRosterPatch(fields);
  return fields;
}

export function assertRosterPatch(fields) {
  for (const [key, value] of Object.entries(fields || {})) {
    if (!ROSTER_FIELD_ALLOWLIST.has(key)) throw new Error(`KOC_ROSTER_FIELD_NOT_ALLOWED:${key}`);
    if (value === undefined) throw new Error(`KOC_UNDEFINED_FIELD_VALUE:${key}`);
  }
  if (!fields['抖音号'] || !fields.Text) throw new Error('KOC_ROSTER_ID_AND_NAME_REQUIRED');
  return true;
}

export function assertContactPatch(fields) {
  const entries = Object.entries(fields || {});
  if (!entries.length) throw new Error('KOC_CONTACT_PATCH_EMPTY');
  for (const [key, value] of entries) {
    if (!CONTACT_PATCH_ALLOWLIST.has(key)) throw new Error(`KOC_CONTACT_FIELD_NOT_ALLOWED:${key}`);
    if (value === undefined || value === null) throw new Error(`KOC_CONTACT_NULL_OR_UNDEFINED_VALUE:${key}`);
  }
  const status = normalizeText(fields['本次联系方式状态']);
  if (status === 'found') {
    if (!normalizeText(fields['微信号']) || !fields['联系方式最近成功'] || !fields['联系方式来源']) {
      throw new Error('KOC_CONTACT_SUCCESS_REQUIRES_VALUE_TIME_AND_SOURCE');
    }
    if ('联系方式最近错误' in fields && fields['联系方式最近错误'] !== '') {
      throw new Error('KOC_CONTACT_SUCCESS_MUST_CLEAR_ONLY_PRIOR_ERROR');
    }
  } else {
    if (!CONTACT_FAILURE_STATES.has(status)) throw new Error('KOC_CONTACT_FAILURE_STATUS_INVALID');
    for (const key of ['微信号', '联系方式最近成功', '联系方式来源']) {
      if (key in fields) throw new Error(`KOC_CONTACT_FAILURE_CANNOT_CHANGE_SUCCESS_FIELD:${key}`);
    }
    if (!fields['联系方式最近尝试']) throw new Error('KOC_CONTACT_FAILURE_REQUIRES_ATTEMPT_TIME');
  }
  return true;
}
