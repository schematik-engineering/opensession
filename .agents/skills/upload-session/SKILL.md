---
name: upload-session
description: Upload the current Claude Code or Codex conversation and git branch to Open Session, then open the imported session. Use when the user says "open this in Open Session", "upload this session", or asks to move an external agent chat into Open Session.
disable-model-invocation: true
---

# Upload session

Run the bundled helper from the directory that contains this `SKILL.md`:

```sh
python3 <skill-dir>/scripts/upload_session.py
```

The helper finds the current Claude Code or Codex JSONL transcript, reads the current git branch and origin, uploads them through `POST /api/sessions/import`, and opens the returned session URL. It uploads the provider log as-is. Do not replace it with a summary or reconstruct the conversation from model context.

Use these options only when auto-detection or local defaults do not fit:

```sh
python3 <skill-dir>/scripts/upload_session.py \
  --transcript /exact/path/to/transcript.jsonl \
  --provider claude-code \
  --server https://sessions.example.com
```

- `OPENSESSION_URL` sets the server. The default is `http://127.0.0.1:3850`.
- `OPENSESSION_TOKEN` supplies an existing bearer token. If the server requires sign-in and no valid token exists, the helper starts GitHub device sign-in and stores the resulting token in the user's private config directory.
- `--repo <id>` names a registered Open Session repo when the git remote cannot be matched.
- `--no-open` prints the URL without launching a browser.
- `--dry-run` shows which transcript and branch would be sent.

If discovery fails, inspect the current tool's own session metadata. Pass its exact transcript path and provider rather than picking another recent transcript. Never upload a different session just because it is the newest file.

The upload contains the full chat log, including tool inputs and results. Run it only after an explicit request such as this skill invocation. On success, return the Open Session URL to the user even if the browser opened.
