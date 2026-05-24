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

/// SoW-4 outcome: creating an observation that points back at a
/// source_task_id stamps that task's resolved QAs as
/// `resolved_followup`. Pending QAs are untouched.
#[tokio::test]
async fn qa_outcome_followup_via_observation() {
    let app = require_db!();
    let project_id = app.create_project("qa-followup").await;

    let task = app.create_task(project_id, "had a qa").await;
    let task_id = task["id"].as_str().unwrap();
    let task_uuid: uuid::Uuid = task_id.parse().unwrap();

    let resolved_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO diraigent.task_qa_item
             (task_id, project_id, step_name, kind, prompt, responder,
              status, answered_at, answer)
         VALUES ($1, $2, 'implement', 'question', 'q1?', 'ai',
                 'resolved', now(), 'yes')
         RETURNING id",
    )
    .bind(task_uuid)
    .bind(project_id)
    .fetch_one(&app.pool)
    .await
    .unwrap();

    let pending_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO diraigent.task_qa_item
             (task_id, project_id, step_name, kind, prompt, responder)
         VALUES ($1, $2, 'implement', 'question', 'q2?', 'human')
         RETURNING id",
    )
    .bind(task_uuid)
    .bind(project_id)
    .fetch_one(&app.pool)
    .await
    .unwrap();

    let r = app
        .send(post_json(
            &format!("/v1/projects/{project_id}/observations"),
            json!({
                "title": "regression spotted",
                "source_task_id": task_id,
            }),
        ))
        .await;
    assert_eq!(r.status, StatusCode::OK, "create obs: {}", r.json);

    let resolved_outcome: (String,) =
        sqlx::query_as("SELECT outcome FROM diraigent.task_qa_item WHERE id = $1")
            .bind(resolved_id)
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert_eq!(resolved_outcome.0, "resolved_followup");

    let pending_outcome: (String,) =
        sqlx::query_as("SELECT outcome FROM diraigent.task_qa_item WHERE id = $1")
            .bind(pending_id)
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert_eq!(pending_outcome.0, "unknown", "pending QAs are not stamped");

    // Idempotency: outcome already set, second observation must not
    // overwrite (e.g. a later revert would still be 'resolved_followup'
    // because first-decisive-signal wins).
    let r2 = app
        .send(post_json(
            &format!("/v1/projects/{project_id}/observations"),
            json!({
                "title": "another follow-up",
                "source_task_id": task_id,
            }),
        ))
        .await;
    assert_eq!(r2.status, StatusCode::OK);
    let still: (String,) =
        sqlx::query_as("SELECT outcome FROM diraigent.task_qa_item WHERE id = $1")
            .bind(resolved_id)
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert_eq!(still.0, "resolved_followup");

    app.cleanup().await;
}

/// SoW-4 clean sweeper: resolved QAs on a task that has been `done`
/// for at least `min_age_days` are stamped `resolved_clean`. Reverted
/// tasks, in-flight tasks, and already-stamped QAs are left alone.
#[tokio::test]
async fn qa_outcome_sweep_clean() {
    let app = require_db!();
    let project_id = app.create_project("qa-clean").await;

    // Task A: done, old enough → should flip.
    let task_a = app.create_task(project_id, "done long ago").await;
    let task_a_uuid: uuid::Uuid = task_a["id"].as_str().unwrap().parse().unwrap();
    sqlx::query(
        "UPDATE diraigent.task
            SET state = 'done', updated_at = now() - interval '30 days'
          WHERE id = $1",
    )
    .bind(task_a_uuid)
    .execute(&app.pool)
    .await
    .unwrap();
    let qa_a: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO diraigent.task_qa_item
             (task_id, project_id, step_name, kind, prompt, responder,
              status, answered_at, answer)
         VALUES ($1, $2, 'implement', 'question', 'a?', 'ai',
                 'resolved', now() - interval '30 days', 'yes')
         RETURNING id",
    )
    .bind(task_a_uuid)
    .bind(project_id)
    .fetch_one(&app.pool)
    .await
    .unwrap();

    // Task B: done but reverted → must NOT flip.
    let task_b = app.create_task(project_id, "reverted").await;
    let task_b_uuid: uuid::Uuid = task_b["id"].as_str().unwrap().parse().unwrap();
    sqlx::query(
        "UPDATE diraigent.task
            SET state = 'done', reverted_at = now(), updated_at = now() - interval '30 days'
          WHERE id = $1",
    )
    .bind(task_b_uuid)
    .execute(&app.pool)
    .await
    .unwrap();
    let qa_b: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO diraigent.task_qa_item
             (task_id, project_id, step_name, kind, prompt, responder,
              status, answered_at, answer)
         VALUES ($1, $2, 'implement', 'question', 'b?', 'ai',
                 'resolved', now() - interval '30 days', 'yes')
         RETURNING id",
    )
    .bind(task_b_uuid)
    .bind(project_id)
    .fetch_one(&app.pool)
    .await
    .unwrap();

    // Task C: still in flight (backlog) → must NOT flip.
    let task_c = app.create_task(project_id, "in flight").await;
    let task_c_uuid: uuid::Uuid = task_c["id"].as_str().unwrap().parse().unwrap();
    let qa_c: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO diraigent.task_qa_item
             (task_id, project_id, step_name, kind, prompt, responder,
              status, answered_at, answer)
         VALUES ($1, $2, 'implement', 'question', 'c?', 'ai',
                 'resolved', now(), 'yes')
         RETURNING id",
    )
    .bind(task_c_uuid)
    .bind(project_id)
    .fetch_one(&app.pool)
    .await
    .unwrap();

    let r = app
        .send(post_json("/v1/qa/sweep-clean?min_age_days=7", json!({})))
        .await;
    assert_eq!(r.status, StatusCode::OK, "sweep-clean: {}", r.json);
    let updated = r.json["updated"].as_u64().unwrap();
    assert!(updated >= 1, "expected at least one QA stamped clean");

    let outcome = |id: uuid::Uuid| {
        let pool = app.pool.clone();
        async move {
            let row: (String,) =
                sqlx::query_as("SELECT outcome FROM diraigent.task_qa_item WHERE id = $1")
                    .bind(id)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            row.0
        }
    };

    assert_eq!(outcome(qa_a).await, "resolved_clean");
    assert_eq!(outcome(qa_b).await, "unknown", "reverted must not flip");
    assert_eq!(outcome(qa_c).await, "unknown", "in-flight must not flip");

    // Idempotency: second call updates nothing new for these rows.
    let qa_a_before = outcome(qa_a).await;
    let r2 = app
        .send(post_json("/v1/qa/sweep-clean?min_age_days=7", json!({})))
        .await;
    assert_eq!(r2.status, StatusCode::OK);
    assert_eq!(outcome(qa_a).await, qa_a_before);

    app.cleanup().await;
}

/// SoW gap #9: cancelling a task must cascade still-pending QA items
/// to `resolved` with a cancellation marker. Already-answered items
/// must be left exactly as they were. Idempotent.
#[tokio::test]
async fn qa_cancelled_task_cascades_pending_to_resolved() {
    let app = require_db!();
    let project_id = app.create_project("qa-cancel").await;
    let task = app.create_task(project_id, "to be cancelled").await;
    let task_id = task["id"].as_str().unwrap();
    let task_uuid: uuid::Uuid = task_id.parse().unwrap();

    // Pending QA (human-targeted, no expiry) — should be cascaded.
    let pending: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO diraigent.task_qa_item
             (task_id, project_id, step_name, kind, prompt, responder)
         VALUES ($1, $2, 'implement', 'question', 'a?', 'human')
         RETURNING id",
    )
    .bind(task_uuid)
    .bind(project_id)
    .fetch_one(&app.pool)
    .await
    .unwrap();

    // Already-resolved QA — must remain untouched (answer + outcome).
    let resolved: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO diraigent.task_qa_item
             (task_id, project_id, step_name, kind, prompt, responder,
              status, answer, answered_at, resolved_at, outcome)
         VALUES ($1, $2, 'implement', 'question', 'b?', 'ai',
                 'resolved', 'yes', now(), now(), 'resolved_clean')
         RETURNING id",
    )
    .bind(task_uuid)
    .bind(project_id)
    .fetch_one(&app.pool)
    .await
    .unwrap();

    // Cancel the task — backlog → cancelled is a valid transition.
    let r = app
        .send(post_json(
            &format!("/v1/tasks/{task_id}/transition"),
            json!({ "state": "cancelled" }),
        ))
        .await;
    assert_eq!(r.status, StatusCode::OK, "cancel: {}", r.json);

    // Pending should now be resolved with the cancellation marker.
    let (status, answer, outcome, meta): (String, Option<String>, String, serde_json::Value) =
        sqlx::query_as(
            "SELECT status, answer, outcome, metadata
             FROM diraigent.task_qa_item WHERE id = $1",
        )
        .bind(pending)
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(status, "resolved");
    assert!(
        answer.unwrap_or_default().contains("cancelled"),
        "cancelled-marker answer expected"
    );
    assert_eq!(meta["cancellation_reason"].as_str(), Some("task_cancelled"));
    // Outcome stays 'unknown' — cancellation gives no SoW-4 signal.
    assert_eq!(outcome, "unknown");

    // Already-resolved row must be byte-for-byte unchanged.
    let (status, answer, outcome): (String, Option<String>, String) =
        sqlx::query_as("SELECT status, answer, outcome FROM diraigent.task_qa_item WHERE id = $1")
            .bind(resolved)
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert_eq!(status, "resolved");
    assert_eq!(answer.as_deref(), Some("yes"));
    assert_eq!(outcome, "resolved_clean");

    // Idempotency: re-cancelling (cancelled → backlog → cancelled) must
    // be a no-op — the pending row already moved to resolved.
    let _ = app
        .send(post_json(
            &format!("/v1/tasks/{task_id}/transition"),
            json!({ "state": "backlog" }),
        ))
        .await;
    let _ = app
        .send(post_json(
            &format!("/v1/tasks/{task_id}/transition"),
            json!({ "state": "cancelled" }),
        ))
        .await;
    let still: (String,) =
        sqlx::query_as("SELECT status FROM diraigent.task_qa_item WHERE id = $1")
            .bind(pending)
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert_eq!(still.0, "resolved");

    app.cleanup().await;
}
