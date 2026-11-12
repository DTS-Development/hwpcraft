import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { codeOnly } from './support/source-guard.ts';
import { CommandDispatcher } from '../src/command/dispatcher.ts';
import { isCommandAllowed, type CommandOverrides } from '../src/ppm/command-policy.ts';
import {
  CONTROL_BINDINGS, CHAR_CONTROL_COMMAND, FONT_SIZE_UP_COMMAND, FONT_SIZE_DOWN_COMMAND, ZOOM_SLIDER_COMMAND,
} from '../src/ppm/control-commands.ts';
import {
  CONTAINER_SELECTOR, SEPARATOR_SELECTOR, TRIGGER_SELECTOR, pruneChrome, type PruneRules,
} from '../src/ppm/menu-prune.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const indexHtml = read('index.html');
const cmdDir = new URL('../src/command/commands/', import.meta.url);
const commandSource = readdirSync(cmdDir).filter((f) => f.endsWith('.ts')).map((f) => readFileSync(new URL(f, cmdDir), 'utf8')).join('\n');

// ── index.html 을 작은 트리로 읽는다(DOM 라이브러리 없이 구조·id·class 만 필요하다) ──
interface HNode {
  tag: string;
  attrs: Record<string, string>;
  classes: Set<string>;
  children: HNode[];
  parent: HNode | null;
  hidden: boolean;
}
const VOID = new Set(['meta', 'link', 'br', 'img', 'input', 'hr']);

function parseHtml(html: string): HNode {
  const root: HNode = { tag: '#root', attrs: {}, classes: new Set(), children: [], parent: null, hidden: false };
  let cur = root;
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  for (const m of html.matchAll(re)) {
    if (m[0].startsWith('<!--')) continue;
    const [, closing, tagRaw, rest, selfClose] = m;
    const tag = tagRaw.toLowerCase();
    if (closing) {
      for (let n: HNode | null = cur; n; n = n.parent) {
        if (n.tag === tag) { cur = n.parent ?? root; break; }
      }
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of rest.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] ?? '';
    const node: HNode = { tag, attrs, classes: new Set((attrs.class ?? '').split(/\s+/).filter(Boolean)), children: [], parent: cur, hidden: false };
    cur.children.push(node);
    if (!VOID.has(tag) && !selfClose) cur = node;
  }
  return root;
}

/** 시험이 쓰는 selector 는 `.class`, `#id`, `#id [attr="v"]` 꼴뿐이다. */
function matches(n: HNode, selector: string): boolean {
  return selector.split(',').map((s) => s.trim()).some((sel) => {
    const desc = sel.match(/^#([\w-]+) \[([\w-]+)="([^"]+)"\]$/);
    if (desc) {
      if (n.attrs[desc[2]] !== desc[3]) return false;
      for (let p = n.parent; p; p = p.parent) if (p.attrs.id === desc[1]) return true;
      return false;
    }
    if (sel.startsWith('#')) return n.attrs.id === sel.slice(1);
    if (sel.startsWith('.')) return n.classes.has(sel.slice(1));
    throw new Error(`시험이 모르는 selector: ${sel}`);
  });
}

function walk(n: HNode, fn: (n: HNode) => void): void {
  fn(n);
  for (const c of n.children) walk(c, fn);
}

/** host 모드 부팅 직후의 DOM: 잠긴 명령의 요소와 최근 문서 메뉴는 main.ts 가 먼저 걷어낸다. */
function bootTree(lockedIds: readonly string[]): HNode {
  const root = parseHtml(indexHtml);
  const strip = (n: HNode) => {
    n.children = n.children.filter((c) => !(lockedIds.includes(c.attrs['data-cmd'] ?? '') || 'data-recent' in c.attrs));
    n.children.forEach(strip);
  };
  strip(root);
  return root;
}

function bindingMap(root: HNode): Map<HNode, string> {
  const map = new Map<HNode, string>();
  walk(root, (n) => {
    for (const b of CONTROL_BINDINGS) if (matches(n, b.selector)) map.set(n, b.commandId);
  });
  return map;
}

function runPrune(root: HNode, overrides: CommandOverrides): void {
  const bound = bindingMap(root);
  walk(root, (n) => { n.hidden = false; });
  const rules: PruneRules<HNode> = {
    leafBlocked: (el) => {
      const cmd = el.attrs['data-cmd'] || bound.get(el);
      return cmd ? !isCommandAllowed(cmd, overrides) : null;
    },
    isContainer: (el) => matches(el, CONTAINER_SELECTOR),
    isSeparator: (el) => matches(el, SEPARATOR_SELECTOR),
    isTrigger: (el) => matches(el, TRIGGER_SELECTOR),
    setHidden: (el, hidden) => { el.hidden = hidden; },
  };
  for (const id of ['studio-header', 'status-bar']) {
    walk(root, (n) => { if (n.attrs.id === id) pruneChrome(n, rules); });
  }
}

const effectivelyHidden = (n: HNode): boolean => { for (let p: HNode | null = n; p; p = p.parent) if (p.hidden) return true; return false; };
const isControl = (n: HNode) => ['button', 'select', 'input', 'textarea'].includes(n.tag);
const allCommandIds = (): string[] => {
  const ids = new Set<string>([...commandSource.matchAll(/^\s*id: '([^']+)'/gm)].map((m) => m[1]));
  walk(parseHtml(indexHtml), (n) => { if (n.attrs['data-cmd']) ids.add(n.attrs['data-cmd']); });
  return [...ids];
};
const allOff = (): CommandOverrides => Object.fromEntries(allCommandIds().map((id) => [id, false]));
const LOCKED = ['file:new-doc', 'file:open', 'file:open-recent', 'file:clear-recent'];

// ── 대응표 ──
test('대응표의 명령 id 는 실제 명령 정의에 있다', () => {
  for (const b of CONTROL_BINDINGS) assert.ok(commandSource.includes(`id: '${b.commandId}'`), `${b.commandId}: 명령 정의 없음`);
});

test('대응표의 selector 는 index.html 에 정확히 하나 이상 있다(없으면 숨기지 못한다)', () => {
  const root = parseHtml(indexHtml);
  for (const b of CONTROL_BINDINGS) {
    let count = 0;
    walk(root, (n) => { if (matches(n, b.selector)) count += 1; });
    assert.ok(count >= 1, `${b.selector}: index.html 에서 찾을 수 없다`);
  }
});

test('대응표 요소에는 data-cmd 가 없다(main.ts 가 .tb-btn[data-cmd] 클릭을 디스패치해 동작이 바뀐다)', () => {
  const root = parseHtml(indexHtml);
  walk(root, (n) => {
    for (const b of CONTROL_BINDINGS) if (matches(n, b.selector)) assert.equal(n.attrs['data-cmd'], undefined, b.selector);
  });
});

// ── 모든 조작 요소가 정책 대상이다 ──
// 정책 대상(data-cmd·대응표) 안에 들어 있거나 이 예외 목록에 없는 단추·입력은 정책을 벗어나 보이고 실행된다.
const EXEMPT_CONTROLS: Readonly<Record<string, string>> = {
  'btn-charfx': '글자 효과 드롭다운을 여는 단추 — 하위 5개가 모두 막히면 드롭다운째 숨는다',
  'btn-style-overflow': '문단 정렬 더보기를 여는 단추 — 정렬 6개가 모두 막히면 숨는다',
  'file-input': '보이지 않는 파일 선택 입력 — host 모드에서는 선택해도 열지 않는다(main.ts: if (PPM_HOST) { input.value = \'\'; return; })',
  'icon-toolbar-prev': '도구 상자 가로 스크롤 이동(문서 명령 아님) — 도구 상자가 비면 함께 숨는다',
  'icon-toolbar-next': '도구 상자 가로 스크롤 이동(문서 명령 아님) — 도구 상자가 비면 함께 숨는다',
};

test('머리 영역·상태 표시줄의 모든 단추·입력은 정책 대상이거나 예외 목록에 있다', () => {
  const root = bootTree(LOCKED);
  const bound = bindingMap(root);
  const uncovered: string[] = [];
  for (const id of ['studio-header', 'status-bar']) {
    walk(root, (n) => {
      if (n.attrs.id !== id) return;
      walk(n, (c) => {
        if (!isControl(c)) return;
        for (let p: HNode | null = c; p && p !== n; p = p.parent) if (p.attrs['data-cmd'] || bound.has(p)) return;
        if (c.attrs.id && EXEMPT_CONTROLS[c.attrs.id]) return;
        if (c.classes.has('tb-split-arrow')) return; // 찾기 ▾ — 메뉴 항목이 모두 막히면 숨는다(아래 시험)
        uncovered.push(`${c.tag}#${c.attrs.id ?? ''}.${[...c.classes].join('.')}`);
      });
    });
  }
  assert.deepEqual(uncovered, []);
});

// ── 숨김 ──
test('잠기지 않은 명령을 모두 끄면 보이는 조작 요소가 하나도 없다', () => {
  const root = bootTree(LOCKED);
  runPrune(root, allOff());
  const leftovers: string[] = [];
  const studio = (() => { let r: HNode | null = null; walk(root, (n) => { if (n.attrs.id === 'studio-header' || n.attrs.id === 'status-bar') (r ??= n); }); return r; })();
  assert.ok(studio);
  for (const id of ['studio-header', 'status-bar']) {
    walk(root, (n) => {
      if (n.attrs.id !== id) return;
      walk(n, (c) => { if (isControl(c) && !effectivelyHidden(c)) leftovers.push(`${c.tag}#${c.attrs.id ?? ''}.${[...c.classes].join('.')}`); });
    });
  }
  assert.deepEqual(leftovers, []);
});

test('잠기지 않은 명령을 모두 끄면 메뉴 제목·부모 항목·구분선도 남지 않는다', () => {
  const root = bootTree(LOCKED);
  runPrune(root, allOff());
  const left: string[] = [];
  walk(root, (n) => {
    if ((n.classes.has('menu-item') || n.classes.has('md-sub') || n.classes.has('md-sep') || n.classes.has('tb-sep') || n.classes.has('tb-group')) && !effectivelyHidden(n)) {
      left.push(`${n.attrs['data-menu'] ?? ''}.${[...n.classes].join('.')}`);
    }
  });
  assert.deepEqual(left, []);
});

test('아무것도 끄지 않으면 정리 대상(잠금 제외)이 숨지 않는다', () => {
  const root = bootTree(LOCKED);
  runPrune(root, {});
  const hidden: string[] = [];
  walk(root, (n) => { if (n.hidden && n.attrs['data-cmd'] !== undefined) hidden.push(n.attrs['data-cmd']); });
  // 기본으로 꺼진 명령(저장 형식·인쇄 등)은 숨는 것이 맞다.
  for (const id of hidden) assert.ok(!isCommandAllowed(id, {}), `${id} 는 허용인데 숨었다`);
  // 첫 구성원이 허용인 메뉴 제목은 남는다.
  walk(root, (n) => { if (n.classes.has('menu-item')) assert.equal(n.hidden, false, n.attrs['data-menu']); });
});

test('무작위 정책에서도 구분선·묶음·끈 요소 규칙이 지켜진다', () => {
  const ids = allCommandIds();
  let seed = 20261112;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let round = 0; round < 120; round++) {
    const keep = rnd();
    const overrides: Record<string, boolean> = {};
    for (const id of ids) overrides[id] = rnd() < keep;
    const root = bootTree(LOCKED);
    runPrune(root, overrides);
    const bound = bindingMap(root);
    walk(root, (n) => {
      // 1) 끈 조작 요소는 숨는다.
      const cmd = n.attrs['data-cmd'] || bound.get(n);
      if (cmd && !isCommandAllowed(cmd, overrides)) assert.ok(effectivelyHidden(n), `round ${round}: ${cmd} 가 남았다`);
      // 2) 보이는 형제 사이의 구분선 규칙: 맨 앞·맨 끝·연속이 없다.
      if (effectivelyHidden(n)) return;
      const seq = n.children.filter((c) => !c.hidden);
      seq.forEach((c, i) => {
        if (!matches(c, SEPARATOR_SELECTOR)) return;
        assert.ok(i > 0 && i < seq.length - 1, `round ${round}: 가장자리 구분선`);
        assert.ok(!matches(seq[i - 1], SEPARATOR_SELECTOR), `round ${round}: 연속 구분선`);
      });
      // 3) 보이는 묶음에는 보이는 조작 요소가 하나는 있다(조작 요소가 아예 없는 묶음은 대상 아님).
      if (matches(n, CONTAINER_SELECTOR) && !bound.has(n) && !n.attrs['data-cmd']) {
        let total = 0;
        let shown = 0;
        walk(n, (c) => {
          const cc = c.attrs['data-cmd'] || bound.get(c);
          if (!cc || c === n) return;
          total += 1;
          if (isCommandAllowed(cc, overrides) && !effectivelyHidden(c)) shown += 1;
        });
        if (total > 0) assert.ok(shown > 0, `round ${round}: 빈 묶음 ${[...n.classes].join('.')}#${n.attrs.id ?? ''}`);
      }
    });
  }
});

test('찾기 분할 단추: 메뉴 항목이 모두 꺼지면 ▾ 단추도 함께 숨고, 하나라도 남으면 남는다', () => {
  const root = bootTree(LOCKED);
  const itemIds: string[] = [];
  walk(root, (n) => { if (n.classes.has('tb-split-item') && n.attrs['data-cmd']) itemIds.push(n.attrs['data-cmd']); });
  assert.ok(itemIds.length >= 2);
  const arrow = () => { let a: HNode | null = null; walk(root, (n) => { if (n.classes.has('tb-split-arrow')) a = n; }); return a!; };
  runPrune(root, Object.fromEntries(itemIds.map((id) => [id, false])));
  assert.ok(effectivelyHidden(arrow()));
  runPrune(root, Object.fromEntries(itemIds.slice(1).map((id) => [id, false])));
  assert.ok(!effectivelyHidden(arrow()));
});

test('정책이 바뀌면 숨김이 되살아난다(요소를 지우지 않는다)', () => {
  const root = bootTree(LOCKED);
  runPrune(root, allOff());
  runPrune(root, {});
  const cut = (() => { let c: HNode | null = null; walk(root, (n) => { if (n.attrs.id === 'tb-cut') c = n; }); return c!; })();
  assert.equal(effectivelyHidden(cut), false);
});

// ── 실행 막기 ──
test('dispatcher.isHostAllowed 는 게이트만 본다', () => {
  const registry = { get: () => undefined } as any;
  const services = { getContext: () => ({ isFormMode: true }) } as any;
  const d = new CommandDispatcher(registry, services, { emit() {} } as any);
  assert.equal(d.isHostAllowed('format:char-shape'), true); // 게이트가 없으면 항상 허용
  d.setGate((id) => (id === 'format:char-shape' ? 'deny' : id === 'file:save' ? 'handled' : 'allow'));
  assert.equal(d.isHostAllowed('format:char-shape'), false);
  assert.equal(d.isHostAllowed('file:save'), true);
  assert.equal(d.isHostAllowed('format:bold'), true); // 양식 모드·canExecute 는 보지 않는다
});

test('이벤트를 직접 내보내는 서식 막대 요소는 숨김과 같은 명령 id 로 실행을 막는다', () => {
  const toolbar = codeOnly(read('src/ui/toolbar.ts'));
  // format-char·highlight-pick 은 게이트를 지나는 출구 함수 안에서만 내보낸다.
  assert.equal((toolbar.match(/emit\('format-char'/g) ?? []).length, 1);
  assert.equal((toolbar.match(/emit\('highlight-pick'/g) ?? []).length, 1);
  assert.match(toolbar, /private emitFormatChar\(commandId: string, props: CharProperties\): void \{\s*if \(!this\.dispatcher\.isHostAllowed\(commandId\)\) return;/);
  assert.match(toolbar, /private emitHighlightPick\(color: string\): void \{\s*if \(!this\.dispatcher\.isHostAllowed\(CHAR_CONTROL_COMMAND\)\) return;/);
  // 요소별 실행 id: 글꼴·언어 선택(대표 글꼴 세트 포함)·크기 입력·글자 색은 글자 모양, 화살표는 각자 명령.
  assert.equal((toolbar.match(/emitFormatChar\(CHAR_CONTROL_COMMAND,/g) ?? []).length, 5);
  assert.match(toolbar, /emitFormatChar\(FONT_SIZE_UP_COMMAND,/);
  assert.match(toolbar, /emitFormatChar\(FONT_SIZE_DOWN_COMMAND,/);
  // 숨김 대응표도 같은 id 를 쓴다.
  const idOf = (selector: string) => CONTROL_BINDINGS.find((b) => b.selector === selector)?.commandId;
  assert.equal(idOf('#btn-size-up'), FONT_SIZE_UP_COMMAND);
  assert.equal(idOf('#btn-size-down'), FONT_SIZE_DOWN_COMMAND);
  for (const sel of ['#sbf-lang', '#sbf-font', '#sbf-size', '#sb-color-wrap', '#highlight-dropdown']) assert.equal(idOf(sel), CHAR_CONTROL_COMMAND, sel);
  assert.equal(idOf('#sb-zoom-range-wrap'), ZOOM_SLIDER_COMMAND);
});

test('확대 가로바는 입력·키보드 모두 view:zoom-dialog 정책을 확인한다', () => {
  const main = codeOnly(read('src/main.ts'));
  assert.equal((main.match(/if \(!dispatcher\.isHostAllowed\(PPM_ZOOM_SLIDER_COMMAND\)\) return;/g) ?? []).length, 2);
  assert.match(main, /zoomRange\.addEventListener\('input', \(\) => \{\s*if \(!dispatcher\.isHostAllowed/);
  assert.match(main, /zoomRange\.addEventListener\('keydown', \(event\) => \{\s*if \(!dispatcher\.isHostAllowed/);
});

test('오른쪽 버튼 메뉴는 정책이 끈 명령을 만들지 않고 빈 상자를 띄우지 않는다', () => {
  const src = codeOnly(read('src/ui/context-menu.ts'));
  assert.match(src, /if \(!this\.dispatcher\.isHostAllowed\(cmdId\)\) \{ skippedByPolicy = true; continue; \}/);
  assert.match(src, /if \(!menu\.querySelector\('\.md-item'\)\) return;/);
});

test('단축키가 부르는 명령은 정책이 끈 경우 dispatcher 게이트에서 거부된다', () => {
  for (const id of ['format:char-shape', 'edit:cut', 'edit:copy', 'edit:paste', 'format:bold']) {
    const d = new CommandDispatcher({ get: (c: string) => (c === id ? { id: c, execute: () => { throw new Error('실행되면 안 된다'); } } : undefined) } as any, {} as any, {} as any);
    d.setGate((c) => (c === id ? 'deny' : 'allow'));
    assert.deepEqual(d.dispatchWithResult(id), { ok: false, reason: 'disabled' });
  }
});

test('입력 처리기는 format-char 를 직접 내보내지 않고, 브라우저 복사·잘라내기·붙여넣기도 정책을 확인한다', () => {
  const emitters = readdirSync(new URL('../src/engine/', import.meta.url))
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => /emit\(\s*'(format-char|highlight-pick)'/.test(codeOnly(read(`src/engine/${f}`))));
  assert.deepEqual(emitters, []);
  const src = codeOnly(read('src/engine/input-handler.ts'));
  for (const id of ['edit:copy', 'edit:cut', 'edit:paste']) {
    assert.match(src, new RegExp(`!this\\.dispatcher\\.isHostAllowed\\('${id}'\\)\\) \\{ e\\.preventDefault\\(\\)`));
  }
});
