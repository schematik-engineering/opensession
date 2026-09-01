#!/usr/bin/env python3

from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
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
        body = json.dumps(
            {
                "id": "os-imported",
                "url": f"http://127.0.0.1:{self.server.server_port}/session/os-imported",
                "entries": 2,
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


class UploadSessionTests(unittest.TestCase):
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
            self.assertEqual(UploadHandler.payload["branch"], "import-test")
            self.assertIn(
                UploadHandler.payload["repository"],
                (
                    "git@github.com:tellahq/demo.git",
                    "https://github.com/tellahq/demo.git",
                ),
            )
            self.assertEqual(UploadHandler.payload["provider"], "claude-code")


if __name__ == "__main__":
    unittest.main()
