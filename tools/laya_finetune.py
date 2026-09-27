"""Fine-tune Laya's scorer on simulated search leads (CPU, minutes).

Laya scores every answer option with a small `scorer` MLP on top of a frozen 421M encoder.
Retraining only that scorer on the simulator's ground truth teaches Laya this one task:
which of the four actions fits a lead, and whether it is a person. Urgency has no ground
truth, so it is held to Laya's original answers (distillation) and does not drift.

  uv run python -m tools.laya_finetune            # writes models/laya_sar_scorer.pt and results/finetune.json

Result (docs/GATES.md): it trades human load against missed people along the same curve as
stock Laya, because low-score people in the open read exactly like debris. Not shipped.
"""
import argparse
import asyncio
import json
from copy import deepcopy
from datetime import UTC, datetime

import numpy as np
import torch

from batch.metrics import ece
from server.config import ROOT, settings
from server.mission.loop import MissionRun
from server.mission.truth import optimal_action
from server.triage.fallback import ACTIONS
from server.triage.laya_runtime import QUESTIONS, load, render

OUTPUT = ROOT / "models/laya_sar_scorer.pt"  # gitignored: an experiment, not a shipped model
TRAIN_SEEDS, TEST_SEEDS = range(1000, 1060), range(100, 112)  # test seeds match tools/laya_check.py


async def collect(seeds, cfg):
    """Every state a decision was made on, labelled from the simulator's truth at that moment."""
    rows, original = [], MissionRun._build_state

    def record(run, lead):
        state = original(run, lead)
        rows.append({"text": render(state), "action": ACTIONS.index(optimal_action(lead, cfg)),
                     "person": int(bool(lead["truth"]["is_person"])), "seed": run.seed})
        return state

    MissionRun._build_state = record
    try:
        for seed in seeds:
            run = MissionRun(seed, cfg, policy="rule", parse_mode="oracle", sim_human=True, fast=True)
            try:
                await run.start()
            finally:
                await run.stop()
    finally:
        MissionRun._build_state = original
    unique = {(row["text"], row["action"], row["person"]): row for row in rows}
    return list(unique.values())


def embed(runtime, rows):
    """The scorer's inputs for each question, plus Laya's original urgency answer to distill toward."""
    captured = {}
    hook = runtime.agent.model.scorer.register_forward_hook(lambda module, args, out: captured.update(m=args[0].detach().float()))
    try:
        for index, row in enumerate(rows):
            answer = runtime.agent.system_one(row["text"], QUESTIONS)["answers"]
            m = captured["m"]  # [question, marker, d] in QUESTIONS order: action, urgency, is_person
            row.update(action_m=m[0, :4].clone(), urgency_m=m[1, :4].clone(), person_m=m[2, :2].clone(),
                       urgency_p=torch.tensor([answer["urgency"]["probabilities"][str(i)] for i in range(4)]))
            if index % 200 == 0:
                print(f"  embedded {index}/{len(rows)}", flush=True)
    finally:
        hook.remove()
    return rows


def stack(rows, key):
    return torch.stack([row[key] for row in rows])


def predict(scorer, rows, temperature):
    with torch.no_grad():
        action = torch.softmax(scorer(stack(rows, "action_m")).squeeze(-1) / temperature["action"], -1)
        person = torch.softmax(scorer(stack(rows, "person_m")).squeeze(-1) / temperature["person"], -1)[:, 1]
    return action, person


def report(name, rows, action, person, tau):
    labels = torch.tensor([row["action"] for row in rows])
    people = torch.tensor([row["person"] for row in rows])
    top, choice = action.max(-1)
    auto = top >= tau
    row = {"action_accuracy": round(float((choice == labels).float().mean()), 3),
           "routed_share": round(float((~auto).float().mean()), 3),
           "auto_accuracy": round(float((choice[auto] == labels[auto]).float().mean()), 3) if auto.any() else None,
           "p_person_ece": round(ece(person.tolist(), people.tolist()), 3),
           "people_called_ignore": int(((choice == 3) & (people == 1)).sum()), "people": int(people.sum())}
    print(f"{name:10s} action acc {row['action_accuracy']} · routed {row['routed_share']} · auto acc {row['auto_accuracy']} · "
          f"P(person) ECE {row['p_person_ece']} · people called ignore {row['people_called_ignore']}/{row['people']}")
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--epochs", type=int, default=60)
    parser.add_argument("--ignore-weight", type=float, default=1.0, help="<1 penalises calling a person 'ignore' more")
    args = parser.parse_args()
    torch.manual_seed(0)
    cfg = settings.model_copy(update={"PARSE_MODE": "oracle"})
    runtime = load(cfg.model_copy(update={"LAYA_SCORER": ""}))  # always start from stock Laya
    print("collecting simulated decisions…", flush=True)
    train = embed(runtime, asyncio.run(collect(TRAIN_SEEDS, cfg)))
    test = embed(runtime, asyncio.run(collect(TEST_SEEDS, cfg)))
    print(f"{len(train)} train / {len(test)} test states")

    # Train at the temperatures Laya decodes with, so served probabilities match training.
    temps = runtime.agent.temperature_by_options
    temperature = {"action": temps.get("choice:3-5", 1.0), "urgency": temps.get("score:3-5", 1.0), "person": temps.get("noul:2", 1.0)}
    original = runtime.agent.model.scorer
    scorer = deepcopy(original).float().train()
    before = report("before", test, *predict(original.float(), test, temperature), cfg.TAU_ROUTE)

    action_y = torch.tensor([row["action"] for row in train])
    person_y = torch.tensor([row["person"] for row in train])
    action_m, urgency_m, person_m, urgency_p = (stack(train, key) for key in ("action_m", "urgency_m", "person_m", "urgency_p"))
    optimizer = torch.optim.AdamW(scorer.parameters(), lr=1e-3, weight_decay=0.05)  # 3e-4 barely moved the scorer
    for epoch in range(args.epochs):
        for batch in torch.randperm(len(train)).split(64):
            action = scorer(action_m[batch]).squeeze(-1) / temperature["action"]
            person = scorer(person_m[batch]).squeeze(-1) / temperature["person"]
            urgency = torch.log_softmax(scorer(urgency_m[batch]).squeeze(-1) / temperature["urgency"], -1)
            loss = (torch.nn.functional.cross_entropy(action, action_y[batch], weight=torch.tensor([1, 1, 1, args.ignore_weight]))
                    + torch.nn.functional.cross_entropy(person, person_y[batch])
                    + torch.nn.functional.kl_div(urgency, urgency_p[batch], reduction="batchmean"))
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
        if epoch % 20 == 19:
            scorer.eval()
            report(f"epoch {epoch + 1}", test, *predict(scorer, test, temperature), cfg.TAU_ROUTE)
            scorer.train()
    scorer.eval()
    after = report("after", test, *predict(scorer, test, temperature), cfg.TAU_ROUTE)
    (cfg.RESULTS_DIR / "finetune.json").write_text(json.dumps({
        "generated_at": datetime.now(UTC).isoformat(), "epochs": args.epochs, "tau_route": cfg.TAU_ROUTE,
        "train": {"states": len(train), "seeds": [TRAIN_SEEDS.start, TRAIN_SEEDS.stop - 1]},
        "test": {"states": len(test), "seeds": [TEST_SEEDS.start, TEST_SEEDS.stop - 1]},
        "stock": before, "fine_tuned": after}, indent=2) + "\n")
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"scorer": scorer.state_dict(), "train_seeds": list(TRAIN_SEEDS), "revision": settings.LAYA_REVISION}, OUTPUT)
    print(f"Saved {OUTPUT}")


if __name__ == "__main__":
    main()
