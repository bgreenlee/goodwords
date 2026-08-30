import type { Env } from "./room";

export { GameRoom } from "./room";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/play") {
      // One room for everyone: rounds are global, so all players share it.
      const id = env.ROOM.idFromName("global");
      // Without a hint the room is created wherever the first player of its life
      // happens to be, which would strand everyone else behind that latency.
      return env.ROOM.get(id, { locationHint: "enam" }).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
