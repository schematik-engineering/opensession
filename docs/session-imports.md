# Import external agent sessions

The bundled `upload-session` skill moves a Claude Code, Codex, or Paseo conversation into Open Session. It sends the transcript, git branch, and origin remote to `POST /api/sessions/import`. Open Session stores the normalized transcript in its owned transcript store and returns a direct session URL. Uploading the same provider session again updates the same Open Session session.

The Open Session Mac app is not required. The helper can upload to a hosted Open Session server and open the result in a browser.

## Install the skill

Copy `.agents/skills/upload-session` from this repository into the global skill directory used by the client:

```sh
# Claude Code
mkdir -p ~/.claude/skills
cp -R /path/to/opensession/.agents/skills/upload-session ~/.claude/skills/

# Codex and Paseo
mkdir -p ~/.agents/skills
cp -R /path/to/opensession/.agents/skills/upload-session ~/.agents/skills/
```

Without a source checkout, download a temporary copy from the Open Session repository, then copy the same directory:

```sh
tmp="$(mktemp -d)"
curl -fsSL https://github.com/tellahq/opensession/archive/refs/heads/main.tar.gz \
  | tar -xz -C "$tmp"
mkdir -p ~/.claude/skills
cp -R "$tmp/opensession-main/.agents/skills/upload-session" ~/.claude/skills/
rm -rf "$tmp"
```

Use `~/.agents/skills` instead of `~/.claude/skills` for Codex and Paseo.

## Use it

Start the skill from the conversation to import:

```text
/upload-session
```

The helper defaults to a local Open Session server at `http://127.0.0.1:3850`. For another instance, set its URL once:

```sh
python3 ~/.claude/skills/upload-session/scripts/upload_session.py \
  --server https://sessions.example.com
```

The successful upload remembers that server in `$XDG_CONFIG_HOME/opensession/session-upload.json`, or `~/.config/opensession/session-upload.json` when `XDG_CONFIG_HOME` is unset. `OPENSESSION_URL` overrides it. `OPENSESSION_TOKEN` can supply a bearer token without writing it to the config file.

When the server requires GitHub sign-in and no valid token is available, the helper starts the same device flow used by the native clients. It stores the resulting Open Session bearer token in the private config file with mode `0600`.

## Claude Code and Codex

Auto-detection checks the invoking Claude Code process metadata, Claude's project transcripts, `CODEX_THREAD_ID`, and recent Codex rollouts for the current checkout. If that is ambiguous, pass an exact transcript instead:

```sh
python3 ~/.claude/skills/upload-session/scripts/upload_session.py \
  --transcript /exact/session.jsonl \
  --provider claude-code
```

Use `--provider codex` for a Codex rollout.

## Paseo

Paseo injects `PASEO_AGENT_ID` into every agent it launches. When the skill runs inside that agent, the helper uses this exact id and fetches the full normalized timeline from the local Paseo daemon. It does not guess from the working directory or newest session.

The helper connects to the direct daemon configured by `PASEO_HOST`, `$PASEO_HOME/config.json`, or `127.0.0.1:6767`. Set `PASEO_PASSWORD` if the daemon requires a password. Paseo SSH and relay offer URLs are not supported because the skill should run on the daemon machine.

Import a past session by exact id, unique prefix, or exact title:

```sh
python3 ~/.agents/skills/upload-session/scripts/upload_session.py \
  --provider paseo \
  --paseo-agent-id <id> \
  --server https://sessions.example.com
```

Paseo keeps transcript history in each underlying provider and hydrates it through the daemon when requested. A past import can fail if that provider history has been removed or its provider is unavailable. Paseo also caps individual tool output in its normalized timeline and keeps provider subagent timelines separate.

## Limits

`--dry-run` prints the selected session and branch without uploading. `--no-open` returns the link without launching a browser.

The upload includes the full available conversation, including tool inputs and results. The endpoint accepts at most 64 MiB per request and requires the same cookie or bearer authentication as other Open Session APIs.
