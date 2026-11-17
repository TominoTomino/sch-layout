// Shared EasyEDA bridge helpers.
//
// The bridge is a local HTTP server (ports 49620-49629) that relays a snippet of
// JavaScript into EasyEDA Pro. Every script that touches the editor goes through
// here so the port scan and the error shape stay identical.
const PORTS = Array.from({ length: 10 }, (_, i) => 49620 + i);

export async function findBridge(port = null) {
  const list = port ? [port] : PORTS;
  for (const p of list) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(1500) });
      const j = await r.json();
      if (j && j.service === 'easyeda-bridge') return { port: p, health: j };
    } catch { /* port closed */ }
  }
  return null;
}

// Run `code` inside the editor and return its `return` value.
// A single request is capped at 30 s by the bridge, so callers that need more
// must fire-and-forget and poll (see rehearse.mjs / D29).
export async function exec(port, code, timeoutMs = 120000) {
  const res = await fetch(`http://127.0.0.1:${port}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const payload = await res.json();
  if (!payload.success) {
    const msg = payload.error || JSON.stringify(payload).slice(0, 500);
    throw new Error('bridge exec failed: ' + msg);
  }
  return payload.result;
}
