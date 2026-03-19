"""
HexNest Python Sandbox Wrapper
Injected before every user script to block dangerous operations.
"""
import importlib
import importlib.abc
import importlib.machinery
import sys
import builtins

# ── Blocked modules ──
_BLOCKED_MODULES = frozenset({
    # OS / filesystem / process
    "os", "posix", "nt", "posixpath", "ntpath",
    "subprocess", "shutil", "pathlib",
    "signal", "resource",
    # System internals
    "sys", "importlib", "importlib.abc", "importlib.machinery",
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
    "code", "codeop", "compile", "compileall",
    "inspect", "dis", "ast",
    "pickle", "shelve", "marshal",
    # File I/O escape
    "tempfile", "glob", "fnmatch",
    "zipfile", "tarfile", "gzip", "bz2", "lzma",
    "io",
    # Dangerous stdlib
    "webbrowser", "antigravity",
    "ensurepip", "pip", "setuptools",
})

# Modules that are allowed even though they start with a blocked prefix
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
        # Check exact match or prefix match for submodules
        for blocked in _BLOCKED_MODULES:
            if name == blocked or name.startswith(blocked + "."):
                return True
        return False


# Install the blocker as the FIRST meta path finder
sys.meta_path.insert(0, _SandboxImportBlocker())

# ── Block dangerous builtins ──
_original_open = builtins.open

def _safe_open(file, mode="r", *args, **kwargs):
    """Only allow reading files in the current working directory."""
    mode_str = str(mode)
    if any(c in mode_str for c in ("w", "a", "x", "+")):
        raise PermissionError(
            "[HexNest Sandbox] Writing files is blocked. Use print() for output."
        )
    return _original_open(file, mode, *args, **kwargs)

builtins.open = _safe_open
builtins.exec = None
builtins.eval = None
builtins.compile = None
builtins.__import__ = None

# Remove sys from user access after setup
_original_modules = sys.modules.copy()

# ── Now execute the user script ──
import runpy as _runpy
_runpy.run_path("main.py", run_name="__main__")
