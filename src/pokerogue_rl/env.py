"""Gymnasium environment backed by one bridge process (see bridge/server.ts)."""

import json
import socket

import gymnasium as gym
import numpy as np
from gymnasium import spaces

# Must match OBS_DIM in bridge/server.ts. Placeholder sizes until the real
# observation/action encoding is designed.
OBS_DIM = 8
N_ACTIONS = 4


class PokeRogueEnv(gym.Env):
    def __init__(self, host: str = "127.0.0.1", port: int = 7700):
        self.observation_space = spaces.Box(-np.inf, np.inf, (OBS_DIM,), np.float32)
        self.action_space = spaces.Discrete(N_ACTIONS)
        self._sock = socket.create_connection((host, port))
        self._io = self._sock.makefile("rw")

    def _call(self, msg: dict) -> dict:
        self._io.write(json.dumps(msg) + "\n")
        self._io.flush()
        resp = json.loads(self._io.readline())
        if "error" in resp:
            raise RuntimeError(f"bridge error: {resp['error']}")
        return resp

    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)
        resp = self._call({"cmd": "reset", "seed": seed})
        return np.asarray(resp["obs"], np.float32), {}

    def step(self, action):
        resp = self._call({"cmd": "step", "action": int(action)})
        obs = np.asarray(resp["obs"], np.float32)
        return obs, resp["reward"], resp["terminated"], resp["truncated"], {}

    def close(self):
        self._io.close()
        self._sock.close()
