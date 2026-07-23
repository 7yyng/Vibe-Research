"""情绪温度量化系统 V3.1 —— 锚定昨日极端股转变 + 涨跌停拔河。

核心改进（2026-07-21 V3.1 用户反馈）：
  1. 拔河维度不再只看涨跌停家数比，核心改为"昨日极端股今日转变"
  2. 游资心法：弱的不在弱，强的才能更强；弱的持续弱，强的要补跌
  3. 拔河三因子：昨日涨停今日表现(50%) + 涨跌停家数比(35%) + 封板率(15%)
  4. 昨涨停池(getYesterdayZTPool)的 zdp 字段 = 昨日涨停股今日涨跌幅

核心改进（2026-07-21 V3）：
  1. 不再拉全市场分布（数据源不稳、采样偏差），改用已有涨跌停/涨跌家数数据
  2. 涨跌停拔河只需看最核心的几个：涨停/跌停家数比 + 封板率
  3. 四维度简化：拔河50% + 赚钱效应25% + 连板15% + 极端10%
  4. 校准锚点：2026-07-20 = 0°（冰点，大盘破位大跌后恐慌延续）

评定标准：
  0-15°  = 冰点（跌停远超涨停，恐慌蔓延，大多数人大亏）
  15-35° = 偏冷（跌停占优，赚钱效应差）
  35-55° = 中性（涨跌平衡）
  55-75° = 偏热（涨停占优，赚钱效应好）
  75-100°= 沸点（涨停远超跌停，情绪亢奋）

用户每天可手动给温度，系统对比生成值与用户值的偏差，逐日修正权重。
历史数据存本地 JSON（sentiment_history.json），不依赖数据库。
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone, timedelta

import astock
import market

BEIJING = timezone(timedelta(hours=8))
_DATA_FILE = os.path.join(os.path.dirname(__file__), "sentiment_history.json")

DEFAULT_WEIGHTS = {
    "tug_of_war": 0.50,   # 涨停跌停拔河（最核心）
    "real_profit": 0.25,  # 赚钱效应（涨跌家数比）
    "lianban": 0.15,      # 连板情绪
    "extreme": 0.10,      # 极端股触顶触底
}


def _clamp(v: float, lo: float = 0, hi: float = 100) -> float:
    return max(lo, min(hi, v))


def _score_tug_of_war(emo: dict) -> tuple[float, dict]:
    """涨跌停拔河：昨日极端股今日转变 + 涨跌停家数比。

    游资心法：弱的不在弱，强的才能更强；弱的持续弱，强的要补跌。
    拔河的核心不是今天的涨跌停家数，而是前一天最赚钱/最亏钱的股票能否转变。

    三因子：
    1. 昨日涨停今日表现（50%）—— 强的能否更强 / 是否补跌
       昨涨停今天继续涨的比例高 = "强的更强" → 高分
       昨涨停今天补跌（跌超3%）的比例高 = "强的要补跌" → 低分
    2. 涨跌停家数比（35%）—— 弱的端是否持续弱（跌停多=弱持续弱）
       涨停占比 < 15% → 0°（冰点）  涨停占比 > 85% → 100°（沸点）
    3. 封板率（15%）—— 涨停方士气
    """
    zt_count = emo.get("zt_count", 0)
    dt_count = emo.get("dt_count", 0)
    zb_count = emo.get("zb_count", 0)

    # ── 因子1：昨日涨停今日表现（游资心法核心）──
    yzt_pcts = emo.get("yzt_today_pcts", [])
    if yzt_pcts:
        yzt_n = len(yzt_pcts)
        still_up = sum(1 for p in yzt_pcts if p > 0)       # 昨涨停今天继续涨
        still_zt = sum(1 for p in yzt_pcts if p >= 9.8)     # 昨涨停今天继续涨停
        fell_hard = sum(1 for p in yzt_pcts if p < -3)      # 昨涨停今天补跌超3%
        still_up_ratio = still_up / yzt_n
        still_zt_ratio = still_zt / yzt_n
        fell_hard_ratio = fell_hard / yzt_n
        # 强的更强→高分；继续涨停额外加分；强的补跌→扣分
        s_strong = _clamp(
            still_up_ratio * 100        # 继续上涨比例
            + still_zt_ratio * 20       # 继续涨停（极强信号）加分
            - fell_hard_ratio * 60      # 补跌（极弱信号）扣分
        )
    else:
        # 无昨涨停数据时，退化为中性
        s_strong = 50.0
        yzt_n = still_up = still_zt = fell_hard = 0

    # ── 因子2：涨跌停家数比（弱端是否持续弱）──
    total_zt_dt = zt_count + dt_count
    zt_dominance = zt_count / total_zt_dt if total_zt_dt > 0 else 0.5
    s_ratio = _clamp((zt_dominance - 0.15) / 0.70 * 100)

    # ── 因子3：封板率（士气）──
    seal_rate = emo.get("seal_rate") or 0.5
    s_seal = _clamp(seal_rate * 100)

    # 加权合成
    score = _clamp(s_strong * 0.50 + s_ratio * 0.35 + s_seal * 0.15)

    factors = {
        "涨停": zt_count, "跌停": dt_count, "炸板": zb_count,
        "昨涨停数": yzt_n,
        "昨涨停继续涨": f"{still_up}/{yzt_n}" if yzt_n else "无数据",
        "昨涨停继续涨停": f"{still_zt}/{yzt_n}" if yzt_n else "无数据",
        "昨涨停补跌(跌超3%)": f"{fell_hard}/{yzt_n}" if yzt_n else "无数据",
        "涨停占比": f"{zt_dominance*100:.1f}%",
        "封板率": f"{seal_rate*100:.1f}%",
    }
    return score, factors


def _score_real_profit(sent: dict) -> tuple[float, dict]:
    """赚钱效应：上涨家数占比（大多数人是赚是亏的代理指标）。

    上涨占比 < 25% → 0°（普跌，大多数人大亏）
    上涨占比 = 50% → 50°（中性）
    上涨占比 > 75% → 100°（普涨，大多数人赚钱）
    """
    up = sent.get("up", 0)
    down = sent.get("down", 0)
    flat = sent.get("flat", 0)
    total = up + down + flat
    win_rate = up / total * 100 if total > 0 else 50

    score = _clamp((win_rate - 25) / 50 * 100)

    factors = {
        "上涨": up, "下跌": down, "平盘": flat,
        "上涨占比": f"{win_rate:.1f}%",
    }
    return score, factors


def _score_lianban(emo: dict) -> tuple[float, dict]:
    """连板情绪：最高连板 + 晋级率。

    最高连板：1板=12°, 3板=36°, 5板=60°, 8板+=60°（封顶）
    晋级率：直接 ×100
    """
    max_b = emo.get("max_boards", 0)
    s_max = min(max_b * 12, 60) if max_b > 0 else 0

    promo = emo.get("promotion_rate")
    s_promo = (promo * 100) if promo is not None else 30

    score = _clamp((s_max + s_promo) / 2)
    factors = {
        "最高连板": max_b, "晋级率": f"{(promo or 0)*100:.1f}%",
    }
    return score, factors


def _score_extreme(extreme_data: dict) -> tuple[float, dict]:
    """极端股触顶触底：5日涨跌幅最大Top10今日是否反转。

    跌幅最大Top10今日反弹 = 触底信号（权重60%，最有价值的情绪转折点）
    涨幅最大Top10继续涨 = 趋势延续（权重40%）
    """
    gainers = extreme_data.get("gainers", [])
    losers = extreme_data.get("losers", [])
    if not gainers and not losers:
        return 30, {"数据": "不可用"}

    gainers_still_up = sum(1 for g in gainers if g.get("today_pct", 0) > 0)
    gainers_ratio = gainers_still_up / max(len(gainers), 1)

    losers_rebound = sum(1 for l in losers if l.get("today_pct", 0) > 0)
    losers_ratio = losers_rebound / max(len(losers), 1)

    s_bottom = losers_ratio * 100
    s_trend = gainers_ratio * 100
    score = _clamp(s_bottom * 0.60 + s_trend * 0.40)

    factors = {
        "5日涨幅Top10": f"{gainers_still_up}/{len(gainers)}继续涨",
        "5日跌幅Top10": f"{losers_rebound}/{len(losers)}反弹",
    }
    return score, factors


def _load_history() -> dict:
    if os.path.exists(_DATA_FILE):
        try:
            with open(_DATA_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"records": [], "weights": DEFAULT_WEIGHTS.copy(), "system_history": []}


def _save_history(data: dict):
    try:
        with open(_DATA_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def _save_system_history(date: str, temperature: float, state: str):
    """每次计算系统温度时自动存一条历史记录（用于校准对比）。"""
    if not date:
        return
    data = _load_history()
    sys_hist = data.setdefault("system_history", [])
    sys_hist = [s for s in sys_hist if s.get("date") != date]
    sys_hist.append({"date": date, "temperature": temperature, "state": state})
    sys_hist.sort(key=lambda s: s["date"], reverse=True)
    data["system_history"] = sys_hist[:90]
    _save_history(data)


def compute_temperature() -> dict:
    """计算当日情绪温度（V3：拔河50% + 赚钱效应25% + 连板15% + 极端10%）。

    日期逻辑：以涨停板数据日期为准（最核心数据源），不再 fallback 到当前日期。
    如果涨跌家数日期与涨停板日期不一致，标注 data_warning。
    """
    overview = market.get_overview()
    emo = market.get_short_term_emotion()
    sent = overview.get("sentiment", {})

    # 数据源日期
    emo_date = emo.get("date", "")  # 涨停板数据日期（最核心）
    sent_date_raw = sent.get("date", "")  # 涨跌家数日期
    # sent.date 格式可能是 "2026-07-20 15:00:00"，截取日期部分
    sent_date = sent_date_raw[:10] if sent_date_raw else ""

    # 主日期：以涨停板数据为准
    main_date = emo_date or sent_date or datetime.now(BEIJING).strftime("%Y-%m-%d")

    # 数据一致性检查
    data_warning = None
    if emo_date and sent_date and emo_date != sent_date:
        data_warning = f"涨跌停数据日期({emo_date})与涨跌家数日期({sent_date})不一致"

    extreme = astock.extreme_movers("5d", 10)

    hist = _load_history()
    # 兼容旧版权重（V2 的 market 维度已删除），缺失的用默认值补
    saved_w = hist.get("weights", {})
    w = {k: saved_w.get(k, DEFAULT_WEIGHTS[k]) for k in DEFAULT_WEIGHTS}

    tug_score, tug_factors = _score_tug_of_war(emo)
    profit_score, profit_factors = _score_real_profit(sent)
    lianban_score, lianban_factors = _score_lianban(emo)
    extreme_score, extreme_factors = _score_extreme(extreme)

    total = (
        tug_score * w["tug_of_war"] + profit_score * w["real_profit"]
        + lianban_score * w["lianban"] + extreme_score * w["extreme"]
    )

    # 情绪状态描述
    if total >= 75:
        state = "沸点"
    elif total >= 55:
        state = "偏热"
    elif total >= 35:
        state = "中性"
    elif total >= 15:
        state = "偏冷"
    else:
        state = "冰点"

    # 拔河状态描述（游资心法视角：看昨日极端股今日转变）
    zt = emo.get("zt_count", 0)
    dt = emo.get("dt_count", 0)
    yzt_pcts = emo.get("yzt_today_pcts", [])
    if yzt_pcts:
        yzt_n = len(yzt_pcts)
        still_up = sum(1 for p in yzt_pcts if p > 0)
        fell_hard = sum(1 for p in yzt_pcts if p < -3)
        up_ratio = still_up / yzt_n
        fell_ratio = fell_hard / yzt_n
        if up_ratio >= 0.6 and fell_ratio <= 0.1:
            tug_state = "强股更强，情绪转暖"
        elif fell_ratio >= 0.4:
            tug_state = "强股补跌，情绪转冷"
        elif up_ratio < 0.3 and dt > zt * 2:
            tug_state = "弱股持续弱，情绪冰冻"
        elif zt > dt * 3:
            tug_state = "涨停方压倒性优势"
        elif dt > zt * 3:
            tug_state = "跌停方压倒性优势"
        else:
            tug_state = "双方胶着"
    else:
        if zt > dt * 3:
            tug_state = "涨停方压倒性优势"
        elif zt > dt * 1.5:
            tug_state = "涨停方占优"
        elif dt > zt * 3:
            tug_state = "跌停方压倒性优势"
        elif dt > zt * 1.5:
            tug_state = "跌停方占优"
        else:
            tug_state = "双方胶着"

    result = {
        "date": main_date,
        "data_warning": data_warning,
        "data_dates": {"zt_date": emo_date, "sentiment_date": sent_date},
        "temperature": round(total, 1),
        "state": state,
        "tug_state": tug_state,
        "dimensions": {
            "tug_of_war": {"score": round(tug_score, 1), "weight": w["tug_of_war"],
                           "label": "涨跌停拔河", "factors": tug_factors},
            "real_profit": {"score": round(profit_score, 1), "weight": w["real_profit"],
                            "label": "赚钱效应", "factors": profit_factors},
            "lianban": {"score": round(lianban_score, 1), "weight": w["lianban"],
                        "label": "连板情绪", "factors": lianban_factors},
            "extreme": {"score": round(extreme_score, 1), "weight": w["extreme"],
                        "label": "极端股信号", "factors": extreme_factors},
        },
        "extreme_movers": extreme,
        "yzt_stocks": emo.get("yzt_stocks", []),   # 昨日涨停今日表现（多空辨识度）
        "raw": {
            "zt_count": zt, "dt_count": dt, "zb_count": emo.get("zb_count", 0),
            "max_boards": emo.get("max_boards", 0),
            "seal_rate": emo.get("seal_rate"), "break_rate": emo.get("break_rate"),
            "up": sent.get("up", 0), "down": sent.get("down", 0),
        },
    }

    # 自动保存系统温度到历史（每次计算都存，用于校准对比）
    _save_system_history(main_date, round(total, 1), state)

    return result


def save_user_input(date: str, temperature: int, notes: str = "",
                    dim_scores: dict | None = None) -> dict:
    """保存用户手动输入的情绪温度（用于校准）。"""
    data = _load_history()
    records = data.setdefault("records", [])
    records = [r for r in records if r.get("date") != date]
    records.append({
        "date": date,
        "user_temperature": temperature,
        "user_notes": notes,
        "user_dim_scores": dim_scores or {},
        "saved_at": datetime.now(BEIJING).strftime("%Y-%m-%d %H:%M"),
    })
    records.sort(key=lambda r: r["date"], reverse=True)
    data["records"] = records

    # 同时存一份今日系统温度（用于历史对比）
    sys_hist = data.setdefault("system_history", [])
    try:
        sys_temp = compute_temperature()
        sys_hist = [s for s in sys_hist if s.get("date") != date]
        sys_hist.append({"date": date, "temperature": sys_temp["temperature"],
                         "state": sys_temp.get("state", "")})
        sys_hist.sort(key=lambda s: s["date"], reverse=True)
        data["system_history"] = sys_hist[:90]
    except Exception:
        pass

    _save_history(data)
    _auto_calibrate(data)
    return {"ok": True, "date": date}


def _auto_calibrate(data: dict):
    """根据历史用户 vs 系统偏差，微调权重。"""
    records = data.get("records", [])
    sys_hist = data.get("system_history", [])
    if len(records) < 5:
        return
    w = data.get("weights", {})
    w = {k: w.get(k, DEFAULT_WEIGHTS[k]) for k in DEFAULT_WEIGHTS}

    sys_map = {s["date"]: s["temperature"] for s in sys_hist}
    diffs = []
    for r in records[:10]:
        ut = r.get("user_temperature")
        st = sys_map.get(r["date"])
        if ut is not None and st is not None:
            diffs.append(ut - st)
    if not diffs:
        return

    avg_diff = sum(diffs) / len(diffs)
    # 系统持续高估（avg_diff < -5）：降低拔河权重，提升赚钱效应权重
    if avg_diff < -5:
        w["tug_of_war"] = max(w["tug_of_war"] - 0.03, 0.35)
        w["real_profit"] = min(w["real_profit"] + 0.03, 0.35)
    elif avg_diff > 5:
        w["tug_of_war"] = min(w["tug_of_war"] + 0.03, 0.60)
        w["real_profit"] = max(w["real_profit"] - 0.03, 0.15)
    data["weights"] = w
    _save_history(data)


def get_calibration() -> dict:
    """获取校准对比数据（系统值 vs 用户值历史序列 + 当前权重）。"""
    data = _load_history()
    records = data.get("records", [])
    sys_hist = data.get("system_history", [])
    sys_map = {s["date"]: s for s in sys_hist}

    today_sys = compute_temperature()
    today_date = today_sys["date"]
    today_user = next((r for r in records if r.get("date") == today_date), None)

    comparison = []
    for r in records[:30]:
        sys_s = sys_map.get(r["date"])
        sys_t = sys_s["temperature"] if sys_s else None
        ut = r.get("user_temperature")
        comparison.append({
            "date": r["date"],
            "user": ut,
            "system": sys_t,
            "diff": (ut - sys_t) if (ut is not None and sys_t is not None) else None,
        })

    return {
        "today": {
            "date": today_date,
            "system": today_sys["temperature"],
            "state": today_sys.get("state"),
            "tug_state": today_sys.get("tug_state"),
            "user": today_user.get("user_temperature") if today_user else None,
            "diff": (today_user["user_temperature"] - today_sys["temperature"]) if today_user else None,
        },
        "weights": {k: data.get("weights", {}).get(k, DEFAULT_WEIGHTS[k]) for k in DEFAULT_WEIGHTS},
        "history": comparison,
        "record_count": len(records),
    }


def get_temperature_history(days: int = 15) -> dict:
    """N交易日温度对比：系统值 vs 用户校正值，按日期降序。"""
    data = _load_history()
    sys_hist = data.get("system_history", [])
    records = data.get("records", [])
    sys_map = {s["date"]: s for s in sys_hist}
    user_map = {r["date"]: r for r in records}
    all_dates = sorted(set(list(sys_map.keys()) + list(user_map.keys())), reverse=True)[:days]
    rows = []
    for date in all_dates:
        sys_s = sys_map.get(date)
        user_r = user_map.get(date)
        sys_t = sys_s["temperature"] if sys_s else None
        sys_state = sys_s["state"] if sys_s else None
        user_t = user_r.get("user_temperature") if user_r else None
        user_notes = user_r.get("user_notes", "") if user_r else ""
        diff = None
        if sys_t is not None and user_t is not None:
            diff = round(user_t - sys_t, 1)
        rows.append({
            "date": date, "system": sys_t, "system_state": sys_state,
            "user": user_t, "user_notes": user_notes, "diff": diff,
            "has_system": sys_s is not None, "has_user": user_r is not None,
        })
    return {"rows": rows, "total_system": len(sys_hist), "total_user": len(records)}
