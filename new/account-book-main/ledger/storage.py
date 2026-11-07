"""JSON 持久化：校验读取、原子替换与外部修改检测。"""

import json
import os
from pathlib import Path
import tempfile

from .models import Record


class StorageError(Exception):
    pass


class JsonStore:
    def __init__(self, path):
        self.path = Path(path).resolve()
        self._snapshot = None

    def load(self):
        try:
            raw = self.path.read_bytes() if self.path.exists() else None
            if raw is None:
                self._snapshot = None
                return []
            data = json.loads(raw.decode("utf-8-sig"))
            if not isinstance(data, dict) or data.get("version") != 1 or not isinstance(data.get("records"), list):
                raise ValueError("不支持的账本格式")
            records = [Record.from_dict(item) for item in data["records"]]
            if len({record.id for record in records}) != len(records):
                raise ValueError("发现重复记录编号")
            self._snapshot = raw
            return records
        except (OSError, UnicodeError, ValueError, TypeError) as exc:
            raise StorageError(f"账本读取失败，原文件已保留：{exc}") from exc

    def save(self, records):
        temporary_path = None
        try:
            current = self.path.read_bytes() if self.path.exists() else None
            if current != self._snapshot:
                raise StorageError("账本文件已被其他程序修改，请重启本程序后再操作")
            raw = (json.dumps({"version": 1, "records": [r.to_dict() for r in records]},
                              ensure_ascii=False, indent=2) + "\n").encode("utf-8")
            self.path.parent.mkdir(parents=True, exist_ok=True)
            # 临时文件和目标文件位于同一目录，写入完整后再原子替换。
            with tempfile.NamedTemporaryFile(dir=self.path.parent, prefix=".ledger-", suffix=".tmp", delete=False) as handle:
                temporary_path = Path(handle.name)
                handle.write(raw)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_path, self.path)
            self._snapshot = raw
        except OSError as exc:
            raise StorageError("保存失败，请检查账本目录的写入权限和磁盘空间") from exc
        finally:
            if temporary_path and temporary_path.exists():
                temporary_path.unlink(missing_ok=True)
