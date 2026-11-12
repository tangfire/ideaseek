import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ideaseek_worker.schema_validate import schema_dir, validate_payload


def valid_payload() -> dict:
    return {
        "source": "papers/x.pdf",
        "pageCount": 1,
        "pages": [{"page": 1, "text": "hello"}],
        "parser": "ideaseek-pdf/7.0.0",
    }


class SchemaValidationTests(unittest.TestCase):
    def test_shared_schema_directory_is_found(self) -> None:
        directory = schema_dir()
        self.assertIsNotNone(directory)
        self.assertTrue((directory / "parsed-paper-v1.json").is_file())

    def test_valid_payload_passes(self) -> None:
        self.assertIsNone(validate_payload("parsed-paper-v1", valid_payload()))

    def test_page_zero_is_rejected_with_instance_path(self) -> None:
        payload = valid_payload()
        payload["pages"] = [{"page": 0, "text": "zero-indexed"}]
        message = validate_payload("parsed-paper-v1", payload)
        self.assertIsNotNone(message)
        self.assertIn("parsed-paper-v1 self-validation failed", message)
        self.assertIn("/pages/0/page", message)

    def test_missing_pages_is_rejected(self) -> None:
        payload = valid_payload()
        del payload["pages"]
        message = validate_payload("parsed-paper-v1", payload)
        self.assertIsNotNone(message)
        self.assertIn("pages", message)

    def test_unknown_schema_name_is_an_error_string(self) -> None:
        message = validate_payload("nope-v1", valid_payload())
        self.assertIsNotNone(message)
        self.assertIn("unknown schema", message)

    def test_extra_per_parser_fields_are_allowed(self) -> None:
        payload = valid_payload()
        payload["ocr"] = True
        payload["ocrPagesTruncated"] = 3
        payload["title"] = "A Title"
        self.assertIsNone(validate_payload("parsed-paper-v1", payload))


if __name__ == "__main__":
    unittest.main()
