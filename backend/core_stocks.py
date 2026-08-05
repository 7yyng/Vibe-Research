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
import logging
import os
from datetime import datetime, timezone, timedelta

import market

logger = logging.getLogger(__name__)

BEIJING = timezone(timedelta(hours=8))
_DATA_FILE = os.path.join(os.path.dirname(__file__), "core_stocks_history.json")


def _num(v) -> int:
    try:
        return int(float(v))
    except (ValueError, TypeError):
        return 0


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


def compute_core_stocks(target_date: str | None = None) -> dict:
    """计算当日核心标的（多方3只 + 空方3只）。

    target_date: 指定日期（YYYY-MM-DD），不传则用最近交易日。
    指定日期时直接从东财历史涨停池计算，不走实时情绪接口。

    返回结构：
    {
        "date": "2026-07-21",
        "bulls": [...],   # 多方标的
        "bears": [...],   # 空方标的
        "note": "系统自动选出，可手动校准"
    }
    """
    # 指定日期模式：直接用东财历史涨停池计算
    if target_date:
        return _compute_core_stocks_for_date(target_date)

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


def _compute_core_stocks_for_date(target_date: str) -> dict:
    """为指定历史日期计算核心标的（直接用东财历史涨停池）。

    最具辨识度的多方、空方，不一定要有3个但一定有。
    """
    import astock
    from collections import Counter

    ymd = target_date.replace("-", "")
    date_str = target_date

    # 获取当日涨停池、炸板池、跌停池、昨涨停池
    zt = astock.em_zt_topic_pool("getTopicZTPool", ymd, "fbt:asc") or []
    zb = astock.em_zt_topic_pool("getTopicZBPool", ymd, "fbt:asc") or []
    dt = astock.em_zt_topic_pool("getTopicDTPool", ymd, "fund:asc") or []
    yzt = astock.em_zt_topic_pool("getYesterdayZTPool", ymd, "zs:desc") or []

    if not zt and not zb and not dt:
        # 当天没有任何数据，返回空但标记日期
        return {"date": date_str, "bulls": [], "bears": [],
                "note": "该日期无涨停池数据", "yzt_stocks": []}

    # 构造连板梯队
    boards = [_num(p.get("lbc")) or 1 for p in zt]
    lianban = [b for b in boards if b >= 2]
    tiers = Counter(min(b, 5) for b in lianban)

    def _stock_item(p: dict, is_zt: bool = True) -> dict:
        code = str(p.get("c", ""))
        pct_val = astock._numf(p.get("zdp")) or 0
        return {
            "code": code, "name": p.get("n", ""),
            "boards": _num(p.get("lbc")) or 1,
            "price": round((astock._numf(p.get("p")) or 0) / 1000, 2),
            "pct": round(pct_val, 2),
            "amount": astock._numf(p.get("amount")),
            "float_cap": astock._numf(p.get("ltsz")),
            "industry": p.get("hybk", ""),
            "first_seal_time": market._fmt_seal_time(p.get("fbt")) if hasattr(market, '_fmt_seal_time') else "",
            "last_seal_time": market._fmt_seal_time(p.get("lbt")) if hasattr(market, '_fmt_seal_time') else "",
            "pattern": _zt_pattern_local(p.get("fbt"), p.get("zbc")),
            "break_count": _num(p.get("zbc")),
            "seal_fund": astock._numf(p.get("fund")),
        }

    lianban_stocks = sorted(
        (_stock_item(p) for p in zt if (_num(p.get("lbc")) or 1) >= 2),
        key=lambda x: (-x["boards"], x["last_seal_time"] or "99:99:99"),
    )
    shouban_stocks = sorted(
        (_stock_item(p) for p in zt if (_num(p.get("lbc")) or 1) == 1),
        key=lambda x: (x["industry"] or "其他", x["last_seal_time"] or "99:99:99"),
    )

    # 昨涨停今日表现
    yzt_stocks = []
    for p in yzt:
        pct_val = round(astock._numf(p.get("zdp")) or 0, 2)
        yzt_stocks.append({
            "code": str(p.get("c", "")),
            "name": p.get("n", ""),
            "boards": _num(p.get("lbc")) or 1,
            "today_pct": pct_val,
            "industry": p.get("hybk", ""),
        })
    yzt_stocks.sort(key=lambda x: x["today_pct"], reverse=True)

    emo_simple = {
        "date": date_str,
        "lianban_stocks": lianban_stocks,
        "shouban_stocks": shouban_stocks,
        "yzt_stocks": yzt_stocks,
        "dt_count": len(dt),
    }

    # 选多方（从涨停池中选）
    bulls = _pick_bulls(emo_simple, [])

    # 空方：炸板王 + 跌停 + 强股补跌
    bears = _pick_bears_historical(zt, zb, dt, yzt_stocks, exclude_codes={b["code"] for b in bulls})

    return {
        "date": date_str,
        "bulls": bulls,
        "bears": bears,
        "note": f"系统按{date_str}历史数据自动选出（连板龙头/首板强势/炸板王/跌停等维度），可手动校准",
        "yzt_stocks": yzt_stocks,
    }


def _zt_pattern_local(fbt, zbc) -> str:
    """本地版涨停形态推断（避免循环导入）。"""
    try:
        f = int(fbt or 0)
    except (ValueError, TypeError):
        f = 0
    try:
        z = int(zbc or 0)
    except (ValueError, TypeError):
        z = 0
    if f <= 92500 and z == 0:
        return "一字板"
    if f <= 92500 and z > 0:
        return "T字板"
    if f <= 93000 and z == 0:
        return "秒板"
    if z >= 3:
        return "烂板"
    return "换手板"


def _pick_bears_historical(zt: list, zb: list, dt: list, yzt_stocks: list, exclude_codes: set[str]) -> list[dict]:
    """历史日期模式下选空方标的（从炸板池/跌停池/昨涨停补跌中选）。

    最具辨识度的空方，不一定要3个但一定有。
    """
    bears: list[dict] = []
    seen_codes: set[str] = set(exclude_codes or [])

    # 维度1：炸板王（炸板次数最多的）
    if zb:
        zb_sorted = sorted(zb, key=lambda x: _num(x.get("zbc")), reverse=True)
        for p in zb_sorted:
            code = str(p.get("c", ""))
            if code not in seen_codes:
                bears.append({
                    "code": code, "name": p.get("n", ""),
                    "dimension": "炸板王",
                    "reason": f"炸板{_num(p.get('zbc'))}次，多头反复溃败，抛压极重",
                    "price": round((astock._numf(p.get("p")) or 0) / 1000, 2),
                    "pct": round(astock._numf(p.get("zdp")) or 0, 2),
                    "amount": astock._numf(p.get("amount")),
                    "industry": p.get("hybk", ""),
                    "pattern": _zt_pattern_local(p.get("fbt"), p.get("zbc")),
                    "boards": _num(p.get("lbc")) or 1,
                })
                seen_codes.add(code)
                break

    # 维度2：跌停封死（封单最大的）
    if dt and len(bears) < 3:
        # dt 已按 fund 升序？fund是封单资金，找封单最大的
        dt_sorted = sorted(dt, key=lambda x: astock._numf(x.get("fund")) or 0, reverse=True)
        for p in dt_sorted:
            code = str(p.get("c", ""))
            if code not in seen_codes:
                bears.append({
                    "code": code, "name": p.get("n", ""),
                    "dimension": "跌停封死",
                    "reason": f"跌停封单{yi_short(astock._numf(p.get('fund')) or 0)}，空头最猛",
                    "price": round((astock._numf(p.get("p")) or 0) / 1000, 2),
                    "pct": round(astock._numf(p.get("zdp")) or 0, 2),
                    "amount": astock._numf(p.get("amount")),
                    "industry": p.get("hybk", ""),
                    "pattern": "跌停",
                    "boards": 0,
                })
                seen_codes.add(code)
                break

    # 维度3：强股补跌（昨涨停今天跌幅最大的）
    if yzt_stocks and len(bears) < 3:
        # 按今日涨幅从小到大排（跌最狠的在前）
        yzt_sorted = sorted(yzt_stocks, key=lambda x: x.get("today_pct", 0))
        for s in yzt_sorted:
            if s["code"] not in seen_codes and s.get("today_pct", 0) < -3:
                bears.append({
                    "code": s["code"], "name": s["name"],
                    "dimension": "强股补跌",
                    "reason": f"昨涨停今日补跌{s.get('today_pct', 0):.1f}%，情绪退潮信号",
                    "price": 0,
                    "pct": s.get("today_pct", 0),
                    "amount": 0,
                    "industry": s.get("industry", ""),
                    "pattern": "",
                    "boards": s.get("boards", 1),
                })
                seen_codes.add(s["code"])
                break

    # 如果还不够，从涨停池中找炸板次数多的
    if len(bears) == 0 and zt:
        zt_with_breaks = [p for p in zt if _num(p.get("zbc")) >= 1 and str(p.get("c", "")) not in seen_codes]
        zt_with_breaks.sort(key=lambda x: _num(x.get("zbc")), reverse=True)
        for p in zt_with_breaks[:2]:
            code = str(p.get("c", ""))
            bears.append({
                "code": code, "name": p.get("n", ""),
                "dimension": "烂板警示",
                "reason": f"炸板{_num(p.get('zbc'))}次后封住，反复开板需警惕",
                "price": round((astock._numf(p.get("p")) or 0) / 1000, 2),
                "pct": round(astock._numf(p.get("zdp")) or 0, 2),
                "amount": astock._numf(p.get("amount")),
                "industry": p.get("hybk", ""),
                "pattern": _zt_pattern_local(p.get("fbt"), p.get("zbc")),
                "boards": _num(p.get("lbc")) or 1,
            })
            seen_codes.add(code)

    return bears[:3]


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


def get_core_stocks_with_calibration(target_date: str | None = None) -> dict:
    """获取核心标的全景：昨日标的今日追踪 + 今日录入/推荐。

    target_date: 指定查看某天的核心标的（如 "2026-07-28"）。
                 不传或为空则自动判断今天/最近交易日。

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
    # ── 指定日期模式：直接用 target_date，从本地 JSON 读取，不调任何网络 API ──
    # 但如果 target_date 是今天，走实时路径（历史路径调东财API太慢且今天数据可能还没更新）
    _cal_now = datetime.now(BEIJING)
    _cal_today = _cal_now.strftime("%Y-%m-%d")
    if target_date and target_date == _cal_today:
        target_date = None  # 今天走实时路径
    if target_date:
        data = _load_history()
        records = data.get("records", [])
        sys_history = data.get("system_history", [])

        today_date = target_date
        data_date = target_date
        is_non_trading = True

        # 系统推荐：从 system_history 找该日期的快照
        sys_snap = next((s for s in sys_history if s.get("date") == target_date), None)
        if sys_snap:
            sys_bulls = sys_snap.get("bulls", [])
            sys_bears = sys_snap.get("bears", [])
        else:
            # 无系统快照时兜底生成（一定有，不一定3个）
            try:
                computed = compute_core_stocks(target_date)
                sys_bulls = computed.get("bulls", [])
                sys_bears = computed.get("bears", [])
                # 缓存计算结果到 system_history
                if sys_bulls or sys_bears:
                    sys_history.append({
                        "date": target_date,
                        "bulls": sys_bulls,
                        "bears": sys_bears,
                    })
                    sys_history.sort(key=lambda s: s["date"], reverse=True)
                    data["system_history"] = sys_history[:90]
                    _save_history(data)
            except Exception as e:
                logger.warning(f"历史日期 {target_date} 生成核心标的失败: {e}")
                sys_bulls, sys_bears = [], []

        # 用户录入：找该日期的 record
        today_rec = next((r for r in records if r.get("date") == target_date), None)
        if today_rec:
            user_bulls = today_rec.get("user_bulls", [])
            user_bears = today_rec.get("user_bears", [])
            is_calibrated = bool(user_bulls) or bool(user_bears)
            merged_bulls = user_bulls if user_bulls else sys_bulls
            merged_bears = user_bears if user_bears else sys_bears
        else:
            user_bulls, user_bears = [], []
            merged_bulls, merged_bears = sys_bulls, sys_bears
            is_calibrated = False

        # 昨日标的：找 target_date 之前最近有数据的交易日
        yest_rec = None
        yest_date = ""
        for r in records:
            if r.get("date") and r["date"] < target_date:
                yest_rec = r
                yest_date = r["date"]
                break
        if yest_rec:
            yest_bulls = _add_tracking_days(yest_rec.get("user_bulls", []), records)
            yest_bears = _add_tracking_days(yest_rec.get("user_bears", []), records)
            yesterday = {
                "date": yest_date,
                "bulls": yest_bulls,
                "bears": yest_bears,
                "has_data": True,
                "note": f"历史查看 · {yest_date} 核心标的",
            }
        else:
            yesterday = {"date": "", "bulls": [], "bears": [], "has_data": False, "note": "该日期之前无录入数据"}

        today = {
            "date": today_date,
            "system_bulls": sys_bulls,
            "system_bears": sys_bears,
            "user_bulls": user_bulls,
            "user_bears": user_bears,
            "merged_bulls": merged_bulls,
            "merged_bears": merged_bears,
            "is_user_calibrated": is_calibrated,
            "note": "用户校准版" if is_calibrated else "系统推荐版（未校准）",
        }
        return {"today_date": today_date, "yesterday": yesterday, "today": today}

    # ── 自动模式（无 target_date）：原有逻辑 ──
    # 非交易时段优化：跳过 compute_core_stocks() 和 market API 调用
    cal_now = datetime.now(BEIJING)
    cal_today = cal_now.strftime("%Y-%m-%d")
    cal_hour = cal_now.hour
    is_weekend = cal_now.weekday() >= 5

    # 先从历史 JSON 读取已存数据
    data = _load_history()
    records = data.get("records", [])

    # 从历史记录推断数据源最近交易日（避免调 market API）
    # records 已按日期降序排列，第一条就是最近的
    latest_record_date = records[0]["date"] if records else ""

    # 判断是否非交易时段：
    # 1. 周末 — 直接用历史日期，完全不调 market API
    # 2. 日历日 > 最近记录日期 且已过 9 点 — 尝试 market API 但有兜底
    if is_weekend:
        data_date = latest_record_date
        is_non_trading = True
        sys_cs = {"date": data_date, "bulls": [], "bears": [], "yzt_stocks": []}
    elif latest_record_date and cal_today > latest_record_date and cal_hour >= 9:
        # 非交易时段：尝试轻量获取数据源日期（有缓存就用缓存，没有就跳过）
        try:
            emo = market.get_short_term_emotion()
            data_date = emo.get("date", "") if emo else ""
        except Exception:
            data_date = ""
        if not data_date:
            data_date = latest_record_date
        is_non_trading = True
        sys_cs = {"date": data_date, "bulls": [], "bears": [], "yzt_stocks": []}
    else:
        # 交易时段：正常调用
        try:
            emo = market.get_short_term_emotion()
            data_date = emo.get("date", "") if emo else ""
        except Exception:
            data_date = latest_record_date
        is_non_trading = False
        if not data_date:
            sys_cs = {"date": "", "bulls": [], "bears": [], "yzt_stocks": []}
        else:
            sys_cs = compute_core_stocks()

    # today_date 计算：非交易时段修正，只有过了9:00才将视角移到新交易日
    if data_date and cal_today > data_date and cal_hour >= 9:
        today_date = cal_today
    else:
        today_date = data_date

    # ── 昨日核心标的 + 今日行情追踪 ──
    # 只使用用户手动录入的核心标的，系统不会自动生成
    # 因为核心标的是基于事件（地天板/反核/核按钮/连续跌停等），无法自动判断
    yest_date = _yesterday_date(today_date) if today_date else ""
    yest_rec = next((r for r in records if r.get("date") == yest_date), None)
    # 如果精确的前一交易日没有数据，往前找最近有数据的交易日（最多回溯5天）
    if not yest_rec and records:
        for r in records:
            if r.get("date") and r.get("date") < today_date:
                yest_rec = r
                yest_date = r.get("date")
                break
    if yest_rec:
        # 非交易时段跳过实时行情获取（会卡在网络请求），直接用已存数据
        if is_non_trading or is_weekend:
            yest_bulls = yest_rec.get("user_bulls", [])
            yest_bears = yest_rec.get("user_bears", [])
        else:
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
    # 非交易时段：从 system_history 取最近交易日的系统推荐快照（而非返回空）
    if is_non_trading or is_weekend or today_date != data_date:
        sys_history = data.get("system_history", [])
        # 找最近一个有系统推荐记录的交易日
        sys_snap = None
        if sys_history:
            # 优先找 data_date 的记录，否则取第一条（最新的）
            sys_snap = next((s for s in sys_history if s.get("date") == data_date), None)
            if not sys_snap:
                sys_snap = sys_history[0] if sys_history else None
        if sys_snap:
            sys_bulls = sys_snap.get("bulls", [])
            sys_bears = sys_snap.get("bears", [])
        else:
            sys_bulls = sys_cs.get("bulls", [])
            sys_bears = sys_cs.get("bears", [])
    else:
        sys_bulls = sys_cs.get("bulls", [])
        sys_bears = sys_cs.get("bears", [])
    if today_rec:
        user_bulls = today_rec.get("user_bulls", [])
        user_bears = today_rec.get("user_bears", [])
        # 只有用户实际录入了标的才算校准
        is_calibrated = bool(user_bulls) or bool(user_bears)
        # merged 逻辑：用户录了哪一方就用哪一方，没录的那一方默认保留系统推荐
        merged_bulls = user_bulls if user_bulls else sys_bulls
        merged_bears = user_bears if user_bears else sys_bears
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
