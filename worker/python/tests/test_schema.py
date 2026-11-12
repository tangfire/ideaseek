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

    def test_dataset_profile_valid_passes(self) -> None:
        profile = {
            "parser": "ideaseek-fedpf-1",
            "root": "/data/x",
            "splits": {
                "train": {
                    "dir": "train",
                    "clients": [
                        {
                            "id": "f_1",
                            "file": "train/f_1.npz",
                            "samples": 10,
                            "xShape": [10, 1, 28, 28],
                            "xDtype": "float32",
                            "yShape": [10],
                            "yDtype": "int64",
                            "labelCounts": {"0": 5, "1": 5},
                        }
                    ],
                    "clientCount": 1,
                    "totalSamples": 10,
                    "sampleStats": {"min": 10, "max": 10, "mean": 10.0, "std": 0.0},
                    "labelDistribution": {"0": 5, "1": 5},
                }
            },
            "clientCount": 1,
            "nonIid": {
                "tvDistanceMean": 0.2,
                "tvDistanceMax": 0.3,
                "samplesCv": 0.0,
                "classesPerClientMean": 2.0,
                "interpretation": "non-IID",
            },
            "files": [
                {"rel": "train/f_1.npz", "bytes": 8, "sha256": "sha256:" + "a" * 64}
            ],
            "fileCount": 1,
            "rootHash": "sha256:" + "b" * 64,
            "readOnly": {
                "rootWritableByProcess": False,
                "sampleWritableByProcess": False,
                "policy": "read-only",
            },
        }
        self.assertIsNone(validate_payload("dataset-profile-v1", profile))

    def test_dataset_profile_bad_root_hash_rejected(self) -> None:
        profile = {
            "parser": "p",
            "root": "/r",
            "splits": {"train": {"dir": "train", "clients": [], "clientCount": 0,
                                  "totalSamples": 0,
                                  "sampleStats": {"min": 0, "max": 0, "mean": 0.0, "std": 0.0},
                                  "labelDistribution": {}}},
            "clientCount": 0,
            "nonIid": {"tvDistanceMean": 0.0, "tvDistanceMax": 0.0, "samplesCv": 0.0,
                       "classesPerClientMean": 0.0, "interpretation": "x"},
            "files": [],
            "fileCount": 0,
            "rootHash": "nope",
            "readOnly": {"rootWritableByProcess": False, "sampleWritableByProcess": False,
                         "policy": "p"},
        }
        message = validate_payload("dataset-profile-v1", profile)
        self.assertIsNotNone(message)
        self.assertIn("/rootHash", message)

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
