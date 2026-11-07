import json
from pathlib import Path
import tempfile
from threading import Thread
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from app import create_server


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.TemporaryDirectory()
        cls.server = create_server(Path(cls.folder.name) / "ledger.json", 0)
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"
        cls.thread = Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.folder.cleanup()

    def request(self, path, method="GET", payload=None, headers=None):
        body = json.dumps(payload).encode() if payload is not None else None
        request = Request(self.url + path, data=body, method=method, headers={"Content-Type": "application/json", **(headers or {})})
        try:
            response = urlopen(request, timeout=5)
        except HTTPError as error:
            response = error
        with response:
            return response.status, response.read(), response.headers

    def test_assets_and_private_files(self):
        for path in ["/", "/styles.css", "/app.js", "/favicon.svg"]:
            status, body, headers = self.request(path)
            self.assertEqual(status, 200)
            self.assertTrue(body)
            self.assertIn("nosniff", headers["X-Content-Type-Options"])
        for path in ["/data/ledger.json", "/../app.py", "/app.py"]:
            self.assertEqual(self.request(path)[0], 404)

    def test_http_crud_and_validation(self):
        payload = dict(date="2026-11-07", amount="0.10", kind="expense", category="餐饮", note="<script>alert(1)</script>")
        status, body, _ = self.request("/api/records", "POST", payload)
        self.assertEqual(status, 201)
        record = json.loads(body)
        path = f"/api/records/{record['id']}"
        self.assertEqual(self.request(path, "PUT", {**payload, "amount": "0.20"})[0], 200)
        status, body, _ = self.request("/api/records?min=0.20&max=0.20")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["summary"]["expense_cents"], 20)
        self.assertEqual(self.request("/api/records", "POST", {**payload, "amount": "0"})[0], 400)
        self.assertEqual(self.request("/api/records", "POST", [1, 2])[0], 400)
        self.assertEqual(self.request(path, "DELETE")[0], 200)
        self.assertEqual(self.request(path, "DELETE")[0], 404)

    def test_foreign_origin_and_host_rejected(self):
        self.assertEqual(self.request("/api/records", "POST", {}, {"Origin": "https://other.example"})[0], 403)
        self.assertEqual(self.request("/api/records", headers={"Host": "other.example"})[0], 403)


if __name__ == "__main__":
    unittest.main()
