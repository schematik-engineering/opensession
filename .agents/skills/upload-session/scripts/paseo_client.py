#!/usr/bin/env python3
"""Minimal direct client for exporting a Paseo agent timeline."""

from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import socket
import ssl
import struct
import urllib.parse
import uuid

DEFAULT_PASEO_HOST = "127.0.0.1:6767"
MAX_PASEO_FRAME_BYTES = 70 * 1024 * 1024
PASEO_TIMELINE_PAGE_SIZE = 200
WEBSOCKET_TOKEN = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$")


class PaseoError(RuntimeError):
    pass


class PaseoTimelineReset(RuntimeError):
    pass


def paseo_home() -> Path:
    return Path(os.environ.get("PASEO_HOME", Path.home() / ".paseo")).expanduser()


def paseo_config_host() -> str | None:
    try:
        config = json.loads((paseo_home() / "config.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(config, dict):
        return None
    daemon = config.get("daemon")
    if not isinstance(daemon, dict):
        return None
    listen = daemon.get("listen")
    return listen.strip() if isinstance(listen, str) and listen.strip() else None


def resolve_paseo_endpoint(
    host: str | None,
    password: str | None,
) -> tuple[str, str | None]:
    raw = (
        host
        or os.environ.get("PASEO_HOST")
        or paseo_config_host()
        or DEFAULT_PASEO_HOST
    ).strip()
    if raw.startswith("0.0.0.0:"):
        raw = f"127.0.0.1:{raw.removeprefix('0.0.0.0:')}"
    elif raw.startswith("[::]:"):
        raw = f"[::1]:{raw.removeprefix('[::]:')}"
    if raw.startswith("ssh://") or "#offer=" in raw:
        raise PaseoError(
            "Paseo SSH and relay targets are not supported. Run the skill on the daemon host."
        )
    if raw.startswith("unix:") or raw.startswith("/"):
        raise PaseoError("Paseo Unix sockets are not supported by this helper")

    embedded_password: str | None = None
    if raw.startswith("tcp://"):
        parsed_tcp = urllib.parse.urlparse(raw)
        query = urllib.parse.parse_qs(parsed_tcp.query)
        embedded_password = query.get("password", [None])[0]
        secure = query.get("ssl", [""])[0].lower() in ("1", "true", "yes")
        scheme = "wss" if secure else "ws"
        raw = f"{scheme}://{parsed_tcp.netloc}/ws"
    elif raw.startswith("http://"):
        raw = f"ws://{raw.removeprefix('http://')}"
    elif raw.startswith("https://"):
        raw = f"wss://{raw.removeprefix('https://')}"
    elif not raw.startswith(("ws://", "wss://")):
        raw = f"ws://{raw}"
    raw = raw.replace("://0.0.0.0:", "://127.0.0.1:", 1)
    raw = raw.replace("://[::]:", "://[::1]:", 1)

    parsed = urllib.parse.urlparse(raw)
    if (
        parsed.scheme not in ("ws", "wss")
        or not parsed.hostname
        or parsed.username
        or parsed.password
    ):
        raise PaseoError("Invalid Paseo daemon target")
    query_pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    for key, value in query_pairs:
        if key == "password" and not embedded_password:
            embedded_password = value
    safe_query = urllib.parse.urlencode(
        [(key, value) for key, value in query_pairs if key != "password"]
    )
    path = parsed.path.rstrip("/")
    if not path:
        path = "/ws"
    elif path != "/ws":
        path = f"{path}/ws"
    endpoint = urllib.parse.urlunparse(
        (parsed.scheme, parsed.netloc, path, "", safe_query, "")
    )
    resolved_password = password or embedded_password or os.environ.get("PASEO_PASSWORD")
    return endpoint, resolved_password


class WebSocketConnection:
    def __init__(self, url: str, password: str | None, timeout: float = 120.0):
        self.url = url
        self.password = password
        self.timeout = timeout
        self.socket: socket.socket | None = None
        self.buffer = bytearray()

    def __enter__(self) -> "WebSocketConnection":
        self.connect()
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    def connect(self) -> None:
        parsed = urllib.parse.urlparse(self.url)
        host = parsed.hostname
        if not host:
            raise PaseoError("Paseo WebSocket URL has no hostname")
        port = parsed.port or (443 if parsed.scheme == "wss" else 80)
        try:
            raw_socket = socket.create_connection((host, port), timeout=self.timeout)
            if parsed.scheme == "wss":
                raw_socket = ssl.create_default_context().wrap_socket(
                    raw_socket, server_hostname=host
                )
            raw_socket.settimeout(self.timeout)
            self.socket = raw_socket
            self._handshake(parsed, host, port)
        except PaseoError:
            self.close()
            raise
        except (OSError, ssl.SSLError) as error:
            self.close()
            raise PaseoError(f"Cannot connect to Paseo daemon: {error}") from error

    def _handshake(
        self, parsed: urllib.parse.ParseResult, host: str, port: int
    ) -> None:
        key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
        path = parsed.path or "/ws"
        if parsed.query:
            path += f"?{parsed.query}"
        default_port = 443 if parsed.scheme == "wss" else 80
        host_name = f"[{host}]" if ":" in host else host
        host_header = host_name if port == default_port else f"{host_name}:{port}"
        headers = [
            f"GET {path} HTTP/1.1",
            f"Host: {host_header}",
            "Upgrade: websocket",
            "Connection: Upgrade",
            f"Sec-WebSocket-Key: {key}",
            "Sec-WebSocket-Version: 13",
        ]
        if self.password:
            protocol = f"paseo.bearer.{self.password}"
            if not WEBSOCKET_TOKEN.fullmatch(protocol):
                raise PaseoError(
                    "Paseo password contains characters that cannot be used "
                    "for WebSocket authentication"
                )
            headers.append(f"Sec-WebSocket-Protocol: {protocol}")
        request = ("\r\n".join(headers) + "\r\n\r\n").encode("latin-1")
        self._require_socket().sendall(request)
        response = self._read_http_headers()
        lines = response.decode("latin-1", errors="replace").split("\r\n")
        if not lines or " 101 " not in f" {lines[0]} ":
            detail = lines[0] if lines else "empty response"
            raise PaseoError(f"Paseo rejected the WebSocket connection: {detail}")
        response_headers = {}
        for line in lines[1:]:
            if ":" not in line:
                continue
            name, value = line.split(":", 1)
            response_headers[name.strip().lower()] = value.strip()
        expected = base64.b64encode(
            hashlib.sha1(
                (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")
            ).digest()
        ).decode("ascii")
        if response_headers.get("sec-websocket-accept") != expected:
            raise PaseoError("Paseo returned an invalid WebSocket handshake")

    def _read_http_headers(self) -> bytes:
        while b"\r\n\r\n" not in self.buffer:
            chunk = self._require_socket().recv(4096)
            if not chunk:
                raise PaseoError("Paseo closed the connection during WebSocket setup")
            self.buffer.extend(chunk)
            if len(self.buffer) > 64 * 1024:
                raise PaseoError("Paseo returned oversized WebSocket headers")
        marker = self.buffer.index(b"\r\n\r\n") + 4
        headers = bytes(self.buffer[:marker])
        del self.buffer[:marker]
        return headers

    def _require_socket(self) -> socket.socket:
        if not self.socket:
            raise PaseoError("Paseo WebSocket is not connected")
        return self.socket

    def _recv_exact(self, length: int) -> bytes:
        while len(self.buffer) < length:
            try:
                chunk = self._require_socket().recv(
                    min(64 * 1024, max(4096, length - len(self.buffer)))
                )
            except TimeoutError as error:
                raise PaseoError("Timed out waiting for the Paseo daemon") from error
            except OSError as error:
                raise PaseoError(f"Could not read from the Paseo daemon: {error}") from error
            if not chunk:
                raise PaseoError("Paseo closed the WebSocket connection")
            self.buffer.extend(chunk)
        result = bytes(self.buffer[:length])
        del self.buffer[:length]
        return result

    def send_json(self, value: dict) -> None:
        self._send_frame(0x1, json.dumps(value, separators=(",", ":")).encode("utf-8"))

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        mask = secrets.token_bytes(4)
        length = len(payload)
        if length < 126:
            header = struct.pack("!BB", 0x80 | opcode, 0x80 | length)
        elif length < 65536:
            header = struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, length)
        else:
            header = struct.pack("!BBQ", 0x80 | opcode, 0x80 | 127, length)
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        self._require_socket().sendall(header + mask + masked)

    def receive_json(self) -> dict:
        fragments = bytearray()
        reading_text = False
        while True:
            first, second = self._recv_exact(2)
            final = bool(first & 0x80)
            opcode = first & 0x0F
            masked = bool(second & 0x80)
            length = second & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._recv_exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._recv_exact(8))[0]
            if length > MAX_PASEO_FRAME_BYTES:
                raise PaseoError("Paseo returned a WebSocket frame larger than 70 MiB")
            mask = self._recv_exact(4) if masked else b""
            payload = self._recv_exact(length)
            if mask:
                payload = bytes(
                    byte ^ mask[index % 4] for index, byte in enumerate(payload)
                )

            if opcode == 0x8:
                raise PaseoError("Paseo closed the WebSocket connection")
            if opcode == 0x9:
                self._send_frame(0xA, payload)
                continue
            if opcode == 0xA:
                continue
            if opcode == 0x1:
                fragments = bytearray(payload)
                reading_text = True
            elif opcode == 0x0 and reading_text:
                fragments.extend(payload)
            else:
                continue
            if len(fragments) > MAX_PASEO_FRAME_BYTES:
                raise PaseoError("Paseo returned a message larger than 70 MiB")
            if not final:
                continue
            try:
                value = json.loads(fragments.decode("utf-8"))
            except (UnicodeDecodeError, ValueError) as error:
                raise PaseoError("Paseo returned invalid WebSocket JSON") from error
            if not isinstance(value, dict):
                raise PaseoError("Paseo returned a non-object WebSocket message")
            return value

    def close(self) -> None:
        if not self.socket:
            return
        try:
            self._send_frame(0x8, struct.pack("!H", 1000))
        except (OSError, PaseoError):
            pass
        try:
            self.socket.close()
        finally:
            self.socket = None


class PaseoClient:
    def __init__(self, url: str, password: str | None):
        self.connection = WebSocketConnection(url, password)

    def __enter__(self) -> "PaseoClient":
        self.connection.connect()
        self.connection.send_json(
            {
                "type": "hello",
                "clientId": f"opensession-upload-{uuid.uuid4()}",
                "clientType": "cli",
                "protocolVersion": 1,
                "capabilities": {},
            }
        )
        while True:
            message = self.connection.receive_json()
            session = self._session_message(message)
            if (
                session
                and session.get("type") == "status"
                and isinstance(session.get("payload"), dict)
                and session["payload"].get("status") == "server_info"
            ):
                return self

    def __exit__(self, *_args: object) -> None:
        self.connection.close()

    @staticmethod
    def _session_message(message: dict) -> dict | None:
        session = message.get("message") if message.get("type") == "session" else None
        return session if isinstance(session, dict) else None

    def rpc(self, request: dict, response_type: str) -> dict:
        request_id = str(uuid.uuid4())
        self.connection.send_json(
            {
                "type": "session",
                "message": {**request, "requestId": request_id},
            }
        )
        while True:
            message = self.connection.receive_json()
            session = self._session_message(message)
            if not session:
                continue
            payload = session.get("payload")
            if not isinstance(payload, dict) or payload.get("requestId") != request_id:
                continue
            if session.get("type") == "rpc_error":
                raise PaseoError(str(payload.get("error") or "Paseo request failed"))
            if session.get("type") == response_type:
                return payload

    def fetch_agent(self, agent_reference: str) -> tuple[dict, dict | None]:
        payload = self.rpc(
            {"type": "fetch_agent_request", "agentId": agent_reference},
            "fetch_agent_response",
        )
        if payload.get("error"):
            raise PaseoError(str(payload["error"]))
        agent = payload.get("agent")
        if not isinstance(agent, dict):
            raise PaseoError(f"Paseo agent not found: {agent_reference}")
        project = payload.get("project")
        return agent, project if isinstance(project, dict) else None

    def _timeline_page(
        self,
        agent_id: str,
        direction: str,
        cursor: dict | None = None,
    ) -> dict:
        request = {
            "type": "fetch_agent_timeline_request",
            "agentId": agent_id,
            "direction": direction,
            "limit": PASEO_TIMELINE_PAGE_SIZE,
            "projection": "projected",
        }
        if cursor:
            request["cursor"] = cursor
        payload = self.rpc(request, "fetch_agent_timeline_response")
        if payload.get("error"):
            raise PaseoError(str(payload["error"]))
        return payload

    def fetch_timeline(self, agent_id: str) -> list[dict]:
        for attempt in range(2):
            try:
                return self._fetch_timeline_once(agent_id)
            except PaseoTimelineReset:
                if attempt == 1:
                    raise PaseoError(
                        "Paseo changed the timeline while it was being exported. Try again."
                    )
        raise PaseoError("Paseo timeline export failed")

    def _fetch_timeline_once(self, agent_id: str) -> list[dict]:
        page = self._timeline_page(agent_id, "tail")
        epoch = page.get("epoch")
        if not isinstance(epoch, str) or page.get("reset") is True:
            raise PaseoTimelineReset()
        pages: list[list[dict]] = []
        while True:
            raw_entries = page.get("entries")
            if not isinstance(raw_entries, list) or not all(
                isinstance(entry, dict) for entry in raw_entries
            ):
                raise PaseoError("Paseo returned an invalid timeline page")
            pages.insert(0, raw_entries)
            if page.get("hasOlder") is not True:
                break
            cursor = page.get("startCursor")
            if not isinstance(cursor, dict) or not raw_entries:
                raise PaseoError("Paseo timeline pagination did not advance")
            page = self._timeline_page(agent_id, "before", cursor)
            if (
                page.get("epoch") != epoch
                or page.get("reset") is True
                or page.get("staleCursor") is True
                or page.get("gap") is True
            ):
                raise PaseoTimelineReset()
        return [entry for timeline_page in pages for entry in timeline_page]


def paseo_export(
    client: PaseoClient,
    agent_reference: str,
    include_timeline: bool,
) -> dict:
    agent, project = client.fetch_agent(agent_reference)
    agent_id = agent.get("id")
    provider = agent.get("provider")
    cwd = agent.get("cwd")
    if not isinstance(agent_id, str) or not agent_id:
        raise PaseoError("Paseo returned an agent without an id")
    if not isinstance(provider, str) or not provider:
        raise PaseoError("Paseo returned an agent without a provider")
    if not isinstance(cwd, str) or not cwd:
        raise PaseoError("Paseo returned an agent without a working directory")

    branch = ""
    repository = ""
    checkout = project.get("checkout") if project else None
    if isinstance(checkout, dict):
        current_branch = checkout.get("currentBranch")
        remote_url = checkout.get("remoteUrl")
        branch = current_branch if isinstance(current_branch, str) else ""
        repository = remote_url if isinstance(remote_url, str) else ""

    timeline = client.fetch_timeline(agent_id) if include_timeline else []
    lines = []
    for entry in timeline:
        row_provider = entry.get("provider", provider)
        timestamp = entry.get("timestamp")
        seq_start = entry.get("seqStart")
        seq_end = entry.get("seqEnd")
        item = entry.get("item")
        if (
            not isinstance(row_provider, str)
            or not isinstance(timestamp, str)
            or not isinstance(seq_start, int)
            or not isinstance(seq_end, int)
            or not isinstance(item, dict)
        ):
            raise PaseoError("Paseo returned an invalid timeline entry")
        row = {
            "type": "paseo_timeline",
            "agentId": agent_id,
            "provider": row_provider,
            "timestamp": timestamp,
            "seqStart": seq_start,
            "seqEnd": seq_end,
            "item": item,
        }
        lines.append(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
    if include_timeline and not lines:
        raise PaseoError("Paseo agent has no visible timeline entries")
    title = agent.get("title")
    return {
        "agentId": agent_id,
        "provider": provider,
        "cwd": cwd,
        "title": title if isinstance(title, str) else "",
        "branch": branch,
        "repository": repository,
        "transcript": "\n".join(lines),
        "entries": len(timeline),
    }
