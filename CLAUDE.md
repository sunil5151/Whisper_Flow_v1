# Project Rules & Conventions

## Core Rules (Har Agent Ko Follow Karna Hai)

### 1. Memory Bank पहले पढ़ो
- हर नया काम शुरू करते समय memory folder check करो
- MEMORY.md को देखो कि कौन से files हैं
- सभी relevant memory files पढ़ो
- फिर काम करो

### 2. Agent के लिए Rules
- **Confirmation लो** risky actions के लिए (git push, delete, force operations)
- **Update करो** memory bank बाद में significant changes के बाद
- **Code quality** को priority दो - comments add मत करो (सिर्फ जरूरत हो तो)
- **Security पहले** - OWASP vulnerabilities check करो

### 3. Communication
- **Short और concise** रहो user के साथ
- **Don't narrate** - सिर्फ important updates दो
- **One sentence** per update
- Result दिखाओ, think करने का chronicle मत रखो

### 4. File Changes
- **Prefer Edit** नई files बनाने से
- **Don't add** unnecessary features/comments/abstractions
- **Trust internal code** - सब validation add मत करो
- **Review diff** before committing

### 5. Testing
- **UI changes** के लिए browser में test करो
- **Type checking** करो
- **Golden path + edge cases** दोनों test करो

---

## Project Specifics

**Working Directory:** `C:\Users\sunil\Desktop\sunil_testing_folder\whisper_flow_hackathon`

**Memory Location:** `C:\Users\sunil\Desktop\sunil_testing_folder\whisper_flow_hackathon\memory\`

**Key Patterns:**
- Use PowerShell for commands (git, npm, docker, etc.)
- Use dedicated tools (Read, Edit, Glob, Grep) instead of bash when possible
- Check memory files first हर session में

---

**Last Updated:** 2026-10-19
**Created By:** Claude Haiku 4.5
