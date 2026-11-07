import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from ledger.models import parse_amount
from ledger.service import LedgerService
from ledger.storage import JsonStore, StorageError


def payload(amount="12.50", kind="expense", category="餐饮", date="2026-11-07", note="午餐"):
    return dict(amount=amount, kind=kind, category=category, date=date, note=note)


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.path = Path(self.folder.name) / "ledger.json"
        self.service = LedgerService(JsonStore(self.path))

    def test_money_precision_and_invalid_inputs(self):
        self.assertEqual(parse_amount("0.10") + parse_amount("0.20"), 30)
        self.assertEqual(parse_amount("9999999999.99"), 999999999999)
        for amount in ["0", "-1", "1.001", "NaN", "Infinity", "bad", "10000000000", True, None, [], "1e999999"]:
            with self.subTest(amount=amount), self.assertRaises(ValueError):
                parse_amount(amount)

    def test_add_edit_delete_survive_restart(self):
        record = self.service.add(payload(note="中文备注"))
        reloaded = LedgerService(JsonStore(self.path))
        self.assertEqual(reloaded.query({})["records"][0], record)
        updated = reloaded.edit(record["id"], payload("100.25", "income", "工资"))
        self.assertEqual(updated["id"], record["id"])
        self.assertEqual(updated["created_at"], record["created_at"])
        self.assertEqual(LedgerService(JsonStore(self.path)).query({})["summary"]["income_cents"], 10025)
        reloaded.delete(record["id"])
        self.assertEqual(LedgerService(JsonStore(self.path)).query({})["records"], [])

    def test_filters_inclusive_and_summary_consistent(self):
        self.service.add(payload("10.00", date="2026-11-01", note="早餐"))
        self.service.add(payload("20.00", date="2026-11-07", note="午餐"))
        self.service.add(payload("5.00", category="交通", date="2026-10-31", note="公交"))
        self.service.add(payload("100.00", "income", "工资", date="2026-11-07"))
        result = self.service.query({"start": "2026-11-01", "end": "2026-11-07", "kind": "expense", "category": "餐饮", "min": "10", "max": "20"})
        self.assertEqual(result["summary"], dict(income_cents=0, expense_cents=3000, balance_cents=-3000, count=2))
        self.assertEqual([r["date"] for r in result["records"]], ["2026-11-07", "2026-11-01"])
        self.assertEqual(result["expense_categories"], [{"category": "餐饮", "amount_cents": 3000}])
        self.assertEqual(self.service.query({"q": "早餐"})["summary"]["count"], 1)
        self.assertEqual(self.service.query({"max": "0"})["summary"]["count"], 0)
        self.assertEqual(self.service.query({})["summary"]["balance_cents"], 6500)

    def test_bad_records_and_ranges_do_not_modify_data(self):
        for fields in [{"amount": "-3"}, {"date": "2026-02-30"}, {"date": "20261107"}, {"category": "工资"}, {"note": "字" * 201}, {"kind": "invalid"}]:
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                self.service.add({**payload(), **fields})
        for filters in [{"start": "2026-11-08", "end": "2026-11-01"}, {"min": "10", "max": "1"}, {"kind": "invalid"}, {"category": "invalid"}]:
            with self.subTest(filters=filters), self.assertRaises(ValueError):
                self.service.query(filters)
        self.assertFalse(self.path.exists())

    def test_corrupted_file_preserved(self):
        raw = b'{"version": 1, broken'
        self.path.write_bytes(raw)
        with self.assertRaises(StorageError):
            LedgerService(JsonStore(self.path))
        self.assertEqual(self.path.read_bytes(), raw)

    def test_duplicate_ids_rejected(self):
        record = self.service.add(payload())
        self.path.write_text(json.dumps({"version": 1, "records": [record, record]}), encoding="utf-8")
        with self.assertRaises(StorageError):
            LedgerService(JsonStore(self.path))

    def test_failed_save_preserves_disk_and_memory(self):
        self.service.add(payload())
        original = self.path.read_bytes()
        with patch("ledger.storage.os.replace", side_effect=OSError("disk failure")):
            with self.assertRaises(StorageError):
                self.service.add(payload("20"))
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual(self.service.query({})["summary"]["count"], 1)
        self.assertEqual(list(self.path.parent.glob(".ledger-*.tmp")), [])

    def test_external_changes_not_overwritten(self):
        self.service.add(payload())
        other = LedgerService(JsonStore(self.path))
        other.add(payload("99"))
        original = self.path.read_bytes()
        with self.assertRaises(StorageError):
            self.service.add(payload("20"))
        self.assertEqual(self.path.read_bytes(), original)

    def test_missing_record(self):
        with self.assertRaises(KeyError):
            self.service.delete("missing")
        with self.assertRaises(KeyError):
            self.service.edit("missing", payload())


if __name__ == "__main__":
    unittest.main()
