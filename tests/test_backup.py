import csv
from io import StringIO
import json
import os
from pathlib import Path
import tempfile
from threading import Thread
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from app import create_server
from ledger.service import LedgerService
from ledger.storage import BudgetStore, JsonStore, StorageError


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.path = Path(self.folder.name) / "ledger.json"
        self.budget_path = self.path.with_name("budgets.json")
        self.service = LedgerService(JsonStore(self.path), BudgetStore(self.budget_path))
        self.record = self.service.add(dict(date="2026-11-07", kind="expense", category="餐饮",
                                            amount="12.50", note="原账目"))
        self.backup = self.service.export_backup()

    def test_preview_and_invalid_restore_preserve_data(self):
        original = self.path.read_bytes()
        preview = self.service.preview_restore(self.backup)
        self.assertEqual(preview, dict(valid=True, count=1, start="2026-11-07", end="2026-11-07"))
        self.assertEqual(self.path.read_bytes(), original)
        invalid_records = [dict(self.record, amount_cents=-1), dict(self.record, date="2026-02-30"),
                           dict(self.record, category="工资"), dict(self.record, created_at="invalid")]
        invalid_payloads = [[], {"version": 2, "records": []}, {"version": True, "records": []},
                            {"version": 1, "records": [self.record, self.record]},
                            {"version": 1, "records": [{"id": "missing-fields"}]}]
        invalid_payloads += [{"version": 1, "records": [record]} for record in invalid_records]
        for payload in invalid_payloads:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                self.service.restore_backup(payload)
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual(self.service.export_backup(), self.backup)
        self.assertFalse(self.path.with_name("ledger.json.before-restore.bak").exists())

    def test_restore_backup_restart_budget_and_empty_ledger(self):
        self.service.set_budget("2026-11", {"amount": "100"})
        original = self.path.read_bytes()
        replacement = {"version": 1, "records": [dict(self.record, amount_cents=2500, note="恢复后") ]}
        self.service.restore_backup(replacement)
        self.assertEqual(self.path.with_name("ledger.json.before-restore.bak").read_bytes(), original)
        restarted = LedgerService(JsonStore(self.path), BudgetStore(self.budget_path))
        self.assertEqual(restarted.export_backup(), replacement)
        self.assertEqual(restarted.get_budget("2026-11")["remaining_cents"], 7500)
        self.assertEqual(restarted.get_budget("2026-11")["budget_cents"], 10000)
        self.assertEqual(restarted.preview_restore({"version": 1, "records": []}),
                         dict(valid=True, count=0, start=None, end=None))
        restarted.restore_backup({"version": 1, "records": []})
        self.assertEqual(LedgerService(JsonStore(self.path)).query({})["summary"]["count"], 0)

    def test_failed_restore_keeps_disk_and_memory(self):
        original = self.path.read_bytes()
        real_replace = os.replace

        def fail_ledger_replace(source, destination):
            if Path(destination) == self.path:
                raise OSError("simulated write failure")
            return real_replace(source, destination)

        with patch("ledger.storage.os.replace", side_effect=fail_ledger_replace):
            with self.assertRaises(StorageError):
                self.service.restore_backup({"version": 1, "records": []})
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual(self.service.export_backup(), self.backup)
        self.assertEqual(self.path.with_name("ledger.json.before-restore.bak").read_bytes(), original)

    def test_http_large_preview_restore_and_csv_work_together(self):
        server = create_server(self.path, 0)
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"

        def request(path, payload=None):
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
            req = Request(base + path, data=body, headers={"Content-Type": "application/json"})
            try:
                response = urlopen(req, timeout=5)
            except HTTPError as error:
                response = error
            with response:
                return response.status, response.read()

        try:
            large_backup = {"version": 1, "records": [dict(self.record, id=f"restored-{i}", note="字" * 200) for i in range(100)]}
            self.assertGreater(len(json.dumps(large_backup).encode()), 16384)
            original = self.path.read_bytes()
            status, body = request("/api/restore/preview", large_backup)
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body)["count"], 100)
            self.assertEqual(self.path.read_bytes(), original)
            self.assertEqual(request("/api/restore", {"version": 0, "records": []})[0], 400)
            self.assertEqual(self.path.read_bytes(), original)
            self.assertEqual(request("/api/restore", large_backup)[0], 200)
            status, body = request("/api/backup")
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body), large_backup)
            status, body = request("/api/records.csv?kind=expense")
            self.assertEqual(status, 200)
            self.assertEqual(len(list(csv.reader(StringIO(body.decode("utf-8-sig"))))), 101)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
