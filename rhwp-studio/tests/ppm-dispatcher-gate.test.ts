import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandDispatcher } from '../src/command/dispatcher.ts';

// 게이트가 'handled' 를 돌려주는 명령은 isEnabled(상태 조회)에서 부작용이 없고, dispatch 에서 한 번만 처리된다.
function setup() {
  const ran: string[] = [];
  const handled: string[] = [];
  const defs = new Map([['file:save', { id: 'file:save', execute: () => { ran.push('execute'); } }]]);
  const registry = { get: (id: string) => defs.get(id) } as any;
  const services = { getContext: () => ({ isFormMode: false }) } as any;
  const eventBus = { emit: () => {} } as any;
  const dispatcher = new CommandDispatcher(registry, services, eventBus);
  let gateCalls = 0;
  dispatcher.setGate((id) => { gateCalls += 1; return id === 'file:save' ? 'handled' : 'allow'; });
  dispatcher.setHandledHandler((id) => { handled.push(id); });
  return { dispatcher, ran, handled, gateCalls: () => gateCalls };
}

test('isEnabled 는 위임 처리를 부르지 않는다(메뉴를 열어도 저장되지 않는다)', () => {
  const { dispatcher, handled, ran } = setup();
  for (let i = 0; i < 5; i++) assert.equal(dispatcher.isEnabled('file:save'), true);
  assert.deepEqual(handled, []);
  assert.deepEqual(ran, []);
});

test('dispatch 는 위임 처리를 한 번 부르고 편집기 자체 저장은 실행하지 않는다', () => {
  const { dispatcher, handled, ran } = setup();
  assert.equal(dispatcher.dispatch('file:save'), true);
  assert.deepEqual(handled, ['file:save']);
  assert.deepEqual(ran, []);
});

test('isEnabled 를 먼저 불러도 dispatch 는 한 번만 처리한다(양식 FileSave 이중 전송 방지)', () => {
  const { dispatcher, handled } = setup();
  assert.equal(dispatcher.isEnabled('file:save'), true);
  dispatcher.dispatch('file:save');
  assert.equal(handled.length, 1);
});

test('위임 처리가 던지면 실행 결과는 threw', () => {
  const { dispatcher } = setup();
  dispatcher.setHandledHandler(() => { throw new Error('boom'); });
  const r = dispatcher.dispatchWithResult('file:save');
  assert.equal(r.ok, false);
});
