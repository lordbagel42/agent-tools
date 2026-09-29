import http.server
import os
import socket
import subprocess
import threading
import unittest
import uuid
from unittest.mock import patch
import urllib.parse

import callback
from callback import callback_target, success_target


class CallbackTests(unittest.TestCase):
    def test_preserves_encoded_code_and_other_provider_parameters(self):
        self.assertEqual(
            callback_target(
                "http://localhost:1455/auth/callback?code=a%2Bb&state=expected&scope=openid",
                1455,
                "expected",
            ),
            "/auth/callback?code=a%2Bb&state=expected&scope=openid",
        )

    def test_rejects_other_sessions_destinations_and_ambiguous_parameters(self):
        for url in [
            "http://localhost:1455/auth/callback?code=a&state=wrong",
            "http://localhost:1457/auth/callback?code=a&state=expected",
            "http://evil.test:1455/auth/callback?code=a&state=expected",
            "http://localhost:1455@evil.test/auth/callback?code=a&state=expected",
            "https://localhost:1455/auth/callback?code=a&state=expected",
            "http://localhost:1455/cancel?code=a&state=expected",
            "http://localhost:1455/auth/callback?code=a&state=expected&state=wrong",
            "http://localhost:1455/auth/callback?code=a&code=b&state=expected",
            "http://localhost:1455/auth/callback?state=expected",
            "http://localhost:1455/auth/callback?code=a&state=expected#fragment",
            "http://localhost:1455/auth/callback?code=a\n&state=expected",
        ]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                callback_target(url, 1455, "expected")

    def test_only_follows_local_success_not_external_or_cancel_redirects(self):
        for location in ["/success?test=1", "http://localhost:1455/success?test=1"]:
            self.assertEqual(success_target(location, 1455), "/success?test=1")
        for location in ["https://evil.test/success", "//evil.test/success", "/cancel"]:
            with self.subTest(location=location), self.assertRaises(ValueError):
                success_target(location, 1455)


@unittest.skipUnless(os.environ.get("PAINT_BROWSER_TEST") == "1", "optional agent-browser fixture")
class BrowserCallbackTests(unittest.TestCase):
    def test_real_same_origin_form_completes_without_exposing_upstream_token(self):
        hits = []

        class CodexFixture(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                hits.append(self.path)
                if self.path.startswith("/auth/callback?"):
                    self.send_response(302)
                    self.send_header("Location", "/success?id_token=private-fixture-token")
                elif self.path == "/success?id_token=private-fixture-token":
                    self.send_response(200)
                else:
                    self.send_response(404)
                self.end_headers()

        server_class = http.server.HTTPServer
        upstream = server_class(("127.0.0.1", 0), CodexFixture)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        callback_url = (
            f"http://localhost:{upstream.server_port}/auth/callback"
            "?code=fixture%2Bcode&state=fixture-state"
        )
        auth_url = "https://auth.openai.com/oauth/authorize?" + urllib.parse.urlencode({
            "redirect_uri": f"http://localhost:{upstream.server_port}/auth/callback",
            "state": "fixture-state",
        })
        servers = []
        ready = threading.Event()

        def make_server(address, handler):
            server = server_class(address, handler)
            servers.append(server)
            ready.set()
            return server

        session = "paint-fixture-" + uuid.uuid4().hex

        def browser(*args):
            result = subprocess.run(
                ["agent-browser", "--session", session, *args],
                check=True, capture_output=True, text=True, timeout=30,
            )
            return result.stdout

        try:
            with patch.object(callback.http.server, "HTTPServer", side_effect=make_server):
                threading.Thread(target=callback.serve, args=(auth_url, f"http://127.0.0.1:{port}", port), daemon=True).start()
                self.assertTrue(ready.wait(5))
                browser("open", f"http://127.0.0.1:{port}")
                initial_text = browser("get", "text", "body")
                self.assertIn("Connect ChatGPT to paint", initial_text)
                self.assertIn(f"localhost:{upstream.server_port}/auth/callback", initial_text)
                if os.environ.get("PAINT_FIXTURE_SCREENSHOT"):
                    browser("screenshot", os.environ["PAINT_FIXTURE_SCREENSHOT"])
                browser("fill", "#callback", callback_url)
                browser("click", "button[type=submit]")
                browser("wait", "--text", "Signed in")
                text = browser("get", "text", "body")
                self.assertIn("Signed in", text)
                self.assertNotIn("private-fixture-token", text)
                self.assertEqual(hits, [
                    "/auth/callback?code=fixture%2Bcode&state=fixture-state",
                    "/success?id_token=private-fixture-token",
                ])
        finally:
            browser("close")
            for server in [*servers, upstream]:
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    unittest.main()
