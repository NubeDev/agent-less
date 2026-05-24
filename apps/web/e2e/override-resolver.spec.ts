import { test, expect } from '@playwright/test';
import {
  buildTaskContext,
  classifyStepProfile,
  resolveStepConfig,
  validateOverrides,
} from '../src/app/core/services/override-resolver';
import type { SpPlaybookStep } from '../src/app/core/services/playbooks-api.service';

/**
 * Unit tests for the shared override-resolver. Uses Playwright as a
 * test runner because the workspace doesn't have Karma/Jest/Vitest
 * configured yet, but these tests never touch the browser — they
 * exercise pure functions.
 *
 * If you add Vitest later, the imports are framework-agnostic enough
 * that this file should port with only the `import` line changing.
 */

function mkStep(overrides: Partial<SpPlaybookStep> = {}): SpPlaybookStep {
  return {
    name: 'Implement',
    description: '',
    on_complete: 'review',
    step: 1,
    ...overrides,
  };
}

test.describe('override-resolver: classifyStepProfile', () => {
  test('classifies by step name and git_action', () => {
    expect(classifyStepProfile(mkStep({ name: 'Implement' }))).toBe('implement');
    expect(classifyStepProfile(mkStep({ name: 'Review changes' }))).toBe('review');
    expect(classifyStepProfile(mkStep({ name: 'Merge into main' }))).toBe('merge');
    expect(classifyStepProfile(mkStep({ name: 'Dream' }))).toBe('dream');
    expect(classifyStepProfile(mkStep({ name: 'Whatever' }))).toBe('other');
    expect(classifyStepProfile(mkStep({ name: 'Finalize', git_action: 'merge' }))).toBe('merge');
  });
});

test.describe('override-resolver: resolveStepConfig', () => {
  test('no overrides + no qa block → human responder, default min_confidence', () => {
    const step = mkStep({ name: 'Implement', model: 'gpt-5', budget: 5 });
    const r = resolveStepConfig(step, null);
    expect(r.qa.responder).toBe('human');
    expect(r.qa.responderSource).toBe('playbook');
    expect(r.qa.accept).toBe('confidence');
    expect(r.qa.min_confidence).toBeCloseTo(0.85);
    expect(r.model).toBe('gpt-5');
    expect(r.budget).toBe(5);
    expect(r.overriddenFields).toEqual([]);
    expect(r.qa.forcedUpgradeReason).toBeUndefined();
  });

  test('per-task qa_override beats playbook qa', () => {
    const step = mkStep({
      name: 'Implement',
      settings: { qa: { responder: 'human', accept: 'always_human' } },
    });
    const r = resolveStepConfig(step, {
      qa_override: { responder: 'ai', accept: 'second_pass', min_confidence: 0.9 },
    });
    expect(r.qa.responder).toBe('ai');
    expect(r.qa.responderSource).toBe('override');
    expect(r.qa.accept).toBe('second_pass');
    expect(r.qa.acceptSource).toBe('override');
    expect(r.qa.min_confidence).toBeCloseTo(0.9);
    expect(r.overriddenFields).toEqual(
      expect.arrayContaining([
        'steps[1].qa.responder',
        'steps[1].qa.accept',
        'steps[1].qa.min_confidence',
      ]),
    );
  });

  test('playbook_default sentinel falls back to playbook value', () => {
    const step = mkStep({
      name: 'Implement',
      settings: { qa: { responder: 'ai', accept: 'confidence', min_confidence: 0.7 } },
    });
    const r = resolveStepConfig(step, {
      qa_override: { responder: 'playbook_default', accept: 'playbook_default' },
    });
    expect(r.qa.responder).toBe('ai');
    expect(r.qa.responderSource).toBe('playbook');
    expect(r.qa.accept).toBe('confidence');
    expect(r.qa.acceptSource).toBe('playbook');
    expect(r.qa.min_confidence).toBeCloseTo(0.7);
  });

  test('Merge-profile step force-upgrades accept=confidence → second_pass', () => {
    const step = mkStep({ name: 'Merge', git_action: 'merge' });
    const r = resolveStepConfig(step, {
      qa_override: { responder: 'ai', accept: 'confidence' },
    });
    expect(r.qa.accept).toBe('second_pass');
    expect(r.qa.acceptSource).toBe('forced');
    expect(r.qa.forcedUpgradeReason).toMatch(/Merge/);
  });

  test('on_irreversible=human upgrade fires on non-Merge step', () => {
    const step = mkStep({ name: 'Implement' });
    const r = resolveStepConfig(step, {
      qa_override: { accept: 'confidence', on_irreversible: 'human' },
    });
    expect(r.qa.accept).toBe('second_pass');
    expect(r.qa.acceptSource).toBe('forced');
    expect(r.qa.forcedUpgradeReason).toMatch(/on_irreversible/);
  });

  test('model and budget overrides apply across all steps', () => {
    const step = mkStep({ name: 'Implement', model: 'gpt-5', budget: 5 });
    const r = resolveStepConfig(step, { model_override: 'claude-opus', budget_usd_cap: 10 });
    expect(r.model).toBe('claude-opus');
    expect(r.modelSource).toBe('override');
    expect(r.budget).toBe(10);
    expect(r.budgetSource).toBe('override');
  });
});

test.describe('override-resolver: validateOverrides', () => {
  test('rejects min_confidence out of range', () => {
    const errs = validateOverrides([mkStep()], { qa_override: { min_confidence: 1.5 } });
    expect(errs).toHaveLength(1);
    expect(errs[0].path).toBe('qa_override.min_confidence');
  });

  test('blocks accept=confidence when playbook has a Merge step', () => {
    const steps = [mkStep({ name: 'Implement', step: 1 }), mkStep({ name: 'Merge', step: 2 })];
    const errs = validateOverrides(steps, { qa_override: { accept: 'confidence' } });
    expect(errs.map(e => e.path)).toContain('qa_override.accept');
  });

  test('allows accept=confidence on pure-Implement playbook', () => {
    const steps = [mkStep({ name: 'Implement' })];
    const errs = validateOverrides(steps, { qa_override: { accept: 'confidence' } });
    expect(errs).toEqual([]);
  });
});

test.describe('override-resolver: buildTaskContext', () => {
  test('strips playbook_default markers and empties', () => {
    const out = buildTaskContext({
      qa_override: {
        responder: 'playbook_default',
        accept: 'playbook_default',
        on_irreversible: 'playbook_default',
      },
      knowledge: { pin_ids: [], exclude_tags: [] },
      verifications: { ids: [], fail_fast: false, extra_test_cmd: '   ' },
      reports: [],
    });
    expect(out).toEqual({});
  });

  test('preserves provided fields and merges raw passthrough', () => {
    const out = buildTaskContext(
      {
        session_mode: 'shared',
        preserve_worktree: false,
        qa_override: { responder: 'ai', min_confidence: 0.9 },
        reports: ['diff_summary', 'cost_breakdown'],
        model_override: 'claude-opus',
        budget_usd_cap: 7.5,
      },
      { spec: 'do the thing', custom: { x: 1 } },
    );
    expect(out['spec']).toBe('do the thing');
    expect(out['custom']).toEqual({ x: 1 });
    expect(out['session_mode']).toBe('shared');
    expect(out['preserve_worktree']).toBe(false);
    expect(out['qa_override']).toEqual({ responder: 'ai', min_confidence: 0.9 });
    expect(out['reports']).toEqual(['diff_summary', 'cost_breakdown']);
    expect(out['model_override']).toBe('claude-opus');
    expect(out['budget_usd_cap']).toBe(7.5);
  });
});
