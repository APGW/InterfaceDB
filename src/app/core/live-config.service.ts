import { Injectable, signal } from '@angular/core';

import type { RangeMode } from './live.models';

export type AuthenticationMode = 'none' | 'bearer' | 'oauth2';
export type SequenceGapAction = 'reload-snapshot' | 'stop-with-error';

export interface ApiConnectionConfig {
  baseUrl: string;
  meterId: string;
  snapshotPath: string;
  updatesPath: string;
  lastSeenPath: string;
  authenticationMode: AuthenticationMode;
  bearerToken: string;
  oauthIssuerUrl: string;
  oauthClientId: string;
  oauthScope: string;
  timeoutMs: number;
  pollingSeconds: number;
  requestLimit: number;
  retryCount: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  unansweredRequestLimit: number;
  maxCatchUpRequests: number;
  snapshotRefreshMinutes: number;
  sequenceGapAction: SequenceGapAction;
  defaultRange: RangeMode;
  bucket15mSeconds: number;
  bucket1hSeconds: number;
  bucket24hSeconds: number;
  demoMode: boolean;
}

export const DEFAULT_API_CONFIG: ApiConnectionConfig = {
  baseUrl: 'http://127.0.0.1:8080/api/v1/live',
  meterId: 'PQM-MTR-01',
  snapshotPath: '/snapshot',
  updatesPath: '/updates',
  lastSeenPath: '/last-seen',
  authenticationMode: 'none',
  bearerToken: '',
  oauthIssuerUrl: 'https://keycloak.example/realms/pqm',
  oauthClientId: 'pqm-live-dashboard',
  oauthScope: 'openid profile',
  timeoutMs: 5000,
  pollingSeconds: 2,
  requestLimit: 2000,
  retryCount: 2,
  retryBaseDelayMs: 500,
  retryMaxDelayMs: 5000,
  unansweredRequestLimit: 3,
  maxCatchUpRequests: 10,
  snapshotRefreshMinutes: 15,
  sequenceGapAction: 'reload-snapshot',
  defaultRange: 'live',
  bucket15mSeconds: 5,
  bucket1hSeconds: 30,
  bucket24hSeconds: 360,
  demoMode: true,
};

@Injectable({ providedIn: 'root' })
export class LiveConfigService {
  private readonly storageKey = 'pqm-live-api-config';
  private readonly configSignal = signal<ApiConnectionConfig>(this.load());
  readonly config = this.configSignal.asReadonly();

  update(value: ApiConnectionConfig): void {
    const normalized: ApiConnectionConfig = {
      ...value,
      baseUrl: value.baseUrl.trim().replace(/\/$/, ''),
      meterId: value.meterId.trim(),
      snapshotPath: this.normalizePath(value.snapshotPath),
      updatesPath: this.normalizePath(value.updatesPath),
      lastSeenPath: this.normalizePath(value.lastSeenPath),
      oauthIssuerUrl: value.oauthIssuerUrl.trim().replace(/\/$/, ''),
      oauthClientId: value.oauthClientId.trim(),
      oauthScope: value.oauthScope.trim(),
      pollingSeconds: Math.min(30, Math.max(.5, Number(value.pollingSeconds))),
      timeoutMs: Math.min(60_000, Math.max(500, Math.round(Number(value.timeoutMs)))),
      requestLimit: Math.min(20_000, Math.max(100, Math.round(Number(value.requestLimit)))),
      retryCount: Math.min(10, Math.max(0, Math.round(Number(value.retryCount)))),
      retryBaseDelayMs: Math.min(30_000, Math.max(100, Math.round(Number(value.retryBaseDelayMs)))),
      retryMaxDelayMs: Math.min(120_000, Math.max(Number(value.retryBaseDelayMs), Math.round(Number(value.retryMaxDelayMs)))),
      unansweredRequestLimit: Math.min(20, Math.max(1, Math.round(Number(value.unansweredRequestLimit)))),
      maxCatchUpRequests: Math.min(100, Math.max(1, Math.round(Number(value.maxCatchUpRequests)))),
      snapshotRefreshMinutes: Math.min(1440, Math.max(0, Math.round(Number(value.snapshotRefreshMinutes)))),
      bucket15mSeconds: Math.max(1, Math.round(Number(value.bucket15mSeconds))),
      bucket1hSeconds: Math.max(1, Math.round(Number(value.bucket1hSeconds))),
      bucket24hSeconds: Math.max(1, Math.round(Number(value.bucket24hSeconds))),
    };
    this.configSignal.set(normalized);

    // Access tokens remain session-only and are never written to localStorage.
    const { bearerToken: _secret, ...persistable } = normalized;
    localStorage.setItem(this.storageKey, JSON.stringify(persistable));
  }

  reset(): void {
    localStorage.removeItem(this.storageKey);
    this.configSignal.set({ ...DEFAULT_API_CONFIG });
  }

  private load(): ApiConnectionConfig {
    try {
      const stored = localStorage.getItem(this.storageKey);
      if (!stored) return { ...DEFAULT_API_CONFIG };
      return { ...DEFAULT_API_CONFIG, ...JSON.parse(stored) as Partial<ApiConnectionConfig>, bearerToken: '' };
    } catch {
      return { ...DEFAULT_API_CONFIG };
    }
  }

  private normalizePath(path: string): string {
    const trimmed = path.trim();
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  }
}
