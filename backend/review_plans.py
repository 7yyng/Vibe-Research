"""每日复盘计划存储模块。

用户每天提交的复盘计划（文字），和情绪温度校准一样每天保存一份。
AI 复盘时读取历史计划，学习用户的复盘思路和关注点。
"""

import json, os
from datetime import datetime, timezone, timedelta

BEIJING = timezone(timedelta(hours=8))
_DATA_FILE = os.path.join(os.path.dirname(__file__), "review_plans_history.json")

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

def save_review_plan(date: str, plan_text: str, tags: list[str] = None) -> dict:
    """保存每日复盘计划。"""
    data = _load()
    records = data.setdefault("records", [])
    # 替换同日期记录
    records = [r for r in records if r.get("date") != date]
    records.append({
        "date": date,
        "plan_text": plan_text,
        "tags": tags or [],
        "saved_at": datetime.now(BEIJING).strftime("%Y-%m-%d %H:%M"),
    })
    records.sort(key=lambda r: r["date"], reverse=True)
    data["records"] = records[:90]
    _save(data)
    return {"ok": True, "date": date}

def get_review_plans(limit: int = 30) -> dict:
    """获取复盘计划历史。"""
    data = _load()
    records = data.get("records", [])
    return {"plans": records[:limit], "total": len(records)}

def get_latest_review_plan() -> dict:
    """获取最新一份复盘计划（供AI复盘认知用）。"""
    data = _load()
    records = data.get("records", [])
    if records:
        return records[0]
    return {}

def get_review_plans_for_ai() -> dict:
    """获取最近N份复盘计划，供AI学习用户复盘思路。

    返回格式包含所有文字内容，AI可以分析用户的：
    - 关注维度（情绪/资金/题材/个股）
    - 复盘结构（先大盘后个股/先情绪后资金）
    - 常用术语和表达方式
    """
    data = _load()
    records = data.get("records", [])
    return {
        "recent_plans": records[:10],
        "total": len(records),
        "user_style_summary": _build_style_summary(records[:20]),
    }

def _build_style_summary(plans: list[dict]) -> str:
    """从历史计划中提取用户复盘风格摘要。"""
    if not plans:
        return ""
    all_text = " ".join(p.get("plan_text", "") for p in plans)
    # 基础统计
    avg_len = len(all_text) / len(plans)
    all_tags = []
    for p in plans:
        all_tags.extend(p.get("tags", []))
    tag_counts = {}
    for t in all_tags:
        tag_counts[t] = tag_counts.get(t, 0) + 1
    top_tags = sorted(tag_counts.items(), key=lambda x: x[1], reverse=True)[:10]

    summary = f"平均复盘长度: {avg_len:.0f}字\n"
    summary += f"历史复盘次数: {len(plans)}\n"
    if top_tags:
        summary += "常用标签: " + ", ".join(f"{t[0]}({t[1]}次)" for t in top_tags)
    return summary
