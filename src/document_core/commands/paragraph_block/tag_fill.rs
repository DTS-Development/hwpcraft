//! `{{key}}` · `{{loop 이름}}…{{endloop}}` 태그 채우기·키 추출 엔진.
//!
//! HWPX 구현(dts-craft `oss-hwpx.ts`)을 HWP 5.x 모델로 옮긴 것이다. 문법과 거절 규칙은 같고 다음이 다르다.
//! - 문단 묶음은 `Vec<Paragraph>`, 표 행은 "그 행에서 시작하는 셀 묶음"(RowUnit)이 반복 단위다.
//! - 개체 번호 재부여는 편집기 복제와 같은 `reidentify_with_allocator`를 쓴다.
//! - 복제 예산은 XML 바이트가 아니라 모델 크기 측정(`owned_work::measure`)이다.
//!
//! 먼저 빈 데이터로 한 번 훑어(collect) 문법 오류를 모두 낸 뒤, 데이터를 채운다. 두 번 다 복제본에서 하므로
//! 실패하면 문서는 그대로다.
pub use super::tag_scan::IssueKind;
use super::tag_scan::{edit_range, is_obj, model, scan, strip_fill, Tag, TagKind, FILL};
use crate::{
    document_core::commands::clone_identity::reidentify_with_allocator,
    model::{
        control::Control,
        identity::Allocator,
        paragraph::Paragraph,
        shape::ShapeObject,
        table::{Cell, Table},
    },
};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap, HashSet};

/// 반복 하나의 항목 수 상한(복제는 동기 작업이라 호출을 막는다).
pub const MAX_LOOP_ITEMS: usize = 20_000;
/// 반복으로 새로 만드는 문단 수 상한(문서 전체 합계).
pub const MAX_PARAS: usize = 250_000;
/// 반복으로 복제하는 구조의 총량 상한(모델 크기 추정 바이트). 작은 입력이 메모리를 터뜨리지 못하게 한다.
pub const MAX_CLONE_BYTES: usize = 256 * 1024 * 1024;
const MAX_ISSUES: usize = 1000;
/// 위치를 계산하는 오류 수 상한.
pub const MAX_LOCATED_ISSUES: usize = 50;
/// 한 번에 계산하는 키 위치 수 상한.
pub const MAX_LOCATIONS: usize = 100;
/// 위치에 싣는 태그 글자 길이 상한.
pub const TAG_LOCATION_TEXT_MAX: usize = 1000;

#[derive(Clone, Copy, Debug)]
pub struct TagLimits {
    pub max_loop_items: usize,
    pub max_paras: usize,
    pub max_clone_bytes: usize,
}

impl Default for TagLimits {
    fn default() -> Self {
        Self {
            max_loop_items: MAX_LOOP_ITEMS,
            max_paras: MAX_PARAS,
            max_clone_bytes: MAX_CLONE_BYTES,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Story {
    Body,
    Header,
    Footer,
    Footnote,
    Endnote,
    MasterPage,
}

impl Story {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Body => "body",
            Self::Header => "header",
            Self::Footer => "footer",
            Self::Footnote => "footnote",
            Self::Endnote => "endnote",
            Self::MasterPage => "masterPage",
        }
    }
}

/// 태그가 쓰인 곳. text = 문서에 적힌 태그 글자 그대로, occurrence = 범위 안 일치 순번(1부터), total = 범위 안 일치 수.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TagLocation {
    pub story: Story,
    pub text: String,
    pub occurrence: usize,
    pub total: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TagIssue {
    pub message: String,
    pub kind: IssueKind,
    pub name: Option<String>,
    pub location: Option<TagLocation>,
}

#[derive(Debug)]
pub enum TagFillError {
    /// 템플릿 문법 오류(짝이 안 맞는 반복·지원하지 않는 위치 등).
    Syntax(Vec<TagIssue>),
    /// 한도 초과(반복 수·문단 수·복제 크기).
    Limit(String),
    /// 문서 구조가 올바르지 않거나 내부 오류.
    Document(String),
}

type Res<T> = Result<T, TagFillError>;

/// 키 목록: 먼저 쓰인 순서를 지킨다. 반복 안의 키는 반복 이름 아래 항목으로 모인다.
#[derive(Clone, Debug, Default)]
pub struct TagKeys {
    pub entries: Vec<(String, Vec<String>)>,
}

impl TagKeys {
    fn add(&mut self, path: &[String]) {
        let (Some(top), child) = (path.first(), path.get(1)) else {
            return;
        };
        let idx = match self.entries.iter().position(|(k, _)| k == top) {
            Some(i) => i,
            None => {
                self.entries.push((top.clone(), Vec::new()));
                self.entries.len() - 1
            }
        };
        if let Some(child) = child {
            let subs = &mut self.entries[idx].1;
            if !subs.contains(child) {
                subs.push(child.clone());
            }
        }
    }

    /// `getTemplateKeysJson`와 같은 모양: `{"keys":{"이름":{"itemSchema":{"하위":{}}}}}`.
    pub fn to_json(&self) -> String {
        let mut keys = serde_json::Map::new();
        for (name, subs) in &self.entries {
            let mut entry = serde_json::Map::new();
            if !subs.is_empty() {
                let schema: serde_json::Map<String, Value> = subs
                    .iter()
                    .map(|s| (s.clone(), Value::Object(Default::default())))
                    .collect();
                entry.insert("itemSchema".into(), Value::Object(schema));
            }
            keys.insert(name.clone(), Value::Object(entry));
        }
        let mut root = serde_json::Map::new();
        root.insert("keys".into(), Value::Object(keys));
        Value::Object(root).to_string()
    }

    /// 키 경로(`이름` 또는 `반복.하위`)를 처음 쓰인 순서로 나열한다.
    pub fn paths(&self) -> Vec<String> {
        let mut out = Vec::new();
        for (name, subs) in &self.entries {
            out.push(name.clone());
            for s in subs {
                out.push(format!("{name}.{s}"));
            }
        }
        out
    }
}

struct Site {
    origin: Option<u32>,
    start: usize,
    text: String,
}

struct Info {
    story: Story,
    idx: i64,
}

struct RawIssue {
    message: String,
    kind: IssueKind,
    name: Option<String>,
    site: Option<Site>,
}

/// 반복 태그 하나. unit은 문단 번호(문단 묶음) 또는 행 번호(표 행), cell·sub는 표 행에서 셀 번호·셀 안 문단 번호.
#[derive(Clone)]
struct Ev {
    open: bool,
    name: String,
    tag: Tag,
    unit: usize,
    seq: usize,
    cell: usize,
    sub: usize,
}

struct Sc<'d> {
    scopes: Vec<&'d Value>,
    stack: Vec<String>,
}

type RowUnit = Vec<Cell>;

/// 한 번의 훑기(collect 또는 fill) 결과.
pub(super) struct Pass {
    pub issues: Vec<TagIssue>,
    pub keys: TagKeys,
    pub sites: HashMap<String, TagLocation>,
    pub filled: BTreeSet<String>,
    pub empty: BTreeSet<String>,
    /// 문서에 손댄 곳이 있는가(없으면 원본을 그대로 둔다).
    pub changed: bool,
    /// 구역마다, 구조가 바뀐 첫 최상위 문단 번호(반복 시작 자리).
    pub first_units: Vec<Option<usize>>,
    /// 구역마다 바뀌었는가.
    pub changed_secs: Vec<bool>,
}

pub(super) struct Engine {
    collect: bool,
    limits: TagLimits,
    issues: Vec<RawIssue>,
    seen: HashSet<String>,
    keys: TagKeys,
    sites: HashMap<String, Site>,
    infos: Vec<Info>,
    story_texts: HashMap<Story, Vec<Vec<char>>>,
    budget: usize,
    bytes: usize,
    cap: usize,
    edits: usize,
    changed: bool,
    allocator: Option<Allocator>,
    filled: BTreeSet<String>,
    empty: BTreeSet<String>,
}

// ---------------------------------------------------------------- 값 읽기

fn empty_scope() -> &'static Value {
    static EMPTY: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    EMPTY.get_or_init(|| Value::Object(Default::default()))
}

/// 현재 항목 -> 바깥 순서로 찾는다. 점 표기는 없다(`.`은 현재 항목 자신).
fn lookup<'d>(scopes: &[&'d Value], tag: &str) -> Option<&'d Value> {
    if tag == "." {
        return scopes.last().copied();
    }
    for s in scopes.iter().rev() {
        if let Value::Object(map) = s {
            if let Some(v) = map.get(tag) {
                return Some(v);
            }
        }
    }
    None
}

/// 글자로 쓸 때의 값: 없으면 빈 글자.
fn as_text(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => {
            // JS의 String(숫자)처럼: 정수로 떨어지는 실수는 소수점 없이
            if let Some(f) = n.as_f64() {
                if !n.is_i64() && !n.is_u64() && f.fract() == 0.0 && f.abs() < 1e21 {
                    return format!("{}", f as i128);
                }
            }
            n.to_string()
        }
        Some(v) => v.to_string(),
    }
}

/// 문서에 쓸 수 없는 제어 문자를 뺀다(줄바꿈·탭은 둔다). 엔진 표지 글자도 뺀다.
fn clean_text(s: &str) -> String {
    s.chars()
        .filter(|c| {
            !matches!(*c, '\u{0}'..='\u{8}' | '\u{B}' | '\u{C}' | '\u{E}'..='\u{1F}' | '\u{FFFE}' | '\u{FFFF}')
                && *c != FILL
        })
        .collect()
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

fn to_items<'d>(v: Option<&'d Value>) -> Vec<&'d Value> {
    match v {
        Some(Value::Array(a)) => a.iter().collect(),
        Some(v) if truthy(v) => vec![v],
        _ => Vec::new(),
    }
}

fn key_path(stack: &[String], name: &str) -> Vec<String> {
    match stack.len() {
        0 => vec![name.to_string()],
        1 => vec![stack[0].clone(), name.to_string()],
        _ => vec![stack[0].clone(), stack[1].clone()],
    }
}

fn unclosed(name: &str) -> String {
    format!("반복이 닫히지 않았습니다: {{{{loop {name}}}}}에 짝이 되는 {{{{endloop}}}}가 없습니다")
}
const UNOPENED: &str = "반복이 열리지 않았습니다: {{endloop}}에 짝이 되는 {{loop}}가 없습니다";

fn count_in(hay: &[char], needle: &[char], until: usize) -> usize {
    if needle.is_empty() || hay.len() < needle.len() {
        return 0;
    }
    let mut n = 0;
    let mut i = 0;
    while i + needle.len() <= hay.len() && i < until {
        if &hay[i..i + needle.len()] == needle {
            n += 1;
            i += needle.len();
        } else {
            i += 1;
        }
    }
    n
}

fn pair_up(evs: Vec<Ev>) -> (Vec<(Ev, Ev)>, Vec<Ev>, Vec<Ev>) {
    let mut stack: Vec<Ev> = Vec::new();
    let mut pairs = Vec::new();
    let mut stray_closes = Vec::new();
    for ev in evs {
        if ev.open {
            stack.push(ev);
            continue;
        }
        match stack.pop() {
            None => stray_closes.push(ev),
            Some(open) => {
                if stack.is_empty() {
                    pairs.push((open, ev));
                }
            }
        }
    }
    (pairs, stack, stray_closes)
}

// ---------------------------------------------------------------- 문단·표 읽기 보조

/// 모든 안쪽 문단(표 셀·글상자·캡션·머리말·각주 등)을 포함해 훑는다.
pub(super) fn visit_paras(paras: &[Paragraph], f: &mut dyn FnMut(&Paragraph)) {
    for p in paras {
        f(p);
        for c in &p.controls {
            match c {
                Control::Table(t) => {
                    for cell in &t.cells {
                        visit_paras(&cell.paragraphs, f);
                    }
                    if let Some(cap) = &t.caption {
                        visit_paras(&cap.paragraphs, f);
                    }
                }
                Control::Shape(s) => visit_shape(s, f),
                Control::Picture(pic) => {
                    if let Some(cap) = &pic.caption {
                        visit_paras(&cap.paragraphs, f);
                    }
                }
                Control::Header(h) => visit_paras(&h.paragraphs, f),
                Control::Footer(h) => visit_paras(&h.paragraphs, f),
                Control::Footnote(h) => visit_paras(&h.paragraphs, f),
                Control::Endnote(h) => visit_paras(&h.paragraphs, f),
                Control::HiddenComment(h) => visit_paras(&h.paragraphs, f),
                _ => {}
            }
        }
    }
}

fn visit_shape(s: &ShapeObject, f: &mut dyn FnMut(&Paragraph)) {
    match s {
        ShapeObject::Group(g) => {
            for child in &g.children {
                visit_shape(child, f);
            }
            if let Some(cap) = &g.caption {
                visit_paras(&cap.paragraphs, f);
            }
        }
        ShapeObject::Picture(p) => {
            if let Some(cap) = &p.caption {
                visit_paras(&cap.paragraphs, f);
            }
        }
        other => {
            if let Some(d) = other.drawing() {
                if let Some(tb) = &d.text_box {
                    visit_paras(&tb.paragraphs, f);
                }
                if let Some(cap) = &d.caption {
                    visit_paras(&cap.paragraphs, f);
                }
            }
        }
    }
}

/// 구역 설정·단 설정이 든 문단이 있는가(반복에 넣으면 구역 설정이 복제된다).
fn has_section_def(paras: &[Paragraph]) -> bool {
    let mut found = false;
    visit_paras(paras, &mut |p| {
        if p.controls
            .iter()
            .any(|c| matches!(c, Control::SectionDef(_) | Control::ColumnDef(_)))
        {
            found = true;
        }
    });
    found
}

/// 컨트롤·탭·줄바꿈 없이 글자만 있는 문단인가.
fn is_pure_text(p: &Paragraph) -> bool {
    p.controls.is_empty() && !p.text.contains(['\t', '\n', '\r'])
}

/// 태그(와 공백·표지)만 있던 문단인가.
fn tag_only(p: &Paragraph) -> bool {
    model(p)
        .chars
        .iter()
        .all(|c| is_obj(*c) || c.is_whitespace())
}

fn row_height(row: &[Cell]) -> u32 {
    row.iter()
        .filter(|c| c.row_span.max(1) == 1)
        .map(|c| c.height)
        .max()
        .unwrap_or(0)
}

/// 행마다 그 행에서 시작하는 셀 수를 다시 센다(`row_sizes`).
fn rebuild_row_sizes(t: &mut Table) {
    let mut counts = vec![0u16; usize::from(t.row_count)];
    for c in &t.cells {
        if let Some(n) = counts.get_mut(usize::from(c.row)) {
            *n += 1;
        }
    }
    t.row_sizes = counts.into_iter().map(|n| n as i16).collect();
}

/// 반복이 비어 문단이 하나도 안 남을 때 채워 둘 빈 문단(셀·머리말은 문단이 하나는 있어야 한다). 첫 문단의 모양을 따른다.
fn blank_paragraph(src: &Paragraph) -> Paragraph {
    let mut p = src.clone();
    for i in (0..p.controls.len()).rev() {
        p.remove_control(i);
    }
    let n = p.text.chars().count();
    if n > 0 {
        p.delete_text_at(0, n);
    }
    p.invalidate_layout_inputs();
    p
}

fn blank(p: &mut Paragraph, tag: &Tag) {
    let m = model(p);
    let n = tag.end - tag.start;
    let filler: String = std::iter::repeat_n(FILL, n).collect();
    edit_range(p, &m, tag.start, tag.end, &filler);
}

// ---------------------------------------------------------------- 엔진

impl Engine {
    pub(super) fn new(collect: bool, limits: TagLimits, allocator: Option<Allocator>) -> Self {
        Self {
            collect,
            limits,
            issues: Vec::new(),
            seen: HashSet::new(),
            keys: TagKeys::default(),
            sites: HashMap::new(),
            infos: Vec::new(),
            story_texts: HashMap::new(),
            budget: limits.max_paras,
            bytes: limits.max_clone_bytes,
            cap: limits.max_clone_bytes,
            edits: 0,
            changed: false,
            allocator,
            filled: BTreeSet::new(),
            empty: BTreeSet::new(),
        }
    }

    // ---- 위치 등록(collect 전용)

    /// 원본 문단마다 (범위, 범위 안 순번)을 매기고 범위별 문단 글자 목록을 만든다. 문단에는 번호표를 달아 복제본도 원본을 찾게 한다.
    /// body는 편집기 검색이 훑는 곳(본문·표 셀·글상자)만 센다. 캡션·숨은 설명·묶음 안 글상자는 세지 않는다(idx -1).
    pub(super) fn register(&mut self, paras: &mut [Paragraph], story: Story, counted: bool) {
        for p in paras {
            let id = self.infos.len() as u32;
            let m = model(p);
            if counted {
                let list = self.story_texts.entry(story).or_default();
                self.infos.push(Info {
                    story,
                    idx: list.len() as i64,
                });
                list.push(m.chars);
            } else {
                self.infos.push(Info { story, idx: -1 });
            }
            p.raw_header_extra = id.to_le_bytes().to_vec();
            for c in &mut p.controls {
                match c {
                    Control::Table(t) => {
                        for cell in &mut t.cells {
                            self.register(&mut cell.paragraphs, story, counted);
                        }
                        if let Some(cap) = t.caption.as_mut() {
                            self.register(
                                &mut cap.paragraphs,
                                story,
                                counted && story != Story::Body,
                            );
                        }
                    }
                    Control::Shape(s) => self.register_shape(s, story, counted, false),
                    Control::Picture(pic) => {
                        if let Some(cap) = pic.caption.as_mut() {
                            self.register(
                                &mut cap.paragraphs,
                                story,
                                counted && story != Story::Body,
                            );
                        }
                    }
                    Control::Header(h) => self.register(&mut h.paragraphs, Story::Header, true),
                    Control::Footer(h) => self.register(&mut h.paragraphs, Story::Footer, true),
                    Control::Footnote(h) => self.register(&mut h.paragraphs, Story::Footnote, true),
                    Control::Endnote(h) => self.register(&mut h.paragraphs, Story::Endnote, true),
                    Control::HiddenComment(h) => {
                        self.register(&mut h.paragraphs, story, counted && story != Story::Body)
                    }
                    _ => {}
                }
            }
        }
    }

    fn register_shape(&mut self, s: &mut ShapeObject, story: Story, counted: bool, in_group: bool) {
        let sub_counted = |owner_ok: bool| {
            if story != Story::Body {
                counted
            } else {
                counted && owner_ok
            }
        };
        match s {
            ShapeObject::Group(g) => {
                for child in &mut g.children {
                    self.register_shape(child, story, counted, true);
                }
                if let Some(cap) = g.caption.as_mut() {
                    self.register(&mut cap.paragraphs, story, sub_counted(false));
                }
            }
            ShapeObject::Picture(p) => {
                if let Some(cap) = p.caption.as_mut() {
                    self.register(&mut cap.paragraphs, story, sub_counted(false));
                }
            }
            other => {
                if let Some(d) = other.drawing_mut() {
                    if let Some(tb) = d.text_box.as_mut() {
                        self.register(&mut tb.paragraphs, story, sub_counted(!in_group));
                    }
                    if let Some(cap) = d.caption.as_mut() {
                        self.register(&mut cap.paragraphs, story, sub_counted(false));
                    }
                }
            }
        }
    }

    // ---- 기록·보고

    fn origin_of(&self, p: &Paragraph) -> Option<u32> {
        if !self.collect {
            return None;
        }
        <[u8; 4]>::try_from(p.raw_header_extra.as_slice())
            .ok()
            .map(u32::from_le_bytes)
    }

    fn site_of(&self, p: &Paragraph, start: usize, text: &str) -> Site {
        Site {
            origin: self.origin_of(p),
            start,
            text: text.to_string(),
        }
    }

    fn record(&mut self, path: Vec<String>, site: Site) {
        if !self.collect {
            return;
        }
        if path.is_empty() {
            return;
        }
        let k = path.join(".");
        self.keys.add(&path);
        self.sites.entry(k).or_insert(site);
    }

    fn report(
        &mut self,
        message: String,
        kind: IssueKind,
        name: Option<String>,
        site: Option<Site>,
    ) {
        if self.issues.len() >= MAX_ISSUES {
            return;
        }
        let info = site
            .as_ref()
            .and_then(|s| s.origin)
            .and_then(|o| self.infos.get(o as usize));
        let key = match (info, &site) {
            (Some(i), Some(s)) => format!("{message}@{}:{}:{}", i.story.as_str(), i.idx, s.start),
            _ => message.clone(),
        };
        if !self.seen.insert(key) {
            return;
        }
        self.issues.push(RawIssue {
            message,
            kind,
            name,
            site,
        });
    }

    fn locate(&self, site: &Site) -> Option<TagLocation> {
        let info = self.infos.get(site.origin? as usize)?;
        let list = self.story_texts.get(&info.story)?;
        let needle: Vec<char> = site.text.chars().collect();
        if info.idx < 0 || needle.len() > TAG_LOCATION_TEXT_MAX || needle.iter().any(|c| is_obj(*c))
        {
            return None;
        }
        let idx = info.idx as usize;
        let mut occurrence = 1;
        let mut total = 0;
        for (k, hay) in list.iter().enumerate() {
            let c = count_in(hay, &needle, usize::MAX);
            if k < idx {
                occurrence += c;
            } else if k == idx {
                occurrence += count_in(hay, &needle, site.start);
            }
            total += c;
        }
        Some(TagLocation {
            story: info.story,
            text: site.text.clone(),
            occurrence,
            total,
        })
    }

    /// 모은 오류에 위치를 달아 돌려준다(앞쪽 MAX_LOCATED_ISSUES개까지).
    fn issues_of(&self) -> Vec<TagIssue> {
        let mut located = 0;
        self.issues
            .iter()
            .map(|r| {
                let mut location = None;
                if let Some(site) = &r.site {
                    if located < MAX_LOCATED_ISSUES {
                        location = self.locate(site);
                        if location.is_some() {
                            located += 1;
                        }
                    }
                }
                TagIssue {
                    message: r.message.clone(),
                    kind: r.kind,
                    name: r.name.clone(),
                    location,
                }
            })
            .collect()
    }

    pub(super) fn finish(self, first_units: Vec<Option<usize>>, changed_secs: Vec<bool>) -> Pass {
        let issues = self.issues_of();
        let mut sites = HashMap::new();
        let mut n = 0;
        for path in self.keys.paths() {
            if let Some(site) = self.sites.get(&path) {
                n += 1;
                if n > MAX_LOCATIONS {
                    break;
                }
                if let Some(loc) = self.locate(site) {
                    sites.insert(path, loc);
                }
            }
        }
        Pass {
            issues,
            keys: self.keys,
            sites,
            filled: self.filled,
            empty: self.empty,
            changed: self.changed,
            first_units,
            changed_secs,
        }
    }

    // ---- 한도

    fn too_many(&self) -> TagFillError {
        TagFillError::Limit(format!(
            "문단이 너무 많아집니다 (반복으로 새로 만드는 문단은 문서 전체에서 최대 {}개)",
            self.limits.max_paras
        ))
    }

    fn too_big(&self) -> TagFillError {
        TagFillError::Limit(format!(
            "반복으로 만들어지는 내용이 너무 큽니다 (복제·채우기로 늘어나는 구조는 문서 전체에서 최대 {}MiB, --max-clone-bytes로 바꿀 수 있습니다)",
            self.cap / 1024 / 1024
        ))
    }

    /// 복제할 묶음이 가진 문단 수만큼 예산을 쓴다.
    fn spend(&mut self, paras: &[Paragraph]) -> Res<()> {
        if self.collect {
            return Ok(());
        }
        let mut n = 0usize;
        visit_paras(paras, &mut |_| n += 1);
        self.budget = self.budget.checked_sub(n).ok_or_else(|| self.too_many())?;
        Ok(())
    }

    /// 복제하기 전에 (묶음 크기 × 반복 수)와 값 길이 추정치가 남은 예산을 넘는지 보고, 넘으면 복제를 시작하지 않고 거절한다.
    fn spend_bytes<T: serde::Serialize + ?Sized>(
        &mut self,
        els: &T,
        paras: &[Paragraph],
        count: usize,
        items: &[&Value],
    ) -> Res<()> {
        if self.collect || count == 0 {
            return Ok(());
        }
        let one =
            crate::model::owned_work::measure(els, self.bytes, 0).map_err(|_| self.too_big())?;
        let need = one.checked_mul(count).ok_or_else(|| self.too_big())?;
        let mut tags = 0usize;
        visit_paras(paras, &mut |p| tags += p.text.matches("{{").count());
        if need.saturating_add(value_estimate(items, tags, self.cap)) > self.bytes {
            return Err(self.too_big());
        }
        self.bytes -= need;
        Ok(())
    }

    fn loop_items<'d>(&self, sc: &Sc<'d>, name: &str) -> Res<Vec<&'d Value>> {
        if self.collect {
            return Ok(vec![empty_scope()]);
        }
        let items = to_items(lookup(&sc.scopes, name));
        if items.len() > self.limits.max_loop_items {
            return Err(TagFillError::Limit(format!(
                "반복 항목이 너무 많습니다: {name} {}개 (최대 {}개)",
                items.len(),
                self.limits.max_loop_items
            )));
        }
        Ok(items)
    }

    /// 복제한 개체(표·그림·도형)의 번호가 겹치지 않게 새로 매긴다.
    fn fresh_ids(&mut self, paras: &mut [Paragraph]) -> Res<()> {
        if self.collect {
            return Ok(());
        }
        let alloc = self
            .allocator
            .as_mut()
            .ok_or_else(|| TagFillError::Document("개체 번호 할당기가 없습니다".into()))?;
        reidentify_with_allocator(paras, alloc).map_err(|e| TagFillError::Document(e.to_string()))
    }

    // ---- 문단 묶음

    /// 문단 목록에서 반복을 펼치고 키를 채운다. 결과는 `tpl`에 돌려놓는다.
    /// 반환: 반복이 있으면 (첫 반복 시작 문단 번호, 목록이 비었을 때 쓸 첫 문단 사본).
    fn render_paras<'d>(
        &mut self,
        tpl: &mut Vec<Paragraph>,
        sc: &Sc<'d>,
    ) -> Res<Option<(usize, Paragraph)>> {
        if tpl.is_empty() {
            return Ok(None);
        }
        let mut evs = Vec::new();
        let mut seq = 0;
        for (unit, p) in tpl.iter().enumerate() {
            for tag in scan(&model(p).chars).0 {
                if tag.kind != TagKind::Key {
                    evs.push(Ev {
                        open: tag.kind == TagKind::Open,
                        name: tag.name.clone(),
                        tag,
                        unit,
                        seq,
                        cell: 0,
                        sub: 0,
                    });
                    seq += 1;
                }
            }
        }
        let (pairs, stray_opens, stray_closes) = pair_up(evs);
        for ev in stray_opens.into_iter().chain(stray_closes) {
            let site = self.site_of(&tpl[ev.unit], ev.tag.start, &ev.tag.text);
            self.report_stray(&ev, site);
            blank(&mut tpl[ev.unit], &ev.tag);
        }
        let mut ranges: Vec<(Ev, Ev)> = Vec::new();
        let mut last_close: isize = -1;
        for (open, close) in pairs {
            let message = if open.unit == close.unit {
                Some(format!(
                    "한 문단 안에서 열고 닫는 반복은 지원하지 않습니다: {{{{loop {}}}}}와 {{{{endloop}}}}를 서로 다른 문단에 두세요",
                    open.name
                ))
            } else if open.unit as isize <= last_close {
                Some(format!(
                    "한 문단에서 반복이 끝나고 다음 반복이 시작될 수 없습니다: {{{{loop {}}}}}는 앞 반복의 {{{{endloop}}}}와 다른 문단에 두세요",
                    open.name
                ))
            } else {
                None
            };
            match message {
                Some(message) => {
                    let site = self.site_of(&tpl[open.unit], open.tag.start, &open.tag.text);
                    self.report(
                        message,
                        IssueKind::Other,
                        Some(open.name.clone()),
                        Some(site),
                    );
                    blank(&mut tpl[open.unit], &open.tag);
                    blank(&mut tpl[close.unit], &close.tag);
                }
                None => {
                    last_close = close.unit as isize;
                    ranges.push((open, close));
                }
            }
        }
        let first = ranges.first().map(|r| r.0.unit);
        let proto = first.map(|_| tpl[0].clone());
        let mut out: Vec<Paragraph> = Vec::with_capacity(tpl.len());
        let mut next = 0usize;
        for (open, close) in &ranges {
            for i in next..open.unit {
                let mut p = std::mem::take(&mut tpl[i]);
                self.render_paragraph(&mut p, sc)?;
                out.push(p);
            }
            self.expand_paras(tpl, open, close, sc, &mut out)?;
            next = close.unit + 1;
        }
        for i in next..tpl.len() {
            let mut p = std::mem::take(&mut tpl[i]);
            self.render_paragraph(&mut p, sc)?;
            out.push(p);
        }
        *tpl = out;
        Ok(first.zip(proto))
    }

    fn report_stray(&mut self, ev: &Ev, site: Site) {
        if ev.open {
            self.report(
                unclosed(&ev.name),
                IssueKind::UnclosedLoop,
                Some(ev.name.clone()),
                Some(site),
            );
        } else {
            self.report(
                UNOPENED.to_string(),
                IssueKind::UnopenedLoop,
                None,
                Some(site),
            );
        }
    }

    fn expand_paras<'d>(
        &mut self,
        tpl: &[Paragraph],
        open: &Ev,
        close: &Ev,
        sc: &Sc<'d>,
        out: &mut Vec<Paragraph>,
    ) -> Res<()> {
        let slice = &tpl[open.unit..=close.unit];
        let site = self.site_of(&tpl[open.unit], open.tag.start, &open.tag.text);
        self.record(key_path(&sc.stack, &open.name), site);
        if has_section_def(slice) {
            let site = self.site_of(&tpl[open.unit], open.tag.start, &open.tag.text);
            self.report(
                format!(
                    "구역 설정이 든 문단은 반복에 넣을 수 없습니다: {{{{loop {}}}}}를 문서 첫 문단 뒤로 옮기세요",
                    open.name
                ),
                IssueKind::Other,
                Some(open.name.clone()),
                Some(site),
            );
            return Ok(());
        }
        let items = self.loop_items(sc, &open.name)?;
        self.spend_bytes(slice, slice, items.len(), &items)?;
        for item in &items {
            self.spend(slice)?;
            let mut clones: Vec<Paragraph> = slice.to_vec();
            let last = clones.len() - 1;
            blank(&mut clones[0], &open.tag);
            blank(&mut clones[last], &close.tag);
            // 태그만 있던 문단은 남기지 않는다
            let mut kept: Vec<Paragraph> = clones
                .into_iter()
                .enumerate()
                .filter(|(i, c)| !((*i == 0 || *i == last) && is_pure_text(c) && tag_only(c)))
                .map(|(_, c)| c)
                .collect();
            self.fresh_ids(&mut kept)?;
            let mut scopes = sc.scopes.clone();
            scopes.push(item);
            let mut stack = sc.stack.clone();
            stack.push(open.name.clone());
            let sc2 = Sc { scopes, stack };
            self.render_paras(&mut kept, &sc2)?;
            out.append(&mut kept);
        }
        if !items.is_empty() || !self.collect {
            self.changed = true;
        }
        Ok(())
    }

    /// 문단 하나의 키를 채우고, 안쪽의 표·머리말·글상자도 처리한다.
    fn render_paragraph<'d>(&mut self, p: &mut Paragraph, sc: &Sc<'d>) -> Res<()> {
        let m = model(p);
        let has_fill = m.chars.contains(&FILL);
        if m.chars.contains(&'{') || m.chars.contains(&'}') || has_fill {
            let (tags, problems) = scan(&m.chars);
            for pr in problems {
                let site = self.site_of(p, pr.start, &pr.text);
                self.report(pr.message, pr.kind, None, Some(site));
            }
            for t in &tags {
                if t.kind == TagKind::Key {
                    let site = self.site_of(p, t.start, &t.text);
                    self.record(key_path(&sc.stack, &t.name), site);
                }
            }
            if !self.collect {
                // 뒤에서부터 바꿔야 앞 태그의 위치가 그대로다
                for t in tags.iter().rev() {
                    let value = if t.kind == TagKind::Key {
                        let found = lookup(&sc.scopes, &t.name);
                        let label = key_path(&sc.stack, &t.name).join(".");
                        if matches!(found, None | Some(Value::Null)) {
                            self.empty.insert(label);
                        } else {
                            self.filled.insert(label);
                        }
                        let v = clean_text(&as_text(found));
                        crate::model::paragraph::normalize_text_newlines(&v).into_owned()
                    } else {
                        String::new()
                    };
                    // 값이 커서 문서가 부풀어도 같은 예산에서 막는다
                    self.bytes = self
                        .bytes
                        .checked_sub(value.len())
                        .ok_or_else(|| self.too_big())?;
                    edit_range(p, &m, t.start, t.end, &value);
                    self.changed = true;
                }
                strip_fill(p);
                if has_fill {
                    self.changed = true;
                }
            }
        }
        let before = self.edits;
        self.nested(p, sc)?;
        if self.edits != before {
            // 안쪽 표·문단이 늘거나 줄었으면 바깥 문단의 줄 배치도 낡았다
            p.invalidate_layout_inputs();
        }
        Ok(())
    }

    /// 문단 안쪽의 표와 문단 묶음(머리말·꼬리말·각주·미주·글상자·캡션·숨은 설명).
    fn nested<'d>(&mut self, p: &mut Paragraph, sc: &Sc<'d>) -> Res<()> {
        let mut remove = Vec::new();
        for ci in 0..p.controls.len() {
            match &mut p.controls[ci] {
                Control::Table(t) => {
                    if let Some(cap) = t.caption.as_mut() {
                        self.container(&mut cap.paragraphs, sc)?;
                    }
                    if self.table(t, sc)? {
                        remove.push(ci);
                    }
                }
                Control::Shape(s) => self.shape(s, sc)?,
                Control::Picture(pic) => {
                    if let Some(cap) = pic.caption.as_mut() {
                        self.container(&mut cap.paragraphs, sc)?;
                    }
                }
                Control::Header(h) => {
                    self.container(&mut h.paragraphs, sc)?;
                }
                Control::Footer(h) => {
                    self.container(&mut h.paragraphs, sc)?;
                }
                Control::Footnote(h) => {
                    self.container(&mut h.paragraphs, sc)?;
                }
                Control::Endnote(h) => {
                    self.container(&mut h.paragraphs, sc)?;
                }
                Control::HiddenComment(h) => {
                    self.container(&mut h.paragraphs, sc)?;
                }
                _ => {}
            }
        }
        for ci in remove.into_iter().rev() {
            // 행이 하나도 안 남은 표는 지운다
            p.remove_control(ci);
            self.edits += 1;
            self.changed = true;
        }
        Ok(())
    }

    fn shape<'d>(&mut self, s: &mut ShapeObject, sc: &Sc<'d>) -> Res<()> {
        match s {
            ShapeObject::Group(g) => {
                for child in &mut g.children {
                    self.shape(child, sc)?;
                }
                if let Some(cap) = g.caption.as_mut() {
                    self.container(&mut cap.paragraphs, sc)?;
                }
            }
            ShapeObject::Picture(p) => {
                if let Some(cap) = p.caption.as_mut() {
                    self.container(&mut cap.paragraphs, sc)?;
                }
            }
            other => {
                if let Some(d) = other.drawing_mut() {
                    if let Some(tb) = d.text_box.as_mut() {
                        self.container(&mut tb.paragraphs, sc)?;
                    }
                    if let Some(cap) = d.caption.as_mut() {
                        self.container(&mut cap.paragraphs, sc)?;
                    }
                }
            }
        }
        Ok(())
    }

    /// 문단을 직접 담는 곳(본문·셀·글상자·머리말 등). 반복으로 문단이 늘거나 줄면 목록을 바꿔 끼운다.
    /// 반환: 구조를 바꾸는 반복이 있으면 첫 반복 시작 문단 번호.
    fn container<'d>(&mut self, paras: &mut Vec<Paragraph>, sc: &Sc<'d>) -> Res<Option<usize>> {
        let Some((first, proto)) = self.render_paras(paras, sc)? else {
            return Ok(None);
        };
        self.edits += 1;
        if paras.is_empty() {
            paras.push(blank_paragraph(&proto));
        }
        Ok(Some(first))
    }

    // ---- 표 행

    /// 표의 행 반복을 처리한다. 반환 true면 행이 하나도 안 남아 표를 지워야 한다.
    fn table<'d>(&mut self, t: &mut Table, sc: &Sc<'d>) -> Res<bool> {
        let rc = usize::from(t.row_count);
        if rc == 0 || t.cells.iter().any(|c| usize::from(c.row) >= rc) {
            // 구조가 올바르지 않은 표: 행 반복 없이 셀 안 글자만 채운다
            for cell in &mut t.cells {
                self.container(&mut cell.paragraphs, sc)?;
            }
            return Ok(false);
        }
        let was_sorted = t.cells.windows(2).all(|w| w[0].row <= w[1].row);
        t.cells.sort_by_key(|c| c.row);
        let mut rows: Vec<RowUnit> = vec![Vec::new(); rc];
        for c in std::mem::take(&mut t.cells) {
            rows[usize::from(c.row)].push(c);
        }
        let old_height: u32 = rows.iter().map(|r| row_height(r)).sum();
        let old_rows = rows.len();
        let mut passed: Vec<Option<usize>> = Vec::new();
        let (out, changed) = self.render_rows(rows, sc, Some(&mut passed))?;
        if !changed {
            t.cells = out.into_iter().flatten().collect();
            if !was_sorted {
                t.rebuild_grid();
            }
            return Ok(false);
        }
        self.edits += 1;
        self.changed = true;
        let new_rows = out.len();
        if new_rows == 0 {
            return Ok(true);
        }
        if new_rows > usize::from(u16::MAX) {
            return Err(TagFillError::Limit(format!(
                "표 행이 너무 많아집니다: {new_rows}행 (최대 {}행)",
                u16::MAX
            )));
        }
        let new_height: u32 = out.iter().map(|r| row_height(r)).sum();
        // 행 번호·행 수·높이를 새 행 수에 맞춘다
        let mut to_new: HashMap<u16, u16> = HashMap::new();
        for (k, old) in passed.iter().enumerate() {
            if let Some(old) = old {
                to_new.insert(*old as u16, k as u16);
            }
        }
        t.cells = out
            .into_iter()
            .enumerate()
            .flat_map(|(k, row)| {
                row.into_iter().map(move |mut c| {
                    c.row = k as u16;
                    c
                })
            })
            .collect();
        t.row_count = new_rows as u16;
        rebuild_row_sizes(t);
        // 셀 영역은 반복 밖의 행만 새 번호로 옮기고, 반복 행에 닿는 영역은 지운다
        t.zones.retain_mut(|z| {
            let (s, e) = (z.start_row, z.end_row);
            match (to_new.get(&s), to_new.get(&e)) {
                (Some(ns), Some(ne)) if ne.wrapping_sub(*ns) == e.wrapping_sub(s) => {
                    z.start_row = *ns;
                    z.end_row = *ne;
                    true
                }
                _ => false,
            }
        });
        let height = (u64::from(t.common.height) + u64::from(new_height))
            .saturating_sub(u64::from(old_height))
            .min(u64::from(u32::MAX)) as u32;
        let _ = old_rows;
        t.sync_ctrl_height(height);
        t.rebuild_grid();
        Ok(false)
    }

    /// 행 목록에서 반복을 펼치고 키를 채운 행 목록을 돌려준다(반복이 있었는지도).
    fn render_rows<'d>(
        &mut self,
        mut rows: Vec<RowUnit>,
        sc: &Sc<'d>,
        mut passed: Option<&mut Vec<Option<usize>>>,
    ) -> Res<(Vec<RowUnit>, bool)> {
        // 셀 안에서 짝이 맞은 반복은 문단 묶음이 처리한다. 셀 안에서 짝이 안 맞은 태그만 행 순서로 모아 셀끼리 짝짓는다.
        let mut evs = Vec::new();
        let mut seq = 0;
        for (r, row) in rows.iter().enumerate() {
            for (c, cell) in row.iter().enumerate() {
                let mut cell_evs = Vec::new();
                for (k, p) in cell.paragraphs.iter().enumerate() {
                    for tag in scan(&model(p).chars).0 {
                        if tag.kind != TagKind::Key {
                            cell_evs.push(Ev {
                                open: tag.kind == TagKind::Open,
                                name: tag.name.clone(),
                                tag,
                                unit: r,
                                seq,
                                cell: c,
                                sub: k,
                            });
                            seq += 1;
                        }
                    }
                }
                let (_, so, sc_) = pair_up(cell_evs);
                let mut strays: Vec<Ev> = sc_.into_iter().chain(so).collect();
                strays.sort_by_key(|e| e.seq);
                evs.extend(strays);
            }
        }
        let (pairs, stray_opens, stray_closes) = pair_up(evs);
        for ev in stray_opens.into_iter().chain(stray_closes) {
            let p = &mut rows[ev.unit][ev.cell].paragraphs[ev.sub];
            let site = self.site_of(p, ev.tag.start, &ev.tag.text);
            self.report_stray(&ev, site);
            blank(&mut rows[ev.unit][ev.cell].paragraphs[ev.sub], &ev.tag);
        }
        let mut ranges: Vec<(Ev, Ev)> = Vec::new();
        let mut last_close: isize = -1;
        for (open, close) in pairs {
            let (r1, r2) = (open.unit, close.unit);
            let site = {
                let p = &rows[open.unit][open.cell].paragraphs[open.sub];
                self.site_of(p, open.tag.start, &open.tag.text)
            };
            // 세로 병합 셀이 반복 행 범위에 걸쳐 있으면(범위 밖에서 들어오거나 밖으로 나가면) 행을 복제할 수 없다
            let crossing = rows.iter().enumerate().any(|(r, row)| {
                row.iter().any(|c| {
                    let end = r + usize::from(c.row_span.max(1)) - 1;
                    r <= r2 && end >= r1 && !(r >= r1 && end <= r2)
                })
            });
            let message = if r1 as isize <= last_close {
                Some(format!(
                    "한 행에서 반복이 겹칩니다: {{{{loop {}}}}}가 앞 반복과 같은 행에 있습니다",
                    open.name
                ))
            } else if crossing {
                Some(format!(
                    "세로로 병합된 셀이 반복 행에 걸쳐 있어 반복할 수 없습니다: {{{{loop {}}}}}",
                    open.name
                ))
            } else {
                None
            };
            match message {
                Some(message) => {
                    self.report(
                        message,
                        IssueKind::Other,
                        Some(open.name.clone()),
                        Some(site),
                    );
                    blank(
                        &mut rows[open.unit][open.cell].paragraphs[open.sub],
                        &open.tag,
                    );
                    blank(
                        &mut rows[close.unit][close.cell].paragraphs[close.sub],
                        &close.tag,
                    );
                }
                None => {
                    last_close = r2 as isize;
                    ranges.push((open, close));
                }
            }
        }

        let changed = !ranges.is_empty();
        let mut out: Vec<RowUnit> = Vec::with_capacity(rows.len());
        let mut next = 0usize;
        for (open, close) in &ranges {
            self.leaf_rows(&mut rows, next, open.unit, sc, &mut out, &mut passed)?;
            let site = {
                let p = &rows[open.unit][open.cell].paragraphs[open.sub];
                self.site_of(p, open.tag.start, &open.tag.text)
            };
            self.record(key_path(&sc.stack, &open.name), site);
            let slice: Vec<RowUnit> = rows[open.unit..=close.unit].to_vec();
            let items = self.loop_items(sc, &open.name)?;
            let flat_paras: Vec<Paragraph> = slice
                .iter()
                .flatten()
                .flat_map(|c| c.paragraphs.iter().cloned())
                .collect();
            self.spend_bytes(&slice, &flat_paras, items.len(), &items)?;
            drop(flat_paras);
            for item in &items {
                if !self.collect {
                    let mut n = 0usize;
                    for row in &slice {
                        for c in row {
                            visit_paras(&c.paragraphs, &mut |_| n += 1);
                        }
                    }
                    self.budget = self.budget.checked_sub(n).ok_or_else(|| self.too_many())?;
                }
                let mut clones: Vec<RowUnit> = slice.clone();
                let last = clones.len() - 1;
                blank(&mut clones[0][open.cell].paragraphs[open.sub], &open.tag);
                blank(
                    &mut clones[last][close.cell].paragraphs[close.sub],
                    &close.tag,
                );
                for row in &mut clones {
                    for c in row {
                        self.fresh_ids(&mut c.paragraphs)?;
                    }
                }
                let mut scopes = sc.scopes.clone();
                scopes.push(item);
                let mut stack = sc.stack.clone();
                stack.push(open.name.clone());
                let sc2 = Sc { scopes, stack };
                let (done, _) = self.render_rows(clones, &sc2, None)?;
                for row in done {
                    out.push(row);
                    if let Some(p) = passed.as_deref_mut() {
                        p.push(None);
                    }
                }
            }
            next = close.unit + 1;
        }
        let len = rows.len();
        self.leaf_rows(&mut rows, next, len, sc, &mut out, &mut passed)?;
        Ok((out, changed))
    }

    /// 반복에 들지 않은 행의 셀 안 문단 묶음을 처리하고 결과 행 목록에 옮긴다.
    fn leaf_rows<'d>(
        &mut self,
        rows: &mut [RowUnit],
        from: usize,
        to: usize,
        sc: &Sc<'d>,
        out: &mut Vec<RowUnit>,
        passed: &mut Option<&mut Vec<Option<usize>>>,
    ) -> Res<()> {
        for r in from..to {
            let mut row = std::mem::take(&mut rows[r]);
            for cell in &mut row {
                self.container(&mut cell.paragraphs, sc)?;
            }
            if let Some(p) = passed.as_deref_mut() {
                p.push(Some(r));
            }
            out.push(row);
        }
        Ok(())
    }

    // ---- 구역 단위

    /// 구역 본문 한 곳을 처리한다. 반환: 구조를 바꾸는 반복이 있으면 첫 반복 시작 문단 번호.
    pub(super) fn run_section(
        &mut self,
        paras: &mut Vec<Paragraph>,
        data: &Value,
    ) -> Res<Option<usize>> {
        let sc = Sc {
            scopes: vec![data],
            stack: Vec::new(),
        };
        self.container(paras, &sc)
    }
}

/// 항목 하나가 묶음 안 태그로 들어갈 글자 수 추정: 태그 수 × 항목 값(문자열·숫자) 평균 길이. 정확하지 않아도 예산을 넘길 입력을 복제 전에 알아채는 용도다.
fn value_estimate(items: &[&Value], tags: usize, cap: usize) -> usize {
    if tags == 0 {
        return 0;
    }
    let mut total = 0f64;
    for it in items {
        match it {
            Value::Object(map) => {
                let (mut sum, mut n) = (0usize, 0usize);
                for v in map.values() {
                    match v {
                        Value::String(s) => {
                            sum += s.chars().count();
                            n += 1;
                        }
                        Value::Number(num) => {
                            sum += num.to_string().len();
                            n += 1;
                        }
                        _ => {}
                    }
                    if n >= 200 {
                        break;
                    }
                }
                if n > 0 {
                    total += tags as f64 * (sum as f64 / n as f64);
                }
            }
            other => total += (tags * as_text(Some(other)).chars().count()) as f64,
        }
        if total > cap as f64 * 4.0 {
            break; // 이미 넘는 것이 확실하다
        }
    }
    total as usize
}

// ---------------------------------------------------------------- 문서 단위 진입점

use crate::document_core::DocumentCore;

/// `--keys` 결과: 키 모양, 키 위치, 문법 오류.
pub struct TagScan {
    pub keys: TagKeys,
    pub locations: Vec<(String, TagLocation)>,
    pub issues: Vec<TagIssue>,
}

/// 채우기 결과.
#[derive(Debug)]
pub struct TagFillReport {
    pub filled: Vec<String>,
    pub empty: Vec<String>,
    pub changed: bool,
}

fn master_page_issues(doc: &DocumentCore) -> Vec<TagIssue> {
    let mut out = Vec::new();
    for s in &doc.document.sections {
        for m in &s.section_def.master_pages {
            visit_paras(&m.paragraphs, &mut |p| {
                if p.text.contains("{{") || p.text.contains("}}") {
                    out.push(TagIssue {
                        message: "바탕쪽의 태그는 지원하지 않습니다: 본문·머리말·꼬리말로 옮기세요"
                            .into(),
                        kind: IssueKind::Other,
                        name: None,
                        location: None,
                    });
                }
            });
        }
    }
    out.truncate(MAX_LOCATED_ISSUES);
    out
}

impl DocumentCore {
    /// 구역 본문을 복제해 엔진을 돌린다. 문서는 바꾸지 않는다.
    fn run_tags(
        &self,
        data: &Value,
        collect: bool,
        limits: TagLimits,
    ) -> Res<(Pass, Vec<Vec<Paragraph>>)> {
        let allocator = if collect {
            None
        } else {
            Some(Allocator {
                used: crate::model::identity::used_instance_ids(&self.document),
                next: 1,
            })
        };
        let mut engine = Engine::new(collect, limits, allocator);
        let mut secs: Vec<Vec<Paragraph>> = self
            .document
            .sections
            .iter()
            .map(|s| s.paragraphs.clone())
            .collect();
        if collect {
            for paras in &mut secs {
                engine.register(paras, Story::Body, true);
            }
        }
        let mut firsts = Vec::with_capacity(secs.len());
        let mut changed_secs = Vec::with_capacity(secs.len());
        for paras in &mut secs {
            let before = engine.changed;
            engine.changed = false;
            firsts.push(engine.run_section(paras, data)?);
            changed_secs.push(engine.changed);
            engine.changed |= before;
        }
        Ok((engine.finish(firsts, changed_secs), secs))
    }

    /// 템플릿 키·위치·문법 오류를 모은다. 문서는 바뀌지 않는다.
    pub fn scan_template_tags(&self, limits: TagLimits) -> Res<TagScan> {
        let (pass, _) = self.run_tags(&Value::Null, true, limits)?;
        let mut issues = pass.issues;
        issues.extend(master_page_issues(self));
        let mut locations: Vec<(String, TagLocation)> = Vec::new();
        for path in pass.keys.paths() {
            if let Some(loc) = pass.sites.get(&path) {
                locations.push((path, loc.clone()));
            }
        }
        Ok(TagScan {
            keys: pass.keys,
            locations,
            issues,
        })
    }

    /// 데이터로 `{{...}}`를 채운다. 문법 오류·한도 초과면 문서는 그대로 두고 Err.
    /// 쪽 나누기는 하지 않는다. 같은 인스턴스에서 쪽 정보를 읽을 호출자는 `repaginate_if_needed()`를 부른다.
    pub fn fill_template_tags(&mut self, data: &Value, limits: TagLimits) -> Res<TagFillReport> {
        let (check, _) = self.run_tags(&Value::Null, true, limits)?;
        let mut issues = check.issues;
        issues.extend(master_page_issues(self));
        if !issues.is_empty() {
            return Err(TagFillError::Syntax(issues));
        }
        let (pass, secs) = self.run_tags(data, false, limits)?;
        if !pass.changed {
            return Ok(TagFillReport {
                filled: Vec::new(),
                empty: Vec::new(),
                changed: false,
            });
        }
        // 여기부터는 실패하지 않는다: 구역마다 본문을 바꿔 끼우고 줄 배치를 다시 짠다.
        let mut touched = Vec::new();
        for (si, (paras, first)) in secs.into_iter().zip(&pass.first_units).enumerate() {
            if !pass.changed_secs[si] && first.is_none() {
                continue;
            }
            self.document.sections[si].paragraphs = paras;
            self.document.sections[si].raw_stream = None;
            touched.push((si, *first));
        }
        for (si, first) in touched {
            self.recompose_section(si);
            let mut start = first.unwrap_or(usize::MAX);
            let n = self.document.sections[si].paragraphs.len();
            for pi in 0..n {
                let p = &self.document.sections[si].paragraphs[pi];
                if p.line_segs.is_empty() && !p.text.is_empty() {
                    self.reflow_paragraph(si, pi);
                    start = start.min(pi);
                }
            }
            if start < n {
                let hwp3_layout = self.document.layout_profile().hwp3_layout();
                crate::renderer::composer::recalculate_section_vpos(
                    &mut self.document.sections[si].paragraphs,
                    start,
                    None,
                    None,
                    &self.styles,
                    self.dpi,
                    hwp3_layout,
                );
            }
            // 쪽 나누기는 하지 않는다: 이 함수는 저장 직전의 무상태 CLI만 부르고, 표 행이 수천 개면 쪽 나누기가 제곱으로 느리다.
            self.recompose_section(si);
        }
        Ok(TagFillReport {
            filled: pass.filled.into_iter().collect(),
            empty: pass.empty.into_iter().collect(),
            changed: true,
        })
    }
}
