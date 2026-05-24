import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { DiraigentApiService, DgProject } from '../../core/services/diraigent-api.service';
import { TasksApiService, CreateTaskRequest } from '../../core/services/tasks-api.service';
import { PlaybooksApiService, SpPlaybook } from '../../core/services/playbooks-api.service';
import { KnowledgeApiService, SpKnowledge } from '../../core/services/knowledge-api.service';
import { VerificationsApiService, SpVerification } from '../../core/services/verifications-api.service';
import { AgentsApiService, SpAgent } from '../../core/services/agents-api.service';
import { ProjectContext } from '../../core/services/project-context.service';
import {
  AdvancedTaskContext,
  buildTaskContext,
  resolveStepConfig,
  validateOverrides,
  ResolvedStepConfig,
} from '../../core/services/override-resolver';

/**
 * UI-4 — Advanced job creation form. One screen, collapsible sections,
 * every backend feature SoW-1/2/3/4 introduced is configurable per job.
 *
 * Mirrors `/quick/new` for the "What" section then layers per-task
 * overrides on top. Submits a single POST /tasks with a fat
 * `task.context` payload and redirects to `/advanced/:id`.
 *
 * Design notes:
 * - Live preview right column shows the resolved playbook step list
 *   (via `resolveStepConfig`), highlighting fields that come from
 *   overrides and any safety upgrades the backend will force.
 * - Validation runs on every change; submit button disables with a
 *   reason rendered below it. The validator mirrors the SoW-2 backend
 *   so the user can't submit something the worker will refuse.
 * - "Save as template" persists form state to localStorage under a
 *   user-named key (default `last`). No server round-trip — templates
 *   are a personal shortcut, not a shared resource.
 */

const TEMPLATE_KEY_PREFIX = 'diraigent.advanced.template.';

interface FormState {
  // What
  spec: string;
  filesCsv: string;
  acceptanceCriteria: string;
  // Playbook
  projectId: string;
  playbookId: string;
  modelOverride: string;
  budgetCap: string; // string for input binding; parsed on submit
  // Session
  sessionMode: 'per_step' | 'shared';
  preserveWorktree: boolean;
  // QA
  qaResponder: 'playbook_default' | 'ai' | 'human';
  qaAccept: 'playbook_default' | 'confidence' | 'second_pass' | 'always_human' | 'always_ai';
  qaMinConfidence: string;
  qaOnIrreversible: 'playbook_default' | 'human';
  // Knowledge
  pinnedKnowledgeIds: string[];
  excludeTagsCsv: string;
  // Verifications
  verificationIds: string[];
  failFast: boolean;
  extraTestCmd: string;
  // Reports
  reports: string[];
  // Integrations / agent
  agentId: string;
  integrations: { forgejo: boolean; github: boolean };
  // Raw
  rawContextJson: string;
  envCsv: string;
  mcpJson: string;
}

const REPORT_TYPES = [
  { id: 'diff_summary', label: 'Diff summary' },
  { id: 'cost_breakdown', label: 'Cost breakdown' },
  { id: 'qa_log', label: 'QA log' },
  { id: 'handover_chain', label: 'Handover chain' },
  { id: 'knowledge_touched', label: 'Knowledge touched' },
] as const;

@Component({
  selector: 'app-advanced-new',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  template: `
    <div class="max-w-7xl mx-auto py-6 sm:py-10 px-3">
      <div class="mb-6 flex items-center justify-between">
        <div>
          <h1 class="text-2xl font-semibold text-text-primary">New job (advanced)</h1>
          <p class="text-sm text-text-secondary mt-1">
            Every backend knob, one screen. For day-to-day use see
            <a routerLink="/quick/new" class="underline decoration-dotted hover:text-text-primary">/quick/new</a>.
          </p>
        </div>
        <div class="flex items-center gap-2">
          <input type="text" [(ngModel)]="templateName" placeholder="template name"
                 class="w-32 px-2 py-1 text-xs rounded border border-border bg-bg-subtle text-text-primary
                        focus:outline-none focus:ring-1 focus:ring-accent" />
          <button type="button" (click)="saveTemplate()"
                  class="px-2 py-1 text-xs rounded border border-border text-text-secondary
                         hover:text-text-primary hover:bg-surface-hover">
            Save as template
          </button>
          <button type="button" (click)="loadTemplate()"
                  class="px-2 py-1 text-xs rounded border border-border text-text-secondary
                         hover:text-text-primary hover:bg-surface-hover">
            Load
          </button>
        </div>
      </div>

      @if (loadError()) {
        <div class="mb-4 p-3 rounded-lg bg-ctp-red/10 text-ctp-red text-sm"
             role="alert" aria-live="assertive">{{ loadError() }}</div>
      }

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <!-- ────────── Form (left column) ────────── -->
        <form (ngSubmit)="submit()" class="space-y-3">

          <!-- 1. What — pre-expanded -->
          <details open class="rounded-lg border border-border bg-bg-subtle">
            <summary class="cursor-pointer px-4 py-3 text-sm font-medium text-text-primary">
              1. What to do
            </summary>
            <div class="px-4 pb-4 space-y-3">
              <div>
                <label class="block text-xs font-medium text-text-secondary mb-1"><span>Spec</span>
                  <textarea [(ngModel)]="form.spec" name="spec" required rows="4"
                          placeholder="Plain English description of the task."
                          class="w-full px-2 py-1.5 rounded border border-border bg-bg text-text-primary
                                 focus:outline-none focus:ring-1 focus:ring-accent font-mono text-sm"></textarea>
                </label>
              </div>
              <div>
                <label class="block text-xs font-medium text-text-secondary mb-1"><span>Files (comma-separated, optional)</span>
                  <input type="text" [(ngModel)]="form.filesCsv" name="files"
                       class="w-full px-2 py-1.5 rounded border border-border bg-bg text-text-primary
                              focus:outline-none focus:ring-1 focus:ring-accent font-mono text-sm" />
                </label>
              </div>
              <div>
                <label class="block text-xs font-medium text-text-secondary mb-1"><span>Acceptance criteria (one per line)</span>
                  <textarea [(ngModel)]="form.acceptanceCriteria" name="ac" rows="3"
                          class="w-full px-2 py-1.5 rounded border border-border bg-bg text-text-primary
                                 focus:outline-none focus:ring-1 focus:ring-accent font-mono text-sm"></textarea>
                </label>
              </div>
            </div>
          </details>

          <!-- 2. Playbook -->
          <details open class="rounded-lg border border-border bg-bg-subtle">
            <summary class="cursor-pointer px-4 py-3 text-sm font-medium text-text-primary">
              2. Playbook
            </summary>
            <div class="px-4 pb-4 space-y-3">
              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label class="block text-xs font-medium text-text-secondary mb-1"><span>Project</span>
                    <select [(ngModel)]="form.projectId" name="project" (change)="onProjectChange()"
                            class="w-full px-2 py-1.5 rounded border border-border bg-bg text-text-primary
                                   focus:outline-none focus:ring-1 focus:ring-accent text-sm">
                      @for (p of projects(); track p.id) {
                        <option [value]="p.id">{{ p.name }}</option>
                      }
                    </select>
                  </label>
                </div>
                <div>
                  <label class="block text-xs font-medium text-text-secondary mb-1"><span>Playbook</span>
                    <select [(ngModel)]="form.playbookId" name="playbook"
                            class="w-full px-2 py-1.5 rounded border border-border bg-bg text-text-primary
                                   focus:outline-none focus:ring-1 focus:ring-accent text-sm">
                      <option value="">(project default)</option>
                      @for (pb of playbooks(); track pb.id) {
                        <option [value]="pb.id">{{ pb.title }}</option>
                      }
                    </select>
                  </label>
                </div>
              </div>
              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label class="block text-xs font-medium text-text-secondary mb-1"><span>Model override (all steps)</span>
                    <input type="text" [(ngModel)]="form.modelOverride" name="model"
                         placeholder="e.g. claude-opus, gpt-5"
                         class="w-full px-2 py-1.5 rounded border border-border bg-bg text-text-primary
                                focus:outline-none focus:ring-1 focus:ring-accent font-mono text-sm" />
                  </label>
                </div>
                <div>
                  <label class="block text-xs font-medium text-text-secondary mb-1"><span>Budget cap (USD)</span>
                    <input type="text" inputmode="decimal" [(ngModel)]="form.budgetCap" name="budget"
                         placeholder="e.g. 10"
                         class="w-full px-2 py-1.5 rounded border border-border bg-bg text-text-primary
                                focus:outline-none focus:ring-1 focus:ring-accent font-mono text-sm" />
                  </label>
                </div>
              </div>
            </div>
          </details>

          <!-- 3. Session control -->
          <details class="rounded-lg border border-border bg-bg-subtle">
            <summary class="cursor-pointer px-4 py-3 text-sm font-medium text-text-primary">
              3. Session control
            </summary>
            <div class="px-4 pb-4 space-y-3">
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-sm text-text-primary">Fresh session per step (default)</p>
                  <p class="text-xs text-text-secondary">
                    OFF = experimental shared session across steps. Not all providers support this.
                  </p>
                </div>
                <label class="inline-flex items-center cursor-pointer">
                  <input type="checkbox" [checked]="form.sessionMode === 'per_step'"
                         (change)="form.sessionMode = $any($event.target).checked ? 'per_step' : 'shared'"
                         class="w-4 h-4 accent-accent" />
                </label>
              </div>
              @if (form.sessionMode === 'shared') {
                <p class="text-xs text-ctp-yellow">⚠ Shared session is experimental. Providers without session reuse will silently fall back to per_step.</p>
              }
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-sm text-text-primary">Preserve worktree between runs</p>
                  <p class="text-xs text-text-secondary">OFF wipes the worktree on retry.</p>
                </div>
                <label class="inline-flex items-center cursor-pointer">
                  <input type="checkbox" [(ngModel)]="form.preserveWorktree" name="preserve" class="w-4 h-4 accent-accent" />
                </label>
              </div>
            </div>
          </details>

          <!-- 4. QA policy -->
          <details class="rounded-lg border border-border bg-bg-subtle">
            <summary class="cursor-pointer px-4 py-3 text-sm font-medium text-text-primary">
              4. QA policy (overrides playbook per step)
            </summary>
            <div class="px-4 pb-4 space-y-3">
              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label class="block text-xs font-medium text-text-secondary mb-1"><span>Responder</span>
                    <select [(ngModel)]="form.qaResponder" name="qaResponder"
                            class="w-full px-2 py-1.5 rounded border border-border bg-bg text-text-primary text-sm">
                      <option value="playbook_default">playbook default</option>
                      <option value="ai">ai</option>
                      <option value="human">human</option>
                    </select>
                  </label>
                </div>
                <div>
                  <label class="block text-xs font-medium text-text-secondary mb-1"><span>Accept</span>
                    <select [(ngModel)]="form.qaAccept" name="qaAccept"
                            class="w-full px-2 py-1.5 rounded border border-border bg-bg text-text-primary text-sm">
                      <option value="playbook_default">playbook default</option>
                      <option value="confidence">confidence</option>
                      <option value="second_pass">second_pass</option>
                      <option value="always_human">always_human</option>
                      <option value="always_ai">always_ai</option>
                    </select>
                  </label>
                </div>
              </div>
              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label class="block text-xs font-medium text-text-secondary mb-1"><span>Min confidence (0.0–1.0)</span>
                    <input type="text" inputmode="decimal" [(ngModel)]="form.qaMinConfidence" name="qaMin"
                         placeholder="0.85"
                         class="w-full px-2 py-1.5 rounded border border-border bg-bg text-text-primary
                                focus:outline-none focus:ring-1 focus:ring-accent font-mono text-sm" />
                  </label>
                </div>
                <div>
                  <label class="block text-xs font-medium text-text-secondary mb-1"><span>On irreversible</span>
                    <select [(ngModel)]="form.qaOnIrreversible" name="qaOnIrr"
                            class="w-full px-2 py-1.5 rounded border border-border bg-bg text-text-primary text-sm">
                      <option value="playbook_default">playbook default</option>
                      <option value="human">human</option>
                    </select>
                  </label>
                </div>
              </div>
              @for (e of qaSafetyNotices(); track e.path) {
                <p class="text-xs text-ctp-yellow">⚠ {{ e.message }}</p>
              }
            </div>
          </details>

          <!-- 5. Knowledge scope -->
          <details class="rounded-lg border border-border bg-bg-subtle">
            <summary class="cursor-pointer px-4 py-3 text-sm font-medium text-text-primary">
              5. Knowledge scope
            </summary>
            <div class="px-4 pb-4 space-y-3">
              <div>
                <p class="block text-xs font-medium text-text-secondary mb-1">Pin knowledge entries</p>
                <div class="max-h-40 overflow-y-auto rounded border border-border bg-bg p-2 space-y-1">
                  @if (knowledge().length === 0) {
                    <p class="text-xs text-text-secondary">No knowledge entries for this project.</p>
                  }
                  @for (k of knowledge(); track k.id) {
                    <label class="flex items-start gap-2 text-xs cursor-pointer">
                      <input type="checkbox" [checked]="form.pinnedKnowledgeIds.includes(k.id)"
                             (change)="toggleKnowledge(k.id, $any($event.target).checked)"
                             class="mt-0.5 accent-accent" />
                      <span class="text-text-primary">{{ k.title }}
                        <span class="text-text-secondary">— {{ k.category }}</span>
                      </span>
                    </label>
                  }
                </div>
                <p class="text-xs text-text-secondary mt-1">
                  ~{{ pinnedTokenEstimate() }} tokens pinned.
                </p>
              </div>
              <div>
                <label class="block text-xs font-medium text-text-secondary mb-1"><span>Exclude tags (comma-separated)</span>
                  <input type="text" [(ngModel)]="form.excludeTagsCsv" name="excludeTags"
                       class="w-full px-2 py-1.5 rounded border border-border bg-bg text-text-primary text-sm" />
                </label>
              </div>
            </div>
          </details>

          <!-- 6. Verifications -->
          <details class="rounded-lg border border-border bg-bg-subtle">
            <summary class="cursor-pointer px-4 py-3 text-sm font-medium text-text-primary">
              6. Verifications
            </summary>
            <div class="px-4 pb-4 space-y-3">
              <div>
                <p class="block text-xs font-medium text-text-secondary mb-1">Project verifications to run as gates</p>
                <div class="max-h-32 overflow-y-auto rounded border border-border bg-bg p-2 space-y-1">
                  @if (verifications().length === 0) {
                    <p class="text-xs text-text-secondary">No verifications defined for this project.</p>
                  }
                  @for (v of verifications(); track v.id) {
                    <label class="flex items-center gap-2 text-xs cursor-pointer">
                      <input type="checkbox" [checked]="form.verificationIds.includes(v.id)"
                             (change)="toggleVerification(v.id, $any($event.target).checked)"
                             class="accent-accent" />
                      <span class="text-text-primary">{{ v.title }}
                        <span class="text-text-secondary">— {{ v.kind }}</span>
                      </span>
                    </label>
                  }
                </div>
              </div>
              <div class="flex items-center justify-between">
                <p class="text-sm text-text-primary">Fail fast on first verification fail</p>
                <input type="checkbox" [(ngModel)]="form.failFast" name="failFast" class="w-4 h-4 accent-accent" />
              </div>
              <div>
                <label class="block text-xs font-medium text-text-secondary mb-1"><span>Extra test_cmd (runs after playbook)</span>
                  <input type="text" [(ngModel)]="form.extraTestCmd" name="extra"
                       placeholder="e.g. pnpm test --bail"
                       class="w-full px-2 py-1.5 rounded border border-border bg-bg text-text-primary font-mono text-sm" />
                </label>
              </div>
            </div>
          </details>

          <!-- 7. Reports -->
          <details class="rounded-lg border border-border bg-bg-subtle">
            <summary class="cursor-pointer px-4 py-3 text-sm font-medium text-text-primary">
              7. Reports to attach on completion
            </summary>
            <div class="px-4 pb-4 space-y-2">
              @for (r of reportTypes; track r.id) {
                <label class="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox" [checked]="form.reports.includes(r.id)"
                         (change)="toggleReport(r.id, $any($event.target).checked)"
                         class="accent-accent" />
                  <span class="text-text-primary">{{ r.label }}</span>
                </label>
              }
            </div>
          </details>

          <!-- 8. Integrations / agent -->
          <details class="rounded-lg border border-border bg-bg-subtle">
            <summary class="cursor-pointer px-4 py-3 text-sm font-medium text-text-primary">
              8. Integrations / agent
            </summary>
            <div class="px-4 pb-4 space-y-3">
              <div>
                <label class="block text-xs font-medium text-text-secondary mb-1"><span>Agent (defaults to project default)</span>
                  <select [(ngModel)]="form.agentId" name="agent"
                          class="w-full px-2 py-1.5 rounded border border-border bg-bg text-text-primary text-sm">
                    <option value="">(default)</option>
                    @for (a of agents(); track a.id) {
                      <option [value]="a.id">{{ a.name }}</option>
                    }
                  </select>
                </label>
              </div>
              <div class="flex items-center gap-4">
                <label class="flex items-center gap-2 text-sm">
                  <input type="checkbox" [(ngModel)]="form.integrations.forgejo" name="intFg"
                         class="accent-accent" /> Forgejo
                </label>
                <label class="flex items-center gap-2 text-sm">
                  <input type="checkbox" [(ngModel)]="form.integrations.github" name="intGh"
                         class="accent-accent" /> GitHub
                </label>
              </div>
            </div>
          </details>

          <!-- 9. Advanced (collapsed) -->
          <details class="rounded-lg border border-border bg-bg-subtle">
            <summary class="cursor-pointer px-4 py-3 text-sm font-medium text-text-primary">
              9. Advanced (raw context, env, MCP)
            </summary>
            <div class="px-4 pb-4 space-y-3">
              <div>
                <label class="block text-xs font-medium text-text-secondary mb-1"><span>Raw context JSON (merged into task.context)</span>
                  <textarea [(ngModel)]="form.rawContextJson" name="raw" rows="5"
                          placeholder='{"my_field": "value"}'
                          class="w-full px-2 py-1.5 rounded border border-border bg-bg text-text-primary font-mono text-sm"></textarea>
                </label>
                @if (rawJsonError()) {
                  <p class="text-xs text-ctp-red mt-1">{{ rawJsonError() }}</p>
                }
              </div>
              <div>
                <label class="block text-xs font-medium text-text-secondary mb-1"><span>Env vars (KEY=value, one per line)</span>
                  <textarea [(ngModel)]="form.envCsv" name="env" rows="3"
                          class="w-full px-2 py-1.5 rounded border border-border bg-bg text-text-primary font-mono text-sm"></textarea>
                </label>
              </div>
              <div>
                <label class="block text-xs font-medium text-text-secondary mb-1"><span>MCP server overrides (JSON)</span>
                  <textarea [(ngModel)]="form.mcpJson" name="mcp" rows="3"
                          placeholder='{"server": {"url": "..."}}'
                          class="w-full px-2 py-1.5 rounded border border-border bg-bg text-text-primary font-mono text-sm"></textarea>
                </label>
              </div>
            </div>
          </details>

          <!-- Submit -->
          @if (validationErrors().length > 0) {
            <div class="p-3 rounded-lg bg-ctp-red/10 text-ctp-red text-sm space-y-1"
                 role="alert" aria-live="assertive">
              @for (e of validationErrors(); track e.path) {
                <p><span class="font-mono text-xs">{{ e.path }}</span>: {{ e.message }}</p>
              }
            </div>
          }
          @if (submitError()) {
            <div class="p-3 rounded-lg bg-ctp-red/10 text-ctp-red text-sm"
                 role="alert" aria-live="assertive">{{ submitError() }}</div>
          }
          <div class="sticky bottom-0 bg-bg/95 backdrop-blur-sm py-3 -mx-3 px-3 border-t border-border flex items-center justify-between">
            <a routerLink="/quick/new" class="text-sm text-text-secondary hover:text-text-primary underline decoration-dotted">
              Switch to quick form
            </a>
            <button type="submit" [disabled]="!canSubmit() || submitting()"
                    data-testid="advanced-submit"
                    class="px-5 py-2 rounded-lg bg-accent text-white font-medium
                           disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90 transition-opacity">
              {{ submitting() ? 'Submitting…' : 'Submit job' }}
            </button>
          </div>
        </form>

        <!-- ────────── Live preview (right column) ────────── -->
        <aside class="space-y-3 lg:sticky lg:top-4 lg:self-start">
          <div class="rounded-lg border border-border bg-bg-subtle p-4">
            <h2 class="text-sm font-semibold text-text-primary mb-3">Resolved playbook preview</h2>
            @if (!selectedPlaybook()) {
              <p class="text-sm text-text-secondary">Pick a playbook to preview.</p>
            } @else {
              <div class="space-y-2">
                @for (rs of resolvedSteps(); track rs.step.step) {
                  <div class="rounded border border-border bg-bg p-3 text-xs">
                    <div class="flex items-center justify-between mb-1">
                      <span class="font-mono text-text-primary">{{ rs.step.step }}. {{ rs.step.name }}</span>
                      <span class="px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide"
                            [class]="profileClasses(rs.profile)">{{ rs.profile }}</span>
                    </div>
                    <dl class="grid grid-cols-[max-content_1fr] gap-x-2 gap-y-0.5 text-text-secondary">
                      <dt>model</dt><dd [class.text-accent]="rs.modelSource === 'override'">{{ rs.model ?? '—' }}</dd>
                      <dt>budget</dt><dd [class.text-accent]="rs.budgetSource === 'override'">{{ rs.budget ?? '—' }}</dd>
                      <dt>qa.responder</dt><dd [class.text-accent]="rs.qa.responderSource === 'override'">{{ rs.qa.responder }}</dd>
                      <dt>qa.accept</dt>
                      <dd [class.text-accent]="rs.qa.acceptSource === 'override'"
                          [class.text-ctp-yellow]="rs.qa.acceptSource === 'forced'">
                        {{ rs.qa.accept }}
                        @if (rs.qa.acceptSource === 'forced') {
                          <span class="text-[10px]">(forced)</span>
                        }
                      </dd>
                      <dt>qa.min_confidence</dt><dd [class.text-accent]="rs.qa.min_confidenceSource === 'override'">{{ rs.qa.min_confidence }}</dd>
                      <dt>qa.on_irreversible</dt><dd [class.text-accent]="rs.qa.on_irreversibleSource === 'override'">{{ rs.qa.on_irreversible }}</dd>
                    </dl>
                    @if (rs.qa.forcedUpgradeReason) {
                      <p class="mt-2 text-[11px] text-ctp-yellow">⚠ {{ rs.qa.forcedUpgradeReason }}</p>
                    }
                  </div>
                }
              </div>
              <dl class="mt-4 grid grid-cols-[max-content_1fr] gap-x-2 gap-y-0.5 text-xs text-text-secondary">
                <dt>Total steps</dt><dd class="text-text-primary">{{ resolvedSteps().length }}</dd>
                <dt>Verification gates</dt><dd class="text-text-primary">{{ form.verificationIds.length }}{{ form.extraTestCmd ? ' + extra cmd' : '' }}</dd>
                <dt>Reports</dt><dd class="text-text-primary">{{ form.reports.length || '(default)' }}</dd>
              </dl>
            }
          </div>

          <details class="rounded-lg border border-border bg-bg-subtle p-4">
            <summary class="cursor-pointer text-sm font-semibold text-text-primary">task.context preview</summary>
            <pre class="mt-3 text-xs text-text-secondary whitespace-pre-wrap break-all font-mono">{{ contextPreview() }}</pre>
          </details>
        </aside>
      </div>
    </div>
  `,
})
export class AdvancedNewPage implements OnInit {
  private dgApi = inject(DiraigentApiService);
  private tasksApi = inject(TasksApiService);
  private playbooksApi = inject(PlaybooksApiService);
  private knowledgeApi = inject(KnowledgeApiService);
  private verificationsApi = inject(VerificationsApiService);
  private agentsApi = inject(AgentsApiService);
  private projectCtx = inject(ProjectContext);
  private router = inject(Router);

  readonly reportTypes = REPORT_TYPES;

  readonly projects = signal<DgProject[]>([]);
  readonly playbooks = signal<SpPlaybook[]>([]);
  readonly knowledge = signal<SpKnowledge[]>([]);
  readonly verifications = signal<SpVerification[]>([]);
  readonly agents = signal<SpAgent[]>([]);

  readonly loadError = signal<string | null>(null);
  readonly submitError = signal<string | null>(null);
  readonly submitting = signal(false);

  templateName = 'last';

  form: FormState = this.defaultForm();

  /**
   * Re-rendering on plain object mutations doesn't run computeds. We
   * bump this signal in `submit()`/template-load to force the preview
   * to recompute; per-field reactivity in ngModel is fine for the form
   * controls themselves and good enough for preview because Angular's
   * change detection runs after every event.
   */
  private formRev = signal(0);

  readonly selectedPlaybook = computed<SpPlaybook | null>(() => {
    this.formRev();
    const id = this.form.playbookId;
    if (!id) return this.playbooks()[0] ?? null;
    return this.playbooks().find(pb => pb.id === id) ?? null;
  });

  readonly currentContext = computed<AdvancedTaskContext>(() => {
    this.formRev();
    const f = this.form;
    const ctx: AdvancedTaskContext = {
      session_mode: f.sessionMode,
      preserve_worktree: f.preserveWorktree,
    };
    const qa: AdvancedTaskContext['qa_override'] = {
      responder: f.qaResponder,
      accept: f.qaAccept,
      on_irreversible: f.qaOnIrreversible,
    };
    const min = parseFloat(f.qaMinConfidence);
    if (!Number.isNaN(min)) qa.min_confidence = min;
    ctx.qa_override = qa;
    if (f.pinnedKnowledgeIds.length || f.excludeTagsCsv.trim()) {
      ctx.knowledge = {
        pin_ids: f.pinnedKnowledgeIds,
        exclude_tags: f.excludeTagsCsv.split(',').map(s => s.trim()).filter(Boolean),
      };
    }
    if (f.verificationIds.length || f.failFast || f.extraTestCmd.trim()) {
      ctx.verifications = {
        ids: f.verificationIds,
        fail_fast: f.failFast,
        extra_test_cmd: f.extraTestCmd,
      };
    }
    if (f.reports.length) ctx.reports = f.reports;
    if (f.agentId) ctx.agent_id = f.agentId;
    const allowed: string[] = [];
    if (f.integrations.forgejo) allowed.push('forgejo');
    if (f.integrations.github) allowed.push('github');
    if (allowed.length) ctx.integrations_allowed = allowed;
    if (f.modelOverride.trim()) ctx.model_override = f.modelOverride.trim();
    const budget = parseFloat(f.budgetCap);
    if (!Number.isNaN(budget) && budget > 0) ctx.budget_usd_cap = budget;
    return ctx;
  });

  readonly resolvedSteps = computed<ResolvedStepConfig[]>(() => {
    const pb = this.selectedPlaybook();
    if (!pb) return [];
    const ctx = this.currentContext();
    return pb.steps.map(s => resolveStepConfig(s, ctx));
  });

  readonly validationErrors = computed(() => {
    const pb = this.selectedPlaybook();
    const ctx = this.currentContext();
    return validateOverrides(pb?.steps ?? [], ctx);
  });

  readonly qaSafetyNotices = computed(() => {
    // Subset of validationErrors that are specifically QA-policy related.
    return this.validationErrors().filter(e => e.path.startsWith('qa_override.'));
  });

  readonly rawJsonError = computed<string | null>(() => {
    this.formRev();
    const raw = this.form.rawContextJson.trim();
    if (!raw) return null;
    try {
      const v = JSON.parse(raw);
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        return 'Raw context must be a JSON object.';
      }
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  });

  readonly pinnedTokenEstimate = computed<number>(() => {
    this.formRev();
    const pinned = this.knowledge().filter(k => this.form.pinnedKnowledgeIds.includes(k.id));
    // ~4 chars per token, very rough.
    const chars = pinned.reduce((acc, k) => acc + (k.content?.length ?? 0), 0);
    return Math.ceil(chars / 4);
  });

  readonly contextPreview = computed(() => {
    const ctx = this.currentContext();
    let raw: Record<string, unknown> | undefined;
    if (this.form.rawContextJson.trim() && !this.rawJsonError()) {
      try {
        raw = JSON.parse(this.form.rawContextJson) as Record<string, unknown>;
      } catch {
        raw = undefined;
      }
    }
    const merged = buildTaskContext(ctx, raw);
    return JSON.stringify(merged, null, 2);
  });

  canSubmit(): boolean {
    return (
      this.form.spec.trim().length > 0 &&
      this.form.projectId !== '' &&
      this.validationErrors().length === 0 &&
      this.rawJsonError() === null
    );
  }

  async ngOnInit(): Promise<void> {
    try {
      const projects = await firstValueFrom(this.dgApi.getProjects());
      this.projects.set(projects);
      if (projects.length === 0) {
        this.loadError.set('No projects available.');
        return;
      }
      const stored = this.projectCtx.projectId();
      this.form.projectId = projects.find(p => p.id === stored)?.id ?? projects[0].id;
      await this.loadProjectScopedData();
    } catch {
      this.loadError.set('Could not load projects.');
    }
  }

  async onProjectChange(): Promise<void> {
    this.projectCtx.select(this.form.projectId);
    this.form.playbookId = '';
    this.form.pinnedKnowledgeIds = [];
    this.form.verificationIds = [];
    await this.loadProjectScopedData();
    this.bumpForm();
  }

  private async loadProjectScopedData(): Promise<void> {
    const pid = this.form.projectId;
    // Each fetch is best-effort — a missing endpoint on one shouldn't
    // block the others.
    const [pbs, ks, vs, ags] = await Promise.all([
      firstValueFrom(this.playbooksApi.listForProject(pid)).catch(() => [] as SpPlaybook[]),
      firstValueFrom(this.knowledgeApi.list()).catch(() => [] as SpKnowledge[]),
      firstValueFrom(this.verificationsApi.list()).catch(() => ({ data: [] as SpVerification[] } as { data: SpVerification[] })),
      firstValueFrom(this.agentsApi.getAgents()).catch(() => [] as SpAgent[]),
    ]);
    this.playbooks.set(pbs);
    this.knowledge.set(ks);
    this.verifications.set(vs.data);
    this.agents.set(ags);
    const standard = pbs.find(pb => pb.title.toLowerCase().includes('standard'));
    this.form.playbookId = standard?.id ?? pbs[0]?.id ?? '';
  }

  toggleKnowledge(id: string, checked: boolean): void {
    const set = new Set(this.form.pinnedKnowledgeIds);
    if (checked) set.add(id); else set.delete(id);
    this.form.pinnedKnowledgeIds = Array.from(set);
    this.bumpForm();
  }

  toggleVerification(id: string, checked: boolean): void {
    const set = new Set(this.form.verificationIds);
    if (checked) set.add(id); else set.delete(id);
    this.form.verificationIds = Array.from(set);
    this.bumpForm();
  }

  toggleReport(id: string, checked: boolean): void {
    const set = new Set(this.form.reports);
    if (checked) set.add(id); else set.delete(id);
    this.form.reports = Array.from(set);
    this.bumpForm();
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

  saveTemplate(): void {
    const key = TEMPLATE_KEY_PREFIX + (this.templateName.trim() || 'last');
    try {
      localStorage.setItem(key, JSON.stringify(this.form));
    } catch {
      this.submitError.set('Could not save template (localStorage full?).');
    }
  }

  loadTemplate(): void {
    const key = TEMPLATE_KEY_PREFIX + (this.templateName.trim() || 'last');
    try {
      const raw = localStorage.getItem(key);
      if (!raw) {
        this.submitError.set(`No template "${this.templateName}" found.`);
        return;
      }
      const loaded = JSON.parse(raw) as FormState;
      this.form = { ...this.defaultForm(), ...loaded };
      this.bumpForm();
    } catch {
      this.submitError.set('Template was malformed.');
    }
  }

  async submit(): Promise<void> {
    if (!this.canSubmit() || this.submitting()) return;
    this.submitting.set(true);
    this.submitError.set(null);

    if (this.form.projectId !== this.projectCtx.projectId()) {
      this.projectCtx.select(this.form.projectId);
    }

    let raw: Record<string, unknown> = {};
    const spec = this.form.spec.trim();
    raw['spec'] = spec;
    const files = this.form.filesCsv.split(',').map(s => s.trim()).filter(Boolean);
    if (files.length) raw['files'] = files;
    const ac = this.form.acceptanceCriteria.split('\n').map(s => s.trim()).filter(Boolean);
    if (ac.length) raw['acceptance_criteria'] = ac;
    if (this.form.extraTestCmd.trim()) raw['test_cmd'] = this.form.extraTestCmd.trim();
    if (this.form.envCsv.trim()) {
      const env: Record<string, string> = {};
      for (const line of this.form.envCsv.split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1);
      }
      if (Object.keys(env).length) raw['env'] = env;
    }
    if (this.form.mcpJson.trim()) {
      try {
        raw['mcp'] = JSON.parse(this.form.mcpJson);
      } catch {
        this.submitError.set('MCP server JSON is invalid.');
        this.submitting.set(false);
        return;
      }
    }
    if (this.form.rawContextJson.trim()) {
      try {
        const userRaw = JSON.parse(this.form.rawContextJson) as Record<string, unknown>;
        raw = { ...raw, ...userRaw };
      } catch {
        this.submitError.set('Raw context JSON is invalid.');
        this.submitting.set(false);
        return;
      }
    }

    const context = buildTaskContext(this.currentContext(), raw);
    const title = spec.split('\n')[0].slice(0, 80) || 'Untitled';
    const req: CreateTaskRequest = { title, context };
    if (this.form.playbookId) req.playbook_id = this.form.playbookId;

    try {
      const created = await firstValueFrom(this.tasksApi.create(req));
      this.router.navigate(['/advanced', created.id]);
    } catch (err) {
      const e = err as { error?: { message?: string }; message?: string };
      this.submitError.set(e?.error?.message ?? e?.message ?? 'Failed to create job.');
      this.submitting.set(false);
    }
  }

  private bumpForm(): void {
    this.formRev.update(v => v + 1);
  }

  private defaultForm(): FormState {
    return {
      spec: '',
      filesCsv: '',
      acceptanceCriteria: '',
      projectId: '',
      playbookId: '',
      modelOverride: '',
      budgetCap: '',
      sessionMode: 'per_step',
      preserveWorktree: true,
      qaResponder: 'playbook_default',
      qaAccept: 'playbook_default',
      qaMinConfidence: '',
      qaOnIrreversible: 'playbook_default',
      pinnedKnowledgeIds: [],
      excludeTagsCsv: '',
      verificationIds: [],
      failFast: false,
      extraTestCmd: '',
      reports: ['diff_summary', 'cost_breakdown'],
      agentId: '',
      integrations: { forgejo: true, github: true },
      rawContextJson: '',
      envCsv: '',
      mcpJson: '',
    };
  }
}
