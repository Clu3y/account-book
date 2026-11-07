"""记录模型与输入校验。所有金额使用整数分存储。"""

from dataclasses import asdict, dataclass
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from uuid import uuid4


CATEGORIES = {
    "expense": ["餐饮", "交通", "购物", "居住", "娱乐", "医疗", "学习", "其他支出"],
    "income": ["工资", "奖金", "兼职", "理财", "红包", "其他收入"],
}
MAX_CENTS = 999_999_999_999


def parse_date(value, label="日期"):
    if not isinstance(value, str):
        raise ValueError(f"{label}格式应为 YYYY-MM-DD")
    try:
        result = date.fromisoformat(value)
        if result.isoformat() != value:
            raise ValueError
        return result
    except ValueError:
        raise ValueError(f"{label}格式应为 YYYY-MM-DD，且必须是真实日期") from None


def parse_amount(value, allow_zero=False):
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise ValueError("请输入正确的金额")
    try:
        amount = Decimal(str(value).strip())
        if not amount.is_finite() or amount < 0 or amount > Decimal(MAX_CENTS) / 100:
            raise ValueError("金额应在 0.01 至 9,999,999,999.99 元之间")
        cents = amount * 100
        if cents != cents.to_integral_value():
            raise ValueError("金额最多保留两位小数")
        if cents == 0 and not allow_zero:
            raise ValueError("金额必须大于 0")
        return int(cents)
    except (InvalidOperation, OverflowError):
        raise ValueError("请输入正确的金额") from None


@dataclass(frozen=True)
class Record:
    id: str
    date: str
    kind: str
    amount_cents: int
    category: str
    note: str
    created_at: str

    @classmethod
    def create(cls, payload, existing=None):
        if not isinstance(payload, dict):
            raise ValueError("记录内容必须是 JSON 对象")
        kind = payload.get("kind")
        if kind not in ("income", "expense"):
            raise ValueError("请选择收入或支出")
        category = payload.get("category")
        if category not in CATEGORIES[kind]:
            raise ValueError("请选择与收支类型对应的类别")
        record_date = parse_date(payload.get("date")).isoformat()
        amount_cents = parse_amount(payload.get("amount"))
        note = payload.get("note", "")
        if not isinstance(note, str) or len(note.strip()) > 200:
            raise ValueError("备注不能超过 200 字")
        return cls(
            id=existing.id if existing else str(uuid4()),
            date=record_date, kind=kind, amount_cents=amount_cents,
            category=category, note=note.strip(),
            created_at=existing.created_at if existing else datetime.now().isoformat(timespec="microseconds"),
        )

    @classmethod
    def from_dict(cls, payload):
        if not isinstance(payload, dict):
            raise ValueError("记录格式错误")
        cents = payload.get("amount_cents")
        if type(cents) is not int or not 0 < cents <= MAX_CENTS:
            raise ValueError("存储金额必须是合法的整数分")
        result = cls.create({**payload, "amount": str(Decimal(cents) / 100)})
        record_id = payload.get("id")
        created_at = payload.get("created_at")
        if not isinstance(record_id, str) or not record_id or len(record_id) > 100:
            raise ValueError("记录编号错误")
        if not isinstance(created_at, str):
            raise ValueError("创建时间错误")
        datetime.fromisoformat(created_at)
        return cls(record_id, result.date, result.kind, cents, result.category, result.note, created_at)

    def to_dict(self):
        return asdict(self)
