//! 템플릿 데이터용 JSON 값. `serde_json::Value`는 객체 키를 사전순으로 가져 HWPX(JS `JSON.parse`·`JSON.stringify`)와
//! 객체 값 글자가 달라지므로, 입력 순서를 지키는 값을 따로 둔다. `serde_json`의 `preserve_order`는 crate 전체
//! (다른 명령의 JSON 출력·wasm)에 영향을 주어 켜지 않는다.
use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Number, Value};
use std::{collections::HashMap, fmt};

/// 입력 순서를 지키는 JSON 값. 객체의 같은 키가 또 나오면 처음 자리에 뒤의 값을 둔다(JS와 같다).
#[derive(Clone, Debug, PartialEq)]
pub enum JVal {
    Null,
    Bool(bool),
    Number(Number),
    String(String),
    Array(Vec<JVal>),
    Object(JObj),
}

/// 객체: 입력 순서의 항목과 키 색인(키 수가 많은 데이터에서 찾기가 선형으로 늘지 않게 한다).
#[derive(Clone, Debug, Default)]
pub struct JObj {
    items: Vec<(String, JVal)>,
    index: HashMap<String, usize>,
}

impl PartialEq for JObj {
    fn eq(&self, other: &Self) -> bool {
        self.items == other.items
    }
}

impl JObj {
    /// 항목 목록에서 만든다. 같은 키가 또 나오면 처음 자리에 뒤의 값을 둔다(JS와 같다).
    pub fn new(items: Vec<(String, JVal)>) -> Self {
        let mut o = JObj::default();
        for (k, v) in items {
            o.insert(k, v);
        }
        o
    }

    fn insert(&mut self, k: String, v: JVal) {
        match self.index.get(&k) {
            Some(&i) => self.items[i].1 = v,
            None => {
                self.index.insert(k.clone(), self.items.len());
                self.items.push((k, v));
            }
        }
    }

    pub fn iter(&self) -> std::slice::Iter<'_, (String, JVal)> {
        self.items.iter()
    }
}

/// JS `String(숫자)`·`JSON.stringify`와 같은 글자로 숫자를 쓴다(HWPX와 같은 출력 글자를 위해).
/// 2^53을 넘는 정수는 JS가 부동소수로 읽으므로 같은 규칙을 따른다.
pub fn js_number(n: &Number) -> String {
    const SAFE: u64 = 1 << 53;
    if let Some(i) = n.as_i64() {
        if i.unsigned_abs() <= SAFE {
            return i.to_string();
        }
    } else if let Some(u) = n.as_u64() {
        if u <= SAFE {
            return u.to_string();
        }
    }
    let f = n.as_f64().unwrap_or(0.0);
    if f == 0.0 {
        return "0".to_string();
    }
    // 최단 왕복 자릿수: `{:e}`는 "1.2345e20" 꼴이다
    let sci = format!("{:e}", f.abs());
    let (mant, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let point = exp.parse::<i32>().unwrap_or(0) + 1; // 소수점 위치(JS 명세의 n)
    let body = if k <= point && point <= 21 {
        format!("{digits}{}", "0".repeat((point - k) as usize))
    } else if 0 < point && point <= 21 {
        format!(
            "{}.{}",
            &digits[..point as usize],
            &digits[point as usize..]
        )
    } else if -6 < point && point <= 0 {
        format!("0.{}{digits}", "0".repeat((-point) as usize))
    } else {
        let e = point - 1;
        let sign = if e < 0 { '-' } else { '+' };
        let head = if k == 1 {
            digits.clone()
        } else {
            format!("{}.{}", &digits[..1], &digits[1..])
        };
        format!("{head}e{sign}{}", e.abs())
    };
    if f < 0.0 {
        format!("-{body}")
    } else {
        body
    }
}

impl JVal {
    /// 빈 객체.
    pub fn empty_object() -> JVal {
        JVal::Object(JObj::default())
    }

    /// 객체의 값.
    pub fn get(&self, key: &str) -> Option<&JVal> {
        match self {
            JVal::Object(m) => m.index.get(key).map(|&i| &m.items[i].1),
            _ => None,
        }
    }

    /// JSON 글자(공백 없음). 객체 키는 입력 순서다.
    fn write(&self, out: &mut String) {
        match self {
            JVal::Null => out.push_str("null"),
            JVal::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            JVal::Number(n) => out.push_str(&js_number(n)),
            JVal::String(s) => out.push_str(&Value::String(s.clone()).to_string()),
            JVal::Array(a) => {
                out.push('[');
                for (i, v) in a.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    v.write(out);
                }
                out.push(']');
            }
            JVal::Object(m) => {
                out.push('{');
                for (i, (k, v)) in m.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&Value::String(k.clone()).to_string());
                    out.push(':');
                    v.write(out);
                }
                out.push('}');
            }
        }
    }
}

impl fmt::Display for JVal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut s = String::new();
        self.write(&mut s);
        f.write_str(&s)
    }
}

/// `serde_json::Value`(키 사전순)에서 바꾼다. 시험처럼 순서가 중요하지 않은 곳에서 쓴다.
impl From<&Value> for JVal {
    fn from(v: &Value) -> Self {
        match v {
            Value::Null => JVal::Null,
            Value::Bool(b) => JVal::Bool(*b),
            Value::Number(n) => JVal::Number(n.clone()),
            Value::String(s) => JVal::String(s.clone()),
            Value::Array(a) => JVal::Array(a.iter().map(JVal::from).collect()),
            Value::Object(m) => JVal::Object(JObj::new(
                m.iter().map(|(k, v)| (k.clone(), v.into())).collect(),
            )),
        }
    }
}

impl JVal {
    /// JSON 글자에서 읽는다(입력 순서를 지킨다. 중첩 깊이 상한은 `serde_json`의 기본값 128).
    pub fn parse(text: &str) -> Result<JVal, serde_json::Error> {
        serde_json::from_str(text)
    }
}

impl<'de> Deserialize<'de> for JVal {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = JVal;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("JSON 값")
            }
            fn visit_unit<E>(self) -> Result<JVal, E> {
                Ok(JVal::Null)
            }
            fn visit_none<E>(self) -> Result<JVal, E> {
                Ok(JVal::Null)
            }
            fn visit_bool<E>(self, b: bool) -> Result<JVal, E> {
                Ok(JVal::Bool(b))
            }
            fn visit_i64<E>(self, n: i64) -> Result<JVal, E> {
                Ok(JVal::Number(n.into()))
            }
            fn visit_u64<E>(self, n: u64) -> Result<JVal, E> {
                Ok(JVal::Number(n.into()))
            }
            fn visit_f64<E: serde::de::Error>(self, n: f64) -> Result<JVal, E> {
                Number::from_f64(n)
                    .map(JVal::Number)
                    .ok_or_else(|| E::custom("유한하지 않은 숫자"))
            }
            fn visit_str<E>(self, s: &str) -> Result<JVal, E> {
                Ok(JVal::String(s.to_string()))
            }
            fn visit_string<E>(self, s: String) -> Result<JVal, E> {
                Ok(JVal::String(s))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<JVal, A::Error> {
                let mut out = Vec::new();
                while let Some(v) = seq.next_element()? {
                    out.push(v);
                }
                Ok(JVal::Array(out))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<JVal, A::Error> {
                let mut out = JObj::default();
                while let Some((k, v)) = map.next_entry::<String, JVal>()? {
                    out.insert(k, v);
                }
                Ok(JVal::Object(out))
            }
        }
        d.deserialize_any(V)
    }
}
