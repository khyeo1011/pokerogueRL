"""PPO training over N parallel envs, one per bridge port (BASE_PORT .. BASE_PORT+N-1)."""

import argparse
from datetime import datetime
from pathlib import Path

from stable_baselines3 import PPO
from stable_baselines3.common.vec_env import SubprocVecEnv, VecMonitor

from pokerogue_rl.env import PokeRogueEnv


def make_env(port: int):
    return lambda: PokeRogueEnv(port=port)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--num-envs", type=int, default=4)
    parser.add_argument("--base-port", type=int, default=7700)
    parser.add_argument("--timesteps", type=int, default=100_000)
    parser.add_argument("--runs-dir", type=Path, default=Path("runs"))
    args = parser.parse_args()

    run_dir = args.runs_dir / datetime.now().strftime("%Y%m%d-%H%M%S")
    run_dir.mkdir(parents=True)

    env = VecMonitor(SubprocVecEnv([make_env(args.base_port + i) for i in range(args.num_envs)]))
    model = PPO("MlpPolicy", env, verbose=1)
    model.learn(total_timesteps=args.timesteps)
    model.save(run_dir / "model")
    env.close()
    print(f"saved {run_dir / 'model.zip'}")


if __name__ == "__main__":
    main()
