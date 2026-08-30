/**
 * Post-deploy check against a running deployment. Verifies the parts that only a
 * real deploy exercises: the websocket upgrade reaching the durable object, the
 * object reading the dictionary out of the assets binding, and a word being scored
 * against the server's own solve.
 *
 *   npm run smoke                       # the live site
 *   SMOKE_URL=https://... npm run smoke # somewhere else
 */
import { expect, test } from "vitest";
import { solveBoard } from "../src/game/solver";
import { Trie } from "../src/game/trie";
import { scoreWord } from "../src/game/scoring";
import { roundAt } from "../src/game/schedule";
import type { ServerMessage } from "../src/net/protocol";

const BASE = process.env.SMOKE_URL ?? "https://goodwords.fun";

test("the deployed game serves, deals a board, and scores a word", async () => {
  const page = await fetch(BASE);
  expect(page.status, `GET ${BASE}`).toBe(200);
  expect(await page.text()).toContain("<title>Good Words</title>");

  const list = await fetch(`${BASE}/data/words.txt`);
  expect(list.status).toBe(200);
  const trie = new Trie((await list.text()).split("\n").filter(Boolean));

  const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/play`);
  const messages: ServerMessage[] = [];
  ws.addEventListener("message", (e) => messages.push(JSON.parse(String(e.data))));
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
      if (Date.now() > deadline) throw new Error(`no "${t}"; saw ${JSON.stringify(messages)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  // The object must have loaded the dictionary from the assets binding to get here.
  const dealt = await waitFor("board");
  expect(dealt.board).toHaveLength(25);
  expect(Math.abs(dealt.now - Date.now())).toBeLessThan(15_000);

  const solution = [...solveBoard(dealt.board, trie)];
  expect(solution.length, "the dealt board should be playable").toBeGreaterThan(20);

  if (roundAt(dealt.now).phase === "playing") {
    ws.send(JSON.stringify({ t: "word", w: solution[0] }));
    const ok = await waitFor("ok");
    expect(ok.points).toBe(scoreWord(solution[0]));
    ws.send(JSON.stringify({ t: "word", w: "zzzzq" }));
    expect((await waitFor("no")).reason).toBe("not on this board");
  }
  ws.close();
}, 60_000);
