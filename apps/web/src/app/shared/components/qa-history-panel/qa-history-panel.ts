import { Component, EventEmitter, Input, Output, computed, signal } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import type { SpQaItem } from '../../../core/services/qa-api.service';

/**
 * Shared QA history panel. Used by:
 * - UI-5 advanced job detail (`/advanced/:id`).
 * - UI-6 Review Queue refresh (inline answer UI for both `ai_review` and
 *   `human_review` items).
 *
 * Pure presentational + answer-submit emitter — the parent owns the
 * API call. This avoids two screens diverging on how confidence,
 * accept mode, and outcome are rendered.
 *
 * Plaintext rendering only (per IMPROVEMENT.md §4 injection hygiene):
 * the QA prompt and answer body are bound with `{{ ... }}` (Angular
 * escapes), never `[innerHTML]`. No auto-linkification.
 */
@Component({
  selector: 'app-qa-history-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, DatePipe],
  template: `
    <section class="space-y-3" data-testid="qa-history-panel">
      <h2 class="text-sm font-semibold text-text-secondary uppercase tracking-wide">
        QA history
      </h2>

      @if (pending().length > 0) {
        <div class="space-y-2">
          @for (qa of pending(); track qa.id) {
            <div class="p-3 rounded-lg border border-ctp-yellow/40 bg-ctp-yellow/5"
                 [attr.data-testid]="'qa-pending-' + qa.id">
              <div class="flex items-center justify-between mb-2 text-xs">
                <span class="text-ctp-yellow font-semibold uppercase tracking-wide">
                  Pending — {{ qa.step_name }} · {{ qa.responder }}
                </span>
                <span class="text-text-secondary">{{ qa.created_at | date:'short' }}</span>
              </div>
              <!-- Plaintext only — never innerHTML -->
              <p class="text-text-primary whitespace-pre-wrap break-words mb-3">{{ qa.prompt }}</p>

              @if (qa.options && qa.options.length > 0) {
                <div class="flex flex-wrap gap-2">
                  @for (opt of qa.options; track opt) {
                    <button type="button" (click)="onAnswer(qa, opt)"
                            [disabled]="submitting() === qa.id"
                            class="px-3 py-1 text-sm rounded border border-border bg-bg
                                   hover:bg-surface-hover disabled:opacity-50">
                      {{ opt }}
                    </button>
                  }
                </div>
              } @else {
                <textarea [(ngModel)]="drafts[qa.id]" rows="3"
                          placeholder="Your answer (plaintext)"
                          class="w-full px-2 py-1.5 rounded border border-border bg-bg text-text-primary
                                 focus:outline-none focus:ring-1 focus:ring-accent text-sm"></textarea>
                <div class="mt-2 flex justify-end">
                  <button type="button" (click)="onAnswer(qa, drafts[qa.id] ?? '')"
                          [disabled]="submitting() === qa.id || !(drafts[qa.id] ?? '').trim()"
                          class="px-3 py-1.5 text-sm rounded bg-accent text-white font-medium
                                 disabled:opacity-50 hover:opacity-90">
                    {{ submitting() === qa.id ? 'Submitting…' : 'Submit answer' }}
                  </button>
                </div>
              }
            </div>
          }
        </div>
      }

      @if (history().length > 0) {
        <div class="space-y-1.5">
          @for (qa of history(); track qa.id) {
            <details class="rounded-lg border border-border bg-bg-subtle"
                     [attr.data-testid]="'qa-history-' + qa.id">
              <summary class="cursor-pointer px-3 py-2 text-xs flex items-center gap-2 flex-wrap">
                <span class="font-mono text-text-secondary">{{ qa.step_name }}</span>
                <span class="px-1.5 py-0.5 rounded text-[10px] uppercase"
                      [class]="statusClasses(qa.status)">{{ qa.status }}</span>
                <span class="px-1.5 py-0.5 rounded bg-overlay-1/15 text-text-secondary text-[10px]">
                  by {{ qa.responder }}
                </span>
                @let conf = confidence(qa);
                @if (conf !== null) {
                  <span class="px-1.5 py-0.5 rounded text-[10px]"
                        [class]="confidenceClasses(conf)">
                    conf={{ conf.toFixed(2) }}
                  </span>
                }
                @let acceptMode = acceptMode(qa);
                @if (acceptMode) {
                  <span class="px-1.5 py-0.5 rounded bg-ctp-blue/15 text-ctp-blue text-[10px]">
                    {{ acceptMode }}
                  </span>
                }
                @if (qa.outcome && qa.outcome !== 'unknown') {
                  <span class="px-1.5 py-0.5 rounded text-[10px]"
                        [class]="outcomeClasses(qa.outcome)">
                    {{ qa.outcome }}
                  </span>
                }
                <span class="ml-auto text-text-secondary">{{ qa.created_at | date:'short' }}</span>
              </summary>
              <div class="px-3 pb-3 space-y-2 text-sm">
                <div>
                  <p class="text-xs text-text-secondary mb-0.5">Prompt</p>
                  <p class="text-text-primary whitespace-pre-wrap break-words">{{ qa.prompt }}</p>
                </div>
                @if (qa.answer) {
                  <div>
                    <p class="text-xs text-text-secondary mb-0.5">
                      Answer @if (qa.answered_by) { <span>· {{ qa.answered_by }}</span> }
                    </p>
                    <p class="text-text-primary whitespace-pre-wrap break-words">{{ qa.answer }}</p>
                  </div>
                }
              </div>
            </details>
          }
        </div>
      }

      @if (pending().length === 0 && history().length === 0) {
        <p class="text-sm text-text-secondary">No QA items.</p>
      }
    </section>
  `,
})
export class QaHistoryPanelComponent {
  @Input() set items(v: SpQaItem[]) {
    this._items.set(v ?? []);
  }
  @Output() answer = new EventEmitter<{ qa: SpQaItem; answer: string }>();

  private readonly _items = signal<SpQaItem[]>([]);
  readonly submitting = signal<string | null>(null);
  drafts: Record<string, string> = {};

  readonly pending = computed(() => this._items().filter(q => q.status === 'pending'));
  readonly history = computed(() =>
    this._items()
      .filter(q => q.status !== 'pending')
      .slice()
      .sort((a, b) => b.created_at.localeCompare(a.created_at)),
  );

  /** Pull confidence out of metadata (`metadata.confidence` per SoW-2). */
  confidence(qa: SpQaItem): number | null {
    const v = (qa.metadata as Record<string, unknown>)?.['confidence'];
    return typeof v === 'number' ? v : null;
  }

  /** Pull accept mode out of metadata (`metadata.accept_mode` per SoW-2). */
  acceptMode(qa: SpQaItem): string | null {
    const v = (qa.metadata as Record<string, unknown>)?.['accept_mode'];
    return typeof v === 'string' ? v : null;
  }

  statusClasses(status: string): string {
    switch (status) {
      case 'resolved': return 'bg-ctp-green/15 text-ctp-green';
      case 'answered': return 'bg-ctp-blue/15 text-ctp-blue';
      case 'escalated': return 'bg-ctp-yellow/15 text-ctp-yellow';
      case 'expired': return 'bg-ctp-red/15 text-ctp-red';
      default: return 'bg-overlay-1/15 text-text-secondary';
    }
  }

  confidenceClasses(c: number): string {
    if (c >= 0.85) return 'bg-ctp-green/15 text-ctp-green';
    if (c >= 0.7) return 'bg-ctp-yellow/15 text-ctp-yellow';
    return 'bg-ctp-red/15 text-ctp-red';
  }

  outcomeClasses(outcome: string): string {
    switch (outcome) {
      case 'resolved_clean': return 'bg-ctp-green/15 text-ctp-green';
      case 'resolved_followup': return 'bg-ctp-yellow/15 text-ctp-yellow';
      case 'resolved_reverted': return 'bg-ctp-red/15 text-ctp-red';
      default: return 'bg-overlay-1/15 text-text-secondary';
    }
  }

  onAnswer(qa: SpQaItem, raw: string): void {
    const answer = (raw ?? '').trim();
    if (!answer) return;
    this.submitting.set(qa.id);
    this.answer.emit({ qa, answer });
    // Parent calls `clearSubmitting` via @Input change when done; if
    // it doesn't, we self-clear after a short window so the UI never
    // gets stuck.
    setTimeout(() => {
      if (this.submitting() === qa.id) this.submitting.set(null);
    }, 5000);
  }
}
