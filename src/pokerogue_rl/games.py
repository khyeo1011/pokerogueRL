"""Play many runs of the real game in parallel processes and summarize them (issue #9).

The seeds `<prefix>-<start> ..` are cut into chunks, and up to `processes` batch runner
processes (bridge/batch/games.batch.ts) play one chunk each at a time, writing one JSON
line per run. A fresh process per chunk bounds what a process can leak from run to run.
A process that writes no line for `--stall-seconds` is killed (the driver's watchdogs
can't interrupt code that never returns), its current run is recorded as lost, and the
rest of its chunk goes on in a new process. The lines are merged into `runs.jsonl`, and
a summary is printed and saved as `summary.json`, in the output directory.

Usage: scripts/run_games.sh <runs> [processes] [--prefix P] [--start N] [--out DIR]
"""

import argparse
import json
import os
import statistics
import subprocess
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def chunks(runs: int, size: int) -> list[tuple[int, int]]:
    """(offset, count) of each chunk of at most `size` runs."""
    return [(o, min(size, runs - o)) for o in range(0, runs, size)]


def count_lines(path: Path) -> int:
    return len(path.read_text().splitlines()) if path.exists() else 0


def launch(prefix: str, start: int, count: int, out: Path, log: Path):
    """Start a batch runner process for seeds `prefix-start ..`."""
    env = os.environ | {
        "BATCH_PREFIX": prefix,
        "BATCH_START": str(start),
        "BATCH_COUNT": str(count),
        "BATCH_OUT": str(out),
        "COREPACK_ENABLE_DOWNLOAD_PROMPT": "0",
    }
    config = ROOT / "bridge/batch/vitest.config.ts"
    cmd = ["corepack", "pnpm", "exec", "vitest", "run", "--configLoader", "native"]
    cmd += ["--config", str(config), "--silent"]
    with log.open("w") as f:
        return subprocess.Popen(
            cmd, cwd=ROOT / "pokerogue", env=env, stdout=f, stderr=subprocess.STDOUT
        )


def play_chunk(
    out: Path, prefix: str, start: int, count: int, k: int, stall_s: float
) -> list[int]:
    """Play one chunk to the end, restarting past stuck runs. Returns exit codes."""
    path = out / f"chunk-{k}.jsonl"
    codes = []
    while (done := count_lines(path)) < count:
        log = out / f"chunk-{k}-{len(codes)}.log"
        proc = launch(prefix, start + done, count - done, path, log)
        seen, last, killed = done, time.monotonic(), False
        while proc.poll() is None:
            time.sleep(1)
            if (n := count_lines(path)) != seen:
                seen, last = n, time.monotonic()
            elif time.monotonic() - last > stall_s:
                proc.kill()
                proc.wait()
                killed = True
        codes.append(proc.returncode)
        if (n := count_lines(path)) >= count:
            break
        # The process stopped before the chunk's end: lose the run it was playing.
        why = f"process killed after {stall_s:.0f} s" if killed else f"exit {codes[-1]}"
        lost = [{"seed": f"{prefix}-{start + n}", "outcome": "lost", "reason": why}]
        if not killed and n == done:
            # It played nothing (a broken setup): don't retry the rest one by one.
            lost += [
                {**lost[0], "seed": f"{prefix}-{start + i}"}
                for i in range(n + 1, count)
            ]
        with path.open("a") as f:
            f.writelines(json.dumps(r) + "\n" for r in lost)
    return codes


def spread(values: list[float]) -> dict:
    """min, median, mean and max of `values` (empty if none)."""
    if not values:
        return {}
    return {
        "min": min(values),
        "median": statistics.median(values),
        "mean": round(statistics.fmean(values), 1),
        "max": max(values),
    }


def summarize(records: list[dict]) -> dict:
    """Aggregate run records (the batch runner's JSON lines)."""
    played = [r for r in records if r["outcome"] != "lost"]
    truncated = [r for r in records if r["outcome"] == "truncated"]
    encounters = Counter(
        m.split("@")[0] for r in played for m in r["mysteryEncounters"]
    )
    return {
        "runs": len(records),
        "outcomes": dict(Counter(r["outcome"] for r in records)),
        "truncationReasons": dict(Counter(r["reason"] for r in truncated)),
        "truncated": [
            {k: r["stall"][k] for k in ("seed", "reason", "wave", "phase", "detail")}
            for r in truncated
        ],
        "errors": [
            {"seed": r["seed"], "outcome": r["outcome"], "reason": r["reason"]}
            for r in records
            if r["outcome"] in ("error", "lost")
        ],
        "wave": spread([r["wave"] for r in played]),
        "turns": spread([r["turns"] for r in played]),
        "maxWaveTurns": max((r["maxWaveTurns"] for r in played), default=0),
        "maxPhasesPerNext": max((r["maxPhasesPerNext"] for r in played), default=0),
        "decisions": spread([r["decisions"] for r in played]),
        "wallMs": spread([r["wallMs"] for r in played]),
        "bootMs": spread([r["bootMs"] for r in played]),
        "mysteryEncounters": sum(encounters.values()),
        "mysteryEncounterTypes": dict(encounters.most_common()),
    }


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("runs", type=int)
    parser.add_argument("processes", type=int, nargs="?", default=1)
    parser.add_argument("--prefix", default="batch", help="seeds are <prefix>-<n>")
    parser.add_argument("--start", type=int, default=0, help="first n")
    parser.add_argument("--chunk", type=int, default=100, help="max runs per process")
    parser.add_argument("--stall-seconds", type=float, default=420)
    parser.add_argument("--out", type=Path, help="default runs/games-<timestamp>")
    args = parser.parse_args(argv)

    out = args.out or ROOT / "runs" / datetime.now().strftime("games-%Y%m%d-%H%M%S")
    out = out.resolve()  # the runners' working directory is pokerogue/
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.monotonic()
    # Chunks small enough to keep every process busy.
    work = chunks(args.runs, min(args.chunk, -(-args.runs // args.processes)))
    with ThreadPoolExecutor(args.processes) as pool:
        futures = [
            pool.submit(
                play_chunk, out, args.prefix, args.start + o, n, k, args.stall_seconds
            )
            for k, (o, n) in enumerate(work)
        ]
        codes = [c for f in futures for c in f.result()]
    elapsed = time.monotonic() - t0

    lines = [
        line
        for k in range(len(work))
        for line in (out / f"chunk-{k}.jsonl").read_text().splitlines()
    ]
    (out / "runs.jsonl").write_text("".join(f"{line}\n" for line in lines))
    summary = summarize([json.loads(line) for line in lines])
    summary |= {
        "processes": args.processes,
        "chunks": len(work),
        "exitCodes": dict(Counter(codes)),
        "elapsedS": round(elapsed, 1),
        "runsPerMinute": round(len(lines) / elapsed * 60, 1),
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))
    print(f"runs: {out / 'runs.jsonl'}")


if __name__ == "__main__":
    main()
