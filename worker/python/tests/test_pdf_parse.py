import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ideaseek_worker.minipdf import build_minimal_pdf
from ideaseek_worker.pdf_parse import PdfParseError, parse_pdf


class ParseTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="ideaseek-worker-test-")
        self.tmp = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_parses_pages_with_1based_numbers(self) -> None:
        pdf = self.tmp / "two.pdf"
        pdf.write_bytes(build_minimal_pdf(["First page marker", "Second page marker"]))
        parsed = parse_pdf(pdf)
        self.assertEqual(parsed.page_count, 2)
        self.assertEqual([p.page for p in parsed.pages], [1, 2])
        self.assertIn("First page marker", parsed.pages[0].text)
        self.assertIn("Second page marker", parsed.pages[1].text)
        self.assertTrue(parsed.parser.startswith("pypdf/"))
        payload = parsed.to_json()
        self.assertEqual(payload["pageCount"], 2)
        self.assertIsInstance(payload["pages"][0]["text"], str)

    def test_missing_file_has_stable_code(self) -> None:
        with self.assertRaises(PdfParseError) as ctx:
            parse_pdf(self.tmp / "absent.pdf")
        self.assertEqual(ctx.exception.code, "FILE_NOT_FOUND")

    def test_empty_file_rejected(self) -> None:
        empty = self.tmp / "empty.pdf"
        empty.write_bytes(b"")
        with self.assertRaises(PdfParseError) as ctx:
            parse_pdf(empty)
        self.assertEqual(ctx.exception.code, "EMPTY_FILE")

    def test_non_pdf_rejected(self) -> None:
        junk = self.tmp / "junk.pdf"
        junk.write_bytes(b"this is not a pdf at all")
        with self.assertRaises(PdfParseError) as ctx:
            parse_pdf(junk)
        self.assertEqual(ctx.exception.code, "PARSE_FAILED")

    def test_cli_protocol_success_and_failure(self) -> None:
        pdf = self.tmp / "cli.pdf"
        pdf.write_bytes(build_minimal_pdf(["CLI marker page"]))
        env = {"PYTHONPATH": str(Path(__file__).resolve().parents[1]), "PATH": ""}
        # Keep system PATH for the interpreter itself.
        import os

        env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1])}
        ok = subprocess.run(
            [sys.executable, "-m", "ideaseek_worker", "parse", str(pdf)],
            capture_output=True,
            text=True,
            env=env,
            cwd=str(Path(__file__).resolve().parents[1]),
            timeout=60,
        )
        self.assertEqual(ok.returncode, 0, ok.stderr)
        payload = json.loads(ok.stdout)
        self.assertEqual(payload["pageCount"], 1)

        bad = subprocess.run(
            [sys.executable, "-m", "ideaseek_worker", "parse", str(self.tmp / "nope.pdf")],
            capture_output=True,
            text=True,
            env=env,
            cwd=str(Path(__file__).resolve().parents[1]),
            timeout=60,
        )
        self.assertEqual(bad.returncode, 1)
        err = json.loads(bad.stderr)
        self.assertEqual(err["code"], "FILE_NOT_FOUND")
        self.assertEqual(ok.stdout.count("\n"), 1)  # strict single-JSON-line stdout


if __name__ == "__main__":
    unittest.main()


class TablesTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="ideaseek-tables-")
        self.tmp = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_fixture_has_no_tables_but_succeeds(self) -> None:
        pdf = self.tmp / "plain.pdf"
        pdf.write_bytes(build_minimal_pdf(["Just prose, no grids."]))
        env = {**__import__("os").environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1])}
        out = subprocess.run(
            [sys.executable, "-m", "ideaseek_worker", "tables", str(pdf)],
            capture_output=True, text=True, env=env,
            cwd=str(Path(__file__).resolve().parents[1]), timeout=120,
        )
        self.assertEqual(out.returncode, 0, out.stderr)
        payload = json.loads(out.stdout)
        self.assertEqual(payload["tableCount"], len(payload["tables"]))
        self.assertTrue(payload["parser"].startswith("pdfplumber/"))

    def test_missing_file_reports_stable_code(self) -> None:
        env = {**__import__("os").environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1])}
        out = subprocess.run(
            [sys.executable, "-m", "ideaseek_worker", "tables", str(self.tmp / "nope.pdf")],
            capture_output=True, text=True, env=env,
            cwd=str(Path(__file__).resolve().parents[1]), timeout=60,
        )
        self.assertEqual(out.returncode, 1)
        self.assertEqual(json.loads(out.stderr)["code"], "FILE_NOT_FOUND")
