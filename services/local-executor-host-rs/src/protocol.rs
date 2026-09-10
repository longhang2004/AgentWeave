use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use std::collections::BTreeMap;

type HmacSha256 = Hmac<Sha256>;

pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
pub const MAX_REQUEST_BYTES: usize = 1024 * 1024;
pub const MODEL_ID_MAX_LENGTH: usize = 256;

pub const HEADER_KEY_ID: &str = "X-AgentWeave-Key-Id";
pub const HEADER_TIMESTAMP: &str = "X-AgentWeave-Timestamp";
pub const HEADER_DELIVERY_ID: &str = "X-AgentWeave-Delivery-Id";
pub const HEADER_SIGNATURE: &str = "X-AgentWeave-Signature";

#[derive(Debug)]
pub struct ProtocolError {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
}

impl ProtocolError {
    pub fn new(status: u16, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct RunRequest {
    pub invocation: Value,
    #[serde(rename = "resultDelivery")]
    pub result_delivery: ResultDelivery,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ResultDelivery {
    pub mode: String,
    #[serde(rename = "callbackUrl")]
    pub callback_url: String,
    pub authentication: CallbackAuth,
}

#[derive(Clone, Debug, Deserialize)]
pub struct CallbackAuth {
    pub scheme: String,
    #[serde(rename = "keyId")]
    pub key_id: String,
}

pub fn create_callback_signature(
    secret: &str,
    timestamp: &str,
    delivery_id: &str,
    raw_body: &[u8],
) -> String {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC key");
    mac.update(timestamp.as_bytes());
    mac.update(b".");
    mac.update(delivery_id.as_bytes());
    mac.update(b".");
    mac.update(raw_body);
    format!("v1={}", hex::encode(mac.finalize().into_bytes()))
}

pub fn authenticate_bearer(authorization: Option<&str>, expected: &str) -> bool {
    let Some(header) = authorization else {
        return false;
    };
    let Some(rest) = header
        .strip_prefix("Bearer ")
        .or_else(|| header.strip_prefix("bearer "))
    else {
        return false;
    };
    constant_time_eq(rest.as_bytes(), expected.as_bytes())
}

fn constant_time_eq(actual: &[u8], expected: &[u8]) -> bool {
    actual.len() == expected.len() && actual.ct_eq(expected).into()
}

pub fn validate_callback_url(
    value: &str,
    allowed_origins: &[String],
    allow_insecure_http: bool,
) -> Result<(), ProtocolError> {
    let url = url_parts(value).ok_or_else(|| {
        ProtocolError::new(400, "CALLBACK_TARGET_REJECTED", "Callback URL is not allowed")
    })?;
    if url.username || url.password {
        return Err(ProtocolError::new(
            400,
            "CALLBACK_TARGET_REJECTED",
            "Callback URL is not allowed",
        ));
    }
    if url.query || url.fragment {
        return Err(ProtocolError::new(
            400,
            "CALLBACK_TARGET_REJECTED",
            "Callback URL is not allowed",
        ));
    }
    if url.scheme != "https" && !(url.scheme == "http" && allow_insecure_http) {
        return Err(ProtocolError::new(
            400,
            "CALLBACK_TARGET_REJECTED",
            "Callback URL is not allowed",
        ));
    }
    if !allowed_origins.iter().any(|origin| origin == &url.origin) {
        return Err(ProtocolError::new(
            400,
            "CALLBACK_TARGET_REJECTED",
            "Callback URL is not allowed",
        ));
    }
    Ok(())
}

struct UrlParts {
    scheme: String,
    origin: String,
    username: bool,
    password: bool,
    query: bool,
    fragment: bool,
}

fn url_parts(value: &str) -> Option<UrlParts> {
    let (scheme, rest) = value.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let (authority_and_path, fragment) = match rest.split_once('#') {
        Some((left, _)) => (left, true),
        None => (rest, false),
    };
    let (authority_and_path, query) = match authority_and_path.split_once('?') {
        Some((left, _)) => (left, true),
        None => (authority_and_path, false),
    };
    let authority = authority_and_path.split('/').next().unwrap_or("");
    if authority.is_empty() {
        return None;
    }
    let (userinfo, hostport) = match authority.split_once('@') {
        Some((userinfo, hostport)) => (Some(userinfo), hostport),
        None => (None, authority),
    };
    let (username, password) = match userinfo {
        Some(info) => match info.split_once(':') {
            Some((user, pass)) => (!user.is_empty(), !pass.is_empty() || info.contains(':')),
            None => (!info.is_empty(), false),
        },
        None => (false, false),
    };
    let hostport = hostport.trim_start_matches('[');
    if hostport.is_empty() {
        return None;
    }
    Some(UrlParts {
        origin: format!("{scheme}://{authority_after}", authority_after = match userinfo {
            Some(_) => hostport.trim_end_matches(']'),
            None => authority,
        }),
        scheme,
        username,
        password,
        query,
        fragment,
    })
}

pub fn reject_unsafe_numbers(value: &Value) -> Result<(), ProtocolError> {
    match value {
        Value::Number(number) => {
            if let Some(i) = number.as_i64() {
                if i.unsigned_abs() > MAX_SAFE_INTEGER as u64 {
                    return Err(ProtocolError::new(
                        400,
                        "INVALID_REQUEST",
                        "Request does not match HttpAgentRunRequestV1",
                    ));
                }
            } else if let Some(u) = number.as_u64() {
                if u > MAX_SAFE_INTEGER as u64 {
                    return Err(ProtocolError::new(
                        400,
                        "INVALID_REQUEST",
                        "Request does not match HttpAgentRunRequestV1",
                    ));
                }
            } else if let Some(f) = number.as_f64() {
                if !f.is_finite()
                    || (f.fract() == 0.0 && f.abs() > MAX_SAFE_INTEGER as f64)
                {
                    return Err(ProtocolError::new(
                        400,
                        "INVALID_REQUEST",
                        "Request does not match HttpAgentRunRequestV1",
                    ));
                }
            }
            Ok(())
        }
        Value::Array(items) => items.iter().try_for_each(reject_unsafe_numbers),
        Value::Object(map) => map.values().try_for_each(reject_unsafe_numbers),
        _ => Ok(()),
    }
}

pub fn parse_run_request(value: &Value) -> Result<RunRequest, ProtocolError> {
    reject_unsafe_numbers(value)?;
    let object = value.as_object().ok_or_else(|| {
        ProtocolError::new(
            400,
            "INVALID_REQUEST",
            "Request does not match HttpAgentRunRequestV1",
        )
    })?;
    for key in object.keys() {
        if !matches!(key.as_str(), "schemaVersion" | "invocation" | "resultDelivery") {
            return Err(ProtocolError::new(
                400,
                "INVALID_REQUEST",
                "Request does not match HttpAgentRunRequestV1",
            ));
        }
    }
    if object.get("schemaVersion") != Some(&Value::String("1".into())) {
        return Err(ProtocolError::new(
            400,
            "INVALID_REQUEST",
            "Request does not match HttpAgentRunRequestV1",
        ));
    }
    let invocation = object.get("invocation").ok_or_else(|| {
        ProtocolError::new(
            400,
            "INVALID_REQUEST",
            "Request does not match HttpAgentRunRequestV1",
        )
    })?;
    validate_invocation(invocation)?;
    let delivery = object.get("resultDelivery").ok_or_else(|| {
        ProtocolError::new(
            400,
            "INVALID_REQUEST",
            "Request does not match HttpAgentRunRequestV1",
        )
    })?;
    let parsed: RunRequest = serde_json::from_value(value.clone()).map_err(|_| {
        ProtocolError::new(
            400,
            "INVALID_REQUEST",
            "Request does not match HttpAgentRunRequestV1",
        )
    })?;
    if parsed.result_delivery.mode != "callback"
        || parsed.result_delivery.authentication.scheme != "hmac-sha256"
        || parsed.result_delivery.authentication.key_id.is_empty()
    {
        return Err(ProtocolError::new(
            400,
            "INVALID_REQUEST",
            "Request does not match HttpAgentRunRequestV1",
        ));
    }
    let _ = delivery;
    Ok(parsed)
}

fn validate_invocation(value: &Value) -> Result<(), ProtocolError> {
    let object = value.as_object().ok_or_else(|| invalid_request())?;
    for required in [
        "schemaVersion",
        "invocationId",
        "executionId",
        "stepExecutionId",
        "stepId",
        "target",
        "input",
        "attempt",
        "createdAt",
        "trace",
    ] {
        if !object.contains_key(required) {
            return Err(invalid_request());
        }
    }
    if object.get("schemaVersion") != Some(&Value::String("1".into())) {
        return Err(invalid_request());
    }
    for key in object.keys() {
        if !matches!(
            key.as_str(),
            "schemaVersion"
                | "invocationId"
                | "executionId"
                | "stepExecutionId"
                | "stepId"
                | "target"
                | "input"
                | "context"
                | "attempt"
                | "createdAt"
                | "deadlineAt"
                | "trace"
                | "metadata"
                | "connection"
                | "requestedModelId"
        ) {
            return Err(invalid_request());
        }
    }
    let target = object.get("target").and_then(|v| v.as_object());
    let Some(target) = target else {
        return Err(invalid_request());
    };
    if target.get("agent").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
        return Err(invalid_request());
    }
    let trace = object.get("trace").and_then(|v| v.as_object());
    let Some(trace) = trace else {
        return Err(invalid_request());
    };
    if trace
        .get("traceId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .is_empty()
        || trace
            .get("correlationId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .is_empty()
    {
        return Err(invalid_request());
    }
    Ok(())
}

fn invalid_request() -> ProtocolError {
    ProtocolError::new(
        400,
        "INVALID_REQUEST",
        "Request does not match HttpAgentRunRequestV1",
    )
}

pub fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(true) => "true".into(),
        Value::Bool(false) => "false".into(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => serde_json::to_string(s).unwrap(),
        Value::Array(items) => {
            format!(
                "[{}]",
                items.iter().map(canonical_json).collect::<Vec<_>>().join(",")
            )
        }
        Value::Object(map) => {
            let ordered: BTreeMap<_, _> = map.iter().collect();
            let body = ordered
                .into_iter()
                .map(|(k, v)| format!("{}:{}", serde_json::to_string(k).unwrap(), canonical_json(v)))
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{body}}}")
        }
    }
}

pub fn request_fingerprint(request: &Value, idempotency_key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(idempotency_key.as_bytes());
    hasher.update(b"\n");
    hasher.update(canonical_json(request).as_bytes());
    hex::encode(hasher.finalize())
}

pub fn model_id_ok(value: &str) -> bool {
    if value.is_empty() || value.len() > MODEL_ID_MAX_LENGTH {
        return false;
    }
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    chars.all(|c| {
        c.is_ascii_alphanumeric()
            || matches!(c, '.' | '_' | '/' | '-' | ':' | '@' | '+')
    })
}

pub fn rfc3339_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn succeeded_result(invocation: &Value, output: Value) -> Map<String, Value> {
    result_envelope(invocation, "succeeded", Some(output), None)
}

pub fn failed_result(
    invocation: &Value,
    code: &str,
    message: &str,
    retryable: bool,
) -> Map<String, Value> {
    let error = serde_json::json!({
        "code": code,
        "message": message,
        "retryable": retryable
    });
    result_envelope(invocation, "failed", None, Some(error))
}

fn result_envelope(
    invocation: &Value,
    status: &str,
    output: Option<Value>,
    error: Option<Value>,
) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert("schemaVersion".into(), Value::String("1".into()));
    map.insert(
        "invocationId".into(),
        invocation
            .get("invocationId")
            .cloned()
            .unwrap_or(Value::String(String::new())),
    );
    map.insert(
        "executionId".into(),
        invocation
            .get("executionId")
            .cloned()
            .unwrap_or(Value::String(String::new())),
    );
    map.insert(
        "stepExecutionId".into(),
        invocation
            .get("stepExecutionId")
            .cloned()
            .unwrap_or(Value::String(String::new())),
    );
    map.insert("status".into(), Value::String(status.into()));
    if let Some(output) = output {
        map.insert("output".into(), output);
    }
    if let Some(error) = error {
        map.insert("error".into(), error);
    }
    map.insert("completedAt".into(), Value::String(rfc3339_now()));
    map
}

pub fn compact_json(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).expect("json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_matches_shared_conformance_vectors() {
        let raw = include_str!("../../../contracts/conformance/callback-signatures/vectors.json");
        let vectors: Vec<Value> = serde_json::from_str(raw).unwrap();
        for vector in vectors {
            let secret = vector["secret"].as_str().unwrap();
            let timestamp = vector["timestamp"].as_str().unwrap();
            let delivery_id = vector["deliveryId"].as_str().unwrap();
            let body = vector["rawBodyUtf8"].as_str().unwrap();
            let expected = vector["expectedSignature"].as_str().unwrap();
            assert_eq!(
                create_callback_signature(secret, timestamp, delivery_id, body.as_bytes()),
                expected,
                "{}",
                vector["name"]
            );
        }
    }

    #[test]
    fn bearer_rejects_wrong_token() {
        assert!(!authenticate_bearer(Some("Bearer nope"), "token"));
        assert!(authenticate_bearer(Some("Bearer token"), "token"));
    }

    #[test]
    fn callback_url_must_match_origin_and_reject_userinfo() {
        let origins = vec!["http://127.0.0.1:3001".into()];
        assert!(validate_callback_url(
            "http://127.0.0.1:3001/v1/agent-results",
            &origins,
            true
        )
        .is_ok());
        assert!(validate_callback_url(
            "http://evil.example/v1/agent-results",
            &origins,
            true
        )
        .is_err());
        assert!(validate_callback_url(
            "http://user@127.0.0.1:3001/v1/agent-results",
            &origins,
            true
        )
        .is_err());
        assert!(validate_callback_url(
            "http://127.0.0.1:3001/v1/agent-results?x=1",
            &origins,
            true
        )
        .is_err());
    }
}
