/**
 * LiveTile — one dock's live A/V tile: a recvonly RTCPeerConnection + <video>,
 * signaled over the `media` topic, with a per-tile audio toggle (audio is OFF by
 * default — the phone mic ↔ laptop speakers form a feedback loop) and an "enroll
 * the face on screen" button. Extracted from the old Live Wall (LiveStream.tsx)
 * so the Perception view can show the selected dock's live stream inline. See the
 * SFU in orbit-station/server/src/modules/media.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/station';
import { useStationClient, useStationEvents } from '../lib/useStation';

export function LiveTile({ streamId, label }: { streamId: string; label: string }) {
  const client = useStationClient();
  const videoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  // One combined stream per tile: the SFU sends audio + video as SEPARATE
  // MediaStreams, so we must collect both tracks into a single stream — else the
  // <video>'s srcObject ends up with only whichever track arrived last (audio
  // gets dropped → silent). Keep our own stream and add each inbound track to it.
  const streamRef = useRef<MediaStream>(new MediaStream());
  const [live, setLive] = useState(false);
  const [audioOn, setAudioOn] = useState(false);
  // Whether video frames are actually decoding. A producer can be advertised with
  // video:true yet send no RTP (a half-dead/idle dock stream) — the PC still
  // connects, so 'connecting…' clears but the picture stays black. We poll
  // getStats for advancing frames/packets and surface a clear overlay so it's
  // obvious it's the dock, not the viewer: distinguish "audio only (no camera)"
  // from "nothing flowing" — an audio-only dock is working, just has no picture.
  const [videoFlowing, setVideoFlowing] = useState(false);
  const [audioFlowing, setAudioFlowing] = useState(false);

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

  // Poll inbound stats: a track is "flowing" only if its counter keeps advancing
  // (video → framesDecoded, audio → packetsReceived). Reset whenever the streamId
  // changes (new tile). Tracked separately so audio-only docks read as working.
  useEffect(() => {
    setVideoFlowing(false); setAudioFlowing(false);
    let lastV = -1, lastA = -1, alive = true;
    const t = setInterval(async () => {
      const pc = pcRef.current;
      if (!pc || !alive) return;
      let frames = 0, audioPkts = 0;
      (await pc.getStats()).forEach((s) => {
        if (s.type !== 'inbound-rtp') return;
        const r = s as RTCInboundRtpStreamStats;
        if (r.kind === 'video') frames = r.framesDecoded ?? 0;
        if (r.kind === 'audio') audioPkts = r.packetsReceived ?? 0;
      });
      setVideoFlowing(frames > lastV && frames > 0);
      setAudioFlowing(audioPkts > lastA && audioPkts > 0);
      lastV = frames; lastA = audioPkts;
    }, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [streamId]);

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
    <div style={{ position: 'relative', borderRadius: 12, overflow: 'hidden', background: '#0b0e16', border: audioOn ? '2px solid #6aa2ff' : '2px solid #1c2233' }}>
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
      {/* Connected but no video frames → either audio-only (working, no camera) or
          nothing flowing (dead stream). Distinguish them instead of a silent black
          box that always reads as "broken". */}
      {live && !videoFlowing && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
          background: 'rgba(7,10,17,0.78)', color: '#8aa', fontSize: 13, textAlign: 'center', padding: 16 }}>
          <div>
            <div style={{ fontSize: 24, marginBottom: 6, opacity: 0.7 }}>{audioFlowing ? '🎙' : '📵'}</div>
            {audioFlowing ? 'audio only' : 'no live video'}<br />
            <span style={{ opacity: 0.6, fontSize: 12 }}>
              {audioFlowing ? `${label} is streaming audio but no camera` : `connected, but ${label} isn’t streaming frames`}
            </span>
          </div>
        </div>
      )}
      {/* Audio is OFF by default (mic↔speaker feedback). Explicit per-tile enable. */}
      <button
        onClick={() => setAudioOn((a) => !a)}
        title={audioOn ? 'Mute audio' : 'Enable audio (may echo if near the dock)'}
        style={{ position: 'absolute', bottom: 6, left: 6, padding: '4px 8px' }}
      >
        {audioOn ? '🔊 Audio on' : '🔇 Enable audio'}
      </button>
      <EnrollButton streamId={streamId} />
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
