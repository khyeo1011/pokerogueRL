// Headless PokéRogue bridge: one game instance per process, served over TCP.
//
// Protocol: newline-delimited JSON, one request -> one response.
//   {"cmd": "reset", "seed": int|null}  -> {"obs": number[]}
//   {"cmd": "step", "action": int}      -> {"obs": number[], "reward": number, "terminated": bool, "truncated": bool}
//
// STUB: episodes are dummy data (action 0 earns reward) so the Python pipeline
// can be exercised end to end. Replace with a real game driven through
// the pokerogue/ submodule's headless test harness.

import { createServer } from "node:net";
import { parseArgs } from "node:util";

// Must match OBS_DIM / N_ACTIONS in bridge/encoding.ts and src/pokerogue_rl/env.py.
const OBS_DIM = 2102;
const N_ACTIONS = 272;
const EPISODE_LEN = 20;

const { values } = parseArgs({ options: { port: { type: "string", default: "7700" } } });
const port = Number(values.port);

function observe(t: number): number[] {
  const obs = new Array(OBS_DIM).fill(0);
  obs[0] = t / EPISODE_LEN;
  return obs;
}

const server = createServer(socket => {
  let t = 0;
  let buffer = "";

  const handle = (msg: { cmd: string; action?: number }) => {
    switch (msg.cmd) {
      case "reset":
        t = 0;
        return { obs: observe(t) };
      case "step":
        if (!(Number.isInteger(msg.action) && msg.action! >= 0 && msg.action! < N_ACTIONS)) {
          return { error: `action out of range: ${msg.action}` };
        }
        t += 1;
        return { obs: observe(t), reward: msg.action === 0 ? 1 : 0, terminated: false, truncated: t >= EPISODE_LEN };
      default:
        return { error: `unknown cmd: ${msg.cmd}` };
    }
  };

  socket.setEncoding("utf8");
  socket.on("data", chunk => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      socket.write(`${JSON.stringify(handle(JSON.parse(line)))}\n`);
    }
  });
});

server.listen(port, "127.0.0.1", () => console.log(`bridge listening on 127.0.0.1:${port}`));
