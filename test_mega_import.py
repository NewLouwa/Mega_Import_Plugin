"""
Unit tests for mega_import.py (mega.py edition).

Run with:
    python -m unittest test_mega_import -v

No MEGAcmd, no Stash, no network required — mega.py calls are mocked.
"""

import base64
import hashlib
import io
import json
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run_main(input_dict, *, as_stash=True):
    """Feed a payload to main() and return the decoded output dict."""
    import mega_import
    payload = {"args": input_dict} if as_stash else input_dict
    stdin_data = json.dumps(payload)
    captured = io.StringIO()
    with (
        patch("sys.stdin", io.StringIO(stdin_data)),
        patch("sys.stdout", captured),
        patch("sys.exit"),
    ):
        mega_import.main()
    return json.loads(captured.getvalue())


def _fake_files():
    """Minimal flat files dict: root + one folder + two files."""
    return {
        "root1": {"h": "root1", "t": 2, "p": None,    "a": None},
        "fold1": {"h": "fold1", "t": 1, "p": "root1", "a": {"n": "Movies"}, "s": None},
        "file1": {"h": "file1", "t": 0, "p": "fold1", "a": {"n": "video.mp4"}, "s": 1048576},
        "file2": {"h": "file2", "t": 0, "p": "root1", "a": {"n": "readme.txt"}, "s": 512},
    }


# ---------------------------------------------------------------------------
# Session token encoding / decoding
# ---------------------------------------------------------------------------

class SessionTokenTests(unittest.TestCase):
    def test_roundtrip(self):
        import mega_import
        sid = "abc123session"
        mk = bytes(range(16))
        token = mega_import._session_to_token(sid, mk)
        sid2, mk2 = mega_import._token_to_session(token)
        self.assertEqual(sid, sid2)
        self.assertEqual(mk, mk2)

    def test_null_master_key(self):
        import mega_import
        token = mega_import._session_to_token("sid", None)
        sid, mk = mega_import._token_to_session(token)
        self.assertEqual("sid", sid)
        self.assertIsNone(mk)

    def test_invalid_token_raises(self):
        import mega_import
        from mega_import import MegaError
        with self.assertRaises(MegaError):
            mega_import._token_to_session("not-valid-base64!!!")

    def test_empty_sid_raises(self):
        import mega_import
        from mega_import import MegaError
        bad = base64.b64encode(json.dumps({"sid": "", "mk": []}).encode()).decode()
        with self.assertRaises(MegaError):
            mega_import._token_to_session(bad)


# ---------------------------------------------------------------------------
# File-tree helpers
# ---------------------------------------------------------------------------

class NodePathTests(unittest.TestCase):
    def setUp(self):
        import mega_import
        self.files = _fake_files()
        self.np = mega_import._node_path

    def test_root_is_slash(self):
        self.assertEqual("/", self.np("root1", self.files, {}))

    def test_first_level_folder(self):
        self.assertEqual("/Movies", self.np("fold1", self.files, {}))

    def test_nested_file(self):
        self.assertEqual("/Movies/video.mp4", self.np("file1", self.files, {}))

    def test_root_level_file(self):
        self.assertEqual("/readme.txt", self.np("file2", self.files, {}))

    def test_unknown_node_returns_slash(self):
        self.assertEqual("/", self.np("nope", self.files, {}))

    def test_cache_populated(self):
        cache = {}
        import mega_import
        mega_import._node_path("file1", self.files, cache)
        self.assertIn("file1", cache)
        self.assertIn("fold1", cache)
        self.assertIn("root1", cache)


class FindByPathTests(unittest.TestCase):
    def setUp(self):
        import mega_import
        self.files = _fake_files()
        self.fbp = mega_import._find_by_path

    def test_root(self):
        nid, node = self.fbp(self.files, "/")
        self.assertEqual("root1", nid)

    def test_folder(self):
        nid, node = self.fbp(self.files, "/Movies")
        self.assertEqual("fold1", nid)

    def test_nested_file(self):
        nid, node = self.fbp(self.files, "/Movies/video.mp4")
        self.assertEqual("file1", nid)

    def test_missing_path_raises(self):
        from mega_import import MegaError
        with self.assertRaises(MegaError) as cm:
            self.fbp(self.files, "/DoesNotExist")
        self.assertEqual("not_found", cm.exception.code)

    def test_trailing_slash_stripped(self):
        nid, _ = self.fbp(self.files, "/Movies/")
        self.assertEqual("fold1", nid)


class ListChildrenTests(unittest.TestCase):
    def setUp(self):
        import mega_import
        self.files = _fake_files()
        self.lc = mega_import._list_children

    def test_root_children_sorted_folders_first(self):
        items = self.lc(self.files, "root1", "/")
        self.assertEqual("folder", items[0]["type"])
        self.assertEqual("Movies", items[0]["name"])
        self.assertEqual("file", items[1]["type"])
        self.assertEqual("readme.txt", items[1]["name"])

    def test_folder_children(self):
        items = self.lc(self.files, "fold1", "/Movies")
        self.assertEqual(1, len(items))
        self.assertEqual("file", items[0]["type"])
        self.assertEqual("/Movies/video.mp4", items[0]["path"])

    def test_size_included(self):
        items = self.lc(self.files, "fold1", "/Movies")
        self.assertEqual(1048576, items[0]["size"])

    def test_alphabetical_within_type(self):
        files = _fake_files()
        files["fold2"] = {"h": "fold2", "t": 1, "p": "root1", "a": {"n": "AAA"}, "s": None}
        items = self.lc(files, "root1", "/")
        folder_names = [i["name"] for i in items if i["type"] == "folder"]
        self.assertEqual(["AAA", "Movies"], folder_names)


# ---------------------------------------------------------------------------
# Action: check
# ---------------------------------------------------------------------------

class ActionCheckTests(unittest.TestCase):
    def test_returns_version_and_backend(self):
        import mega_import
        result = mega_import.action_check({})
        self.assertIn("mega.py", result["version"])
        self.assertEqual("mega.py", result["backend"])


# ---------------------------------------------------------------------------
# Action: whoami
# ---------------------------------------------------------------------------

class ActionWhoamiTests(unittest.TestCase):
    def test_null_when_not_logged_in(self):
        import mega_import
        with patch.object(mega_import, "_load_saved_token", return_value=None):
            result = mega_import.action_whoami({})
        self.assertIsNone(result["email"])

    def test_returns_email_when_logged_in(self):
        import mega_import
        mock_mega = MagicMock()
        mock_mega.get_user.return_value = {"email": "test@example.com"}
        token = mega_import._session_to_token("sid123", bytes(16))
        with (
            patch.object(mega_import, "_load_saved_token", return_value=token),
            patch.object(mega_import, "_make_mega", return_value=mock_mega),
        ):
            result = mega_import.action_whoami({})
        self.assertEqual("test@example.com", result["email"])

    def test_null_on_api_error(self):
        import mega_import
        mock_mega = MagicMock()
        mock_mega.get_user.side_effect = Exception("network error")
        token = mega_import._session_to_token("sid123", bytes(16))
        with (
            patch.object(mega_import, "_load_saved_token", return_value=token),
            patch.object(mega_import, "_make_mega", return_value=mock_mega),
        ):
            result = mega_import.action_whoami({})
        self.assertIsNone(result["email"])


# ---------------------------------------------------------------------------
# Action: login
# ---------------------------------------------------------------------------

class ActionLoginTests(unittest.TestCase):
    def test_missing_args_raises(self):
        import mega_import
        from mega_import import MegaError
        with self.assertRaises(MegaError) as cm:
            mega_import.action_login({})
        self.assertEqual("bad_args", cm.exception.code)

    def test_email_password_login_returns_token(self):
        import mega_import
        mock_instance = MagicMock()
        mock_instance.sid = "test_sid"
        mock_instance.master_key = bytes(16)
        mock_instance.get_user.return_value = {"email": "user@mega.nz"}
        mock_mega_cls = MagicMock()
        mock_mega_cls.return_value.login.return_value = mock_instance

        with (
            patch.dict("sys.modules", {"mega": MagicMock(Mega=mock_mega_cls)}),
            patch.object(mega_import, "_save_session", return_value="TOKEN123"),
        ):
            result = mega_import.action_login({"email": "user@mega.nz", "password": "pw"})
        self.assertEqual("user@mega.nz", result["email"])
        self.assertEqual("TOKEN123", result["session_token"])

    def test_session_token_login(self):
        import mega_import
        token = mega_import._session_to_token("sid_abc", bytes(16))
        mock_mega = MagicMock()
        mock_mega.get_user.return_value = {"email": "restored@mega.nz"}
        with (
            patch.object(mega_import, "_make_mega", return_value=mock_mega),
            patch.object(mega_import, "_save_session", return_value=token),
        ):
            result = mega_import.action_login({"session_token": token})
        self.assertEqual("restored@mega.nz", result["email"])

    def test_bad_session_token_raises(self):
        import mega_import
        from mega_import import MegaError
        bad_token = base64.b64encode(b"garbage").decode()
        with self.assertRaises(MegaError):
            mega_import.action_login({"session_token": bad_token})


# ---------------------------------------------------------------------------
# Action: logout
# ---------------------------------------------------------------------------

class ActionLogoutTests(unittest.TestCase):
    def test_deletes_session_file(self):
        import mega_import
        with tempfile.NamedTemporaryFile(delete=False) as f:
            tmp = Path(f.name)
        tmp.write_text("session")
        with patch.object(mega_import, "SESSION_FILE", tmp):
            mega_import.action_logout({})
        self.assertFalse(tmp.exists())

    def test_no_error_if_file_missing(self):
        import mega_import
        with patch.object(mega_import, "SESSION_FILE", Path("/nonexistent/nowhere")):
            result = mega_import.action_logout({})
        self.assertEqual({}, result)


# ---------------------------------------------------------------------------
# Action: find
# ---------------------------------------------------------------------------

class ActionFindTests(unittest.TestCase):
    def _patched_mega(self):
        import mega_import
        mock_mega = MagicMock()
        mock_mega.get_files.return_value = _fake_files()
        token = mega_import._session_to_token("s", bytes(16))
        return mock_mega, token

    def test_requires_query(self):
        import mega_import
        from mega_import import MegaError
        mock_mega, token = self._patched_mega()
        with (
            patch.object(mega_import, "_load_saved_token", return_value=token),
            patch.object(mega_import, "_make_mega", return_value=mock_mega),
        ):
            with self.assertRaises(MegaError) as cm:
                mega_import.action_find({})
        self.assertEqual("bad_args", cm.exception.code)

    def test_finds_file_by_name_substring(self):
        import mega_import
        mock_mega, token = self._patched_mega()
        with (
            patch.object(mega_import, "_load_saved_token", return_value=token),
            patch.object(mega_import, "_make_mega", return_value=mock_mega),
        ):
            result = mega_import.action_find({"query": "video"})
        paths = [r["path"] for r in result]
        self.assertIn("/Movies/video.mp4", paths)

    def test_no_match_returns_empty(self):
        import mega_import
        mock_mega, token = self._patched_mega()
        with (
            patch.object(mega_import, "_load_saved_token", return_value=token),
            patch.object(mega_import, "_make_mega", return_value=mock_mega),
        ):
            result = mega_import.action_find({"query": "XXXXXXXX"})
        self.assertEqual([], result)

    def test_path_filter(self):
        import mega_import
        mock_mega, token = self._patched_mega()
        with (
            patch.object(mega_import, "_load_saved_token", return_value=token),
            patch.object(mega_import, "_make_mega", return_value=mock_mega),
        ):
            # readme.txt is at root, search inside /Movies
            result = mega_import.action_find({"query": "readme", "path": "/Movies"})
        self.assertEqual([], result)


# ---------------------------------------------------------------------------
# Hashcash helpers
# ---------------------------------------------------------------------------

class MegaBase64Tests(unittest.TestCase):
    def test_encode_decode_roundtrip(self):
        import mega_import
        for b in [b"", b"\x00", b"\xff" * 4, bytes(range(48))]:
            encoded = mega_import._mega_b64_encode(b)
            decoded = mega_import._mega_b64_decode(encoded)
            self.assertEqual(b, decoded)

    def test_no_padding_in_output(self):
        import mega_import
        enc = mega_import._mega_b64_encode(b"\x00\x00\x00")  # 4 chars, no =
        self.assertNotIn("=", enc)

    def test_uses_mega_alphabet(self):
        import mega_import
        # all output chars must be in A-Za-z0-9-_
        enc = mega_import._mega_b64_encode(bytes(range(256)))
        allowed = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        self.assertTrue(all(c in allowed for c in enc))

    def test_accepts_standard_base64_chars(self):
        """Decode must treat + as - and / as _ (lenient)."""
        import mega_import
        # encode with standard base64 then swap chars and decode with mega
        b = bytes(range(48))
        std = base64.b64encode(b).decode().rstrip("=").replace("+", "-").replace("/", "_")
        # decode the MEGA-alphabet version and also the standard chars
        out_mega = mega_import._mega_b64_decode(std)
        out_std  = mega_import._mega_b64_decode(
            std.replace("-", "+").replace("_", "/")
        )
        self.assertEqual(out_mega, out_std)


class HashcashThresholdTests(unittest.TestCase):
    def test_known_values(self):
        import mega_import
        # From SDK: threshold(e) = (((e&63)<<1)+1) << ((e>>6)*7+3)
        for e, expected in [(0, 8), (1, 24), (63, 1016), (100, 74752), (200, 285212672)]:
            self.assertEqual(expected, mega_import._hc_threshold(e),
                             msg=f"threshold({e})")


class HashcashParseHeaderTests(unittest.TestCase):
    def test_valid_header(self):
        import mega_import
        token = "A" * 64
        val = f"1:100:1731410499:{token}"
        result = mega_import._parse_hashcash_header(val)
        self.assertIsNotNone(result)
        tok, ease = result
        self.assertEqual(token, tok)
        self.assertEqual(100, ease)

    def test_wrong_version_rejected(self):
        import mega_import
        self.assertIsNone(mega_import._parse_hashcash_header(f"2:100:123:{'A'*64}"))

    def test_wrong_token_length_rejected(self):
        import mega_import
        self.assertIsNone(mega_import._parse_hashcash_header(f"1:100:123:{'A'*63}"))

    def test_bad_easiness_rejected(self):
        import mega_import
        self.assertIsNone(mega_import._parse_hashcash_header(f"1:256:123:{'A'*64}"))


class GencashTests(unittest.TestCase):
    """Test the proof-of-work solver with a high easiness (trivial difficulty)."""

    @staticmethod
    def _make_token_b64() -> str:
        """Return a valid 48-byte MEGA-base64 token."""
        import mega_import
        return mega_import._mega_b64_encode(bytes(range(48)))

    def test_returns_valid_prefix(self):
        """gencash with easiness=255 (easiest) must return a valid 4-byte prefix."""
        import mega_import
        token_b64 = self._make_token_b64()
        prefix_b64 = mega_import._gencash(token_b64, easiness=255)
        # Must decode to exactly 4 bytes
        prefix_bytes = mega_import._mega_b64_decode(prefix_b64)
        self.assertEqual(4, len(prefix_bytes))

    def test_prefix_satisfies_threshold(self):
        """The returned prefix must genuinely satisfy SHA-256 ≤ threshold(easiness)."""
        import mega_import
        token_b64 = self._make_token_b64()
        token_bin = mega_import._mega_b64_decode(token_b64)
        easiness = 255

        prefix_b64 = mega_import._gencash(token_b64, easiness=easiness)
        prefix_bytes = mega_import._mega_b64_decode(prefix_b64)

        # Rebuild the buffer exactly as the SDK does
        BUF_SIZE = 4 + 262144 * 48
        buf = bytearray(BUF_SIZE)
        buf[0:4] = prefix_bytes
        buf[4:4 + 48] = token_bin
        filled = 48
        while filled < 262144 * 48:
            chunk = min(filled, 262144 * 48 - filled)
            buf[4 + filled : 4 + filled + chunk] = buf[4 : 4 + filled]
            filled += chunk

        digest = hashlib.sha256(bytes(buf)).digest()
        first_word, = struct.unpack(">I", digest[:4])
        threshold = mega_import._hc_threshold(easiness)
        self.assertLessEqual(first_word, threshold,
            msg=f"first_word={first_word:#010x} > threshold={threshold:#010x}")

    def test_bad_token_raises(self):
        import mega_import
        from mega_import import MegaError
        # token that decodes to wrong number of bytes
        short_token = mega_import._mega_b64_encode(b"\x00" * 10)  # 10 bytes, not 48
        with self.assertRaises(MegaError) as cm:
            mega_import._gencash(short_token, easiness=255)
        self.assertEqual("bad_hashcash", cm.exception.code)


# ---------------------------------------------------------------------------
# Main dispatch
# ---------------------------------------------------------------------------

class MainDispatchTests(unittest.TestCase):
    def test_empty_stdin(self):
        import mega_import
        captured = io.StringIO()
        with (
            patch("sys.stdin", io.StringIO("")),
            patch("sys.stdout", captured),
            patch("sys.exit"),
        ):
            mega_import.main()
        out = json.loads(captured.getvalue())
        self.assertIsNone(out["output"])
        self.assertIsNotNone(out["error"])

    def test_unknown_action(self):
        out = _run_main({"action": "bogus"})
        self.assertIsNone(out["output"])
        self.assertIn("bogus", out["error"])

    def test_missing_action(self):
        out = _run_main({})
        self.assertIsNone(out["output"])
        self.assertIn("action", out["error"])

    def test_stash_mode_unwraps_args(self):
        """Stash wraps args in {"args": {...}}; main() must unwrap them."""
        import mega_import
        payload = json.dumps({"args": {"action": "check"}})
        captured = io.StringIO()
        with (
            patch("sys.stdin", io.StringIO(payload)),
            patch("sys.stdout", captured),
            patch("sys.exit"),
        ):
            mega_import.main()
        out = json.loads(captured.getvalue())
        self.assertIsNone(out["error"])
        self.assertIn("mega.py", out["output"]["version"])

    def test_not_logged_in_returns_error(self):
        out = _run_main({"action": "list", "path": "/"})
        self.assertIsNone(out["output"])
        self.assertIn("log in", out["error"].lower())

    def test_check_succeeds_without_auth(self):
        out = _run_main({"action": "check"})
        self.assertIsNone(out["error"])
        self.assertIsNotNone(out["output"])

    def test_output_null_on_error(self):
        out = _run_main({"action": "login"})   # missing email+password
        self.assertIsNone(out["output"])
        self.assertIsNotNone(out["error"])

    def test_error_null_on_success(self):
        out = _run_main({"action": "check"})
        self.assertIsNone(out["error"])
        self.assertIsNotNone(out["output"])


if __name__ == "__main__":
    unittest.main()
