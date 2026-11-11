import test from 'node:test';
import assert from 'node:assert/strict';
import { isCommandAllowed, sanitizeOverrides, gradeOf, blockedIds } from '../src/ppm/command-policy.ts';

test('기본: 문서 출입은 막고 편집은 연다', () => {
  const o = sanitizeOverrides({});
  assert.equal(isCommandAllowed('file:open', o), false);
  assert.equal(isCommandAllowed('file:print', o), false);
  assert.equal(isCommandAllowed('file:save-as-hwpx', o), false);
  assert.equal(isCommandAllowed('link.external', o), false);
  assert.equal(isCommandAllowed('file:save', o), true);
  assert.equal(isCommandAllowed('edit:compare-documents', o), true);
  assert.equal(isCommandAllowed('format:bold', o), true);
});

test('off 는 override true 로 켜지고 locked 는 못 켠다', () => {
  const o = sanitizeOverrides({ 'file:print': true, 'file:open': true });
  assert.equal(isCommandAllowed('file:print', o), true);
  assert.equal(isCommandAllowed('file:open', o), false);
});

test('on 은 override false 로 꺼진다(문서 비교)', () => {
  const o = sanitizeOverrides({ 'edit:compare-documents': false });
  assert.equal(isCommandAllowed('edit:compare-documents', o), false);
});

test('sanitizeOverrides: 잘못된 id·값·프로토타입 키는 버린다', () => {
  const o = sanitizeOverrides(JSON.parse('{"__proto__":true,"a b":true,"file:print":"yes","edit:find":false}'));
  assert.deepEqual(Object.keys(o), ['edit:find']);
  assert.deepEqual(Object.keys(sanitizeOverrides(null)), []);
  assert.deepEqual(Object.keys(sanitizeOverrides([true])), []);
  assert.equal(gradeOf('toString'), 'on');
});

test('blockedIds', () => {
  const ids = ['file:open', 'file:print', 'edit:find'];
  assert.deepEqual(blockedIds(sanitizeOverrides({ 'file:print': true }), ids), ['file:open']);
});
