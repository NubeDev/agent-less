import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { forkJoin, of } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';
import {
  DagreLayout,
  Edge,
  Node,
  NgxGraphModule,
} from '@swimlane/ngx-graph';
import { SpTask } from '../../core/services/tasks-api.service';
import { SpQaItem } from '../../core/services/qa-api.service';
import { SpReport } from '../../core/services/reports-api.service';
import { SpAuditEntry } from '../../core/services/audit-api.service';
import {
  JobsApiService,
  TaskLogSummary,
} from './jobs-api.service';

type NodeKind = 'task' | 'step' | 'qa' | 'report';

interface JobNode extends Node {
  kind: NodeKind;
  /** Backing entity reference (whichever fits). */
  ref:
    | { kind: 'task'; task: SpTask }
    | { kind: 'step'; step_name: string; logs: TaskLogSummary[] }
    | { kind: 'qa'; qa: SpQaItem }
    | { kind: 'report'; report: SpReport };
}

type DrawerTab = 'overview' | 'prompt' | 'output' | 'logs' | 'audit';

interface SentinelBlock {
  tag: string;
  body: string;
}

const SENTINEL_RE = /<<<([A-Z_]+)>>>([\s\S]*?)<<<END>>>/g;

@Component({
  selector: 'app-job-theatre',
  standalone: true,
  imports: [NgxGraphModule, DatePipe],
  styles: [`
    :host { display: block; }
    .theatre { display: grid; grid-template-columns: minmax(0, 1fr) 420px; height: calc(100vh - 4rem); }
    .graph-pane { background: var(--surface, #181825); border-right: 1px solid var(--border, #313244); position: relative; }
    .drawer { background: var(--surface, #181825); color: var(--text-primary, #cdd6f4); padding: 1rem; overflow: auto; }
    .empty { padding: 2rem; color: var(--text-muted, #6c7086); }
    .node { cursor: pointer; }
    .node-rect { stroke: #45475a; stroke-width: 1; rx: 6; ry: 6; }
    .node-rect.task { fill: #1e1e2e; stroke: #cba6f7; }
    .node-rect.step { fill: #1e1e2e; stroke: #89b4fa; }
    .node-rect.qa { fill: #1e1e2e; stroke: #f9e2af; }
    .node-rect.report { fill: #1e1e2e; stroke: #a6e3a1; }
    .node-rect.selected { stroke-width: 3; }
    .node-label { fill: #cdd6f4; font-size: 12px; font-family: sans-serif; pointer-events: none; }
    .node-sub { fill: #6c7086; font-size: 10px; font-family: sans-serif; pointer-events: none; }
    .tabs { display: flex; gap: 0.25rem; margin-bottom: 0.75rem; border-bottom: 1px solid #313244; }
    .tab { padding: 0.5rem 0.75rem; cursor: pointer; background: transparent; border: 0; color: #6c7086; font-size: 12px; }
    .tab.active { color: #cba6f7; border-bottom: 2px solid #cba6f7; }
    .kvs { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; font-size: 12px; }
    .kvs dt { color: #6c7086; }
    .kvs dd { margin: 0; color: #cdd6f4; word-break: break-all; }
    pre.raw { white-space: pre-wrap; word-break: break-word; font-size: 11px; background: #11111b; padding: 0.75rem; border-radius: 6px; max-height: 60vh; overflow: auto; color: #cdd6f4; }
    .sentinel { margin-top: 0.75rem; border: 1px solid #45475a; border-radius: 6px; padding: 0.5rem; }
    .sentinel-tag { font-family: monospace; color: #f9e2af; font-size: 11px; margin-bottom: 0.25rem; }
    .audit-row { padding: 0.5rem; border-bottom: 1px solid #313244; font-size: 12px; }
    .audit-row .actor { color: #89b4fa; }
    .audit-row .summary { color: #cdd6f4; }
    .audit-row .ts { color: #6c7086; font-size: 11px; }
    h3 { font-size: 14px; font-weight: 600; margin: 0 0 0.5rem 0; color: #cba6f7; }
  `],
  template: `
    @if (!loaded()) {
      <div class="empty" data-testid="job-theatre-loading">Loading job theatre…</div>
    } @else {
    <div class="theatre" data-testid="job-theatre">
      <div class="graph-pane" data-testid="job-theatre-graph">
        @if (nodes().length === 0) {
          <div class="empty">No graph data for this task.</div>
        } @else {
          <ngx-graph
            [nodes]="nodes()"
            [links]="edges()"
            [layout]="layout"
            [layoutSettings]="layoutSettings"
            [zoomSpeed]="0.05">
            <ng-template #nodeTemplate let-node>
              <svg:g class="node" (click)="selectNode(node)"
                     [attr.data-testid]="'job-node-' + node.id"
                     [attr.data-node-kind]="node.kind">
                <svg:rect
                  [class]="'node-rect ' + node.kind + (selectedId() === node.id ? ' selected' : '')"
                  [attr.width]="node.dimension.width"
                  [attr.height]="node.dimension.height" />
                <svg:text class="node-label" [attr.x]="10" [attr.y]="20">{{ node.label }}</svg:text>
                <svg:text class="node-sub" [attr.x]="10" [attr.y]="36">{{ subLabel(node) }}</svg:text>
              </svg:g>
            </ng-template>
            <ng-template #linkTemplate let-link>
              <svg:g class="edge">
                <svg:path [attr.d]="link.line" stroke="#45475a" stroke-width="1.5" fill="none"></svg:path>
              </svg:g>
            </ng-template>
          </ngx-graph>
        }
      </div>

      <aside class="drawer" data-testid="job-theatre-drawer">
        @if (selected(); as sel) {
          <h3 [attr.data-testid]="'drawer-title'">{{ sel.label }}</h3>
          <div class="tabs">
            @for (t of tabs; track t) {
              <button class="tab" [class.active]="activeTab() === t"
                      [attr.data-testid]="'drawer-tab-' + t"
                      (click)="activeTab.set(t)">{{ t }}</button>
            }
          </div>

          @switch (activeTab()) {
            @case ('overview') {
              <dl class="kvs" data-testid="drawer-overview">
                @for (kv of overviewRows(); track kv[0]) {
                  <dt>{{ kv[0] }}</dt>
                  <dd>{{ kv[1] }}</dd>
                }
              </dl>
            }
            @case ('prompt') {
              <pre class="raw" data-testid="drawer-prompt">{{ promptText() || 'No prompt available.' }}</pre>
            }
            @case ('output') {
              <pre class="raw" data-testid="drawer-output">{{ outputText() || 'No output available.' }}</pre>
              @for (s of sentinels(); track $index) {
                <div class="sentinel">
                  <div class="sentinel-tag">{{ s.tag }}</div>
                  <pre class="raw">{{ s.body }}</pre>
                </div>
              }
            }
            @case ('logs') {
              @if (selectedLogs().length === 0) {
                <div class="empty">No logs for this step.</div>
              } @else {
                @for (log of selectedLogs(); track log.id) {
                  <div class="audit-row" data-testid="drawer-log-row">
                    <div class="ts">{{ log.created_at | date:'medium' }}</div>
                    <div class="summary">{{ log.step_name }}</div>
                  </div>
                }
              }
            }
            @case ('audit') {
              @if (selectedAudit().length === 0) {
                <div class="empty">No audit entries.</div>
              } @else {
                @for (row of selectedAudit(); track row.id) {
                  <div class="audit-row" data-testid="drawer-audit-row">
                    <div class="ts">{{ row.created_at | date:'medium' }} — {{ row.action }}</div>
                    <div class="actor">{{ row.actor_name || row.actor_agent_id || row.actor_user_id || 'system' }}</div>
                    <div class="summary">{{ row.summary }}</div>
                  </div>
                }
              }
            }
          }
        } @else {
          <div class="empty">Select a node to inspect.</div>
        }
      </aside>
    </div>
    }
  `,
})
export class JobTheatrePage implements OnInit {
  private route = inject(ActivatedRoute);
  private api = inject(JobsApiService);

  layout = new DagreLayout();
  layoutSettings = { orientation: 'LR' as const, marginX: 24, marginY: 24, edgePadding: 80, rankPadding: 80, nodePadding: 32 };
  tabs: DrawerTab[] = ['overview', 'prompt', 'output', 'logs', 'audit'];

  loaded = signal(false);
  task = signal<SpTask | null>(null);
  logs = signal<TaskLogSummary[]>([]);
  qa = signal<SpQaItem[]>([]);
  reports = signal<SpReport[]>([]);
  audit = signal<SpAuditEntry[]>([]);
  /** Lazily loaded log content keyed by log id. */
  logContent = signal<Map<string, string>>(new Map());

  selectedId = signal<string | null>(null);
  activeTab = signal<DrawerTab>('overview');

  nodes = computed<JobNode[]>(() => {
    const out: JobNode[] = [];
    const t = this.task();
    if (!t) return out;
    out.push({
      id: 'task:' + t.id,
      label: `#${t.number} ${t.title}`,
      kind: 'task',
      ref: { kind: 'task', task: t },
      dimension: { width: 240, height: 56 },
      data: {},
    } as JobNode);

    // One step node per unique step_name (ordered by first occurrence).
    const stepSeen = new Map<string, TaskLogSummary[]>();
    const order: string[] = [];
    for (const log of [...this.logs()].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
      if (!stepSeen.has(log.step_name)) {
        stepSeen.set(log.step_name, []);
        order.push(log.step_name);
      }
      stepSeen.get(log.step_name)!.push(log);
    }
    for (const step of order) {
      out.push({
        id: 'step:' + step,
        label: step,
        kind: 'step',
        ref: { kind: 'step', step_name: step, logs: stepSeen.get(step)! },
        dimension: { width: 180, height: 56 },
        data: {},
      } as JobNode);
    }

    for (const q of this.qa()) {
      out.push({
        id: 'qa:' + q.id,
        label: `QA (${q.status})`,
        kind: 'qa',
        ref: { kind: 'qa', qa: q },
        dimension: { width: 200, height: 56 },
        data: {},
      } as JobNode);
    }
    for (const r of this.reports()) {
      out.push({
        id: 'report:' + r.id,
        label: r.title,
        kind: 'report',
        ref: { kind: 'report', report: r },
        dimension: { width: 200, height: 56 },
        data: {},
      } as JobNode);
    }
    return out;
  });

  edges = computed<Edge[]>(() => {
    const ns = this.nodes();
    if (ns.length === 0) return [];
    const task = ns[0];
    const links: Edge[] = [];
    const steps = ns.filter(n => n.kind === 'step');
    // task -> first step; step -> next step
    if (steps.length > 0) {
      links.push({ id: 'e-task-' + steps[0].id, source: task.id, target: steps[0].id });
      for (let i = 0; i < steps.length - 1; i++) {
        links.push({ id: `e-${steps[i].id}-${steps[i + 1].id}`, source: steps[i].id, target: steps[i + 1].id });
      }
    }
    // attach QA + report nodes to matching step (by step_name) or to task as fallback
    const stepByName = new Map(steps.map(s => [(s.ref as { step_name: string }).step_name, s]));
    for (const n of ns) {
      if (n.kind === 'qa') {
        const parent = stepByName.get((n.ref as { qa: SpQaItem }).qa.step_name) ?? task;
        links.push({ id: `e-${parent.id}-${n.id}`, source: parent.id, target: n.id });
      } else if (n.kind === 'report') {
        const parent = steps[steps.length - 1] ?? task;
        links.push({ id: `e-${parent.id}-${n.id}`, source: parent.id, target: n.id });
      }
    }
    return links;
  });

  selected = computed<JobNode | null>(() => {
    const id = this.selectedId();
    if (!id) return null;
    return this.nodes().find(n => n.id === id) ?? null;
  });

  selectedLogs = computed<TaskLogSummary[]>(() => {
    const sel = this.selected();
    if (!sel) return [];
    if (sel.ref.kind === 'step') return sel.ref.logs;
    if (sel.ref.kind === 'task') return this.logs();
    return [];
  });

  selectedAudit = computed<SpAuditEntry[]>(() => {
    const sel = this.selected();
    if (!sel) return [];
    if (sel.ref.kind === 'task') return this.audit();
    // For other node kinds we don't fetch separate audit history in MVP; show task audit.
    return this.audit();
  });

  overviewRows = computed<[string, string][]>(() => {
    const sel = this.selected();
    if (!sel) return [];
    if (sel.ref.kind === 'task') {
      const t = sel.ref.task;
      const dur = t.completed_at && t.claimed_at
        ? this.fmtDuration(new Date(t.claimed_at).getTime(), new Date(t.completed_at).getTime())
        : '—';
      return [
        ['Status', t.state],
        ['Kind', t.kind],
        ['Agent', t.assigned_agent_id ?? '—'],
        ['Cost (USD)', t.cost_usd.toFixed(4)],
        ['Tokens in/out', `${t.input_tokens} / ${t.output_tokens}`],
        ['Duration', dur],
        ['Created', t.created_at],
        ['Completed', t.completed_at ?? '—'],
      ];
    }
    if (sel.ref.kind === 'step') {
      const logs = sel.ref.logs;
      const first = logs[0];
      const last = logs[logs.length - 1];
      return [
        ['Step', sel.ref.step_name],
        ['Entries', String(logs.length)],
        ['First entry', first?.created_at ?? '—'],
        ['Last entry', last?.created_at ?? '—'],
        ['Agent', first?.agent_id ?? '—'],
        ['Provider', String((first?.metadata as Record<string, unknown> | undefined)?.['provider'] ?? '—')],
      ];
    }
    if (sel.ref.kind === 'qa') {
      const q = sel.ref.qa;
      return [
        ['Step', q.step_name],
        ['Status', q.status],
        ['Responder', q.responder],
        ['Answered by', q.answered_by ?? '—'],
        ['Created', q.created_at],
        ['Answered', q.answered_at ?? '—'],
      ];
    }
    if (sel.ref.kind === 'report') {
      const r = sel.ref.report;
      return [
        ['Kind', r.kind],
        ['Status', r.status],
        ['Created', r.created_at],
      ];
    }
    return [];
  });

  promptText = computed<string>(() => {
    const sel = this.selected();
    if (!sel) return '';
    if (sel.ref.kind === 'task') {
      const ctx = sel.ref.task.context as Record<string, unknown>;
      return String(ctx?.['spec'] ?? '');
    }
    if (sel.ref.kind === 'step') {
      const first = sel.ref.logs[0];
      return first ? (this.logContent().get(first.id) ?? '') : '';
    }
    if (sel.ref.kind === 'qa') return sel.ref.qa.prompt;
    if (sel.ref.kind === 'report') return sel.ref.report.prompt ?? '';
    return '';
  });

  outputText = computed<string>(() => {
    const sel = this.selected();
    if (!sel) return '';
    if (sel.ref.kind === 'step') {
      const last = sel.ref.logs[sel.ref.logs.length - 1];
      return last ? (this.logContent().get(last.id) ?? '') : '';
    }
    if (sel.ref.kind === 'qa') return sel.ref.qa.answer ?? '';
    if (sel.ref.kind === 'report') return sel.ref.report.result ?? '';
    if (sel.ref.kind === 'task') {
      return JSON.stringify(sel.ref.task.context, null, 2);
    }
    return '';
  });

  sentinels = computed<SentinelBlock[]>(() => {
    const text = this.outputText();
    if (!text) return [];
    const out: SentinelBlock[] = [];
    SENTINEL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SENTINEL_RE.exec(text)) !== null) {
      out.push({ tag: m[1], body: m[2].trim() });
    }
    return out;
  });

  ngOnInit(): void {
    const taskId = this.route.snapshot.paramMap.get('taskId');
    if (!taskId) {
      this.loaded.set(true);
      return;
    }
    this.api.getTask(taskId).pipe(
      switchMap(task => {
        this.task.set(task);
        return forkJoin({
          logs: this.api.listLogs(task.project_id, task.id).pipe(catchError(() => of([] as TaskLogSummary[]))),
          qa: this.api.listQa(task.id).pipe(catchError(() => of([] as SpQaItem[]))),
          reports: this.api.listReports(task.project_id, task.id).pipe(catchError(() => of([] as SpReport[]))),
          audit: this.api.entityAudit('task', task.id).pipe(catchError(() => of([] as SpAuditEntry[]))),
        });
      }),
    ).subscribe(({ logs, qa, reports, audit }) => {
      this.logs.set(logs);
      this.qa.set(qa);
      this.reports.set(reports);
      this.audit.set(audit);
      this.loaded.set(true);
      // Auto-select task node
      const t = this.task();
      if (t) this.selectNodeById('task:' + t.id);
    });
  }

  selectNode(node: JobNode): void {
    this.selectNodeById(node.id);
  }

  selectNodeById(id: string): void {
    this.selectedId.set(id);
    this.activeTab.set('overview');
    const sel = this.nodes().find(n => n.id === id);
    if (sel?.ref.kind === 'step') {
      this.ensureLogContent(sel.ref.logs[0]);
      const last = sel.ref.logs[sel.ref.logs.length - 1];
      if (last && last !== sel.ref.logs[0]) this.ensureLogContent(last);
    }
  }

  private ensureLogContent(log: TaskLogSummary | undefined): void {
    if (!log) return;
    if (this.logContent().has(log.id)) return;
    this.api.getLog(log.id).subscribe(full => {
      const next = new Map(this.logContent());
      next.set(full.id, full.content);
      this.logContent.set(next);
    });
  }

  subLabel(node: JobNode): string {
    if (node.kind === 'task') return (node.ref as { task: SpTask }).task.state;
    if (node.kind === 'step') return `${(node.ref as { logs: TaskLogSummary[] }).logs.length} log(s)`;
    if (node.kind === 'qa') return (node.ref as { qa: SpQaItem }).qa.responder;
    if (node.kind === 'report') return (node.ref as { report: SpReport }).report.kind;
    return '';
  }

  private fmtDuration(start: number, end: number): string {
    const ms = end - start;
    if (ms < 0) return '—';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rs = s % 60;
    if (m < 60) return `${m}m ${rs}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }

}
