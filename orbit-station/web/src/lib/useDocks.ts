import { useCallback, useEffect, useState } from 'react';
import { api } from './station';
import { useStationEvents } from './useStation';
import type { DockInfo } from './protocol';

/**
 * Live dock directory. Polls /api/docks (so ip/lastSeen stay fresh) and refreshes
 * immediately on any `station`-topic event (peer join/leave, dock-updated).
 * Shared by the always-on sidebar status and the Overview view.
 */
export function useDocks(pollMs = 4000): DockInfo[] {
  const [docks, setDocks] = useState<DockInfo[]>([]);

  const refresh = useCallback(() => {
    api.get<DockInfo[]>('/docks').then(setDocks).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, pollMs);
    return () => clearInterval(t);
  }, [refresh, pollMs]);

  useStationEvents('station', useCallback(() => refresh(), [refresh]));

  return docks;
}

/** A 1s tick for live "seen Ns ago" relative-time rendering. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function relTime(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 2) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/** Humanize a millisecond duration knob/value: 300000 → "5m", 3600000 → "1h". The one
 *  shared duration formatter — modules were each rolling their own s/m/h ladder. */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${+(ms / 60_000).toFixed(1)}m`.replace('.0m', 'm');
  return `${+(ms / 3_600_000).toFixed(1)}h`.replace('.0h', 'h');
}
