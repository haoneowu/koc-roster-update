import test from 'node:test';
import assert from 'node:assert/strict';
import {isMaskedContactValue} from './contact-reveal-state.mjs';

test('recognizes masked and placeholder contact values', () => {
  for (const value of ['', '   ', '***********', 'wx***demo', '••••••', '—', '未展示', '暂无', '已隐藏', '保密', 'N/A']) {
    assert.equal(isMaskedContactValue(value), true);
  }
});

test('accepts visible values without printing or retaining them', () => {
  for (const value of ['wx_demo_id_2026', '13800000000', '测试微信']) {
    assert.equal(isMaskedContactValue(value), false);
  }
});
