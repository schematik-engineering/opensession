#!/usr/bin/env python3
"""Upload the current Claude Code, Codex, or Paseo conversation to Open Session."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser

from paseo_client import PaseoClient, PaseoError, paseo_export, resolve_paseo_endpoint

DEFAULT_SERVER = "http://127.0.0.1:3850"
MAX_REQUEST_BYTES = 64 * 1024 * 1024
UUID_AT_END = re.compile(
    r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$",
    re.IGNORECASE,
)


class UploadError(RuntimeError):
    pass


def config_path() -> Path:
    root = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return root / "opensession" / "session-upload.json"


def load_config() -> dict:
    try:
        value = json.loads(config_path().read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def save_config(config: dict) -> None:
    path = config_path()
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def normalize_server(value: str) -> str:
    server = value.strip().rstrip("/")
    if not re.match(r"^https?://", server):
        raise UploadError("Open Session URL must start with http:// or https://")
    return server


def git_value(cwd: Path, *args: str) -> str:
    try:
        result = subprocess.run(
            ["git", "-C", str(cwd), *args],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return result.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def git_context(cwd: Path) -> tuple[Path, str, str]:
    root_value = git_value(cwd, "rev-parse", "--show-toplevel")
    root = Path(root_value) if root_value else cwd
    branch = git_value(root, "branch", "--show-current")
    remote = git_value(root, "remote", "get-url", "origin")
    return root, branch, remote


def process_ancestors() -> set[int]:
    ancestors: set[int] = set()
    pid = os.getppid()
    while pid > 1 and pid not in ancestors:
        ancestors.add(pid)
        status = Path(f"/proc/{pid}/status")
        try:
            match = re.search(r"^PPid:\s+(\d+)$", status.read_text(), re.MULTILINE)
            if match:
                pid = int(match.group(1))
                continue
        except OSError:
            pass
        try:
            result = subprocess.run(
                ["ps", "-o", "ppid=", "-p", str(pid)],
                check=True,
                capture_output=True,
                text=True,
                timeout=2,
            )
            pid = int(result.stdout.strip())
        except (OSError, ValueError, subprocess.SubprocessError):
            break
    return ancestors


def claude_project_dir(cwd: Path) -> Path:
    encoded = str(cwd.resolve()).replace("/", "-").lstrip("-")
    return Path.home() / ".claude" / "projects" / f"-{encoded}"


def claude_transcript_for(cwd: Path, session_id: str) -> Path:
    return claude_project_dir(cwd) / f"{session_id}.jsonl"


def live_claude_candidates(cwd: Path) -> tuple[list[Path], list[Path]]:
    directory = Path.home() / ".claude" / "sessions"
    if not directory.is_dir():
        return [], []
    ancestors = process_ancestors()
    exact: list[Path] = []
    same_cwd: list[Path] = []
    for record_path in directory.glob("*.json"):
        try:
            record = json.loads(record_path.read_text(encoding="utf-8"))
            record_cwd = Path(record["cwd"]).resolve()
            session_id = str(record["sessionId"])
            pid = int(record["pid"])
        except (OSError, ValueError, KeyError, TypeError):
            continue
        transcript = claude_transcript_for(record_cwd, session_id)
        if not transcript.is_file():
            continue
        if pid in ancestors:
            exact.append(transcript)
        elif record_cwd == cwd.resolve():
            same_cwd.append(transcript)
    return exact, same_cwd


def recent_claude_candidates(cwds: set[Path]) -> list[Path]:
    candidates: list[Path] = []
    for cwd in cwds:
        directory = claude_project_dir(cwd)
        if not directory.is_dir():
            continue
        candidates.extend(
            path
            for path in directory.glob("*.jsonl")
            if not path.name.startswith("agent-")
        )
    return candidates


def rollout_cwd(path: Path) -> Path | None:
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for _ in range(80):
                line = handle.readline()
                if not line:
                    break
                try:
                    value = json.loads(line)
                except ValueError:
                    continue
                if value.get("type") != "session_meta":
                    continue
                raw = value.get("payload", {}).get("cwd")
                return Path(raw).resolve() if isinstance(raw, str) and raw else None
    except OSError:
        return None
    return None


def codex_candidates(cwds: set[Path], thread_id: str | None = None) -> list[Path]:
    home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
    sessions = home / "sessions"
    if not sessions.is_dir():
        return []
    if thread_id:
        matches = list(sessions.glob(f"*/*/*/rollout-*-{thread_id}.jsonl"))
    else:
        matches: list[Path] = []
        now = dt.datetime.now(dt.timezone.utc)
        for offset in range(-2, 2):
            day = now + dt.timedelta(days=offset)
            directory = sessions / day.strftime("%Y/%m/%d")
            if directory.is_dir():
                matches.extend(directory.glob("rollout-*.jsonl"))
    resolved = {cwd.resolve() for cwd in cwds}
    return [path for path in matches if rollout_cwd(path) in resolved]


def newest(paths: list[Path]) -> Path | None:
    existing = [path for path in paths if path.is_file()]
    return max(existing, key=lambda path: path.stat().st_mtime, default=None)


def infer_provider(path: Path) -> str:
    return "codex" if path.name.startswith("rollout-") else "claude-code"


def detect_transcript(
    cwd: Path,
    provider: str,
    explicit_path: str | None,
) -> tuple[str, Path]:
    if explicit_path:
        path = Path(explicit_path).expanduser().resolve()
        if not path.is_file():
            raise UploadError(f"Transcript does not exist: {path}")
        return (infer_provider(path) if provider == "auto" else provider, path)

    for variable, detected_provider in (
        ("OPENSESSION_TRANSCRIPT_PATH", provider),
        ("CLAUDE_TRANSCRIPT_PATH", "claude-code"),
        ("CODEX_TRANSCRIPT_PATH", "codex"),
    ):
        value = os.environ.get(variable)
        if not value:
            continue
        path = Path(value).expanduser().resolve()
        if path.is_file() and provider in ("auto", detected_provider):
            return (
                infer_provider(path) if detected_provider == "auto" else detected_provider,
                path,
            )

    root, _, _ = git_context(cwd)
    cwds = {cwd.resolve(), root.resolve()}
    claude_id = os.environ.get("CLAUDE_SESSION_ID")
    codex_id = os.environ.get("CODEX_THREAD_ID") or os.environ.get("CODEX_SESSION_ID")

    if provider in ("auto", "claude-code") and claude_id:
        path = newest([claude_transcript_for(candidate, claude_id) for candidate in cwds])
        if path:
            return "claude-code", path
    if provider in ("auto", "codex") and codex_id:
        path = newest(codex_candidates(cwds, codex_id))
        if path:
            return "codex", path

    candidates: list[tuple[str, Path]] = []
    if provider in ("auto", "claude-code"):
        exact_claude, same_cwd_claude = live_claude_candidates(cwd)
        exact_path = newest(exact_claude)
        if exact_path:
            return "claude-code", exact_path
        candidates.extend(("claude-code", path) for path in same_cwd_claude)
        candidates.extend(
            ("claude-code", path) for path in recent_claude_candidates(cwds)
        )
    if provider in ("auto", "codex"):
        candidates.extend(("codex", path) for path in codex_candidates(cwds))
    candidates = [(kind, path) for kind, path in candidates if path.is_file()]
    if not candidates:
        raise UploadError(
            "Could not find the current transcript. Pass --transcript and --provider."
        )
    return max(candidates, key=lambda item: item[1].stat().st_mtime)


def validate_source_session_id(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}", value):
        raise UploadError("Could not derive a valid source session id")
    return value


def source_session_id(provider: str, path: Path, explicit: str | None) -> str:
    if explicit:
        value = explicit
    elif provider == "codex":
        match = UUID_AT_END.search(path.stem)
        value = match.group(1) if match else path.stem
    else:
        value = path.stem
    return validate_source_session_id(value)


def has_transcript_override(args: argparse.Namespace) -> bool:
    if args.transcript:
        return True
    return any(
        os.environ.get(name)
        for name in (
            "OPENSESSION_TRANSCRIPT_PATH",
            "CLAUDE_TRANSCRIPT_PATH",
            "CODEX_TRANSCRIPT_PATH",
        )
    )


def request_json(
    server: str,
    path: str,
    method: str = "GET",
    payload: dict | None = None,
    token: str | None = None,
) -> tuple[int, dict]:
    body = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        if len(body) > MAX_REQUEST_BYTES:
            raise UploadError(
                f"Upload is {len(body) // (1024 * 1024)} MiB; the limit is 64 MiB"
            )
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        f"{server}{path}", data=body, headers=headers, method=method
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            raw = response.read().decode("utf-8", errors="replace")
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        try:
            decoded = json.loads(raw)
        except ValueError:
            decoded = {"error": raw or str(error)}
        return error.code, decoded
    except urllib.error.URLError as error:
        raise UploadError(f"Cannot reach Open Session at {server}: {error.reason}") from error


def device_sign_in(server: str) -> str:
    status, flow = request_json(server, "/api/auth/device", method="POST", payload={})
    if status >= 400 or flow.get("error"):
        raise UploadError(flow.get("error") or "Open Session sign-in failed")
    code = flow.get("userCode")
    verification = flow.get("verificationUri") or "https://github.com/login/device"
    device_code = flow.get("deviceCode")
    if not code or not device_code:
        raise UploadError("Open Session returned an invalid sign-in response")
    print(f"Sign in to Open Session: {verification}")
    print(f"Code: {code}")
    try:
        webbrowser.open(verification)
    except webbrowser.Error:
        pass
    interval = max(int(flow.get("interval") or 5), 1)
    deadline = time.time() + max(int(flow.get("expiresIn") or 900), 30)
    while time.time() < deadline:
        time.sleep(interval)
        poll_status, result = request_json(
            server,
            "/api/auth/device/poll",
            method="POST",
            payload={"deviceCode": device_code, "native": True},
        )
        if poll_status >= 500:
            continue
        if result.get("status") == "ok" and result.get("token"):
            return str(result["token"])
        if result.get("status") == "slow_down":
            interval = max(int(result.get("interval") or interval + 5), interval)
        elif result.get("status") == "error":
            raise UploadError(result.get("error") or "Open Session sign-in failed")
    raise UploadError("Open Session sign-in expired")


def upload(payload: dict, server: str, token: str | None) -> tuple[dict, str | None]:
    status, result = request_json(
        server, "/api/sessions/import", method="POST", payload=payload, token=token
    )
    signed_in_token = None
    if status == 401:
        signed_in_token = device_sign_in(server)
        status, result = request_json(
            server,
            "/api/sessions/import",
            method="POST",
            payload=payload,
            token=signed_in_token,
        )
    if status >= 400:
        raise UploadError(result.get("error") or f"Open Session returned HTTP {status}")
    if not result.get("url"):
        raise UploadError("Open Session returned no session URL")
    return result, signed_in_token


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Upload the current Claude Code, Codex, or Paseo transcript to Open Session"
    )
    parser.add_argument(
        "--provider",
        choices=("auto", "claude", "claude-code", "codex", "paseo"),
        default="auto",
    )
    parser.add_argument("--transcript", help="Exact transcript JSONL path")
    parser.add_argument("--source-session-id", help="Override the source session id")
    parser.add_argument("--paseo-agent-id", help="Exact Paseo agent id, prefix, or title")
    parser.add_argument("--paseo-host", help="Direct Paseo daemon host or WebSocket URL")
    parser.add_argument("--paseo-password", help="Password for the Paseo daemon")
    parser.add_argument("--server", help="Open Session base URL")
    parser.add_argument("--token", help="Open Session bearer token")
    parser.add_argument("--repo", help="Exact registered Open Session repository id")
    parser.add_argument("--title", help="Override the imported session title")
    parser.add_argument("--user", help="Attribution name for a server without sign-in")
    parser.add_argument(
        "--no-open", action="store_true", help="Print the link without opening a browser"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show the selected session and git metadata only",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    provider = "claude-code" if args.provider == "claude" else args.provider
    config = load_config()
    server = normalize_server(
        args.server
        or os.environ.get("OPENSESSION_URL", "")
        or config.get("defaultServer", "")
        or DEFAULT_SERVER
    )
    server_config = config.get("servers", {}).get(server, {})
    token = args.token or os.environ.get("OPENSESSION_TOKEN") or server_config.get("token")
    invocation_cwd = Path.cwd().resolve()
    paseo_agent = args.paseo_agent_id or os.environ.get("PASEO_AGENT_ID")
    use_live_paseo = not has_transcript_override(args) and bool(
        provider == "paseo"
        or args.paseo_agent_id
        or (provider == "auto" and paseo_agent)
    )
    if args.paseo_agent_id and provider not in ("auto", "paseo"):
        raise UploadError("--paseo-agent-id requires --provider paseo or auto")

    if use_live_paseo:
        if not paseo_agent:
            raise UploadError(
                "No current Paseo agent. Pass --paseo-agent-id or run this from a Paseo session."
            )
        if args.source_session_id:
            raise UploadError("A Paseo import always uses the Paseo agent id as its source id")
        endpoint, paseo_password = resolve_paseo_endpoint(
            args.paseo_host, args.paseo_password
        )
        with PaseoClient(endpoint, paseo_password) as client:
            exported = paseo_export(client, paseo_agent, not args.dry_run)
        source_cwd = Path(exported["cwd"]).expanduser()
        _, git_branch, git_remote = git_context(source_cwd)
        branch = exported["branch"] or git_branch
        remote = exported["repository"] or git_remote
        detected_provider = "paseo"
        session_id = validate_source_session_id(exported["agentId"])
        transcript = exported["transcript"]
        title = args.title or exported["title"][:240]
        print(f"Paseo agent: {session_id}")
        print(f"Paseo provider: {exported['provider']}")
    else:
        detected_provider, transcript_path = detect_transcript(
            invocation_cwd, provider, args.transcript
        )
        session_id = source_session_id(
            detected_provider, transcript_path, args.source_session_id
        )
        _, branch, remote = git_context(invocation_cwd)
        title = args.title
        print(f"Transcript: {transcript_path}")
        try:
            transcript = transcript_path.read_text(encoding="utf-8", errors="replace")
        except OSError as error:
            raise UploadError(f"Could not read transcript: {error}") from error

    print(f"Provider: {detected_provider}")
    print(f"Branch: {branch or '(none)'}")
    if args.dry_run:
        return 0

    payload = {
        "provider": detected_provider,
        "sourceSessionId": session_id,
        "transcript": transcript,
        "branch": branch,
        "repository": remote,
        **({"repo": args.repo} if args.repo else {}),
        **({"title": title} if title else {}),
        **({"user": args.user} if args.user else {}),
    }
    result, signed_in_token = upload(payload, server, token)

    config["defaultServer"] = server
    servers = config.setdefault("servers", {})
    stored = servers.setdefault(server, {})
    if signed_in_token:
        stored["token"] = signed_in_token
    save_config(config)

    url = str(result["url"])
    print(f"Uploaded {result.get('entries', 0)} transcript entries.")
    if remote and not result.get("repo"):
        print("The git remote did not match a repository registered in Open Session.")
    print(f"Open Session: {url}")
    if not args.no_open:
        try:
            webbrowser.open(url)
        except webbrowser.Error:
            pass
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (UploadError, PaseoError) as error:
        print(f"upload-session: {error}", file=sys.stderr)
        raise SystemExit(1)
