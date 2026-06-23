import { useCallback, useEffect, useState } from 'react';
import { api } from './station';
import { useStationEvents } from './useStation';

/** A live device that has dialed in but isn't bound to any dock yet
 *  (docs/modules/runtime-dock-binding.md). */
export interface UnclaimedDevice {
  id: string;
  kind?: string;
  label?: string;
  caps?: string[];
  ip?: string;
  build?: number;
  lastSeen: number;
  connectedAt: number;
}

/**
 * Live list of UNCLAIMED devices — connected peers with no dock binding,
 * waiting to be claimed onto a dock. Polls /api/docks/unclaimed and refreshes
 * on any `station`-topic event (a device joining/leaving or getting claimed).
 */
export function useUnclaimed(pollMs = 4000): { devices: UnclaimedDevice[]; refresh: () => void } {
  const [devices, setDevices] = useState<UnclaimedDevice[]>([]);

  const refresh = useCallback(() => {
    api.get<UnclaimedDevice[]>('/docks/unclaimed').then(setDevices).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, pollMs);
    return () => clearInterval(t);
  }, [refresh, pollMs]);

  useStationEvents('station', useCallback(() => refresh(), [refresh]));

  return { devices, refresh };
}

/** Bind a device to a dock (claim it). */
export function claimDevice(deviceId: string, dock: string): Promise<unknown> {
  return api.post('/docks/bind', { deviceId, dock });
}

/** Forget a device's binding — it re-parks UNCLAIMED on its next hello. */
export function unbindDevice(deviceId: string): Promise<unknown> {
  return api.del(`/docks/bind/${encodeURIComponent(deviceId)}`);
}
