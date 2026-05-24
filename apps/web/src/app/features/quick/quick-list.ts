import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { TranslocoModule } from '@jsverse/transloco';
import { Subscription, firstValueFrom, interval } from 'rxjs';
import { TasksApiService, SpTask } from '../../core/services/tasks-api.service';
import { QaApiService, SpQaItem } from '../../core/services/qa-api.service';
import { DiraigentApiService, DgProject } from '../../core/services/diraigent-api.service';
import { ReviewSseService } from '../../core/services/review-sse.service';
import { ProjectContext } from '../../core/services/project-context.service';
import { setUiMode } from '../../core/guards/default-route.guard';

interface QuickRow {
  task: SpTask;
  hasPendingQa: boolean;
}

/**
 * UI-3 — `/quick` list. Three groups: Needs you (pending QA),
 * Running (in any step state), Recent (last 20 done/cancelled).
 *
 * Polls every 5s and listens to the review SSE for instant promotion
 * of a task into "Needs you" when a QA enters.
 */
@Component({
  selector: 'app-quick-list',
  standalone: true,
  imports: [CommonModule, RouterLink, TranslocoModule, DatePipe],
  template: `
    <div class="max-w-4xl mx-auto py-6 sm:py-10 px-3" *transloco="let t">
      <div class="mb-6 flex items-center justify-between gap-3">
        <h1 class="text-2xl font-semibold text-text-primary">{{ t('quick.listTitle') }}</h1>
        <div class="flex items-center gap-3">
          <a routerLink="/dashboard" (click)="flipToAdvanced()"
             class="hidden sm:inline text-sm text-text-secondary hover:text-text-primary underline decoration-dotted">
            {{ t('quick.advancedLink') }}
          </a>
          <a routerLink="/quick/new" data-testid="quick-new-button"
             class="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:opacity-90">
            + {{ t('quick.newButton') }}
          </a>
        </div>
      </div>

      <!-- Project switcher (only when >1 project) -->
      @if (projects().length > 1) {
        <div class="mb-4 flex items-center gap-2 text-sm">
          <label for="quick-list-project" class="text-text-secondary">{{ t('quick.fieldProject') }}:</label>
          <select id="quick-list-project" [value]="selectedProjectId()" (change)="onSelectProject($event)"
                  class="px-2 py-1 rounded border border-border bg-bg-subtle text-text-primary text-sm">
            @for (p of projects(); track p.id) {
              <option [value]="p.id">{{ p.name }}</option>
            }
          </select>
        </div>
      }

      @if (loadError()) {
        <div class="p-3 rounded-lg bg-ctp-red/10 text-ctp-red text-sm">{{ loadError() }}</div>
      }

      <!-- Needs you -->
      <section class="mb-6">
        <h2 class="text-sm font-semibold text-ctp-yellow uppercase tracking-wide mb-2">
          {{ t('quick.groupNeedsYou') }}
          @if (needsYou().length > 0) {
            <span class="ml-2 px-1.5 py-0.5 text-xs rounded-full bg-ctp-yellow/20 text-ctp-yellow">
              {{ needsYou().length }}
            </span>
          }
        </h2>
        @if (needsYou().length === 0) {
          <p class="text-sm text-text-secondary">{{ t('quick.noNeedsYou') }}</p>
        } @else {
          <ul class="space-y-1.5" data-testid="quick-needs-you">
            @for (row of needsYou(); track row.task.id) {
              <li>
                <a [routerLink]="['/quick', row.task.id]"
                   class="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-ctp-yellow/30
                          bg-ctp-yellow/5 hover:bg-ctp-yellow/10">
                  <span class="text-text-primary truncate">{{ row.task.title }}</span>
                  <span class="text-xs text-text-secondary shrink-0">{{ row.task.updated_at | date:'short' }}</span>
                </a>
              </li>
            }
          </ul>
        }
      </section>

      <!-- Running -->
      <section class="mb-6">
        <h2 class="text-sm font-semibold text-ctp-blue uppercase tracking-wide mb-2">
          {{ t('quick.groupRunning') }}
        </h2>
        @if (running().length === 0) {
          <p class="text-sm text-text-secondary">{{ t('quick.noRunning') }}</p>
        } @else {
          <ul class="space-y-1.5">
            @for (row of running(); track row.task.id) {
              <li>
                <a [routerLink]="['/quick', row.task.id]"
                   class="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-border
                          bg-bg-subtle hover:bg-surface-hover">
                  <span class="flex items-center gap-2 min-w-0">
                    <span class="w-1.5 h-1.5 rounded-full bg-ctp-blue animate-pulse shrink-0"></span>
                    <span class="text-text-primary truncate">{{ row.task.title }}</span>
                  </span>
                  <span class="text-xs text-text-secondary shrink-0 font-mono">
                    {{ row.task.state }} · \${{ row.task.cost_usd.toFixed(4) }}
                  </span>
                </a>
              </li>
            }
          </ul>
        }
      </section>

      <!-- Recent -->
      <section>
        <h2 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-2">
          {{ t('quick.groupRecent') }}
        </h2>
        @if (recent().length === 0) {
          <p class="text-sm text-text-secondary">{{ t('quick.noRecent') }}</p>
        } @else {
          <ul class="space-y-1.5">
            @for (row of recent(); track row.task.id) {
              <li>
                <a [routerLink]="['/quick', row.task.id]"
                   class="flex items-center justify-between gap-3 px-3 py-2 rounded-lg hover:bg-bg-subtle">
                  <span class="flex items-center gap-2 min-w-0">
                    <span class="w-1.5 h-1.5 rounded-full shrink-0"
                          [class.bg-ctp-green]="row.task.state === 'done'"
                          [class.bg-overlay-1]="row.task.state === 'cancelled'"></span>
                    <span class="text-text-primary truncate">{{ row.task.title }}</span>
                  </span>
                  <span class="text-xs text-text-secondary shrink-0">
                    {{ row.task.state }} · {{ row.task.completed_at ?? row.task.updated_at | date:'short' }}
                  </span>
                </a>
              </li>
            }
          </ul>
        }
      </section>
    </div>
  `,
})
export class QuickListPage implements OnInit, OnDestroy {
  private tasksApi = inject(TasksApiService);
  private qaApi = inject(QaApiService);
  private dgApi = inject(DiraigentApiService);
  private reviewSse = inject(ReviewSseService);
  private projectCtx = inject(ProjectContext);
  private router = inject(Router);

  readonly projects = signal<DgProject[]>([]);
  readonly selectedProjectId = signal<string>('');
  readonly tasks = signal<SpTask[]>([]);
  readonly pendingTaskIds = signal<Set<string>>(new Set());
  readonly loadError = signal<string | null>(null);

  private subs: Subscription[] = [];

  readonly rows = computed<QuickRow[]>(() => {
    const pending = this.pendingTaskIds();
    return this.tasks().map(t => ({ task: t, hasPendingQa: pending.has(t.id) }));
  });

  readonly needsYou = computed(() => this.rows().filter(r => r.hasPendingQa));

  readonly running = computed(() => this.rows().filter(r => {
    if (r.hasPendingQa) return false;
    const s = r.task.state;
    return s !== 'done' && s !== 'cancelled' && s !== 'backlog';
  }));

  readonly recent = computed(() => this.rows()
    .filter(r => r.task.state === 'done' || r.task.state === 'cancelled')
    .sort((a, b) => {
      const ax = new Date(a.task.completed_at ?? a.task.updated_at).getTime();
      const bx = new Date(b.task.completed_at ?? b.task.updated_at).getTime();
      return bx - ax;
    })
    .slice(0, 20));

  async ngOnInit(): Promise<void> {
    // Visiting /quick is implicit "I prefer quick mode" — flip the pref
    // so '/' redirects here next time.
    setUiMode('quick');
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
      this.loadError.set('Could not load jobs.');
    }
    this.subs.push(interval(5000).subscribe(() => void this.refresh()));
    this.subs.push(this.reviewSse.events.subscribe(() => void this.refresh()));
  }

  ngOnDestroy(): void {
    for (const s of this.subs) s.unsubscribe();
  }

  flipToAdvanced(): void {
    setUiMode('advanced');
  }

  onSelectProject(ev: Event): void {
    const pid = (ev.target as HTMLSelectElement).value;
    this.selectedProjectId.set(pid);
    this.projectCtx.select(pid);
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    const pid = this.selectedProjectId();
    if (!pid) return;
    try {
      const [page, qa] = await Promise.all([
        firstValueFrom(this.tasksApi.listForProject(pid, { limit: 100 })),
        firstValueFrom(this.qaApi.list({ project_id: pid, status: 'pending', limit: 200 })),
      ]);
      this.tasks.set(page.data);
      this.pendingTaskIds.set(new Set(qa.map((q: SpQaItem) => q.task_id)));
      this.loadError.set(null);
    } catch {
      if (this.tasks().length === 0) this.loadError.set('Could not load jobs.');
    }
  }
}
