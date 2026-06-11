import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/station';
import { useStationClient, useStationEvents } from '../lib/useStation';

interface ProducerInfo {
  streamId: string;          // the producer's unique peer id (addressing key)
  label: string;             // friendly dock name (display)
  tracks: { audio: boolean; video: boolean };
  viewers: number;
}
interface MediaStatus {
  producers: ProducerInfo[];
  viewers: string[];
  waiting: string[];
}

/**
 * Live A/V wall. Each connected dock is its own stream (keyed by streamId); the
 * operator checks which docks to watch and they play simultaneously in a grid —
 * one recvonly RTCPeerConnection per watched dock, signaled over the `media`
 * topic. Video plays for every tile; audio plays for only ONE tile at a time
 * (click a tile to make it the audio source) to avoid a cacophony. See the SFU
 * in orbit-station/server/src/modules/media.
 */
export function LiveStream() {
  const [status, setStatus] = useState<MediaStatus | null>(null);
  const [watching, setWatching] = useState<Set<string>>(new Set());
  const [audioStream, setAudioStream] = useState<string | null>(null);

  const loadStatus = useCallback(() => {
    api.get<MediaStatus>('/media/status').then(setStatus).catch(() => {});
  }, []);
  useEffect(loadStatus, [loadStatus]);

  // Producer set changes (dock joins/leaves) → refresh the picker.
  useStationEvents('media', useCallback(() => loadStatus(), [loadStatus]));
  // Dock peers come/go on the station topic too — keep the picker live.
  useStationEvents('station', useCallback((e) => {
    if (e.kind === 'peer-joined' || e.kind === 'peer-left' || e.kind === 'dock-updated') loadStatus();
  }, [loadStatus]));

  const producers = status?.producers ?? [];

  const toggle = (streamId: string) => {
    setWatching((prev) => {
      const next = new Set(prev);
      if (next.has(streamId)) {
        next.delete(streamId);
        setAudioStream((a) => (a === streamId ? null : a)); // stop audio if this was the source
      } else {
        next.add(streamId);
        // Audio stays OFF by default — the phone mic + laptop speakers form a
        // feedback loop, so the operator must explicitly enable audio per tile.
      }
      return next;
    });
  };

  // Enable audio for one tile (and only one — single audio source at a time).
  const enableAudio = (streamId: string) => setAudioStream((a) => (a === streamId ? null : streamId));

  return (
    <section>
      <h2 className="title">Live Wall</h2>
      <p className="subtitle">
        {producers.length
          ? <>{producers.length} dock(s) streaming · watching {watching.size}</>
          : 'No docks are streaming yet.'}
      </p>

      {producers.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
          {producers.map((p) => (
            <label key={p.streamId} className="chip" style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={watching.has(p.streamId)} onChange={() => toggle(p.streamId)} />
              <span className="mono">{p.label}</span>
              {p.tracks.video ? ' 📹' : ''}{p.tracks.audio ? ' 🎙' : ''}
            </label>
          ))}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
        {[...watching].map((streamId) => (
          <StreamTile
            key={streamId}
            streamId={streamId}
            label={producers.find((p) => p.streamId === streamId)?.label ?? streamId}
            audioOn={audioStream === streamId}
            onToggleAudio={() => enableAudio(streamId)}
            onClose={() => toggle(streamId)}
          />
        ))}
      </div>
    </section>
  );
}

/** One dock's live tile: its own recvonly PeerConnection + <video>. */
function StreamTile({ streamId, label, audioOn, onToggleAudio, onClose }: {
  streamId: string; label: string; audioOn: boolean; onToggleAudio: () => void; onClose: () => void;
}) {
  const client = useStationClient();
  const videoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  // One combined stream per tile: the SFU sends audio + video as SEPARATE
  // MediaStreams, so we must collect both tracks into a single stream — else the
  // <video>'s srcObject ends up with only whichever track arrived last (audio
  // gets dropped → silent). Keep our own stream and add each inbound track to it.
  const streamRef = useRef<MediaStream>(new MediaStream());
  const [live, setLive] = useState(false);

  const join = useCallback(() => {
    pcRef.current?.close();
    streamRef.current = new MediaStream();
    const pc = new RTCPeerConnection();
    pcRef.current = pc;
    pc.ontrack = (e) => {
      streamRef.current.addTrack(e.track);
      if (videoRef.current) {
        videoRef.current.srcObject = streamRef.current;
        void videoRef.current.play().catch(() => {}); // autoplay may need this nudge
        setLive(true);
      }
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) client.publish('media', 'viewer-ice', { streamId, candidate: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') setLive(false);
    };
    client.publish('media', 'viewer-ready', { streamId });
  }, [client, streamId]);

  useEffect(() => {
    join();
    return () => {
      client.publish('media', 'viewer-leave', { streamId });
      pcRef.current?.close();
      pcRef.current = null;
    };
  }, [join, client, streamId]);

  // Only this tile's signaling (matching streamId) drives its PC.
  useStationEvents('media', useCallback((e) => {
    const p = e.payload as Record<string, unknown> | null;
    if (p?.streamId !== streamId) return;
    const pc = pcRef.current;
    if (e.kind === 'viewer-offer' && pc && p?.sdp) {
      void (async () => {
        await pc.setRemoteDescription({ type: 'offer', sdp: p.sdp as string });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        client.publish('media', 'viewer-answer', { streamId, sdp: answer.sdp });
      })();
    } else if (e.kind === 'viewer-ice' && pc && p?.candidate) {
      void pc.addIceCandidate(p.candidate as RTCIceCandidateInit).catch(() => {});
    }
  }, [client, streamId]));

  // Keep the element's mute state in sync and (re)start playback when this tile
  // becomes the audio source — unmuting a media element can require a fresh
  // play() in some browsers, and the user's click on the tile is the gesture
  // that unblocks audio autoplay.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !audioOn;
    void v.play().catch(() => {});
  }, [audioOn, live]);

  return (
    <div style={{ position: 'relative', borderRadius: 12, overflow: 'hidden', background: '#0b0e16', border: audioOn ? '2px solid #6aa2ff' : '2px solid transparent' }}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={!audioOn}
        style={{ width: '100%', display: 'block', aspectRatio: '4 / 3' }}
      />
      <div style={{ position: 'absolute', top: 6, left: 8, fontSize: 12, color: '#cbd5e1', textShadow: '0 1px 2px #000' }}>
        <span className="mono">{label}</span> {!live && '· connecting…'}
      </div>
      {/* Audio is OFF by default (mic↔speaker feedback). Explicit per-tile enable. */}
      <button
        onClick={onToggleAudio}
        title={audioOn ? 'Mute audio' : 'Enable audio (may echo if near the dock)'}
        style={{ position: 'absolute', bottom: 6, left: 6, padding: '4px 8px' }}
      >
        {audioOn ? '🔊 Audio on' : '🔇 Enable audio'}
      </button>
      <EnrollButton streamId={streamId} />
      <button onClick={onClose} style={{ position: 'absolute', top: 4, right: 4 }} aria-label="close">✕</button>
    </div>
  );
}

/** "Enroll this person" — names the face currently on screen into the gallery. */
function EnrollButton({ streamId }: { streamId: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const enroll = async () => {
    const name = window.prompt('Name this person (enrolls the face on screen):')?.trim();
    if (!name) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api.post<{ ok: boolean; reason?: string }>('/perception/enroll', { streamId, name });
      setMsg(r.ok ? `✓ enrolled ${name}` : `✗ ${r.reason ?? 'failed'}`);
    } catch { setMsg('✗ error'); }
    setBusy(false);
    setTimeout(() => setMsg(null), 4000);
  };
  return (
    <button
      onClick={enroll}
      disabled={busy}
      title="Enroll the face currently on screen"
      style={{ position: 'absolute', bottom: 6, right: 6, padding: '4px 8px' }}
    >
      {busy ? '…' : msg ?? '🪪 Enroll'}
    </button>
  );
}
