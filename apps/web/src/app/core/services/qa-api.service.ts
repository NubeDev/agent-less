import { Injectable } from '@angular/core';
import { HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { BaseApiService } from './base-crud-api.service';

/**
 * QA item — see `apps/api/src/models.rs::TaskQaItem`. Mirrors the
 * server-side struct. UI surfaces these in the `/quick` "Pending QA"
 * panel and in the `/quick` "Needs you" group.
 */
export interface SpQaItem {
  id: string;
  task_id: string;
  project_id: string;
  step_name: string;
  /** `freeform` or `choice` — `choice` means `options` is non-null. */
  kind: string;
  prompt: string;
  /** When `kind = 'choice'`, an array of string options. */
  options: string[] | null;
  /** `human` | `ai` | `ai_then_human` — UI shows the prompt either way. */
  responder: string;
  answer: string | null;
  answered_by: string | null;
  /** `pending` | `answered` | `resolved` | `expired`. */
  status: string;
  expires_at: string | null;
  created_at: string;
  answered_at: string | null;
  resolved_at: string | null;
  /** `unknown` | `resolved_clean` | `resolved_reverted` | `resolved_followup`. */
  outcome: string;
  metadata: Record<string, unknown>;
}

export interface QaListFilters {
  status?: string;
  task_id?: string;
  project_id?: string;
  limit?: number;
  offset?: number;
}

export interface AnswerQaRequest {
  /** Free-text or selected-option answer body. Plaintext only. */
  answer: string;
  /** Step to resume into. Must satisfy `can_transition`. */
  target_step: string;
}

/**
 * Thin client around `/v1/qa`. Used by the `/quick` flow only — the
 * legacy dashboard surfaces QA items via the bridged `task_update`
 * (kind=question) rows in the existing review thread.
 */
@Injectable({ providedIn: 'root' })
export class QaApiService extends BaseApiService {
  list(filters?: QaListFilters): Observable<SpQaItem[]> {
    let params = new HttpParams();
    if (filters?.status) params = params.set('status', filters.status);
    if (filters?.task_id) params = params.set('task_id', filters.task_id);
    if (filters?.project_id) params = params.set('project_id', filters.project_id);
    if (filters?.limit != null) params = params.set('limit', filters.limit);
    if (filters?.offset != null) params = params.set('offset', filters.offset);
    return this.http.get<SpQaItem[]>(`${this.baseUrl}/qa`, { params });
  }

  get(id: string): Observable<SpQaItem> {
    return this.http.get<SpQaItem>(`${this.baseUrl}/qa/${id}`);
  }

  answer(id: string, req: AnswerQaRequest): Observable<SpQaItem> {
    return this.http.post<SpQaItem>(`${this.baseUrl}/qa/${id}/answer`, req);
  }
}
