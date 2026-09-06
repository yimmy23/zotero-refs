"""Authenticated, isolated-development-only access to the local eval endpoint."""

import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.request


REPO = Path(__file__).resolve().parents[2]
DEFAULT_DEV_PORT = 23126


def configured_path(name):
    configured = os.environ.get(name)
    if not configured:
        env_file = REPO / ".env"
        if env_file.is_file():
            for line in env_file.read_text().splitlines():
                key, separator, value = line.partition("=")
                if separator and key.strip() == name:
                    configured = value.strip().strip("\"'")
                    break
    return configured


def isolated_path(configured, default, kind):
    path = Path(configured).expanduser() if configured else REPO / default
    if not path.is_absolute():
        path = REPO / path
    path = path.resolve()
    if not path.is_relative_to((REPO / ".scaffold").resolve()):
        raise RuntimeError(f"Parser tests require {kind} inside this checkout's .scaffold")
    return path


def dev_data_dir():
    configured = os.environ.get("REFS_DEV_DATA_DIR") or configured_path(
        "ZOTERO_PLUGIN_DATA_DIR"
    )
    return isolated_path(configured, ".scaffold/dev-data", "a data directory")


def checked_port(value):
    try:
        port = int(str(value).strip())
    except (TypeError, ValueError):
        raise RuntimeError("The development connector port must be an integer between 1 and 65535") from None
    if not 1 <= port <= 65535:
        raise RuntimeError("The development connector port must be an integer between 1 and 65535")
    return port


def dev_port():
    if "ZPORT" in os.environ:
        return checked_port(os.environ["ZPORT"])
    profile = isolated_path(
        configured_path("ZOTERO_PLUGIN_PROFILE_PATH"),
        ".scaffold/dev-profile",
        "a profile directory",
    )
    prefs = isolated_path(str(profile / "prefs.js"), "", "the profile preferences file")
    # Read only this known preference; never evaluate prefs.js or collect
    # unrelated profile settings. The last assignment wins, as in Gecko.
    pattern = re.compile(
        r'''^\s*user_pref\(\s*["']extensions\.zotero\.httpServer\.port["']\s*,\s*(.*?)\s*\)\s*;\s*$'''
    )
    value = None
    if prefs.is_file():
        with prefs.open(encoding="utf-8") as source:
            for line in source:
                match = pattern.fullmatch(line)
                if match:
                    value = match[1].strip().strip("\"'")
    return DEFAULT_DEV_PORT if value is None else checked_port(value)


def evaluate(code, timeout=900):
    data_dir = dev_data_dir()
    token_path = data_dir / "dev-eval-token.txt"
    if not token_path.is_file():
        raise RuntimeError("No dev token file. Start the isolated development build first.")
    token = token_path.read_text().strip()
    if not token:
        raise RuntimeError("The development token file is empty.")
    port = dev_port()
    # This check runs in the destination instance BEFORE any item/attachment
    # mutations. A wrong port or stale token must never target another profile.
    checked_code = """
if (addon.data.env !== "development" || Zotero.DataDirectory.dir !== %s) {
  throw new Error("Refusing parser test outside the expected isolated dev data directory");
}
%s
""" % (json.dumps(str(data_dir)), code)
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/refs-dev/eval",
        json.dumps({"token": token, "code": checked_code}).encode(),
        {"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Development endpoint returned HTTP {error.code}; check its port and restart token") from None
    if not result.get("ok"):
        raise RuntimeError(result.get("error", "Development evaluation failed"))
    return json.loads(result["result"])
