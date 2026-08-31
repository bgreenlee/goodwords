/**
 * Post-deploy check against a running deployment. Verifies the parts that only a
 * real deploy exercises: the websocket upgrade reaching the durable object, the
 * object reading the dictionary out of the assets binding, and a word being scored
 * against the server's own solve.
 *
 *   npm run smoke                       # the live site
 *   SMOKE_URL=https://... npm run smoke # somewhere else
 */
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { solveBoard } from "../src/game/solver";
import { Trie } from "../src/game/trie";
import type { ServerMessage } from "../src/net/protocol";

const BASE = process.env.SMOKE_URL ?? "https://goodwords.fun";

const assetsOf = (html: string) =>
  [...html.matchAll(/\/assets\/[A-Za-z0-9_.-]+/g)].map((m) => m[0]).sort();

test("the deployment matches the current build", async () => {
  // Committing is not deploying. Twice now a change has been verified locally,
  // pushed, and left un-deployed; comparing the hashed asset names says so plainly.
  const local = assetsOf(readFileSync("dist/index.html", "utf8"));
  expect(local.length, "no built assets — run npm run build").toBeGreaterThan(0);

  // A fresh deploy takes a few seconds to be served everywhere, so give it time
  // rather than reporting drift that is about to resolve itself.
  const deadline = Date.now() + 60_000;
  let served: string[] = [];
  for (;;) {
    served = assetsOf(await fetch(BASE).then((r) => r.text()));
    if (JSON.stringify(served) === JSON.stringify(local)) return;
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  expect(served, "the deployment is behind dist/ — run npm run deploy").toEqual(local);
}, 90_000);

/**
 * One attempt at the websocket check. Publishing restarts the room and closes
 * every socket with it, and this runs seconds after a deploy — so a dropped
 * connection here means try again, not that the game is broken.
 */
async function checkRoom(): Promise<{ board: string[]; reason: string }> {
  const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/play`);
  const messages: ServerMessage[] = [];
  let closed = false;
  ws.addEventListener("message", (e) => messages.push(JSON.parse(String(e.data))));
  ws.addEventListener("close", () => (closed = true));

  await new Promise<void>((res, rej) => {
    ws.addEventListener("open", () => res());
    ws.addEventListener("error", () => rej(new Error("websocket refused")));
    setTimeout(() => rej(new Error("websocket timed out")), 15_000);
  });
  ws.send(JSON.stringify({ t: "hello", name: "smoke" }));

  const waitFor = async <T extends ServerMessage["t"]>(t: T, ms = 20_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = messages.find((m) => m.t === t);
      if (found) return found as Extract<ServerMessage, { t: T }>;
      if (closed) throw new Error(`socket closed while waiting for "${t}"`);
      if (Date.now() > deadline) throw new Error(`no "${t}"; saw ${JSON.stringify(messages)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  // Getting a board at all means the room loaded its dictionary from the assets
  // binding, which is the thing only a real deploy exercises.
  const dealt = await waitFor("board");
  expect(dealt.board).toHaveLength(25);
  expect(Math.abs(dealt.now - Date.now())).toBeLessThan(15_000);

  // Wait out a break rather than asking during one: mid-break the room answers
  // "round over", which proves nothing about its dictionary. The server's own
  // timestamps are the authority, not this machine's clock.
  const skew = dealt.now - Date.now();
  const untilPlaying = dealt.roundEndsAt - (Date.now() + skew);
  if (Date.now() + skew > dealt.playEndsAt) {
    await new Promise((r) => setTimeout(r, Math.max(0, untilPlaying) + 1500));
    await waitFor("board", 30_000);
  }

  // Deliberately never scores. A finished round is kept for a day, and a check
  // that runs on every deploy would sit in the standings beside real players.
  // Refusing a word proves the same path: the socket reached the room, the room
  // dealt a board, and it consulted its own dictionary to say no.
  ws.send(JSON.stringify({ t: "word", w: "zzzzq" }));
  const refused = await waitFor("no");
  ws.close();
  return { board: dealt.board, reason: refused.reason };
}

test("the deployed game serves, deals a board, and refuses a word it cannot spell", async () => {
  const page = await fetch(BASE);
  expect(page.status, `GET ${BASE}`).toBe(200);
  expect(await page.text()).toContain("<title>Good Words</title>");

  // The client asks for the data by version, so ask the same way: a deployment that
  // served the bare path but not the versioned one would leave every browser without
  // a dictionary while this check passed.
  const list = await fetch(`${BASE}/data/words.txt?v=smoke`);
  expect(list.status, "the versioned dictionary URL should serve").toBe(200);
  const trie = new Trie((await list.text()).split("\n").filter(Boolean));

  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { board, reason } = await checkRoom();
      expect(solveBoard(board, trie).size, "the dealt board should be playable").toBeGreaterThan(
        20,
      );
      expect(reason).toBe("not on this board");
      return;
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw last;
}, 180_000);
