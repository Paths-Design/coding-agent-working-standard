use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures.json")).unwrap()
}
fn bytes(v: &Value) -> Vec<u8> {
    if let Some(s) = v.as_str() {
        return STANDARD.decode(s).unwrap();
    }
    let mut result = Vec::new();
    for part in v.as_array().unwrap() {
        if let Some(s) = part.as_str() {
            result.extend(STANDARD.decode(s).unwrap());
        } else {
            result.extend(std::iter::repeat_n(
                part["byte"].as_u64().unwrap() as u8,
                part["count"].as_u64().unwrap() as usize,
            ));
        }
    }
    result
}
fn issued() -> (ServiceRenderGrant, RenderRequest) {
    let f = fixture();
    (
        decode_service_grant(&bytes(&f["grant"])).unwrap(),
        decode_render_request(&bytes(&f["request"])).unwrap(),
    )
}

#[test]
fn exact_external_typed_ts_wire_corpus() {
    // Produced by actual Node CLI dist, independently of this Rust codec. The
    // manifest pins producer bytes and owning TS sources; regenerating fixtures
    // requires a current CLI build and a separately reviewed producer script.
    let f = fixture();
    assert_eq!(
        f["sourceFiles"]["service-protocol.ts"],
        sha(include_bytes!(
            "../../../caws-cli/src/runtime/service-protocol.ts"
        ))
    );
    assert_eq!(
        f["sourceFiles"]["service-client.ts"],
        sha(include_bytes!(
            "../../../caws-cli/src/runtime/service-client.ts"
        ))
    );
    let (grant, request) = issued();
    let mut accepted = 0;
    let mut rejected = 0;
    for case in f["cases"].as_array().unwrap() {
        let wire = bytes(&case["wire"]);
        let result = match case["kind"].as_str().unwrap() {
            "request" => decode_render_request(&wire).and_then(|r| encode_render_request(&r)),
            "grant" => decode_service_grant(&wire).and_then(|g| encode_service_grant(&g)),
            "bridge_request" => decode_service_bridge_request(&wire, &grant)
                .and_then(|b| encode_service_bridge_request(&grant, &b.request)),
            "outcome" => decode_render_outcome(&wire, &request)
                .and_then(|f| encode_render_outcome(&f, &request)),
            "bridge_reply" => decode_service_bridge_reply(&wire, &grant, &request)
                .and_then(|r| encode_service_bridge_reply(&grant, &request, &r.outcome)),
            "receipt" => decode_service_client_receipt(&wire, &grant, &request)
                .and_then(|r| encode_service_client_receipt(&r, &grant, &request)),
            other => panic!("unknown fixture kind {other}"),
        };
        if case["canonical"].is_null() {
            rejected += 1;
            assert!(
                result.is_err(),
                "accepted TS-rejected case {}",
                case["name"]
            );
        } else {
            accepted += 1;
            assert_eq!(
                result.unwrap_or_else(|_| panic!("refused TS-accepted case {}", case["name"])),
                bytes(&case["canonical"]),
                "encoder bytes differ for {}",
                case["name"]
            );
        }
    }
    assert_eq!((accepted, rejected), (64, 65));
}

#[test]
fn public_hashes_and_grant_correlation_do_not_replace_exact_issued_request() {
    let (grant, request) = issued();
    let good = decode_service_bridge_request(
        &encode_service_bridge_request(&grant, &request).unwrap(),
        &grant,
    )
    .unwrap();
    validate_issued_request(&good, &grant, &request).unwrap();
    let mut changed = request.arguments.clone();
    changed[4].push_str("changed by caller");
    let recomputed = grant.request(changed).unwrap();
    assert_eq!(recomputed.request_id, request.request_id);
    assert_ne!(recomputed.argument_digest, request.argument_digest);
    // Every digest and envelope is valid, yet exact native expectation refuses.
    let altered = decode_service_bridge_request(
        &encode_service_bridge_request(&grant, &recomputed).unwrap(),
        &grant,
    )
    .unwrap();
    assert!(validate_issued_request(&altered, &grant, &request).is_err());
    let mut foreign = grant.clone();
    foreign.remaining_budget_ms -= 1;
    assert!(
        decode_service_bridge_request(
            &encode_service_bridge_request(&grant, &request).unwrap(),
            &foreign
        )
        .is_err()
    );
}

#[test]
fn controls_remain_argument_data_and_nul_cannot_be_constructed() {
    let (grant, request) = issued();
    assert!(request.arguments[4].contains("\r\n\x1f"));
    assert!(request.arguments[4].contains("\u{2028}\u{2029}/"));
    for index in 0..12 {
        let mut args = request.arguments.clone();
        args[index] = "before\r\n\x1fafter".into();
        let r = grant.request(args).unwrap();
        assert_eq!(
            decode_render_request(&encode_render_request(&r).unwrap())
                .unwrap()
                .arguments[index],
            "before\r\n\x1fafter"
        );
        let mut bad = r.arguments.clone();
        bad[index].push('\0');
        assert!(grant.request(bad).is_err());
    }
}

#[test]
fn typed_output_constructors_refuse_semantically_impossible_results() {
    let (_, request) = issued();
    for result in [
        RenderResult::ProcessExit {
            code: Some(0),
            signal: Some(1),
        },
        RenderResult::ProcessExit {
            code: None,
            signal: None,
        },
        RenderResult::ProcessExit {
            code: None,
            signal: Some(128),
        },
        RenderResult::DaemonResponse {
            served: 0,
            elapsed_ms: 0,
            cached: false,
        },
        RenderResult::DaemonResponse {
            served: 1,
            elapsed_ms: SAFE + 1,
            cached: false,
        },
    ] {
        assert!(
            RenderOutcomeFrame::for_request(
                &request,
                RenderOutcome::Returned {
                    result,
                    artifact_manifest_digest: None
                }
            )
            .is_err()
        );
    }
    assert!(
        RenderOutcomeFrame::for_request(
            &request,
            RenderOutcome::Rejected {
                reason: "x".repeat(1025)
            }
        )
        .is_err()
    );
}
