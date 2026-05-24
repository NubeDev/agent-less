import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { OAuthService } from 'angular-oauth2-oidc';
import { Observable, Subject, firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../core/services/auth.service';

/**
 * Server-pushed per-task event. The `kind` field is set by the
 * `#[serde(tag = "kind")]` attribute on `TaskStreamEvent` in
 * `apps/api/src/routes/sse.rs`.
 */
export type TaskStreamEvent =
  | {
      kind: 'task_updated';
      task_id: string;
      state: string;
      playbook_step: number | null;
      updated_at: string;
      cost_usd: number;
      input_tokens: number;
      output_tokens: number;
    }
  | { kind: 'qa_updated'; qa_id: string; status: string; step_name: string }
  | { kind: 'report_updated'; report_id: string; status: string }
  | {
      kind: 'log_added';
      log_id: string;
      step_name: string;
      created_at: string;
    };

/**
 * SSE client for the per-task live update stream
 * (`GET /v1/tasks/{taskId}/stream`).
 *
 * Mirrors the ticket-exchange pattern used by
 * `ReviewSseService`/`AgentStatusSseService`: a short-lived ticket is fetched
 * with the Bearer JWT, then the EventSource opens with `?ticket=…` so the
 * raw JWT never appears in URLs or proxy logs.
 *
 * Use {@link connect} to open a connection for a specific task; the returned
 * `unsubscribe()` closes the EventSource. Reconnect with exponential
 * back-off (max 30 s) is applied automatically on transport errors.
 */
@Injectable({ providedIn: 'root' })
export class TaskStreamService {
  private oauth = inject(OAuthService);
  private http = inject(HttpClient);
  private auth = inject(AuthService);

  /**
   * Open an SSE connection for `taskId`. Returns an observable of events
   * and a disposer; the caller must call `unsubscribe()` (or simply
   * unsubscribe the returned Observable) on component destroy.
   */
  connect(taskId: string): { events$: Observable<TaskStreamEvent>; unsubscribe: () => void } {
    const subject = new Subject<TaskStreamEvent>();
    let es: EventSource | null = null;
    let retryMs = 2_000;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const open = async () => {
      if (closed) return;
      const base = environment.apiServer;

      // Mock/dev mode: auth disabled → don't bother connecting.
      if (this.auth.isAuthDisabled()) return;

      let ticket: string | null = null;
      try {
        const token = this.oauth.getAccessToken();
        if (token) {
          const resp = await firstValueFrom(
            this.http.post<{ ticket: string }>(
              `${base}/tasks/${taskId}/stream/ticket`,
              null,
              { headers: { Authorization: `Bearer ${token}` } },
            ),
          );
          ticket = resp.ticket;
        }
      } catch {
        scheduleReconnect();
        return;
      }
      if (!ticket) return;

      const url = `${base}/tasks/${taskId}/stream?ticket=${encodeURIComponent(ticket)}`;
      es = new EventSource(url);

      es.addEventListener('task_update', (e: MessageEvent) => {
        try {
          subject.next(JSON.parse(e.data) as TaskStreamEvent);
        } catch {
          // Malformed payload — ignore.
        }
        retryMs = 2_000;
      });

      es.addEventListener('error', () => {
        es?.close();
        es = null;
        scheduleReconnect();
      });
    };

    const scheduleReconnect = () => {
      if (closed || retryTimer) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        retryMs = Math.min(retryMs * 2, 30_000);
        void open();
      }, retryMs);
    };

    void open();

    return {
      events$: subject.asObservable(),
      unsubscribe: () => {
        closed = true;
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
        if (es) {
          es.close();
          es = null;
        }
        subject.complete();
      },
    };
  }
}
