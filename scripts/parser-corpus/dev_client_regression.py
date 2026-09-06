"""Client-only regressions using temporary fixtures and mocked HTTP responses."""

import ast
from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
from unittest.mock import patch

sys.dont_write_bytecode = True
SOURCE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("refs_test_dev_client", SOURCE / "dev_client.py")
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)
passed = 0


def check(name, function):
    global passed
    function()
    passed += 1
    print(f"PASS {name}")


def refuses(function):
    try:
        function()
    except RuntimeError:
        return
    raise AssertionError("Expected refusal")


with tempfile.TemporaryDirectory(prefix="refs-client-regression-") as temporary:
    repo = Path(temporary).resolve() / "checkout"
    profile = repo / ".scaffold/custom-profile"
    data = repo / ".scaffold/custom-data"
    profile.mkdir(parents=True)
    data.mkdir(parents=True)
    (repo / ".env").write_text(
        "ZOTERO_PLUGIN_PROFILE_PATH = .scaffold/custom-profile\n"
        "ZOTERO_PLUGIN_DATA_DIR = .scaffold/custom-data\n"
    )
    prefs = profile / "prefs.js"
    prefs.write_text(
        'user_pref("unrelated.synthetic.preference", "do-not-return-this");\n'
        'user_pref("extensions.zotero.httpServer.port", 24111);\n'
    )
    client.REPO = repo
    with patch.dict(os.environ, {}, clear=True):
        def syntax():
            for source in SOURCE.glob("*.py"):
                ast.parse(source.read_text(), filename=str(source))
        check("Python syntax", syntax)

        def automatic():
            assert client.dev_port() == 24111
            assert client.dev_data_dir() == data
        check("automatic profile port and data path from .env", automatic)

        def explicit():
            with patch.dict(os.environ, {"ZPORT": "24222"}), patch.object(Path, "open", side_effect=AssertionError("Profile must not be read")):
                assert client.dev_port() == 24222
        check("explicit ZPORT wins without reading profile", explicit)

        def environment_profile():
            other = repo / ".scaffold/env-profile"
            other.mkdir()
            (other / "prefs.js").write_text('user_pref("extensions.zotero.httpServer.port", 24333);\n')
            with patch.dict(os.environ, {"ZOTERO_PLUGIN_PROFILE_PATH": str(other)}):
                assert client.dev_port() == 24333
        check("environment profile overrides .env", environment_profile)

        def fallback():
            prefs.write_text('user_pref("unrelated.synthetic.preference", 12345);\n')
            assert client.dev_port() == 23126
            prefs.unlink()
            assert client.dev_port() == 23126
            prefs.write_text('user_pref("extensions.zotero.httpServer.port", 24111);\n')
        check("missing port preference or file uses documented 23126", fallback)

        def outside():
            with patch.dict(os.environ, {"ZOTERO_PLUGIN_PROFILE_PATH": str(Path(temporary) / "production-profile")}):
                refuses(client.dev_port)
            with patch.dict(os.environ, {"REFS_DEV_DATA_DIR": str(Path(temporary) / "production-data")}):
                refuses(client.dev_data_dir)
        check("non-development profile and data paths rejected", outside)

        def symlink():
            outside_prefs = Path(temporary) / "outside-prefs.js"
            outside_prefs.write_text('user_pref("extensions.zotero.httpServer.port", 24444);\n')
            prefs.unlink()
            prefs.symlink_to(outside_prefs)
            refuses(client.dev_port)
            prefs.unlink()
            prefs.write_text('user_pref("extensions.zotero.httpServer.port", 24111);\n')
        check("prefs.js symlink outside .scaffold rejected", symlink)

        def invalid():
            for value in ["", "0", "65536", "not-a-port", "24111.5"]:
                with patch.dict(os.environ, {"ZPORT": value}):
                    refuses(client.dev_port)
            prefs.write_text('user_pref("extensions.zotero.httpServer.port", 70000);\n')
            refuses(client.dev_port)
            prefs.write_text('user_pref("extensions.zotero.httpServer.port", 24111);\n')
        check("invalid explicit and profile ports rejected", invalid)

        def request():
            (data / "dev-eval-token.txt").write_text("synthetic-test-token")
            captured = io.StringIO()
            with patch("urllib.request.urlopen") as send, redirect_stdout(captured):
                send.return_value.__enter__.return_value = io.BytesIO(json.dumps({"ok": True, "result": '{"count":3}'}).encode())
                assert client.evaluate("return {count: 3}") == {"count": 3}
                outgoing = send.call_args.args[0]
                assert outgoing.full_url == "http://127.0.0.1:24111/refs-dev/eval"
                payload = json.loads(outgoing.data)
                assert payload["token"] == "synthetic-test-token"
                assert payload["code"].index("addon.data.env") < payload["code"].index("return {count: 3}")
                assert "Zotero.DataDirectory.dir" in payload["code"]
            assert "synthetic-test-token" not in captured.getvalue()
            assert "do-not-return-this" not in captured.getvalue()
        check("random token and remote isolation guard precede work without printing secrets", request)

        def title():
            captured = {}
            module = types.ModuleType("dev_client")
            def evaluate(code, timeout):
                captured["code"] = code
                return {"n": 0, "lines": [], "sample": [], "tail": []}
            module.evaluate = evaluate
            sample = [{"title": 'A "quote" \\ slash\nnew line', "scratch": "/synthetic/test.pdf", "journal": "Synthetic", "crossref_refs": 0}]
            source = (SOURCE / "one_parse.py").read_text()
            with patch.dict(sys.modules, {"dev_client": module}), patch.object(sys, "argv", ["one_parse.py", "0"]), patch("builtins.open", return_value=io.StringIO(json.dumps(sample))), redirect_stdout(io.StringIO()):
                exec(compile(source, "one_parse.py", "exec"), {})
            line = next(line for line in captured["code"].splitlines() if 'setField("title"' in line)
            encoded = line.split('setField("title", ', 1)[1].split("); await", 1)[0]
            assert json.loads(encoded) == "[parser-test] " + sample[0]["title"]
        check("quoted, backslash and multiline titles serialize as JSON", title)

print(f"Client regression: {passed} checks passed (no application or network access).")
