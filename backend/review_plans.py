"""每日复盘计划存储模块。

用户每天提交的复盘计划（文字），和情绪温度校准一样每天保存一份。
AI 复盘时读取历史计划，学习用户的复盘思路和关注点。
保存时自动提取关键词标签。
"""

import json, os, re
from datetime import datetime, timezone, timedelta

BEIJING = timezone(timedelta(hours=8))
_DATA_FILE = os.path.join(os.path.dirname(__file__), "review_plans_history.json")
_PREF_FILE = os.path.join(os.path.dirname(__file__), "keyword_preferences.json")

# ── 关键词提取规则 ──

# 情绪相关关键词
_EMOTION_KEYWORDS = {
    "情绪高潮", "情绪冰点", "情绪修复", "情绪发酵", "情绪退潮", "情绪亢奋",
    "高潮", "冰点", "发酵", "退潮", "亢奋", "修复",
    "分歧", "一致", "分歧预期", "弱分歧", "强分歧",
    "去弱留强", "观察日", "试错", "格局", "止损",
}

# 板块/题材关键词（常见A股板块）
_SECTOR_KEYWORDS = {
    "AI应用", "AI算力", "算力", "电力", "电网设备", "创新药", "医药", "消费",
    "机器人", "核电", "商航", "芯片", "半导体", "科技", "化工", "军工",
    "光伏", "新能源", "储能", "汽车", "房地产", "金融", "证券", "银行",
    "煤炭", "有色", "钢铁", "石油", "农业", "教育", "传媒", "游戏",
    "股权", "脑机", "交换机", "光模块", "液冷", "PCB", "广告营销",
}

# 操作策略关键词
_STRATEGY_KEYWORDS = {
    "打板", "首板", "连板", "反包", "低吸", "追高", "顶一字", "半路",
    "做T", "分批", "梭哈", "试错", "空仓", "减仓", "加仓",
    "挡刀", "悟道板", "T字板", "一字板", "换手板", "地天板",
}

# 连板梯队描述（如 7321、5321 等）
_LADDER_PATTERN = re.compile(r'\b[1-9][0-9]{0,3}(?=[\s,，])')

# 情绪温度范围（如 50-80、60到70）
_TEMP_PATTERN = re.compile(r'(\d{2,3})\s*[-到~]\s*(\d{2,3})')


def _extract_keywords(text: str) -> list[str]:
    """从复盘计划文本中自动提取关键词标签。

    提取维度：
    1. 情绪关键词（高潮/分歧/退潮等）
    2. 板块/题材（AI应用/电力/机器人等）
    3. 操作策略（打板/低吸/去弱留强等）
    4. 连板梯队描述（7321等）
    5. 情绪温度范围（50-80等）
    6. 个股名称（从【】或特定格式中提取）
    """
    if not text:
        return []

    found = set()

    # 1. 情绪关键词
    for kw in _EMOTION_KEYWORDS:
        if kw in text:
            found.add(kw)

    # 2. 板块/题材
    for kw in _SECTOR_KEYWORDS:
        if kw in text:
            found.add(kw)

    # 3. 操作策略
    for kw in _STRATEGY_KEYWORDS:
        if kw in text:
            found.add(kw)

    # 4. 连板梯队（如 7321）
    for m in _LADDER_PATTERN.finditer(text):
        num = m.group()
        if len(num) >= 2 and num.isdigit():
            n = int(num)
            if 10 <= n <= 9999:
                found.add(f"梯队{num}")

    # 5. 情绪温度范围
    for m in _TEMP_PATTERN.finditer(text):
        lo, hi = int(m.group(1)), int(m.group(2))
        if 0 <= lo <= 100 and 0 <= hi <= 100 and lo < hi:
            found.add(f"{lo}-{hi}")

    # 6. 从【】中提取个股或板块名（排除结构性标题）
    _BRACKET_EXCLUDE = {"盘面", "复盘", "计划", "预期", "操作反思", "辨识度总结",
                        "连板总结", "多方三炮", "空方三炮", "最强板块", "计划"}
    bracket_items = re.findall(r'【([^】]+)】', text)
    for item in bracket_items:
        item = item.strip()
        if 2 <= len(item) <= 10 and item not in _BRACKET_EXCLUDE:
            found.add(item)

    # 去掉过于宽泛的词
    found.discard("科技") if text.count("科技") > 3 else None

    # 应用用户排除的关键词（模仿学习：用户删过的不再提取）
    excludes = _get_keyword_excludes()
    found = found - excludes

    return sorted(found)


# ── 关键词偏好（用户排除/学习） ──

def _load_prefs() -> dict:
    """加载用户关键词偏好。"""
    if os.path.exists(_PREF_FILE):
        try:
            with open(_PREF_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"excludes": [], "user_added": []}


def _save_prefs(data: dict):
    try:
        with open(_PREF_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def _get_keyword_excludes() -> set:
    """获取用户排除的关键词集合。"""
    return set(_load_prefs().get("excludes", []))


def add_keyword_exclude(keyword: str) -> dict:
    """用户删除了一个自动提取的标签 → 加入排除列表，未来不再提取。"""
    keyword = keyword.strip().rstrip("*")
    if not keyword:
        return {"ok": False}
    prefs = _load_prefs()
    excludes = prefs.setdefault("excludes", [])
    if keyword not in excludes:
        excludes.append(keyword)
    _save_prefs(prefs)
    return {"ok": True, "keyword": keyword, "total_excludes": len(excludes)}


def remove_keyword_exclude(keyword: str) -> dict:
    """恢复一个被排除的关键词。"""
    keyword = keyword.strip()
    prefs = _load_prefs()
    prefs["excludes"] = [k for k in prefs.get("excludes", []) if k != keyword]
    _save_prefs(prefs)
    return {"ok": True}


def get_keyword_preferences() -> dict:
    """获取用户关键词偏好（排除列表 + 学习统计）。"""
    prefs = _load_prefs()
    excludes = prefs.get("excludes", [])
    user_added = prefs.get("user_added", [])
    return {
        "excludes": excludes,
        "user_added": user_added,
        "exclude_count": len(excludes),
    }


def remove_tag_from_plan(date: str, tag: str, exclude: bool = True) -> dict:
    """从指定日期的复盘计划中删除一个标签。

    Args:
        date: 计划日期
        tag: 要删除的标签
        exclude: 是否同时加入排除列表（默认True，AI学习用户不想要这个标签）
    """
    data = _load()
    records = data.get("records", [])
    for r in records:
        if r.get("date") == date:
            tags = r.get("tags", [])
            auto_tags = r.get("auto_tags", [])
            # 从 tags 中移除
            if tag in tags:
                r["tags"] = [t for t in tags if t != tag]
            # 从 auto_tags 中移除
            if tag in auto_tags:
                r["auto_tags"] = [t for t in auto_tags if t != tag]
            _save(data)
            # 加入排除列表
            if exclude:
                add_keyword_exclude(tag)
            return {"ok": True, "date": date, "tags": r["tags"], "auto_tags": r["auto_tags"]}
    return {"ok": False, "reason": "未找到该日期的复盘计划"}

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
    """保存每日复盘计划，自动提取关键词标签。

    重要：同一日期只保留最新一版，旧记录被覆盖。
    """
    data = _load()
    records = data.setdefault("records", [])
    # 同一天只保留最新上传的版本：先移除所有同日期记录
    records = [r for r in records if r.get("date") != date]
    # 安全网：如果数据文件中存在重复日期，只保留最新一条
    seen = set()
    records = [r for r in records if r.get("date") not in seen and not seen.add(r.get("date"))]

    # 自动提取关键词 + 合并用户手动输入的标签
    auto_tags = _extract_keywords(plan_text)
    user_tags = tags or []
    # 合并去重，用户手动输入的优先排在前面
    merged_tags = list(dict.fromkeys(user_tags + auto_tags))

    records.append({
        "date": date,
        "plan_text": plan_text,
        "tags": merged_tags,
        "auto_tags": auto_tags,
        "user_tags": user_tags,
        "saved_at": datetime.now(BEIJING).strftime("%Y-%m-%d %H:%M"),
    })
    records.sort(key=lambda r: r["date"], reverse=True)
    data["records"] = records[:90]
    _save(data)
    prefs = get_keyword_preferences()
    return {
        "ok": True, "date": date, "tags": merged_tags,
        "auto_tags": auto_tags, "user_tags": user_tags,
        "exclude_count": prefs["exclude_count"],
    }

def get_review_plans(limit: int = 30) -> dict:
    """获取复盘计划历史。"""
    data = _load()
    records = data.get("records", [])
    return {"plans": records[:limit], "total": len(records)}

def get_latest_review_plan(date: str | None = None) -> dict:
    """获取最新一份复盘计划（供AI复盘认知用）。指定 date 时返回该日期的计划。"""
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
