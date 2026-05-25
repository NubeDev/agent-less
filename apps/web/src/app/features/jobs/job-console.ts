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
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subscription, firstValueFrom, interval } from 'rxjs';
import {
  TasksApiService,
  SpTask,
} from '../../core/services/tasks-api.service';
import {
  QaApiService,
  SpQaItem,
} from '../../core/services/qa-api.service';
import { SpReport } from '../../core/services/reports-api.service';
import { SpAuditEntry } from '../../core/services/audit-api.service';
import {
  JobsApiService,
  TaskLogSummary,
  StepFileGroup,
} from '../jobs/jobs-api.service';
import { TaskStreamService } from '../jobs/task-stream.service';
import {
  DiraigentApiService,
  DgProject,
} from '../../core/services/diraigent-api.service';

/**
 * SoW-10 — single-job console. The per-task counterpart of /control:
 * one page, all the actions, no DAG. Replaces the navigate-into-DAG
 * flow as the default landing for /jobs/:id; the DAG lives at
 * /jobs/:id/post-mortem for after-the-fact analysis.
 */

type Tab = 'activity' | 'files' | 'qa' | 'reports';

/** Mirrors apps/orchestra/src/task_id.rs#branch_name. */
function taskBranchName(taskId: string): string {
  return `agent/task-${taskId.slice(0, 12)}`;
}

@Component({
  selector: 'app-job-console',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, DatePipe, DecimalPipe],
  template: `
    <div class="mx-auto max-w-5xl px-3 py-4">
      <!-- Header -->
      <div class="mb-3 flex items-center justify-between gap-2 text-xs">
        <nav class="flex min-w-0 flex-wrap items-center gap-1 text-text-secondary" aria-label="Breadcrumb">
          <a routerLink="/control" class="hover:text-text-primary">Projects</a>
          @if (project(); as p) {
            <span aria-hidden="true">▸</span>
            <a routerLink="/control" class="hover:text-text-primary">{{ p.name }}</a>
          }
          @if (task(); as t) {
            <span aria-hidden="true">▸</span>
            <span class="text-text-primary">Job #{{ t.number }}</span>
            <span aria-hidden="true">▸</span>
            <span class="truncate text-text-primary">{{ t.title }}</span>
          }
        </nav>
        @if (task(); as t) {
          <a [routerLink]="['/jobs', t.id, 'post-mortem']"
             class="shrink-0 text-text-secondary hover:text-text-primary underline decoration-dotted">
            Post-mortem view →
          </a>
        }
      </div>

      @if (loadError()) {
        <div class="rounded-lg bg-ctp-red/10 px-3 py-2 text-sm text-ctp-red" role="alert">
          {{ loadError() }}
        </div>
      } @else if (!task()) {
        <div class="rounded-lg border border-border bg-bg-subtle px-3 py-4 text-sm text-text-secondary">
          Loading…
        </div>
      } @else if (task(); as t) {
        <!-- Title block -->
        <div class="mb-4 rounded-lg border border-border bg-bg-subtle p-4">
          <div class="mb-1 flex items-center gap-2 text-xs text-text-secondary">
            <span>#{{ t.number }}</span>
            <span>·</span>
            <span [class]="stateBadgeClass()" class="rounded px-1.5 py-0.5 font-mono uppercase tracking-wider">
              {{ t.state }}
            </span>
            @if (pendingQas().length > 0) {
              <span class="rounded bg-ctp-yellow/20 px-1.5 py-0.5 font-mono uppercase tracking-wider text-ctp-yellow">
                {{ pendingQas().length }} waiting
              </span>
            }
          </div>
          <h1 class="text-xl font-semibold text-text-primary">{{ t.title }}</h1>

          <div class="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs sm:grid-cols-4">
            <div>
              <div class="text-text-secondary">branch</div>
              <div class="truncate text-ctp-teal">{{ branchOf(t) }}</div>
            </div>
            <div>
              <div class="text-text-secondary">cost</div>
              <div class="text-text-primary">\${{ t.cost_usd | number:'1.4-4' }}</div>
            </div>
            <div>
              <div class="text-text-secondary">tokens in/out</div>
              <div class="text-text-primary">{{ t.input_tokens }}/{{ t.output_tokens }}</div>
            </div>
            <div>
              <div class="text-text-secondary">{{ t.completed_at ? 'completed' : 'updated' }}</div>
              <div class="text-text-primary">{{ (t.completed_at ?? t.updated_at) | date:'short' }}</div>
            </div>
          </div>
        </div>

        <!-- Needs you (inline answer, full width) -->
        @if (pendingQas().length > 0) {
          <section class="mb-4 rounded-lg border border-ctp-yellow/30 bg-ctp-yellow/5 p-3">
            <h2 class="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ctp-yellow">
              ⚠ Question{{ pendingQas().length === 1 ? '' : 's' }} waiting
            </h2>
            <div class="space-y-3">
              @for (qa of pendingQas(); track qa.id) {
                <div class="rounded border border-border bg-bg-base/40 p-3">
                  <div class="mb-2 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wider text-text-secondary">
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
          </section>
        }

        <!-- Pipeline strip -->
        <section class="mb-4">
          <div class="mb-1 text-[10px] font-semibold uppercase tracking-wider text-text-secondary">Pipeline</div>
          @if (steps().length === 0) {
            <p class="text-sm text-text-secondary">No steps recorded yet.</p>
          } @else {
            <div class="flex flex-wrap items-center gap-1.5">
              @for (s of steps(); track s.name; let i = $index) {
                <span class="rounded px-2 py-0.5 font-mono text-xs"
                      [class.bg-ctp-green]="s.status === 'done'"
                      [class.text-bg-base]="s.status === 'done'"
                      [class.bg-ctp-blue]="s.status === 'active'"
                      [class.text-bg-base.bg-ctp-blue]="s.status === 'active'"
                      [class.bg-bg-subtle]="s.status === 'pending'"
                      [class.text-text-secondary]="s.status === 'pending'"
                      [class.border]="true"
                      [class.border-border]="true">
                  @if (s.status === 'done') { ✓ }
                  @if (s.status === 'active') { ◐ }
                  {{ s.name }}
                </span>
                @if (i < steps().length - 1) {
                  <span class="text-text-secondary">›</span>
                }
              }
            </div>
          }
        </section>

        <!-- Actions -->
        <section class="mb-5 flex flex-wrap items-center gap-2">
          @if (canCancel()) {
            <button type="button" (click)="cancel()" [disabled]="cancelling()"
                    class="rounded border border-ctp-red/40 bg-ctp-red/10 px-2.5 py-1 text-xs text-ctp-red hover:bg-ctp-red/20 disabled:opacity-50">
              {{ cancelling() ? 'Cancelling…' : 'Cancel job' }}
            </button>
          }
          @if (canPush()) {
            <button type="button" (click)="copyPushCommand()"
                    class="rounded border border-ctp-teal/40 bg-ctp-teal/10 px-2.5 py-1 font-mono text-xs text-ctp-teal hover:bg-ctp-teal/20">
              {{ copied() ? '✓ copied' : 'Copy git push' }}
            </button>
          }
          <a [routerLink]="['/jobs', t.id, 'post-mortem']"
             class="rounded border border-border bg-bg-subtle px-2.5 py-1 text-xs text-text-primary hover:bg-surface-hover">
            Post-mortem (DAG + diffs)
          </a>
        </section>

        <!-- Tabs -->
        <div class="mb-2 flex gap-1 border-b border-border text-xs">
          @for (t of tabs; track t.id) {
            <button type="button" (click)="setTab(t.id)"
                    class="border-b-2 px-3 py-1.5 transition-colors"
                    [class.border-accent]="tab() === t.id"
                    [class.text-text-primary]="tab() === t.id"
                    [class.border-transparent]="tab() !== t.id"
                    [class.text-text-secondary]="tab() !== t.id"
                    [class.hover:text-text-primary]="tab() !== t.id">
              {{ t.label }}
              @if (t.count() > 0) {
                <span class="ml-1 rounded-full bg-bg-subtle px-1.5 py-0.5 font-mono text-[10px]">{{ t.count() }}</span>
              }
            </button>
          }
        </div>

        <!-- Tab body -->
        <section class="rounded-lg border border-border bg-bg-subtle">
          @switch (tab()) {
            @case ('activity') {
              <div class="max-h-[60vh] overflow-y-auto">
                @if (activity().length === 0) {
                  <p class="px-3 py-4 text-sm text-text-secondary">No activity yet.</p>
                } @else {
                  <ul class="divide-y divide-border">
                    @for (row of activity(); track row.key) {
                      <li class="flex items-start gap-3 px-3 py-1.5 font-mono text-xs">
                        <span class="shrink-0 text-text-secondary">{{ row.time | date:'HH:mm:ss' }}</span>
                        <span class="shrink-0 rounded px-1.5 text-[10px] uppercase"
                              [class.bg-ctp-blue]="row.kind === 'log'"
                              [class.text-bg-base.bg-ctp-blue]="row.kind === 'log'"
                              [class.bg-ctp-yellow]="row.kind === 'qa'"
                              [class.text-bg-base.bg-ctp-yellow]="row.kind === 'qa'"
                              [class.bg-ctp-green]="row.kind === 'report'"
                              [class.text-bg-base.bg-ctp-green]="row.kind === 'report'"
                              [class.bg-overlay-1]="row.kind === 'audit'"
                              [class.text-text-secondary]="row.kind === 'audit'">
                          {{ row.kind }}
                        </span>
                        <span class="min-w-0 flex-1 break-words text-text-primary">{{ row.label }}</span>
                      </li>
                    }
                  </ul>
                }
              </div>
            }
            @case ('files') {
              <div class="max-h-[60vh] overflow-y-auto p-2">
                @if (allFiles() === 0) {
                  <p class="px-2 py-2 text-sm text-text-secondary">No changed files yet.</p>
                } @else {
                  @for (group of files(); track group.step_name) {
                    <div class="mb-3">
                      <div class="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
                        {{ group.step_name }} ({{ group.files.length }})
                      </div>
                      <ul class="divide-y divide-border rounded border border-border">
                        @for (f of group.files; track f.id) {
                          <li class="flex items-center justify-between gap-3 px-2 py-1 font-mono text-xs">
                            <span class="truncate text-text-primary">{{ f.path }}</span>
                            <span class="shrink-0 text-text-secondary uppercase">{{ f.change_type }}</span>
                          </li>
                        }
                      </ul>
                    </div>
                  }
                }
              </div>
            }
            @case ('qa') {
              <div class="max-h-[60vh] overflow-y-auto">
                @if (qas().length === 0) {
                  <p class="px-3 py-4 text-sm text-text-secondary">No questions on this job.</p>
                } @else {
                  <ul class="divide-y divide-border">
                    @for (q of qas(); track q.id) {
                      <li class="px-3 py-2">
                        <div class="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wider text-text-secondary">
                          <span class="font-mono">{{ q.step_name }}</span>
                          <span>·</span>
                          <span [class.text-ctp-yellow]="q.status === 'pending'"
                                [class.text-ctp-green]="q.status === 'answered' || q.status === 'resolved'"
                                [class.text-ctp-red]="q.status === 'expired' || q.status === 'cancelled'">
                            {{ q.status }}
                          </span>
                          <span>·</span>
                          <span>{{ q.created_at | date:'short' }}</span>
                        </div>
                        <p class="text-sm text-text-primary">{{ q.prompt }}</p>
                        @if (q.answer) {
                          <p class="mt-1 rounded bg-bg-base/40 px-2 py-1 font-mono text-xs text-ctp-green">
                            → {{ q.answer }}
                          </p>
                        }
                      </li>
                    }
                  </ul>
                }
              </div>
            }
            @case ('reports') {
              <div class="max-h-[60vh] overflow-y-auto">
                @if (reports().length === 0) {
                  <p class="px-3 py-4 text-sm text-text-secondary">No reports.</p>
                } @else {
                  <ul class="divide-y divide-border">
                    @for (r of reports(); track r.id) {
                      <li class="px-3 py-2">
                        <div class="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wider text-text-secondary">
                          <span class="font-mono">{{ r.kind }}</span>
                          <span>·</span>
                          <span [class.text-ctp-green]="r.status === 'completed'"
                                [class.text-ctp-yellow]="r.status === 'in_progress'"
                                [class.text-ctp-red]="r.status === 'failed'">
                            {{ r.status }}
                          </span>
                          <span>·</span>
                          <span>{{ r.created_at | date:'short' }}</span>
                        </div>
                        <div class="text-sm font-medium text-text-primary">{{ r.title }}</div>
                        @if (r.result) {
                          <pre class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-bg-base/40 px-2 py-1 text-xs text-text-secondary">{{ r.result }}</pre>
                        }
                      </li>
                    }
                  </ul>
                }
              </div>
            }
          }
        </section>
      }
    </div>
  `,
})
export class JobConsolePage implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private tasksApi = inject(TasksApiService);
  private qaApi = inject(QaApiService);
  private jobsApi = inject(JobsApiService);
  private stream = inject(TaskStreamService);
  private dgApi = inject(DiraigentApiService);

  readonly task = signal<SpTask | null>(null);
  readonly project = signal<DgProject | null>(null);
  readonly qas = signal<SpQaItem[]>([]);
  readonly logs = signal<TaskLogSummary[]>([]);
  readonly reports = signal<SpReport[]>([]);
  readonly audit = signal<SpAuditEntry[]>([]);
  readonly files = signal<StepFileGroup[]>([]);
  readonly loadError = signal<string | null>(null);
  readonly tab = signal<Tab>('activity');
  readonly answering = signal<string | null>(null);
  readonly answerError = signal<Record<string, string>>({});
  readonly cancelling = signal(false);
  readonly copied = signal(false);

  answerDraft: Record<string, string> = {};
  private taskId = '';
  private subs: Subscription[] = [];
  private streamSub: { unsubscribe: () => void } | null = null;
  private copyTimer: ReturnType<typeof setTimeout> | null = null;

  readonly pendingQas = computed(() => this.qas().filter(q => q.status === 'pending'));

  readonly allFiles = computed(() =>
    this.files().reduce((sum, g) => sum + g.files.length, 0),
  );

  /** Pipeline step strip derived from logs + qas. */
  readonly steps = computed<{ name: string; status: 'done' | 'active' | 'pending' }[]>(() => {
    const t = this.task();
    if (!t) return [];
    const stepNames: string[] = [];
    const seen = new Set<string>();
    for (const l of this.logs()) {
      if (!seen.has(l.step_name)) { seen.add(l.step_name); stepNames.push(l.step_name); }
    }
    for (const q of this.qas()) {
      if (!seen.has(q.step_name)) { seen.add(q.step_name); stepNames.push(q.step_name); }
    }
    const current = t.state;
    return stepNames.map((name, i) => {
      const isLast = i === stepNames.length - 1;
      let status: 'done' | 'active' | 'pending' = 'pending';
      if (t.state === 'done' || t.state === 'cancelled') status = 'done';
      else if (isLast && (name === current || true)) status = 'active';
      else status = 'done';
      return { name, status };
    });
  });

  readonly activity = computed<{ key: string; time: string; kind: string; label: string }[]>(() => {
    const rows: { key: string; time: string; kind: string; label: string }[] = [];
    for (const l of this.logs()) {
      rows.push({
        key: `log-${l.id}`,
        time: l.created_at,
        kind: 'log',
        label: `${l.step_name}: log recorded`,
      });
    }
    for (const q of this.qas()) {
      rows.push({
        key: `qa-${q.id}-c`,
        time: q.created_at,
        kind: 'qa',
        label: `QA emitted (${q.step_name}): ${truncate(q.prompt, 100)}`,
      });
      if (q.answered_at && q.answer) {
        rows.push({
          key: `qa-${q.id}-a`,
          time: q.answered_at,
          kind: 'qa',
          label: `QA answered (${q.step_name}): ${truncate(q.answer, 100)}`,
        });
      }
    }
    for (const r of this.reports()) {
      rows.push({
        key: `rpt-${r.id}`,
        time: r.created_at,
        kind: 'report',
        label: `${r.title} [${r.status}]`,
      });
    }
    for (const a of this.audit()) {
      rows.push({
        key: `aud-${a.id}`,
        time: a.created_at,
        kind: 'audit',
        label: a.summary,
      });
    }
    return rows.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
  });

  readonly stateBadgeClass = computed(() => {
    const s = this.task()?.state;
    if (s === 'done') return 'bg-ctp-green/20 text-ctp-green';
    if (s === 'cancelled') return 'bg-overlay-1/20 text-text-secondary';
    if (s === 'failed' || s === 'parked') return 'bg-ctp-red/20 text-ctp-red';
    if (s === 'backlog') return 'bg-bg-subtle text-text-secondary';
    return 'bg-ctp-blue/20 text-ctp-blue';
  });

  readonly canCancel = computed(() => {
    const s = this.task()?.state;
    return !!s && s !== 'done' && s !== 'cancelled' && s !== 'failed';
  });

  readonly canPush = computed(() => this.task()?.state === 'done');

  readonly tabs = [
    { id: 'activity' as const, label: 'Activity', count: () => this.activity().length },
    { id: 'files' as const, label: 'Files', count: () => this.allFiles() },
    { id: 'qa' as const, label: 'Questions', count: () => this.qas().length },
    { id: 'reports' as const, label: 'Reports', count: () => this.reports().length },
  ];

  async ngOnInit(): Promise<void> {
    const id = this.route.snapshot.paramMap.get('taskId');
    if (!id) {
      this.loadError.set('No task id in route.');
      return;
    }
    this.taskId = id;
    await this.refresh();
    this.subs.push(interval(5000).subscribe(() => void this.refresh()));
    const { events$, unsubscribe } = this.stream.connect(id);
    this.streamSub = { unsubscribe };
    this.subs.push(events$.subscribe(() => void this.refresh()));
  }

  ngOnDestroy(): void {
    for (const s of this.subs) s.unsubscribe();
    this.streamSub?.unsubscribe();
    if (this.copyTimer) clearTimeout(this.copyTimer);
  }

  setTab(t: Tab): void { this.tab.set(t); }

  branchOf(t: SpTask): string { return taskBranchName(t.id); }

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

  async cancel(): Promise<void> {
    if (!this.canCancel() || this.cancelling()) return;
    if (!confirm('Cancel this job? This cannot be undone.')) return;
    this.cancelling.set(true);
    try {
      await firstValueFrom(this.tasksApi.transition(this.taskId, 'cancelled'));
      await this.refresh();
    } catch {
      await this.refresh();
    } finally {
      this.cancelling.set(false);
    }
  }

  async copyPushCommand(): Promise<void> {
    const t = this.task();
    if (!t) return;
    const cmd = `git push -u origin ${taskBranchName(t.id)}`;
    try {
      await navigator.clipboard.writeText(cmd);
      this.copied.set(true);
      if (this.copyTimer) clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => this.copied.set(false), 1800);
    } catch {
      window.prompt('Copy this command:', cmd);
    }
  }

  private async refresh(): Promise<void> {
    try {
      const task = await firstValueFrom(this.jobsApi.getTask(this.taskId));
      this.task.set(task);
      this.loadError.set(null);

      const pid = task.project_id;
      if (this.project()?.id !== pid) {
        try {
          const proj = await firstValueFrom(this.dgApi.getProject(pid));
          this.project.set(proj);
        } catch { /* breadcrumb degrades gracefully */ }
      }
      const [qa, logs, reports, files] = await Promise.all([
        firstValueFrom(this.jobsApi.listQa(this.taskId)),
        firstValueFrom(this.jobsApi.listLogs(pid, this.taskId)).catch(() => [] as TaskLogSummary[]),
        firstValueFrom(this.jobsApi.listReports(pid, this.taskId)).catch(() => [] as SpReport[]),
        firstValueFrom(this.jobsApi.filesByStep(this.taskId)).catch(() => [] as StepFileGroup[]),
      ]);
      this.qas.set(qa);
      this.logs.set(logs);
      this.reports.set(reports);
      this.files.set(files);

      // Audit is cheap and adds context. Fail silently.
      try {
        const audit = await firstValueFrom(this.jobsApi.entityAudit('task', this.taskId));
        this.audit.set(audit);
      } catch { /* ignore */ }
    } catch {
      if (!this.task()) this.loadError.set('Could not load this job.');
    }
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
