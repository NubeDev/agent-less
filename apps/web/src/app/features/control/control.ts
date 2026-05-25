import {
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule, DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Subscription, firstValueFrom, interval } from 'rxjs';
import {
  TasksApiService,
  SpTask,
} from '../../core/services/tasks-api.service';
import {
  QaApiService,
  SpQaItem,
} from '../../core/services/qa-api.service';
import {
  DiraigentApiService,
  DgProject,
} from '../../core/services/diraigent-api.service';
import { ReviewSseService } from '../../core/services/review-sse.service';
import { ProjectContext } from '../../core/services/project-context.service';
import { setUiMode } from '../../core/guards/default-route.guard';

/**
 * SoW-10 Mission Control — the single page that runs the show.
 *
 * Replaces the navigate-into-each-job flow. Lanes derive from existing
 * /tasks + /qa endpoints; cards expand inline so the operator never
 * leaves this surface to answer a question or push a branch.
 *
 * Modes:
 *   • autonomous — AI proceeds without input when confidence ≥ threshold
 *     (qa_config server-side); Needs-you lane only fills on hard blocks.
 *   • gated — every QA waits for a human regardless of confidence.
 *
 * The mode chip writes a per-tenant pref the worker reads via the
 * existing qa_config layer; this page just surfaces the current value.
 */

interface LaneCard {
  task: SpTask;
  pendingQas: SpQaItem[];
}

const MODE_KEY = 'diraigent.controlMode';
type ControlMode = 'autonomous' | 'gated';

function readMode(): ControlMode {
  if (typeof localStorage === 'undefined') return 'autonomous';
  return (localStorage.getItem(MODE_KEY) as ControlMode | null) ?? 'autonomous';
}
function writeMode(m: ControlMode): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(MODE_KEY, m);
}

/** Branch convention from apps/orchestra/src/task_id.rs#branch_name. */
function taskBranchName(taskId: string): string {
  return `agent/task-${taskId.slice(0, 12)}`;
}

@Component({
  selector: 'app-control',
  standalone: true,
  imports: [CommonModule, RouterLink, FormsModule, DatePipe, DecimalPipe],
  template: `
    <div class="mx-auto max-w-6xl px-3 py-5">
      <!-- Header -->
      <header class="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-baseline gap-3">
          <h1 class="text-2xl font-semibold text-text-primary">Mission control</h1>
          @if (projects().length > 1) {
            <select
              [value]="selectedProjectId()"
              (change)="onSelectProject($event)"
              class="rounded border border-border bg-bg-subtle px-2 py-1 text-sm text-text-primary"
            >
              @for (p of projects(); track p.id) {
                <option [value]="p.id">{{ p.name }}</option>
              }
            </select>
          }
        </div>

        <div class="flex items-center gap-2">
          <button
            type="button"
            (click)="toggleMode()"
            class="flex items-center gap-2 rounded-lg border border-border bg-bg-subtle px-3 py-1.5 text-xs font-medium hover:bg-surface-hover"
            [title]="mode() === 'autonomous'
              ? 'AI runs end-to-end; only hard blocks surface in Needs-you.'
              : 'Every QA pauses for a human answer.'"
          >
            <span
              class="h-1.5 w-1.5 rounded-full"
              [class.bg-ctp-green]="mode() === 'autonomous'"
              [class.bg-ctp-yellow]="mode() === 'gated'"
            ></span>
            <span class="text-text-primary">{{ mode() === 'autonomous' ? 'AUTONOMOUS' : 'GATED' }}</span>
            <span class="text-text-secondary">▾</span>
          </button>
          <a
            routerLink="/quick/new"
            class="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
          >+ New task</a>
        </div>
      </header>

      <!-- Status strip -->
      <div class="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-5">
        <div class="rounded-lg border border-ctp-yellow/30 bg-ctp-yellow/5 px-3 py-2">
          <div class="text-[10px] uppercase tracking-wider text-ctp-yellow">Needs you</div>
          <div class="font-mono text-lg text-text-primary">{{ needsYou().length }}</div>
        </div>
        <div class="rounded-lg border border-ctp-blue/30 bg-ctp-blue/5 px-3 py-2">
          <div class="text-[10px] uppercase tracking-wider text-ctp-blue">In flight</div>
          <div class="font-mono text-lg text-text-primary">{{ inFlight().length }}</div>
        </div>
        <div class="rounded-lg border border-ctp-teal/30 bg-ctp-teal/5 px-3 py-2">
          <div class="text-[10px] uppercase tracking-wider text-ctp-teal">Ready to ship</div>
          <div class="font-mono text-lg text-text-primary">{{ readyToShip().length }}</div>
        </div>
        <div class="rounded-lg border border-border bg-bg-subtle px-3 py-2">
          <div class="text-[10px] uppercase tracking-wider text-text-secondary">Queued</div>
          <div class="font-mono text-lg text-text-primary">{{ backlog().length }}</div>
        </div>
        <div class="rounded-lg border border-border bg-bg-subtle px-3 py-2 col-span-2 sm:col-span-1">
          <div class="text-[10px] uppercase tracking-wider text-text-secondary">Today total</div>
          <div class="font-mono text-lg text-text-primary">
            \${{ totalCostToday() | number:'1.2-2' }}
          </div>
        </div>
      </div>

      @if (loadError()) {
        <div class="mb-4 rounded-lg bg-ctp-red/10 px-3 py-2 text-sm text-ctp-red" role="alert">
          {{ loadError() }}
        </div>
      }

      <!-- ─── Needs you ─── -->
      <section class="mb-6">
        <h2 class="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ctp-yellow">
          ⚠ Needs you
          <span class="cursor-help text-text-secondary opacity-70"
                title="Jobs with at least one QA item in status=pending. Empties as soon as you answer or the AI auto-resolves them.">(?)</span>
          @if (needsYou().length > 0) {
            <span class="rounded-full bg-ctp-yellow/20 px-1.5 py-0.5 font-mono text-[10px] text-ctp-yellow">
              {{ needsYou().length }}
            </span>
          }
        </h2>
        @if (needsYou().length === 0) {
          <p class="text-sm text-text-secondary">No open questions. Everything is running or done.</p>
        } @else {
          <ul class="space-y-2" data-testid="control-needs-you">
            @for (card of needsYou(); track card.task.id) {
              <li class="rounded-lg border border-ctp-yellow/30 bg-ctp-yellow/5 p-3">
                <div class="mb-2 min-w-0">
                  <div class="text-xs text-text-secondary">
                    <span class="text-text-primary">{{ selectedProjectName() }}</span>
                    <span> · </span>
                    <a [routerLink]="['/jobs', card.task.id]"
                       class="hover:underline">Job #{{ card.task.number }}</a>
                    <span> · </span>
                    <a [routerLink]="['/jobs', card.task.id]"
                       class="font-medium text-text-primary hover:underline">{{ card.task.title }}</a>
                  </div>
                  <div class="mt-0.5 text-xs text-text-secondary">
                    step <span class="font-mono">{{ card.task.state }}</span>
                    · \${{ card.task.cost_usd | number:'1.4-4' }}
                    · {{ card.pendingQas.length }} question{{ card.pendingQas.length === 1 ? '' : 's' }}
                  </div>
                </div>

                <div class="space-y-3 border-t border-ctp-yellow/20 pt-3">
                  @for (qa of card.pendingQas; track qa.id) {
                      <div class="rounded border border-border bg-bg-base/40 p-3">
                        <div class="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-wider text-text-secondary">
                          <span class="font-mono">{{ qa.step_name }}</span>
                          <span>·</span>
                          <span>{{ qa.kind }}</span>
                          <span>·</span>
                          <span>asked {{ qa.created_at | date:'short' }}</span>
                          @if (qa.expires_at) {
                            <span>·</span>
                            <span class="text-ctp-peach">escalates {{ qa.expires_at | date:'short' }}</span>
                          }
                        </div>
                        <p class="mb-3 whitespace-pre-wrap text-sm text-text-primary">{{ qa.prompt }}</p>

                        @if (qa.options && qa.options.length > 0) {
                          <div class="mb-2 flex flex-wrap gap-2">
                            @for (opt of qa.options; track opt) {
                              <button type="button"
                                      (click)="quickAnswer(qa, opt)"
                                      [disabled]="answering() === qa.id"
                                      class="rounded border border-border bg-bg-subtle px-2.5 py-1 text-sm text-text-primary hover:bg-surface-hover disabled:opacity-50">
                                {{ opt }}
                              </button>
                            }
                          </div>
                        }

                        <div class="flex items-stretch gap-2">
                          <input
                            type="text"
                            [(ngModel)]="answerDraft[qa.id]"
                            (keyup.enter)="submitAnswer(qa)"
                            [disabled]="answering() === qa.id"
                            [placeholder]="qa.options && qa.options.length > 0 ? 'Or type your own…' : 'Your answer…'"
                            class="flex-1 rounded border border-border bg-bg-subtle px-2.5 py-1.5 text-sm text-text-primary placeholder:text-text-secondary disabled:opacity-50"
                          />
                          <button type="button"
                                  (click)="submitAnswer(qa)"
                                  [disabled]="answering() === qa.id || !(answerDraft[qa.id] || '').trim()"
                                  class="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50">
                            {{ answering() === qa.id ? '…' : 'Send' }}
                          </button>
                        </div>

                        @if (answerError()[qa.id]) {
                          <p class="mt-2 text-xs text-ctp-red">{{ answerError()[qa.id] }}</p>
                        }
                      </div>
                    }
                </div>
              </li>
            }
          </ul>
        }
      </section>

      <!-- ─── In flight ─── -->
      <section class="mb-6">
        <h2 class="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ctp-blue">
          🟢 In flight
          <span class="cursor-help text-text-secondary opacity-70"
                title="Jobs currently running with no pending QAs. state ≠ done | cancelled | backlog | failed | parked.">(?)</span>
          @if (inFlight().length > 0) {
            <span class="ml-1 font-normal normal-case text-text-secondary">— autonomous, no input expected</span>
          }
        </h2>
        @if (inFlight().length === 0) {
          <p class="text-sm text-text-secondary">No active work.</p>
        } @else {
          <ul class="space-y-1.5">
            @for (card of inFlight(); track card.task.id) {
              <li class="flex items-center justify-between gap-3 rounded-lg border border-border bg-bg-subtle px-3 py-2 hover:bg-surface-hover">
                <a [routerLink]="['/jobs', card.task.id]" class="flex min-w-0 flex-1 items-center gap-2">
                  <span class="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-ctp-blue"></span>
                  <span class="truncate text-text-primary">
                    <span class="text-text-secondary">{{ selectedProjectName() }} · #{{ card.task.number }} ·</span>
                    {{ card.task.title }}
                  </span>
                </a>
                <span class="shrink-0 font-mono text-xs text-text-secondary">
                  {{ card.task.state }} · \${{ card.task.cost_usd | number:'1.4-4' }} · {{ card.task.updated_at | date:'shortTime' }}
                </span>
              </li>
            }
          </ul>
        }
      </section>

      <!-- ─── Ready to ship ─── -->
      <section class="mb-6">
        <h2 class="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ctp-teal">
          🚀 Ready to ship
          <span class="cursor-help text-text-secondary opacity-70"
                title="state = done with a completed_at in the last 24h. Branch is merged locally; you still need to git push.">(?)</span>
          @if (readyToShip().length > 0) {
            <span class="ml-1 font-normal normal-case text-text-secondary">— merged locally, not yet pushed</span>
          }
        </h2>
        @if (readyToShip().length === 0) {
          <p class="text-sm text-text-secondary">Nothing waiting to push.</p>
        } @else {
          <ul class="space-y-2">
            @for (card of readyToShip(); track card.task.id) {
              <li class="rounded-lg border border-ctp-teal/30 bg-ctp-teal/5 p-3">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <div class="min-w-0">
                    <a [routerLink]="['/jobs', card.task.id]"
                       class="font-medium text-text-primary hover:underline">
                      <span class="text-text-secondary">{{ selectedProjectName() }} · #{{ card.task.number }} ·</span>
                      {{ card.task.title }}
                    </a>
                    <div class="mt-0.5 font-mono text-xs text-text-secondary">
                      branch <span class="text-ctp-teal">{{ branchOf(card.task) }}</span>
                      · done {{ card.task.completed_at | date:'short' }}
                    </div>
                  </div>
                  <button type="button"
                          (click)="copyPushCommand(card.task)"
                          class="rounded border border-ctp-teal/40 bg-ctp-teal/10 px-2.5 py-1 font-mono text-xs text-ctp-teal hover:bg-ctp-teal/20"
                          [attr.data-task]="card.task.id">
                    {{ copiedTaskId() === card.task.id ? '✓ copied' : 'copy git push' }}
                  </button>
                </div>
              </li>
            }
          </ul>
        }
      </section>

      <!-- ─── Backlog ─── -->
      <details class="mb-3 rounded-lg border border-border bg-bg-subtle" [open]="false">
        <summary class="cursor-pointer px-3 py-2 text-xs font-semibold uppercase tracking-wider text-text-secondary">
          ▶ Backlog ({{ backlog().length }})
          <span class="ml-1 cursor-help opacity-70"
                title="state = backlog. Job has been created but not yet picked up by a worker; sorted oldest first.">(?)</span>
        </summary>
        @if (backlog().length === 0) {
          <p class="px-3 pb-3 text-sm text-text-secondary">Empty.</p>
        } @else {
          <ul class="divide-y divide-border px-3 pb-2">
            @for (card of backlog(); track card.task.id) {
              <li class="flex items-center justify-between gap-3 py-1.5">
                <a [routerLink]="['/jobs', card.task.id]" class="truncate text-sm text-text-primary hover:underline">
                  <span class="text-text-secondary">{{ selectedProjectName() }} · #{{ card.task.number }} ·</span>
                  {{ card.task.title }}
                </a>
                <span class="shrink-0 font-mono text-xs text-text-secondary">{{ card.task.created_at | date:'short' }}</span>
              </li>
            }
          </ul>
        }
      </details>

      <!-- ─── Done today ─── -->
      <details class="mb-3 rounded-lg border border-border bg-bg-subtle" [open]="false">
        <summary class="cursor-pointer px-3 py-2 text-xs font-semibold uppercase tracking-wider text-text-secondary">
          ▶ Done today ({{ doneToday().length }})
          <span class="ml-1 cursor-help opacity-70"
                title="state ∈ {done, cancelled} with completed_at (or updated_at) in the last 24h.">(?)</span>
        </summary>
        @if (doneToday().length === 0) {
          <p class="px-3 pb-3 text-sm text-text-secondary">Nothing finished in the last 24h.</p>
        } @else {
          <ul class="divide-y divide-border px-3 pb-2">
            @for (card of doneToday(); track card.task.id) {
              <li class="flex items-center justify-between gap-3 py-1.5">
                <a [routerLink]="['/jobs', card.task.id]" class="flex min-w-0 flex-1 items-center gap-2 hover:underline">
                  <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-ctp-green"></span>
                  <span class="truncate text-sm text-text-primary">
                    <span class="text-text-secondary">{{ selectedProjectName() }} · #{{ card.task.number }} ·</span>
                    {{ card.task.title }}
                  </span>
                </a>
                <span class="shrink-0 font-mono text-xs text-text-secondary">
                  \${{ card.task.cost_usd | number:'1.4-4' }} · {{ card.task.completed_at | date:'shortTime' }}
                </span>
              </li>
            }
          </ul>
        }
      </details>

      <!-- ─── Parked / failed ─── -->
      <details class="rounded-lg border border-ctp-red/20 bg-ctp-red/5" [open]="parkedFailed().length > 0">
        <summary class="cursor-pointer px-3 py-2 text-xs font-semibold uppercase tracking-wider text-ctp-red">
          ▶ Parked / failed ({{ parkedFailed().length }})
          <span class="ml-1 cursor-help opacity-70"
                title="state ∈ {failed, parked}. Worker hit an unrecoverable error or a human paused the job; needs investigation.">(?)</span>
        </summary>
        @if (parkedFailed().length === 0) {
          <p class="px-3 pb-3 text-sm text-text-secondary">None.</p>
        } @else {
          <ul class="divide-y divide-ctp-red/15 px-3 pb-2">
            @for (card of parkedFailed(); track card.task.id) {
              <li class="flex items-center justify-between gap-3 py-1.5">
                <a [routerLink]="['/jobs', card.task.id]" class="truncate text-sm text-text-primary hover:underline">
                  <span class="text-text-secondary">{{ selectedProjectName() }} · #{{ card.task.number }} ·</span>
                  {{ card.task.title }}
                </a>
                <span class="shrink-0 font-mono text-xs text-ctp-red">{{ card.task.state }}</span>
              </li>
            }
          </ul>
        }
      </details>
    </div>
  `,
})
export class ControlPage implements OnInit, OnDestroy {
  private tasksApi = inject(TasksApiService);
  private qaApi = inject(QaApiService);
  private dgApi = inject(DiraigentApiService);
  private reviewSse = inject(ReviewSseService);
  private projectCtx = inject(ProjectContext);
  private router = inject(Router);

  readonly projects = signal<DgProject[]>([]);
  readonly selectedProjectId = signal<string>('');
  readonly tasks = signal<SpTask[]>([]);
  readonly pendingQaByTask = signal<Map<string, SpQaItem[]>>(new Map());
  readonly loadError = signal<string | null>(null);
  readonly mode = signal<ControlMode>(readMode());
  readonly answering = signal<string | null>(null);
  readonly answerError = signal<Record<string, string>>({});
  readonly copiedTaskId = signal<string | null>(null);

  /** Per-QA draft, keyed by qa.id. Bound via ngModel. */
  answerDraft: Record<string, string> = {};

  private subs: Subscription[] = [];
  private copyTimer: ReturnType<typeof setTimeout> | null = null;

  // ─── Lane derivations ────────────────────────────────────────────────

  private readonly cards = computed<LaneCard[]>(() => {
    const byTask = this.pendingQaByTask();
    return this.tasks().map(t => ({
      task: t,
      pendingQas: byTask.get(t.id) ?? [],
    }));
  });

  readonly selectedProjectName = computed(() => {
    const pid = this.selectedProjectId();
    return this.projects().find(p => p.id === pid)?.name ?? '';
  });

  readonly needsYou = computed(() =>
    this.cards().filter(c => c.pendingQas.length > 0),
  );

  readonly inFlight = computed(() =>
    this.cards().filter(c => {
      if (c.pendingQas.length > 0) return false;
      const s = c.task.state;
      return s !== 'done' && s !== 'cancelled' && s !== 'backlog' && s !== 'failed' && s !== 'parked';
    }),
  );

  readonly readyToShip = computed(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return this.cards()
      .filter(c =>
        c.task.state === 'done' &&
        c.task.completed_at &&
        new Date(c.task.completed_at).getTime() >= cutoff,
      )
      .sort((a, b) =>
        new Date(b.task.completed_at!).getTime() -
        new Date(a.task.completed_at!).getTime(),
      )
      .slice(0, 8);
  });

  readonly backlog = computed(() =>
    this.cards()
      .filter(c => c.task.state === 'backlog')
      .sort((a, b) => new Date(a.task.created_at).getTime() - new Date(b.task.created_at).getTime()),
  );

  readonly doneToday = computed(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return this.cards()
      .filter(c =>
        (c.task.state === 'done' || c.task.state === 'cancelled') &&
        new Date(c.task.completed_at ?? c.task.updated_at).getTime() >= cutoff,
      )
      .sort((a, b) =>
        new Date(b.task.completed_at ?? b.task.updated_at).getTime() -
        new Date(a.task.completed_at ?? a.task.updated_at).getTime(),
      );
  });

  readonly parkedFailed = computed(() =>
    this.cards().filter(c => c.task.state === 'failed' || c.task.state === 'parked'),
  );

  readonly totalCostToday = computed(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return this.cards()
      .filter(c => new Date(c.task.updated_at).getTime() >= cutoff)
      .reduce((sum, c) => sum + (c.task.cost_usd ?? 0), 0);
  });

  // ─── Lifecycle ───────────────────────────────────────────────────────

  async ngOnInit(): Promise<void> {
    setUiMode('quick'); // share landing pref with /quick
    try {
      const projects = await firstValueFrom(this.dgApi.getProjects());
      this.projects.set(projects);
      if (projects.length === 0) {
        this.loadError.set('No projects available.');
        return;
      }
      const stored = this.projectCtx.projectId();
      const pid = projects.find(p => p.id === stored)?.id ?? projects[0].id;
      this.selectedProjectId.set(pid);
      if (pid !== stored) this.projectCtx.select(pid);
      await this.refresh();
    } catch {
      this.loadError.set('Could not load mission control.');
    }
    this.subs.push(interval(5000).subscribe(() => void this.refresh()));
    this.subs.push(this.reviewSse.events.subscribe(() => void this.refresh()));
  }

  ngOnDestroy(): void {
    for (const s of this.subs) s.unsubscribe();
    if (this.copyTimer) clearTimeout(this.copyTimer);
  }

  // ─── Actions ─────────────────────────────────────────────────────────

  onSelectProject(ev: Event): void {
    const pid = (ev.target as HTMLSelectElement).value;
    this.selectedProjectId.set(pid);
    this.projectCtx.select(pid);
    void this.refresh();
  }

  toggleMode(): void {
    const next: ControlMode = this.mode() === 'autonomous' ? 'gated' : 'autonomous';
    this.mode.set(next);
    writeMode(next);
  }

  quickAnswer(qa: SpQaItem, value: string): void {
    this.answerDraft[qa.id] = value;
    void this.submitAnswer(qa);
  }

  async submitAnswer(qa: SpQaItem): Promise<void> {
    const text = (this.answerDraft[qa.id] ?? '').trim();
    if (!text || this.answering() === qa.id) return;
    this.answering.set(qa.id);
    this.answerError.update(m => ({ ...m, [qa.id]: '' }));
    try {
      await firstValueFrom(this.qaApi.answer(qa.id, {
        answer: text,
        target_step: qa.step_name,
      }));
      this.answerDraft[qa.id] = '';
      await this.refresh();
    } catch (err) {
      const e = err as { error?: { message?: string }; message?: string };
      const msg = e?.error?.message ?? e?.message ?? 'Failed to submit answer.';
      this.answerError.update(m => ({ ...m, [qa.id]: msg }));
    } finally {
      this.answering.set(null);
    }
  }

  branchOf(t: SpTask): string {
    return taskBranchName(t.id);
  }

  async copyPushCommand(t: SpTask): Promise<void> {
    const branch = taskBranchName(t.id);
    const cmd = `git push -u origin ${branch}`;
    try {
      await navigator.clipboard.writeText(cmd);
      this.copiedTaskId.set(t.id);
      if (this.copyTimer) clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => this.copiedTaskId.set(null), 1800);
    } catch {
      // Clipboard unavailable (insecure context). Fall back to selection prompt.
      window.prompt('Copy this command:', cmd);
    }
  }

  // ─── Data ────────────────────────────────────────────────────────────

  private async refresh(): Promise<void> {
    const pid = this.selectedProjectId();
    if (!pid) return;
    try {
      const [page, qa] = await Promise.all([
        firstValueFrom(this.tasksApi.listForProject(pid, { limit: 200 })),
        firstValueFrom(this.qaApi.list({ project_id: pid, status: 'pending', limit: 200 })),
      ]);
      this.tasks.set(page.data);
      const m = new Map<string, SpQaItem[]>();
      for (const q of qa) {
        const list = m.get(q.task_id) ?? [];
        list.push(q);
        m.set(q.task_id, list);
      }
      this.pendingQaByTask.set(m);
      this.loadError.set(null);
    } catch {
      if (this.tasks().length === 0) this.loadError.set('Could not load mission control.');
    }
  }
}
