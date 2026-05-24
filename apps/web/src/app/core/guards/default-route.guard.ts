import { Injectable, inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { CanActivate, Router, UrlTree } from '@angular/router';
import { Observable, of } from 'rxjs';
import { filter, map, take } from 'rxjs/operators';
import { AuthService } from '../services/auth.service';

/** Persistent key (localStorage) recording the user's preferred mode. */
const MODE_KEY = 'diraigent.uiMode';
type UiMode = 'quick' | 'advanced';

/**
 * UI-2 — Default landing route. Authenticated users hitting `/` are
 * redirected to either `/quick` (default for first-time logins) or
 * `/dashboard` if they have explicitly opted into the advanced view.
 * Unauthenticated visitors still see the landing page.
 *
 * Note: this only guards the bare `''` route. Direct navigation to
 * `/dashboard` or `/quick` always works without a redirect.
 */
@Injectable({ providedIn: 'root' })
export class DefaultRouteGuard implements CanActivate {
  private auth = inject(AuthService);
  private router = inject(Router);
  private platformId = inject(PLATFORM_ID);

  canActivate(): Observable<boolean | UrlTree> {
    if (!isPlatformBrowser(this.platformId)) return of(true);
    if (this.auth.isAuthInitialized()) {
      return of(this.decide());
    }
    return this.auth.authInitialized$.pipe(
      filter(init => init),
      take(1),
      map(() => this.decide()),
    );
  }

  private decide(): boolean | UrlTree {
    if (!this.auth.isLoggedIn()) return true;
    const pref = (localStorage.getItem(MODE_KEY) as UiMode | null) ?? 'quick';
    return pref === 'advanced'
      ? this.router.parseUrl('/dashboard')
      : this.router.parseUrl('/quick');
  }
}

/** Read or write the persisted UI-mode preference. Used by toggle buttons. */
export function getUiMode(): UiMode {
  if (typeof localStorage === 'undefined') return 'quick';
  return (localStorage.getItem(MODE_KEY) as UiMode | null) ?? 'quick';
}

export function setUiMode(mode: UiMode): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(MODE_KEY, mode);
}
