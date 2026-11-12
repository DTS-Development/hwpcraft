#!/usr/bin/env node
// 관리자 화면이 읽는 명령 목록(commands.json)을 만든다.
// 형식(공통): { app, schema: 1, commands: [{ id, label, labelKo, location[], grades: { builder } }] }
// 편집기의 실제 명령 모듈을 vite SSR 로 읽어 만들고, 등급은 src/ppm/command-policy.ts 표에서 가져온다
// — 표와 목록이 어긋날 수 없다. 표에 있는 id 가 명령 목록에 없으면 실패한다.
// 메뉴에 없는 명령(서식 막대·상태 표시줄 등)의 location 은 src/ppm/control-commands.ts 대응표의 표면 이름이다.
//
// 사용: node ppm/gen-commands.mjs <rhwp-studio 경로> <출력 파일>
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [studioArg, outArg] = process.argv.slice(2);
if (!studioArg || !outArg) {
  console.error('사용: node ppm/gen-commands.mjs <rhwp-studio 경로> <출력 파일>');
  process.exit(2);
}
const studio = resolve(studioArg);
const require = createRequire(join(studio, 'package.json'));
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);

const COMMAND_MODULES = ['file', 'edit', 'view', 'format', 'insert', 'table', 'page', 'tool'];
const PSEUDO = [{ id: 'link.external', label: 'Open external links', labelKo: '외부 링크 열기', location: ['Links'] }];

// wasm 산출물(pkg/)이 없어도 명령 모듈을 읽을 수 있게 가짜 모듈로 막는다. 명령 정의에는 쓰이지 않는다.
const stubWasm = {
  name: 'ppm-stub-wasm',
  enforce: 'pre',
  resolveId(id) { if (id === '@wasm/rhwp.js' || /pkg\/rhwp\.js$/.test(id)) return '\0ppm-stub-wasm'; },
  load(id) { if (id === '\0ppm-stub-wasm') return 'export default function init(){}; export class HwpDocument {}; export const version = () => "";'; },
};

/** 한 로케일로 명령 id→라벨, 메뉴 키→문구를 읽는다. 로케일마다 서버를 따로 띄워 모듈을 새로 평가한다. */
async function load(lang) {
  globalThis.location = { search: `?lang=${lang}` };
  const server = await createServer({
    root: studio, configFile: join(studio, 'vite.config.ts'),
    server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom', logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, entries: [] }, plugins: [stubWasm],
  });
  try {
    const labels = new Map();
    for (const m of COMMAND_MODULES) {
      const mod = await server.ssrLoadModule(`/src/command/commands/${m}.ts`);
      for (const v of Object.values(mod)) {
        if (!Array.isArray(v)) continue;
        for (const c of v) if (c && typeof c.id === 'string' && !labels.has(c.id)) labels.set(c.id, c.label ?? c.id);
      }
    }
    const i18n = await server.ssrLoadModule('/src/i18n/index.ts');
    const policy = await server.ssrLoadModule('/src/ppm/command-policy.ts');
    const controls = await server.ssrLoadModule('/src/ppm/control-commands.ts');
    return { labels, t: i18n.t, locale: i18n.getLocale(), policy, controls };
  } finally {
    await server.close();
  }
}

/** index.html 의 메뉴 구조에서 명령 id → 위치(메뉴 제목, 하위 메뉴 제목들). 번역 키를 함께 돌려준다. */
function menuLocations(html) {
  const locs = new Map();
  const lines = html.split('\n');
  let depth = 0;
  const stack = []; // { depth, key }  — menu-item / md-sub 가 열린 깊이
  for (const line of lines) {
    const opens = (line.match(/<div\b/g) || []).length;
    const closes = (line.match(/<\/div>/g) || []).length;
    const menu = line.match(/class="menu-item"[^>]*data-menu="([^"]+)"/);
    if (menu) stack.push({ depth, kind: 'menu', key: null });
    else if (/class="md-sub\b/.test(line)) stack.push({ depth, kind: 'sub', key: null });
    // 제목 줄: menu-title / md-sub 안 첫 md-label 의 data-i18n
    const title = line.match(/class="menu-title"[^>]*data-i18n="([^"]+)"/);
    if (title && stack.length) stack[stack.length - 1].key = title[1];
    const subLabel = line.match(/<span class="md-label" data-i18n="([^"]+)">[^<]*<\/span><span class="md-arrow"/);
    if (subLabel && stack.length) stack[stack.length - 1].key = subLabel[1];
    const cmd = line.match(/data-cmd="([^"]+)"/);
    if (cmd && stack.length && !locs.has(cmd[1])) locs.set(cmd[1], stack.map((s) => s.key).filter(Boolean));
    depth += opens - closes;
    while (stack.length && depth <= stack[stack.length - 1].depth) stack.pop();
  }
  return locs;
}

const [ko, en] = [await load('ko'), await load('en')];
if (ko.locale !== 'ko' || en.locale !== 'en') {
  console.error(`로케일 전환 실패: ko=${ko.locale} en=${en.locale}`);
  process.exit(1);
}
const locs = menuLocations(readFileSync(join(studio, 'index.html'), 'utf8'));
const { NON_DEFAULT_GRADES, gradeOf } = ko.policy;
// 메뉴에 위치가 없는 명령은 처음 만나는 조작 요소의 표면(도구 상자·서식 막대·상태 표시줄)을 위치로 쓴다:
// index.html 에서 data-cmd 를 가진 도구 모음 단추, 그다음 대응표(data-cmd 가 없는 요소).
const surfaceOf = new Map();
{
  const html = readFileSync(join(studio, 'index.html'), 'utf8');
  const regions = [['id="icon-toolbar"', 'toolbox'], ['id="style-bar"', 'format'], ['id="status-bar"', 'status']]
    .map(([marker, surface]) => [html.indexOf(marker), ko.controls.SURFACE_LABELS[surface]])
    .filter(([pos]) => pos >= 0)
    .sort((x, y) => x[0] - y[0]);
  for (const m of html.matchAll(/data-cmd="([^"]+)"/g)) {
    const region = regions.filter(([pos]) => pos <= m.index).at(-1);
    if (region && !surfaceOf.has(m[1])) surfaceOf.set(m[1], region[1]);
  }
}
for (const b of ko.controls.CONTROL_BINDINGS) {
  if (!surfaceOf.has(b.commandId)) surfaceOf.set(b.commandId, ko.controls.SURFACE_LABELS[b.surface]);
}

const commands = [];
for (const [id, labelKo] of ko.labels) {
  const keys = locs.get(id) ?? [];
  commands.push({
    id,
    label: String(en.labels.get(id) ?? labelKo),
    labelKo: String(labelKo),
    location: keys.length ? keys.map((k) => en.t(k)) : surfaceOf.has(id) ? [surfaceOf.get(id)] : ['Other'],
    grades: { builder: gradeOf(id) },
  });
}
for (const p of PSEUDO) commands.push({ ...p, grades: { builder: gradeOf(p.id) } });

// 표 ↔ 목록 어긋남 검사: 표에 있는 id 는 모두 목록에 있어야 한다.
const ids = new Set(commands.map((c) => c.id));
const missing = Object.keys(NON_DEFAULT_GRADES).filter((id) => !ids.has(id));
if (missing.length) {
  console.error(`등급 표에는 있으나 명령 목록에 없는 id: ${missing.join(', ')}`);
  process.exit(1);
}
const unbound = [...new Set(ko.controls.CONTROL_BINDINGS.map((b) => b.commandId))].filter((id) => !ids.has(id));
if (unbound.length) {
  console.error(`조작 요소 대응표에는 있으나 명령 목록에 없는 id: ${unbound.join(', ')}`);
  process.exit(1);
}
const dup = commands.length - ids.size;
if (dup) { console.error('중복 id'); process.exit(1); }

writeFileSync(resolve(outArg), JSON.stringify({ app: 'hwp', schema: 1, commands }, null, 2) + '\n');
console.log(`commands.json: ${commands.length}개 (locked ${commands.filter((c) => c.grades.builder === 'locked').length}, off ${commands.filter((c) => c.grades.builder === 'off').length})`);
