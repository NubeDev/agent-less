import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { environment } from '../../../environments/environment';
import { SpTask, PaginatedResponse } from '../../core/services/tasks-api.service';
import { SpQaItem } from '../../core/services/qa-api.service';
import { SpReport } from '../../core/services/reports-api.service';
import { SpAuditEntry } from '../../core/services/audit-api.service';

export interface TaskLogSummary {
  id: string;
  task_id: string;
  project_id: string;
  agent_id: string | null;
  step_name: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface TaskLog extends TaskLogSummary {
  content: string;
}

export interface ChangedFileSummary {
  id: string;
  task_id: string;
  path: string;
  change_type: string; // 'added' | 'modified' | 'deleted' | 'renamed'
  created_at: string;
}

export interface ChangedFile extends ChangedFileSummary {
  diff: string | null;
}

export interface StepFileGroup {
  step_name: string;
  files: ChangedFileSummary[];
}

/** Thin client for endpoints used by the Job Theatre post-mortem view. */
@Injectable({ providedIn: 'root' })
export class JobsApiService {
  private http = inject(HttpClient);
  private baseUrl = environment.apiServer;

  getTask(taskId: string): Observable<SpTask> {
    return this.http.get<SpTask>(`${this.baseUrl}/tasks/${taskId}`);
  }

  listQa(taskId: string): Observable<SpQaItem[]> {
    const params = new HttpParams().set('task_id', taskId);
    return this.http.get<SpQaItem[]>(`${this.baseUrl}/v1/qa`, { params });
  }

  listReports(projectId: string, taskId: string): Observable<SpReport[]> {
    const params = new HttpParams().set('task_id', taskId);
    return this.http
      .get<PaginatedResponse<SpReport>>(`${this.baseUrl}/${projectId}/reports`, { params })
      .pipe(map(res => (Array.isArray(res) ? (res as unknown as SpReport[]) : res.data ?? [])));
  }

  listLogs(projectId: string, taskId: string): Observable<TaskLogSummary[]> {
    const params = new HttpParams().set('task_id', taskId).set('limit', '500');
    return this.http
      .get<PaginatedResponse<TaskLogSummary>>(`${this.baseUrl}/${projectId}/task-logs`, { params })
      .pipe(map(res => (Array.isArray(res) ? (res as unknown as TaskLogSummary[]) : res.data ?? [])));
  }

  getLog(logId: string): Observable<TaskLog> {
    return this.http.get<TaskLog>(`${this.baseUrl}/task-logs/${logId}`);
  }

  entityAudit(entityType: string, entityId: string): Observable<SpAuditEntry[]> {
    return this.http.get<SpAuditEntry[]>(`${this.baseUrl}/audit/${entityType}/${entityId}`);
  }

  filesByStep(taskId: string): Observable<StepFileGroup[]> {
    return this.http.get<StepFileGroup[]>(`${this.baseUrl}/tasks/${taskId}/files-by-step`);
  }

  getChangedFile(taskId: string, fileId: string): Observable<ChangedFile> {
    return this.http.get<ChangedFile>(`${this.baseUrl}/tasks/${taskId}/changed-files/${fileId}`);
  }
}
