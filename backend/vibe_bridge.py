"""Vibe-Astock 桥接模块 —— 把 vibe-astock 的派生情绪指标/验证条件/反思回看接入 Vibe-Research。

vibe-astock 的代码在 ../vibe-astock/，这里把它加到 sys.path，
然后惰性导入 duanxian 包里的函数。vibe-astock 服务没装/没跑时优雅降级。
"""

from __future__ import annotations

import os
import sys
import logging

logger = logging.getLogger(__name__)

_VIBE_ASTOCK_ROOT = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "..", "vibe-astock")
)

_path_added = False


def _ensure_path():
    """把 vibe-astock 根目录加到 sys.path（只加一次）。"""
    global _path_added
    if _path_added:
        return
    if os.path.isdir(_VIBE_ASTOCK_ROOT) and _VIBE_ASTOCK_ROOT not in sys.path:
        sys.path.insert(0, _VIBE_ASTOCK_ROOT)
    _path_added = True


def _today() -> str:
    """最近的已收盘交易日（非交易时段返回今天）。"""
    try:
        _ensure_path()
        from duanxian.util import china_today
        from duanxian import trade_calendar
        today = china_today()
        # 非交易时段用上一个交易日
        if not trade_calendar.is_settled(today):
            return trade_calendar.latest_session() or today
        return today
    except Exception:
        from datetime import datetime, timezone, timedelta
        bj = timezone(timedelta(hours=8))
        return datetime.now(bj).strftime("%Y-%m-%d")


# ────────────────────── 派生情绪指标 ──────────────────────

def get_derived_emotion(date: str | None = None) -> dict:
    """获取 vibe-astock 的派生情绪指标。

    返回赚钱效应/晋级率/连板溢价/梯队断层/情绪周期位置。
    """
    try:
        _ensure_path()
        from duanxian import emotion_metrics as em
        d = date or _today()
        return em.build_metrics(d, with_cycle=True)
    except Exception as exc:
        logger.warning("派生情绪指标获取失败: %s: %s", type(exc).__name__, exc)
        return {"available": False, "reason": f"{type(exc).__name__}: {exc}"}


def render_derived_emotion(metrics: dict | None = None) -> str:
    """把派生指标渲染成可读文本。"""
    try:
        _ensure_path()
        from duanxian import emotion_metrics as em
        if metrics is None:
            metrics = get_derived_emotion()
        return em.render_metrics(metrics)
    except Exception as exc:
        logger.warning("派生指标渲染失败: %s: %s", type(exc).__name__, exc)
        return f"[派生指标渲染失败: {exc}]"


# ────────────────────── 历史市场数据 ──────────────────────

def get_historical_market(date: str) -> dict:
    """获取某天的历史市场数据（涨跌家数/封板质量/亏钱效应/题材结构等）。

    从 vibe-astock 的缓存中读取，缓存不存在时实时获取并落盘。
    用于前端历史日期模式下渲染盘面数据。
    """
    try:
        _ensure_path()
        from duanxian import data as ds
        # get_market_facts 返回 (文本, 结构化dict)，我们只要结构化的
        _, facts = ds.get_market_facts(date)
        return facts
    except Exception as exc:
        logger.warning("历史市场数据获取失败 date=%s: %s: %s", date, type(exc).__name__, exc)
        return {}


# ────────────────────── 复盘存档（按日期） ──────────────────────

def get_review_dates() -> list[str]:
    """有哪些历史复盘日期（新→旧）。"""
    try:
        _ensure_path()
        from duanxian import review_store
        return review_store.dates()
    except Exception:
        return []


def get_review(date: str | None = None) -> dict | None:
    """读某天的复盘存档；date=None 读最近一份。没有返回 None。"""
    try:
        _ensure_path()
        from duanxian import review_store
        return review_store.load(date)
    except Exception:
        return None


# ────────────────────── 明日验证条件 ──────────────────────

def _verification_from_plan(date: str) -> dict | None:
    """从复盘计划文本中提取验证条件。

    当没有结构化 AI 复盘存档时，基于用户录入的复盘计划
    自动生成可核验的验证条件。
    """
    try:
        import review_plans
        plan = review_plans.get_latest_review_plan(date)
        if not plan or not plan.get("plan_text"):
            return None

        text = plan["plan_text"]
        tags = plan.get("tags", [])
        items = []

        # 从复盘计划中提取关键预期，生成验证条件
        # 1. 最高标表现（从预期部分提取）
        if "传智" in text:
            items.append({
                "metric": "highest_board_pct",
                "label": "传智教育明日表现",
                "direction": "上升",
                "reason": "传智7板预期+5以上破异动，锚定天娱、达实；若高开断板则情绪退潮信号",
                "unit": "%",
                "higher_is_hotter": True,
            })

        # 2. 炸板率/分歧（情绪高潮后预期分歧）
        if "分歧" in text or "高潮" in text:
            items.append({
                "metric": "break_rate",
                "label": "炸板率（分歧检验）",
                "direction": "上升",
                "reason": "今天情绪高潮，明天预期分歧，炸板率应上升；若炸板率反而下降则超预期强",
                "unit": "%",
                "higher_is_hotter": False,
            })

        # 3. 题材集中度/主线
        if "主线" in text or "梯队" in text or "7321" in text:
            items.append({
                "metric": "theme_concentration",
                "label": "题材集中度（主线检验）",
                "direction": "上升",
                "reason": "AI应用7321梯队完整，需等最高标爆量检验后才能知道是否能破局成为主线",
                "higher_is_hotter": True,
            })

        # 4. 赚钱效应（去弱留强）
        if "去弱留强" in text or "观察日" in text:
            items.append({
                "metric": "money_effect",
                "label": "赚钱效应（去弱留强）",
                "direction": "下降",
                "reason": "情绪高潮后看分歧，去弱留强，赚钱效应应有所回落；若维持则超预期强",
                "higher_is_hotter": True,
            })

        # 5. 电力板块（分歧走弱预期）
        if "电力" in text and ("分歧" in text or "走弱" in text or "不看" in text):
            items.append({
                "metric": "sector_power",
                "label": "电力板块表现",
                "direction": "下降",
                "reason": "电力今天分歧走弱，明天主观不看；若反而走强则超预期",
                "higher_is_hotter": False,
            })

        # 6. 跌停/亏钱效应
        if "跌停" in text or "大面" in text or "亏钱" in text:
            items.append({
                "metric": "deep_loss_count",
                "label": "跌超5%家数",
                "direction": "上升",
                "reason": "情绪高潮后分歧，大面风险可能释放，跌超5%家数应增加",
                "higher_is_hotter": False,
            })

        if not items:
            # 兜底：至少返回一个基于情绪的验证条件
            items.append({
                "metric": "break_rate",
                "label": "炸板率（情绪检验）",
                "direction": "上升",
                "reason": "基于复盘计划：情绪高潮后预期分歧，炸板率应上升",
                "unit": "%",
                "higher_is_hotter": False,
            })

        # 情绪阶段推断
        phase = "分歧预期" if "分歧" in text else "高潮" if "高潮" in text else ""

        return {"items": items, "emotion_phase": phase}
    except Exception as exc:
        logger.warning("从复盘计划提取验证条件失败: %s: %s", type(exc).__name__, exc)
        return None


def get_latest_verification(date: str | None = None) -> dict:
    """获取某天复盘的明日验证条件（可核验的市场层面读数）。

    date=None 读最新一份；指定日期读那天的。
    指定日期但那天无复盘时，往前找最近有复盘的交易日，并标注 is_historical。
    从 ~/.duanxian-agents/reviews/ 读复盘，取出其中的 focus.verification_items。
    如果该日期没有结构化 AI 复盘存档但有复盘计划，则从计划文本中提取验证条件。
    """
    try:
        _ensure_path()
        from duanxian import review_store

        review = None
        actual_date = date
        is_historical = False

        if date:
            review = review_store.load(date)
            if not review:
                # 指定日期无结构化存档，检查是否有复盘计划
                plan_items = _verification_from_plan(date)
                if plan_items:
                    return {
                        "available": True,
                        "review_date": date,
                        "emotion_phase": plan_items.get("emotion_phase", ""),
                        "items": plan_items["items"],
                        "source": "review_plan",
                    }
                # 没有复盘计划，往前找最近有复盘的交易日
                dates = review_store.dates()
                for d in dates:
                    if d < date:
                        review = review_store.load(d)
                        actual_date = d
                        is_historical = True
                        break
        else:
            # date=None：优先检查最新复盘计划，因为它可能比结构化存档更新
            import review_plans
            latest_plan = review_plans.get_latest_review_plan()
            dates = review_store.dates()
            structured_latest = dates[0] if dates else None

            # 如果最新复盘计划比结构化存档更新（或结构化存档不存在），用复盘计划
            if latest_plan and latest_plan.get("date"):
                plan_date = latest_plan["date"]
                if not structured_latest or plan_date > structured_latest:
                    plan_items = _verification_from_plan(plan_date)
                    if plan_items:
                        return {
                            "available": True,
                            "review_date": plan_date,
                            "emotion_phase": plan_items.get("emotion_phase", ""),
                            "items": plan_items["items"],
                            "source": "review_plan",
                        }

            if not structured_latest:
                return {"available": False, "reason": "暂无复盘记录"}

            # 结构化存档比复盘计划新，或复盘计划无可用数据，用结构化存档
            actual_date = structured_latest
            review = review_store.load(actual_date)

        if not review:
            return {"available": False, "reason": f"无法读取复盘"}

        focus = review.get("focus") or {}
        items = focus.get("verification_items") or []

        # 补上今日基准值和阈值
        if items:
            try:
                from duanxian import verification as vf
                metrics = review.get("emotion_metrics") or {}
                facts = review.get("market_facts") or {}
                items = vf.describe_items(items, metrics, facts)
            except Exception:
                pass  # describe_items 失败就返回原始 items

        result = {
            "available": True,
            "review_date": actual_date,
            "emotion_phase": focus.get("emotion_phase"),
            "items": items,
        }
        if is_historical:
            result["is_historical"] = True
            result["historical_note"] = f"{date} 无复盘 · 显示 {actual_date} 的验证条件"
        return result
    except Exception as exc:
        logger.warning("验证条件获取失败: %s: %s", type(exc).__name__, exc)
        return {"available": False, "reason": f"{type(exc).__name__}: {exc}"}


# ────────────────────── 反思回看（T+1 命中） ──────────────────────

def get_latest_reflection() -> dict:
    """获取最近一次反思回看结果。

    如果还没有生成回看，尝试自动评估最近一个可评估的预测日。
    保证用户能看到上期回看，而不是空数据。
    """
    try:
        _ensure_path()
        from duanxian import reflection
        from duanxian import review_store

        r = reflection.latest_reflection()
        if r:
            return {"available": True, **r}

        # 没有现成的回看，尝试自动评估最近的预测
        dates = review_store.dates()
        if len(dates) < 2:
            return {"available": False, "reason": "暂无回看记录（需先完成至少两天的复盘，次日盘后自动生成回看）"}

        # 从新到旧找第一个可以评估的预测日（次一交易日已过且已收盘）
        import datetime
        from .util import china_today, is_a_share_closed
        today = china_today()

        for pred_date in dates[1:]:  # 跳过最新的，因为它的次日可能还没到
            eval_date = reflection._next_trade_date(pred_date)
            if not eval_date:
                continue
            if eval_date > today:
                continue  # 次日还没到
            if eval_date == today and not is_a_share_closed():
                continue  # 今天但还没收盘
            # 尝试评估
            r = reflection.evaluate(pred_date, eval_date)
            if r:
                return {"available": True, **r}

        return {"available": False, "reason": "暂无回看记录（最新复盘的次日还没收盘，盘后自动生成）"}
    except Exception as exc:
        logger.warning("回看获取失败: %s: %s", type(exc).__name__, exc)
        return {"available": False, "reason": f"{type(exc).__name__}: {exc}"}


def get_scoreboard() -> dict:
    """获取 AI 判断的累计战绩。"""
    try:
        _ensure_path()
        from duanxian import reflection
        return reflection.scoreboard()
    except Exception as exc:
        logger.warning("战绩获取失败: %s: %s", type(exc).__name__, exc)
        return {"phase": {"decided": 0, "hits": 0, "enough_samples": False},
                "stock": {"days": 0, "samples": 0, "hits": 0, "hit_rate": None},
                "recent": []}


def get_past_context(limit: int = 5) -> str:
    """获取过往命中回看摘要（供 AI 复盘 prompt 注入）。"""
    try:
        _ensure_path()
        from duanxian import reflection
        return reflection.get_past_context(limit)
    except Exception:
        return ""


# ────────────────────── 情绪温度分项读数 ──────────────────────

def get_emotion_subscores(date: str | None = None) -> dict:
    """从派生指标中提取温度分项读数，供 sentiment.py 加权用。

    把 vibe-astock 的专业指标映射成 Vibe-Research 温度系统的分项：
    - 赚钱效应中位数 → real_profit 因子
    - 晋级率 → lianban 因子
    - 炸板率 → tug_of_war 因子的封板率分项
    - 梯队断层 → extreme 因子
    """
    try:
        m = get_derived_emotion(date)
        if not m.get("available") and m.get("reason"):
            # build_metrics 不返回 available 字段，检查子项
            pass

        sub = {}

        # 赚钱效应
        me = m.get("money_effect") or {}
        if me.get("available"):
            sub["money_effect"] = {
                "median": me.get("median"),
                "avg": me.get("avg"),
                "positive_rate": me.get("positive_rate"),
                "limit_up_again_rate": me.get("limit_up_again_rate"),
            }

        # 晋级率
        pr = m.get("promotion") or {}
        if pr.get("available"):
            sub["promotion"] = {
                "overall_rate": (pr.get("overall") or {}).get("rate"),
                "tiers": pr.get("tiers") or {},
            }

        # 连板溢价
        cp = m.get("consec_premium") or {}
        if cp.get("available"):
            sub["consec_premium"] = {
                "avg": cp.get("avg"),
                "median": cp.get("median"),
                "positive_rate": cp.get("positive_rate"),
            }

        # 梯队断层
        lg = m.get("ladder_gap") or {}
        if lg.get("available"):
            sub["ladder_gap"] = {
                "highest": lg.get("highest"),
                "continuous": lg.get("continuous"),
                "gaps": lg.get("gaps") or [],
            }

        # 情绪周期
        cy = m.get("cycle") or {}
        if cy.get("available"):
            sub["cycle"] = {
                "day_n": cy.get("day_n"),
                "rising": cy.get("rising"),
                "trend": cy.get("trend"),
                "pctile": cy.get("pctile"),
            }

        return sub if sub else {"available": False, "reason": "派生指标暂不可用"}
    except Exception as exc:
        logger.warning("分项读数获取失败: %s: %s", type(exc).__name__, exc)
        return {"available": False, "reason": f"{type(exc).__name__}: {exc}"}
