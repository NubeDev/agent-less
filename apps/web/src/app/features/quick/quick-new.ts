import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { TranslocoModule } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { DiraigentApiService, DgProject } from '../../core/services/diraigent-api.service';
import { TasksApiService, CreateTaskRequest } from '../../core/services/tasks-api.service';
import { PlaybooksApiService, SpPlaybook } from '../../core/services/playbooks-api.service';
import { ProjectContext } from '../../core/services/project-context.service';
import { setUiMode } from '../../core/guards/default-route.guard';

/**
 * UI-1 screen 1 — "New job". Five fields, no jargon.
 *
 * Submits a task and redirects to `/quick/:id`. Deliberately does NOT
 * touch agents, roles, members, kinds, integrations, knowledge,
 * decisions, observations, or step templates. Power users follow the
 * "Advanced…" link at the bottom for the full dashboard.
 */
@Component({
  selector: 'app-quick-new',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, TranslocoModule],
  template: `
    <div class="max-w-2xl mx-auto py-6 sm:py-10 px-3" *transloco="let t">
      <div class="mb-6 flex items-center justify-between">
        <h1 class="text-2xl font-semibold text-text-primary">{{ t('quick.newTitle') }}</h1>
        <a routerLink="/quick" class="text-sm text-text-secondary hover:text-text-primary">
          {{ t('quick.backToList') }}
        </a>
      </div>

      @if (loadError()) {
        <div class="mb-4 p-3 rounded-lg bg-ctp-red/10 text-ctp-red text-sm">
          {{ loadError() }}
        </div>
      }

      <form (ngSubmit)="submit()" class="space-y-5">
        <!-- 1. Project -->
        @if (projects().length > 1) {
          <div>
            <label for="quick-project" class="block text-sm font-medium text-text-secondary mb-1">
              {{ t('quick.fieldProject') }}
            </label>
            <select id="quick-project" name="project" [(ngModel)]="projectId"
                    class="w-full px-3 py-2 rounded-lg border border-border bg-bg-subtle text-text-primary
                           focus:outline-none focus:ring-2 focus:ring-accent">
              @for (p of projects(); track p.id) {
                <option [value]="p.id">{{ p.name }}</option>
              }
            </select>
          </div>
        }

        <!-- 2. What to do -->
        <div>
          <label for="quick-spec" class="block text-sm font-medium text-text-secondary mb-1">
            {{ t('quick.fieldSpec') }}
          </label>
          <textarea id="quick-spec" name="spec" [(ngModel)]="spec" required rows="5"
                    [placeholder]="t('quick.fieldSpecPlaceholder')"
                    class="w-full px-3 py-2 rounded-lg border border-border bg-bg-subtle text-text-primary
                           focus:outline-none focus:ring-2 focus:ring-accent font-mono text-sm"></textarea>
        </div>

        <!-- 3. Files involved (optional) -->
        <div>
          <label for="quick-files" class="block text-sm font-medium text-text-secondary mb-1">
            {{ t('quick.fieldFiles') }}
          </label>
          <input id="quick-files" name="files" type="text" [(ngModel)]="filesCsv"
                 [placeholder]="t('quick.fieldFilesPlaceholder')"
                 class="w-full px-3 py-2 rounded-lg border border-border bg-bg-subtle text-text-primary
                        focus:outline-none focus:ring-2 focus:ring-accent font-mono text-sm">
        </div>

        <!-- 4. How to verify -->
        <div>
          <label for="quick-verify" class="block text-sm font-medium text-text-secondary mb-1">
            {{ t('quick.fieldVerify') }}
          </label>
          <textarea id="quick-verify" name="verify" [(ngModel)]="verify" rows="3"
                    [placeholder]="t('quick.fieldVerifyPlaceholder')"
                    class="w-full px-3 py-2 rounded-lg border border-border bg-bg-subtle text-text-primary
                           focus:outline-none focus:ring-2 focus:ring-accent font-mono text-sm"></textarea>
        </div>

        <!-- 5. Playbook (hidden if only one) -->
        @if (playbooks().length > 1) {
          <div>
            <label for="quick-playbook" class="block text-sm font-medium text-text-secondary mb-1">
              {{ t('quick.fieldPlaybook') }}
            </label>
            <select id="quick-playbook" name="playbook" [(ngModel)]="playbookId"
                    class="w-full px-3 py-2 rounded-lg border border-border bg-bg-subtle text-text-primary
                           focus:outline-none focus:ring-2 focus:ring-accent">
              @for (pb of playbooks(); track pb.id) {
                <option [value]="pb.id">{{ pb.title }}</option>
              }
            </select>
          </div>
        }

        @if (title()) {
          <p class="text-xs text-text-secondary">
            {{ t('quick.titlePreviewLabel') }} <span class="font-mono text-text-primary">{{ title() }}</span>
          </p>
        }

        @if (submitError()) {
          <div class="p-3 rounded-lg bg-ctp-red/10 text-ctp-red text-sm">
            {{ submitError() }}
          </div>
        }

        <div class="flex items-center justify-between pt-2">
          <a routerLink="/dashboard" (click)="flipToAdvanced()"
             class="text-sm text-text-secondary hover:text-text-primary underline decoration-dotted">
            {{ t('quick.advancedLink') }}
          </a>
          <button type="submit" [disabled]="!canSubmit() || submitting()"
                  data-testid="quick-submit"
                  class="px-6 py-2 rounded-lg bg-accent text-white font-medium
                         disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90 transition-opacity">
            {{ submitting() ? t('quick.submitting') : t('quick.submit') }}
          </button>
        </div>
      </form>
    </div>
  `,
})
export class QuickNewPage implements OnInit {
  private dgApi = inject(DiraigentApiService);
  private tasksApi = inject(TasksApiService);
  private playbooksApi = inject(PlaybooksApiService);
  private router = inject(Router);
  private projectCtx = inject(ProjectContext);

  readonly projects = signal<DgProject[]>([]);
  readonly playbooks = signal<SpPlaybook[]>([]);
  readonly loadError = signal<string | null>(null);
  readonly submitError = signal<string | null>(null);
  readonly submitting = signal(false);

  projectId = '';
  spec = '';
  filesCsv = '';
  verify = '';
  playbookId = '';

  readonly title = computed(() => {
    const trimmed = this.spec.trim();
    if (!trimmed) return '';
    const firstLine = trimmed.split('\n')[0];
    return firstLine.length > 80 ? firstLine.slice(0, 77) + '…' : firstLine;
  });

  canSubmit(): boolean {
    return !!this.projectId && this.spec.trim().length > 0;
  }

  /** Persist the user's choice so '/' redirects to /dashboard next time. */
  flipToAdvanced(): void {
    setUiMode('advanced');
  }

  async ngOnInit(): Promise<void> {
    try {
      const projects = await firstValueFrom(this.dgApi.getProjects());
      this.projects.set(projects);
      if (projects.length === 0) {
        this.loadError.set('No projects available. Ask an admin to create one.');
        return;
      }
      const stored = this.projectCtx.projectId();
      this.projectId = projects.find(p => p.id === stored)?.id ?? projects[0].id;
    } catch {
      this.loadError.set('Could not load projects.');
      return;
    }

    // Playbooks are optional — the API endpoint is `/v1/projects/{id}/playbooks`
    // and a missing/failing call should not block job creation. The server
    // applies the project's default playbook when `playbook_id` is omitted.
    try {
      const playbooks = await firstValueFrom(this.playbooksApi.listForProject(this.projectId));
      this.playbooks.set(playbooks);
      const standard = playbooks.find(pb => pb.title.toLowerCase().includes('standard'));
      this.playbookId = standard?.id ?? playbooks[0]?.id ?? '';
    } catch {
      this.playbooks.set([]);
      this.playbookId = '';
    }
  }

  async submit(): Promise<void> {
    if (!this.canSubmit() || this.submitting()) return;
    this.submitting.set(true);
    this.submitError.set(null);

    // Keep the selected project as the user's "current project" so
    // shared services (tasks list, SSE filtering) reflect the choice.
    if (this.projectId && this.projectId !== this.projectCtx.projectId()) {
      this.projectCtx.select(this.projectId);
    }

    const files = this.filesCsv
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    const context: Record<string, unknown> = {
      spec: this.spec.trim(),
    };
    if (files.length > 0) context['files'] = files;
    const verifyTrimmed = this.verify.trim();
    if (verifyTrimmed) context['acceptance_criteria'] = [verifyTrimmed];

    const req: CreateTaskRequest = {
      title: this.title() || this.spec.trim().slice(0, 80),
      context,
    };
    if (this.playbookId) req.playbook_id = this.playbookId;

    try {
      const created = await firstValueFrom(this.tasksApi.create(req));
      this.router.navigate(['/quick', created.id]);
    } catch (err) {
      const e = err as { error?: { message?: string }; message?: string };
      this.submitError.set(e?.error?.message ?? e?.message ?? 'Failed to create job.');
      this.submitting.set(false);
    }
  }
}
