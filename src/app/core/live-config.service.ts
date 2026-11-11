import { Injectable, signal } from '@angular/core';

export type AuthenticationMode = 'none' | 'bearer';

export interface ApiConnectionConfig {
  baseUrl: string;
  meterId: string;
  snapshotPath: string;
  updatesPath: string;
  lastSeenPath: string;
  authenticationMode: AuthenticationMode;
  bearerToken: string;
  timeoutMs: number;
  pollingSeconds: number;
  requestLimit: number;
  bucket15mSeconds: number;
  bucket1hSeconds: number;
  bucket24hSeconds: number;
  demoMode: boolean;
}

export const DEFAULT_API_CONFIG: ApiConnectionConfig = {
  baseUrl: '/api/v1/live',
  meterId: 'PQM-MTR-01',
  snapshotPath: '/snapshot',
  updatesPath: '/updates',
  lastSeenPath: '/last-seen',
  authenticationMode: 'none',
  bearerToken: '',
  timeoutMs: 5000,
  pollingSeconds: 2,
  requestLimit: 2000,
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
      snapshotPath: this.normalizePath(value.snapshotPath),
      updatesPath: this.normalizePath(value.updatesPath),
      lastSeenPath: this.normalizePath(value.lastSeenPath),
      pollingSeconds: Math.min(30, Math.max(.5, Number(value.pollingSeconds))),
      timeoutMs: Math.min(60_000, Math.max(500, Math.round(Number(value.timeoutMs)))),
      requestLimit: Math.min(20_000, Math.max(100, Math.round(Number(value.requestLimit)))),
      bucket15mSeconds: Math.max(1, Math.round(Number(value.bucket15mSeconds))),
      bucket1hSeconds: Math.max(1, Math.round(Number(value.bucket1hSeconds))),
      bucket24hSeconds: Math.max(1, Math.round(Number(value.bucket24hSeconds))),
    };
    this.configSignal.set(normalized);

    // The bearer token remains session-only and is never written to localStorage.
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
