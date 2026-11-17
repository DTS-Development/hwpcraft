//! `{{key}}` 채우기·키 추출 엔진 시험. 문서는 편집 API로 직접 만든다(고객 문서 없음).
use super::tag_fill::{visit_paras, TagFillError, TagLimits};
use crate::{
    document_core::DocumentCore,
    model::{control::Control, paragraph::Paragraph},
};
use serde_json::{json, Value};

fn para(text: &str) -> Paragraph {
    let mut p = Paragraph::default();
    p.insert_text_at(0, text);
    p
}

/// 첫 문단(구역 정의)은 두고 본문 문단을 덧붙인 빈 문서.
fn doc(lines: &[&str]) -> DocumentCore {
    let mut c = DocumentCore::new_empty();
    c.create_blank_document_native().unwrap();
    for l in lines {
        c.document_mut().sections[0].paragraphs.push(para(l));
    }
    c
}

/// 문서 안 모든 문단 글자(표·머리말·글상자 포함)를 나타난 순서대로.
fn texts(c: &DocumentCore) -> Vec<String> {
    let mut out = Vec::new();
    for s in &c.document().sections {
        visit_paras(&s.paragraphs, &mut |p| {
            if !p.text.is_empty() {
                out.push(p.text.clone());
            }
        });
    }
    out
}

fn fill(c: &mut DocumentCore, data: Value) -> Result<super::tag_fill::TagFillReport, TagFillError> {
    c.fill_template_tags(&data, TagLimits::default())
}

/// 표를 만들고 셀 글자를 채운다. 반환: 표가 든 문단 번호.
fn table(c: &mut DocumentCore, rows: &[&[&str]]) -> usize {
    let at = c.document().sections[0].paragraphs.len();
    c.document_mut().sections[0]
        .paragraphs
        .push(Paragraph::default());
    let cols = rows[0].len();
    c.create_table_native(0, at, 0, rows.len() as u16, cols as u16)
        .unwrap();
    for (r, row) in rows.iter().enumerate() {
        for (k, text) in row.iter().enumerate() {
            c.insert_text_in_cell_native(0, at, 0, r * cols + k, 0, 0, text)
                .unwrap();
        }
    }
    at
}

fn table_of(c: &DocumentCore, para: usize) -> &crate::model::table::Table {
    c.document().sections[0].paragraphs[para]
        .controls
        .iter()
        .find_map(|c| {
            if let Control::Table(t) = c {
                Some(&**t)
            } else {
                None
            }
        })
        .unwrap()
}

#[test]
fn fills_keys_and_missing_key_becomes_empty() {
    let mut c = doc(&["안녕 {{ name }} 님", "빈값[{{none}}]끝"]);
    let r = fill(&mut c, json!({"name": "홍길동"})).unwrap();
    assert_eq!(r.filled, vec!["name"]);
    assert_eq!(r.empty, vec!["none"]);
    let t = texts(&c);
    assert!(t.contains(&"안녕 홍길동 님".to_string()), "{t:?}");
    assert!(t.contains(&"빈값[]끝".to_string()), "{t:?}");
}

#[test]
fn numbers_and_booleans_render_like_js() {
    let mut c = doc(&["{{a}}/{{b}}/{{c}}/{{d}}"]);
    fill(&mut c, json!({"a": 3, "b": 2.5, "c": true, "d": null})).unwrap();
    assert!(texts(&c).contains(&"3/2.5/true/".to_string()));
}

#[test]
fn paragraph_loop_repeats_and_drops_tag_only_paragraphs() {
    let mut c = doc(&["머리", "{{loop rows}}", "행 {{v}}", "{{endloop}}", "꼬리"]);
    fill(
        &mut c,
        json!({"rows": [{"v": "1"}, {"v": "2"}, {"v": "3"}]}),
    )
    .unwrap();
    let t = texts(&c);
    assert_eq!(t, vec!["머리", "행 1", "행 2", "행 3", "꼬리"]);
}

#[test]
fn empty_loop_removes_block() {
    let mut c = doc(&["머리", "{{loop rows}}", "행 {{v}}", "{{endloop}}", "꼬리"]);
    fill(&mut c, json!({"rows": []})).unwrap();
    assert_eq!(texts(&c), vec!["머리", "꼬리"]);
}

#[test]
fn loop_scope_falls_back_to_outer_values() {
    let mut c = doc(&["{{loop rows}}", "{{v}}-{{title}}", "{{endloop}}"]);
    fill(
        &mut c,
        json!({"title": "T", "rows": [{"v": "a"}, {"v": "b"}]}),
    )
    .unwrap();
    assert_eq!(texts(&c), vec!["a-T", "b-T"]);
}

#[test]
fn table_row_loop_clones_rows_and_updates_geometry() {
    let mut c = doc(&["x"]);
    let at = table(
        &mut c,
        &[
            &["품목", "수량"],
            &["{{loop items}}{{n}}", "{{q}}{{endloop}}"],
            &["합계", "{{total}}"],
        ],
    );
    let before = table_of(&c, at).common.height;
    fill(
        &mut c,
        json!({"total": 9, "items": [{"n":"사과","q":1},{"n":"배","q":2},{"n":"귤","q":3}]}),
    )
    .unwrap();
    let t = table_of(&c, at);
    assert_eq!(t.row_count, 5);
    assert_eq!(t.cells.len(), 10);
    assert_eq!(t.row_sizes, vec![2, 2, 2, 2, 2]);
    assert!(t.common.height > before);
    let cells: Vec<_> = t
        .cells
        .iter()
        .map(|c| c.paragraphs[0].text.clone())
        .collect();
    assert_eq!(
        cells,
        vec!["품목", "수량", "사과", "1", "배", "2", "귤", "3", "합계", "9"]
    );
    let rows: Vec<u16> = t.cells.iter().map(|c| c.row).collect();
    assert_eq!(rows, vec![0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
}

#[test]
fn table_row_loop_with_no_items_removes_rows_and_whole_table_if_empty() {
    let mut c = doc(&["x"]);
    let at = table(&mut c, &[&["{{loop items}}{{n}}", "{{endloop}}"]]);
    fill(&mut c, json!({"items": []})).unwrap();
    assert!(c.document().sections[0].paragraphs[at]
        .controls
        .iter()
        .all(|c| !matches!(c, Control::Table(_))));
}

#[test]
fn nested_paragraph_loop_inside_table_row_loop() {
    let mut c = doc(&["x"]);
    let at = table(&mut c, &[&["{{loop g}}{{name}}", "{{endloop}}"]]);
    // 두 번째 셀 안에서 문단 반복을 쓰지 않아도, 행 반복 안의 값은 항목마다 다르다.
    fill(&mut c, json!({"g": [{"name": "A"}, {"name": "B"}]})).unwrap();
    let t = table_of(&c, at);
    assert_eq!(t.row_count, 2);
    assert_eq!(t.cells[0].paragraphs[0].text, "A");
    assert_eq!(t.cells[2].paragraphs[0].text, "B");
}

#[test]
fn fills_header_footer_and_footnote() {
    let mut c = doc(&["본문 {{a}}"]);
    c.create_header_footer_native(0, true, 0).unwrap();
    c.insert_text_in_header_footer_native(0, true, 0, 0, 0, "머리 {{a}}")
        .unwrap();
    c.create_header_footer_native(0, false, 0).unwrap();
    c.insert_text_in_header_footer_native(0, false, 0, 0, 0, "꼬리 {{a}}")
        .unwrap();
    let at = c.document().sections[0].paragraphs.len() - 1;
    c.insert_footnote_native(0, at, 0).unwrap();
    c.insert_text_in_footnote_native(0, at, 0, 0, 0, "각주 {{a}}")
        .unwrap();
    fill(&mut c, json!({"a": "값"})).unwrap();
    let t = texts(&c);
    for want in ["본문 값", "머리 값", "꼬리 값", "각주 값"] {
        assert!(
            t.iter().any(|s| s.trim_end() == want),
            "{want} not in {t:?}"
        );
    }
    assert!(t.iter().all(|s| !s.contains("{{")), "{t:?}");
}

/// 글상자 안 첫 문단(없으면 만든다)에 글자를 넣는다. 반환: 글상자가 있는 본문 문단 번호.
fn textbox_with(c: &mut DocumentCore, text: &str) -> usize {
    textbox_in(c, 0, text)
}

/// `textbox_with`와 같되 본문 `para`번 문단에 만든다(0번 문단은 구역 정의 컨트롤을 가진다).
fn textbox_in(c: &mut DocumentCore, para: usize, text: &str) -> usize {
    let res = c
        .create_shape_control_native(
            0,
            para,
            0,
            21600,
            7200,
            0,
            0,
            true,
            "TopAndBottom",
            "textbox",
            false,
            false,
            &[],
        )
        .unwrap();
    let v: Value = serde_json::from_str(&res).unwrap();
    let (pi, ci) = (
        v["paraIdx"].as_u64().unwrap() as usize,
        v["controlIdx"].as_u64().unwrap() as usize,
    );
    let Control::Shape(s) = &mut c.document_mut().sections[0].paragraphs[pi].controls[ci] else {
        panic!("shape expected");
    };
    let tb = s.drawing_mut().unwrap().text_box.as_mut().unwrap();
    if tb.paragraphs.is_empty() {
        tb.paragraphs.push(Paragraph::default());
    }
    tb.paragraphs[0].insert_text_at(0, text);
    pi
}

#[test]
fn fills_real_textbox_and_endnote() {
    let mut c = doc(&["본문"]);
    textbox_with(&mut c, "상자 {{a}}");
    let at = c.document().sections[0].paragraphs.len() - 1;
    c.insert_endnote_native(0, at, 0).unwrap();
    let Control::Endnote(e) = c.document_mut().sections[0].paragraphs[at]
        .controls
        .iter_mut()
        .find(|k| matches!(k, Control::Endnote(_)))
        .unwrap()
    else {
        unreachable!()
    };
    e.paragraphs[0].insert_text_at(0, "미주 {{b}}");
    let scan = c.scan_template_tags(TagLimits::default()).unwrap();
    let story = |k: &str| {
        scan.locations
            .iter()
            .find(|(n, _)| n == k)
            .map(|(_, l)| l.story)
    };
    assert_eq!(
        story("a"),
        Some(super::tag_fill::Story::Body),
        "글상자는 본문 범위"
    );
    assert_eq!(story("b"), Some(super::tag_fill::Story::Endnote));
    fill(&mut c, json!({"a": "값", "b": "끝"})).unwrap();
    let t = texts(&c);
    for want in ["상자 값", "미주 끝"] {
        assert!(
            t.iter().any(|s| s.trim_end() == want),
            "{want} not in {t:?}"
        );
    }
    assert!(t.iter().all(|s| !s.contains("{{")), "{t:?}");
}

#[test]
fn scan_reports_keys_shapes_and_locations() {
    let c = doc(&["{{a}} {{a}}", "{{loop r}}", "{{x}}", "{{endloop}}", "{{b}}"]);
    let s = c.scan_template_tags(TagLimits::default()).unwrap();
    assert!(s.issues.is_empty(), "{:?}", s.issues);
    assert_eq!(s.keys.paths(), vec!["a", "r", "r.x", "b"]);
    let v: Value = serde_json::from_str(&s.keys.to_json()).unwrap();
    assert_eq!(v["keys"]["r"]["itemSchema"]["x"], json!({}));
    let a = s.locations.iter().find(|(k, _)| k == "a").unwrap();
    assert_eq!((a.1.occurrence, a.1.total), (1, 2));
    assert_eq!(a.1.story.as_str(), "body");
}

#[test]
fn syntax_errors_reject_without_touching_document() {
    for bad in ["{{loop a}}", "{{endloop}}", "{{@raw}}", "{{open", "close}}"] {
        let mut c = doc(&["앞 {{ok}}", bad]);
        let before = texts(&c);
        let e = fill(&mut c, json!({"ok": "v"})).unwrap_err();
        assert!(
            matches!(e, TagFillError::Syntax(ref v) if !v.is_empty()),
            "{bad}"
        );
        assert_eq!(texts(&c), before, "{bad}");
    }
}

#[test]
fn one_paragraph_loop_is_rejected() {
    let mut c = doc(&["{{loop a}}{{x}}{{endloop}}"]);
    assert!(matches!(
        fill(&mut c, json!({"a": [{"x": 1}]})),
        Err(TagFillError::Syntax(_))
    ));
}

#[test]
fn loop_item_limit_and_clone_budget_reject() {
    let mut c = doc(&["{{loop r}}", "{{x}}", "{{endloop}}"]);
    let many: Vec<Value> = (0..50).map(|i| json!({"x": i})).collect();
    let limits = TagLimits {
        max_loop_items: 10,
        ..TagLimits::default()
    };
    let before = texts(&c);
    let e = c
        .fill_template_tags(&json!({"r": many.clone()}), limits)
        .unwrap_err();
    assert!(matches!(e, TagFillError::Limit(_)));
    let tiny = TagLimits {
        max_clone_bytes: 1024,
        ..TagLimits::default()
    };
    let e = c.fill_template_tags(&json!({"r": many}), tiny).unwrap_err();
    assert!(matches!(e, TagFillError::Limit(_)));
    assert_eq!(texts(&c), before);
}

#[test]
fn huge_value_is_stopped_by_budget() {
    let mut c = doc(&["{{big}}"]);
    let tiny = TagLimits {
        max_clone_bytes: 1000,
        ..TagLimits::default()
    };
    let e = c
        .fill_template_tags(&json!({"big": "가".repeat(5000)}), tiny)
        .unwrap_err();
    assert!(matches!(e, TagFillError::Limit(_)));
}

#[test]
fn saved_output_has_no_loss_and_reloads_filled() {
    let mut c = doc(&["{{loop r}}", "행 {{x}}", "{{endloop}}"]);
    fill(&mut c, json!({"r": [{"x": "a"}, {"x": "b"}]})).unwrap();
    let ser = c.export_hwp_with_adapter_snapshot_with_report().unwrap();
    let (bytes, loss) = ser.into_parts();
    assert!(loss.is_empty());
    let re = DocumentCore::from_bytes(&bytes).unwrap();
    let t = texts(&re);
    assert!(
        t.contains(&"행 a".to_string()) && t.contains(&"행 b".to_string()),
        "{t:?}"
    );
    assert!(t.iter().all(|s| !s.contains("{{")));
}

// ---------------------------------------------------------------- 바탕쪽

use crate::model::header_footer::MasterPage;

/// 바탕쪽(일반·확장)을 모델로 넣어 저장했다 다시 연 문서. 다시 열면 바탕쪽이 원본 레코드로 들어 있어 저장기가 그 레코드를 쓴다.
fn doc_with_masters(body: &[&str], masters: &[(bool, &[&str])]) -> DocumentCore {
    let masters: Vec<(bool, Vec<Paragraph>)> = masters
        .iter()
        .map(|(e, lines)| (*e, lines.iter().map(|l| para(l)).collect()))
        .collect();
    doc_with_master_paragraphs(body, masters)
}

fn doc_with_master_paragraphs(body: &[&str], masters: Vec<(bool, Vec<Paragraph>)>) -> DocumentCore {
    let mut c = doc(body);
    let count = masters.len();
    for (extension, paragraphs) in masters {
        let extension = &extension;
        let page = MasterPage {
            is_extension: *extension,
            ext_flags: if *extension { 0x02 } else { 0 },
            text_width: 1000,
            text_height: 1000,
            paragraphs,
            ..Default::default()
        };
        // 저장기는 첫 문단의 구역 정의 컨트롤에서 바탕쪽을 쓴다
        for ctrl in &mut c.document_mut().sections[0].paragraphs[0].controls {
            if let Control::SectionDef(sd) = ctrl {
                sd.master_pages.push(page.clone());
            }
        }
        c.document_mut().sections[0]
            .section_def
            .master_pages
            .push(page);
    }
    // 원본 스트림이 남아 있으면 저장기가 그대로 써 바탕쪽이 빠진다
    c.document_mut().sections[0].raw_stream = None;
    let bytes = c
        .export_hwp_with_adapter_snapshot_with_report()
        .unwrap()
        .into_parts()
        .0;
    let re = DocumentCore::from_bytes(&bytes).unwrap();
    assert_eq!(
        re.document().sections[0].section_def.master_pages.len(),
        count
    );
    re
}

fn master_texts(c: &DocumentCore) -> Vec<Vec<String>> {
    let mut out = Vec::new();
    for s in &c.document().sections {
        for m in &s.section_def.master_pages {
            let mut t = Vec::new();
            visit_paras(&m.paragraphs, &mut |p| t.push(p.text.clone()));
            out.push(t);
        }
    }
    out
}

/// 채운 문서를 저장(손실 없음)하고 다시 열어 돌려준다.
fn save_and_reload(c: &mut DocumentCore) -> DocumentCore {
    let (bytes, loss) = c
        .export_hwp_with_adapter_snapshot_with_report()
        .unwrap()
        .into_parts();
    assert!(loss.is_empty(), "저장 손실: {}", loss.to_json());
    DocumentCore::from_bytes(&bytes).unwrap()
}

#[test]
fn master_page_values_are_filled_and_saved() {
    let mut c = doc_with_masters(&["본문 {{b}}"], &[(false, &["바탕 {{m}}", "둘째 {{m}}"])]);
    assert!(!c.document().sections[0]
        .section_def
        .extra_child_records
        .is_empty());
    let r = fill(&mut c, json!({"b": "B", "m": "M"})).unwrap();
    assert_eq!(r.filled, vec!["b", "m"]);
    let re = save_and_reload(&mut c);
    assert_eq!(
        master_texts(&re),
        vec![vec!["바탕 M".to_string(), "둘째 M".to_string()]]
    );
    assert!(texts(&re).contains(&"본문 B".to_string()));
}

#[test]
fn master_page_only_template_is_filled() {
    let mut c = doc_with_masters(&["본문"], &[(false, &["{{m}}"])]);
    let r = fill(&mut c, json!({"m": "X"})).unwrap();
    assert!(r.changed);
    let re = save_and_reload(&mut c);
    assert_eq!(master_texts(&re), vec![vec!["X".to_string()]]);
}

#[test]
fn master_page_loop_changes_paragraph_count_and_saves() {
    let mut c = doc_with_masters(
        &["본문"],
        &[(false, &["{{loop r}}", "항목 {{x}}", "{{endloop}}"])],
    );
    fill(&mut c, json!({"r": [{"x": "a"}, {"x": "b"}, {"x": "c"}]})).unwrap();
    let re = save_and_reload(&mut c);
    assert_eq!(
        master_texts(&re),
        vec![vec![
            "항목 a".to_string(),
            "항목 b".to_string(),
            "항목 c".to_string()
        ]]
    );
    // 빈 배열이면 문단이 비어도 바탕쪽은 남는다
    let mut c = doc_with_masters(
        &["본문"],
        &[(false, &["{{loop r}}", "항목 {{x}}", "{{endloop}}"])],
    );
    fill(&mut c, json!({"r": []})).unwrap();
    let re = save_and_reload(&mut c);
    assert_eq!(master_texts(&re).len(), 1);
}

#[test]
fn extension_master_page_in_section_tail_is_filled_and_saved() {
    let mut c = doc_with_masters(
        &["본문 {{b}}"],
        &[(false, &["기본 {{m}}"]), (true, &["확장 {{m}} {{e}}"])],
    );
    assert!(c.document().sections[0].trailing_lists.is_some());
    fill(&mut c, json!({"b": "B", "m": "M", "e": "E"})).unwrap();
    let re = save_and_reload(&mut c);
    assert_eq!(
        master_texts(&re),
        vec![vec!["기본 M".to_string()], vec!["확장 M E".to_string()]]
    );
}

#[test]
fn master_page_scan_locates_keys_after_body_in_master_story() {
    let c = doc_with_masters(
        &["본문 {{b}} {{m}}"],
        &[(false, &["바탕 {{m}}"]), (false, &["또 {{m}} {{only}}"])],
    );
    let scan = c.scan_template_tags(TagLimits::default()).unwrap();
    assert!(scan.issues.is_empty());
    let loc = |k: &str| {
        scan.locations
            .iter()
            .find(|(n, _)| n == k)
            .map(|(_, l)| l.clone())
            .unwrap()
    };
    // 처음 쓰인 곳은 본문
    assert_eq!(loc("m").story.as_str(), "body");
    let only = loc("only");
    assert_eq!(only.story.as_str(), "masterPage");
    assert_eq!(
        (only.text.as_str(), only.occurrence, only.total),
        ("{{only}}", 1, 1)
    );
}

#[test]
fn master_page_syntax_error_rejects_without_touching_document() {
    let mut c = doc_with_masters(&["본문 {{b}}"], &[(false, &["{{loop r}}", "x"])]);
    let before = master_texts(&c);
    let err = fill(&mut c, json!({"b": "B"})).unwrap_err();
    match err {
        TagFillError::Syntax(issues) => assert_eq!(
            issues[0].location.as_ref().unwrap().story.as_str(),
            "masterPage"
        ),
        other => panic!("{other:?}"),
    }
    assert_eq!(master_texts(&c), before);
    assert!(texts(&c).contains(&"본문 {{b}}".to_string()));
}

/// 다른 문서에서 만든 표·글상자 문단을 떼어 바탕쪽 문단으로 쓴다.
fn detached_para(build: impl FnOnce(&mut DocumentCore) -> usize) -> Paragraph {
    let mut c = doc(&["x"]);
    let at = build(&mut c);
    c.document_mut().sections[0].paragraphs.remove(at)
}

#[test]
fn master_page_table_tags_are_filled_and_saved() {
    let tbl = detached_para(|c| {
        table(
            c,
            &[
                &["품목", "{{loop items}}{{n}}"],
                &["합계", "{{total}}{{endloop}}"],
            ],
        )
    });
    let mut c = doc_with_master_paragraphs(&["본문"], vec![(false, vec![para("바탕 {{m}}"), tbl])]);
    let r = fill(
        &mut c,
        json!({"m": "M", "total": "T", "items": [{"n": "a"}, {"n": "b"}]}),
    )
    .unwrap();
    assert!(r.changed);
    let re = save_and_reload(&mut c);
    let t = &master_texts(&re)[0];
    assert!(t.contains(&"바탕 M".to_string()), "{t:?}");
    for want in ["a", "b", "T"] {
        assert!(t.iter().any(|s| s == want), "{want} not in {t:?}");
    }
    assert!(t.iter().all(|s| !s.contains("{{")), "{t:?}");
}

#[test]
fn master_page_textbox_tags_are_filled_and_untagged_box_is_kept_verbatim() {
    let boxed = || detached_para(|c| textbox_in(c, 1, "상자 {{m}}"));
    // 태그가 없는 글상자는 원본 레코드 그대로 두고 다른 문단만 채운다
    let plain = detached_para(|c| textbox_in(c, 1, "상자"));
    let mut c =
        doc_with_master_paragraphs(&["본문"], vec![(false, vec![para("바탕 {{m}}"), plain])]);
    let raw_before = c.document().sections[0]
        .section_def
        .extra_child_records
        .clone();
    fill(&mut c, json!({"m": "M"})).unwrap();
    let raw_after = &c.document().sections[0].section_def.extra_child_records;
    // 글상자 문단(둘째)의 레코드는 바이트까지 같다
    let second = |r: &[crate::model::document::RawRecord]| {
        let top = r
            .iter()
            .filter(|x| x.tag_id == crate::parser::tags::HWPTAG_PARA_HEADER)
            .map(|x| x.level)
            .min()
            .unwrap();
        let at = r
            .iter()
            .enumerate()
            .filter(|(_, x)| x.tag_id == crate::parser::tags::HWPTAG_PARA_HEADER && x.level == top)
            .nth(1)
            .unwrap()
            .0;
        r[at..]
            .iter()
            .map(|x| (x.tag_id, x.level, x.data.clone()))
            .collect::<Vec<_>>()
    };
    assert_eq!(second(&raw_before), second(raw_after));
    let re = save_and_reload(&mut c);
    assert_eq!(master_texts(&re)[0][0], "바탕 M");
    // 글상자 안 태그도 채워진다
    let mut c =
        doc_with_master_paragraphs(&["본문"], vec![(false, vec![para("바탕 {{m}}"), boxed()])]);
    fill(&mut c, json!({"m": "M"})).unwrap();
    let re = save_and_reload(&mut c);
    assert!(
        master_texts(&re)[0].contains(&"상자 M".to_string()),
        "{:?}",
        master_texts(&re)
    );
}

#[test]
fn master_page_fill_keeps_memos_in_section_tail() {
    use crate::{model::document::RawRecord, parser::tags};
    let mut c = doc_with_masters(
        &["본문"],
        &[(false, &["기본 {{m}}"]), (true, &["확장 {{m}}"])],
    );
    // 구역 끝 목록 앞뒤에 메모 묶음(MEMO_LIST + LIST_HEADER + 문단)을 끼운다
    let memo = |text: &str| -> Vec<RawRecord> {
        let mut made = Vec::new();
        crate::serializer::body_text::serialize_paragraph_list(&[para(text)], 2, &mut made);
        let mut v = vec![
            RawRecord {
                tag_id: tags::HWPTAG_MEMO_LIST,
                level: 1,
                data: vec![0; 4],
            },
            RawRecord {
                tag_id: tags::HWPTAG_LIST_HEADER,
                level: 1,
                data: vec![1, 0, 0, 0, 0, 0, 0, 0],
            },
        ];
        v.extend(made.into_iter().map(|r| RawRecord {
            tag_id: r.tag_id,
            level: r.level,
            data: r.data,
        }));
        v
    };
    let (first, last) = (memo("메모 앞 {{m}}"), memo("메모 뒤 {{m}}"));
    {
        let t = c.document_mut().sections[0]
            .trailing_lists
            .as_mut()
            .unwrap();
        let mut all = first.clone();
        all.append(&mut t.records);
        all.extend(last.clone());
        t.records = all;
    }
    c.document_mut().seal_section_tail_provenance();
    fill(&mut c, json!({"m": "M"})).unwrap();
    let t = c.document().sections[0].trailing_lists.as_ref().unwrap();
    let same = |a: &[RawRecord], b: &[RawRecord]| {
        a.len() == b.len()
            && a.iter()
                .zip(b)
                .all(|(x, y)| x.tag_id == y.tag_id && x.level == y.level && x.data == y.data)
    };
    assert!(same(&t.records[..first.len()], &first), "앞 메모가 바뀜");
    assert!(
        same(&t.records[t.records.len() - last.len()..], &last),
        "뒤 메모가 바뀜"
    );
    let re = save_and_reload(&mut c);
    assert_eq!(
        master_texts(&re),
        vec![vec!["기본 M".to_string()], vec!["확장 M".to_string()]]
    );
}

#[test]
fn master_page_with_unmodeled_records_is_rejected_closed_but_other_pages_still_fill() {
    use crate::{model::document::RawRecord, parser::tags};
    let mut c = doc_with_masters(
        &["본문 {{b}}"],
        &[(false, &["첫째 {{m}}"]), (false, &["둘째 {{m}}"])],
    );
    // 첫째 바탕쪽 끝에 모델이 담지 못하는 레코드가 있다고 하자
    let sd_records = |c: &DocumentCore| {
        c.document().sections[0]
            .section_def
            .extra_child_records
            .len()
    };
    let (start, _) = {
        let r = &c.document().sections[0].section_def.extra_child_records;
        let heads: Vec<usize> = r
            .iter()
            .enumerate()
            .filter(|(_, x)| x.tag_id == tags::HWPTAG_LIST_HEADER && x.level == r[0].level)
            .map(|(i, _)| i)
            .collect();
        (heads[1], heads.len())
    };
    let junk = RawRecord {
        tag_id: tags::HWPTAG_BEGIN + 200,
        level: c.document().sections[0].section_def.extra_child_records[start].level + 1,
        data: vec![1, 2, 3],
    };
    c.document_mut().sections[0]
        .section_def
        .extra_child_records
        .insert(start, junk.clone());
    // 같은 레코드를 첫 문단의 구역 정의 컨트롤 사본에도 둔다
    for ctrl in &mut c.document_mut().sections[0].paragraphs[0].controls {
        if let Control::SectionDef(sd) = ctrl {
            sd.extra_child_records.insert(start, junk.clone());
        }
    }
    let n = sd_records(&c);
    let before = master_texts(&c);
    let err = fill(&mut c, json!({"b": "B", "m": "M"})).unwrap_err();
    match err {
        TagFillError::Document(m) => assert!(m.contains("바탕쪽 1"), "{m}"),
        other => panic!("{other:?}"),
    }
    assert_eq!(master_texts(&c), before);
    assert_eq!(sd_records(&c), n);
    assert!(texts(&c).contains(&"본문 {{b}}".to_string()));
    // 태그가 없는 바탕쪽(바뀌지 않음)이면 같은 문서도 그대로 채워진다
    let mut ok = doc_with_masters(&["본문 {{b}}"], &[(false, &["첫째"])]);
    ok.document_mut().sections[0]
        .section_def
        .extra_child_records
        .push(RawRecord {
            tag_id: tags::HWPTAG_BEGIN + 200,
            level: 9,
            data: vec![1],
        });
    fill(&mut ok, json!({"b": "B"})).unwrap();
}
