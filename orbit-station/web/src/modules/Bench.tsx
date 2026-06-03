/**
 * Benchmarks — the existing self-contained dock-LLM viewer, embedded as-is.
 * The viewer (web/public/modules/bench.html) fetches snapshot data from
 * /api/bench/results/* served by the server's bench module. No React rewrite:
 * it's a working, committed artifact; an iframe is the right amount of glue.
 */
export function Bench() {
  return (
    <section>
      <h2 className="title">Benchmarks</h2>
      <p className="subtitle">Dock-LLM benchmark viewer (moved here from node-dock/app/bench).</p>
      <iframe className="frame" src="/modules/bench.html" title="benchmark viewer" />
    </section>
  );
}
