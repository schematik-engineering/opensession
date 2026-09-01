# Import external agent sessions

The bundled `upload-session` skill moves a Claude Code or Codex conversation into Open Session. It sends the provider's JSONL transcript, the current git branch, and the origin remote to `POST /api/sessions/import`. Open Session stores the normalized transcript in its owned transcript store and returns a direct session URL. Uploading the same provider session again updates the same Open Session session.

## Install the skill

Copy `.agents/skills/upload-session` from this repository into the global skill directory used by the client:

```sh
# Claude Code
mkdir -p ~/.claude/skills
cp -R /path/to/opensession/.agents/skills/upload-session ~/.claude/skills/

# Codex
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

Use `~/.agents/skills` instead of `~/.claude/skills` for Codex.

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

Auto-detection checks the invoking Claude Code process metadata, Claude's project transcripts, `CODEX_THREAD_ID`, and recent Codex rollouts for the current checkout. If that is ambiguous, pass an exact transcript instead:

```sh
python3 ~/.claude/skills/upload-session/scripts/upload_session.py \
  --transcript /exact/session.jsonl \
  --provider claude-code
```

Use `--provider codex` for a Codex rollout. `--dry-run` prints the selected transcript and branch without uploading. `--no-open` returns the link without launching a browser.

The upload includes the full conversation, including tool inputs and results. The endpoint accepts at most 64 MiB per request and requires the same cookie or bearer authentication as other Open Session APIs.
