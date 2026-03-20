"""
HexNest Python Sandbox Wrapper
Injected before every user script to block dangerous operations.
"""
import importlib
import importlib.abc
import sys
import builtins

# ── Blocked modules ──
_BLOCKED_MODULES = frozenset({
    # OS / filesystem / process
    "os", "posix", "nt", "posixpath", "ntpath",
    "subprocess", "shutil", "pathlib",
    "signal", "resource",
    # System internals
    "ctypes", "ctypes.util",
    "_thread", "threading", "multiprocessing",
    # Network
    "socket", "ssl",
    "http", "http.client", "http.server",
    "urllib", "urllib.request", "urllib.parse",
    "ftplib", "smtplib", "poplib", "imaplib",
    "xmlrpc", "xmlrpc.client", "xmlrpc.server",
    "socketserver",
    "requests", "httpx", "aiohttp",
    # Code execution / introspection
    "code", "codeop", "compileall",
    "inspect", "dis",
    "pickle", "shelve", "marshal",
    # File I/O escape
    "tempfile", "glob", "fnmatch",
    "zipfile", "tarfile", "gzip", "bz2", "lzma",
    # Dangerous stdlib
    "webbrowser", "antigravity",
    "ensurepip", "pip", "setuptools",
})

_ALLOWED_MODULES = frozenset({
    "math", "cmath", "decimal", "fractions", "statistics",
    "random", "secrets",
    "datetime", "time", "calendar",
    "json", "csv", "re", "string", "textwrap",
    "collections", "itertools", "functools", "operator",
    "heapq", "bisect", "array",
    "copy", "pprint", "enum", "dataclasses", "typing",
    "hashlib", "hmac", "base64", "binascii",
    "struct", "codecs",
    "numbers", "abc",
    "unicodedata",
    "io",
})


class _SandboxImportBlocker(importlib.abc.MetaPathFinder):
    """Meta path finder that blocks dangerous imports at runtime."""

    def find_module(self, fullname, path=None):
        if self._is_blocked(fullname):
            return self
        return None

    def load_module(self, fullname):
        raise ImportError(
            f"[HexNest Sandbox] import '{fullname}' is blocked. "
            f"Only safe modules (math, random, json, datetime, collections, etc.) are allowed."
        )

    @staticmethod
    def _is_blocked(name):
        if name in _ALLOWED_MODULES:
            return False
        for blocked in _BLOCKED_MODULES:
            if name == blocked or name.startswith(blocked + "."):
                return True
        return False


# Install the blocker
sys.meta_path.insert(0, _SandboxImportBlocker())

# ── Block dangerous builtins ──
_original_open = builtins.open


def _safe_open(file, mode="r", *args, **kwargs):
    mode_str = str(mode)
    if any(c in mode_str for c in ("w", "a", "x", "+")):
        raise PermissionError(
            "[HexNest Sandbox] Writing files is blocked. Use print() for output."
        )
    return _original_open(file, mode, *args, **kwargs)


builtins.open = _safe_open

# Block exec/eval but keep __import__ alive (needed by allowed modules internally)
_original_exec = builtins.exec
_original_eval = builtins.eval


def _blocked_exec(*args, **kwargs):
    raise PermissionError("[HexNest Sandbox] exec() is blocked.")


def _blocked_eval(*args, **kwargs):
    raise PermissionError("[HexNest Sandbox] eval() is blocked.")


builtins.exec = _blocked_exec
builtins.eval = _blocked_eval

# ── Execute user script ──
# We use exec with compile so we can control the namespace
_code_path = "main.py"
with _original_open(_code_path, "r") as _f:
    _source = _f.read()

# Temporarily restore exec for our own use, then re-block
builtins.exec = _original_exec
_compiled = compile(_source, _code_path, "exec")
_user_globals = {"__name__": "__main__", "__file__": _code_path}
exec(_compiled, _user_globals)

# Re-block after execution (in case of lingering references)
builtins.exec = _blocked_exec
