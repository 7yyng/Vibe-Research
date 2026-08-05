"""AI 盘面研判存储模块。

每天自动生成的 AI 研判结果存储在此，支持：
- 按日期读取/保存/编辑
- 对话调教记录（用户与AI的多轮对话）
- 用户修正版本（在AI生成基础上手动修改）
"""

import json, os
from datetime import datetime, timezone, timedelta

BEIJING = timezone(timedelta(hours=8))
_DATA_FILE = os.path.join(os.path.dirname(__file__), "ai_reviews_history.json")


def _load() -> dict:
    if os.path.exists(_DATA_FILE):
        try:
            with open(_DATA_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"records": []}


def _save(data: dict):
    try:
        with open(_DATA_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def save_ai_review(date: str, focus: dict, raw_text: str = "", source: str = "auto") -> dict:
    """保存AI盘面研判结果。

    Args:
        date: 交易日日期 YYYY-MM-DD
        focus: 结构化研判数据（emotion_phase/focus_directions/risk_alerts等）
        raw_text: AI原始输出文本
        source: auto=自动生成, manual=手动触发, edited=用户编辑过
    """
    data = _load()
    records = data.setdefault("records", [])

    # 查找同日期记录，保留对话历史
    existing = None
    for r in records:
        if r.get("date") == date:
            existing = r
            break

    record = {
        "date": date,
        "focus": focus,
        "raw_text": raw_text,
        "source": source,
        "edited_text": existing.get("edited_text", "") if existing else "",
        "chat_history": existing.get("chat_history", []) if existing else [],
        "generated_at": datetime.now(BEIJING).strftime("%Y-%m-%d %H:%M"),
    }

    if existing:
        records = [r for r in records if r.get("date") != date]
    records.append(record)
    records.sort(key=lambda r: r["date"], reverse=True)
    data["records"] = records[:90]
    _save(data)
    return {"ok": True, "date": date}


def get_ai_review(date: str | None = None) -> dict:
    """获取某天的AI研判。date=None 返回最新一份。"""
    data = _load()
    records = data.get("records", [])
    if date:
        for r in records:
            if r.get("date") == date:
                return r
        return {}
    if records:
        return records[0]
    return {}


def get_ai_reviews(limit: int = 30) -> dict:
    """获取AI研判历史列表。"""
    data = _load()
    records = data.get("records", [])
    return {"reviews": records[:limit], "total": len(records)}


def update_edited_text(date: str, edited_text: str) -> dict:
    """用户手动编辑研判内容。"""
    data = _load()
    records = data.get("records", [])
    for r in records:
        if r.get("date") == date:
            r["edited_text"] = edited_text
            r["source"] = "edited"
            r["edited_at"] = datetime.now(BEIJING).strftime("%Y-%m-%d %H:%M")
            _save(data)
            return {"ok": True, "date": date}
    return {"ok": False, "reason": "未找到该日期的研判记录"}


def add_chat_message(date: str, role: str, content: str) -> dict:
    """添加对话调教消息到指定日期的研判记录。

    Args:
        date: 关联的交易日
        role: user/assistant
        content: 消息内容
    """
    data = _load()
    records = data.get("records", [])

    # 找到或创建记录
    target = None
    for r in records:
        if r.get("date") == date:
            target = r
            break

    if not target:
        # 没有研判记录时创建一个空壳，方便对话先行
        target = {
            "date": date,
            "focus": None,
            "raw_text": "",
            "source": "chat",
            "edited_text": "",
            "chat_history": [],
            "generated_at": datetime.now(BEIJING).strftime("%Y-%m-%d %H:%M"),
        }
        records.append(target)
        records.sort(key=lambda r: r["date"], reverse=True)

    chat = target.setdefault("chat_history", [])
    chat.append({
        "role": role,
        "content": content,
        "ts": datetime.now(BEIJING).strftime("%H:%M:%S"),
    })
    # 最多保留100条对话
    if len(chat) > 100:
        target["chat_history"] = chat[-100:]

    data["records"] = records[:90]
    _save(data)
    return {"ok": True, "date": date}


def get_chat_history(date: str) -> list:
    """获取某天的对话调教历史。"""
    review = get_ai_review(date)
    return review.get("chat_history", []) if review else []
