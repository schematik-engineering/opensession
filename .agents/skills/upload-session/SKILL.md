---
name: upload-session
description: Upload the current Claude Code, Codex, or Paseo conversation and git branch to Open Session, then open the imported session. Use when the user says "open this in Open Session", "upload this session", or asks to move an external agent chat into Open Session.
disable-model-invocation: true
---

# Upload session

Run the bundled helper from the directory that contains this `SKILL.md`:

```sh
python3 <skill-dir>/scripts/upload_session.py
```

The helper identifies the current Claude Code, Codex, or Paseo session, reads its git branch and origin, uploads it through `POST /api/sessions/import`, and opens the returned session URL. Claude Code and Codex uploads use the provider log. Paseo uploads use the daemon's normalized timeline. Do not replace either source with a summary or reconstruct the conversation from model context.

Use these options only when automatic detection or local defaults do not fit:

```sh
python3 <skill-dir>/scripts/upload_session.py \
  --transcript /exact/path/to/transcript.jsonl \
  --provider claude-code \
  --server https://sessions.example.com
```

- `OPENSESSION_URL` sets the server. The default is `http://127.0.0.1:3850`.
- `OPENSESSION_TOKEN` supplies an existing bearer token. If the server requires sign-in and no valid token exists, the helper starts GitHub device sign-in and stores the resulting token in the user's private config directory.
- `--paseo-agent-id <id>` imports a past Paseo agent. For a current Paseo session, the helper uses `PASEO_AGENT_ID` and never guesses by directory or modification time.
- `--paseo-host <host>` selects a direct Paseo daemon. The default comes from `PASEO_HOST`, `$PASEO_HOME/config.json`, or `127.0.0.1:6767`.
- `PASEO_PASSWORD` or `--paseo-password` authenticates to a password-protected Paseo daemon.
- `--repo <id>` names a registered Open Session repo when the git remote cannot be matched.
- `--no-open` prints the URL without launching a browser.
- `--dry-run` shows which session and branch would be sent.

Paseo SSH and relay links are not supported. Run the skill inside the Paseo agent so it connects to the daemon on that machine. To import a past local Paseo session, pass its exact id, unique prefix, or title:

```sh
python3 <skill-dir>/scripts/upload_session.py \
  --provider paseo \
  --paseo-agent-id <id>
```

If Claude Code or Codex discovery fails, inspect the current tool's own session metadata. Pass its exact transcript path and provider rather than picking another recent transcript. Never upload a different session because it is the newest file.

The upload contains the full visible chat timeline, including tool inputs and results. Paseo may cap individual tool output in its normalized history. Run this skill only after an explicit request. On success, return the Open Session URL to the user even if the browser opened.
