"""The batch launcher (pokerogue_rl.games) with a fake batch runner: chunking, a stuck run
that gets its process killed and the rest of its chunk replayed, and the summary."""

import json
import subprocess
import sys

from pokerogue_rl import games

# Writes one record per seed; hangs (without writing) on the seed ending in "-3".
FAKE_RUNNER = """
import json, sys, time
prefix, start, count, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
for n in range(start, start + count):
    if n == 3:
        time.sleep(60)
    record = {
        "seed": f"{prefix}-{n}", "outcome": "truncated" if n == 5 else "terminated",
        "reason": "waveTurnCap" if n == 5 else None, "wave": n, "turns": 10 * n,
        "maxWaveTurns": n, "decisions": 20, "maxPhasesPerNext": 30,
        "mysteryEncounters": ["SAFARI_ZONE@12"] if n == 1 else [], "bootMs": 100,
        "wallMs": 500, "stall": None,
    }
    if n == 5:
        record["stall"] = {"seed": record["seed"], "reason": "waveTurnCap", "wave": 5,
                           "phase": "TurnEndPhase", "detail": "300 turns in wave 5"}
    with open(out, "a") as f:
        f.write(json.dumps(record) + "\\n")
"""


def fake_launch(prefix, start, count, level, policy, out, log):
    cmd = [sys.executable, "-c", FAKE_RUNNER, prefix, str(start), str(count), str(out)]
    return subprocess.Popen(cmd)


def test_chunks():
    assert games.chunks(250, 100) == [(0, 100), (100, 100), (200, 50)]
    assert games.chunks(3, 100) == [(0, 3)]


def test_stuck_run_is_lost_and_the_chunk_goes_on(tmp_path, monkeypatch):
    monkeypatch.setattr(games, "launch", fake_launch)
    games.main(
        ["7", "2", "--chunk", "4", "--stall-seconds", "2", "--out", str(tmp_path)]
    )

    records = [
        json.loads(line) for line in (tmp_path / "runs.jsonl").read_text().splitlines()
    ]
    assert [r["seed"] for r in records] == [f"batch-{n}" for n in range(7)]
    assert records[3] == {
        "seed": "batch-3",
        "outcome": "lost",
        "reason": "process killed after 2 s",
    }

    summary = json.loads((tmp_path / "summary.json").read_text())
    assert summary["runs"] == 7
    assert summary["outcomes"] == {"terminated": 5, "lost": 1, "truncated": 1}
    assert summary["truncationReasons"] == {"waveTurnCap": 1}
    assert summary["truncated"][0]["phase"] == "TurnEndPhase"
    assert summary["wave"] == {"min": 0, "median": 3.0, "mean": 3.0, "max": 6}
    assert summary["mysteryEncounterTypes"] == {"SAFARI_ZONE": 1}
    assert summary["chunks"] == 2


def test_throughput():
    records = [
        {"bootMs": 100, "wallMs": 900, "turns": 20, "decisions": 50, "startedAt": 0},
        {
            "bootMs": 100,
            "wallMs": 1900,
            "turns": 40,
            "decisions": 100,
            "startedAt": 1010,
        },
    ]
    assert games.throughput(records) == {
        "gamesPerHour": 2400,
        "turnsPerSecond": 20.0,
        "decisionsPerSecond": 50.0,
        "playTurnsPerSecond": 21.4,
        "playDecisionsPerSecond": 53.6,
    }
    assert games.throughput([]) == {}
    # A lost run (no startedAt) breaks the sequence.
    assert games.between_runs(records) == [10]
    assert games.between_runs([records[0], {"outcome": "lost"}, records[1]]) == []
