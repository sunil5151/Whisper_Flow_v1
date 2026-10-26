---
name: agent-rules
description: Core rules that agents must follow every time they run
metadata:
  type: feedback
---

# Agent Rules - Har Bhar Follow Karna Hai

## Rule 1: Memory Bank पहले
**Rule:** हर नया session शुरू करते समय memory folder check करो।

**Why:** Memory files में stored information है जो previous sessions से है। बिना इसे पढ़े काम करना गलत हो सकता है।

**How to Apply:** 
- Session के शुरू में: Memory folder को check करो
- MEMORY.md को पढ़ो
- सभी active memory files को पढ़ो
- फिर user का request देखो

---

## Rule 2: Confirmation Lena
**Rule:** Risky actions (git push, delete, force, destructive operations) के लिए हमेशा confirmation लो।

**Why:** Accidents से data loss या unwanted changes हो सकते हैं।

**How to Apply:**
- `git push` करने से पहले पूछो
- Files delete करने से पहले पूछो
- Force operations के लिए explicit confirmation चाहिए
- Destructive commands के लिए दो बार सोचो

---

## Rule 3: Memory Update करो
**Rule:** Significant changes के बाद memory bank को update करो।

**Why:** अगले session में काम जारी रखने के लिए context चाहिए।

**How to Apply:**
- Major feature add करने के बाद → memory update करो
- नई decisions लेने के बाद → document करो
- Important patterns discover करने के बाद → save करो
- Progress के साथ memory को current रखो

---

## Rule 4: Security First
**Rule:** OWASP vulnerabilities (XSS, SQL injection, command injection) check करो।

**Why:** Security issues production में बहुत costly होते हैं।

**How to Apply:**
- Code review करते समय vulnerabilities देखो
- Secure coding practices follow करो
- User input को validate करो
- External APIs को safely use करो

---

## Rule 5: Concise Communication
**Rule:** User के साथ short, concise communication करो।

**Why:** Long explanations confusing होते हैं और time waste होता है।

**How to Apply:**
- One sentence per update (ज्यादातर)
- Important findings को highlight करो
- Internal thinking expose मत करो
- Results दिखाओ, process नहीं

---

## Rule 6: Code Quality
**Rule:** Comments add मत करो सिर्फ जरूरत हो तो।

**Why:** Clean, well-named code खुद self-documenting होता है।

**How to Apply:**
- Variable names को meaningful बनाओ
- Comments सिर्फ "WHY" के लिए, "WHAT" के लिए नहीं
- Unnecessary comments remove करो
- Code को readable बनाओ

---

**Last Updated:** 2026-10-19
**Created By:** Claude Haiku 4.5
