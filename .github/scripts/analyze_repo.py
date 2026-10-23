import os
import json
import requests
from datetime import datetime
from pathlib import Path
import subprocess
from cost_tracker import log_cost

GITHUB_TOKEN = os.getenv("GITHUB_TOKEN")
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
GITHUB_REPO = os.getenv("GITHUB_REPOSITORY")

def read_repo_context():
    """Read repo structure and key files"""
    repo_root = Path(".")
    context = "Repository Structure:\n"
    
    for file in ["README.md", "requirements.txt", "package.json", ".gitignore"]:
        path = repo_root / file
        if path.exists():
            with open(path, "r", errors="ignore") as f:
                content = f.read()[:500]
                context += f"\n### {file}:\n{content}\n"
        else:
            context += f"\n### {file}: MISSING\n"
    
    dirs = [d.name for d in repo_root.iterdir() if d.is_dir() and not d.name.startswith(".")]
    context += f"\n### Directories: {', '.join(dirs)}\n"
    
    return context

def analyze_with_glm(repo_context):
    """Use GLM-4 Flash via OpenRouter"""
    
    prompt = f"""Analyze this repository and identify issues/improvements needed:

{repo_context}

Provide a list of specific issues found. Format each as:
- TITLE: <brief title>
  DESCRIPTION: <detailed description>
  
Be specific and actionable."""

    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com",
    }
    
    payload = {
        "model": "glm-4-flash",
        "messages": [
            {"role": "user", "content": prompt}
        ],
        "temperature": 0.7,
        "max_tokens": 1500
    }
    
    try:
        response = requests.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers=headers,
            json=payload,
            timeout=30
        )
        response.raise_for_status()
        
        result = response.json()
        analysis = result["choices"][0]["message"]["content"]
        
        usage = result.get("usage", {})
        input_tokens = usage.get("prompt_tokens", 0)
        output_tokens = usage.get("completion_tokens", 0)
        
        return analysis, input_tokens, output_tokens
    except Exception as e:
        print(f"✗ API Error: {e}")
        return None, 0, 0

def parse_issues(analysis_text):
    """Parse GLM output into issue objects"""
    issues = []
    
    lines = analysis_text.split("\n")
    current_issue = {}
    
    for line in lines:
        if line.startswith("- TITLE:"):
            if current_issue:
                issues.append(current_issue)
            current_issue = {"title": line.replace("- TITLE:", "").strip(), "body": ""}
        elif line.startswith("  DESCRIPTION:"):
            if current_issue:
                current_issue["body"] = line.replace("  DESCRIPTION:", "").strip()
    
    if current_issue:
        issues.append(current_issue)
    
    return [i for i in issues if i.get("title") and i.get("body")]

def create_github_issues(issues):
    """Create GitHub issues"""
    if not issues:
        print("✓ No issues to create")
        return
    
    for issue in issues:
        cmd = [
            "gh", "issue", "create",
            "--title", issue["title"],
            "--body", issue["body"],
            "--repo", GITHUB_REPO
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0:
            print(f"✓ Created: {issue['title']}")
        else:
            print(f"✗ Failed: {issue['title']}")

def write_summary(issues, analysis):
    """Write analysis summary with timestamp"""
    os.makedirs("analysis_reports", exist_ok=True)
    
    timestamp = datetime.now().strftime("%Y-%m-%d_%H%M")
    summary_file = f"analysis_reports/summary_{timestamp}.md"
    
    content = f"""# Repository Analysis Report
**Generated:** {datetime.now().isoformat()}

## Analysis (GLM-4 Flash)
{analysis}

## Issues Found: {len(issues)}

"""
    for issue in issues:
        content += f"### {issue['title']}\n{issue['body']}\n\n"
    
    with open(summary_file, "w") as f:
        f.write(content)
    
    print(f"✓ Summary written: {summary_file}")

if __name__ == "__main__":
    print("🔍 Analyzing repository with GLM-4 Flash...")
    
    context = read_repo_context()
    
    analysis, input_tokens, output_tokens = analyze_with_glm(context)
    if not analysis:
        print("✗ Analysis failed")
        exit(1)
    
    print("✓ Analysis complete")
    
    issues = parse_issues(analysis)
    print(f"Found {len(issues)} issues")
    
    write_summary(issues, analysis)
    create_github_issues(issues)
    
    log_cost(input_tokens, output_tokens, len(issues))
    
    print("✓ Done")
