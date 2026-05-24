use crate::harness::*;
use axum::http::StatusCode;

#[tokio::test]
async fn delete_project_with_no_children_succeeds() {
    let app = require_db!();
    let project_id = app.create_project("delete-leaf").await;

    let resp = app.send(delete(&format!("/v1/{project_id}"))).await;
    assert_eq!(
        resp.status,
        StatusCode::OK,
        "delete leaf project: {}",
        resp.json
    );

    app.cleanup().await;
}

#[tokio::test]
async fn delete_project_with_children_is_rejected() {
    let app = require_db!();
    let parent_id = app.create_project("delete-parent").await;

    // Create a child project under the parent
    let resp = app
        .send(post_json(
            "/v1",
            serde_json::json!({
                "name": "delete-child",
                "parent_id": parent_id,
            }),
        ))
        .await;
    assert_eq!(
        resp.status,
        StatusCode::OK,
        "create child project: {}",
        resp.json
    );
    let child_id = resp.id();

    // Attempting to delete the parent should fail with 409
    let resp = app.send(delete(&format!("/v1/{parent_id}"))).await;
    assert_eq!(
        resp.status,
        StatusCode::CONFLICT,
        "expected conflict deleting parent with children: {}",
        resp.json
    );

    // Deleting the child should succeed
    let resp = app.send(delete(&format!("/v1/{child_id}"))).await;
    assert_eq!(
        resp.status,
        StatusCode::OK,
        "delete child project: {}",
        resp.json
    );

    // Now deleting the parent should succeed (no children left)
    let resp = app.send(delete(&format!("/v1/{parent_id}"))).await;
    assert_eq!(
        resp.status,
        StatusCode::OK,
        "delete parent after child removed: {}",
        resp.json
    );

    app.cleanup().await;
}

/// Validates that project.metadata.auto_push (boolean) round-trips correctly
/// through create → update → read. This is the storage mechanism chosen by
/// decision 2d2fb16d: store auto_push in the existing metadata jsonb field.
#[tokio::test]
async fn project_metadata_auto_push_round_trips() {
    let app = require_db!();

    // 1. Create a project — metadata defaults to {}
    let project_id = app.create_project("auto-push-test").await;
    let resp = app.send(get(&format!("/v1/{project_id}"))).await;
    assert_eq!(resp.status, StatusCode::OK);
    // auto_push absent → consumers should default to true
    assert!(
        resp.json["metadata"]["auto_push"].is_null(),
        "auto_push should be absent on fresh project"
    );

    // 2. Set auto_push = false via metadata update
    let resp = app
        .send(put_json(
            &format!("/v1/{project_id}"),
            serde_json::json!({ "metadata": { "auto_push": false } }),
        ))
        .await;
    assert_eq!(
        resp.status,
        StatusCode::OK,
        "update metadata: {}",
        resp.json
    );
    assert_eq!(
        resp.json["metadata"]["auto_push"], false,
        "auto_push should be false after update"
    );

    // 3. Read back — value persists
    let resp = app.send(get(&format!("/v1/{project_id}"))).await;
    assert_eq!(resp.status, StatusCode::OK);
    assert_eq!(
        resp.json["metadata"]["auto_push"], false,
        "auto_push should persist on re-read"
    );

    // 4. Update another field without providing metadata — metadata preserved
    let resp = app
        .send(put_json(
            &format!("/v1/{project_id}"),
            serde_json::json!({ "name": "auto-push-renamed" }),
        ))
        .await;
    assert_eq!(resp.status, StatusCode::OK);
    assert_eq!(
        resp.json["metadata"]["auto_push"], false,
        "metadata preserved when updating unrelated field"
    );

    // 5. Toggle auto_push back to true
    let resp = app
        .send(put_json(
            &format!("/v1/{project_id}"),
            serde_json::json!({ "metadata": { "auto_push": true } }),
        ))
        .await;
    assert_eq!(resp.status, StatusCode::OK);
    assert_eq!(
        resp.json["metadata"]["auto_push"], true,
        "auto_push should be true after toggle"
    );

    app.cleanup().await;
}

/// Validates that auto_push can coexist with other metadata keys without
/// overwriting them, as long as the client sends the full metadata object.
#[tokio::test]
async fn project_metadata_auto_push_coexists_with_other_keys() {
    let app = require_db!();
    let project_id = app.create_project("meta-coexist").await;

    // Set metadata with auto_push + a custom key
    let resp = app
        .send(put_json(
            &format!("/v1/{project_id}"),
            serde_json::json!({
                "metadata": { "auto_push": false, "custom_setting": "hello" }
            }),
        ))
        .await;
    assert_eq!(resp.status, StatusCode::OK);
    assert_eq!(resp.json["metadata"]["auto_push"], false);
    assert_eq!(resp.json["metadata"]["custom_setting"], "hello");

    // Client sends updated metadata preserving both keys
    let resp = app
        .send(put_json(
            &format!("/v1/{project_id}"),
            serde_json::json!({
                "metadata": { "auto_push": true, "custom_setting": "hello" }
            }),
        ))
        .await;
    assert_eq!(resp.status, StatusCode::OK);
    assert_eq!(
        resp.json["metadata"]["auto_push"], true,
        "auto_push toggled"
    );
    assert_eq!(
        resp.json["metadata"]["custom_setting"], "hello",
        "custom_setting preserved"
    );

    app.cleanup().await;
}

/// Debt #2: the canonical resource path is /v1/projects, not the
/// historical bare /v1 root. This test pins both forms working so
/// future refactors can't silently break either.
#[tokio::test]
async fn projects_canonical_and_legacy_paths_both_work() {
    use crate::harness::{get, post_json};
    use axum::http::StatusCode;

    let app = require_db!();

    // Create via the canonical path.
    let r = app
        .send(post_json(
            "/v1/projects",
            serde_json::json!({ "name": "debt2-canonical" }),
        ))
        .await;
    assert_eq!(
        r.status,
        StatusCode::CREATED,
        "canonical create: {}",
        r.json
    );
    let canonical_id = r.json["id"].as_str().unwrap().to_string();

    // Fetch the same project via the canonical /projects/{id}.
    let r = app.send(get(&format!("/v1/projects/{canonical_id}"))).await;
    assert_eq!(r.status, StatusCode::OK, "canonical get: {}", r.json);
    assert_eq!(r.json["name"], "debt2-canonical");

    // Legacy /v1/{id} still works (back-compat for orchestra/tui/web).
    let r = app.send(get(&format!("/v1/{canonical_id}"))).await;
    assert_eq!(r.status, StatusCode::OK, "legacy get: {}", r.json);
    assert_eq!(r.json["id"].as_str().unwrap(), canonical_id);

    // List via canonical path.
    let r = app.send(get("/v1/projects")).await;
    assert_eq!(r.status, StatusCode::OK);
    let names: Vec<String> = r.json["projects"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|p| p["name"].as_str().map(str::to_string))
        .collect();
    assert!(names.contains(&"debt2-canonical".to_string()));

    app.cleanup().await;
}
