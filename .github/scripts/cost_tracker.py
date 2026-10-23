import json
import os
from datetime import datetime

COST_LOG_FILE = "cost_log.json"
OPENROUTER_PRICING = {
    "glm-4-flash": 0.001  # $0.001 per 1K tokens
}

def estimate_cost(input_tokens, output_tokens, model="glm-4-flash"):
    """Estimate cost for API call"""
    rate = OPENROUTER_PRICING.get(model, 0.001)
    total_tokens = input_tokens + output_tokens
    cost = (total_tokens / 1000) * rate
    return cost

def log_cost(input_tokens, output_tokens, issues_count):
    """Log API call cost"""
    if not os.path.exists(COST_LOG_FILE):
        log_data = {"total_cost": 0, "calls": []}
    else:
        with open(COST_LOG_FILE, "r") as f:
            log_data = json.load(f)
    
    cost = estimate_cost(input_tokens, output_tokens)
    
    call_entry = {
        "timestamp": datetime.now().isoformat(),
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": input_tokens + output_tokens,
        "estimated_cost": round(cost, 6),
        "issues_found": issues_count,
        "model": "glm-4-flash"
    }
    
    log_data["calls"].append(call_entry)
    log_data["total_cost"] = round(log_data["total_cost"] + cost, 6)
    log_data["total_calls"] = len(log_data["calls"])
    
    with open(COST_LOG_FILE, "w") as f:
        json.dump(log_data, f, indent=2)
    
    print(f"💰 Cost logged: ${cost:.6f} | Total: ${log_data['total_cost']:.6f}")
