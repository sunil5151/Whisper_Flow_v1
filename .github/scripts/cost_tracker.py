import json
import os
from datetime import datetime

COST_LOG_FILE = "cost_log.json"
MODEL = "z-ai/glm-5.3-flash"

# USD per 1M tokens. Fallback only — used if OpenRouter does not return usage.cost.
# VERIFY on https://openrouter.ai/z-ai/glm-5.3-flash (output price was cut off in screenshot).
PRICE_PER_M = {
    MODEL: {"input": 0.0052, "output": 0.19},
}


def estimate_cost(input_tokens, output_tokens, model=MODEL):
    p = PRICE_PER_M.get(model, {"input": 0.0, "output": 0.0})
    return (input_tokens * p["input"] + output_tokens * p["output"]) / 1_000_000


def log_cost(input_tokens, output_tokens, issues_count, actual_cost=None, model=MODEL):
    if os.path.exists(COST_LOG_FILE):
        try:
            with open(COST_LOG_FILE, "r") as f:
                log_data = json.load(f)
        except (json.JSONDecodeError, OSError):
            log_data = {"total_cost": 0, "calls": []}
    else:
        log_data = {"total_cost": 0, "calls": []}

    if actual_cost is not None:
        cost, source = float(actual_cost), "openrouter"
    else:
        cost, source = estimate_cost(input_tokens, output_tokens, model), "estimate"

    log_data["calls"].append({
        "timestamp": datetime.now().isoformat(),
        "model": model,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": input_tokens + output_tokens,
        "cost_usd": round(cost, 8),
        "cost_source": source,
        "issues_created": issues_count,
    })
    log_data["total_cost"] = round(log_data.get("total_cost", 0) + cost, 8)
    log_data["total_calls"] = len(log_data["calls"])

    with open(COST_LOG_FILE, "w") as f:
        json.dump(log_data, f, indent=2)

    print(f"💰 Cost ({source}): ${cost:.8f} | Total: ${log_data['total_cost']:.8f}")
