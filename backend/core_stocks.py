"""每日核心标的系统 —— 多方/空方各选最有特点的几只，用于对比市场情绪。

设计理念（游资心法）：
  每天最核心的几个标的，是市场情绪的"温度计"。
  多方标的：强的能否更强（连板龙头、首板强势、放量突破）
  空方标的：弱的持续弱还是反转（炸板、跌停、补跌）

系统每天自动选出3只多方+3只空方（可多可少），用户可校准增删。
校准数据存本地 JSON（core_stocks_history.json），与情绪温度校准机制平行。

选股维度（多维度多角度选最有特点的）：
  多方：
    1. 连板龙头（最高连板，市场情绪风向标）
    2. 首板强势（一字板/秒板+大成交额，新晋强势）
    3. 放量突破（成交额Top中的涨停股，资金共识）
  空方：
    1. 炸板王（炸板次数最多，多头溃败）
    2. 跌停封死（封单最大，空头最猛）
    3. 强股补跌（昨涨停今天跌幅最大，情绪退潮信号）
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone, timedelta

import market

BEIJING = timezone(timedelta(hours=8))
_DATA_FILE = os.path.join(os.path.dirname(__file__), "core_stocks_history.json")


def _load_history() -> dict:
    if os.path.exists(_DATA_FILE):
        try:
            with open(_DATA_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"records": [], "system_history": []}


def _save_history(data: dict):
    try:
        with open(_DATA_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def _pick_bulls(emo: dict, turnover_stocks: list[dict]) -> list[dict]:
    """选多方核心标的（最多3只，多维度选最有特点的）。

    维度1：连板龙头 —— 最高连板数，市场情绪风向标
    维度2：首板强势 —— 一字板/秒板 + 大成交额，新晋强势
    维度3：放量突破 —— 成交额Top中的涨停股，资金共识
    """
    bulls: list[dict] = []
    seen_codes: set[str] = set()

    lianban = emo.get("lianban_stocks", [])
    shouban = emo.get("shouban_stocks", [])

    # ── 维度1：连板龙头（最高连板）──
    if lianban:
        top = lianban[0]  # 已按(-boards, last_seal_time)排序
        bulls.append({
            "code": top["code"], "name": top["name"],
            "dimension": "连板龙头",
            "reason": f"{top['boards']}板连板，最高板标的，市场情绪风向标",
            "price": top.get("price", 0),
            "pct": top.get("pct", 0),
            "amount": top.get("amount", 0),
            "industry": top.get("industry", ""),
            "pattern": top.get("pattern", ""),
            "boards": top.get("boards", 1),
        })
        seen_codes.add(top["code"])

    # ── 维度2：首板强势（一字板/秒板 + 大成交额）──
    strong_shouban = [s for s in shouban if s.get("pattern") in ("一字板", "T字板", "秒板")]
    if strong_shouban:
        # 按成交额排序，取最大的一只
        strong_shouban.sort(key=lambda x: x.get("amount", 0) or 0, reverse=True)
        for s in strong_shouban:
            if s["code"] not in seen_codes:
                bulls.append({
                    "code": s["code"], "name": s["name"],
                    "dimension": "首板强势",
                    "reason": f"{s.get('pattern', '首板')}，成交额{yi_short(s.get('amount', 0))}，新晋强势封板",
                    "price": s.get("price", 0),
                    "pct": s.get("pct", 0),
                    "amount": s.get("amount", 0),
                    "industry": s.get("industry", ""),
                    "pattern": s.get("pattern", ""),
                    "boards": 1,
                })
                seen_codes.add(s["code"])
                break

    # ── 维度3：放量突破（成交额Top中的涨停股）──
    if turnover_stocks:
        zt_codes = {s["code"] for s in (lianban + shouban)}
        for t in turnover_stocks[:20]:  # Top20里找
            code = str(t.get("code", ""))
            if code in zt_codes and code not in seen_codes and (t.get("pct") or 0) > 0:
                bulls.append({
                    "code": code, "name": t.get("name", ""),
                    "dimension": "放量突破",
                    "reason": f"成交额{yi_short(t.get('amount', 0))}，涨幅{t.get('pct', 0):.2f}%，资金共识放量",
                    "price": t.get("price") or 0,
                    "pct": t.get("pct") or 0,
                    "amount": t.get("amount") or 0,
                    "industry": t.get("industry", ""),
                    "pattern": "",
                    "boards": 1,
                })
                seen_codes.add(code)
                break

    return bulls[:3]  # 最多3只


def _pick_bears(emo: dict, exclude_codes: set[str] | None = None) -> list[dict]:
    """选空方核心标的（最多3只，多维度选最有特点的）。

    维度1：炸板王 —— 炸板次数最多（炸板后未封住，多头溃败）
    维度2：弱股持续弱 —— 5日跌幅Top里今天继续跌最狠的
    维度3：强股补跌 —— 涨停后回落（封板失败转弱）

    exclude_codes: 多方已选的股票code，不在空方重复出现
    """
    bears: list[dict] = []
    seen_codes: set[str] = set(exclude_codes or [])

    all_zt = emo.get("lianban_stocks", []) + emo.get("shouban_stocks", [])

    # ── 维度1：炸板王（炸板次数最多，且最终封住的——反复炸板说明抛压极重）──
    break_kings = [s for s in all_zt if (s.get("break_count") or 0) >= 2 and s["code"] not in seen_codes]
    break_kings.sort(key=lambda x: x.get("break_count", 0), reverse=True)
    if break_kings:
        b = break_kings[0]
        bears.append({
            "code": b["code"], "name": b["name"],
            "dimension": "炸板王",
            "reason": f"炸板{b.get('break_count', 0)}次后封住，多头反复溃败，抛压极重",
            "price": b.get("price", 0),
            "pct": b.get("pct", 0),
            "amount": b.get("amount", 0),
            "industry": b.get("industry", ""),
            "pattern": b.get("pattern", ""),
            "boards": b.get("boards", 1),
        })
        seen_codes.add(b["code"])

    # ── 维度2：弱股持续弱（5日跌幅Top里今天继续跌最狠的）──
    import astock
    try:
        extreme = astock.extreme_movers("5d", 10)
        losers = extreme.get("losers", [])
        if losers:
            losers_today = sorted(losers, key=lambda x: x.get("today_pct", 0))
            for l in losers_today:
                if l["code"] not in seen_codes and (l.get("today_pct", 0) < -5):
                    bears.append({
                        "code": l["code"], "name": l["name"],
                        "dimension": "弱股持续弱",
                        "reason": f"5日跌{l.get('period_pct', 0):.1f}%，今日续跌{l.get('today_pct', 0):.1f}%，弱股持续弱",
                        "price": 0,
                        "pct": l.get("today_pct", 0),
                        "amount": 0,
                        "industry": "",
                        "pattern": "",
                        "boards": 0,
                    })
                    seen_codes.add(l["code"])
                    break
    except Exception:
        pass

    # ── 维度3：强股补跌（涨停后回落的，封板失败转弱）──
    fell_from_zt = [s for s in all_zt if (s.get("pct", 0) < 0) and s["code"] not in seen_codes]
    fell_from_zt.sort(key=lambda x: x.get("pct", 0))
    for s in fell_from_zt:
        if s["code"] not in seen_codes:
            bears.append({
                "code": s["code"], "name": s["name"],
                "dimension": "强股补跌",
                "reason": f"涨停后回落{s.get('pct', 0):.1f}%，封板失败转弱",
                "price": s.get("price", 0),
                "pct": s.get("pct", 0),
                "amount": s.get("amount", 0),
                "industry": s.get("industry", ""),
                "pattern": s.get("pattern", ""),
                "boards": s.get("boards", 1),
            })
            seen_codes.add(s["code"])
            break

    # ── 补充维度：跌停家数多时，从跌停池选封单最大的 ──
    if len(bears) < 3:
        dt_count = emo.get("dt_count", 0)
        if dt_count > 0 and len(bears) < 3:
            # 没有跌停池明细，用extreme_movers的losers补充
            try:
                extreme = astock.extreme_movers("5d", 10)
                losers = extreme.get("losers", [])
                for l in losers:
                    if l["code"] not in seen_codes and len(bears) < 3:
                        bears.append({
                            "code": l["code"], "name": l["name"],
                            "dimension": "极端弱势",
                            "reason": f"5日跌{l.get('period_pct', 0):.1f}%，今日{l.get('today_pct', 0):.1f}%",
                            "price": 0,
                            "pct": l.get("today_pct", 0),
                            "amount": 0,
                            "industry": "",
                            "pattern": "",
                            "boards": 0,
                        })
                        seen_codes.add(l["code"])
            except Exception:
                pass

    return bears[:3]  # 最多3只


def yi_short(v: float) -> str:
    """成交额元→亿简写。"""
    if not v:
        return "—"
    return f"{v / 1e8:.1f}亿"


def compute_core_stocks() -> dict:
    """计算当日核心标的（多方3只 + 空方3只）。

    返回结构：
    {
        "date": "2026-07-21",
        "bulls": [...],   # 多方标的
        "bears": [...],   # 空方标的
        "note": "系统自动选出，可手动校准"
    }
    """
    emo = market.get_short_term_emotion()
    if not emo or not emo.get("date"):
        return {"date": "", "bulls": [], "bears": [], "note": "暂无数据", "yzt_stocks": []}

    # 成交额Top
    try:
        turnover = market.get_turnover_top()
        turnover_stocks = turnover.get("stocks", [])
    except Exception:
        turnover_stocks = []

    bulls = _pick_bulls(emo, turnover_stocks)
    # 多方已选的股票不在空方重复出现
    bull_codes = {b["code"] for b in bulls}
    bears = _pick_bears(emo, exclude_codes=bull_codes)

    return {
        "date": emo["date"],
        "bulls": bulls,
        "bears": bears,
        "note": "系统按连板龙头/首板强势/放量突破/炸板王/弱股持续弱/强股补跌多维度选出，可手动校准",
        "yzt_stocks": emo.get("yzt_stocks", []),
    }


def save_user_core_stocks(date: str, bulls: list[dict], bears: list[dict]) -> dict:
    """保存用户校准的核心标的（增删改）。"""
    data = _load_history()
    records = data.setdefault("records", [])
    # 替换同日期记录
    records = [r for r in records if r.get("date") != date]
    records.append({
        "date": date,
        "user_bulls": bulls,
        "user_bears": bears,
        "saved_at": datetime.now(BEIJING).strftime("%Y-%m-%d %H:%M"),
    })
    records.sort(key=lambda r: r["date"], reverse=True)
    data["records"] = records

    # 同时存系统选股快照
    sys_hist = data.setdefault("system_history", [])
    try:
        sys_cs = compute_core_stocks()
        sys_hist = [s for s in sys_hist if s.get("date") != date]
        sys_hist.append({
            "date": date,
            "bulls": sys_cs.get("bulls", []),
            "bears": sys_cs.get("bears", []),
        })
        sys_hist.sort(key=lambda s: s["date"], reverse=True)
        data["system_history"] = sys_hist[:90]
    except Exception:
        pass

    _save_history(data)
    return {"ok": True, "date": date}


def _fetch_realtime_quotes(stocks: list[dict]) -> list[dict]:
    """给标的列表补充今日实时行情（涨跌幅/现价/开盘价等）。"""
    if not stocks:
        return stocks
    codes = [s.get("code", "") for s in stocks if s.get("code")]
    if not codes:
        return stocks
    try:
        import astock
        quotes = astock.tencent_quote(codes)
    except Exception:
        quotes = {}

    out = []
    for s in stocks:
        code = s.get("code", "")
        q = quotes.get(code, {})
        # 非交易时段实时行情可能返回0，保留原始pct作为fallback
        rt_pct = q.get("change_pct", 0)
        orig_pct = s.get("pct", 0) or s.get("today_pct", 0)
        out.append({
            **s,
            "today_price": q.get("price", 0) or s.get("price", 0),
            "today_pct": rt_pct if rt_pct != 0 else orig_pct,
            "today_open": q.get("open", 0),
            "today_high": q.get("high", 0),
            "today_low": q.get("low", 0),
            "today_amount_wan": q.get("amount_wan", 0),
            "today_turnover": q.get("turnover_pct", 0),
            "today_amplitude": q.get("amplitude_pct", 0),
        })
    return out


def _add_tracking_days(stocks: list[dict], all_records: list[dict]) -> list[dict]:
    """给标的补充连续追踪信息：在历史中出现的天数 + 每日状态。

    核心用途：德明利这类连续跌停的票，需要看多天的状态，
    而不是只看单日形态。
    """
    if not stocks or not all_records:
        return stocks

    # 构建全局索引：code → [{date, side, dimension, reason, pct}]
    code_history: dict[str, list[dict]] = {}
    for rec in sorted(all_records, key=lambda r: r["date"]):
        date = rec.get("date", "")
        for s in rec.get("user_bulls", []):
            code_history.setdefault(s["code"], []).append({
                "date": date, "side": "bull",
                "dimension": s.get("dimension", ""), "reason": s.get("reason", ""),
                "pct": s.get("pct", 0),
            })
        for s in rec.get("user_bears", []):
            code_history.setdefault(s["code"], []).append({
                "date": date, "side": "bear",
                "dimension": s.get("dimension", ""), "reason": s.get("reason", ""),
                "pct": s.get("pct", 0),
            })

    out = []
    for s in stocks:
        code = s.get("code", "")
        history = code_history.get(code, [])
        tracking_days = len(history)
        # 取最近5天的历史记录
        recent = history[-5:] if history else []
        out.append({
            **s,
            "tracking_days": tracking_days,
            "tracking_history": recent,
        })
    return out


def _yesterday_date(today_str: str) -> str:
    """从 YYYY-MM-DD 字符串推算上一个交易日（简化：往前推1天，周末推3天）。"""
    try:
        d = datetime.strptime(today_str, "%Y-%m-%d")
        # 周一→周五，其他→前一天
        if d.weekday() == 0:
            yd = d - timedelta(days=3)
        else:
            yd = d - timedelta(days=1)
        return yd.strftime("%Y-%m-%d")
    except Exception:
        return ""


def get_core_stocks_with_calibration() -> dict:
    """获取核心标的全景：昨日标的今日追踪 + 今日录入/推荐。

    返回结构：
    {
        "today_date": "2026-07-21",
        "yesterday": {
            "date": "2026-07-20",
            "bulls": [...],   # 昨日多方 + today_pct等实时字段
            "bears": [...],   # 昨日空方 + today_pct等实时字段
            "has_data": bool  # 昨日是否有录入数据
        },
        "today": {
            "date": "2026-07-21",
            "system_bulls": [...],  # 系统推荐（辅助参考）
            "system_bears": [...],
            "user_bulls": [...],    # 用户今日已录入
            "user_bears": [...],
            "merged_bulls": [...],  # 最终版（用户优先，否则系统推荐）
            "merged_bears": [...],
            "is_user_calibrated": bool
        }
    }
    """
    sys_cs = compute_core_stocks()
    today_date = sys_cs.get("date", "")
    yzt_stocks = sys_cs.get("yzt_stocks", [])

    data = _load_history()
    records = data.get("records", [])

    # ── 昨日核心标的 + 今日行情追踪 ──
    # 只使用用户手动录入的核心标的，系统不会自动生成
    # 因为核心标的是基于事件（地天板/反核/核按钮/连续跌停等），无法自动判断
    yest_date = _yesterday_date(today_date) if today_date else ""
    yest_rec = next((r for r in records if r.get("date") == yest_date), None)
    if yest_rec:
        yest_bulls = _fetch_realtime_quotes(yest_rec.get("user_bulls", []))
        yest_bears = _fetch_realtime_quotes(yest_rec.get("user_bears", []))
        # 给每只标的补充连续追踪天数
        yest_bulls = _add_tracking_days(yest_bulls, records)
        yest_bears = _add_tracking_days(yest_bears, records)
        yesterday = {
            "date": yest_date,
            "bulls": yest_bulls,
            "bears": yest_bears,
            "has_data": True,
            "note": "用户录入版 · 昨日核心标的今日表现",
        }
    else:
        yesterday = {
            "date": yest_date,
            "bulls": [],
            "bears": [],
            "has_data": False,
            "note": "昨日无用户录入数据——盘后请在「今日核心标的」录入，明日即可追踪",
        }

    # ── 今日录入/推荐 ──
    today_rec = next((r for r in records if r.get("date") == today_date), None)
    sys_bulls = sys_cs.get("bulls", [])
    sys_bears = sys_cs.get("bears", [])
    if today_rec:
        user_bulls = today_rec.get("user_bulls", [])
        user_bears = today_rec.get("user_bears", [])
        merged_bulls = user_bulls if user_bulls else sys_bulls
        merged_bears = user_bears if user_bears else sys_bears
        is_calibrated = True
    else:
        user_bulls = []
        user_bears = []
        merged_bulls = sys_bulls
        merged_bears = sys_bears
        is_calibrated = False

    today = {
        "date": today_date,
        "system_bulls": sys_bulls,
        "system_bears": sys_bears,
        "user_bulls": user_bulls,
        "user_bears": user_bears,
        "merged_bulls": merged_bulls,
        "merged_bears": merged_bears,
        "is_user_calibrated": is_calibrated,
        "note": "盘后录入今日核心标的（多方/空方），供明日开盘前追踪观察" if not is_calibrated else "用户校准版",
    }

    return {
        "today_date": today_date,
        "yesterday": yesterday,
        "today": today,
    }


def get_core_stocks_history() -> dict:
    """获取核心标的历史记录（系统 vs 用户对比）。"""
    data = _load_history()
    records = data.get("records", [])
    sys_hist = data.get("system_history", [])
    sys_map = {s["date"]: s for s in sys_hist}

    comparison = []
    for r in records[:30]:
        sys_s = sys_map.get(r["date"])
        comparison.append({
            "date": r["date"],
            "user_bulls": r.get("user_bulls", []),
            "user_bears": r.get("user_bears", []),
            "sys_bulls": sys_s.get("bulls", []) if sys_s else [],
            "sys_bears": sys_s.get("bears", []) if sys_s else [],
        })

    return {
        "history": comparison,
        "record_count": len(records),
    }
