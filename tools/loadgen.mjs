/**
 * One shard of the load client. The parent forks several of these: a single Node
 * process saturates around two thousand sockets, and past that the measurement is
 * of the harness rather than the room.
 */
const WS = process.env.WS;
const COUNT = Number(process.env.COUNT);
const OFFSET = Number(process.env.OFFSET);
const WORD_EVERY_MS = Number(process.env.WORD_EVERY_MS ?? 4000);
const DURATION_MS = Number(process.env.DURATION_MS ?? 15000);
const WORDS = JSON.parse(process.env.WORDS ?? "[]");
const HANDSHAKE_BATCH = Number(process.env.HANDSHAKE_BATCH ?? 200);
const HANDSHAKE_PAUSE_MS = Number(process.env.HANDSHAKE_PAUSE_MS ?? 40);

const stats = {
  connected: 0,
  failed: 0,
  closed: 0,
  boards: 0,
  sent: 0,
  ok: 0,
  refused: 0,
  leaderboards: 0,
  neverOpened: 0,
  closeCodes: {},
  latencies: [],
};

const openedOnce = new Set();

const sockets = [];
const pendingAt = new Map(); // socket index + word -> timestamp

for (let i = 0; i < COUNT; i++) {
  const id = OFFSET + i;
  let ws;
  try {
    ws = new WebSocket(`${WS}/api/play`);
  } catch {
    stats.failed++;
    continue;
  }
  sockets.push(ws);
  ws.addEventListener("open", () => {
    openedOnce.add(i);
    stats.connected++;
    ws.send(JSON.stringify({ t: "hello", name: `bot${id}`, id: `load-${id}` }));
  });
  ws.addEventListener("error", () => stats.failed++);
  ws.addEventListener("close", (ev) => {
    stats.closed++;
    // Who refused, and why. A per-IP limit and an overloaded room look identical
    // in a bare count, but not in the close code.
    const key = `${ev.code}:${String(ev.reason ?? "").slice(0, 40)}`;
    stats.closeCodes[key] = (stats.closeCodes[key] ?? 0) + 1;
    if (!openedOnce.has(i)) stats.neverOpened++;
  });
  ws.addEventListener("message", (e) => {
    const raw = String(e.data);
    if (raw.charCodeAt(6) === 108) {
      // {"t":"lb" — most of the traffic, and nothing for the harness to do.
      stats.leaderboards++;
      return;
    }
    const m = JSON.parse(raw);
    if (m.t === "board") stats.boards++;
    else if (m.t === "ok" || m.t === "no") {
      const key = `${i}:${m.w}`;
      const at = pendingAt.get(key);
      if (at !== undefined) {
        stats.latencies.push(Date.now() - at);
        pendingAt.delete(key);
      }
      if (m.t === "ok") stats.ok++;
      else stats.refused++;
    }
  });
  // Spread the handshakes. Connection *rate* and connection *count* are different
  // limits and a burst conflates them, so the pacing is adjustable.
  if (i % HANDSHAKE_BATCH === HANDSHAKE_BATCH - 1) {
    await new Promise((r) => setTimeout(r, HANDSHAKE_PAUSE_MS));
  }
}

// Report the ramp before the steady state begins.
await new Promise((r) => setTimeout(r, 3000));
process.send?.({ type: "ready", connected: stats.connected, failed: stats.failed, boards: stats.boards });

const end = Date.now() + DURATION_MS;
let step = 0;
while (Date.now() < end && WORDS.length > 0) {
  for (let i = 0; i < sockets.length; i++) {
    const ws = sockets[i];
    if (ws.readyState !== 1) continue;
    // Distinct words per socket per step, so nothing is refused as already found.
    const word = WORDS[(i * 7 + step) % WORDS.length];
    pendingAt.set(`${i}:${word}`, Date.now());
    try {
      ws.send(JSON.stringify({ t: "word", w: word }));
      stats.sent++;
    } catch {
      /* socket gone */
    }
  }
  step++;
  await new Promise((r) => setTimeout(r, WORD_EVERY_MS));
}

stats.stillOpen = sockets.filter((s) => s.readyState === 1).length;
process.send?.({ type: "done", stats });
for (const s of sockets) {
  try {
    s.close();
  } catch {
    /* already closing */
  }
}
setTimeout(() => process.exit(0), 500);
