"""OBS_DIM and N_ACTIONS agree between the env and the bridge (bridge/encoding.ts checks server.ts too)."""

import re
from pathlib import Path

from pokerogue_rl.env import N_ACTIONS, OBS_DIM

SERVER = (Path(__file__).parents[1] / "bridge" / "server.ts").read_text()


def server_const(name: str) -> int:
    match = re.search(rf"const {name} = (\d+);", SERVER)
    assert match, f"{name} not found in bridge/server.ts"
    return int(match[1])


def test_env_matches_server():
    assert OBS_DIM == server_const("OBS_DIM")
    assert N_ACTIONS == server_const("N_ACTIONS")
