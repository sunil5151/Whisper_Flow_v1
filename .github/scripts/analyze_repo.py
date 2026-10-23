import os
import json
import subprocess
from datetime import datetime
from pathlib import Path

import requests

from cost_tracker import log_cost, MODEL

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
GITHUB_REPO = os.getenv("GITHUB_REPOSITORY")
API_URL = "https://openrouter.ai/api/v1/chat/completions"
MAX_ISSUES_PER_RUN = 5
LABEL = "auto-analysis"


def read_repo_context():
    """Read repo structure and key files"""
    repo_root = Path(".")
    context = "Repository Structure:\n"

    for file in ["README.md", "requirements.txt", "package.json", ".gitignore"]:
        path = repo_root / file
        if path.exists():
            with open(path, "r", errors="ignore") as f:
                context += f"\n### {file}:\n{f.read()[:2000]}\n"
        else:
            context += f"\n### {file}: MISSING\n"

    dirs = [d.name for d in repo_root.iterdir() if d.is_dir() and not d.name.startswith(".")]
    context += f"\n### Directories: {', '.join(dirs) or 'none'}\n"
    return context


def previous_issue_titles():
    """All issues this bot ever reported (open + closed). Fed to the model so it never repeats them."""
    cmd = ["gh", "issue", "list", "--repo", GITHUB_REPO, "--state", "all",
           "--label", LABEL, "--limit", "500", "--json", "title"]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(f"⚠ Could not list previous issues: {r.stderr.strip()}")
        return []
    return [i["title"].strip() for i in json.loads(r.stdout or "[]")]


def ensure_label():
    subprocess.run(["gh", "label", "create", LABEL, "--repo", GITHUB_REPO,
                    "--color", "5319e7", "--description", "Auto-generated repo analysis",
                    "--force"], capture_output=True, text=True)


def analyze(repo_context, previous_titles):
    """Call GLM via OpenRouter. Returns (text, in_tokens, out_tokens, cost)."""
    if previous_titles:
        history = "\n".join(f"- {t}" for t in previous_titles[:200])
        history_block = f"""
ALREADY REPORTED ISSUES (open or closed). Do NOT report these again, not even reworded
or as the same problem with a different title. Report ONLY genuinely new problems:
{history}
"""
    else:
        history_block = ""

    prompt = f"""Analyze this repository and identify issues/improvements needed:

{repo_context}
{history_block}
If there are no NEW issues, reply exactly: NO_NEW_ISSUES

Otherwise list at most {MAX_ISSUES_PER_RUN} specific, actionable NEW issues. Use EXACTLY this format, nothing else:
- TITLE: <brief title>
  DESCRIPTION: <description on one or more lines>
"""

    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": f"https://github.com/{GITHUB_REPO or ''}",
        "X-Title": "Repo Analyzer",
    }
    payload = {
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.3,
        "max_tokens": 1500,
        "usage": {"include": True},
    }

    try:
        response = requests.post(API_URL, headers=headers, json=payload, timeout=60)
    except requests.RequestException as e:
        print(f"✗ Network error: {e}")
        return None, 0, 0, None

    if not response.ok:
        print(f"✗ API Error {response.status_code}: {response.text}")
        return None, 0, 0, None

    result = response.json()
    try:
        analysis = result["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        print(f"✗ Unexpected response: {json.dumps(result)[:1000]}")
        return None, 0, 0, None

    usage = result.get("usage", {})
    return (
        analysis,
        usage.get("prompt_tokens", 0),
        usage.get("completion_tokens", 0),
        usage.get("cost"),  # actual USD cost from OpenRouter, if returned
    )


def parse_issues(text):
    """Parse '- TITLE: / DESCRIPTION:' blocks; supports multi-line descriptions."""
    issues, current, in_desc = [], None, False

    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("- TITLE:") or line.startswith("TITLE:"):
            if current:
                issues.append(current)
            current = {"title": line.split("TITLE:", 1)[1].strip().strip("*"), "body": ""}
            in_desc = False
        elif line.startswith("DESCRIPTION:") and current:
            current["body"] = line.split("DESCRIPTION:", 1)[1].strip()
            in_desc = True
        elif in_desc and current and line:
            current["body"] += "\n" + line

    if current:
        issues.append(current)

    return [i for i in issues if i["title"] and i["body"]][:MAX_ISSUES_PER_RUN]


def _norm(title):
    return " ".join("".join(c for c in title.lower() if c.isalnum() or c == " ").split())


def create_github_issues(issues, previous_titles):
    if not issues:
        print("✓ No new issues to create")
        return 0

    seen = {_norm(t) for t in previous_titles}  # safety net if model still repeats
    created = 0
    for issue in issues:
        key = _norm(issue["title"])
        if key in seen:
            print(f"↷ Skipped previously reported: {issue['title']}")
            continue
        seen.add(key)
        body = issue["body"] + f"\n\n---\n_Auto-generated by {MODEL}_"
        cmd = ["gh", "issue", "create", "--repo", GITHUB_REPO,
               "--title", issue["title"], "--body", body, "--label", LABEL]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode == 0:
            created += 1
            print(f"✓ Created: {issue['title']}")
        else:
            print(f"✗ Failed: {issue['title']} → {r.stderr.strip()}")
    return created


def write_summary(issues, analysis):
    os.makedirs("analysis_reports", exist_ok=True)
    now = datetime.now()
    path = f"analysis_reports/summary_{now.strftime('%Y-%m-%d_%H%M')}.md"

    content = f"# Repository Analysis Report\n**Generated:** {now.isoformat()}\n\n"
    content += f"## Analysis ({MODEL})\n{analysis}\n\n## Issues Found: {len(issues)}\n\n"
    for i in issues:
        content += f"### {i['title']}\n{i['body']}\n\n"

    with open(path, "w") as f:
        f.write(content)
    print(f"✓ Summary written: {path}")


if __name__ == "__main__":
    if not OPENROUTER_API_KEY:
        print("✗ OPENROUTER_API_KEY not set")
        raise SystemExit(1)
    if not GITHUB_REPO:
        print("✗ GITHUB_REPOSITORY not set")
        raise SystemExit(1)

    ensure_label()
    previous = previous_issue_titles()
    print(f"📚 {len(previous)} previously reported issues sent to model as history")

    print(f"🔍 Analyzing repository with {MODEL}...")
    analysis, in_tok, out_tok, cost = analyze(read_repo_context(), previous)
    if not analysis:
        print("✗ Analysis failed")
        raise SystemExit(1)

    issues = [] if "NO_NEW_ISSUES" in analysis else parse_issues(analysis)
    print(f"✓ Analysis complete. Parsed {len(issues)} new issues")

    write_summary(issues, analysis)
    created = create_github_issues(issues, previous)
    log_cost(in_tok, out_tok, created, actual_cost=cost)
    print("✓ Done")
