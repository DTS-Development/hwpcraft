//! `{{key}}` / `{{loop 이름}}…{{endloop}}` 태그 해석. HWPX 구현(dts-craft `oss-hwpx.ts`)의 `scan`과 같은 규칙이다.
//!
//! 문단 글자는 "스캔 글자열"로 바꿔 읽는다. 컨트롤(표·그림·필드·구역 정의 등)과 탭·줄바꿈이 있던 자리는
//! `PH` 한 글자, 반복 태그를 지운 자리는 `FILL`(위치가 밀리지 않게 같은 길이로 채운다)이다.
//! 스캔 글자열의 위치를 문단 글자 위치로 되돌리는 표(`Model::map`)도 함께 만든다.
use crate::model::paragraph::Paragraph;

/// 글자가 아닌 개체(컨트롤·탭·줄바꿈)가 있던 자리. 문단 글자에는 나오지 않고 스캔 글자열에만 있다.
pub(super) const PH: char = '\u{1}';
/// 지운 반복 태그 자리. 문단 글자에 잠시 들어갔다가 문단을 마무리할 때 빠진다(사용자 데이터에서는 걸러 낸다).
pub(super) const FILL: char = '\u{E002}';

pub(super) const RAW_XML_MESSAGE: &str =
    "지원하지 않는 구문입니다: {{@...}}(원본 XML 삽입)은 사용할 수 없습니다";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum IssueKind {
    UnclosedLoop,
    UnopenedLoop,
    UnclosedTag,
    UnopenedTag,
    RawXml,
    Other,
}

impl IssueKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UnclosedLoop => "unclosed_loop",
            Self::UnopenedLoop => "unopened_loop",
            Self::UnclosedTag => "unclosed_tag",
            Self::UnopenedTag => "unopened_tag",
            Self::RawXml => "raw_xml",
            Self::Other => "other",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TagKind {
    Key,
    Open,
    Close,
}

#[derive(Clone, Debug)]
pub(super) struct Tag {
    pub start: usize,
    pub end: usize,
    pub text: String,
    pub kind: TagKind,
    pub name: String,
}

#[derive(Clone, Debug)]
pub(super) struct Problem {
    pub message: String,
    pub kind: IssueKind,
    pub start: usize,
    pub text: String,
}

pub(super) fn is_obj(c: char) -> bool {
    c == PH || c == FILL
}

/// 개체·지운 자리가 없는 앞 덩어리만(편집기 글자에는 이 문자가 없어 찾을 수 없다).
pub(super) fn plain_head(t: &[char]) -> String {
    t.iter().take_while(|c| !is_obj(**c)).collect()
}

/// 개체·지운 자리가 없는 뒤 덩어리만.
fn plain_tail(t: &[char]) -> String {
    let start = t.iter().rposition(|c| is_obj(*c)).map_or(0, |i| i + 1);
    t[start..].iter().collect()
}

/// `c` 두 글자가 이어진 첫 위치(`from` 이상). `{{{`처럼 겹쳐도 앞쪽을 돌려준다.
fn find_pair(text: &[char], c: char, from: usize) -> Option<usize> {
    let mut i = from;
    while i + 1 < text.len() {
        if text[i] == c && text[i + 1] == c {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// 문단 글자에서 `{{...}}`를 찾는다. 짝이 안 맞는 구분자는 문제(problems)로 쌓는다.
pub(super) fn scan(text: &[char]) -> (Vec<Tag>, Vec<Problem>) {
    let mut tags = Vec::new();
    let mut problems = Vec::new();
    let mut i = 0usize;
    while i < text.len() {
        let s = find_pair(text, '{', i);
        let e = find_pair(text, '}', i);
        if let Some(e) = e {
            if s.is_none_or(|s| e < s) {
                let from = i.max(e.saturating_sub(20));
                let head = plain_tail(&text[from..e]);
                let len = head.chars().count();
                problems.push(Problem {
                    message: format!("여는 기호가 없는 태그입니다: {head}}}}}"),
                    kind: IssueKind::UnopenedTag,
                    start: e - len,
                    text: format!("{head}}}}}"),
                });
                i = e + 2;
                continue;
            }
        }
        let Some(s) = s else { break };
        let Some(close) = find_pair(text, '}', s + 2) else {
            let t40 = plain_head(&text[s..(s + 40).min(text.len())]);
            problems.push(Problem {
                message: format!("닫는 기호가 없는 태그입니다: {t40}"),
                kind: IssueKind::UnclosedTag,
                start: s,
                text: t40,
            });
            break;
        };
        let inner = &text[s + 2..close];
        if let Some(nested) = find_pair(inner, '{', 0) {
            // `{{a{{b}}`: 앞의 `{{`는 짝이 없다
            let tn = plain_head(&text[s..s + 2 + nested]);
            problems.push(Problem {
                message: format!("닫는 기호가 없는 태그입니다: {tn}"),
                kind: IssueKind::UnclosedTag,
                start: s,
                text: tn,
            });
            i = s + 2 + nested;
            continue;
        }
        let full: String = text[s..close + 2].iter().collect();
        i = close + 2;
        if inner.contains(&PH) {
            problems.push(Problem {
                message: format!(
                    "태그 가운데에 탭·표·그림 같은 개체가 끼어 있습니다: {}",
                    full.replace(PH, "")
                ),
                kind: IssueKind::Other,
                start: s,
                text: plain_head(&text[s..close + 2]),
            });
            continue;
        }
        let inner_s: String = inner.iter().collect();
        let t = inner_s.trim();
        if t.starts_with('@') {
            problems.push(Problem {
                message: RAW_XML_MESSAGE.to_string(),
                kind: IssueKind::RawXml,
                start: s,
                text: full,
            });
        } else if let Some(name) = loop_name(t) {
            tags.push(Tag {
                start: s,
                end: close + 2,
                text: full,
                kind: TagKind::Open,
                name,
            });
        } else if t == "endloop" {
            tags.push(Tag {
                start: s,
                end: close + 2,
                text: full,
                kind: TagKind::Close,
                name: String::new(),
            });
        } else {
            tags.push(Tag {
                start: s,
                end: close + 2,
                text: full,
                kind: TagKind::Key,
                name: t.to_string(),
            });
        }
    }
    (tags, problems)
}

/// `loop 이름`(공백 하나 이상) 꼴이면 이름.
fn loop_name(t: &str) -> Option<String> {
    let rest = t.strip_prefix("loop")?;
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let name = rest.trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// 문단 글자(스캔 글자열)와, 스캔 글자열 위치 -> 문단 글자 위치 표. 개체 자리(PH)의 표 값은 `usize::MAX`.
pub(super) struct Model {
    pub chars: Vec<char>,
    pub map: Vec<usize>,
}

pub(super) fn model(p: &Paragraph) -> Model {
    let text: Vec<char> = p.text.chars().collect();
    let positions = if p.controls.is_empty() {
        Vec::new()
    } else {
        p.control_text_positions()
    };
    let mut chars = Vec::with_capacity(text.len() + positions.len());
    let mut map = Vec::with_capacity(text.len() + positions.len());
    let mut ci = 0usize;
    for k in 0..=text.len() {
        while ci < positions.len() && positions[ci].min(text.len()) <= k {
            chars.push(PH);
            map.push(usize::MAX);
            ci += 1;
        }
        if let Some(&c) = text.get(k) {
            if c == '\t' || c == '\n' || c == '\r' {
                chars.push(PH);
                map.push(usize::MAX);
            } else {
                chars.push(c);
                map.push(k);
            }
        }
    }
    Model { chars, map }
}

/// 스캔 글자열의 [start, end)를 value로 바꾼다. 값 전체에 start 글자의 글자 모양을 준다.
/// 태그는 개체 자리를 품지 않으므로(품은 태그는 문제로 거절된다) 범위는 문단 글자의 연속 구간이다.
pub(super) fn edit_range(p: &mut Paragraph, m: &Model, start: usize, end: usize, value: &str) {
    if end <= start {
        return;
    }
    let cs = m.map[start];
    let ce = m.map[end - 1] + 1;
    replace_chars(p, cs, ce, value);
}

pub(super) fn replace_chars(p: &mut Paragraph, cs: usize, ce: usize, value: &str) {
    let style = p.char_shape_id_at(cs);
    let n_new = value.chars().count();
    if ce > cs {
        p.delete_text_at(cs, ce - cs);
    }
    if n_new > 0 {
        p.insert_text_at(cs, value);
        if let Some(style) = style {
            p.apply_char_shape_range(cs, cs + n_new, style);
        }
    }
    // 줄 배치는 비워 두면 그리는 쪽이 다시 짠다(본문 문단은 채운 뒤 따로 reflow).
    p.replace_line_segs(Vec::new());
    p.invalidate_layout_inputs();
}

/// 문단 안에 FILL이 남았으면 뺀다.
pub(super) fn strip_fill(p: &mut Paragraph) {
    if !p.text.contains(FILL) {
        return;
    }
    let chars: Vec<char> = p.text.chars().collect();
    // 뒤에서부터 연속 구간 단위로 지운다
    let mut i = chars.len();
    while i > 0 {
        if chars[i - 1] != FILL {
            i -= 1;
            continue;
        }
        let end = i;
        while i > 0 && chars[i - 1] == FILL {
            i -= 1;
        }
        p.delete_text_at(i, end - i);
    }
    p.invalidate_layout_inputs();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(t: &str) -> Vec<char> {
        t.chars().collect()
    }

    #[test]
    fn scans_keys_and_loops() {
        let (tags, problems) = scan(&s("a {{ name }} b {{loop  rows}}{{endloop}}"));
        assert!(problems.is_empty());
        let kinds: Vec<_> = tags.iter().map(|t| (t.kind, t.name.as_str())).collect();
        assert_eq!(
            kinds,
            vec![
                (TagKind::Key, "name"),
                (TagKind::Open, "rows"),
                (TagKind::Close, "")
            ]
        );
        assert_eq!(tags[0].text, "{{ name }}");
    }

    #[test]
    fn reports_unbalanced_delimiters() {
        let (_, p) = scan(&s("x}} y"));
        assert_eq!(p[0].kind, IssueKind::UnopenedTag);
        let (_, p) = scan(&s("{{a"));
        assert_eq!(p[0].kind, IssueKind::UnclosedTag);
        let (tags, p) = scan(&s("{{a{{b}}"));
        assert_eq!(p[0].kind, IssueKind::UnclosedTag);
        assert_eq!(tags[0].name, "b");
        let (_, p) = scan(&s("{{@raw}}"));
        assert_eq!(p[0].kind, IssueKind::RawXml);
    }

    #[test]
    fn rejects_object_inside_tag() {
        let mut t = s("{{a");
        t.push(PH);
        t.extend(s("b}}"));
        let (tags, p) = scan(&t);
        assert!(tags.is_empty());
        assert_eq!(p[0].kind, IssueKind::Other);
    }
}
