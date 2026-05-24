import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Subscription, firstValueFrom, interval } from 'rxjs';
import { TasksApiService, SpTask, SpTaskUpdate, ChangedFileSummary } from '../../core/services/tasks-api.service';
import { QaApiService, SpQaItem } from '../../core/services/qa-api.service';
import { ReviewSseService } from '../../core/services/review-sse.service';
import { PlaybooksApiService, SpPlaybook } from '../../core/services/playbooks-api.service';
import { KnowledgeApiService, SpKnowledge } from '../../core/services/knowledge-api.service';
import { VerificationsApiService, SpVerification } from '../../core/services/verifications-api.service';
import { ReportsApiService, SpReport } from '../../core/services/reports-api.service';
import { QaHistoryPanelComponent } from '../../shared/components/qa-history-panel/qa-history-panel';
import {
  AdvancedTaskContext,
  resolveStepConfig,
  ResolvedStepConfig,
} from '../../core/services/override-resolver';

/**
 * UI-5 — Advanced job detail page. Power-user view that surfaces every
 * SoW-1/2/3/4 backend feature for one task.
 *
 * Why a new route instead of refreshing `/dashboard`-style task page:
 * - The legacy task page (under `features/tasks/`) is heavily wired
 *   into observations/decisions/work tabs and would force a sweeping
 *   refactor to keep all that intact while bolting on QA history,
 *   handover chain, resolved playbook, etc.
 * - This page only has to handle one task at a time, with a
 *   power-user audience, so it can take a clean dependency on the
 *   shared override-resolver and qa-history-panel without dragging
 *   the dashboard along.
 * - Existing `/quick/:id` remains the simple flow.
 *
 * Live updates: combine the existing review-stream SSE (for QA
 * `entered`/`left` nudges) with a 4-second polling refresh — identical
 * to `/quick/:id`. No second event stream.
 *
 * Plaintext rendering only (per IMPROVEMENT.md §4): handovers, log
 * snippets, QA prompts/answers all use `{{ ... }}` binding (Angular
 * escapes). No `[innerHTML]`, no auto-linkification.
 */
@Component({
  selector: 'app-advanced-detail',
  standalone: true,
  imports: [CommonModule, RouterLink, DatePipe, QaHistoryPanelComponent],
  template: `
    <div class="max-w-6xl mx-auto py-6 sm:py-10 px-3">
      <div class="mb-4 flex items-center justify-between">
        <a routerLink="/quick" class="text-sm text-text-secondary hover:text-text-primary">
          ← Jobs
        </a>
        <a [routerLink]="['/quick', taskId]" class="text-sm text-text-secondary hover:text-text-primary underline decoration-dotted">
          Open in quick view
        </a>
      </div>

      @if (loadError()) {
        <div class="p-3 rounded-lg bg-ctp-red/10 text-ctp-red text-sm">{{ loadError() }}</div>
      } @else if (!task()) {
        <div class="text-text-secondary">Loading…</div>
      } @else {
        <!-- ── Header ── -->
        <header class="mb-6">
          <h1 class="text-2xl font-semibold text-text-primary break-words">{{ task()!.title }}</h1>
          <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-text-secondary">
            <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full"
                  [class]="stateBadgeClasses()">
              <span class="w-1.5 h-1.5 rounded-full" [class]="stateDotClasses()"></span>
              {{ task()!.state }}
            </span>
            @if (currentStepName()) {
              <span>step: <span class="font-mono text-text-primary">{{ currentStepName() }}</span></span>
            }
            <span>elapsed: {{ elapsed() }}</span>
            <span>cost: \${{ task()!.cost_usd.toFixed(4) }}</span>
            <span>tokens: {{ task()!.input_tokens + task()!.output_tokens | number }}</span>
          </div>
        </header>

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <!-- ── Main column ── -->
          <div class="lg:col-span-2 space-y-6">

            <!-- Step timeline -->
            <section data-testid="adv-timeline" class="rounded-lg border border-border bg-bg-subtle">
              <h2 class="px-4 py-3 text-sm font-semibold text-text-primary border-b border-border">
                Step timeline
              </h2>
              <ol class="divide-y divide-border">
                @for (rs of resolvedSteps(); track rs.step.step) {
                  @let st = stepRuntime(rs.step.name);
                  <li class="px-4 py-3">
                    <details [open]="st.qa.length > 0 || st.isCurrent">
                      <summary class="cursor-pointer flex items-center gap-3 text-sm">
                        <span class="font-mono text-text-secondary w-6">{{ rs.step.step }}.</span>
                        <span class="flex-1 text-text-primary">{{ rs.step.name }}</span>
                        <span class="px-1.5 py-0.5 rounded text-[10px] uppercase"
                              [class]="profileClasses(rs.profile)">{{ rs.profile }}</span>
                        <span class="text-xs"
                              [class]="stepStatusClasses(st.status)">{{ st.status }}</span>
                      </summary>
                      <div class="mt-3 ml-9 space-y-3 text-sm">
                        <dl class="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-xs text-text-secondary">
                          <dt>model</dt><dd>{{ rs.model ?? '—' }}</dd>
                          <dt>budget</dt><dd>{{ rs.budget ?? '—' }}</dd>
                          <dt>qa.responder</dt><dd>{{ rs.qa.responder }}</dd>
                          <dt>qa.accept</dt>
                          <dd [class.text-ctp-yellow]="rs.qa.acceptSource === 'forced'">
                            {{ rs.qa.accept }}@if (rs.qa.acceptSource === 'forced') { <span> (forced)</span> }
                          </dd>
                        </dl>
                        @if (st.qa.length > 0) {
                          <div class="space-y-1">
                            <p class="text-xs text-text-secondary uppercase tracking-wide">QA events</p>
                            @for (qa of st.qa; track qa.id) {
                              <div class="text-xs text-text-secondary">
                                · {{ qa.status }}@if (qa.responder) { <span> by {{ qa.responder }}</span> }
                              </div>
                            }
                          </div>
                        }
                        @if (st.handover) {
                          <div>
                            <p class="text-xs text-text-secondary uppercase tracking-wide">Handover</p>
                            <pre class="text-xs text-text-primary whitespace-pre-wrap break-words font-mono">{{ st.handover.content }}</pre>
                          </div>
                        }
                      </div>
                    </details>
                  </li>
                }
                @if (resolvedSteps().length === 0) {
                  <li class="px-4 py-3 text-sm text-text-secondary">
                    No playbook resolved for this task yet.
                  </li>
                }
              </ol>
            </section>

            <!-- QA panel -->
            <app-qa-history-panel [items]="qaItems()" (answer)="onAnswer($event)" />

            <!-- Handover chain -->
            @if (handovers().length > 0) {
              <section class="rounded-lg border border-border bg-bg-subtle">
                <h2 class="px-4 py-3 text-sm font-semibold text-text-primary border-b border-border">
                  Handover chain
                </h2>
                <ol class="divide-y divide-border">
                  @for (h of handovers(); track h.id) {
                    <li class="px-4 py-3">
                      <details>
                        <summary class="cursor-pointer text-xs text-text-secondary flex items-center justify-between">
                          <span class="font-mono">{{ stepNameFromUpdate(h) ?? 'step' }}</span>
                          <span>{{ h.created_at | date:'short' }}</span>
                          <button type="button"
                                  (click)="copy(h.content); $event.preventDefault(); $event.stopPropagation();"
                                  class="px-2 py-0.5 text-[10px] rounded border border-border hover:bg-surface-hover">
                            copy
                          </button>
                        </summary>
                        <pre class="mt-2 text-xs text-text-primary whitespace-pre-wrap break-words font-mono">{{ h.content }}</pre>
                      </details>
                    </li>
                  }
                </ol>
              </section>
            }

            <!-- Verifications -->
            <section class="rounded-lg border border-border bg-bg-subtle">
              <h2 class="px-4 py-3 text-sm font-semibold text-text-primary border-b border-border">
                Verifications
              </h2>
              @if (verifications().length === 0) {
                <p class="px-4 py-3 text-sm text-text-secondary">No verifications recorded for this task.</p>
              } @else {
                <ul class="divide-y divide-border">
                  @for (v of verifications(); track v.id) {
                    <li class="px-4 py-3 text-sm">
                      <div class="flex items-center justify-between gap-2">
                        <span class="text-text-primary">{{ v.title }}</span>
                        <span class="px-1.5 py-0.5 rounded text-[10px]"
                              [class]="verificationStatusClasses(v.status)">{{ v.status }}</span>
                      </div>
                      @if (v.status === 'fail' && v.detail) {
                        <pre class="mt-2 text-xs text-text-secondary whitespace-pre-wrap break-words font-mono">{{ snippet(v.detail) }}</pre>
                      }
                    </li>
                  }
                </ul>
              }
            </section>

            <!-- Reports -->
            <section class="rounded-lg border border-border bg-bg-subtle">
              <h2 class="px-4 py-3 text-sm font-semibold text-text-primary border-b border-border">
                Reports
              </h2>
              @if (taskReports().length === 0) {
                <p class="px-4 py-3 text-sm text-text-secondary">No reports for this task.</p>
              } @else {
                <ul class="divide-y divide-border">
                  @for (r of taskReports(); track r.id) {
                    <li class="px-4 py-3 text-sm flex items-center justify-between">
                      <span class="text-text-primary">{{ r.title }}</span>
                      <a [routerLink]="['/reports']" class="text-xs text-accent hover:underline">open</a>
                    </li>
                  }
                </ul>
              }
            </section>
          </div>

          <!-- ── Side column ── -->
          <aside class="space-y-6">

            <!-- Cost breakdown -->
            <section data-testid="adv-cost" class="rounded-lg border border-border bg-bg-subtle p-4">
              <h2 class="text-sm font-semibold text-text-primary mb-3">Cost breakdown</h2>
              <dl class="grid grid-cols-[1fr_max-content] gap-y-1 text-xs">
                <dt class="text-text-secondary">Total</dt>
                <dd class="text-text-primary font-mono">\${{ task()!.cost_usd.toFixed(4) }}</dd>
                <dt class="text-text-secondary">Input tokens</dt>
                <dd class="text-text-primary font-mono">{{ task()!.input_tokens | number }}</dd>
                <dt class="text-text-secondary">Output tokens</dt>
                <dd class="text-text-primary font-mono">{{ task()!.output_tokens | number }}</dd>
                @if (responderCost() > 0) {
                  <dt class="text-text-secondary">  ↳ responder calls</dt>
                  <dd class="text-text-primary font-mono">\${{ responderCost().toFixed(4) }}</dd>
                }
              </dl>
              @if (perStepCost().length > 0) {
                <hr class="my-3 border-border" />
                <p class="text-xs text-text-secondary uppercase tracking-wide mb-1.5">Per step</p>
                <dl class="grid grid-cols-[1fr_max-content] gap-y-0.5 text-xs">
                  @for (row of perStepCost(); track row.step) {
                    <dt class="text-text-secondary font-mono truncate">{{ row.step }}</dt>
                    <dd class="text-text-primary font-mono">\${{ row.cost.toFixed(4) }}</dd>
                  }
                </dl>
              }
            </section>

            <!-- Knowledge touched -->
            <section class="rounded-lg border border-border bg-bg-subtle p-4">
              <h2 class="text-sm font-semibold text-text-primary mb-3">Knowledge touched</h2>
              @if (touchedKnowledge().length === 0) {
                <p class="text-xs text-text-secondary">
                  Best-effort — backend has no per-task knowledge filter yet.
                  Listing all project knowledge below; tag with
                  <code class="font-mono">metadata.touched_by_task_id</code> to scope.
                </p>
              } @else {
                <ul class="space-y-1 text-sm">
                  @for (k of touchedKnowledge(); track k.id) {
                    <li>
                      <a [routerLink]="['/knowledge']" [queryParams]="{ id: k.id }"
                         class="text-accent hover:underline">{{ k.title }}</a>
                      <span class="text-xs text-text-secondary"> — {{ k.category }}</span>
                    </li>
                  }
                </ul>
              }
            </section>

            <!-- Playbook used -->
            <section class="rounded-lg border border-border bg-bg-subtle">
              <details>
                <summary class="cursor-pointer px-4 py-3 text-sm font-semibold text-text-primary">
                  Playbook used (resolved)
                </summary>
                <div class="px-4 pb-4">
                  @if (playbook()) {
                    <pre class="text-xs text-text-primary whitespace-pre-wrap break-words font-mono">{{ playbookYaml() }}</pre>
                  } @else {
                    <p class="text-xs text-text-secondary">Playbook unavailable.</p>
                  }
                </div>
              </details>
            </section>

            <!-- Changed files / diff link -->
            @if (changedFiles().length > 0) {
              <section class="rounded-lg border border-border bg-bg-subtle p-4">
                <h2 class="text-sm font-semibold text-text-primary mb-2">Changed files ({{ changedFiles().length }})</h2>
                <ul class="space-y-0.5 text-xs font-mono text-text-secondary max-h-48 overflow-y-auto">
                  @for (f of changedFiles(); track f.id) {
                    <li>
                      <span [class]="changeBadgeClasses(f.change_type)">{{ f.change_type[0].toUpperCase() }}</span>
                      <span class="ml-1.5">{{ f.path }}</span>
                    </li>
                  }
                </ul>
              </section>
            }

            <!-- Raw logs link -->
            <p class="text-xs text-text-secondary">
              <a [routerLink]="['/integrations', 'logs']" class="hover:text-text-primary underline">View raw logs</a>
            </p>
          </aside>
        </div>
      }
    </div>
  `,
})
export class AdvancedDetailPage implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private tasksApi = inject(TasksApiService);
  private qaApi = inject(QaApiService);
  private playbooksApi = inject(PlaybooksApiService);
  private knowledgeApi = inject(KnowledgeApiService);
  private verificationsApi = inject(VerificationsApiService);
  private reportsApi = inject(ReportsApiService);
  private reviewSse = inject(ReviewSseService);

  readonly task = signal<SpTask | null>(null);
  readonly updates = signal<SpTaskUpdate[]>([]);
  readonly qaItems = signal<SpQaItem[]>([]);
  readonly playbook = signal<SpPlaybook | null>(null);
  readonly knowledge = signal<SpKnowledge[]>([]);
  readonly verifications = signal<SpVerification[]>([]);
  readonly reports = signal<SpReport[]>([]);
  readonly changedFiles = signal<ChangedFileSummary[]>([]);
  readonly loadError = signal<string | null>(null);

  taskId = '';
  private subs: Subscription[] = [];
  private now = signal(Date.now());

  async ngOnInit(): Promise<void> {
    this.taskId = this.route.snapshot.paramMap.get('id') ?? '';
    if (!this.taskId) {
      this.loadError.set('Missing task id.');
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
      const [task, updates, qa, files] = await Promise.all([
        firstValueFrom(this.tasksApi.get(this.taskId)),
        firstValueFrom(this.tasksApi.listUpdates(this.taskId)),
        firstValueFrom(this.qaApi.list({ task_id: this.taskId, limit: 100 })),
        firstValueFrom(this.tasksApi.listChangedFiles(this.taskId)).catch(() => [] as ChangedFileSummary[]),
      ]);
      this.task.set(task);
      this.updates.set(updates);
      this.qaItems.set(qa);
      this.changedFiles.set(files);
      this.loadError.set(null);
      // First-time-only side loads. Cheap to repeat; bail if already loaded.
      void this.loadAuxiliary(task);
    } catch {
      if (!this.task()) this.loadError.set('Could not load this job.');
    }
  }

  private async loadAuxiliary(task: SpTask): Promise<void> {
    if (!this.playbook() && task.playbook_id) {
      try {
        const pbs = await firstValueFrom(this.playbooksApi.listForProject(task.project_id));
        const pb = pbs.find(p => p.id === task.playbook_id) ?? null;
        this.playbook.set(pb);
      } catch {
        /* best-effort */
      }
    }
    if (this.knowledge().length === 0) {
      try {
        const ks = await firstValueFrom(this.knowledgeApi.list());
        this.knowledge.set(ks);
      } catch {
        /* best-effort */
      }
    }
    try {
      const vs = await firstValueFrom(this.verificationsApi.list({ task_id: this.taskId }));
      this.verifications.set(vs.data);
    } catch {
      /* best-effort */
    }
    if (this.reports().length === 0) {
      try {
        const rs = await firstValueFrom(this.reportsApi.list());
        this.reports.set(rs);
      } catch {
        /* best-effort */
      }
    }
  }

  // ── Derived ──

  /** Build the resolved playbook view via the shared override-resolver. */
  readonly resolvedSteps = computed<ResolvedStepConfig[]>(() => {
    const pb = this.playbook();
    const tk = this.task();
    if (!pb || !tk) return [];
    return pb.steps.map(s => resolveStepConfig(s, tk.context as AdvancedTaskContext));
  });

  readonly currentStepName = computed(() => {
    const tk = this.task();
    const pb = this.playbook();
    if (!tk) return '';
    if (pb && tk.playbook_step != null) {
      const found = pb.steps.find(s => s.step === tk.playbook_step);
      if (found) return found.name;
    }
    const s = tk.state;
    if (s.startsWith('wait:')) return s.slice(5);
    return s;
  });

  readonly handovers = computed(() =>
    this.updates().filter(u => u.kind === 'handover'),
  );

  /**
   * Per-step runtime view: collects QA items + the latest handover row
   * keyed by step_name. Best-effort — handover rows must carry
   * `metadata.step_name` for this to attach correctly; falls back to
   * "any unattached handover lands on the current step" so the UI
   * always shows something.
   */
  stepRuntime(stepName: string): { qa: SpQaItem[]; handover: SpTaskUpdate | undefined; status: string; isCurrent: boolean } {
    const qa = this.qaItems().filter(q => q.step_name === stepName);
    const handover = this.handovers().find(h => stepNameFromMetadata(h) === stepName);
    const current = this.currentStepName() === stepName;
    let status = 'pending';
    if (qa.some(q => q.status === 'pending')) status = 'qa-pending';
    else if (handover) status = 'done';
    else if (current) status = 'running';
    else status = '—';
    return { qa, handover, status, isCurrent: current };
  }

  stepNameFromUpdate(u: SpTaskUpdate): string | null {
    return stepNameFromMetadata(u);
  }

  /** Generate a flat YAML-ish text view of the resolved playbook. */
  readonly playbookYaml = computed(() => {
    const pb = this.playbook();
    if (!pb) return '';
    const tk = this.task();
    const ctx = (tk?.context ?? {}) as AdvancedTaskContext;
    const lines: string[] = [`title: ${pb.title}`, 'steps:'];
    for (const s of pb.steps) {
      const r = resolveStepConfig(s, ctx);
      lines.push(`  - name: ${s.name}`);
      lines.push(`    step: ${s.step}`);
      if (r.model) lines.push(`    model: ${r.model}${r.modelSource === 'override' ? '   # override' : ''}`);
      if (r.budget !== undefined) lines.push(`    budget: ${r.budget}${r.budgetSource === 'override' ? '   # override' : ''}`);
      lines.push(`    qa:`);
      lines.push(`      responder: ${r.qa.responder}${r.qa.responderSource === 'override' ? '   # override' : ''}`);
      lines.push(`      accept: ${r.qa.accept}${
        r.qa.acceptSource === 'override' ? '   # override' :
        r.qa.acceptSource === 'forced' ? '   # forced (SoW-2)' : ''
      }`);
      lines.push(`      min_confidence: ${r.qa.min_confidence}${r.qa.min_confidenceSource === 'override' ? '   # override' : ''}`);
      lines.push(`      on_irreversible: ${r.qa.on_irreversible}${r.qa.on_irreversibleSource === 'override' ? '   # override' : ''}`);
    }
    return lines.join('\n');
  });

  readonly touchedKnowledge = computed<SpKnowledge[]>(() => {
    // Backend has no per-task filter yet (see SCOPE.md Known Gaps).
    // Honour metadata.touched_by_task_id if anyone has tagged it.
    const id = this.taskId;
    return this.knowledge().filter(k => {
      const tag = (k.metadata as Record<string, unknown>)?.['touched_by_task_id'];
      return tag === id;
    });
  });

  readonly taskReports = computed(() => this.reports().filter(r => r.task_id === this.taskId));

  /** Cost attributed to responder QA calls (sum of qa.metadata.cost_usd). */
  readonly responderCost = computed<number>(() => {
    return this.qaItems().reduce((acc, q) => {
      const v = (q.metadata as Record<string, unknown>)?.['cost_usd'];
      return acc + (typeof v === 'number' ? v : 0);
    }, 0);
  });

  /** Per-step cost rollup, derived from task_updates metadata.cost_usd. */
  readonly perStepCost = computed<{ step: string; cost: number }[]>(() => {
    const byStep = new Map<string, number>();
    for (const u of this.updates()) {
      const v = (u.metadata as Record<string, unknown>)?.['cost_usd'];
      const step = stepNameFromMetadata(u) ?? 'unknown';
      if (typeof v === 'number') {
        byStep.set(step, (byStep.get(step) ?? 0) + v);
      }
    }
    return Array.from(byStep, ([step, cost]) => ({ step, cost }));
  });

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

  // ── Actions ──

  async onAnswer(ev: { qa: SpQaItem; answer: string }): Promise<void> {
    try {
      await firstValueFrom(this.qaApi.answer(ev.qa.id, {
        answer: ev.answer,
        target_step: ev.qa.step_name,
      }));
      await this.refresh();
    } catch {
      await this.refresh();
    }
  }

  copy(text: string): void {
    void navigator.clipboard?.writeText(text);
  }

  // ── UI classes ──

  stateBadgeClasses(): string {
    const s = this.task()?.state ?? '';
    if (s === 'done') return 'bg-ctp-green/15 text-ctp-green';
    if (s === 'cancelled') return 'bg-overlay-1/20 text-text-secondary';
    if (s === 'human_review' || s === 'ai_review') return 'bg-ctp-yellow/15 text-ctp-yellow';
    return 'bg-ctp-blue/15 text-ctp-blue';
  }
  stateDotClasses(): string {
    const s = this.task()?.state ?? '';
    if (s === 'done') return 'bg-ctp-green';
    if (s === 'cancelled') return 'bg-overlay-1';
    if (s === 'human_review' || s === 'ai_review') return 'bg-ctp-yellow animate-pulse';
    return 'bg-ctp-blue animate-pulse';
  }
  profileClasses(p: string): string {
    switch (p) {
      case 'merge': return 'bg-ctp-red/20 text-ctp-red';
      case 'review': return 'bg-ctp-yellow/20 text-ctp-yellow';
      case 'implement': return 'bg-ctp-blue/20 text-ctp-blue';
      case 'dream': return 'bg-ctp-mauve/20 text-ctp-mauve';
      default: return 'bg-overlay-1/20 text-text-secondary';
    }
  }
  stepStatusClasses(s: string): string {
    switch (s) {
      case 'done': return 'text-ctp-green';
      case 'running': return 'text-ctp-blue';
      case 'qa-pending': return 'text-ctp-yellow';
      default: return 'text-text-secondary';
    }
  }
  verificationStatusClasses(s: string): string {
    switch (s) {
      case 'pass': return 'bg-ctp-green/15 text-ctp-green';
      case 'fail': return 'bg-ctp-red/15 text-ctp-red';
      case 'skipped': return 'bg-overlay-1/15 text-text-secondary';
      default: return 'bg-ctp-yellow/15 text-ctp-yellow';
    }
  }
  changeBadgeClasses(t: string): string {
    switch (t) {
      case 'added': return 'inline-block w-4 text-center text-ctp-green';
      case 'modified': return 'inline-block w-4 text-center text-ctp-yellow';
      case 'deleted': return 'inline-block w-4 text-center text-ctp-red';
      default: return 'inline-block w-4 text-center';
    }
  }

  snippet(s: string): string {
    return s.length > 400 ? s.slice(0, 397) + '…' : s;
  }
}

function stepNameFromMetadata(u: SpTaskUpdate): string | null {
  const v = (u.metadata as Record<string, unknown>)?.['step_name'];
  return typeof v === 'string' ? v : null;
}
