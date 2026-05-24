//! Debt #3 (SCOPE.md): NEW-TASK.md flagged `POST /v1/members` returning
//! 500 because the `ON CONFLICT (tenant_id, agent_id, role_id)` clause
//! didn't match a real unique constraint. Migration 042 added the
//! `membership_tenant_agent_role_key` UNIQUE constraint, which lines
//! up with the repository SQL.
//!
//! This test re-pins the upsert path so a future migration drop or
//! repo edit that desyncs the constraint fails loudly instead of
//! silently 500-ing in production.

use uuid::Uuid;

#[tokio::test]
async fn create_membership_upserts_on_duplicate() {
    let app = require_db!();

    // Seed: an agent, a role, a tenant. We do this directly via the
    // admin pool so we don't depend on the higher-level CRUD routes.
    let tenant_id: Uuid =
        sqlx::query_scalar("INSERT INTO diraigent.tenant (name) VALUES ($1) RETURNING id")
            .bind("debt3-tenant")
            .fetch_one(&app.pool)
            .await
            .unwrap();

    let agent_id: Uuid = sqlx::query_scalar(
        "INSERT INTO diraigent.agent (tenant_id, name) VALUES ($1, $2) RETURNING id",
    )
    .bind(tenant_id)
    .bind("debt3-agent")
    .fetch_one(&app.pool)
    .await
    .unwrap();

    let role_id: Uuid = sqlx::query_scalar(
        "INSERT INTO diraigent.role (tenant_id, name) VALUES ($1, $2) RETURNING id",
    )
    .bind(tenant_id)
    .bind("debt3-role")
    .fetch_one(&app.pool)
    .await
    .unwrap();

    let req = diraigent_api::models::CreateMembership {
        agent_id,
        role_id,
        config: None,
    };

    // First create: inserts a new row.
    let m1 = diraigent_api::repository::create_membership(&app.pool, tenant_id, &req)
        .await
        .expect("first create_membership");

    // Second create with the same (tenant, agent, role): must hit
    // ON CONFLICT DO UPDATE and return the same id. If the unique
    // constraint or clause ever desync, sqlx returns 23P01-ish and
    // this assert blows up.
    let m2 = diraigent_api::repository::create_membership(&app.pool, tenant_id, &req)
        .await
        .expect("second create_membership (upsert)");

    assert_eq!(m1.id, m2.id, "upsert must reuse the same membership row");
    assert!(
        m2.updated_at >= m1.updated_at,
        "updated_at must advance on upsert"
    );

    app.cleanup().await;
}
