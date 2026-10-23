//! The hand-written structs in `src/contract.rs` against
//! `packages/contract/openapi.yaml`: every field the recorder sends or reads
//! is a property of the schema, and every required property is a field.

use mtxt_recorder::contract::*;
use serde_json::Value;
use serde_yaml::Value as Yaml;
use std::collections::BTreeSet;

fn spec() -> Yaml {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../packages/contract/openapi.yaml");
    serde_yaml::from_str(&std::fs::read_to_string(path).expect("openapi.yaml")).expect("yaml")
}

fn schema<'a>(spec: &'a Yaml, name: &str) -> &'a Yaml {
    &spec["components"]["schemas"][name]
}

fn resolve<'a>(spec: &'a Yaml, s: &'a Yaml) -> &'a Yaml {
    match s.get("$ref").and_then(Yaml::as_str) {
        Some(r) => schema(spec, r.rsplit('/').next().unwrap()),
        None => s,
    }
}

/// Properties and required names of a schema, through `allOf` and `$ref`.
fn shape(spec: &Yaml, s: &Yaml) -> (BTreeSet<String>, BTreeSet<String>) {
    let s = resolve(spec, s);
    let mut props = BTreeSet::new();
    let mut required = BTreeSet::new();
    if let Some(all) = s.get("allOf").and_then(Yaml::as_sequence) {
        for part in all {
            let (p, r) = shape(spec, part);
            props.extend(p);
            required.extend(r);
        }
    }
    if let Some(m) = s.get("properties").and_then(Yaml::as_mapping) {
        for (k, v) in m {
            // `not: {}` marks a property that must be absent.
            if v.get("not").is_none() {
                props.insert(k.as_str().unwrap().to_string());
            }
        }
    }
    if let Some(r) = s.get("required").and_then(Yaml::as_sequence) {
        required.extend(r.iter().map(|v| v.as_str().unwrap().to_string()));
    }
    (props, required)
}

fn check(spec: &Yaml, s: &Yaml, value: &Value, path: &str) {
    let (props, required) = shape(spec, s);
    let obj = value.as_object().unwrap_or_else(|| panic!("{path} is not an object"));
    let keys: BTreeSet<String> = obj.keys().cloned().collect();
    for k in &keys {
        assert!(props.contains(k), "{path}.{k} is not in the contract");
    }
    for r in &required {
        assert!(keys.contains(r), "{path}.{r} is required by the contract");
    }
    // Nested objects.
    let s = resolve(spec, s);
    for (k, v) in obj {
        if let Some(sub) = s.get("properties").and_then(|p| p.get(k.as_str())) {
            let sub = resolve(spec, sub);
            if v.is_object() && sub.get("properties").is_some() {
                check(spec, sub, v, &format!("{path}.{k}"));
            }
        }
    }
}

fn err() -> ErrorBody {
    ErrorBody { code: "busy".into(), message: "m".into() }
}

#[test]
fn every_struct_matches_its_schema() {
    let spec = spec();
    let s = |n: &str| schema(&spec, n).clone();
    let cases: Vec<(&str, Value)> = vec![
        ("RecorderTokenRequest", serde_json::to_value(RecorderTokenRequest { challenge: "c".into(), verifier: "v".into() }).unwrap()),
        (
            "RecorderToken",
            serde_json::to_value(RecorderToken {
                token: "t".into(),
                token_id: "i".into(),
                expires_at: "e".into(),
                device_name: "d".into(),
                user: RecorderUser { name: "n".into() },
                install: RecorderInstall {
                    product_name: "p".into(),
                    theme_accent: "#000000".into(),
                    theme_primary: "#000000".into(),
                    interface_language: Some("da".into()),
                    live_transcript_default: Some(false),
                },
            })
            .unwrap(),
        ),
        ("RecorderTokenPending", serde_json::to_value(RecorderTokenPending { status: "pending".into() }).unwrap()),
        (
            "CreateRecordingResponse",
            serde_json::to_value(CreateRecordingResponse {
                id: "r".into(),
                meeting_id: "m".into(),
                upload_url: "/u".into(),
                chunk_size_bytes: 1,
                chunk_count: Some(1),
                status: "uploading".into(),
            })
            .unwrap(),
        ),
        ("ChunkReceipt", serde_json::to_value(ChunkReceipt { n: 1, size_bytes: 1, chunks_received: vec![1], chunk_count: None }).unwrap()),
        ("CompleteRecordingRequest", serde_json::to_value(CompleteRecordingRequest { sha256: "a".into(), size_bytes: 1, duration_s: 1 }).unwrap()),
        (
            "Recording",
            serde_json::to_value(Recording {
                id: "r".into(),
                meeting_id: "m".into(),
                status: "uploading".into(),
                sha256: None,
                size_bytes: None,
                duration_s: 0,
                source: "desktop".into(),
                created_at: "c".into(),
                chunk_count: None,
                chunks_received: vec![],
                confirmed_at: None,
                error: Some(err()),
            })
            .unwrap(),
        ),
        ("ErrorBody", serde_json::to_value(err()).unwrap()),
        ("Error", serde_json::to_value(Error { error: err() }).unwrap()),
        ("Conflict", serde_json::to_value(Conflict { error: err(), reason: "busy".into(), missing: Some(vec![2]), retry_after: Some(1) }).unwrap()),
        ("RateLimited", serde_json::to_value(RateLimited { error: err(), retry_after: 1 }).unwrap()),
    ];
    for (name, value) in cases {
        check(&spec, &s(name), &value, name);
    }
}

#[test]
fn the_create_request_is_the_new_meeting_branch() {
    let spec = spec();
    let one_of = schema(&spec, "CreateRecordingRequest")["oneOf"].as_sequence().unwrap();
    let branch = one_of.iter().find(|b| b["title"].as_str() == Some("ForNewMeeting")).expect("ForNewMeeting");
    let body = CreateRecordingRequest {
        meeting: NewMeeting { title: "t".into(), started_at: "s".into() },
        duration_s: 1,
        sha256: "a".into(),
        size_bytes: 1,
        source: SOURCE_DESKTOP.into(),
        content_type: CONTENT_TYPE_OGG_OPUS.into(),
    };
    check(&spec, branch, &serde_json::to_value(body).unwrap(), "CreateRecordingRequest");
}

#[test]
fn constants_match_the_contract() {
    let spec = spec();
    let details = schema(&spec, "RecordingDetails");
    assert_eq!(details["properties"]["size_bytes"]["maximum"].as_u64(), Some(MAX_SIZE_BYTES));
    let sources: Vec<&str> = schema(&spec, "RecordingSource")["enum"].as_sequence().unwrap().iter().filter_map(Yaml::as_str).collect();
    assert!(sources.contains(&SOURCE_DESKTOP));
    let pattern = details["properties"]["content_type"]["pattern"].as_str().unwrap();
    assert!(pattern.starts_with("^([Aa][Uu][Dd][Ii][Oo]"));
    assert_eq!(schema(&spec, "NewMeeting")["properties"]["title"]["maxLength"].as_u64(), Some(MAX_TITLE_CHARS as u64));
    let statuses: Vec<&str> = schema(&spec, "RecordingStatus")["enum"].as_sequence().unwrap().iter().filter_map(Yaml::as_str).collect();
    for s in [status::UPLOADING, status::CONFIRMED, status::TRANSCRIBING, status::TRANSCRIBED, status::FAILED] {
        assert!(statuses.contains(&s));
    }
    let flow = &spec["x-recorder-flow"];
    assert_eq!(flow["poll"]["interval_seconds"].as_u64(), Some(mtxt_recorder::connect::POLL_INTERVAL_SECS));
    assert_eq!(flow["poll"]["give_up_after_seconds"].as_u64(), Some(mtxt_recorder::connect::POLL_GIVE_UP_SECS));
    let ex = &flow["pairing_code"]["example"];
    assert_eq!(mtxt_recorder::connect::pairing_code(ex["challenge"].as_str().unwrap()), ex["code"].as_str().unwrap());
}
