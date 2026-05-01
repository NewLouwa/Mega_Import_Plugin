"""
Unit tests for mega_import.py — focuses on the `mega-ls -l` parser, dispatch,
and envelope encoding. Run with: `python -m unittest test_mega_import`.

No MEGAcmd or network required.
"""

import io
import json
import unittest
from unittest import mock

import mega_import


class ParseLsLineTests(unittest.TestCase):
    def test_folder(self):
        line = "drwxrwx---     -     -      14May2024 10:22:11  Documents"
        result = mega_import._parse_ls_line(line, "/")
        self.assertEqual(result, {
            "type": "folder",
            "name": "Documents",
            "size": None,
            "path": "/Documents",
        })

    def test_file_with_size(self):
        line = "-rw-rw----     1   1.5M     14May2024 10:22:11  movie.mp4"
        result = mega_import._parse_ls_line(line, "/")
        self.assertEqual(result["type"], "file")
        self.assertEqual(result["name"], "movie.mp4")
        self.assertEqual(result["size"], "1.5M")
        self.assertEqual(result["path"], "/movie.mp4")

    def test_file_under_subfolder(self):
        line = "-rw-rw----     1   2.2M     01Jan2024 09:00:00  file.pdf"
        result = mega_import._parse_ls_line(line, "/Documents")
        self.assertEqual(result["path"], "/Documents/file.pdf")

    def test_skips_dot_entries(self):
        self.assertIsNone(mega_import._parse_ls_line(
            "drwxrwx---     -     -      14May2024 10:22:11  .", "/"
        ))
        self.assertIsNone(mega_import._parse_ls_line(
            "drwxrwx---     -     -      14May2024 10:22:11  ..", "/"
        ))

    def test_blank_line(self):
        self.assertIsNone(mega_import._parse_ls_line("   ", "/"))
        self.assertIsNone(mega_import._parse_ls_line("", "/"))

    def test_too_few_columns_returns_none(self):
        # Malformed: parser should fail gracefully rather than crash.
        result = mega_import._parse_ls_line("d-x", "/")
        self.assertIsNone(result)

    def test_filename_with_spaces(self):
        # Best-effort: split(None, 5) consumes 5 separators then the rest is
        # treated as one token. A 6-column ls line with a spaced filename keeps
        # everything past the date column intact.
        line = "-rw-rw----     1   3.0M     14May2024 10:22:11  My Vacation Video.mp4"
        result = mega_import._parse_ls_line(line, "/")
        self.assertIsNotNone(result)
        self.assertTrue(result["name"].endswith("Video.mp4"))


class NormalizePathTests(unittest.TestCase):
    def test_empty_becomes_root(self):
        self.assertEqual(mega_import._normalize_remote_path(""), "/")
        self.assertEqual(mega_import._normalize_remote_path(None), "/")

    def test_prepends_leading_slash(self):
        self.assertEqual(mega_import._normalize_remote_path("Documents"), "/Documents")

    def test_preserves_absolute(self):
        self.assertEqual(mega_import._normalize_remote_path("/Documents/file.txt"), "/Documents/file.txt")


class DispatchTests(unittest.TestCase):
    """End-to-end main() dispatch with stdin/stdout mocked."""

    def _run_main(self, payload):
        with mock.patch("sys.stdin", io.StringIO(json.dumps(payload))):
            return mega_import.main()

    def test_unknown_action_standalone(self):
        response, stash_mode = self._run_main({"action": "bogus"})
        self.assertFalse(response["ok"])
        self.assertEqual(response["code"], "unknown_action")
        self.assertFalse(stash_mode)

    def test_unknown_action_stash_mode(self):
        response, stash_mode = self._run_main({"args": {"action": "bogus"}})
        self.assertTrue(stash_mode)
        envelope = mega_import._stash_envelope(response)
        self.assertIsNone(envelope["output"])
        self.assertTrue(envelope["error"].startswith("ERR:"))

    def test_missing_action(self):
        response, _ = self._run_main({})
        self.assertEqual(response["code"], "no_action")

    def test_login_validates_args(self):
        with mock.patch.object(mega_import, "_run", return_value=("", "", 0)):
            response, _ = self._run_main({"action": "login"})
        self.assertFalse(response["ok"])
        self.assertEqual(response["code"], "bad_args")

    def test_megacmd_missing_returns_clean_error(self):
        with mock.patch("shutil.which", return_value=None), \
             mock.patch.dict("os.environ", {"LOCALAPPDATA": "", "PROGRAMFILES": ""}):
            response, _ = self._run_main({"action": "check"})
        self.assertFalse(response["ok"])
        self.assertEqual(response["code"], "megacmd_missing")

    def test_list_parses_and_sorts(self):
        fake_output = (
            "FLAGS         VERS    SIZE         DATE                NAME\n"
            "-rw-rw----     1   1.5M     14May2024 10:22:11  movie.mp4\n"
            "drwxrwx---     -     -      14May2024 10:22:11  Documents\n"
            "drwxrwx---     -     -      14May2024 10:22:11  Images\n"
        )
        with mock.patch.object(mega_import, "_run", return_value=(fake_output, "", 0)):
            response, _ = self._run_main({"action": "list", "path": "/"})
        self.assertTrue(response["ok"], response)
        items = response["result"]
        # Folders first, alpha; then files.
        self.assertEqual([i["name"] for i in items], ["Documents", "Images", "movie.mp4"])
        self.assertEqual(items[0]["type"], "folder")
        self.assertEqual(items[-1]["type"], "file")

    def test_download_returns_dest_and_per_file_status(self):
        def fake_run(args, input_text=None):
            if args[0] == "mega-get" and args[1] == "/ok":
                return ("done", "", 0)
            return ("", "boom", 1)

        with mock.patch.object(mega_import, "_run", side_effect=fake_run):
            response, _ = self._run_main({"action": "download", "paths": ["/ok", "/fail"], "dest": "./tmp_test_dest"})
        self.assertTrue(response["ok"])
        self.assertIn("dest", response["result"])
        statuses = {i["path"]: i["status"] for i in response["result"]["items"]}
        self.assertEqual(statuses["/ok"], "ok")
        self.assertEqual(statuses["/fail"], "error")

        # Cleanup the dir we created.
        import shutil, os
        if os.path.isdir("./tmp_test_dest"):
            shutil.rmtree("./tmp_test_dest", ignore_errors=True)


class FindActionTests(unittest.TestCase):
    def _run_main(self, payload):
        with mock.patch("sys.stdin", io.StringIO(json.dumps(payload))):
            return mega_import.main()

    def test_find_requires_query(self):
        response, _ = self._run_main({"action": "find"})
        self.assertFalse(response["ok"])
        self.assertEqual(response["code"], "bad_args")

    def test_find_parses_paths(self):
        fake_output = "/Documents/file1.pdf\n/Documents/sub/file2.pdf\n/Images/pic.jpg\n"
        with mock.patch.object(mega_import, "_run", return_value=(fake_output, "", 0)):
            response, _ = self._run_main({"action": "find", "query": "*"})
        self.assertTrue(response["ok"])
        names = [i["name"] for i in response["result"]]
        self.assertEqual(sorted(names), ["file1.pdf", "file2.pdf", "pic.jpg"])
        for item in response["result"]:
            self.assertEqual(item["type"], "file")
            self.assertTrue(item["path"].startswith("/"))

    def test_find_falls_back_to_positional_pattern(self):
        # First call (with --pattern=) fails; second (positional) succeeds.
        calls = []
        def fake_run(args, input_text=None):
            calls.append(args)
            if "--pattern=" in args[-1]:
                return ("", "unknown option", 1)
            return ("/found.txt\n", "", 0)
        with mock.patch.object(mega_import, "_run", side_effect=fake_run):
            response, _ = self._run_main({"action": "find", "query": "*.txt"})
        self.assertTrue(response["ok"])
        self.assertEqual(len(calls), 2)
        self.assertEqual(response["result"][0]["path"], "/found.txt")

    def test_find_skips_non_path_lines(self):
        # Real MEGAcmd sometimes interleaves status lines.
        fake_output = "Searching...\n/real/file.txt\n  \nblank-not-a-path\n/another/x.pdf\n"
        with mock.patch.object(mega_import, "_run", return_value=(fake_output, "", 0)):
            response, _ = self._run_main({"action": "find", "query": "*"})
        paths = [i["path"] for i in response["result"]]
        self.assertEqual(sorted(paths), ["/another/x.pdf", "/real/file.txt"])


class StashEnvelopeTests(unittest.TestCase):
    def test_ok_envelope(self):
        env = mega_import._stash_envelope({"ok": True, "result": {"x": 1}})
        self.assertIsNone(env["output"])
        self.assertTrue(env["error"].startswith("OK:"))
        decoded = json.loads(env["error"][3:])
        self.assertEqual(decoded, {"x": 1})

    def test_err_envelope(self):
        env = mega_import._stash_envelope({"ok": False, "error": "nope"})
        self.assertEqual(env["error"], "ERR:nope")


if __name__ == "__main__":
    unittest.main()
