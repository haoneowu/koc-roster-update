export const CONTACT_MASK_REGEX_SOURCE = String.raw`[*＊•·●]|^[—–-]+$|^…+$|^(?:暂无|未展示|未显示|已隐藏|隐藏|保密|无|未知|无数据|N\/A)$`;

export function isMaskedContactValue(value) {
  const text = String(value ?? '').trim();
  return !text || new RegExp(CONTACT_MASK_REGEX_SOURCE, 'i').test(text);
}
