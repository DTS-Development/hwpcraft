//! 바탕쪽 되쓰기. HWP 파일의 바탕쪽은 구역 정의 자식 레코드(`extra_child_records`)와 구역 끝 목록(`trailing_lists`)에
//! 원본 레코드로 들어 있고, 저장기는 그 레코드를 그대로 쓴다. 모델(`master_pages`)만 고치면 저장에 반영되지 않으므로
//! 바뀐 바탕쪽의 문단 레코드를 모델에서 다시 만들어 같은 자리에 끼운다.
use crate::{
    model::{
        document::{RawRecord, SectionDef},
        paragraph::Paragraph,
        section_tail::SectionTail,
    },
    parser::{record::Record, tags},
};
use std::collections::HashMap;

/// 레코드 열에서 바탕쪽 하나가 차지하는 범위(LIST_HEADER 위치, 다음 목록 시작).
/// 파서(`parse_master_pages_from_raw`)와 같은 규칙이다: 가장 얕은 LIST_HEADER만 목록 머리이고,
/// 영역이 0x0인 것은 바탕쪽이 아니다(모델에 없다).
fn pages_in(records: &[RawRecord]) -> Vec<(usize, usize)> {
    let Some(top) = records
        .iter()
        .filter(|r| r.tag_id == tags::HWPTAG_LIST_HEADER)
        .map(|r| r.level)
        .min()
    else {
        return Vec::new();
    };
    let heads: Vec<usize> = records
        .iter()
        .enumerate()
        .filter(|(_, r)| r.tag_id == tags::HWPTAG_LIST_HEADER && r.level == top)
        .map(|(i, _)| i)
        .collect();
    let mut out = Vec::new();
    for (k, &start) in heads.iter().enumerate() {
        let end = heads.get(k + 1).copied().unwrap_or(records.len());
        // 문단 수(2) + 속성(4) + 폭 참조(2) 뒤에 바탕쪽 영역 폭·높이(각 4)
        let d = &records[start].data;
        let word = |at: usize| {
            d.get(at..at + 4)
                .map_or(0, |b| u32::from_le_bytes(b.try_into().unwrap()))
        };
        if word(8) != 0 || word(12) != 0 {
            out.push((start, end));
        }
    }
    out
}

/// 문단 목록을 레코드로 직렬화한다. 원본이 24바이트 문단 머리(변경추적 병합 표지 포함)를 쓰면 머리 길이를 맞춘다.
fn make_body(paras: &[Paragraph], level: u16, header_len: usize) -> Vec<RawRecord> {
    let mut made: Vec<Record> = Vec::new();
    crate::serializer::body_text::serialize_paragraph_list(paras, level, &mut made);
    made.into_iter()
        .map(|r| {
            let mut data = r.data;
            if r.tag_id == tags::HWPTAG_PARA_HEADER && data.len() == 22 && header_len > 22 {
                data.resize(header_len, 0);
            }
            RawRecord {
                tag_id: r.tag_id,
                level: r.level,
                data,
            }
        })
        .collect()
}

/// 최상위 문단 하나의 레코드에서 "목록의 마지막 문단" 표지(문자 수 최상위 비트)를 켜거나 끈다.
fn set_last(rs: &mut [RawRecord], is_last: bool) {
    if let Some(d) = rs
        .first_mut()
        .filter(|r| r.tag_id == tags::HWPTAG_PARA_HEADER)
        .and_then(|r| r.data.get_mut(3))
    {
        if is_last {
            *d |= 0x80;
        } else {
            *d &= 0x7f;
        }
    }
}

/// 레코드 열을 비교용 바이트열로 만든다. 마지막 문단 표지는 위치에 따라 달라지므로 뺀다.
fn key_of(rs: &[RawRecord]) -> Vec<u8> {
    let mut rs = rs.to_vec();
    set_last(&mut rs, false);
    let mut k = Vec::new();
    for r in &rs {
        k.extend_from_slice(&r.tag_id.to_le_bytes());
        k.extend_from_slice(&r.level.to_le_bytes());
        k.extend_from_slice(&(r.data.len() as u32).to_le_bytes());
        k.extend_from_slice(&r.data);
    }
    k
}

/// 바탕쪽 레코드(LIST_HEADER 다음부터)를 최상위 문단 단위로 가른다. 문단 수가 모델과 안 맞으면 None.
fn paragraph_spans(
    body: &[RawRecord],
    list_level: u16,
    count: usize,
) -> Option<Vec<(usize, usize)>> {
    let heads: Vec<usize> = body
        .iter()
        .enumerate()
        .filter(|(_, r)| r.tag_id == tags::HWPTAG_PARA_HEADER && r.level == list_level)
        .map(|(i, _)| i)
        .collect();
    if heads.len() != count || (count > 0 && heads[0] != 0) || (count == 0 && !body.is_empty()) {
        return None;
    }
    Some(
        heads
            .iter()
            .enumerate()
            .map(|(n, &s)| (s, heads.get(n + 1).copied().unwrap_or(body.len())))
            .collect(),
    )
}

/// `records` 안 바탕쪽의 문단 레코드를 새 문단으로 바꾼다. edits: (바탕쪽 번호, 새 문단, 바뀌기 전 문단).
/// 바뀌지 않은 문단은 원본 레코드를 그대로 쓴다(모델이 담지 못하는 레코드·그림·개체까지 보존).
/// 바뀐 문단은 모델에서 다시 만드는데, 원래 모델로 다시 만들면 원본 레코드와 달라지는 문단(모델이 다 담지 못함)이
/// 바뀌어 버리면 그 내용이 빠지므로 아무것도 바꾸지 않고 Err.
fn rewrite_pages(
    records: &mut Vec<RawRecord>,
    edits: &[(usize, &Vec<Paragraph>, &Vec<Paragraph>)],
) -> Result<(), String> {
    let pages = pages_in(records);
    let mut plans: Vec<(usize, usize, Vec<RawRecord>)> = Vec::new();
    for &(k, paras, orig) in edits {
        let Some(&(start, end)) = pages.get(k) else {
            continue;
        };
        let level = records[start].level;
        let body = &records[start + 1..end];
        let header_len = body
            .iter()
            .filter(|r| r.tag_id == tags::HWPTAG_PARA_HEADER)
            .map(|r| r.data.len())
            .max()
            .unwrap_or(0);
        let fail = |why: &str| {
            format!(
                "바탕쪽 {}의 원본 레코드를 모델이 다 담지 못해 채울 수 없습니다 ({why})",
                k + 1
            )
        };
        let spans =
            paragraph_spans(body, level, orig.len()).ok_or_else(|| fail("문단 구조가 다릅니다"))?;
        // 원본 문단마다: 모델로 다시 만든 결과(key)와 그것이 원본 레코드와 같은지(faithful)
        let mut by_key: HashMap<Vec<u8>, usize> = HashMap::new();
        let mut faithful = Vec::with_capacity(orig.len());
        for (i, p) in orig.iter().enumerate() {
            let made = make_body(std::slice::from_ref(p), level, header_len);
            let key = key_of(&made);
            faithful.push(key == key_of(&body[spans[i].0..spans[i].1]));
            by_key.entry(key).or_insert(i);
        }
        let mut used = vec![false; orig.len()];
        let mut out: Vec<RawRecord> = Vec::new();
        for (n, p) in paras.iter().enumerate() {
            let made = make_body(std::slice::from_ref(p), level, header_len);
            let mut one = match by_key.get(&key_of(&made)) {
                Some(&i) => {
                    used[i] = true;
                    body[spans[i].0..spans[i].1].to_vec()
                }
                None => made,
            };
            set_last(&mut one, n + 1 == paras.len());
            out.extend(one);
        }
        if let Some(i) = (0..orig.len()).find(|&i| !faithful[i] && !used[i]) {
            return Err(fail(&format!(
                "{}번째 문단이 바뀌지만 모델로 다시 만들면 원본과 달라집니다",
                i + 1
            )));
        }
        let mut head = records[start].clone();
        if head.data.len() >= 2 {
            head.data[..2]
                .copy_from_slice(&(paras.len().min(usize::from(u16::MAX)) as u16).to_le_bytes());
        }
        let mut full = vec![head];
        full.extend(out);
        plans.push((start, end, full));
    }
    // 뒤에서부터 바꿔야 앞 범위의 위치가 그대로다
    plans.sort_by_key(|p| std::cmp::Reverse(p.0));
    for (start, end, full) in plans {
        records.splice(start..end, full);
    }
    Ok(())
}

/// 구역 정의(와 있으면 구역 끝 목록)에 바뀐 바탕쪽을 되쓴다. edits: 바탕쪽 번호(구역 정의의 `master_pages` 순서) -> 문단.
/// 모델과 원본 레코드의 바탕쪽 수가 안 맞으면 어느 것도 바꾸지 않고 Err.
pub(super) fn write_back_masters(
    sd: &mut SectionDef,
    tail: Option<&mut SectionTail>,
    edits: &HashMap<usize, Vec<Paragraph>>,
) -> Result<(), String> {
    let own = pages_in(&sd.extra_child_records).len();
    // 구역 끝 목록은 메모가 아닌 묶음마다 바탕쪽 0개 이상을 가진다
    let mut spans: Vec<(usize, usize, usize)> = Vec::new(); // (시작, 끝, 바탕쪽 수)
    if let Some(t) = &tail {
        let mut off = 0;
        for (memo, group) in t.record_groups() {
            let n = if memo { 0 } else { pages_in(group).len() };
            spans.push((off, off + group.len(), n));
            off += group.len();
        }
    }
    let tail_pages: usize = spans.iter().map(|s| s.2).sum();
    let raw_pages = own + tail_pages;
    if raw_pages > 0 && raw_pages != sd.master_pages.len() {
        return Err(format!(
            "바탕쪽 구조가 맞지 않아 채울 수 없습니다 (원본 레코드 {raw_pages}개, 해석된 바탕쪽 {}개)",
            sd.master_pages.len()
        ));
    }
    // 바뀌기 전 문단(원본 레코드와 견주는 데 쓴다)
    let orig: HashMap<usize, Vec<Paragraph>> = edits
        .keys()
        .filter_map(|&k| sd.master_pages.get(k).map(|m| (k, m.paragraphs.clone())))
        .collect();
    for (&k, paras) in edits {
        if let Some(m) = sd.master_pages.get_mut(k) {
            m.paragraphs = paras.clone();
        }
    }
    if raw_pages == 0 {
        // 원본 레코드가 없으면 저장기가 모델에서 만든다
        return Ok(());
    }
    let local: Vec<(usize, &Vec<Paragraph>, &Vec<Paragraph>)> = (0..own)
        .filter_map(|k| Some((k, edits.get(&k)?, orig.get(&k)?)))
        .collect();
    if !local.is_empty() {
        rewrite_pages(&mut sd.extra_child_records, &local)?;
    }
    if let Some(t) = tail {
        let mut out: Vec<RawRecord> = Vec::with_capacity(t.records.len());
        let mut next = own;
        for (start, end, n) in spans {
            let mut group = t.records[start..end].to_vec();
            let local: Vec<(usize, &Vec<Paragraph>, &Vec<Paragraph>)> = (0..n)
                .filter_map(|k| Some((k, edits.get(&(next + k))?, orig.get(&(next + k))?)))
                .collect();
            if !local.is_empty() {
                rewrite_pages(&mut group, &local)?;
            }
            next += n;
            out.extend(group);
        }
        t.records = out;
    }
    Ok(())
}
