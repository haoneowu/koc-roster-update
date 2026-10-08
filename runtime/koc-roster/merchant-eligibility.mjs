export const DEFAULT_EXCLUDED_MERCHANT_NAME_PATTERNS = Object.freeze([
  '旗舰店',
  '专卖店',
  '厂家直销',
  '零食店',
  '宠物店',
]);

const EXPLICIT_MERCHANT_SUBJECT_TYPES = new Set([
  '店铺',
  '店铺号',
  '店铺账号',
  '店铺主体',
  '商铺',
  '商家',
  '商家号',
  '商家账号',
  '商家身份',
  '商家主体',
  '商户',
  '商户号',
  '商户身份',
  '品牌方',
  '品牌商家',
  '品牌店铺',
  '企业店铺',
]);

function normalizeEvidence(value) {
  return value === null || value === undefined ? '' : String(value).replace(/\s+/g, ' ').trim();
}

/** Returns true only for an explicit merchant name signal or a clear merchant subject type. */
export function isExplicitMerchant({names = [], typeValues = [], namePatterns = []} = {}) {
  const nameList = Array.isArray(names) ? names : [names];
  const typeList = Array.isArray(typeValues) ? typeValues : [typeValues];
  const patterns = [...DEFAULT_EXCLUDED_MERCHANT_NAME_PATTERNS,
    ...(Array.isArray(namePatterns) ? namePatterns : [])];

  if (nameList.some(value => {
    const name = normalizeEvidence(value);
    return name && patterns.some(pattern => {
      const normalizedPattern = normalizeEvidence(pattern);
      return normalizedPattern && name.includes(normalizedPattern);
    });
  })) return true;

  return typeList.some(value => EXPLICIT_MERCHANT_SUBJECT_TYPES.has(normalizeEvidence(value)));
}
