#!/usr/bin/env python3

from __future__ import annotations

import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socketserver
import struct
import subprocess
import tempfile
import threading
import unittest

MODULE_PATH = Path(__file__).with_name("upload_session.py")
SPEC = importlib.util.spec_from_file_location("upload_session", MODULE_PATH)
assert SPEC and SPEC.loader
upload_session = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(upload_session)


class UploadHandler(BaseHTTPRequestHandler):
    payload: dict | None = None

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        type(self).payload = json.loads(self.rfile.read(length))
        transcript = type(self).payload.get("transcript", "")
        entries = len([line for line in transcript.splitlines() if line.strip()])
        body = json.dumps(
            {
                "id": "os-imported",
                "url": f"http://127.0.0.1:{self.server.server_port}/session/os-imported",
                "entries": entries,
                "branch": type(self).payload.get("branch"),
                "repo": "demo",
            }
        ).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args: object) -> None:
        return


def read_exact(stream, length: int) -> bytes:
    value = stream.read(length)
    if len(value) != length:
        raise ConnectionError("short WebSocket frame")
    return value


def read_client_frame(stream) -> dict:
    first, second = read_exact(stream, 2)
    opcode = first & 0x0F
    length = second & 0x7F
    if length == 126:
        length = struct.unpack("!H", read_exact(stream, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", read_exact(stream, 8))[0]
    mask = read_exact(stream, 4) if second & 0x80 else b""
    payload = read_exact(stream, length)
    if mask:
        payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    if opcode == 0x8:
        return {"type": "close"}
    return json.loads(payload.decode("utf-8"))


def websocket_frame(value: dict) -> bytes:
    payload = json.dumps(value, separators=(",", ":")).encode("utf-8")
    if len(payload) < 126:
        header = struct.pack("!BB", 0x81, len(payload))
    elif len(payload) < 65536:
        header = struct.pack("!BBH", 0x81, 126, len(payload))
    else:
        header = struct.pack("!BBQ", 0x81, 127, len(payload))
    return header + payload


def session_message(message_type: str, payload: dict) -> bytes:
    return websocket_frame(
        {"type": "session", "message": {"type": message_type, "payload": payload}}
    )


class PaseoHandler(socketserver.StreamRequestHandler):
    requests: list[dict] = []
    protocols: list[str] = []

    def handle(self) -> None:
        request_line = self.rfile.readline().decode("latin-1").strip()
        headers: dict[str, str] = {}
        while True:
            line = self.rfile.readline().decode("latin-1")
            if line in ("\r\n", "\n", ""):
                break
            name, value = line.split(":", 1)
            headers[name.lower()] = value.strip()
        key = headers["sec-websocket-key"]
        accept = base64.b64encode(
            hashlib.sha1(
                (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()
            ).digest()
        ).decode()
        protocol = headers.get("sec-websocket-protocol", "")
        type(self).protocols.append(protocol)
        response_headers = [
            "HTTP/1.1 101 Switching Protocols",
            "Upgrade: websocket",
            "Connection: Upgrade",
            f"Sec-WebSocket-Accept: {accept}",
        ]
        if protocol:
            response_headers.append(f"Sec-WebSocket-Protocol: {protocol}")
        self.wfile.write(("\r\n".join(response_headers) + "\r\n\r\n").encode())
        self.wfile.flush()
        if request_line != "GET /ws HTTP/1.1":
            return

        hello = read_client_frame(self.rfile)
        type(self).requests.append(hello)
        self.wfile.write(
            session_message(
                "status", {"status": "server_info", "serverId": "srv-test"}
            )
        )
        self.wfile.flush()

        while True:
            request = read_client_frame(self.rfile)
            if request.get("type") == "close":
                return
            type(self).requests.append(request)
            message = request["message"]
            request_id = message["requestId"]
            if message["type"] == "fetch_agent_request":
                payload = {
                    "requestId": request_id,
                    "agent": {
                        "id": "paseo-agent-123",
                        "provider": "opencode",
                        "cwd": "/tmp/paseo-project",
                        "title": "Paseo import test",
                    },
                    "project": {
                        "checkout": {
                            "currentBranch": "paseo/import",
                            "remoteUrl": "git@github.com:tellahq/paseo-demo.git",
                        }
                    },
                    "error": None,
                }
                response = session_message("fetch_agent_response", payload)
            elif message["type"] == "fetch_agent_timeline_request":
                before = message.get("direction") == "before"
                entries = (
                    [
                        self.timeline_entry(
                            1, {"type": "user_message", "text": "Start in Paseo"}
                        )
                    ]
                    if before
                    else [
                        self.timeline_entry(
                            2,
                            {
                                "type": "tool_call",
                                "callId": "call-1",
                                "name": "Bash",
                                "status": "completed",
                                "error": None,
                                "detail": {
                                    "type": "shell",
                                    "command": "git status",
                                    "output": "clean",
                                    "exitCode": 0,
                                },
                            },
                        ),
                        self.timeline_entry(
                            3, {"type": "assistant_message", "text": "Finished"}
                        ),
                    ]
                )
                payload = {
                    "requestId": request_id,
                    "agentId": "paseo-agent-123",
                    "direction": "before" if before else "tail",
                    "projection": "projected",
                    "epoch": "epoch-1",
                    "reset": False,
                    "staleCursor": False,
                    "gap": False,
                    "startCursor": {"epoch": "epoch-1", "seq": entries[0]["seqStart"]},
                    "endCursor": {"epoch": "epoch-1", "seq": entries[-1]["seqEnd"]},
                    "hasOlder": not before,
                    "hasNewer": False,
                    "entries": entries,
                    "error": None,
                }
                response = session_message("fetch_agent_timeline_response", payload)
            else:
                return
            self.wfile.write(response)
            self.wfile.flush()

    @staticmethod
    def timeline_entry(sequence: int, item: dict) -> dict:
        return {
            "provider": "opencode",
            "timestamp": f"2026-09-02T08:00:0{sequence}.000Z",
            "seqStart": sequence,
            "seqEnd": sequence,
            "sourceSeqRanges": [{"startSeq": sequence, "endSeq": sequence}],
            "collapsed": [],
            "item": item,
        }


class PaseoServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True


class UploadSessionTests(unittest.TestCase):
    def setUp(self) -> None:
        UploadHandler.payload = None
        PaseoHandler.requests = []
        PaseoHandler.protocols = []

    def test_provider_and_source_id_from_paths(self) -> None:
        claude = Path("/tmp/0d5ff956-8d21-4dd6-9894-bf21a414099b.jsonl")
        codex = Path(
            "/tmp/rollout-2026-08-20T10-00-00-0198c4d9-5613-7ad0-bca0-abca7bcb9f6b.jsonl"
        )
        self.assertEqual(upload_session.infer_provider(claude), "claude-code")
        self.assertEqual(upload_session.infer_provider(codex), "codex")
        self.assertEqual(
            upload_session.source_session_id("codex", codex, None),
            "0198c4d9-5613-7ad0-bca0-abca7bcb9f6b",
        )

    def test_paseo_endpoint_normalizes_direct_hosts_and_passwords(self) -> None:
        self.assertEqual(
            upload_session.resolve_paseo_endpoint(
                "tcp://0.0.0.0:6767?ssl=true&password=secret", None
            ),
            ("wss://127.0.0.1:6767/ws", "secret"),
        )
        self.assertEqual(
            upload_session.resolve_paseo_endpoint(
                "ws://localhost:6767/ws?password=hidden&client=test", None
            ),
            ("ws://localhost:6767/ws?client=test", "hidden"),
        )

    def test_explicit_transcript_uploads_git_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            transcript = root / "0d5ff956-8d21-4dd6-9894-bf21a414099b.jsonl"
            transcript.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "type": "user",
                                "uuid": "u1",
                                "timestamp": "2026-08-20T10:00:00.000Z",
                                "message": {"role": "user", "content": "Upload me"},
                            }
                        ),
                        json.dumps(
                            {
                                "type": "assistant",
                                "uuid": "a1",
                                "timestamp": "2026-08-20T10:00:01.000Z",
                                "message": {"role": "assistant", "content": "Done"},
                            }
                        ),
                    ]
                ),
                encoding="utf-8",
            )
            subprocess.run(["git", "init", "-q", "-b", "import-test"], cwd=root, check=True)
            subprocess.run(
                ["git", "remote", "add", "origin", "git@github.com:tellahq/demo.git"],
                cwd=root,
                check=True,
            )
            server = ThreadingHTTPServer(("127.0.0.1", 0), UploadHandler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                env = {
                    **os.environ,
                    "XDG_CONFIG_HOME": str(root / "config"),
                }
                result = subprocess.run(
                    [
                        "python3",
                        str(MODULE_PATH),
                        "--transcript",
                        str(transcript),
                        "--provider",
                        "claude-code",
                        "--server",
                        f"http://127.0.0.1:{server.server_port}",
                        "--no-open",
                    ],
                    cwd=root,
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=15,
                )
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("Open Session:", result.stdout)
            assert UploadHandler.payload
            self.assertEqual(UploadHandler.payload["branch"], "import-test")
            self.assertIn(
                UploadHandler.payload["repository"],
                (
                    "git@github.com:tellahq/demo.git",
                    "https://github.com/tellahq/demo.git",
                ),
            )
            self.assertEqual(UploadHandler.payload["provider"], "claude-code")

    def test_current_paseo_agent_exports_paginated_timeline(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            paseo_server = PaseoServer(("127.0.0.1", 0), PaseoHandler)
            paseo_thread = threading.Thread(
                target=paseo_server.serve_forever, daemon=True
            )
            paseo_thread.start()
            upload_server = ThreadingHTTPServer(("127.0.0.1", 0), UploadHandler)
            upload_thread = threading.Thread(
                target=upload_server.serve_forever, daemon=True
            )
            upload_thread.start()
            try:
                env = {
                    **os.environ,
                    "PASEO_AGENT_ID": "paseo-agent-123",
                    "XDG_CONFIG_HOME": str(root / "config"),
                }
                result = subprocess.run(
                    [
                        "python3",
                        str(MODULE_PATH),
                        "--paseo-host",
                        f"ws://127.0.0.1:{paseo_server.server_address[1]}/ws",
                        "--paseo-password",
                        "test-secret",
                        "--server",
                        f"http://127.0.0.1:{upload_server.server_port}",
                        "--no-open",
                    ],
                    cwd=root,
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=15,
                )
            finally:
                paseo_server.shutdown()
                paseo_server.server_close()
                paseo_thread.join(timeout=2)
                upload_server.shutdown()
                upload_server.server_close()
                upload_thread.join(timeout=2)

            self.assertEqual(result.returncode, 0, result.stderr)
            assert UploadHandler.payload
            payload = UploadHandler.payload
            self.assertEqual(payload["provider"], "paseo")
            self.assertEqual(payload["sourceSessionId"], "paseo-agent-123")
            self.assertEqual(payload["title"], "Paseo import test")
            self.assertEqual(payload["branch"], "paseo/import")
            self.assertEqual(
                payload["repository"], "git@github.com:tellahq/paseo-demo.git"
            )
            rows = [json.loads(line) for line in payload["transcript"].splitlines()]
            self.assertEqual([row["seqStart"] for row in rows], [1, 2, 3])
            self.assertTrue(all(row["agentId"] == "paseo-agent-123" for row in rows))
            self.assertEqual(PaseoHandler.protocols, ["paseo.bearer.test-secret"])
            request_types = [
                request.get("message", {}).get("type") for request in PaseoHandler.requests
            ]
            self.assertEqual(
                request_types,
                [
                    None,
                    "fetch_agent_request",
                    "fetch_agent_timeline_request",
                    "fetch_agent_timeline_request",
                ],
            )


if __name__ == "__main__":
    unittest.main()
