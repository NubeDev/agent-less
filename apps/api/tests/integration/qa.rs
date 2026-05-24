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

/// SoW-2 BLOCK F: the sweeper escalates pending AI-targeted QA items
/// whose `expires_at` has elapsed, transitions the task from
/// `ai_review` to `human_review`, and ignores human-targeted items.
#[tokio::test]
async fn qa_sweep_escalates_expired_ai_items() {
    let app = require_db!();
    let project_id = app.create_project("qa-sweep").await;
    let agent_id = app.create_agent("worker-sweep").await;

    // Drive a task to ai_review.
    let task = app.create_task(project_id, "Will time out").await;
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

    // (1) Expired AI item — sweeper should escalate.
    let expired_ai: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO diraigent.task_qa_item
             (task_id, project_id, step_name, kind, prompt, responder, expires_at)
         VALUES ($1, $2, 'implement', 'question', 'a?', 'ai', now() - interval '5 seconds')
         RETURNING id",
    )
    .bind(task_uuid)
    .bind(project_id)
    .fetch_one(&app.pool)
    .await
    .unwrap();

    // (2) Future AI item — sweeper must not touch.
    let future_ai: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO diraigent.task_qa_item
             (task_id, project_id, step_name, kind, prompt, responder, expires_at)
         VALUES ($1, $2, 'implement', 'question', 'b?', 'ai', now() + interval '5 minutes')
         RETURNING id",
    )
    .bind(task_uuid)
    .bind(project_id)
    .fetch_one(&app.pool)
    .await
    .unwrap();

    // (3) Expired *human* item — sweeper must never auto-cancel human QAs.
    let expired_human: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO diraigent.task_qa_item
             (task_id, project_id, step_name, kind, prompt, responder, expires_at)
         VALUES ($1, $2, 'implement', 'question', 'c?', 'human', now() - interval '5 seconds')
         RETURNING id",
    )
    .bind(task_uuid)
    .bind(project_id)
    .fetch_one(&app.pool)
    .await
    .unwrap();

    // Invoke the sweeper.
    let r = app.send(post_json("/v1/qa/sweep-expired", json!({}))).await;
    assert_eq!(r.status, StatusCode::OK, "sweep: {}", r.json);
    let escalated = r.json.as_array().expect("array");
    let escalated_ids: Vec<String> = escalated
        .iter()
        .map(|i| i["id"].as_str().unwrap().to_string())
        .collect();
    assert!(
        escalated_ids.contains(&expired_ai.to_string()),
        "expected {expired_ai} in {escalated_ids:?}"
    );
    assert!(
        !escalated_ids.contains(&future_ai.to_string()),
        "future_ai must not be escalated yet"
    );
    assert!(
        !escalated_ids.contains(&expired_human.to_string()),
        "expired_human must never be auto-escalated"
    );

    // Expired AI item is now `escalated`; future AI is still pending;
    // human is still pending.
    for (id, expected_status) in [
        (expired_ai, "escalated"),
        (future_ai, "pending"),
        (expired_human, "pending"),
    ] {
        let row: (String,) =
            sqlx::query_as("SELECT status FROM diraigent.task_qa_item WHERE id = $1")
                .bind(id)
                .fetch_one(&app.pool)
                .await
                .unwrap();
        assert_eq!(row.0, expected_status, "{id} status");
    }

    // Task should have moved from ai_review to human_review.
    let r = app.send(get(&format!("/v1/tasks/{task_id}"))).await;
    assert_eq!(r.json["state"].as_str().unwrap(), "human_review");

    // Idempotency: second sweep returns no fresh escalations.
    let r = app.send(post_json("/v1/qa/sweep-expired", json!({}))).await;
    assert_eq!(r.json.as_array().unwrap().len(), 0);

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

    let row: (String, String) =
        sqlx::query_as("SELECT kind, content FROM diraigent.task_update WHERE id = $1")
            .bind(id)
            .fetch_one(&app.pool)
            .await
            .expect("read back");
    assert_eq!(row.0, "handover");
    assert!(row.1.contains("shipped foo"));

    app.cleanup().await;
}
