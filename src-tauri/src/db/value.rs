//! Cell values on their way to the webview.
//!
//! JSON has one number type, and JavaScript reads it as a double. Anything that
//! would lose precision there travels as a string instead, so an edit or delete
//! keyed on a large id still names the right row.

use base64::Engine as _;
use serde_json::{json, Value};

/// Largest integer a JavaScript number holds exactly.
pub const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

/// Blobs larger than this arrive as their size only, unless the caller asks
/// for full values (exports). A page of 100 rows of images would otherwise
/// cross the IPC boundary as hundreds of megabytes of base64 to show a size.
pub const BLOB_INLINE_LIMIT: usize = 256 * 1024;

pub fn int_value(v: i64) -> Value {
    if (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&v) {
        Value::Number(v.into())
    } else {
        Value::String(v.to_string())
    }
}

/// NaN and the infinities have no JSON form. They used to become NULL, which
/// misreports a real value; send the spelling Postgres itself uses.
pub fn float_value(v: f64) -> Value {
    match serde_json::Number::from_f64(v) {
        Some(n) => Value::Number(n),
        None if v.is_nan() => Value::String("NaN".into()),
        None if v > 0.0 => Value::String("Infinity".into()),
        None => Value::String("-Infinity".into()),
    }
}

pub fn blob_value(bytes: &[u8], full: bool) -> Value {
    if full || bytes.len() <= BLOB_INLINE_LIMIT {
        json!({
            "$blob": base64::engine::general_purpose::STANDARD.encode(bytes),
            "size": bytes.len(),
        })
    } else {
        json!({ "$blob": Value::Null, "size": bytes.len() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integers_beyond_2_pow_53_travel_as_strings() {
        assert_eq!(int_value(42), json!(42));
        assert_eq!(int_value(MAX_SAFE_INTEGER), json!(MAX_SAFE_INTEGER));
        assert_eq!(
            int_value(MAX_SAFE_INTEGER + 1),
            json!((MAX_SAFE_INTEGER + 1).to_string())
        );
        assert_eq!(int_value(i64::MIN), json!(i64::MIN.to_string()));
    }

    #[test]
    fn non_finite_floats_are_named_not_nulled() {
        assert_eq!(float_value(1.5), json!(1.5));
        assert_eq!(float_value(f64::NAN), json!("NaN"));
        assert_eq!(float_value(f64::INFINITY), json!("Infinity"));
        assert_eq!(float_value(f64::NEG_INFINITY), json!("-Infinity"));
    }

    #[test]
    fn large_blobs_send_their_size_only() {
        let small = blob_value(b"hi", false);
        assert_eq!(small["$blob"], json!("aGk="));
        assert_eq!(small["size"], json!(2));

        let big = vec![0u8; BLOB_INLINE_LIMIT + 1];
        let summary = blob_value(&big, false);
        assert!(summary["$blob"].is_null());
        assert_eq!(summary["size"], json!(BLOB_INLINE_LIMIT + 1));
        assert!(blob_value(&big, true)["$blob"].is_string());
    }
}
