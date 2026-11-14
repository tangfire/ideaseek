"""Image corpus profiling tests.

The directory-layout case runs anywhere; the parquet cases need pyarrow and
skip without it, matching how the other optional-dependency suites behave.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from ideaseek_worker.images import ImageProfileError, profile_images
from ideaseek_worker.schema_validate import validate_payload

try:
    import pyarrow as pa
    import pyarrow.parquet as pq

    HAS_PYARROW = True
except ImportError:  # pragma: no cover - environment dependent
    HAS_PYARROW = False


def _write_domain_parquet(path: Path, domains: dict[str, int], classes: int = 3) -> None:
    rows_domain: list[str] = []
    rows_label: list[int] = []
    for domain, count in domains.items():
        for index in range(count):
            rows_domain.append(domain)
            rows_label.append(index % classes)
    table = pa.table(
        {
            "image": [{"bytes": b"\x89PNGfake", "path": f"{d}-{i}.png"} for d, i in
                      zip(rows_domain, range(len(rows_domain)))],
            "domain": rows_domain,
            "label": rows_label,
        }
    )
    pq.write_table(table, path)


class DirectoryLayoutTest(unittest.TestCase):
    def test_groups_and_classes_come_from_the_tree_not_from_guesses(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ideaseek-images-") as tmp:
            root = Path(tmp)
            for domain, size in (("photo", 4), ("sketch", 2)):
                for label in ("cat", "dog"):
                    folder = root / domain / label
                    folder.mkdir(parents=True)
                    for index in range(size):
                        (folder / f"{index}.jpg").write_bytes(b"\xff\xd8fake")
            profile = profile_images(root)

        self.assertEqual(profile["source"]["format"], "image-dir")
        self.assertEqual(profile["samples"], 12)
        self.assertEqual(profile["grouping"]["column"], "directory:level-1")
        counts = {item["name"]: item["count"] for item in profile["grouping"]["values"]}
        self.assertEqual(counts, {"photo": 8, "sketch": 4})
        self.assertEqual(profile["classes"]["distinct"], 2)
        self.assertTrue(any("leave-one-group-out" in rule for rule in profile["splitRules"]))
        self.assertIsNone(validate_payload("image-profile-v1", profile))

    def test_flat_class_layout_reports_no_domain_axis(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ideaseek-images-") as tmp:
            root = Path(tmp)
            for label in ("cat", "dog"):
                folder = root / label
                folder.mkdir()
                (folder / "0.jpg").write_bytes(b"\xff\xd8fake")
            profile = profile_images(root)
        self.assertIsNone(profile["grouping"]["column"])
        self.assertEqual(profile["splitRules"], [])
        self.assertTrue(any("no domain axis" in warning for warning in profile["warnings"]))

    def test_empty_input_fails_loudly(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ideaseek-images-") as tmp:
            with self.assertRaises(ImageProfileError):
                profile_images(Path(tmp))


@unittest.skipUnless(HAS_PYARROW, "pyarrow not installed")
class ParquetTest(unittest.TestCase):
    def test_domain_column_drives_grouping_and_split_rules(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ideaseek-images-") as tmp:
            path = Path(tmp) / "pacs.parquet"
            _write_domain_parquet(path, {"photo": 6, "art": 3, "sketch": 9})
            profile = profile_images(path)

        self.assertEqual(profile["source"]["format"], "parquet")
        self.assertEqual(profile["samples"], 18)
        self.assertEqual(profile["grouping"]["column"], "domain")
        counts = {item["name"]: item["count"] for item in profile["grouping"]["values"]}
        self.assertEqual(counts, {"sketch": 9, "photo": 6, "art": 3})
        self.assertEqual(profile["classes"]["column"], "label")
        self.assertEqual(profile["classes"]["distinct"], 3)
        self.assertIn("leave-one-group-out over domain: 3 groups", profile["splitRules"][0])
        self.assertIn("one federated client per domain value (3 clients)", profile["splitRules"][1])
        self.assertIsNone(validate_payload("image-profile-v1", profile))

    def test_shards_aggregate_into_one_corpus(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ideaseek-images-") as tmp:
            root = Path(tmp)
            _write_domain_parquet(root / "train-00000-of-00002.parquet", {"photo": 4})
            _write_domain_parquet(root / "train-00001-of-00002.parquet", {"photo": 3, "art": 2})
            profile = profile_images(root)

        self.assertEqual(profile["source"]["format"], "parquet-shards")
        self.assertEqual(profile["samples"], 9)
        counts = {item["name"]: item["count"] for item in profile["grouping"]["values"]}
        self.assertEqual(counts, {"photo": 7, "art": 2})
        self.assertIsNone(validate_payload("image-profile-v1", profile))

    def test_parquet_without_a_domain_axis_warns_instead_of_inventing_one(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ideaseek-images-") as tmp:
            path = Path(tmp) / "plain.parquet"
            pq.write_table(pa.table({"value": [1, 2, 3]}), path)
            profile = profile_images(path)
        self.assertIsNone(profile["grouping"]["column"])
        self.assertEqual(profile["splitRules"], [])
        self.assertTrue(
            any("no grouping column" in warning for warning in profile["warnings"]),
            json.dumps(profile["warnings"]),
        )


if __name__ == "__main__":
    unittest.main()
