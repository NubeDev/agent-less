//! Integration tests for the QA item routes (SoW-1).
//!
//! Walks a task through the human-answer flow: create QA, list pending,
//! POST answer, assert the task transitioned and the QA row is resolved.

use axum::http::StatusCode;
use serde_json::json;

use crate::harness::{get, post_json};

#[tokio::test]
async fn qa_answer_resumes_step() {
    let app = require_db!();
    let project_id = app.create_project("qa-answer").await;
    let agent_id = app.create_agent("worker").await;

    // backlog → ready → implement → ai_review
    let task = app.create_task(project_id, "Needs answer").await;
    let task_id = task["id"].as_str().unwrap();

    app.send(post_json(
        &format!("/v1/tasks/{task_id}/transition"),
        json!({ "state": "ready" }),
    ))
    .await;
    app.send(post_json(
        &format!("/v1/tasks/{task_id}/claim"),
        json!({ "agent_id": agent_id }),
    ))
    .await;
    let r = app
        .send(post_json(
            &format!("/v1/tasks/{task_id}/transition"),
            json!({ "state": "ai_review" }),
        ))
        .await;
    assert_eq!(
        r.status,
        StatusCode::OK,
        "implement → ai_review: {}",
        r.json
    );

    // Insert a QA item directly through the DB to mimic what the worker
    // does after sentinel detection. (The orchestra hook lives in SoW-1
    // BLOCK G; this test exercises the API surface.)
    let task_uuid: uuid::Uuid = task_id.parse().unwrap();
    let qa_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO diraigent.task_qa_item
             (task_id, project_id, step_name, kind, prompt, responder)
         VALUES ($1, $2, 'implement', 'question', 'postgres or sqlite?', 'human')
         RETURNING id",
    )
    .bind(task_uuid)
    .bind(project_id)
    .fetch_one(&app.pool)
    .await
    .expect("insert qa item");

    // List pending → should include our item.
    let r = app.send(get("/v1/qa?status=pending")).await;
    assert_eq!(r.status, StatusCode::OK);
    let items = r.json.as_array().expect("array");
    assert!(
        items
            .iter()
            .any(|i| i["id"].as_str().unwrap() == qa_id.to_string())
    );

    // Answer → transition back to implement.
    let r = app
        .send(post_json(
            &format!("/v1/qa/{qa_id}/answer"),
            json!({ "answer": "postgres", "target_step": "implement" }),
        ))
        .await;
    assert_eq!(r.status, StatusCode::OK, "answer qa: {}", r.json);
    assert_eq!(r.json["status"].as_str().unwrap(), "resolved");
    assert_eq!(r.json["answer"].as_str().unwrap(), "postgres");

    // Verify task transitioned.
    let r = app.send(get(&format!("/v1/tasks/{task_id}"))).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json["state"].as_str().unwrap(), "implement");

    // Second answer attempt fails (already resolved).
    let r = app
        .send(post_json(
            &format!("/v1/qa/{qa_id}/answer"),
            json!({ "answer": "sqlite", "target_step": "implement" }),
        ))
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);

    app.cleanup().await;
}

#[tokio::test]
async fn qa_answer_rejects_invalid_transition() {
    let app = require_db!();
    let project_id = app.create_project("qa-invalid").await;
    let agent_id = app.create_agent("worker2").await;

    let task = app.create_task(project_id, "Invalid").await;
    let task_id = task["id"].as_str().unwrap();
    app.send(post_json(
        &format!("/v1/tasks/{task_id}/transition"),
        json!({ "state": "ready" }),
    ))
    .await;
    app.send(post_json(
        &format!("/v1/tasks/{task_id}/claim"),
        json!({ "agent_id": agent_id }),
    ))
    .await;
    app.send(post_json(
        &format!("/v1/tasks/{task_id}/transition"),
        json!({ "state": "ai_review" }),
    ))
    .await;

    let task_uuid: uuid::Uuid = task_id.parse().unwrap();
    let qa_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO diraigent.task_qa_item
             (task_id, project_id, step_name, prompt, responder)
         VALUES ($1, $2, 'implement', 'q?', 'human')
         RETURNING id",
    )
    .bind(task_uuid)
    .bind(project_id)
    .fetch_one(&app.pool)
    .await
    .unwrap();

    // ai_review → done is forbidden per state machine.
    let r = app
        .send(post_json(
            &format!("/v1/qa/{qa_id}/answer"),
            json!({ "answer": "x", "target_step": "done" }),
        ))
        .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);

    app.cleanup().await;
}

/// SoW-3: the `handover` kind must be accepted by the
/// `task_update_kind_check` CHECK constraint added in migration 048.
/// This test exists primarily as a smoke check that the migration ran
/// and that downstream readers (e.g. the orchestra prompt builder) can
/// observe handover rows alongside other task_update kinds.
#[tokio::test]
async fn task_update_accepts_handover_kind() {
    let app = require_db!();
    let project_id = app.create_project("handover-kind").await;
    let task = app.create_task(project_id, "handover smoke").await;
    let task_id: uuid::Uuid = task["id"].as_str().unwrap().parse().unwrap();

    let id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO diraigent.task_update (task_id, kind, content)
         VALUES ($1, 'handover', 'from_step: implement\n\nshipped foo')
         RETURNING id",
    )
    .bind(task_id)
    .fetch_one(&app.pool)
    .await
    .expect("insert handover row");

    let row: (String, String) = sqlx::query_as(
        "SELECT kind, content FROM diraigent.task_update WHERE id = $1",
    )
    .bind(id)
    .fetch_one(&app.pool)
    .await
    .expect("read back");
    assert_eq!(row.0, "handover");
    assert!(row.1.contains("shipped foo"));

    app.cleanup().await;
}
