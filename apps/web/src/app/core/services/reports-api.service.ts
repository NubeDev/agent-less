import { Injectable } from '@angular/core';
import { EMPTY, Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { PaginatedResponse } from './tasks-api.service';
import { BaseCrudApiService } from './base-crud-api.service';

export type ReportStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export type ReportKind = 'security' | 'component' | 'architecture' | 'performance' | 'custom';

export interface SpReport {
  id: string;
  project_id: string;
  title: string;
  kind: string;
  prompt: string | null;
  status: ReportStatus;
  result: string | null;
  task_id: string | null;
  created_by: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SpReportCreate {
  title: string;
  kind: string;
  prompt: string;
}

export interface SpReportUpdate {
  title?: string;
  status?: string;
  result?: string;
}

@Injectable({ providedIn: 'root' })
export class ReportsApiService extends BaseCrudApiService<SpReport, SpReportCreate, SpReportUpdate> {
  protected readonly resource = 'reports';

  list(filters?: {
    status?: ReportStatus;
    kind?: ReportKind;
    task_id?: string;
    task_run_only?: boolean;
  }): Observable<SpReport[]> {
    if (!this.projectId) return EMPTY;
    const params: Record<string, string> = {};
    if (filters?.status) params['status'] = filters.status;
    if (filters?.kind) params['kind'] = filters.kind;
    if (filters?.task_id) params['task_id'] = filters.task_id;
    if (filters?.task_run_only) params['task_run_only'] = 'true';
    return this.http.get<PaginatedResponse<SpReport>>(
      `${this.baseUrl}/${this.projectId}/${this.resource}`, { params }
    ).pipe(map(res => res.data));
  }
}
