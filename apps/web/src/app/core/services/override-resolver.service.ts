import { Injectable } from '@angular/core';
import {
  buildTaskContext,
  classifyStepProfile,
  resolveStepConfig,
  validateOverrides,
} from './override-resolver';

/**
 * DI wrapper around the pure `override-resolver` module. The pure
 * module lives at `./override-resolver` (no Angular deps) so unit
 * tests can import it without standing up the Angular runtime.
 */
@Injectable({ providedIn: 'root' })
export class OverrideResolverService {
  classifyStepProfile = classifyStepProfile;
  resolveStepConfig = resolveStepConfig;
  validateOverrides = validateOverrides;
  buildTaskContext = buildTaskContext;
}

export * from './override-resolver';
