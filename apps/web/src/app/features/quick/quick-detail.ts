import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslocoModule } from '@jsverse/transloco';
import { Subscription, firstValueFrom, interval } from 'rxjs';
import { TasksApiService, SpTask, SpTaskUpdate } from '../../core/services/tasks-api.service';
import { QaApiService, SpQaItem } from '../../core/services/qa-api.service';
import { ReviewSseService } from '../../core/services/review-sse.service';
import { setUiMode } from '../../core/guards/default-route.guard';

/**
 * UI-1 screen 2 — "Job detail".
 *
 * Top: title, state badge, current step, elapsed time, total cost.
 * Body: pending QA panel (if any), latest handover, last update line,
 * diff link, cancel button. No model names, no turn counts, no raw
 * provider output — those live on the legacy task page.
 *
 * Live updates: combine the existing review-stream SSE (for QA
 * `entered`/`left` nudges) with a 4-second polling refresh for task
 * state and the most recent updates. Polling is cheap on /quick because
 * we only look at one task at a time.
 */
@Component({
  selector: 'app-quick-detail',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, TranslocoModule, DatePipe],
  template: `
    <div class="max-w-3xl mx-auto py-6 sm:py-10 px-3" *transloco="let t">
      <div class="mb-4 flex items-center justify-between">
        <a routerLink="/quick" class="text-sm text-text-secondary hover:text-text-primary">
          ← {{ t('quick.backToList') }}
        </a>
        <a routerLink="/dashboard" (click)="flipToAdvanced()"
           class="text-sm text-text-secondary hover:text-text-primary underline decoration-dotted">
          {{ t('quick.advancedLink') }}
        </a>
      </div>

      @if (loadError()) {
        <div class="p-3 rounded-lg bg-ctp-red/10 text-ctp-red text-sm">{{ loadError() }}</div>
      } @else if (!task()) {
        <div class="text-text-secondary">{{ t('quick.loading') }}</div>
      } @else {
        <!-- Header -->
        <div class="mb-5">
          <h1 class="text-2xl font-semibold text-text-primary break-words">{{ task()!.title }}</h1>
          <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-text-secondary">
            <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full"
                  [class]="stateBadgeClasses()">
              <span class="w-1.5 h-1.5 rounded-full" [class]="stateDotClasses()"></span>
              {{ stateLabel() }}
            </span>
            <span>{{ t('quick.elapsed') }}: {{ elapsed() }}</span>
            <span>{{ t('quick.cost') }}: \${{ task()!.cost_usd.toFixed(4) }}</span>
          </div>
        </div>

        <!-- Pending QA panel -->
        @if (pendingQa(); as qa) {
          <section class="mb-6 p-4 rounded-lg border border-ctp-yellow/40 bg-ctp-yellow/5"
                   data-testid="quick-qa-panel">
            <h2 class="text-sm font-semibold text-ctp-yellow uppercase tracking-wide mb-2">
              {{ t('quick.qaTitle') }}
            </h2>
            <!-- Plaintext — never v-html: see IMPROVEMENT.md §4 -->
            <p class="text-text-primary whitespace-pre-wrap break-words mb-3">{{ qa.prompt }}</p>

            @if (qa.options && qa.options.length > 0) {
              <div class="flex flex-wrap gap-2 mb-2">
                @for (opt of qa.options; track opt) {
                  <button type="button" (click)="submitAnswer(qa, opt)"
                          [disabled]="answering()"
                          class="px-3 py-1.5 text-sm rounded-lg border border-border bg-bg-subtle
                                 hover:bg-surface-hover disabled:opacity-50">
                    {{ opt }}
                  </button>
                }
              </div>
            } @else {
              <textarea [(ngModel)]="qaAnswerDraft" rows="3"
                        [placeholder]="t('quick.qaAnswerPlaceholder')"
                        class="w-full px-3 py-2 rounded-lg border border-border bg-bg-subtle text-text-primary
                               focus:outline-none focus:ring-2 focus:ring-accent text-sm"></textarea>
              <div class="mt-2 flex justify-end">
                <button type="button" (click)="submitAnswer(qa, qaAnswerDraft)"
                        [disabled]="answering() || qaAnswerDraft.trim().length === 0"
                        data-testid="quick-qa-submit"
                        class="px-4 py-2 text-sm rounded-lg bg-accent text-white font-medium
                               disabled:opacity-50 hover:opacity-90">
                  {{ answering() ? t('quick.submitting') : t('quick.qaSubmit') }}
                </button>
              </div>
            }

            @if (answerError()) {
              <p class="mt-2 text-sm text-ctp-red">{{ answerError() }}</p>
            }
          </section>
        }

        <!-- Latest handover -->
        @if (latestHandover(); as ho) {
          <details class="mb-6 p-4 rounded-lg border border-border bg-bg-subtle">
            <summary class="cursor-pointer text-sm font-medium text-text-secondary">
              {{ t('quick.handoverTitle') }}
            </summary>
            <pre class="mt-3 text-sm text-text-primary whitespace-pre-wrap break-words font-mono">{{ ho.content }}</pre>
          </details>
        }

        <!-- Last update -->
        @if (lastUpdate(); as up) {
          <section class="mb-6">
            <h2 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-1">
              {{ t('quick.lastUpdate') }}
            </h2>
            <p class="text-text-primary whitespace-pre-wrap break-words">{{ updateOneLiner(up) }}</p>
            <p class="text-xs text-text-secondary mt-1">{{ up.created_at | date:'short' }}</p>
          </section>
        }

        <!-- Footer actions -->
        <div class="mt-8 pt-4 border-t border-border flex items-center justify-between gap-3">
          @if (diffLink(); as link) {
            <a [href]="link.href" target="_blank" rel="noopener noreferrer"
               class="text-sm text-accent hover:underline">
              {{ link.label }}
            </a>
          } @else {
            <span></span>
          }
          @if (canCancel()) {
            <button type="button" (click)="cancel()" [disabled]="cancelling()"
                    class="px-3 py-1.5 text-sm rounded-lg border border-ctp-red/40 text-ctp-red
                           hover:bg-ctp-red/10 disabled:opacity-50">
              {{ cancelling() ? t('quick.cancelling') : t('quick.cancel') }}
            </button>
          }
        </div>
      }
    </div>
  `,
})
export class QuickDetailPage implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private tasksApi = inject(TasksApiService);
  private qaApi = inject(QaApiService);
  private reviewSse = inject(ReviewSseService);

  readonly task = signal<SpTask | null>(null);
  readonly updates = signal<SpTaskUpdate[]>([]);
  readonly pendingQa = signal<SpQaItem | null>(null);
  readonly loadError = signal<string | null>(null);
  readonly answerError = signal<string | null>(null);
  readonly answering = signal(false);
  readonly cancelling = signal(false);

  qaAnswerDraft = '';

  flipToAdvanced(): void {
    setUiMode('advanced');
  }

  private taskId = '';
  private subs: Subscription[] = [];
  /** Re-rendered every second so elapsed time stays live. */
  private now = signal(Date.now());

  async ngOnInit(): Promise<void> {
    this.taskId = this.route.snapshot.paramMap.get('id') ?? '';
    if (!this.taskId) {
      this.loadError.set('Missing task id in URL.');
      return;
    }
    await this.refresh();
    this.subs.push(interval(4000).subscribe(() => void this.refresh()));
    this.subs.push(interval(1000).subscribe(() => this.now.set(Date.now())));
    this.subs.push(this.reviewSse.events.subscribe(ev => {
      if (ev.task_id === this.taskId) void this.refresh();
    }));
  }

  ngOnDestroy(): void {
    for (const s of this.subs) s.unsubscribe();
  }

  private async refresh(): Promise<void> {
    try {
      const [task, updates, qaItems] = await Promise.all([
        firstValueFrom(this.tasksApi.get(this.taskId)),
        firstValueFrom(this.tasksApi.listUpdates(this.taskId)),
        firstValueFrom(this.qaApi.list({ task_id: this.taskId, status: 'pending', limit: 1 })),
      ]);
      this.task.set(task);
      this.updates.set(updates);
      this.pendingQa.set(qaItems[0] ?? null);
      this.loadError.set(null);
    } catch {
      if (!this.task()) this.loadError.set('Could not load this job.');
    }
  }

  // ─── Derived UI ─────────────────────────────────────────────────────

  readonly stateLabel = computed(() => {
    const tk = this.task();
    if (!tk) return '';
    if (tk.state === 'done' || tk.state === 'cancelled') return tk.state;
    if (tk.state === 'human_review' || tk.state === 'ai_review') return 'review';
    if (tk.state === 'ready' || tk.state === 'backlog') return 'ready';
    return `running:${tk.state}`;
  });

  stateBadgeClasses(): string {
    const tk = this.task();
    if (!tk) return '';
    switch (tk.state) {
      case 'done': return 'bg-ctp-green/15 text-ctp-green';
      case 'cancelled': return 'bg-overlay-1/20 text-text-secondary';
      case 'human_review':
      case 'ai_review': return 'bg-ctp-yellow/15 text-ctp-yellow';
      default: return 'bg-ctp-blue/15 text-ctp-blue';
    }
  }

  stateDotClasses(): string {
    const tk = this.task();
    if (!tk) return '';
    switch (tk.state) {
      case 'done': return 'bg-ctp-green';
      case 'cancelled': return 'bg-overlay-1';
      case 'human_review':
      case 'ai_review': return 'bg-ctp-yellow animate-pulse';
      default: return 'bg-ctp-blue animate-pulse';
    }
  }

  readonly elapsed = computed(() => {
    const tk = this.task();
    if (!tk) return '';
    const start = new Date(tk.claimed_at ?? tk.created_at).getTime();
    const end = tk.completed_at ? new Date(tk.completed_at).getTime() : this.now();
    const sec = Math.max(0, Math.floor((end - start) / 1000));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  });

  readonly lastUpdate = computed<SpTaskUpdate | null>(() => {
    const list = this.updates();
    if (list.length === 0) return null;
    // Most recent — server orders ascending; pick the tail.
    return list[list.length - 1];
  });

  readonly latestHandover = computed<SpTaskUpdate | null>(() => {
    const handovers = this.updates().filter(u => u.kind === 'handover');
    return handovers.length > 0 ? handovers[handovers.length - 1] : null;
  });

  readonly diffLink = computed<{ href: string; label: string } | null>(() => {
    const tk = this.task();
    if (!tk) return null;
    const ctx = tk.context ?? {};
    const branch = (ctx as Record<string, unknown>)['git_branch'];
    const mergeSha = (ctx as Record<string, unknown>)['git_merge_sha'];
    const repoUrl = (ctx as Record<string, unknown>)['repo_url'];
    if (typeof mergeSha === 'string' && typeof repoUrl === 'string') {
      return { href: `${repoUrl}/commit/${mergeSha}`, label: 'View merge commit' };
    }
    if (typeof branch === 'string' && typeof repoUrl === 'string') {
      return { href: `${repoUrl}/tree/${branch}`, label: `View branch ${branch}` };
    }
    return null;
  });

  canCancel(): boolean {
    const s = this.task()?.state;
    return !!s && s !== 'done' && s !== 'cancelled';
  }

  updateOneLiner(up: SpTaskUpdate): string {
    const firstLine = up.content.split('\n')[0] ?? '';
    return firstLine.length > 200 ? firstLine.slice(0, 197) + '…' : firstLine;
  }

  // ─── Actions ────────────────────────────────────────────────────────

  async submitAnswer(qa: SpQaItem, answer: string): Promise<void> {
    const trimmed = answer.trim();
    if (!trimmed || this.answering()) return;
    this.answering.set(true);
    this.answerError.set(null);
    try {
      await firstValueFrom(this.qaApi.answer(qa.id, {
        answer: trimmed,
        target_step: qa.step_name,
      }));
      this.qaAnswerDraft = '';
      this.pendingQa.set(null);
      await this.refresh();
    } catch (err) {
      const e = err as { error?: { message?: string }; message?: string };
      this.answerError.set(e?.error?.message ?? e?.message ?? 'Failed to submit answer.');
    } finally {
      this.answering.set(false);
    }
  }

  async cancel(): Promise<void> {
    if (!this.canCancel() || this.cancelling()) return;
    if (!confirm('Cancel this job? This cannot be undone.')) return;
    this.cancelling.set(true);
    try {
      await firstValueFrom(this.tasksApi.transition(this.taskId, 'cancelled'));
      await this.refresh();
    } catch {
      // Surface via reload — task may have already transitioned.
      await this.refresh();
    } finally {
      this.cancelling.set(false);
    }
  }
}
