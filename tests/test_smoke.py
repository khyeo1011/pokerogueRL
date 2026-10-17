"""End-to-end smoke test: one bridge process, the Gymnasium env, and the training entry point."""

import subprocess
import sys
from pathlib import Path

import pytest
from gymnasium.utils.env_checker import check_env

from pokerogue_rl.env import PokeRogueEnv

BRIDGE = Path(__file__).parents[1] / "bridge" / "server.ts"
PORT = 7799


@pytest.fixture(scope="module")
def bridge_port():
    proc = subprocess.Popen(["node", str(BRIDGE), "--port", str(PORT)], stdout=subprocess.PIPE, text=True)
    assert "listening" in proc.stdout.readline()
    yield PORT
    proc.terminate()
    proc.wait()


def test_env_api(bridge_port):
    env = PokeRogueEnv(port=bridge_port)
    check_env(env, skip_render_check=True)
    env.close()


def test_train_entrypoint(bridge_port, tmp_path):
    subprocess.run(
        [sys.executable, "-m", "pokerogue_rl.train", "--num-envs", "1", "--base-port", str(bridge_port),
         "--timesteps", "256", "--runs-dir", str(tmp_path)],
        check=True,
    )
    assert list(tmp_path.glob("*/model.zip"))
