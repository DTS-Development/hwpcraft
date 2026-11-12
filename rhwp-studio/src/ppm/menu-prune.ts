/**
 * PPM host 모드: 정책으로 막힌 조작 요소 때문에 남는 빈 껍데기를 숨긴다.
 *
 * - 하위 조작 요소가 모두 막힌 컨테이너(메뉴 제목·부모 항목·도구 모음 묶음·서식 필드·드롭다운)
 * - 앞뒤에 보이는 형제가 없거나 연달아 남은 구분선
 * 숨김은 요소를 지우지 않고 setHidden 으로 켜고 끈다 — 정책이 다시 바뀌면 되살아나야 하기 때문이다.
 * DOM 에 직접 묶이지 않도록 노드 모양(children)과 판정을 주입받는 순수 함수라 node 테스트로 검증한다.
 */

/** 조작 요소가 모두 막히면 함께 숨길 묶음, 구분선, 묶음을 여는 단추(host-install 이 DOM 에 쓴다). */
export const CONTAINER_SELECTOR = '.menu-item, .md-sub, .tb-group, .tb-split, .sb-field, .sb-ribbon-group, .sb-command-band, .sb-overflow-host, .sb-dropdown, #menu-bar, #icon-toolbar, #style-bar';
export const SEPARATOR_SELECTOR = '.md-sep, .tb-sep, .tb-split-sep, .stb-divider, .sb-sep';
export const TRIGGER_SELECTOR = '#btn-charfx, #btn-style-overflow, .tb-split-arrow';
/** 정리를 시작하는 뿌리: 메뉴바·도구 상자·서식 막대가 든 머리 영역과 상태 표시줄. */
export const PRUNE_ROOTS = '#studio-header, #status-bar';

export interface PruneNode<N> {
  readonly children: ArrayLike<N>;
}

export interface PruneRules<N extends PruneNode<N>> {
  /** 정책 대상 조작 요소면 막혔는지(true=막힘), 아니면 null. */
  leafBlocked(el: N): boolean | null;
  /** 조작 요소가 모두 막히면 함께 숨길 묶음. */
  isContainer(el: N): boolean;
  isSeparator(el: N): boolean;
  /** 컨테이너를 여는 단추. 혼자서는 컨테이너를 보이게 하지 못한다(하위가 다 막히면 컨테이너째 숨는다). */
  isTrigger(el: N): boolean;
  setHidden(el: N, hidden: boolean): void;
  /**
   * 문맥에 따라 편집기가 직접 숨겨 둔 묶음(개체 선택 때만 뜨는 회전 묶음 등)이면 true.
   * 이런 묶음은 허용돼 있어도 지금 보이지 않으므로 "보이는 자식"으로 세지 않는다 —
   * 그러지 않으면 문맥 전용 묶음만 남았을 때 도구 상자가 빈 띠로 남는다.
   * 판정은 호출 시점의 상태이므로, 상태가 바뀌면 호출 쪽이 pruneChrome 을 다시 불러야 한다.
   */
  isContextHidden?(el: N): boolean;
}

interface Tally { has: boolean; vis: number; hidden: boolean }

/** root 아래를 정리한다. 호출할 때마다 모든 판정을 새로 계산해 켜고 끈다. */
export function pruneChrome<N extends PruneNode<N>>(root: N, rules: PruneRules<N>): void {
  const visitChildren = (el: N): Tally => {
    let has = false;
    let vis = 0;
    const kids: { el: N; hidden: boolean; sep: boolean }[] = [];
    for (let i = 0; i < el.children.length; i++) {
      const child = el.children[i];
      if (rules.isSeparator(child)) { kids.push({ el: child, hidden: false, sep: true }); continue; }
      if (rules.isTrigger(child)) { kids.push({ el: child, hidden: false, sep: false }); continue; }
      const r = visit(child);
      if (r.has) has = true;
      vis += r.vis;
      kids.push({ el: child, hidden: r.hidden, sep: false });
    }
    // 구분선: 이 형제 목록에서 정책 때문에 숨은 항목이 하나도 없으면 원래 배치 그대로 둔다
    // (회전 묶음 끝의 구분선처럼 원래부터 가장자리에 있는 것도 건드리지 않는다).
    // 숨은 항목이 있을 때만: 앞에 보이는 항목이 있고 직전이 구분선이 아닐 때 남기고, 끝에 남은 구분선은 숨긴다.
    if (!kids.some((k) => !k.sep && k.hidden)) {
      for (const k of kids) if (k.sep) rules.setHidden(k.el, false);
      return { has, vis, hidden: false };
    }
    let prev: 'none' | 'item' | 'sep' = 'none';
    let lastSep: N | null = null;
    for (const k of kids) {
      if (k.sep) {
        if (prev === 'item') { rules.setHidden(k.el, false); prev = 'sep'; lastSep = k.el; }
        else rules.setHidden(k.el, true);
      } else if (!k.hidden) {
        prev = 'item';
      }
    }
    if (prev === 'sep' && lastSep) rules.setHidden(lastSep, true);
    return { has, vis, hidden: false };
  };

  const visit = (el: N): Tally => {
    const blocked = rules.leafBlocked(el);
    if (blocked !== null) {
      rules.setHidden(el, blocked);
      if (blocked) return { has: true, vis: 0, hidden: true };
      visitChildren(el); // 허용된 조작 요소 안의 하위 요소도 정리한다
      return { has: true, vis: 1, hidden: false };
    }
    const t = visitChildren(el);
    if (!rules.isContainer(el)) {
      // 컨테이너가 아닌 감싸개도 정책 요소가 모두 숨었으면 형제 구분선 판정에서는 비어 있는 것으로 센다(표시는 걸지 않는다).
      return { has: t.has, vis: t.vis, hidden: t.has && t.vis === 0 };
    }
    if (rules.isContextHidden?.(el)) {
      // 숨김은 편집기 몫이다. 우리 표시는 걸지 않고, 구분선 판정에서는 원래 배치대로 보이는 항목으로 둔다.
      rules.setHidden(el, false);
      return { has: t.has, vis: 0, hidden: false };
    }
    const hide = t.has && t.vis === 0;
    rules.setHidden(el, hide);
    return { has: t.has, vis: t.vis, hidden: hide };
  };

  visitChildren(root);
}
