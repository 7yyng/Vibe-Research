"""市场总览数据层 —— 市场情绪 + 板块资金流（板块/大盘级公开数据，不涉个股推荐）。

省流量：全站共享一份缓存（TTL 默认 5 分钟），多个用户/多次打开只抓一次；
盘中 5 分钟刷新足够，非交易时段数据本就不变。数据源全免费、无 key。
"""

from __future__ import annotations

import json
import os
import time
from collections import Counter
from datetime import datetime, timezone, timedelta

import astock
import gstock
import requests

BEIJING = timezone(timedelta(hours=8))
_CACHE: dict = {}
_TTL = 300  # 5 分钟；全站共享，省数据源压力
_REASON_CACHE: dict = {}  # 涨停原因缓存：{code: (date, reason)}，每日只抓一次

# 每日历史缓存目录（收盘后的数据落盘，供非交易时段回看）
_HIST_DIR = os.path.join(os.path.dirname(__file__), "data", "market_history")
os.makedirs(_HIST_DIR, exist_ok=True)


def _save_daily_cache(key: str, date_str: str, data: dict):
    """保存某日的数据快照到历史缓存。"""
    try:
        path = os.path.join(_HIST_DIR, f"{key}_{date_str}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def _load_daily_cache(key: str, date_str: str) -> dict | None:
    """从历史缓存读取某日的数据快照。"""
    try:
        path = os.path.join(_HIST_DIR, f"{key}_{date_str}.json")
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        pass
    return None


def _is_trading_hours() -> bool:
    """判断当前是否处于 A 股交易时段（9:30-11:30, 13:00-15:00）。"""
    now = datetime.now(BEIJING)
    if now.weekday() >= 5:  # 周末
        return False
    hhmm = now.hour * 60 + now.minute
    # 9:30-11:30 或 13:00-15:00
    return (9 * 60 + 30 <= hhmm <= 11 * 60 + 30) or (13 * 60 <= hhmm <= 15 * 60)


def _before_9am() -> bool:
    """判断当前是否在交易日 9:00 之前。"""
    now = datetime.now(BEIJING)
    if now.weekday() >= 5:  # 周末
        return True
    return now.hour < 9


def _previous_trading_day() -> str:
    """获取上一个交易日（往前找第一个工作日）。"""
    now = datetime.now(BEIJING)
    for i in range(1, 10):
        d = now - timedelta(days=i)
        if d.weekday() < 5:
            return d.strftime("%Y-%m-%d")
    return (now - timedelta(days=1)).strftime("%Y-%m-%d")


def _cached(key: str, fn, valid=bool):
    """TTL 缓存。数据源故障的空结果不缓存（valid 判否），下次请求直接重试。"""
    now = time.time()
    hit = _CACHE.get(key)
    if hit and now - hit[0] < _TTL:
        return hit[1]
    val = fn()
    if valid(val):
        _CACHE[key] = (now, val)
    return val


def _num(v) -> int:
    try:
        return int(float(v))
    except (ValueError, TypeError):
        return 0


def _sentiment() -> dict:
    """市场情绪：涨跌家数/涨停跌停/活跃度 + 大盘宽度、题材投机（客观数据机械分档）。"""
    try:
        # akshare 惰性导入（同 astock 模式）：未装时降级返回空，不挡整个服务启动
        df = astock._akshare().stock_market_activity_legu()
        d = {row["item"]: row["value"] for _, row in df.iterrows()}
    except Exception:
        return {}
    up, down, flat = _num(d.get("上涨")), _num(d.get("下跌")), _num(d.get("平盘"))
    zt, zt_real = _num(d.get("涨停")), _num(d.get("真实涨停"))
    dt, dt_real = _num(d.get("跌停")), _num(d.get("真实跌停"))
    r = up / max(down, 1)
    if up < 600:
        breadth = "冰点"
    elif r < 0.7:
        breadth = "偏弱"
    elif r < 1.2:
        breadth = "中性"
    elif r < 2.5:
        breadth = "偏强"
    else:
        breadth = "普涨"
    speculation = "亢奋" if zt_real >= 100 else "活跃" if zt_real >= 60 else "普通" if zt_real >= 30 else "冰点"
    return {
        "up": up, "down": down, "flat": flat,
        "zt": zt, "zt_real": zt_real, "dt": dt, "dt_real": dt_real,
        "active": str(d.get("活跃度", "")),
        "breadth": breadth, "speculation": speculation,
        "date": str(d.get("统计日期", "")),
    }


def _sectors() -> list[dict]:
    """行业资金流（按净额降序）。不含领涨股等个股字段。"""
    try:
        f = astock._akshare().stock_fund_flow_industry(symbol="即时")
        f = f.sort_values("净额", ascending=False)
    except Exception:
        return []
    out = []
    for _, row in f.iterrows():
        out.append({
            "name": str(row["行业"]),
            "pct": round(float(row.get("行业-涨跌幅", 0) or 0), 2),
            "net": round(float(row.get("净额", 0) or 0), 2),
            "inflow": round(float(row.get("流入资金", 0) or 0), 2),
            "outflow": round(float(row.get("流出资金", 0) or 0), 2),
            "firms": _num(row.get("公司家数")),
        })
    return out


def get_overview() -> dict:
    """市场情绪 + 板块资金（含缓存）。资金轮动由前端从 sectors 头尾取。"""
    def build():
        return {
            "sentiment": _sentiment(),
            "sectors": _sectors(),
            "updated": datetime.now(BEIJING).strftime("%Y-%m-%d %H:%M"),
        }
    return _cached("overview", build, valid=lambda v: bool(v.get("sentiment") or v.get("sectors")))


def _fetch_zt_reason(code: str, date_str: str) -> str:
    """从同花顺涨停分析页抓取最新涨停原因（view_title）。

    每只股票每天只抓一次（缓存在 _REASON_CACHE），避免重复请求。
    同花顺页面结构：首个 view_li_reason 的 view_title 即最新涨停原因摘要。
    """
    cache_key = code
    cached = _REASON_CACHE.get(cache_key)
    if cached and cached[0] == date_str:
        return cached[1]
    try:
        url = f"http://zx.10jqka.com.cn/event/harden/stockhistory/code/{code}"
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
        r = requests.get(url, headers=headers, timeout=5)
        import re
        # 提取首个 view_li_reason 的 view_title
        m = re.search(r'view_li_reason[^>]*view_title="([^"]+)"', r.text)
        reason = m.group(1) if m else ""
        _REASON_CACHE[cache_key] = (date_str, reason)
        return reason
    except Exception:
        _REASON_CACHE[cache_key] = (date_str, "")
        return ""


def _fmt_seal_time(t) -> str:
    """封板时间 92500 -> '09:25:00'。"""
    try:
        t = int(t)
    except (ValueError, TypeError):
        return ""
    if t <= 0:
        return ""
    return f"{t // 10000:02d}:{(t % 10000) // 100:02d}:{t % 100:02d}"


def _zt_pattern(fbt, zbc) -> str:
    """涨停形态推断（基于首次封板时间 + 炸板次数）。

    一字板：集合竞价（9:25）即封住、全程未炸；
    T字板：9:25 封住但有炸板回封；
    秒板：开盘（9:30）后迅速封住、未炸；
    烂板：炸板≥3 次（反复开板）；
    换手板：其余盘中封板（充分换手后封住）。
    """
    try:
        f = int(fbt)
    except (ValueError, TypeError):
        f = 0
    try:
        z = int(zbc)
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


def _emotion() -> dict:
    """短线情绪（聚合口径）：连板梯队 / 最高连板 / 炸板率 / 封板率 / 晋级率 / 涨跌停家数。

    数据源＝东财涨停板四池（push2ex）。展示客观榜单（连板 + 首板），
    含形态 / 最后封板时间 / 概念，不推荐 / 不预测 / 不评分。
    """
    # 定位最近交易日：从今天往前回溯，第一日有涨停池即取（非交易日/盘前返空则继续回溯）。
    today = datetime.now(BEIJING).date()
    resolved, zt = "", []
    for back in range(8):
        d = (today - timedelta(days=back)).strftime("%Y%m%d")
        zt = astock.em_zt_topic_pool("getTopicZTPool", d, "fbt:asc")
        if zt:
            resolved = d
            break
    if not resolved:
        return {}

    zb = astock.em_zt_topic_pool("getTopicZBPool", resolved, "fbt:asc")    # 炸板池
    dt = astock.em_zt_topic_pool("getTopicDTPool", resolved, "fund:asc")   # 跌停池
    yzt = astock.em_zt_topic_pool("getYesterdayZTPool", resolved, "zs:desc")  # 昨涨停池

    boards = [_num(p.get("lbc")) or 1 for p in zt]      # 每只连板数（缺省按 1 板）
    lianban = [b for b in boards if b >= 2]             # 2 板及以上（连板）
    # 连板梯队：2/3/4/5+ 各多少家（5 代表 5 板及以上），只保留有家数的档
    tiers = Counter(min(b, 5) for b in lianban)
    ladder = [{"boards": b, "count": tiers[b], "plus": b >= 5} for b in sorted(tiers)]

    # 涨停股清单（客观公开榜单数据）。拆分首板（1 板）与连板（2 板+）。
    # 新增字段：形态 / 首次&最后封板时间 / 炸板次数 / 封板资金 / 概念。
    # 注：东财涨停池不含独立「涨停原因」字段，以 hybk（所属行业/概念）近似展示。
    def _stock_item(p: dict) -> dict:
        code = str(p.get("c", ""))
        return {
            "code": code, "name": p.get("n", ""),
            "boards": _num(p.get("lbc")) or 1,
            "price": round((astock._numf(p.get("p")) or 0) / 1000, 2),
            "pct": round(astock._numf(p.get("zdp")) or 0, 2),
            "amount": astock._numf(p.get("amount")),      # 成交额,元
            "float_cap": astock._numf(p.get("ltsz")),     # 流通市值,元
            "industry": p.get("hybk", ""),                 # 所属行业/概念
            "first_seal_time": _fmt_seal_time(p.get("fbt")),   # 首次封板时间
            "last_seal_time": _fmt_seal_time(p.get("lbt")),    # 最后封板时间
            "pattern": _zt_pattern(p.get("fbt"), p.get("zbc")),# 涨停形态
            "break_count": _num(p.get("zbc")),                 # 炸板次数
            "seal_fund": astock._numf(p.get("fund")),          # 封板资金,元
            "reason": _fetch_zt_reason(code, resolved),        # 涨停原因（同花顺）
        }

    lianban_stocks = sorted(
        (_stock_item(p) for p in zt if (_num(p.get("lbc")) or 1) >= 2),
        key=lambda x: (-x["boards"], x["last_seal_time"] or "99:99:99"),
    )
    shouban_stocks = sorted(
        (_stock_item(p) for p in zt if (_num(p.get("lbc")) or 1) == 1),
        key=lambda x: (x["industry"] or "其他", x["last_seal_time"] or "99:99:99"),
    )

    zt_count, zb_count, yzt_count = len(zt), len(zb), len(yzt)
    attempts = zt_count + zb_count                       # 尝试涨停 = 封住 + 炸板
    seal_rate = round(zt_count / attempts, 3) if attempts else None      # 封板率
    break_rate = round(zb_count / attempts, 3) if attempts else None     # 炸板率
    # 晋级率＝今日 2 板+（＝昨涨停今又停）÷ 昨日涨停家数
    promotion_rate = round(len(lianban) / yzt_count, 3) if yzt_count else None

    # 昨涨停今日涨跌幅（游资心法：强能更强 vs 强要补跌）
    # 昨涨停池(getYesterdayZTPool)的 zdp 字段 = 昨日涨停股今日涨跌幅(%)
    yzt_today_pcts: list[float] = []
    yzt_stocks: list[dict] = []   # 昨涨停今日表现明细（多空辨识度）
    for p in yzt:
        pct = astock._numf(p.get("zdp"))
        pct_val = round(pct, 2) if pct is not None else 0
        if pct is not None:
            yzt_today_pcts.append(pct_val)
        yzt_stocks.append({
            "code": str(p.get("c", "")),
            "name": p.get("n", ""),
            "boards": _num(p.get("lbc")) or 1,
            "today_pct": pct_val,
            "industry": p.get("hybk", ""),
        })
    # 按今日涨跌幅降序：强的在前，补跌的在后
    yzt_stocks.sort(key=lambda x: x["today_pct"], reverse=True)

    return {
        "date": f"{resolved[:4]}-{resolved[4:6]}-{resolved[6:]}",
        "zt_count": zt_count,
        "dt_count": len(dt),
        "zb_count": zb_count,
        "max_boards": max(boards) if boards else 0,
        "lianban_count": len(lianban),
        "shouban_count": len(shouban_stocks),
        "ladder": ladder,
        "lianban_stocks": lianban_stocks,
        "shouban_stocks": shouban_stocks,
        "seal_rate": seal_rate,
        "break_rate": break_rate,
        "promotion_rate": promotion_rate,
        "yzt_count": yzt_count,
        "yzt_today_pcts": yzt_today_pcts,
        "yzt_stocks": yzt_stocks,
    }


def get_short_term_emotion() -> dict:
    """短线情绪（含缓存，5 分钟）。"""
    return _cached("emotion", _emotion)


def get_turnover_top() -> dict:
    """全市场成交额榜 Top20（客观公开榜单，含缓存 5 分钟）。

    非交易时段 / 交易日 9:00 前：默认显示上一交易日的收盘数据，
    并标注 is_historical=True + historical_date，提醒读者这是昨日数据。
    交易时段正常获取实时数据，同时落盘保存供日后回看。
    """
    # 非交易时段或 9 点前：优先返回上一交易日的历史缓存
    if _before_9am() or not _is_trading_hours():
        prev_date = _previous_trading_day()
        cached = _load_daily_cache("turnover_top", prev_date)
        if cached and cached.get("stocks"):
            return {
                **cached,
                "is_historical": True,
                "historical_date": prev_date,
                "historical_note": f"非交易时段 · 显示 {prev_date} 收盘数据",
            }

    def build():
        stocks = astock.market_turnover_rank(20)
        today = datetime.now(BEIJING).strftime("%Y-%m-%d")
        result = {
            "stocks": stocks,
            "updated": datetime.now(BEIJING).strftime("%Y-%m-%d %H:%M"),
            "is_historical": False,
        }
        # 收盘后保存当日快照到历史缓存（每天只存一次足够）
        if _is_a_share_closed():
            _save_daily_cache("turnover_top", today, result)
        return result

    result = _cached("turnover_top", build, valid=lambda v: bool(v.get("stocks")))

    # 如果实时获取失败，兜底用上一交易日缓存
    if not result.get("stocks"):
        prev_date = _previous_trading_day()
        cached = _load_daily_cache("turnover_top", prev_date)
        if cached and cached.get("stocks"):
            return {
                **cached,
                "is_historical": True,
                "historical_date": prev_date,
                "historical_note": f"实时数据获取失败 · 显示 {prev_date} 收盘数据",
            }

    return result


def get_global_indices() -> list[dict]:
    """全球指数快照（美股 / 港股，含缓存 5 分钟）。空结果不缓存。"""
    return _cached("global_indices", gstock.global_indices, valid=bool)


# ---------- 交易时段判断 + 今日实时打板情绪 ----------

def _is_weekend(d) -> bool:
    return d.weekday() >= 5


def _is_a_share_closed() -> bool:
    """A 股是否已收盘（上海时间 15:05 后）。"""
    n = datetime.now(BEIJING)
    return (n.hour, n.minute) >= (15, 5)


def _quote_trade_day() -> str | None:
    """通过腾讯实时行情时间戳判断当前行情属于哪个交易日。"""
    import urllib.request
    try:
        raw = urllib.request.urlopen("http://qt.gtimg.cn/q=sh600000", timeout=8).read().decode("gbk", "ignore")
        f = raw.split("~")
        ts = f[30].strip() if len(f) > 30 else ""
        if len(ts) >= 8 and ts[:8].isdigit():
            return f"{ts[:4]}-{ts[4:6]}-{ts[6:8]}"
    except Exception:
        pass
    return None


_LIVE_CACHE: dict = {}
_LIVE_TTL = 15.0      # 今日池子 15 秒
_PREV_TTL = 3600.0    # 昨日池子盘中不变


def _live_cached(key: str, ttl: float, fn):
    now = time.time()
    hit = _LIVE_CACHE.get(key)
    if hit and now - hit[0] < ttl:
        return hit[1]
    val = fn()
    if val is not None:
        _LIVE_CACHE[key] = (now, val)
    return val


def get_market_session() -> dict:
    """此刻实时行情属于哪一场（盘前/盘中/已收盘/非交易日）。"""
    today = datetime.now(BEIJING).strftime("%Y-%m-%d")
    quotes_of = _quote_trade_day()
    is_today = bool(quotes_of) and quotes_of == today
    closed = _is_a_share_closed()
    now = datetime.now(BEIJING)
    hhmm = now.hour * 60 + now.minute

    if not quotes_of:
        phase, label = "未知", "行情时间取不到"
    elif is_today and not closed and hhmm < 9 * 60 + 25:
        phase, label = "集合竞价", "集合竞价 · 尚未成交"
    elif is_today and not closed:
        phase, label = "盘中", "盘中 · 实时"
    elif is_today:
        phase, label = "已收盘", f"{today} 收盘"
    elif _is_weekend(now.date()):
        phase, label = "非交易日", f"非交易日 · 显示 {quotes_of} 收盘"
    elif not closed:
        phase, label = "盘前", f"盘前 · 显示 {quotes_of} 收盘"
    else:
        phase, label = "已收盘", f"已收盘 · 显示 {quotes_of} 收盘"

    return {
        "now": now.strftime("%Y-%m-%d %H:%M"),
        "today": today,
        "quotes_of": quotes_of,
        "is_today": is_today,
        "phase": phase,
        "label": label,
    }


def _live_pool(kind: str, ymd: str) -> list[dict] | None:
    """取东财涨停板池子（不加锁的实时出口）。"""
    try:
        return astock.em_zt_topic_pool(kind, ymd, "fbt:asc") or []
    except Exception:
        return None


def _prev_trade_date(today_str: str) -> str | None:
    """简易前一交易日：往前找第一个工作日。"""
    from datetime import timedelta
    d = datetime.strptime(today_str, "%Y-%m-%d")
    for i in range(1, 10):
        pd = d - timedelta(days=i)
        if pd.weekday() < 5:
            return pd.strftime("%Y-%m-%d")
    return None


def get_live_emotion() -> dict:
    """今日实时打板情绪（盘中随盘变化）。非交易时段/取不到 → available=False。"""
    today = datetime.now(BEIJING).strftime("%Y-%m-%d")
    ymd = today.replace("-", "")

    zt = _live_cached(f"live_zt:{ymd}", _LIVE_TTL, lambda: _live_pool("getTopicZTPool", ymd))
    if zt is None:
        return {"available": False, "reason": "涨停池取数失败"}
    if not zt:
        return {"available": False, "date": today, "reason": "今日还没有涨停池（未开盘 / 非交易日）"}

    zb = _live_cached(f"live_zb:{ymd}", _LIVE_TTL, lambda: _live_pool("getTopicZBPool", ymd))
    dt = _live_cached(f"live_dt:{ymd}", _LIVE_TTL, lambda: _live_pool("getTopicDTPool", ymd))

    boards = [_num(p.get("lbc")) or 1 for p in zt]
    zt_n = len(zt)
    zb_n = len(zb) if zb is not None else None
    tried = zt_n + zb_n if zb_n is not None else None

    # 晋级率：昨日涨停的票今天又封住
    prev_day = _prev_trade_date(today)
    prev = None
    if prev_day:
        prev = _live_cached(f"live_zt:{prev_day.replace('-','')}", _PREV_TTL,
                            lambda: _live_pool("getTopicZTPool", prev_day.replace("-", "")))
    today_codes = {str(p.get("c")) for p in zt}
    promo = None
    promo_base = None
    if prev:
        promo_base = len(prev)
        promo = round(sum(1 for p in prev if str(p.get("c")) in today_codes) / promo_base, 4) if promo_base else None

    settled = _is_a_share_closed()
    return {
        "available": True,
        "date": today,
        "as_of": datetime.now(BEIJING).strftime("%H:%M"),
        "phase": "盘中" if not settled else "已收盘",
        "zt_count": zt_n,
        "dt_count": len(dt) if dt is not None else None,
        "zb_count": zb_n,
        "max_boards": max(boards) if boards else 0,
        "lianban_count": sum(1 for b in boards if b >= 2),
        "seal_rate": round(zt_n / tried, 4) if tried else None,
        "break_rate": round(zb_n / tried, 4) if (tried and zb_n is not None) else None,
        "promotion_rate": promo,
        "promotion_base": promo_base,
        "promotion_base_date": prev_day,
    }
