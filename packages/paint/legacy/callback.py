"""Optional legacy single-login bridge; prefer a loopback callback tunnel.

Only expose through an authenticated HTTPS portal. Never log callback URLs.
"""

import argparse
import html
import http.client
import http.server
import os
from pathlib import Path
import re
import secrets
import time
import urllib.parse


def callback_target(value, port, expected_state):
    if any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError("Invalid callback")
    url = urllib.parse.urlsplit(value.strip())
    params = urllib.parse.parse_qs(url.query, keep_blank_values=True)
    if (
        url.scheme != "http"
        or url.netloc != f"localhost:{port}"
        or url.path != "/auth/callback"
        or url.fragment
        or params.get("state") != [expected_state]
        or len(params.get("code", [])) != 1
        or not params["code"][0]
    ):
        raise ValueError("Invalid callback")
    return url.path + "?" + url.query


def success_target(value, port):
    if any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError("Unexpected redirect")
    url = urllib.parse.urlsplit(value)
    if (
        url.scheme not in ("", "http")
        or url.netloc not in ("", f"localhost:{port}")
        or url.path != "/success"
        or url.fragment
    ):
        raise ValueError("Unexpected redirect")
    return url.path + ("?" + url.query if url.query else "")


def serve(auth_url, origin, port):
    auth = urllib.parse.urlsplit(auth_url)
    if auth.scheme != "https" or auth.netloc != "auth.openai.com":
        raise ValueError("Invalid authorization URL")
    params = urllib.parse.parse_qs(urllib.parse.urlsplit(auth_url).query)
    if len(params.get("redirect_uri", [])) != 1 or len(params.get("state", [])) != 1 or not params["state"][0]:
        raise ValueError("Invalid authorization parameters")
    redirect = urllib.parse.urlsplit(params["redirect_uri"][0])
    callback_port = redirect.port
    if redirect.scheme != "http" or redirect.netloc != f"localhost:{callback_port}" or redirect.path != "/auth/callback" or redirect.query or redirect.fragment or not callback_port:
        raise ValueError("Invalid callback listener")
    expected_state = params["state"][0]
    csrf = secrets.token_urlsafe(32)
    deadline = time.monotonic() + 1800
    completed = False

    class Handler(http.server.BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, *args):
            pass

        def respond(self, status, body):
            page = (
                '<!doctype html><html lang="en"><meta charset="utf-8">'
                '<meta name="viewport" content="width=device-width, initial-scale=1">'
                '<title>Paint sign-in</title><style>'
                'body{font:17px/1.6 system-ui;max-width:640px;margin:48px auto;'
                'padding:0 24px;color:#172033;background:#f6f7fa}'
                'h1{line-height:1.2}textarea{box-sizing:border-box;width:100%;'
                'min-height:130px;padding:12px;font:14px monospace}'
                'button{font:inherit;padding:10px 20px;margin-top:16px;cursor:pointer}'
                'a{color:#164bb0}small{display:block;color:#536076}'
                '</style><main>' + body + '</main></html>'
            ).encode()
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(page)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "same-origin")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header(
                "Content-Security-Policy",
                "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; "
                "base-uri 'none'; frame-ancestors 'none'",
            )
            self.end_headers()
            self.wfile.write(page)

        def do_GET(self):
            if self.path != "/":
                return self.respond(404, "<h1>Not found</h1>")
            if completed:
                return self.respond(200, "<h1>Signed in</h1><p>You can close this page and return to Amp.</p>")
            if time.monotonic() > deadline:
                return self.respond(410, "<h1>Sign-in expired</h1><p>Return to Amp for a fresh attempt.</p>")
            self.respond(
                200,
                '<h1>Connect ChatGPT to paint</h1>'
                '<p>This connects the Codex login attempt you started on this machine.</p>'
                f'<p><strong>1.</strong> <a href="{html.escape(auth_url, quote=True)}" '
                'target="_blank" rel="noopener noreferrer">Sign in with OpenAI</a>.</p>'
                '<p><strong>2.</strong> After sign-in, your browser will try to open '
                f'<code>localhost:{callback_port}/auth/callback</code> and show a connection error. '
                'That is expected. Copy the complete URL from the address bar.</p>'
                '<form method="post" action="/complete" autocomplete="off">'
                f'<input type="hidden" name="csrf" value="{csrf}">'
                '<label for="callback"><strong>3.</strong> Paste that callback URL here:</label>'
                '<textarea id="callback" name="callback" required maxlength="12000" '
                'autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>'
                '<button type="submit">Finish sign-in</button></form>'
                '<small>The callback is forwarded only to this login’s local Codex listener. '
                'It is not written to logs or sent to the Amp conversation. '
                'Credentials stay in the Codex home selected for that login.</small>',
            )

        def do_POST(self):
            nonlocal completed
            if self.path != "/complete":
                return self.respond(404, "<h1>Not found</h1>")
            if completed or time.monotonic() > deadline:
                return self.respond(410, "<h1>This sign-in is no longer active</h1>")
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 16000:
                    raise ValueError()
                if self.headers.get("Origin") != origin:
                    raise ValueError()
                if self.headers.get_content_type() != "application/x-www-form-urlencoded":
                    raise ValueError()
                fields = urllib.parse.parse_qs(self.rfile.read(length).decode(), max_num_fields=4)
                if fields.get("csrf") != [csrf] or len(fields.get("callback", [])) != 1:
                    raise ValueError()
                target = callback_target(fields["callback"][0], callback_port, expected_state)
            except (ValueError, UnicodeError):
                return self.respond(400, '<h1>Callback not accepted</h1><p>Use the complete URL from this sign-in attempt. <a href="/">Try again</a>.</p>')
            conn = http.client.HTTPConnection("127.0.0.1", callback_port, timeout=45)
            try:
                conn.request("GET", target)
                response = conn.getresponse()
                if response.status != 302:
                    raise ValueError()
                target = success_target(response.getheader("Location", ""), callback_port)
                response.read(65536)
                conn.close()
                conn = http.client.HTTPConnection("127.0.0.1", callback_port, timeout=15)
                conn.request("GET", target)
                response = conn.getresponse()
                if response.status != 200:
                    raise ValueError()
                response.read(65536)
                completed = True
            except (OSError, ValueError, http.client.HTTPException):
                return self.respond(502, '<h1>Sign-in could not finish</h1><p>Return to Amp to check the login status. No callback details have been logged.</p>')
            finally:
                conn.close()
            self.respond(200, "<h1>Signed in</h1><p>You can close this page and return to Amp.</p>")

    http.server.HTTPServer(("127.0.0.1", port), Handler).serve_forever()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--auth-url-file", default=os.environ.get("PAINT_AUTH_URL_FILE"), help="Private file containing the authorization URL for the current login")
    parser.add_argument("--public-url", default=os.environ.get("PUBLIC_URL"), help="Authenticated HTTPS portal origin (required)")
    parser.add_argument("--port", type=int, default=os.environ.get("PORT", "8765"))
    args = parser.parse_args(argv)
    origin = urllib.parse.urlsplit(args.public_url or "")
    if not args.auth_url_file or origin.scheme != "https" or not origin.netloc or origin.username or origin.password or origin.path not in ("", "/") or origin.query or origin.fragment or not 1 <= args.port <= 65535:
        parser.error("Provide a private authorization URL file, authenticated HTTPS origin, and valid local port")
    try:
        source = Path(args.auth_url_file)
        if source.stat().st_size > 65536:
            raise ValueError()
        urls = re.findall(r"https://auth\.openai\.com/\S+", source.read_text())
        if len(urls) != 1:
            raise ValueError()
        serve(urls[0], args.public_url.rstrip("/"), args.port)
    except (ValueError, OSError):
        parser.exit(1, "Callback helper failed; check private configuration locally.\n")


if __name__ == "__main__":
    main()
