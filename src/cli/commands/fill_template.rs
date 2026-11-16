//! `rhwp fill-template` — HWP 5.x 문서의 `{{key}}` · `{{loop 이름}}…{{endloop}}` 태그를 데이터로 채우거나 키를 뽑는다.
//!
//! 문법·의미는 dts-craft의 HWPX 구현(`oss-hwpx.ts`)과 같다. 저장 손실 보고가 비어 있지 않으면 산출물을 쓰지 않는다.
//! 종료 코드: 0 성공, 2 사용법 오류, 1 그 밖의 실패. 실패 종류는 `--json` 봉투의 `code`로 가른다
//! (`template` 문법 오류, `limit` 한도 초과, `contentLoss` 저장 손실, `protected` 암호·배포용, `load` 열기 실패, `usage`, `io`).

use std::fs;

use rhwp::document_core::{TagFillError, TagIssue, TagLimits, TagLocation};
use serde_json::{json, Value};

use crate::cli::document_io::{load_document, LoadError};
use crate::{EXIT_RUNTIME, EXIT_USAGE};

const USAGE: &str = "사용법: rhwp fill-template <입력.hwp> (--data <json|@파일> -o <출력.hwp> | --keys) [--json] [--max-clone-bytes <N>] [--max-loop-items <N>] [--max-paragraphs <N>] [--max-output-bytes <N>]";
const DEFAULT_MAX_OUTPUT: usize = 512 * 1024 * 1024;

fn issue_json(i: &TagIssue) -> Value {
    json!({
        "message": i.message,
        "kind": i.kind.as_str(),
        "name": i.name,
        "location": i.location.as_ref().map(location_json),
    })
}

fn location_json(l: &TagLocation) -> Value {
    json!({
        "story": l.story.as_str(),
        "text": l.text,
        "occurrence": l.occurrence,
        "total": l.total,
    })
}

struct Failure {
    code: &'static str,
    message: String,
    issues: Vec<Value>,
    exit: i32,
}

impl Failure {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            issues: Vec::new(),
            exit: EXIT_RUNTIME,
        }
    }
    fn usage(message: impl Into<String>) -> Self {
        Self {
            exit: EXIT_USAGE,
            ..Self::new("usage", message)
        }
    }
}

impl From<TagFillError> for Failure {
    fn from(e: TagFillError) -> Self {
        match e {
            TagFillError::Syntax(issues) => Self {
                issues: issues.iter().map(issue_json).collect(),
                ..Self::new(
                    "template",
                    issues
                        .first()
                        .map_or_else(|| "템플릿 오류".to_string(), |i| i.message.clone()),
                )
            },
            TagFillError::Limit(m) => Self::new("limit", m),
            TagFillError::Document(m) => Self::new("load", m),
        }
    }
}

fn parse_n(opt: &str, v: Option<&String>) -> Result<usize, Failure> {
    v.and_then(|s| s.parse::<usize>().ok())
        .filter(|n| *n >= 1)
        .ok_or_else(|| Failure::usage(format!("{opt} 뒤에 1 이상의 정수가 필요합니다")))
}

pub(crate) fn run(args: &[String]) -> i32 {
    let json_mode = args.iter().any(|a| a == "--json");
    match run_inner(args) {
        Ok(envelope) => {
            if json_mode {
                println!("{envelope}");
            }
            0
        }
        Err(f) => {
            if json_mode {
                println!(
                    "{}",
                    json!({"ok": false, "code": f.code, "error": f.message, "issues": f.issues})
                );
            } else {
                eprintln!("오류: {}", f.message);
                for i in &f.issues {
                    if let Some(m) = i.get("message").and_then(Value::as_str) {
                        eprintln!("  - {m}");
                    }
                }
                if f.exit == EXIT_USAGE {
                    eprintln!("{USAGE}");
                }
            }
            f.exit
        }
    }
}

fn run_inner(args: &[String]) -> Result<Value, Failure> {
    let mut input: Option<&str> = None;
    let mut data: Option<&str> = None;
    let mut output: Option<&str> = None;
    let mut keys_mode = false;
    let mut limits = TagLimits::default();
    let mut max_output = DEFAULT_MAX_OUTPUT;
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        match a {
            "--json" => {}
            "--keys" => keys_mode = true,
            "--data" | "-o" | "--output" | "--max-clone-bytes" | "--max-loop-items"
            | "--max-paragraphs" | "--max-output-bytes" => {
                let v = args.get(i + 1);
                match a {
                    "--data" | "-o" | "--output" => {
                        let s = v
                            .filter(|s| !s.is_empty())
                            .ok_or_else(|| Failure::usage(format!("{a} 뒤에 값이 필요합니다")))?;
                        if a == "--data" {
                            data = Some(s);
                        } else {
                            output = Some(s);
                        }
                    }
                    "--max-clone-bytes" => limits.max_clone_bytes = parse_n(a, v)?,
                    "--max-loop-items" => limits.max_loop_items = parse_n(a, v)?,
                    "--max-paragraphs" => limits.max_paras = parse_n(a, v)?,
                    _ => max_output = parse_n(a, v)?,
                }
                i += 1;
            }
            o if o.starts_with('-') => return Err(Failure::usage(format!("알 수 없는 옵션: {o}"))),
            p => {
                if input.replace(p).is_some() {
                    return Err(Failure::usage("입력 파일은 하나만 지정할 수 있습니다"));
                }
            }
        }
        i += 1;
    }
    let input = input.ok_or_else(|| Failure::usage("입력 파일이 필요합니다"))?;
    if keys_mode && (data.is_some() || output.is_some()) {
        return Err(Failure::usage("--keys는 --data·-o와 함께 쓸 수 없습니다"));
    }
    if !keys_mode && (data.is_none() || output.is_none()) {
        return Err(Failure::usage("채우려면 --data와 -o가 모두 필요합니다"));
    }

    let bytes =
        fs::read(input).map_err(|e| Failure::new("io", format!("입력을 읽을 수 없습니다: {e}")))?;
    if rhwp::parser::detect_format(&bytes) == rhwp::parser::FileFormat::Hwpx {
        return Err(Failure::usage(
            "HWPX 입력은 지원하지 않습니다 (HWPX는 dts-craft의 HWPX 경로를 쓰세요)",
        ));
    }
    let mut doc = load_document(&bytes).map_err(|e| match e {
        LoadError::NeedPassword => Failure::new("protected", "비밀번호가 필요한 암호 문서입니다"),
        LoadError::WrongPassword => {
            Failure::new("protected", "암호 문서이며 비밀번호가 맞지 않습니다")
        }
        LoadError::Other(m) => Failure::new("load", format!("문서를 열 수 없습니다: {m}")),
    })?;
    if doc.document().header.distribution {
        return Err(Failure::new("protected", "배포용 문서는 채울 수 없습니다"));
    }

    if keys_mode {
        let scan = doc.scan_template_tags(limits)?;
        let issues: Vec<Value> = scan.issues.iter().map(issue_json).collect();
        let locations: Vec<Value> = scan
            .locations
            .iter()
            .map(|(k, l)| {
                let mut v = location_json(l);
                v["key"] = json!(k);
                v
            })
            .collect();
        return Ok(json!({
            "ok": scan.issues.is_empty(),
            "keysJson": scan.keys.to_json(),
            "keys": scan.keys.paths(),
            "locations": locations,
            "issues": issues,
        }));
    }

    let raw = data.unwrap_or_default();
    let text = match raw.strip_prefix('@') {
        Some(path) => fs::read_to_string(path)
            .map_err(|e| Failure::new("io", format!("데이터 파일을 읽을 수 없습니다: {e}")))?,
        None => raw.to_string(),
    };
    let value: Value = serde_json::from_str(&text)
        .map_err(|e| Failure::usage(format!("--data가 올바른 JSON이 아닙니다: {e}")))?;
    if !value.is_object() {
        return Err(Failure::usage("--data는 JSON 객체여야 합니다"));
    }

    let report = doc.fill_template_tags(&value, limits)?;
    // 저장 손실이 있으면 산출물을 쓰지 않는다(편집기 저장 거절과 같은 정책).
    let serialized = doc
        .export_hwp_with_adapter_snapshot_with_report()
        .map_err(|e| Failure::new("load", format!("저장하지 못했습니다: {e}")))?;
    let (out_bytes, loss) = serialized.into_parts();
    if !loss.is_empty() {
        let mut f = Failure::new(
            "contentLoss",
            format!(
                "저장하면 내용이 빠지는 문서입니다 ({}건) — 저장하지 않았습니다",
                loss.len()
            ),
        );
        f.issues = vec![serde_json::from_str(&loss.to_json()).unwrap_or(Value::Null)];
        return Err(f);
    }
    if out_bytes.len() > max_output {
        return Err(Failure::new(
            "limit",
            format!(
                "출력이 너무 큽니다: {}바이트 (최대 {max_output})",
                out_bytes.len()
            ),
        ));
    }
    let out_path = output.unwrap_or_default();
    // 반쯤 쓴 파일이 남지 않게 임시 이름에 쓴 뒤 옮긴다.
    let tmp = format!("{out_path}.tmp-{}", std::process::id());
    fs::write(&tmp, &out_bytes)
        .map_err(|e| Failure::new("io", format!("출력을 쓸 수 없습니다: {e}")))?;
    if let Err(e) = fs::rename(&tmp, out_path) {
        let _ = fs::remove_file(&tmp);
        return Err(Failure::new("io", format!("출력을 쓸 수 없습니다: {e}")));
    }
    Ok(json!({
        "ok": true,
        "output": out_path,
        "bytes": out_bytes.len(),
        "changed": report.changed,
        "filled": report.filled,
        "empty": report.empty,
        "contentLoss": {"count": 0},
    }))
}
