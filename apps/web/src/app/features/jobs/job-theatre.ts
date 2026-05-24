import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
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
  ChangedFile,
  ChangedFileSummary,
  JobsApiService,
  StepFileGroup,
  TaskLogSummary,
} from './jobs-api.service';
import { TaskStreamEvent, TaskStreamService } from './task-stream.service';

type NodeKind = 'task' | 'step' | 'qa' | 'report' | 'verify' | 'merge';

interface VerifyInfo {
  /** test_cmd from task.context if present. */
  test_cmd: string | null;
  /** Status derived from task.state: 'done' (task done), 'failed', or 'pending'. */
  status: 'done' | 'failed' | 'pending';
  /** Best-guess timestamp for when verify resolved (task.completed_at). */
  resolved_at: string | null;
}

interface MergeInfo {
  /** agent/task-<short_id>. */
  branch: string;
  /** Task's project default_branch, when known; otherwise 'main'. */
  target: string;
  /** Number of merged files (sum of files across step groups). */
  file_count: number;
  status: 'done' | 'failed' | 'pending';
}

interface JobNode extends Node {
  kind: NodeKind;
  /** Backing entity reference (whichever fits). */
  ref:
    | { kind: 'task'; task: SpTask }
    | { kind: 'step'; step_name: string; logs: TaskLogSummary[] }
    | { kind: 'qa'; qa: SpQaItem }
    | { kind: 'report'; report: SpReport }
    | { kind: 'verify'; info: VerifyInfo }
    | { kind: 'merge'; info: MergeInfo };
}

/**
 * Pure helper: derive synthetic `verify` and `merge` tail nodes from
 * task state + file groups already in memory. Returns null entries
 * when the corresponding stage should not appear in the graph.
 *
 * Verify appears when the task has reached a terminal state
 * (completed_at set, or state == 'failed' / 'cancelled').
 * Merge appears when verify is present AND the task has any
 * changed files OR the task is in 'done' state (the orchestra only
 * marks a task done after a merge attempt succeeds).
 */
export function synthTailNodes(
  task: SpTask,
  filesByStep: StepFileGroup[],
): { verify: VerifyInfo | null; merge: MergeInfo | null } {
  const isTerminal = !!task.completed_at || task.state === 'failed' || task.state === 'cancelled';
  if (!isTerminal) return { verify: null, merge: null };
  const ctx = (task.context ?? {}) as Record<string, unknown>;
  const testCmd = typeof ctx['test_cmd'] === 'string' ? (ctx['test_cmd'] as string) : null;
  const verifyStatus: VerifyInfo['status'] =
    task.state === 'failed' || task.state === 'cancelled' ? 'failed' :
    task.state === 'done' ? 'done' : 'pending';
  const verify: VerifyInfo = {
    test_cmd: testCmd,
    status: verifyStatus,
    resolved_at: task.completed_at ?? null,
  };
  const fileCount = filesByStep.reduce((acc, g) => acc + g.files.length, 0);
  const shouldShowMerge = task.state === 'done' || fileCount > 0;
  if (!shouldShowMerge) return { verify, merge: null };
  const shortId = task.id.split('-')[0] + '-' + (task.id.split('-')[1] ?? '').slice(0, 3);
  const merge: MergeInfo = {
    branch: `agent/task-${shortId}`,
    target: 'main',
    file_count: fileCount,
    status:
      task.state === 'failed' || task.state === 'cancelled' ? 'failed' :
      task.state === 'done' ? 'done' : 'pending',
  };
  return { verify, merge };
}

type DrawerTab = 'overview' | 'prompt' | 'output' | 'logs' | 'audit' | 'files';

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
    .job-theatre-root { display: flex; flex-direction: column; height: calc(100vh - 4rem); }
    .theatre { display: grid; grid-template-columns: minmax(0, 1fr) 420px; flex: 1; min-height: 0; transition: grid-template-columns 0.2s ease; }
    .theatre.diff-open { grid-template-columns: minmax(0, 1fr) 70%; }
    .timeline-strip { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.75rem 1rem; background: var(--surface, #181825); border-top: 1px solid var(--border, #313244); color: #cdd6f4; font-size: 12px; flex: 0 0 auto; }
    .timeline-strip input[type="range"] { flex: 1; accent-color: #cba6f7; }
    .timeline-strip button { background: #313244; border: 1px solid #45475a; color: #cdd6f4; padding: 0.3rem 0.6rem; font-size: 11px; border-radius: 3px; cursor: pointer; }
    .timeline-strip button:hover { background: #45475a; }
    .timeline-strip button.active { background: #cba6f7; color: #11111b; border-color: #cba6f7; }
    .tl-kpis { display: flex; gap: 1.25rem; flex-wrap: wrap; }
    .tl-kpi { display: flex; flex-direction: column; gap: 2px; min-width: 92px; }
    .tl-kpi .k { font-size: 10px; color: #6c7086; text-transform: uppercase; letter-spacing: 0.06em; }
    .tl-kpi .v { font-size: 13px; font-family: monospace; color: #cdd6f4; }
    .tl-kpi .v.done { color: #a6e3a1; }
    .tl-kpi .v.failed { color: #f38ba8; }
    .tl-kpi .v.running { color: #fab387; }
    .tl-kpi .v.parked { color: #f9e2af; }
    .tl-controls { display: flex; align-items: center; gap: 0.5rem; }
    .tl-bar-wrap { position: relative; flex: 1; height: 38px; }
    .tl-phases { position: absolute; inset: 0 0 18px 0; display: flex; border-radius: 3px; overflow: hidden; background: #11111b; border: 1px solid #313244; }
    .tl-phase { display: flex; align-items: center; justify-content: center; font-size: 10px; color: #11111b; text-shadow: 0 0 2px rgba(0,0,0,0.3); white-space: nowrap; overflow: hidden; border-right: 1px solid rgba(17,17,27,0.5); }
    .tl-phase:last-child { border-right: none; }
    .tl-phase.task { background: #cba6f7; }
    .tl-phase.step { background: #89b4fa; }
    .tl-phase.verify { background: #94e2d5; }
    .tl-phase.merge { background: #f5c2e7; }
    .tl-phase.report { background: #a6e3a1; }
    .tl-phase.qa { background: #f9e2af; }
    .tl-ticks { position: absolute; left: 0; right: 0; top: 0; height: 20px; pointer-events: none; }
    .tl-tick { position: absolute; transform: translateX(-50%); width: 8px; height: 8px; border-radius: 50%; top: 6px; }
    .tl-tick.qa { background: #f9e2af; border: 1px solid #11111b; }
    .tl-tick.report { background: #a6e3a1; border: 1px solid #11111b; }
    .tl-tick.failed { background: #f38ba8; border: 1px solid #11111b; }
    .tl-scrub { position: absolute; left: 0; right: 0; bottom: 0; height: 18px; }
    .tl-scrub input[type="range"] { width: 100%; height: 100%; margin: 0; }
    .tl-playhead { position: absolute; top: -2px; bottom: 0; width: 2px; background: #cba6f7; pointer-events: none; box-shadow: 0 0 4px #cba6f7; }
    .tl-footer { display: flex; justify-content: space-between; align-items: center; gap: 1rem; font-size: 11px; color: #a6adc8; }
    .tl-current { font-family: monospace; }
    .tl-current .ev-kind { display: inline-block; padding: 1px 6px; border-radius: 3px; margin-right: 6px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; }
    .tl-current .ev-kind.task { background: #cba6f7; color: #11111b; }
    .tl-current .ev-kind.step { background: #89b4fa; color: #11111b; }
    .tl-current .ev-kind.qa { background: #f9e2af; color: #11111b; }
    .tl-current .ev-kind.report { background: #a6e3a1; color: #11111b; }
    .tl-current .ev-kind.verify { background: #94e2d5; color: #11111b; }
    .tl-current .ev-kind.merge { background: #f5c2e7; color: #11111b; }
    .tl-legend { display: flex; gap: 0.75rem; color: #6c7086; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; }
    .tl-legend .sw { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 4px; vertical-align: middle; }
    .timeline-label { font-family: monospace; color: #a6adc8; min-width: 14ch; text-align: right; }
    .timeline-mode { font-size: 10px; padding: 2px 6px; border-radius: 3px; background: #313244; color: #a6adc8; text-transform: uppercase; letter-spacing: 0.05em; }
    .timeline-mode.live { background: #1f3d2a; color: #a6e3a1; }
    .timeline-mode.scrubbing { background: #3d3a1f; color: #f9e2af; }
    .file-row { display: flex; align-items: center; gap: 0.5rem; padding: 0.35rem 0.5rem; cursor: pointer; border-bottom: 1px solid #313244; font-size: 12px; }
    .file-row:hover { background: #1e1e2e; }
    .file-row.active { background: #313244; }
    .file-status { display: inline-block; width: 18px; height: 18px; line-height: 18px; text-align: center; border-radius: 3px; font-family: monospace; font-weight: bold; font-size: 11px; }
    .file-status.added { background: #1f3d2a; color: #a6e3a1; }
    .file-status.modified { background: #3d3a1f; color: #f9e2af; }
    .file-status.deleted { background: #3d1f1f; color: #f38ba8; }
    .file-status.renamed { background: #1f2a3d; color: #89b4fa; }
    .file-path { flex: 1; color: #cdd6f4; word-break: break-all; }
    .step-section { margin-bottom: 0.75rem; }
    .step-section-header { font-size: 11px; color: #cba6f7; text-transform: uppercase; letter-spacing: 0.05em; padding: 0.5rem 0; }
    .diff-overlay { padding: 0.75rem; background: #11111b; border-radius: 6px; max-height: 70vh; overflow: auto; font-family: monospace; font-size: 11px; line-height: 1.4; }
    .diff-line { white-space: pre; }
    .diff-line.add { background: #1f3d2a; color: #a6e3a1; }
    .diff-line.del { background: #3d1f1f; color: #f38ba8; }
    .diff-line.hunk { color: #89b4fa; }
    .diff-line.ctx { color: #6c7086; }
    .diff-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
    .diff-close { background: transparent; border: 1px solid #45475a; color: #cdd6f4; padding: 0.25rem 0.5rem; cursor: pointer; border-radius: 3px; font-size: 11px; }
    .graph-pane { background: var(--surface, #181825); border-right: 1px solid var(--border, #313244); position: relative; }
    .drawer { background: var(--surface, #181825); color: var(--text-primary, #cdd6f4); padding: 1rem; overflow: auto; }
    .empty { padding: 2rem; color: var(--text-muted, #6c7086); }
    .node { cursor: pointer; }
    .node-rect { stroke: #45475a; stroke-width: 1; rx: 6; ry: 6; }
    .node-rect.task { fill: #1e1e2e; stroke: #cba6f7; }
    .node-rect.step { fill: #1e1e2e; stroke: #89b4fa; }
    .node-rect.qa { fill: #1e1e2e; stroke: #f9e2af; }
    .node-rect.report { fill: #1e1e2e; stroke: #a6e3a1; }
    .node-rect.verify { fill: #1e1e2e; stroke: #94e2d5; }
    .node-rect.merge { fill: #1e1e2e; stroke: #f5c2e7; }
    .node-rect.selected { stroke-width: 3; }
    /* Live status colour overlay — applied via data-status to keep the
       dagre layout stable (no DOM structure change on update). */
    .node-rect[data-status="pending"] { fill: #1e1e2e; }
    .node-rect[data-status="running"] { fill: #313244; stroke: #fab387; animation: node-pulse 1.4s ease-in-out infinite; }
    .node-rect[data-status="done"] { fill: #1e1e2e; stroke: #a6e3a1; }
    .node-rect[data-status="failed"] { fill: #2a1818; stroke: #f38ba8; }
    .node-rect[data-status="qa-parked"] { fill: #2a2618; stroke: #f9e2af; }
    @keyframes node-pulse {
      0%, 100% { stroke-opacity: 1; stroke-width: 1.5; }
      50% { stroke-opacity: 0.6; stroke-width: 3; }
    }
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
    <div class="job-theatre-root">
    <div class="theatre" [class.diff-open]="!!openDiff()" data-testid="job-theatre">
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
                  [attr.data-status]="nodeStatus(node)"
                  [attr.data-testid-status]="nodeStatus(node)"
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
            @case ('files') {
              @if (openDiff(); as diff) {
                <div class="diff-header">
                  <div data-testid="diff-path"><strong>{{ diff.path }}</strong></div>
                  <button class="diff-close" data-testid="diff-close" (click)="closeDiff()">Close diff</button>
                </div>
                @if (diff.diff) {
                  <div class="diff-overlay" data-testid="diff-overlay">
                    @for (l of diffLines(); track $index) {
                      <div class="diff-line" [class.add]="l.kind === 'add'" [class.del]="l.kind === 'del'" [class.hunk]="l.kind === 'hunk'" [class.ctx]="l.kind === 'ctx'">{{ l.text }}</div>
                    }
                  </div>
                } @else {
                  <div class="empty">No diff content stored for this file.</div>
                }
              } @else {
                @if (filesByStep().length === 0) {
                  <div class="empty" data-testid="drawer-files-empty">No changed files for this task.</div>
                } @else {
                  @for (group of filesByStep(); track group.step_name) {
                    @if (isFileGroupVisible(group)) {
                      <div class="step-section" data-testid="files-step-section">
                        <div class="step-section-header">{{ group.step_name }}</div>
                        @for (f of group.files; track f.id) {
                          <div class="file-row" data-testid="files-row"
                               [class.active]="openFileId() === f.id"
                               (click)="openFile(f)">
                            <span class="file-status" [class.added]="f.change_type === 'added'"
                                  [class.modified]="f.change_type === 'modified'"
                                  [class.deleted]="f.change_type === 'deleted'"
                                  [class.renamed]="f.change_type === 'renamed'"
                                  [attr.data-testid]="'file-status-' + f.change_type"
                                  [attr.title]="f.change_type">{{ statusLetter(f.change_type) }}</span>
                            <span class="file-path">{{ f.path }}</span>
                          </div>
                        }
                      </div>
                    }
                  }
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
    <div class="timeline-strip" data-testid="timeline-strip">
      <!-- KPI row: dense rollup of task vitals. -->
      <div class="tl-kpis">
        <div class="tl-kpi">
          <span class="k">Status</span>
          <span class="v" [class.done]="kpiStatusClass()==='done'" [class.failed]="kpiStatusClass()==='failed'"
                [class.running]="kpiStatusClass()==='running'" [class.parked]="kpiStatusClass()==='parked'">
            {{ kpiStatus() }}
          </span>
        </div>
        <div class="tl-kpi"><span class="k">Step</span><span class="v">{{ kpiStep() }}</span></div>
        <div class="tl-kpi"><span class="k">Elapsed</span><span class="v">{{ kpiElapsed() }}</span></div>
        <div class="tl-kpi"><span class="k">Cost (USD)</span><span class="v">{{ kpiCost() }}</span></div>
        <div class="tl-kpi"><span class="k">Tokens in/out</span><span class="v">{{ kpiTokens() }}</span></div>
        <div class="tl-kpi"><span class="k">QA items</span><span class="v">{{ kpiQa() }}</span></div>
        <div class="tl-kpi"><span class="k">Files merged</span><span class="v">{{ kpiFiles() }}</span></div>
        <div class="tl-kpi"><span class="k">Started</span><span class="v">{{ kpiStarted() }}</span></div>
        <div class="tl-kpi"><span class="k">Completed</span><span class="v">{{ kpiCompleted() }}</span></div>
      </div>

      <!-- Controls row: mode + replay + live + scrub label. -->
      <div class="tl-controls">
        <span class="timeline-mode" [class.live]="scrubTime() === null" [class.scrubbing]="scrubTime() !== null"
              [attr.data-testid]="'timeline-mode-' + (scrubTime() === null ? 'live' : 'scrubbing')">
          {{ scrubTime() === null ? 'LIVE' : 'SCRUB' }}
        </span>
        <button data-testid="timeline-replay" [class.active]="replaying()" (click)="toggleReplay()" [disabled]="!timelineRange()">
          {{ replaying() ? 'Pause' : 'Replay 4\u00d7' }}
        </button>
        <button data-testid="timeline-live" (click)="goLive()" [disabled]="scrubTime() === null">Snap to live</button>
        <span class="timeline-label" data-testid="timeline-label">{{ scrubLabel() }}</span>
      </div>

      <!-- Bar: phase segments + event ticks + scrub + playhead. -->
      <div class="tl-bar-wrap">
        <div class="tl-phases" data-testid="tl-phases">
          @for (p of phaseSegments(); track p.id) {
            <div class="tl-phase" [class]="'tl-phase ' + p.kind"
                 [style.flex]="p.weight"
                 [attr.title]="p.label + ' \u2014 ' + p.duration"
                 [attr.data-testid]="'tl-phase-' + p.kind">
              {{ p.label }}
            </div>
          }
        </div>
        <div class="tl-ticks">
          @for (m of eventMarkers(); track m.id) {
            <div class="tl-tick" [class]="'tl-tick ' + m.kind"
                 [style.left.%]="m.pct"
                 [attr.title]="m.label + ' @ ' + m.ts"
                 [attr.data-testid]="'tl-marker-' + m.kind"></div>
          }
        </div>
        <div class="tl-playhead" [style.left.%]="scrubFraction() * 100"></div>
        <div class="tl-scrub">
          <input type="range" min="0" max="1000" step="1"
                 [value]="scrubFraction() * 1000"
                 (input)="onScrub($event)"
                 (mousedown)="onScrubStart()"
                 [disabled]="!timelineRange()"
                 data-testid="timeline-scrub" />
        </div>
      </div>

      <!-- Footer: legend + at-this-moment event. -->
      <div class="tl-footer">
        <div class="tl-current" data-testid="tl-current">
          <span class="ev-kind" [class]="'ev-kind ' + currentEvent().kind">{{ currentEvent().kind }}</span>
          {{ currentEvent().label }}
          <span style="color:#6c7086"> \u2014 {{ currentEvent().ts }}</span>
        </div>
        <div class="tl-legend">
          <span><span class="sw" style="background:#cba6f7"></span>task</span>
          <span><span class="sw" style="background:#89b4fa"></span>step</span>
          <span><span class="sw" style="background:#94e2d5"></span>verify</span>
          <span><span class="sw" style="background:#f5c2e7"></span>merge</span>
          <span><span class="sw" style="background:#f9e2af"></span>qa</span>
          <span><span class="sw" style="background:#a6e3a1"></span>report</span>
        </div>
      </div>
    </div>
    </div>
    }
  `,
})
export class JobTheatrePage implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private api = inject(JobsApiService);
  private stream = inject(TaskStreamService);

  /** Closes the SSE EventSource on destroy. */
  private streamUnsubscribe: (() => void) | null = null;

  /** Scrubber state. `null` = live mode; otherwise epoch-ms. */
  scrubTime = signal<number | null>(null);
  replaying = signal(false);
  private replayHandle: ReturnType<typeof setInterval> | null = null;
  /** Replay speed multiplier. */
  private readonly REPLAY_SPEED = 4;
  private readonly REPLAY_TICK_MS = 100;

  layout = new DagreLayout();
  layoutSettings = { orientation: 'LR' as const, marginX: 24, marginY: 24, edgePadding: 80, rankPadding: 80, nodePadding: 32 };
  tabs: DrawerTab[] = ['overview', 'prompt', 'output', 'logs', 'files', 'audit'];

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

  /** All files grouped by step — fetched once on load. */
  filesByStep = signal<StepFileGroup[]>([]);
  /** Currently-open diff in the overlay (per-file). */
  openDiff = signal<ChangedFile | null>(null);
  openFileId = signal<string | null>(null);

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
    // Synthesised tail: verify + merge derived from task state + files.
    const tail = synthTailNodes(t, this.filesByStep());
    if (tail.verify) {
      out.push({
        id: 'verify:' + t.id,
        label: 'verify',
        kind: 'verify',
        ref: { kind: 'verify', info: tail.verify },
        dimension: { width: 160, height: 56 },
        data: {},
      } as JobNode);
    }
    if (tail.merge) {
      out.push({
        id: 'merge:' + t.id,
        label: `merge → ${tail.merge.target}`,
        kind: 'merge',
        ref: { kind: 'merge', info: tail.merge },
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
    const verify = ns.find(n => n.kind === 'verify') ?? null;
    const merge = ns.find(n => n.kind === 'merge') ?? null;
    // task -> first step; step -> next step
    if (steps.length > 0) {
      links.push({ id: 'e-task-' + steps[0].id, source: task.id, target: steps[0].id });
      for (let i = 0; i < steps.length - 1; i++) {
        links.push({ id: `e-${steps[i].id}-${steps[i + 1].id}`, source: steps[i].id, target: steps[i + 1].id });
      }
    } else if (verify) {
      // No step logs but we still synthed verify (e.g. task done with upload_logs=false).
      links.push({ id: 'e-task-' + verify.id, source: task.id, target: verify.id });
    }
    // last_step -> verify -> merge (when present).
    const lastStep = steps[steps.length - 1] ?? null;
    if (verify && lastStep) {
      links.push({ id: `e-${lastStep.id}-${verify.id}`, source: lastStep.id, target: verify.id });
    }
    if (merge && verify) {
      links.push({ id: `e-${verify.id}-${merge.id}`, source: verify.id, target: merge.id });
    } else if (merge && lastStep) {
      links.push({ id: `e-${lastStep.id}-${merge.id}`, source: lastStep.id, target: merge.id });
    }
    // attach QA + report nodes to matching step (by step_name) or to task as fallback.
    // Reports prefer the merge node when present (post-pipeline artefact), else last step.
    const stepByName = new Map(steps.map(s => [(s.ref as { step_name: string }).step_name, s]));
    const reportParent = merge ?? verify ?? lastStep ?? task;
    for (const n of ns) {
      if (n.kind === 'qa') {
        const parent = stepByName.get((n.ref as { qa: SpQaItem }).qa.step_name) ?? task;
        links.push({ id: `e-${parent.id}-${n.id}`, source: parent.id, target: n.id });
      } else if (n.kind === 'report') {
        links.push({ id: `e-${reportParent.id}-${n.id}`, source: reportParent.id, target: n.id });
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
    if (sel.ref.kind === 'verify') {
      const v = sel.ref.info;
      return [
        ['Phase', 'verify'],
        ['Status', v.status],
        ['Test command', v.test_cmd ?? '— (no test_cmd in task.context)'],
        ['Resolved', v.resolved_at ?? '—'],
      ];
    }
    if (sel.ref.kind === 'merge') {
      const m = sel.ref.info;
      return [
        ['Phase', 'merge'],
        ['Status', m.status],
        ['Branch', m.branch],
        ['Target', m.target],
        ['Files merged', String(m.file_count)],
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
          files: this.api.filesByStep(task.id).pipe(catchError(() => of([] as StepFileGroup[]))),
        });
      }),
    ).subscribe(({ logs, qa, reports, audit, files }) => {
      this.logs.set(logs);
      this.qa.set(qa);
      this.reports.set(reports);
      this.audit.set(audit);
      this.filesByStep.set(files);
      this.loaded.set(true);
      // Auto-select task node
      const t = this.task();
      if (t) this.selectNodeById('task:' + t.id);

      // Subscribe to live updates. Node IDs are stable (task.id, step name,
      // qa.id, report.id) so dagre positions are preserved across updates.
      if (t) this.subscribeLive(t.id);
    });
  }

  ngOnDestroy(): void {
    this.streamUnsubscribe?.();
    this.streamUnsubscribe = null;
    if (this.replayHandle !== null) {
      clearInterval(this.replayHandle);
      this.replayHandle = null;
    }
  }

  /** Resolve a status string for a node, honouring scrub time if set. */
  nodeStatus(node: JobNode): string {
    const t = this.scrubTime();
    if (t !== null) return this.statusAt(node, t);
    return this.liveStatus(node);
  }

  /** Live status (current signal values). */
  private liveStatus(node: JobNode): string {
    if (node.kind === 'task') {
      const state = (node.ref as { task: SpTask }).task.state;
      // Map orchestra task states onto DAG status colours.
      if (state === 'done') return 'done';
      if (state === 'cancelled' || state === 'failed') return 'failed';
      if (state === 'ai_review' || state === 'human_review') return 'qa-parked';
      if (state === 'backlog' || state === 'ready') return 'pending';
      return 'running'; // claimed / implement / review / etc.
    }
    if (node.kind === 'qa') {
      const q = (node.ref as { qa: SpQaItem }).qa;
      if (q.status === 'answered' || q.status === 'resolved') return 'done';
      if (q.status === 'expired') return 'failed';
      return 'qa-parked';
    }
    if (node.kind === 'report') {
      const r = (node.ref as { report: SpReport }).report;
      if (r.status === 'completed') return 'done';
      if (r.status === 'failed') return 'failed';
      return 'pending';
    }
    if (node.kind === 'step') {
      // Step nodes are inferred from logs; treat them as running while the
      // owning task is mid-pipeline, otherwise done.
      const task = this.task();
      const taskRunning = !!task && task.state !== 'done' && task.state !== 'cancelled';
      const steps = this.nodes().filter(n => n.kind === 'step');
      const isLast = steps.length > 0 && steps[steps.length - 1].id === node.id;
      return taskRunning && isLast ? 'running' : 'done';
    }
    if (node.kind === 'verify' || node.kind === 'merge') {
      return (node.ref as { info: { status: 'done' | 'failed' | 'pending' } }).info.status;
    }
    return 'pending';
  }

  // ---- Timeline scrub helpers ----------------------------------------------

  /** [start, end] epoch-ms covering the task lifetime; null when no task. */
  timelineRange = computed<[number, number] | null>(() => {
    const t = this.task();
    if (!t) return null;
    const start = new Date(t.created_at).getTime();
    // End: completion if known, else max observed event ts, else now.
    let end = t.completed_at ? new Date(t.completed_at).getTime() : 0;
    if (!end) {
      for (const a of this.audit()) end = Math.max(end, new Date(a.created_at).getTime());
      for (const l of this.logs()) end = Math.max(end, new Date(l.created_at).getTime());
      for (const q of this.qa()) {
        end = Math.max(end, new Date(q.created_at).getTime());
        if (q.answered_at) end = Math.max(end, new Date(q.answered_at).getTime());
      }
      if (!end) end = Date.now();
    }
    if (end <= start) end = start + 1;
    return [start, end];
  });

  /** Current scrub position as a 0..1 fraction (1 in live mode). */
  scrubFraction = computed<number>(() => {
    const r = this.timelineRange();
    const t = this.scrubTime();
    if (!r) return 1;
    if (t === null) return 1;
    const [start, end] = r;
    return Math.max(0, Math.min(1, (t - start) / (end - start)));
  });

  scrubLabel = computed<string>(() => {
    const t = this.scrubTime();
    const r = this.timelineRange();
    if (t === null || !r) return 'live';
    const d = new Date(t);
    return d.toLocaleTimeString();
  });

  // ---- Timeline dashboard signals -----------------------------------------

  /** Display status string for KPI ('done' | 'failed' | 'running' | 'parked' | 'pending' | <state>). */
  kpiStatus = computed<string>(() => {
    const t = this.task();
    if (!t) return '—';
    return t.state;
  });

  kpiStatusClass = computed<string>(() => {
    const s = this.kpiStatus();
    if (s === 'done') return 'done';
    if (s === 'failed' || s === 'cancelled') return 'failed';
    if (s === 'ai_review' || s === 'human_review') return 'parked';
    if (s === 'backlog' || s === 'ready' || s === '—') return 'pending';
    return 'running';
  });

  kpiStep = computed<string>(() => {
    const t = this.task();
    if (!t) return '—';
    const steps = this.nodes().filter(n => n.kind === 'step');
    const n = steps.length;
    const playbook = (t as unknown as { playbook_name?: string | null }).playbook_name ?? null;
    if (n === 0) return playbook ? `${playbook} (queued)` : '—';
    const cur = t.playbook_step ?? n;
    return `${cur}/${Math.max(cur, n)} \u00b7 ${steps[steps.length - 1].label}`;
  });

  kpiElapsed = computed<string>(() => {
    const t = this.task();
    if (!t) return '—';
    const start = new Date(t.claimed_at ?? t.created_at).getTime();
    const end = t.completed_at ? new Date(t.completed_at).getTime() : Date.now();
    return this.fmtDuration(start, end);
  });

  kpiCost = computed<string>(() => {
    const t = this.task();
    if (!t) return '—';
    return `$${t.cost_usd.toFixed(4)}`;
  });

  kpiTokens = computed<string>(() => {
    const t = this.task();
    if (!t) return '—';
    const fmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
    return `${fmt(t.input_tokens)} / ${fmt(t.output_tokens)}`;
  });

  kpiQa = computed<string>(() => {
    const qs = this.qa();
    if (qs.length === 0) return '0';
    const pending = qs.filter(q => q.status !== 'resolved' && q.status !== 'answered' && q.status !== 'expired').length;
    return pending > 0 ? `${qs.length} (${pending} open)` : String(qs.length);
  });

  kpiFiles = computed<string>(() => {
    const groups = this.filesByStep();
    const n = groups.reduce((acc, g) => acc + g.files.length, 0);
    return String(n);
  });

  kpiStarted = computed<string>(() => {
    const t = this.task();
    if (!t) return '—';
    return new Date(t.claimed_at ?? t.created_at).toLocaleTimeString();
  });

  kpiCompleted = computed<string>(() => {
    const t = this.task();
    if (!t || !t.completed_at) return '—';
    return new Date(t.completed_at).toLocaleTimeString();
  });

  /**
   * Phase segments — proportional-width chunks for the bar. Built from
   * the step nodes' log timestamps, then the synth verify / merge tail
   * (each given a nominal slice of the post-last-log window).
   */
  phaseSegments = computed<{ id: string; kind: string; label: string; weight: number; duration: string }[]>(() => {
    const r = this.timelineRange();
    if (!r) return [];
    const [s, e] = r;
    const span = e - s;
    if (span <= 0) return [];
    const ns = this.nodes();
    const steps = ns.filter(n => n.kind === 'step');
    const verify = ns.find(n => n.kind === 'verify');
    const merge = ns.find(n => n.kind === 'merge');
    type Seg = { id: string; kind: string; label: string; weight: number; duration: string };
    const out: Seg[] = [];
    // task header slice: from created_at -> first step (or end)
    const firstStepTs = steps.length > 0
      ? new Date((steps[0].ref as { logs: TaskLogSummary[] }).logs[0].created_at).getTime()
      : e;
    const taskWeight = Math.max(0.02, (firstStepTs - s) / span);
    out.push({ id: 'task', kind: 'task', label: 'queued', weight: taskWeight, duration: this.fmtDuration(s, firstStepTs) });
    // step slices: each step extends to the next step's first log (or to end)
    for (let i = 0; i < steps.length; i++) {
      const cur = (steps[i].ref as { step_name: string; logs: TaskLogSummary[] });
      const curTs = new Date(cur.logs[0].created_at).getTime();
      const nextTs = i + 1 < steps.length
        ? new Date((steps[i + 1].ref as { logs: TaskLogSummary[] }).logs[0].created_at).getTime()
        : (verify || merge ? Math.max(curTs + 1000, e - (verify ? span * 0.08 : 0) - (merge ? span * 0.05 : 0)) : e);
      const weight = Math.max(0.02, (nextTs - curTs) / span);
      out.push({ id: 'step-' + cur.step_name, kind: 'step', label: cur.step_name, weight, duration: this.fmtDuration(curTs, nextTs) });
    }
    if (verify) {
      out.push({ id: 'verify', kind: 'verify', label: 'verify', weight: Math.max(0.04, 0.06), duration: '—' });
    }
    if (merge) {
      out.push({ id: 'merge', kind: 'merge', label: 'merge', weight: Math.max(0.04, 0.05), duration: '—' });
    }
    return out;
  });

  /** Event marker ticks: QA emission + report creation + failures. */
  eventMarkers = computed<{ id: string; kind: string; label: string; ts: string; pct: number }[]>(() => {
    const r = this.timelineRange();
    if (!r) return [];
    const [s, e] = r;
    const span = e - s;
    const pct = (ts: number) => Math.max(0, Math.min(100, ((ts - s) / span) * 100));
    const out: { id: string; kind: string; label: string; ts: string; pct: number }[] = [];
    for (const q of this.qa()) {
      out.push({
        id: 'qa-' + q.id, kind: 'qa', label: `QA fired (${q.status})`,
        ts: q.created_at, pct: pct(new Date(q.created_at).getTime()),
      });
    }
    for (const rep of this.reports()) {
      out.push({
        id: 'rep-' + rep.id, kind: 'report', label: rep.title,
        ts: rep.created_at, pct: pct(new Date(rep.created_at).getTime()),
      });
    }
    const t = this.task();
    if (t && (t.state === 'failed' || t.state === 'cancelled') && t.completed_at) {
      out.push({
        id: 'fail', kind: 'failed', label: `task ${t.state}`,
        ts: t.completed_at, pct: pct(new Date(t.completed_at).getTime()),
      });
    }
    return out;
  });

  /** "At this moment" event description — what's closest to scrubTime (or live = latest). */
  currentEvent = computed<{ kind: string; label: string; ts: string }>(() => {
    const r = this.timelineRange();
    if (!r) return { kind: 'task', label: 'no task loaded', ts: '—' };
    const t = this.scrubTime() ?? r[1];
    // Build event list: step starts + qa + reports + verify/merge resolution.
    type Ev = { kind: string; label: string; tsMs: number; tsIso: string };
    const evs: Ev[] = [];
    const task = this.task();
    if (task) {
      evs.push({
        kind: 'task', label: `task created \u2014 ${task.title}`,
        tsMs: new Date(task.created_at).getTime(), tsIso: task.created_at,
      });
      if (task.claimed_at) {
        evs.push({
          kind: 'task', label: 'task claimed',
          tsMs: new Date(task.claimed_at).getTime(), tsIso: task.claimed_at,
        });
      }
    }
    for (const log of this.logs()) {
      evs.push({
        kind: 'step', label: `step ${log.step_name} started`,
        tsMs: new Date(log.created_at).getTime(), tsIso: log.created_at,
      });
    }
    for (const q of this.qa()) {
      evs.push({
        kind: 'qa', label: `QA emitted (step ${q.step_name})`,
        tsMs: new Date(q.created_at).getTime(), tsIso: q.created_at,
      });
      if (q.answered_at) {
        evs.push({
          kind: 'qa', label: `QA ${q.status} (step ${q.step_name})`,
          tsMs: new Date(q.answered_at).getTime(), tsIso: q.answered_at,
        });
      }
    }
    for (const rep of this.reports()) {
      evs.push({
        kind: 'report', label: `report \u201c${rep.title}\u201d`,
        tsMs: new Date(rep.created_at).getTime(), tsIso: rep.created_at,
      });
    }
    if (task?.completed_at) {
      evs.push({
        kind: task.state === 'failed' || task.state === 'cancelled' ? 'merge' : 'merge',
        label: task.state === 'failed' ? 'task failed'
             : task.state === 'cancelled' ? 'task cancelled'
             : 'task completed (merged)',
        tsMs: new Date(task.completed_at).getTime(), tsIso: task.completed_at,
      });
    }
    if (evs.length === 0) return { kind: 'task', label: 'no events yet', ts: '—' };
    evs.sort((a, b) => a.tsMs - b.tsMs);
    // Find last event with tsMs <= t
    let pick: Ev = evs[0];
    for (const ev of evs) {
      if (ev.tsMs <= t) pick = ev;
      else break;
    }
    return { kind: pick.kind, label: pick.label, ts: new Date(pick.tsIso).toLocaleTimeString() };
  });

  onScrubStart(): void {
    // Pause auto-replay on user grab.
    if (this.replaying()) this.pauseReplay();
  }

  onScrub(ev: Event): void {
    const target = ev.target as HTMLInputElement;
    const frac = Number(target.value) / 1000;
    const r = this.timelineRange();
    if (!r) return;
    const [start, end] = r;
    const t = start + frac * (end - start);
    // Snap to live if user drags to the far right.
    if (frac >= 0.999) {
      this.scrubTime.set(null);
    } else {
      this.scrubTime.set(t);
    }
  }

  goLive(): void {
    this.pauseReplay();
    this.scrubTime.set(null);
  }

  toggleReplay(): void {
    if (this.replaying()) this.pauseReplay();
    else this.startReplay();
  }

  private startReplay(): void {
    const r = this.timelineRange();
    if (!r) return;
    const [start, end] = r;
    // If currently live or at end, restart from beginning.
    const cur = this.scrubTime();
    if (cur === null || cur >= end - 1) {
      this.scrubTime.set(start);
    }
    this.replaying.set(true);
    const tickMs = this.REPLAY_TICK_MS;
    const stepMs = tickMs * this.REPLAY_SPEED;
    this.replayHandle = setInterval(() => {
      const range = this.timelineRange();
      if (!range) { this.pauseReplay(); return; }
      const [s, e] = range;
      const t = this.scrubTime() ?? s;
      const next = t + stepMs;
      if (next >= e) {
        // Snap to live and stop.
        this.scrubTime.set(null);
        this.pauseReplay();
      } else {
        this.scrubTime.set(next);
      }
    }, tickMs);
  }

  private pauseReplay(): void {
    if (this.replayHandle !== null) {
      clearInterval(this.replayHandle);
      this.replayHandle = null;
    }
    this.replaying.set(false);
  }

  /** Status for a node at a specific epoch-ms `t`. */
  private statusAt(node: JobNode, t: number): string {
    if (node.kind === 'task') {
      const task = (node.ref as { task: SpTask }).task;
      const createdAt = new Date(task.created_at).getTime();
      if (t < createdAt) return 'pending';
      // Walk audit entries in order; find the most recent task-state change <= t.
      let state: string | null = null;
      const rows = [...this.audit()]
        .filter(a => a.entity_type === 'task' && a.entity_id === task.id)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      for (const row of rows) {
        if (new Date(row.created_at).getTime() > t) break;
        const after = row.after_state as Record<string, unknown> | null;
        const s = after?.['state'];
        if (typeof s === 'string') state = s;
      }
      if (state === null) state = 'backlog';
      if (state === 'done') return 'done';
      if (state === 'cancelled' || state === 'failed') return 'failed';
      if (state === 'ai_review' || state === 'human_review') return 'qa-parked';
      if (state === 'backlog' || state === 'ready') return 'pending';
      return 'running';
    }
    if (node.kind === 'step') {
      const ref = node.ref as { step_name: string; logs: TaskLogSummary[] };
      const firstTs = ref.logs.length > 0
        ? new Date(ref.logs[0].created_at).getTime()
        : Number.POSITIVE_INFINITY;
      if (firstTs > t) return 'pending';
      // "Done" if a later step (in the layout order) already has a log <= t.
      const steps = this.nodes().filter(n => n.kind === 'step');
      const myIdx = steps.findIndex(s => s.id === node.id);
      for (let i = myIdx + 1; i < steps.length; i++) {
        const laterRef = steps[i].ref as { logs: TaskLogSummary[] };
        const ts = laterRef.logs.length > 0 ? new Date(laterRef.logs[0].created_at).getTime() : Number.POSITIVE_INFINITY;
        if (ts <= t) return 'done';
      }
      // No later step started — was this step the final one and is task done?
      const task = this.task();
      if (task && task.completed_at) {
        const completed = new Date(task.completed_at).getTime();
        const isLast = myIdx === steps.length - 1;
        if (isLast && t >= completed) return 'done';
      }
      return 'running';
    }
    if (node.kind === 'qa') {
      const q = (node.ref as { qa: SpQaItem }).qa;
      const created = new Date(q.created_at).getTime();
      if (t < created) return 'pending';
      const answered = q.answered_at ? new Date(q.answered_at).getTime() : null;
      if (answered !== null && t >= answered) {
        if (q.status === 'expired') return 'failed';
        return 'done';
      }
      return 'qa-parked';
    }
    if (node.kind === 'report') {
      const r = (node.ref as { report: SpReport }).report;
      const created = new Date(r.created_at).getTime();
      if (t < created) return 'pending';
      const updated = new Date(r.updated_at).getTime();
      if (t >= updated && r.status === 'completed') return 'done';
      if (t >= updated && r.status === 'failed') return 'failed';
      return 'pending';
    }
    if (node.kind === 'verify' || node.kind === 'merge') {
      // Synthetic tail nodes resolve when the task does. Pre-resolution: pending.
      const task = this.task();
      if (!task) return 'pending';
      const completed = task.completed_at ? new Date(task.completed_at).getTime() : null;
      if (completed === null || t < completed) return 'pending';
      return (node.ref as { info: { status: 'done' | 'failed' | 'pending' } }).info.status;
    }
    return 'pending';
  }

  private subscribeLive(taskId: string): void {
    const { events$, unsubscribe } = this.stream.connect(taskId);
    this.streamUnsubscribe = unsubscribe;
    events$.subscribe(ev => this.applyStreamEvent(taskId, ev));
  }

  private applyStreamEvent(taskId: string, ev: TaskStreamEvent): void {
    switch (ev.kind) {
      case 'task_updated': {
        const cur = this.task();
        if (cur && cur.id === ev.task_id) {
          // Patch in place — keep the same task identity and node ID so
          // ngx-graph reuses the existing dagre position (no reflow).
          this.task.set({
            ...cur,
            state: ev.state,
            playbook_step: ev.playbook_step ?? cur.playbook_step,
            updated_at: ev.updated_at,
            cost_usd: ev.cost_usd,
            input_tokens: ev.input_tokens,
            output_tokens: ev.output_tokens,
          } as SpTask);
        }
        return;
      }
      case 'qa_updated': {
        // Patch or append.
        const list = this.qa();
        const idx = list.findIndex(q => q.id === ev.qa_id);
        if (idx >= 0) {
          const next = list.slice();
          next[idx] = { ...next[idx], status: ev.status };
          this.qa.set(next);
        } else {
          // New QA — refetch the list to get the full row.
          this.api.listQa(taskId).subscribe(rows => this.qa.set(rows));
        }
        return;
      }
      case 'report_updated': {
        const list = this.reports();
        const idx = list.findIndex(r => r.id === ev.report_id);
        if (idx >= 0) {
          const next = list.slice();
          next[idx] = { ...next[idx], status: ev.status as SpReport['status'] };
          this.reports.set(next);
        } else {
          const t = this.task();
          if (t) this.api.listReports(t.project_id, taskId).subscribe(rs => this.reports.set(rs));
        }
        return;
      }
      case 'log_added': {
        const list = this.logs();
        if (list.some(l => l.id === ev.log_id)) return;
        const t = this.task();
        if (t) this.api.listLogs(t.project_id, taskId).subscribe(ls => this.logs.set(ls));
        return;
      }
    }
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

  /** Visible if a node is selected: task -> all groups; step -> matching group only. */
  isFileGroupVisible(group: StepFileGroup): boolean {
    const sel = this.selected();
    if (!sel) return true;
    if (sel.ref.kind === 'task') return true;
    if (sel.ref.kind === 'step') return group.step_name === sel.ref.step_name;
    return true;
  }

  statusLetter(t: string): string {
    switch (t) {
      case 'added': return 'A';
      case 'modified': return 'M';
      case 'deleted': return 'D';
      case 'renamed': return 'R';
      default: return '?';
    }
  }

  openFile(f: ChangedFileSummary): void {
    this.openFileId.set(f.id);
    this.api.getChangedFile(f.task_id, f.id).subscribe(full => {
      // Only apply if it's still the same file the user wants open.
      if (this.openFileId() === full.id) this.openDiff.set(full);
    });
  }

  closeDiff(): void {
    this.openDiff.set(null);
    this.openFileId.set(null);
  }

  /** Classify diff lines for colouring. */
  diffLines = computed<{ kind: 'add' | 'del' | 'hunk' | 'ctx' | 'meta'; text: string }[]>(() => {
    const d = this.openDiff();
    if (!d || !d.diff) return [];
    const lines = d.diff.split('\n');
    // Hard cap render to keep < 500ms even on pathological inputs.
    const cap = 8000;
    const sliced = lines.length > cap ? lines.slice(0, cap) : lines;
    return sliced.map(text => {
      if (text.startsWith('@@')) return { kind: 'hunk' as const, text };
      if (text.startsWith('+++') || text.startsWith('---') || text.startsWith('diff ') || text.startsWith('index ')) return { kind: 'meta' as const, text };
      if (text.startsWith('+')) return { kind: 'add' as const, text };
      if (text.startsWith('-')) return { kind: 'del' as const, text };
      return { kind: 'ctx' as const, text };
    });
  });

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
