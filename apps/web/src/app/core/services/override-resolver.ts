import type { SpPlaybookStep } from './playbooks-api.service';

/**
 * Shared "playbook step + per-task overrides → effective config" resolver.
 *
 * UI-4 (advanced create) and UI-5 (advanced detail) both need to compute
 * "what does this step actually look like after overrides?". Built once
 * here so the two pages agree on:
 *
 * - which fields came from the playbook vs. from `task.context`,
 * - which override combinations are blocked client-side because the
 *   SoW-2 backend will reject them anyway (e.g. `accept: confidence`
 *   on a Merge-profile step gets force-upgraded to `second_pass`),
 * - what the resolved QA policy looks like before submit.
 *
 * Pure. No HTTP, no DI side-effects. The `@Injectable` wrapper exists
 * so consumers can `inject(OverrideResolverService)`, but every method
 * is also exported as a free function for direct call / unit tests.
 */

export type StepProfile = 'implement' | 'review' | 'merge' | 'dream' | 'other';

export type QaResponder = 'ai' | 'human' | 'playbook_default';
export type QaAccept =
  | 'confidence'
  | 'second_pass'
  | 'always_human'
  | 'always_ai'
  | 'playbook_default';
export type QaOnIrreversible = 'human' | 'playbook_default';

/**
 * Per-task QA overrides. All optional — missing fields fall back to
 * whatever the playbook step's `qa:` block specified.
 */
export interface QaOverride {
  responder?: QaResponder;
  accept?: QaAccept;
  min_confidence?: number | null;
  on_irreversible?: QaOnIrreversible;
}

/**
 * The subset of `task.context` UI-4 produces. Anything else the user
 * stuffs into context is opaque to the resolver — passed through
 * verbatim to the server.
 */
export interface AdvancedTaskContext {
  session_mode?: 'per_step' | 'shared';
  preserve_worktree?: boolean;
  qa_override?: QaOverride;
  knowledge?: {
    pin_ids?: string[];
    exclude_tags?: string[];
  };
  verifications?: {
    ids?: string[];
    fail_fast?: boolean;
    extra_test_cmd?: string;
  };
  reports?: string[];
  agent_id?: string;
  integrations_allowed?: string[];
  model_override?: string;
  budget_usd_cap?: number;
  [k: string]: unknown;
}

/** Source attribution for one field in the resolved config. */
export type FieldSource = 'playbook' | 'override' | 'forced';

/** Resolved view of a step's QA policy with provenance per field. */
export interface ResolvedQaConfig {
  responder: 'ai' | 'human';
  responderSource: FieldSource;
  accept: 'confidence' | 'second_pass' | 'always_human' | 'always_ai';
  acceptSource: FieldSource;
  min_confidence: number;
  min_confidenceSource: FieldSource;
  on_irreversible: 'human' | 'ai';
  on_irreversibleSource: FieldSource;
  /**
   * Set when the backend's SoW-2 safety policy would force a stricter
   * accept-check at runtime (e.g. Merge-profile step + `accept:
   * confidence` → upgraded to `second_pass`). UI shows this as an
   * orange notice.
   */
  forcedUpgradeReason?: string;
}

export interface ResolvedStepConfig {
  step: SpPlaybookStep;
  profile: StepProfile;
  model: string | undefined;
  modelSource: FieldSource;
  budget: number | undefined;
  budgetSource: FieldSource;
  qa: ResolvedQaConfig;
  /** Field paths that came from overrides (for highlighting in the YAML preview). */
  overriddenFields: string[];
}

/** Validation errors that block submit. */
export interface ValidationError {
  path: string;
  message: string;
}

const DEFAULT_MIN_CONFIDENCE = 0.85;

/**
 * Classify a step into one of the four SoW-1 profiles. We look at the
 * step name first (the convention `Implement|Review|Merge|Dream` is
 * baked into the seed playbooks) and fall back to `git_action: merge`
 * as a Merge signal. Anything else is `other`.
 */
export function classifyStepProfile(step: SpPlaybookStep): StepProfile {
  const name = (step.name ?? '').toLowerCase();
  if (name.includes('merge') || step.git_action === 'merge') return 'merge';
  if (name.includes('review')) return 'review';
  if (name.includes('implement')) return 'implement';
  if (name.includes('dream')) return 'dream';
  return 'other';
}

/**
 * Read a step's `qa:` config out of its `settings` blob, if any. The
 * server stores it under `settings.qa`; missing/invalid → undefined.
 */
function readPlaybookQa(step: SpPlaybookStep): {
  responder?: 'ai' | 'human';
  accept?: 'confidence' | 'second_pass' | 'always_human' | 'always_ai';
  min_confidence?: number;
  on_irreversible?: 'human' | 'ai';
} {
  const s = step.settings as Record<string, unknown> | undefined;
  const raw = s?.['qa'] as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') return {};
  const out: ReturnType<typeof readPlaybookQa> = {};
  if (raw['responder'] === 'ai' || raw['responder'] === 'human') {
    out.responder = raw['responder'];
  }
  const a = raw['accept'];
  if (a === 'confidence' || a === 'second_pass' || a === 'always_human' || a === 'always_ai') {
    out.accept = a;
  }
  if (typeof raw['min_confidence'] === 'number') {
    out.min_confidence = raw['min_confidence'] as number;
  }
  if (raw['on_irreversible'] === 'human' || raw['on_irreversible'] === 'ai') {
    out.on_irreversible = raw['on_irreversible'];
  }
  return out;
}

/**
 * Resolve a single playbook step against per-task context. Mirrors the
 * SoW-2 backend's `resolve_qa_config` policy:
 *
 * 1. Missing `qa:` block + no override → `responder: human` (safe default).
 * 2. Per-task override fields win over the playbook step's `qa:` block.
 * 3. `StepProfile::Merge` OR `on_irreversible: human` forces
 *    `accept: second_pass` at runtime — the resolver mirrors that
 *    upgrade so the UI shows the user what will actually run.
 */
export function resolveStepConfig(
  step: SpPlaybookStep,
  ctx: AdvancedTaskContext | undefined | null,
): ResolvedStepConfig {
  const profile = classifyStepProfile(step);
  const overridden: string[] = [];
  const c = ctx ?? {};

  // ── Model & budget overrides apply across all steps. ──
  const modelOverride = typeof c.model_override === 'string' && c.model_override.trim() !== ''
    ? c.model_override.trim()
    : undefined;
  const budgetOverride = typeof c.budget_usd_cap === 'number' && c.budget_usd_cap > 0
    ? c.budget_usd_cap
    : undefined;
  if (modelOverride !== undefined) overridden.push(`steps[${step.step}].model`);
  if (budgetOverride !== undefined) overridden.push(`steps[${step.step}].budget`);

  // ── QA. ──
  const pbQa = readPlaybookQa(step);
  const qaOver = c.qa_override ?? {};

  // Responder: override > playbook > default (human).
  let responder: 'ai' | 'human';
  let responderSource: FieldSource;
  if (qaOver.responder && qaOver.responder !== 'playbook_default') {
    responder = qaOver.responder;
    responderSource = 'override';
    overridden.push(`steps[${step.step}].qa.responder`);
  } else if (pbQa.responder) {
    responder = pbQa.responder;
    responderSource = 'playbook';
  } else {
    responder = 'human';
    responderSource = 'playbook';
  }

  // Accept: override > playbook > confidence (default).
  let accept: 'confidence' | 'second_pass' | 'always_human' | 'always_ai';
  let acceptSource: FieldSource;
  if (qaOver.accept && qaOver.accept !== 'playbook_default') {
    accept = qaOver.accept;
    acceptSource = 'override';
    overridden.push(`steps[${step.step}].qa.accept`);
  } else if (pbQa.accept) {
    accept = pbQa.accept;
    acceptSource = 'playbook';
  } else {
    accept = 'confidence';
    acceptSource = 'playbook';
  }

  // on_irreversible: override > playbook > 'human' (safe default).
  let onIrreversible: 'human' | 'ai';
  let onIrreversibleSource: FieldSource;
  if (qaOver.on_irreversible && qaOver.on_irreversible !== 'playbook_default') {
    onIrreversible = qaOver.on_irreversible;
    onIrreversibleSource = 'override';
    overridden.push(`steps[${step.step}].qa.on_irreversible`);
  } else if (pbQa.on_irreversible) {
    onIrreversible = pbQa.on_irreversible;
    onIrreversibleSource = 'playbook';
  } else {
    onIrreversible = 'human';
    onIrreversibleSource = 'playbook';
  }

  // min_confidence: override (when numeric) > playbook > DEFAULT.
  let minConf: number;
  let minConfSource: FieldSource;
  if (typeof qaOver.min_confidence === 'number') {
    minConf = qaOver.min_confidence;
    minConfSource = 'override';
    overridden.push(`steps[${step.step}].qa.min_confidence`);
  } else if (typeof pbQa.min_confidence === 'number') {
    minConf = pbQa.min_confidence;
    minConfSource = 'playbook';
  } else {
    minConf = DEFAULT_MIN_CONFIDENCE;
    minConfSource = 'playbook';
  }

  // ── SoW-2 safety upgrade: Merge-profile or on_irreversible=human + accept=confidence
  //    is forced to second_pass at runtime by the backend. Mirror that. ──
  let forcedUpgradeReason: string | undefined;
  if (accept === 'confidence' && (profile === 'merge' || onIrreversible === 'human')) {
    accept = 'second_pass';
    acceptSource = 'forced';
    forcedUpgradeReason =
      profile === 'merge'
        ? 'Merge-profile steps cannot auto-accept on confidence alone (SoW-2 policy)'
        : 'on_irreversible=human forces second_pass (SoW-2 policy)';
  }

  return {
    step,
    profile,
    model: modelOverride ?? step.model,
    modelSource: modelOverride !== undefined ? 'override' : 'playbook',
    budget: budgetOverride ?? step.budget,
    budgetSource: budgetOverride !== undefined ? 'override' : 'playbook',
    qa: {
      responder,
      responderSource,
      accept,
      acceptSource,
      min_confidence: minConf,
      min_confidenceSource: minConfSource,
      on_irreversible: onIrreversible,
      on_irreversibleSource: onIrreversibleSource,
      forcedUpgradeReason,
    },
    overriddenFields: overridden,
  };
}

/**
 * Client-side validation that mirrors backend-enforced rules. UI-4's
 * submit button is disabled while this returns errors, with each
 * `path` rendered next to its form control.
 *
 * The backend will re-validate; this is a UX shortcut, not a security
 * boundary.
 */
export function validateOverrides(
  steps: SpPlaybookStep[],
  ctx: AdvancedTaskContext | undefined | null,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const c = ctx ?? {};
  const qaOver = c.qa_override ?? {};

  // min_confidence range.
  if (typeof qaOver.min_confidence === 'number') {
    const v = qaOver.min_confidence;
    if (Number.isNaN(v) || v < 0 || v > 1) {
      errors.push({
        path: 'qa_override.min_confidence',
        message: 'min_confidence must be between 0.0 and 1.0',
      });
    }
  }

  // budget_usd_cap range.
  if (typeof c.budget_usd_cap === 'number') {
    if (Number.isNaN(c.budget_usd_cap) || c.budget_usd_cap < 0) {
      errors.push({
        path: 'budget_usd_cap',
        message: 'Budget cap must be non-negative',
      });
    }
  }

  // session_mode = shared on >1 step is allowed but the form attaches a
  // warning (not an error) — providers without session reuse will be
  // detected server-side. No client-side block.

  // Hard safety: accept=confidence (without playbook_default) on a step
  // whose resolved profile is Merge → fatal, because the backend will
  // force-upgrade anyway and we'd rather surface that pre-submit.
  // (We *also* upgrade in resolveStepConfig for the preview, but we
  // raise an error here so the form makes the user pick second_pass /
  // always_human / playbook_default explicitly.)
  if (qaOver.accept === 'confidence') {
    const hasMerge = steps.some(s => classifyStepProfile(s) === 'merge');
    if (hasMerge) {
      errors.push({
        path: 'qa_override.accept',
        message:
          'accept=confidence is not allowed when the playbook contains a Merge-profile step. Pick second_pass or always_human.',
      });
    }
  }

  return errors;
}

/**
 * Reverse direction: take a form-state object and emit a clean
 * `task.context` payload to POST. Strips `playbook_default` markers,
 * drops empties, leaves arbitrary user JSON in the raw escape hatch
 * untouched.
 */
export function buildTaskContext(
  ctx: AdvancedTaskContext,
  raw?: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(raw ?? {}) };

  if (ctx.session_mode) out['session_mode'] = ctx.session_mode;
  if (ctx.preserve_worktree !== undefined) out['preserve_worktree'] = ctx.preserve_worktree;

  if (ctx.qa_override) {
    const qa: Record<string, unknown> = {};
    if (ctx.qa_override.responder && ctx.qa_override.responder !== 'playbook_default') {
      qa['responder'] = ctx.qa_override.responder;
    }
    if (ctx.qa_override.accept && ctx.qa_override.accept !== 'playbook_default') {
      qa['accept'] = ctx.qa_override.accept;
    }
    if (typeof ctx.qa_override.min_confidence === 'number') {
      qa['min_confidence'] = ctx.qa_override.min_confidence;
    }
    if (
      ctx.qa_override.on_irreversible &&
      ctx.qa_override.on_irreversible !== 'playbook_default'
    ) {
      qa['on_irreversible'] = ctx.qa_override.on_irreversible;
    }
    if (Object.keys(qa).length > 0) out['qa_override'] = qa;
  }

  if (ctx.knowledge) {
    const k: Record<string, unknown> = {};
    if (ctx.knowledge.pin_ids && ctx.knowledge.pin_ids.length) k['pin_ids'] = ctx.knowledge.pin_ids;
    if (ctx.knowledge.exclude_tags && ctx.knowledge.exclude_tags.length) {
      k['exclude_tags'] = ctx.knowledge.exclude_tags;
    }
    if (Object.keys(k).length > 0) out['knowledge'] = k;
  }

  if (ctx.verifications) {
    const v: Record<string, unknown> = {};
    if (ctx.verifications.ids && ctx.verifications.ids.length) v['ids'] = ctx.verifications.ids;
    if (ctx.verifications.fail_fast) v['fail_fast'] = true;
    if (ctx.verifications.extra_test_cmd && ctx.verifications.extra_test_cmd.trim() !== '') {
      v['extra_test_cmd'] = ctx.verifications.extra_test_cmd.trim();
    }
    if (Object.keys(v).length > 0) out['verifications'] = v;
  }

  if (ctx.reports && ctx.reports.length > 0) out['reports'] = ctx.reports;
  if (ctx.agent_id) out['agent_id'] = ctx.agent_id;
  if (ctx.integrations_allowed && ctx.integrations_allowed.length > 0) {
    out['integrations_allowed'] = ctx.integrations_allowed;
  }
  if (ctx.model_override && ctx.model_override.trim() !== '') {
    out['model_override'] = ctx.model_override.trim();
  }
  if (typeof ctx.budget_usd_cap === 'number' && ctx.budget_usd_cap > 0) {
    out['budget_usd_cap'] = ctx.budget_usd_cap;
  }

  return out;
}

