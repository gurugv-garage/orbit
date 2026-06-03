import { createContext, useContext, useEffect, useState } from 'react';
import { StationClient } from './station';
import type { EventFrame, Topic } from './protocol';

export const StationContext = createContext<StationClient | null>(null);

export function useStationClient(): StationClient {
  const c = useContext(StationContext);
  if (!c) throw new Error('useStationClient outside provider');
  return c;
}

/** Subscribe to live events on one topic (or all). Re-renders on each event via cb. */
export function useStationEvents(topic: Topic | '*', cb: (e: EventFrame) => void): void {
  const client = useStationClient();
  useEffect(() => {
    return client.onEvent((e) => {
      if (topic === '*' || e.topic === topic) cb(e);
    });
    // cb is expected stable (useCallback) or intentionally re-subscribing.
  }, [client, topic, cb]);
}

export function useConnected(): boolean {
  const client = useStationClient();
  const [connected, setConnected] = useState(false);
  useEffect(() => client.onStatus(setConnected), [client]);
  return connected;
}
