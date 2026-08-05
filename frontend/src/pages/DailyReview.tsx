import { useState, useEffect, useRef, Fragment } from "react";
import { Link } from "react-router-dom";
import { Sparkles, Loader2, AlertCircle, RefreshCw, Gauge, ArrowDownUp, TrendingUp, TrendingDown, Plus, X, Flame, BarChart3, Globe, CheckCircle, History, CalendarClock, Calendar, AlertTriangle, Crosshair, FileText, Save, MessageSquare, Send, Edit3, Check } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { GlassCard } from "@/components/ui/GlassCard";
import { AskAiButton } from "@/components/ui/AskAiButton";
import { Disclaimer } from "@/components/ui/Disclaimer";
import { Caliber } from "@/components/ui/Caliber";
import { useDeepDive, DeepDivePanel, RunAllButton, type DiveItem } from "@/components/ui/DeepDive";
import { api, ApiError, type IndexQuote, type Quote, type MarketOverview, type ShortTermEmotion, type LianbanStock, type TurnoverTop, type GlobalIndex, type MarketSession, type LiveEmotion, type DerivedEmotion, type VerificationData, type ReflectionData, type ReviewData, type TomorrowFocus, type CoreStocksData, type CoreStock, type ReviewPlan, type TemperatureView, type AiReviewRecord, type AiChatMsg } from "@/lib/api";
import { hasLlm, chatStream } from "@/lib/llm";
import { SaveNoteButton } from "@/components/ui/SaveNoteButton";
import { loadWatch, saveWatch, addCodes } from "@/lib/watchlist";
import { cn } from "@/lib/utils";

// A股红涨绿跌。全球市场（美股/港股指数）**也沿用红涨**——与整个看板及东财等中国平台一致，
// 对中国用户最不易看错（Simon 2026-07-05 确认；非国际绿涨惯例，是有意选择，勿改）。
const pctColor = (p: number) => (p > 0 ? "text-danger" : p < 0 ? "text-success" : "text-muted-foreground");
const fmt = (v: number) => v.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const yi = (v: number | null) => (v == null ? "—" : `${fmt(v / 1e8)} 亿`); // 元 → 亿
const pct = (v: number | null | undefined) => v == null ? "—" : `${(v * 100).toFixed(1)}%`;

/** 东财 hybk 是 4 字截断行业名（如「汽车零部」「互联网电」），按关键词归到大板块。 */
function mapToSector(industry: string): string {
  const s = (industry || "").trim();
  if (!s) return "其他";
  if (/电子|通信|计算机|软件|传媒|互联网|游戏|影视|芯片|半导体|元件|数据|信息|广告|出版|版权|数字|算力|人工智能|机器人|智能|AIGC|大模型|激光|消费电子/.test(s)) return "科技";
  if (/零售|食品|饮料|酿酒|白酒|啤酒|乳品|肉制品|调味|纺织|服装|家纺|家电|商贸|百货|超市|便利店|餐饮|酒店|旅游|景区|轻工|文教|休闲|家居|珠宝|宠物|母婴|化妆品|黄金/.test(s)) return "消费";
  if (/医药|医疗|中药|生物|制药|器械|医药商业|兽药|疫苗|眼科|牙科|医美|康复/.test(s)) return "医药";
  if (/银行|证券|保险|金融|信托|期货|创投|典当|租赁|多元金融/.test(s)) return "金融";
  if (/光伏|风电|储能|锂电|电池|新能源|充电|氢能|核电|特高压|电网|智能电网/.test(s)) return "新能源";
  if (/钢铁|有色|煤炭|化工|化纤|塑料|橡胶|建材|玻璃|水泥|石油|石化|采掘|稀土|锂|镍|铜|铝|钛|钨|盐湖/.test(s)) return "周期";
  if (/机械|电气|设备|汽车|军工|国防|专用|通用|仪器|自动化|船舶|航空|航天|工业母机|工程机械|农机/.test(s)) return "制造";
  if (/房地产|建筑|装饰|基建|工程|建材|装修|物业|租售/.test(s)) return "地产基建";
  if (/电力|燃气|环保|水务|供热|垃圾处理|节能/.test(s)) return "公用事业";
  if (/农业|养殖|种植|饲料|林业|渔业|农药|化肥|种业|生猪|鸡/.test(s)) return "农林牧渔";
  if (/港口|航运|铁路|公路|物流|机场|航空|运输|快递|仓储|管道/.test(s)) return "交通运输";
  return "其他";
}

// 大板块展示顺序
const SECTOR_ORDER = ["科技", "消费", "制造", "医药", "周期", "新能源", "金融", "地产基建", "公用事业", "农林牧渔", "交通运输", "其他"];
const sectorSortIdx = (s: string) => { const i = SECTOR_ORDER.indexOf(s); return i < 0 ? SECTOR_ORDER.length : i; };

export function DailyReview() {
  const [indices, setIndices] = useState<IndexQuote[]>([]);
  const [idxErr, setIdxErr] = useState(false);
  const [reviewErr, setReviewErr] = useState<string | null>(null);
  const [needConfig, setNeedConfig] = useState(false);
  const [overview, setOverview] = useState<MarketOverview | null>(null);
  const [emotion, setEmotion] = useState<ShortTermEmotion | null>(null);
  const [turnover, setTurnover] = useState<TurnoverTop | null>(null);
  const [globalIdx, setGlobalIdx] = useState<GlobalIndex[]>([]);
  // 关注股票（自选，存本地）
  const [watchCodes, setWatchCodes] = useState<string[]>(loadWatch);
  const [watchQuotes, setWatchQuotes] = useState<Record<string, Quote>>({});
  const [watchInput, setWatchInput] = useState("");
  const [watchLoading, setWatchLoading] = useState(false);

  // 各数据块请求是否已结束：区分「加载中」与「数据源暂不可用」（非交易时段/被限流时后端返回空）
  const [ovDone, setOvDone] = useState(false);
  const [emoDone, setEmoDone] = useState(false);
  const [toDone, setToDone] = useState(false);
  // 派生情绪指标 / 明日验证条件 / 上期回看
  const [derived, setDerived] = useState<DerivedEmotion | null>(null);
  const [derivedDone, setDerivedDone] = useState(false);
  const [verification, setVerification] = useState<VerificationData | null>(null);
  const [veriDone, setVeriDone] = useState(false);
  const [reflection, setReflection] = useState<ReflectionData | null>(null);
  const [reflDone, setReflDone] = useState(false);
  // 涨停板切换：连板 / 首板
  const [ztTab, setZtTab] = useState<"lianban" | "shouban">("lianban");
  // 各大板块选中的细分行业筛选（key=`${ztTab}:${sector}`，value=选中的细分行业名或"全部"）
  const [sectorFilter, setSectorFilter] = useState<Record<string, string>>({});
  // 交易时段 + 今日实时打板情绪 + 连板股实时行情 + 自动刷新
  const [session, setSession] = useState<MarketSession | null>(null);
  const [liveEmo, setLiveEmo] = useState<LiveEmotion | null>(null);
  const [lianbanQuotes, setLianbanQuotes] = useState<Record<string, Quote>>({});
  const [autoRefresh, setAutoRefresh] = useState<boolean>(
    () => localStorage.getItem("vr-auto-refresh") === "1");
  const LIVE_MS = 5_000;
  const HEAVY_MS = 60_000;

  // 日期选择 + 复盘存档
  // 非交易时段默认今天的日历日期；后端会自动返回最近交易日的数据
  const _todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
  const [reviewDate, setReviewDate] = useState<string>(_todayStr);   // 选中的复盘日期
  const [reviewDates, setReviewDates] = useState<string[]>([]);   // 可选的历史复盘日期
  const [reviewData, setReviewData] = useState<ReviewData | null>(null);  // 结构化复盘存档
  const [reviewLoading, setReviewLoading] = useState(false);       // 生成复盘中
  // AI 流式复盘（非结构化，在没有存档时作为备选输出）
  const [reviewText, setReviewText] = useState("");
  const [reviewFocus, setReviewFocus] = useState<TomorrowFocus | null>(null);  // 结构化 AI 研判

  // AI研判存储 + 编辑 + 对话调教
  const [aiReview, setAiReview] = useState<AiReviewRecord | null>(null);
  const [editingReview, setEditingReview] = useState(false);
  const [editText, setEditText] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [chatMessages, setChatMessages] = useState<AiChatMsg[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // 核心标的（多空三炮）
  const [coreStocks, setCoreStocks] = useState<CoreStocksData | null>(null);
  const [coreStocksDone, setCoreStocksDone] = useState(false);
  const [coreInput, setCoreInput] = useState({ code: "", name: "", dimension: "", reason: "", side: "bull" as "bull" | "bear" });
  const [coreSaving, setCoreSaving] = useState(false);

  // 复盘计划
  const [reviewPlans, setReviewPlans] = useState<ReviewPlan[]>([]);
  const [planText, setPlanText] = useState("");
  const [planTagItems, setPlanTagItems] = useState<{ text: string; isAuto: boolean }[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [planSaving, setPlanSaving] = useState(false);
  const [excludeCount, setExcludeCount] = useState(0);

  // 市场情绪温度（今日+昨日对比+权重体系+学习进度）
  const [tempView, setTempView] = useState<TemperatureView | null>(null);
  const [tempDone, setTempDone] = useState(false);
  const [tempInput, setTempInput] = useState("");
  const [tempSaving, setTempSaving] = useState(false);

  // 涨停股「AI 深入分析」（行内展开流式面板 + 本地存档 + 一键批量）
  const dd = useDeepDive("zt", emotion?.date || "");
  const ztPrompt = (s: LianbanStock) =>
    `${emotion?.date || ""} A 股涨停股「${s.name}（${s.code}）」的客观数据：\n` +
    `收盘 ${s.price} 元、涨停 +${s.pct}%，${s.boards > 1 ? `已连续涨停 ${s.boards} 天（${s.boards} 连板）` : "今日首板"}，` +
    `成交额 ${yi(s.amount)}，流通市值 ${yi(s.float_cap)}，所属概念/行业 ${s.industry || "未知"}，` +
    `涨停形态 ${s.pattern || "未知"}，最后封板时间 ${s.last_seal_time || "未知"}，炸板次数 ${s.break_count ?? 0}，` +
    `涨停原因题材：${s.reason || "（暂缺，需要自查）"}。\n\n` +
    "请深入分析这只股票本轮涨停的驱动：\n" +
    "1. 先调用工具查询这只股票的近期新闻与研报，结合上面的题材串，说清本轮涨停的核心驱动（消息面 / 题材面 / 资金面）" +
    (s.boards > 1 ? `，以及走到第 ${s.boards} 板的位置上驱动有没有变化` : "") + "；\n" +
    "2. 就**这个题材板块整体**说清它的强度与所处阶段（情绪接力 / 有产业逻辑或业绩支撑，发酵期 / 分歧期），" +
    "并给出依据 —— 只讲题材板块层面，不要由此推断这只个股接下来会怎样；\n" +
    "3. 客观列出值得注意的点（连板高度、成交额是放大还是缩量、流通盘大小、涨停形态、封板质量、题材扩散位置）。\n" +
    "个股层面只陈述已经发生的客观数据与事实，方向与强弱判断做到题材板块层面为止：" +
    "不预测个股涨跌、不给个股参与倾向、不推荐任何标的、不构成投资建议。" +
    "输出用纯 Markdown。";
  const ztCtx = (s: LianbanStock) => `涨停股 ${s.name}(${s.code}) ${s.boards > 1 ? `${s.boards}连板` : "首板"} 深入分析`;
  const ztItem = (s: LianbanStock): DiveItem => ({ key: s.code, prompt: ztPrompt(s), context: ztCtx(s) });

  // 是否查看历史日期（非今天）
  const isHistory = reviewDate !== _todayStr;

  // 加载实时盘面数据（仅今天调用）
  const loadRealtimeData = () => {
    api.indices().then(setIndices).catch(() => setIdxErr(true));
    api.globalIndices().then(setGlobalIdx).catch(() => {});
    api.marketSession().then(setSession).catch(() => {});
    api.liveEmotion().then(setLiveEmo).catch(() => {});
    api.marketOverview().then(setOverview).catch(() => {}).finally(() => setOvDone(true));
    api.emotion().then(setEmotion).catch(() => {}).finally(() => setEmoDone(true));
    api.turnoverTop().then(setTurnover).catch(() => {}).finally(() => setToDone(true));
    api.derivedEmotion().then(setDerived).catch(() => {}).finally(() => setDerivedDone(true));
    api.reflection().then(setReflection).catch(() => {}).finally(() => setReflDone(true));
  };

  // 加载所有与日期绑定的数据（切换日期时调用，整个盘面回到当天）
  const loadDateBoundData = (date: string) => {
    const hist = date !== _todayStr;
    // 复盘存档（AI 研判 + market_facts）
    api.reviewLatest(date || undefined).then((r) => {
      setReviewData(r);
      setReviewFocus(r?.focus || null);
      setReviewText(r?.focus_md || "");
    }).catch(() => { /* 保留已有数据，不清空 */ });

    // 加载已保存的AI研判（含编辑版/对话历史）
    api.aiReviewLatest(date).then((r) => {
      setAiReview(r || null);
      setChatMessages(r?.chat_history || []);
      setEditText(r?.edited_text || "");
      // 如果有保存的focus且当前没有reviewFocus，用它填充
      if (r?.focus && !reviewFocus) {
        setReviewFocus(r.focus);
      }
    }).catch(() => {});

    // 历史模式：直接从 vibe-astock 缓存获取市场数据（不依赖 review 存档）
    if (hist) {
      api.marketHistory(date).then((mf) => {
        const b = mf?.breadth;
        const sq = mf?.seal_quality;
        const le = mf?.loss_effect;
        const ztCount = sq?.total || 0;
        const dtCount = le?.market_limit_down || 0;

        // 市场情绪：breadth 有就用完整数据，没有也用 seal_quality/loss_effect 构造部分
        if (b?.available || ztCount > 0 || dtCount > 0) {
          const upVal = b?.up ?? 0;
          const downVal = b?.down ?? 0;
          const flatVal = b?.flat ?? 0;
          const total = upVal + downVal + flatVal;
          const ratio = total > 0 ? upVal / (downVal || 1) : 0;
          const breadthLabel = b?.available
            ? (upVal < 600 ? "冰点" : ratio < 0.7 ? "偏弱" : ratio < 1.2 ? "中性" : ratio < 2.5 ? "偏强" : "普涨")
            : "—";
          setOverview({
            sentiment: {
              up: upVal, down: downVal, flat: flatVal,
              zt: ztCount, zt_real: ztCount,
              dt: dtCount, dt_real: dtCount,
              active: "—", breadth: breadthLabel, speculation: "—",
              date: b?.date || date,
            },
            sectors: [], updated: date,
          });
          setOvDone(true);
        } else {
          setOverview(null); setOvDone(true);
        }

        // 短线情绪：seal_quality 有数据就显示
        if (sq?.available) {
          setEmotion({
            date: date, zt_count: sq.total || 0, dt_count: dtCount,
            zb_count: 0, max_boards: 0, lianban_count: 0, shouban_count: 0,
            ladder: [], lianban_stocks: [], shouban_stocks: [],
            seal_rate: null, break_rate: null, promotion_rate: null, yzt_count: 0,
          });
          setEmoDone(true);
        } else {
          setEmotion(null); setEmoDone(true);
        }
      }).catch(() => { setOverview(null); setEmotion(null); setOvDone(true); setEmoDone(true); });
    }
    // 核心标的（多空三炮）—— 今天不传 date 走实时路径（快），历史日期才传 date
    api.coreStocks(hist ? date : undefined).then(setCoreStocks).catch(() => {}).finally(() => setCoreStocksDone(true));
    // 该日期的复盘计划文本（预填到输入框）
    api.latestReviewPlan(date).then((p) => {
      setPlanText(p?.plan_text || "");
      const autoSet = new Set(p?.auto_tags || []);
      const allTags = p?.tags || [];
      setPlanTagItems(allTags.map((t: string) => ({ text: t, isAuto: autoSet.has(t) })));
    }).catch(() => {});
    // 验证条件
    api.verification(date || undefined).then(setVerification).catch(() => {}).finally(() => setVeriDone(true));
    // 派生情绪指标（后端支持 date 参数）
    api.derivedEmotion(date || undefined).then(setDerived).catch(() => {}).finally(() => setDerivedDone(true));
    // 市场情绪温度（今日+昨日对比+权重体系+学习进度）
    api.temperatureView(date || undefined).then((t) => {
      setTempView(t);
      // 预填用户校准输入框（已校正则显示用户值，否则空）
      setTempInput(t?.user?.temperature != null ? String(t.user.temperature) : "");
    }).catch(() => {}).finally(() => setTempDone(true));
    // 反思回看
    api.reflection().then(setReflection).catch(() => {}).finally(() => setReflDone(true));
  };

  const loadIndices = () => {
    if (!isHistory) {
      loadRealtimeData();
    }
    // 复盘日期列表 + 计划历史列表（不随日期变化）
    api.reviewDates().then((r) => setReviewDates(r.dates || [])).catch(() => {});
    api.reviewPlans(15).then((r) => setReviewPlans(r.plans || [])).catch(() => {});
    // 日期绑定的数据（核心标的 + 复盘存档 + 计划文本 + 验证条件 + 派生指标）
    loadDateBoundData(reviewDate);
  };

  // 切换日期 —— 整个盘面数据回到当天
  const onDateChange = (d: string) => {
    const date = d || _todayStr;  // 空值回退到今天
    const goingToHistory = date !== _todayStr;
    const wasHistory = reviewDate !== _todayStr;
    setReviewDate(date);
    setReviewErr(null);
    // 从历史回到今天：重新加载实时数据
    if (!goingToHistory && wasHistory) {
      loadRealtimeData();
    }
    // 历史模式：清空所有实时数据，避免显示今天的残留
    if (goingToHistory) {
      setIndices([]); setGlobalIdx([]); setLiveEmo(null); setSession(null);
      setOverview(null); setEmotion(null); setTurnover(null);
      setOvDone(false); setEmoDone(false); setToDone(false);
    }
    loadDateBoundData(date);
  };

  // ── 核心标的操作 ──
  const addCoreStock = () => {
    if (!coreInput.code || !coreInput.name) return;
    if (!coreStocks) return;
    const stock: CoreStock = {
      code: coreInput.code, name: coreInput.name,
      dimension: coreInput.dimension, reason: coreInput.reason,
    };
    const date = coreStocks.today_date;
    const bulls = coreInput.side === "bull"
      ? [...coreStocks.today.user_bulls, stock]
      : coreStocks.today.user_bulls;
    const bears = coreInput.side === "bear"
      ? [...coreStocks.today.user_bears, stock]
      : coreStocks.today.user_bears;
    setCoreSaving(true);
    api.saveCoreStocks(date, bulls, bears).then(() => {
      setCoreInput({ code: "", name: "", dimension: "", reason: "", side: coreInput.side });
      return api.coreStocks(date);
    }).then(setCoreStocks).catch(() => {}).finally(() => setCoreSaving(false));
  };

  const removeCoreStock = (side: "bull" | "bear", code: string) => {
    if (!coreStocks) return;
    const date = coreStocks.today_date;
    const bulls = side === "bull" ? coreStocks.today.user_bulls.filter((s) => s.code !== code) : coreStocks.today.user_bulls;
    const bears = side === "bear" ? coreStocks.today.user_bears.filter((s) => s.code !== code) : coreStocks.today.user_bears;
    setCoreSaving(true);
    api.saveCoreStocks(date, bulls, bears).then(() => api.coreStocks(date)).then(setCoreStocks).catch(() => {}).finally(() => setCoreSaving(false));
  };

  // ── 复盘计划操作 ──
  const savePlan = () => {
    if (!planText.trim()) return;
    const date = reviewDate || new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
    // 只把用户手动添加的标签发给后端，auto_tags 由后端提取
    const userTags = planTagItems.filter((t) => !t.isAuto).map((t) => t.text);
    setPlanSaving(true);
    api.saveReviewPlan(date, planText, userTags).then((r) => {
      // 后端返回合并后的标签（user + auto），更新 chip 列表
      const autoSet = new Set(r.auto_tags || []);
      const allTags = r.tags || [];
      setPlanTagItems(allTags.map((t: string) => ({ text: t, isAuto: autoSet.has(t) })));
      setExcludeCount(r.exclude_count || 0);
      // 重新加载计划列表
      return api.reviewPlans(15);
    }).then((r) => setReviewPlans(r.plans || [])).catch(() => {}).finally(() => setPlanSaving(false));
  };

  // 删除标签：auto 标签调后端排除（AI学习），user 标签仅本地移除
  const removeTag = (tagText: string, isAuto: boolean) => {
    const date = reviewDate || new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
    if (isAuto) {
      // 调后端删除 + 加入排除列表
      api.removePlanTag(date, tagText, true).then((r) => {
        const autoSet = new Set(r.auto_tags || []);
        const allTags = r.tags || [];
        setPlanTagItems(allTags.map((t: string) => ({ text: t, isAuto: autoSet.has(t) })));
        setExcludeCount((c) => c + 1);
        // 同步刷新历史列表中的标签
        return api.reviewPlans(15);
      }).then((r) => setReviewPlans(r.plans || [])).catch(() => {});
    } else {
      setPlanTagItems((prev) => prev.filter((t) => t.text !== tagText));
    }
  };

  // 添加自定义标签
  const addTag = () => {
    const text = tagInput.trim();
    if (!text) return;
    setPlanTagItems((prev) => {
      if (prev.some((t) => t.text === text)) return prev;
      return [...prev, { text, isAuto: false }];
    });
    setTagInput("");
  };

  // 保存用户校正的情绪温度（0-100，保存后触发系统学习权重）
  const saveTemperature = () => {
    const v = parseInt(tempInput, 10);
    if (isNaN(v) || v < 0 || v > 100) return;
    const date = reviewDate || new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
    setTempSaving(true);
    api.saveTemperature(date, v).then(() => {
      // 重新拉温度总览（含更新的权重体系 + 学习进度）
      return api.temperatureView(date || undefined);
    }).then((t) => {
      setTempView(t);
      setTempInput(t?.user?.temperature != null ? String(t.user.temperature) : "");
    }).catch(() => {}).finally(() => setTempSaving(false));
  };

  // 连板股名单到了之后补拉一次实时行情
  const refreshLianban = (codes: string[]) => {
    if (!codes.length) return;
    api.quote(codes.join(",")).then(setLianbanQuotes).catch(() => {});
  };

  // 数据块占位：请求没回来 = 加载中；回来了但为空 = 数据源暂不可用（别让用户干等）
  const pending = (done: boolean) => (
    <p className="py-4 text-center text-sm text-muted-foreground/60">
      {done ? "暂无数据：可能是非交易时段或数据源暂时不可用，可点「大盘指数」旁的刷新重试" : "加载中…"}
    </p>
  );

  const refreshWatch = (codes: string[]) => {
    if (!codes.length) { setWatchQuotes({}); return; }
    setWatchLoading(true);
    api.quote(codes.join(",")).then(setWatchQuotes).catch(() => {}).finally(() => setWatchLoading(false));
  };

  useEffect(() => {
    loadIndices();
    refreshWatch(loadWatch());
    // 加载关键词学习状态（已排除多少个关键词）
    api.keywordPreferences().then((p) => setExcludeCount(p.exclude_count || 0)).catch(() => {});
  }, []);

  // 连板股名单是异步来的，首次 loadIndices 时它还没回来 —— 名单一到补拉一次
  useEffect(() => {
    refreshLianban((emotion?.lianban_stocks ?? []).map((s) => s.code));
  }, [emotion?.date, emotion?.lianban_stocks?.length]);

  // 自动刷新：只在交易时段生效，收盘/非交易日不刷
  const liveNow = session?.phase === "盘中" || session?.phase === "集合竞价";
  useEffect(() => {
    if (!autoRefresh || !liveNow) return;
    const liveTimer = setInterval(() => {
      api.indices().then(setIndices).catch(() => {});
      api.marketSession().then(setSession).catch(() => {});
      api.liveEmotion().then(setLiveEmo).catch(() => {});
      if (watchCodes.length) refreshWatch(watchCodes);
      refreshLianban((emotion?.lianban_stocks ?? []).map((s) => s.code));
    }, LIVE_MS);
    const heavyTimer = setInterval(() => {
      api.marketOverview().then(setOverview).catch(() => {});
      api.turnoverTop().then(setTurnover).catch(() => {});
    }, HEAVY_MS);
    return () => { clearInterval(liveTimer); clearInterval(heavyTimer); };
  }, [autoRefresh, session?.phase, watchCodes, emotion?.date]);

  const toggleAuto = () => {
    const next = !autoRefresh;
    setAutoRefresh(next);
    localStorage.setItem("vr-auto-refresh", next ? "1" : "0");
  };

  const addWatch = () => {
    // 支持一次粘贴多只（逗号 / 空格分隔）；全部无效或重复则清空输入、无副作用。
    const { next, added } = addCodes(watchCodes, watchInput);
    setWatchInput("");
    if (!added) return;
    setWatchCodes(next); saveWatch(next); refreshWatch(next);
  };

  const removeWatch = (c: string) => {
    const next = watchCodes.filter((x) => x !== c);
    setWatchCodes(next); saveWatch(next); refreshWatch(next);
  };

  const today = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });

  const dataSummary = indices.length
    ? indices.map((i) => `${i.name} ${i.price}（${i.change_pct > 0 ? "+" : ""}${i.change_pct}%）`).join("；")
    : "（指数数据未取到）";

  const runReview = async () => {
    setReviewErr(null);
    setNeedConfig(false);
    if (!hasLlm()) { setNeedConfig(true); return; }
    setReviewLoading(true);
    setReviewText("");
    setReviewFocus(null);
    // 汇总当日所有客观数据给 AI
    const emo = emotion ? `\n涨停 ${emotion.zt_count}、跌停 ${emotion.dt_count}、炸板 ${emotion.zb_count}、最高连板 ${emotion.max_boards} 板、连板 ${emotion.lianban_count} 家、封板率 ${pct(emotion.seal_rate)}、炸板率 ${pct(emotion.break_rate)}、晋级率 ${pct(emotion.promotion_rate)}` : "";
    const sent = sentiment ? `\n上涨 ${sentiment.up}、下跌 ${sentiment.down}、涨停 ${sentiment.zt}（真实 ${sentiment.zt_real}）、跌停 ${sentiment.dt}、活跃度 ${sentiment.active}、大盘宽度 ${sentiment.breadth}、题材投机 ${sentiment.speculation}` : "";
    const sec = sectors.length ? `\n板块资金流入前3：${sectors.slice(0, 3).map((s) => `${s.name}(${s.pct > 0 ? "+" : ""}${s.pct}%,净${s.net > 0 ? "+" : ""}${fmt(s.net)}亿)`).join("、")}` : "";
    const der = derived?.money_effect?.available ? `\n赚钱效应中位数 ${derived.money_effect.median?.toFixed(2)}%、红盘率 ${pct(derived.money_effect.positive_rate)}` : "";
    // 核心标的信息也打包给 AI
    const coreInfo = coreStocks?.yesterday?.has_data
      ? `\n昨日核心标的：多方[${coreStocks.yesterday.bulls.map(s => s.name).join("、")}]，空方[${coreStocks.yesterday.bears.map(s => s.name).join("、")}]`
      : "";
    const prompt =
      `以下是 ${reviewDate || "今天"} A 股的客观数据：\n${dataSummary}${emo}${sent}${sec}${der}${coreInfo}\n\n` +
      "请基于以上数据做结构化盘面研判，**只输出 JSON**，不要输出其他内容。格式如下：\n" +
      '{\n' +
      '  "emotion_phase": "情绪档位，只能填：冰点/修复/发酵/亢奋/退潮 之一",\n' +
      '  "market_oneliner": "今日盘面一句话总结",\n' +
      '  "focus_directions": [\n' +
      '    {"direction": "题材/板块名", "logic": "今日活跃的支撑依据(逻辑链)", "risk": "风险/证伪点"}\n' +
      '  ],\n' +
      '  "risk_alerts": ["风险信号1", "风险信号2"]\n' +
      '}\n' +
      '（focus_directions 必须 2~5 个）\n\n' +
      "要求：基于数据讲清楚今天盘面发生了什么、为什么，把依据摆出来。" +
      "如果附带了用户历史复盘计划，请参考用户的复盘思路、关注维度和表达方式来组织研判。" +
      "个股只作客观陈述（涨停梯队、题材归属等公开事实），" +
      "不点名推荐、不给参与倾向、不给买卖点位。";
    let full = "";
    try {
      // 走 /api/ai-review 端点：后端会自动注入用户历史复盘计划风格 + 情绪温度校准参考
      await chatStream([{ role: "user", content: prompt }], `今日大盘数据：${dataSummary}`, {
        onDelta: (t) => { full += t; setReviewText(full); },
      }, undefined, "/api/ai-review");
      // 尝试解析 JSON
      const jsonStr = extractJson(full);
      if (jsonStr) {
        try {
          const parsed = JSON.parse(jsonStr) as TomorrowFocus;
          if (parsed.emotion_phase && parsed.focus_directions?.length >= 2) {
            setReviewFocus(parsed);
            // 自动保存研判结果到后端
            api.saveAiReview(reviewDate || _todayStr, parsed, full, "manual").then(() => {
              // 刷新已保存的AI研判状态
              api.aiReviewLatest(reviewDate || _todayStr).then(setAiReview).catch(() => {});
            }).catch(() => {});
          }
        } catch { /* JSON 解析失败，保留纯文本 */ }
      }
    } catch (e) {
      setReviewErr(e instanceof ApiError ? e.message : "复盘失败");
    } finally {
      setReviewLoading(false);
    }
  };

  /** 从可能包含 markdown 代码块的文本中提取 JSON 字符串 */
  const extractJson = (text: string): string | null => {
    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) return m[1].trim();
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    if (s >= 0 && e > s) return text.slice(s, e + 1);
    return null;
  };

  /** 对话调教：发送消息给AI，流式接收回复 */
  const sendChat = async () => {
    const input = chatInput.trim();
    if (!input || chatLoading) return;
    if (!hasLlm()) { setNeedConfig(true); return; }

    const userMsg: AiChatMsg = { role: "user", content: input };
    const newMessages = [...chatMessages, userMsg];
    setChatMessages(newMessages);
    setChatInput("");
    setChatLoading(true);

    // 添加一个空的AI回复占位
    const aiPlaceholder: AiChatMsg = { role: "assistant", content: "" };
    setChatMessages([...newMessages, aiPlaceholder]);

    try {
      const llm = (await import("@/lib/llm")).loadLlm();
      if (!llm) throw new ApiError("未接入AI", 400);

      let aiText = "";
      await chatStream(
        newMessages.map(m => ({ role: m.role, content: m.content })),
        "",
        {
          onDelta: (t) => {
            aiText += t;
            // 更新最后一条消息
            setChatMessages(prev => {
              const updated = [...prev];
              updated[updated.length - 1] = { role: "assistant", content: aiText };
              return updated;
            });
          },
        },
        undefined,
        "/api/ai-reviews/chat"
      );
      // 对话完成后刷新AI研判状态（后端已保存对话）
      api.aiReviewLatest(reviewDate || _todayStr).then(setAiReview).catch(() => {});
    } catch (e) {
      // 移除空占位，显示错误
      setChatMessages(prev => {
        const updated = [...prev];
        updated[updated.length - 1] = { role: "assistant", content: `[出错] ${e instanceof ApiError ? e.message : "对话失败"}` };
        return updated;
      });
    } finally {
      setChatLoading(false);
      // 滚动到底部
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
    }
  };

  const sentiment = overview?.sentiment;
  const sectors = overview?.sectors || [];
  const sentCells = sentiment ? [
    { k: "上涨家数", v: sentiment.up, up: true },
    { k: "下跌家数", v: sentiment.down, up: false },
    { k: "平盘", v: sentiment.flat, up: null },
    { k: "涨停", v: sentiment.zt, up: true },
    { k: "真实涨停", v: sentiment.zt_real, up: true },
    { k: "跌停", v: sentiment.dt, up: false },
    { k: "真实跌停", v: sentiment.dt_real, up: false },
    { k: "活跃度", v: sentiment.active, up: null },
  ] : [];

  // 情绪档位着色
  const phaseTone = (phase: string) => {
    if (/冰点/.test(phase)) return "bg-muted/40 text-muted-foreground";
    if (/修复/.test(phase)) return "bg-success/15 text-success";
    if (/发酵/.test(phase)) return "bg-primary/15 text-primary";
    if (/亢奋/.test(phase)) return "bg-danger/15 text-danger";
    if (/退潮/.test(phase)) return "bg-warning/15 text-warning";
    return "bg-muted/40 text-muted-foreground";
  };

  return (
    <div>
      <PageHeader
        title="每日复盘"
        subtitle={`${reviewDate && reviewDate !== _todayStr ? `查看 ${reviewDate} 的复盘` : (session?.label ?? today)} · 大盘 / 情绪 / 板块资金一屏看全，交给你的 AI 做复盘`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {/* 日期选择器 */}
            <div className="flex flex-col items-start">
              <div className="flex items-center gap-1">
                <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                <input type="date" value={reviewDate} list="review-dates"
                  onChange={(e) => onDateChange(e.target.value)}
                  className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs text-foreground"
                />
                <datalist id="review-dates">
                  {reviewDates.map((d) => <option key={d} value={d} />)}
                </datalist>
                {reviewDate && reviewDate !== _todayStr && (
                  <button onClick={() => onDateChange(_todayStr)}
                    className="rounded px-1.5 py-1 text-[10px] text-muted-foreground hover:text-primary"
                    title="回到今天">今天</button>
                )}
              </div>
              {reviewDates.length > 0 && (
                <div className="mt-0.5 flex flex-wrap gap-1 text-[10px] text-muted-foreground">
                  {reviewDates.slice(0, 5).map((d) => (
                    <button key={d} onClick={() => onDateChange(d)}
                      className={cn("rounded px-1.5 py-0.5 transition-colors hover:text-primary",
                        reviewDate === d ? "bg-primary/15 text-primary" : "bg-muted/40")}>
                      {d.slice(5)}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={toggleAuto}
              title={autoRefresh
                ? `已开：指数/自选每 ${LIVE_MS / 1000} 秒、板块资金每 ${HEAVY_MS / 1000} 秒。只在盘中生效`
                : "开启后在交易时段自动刷新行情"}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm transition-colors",
                autoRefresh
                  ? "bg-primary/15 text-primary hover:bg-primary/25"
                  : "text-muted-foreground hover:text-primary",
              )}
            >
              <RefreshCw className={cn("h-3.5 w-3.5", autoRefresh && liveNow && "animate-spin")} />
              {autoRefresh ? (liveNow ? `每 ${LIVE_MS / 1000} 秒` : "自动刷新(暂停)") : "自动刷新"}
            </button>
            <AskAiButton
              context={`今日大盘数据：${dataSummary}`}
              label="问 AI"
              suggestions={["今天大盘怎么走", "哪些指数领涨领跌", "盘面有什么值得注意"]}
            />
          </div>
        }
      />

      {/* 历史存档模式提示条 */}
      {isHistory && (
        <div className="mb-4 rounded-lg border border-warning/30 bg-warning/5 px-4 py-2.5">
          <p className="text-xs text-warning">
            正在查看 <span className="font-bold">{reviewDate}</span> 的历史复盘存档。大盘指数/成交额榜等实时行情不显示，核心标的/复盘计划/AI研判/市场情绪均回到当天。
            {!reviewData?.available && <span className="ml-1 text-muted-foreground">（该日期暂无复盘存档，可补充核心标的和复盘计划）</span>}
          </p>
        </div>
      )}

      {/* 1. 大盘指数（实时 / 历史模式隐藏） */}
      {!isHistory && (
        <>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-muted-foreground">大盘指数</h3>
          <Caliber text={"涨跌幅对比前一交易日收盘。\n「实时」是延时行情，页面上没标截至几点。"} />
          <button onClick={loadIndices} className="text-muted-foreground hover:text-primary" title="刷新"><RefreshCw className="h-3.5 w-3.5" /></button>
        </div>
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {indices.length === 0
            ? [1, 2, 3, 4].map((i) => (
              <GlassCard key={i} className="p-3">
                <p className="text-xs text-muted-foreground">{idxErr ? "行情未接通" : "加载中…"}</p>
                <p className="mt-1 font-mono text-lg font-bold text-muted-foreground/40">—</p>
              </GlassCard>
            ))
          : indices.map((i) => (
              <GlassCard key={i.name} className="p-3">
                <p className="truncate text-xs text-muted-foreground">{i.name}</p>
                <p className={cn("mt-1 font-mono text-lg font-bold", pctColor(i.change_pct))}>{i.price}</p>
                <p className={cn("text-xs", pctColor(i.change_pct))}>{i.change_pct > 0 ? "+" : ""}{i.change_pct}%</p>
              </GlassCard>
            ))}
        </div>

        {/* 1b. 全球市场（隔夜外围脸色：A 股常看美股 / 港股） */}
        {globalIdx.length > 0 && (
          <>
            <div className="mb-3 flex items-center gap-2">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground"><Globe className="h-4 w-4" /> 全球市场</h3>
              <Caliber text={"美股港股的涨跌幅都是对比它们各自的前一交易日收盘。\n港股在北京时间白天可能正在交易，所以会标「盘中」——那是抓取那一刻的延时行情，没标具体几点。"} />
              <span className="text-[11px] text-muted-foreground/50">隔夜外围 · A 股常看美股 / 港股脸色</span>
            </div>
            <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
              {globalIdx.map((g) => (
                <GlassCard key={g.key} className="p-3">
                  <p className="truncate text-xs text-muted-foreground">{g.name} <span className="text-muted-foreground/40">{g.region}</span></p>
                  <p className={cn("mt-1 font-mono text-lg font-bold", g.change_pct == null ? "text-foreground" : pctColor(g.change_pct))}>{g.price ?? "—"}</p>
                  <p className={cn("text-xs", g.change_pct == null ? "text-muted-foreground" : pctColor(g.change_pct))}>
                    {g.change_pct == null ? "—" : `${g.change_pct > 0 ? "+" : ""}${g.change_pct}%`}
                  </p>
                </GlassCard>
              ))}
            </div>
          </>
        )}
        </>
      )}

      {/* 2. 关注股票（自选） */}
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-muted-foreground">关注股票</h3>
        {watchCodes.length > 0 && (
          <button onClick={() => refreshWatch(watchCodes)} className="text-muted-foreground hover:text-primary" title="刷新价格">
            {watchLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>
      <GlassCard className="mb-6">
        <div className="mb-3 flex gap-2">
          <input
            value={watchInput}
            onChange={(e) => setWatchInput(e.target.value.replace(/[^\d,\s]/g, "").slice(0, 80))}
            onKeyDown={(e) => e.key === "Enter" && addWatch()}
            placeholder="加自选：可批量，如 600519 000858"
            className="w-60 rounded-lg border border-border bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary/50"
          />
          <button onClick={addWatch}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-4 py-2 text-sm font-medium text-primary shadow-glow hover:bg-primary/25">
            <Plus className="h-4 w-4" /> 增加
          </button>
        </div>
        {watchCodes.length === 0 ? (
          <p className="text-sm text-muted-foreground/60">加上你关注的股票，随时看它们的实时价格与涨跌。数据存本地，不上传。</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {watchCodes.map((c) => {
              const q = watchQuotes[c];
              return (
                <div key={c} className="group relative rounded-lg bg-muted/25 p-3">
                  <button onClick={() => removeWatch(c)} title="移除"
                    className="absolute right-1.5 top-1.5 text-muted-foreground/40 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100">
                    <X className="h-3.5 w-3.5" />
                  </button>
                  <p className="truncate text-xs text-muted-foreground">{q?.name || c}</p>
                  <p className={cn("mt-1 font-mono text-lg font-bold", q ? pctColor(q.change_pct) : "text-muted-foreground/40")}>{q ? q.price : "—"}</p>
                  <p className={cn("text-xs", q ? pctColor(q.change_pct) : "text-muted-foreground/40")}>
                    {q ? `${q.change_pct > 0 ? "+" : ""}${q.change_pct}%` : c}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </GlassCard>

      {/* 3. AI 盘面研判（结构化卡片，按短线看板风格输出） */}
      <GlassCard glow className="mb-6">
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 font-semibold"><Sparkles className="h-4 w-4 text-primary" /> AI 盘面研判</h3>
          <div className="flex items-center gap-2">
            {reviewData?.generated_at && (
              <span className="text-[11px] text-muted-foreground/50">存档于 {reviewData.generated_at.slice(0, 16)}</span>
            )}
            <button onClick={runReview} disabled={reviewLoading}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-4 py-2 text-sm font-medium text-primary shadow-glow hover:bg-primary/25 disabled:opacity-50">
              {reviewLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {reviewLoading ? "复盘中…" : reviewFocus ? "重新研判" : "生成研判"}
            </button>
          </div>
        </div>
        {needConfig && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm text-muted-foreground">
            <AlertCircle className="h-4 w-4 shrink-0 text-warning" />
            还没接入 AI。<Link to="/settings" className="text-primary">先去接入你的 AI</Link>，之后一键出研判。
          </div>
        )}
        {reviewErr && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" /> {reviewErr}
          </div>
        )}
        {/* 结构化卡片输出（有 focus 时） */}
        {reviewFocus ? (
          <div className="mt-4">
            {/* 情绪档位 + 一句话 */}
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <span className={cn("rounded-full px-4 py-1.5 text-sm font-bold tracking-wider", phaseTone(reviewFocus.emotion_phase))}>
                {reviewFocus.emotion_phase}
              </span>
              <span className="flex-1 text-base font-semibold">{reviewFocus.market_oneliner}</span>
            </div>
            {/* 活跃方向 */}
            <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.2em] text-primary">活跃方向</div>
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {reviewFocus.focus_directions.map((d, i) => (
                <div key={i} className="rounded-xl border border-border border-l-4 border-l-primary bg-card/50 p-4">
                  <h4 className="mb-1.5 text-base font-bold">{d.direction}</h4>
                  <p className="mb-2.5 text-sm text-muted-foreground">{d.logic}</p>
                  <div className="border-t border-dashed border-border pt-2 text-xs text-muted-foreground">
                    <span className="font-semibold text-danger">风险</span> {d.risk}
                  </div>
                </div>
              ))}
            </div>
            {/* 风险提示 */}
            {reviewFocus.risk_alerts?.length > 0 && (
              <div className="mt-4 border-t-2 border-foreground pt-2.5">
                <h4 className="mb-1.5 flex items-center gap-1.5 text-sm font-bold"><AlertTriangle className="h-4 w-4 text-warning" /> 风险提示</h4>
                <ul className="ml-4 list-disc space-y-1 text-[13px] text-muted-foreground">
                  {reviewFocus.risk_alerts.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              </div>
            )}
            {/* 明日验证条件（来自结构化 focus） */}
            {reviewFocus.verification_items && reviewFocus.verification_items.length > 0 && (
              <div className="mt-4 border-t-2 border-foreground pt-2.5">
                <h4 className="mb-2 flex items-center gap-1.5 text-sm font-bold">
                  <CheckCircle className="h-4 w-4 text-info" /> 明日验证条件
                  <span className="text-[11px] font-normal text-muted-foreground">明天用这几个读数检验今晚的判断</span>
                </h4>
                <div className="flex flex-wrap gap-2">
                  {reviewFocus.verification_items.map((v, i) => (
                    <div key={i} className="flex-1 basis-[240px] rounded-lg border border-border bg-muted/20 px-3 py-2">
                      <div className="text-[13px] font-semibold">
                        {v.label || v.metric}
                        <span className={cn("ml-1.5 rounded px-1.5 py-0.5 text-[11px] font-bold",
                          v.direction === "上升" ? "bg-danger/15 text-danger"
                            : v.direction === "下降" ? "bg-success/15 text-success"
                            : "bg-muted text-muted-foreground")}>预期{v.direction}</span>
                      </div>
                      {v.base_value != null && (
                        <div className="mt-1 text-[11px] tabular-nums text-foreground/70">
                          今日 <b className="text-foreground">{v.base_value}{v.unit || ""}</b>
                          {v.eps != null && <> · 变动超过 {v.eps}{v.unit || ""} 才算数</>}
                        </div>
                      )}
                      {v.reason && <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{v.reason}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {!reviewLoading && (
              <div className="mt-3">
                <SaveNoteButton kind="研判" title={`AI盘面研判 ${reviewDate || today}`} content={reviewText || JSON.stringify(reviewFocus, null, 2)} />
              </div>
            )}
            {/* 编辑研判 + 对话调教区域 */}
            {reviewFocus && !reviewLoading && (
              <div className="mt-4 border-t-2 border-foreground pt-3">
                {/* 编辑研判 */}
                <div className="mb-3">
                  <div className="flex items-center justify-between">
                    <h4 className="flex items-center gap-1.5 text-sm font-bold"><Edit3 className="h-4 w-4 text-primary" /> 编辑研判</h4>
                    {!editingReview ? (
                      <button onClick={() => { setEditingReview(true); setEditText(aiReview?.edited_text || reviewText || JSON.stringify(reviewFocus, null, 2)); }}
                        className="inline-flex items-center gap-1 rounded-lg bg-muted/40 px-3 py-1.5 text-xs font-medium hover:bg-muted/60">
                        <Edit3 className="h-3.5 w-3.5" /> {aiReview?.edited_text ? "继续编辑" : "编辑修改"}
                      </button>
                    ) : (
                      <div className="flex items-center gap-2">
                        <button onClick={() => { setEditingReview(false); }}
                          className="rounded-lg bg-muted/40 px-3 py-1.5 text-xs hover:bg-muted/60">取消</button>
                        <button onClick={async () => {
                          setEditSaving(true);
                          try {
                            await api.editAiReview(reviewDate || _todayStr, editText);
                            setEditingReview(false);
                            // 刷新状态
                            api.aiReviewLatest(reviewDate || _todayStr).then(setAiReview).catch(() => {});
                          } catch { /* ignore */ } finally { setEditSaving(false); }
                        }} disabled={editSaving}
                          className="inline-flex items-center gap-1 rounded-lg bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/25 disabled:opacity-50">
                          {editSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} 保存
                        </button>
                      </div>
                    )}
                  </div>
                  {editingReview ? (
                    <textarea value={editText} onChange={(e) => setEditText(e.target.value)}
                      className="mt-2 h-48 w-full resize-y rounded-lg border border-border bg-card/50 p-3 text-sm leading-relaxed" />
                  ) : aiReview?.edited_text ? (
                    <pre className="mt-2 max-h-60 overflow-auto rounded-lg bg-muted/20 p-3 text-[13px] leading-relaxed whitespace-pre-wrap">{aiReview.edited_text}</pre>
                  ) : null}
                </div>

                {/* 对话调教 */}
                <div>
                  <h4 className="mb-2 flex items-center gap-1.5 text-sm font-bold"><MessageSquare className="h-4 w-4 text-info" /> 对话调教</h4>
                  <span className="mb-2 block text-[11px] text-muted-foreground">与AI对话修正研判方向，AI会指出你的不足，研判往你的复盘计划靠拢</span>
                  {/* 对话历史 */}
                  {chatMessages.length > 0 && (
                    <div className="mb-3 max-h-64 space-y-2 overflow-y-auto rounded-lg border border-border/50 bg-muted/10 p-3">
                      {chatMessages.map((m, i) => (
                        <div key={i} className={m.role === "user" ? "text-right" : ""}>
                          <span className={m.role === "user"
                            ? "inline-block max-w-[85%] rounded-lg bg-primary/15 px-3 py-1.5 text-[13px]"
                            : "inline-block max-w-[85%] rounded-lg bg-muted/40 px-3 py-1.5 text-[13px] leading-relaxed whitespace-pre-wrap"}>
                            {m.content}
                          </span>
                          {m.ts && <span className="mt-0.5 block text-[10px] text-muted-foreground/40">{m.ts}</span>}
                        </div>
                      ))}
                      <div ref={chatEndRef} />
                    </div>
                  )}
                  {/* 输入框 */}
                  <div className="flex items-end gap-2">
                    <textarea value={chatInput} onChange={(e) => setChatInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } }}
                      placeholder="对AI说点什么…（Enter发送，Shift+Enter换行）"
                      className="flex-1 resize-none rounded-lg border border-border bg-card/50 p-2.5 text-sm" rows={2} />
                    <button onClick={sendChat} disabled={chatLoading || !chatInput.trim()}
                      className="inline-flex items-center gap-1 rounded-lg bg-info/15 px-4 py-2.5 text-sm font-medium text-info hover:bg-info/25 disabled:opacity-50">
                      {chatLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} 发送
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : reviewLoading && reviewText ? (
          /* 生成中：展示原始流式文本（等待 JSON 解析） */
          <div className="mt-4">
            <p className="mb-2 text-[11px] text-muted-foreground/50">AI 正在生成结构化研判…</p>
            <pre className="max-h-60 overflow-auto rounded-lg bg-muted/20 p-3 text-[11px] text-muted-foreground">{reviewText}</pre>
          </div>
        ) : !needConfig && !reviewErr && !reviewLoading ? (
          <p className="mt-3 text-sm text-muted-foreground">
            点上方按钮，系统把当天客观数据打包给你的 AI，生成结构化盘面研判：
            <b className="text-foreground">情绪档位 · 活跃方向 · 风险提示 · 明日验证条件</b>。
            {reviewData && !reviewData.available && <span className="ml-1 text-muted-foreground/50">（该日期暂无存档，可点「生成研判」新建）</span>}
          </p>
        ) : null}
      </GlassCard>

      {/* 4. 市场情绪 */}
      <div className="mb-3 flex items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground"><Gauge className="h-4 w-4" /> 市场情绪</h3>
        <Caliber text={
          "涨停 / 真实涨停 / 跌停 / 真实跌停 / 活跃度这几个数取自乐咕乐股，不是我们算的。\n" +
          "「真实」与普通涨跌停的差额由它自己的口径决定，具体算法未公开。\n" +
          "活跃度同样是它的算法，**不能按上涨家数占比来理解**。\n" +
          "大盘宽度按涨跌家数机械分档：上涨不足 600 家为冰点，其余看 上涨÷下跌 的比值\n" +
          "（<0.7 偏弱 / 0.7-1.2 中性 / 1.2-2.5 偏强 / ≥2.5 普涨）。\n" +
          "题材投机只按真实涨停家数分档：<30 冰点 / 30-59 普通 / 60-99 活跃 / ≥100 亢奋。"
        } />
        {sentiment?.date && <span className="text-[11px] text-muted-foreground/50">{sentiment.date}</span>}
      </div>
      <GlassCard className="mb-6">
        {!sentiment?.breadth ? (
          pending(ovDone)
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                { k: "大盘宽度", v: sentiment.breadth, hint: "冰点 / 偏弱 / 中性 / 偏强 / 普涨" },
                { k: "题材投机", v: sentiment.speculation, hint: "冰点 / 普通 / 活跃 / 亢奋" },
              ].map((m) => (
                <div key={m.k} className="rounded-lg bg-muted/25 p-4">
                  <p className="text-xs text-muted-foreground">{m.k}</p>
                  <p className="mt-1 text-2xl font-bold text-primary">{m.v}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground/60">{m.hint}</p>
                </div>
              ))}
            </div>
            <div className="mt-3 grid grid-cols-4 gap-2">
              {sentCells.map((c) => (
                <div key={c.k} className="rounded-lg bg-muted/20 p-2 text-center">
                  <p className="truncate text-[11px] text-muted-foreground">{c.k}</p>
                  <p className={cn("mt-0.5 font-mono text-sm font-bold", c.up === null ? "text-foreground" : c.up ? "text-danger" : "text-success")}>{c.v}</p>
                </div>
              ))}
            </div>
          </>
        )}
      </GlassCard>

      {/* 4a0. 今日实时打板情绪（盘中随盘变化） */}
      {liveEmo && (
        <>
          <div className="mb-3 flex flex-wrap items-baseline gap-2">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
              <Flame className="h-4 w-4" /> 今日实时打板情绪
              <Caliber text={
                "封板率 = 最终封住家数 ÷ 摸板家数；炸板率 = 炸板未回封家数 ÷ 摸板家数。\n" +
                "摸板家数 = 涨停 + 炸板，**按家数算，不按炸板次数算**。\n" +
                "最高连板只给板数，具体是哪只票看下面那张连板股表。"
              } />
            </h3>
            {liveEmo.available ? (
              <span className="text-[11px] text-warning">
                {liveEmo.date} {liveEmo.as_of} · {liveEmo.phase}（随盘变化）
              </span>
            ) : (
              <span className="text-[11px] text-muted-foreground/50">{liveEmo.reason}</span>
            )}
          </div>
          <GlassCard className="mb-6">
            {!liveEmo.available ? (
              <p className="py-4 text-center text-sm text-muted-foreground/60">
                {liveEmo.reason || "今日暂无数据"}
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  { k: "涨停", v: liveEmo.zt_count, unit: "", up: true },
                  { k: "跌停", v: liveEmo.dt_count, unit: "", up: false },
                  { k: "最高连板", v: liveEmo.max_boards, unit: " 板", up: true },
                  { k: "连板（2板+）", v: liveEmo.lianban_count, unit: " 家", up: true },
                ].map((c) => (
                  <div key={c.k} className="rounded-lg bg-muted/30 p-3 text-center">
                    <p className="text-xs text-muted-foreground">{c.k}</p>
                    <p className={cn("mt-1 font-mono text-xl font-bold",
                                     c.v == null ? "text-muted-foreground/40"
                                                 : c.up ? "text-danger" : "text-success")}>
                      {c.v ?? "—"}{c.v != null && c.unit}
                    </p>
                  </div>
                ))}
                {[
                  { k: "封板率", v: liveEmo.seal_rate, sub: "封住 / 尝试涨停", up: true },
                  { k: "炸板率", v: liveEmo.break_rate, sub: "炸板 / 尝试涨停", up: false },
                  {
                    k: "晋级率", v: liveEmo.promotion_rate, up: true,
                    sub: liveEmo.promotion_base != null
                      ? `${liveEmo.promotion_base_date || "上一场"} 涨停 ${liveEmo.promotion_base} 家，今天又封住`
                      : "上一场涨停的票，今天又封住",
                  },
                  { k: "炸板家数", v: null as number | null, raw: liveEmo.zb_count, sub: "炸板未回封", up: false },
                ].map((c) => (
                  <div key={c.k} className="rounded-lg bg-muted/30 p-3 text-center">
                    <p className="text-xs text-muted-foreground">{c.k}</p>
                    <p className={cn("mt-1 font-mono text-xl font-bold",
                                     (c.raw ?? c.v) == null ? "text-muted-foreground/40"
                                                            : c.up ? "text-danger" : "text-success")}>
                      {c.raw != null ? c.raw
                        : c.v != null ? `${(c.v * 100).toFixed(1)}%` : "—"}
                    </p>
                    <p className="mt-0.5 text-[10px] text-muted-foreground/50">{c.sub}</p>
                  </div>
                ))}
              </div>
            )}
          </GlassCard>
        </>
      )}

      {/* 4a0. 市场情绪温度（今日 + 昨日对比 + 用户校准 + 权重体系） */}
      <div className="mb-3 flex items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground"><Gauge className="h-4 w-4" /> 市场情绪温度</h3>
        <Caliber text={
          "5 维加权打分 0-100°：涨跌停拔河（昨日极端股今日转变 + 涨跌停家数比 + 封板率）50% + 赚钱效应 25% + 连板情绪 15% + 极端股信号 10%。\n" +
          "你可以在下方输入当天你认可的温度（0-100），系统会对比与自算值的偏差，逐日学习并自动微调各维度权重，让体系越来越贴合你的判断。\n" +
          "校正 ≥3 天开始生效，样本越多收敛越快。"
        } />
        <span className="text-[11px] text-muted-foreground/50">0-100° · 系统自算 + 你的校正双向对齐</span>
        {tempView?.date && <span className="ml-auto text-[11px] text-muted-foreground/50">{tempView.date}</span>}
      </div>
      <GlassCard className="mb-6">
        {!tempView ? (
          pending(tempDone)
        ) : (
          <div className="space-y-4">
            {/* 今日 vs 昨日温度 */}
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg bg-muted/25 p-4">
                <p className="text-xs text-muted-foreground">今日温度（系统）</p>
                <p className="mt-1 flex items-baseline gap-2">
                  <span className={cn("font-mono text-3xl font-bold", tempView.system.temperature == null ? "text-muted-foreground" : tempView.system.temperature >= 75 ? "text-danger" : tempView.system.temperature >= 55 ? "text-orange-500" : tempView.system.temperature >= 35 ? "text-foreground" : tempView.system.temperature >= 15 ? "text-sky-600" : "text-success")}>
                    {tempView.system.temperature == null ? "—" : `${tempView.system.temperature}°`}
                  </span>
                  {tempView.system.state && <span className="text-xs text-muted-foreground">{tempView.system.state}</span>}
                </p>
                {tempView.prev?.diff != null && (
                  <p className={cn("mt-1 text-[11px]", tempView.prev.diff > 0 ? "text-danger" : tempView.prev.diff < 0 ? "text-success" : "text-muted-foreground")}>
                    较昨 {tempView.prev.diff > 0 ? "+" : ""}{tempView.prev.diff}°
                  </p>
                )}
              </div>
              <div className="rounded-lg bg-muted/25 p-4">
                <p className="text-xs text-muted-foreground">昨日温度</p>
                <p className="mt-1 flex items-baseline gap-2">
                  <span className="font-mono text-3xl font-bold text-muted-foreground">{tempView.prev?.temperature == null ? "—" : `${tempView.prev.temperature}°`}</span>
                  {tempView.prev?.state && <span className="text-xs text-muted-foreground">{tempView.prev.state}</span>}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground/60">{tempView.prev?.date ? `${tempView.prev.date} 存档` : "无历史记录"}</p>
              </div>
              <div className="rounded-lg bg-muted/25 p-4">
                <p className="text-xs text-muted-foreground">你的校正</p>
                <p className="mt-1 flex items-baseline gap-2">
                  <span className={cn("font-mono text-3xl font-bold", tempView.user?.temperature == null ? "text-muted-foreground/40" : "text-primary")}>
                    {tempView.user?.temperature == null ? "未校正" : `${tempView.user.temperature}°`}
                  </span>
                  {tempView.user?.diff != null && (
                    <span className={cn("text-xs", tempView.user.diff > 0 ? "text-danger" : tempView.user.diff < 0 ? "text-success" : "text-muted-foreground")}>
                      较系统 {tempView.user.diff > 0 ? "+" : ""}{tempView.user.diff}°
                    </span>
                  )}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground/60">
                  {tempView.user?.notes || (tempView.user?.temperature != null ? "已校准" : "输入你的温度，系统会学习")}
                </p>
              </div>
            </div>

            {/* 用户校准输入 */}
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border p-3">
              <span className="text-xs text-muted-foreground">我的温度（0-100）：</span>
              <input
                type="number" min={0} max={100}
                value={tempInput}
                onChange={(e) => setTempInput(e.target.value)}
                placeholder={tempView.system.temperature != null ? `系统 ${tempView.system.temperature}` : "0-100"}
                className="w-24 rounded-md border border-border bg-background px-2 py-1 text-sm"
              />
              <button
                onClick={saveTemperature}
                disabled={tempSaving || !tempInput.trim()}
                className="flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {tempSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                校准并学习
              </button>
              <span className="text-[11px] text-muted-foreground/60">
                已校正 {tempView.learning.record_count} 天 · {tempView.learning.trend}
              </span>
            </div>

            {/* 权重体系（当前学习到的） */}
            <div>
              <p className="mb-2 text-xs text-muted-foreground">当前权重体系（系统按你的校正自动学习调整）</p>
              <div className="flex flex-wrap gap-2">
                {[
                  { k: "tug_of_war", label: "涨跌停拔河" },
                  { k: "real_profit", label: "赚钱效应" },
                  { k: "lianban", label: "连板情绪" },
                  { k: "extreme", label: "极端股信号" },
                ].map(({ k, label }) => {
                  const wt = tempView.weights?.[k];
                  const isDefault = Math.abs((wt ?? 0) - ({ tug_of_war: 0.5, real_profit: 0.25, lianban: 0.15, extreme: 0.1 } as Record<string, number>)[k]) < 0.005;
                  return (
                    <span key={k} className={cn("rounded-full px-2.5 py-1 text-[11px]", isDefault ? "bg-muted/30 text-muted-foreground" : "bg-primary/10 text-primary")}>
                      {label} {wt != null ? `${(wt * 100).toFixed(0)}%` : "—"}
                    </span>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </GlassCard>

      {/* 4a. 派生情绪指标（赚钱效应 / 晋级率 / 连板溢价 / 梯队断层） */}
      <div className="mb-3 flex items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground"><BarChart3 className="h-4 w-4" /> 派生情绪指标</h3>
        <Caliber text={
          "赚钱效应 = 当日所有涨停股次日涨跌幅的统计（均值 / 中位数 / 红盘率 / 昨涨停今又停率）。\n" +
          "晋级率 = 上一交易日涨停的票在今天又封板的比例，按板位拆分。\n" +
          "连板溢价 = 连板股（2 板+）次日的涨跌幅统计。\n" +
          "梯队结构 = 全市场板位是否连续（跨题材），缺档表示某板位无个股承接。\n" +
          "以上均基于公开榜单数据计算，非预测、非推荐。"
        } />
        <span className="text-[11px] text-muted-foreground/50">赚钱效应 · 晋级率 · 连板溢价 · 梯队结构</span>
        {derived?.date && <span className="ml-auto text-[11px] text-muted-foreground/50">{derived.date}</span>}
      </div>
      <GlassCard className="mb-6">
        {!derived ? (
          pending(derivedDone)
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {/* 赚钱效应 */}
            <div className="rounded-lg bg-muted/25 p-4">
              <p className="text-xs text-muted-foreground">赚钱效应</p>
              {!derived.money_effect?.available ? (
                <p className="mt-2 text-sm text-muted-foreground/60">暂不可用</p>
              ) : (
                <div className="mt-2 space-y-1 text-sm">
                  <div className="flex justify-between"><span className="text-muted-foreground/60">中位数</span><span className={cn("font-mono", derived.money_effect.median != null ? pctColor(derived.money_effect.median) : "text-muted-foreground")}>{derived.money_effect.median == null ? "—" : `${derived.money_effect.median > 0 ? "+" : ""}${derived.money_effect.median.toFixed(2)}%`}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground/60">均值</span><span className={cn("font-mono", derived.money_effect.avg != null ? pctColor(derived.money_effect.avg) : "text-muted-foreground")}>{derived.money_effect.avg == null ? "—" : `${derived.money_effect.avg > 0 ? "+" : ""}${derived.money_effect.avg.toFixed(2)}%`}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground/60">红盘率</span><span className="font-mono">{pct(derived.money_effect.positive_rate)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground/60">昨涨停今又停</span><span className="font-mono">{pct(derived.money_effect.limit_up_again_rate)}</span></div>
                </div>
              )}
            </div>
            {/* 晋级率 */}
            <div className="rounded-lg bg-muted/25 p-4">
              <p className="text-xs text-muted-foreground">晋级率</p>
              {!derived.promotion?.available ? (
                <p className="mt-2 text-sm text-muted-foreground/60">暂不可用</p>
              ) : (
                <div className="mt-2 space-y-1 text-sm">
                  <div className="flex justify-between"><span className="text-muted-foreground/60">整体</span><span className="font-mono text-primary">{pct(derived.promotion.overall?.rate)}</span></div>
                  {derived.promotion.tiers && Object.entries(derived.promotion.tiers).map(([k, t]) => (
                    <div key={k} className="flex justify-between"><span className="text-muted-foreground/60">{k}</span><span className="font-mono">{t.base ? `${t.promoted}/${t.base}（${pct(t.rate)}）` : "—"}</span></div>
                  ))}
                </div>
              )}
            </div>
            {/* 连板溢价 */}
            <div className="rounded-lg bg-muted/25 p-4">
              <p className="text-xs text-muted-foreground">连板溢价</p>
              {!derived.consec_premium?.available ? (
                <p className="mt-2 text-sm text-muted-foreground/60">暂不可用</p>
              ) : (
                <div className="mt-2 space-y-1 text-sm">
                  <div className="flex justify-between"><span className="text-muted-foreground/60">均值</span><span className={cn("font-mono", derived.consec_premium.avg != null ? pctColor(derived.consec_premium.avg) : "text-muted-foreground")}>{derived.consec_premium.avg == null ? "—" : `${derived.consec_premium.avg > 0 ? "+" : ""}${derived.consec_premium.avg.toFixed(2)}%`}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground/60">中位数</span><span className={cn("font-mono", derived.consec_premium.median != null ? pctColor(derived.consec_premium.median) : "text-muted-foreground")}>{derived.consec_premium.median == null ? "—" : `${derived.consec_premium.median > 0 ? "+" : ""}${derived.consec_premium.median.toFixed(2)}%`}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground/60">红盘率</span><span className="font-mono">{pct(derived.consec_premium.positive_rate)}</span></div>
                </div>
              )}
            </div>
            {/* 梯队结构 */}
            <div className="rounded-lg bg-muted/25 p-4">
              <p className="text-xs text-muted-foreground">梯队结构</p>
              {!derived.ladder_gap?.available ? (
                <p className="mt-2 text-sm text-muted-foreground/60">暂不可用</p>
              ) : (
                <>
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    {derived.ladder_gap.tiers && Object.entries(derived.ladder_gap.tiers).map(([b, c]) => (
                      <span key={b} className="rounded-lg bg-primary/10 px-2.5 py-1 text-[13px] font-semibold text-primary tabular-nums">{b}板 × {c}</span>
                    ))}
                    {derived.ladder_gap.gaps?.map((g) => (
                      <span key={`gap${g}`} className="rounded-lg border border-dashed border-danger/50 px-2.5 py-1 text-[13px] font-semibold text-danger tabular-nums">{g}板 缺</span>
                    ))}
                    {(!derived.ladder_gap.tiers || Object.keys(derived.ladder_gap.tiers).length === 0) && (
                      <span className="text-[13px] text-muted-foreground">无 2 板以上</span>
                    )}
                  </div>
                  <p className={cn("mt-3 border-t border-dashed border-border pt-2 text-[12px]", derived.ladder_gap.continuous === false ? "text-danger" : "text-muted-foreground")}>
                    {derived.ladder_gap.gaps && derived.ladder_gap.gaps.length > 0
                      ? `板位缺档 ${derived.ladder_gap.gaps.map((g) => `${g}板`).join("、")} → 最高标${derived.ladder_gap.highest ? `（${derived.ladder_gap.highest}板）` : ""}下方断层，断板后没有下一梯队承接`
                      : "全市场板位结构连续（注：跨题材，不代表同一题材内部有梯队）"}
                  </p>
                </>
              )}
            </div>
          </div>
        )}
      </GlassCard>

      {/* 4a2. 情绪周期 */}
      <div className="mb-3 flex items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground"><CalendarClock className="h-4 w-4" /> 情绪周期</h3>
        <Caliber text={
          "取最近 20 个交易日的情绪分，窗口内最低分日视为本轮周期起点。\n" +
          "day_n = 距低点天数；百分位 = 当前情绪分在历史窗口中的位置。\n" +
          "启发式参考，不构成择时依据。"
        } />
        <span className="text-[11px] text-muted-foreground/50">窗口内情绪分最低日视为本轮起点 · 启发式参考</span>
        {derived?.date && <span className="ml-auto text-[11px] text-muted-foreground/50">{derived.date}</span>}
      </div>
      <GlassCard className="mb-6">
        {!derived ? (
          pending(derivedDone)
        ) : !derived.cycle?.available ? (
          <p className="py-4 text-center text-sm text-muted-foreground/60">暂不可用</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-lg bg-muted/25 p-4">
              <p className="text-xs text-muted-foreground">距低点</p>
              <p className="mt-1 font-mono text-2xl font-bold text-primary">第 {derived.cycle.day_n ?? "—"} 天</p>
              <p className="mt-1 text-[11px] text-muted-foreground/60">起点 {derived.cycle.trough_date ?? "—"}</p>
            </div>
            <div className="rounded-lg bg-muted/25 p-4">
              <p className="text-xs text-muted-foreground">走向</p>
              <p className={cn("mt-1 font-mono text-2xl font-bold", derived.cycle.rising ? "text-danger" : "text-success")}>{derived.cycle.trend ?? "—"}</p>
              <p className="mt-1 text-[11px] text-muted-foreground/60">{derived.cycle.rising ? "情绪走强" : "情绪转弱"}</p>
            </div>
            <div className="rounded-lg bg-muted/25 p-4">
              <p className="text-xs text-muted-foreground">分位</p>
              <p className="mt-1 font-mono text-2xl font-bold text-primary">{pct(derived.cycle.pctile)}</p>
              <p className="mt-1 text-[11px] text-muted-foreground/60">十日区间分位</p>
            </div>
          </div>
        )}
      </GlassCard>

      {/* 4b. 短线情绪（连板梯队 / 打板情绪，聚合口径零个股名） */}
      <div className="mb-3 flex items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground"><Flame className="h-4 w-4" /> 短线情绪</h3>
        <Caliber text={
          "封板率 / 炸板率与上面那张实时卡同一个算法：分母是摸板家数（涨停 + 炸板），按家数不按次数。\n" +
          "表里的「行业 / 概念」经常只有四个字（像「互联网电」「汽车零部」）——是上游把名字截到四字，\n" +
          "不是这里显示不全；怕猜错所以不替它补全称。"
        } />
        <span className="text-[11px] text-muted-foreground/50">连板股 · 打板情绪 · 客观公开榜单</span>
        {emotion?.date && <span className="ml-auto text-[11px] text-muted-foreground/50">{emotion.date}</span>}
      </div>
      <GlassCard className="mb-6">
        {!emotion || emotion.zt_count === undefined ? (
          pending(emoDone)
        ) : (
          <>
            {/* 关键计数 */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                { k: "涨停", v: `${emotion.zt_count}`, cls: "text-danger" },
                { k: "跌停", v: `${emotion.dt_count}`, cls: "text-success" },
                { k: "最高连板", v: `${emotion.max_boards} 板`, cls: "text-primary" },
                { k: "连板（2板+）", v: `${emotion.lianban_count} 家`, cls: "text-primary" },
              ].map((c) => (
                <div key={c.k} className="rounded-lg bg-muted/25 p-3 text-center">
                  <p className="text-[11px] text-muted-foreground">{c.k}</p>
                  <p className={cn("mt-0.5 font-mono text-xl font-bold", c.cls)}>{c.v}</p>
                </div>
              ))}
            </div>
            {/* 打板情绪比率 */}
            <div className="mt-2 grid grid-cols-3 gap-2">
              {[
                { k: "封板率", v: emotion.seal_rate, hint: "封住 / 尝试涨停", strong: true },
                { k: "炸板率", v: emotion.break_rate, hint: "炸板 / 尝试涨停", strong: false },
                { k: "晋级率", v: emotion.promotion_rate, hint: "昨涨停今又停", strong: true },
              ].map((c) => (
                <div key={c.k} className="rounded-lg bg-muted/20 p-2.5 text-center">
                  <p className="text-[11px] text-muted-foreground">{c.k}</p>
                  <p className={cn("mt-0.5 font-mono text-sm font-bold", c.strong ? "text-danger" : "text-success")}>
                    {c.v == null ? "—" : `${(c.v * 100).toFixed(1)}%`}
                  </p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground/50">{c.hint}</p>
                </div>
              ))}
            </div>
            {/* 涨停板清单（连板 / 首板切换，按概念分组，客观公开榜单） */}
            <div className="mt-3">
              {/* 横栏切换按钮 */}
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <div className="inline-flex rounded-lg border border-border bg-muted/30 p-0.5">
                  <button
                    onClick={() => setZtTab("lianban")}
                    className={cn("px-3 py-1 text-xs font-medium rounded-md transition-colors", ztTab === "lianban" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
                  >
                    连板（{emotion.lianban_count} 家）
                  </button>
                  <button
                    onClick={() => setZtTab("shouban")}
                    className={cn("px-3 py-1 text-xs font-medium rounded-md transition-colors", ztTab === "shouban" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
                  >
                    首板（{emotion.shouban_count ?? 0} 家）
                  </button>
                </div>
                <span className="text-[11px] text-muted-foreground/50">按概念分类 · 涨停原因 · 最后封板时间 · 客观公开榜单，非推荐 / 非预测</span>
                <span className="ml-auto">
                  <RunAllButton
                    dd={dd}
                    items={(ztTab === "lianban" ? emotion.lianban_stocks : (emotion.shouban_stocks ?? [])).map(ztItem)}
                    nameOf={(k) => [...(emotion.lianban_stocks ?? []), ...(emotion.shouban_stocks ?? [])].find((s) => s.code === k)?.name || k}
                  />
                </span>
              </div>
              {(() => {
                const stocks = ztTab === "lianban" ? emotion.lianban_stocks : (emotion.shouban_stocks ?? []);
                if (stocks.length === 0) {
                  return <p className="text-xs text-muted-foreground/50">{ztTab === "lianban" ? "今日无 2 板以上个股" : "今日无首板个股"}</p>;
                }
                // 按大板块分组（科技含AI应用/电子/半导体等，消费含零售/食品等…）
                const groups: Record<string, typeof stocks> = {};
                for (const s of stocks) {
                  const k = mapToSector(s.industry);
                  (groups[k] ??= []).push(s);
                }
                const sortedGroups = Object.entries(groups).sort((a, b) => {
                  const d = b[1].length - a[1].length;
                  return d !== 0 ? d : sectorSortIdx(a[0]) - sectorSortIdx(b[0]);
                });
                return (
                  <div className="space-y-4">
                    {sortedGroups.map(([sector, items]) => {
                      const subIndustries = Array.from(
                        items.reduce<Map<string, number>>((m, s) => {
                          const k = s.industry || "其他";
                          m.set(k, (m.get(k) ?? 0) + 1);
                          return m;
                        }, new Map())
                      ).sort((a, b) => b[1] - a[1]);
                      const filterKey = `${ztTab}:${sector}`;
                      const selected = sectorFilter[filterKey] ?? "全部";
                      const filteredItems = selected === "全部" ? items : items.filter((s) => (s.industry || "其他") === selected);
                      return (
                      <div key={sector}>
                        <div className="mb-1.5 flex items-center gap-2">
                          <span className="rounded bg-primary/15 px-2.5 py-0.5 text-xs font-bold text-primary">{sector}</span>
                          <span className="text-[11px] text-muted-foreground/50">{filteredItems.length} 家{selected !== "全部" && ` / 共 ${items.length} 家`}</span>
                        </div>
                        {/* 细分行业筛选横栏（只有1种细分时不显示） */}
                        {subIndustries.length > 1 && (
                          <div className="mb-2 flex flex-wrap gap-1">
                            <button
                              onClick={() => setSectorFilter((p) => ({ ...p, [filterKey]: "全部" }))}
                              className={cn("rounded px-2 py-0.5 text-[11px] font-medium transition-colors", selected === "全部" ? "bg-primary/20 text-primary" : "bg-muted/30 text-muted-foreground hover:text-foreground")}
                            >
                              全部 {items.length}
                            </button>
                            {subIndustries.map(([name, count]) => (
                              <button
                                key={name}
                                onClick={() => setSectorFilter((p) => ({ ...p, [filterKey]: name }))}
                                className={cn("rounded px-2 py-0.5 text-[11px] font-medium transition-colors", selected === name ? "bg-primary/20 text-primary" : "bg-muted/30 text-muted-foreground hover:text-foreground")}
                              >
                                {name} {count}
                              </button>
                            ))}
                          </div>
                        )}
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                                {["名称", "连板", "现价", "涨停%", "今日实时", "最后封板", "涨停原因", "细分行业", "成交额", "流通市值", ""].map((h) => (
                                  <th key={h} className="whitespace-nowrap px-2 py-1.5 font-medium">{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {filteredItems.map((s) => (
                                <Fragment key={s.code}>
                                  <tr className="border-b border-border/30">
                                    <td className="px-2 py-1.5"><span className="font-medium">{s.name}</span> <span className="text-xs text-muted-foreground/50">{s.code}</span></td>
                                    <td className="whitespace-nowrap px-2 py-1.5 font-mono font-bold text-primary">{s.boards > 1 ? `${s.boards} 板` : "首板"}</td>
                                    <td className="px-2 py-1.5 font-mono">{s.price}</td>
                                    <td className="px-2 py-1.5 font-mono text-danger">+{s.pct}%</td>
                                    <td className="px-2 py-1.5 font-mono">
                                      {lianbanQuotes[s.code]?.price != null ? (
                                        <span className={cn(pctColor(lianbanQuotes[s.code].change_pct))}>
                                          {lianbanQuotes[s.code].price}
                                          <span className="ml-1 text-xs">
                                            {lianbanQuotes[s.code].change_pct > 0 ? "+" : ""}{lianbanQuotes[s.code].change_pct}%
                                          </span>
                                        </span>
                                      ) : (
                                        <span className="text-muted-foreground/50">—</span>
                                      )}
                                    </td>
                                    <td className="whitespace-nowrap px-2 py-1.5 font-mono text-muted-foreground">{s.last_seal_time || "—"}</td>
                                    <td className="max-w-48 px-2 py-1.5 text-xs">
                                      {s.reason ? <span className="text-foreground">{s.reason}</span> : <span className="text-muted-foreground/50">—</span>}
                                    </td>
                                    <td className="whitespace-nowrap px-2 py-1.5 text-xs text-muted-foreground">{s.industry || "—"}</td>
                                    <td className="whitespace-nowrap px-2 py-1.5 font-mono text-muted-foreground">{yi(s.amount)}</td>
                                    <td className="whitespace-nowrap px-2 py-1.5 font-mono text-muted-foreground">{yi(s.float_cap)}</td>
                                    <td className="whitespace-nowrap px-2 py-1.5 text-right">
                                      <button
                                        onClick={() => dd.toggle(ztItem(s))}
                                        className="inline-flex items-center gap-1 rounded-lg border border-primary/50 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
                                      >
                                        {dd.running === s.code ? <Loader2 className="h-3 w-3 animate-spin" /> : dd.open === s.code ? <X className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />}
                                        {dd.open === s.code ? "收起" : dd.analysis[s.code] ? "展开" : "深入分析"}
                                      </button>
                                    </td>
                                  </tr>
                                  {dd.open === s.code && (
                                    <DeepDivePanel
                                      dd={dd}
                                      stockKey={s.code}
                                      colSpan={11}
                                      noteTitle={`涨停深析 · ${s.name} ${s.boards > 1 ? `${s.boards}板` : "首板"}`}
                                      onRerun={() => dd.rerun(ztItem(s))}
                                    />
                                  )}
                                </Fragment>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          </>
        )}
      </GlassCard>

      {/* 4b3. 明日验证条件（可核验的市场层面读数） */}
      <div className="mb-3 flex items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground"><CheckCircle className="h-4 w-4" /> 明日验证条件</h3>
        <Caliber text={
          "基于当日复盘数据，列出次日可核验的市场层面读数（涨停家数方向、封板率变化等）。\n" +
          "每个条件有预期方向和阈值，次日盘后自动核验是否成立。\n" +
          "只跟踪市场层面指标，不涉及个股预测。"
        } />
        <span className="text-[11px] text-muted-foreground/50">{verification?.review_date ? `基于 ${verification.review_date} 复盘 · 可核验的市场层面读数` : "可核验的市场层面读数"}</span>
      </div>
      <GlassCard className="mb-6">
        {verification?.is_historical && verification.review_date && (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-info/30 bg-info/10 px-3 py-2">
            <AlertTriangle className="h-4 w-4 text-info" />
            <span className="text-xs text-info">
              注意：{verification.historical_note || `显示 ${verification.review_date} 的验证条件`}
            </span>
          </div>
        )}
        {!verification ? (
          pending(veriDone)
        ) : !verification.available || !verification.items?.length ? (
          <p className="py-4 text-center text-sm text-muted-foreground/60">{verification.reason || "暂无验证条件"}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                  {["指标", "预期方向", "基准值", "阈值", "理由"].map((h) => (
                    <th key={h} className="whitespace-nowrap px-2 py-2 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {verification.items.map((it, i) => (
                  <tr key={i} className="border-b border-border/30">
                    <td className="px-2 py-2 font-medium">{it.label || it.metric}</td>
                    <td className={cn("whitespace-nowrap px-2 py-2 font-mono", it.direction === "上升" ? "text-danger" : it.direction === "下降" ? "text-success" : "text-muted-foreground")}>{it.direction}</td>
                    <td className="px-2 py-2 font-mono text-muted-foreground">{it.base_value == null ? "—" : `${fmt(it.base_value)}${it.unit || ""}`}</td>
                    <td className="px-2 py-2 font-mono text-muted-foreground">{it.eps == null ? "—" : `${fmt(it.eps)}${it.unit || ""}`}</td>
                    <td className="px-2 py-2 text-xs text-muted-foreground">{it.reason || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>

      {/* 4b4. 上期回看（T+1 命中回看） */}
      <div className="mb-3 flex items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground"><History className="h-4 w-4" /> 上期回看</h3>
        <Caliber text={
          "T+1 命中回看：上一交易日列出的明日验证条件在今天是否成立。\n" +
          "方向命中率 = 预测方向与实际方向一致的占比。\n" +
          "龙头次日均涨幅 = 上一交易日涨停股今天的平均涨跌幅。\n" +
          "「暂定」表示信号不足，待后续交易日重评。"
        } />
        <span className="text-[11px] text-muted-foreground/50">{reflection?.prediction_date && reflection?.eval_date ? `${reflection.prediction_date} → ${reflection.eval_date} 命中回看` : "T+1 命中回看"}</span>
      </div>
      <GlassCard className="mb-6">
        {!reflection ? (
          pending(reflDone)
        ) : !reflection.available ? (
          <div className="py-6 text-center">
            <p className="text-sm text-muted-foreground/60">{reflection.reason || "暂无回看记录"}</p>
            <p className="mt-2 text-xs text-muted-foreground/40">
              完成至少两天的复盘后，次日盘后会自动生成 T+1 命中回看
            </p>
          </div>
        ) : (
          <>
            {/* 情绪档位 + 方向命中率 + 龙头次日均涨幅 */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-lg bg-muted/25 p-4">
                <p className="text-xs text-muted-foreground">情绪档位</p>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-lg font-bold text-foreground">{reflection.phase_eval?.phase || reflection.emotion_phase || "—"}</span>
                  {reflection.phase_eval && (
                    <span className={cn("rounded px-1.5 py-0.5 text-xs font-medium", reflection.phase_eval.hit === true ? "bg-success/15 text-success" : reflection.phase_eval.hit === false ? "bg-danger/15 text-danger" : "bg-muted/30 text-muted-foreground")}>
                      {reflection.phase_eval.hit === true ? "命中" : reflection.phase_eval.hit === false ? "未中" : "待定"}
                    </span>
                  )}
                </div>
                {reflection.phase_eval?.provisional && <p className="mt-0.5 text-[10px] text-muted-foreground/50">暂定（信号不足，待重评）</p>}
              </div>
              <div className="rounded-lg bg-muted/25 p-4">
                <p className="text-xs text-muted-foreground">方向命中</p>
                <p className="mt-1 text-lg font-bold text-primary">{reflection.direction_hits ?? 0}/{reflection.direction_samples ?? 0} 方向命中</p>
                {reflection.direction_hit_rate != null && <p className="mt-0.5 text-[11px] text-muted-foreground/60">命中率 {pct(reflection.direction_hit_rate)}</p>}
              </div>
              <div className="rounded-lg bg-muted/25 p-4">
                <p className="text-xs text-muted-foreground">龙头次日均涨幅</p>
                <p className={cn("mt-1 text-lg font-bold", reflection.overall_next_ret != null ? pctColor(reflection.overall_next_ret) : "text-muted-foreground")}>
                  {reflection.overall_next_ret == null ? "—" : `${reflection.overall_next_ret > 0 ? "+" : ""}${reflection.overall_next_ret.toFixed(2)}%`}
                </p>
              </div>
            </div>
            {/* 验证条件逐条核验 */}
            {reflection.verification && reflection.verification.length > 0 && (
              <div className="mt-3">
                <p className="mb-1.5 text-[11px] text-muted-foreground">明日验证条件核验</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                        {["指标", "预期", "实际", "是否成立"].map((h) => (
                          <th key={h} className="whitespace-nowrap px-2 py-2 font-medium">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {reflection.verification.map((v, i) => (
                        <tr key={i} className="border-b border-border/30">
                          <td className="px-2 py-2 font-medium">{v.label}</td>
                          <td className={cn("whitespace-nowrap px-2 py-2 font-mono", v.expect === "上升" ? "text-danger" : v.expect === "下降" ? "text-success" : "text-muted-foreground")}>{v.expect}</td>
                          <td className={cn("whitespace-nowrap px-2 py-2 font-mono", v.actual === "上升" ? "text-danger" : v.actual === "下降" ? "text-success" : "text-muted-foreground")}>{v.actual || "—"}</td>
                          <td className={cn("whitespace-nowrap px-2 py-2 font-mono", v.verified === true ? "text-success" : v.verified === false ? "text-danger" : "text-muted-foreground")}>
                            {v.verified === true ? "成立" : v.verified === false ? "不成立" : "待定"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </GlassCard>

      {/* 4c. 全市场成交额 TOP20（客观公开榜单） */}
      <div className="mb-3 flex items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground"><BarChart3 className="h-4 w-4" /> 全市场成交额 TOP20</h3>
        <Caliber text={
          "沪深京 A 股按当日累计成交额从大到小排。\n" +
          "盘中看到的成交额是「到刷新那一刻为止」的累计值，不是收盘值；总市值按当前价算。\n" +
          "名字前面带 C 的是上市不满一年的次新股标记，不是名字的一部分。"
        } />
        <span className="text-[11px] text-muted-foreground/50">客观公开榜单，非推荐 / 非预测 / 不构成投资建议</span>
        {turnover?.updated && <span className="ml-auto text-[11px] text-muted-foreground/50">{turnover.updated}</span>}
      </div>
      <GlassCard className="mb-6">
        {turnover?.is_historical && turnover.historical_date && (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2">
            <AlertTriangle className="h-4 w-4 text-warning" />
            <span className="text-xs text-warning">
              注意：当前为 <strong>{turnover.historical_date}</strong> 收盘数据（{turnover.historical_note || "非交易时段"}），今日开盘后将自动更新
            </span>
          </div>
        )}
        {!turnover || turnover.stocks.length === 0 ? (
          pending(toDone)
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                  {["#", "名称", "现价", "涨跌%", "成交额", "总市值", "行业"].map((h) => (
                    <th key={h} className="whitespace-nowrap px-2 py-2 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {turnover.stocks.map((s, i) => (
                  <tr key={s.code} className="border-b border-border/30">
                    <td className="px-2 py-2 font-mono text-xs text-muted-foreground/50">{i + 1}</td>
                    <td className="px-2 py-2"><span className="font-medium">{s.name}</span> <span className="text-xs text-muted-foreground/50">{s.code}</span></td>
                    <td className="px-2 py-2 font-mono">{s.price ?? "—"}</td>
                    <td className={cn("px-2 py-2 font-mono", s.pct == null ? "text-muted-foreground" : pctColor(s.pct))}>
                      {s.pct == null ? "—" : `${s.pct > 0 ? "+" : ""}${s.pct}%`}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 font-mono">{yi(s.amount)}</td>
                    <td className="whitespace-nowrap px-2 py-2 font-mono text-muted-foreground">{yi(s.mcap)}</td>
                    <td className="whitespace-nowrap px-2 py-2 text-xs text-muted-foreground">{s.industry}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>

      {/* 5. 板块资金趋势榜（行业） */}
      <div className="mb-3 flex items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground"><TrendingUp className="h-4 w-4" /> 板块资金趋势榜</h3>
        <Caliber text={
          "净流入 / 流入 / 流出取自同花顺行业资金流的**盘中即时值**，单位亿元，净流入 = 流入 − 流出。\n" +
          "⚠️ 那边没说明这是主力资金还是全部成交资金，所以**不能当作主力净流入**来读。\n" +
          "涨跌% 是行业整体涨幅；成分股数是这个行业的公司总数，不是上涨家数、也不是涨停家数。"
        } />
        <span className="text-[11px] text-muted-foreground/50">行业 · 按今日净流入排序</span>
      </div>
      <GlassCard className="mb-6">
        {sectors.length === 0 ? (
          pending(ovDone)
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                  {["行业", "涨跌%", "今日净流入", "流入", "流出", "家数"].map((h) => (
                    <th key={h} className="whitespace-nowrap px-2 py-2 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sectors.slice(0, 15).map((s) => (
                  <tr key={s.name} className="border-b border-border/30">
                    <td className="px-2 py-2 font-medium">{s.name}</td>
                    <td className={cn("px-2 py-2 font-mono", pctColor(s.pct))}>{s.pct > 0 ? "+" : ""}{s.pct}%</td>
                    <td className={cn("px-2 py-2 font-mono", pctColor(s.net))}>{s.net > 0 ? "+" : ""}{fmt(s.net)} 亿</td>
                    <td className="px-2 py-2 font-mono text-muted-foreground">{fmt(s.inflow)}</td>
                    <td className="px-2 py-2 font-mono text-muted-foreground">{fmt(s.outflow)}</td>
                    <td className="px-2 py-2 font-mono text-muted-foreground">{s.firms}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>

      {/* 6. 资金轮动 */}
      <div className="mb-3 flex items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground"><ArrowDownUp className="h-4 w-4" /> 资金轮动</h3>
        <Caliber text={
          "就是上面那张榜的两头：流入榜只放净流入为正的、流出榜只放为负的，各取前六。\n" +
          "某一边不足六个就只列够格的那几个 —— 普跌日往往只有两三个行业真净流入。\n" +
          "口径同上：同花顺行业资金流盘中即时值，不能当主力净流入读。"
        } />
        <span className="text-[11px] text-muted-foreground/50">板块级净流入 / 流出</span>
      </div>
      <div className="mb-2 grid gap-4 md:grid-cols-2">
        {[
          { title: "流入 Top", icon: TrendingUp, color: "text-danger", rows: sectors.slice(0, 6) },
          { title: "流出 Top", icon: TrendingDown, color: "text-success", rows: [...sectors].slice(-6).reverse() },
        ].map((col) => (
          <GlassCard key={col.title}>
            <h4 className={cn("mb-3 flex items-center gap-1.5 text-sm font-semibold", col.color)}><col.icon className="h-4 w-4" /> {col.title}</h4>
            {col.rows.length === 0 ? (
              pending(ovDone)
            ) : (
              <div className="space-y-1.5">
                {col.rows.map((s, i) => (
                  <div key={s.name} className="flex items-center gap-3 border-b border-border/30 pb-1.5 text-sm last:border-0">
                    <span className="w-5 text-xs text-muted-foreground/50">{i + 1}</span>
                    <span className="flex-1 truncate">{s.name}</span>
                    <span className={cn("font-mono text-xs", pctColor(s.pct))}>{s.pct > 0 ? "+" : ""}{s.pct}%</span>
                    <span className={cn("w-20 text-right font-mono text-xs", pctColor(s.net))}>{s.net > 0 ? "+" : ""}{fmt(s.net)} 亿</span>
                  </div>
                ))}
              </div>
            )}
          </GlassCard>
        ))}
      </div>

      {/* 7. 核心标的（多空三炮） */}
      <div className="mb-3 flex items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground"><Crosshair className="h-4 w-4" /> 核心标的（多空三炮）</h3>
        <Caliber text={
          "核心标的：多方/空方关键票，用于观察市场情绪和资金流向。\n" +
          "系统推荐基于客观数据（连板龙头/首板强势/放量突破/炸板王/弱股持续弱/强股补跌），用户可手动校准覆盖。\n" +
          "跟踪天数：该标的连续出现在核心标的中的天数。\n" +
          "昨日核心标的今日表现：追踪昨天选出的票今天的涨跌情况。"
        } />
        {coreStocks?.today_date && <span className="ml-auto text-[11px] text-muted-foreground/50">{coreStocks.today_date}</span>}
      </div>
      <GlassCard className="mb-6">
        {!coreStocksDone ? (
          pending(false)
        ) : !coreStocks ? (
          <p className="py-4 text-center text-sm text-muted-foreground/60">核心标的数据获取失败</p>
        ) : (
          <>
            {/* 昨日核心标的今日表现 */}
            {coreStocks.yesterday.has_data && (
              <div className="mb-6">
                <h4 className="mb-3 text-sm font-semibold">昨日核心标的今日表现 <span className="text-xs text-muted-foreground/50">（{coreStocks.yesterday.date}）</span></h4>
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <p className="mb-2 text-xs text-muted-foreground">多方（{coreStocks.yesterday.bulls.length}）</p>
                    {coreStocks.yesterday.bulls.map((s) => (
                      <div key={s.code} className="mb-2 flex items-center justify-between rounded-lg bg-muted/20 p-3 text-sm">
                        <div className="min-w-0">
                          <span className="font-medium">{s.name}</span>
                          <span className="ml-1 text-xs text-muted-foreground/50">{s.code}</span>
                          {s.dimension && <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">{s.dimension}</span>}
                          {s.tracking_days && s.tracking_days > 1 && <span className="ml-2 text-xs text-warning">追踪{s.tracking_days}天</span>}
                        </div>
                        <span className={cn("whitespace-nowrap font-mono", s.today_pct != null ? pctColor(s.today_pct) : "text-muted-foreground")}>
                          {s.today_pct != null ? `${s.today_pct > 0 ? "+" : ""}${s.today_pct}%` : "—"}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div>
                    <p className="mb-2 text-xs text-muted-foreground">空方（{coreStocks.yesterday.bears.length}）</p>
                    {coreStocks.yesterday.bears.map((s) => (
                      <div key={s.code} className="mb-2 flex items-center justify-between rounded-lg bg-muted/20 p-3 text-sm">
                        <div className="min-w-0">
                          <span className="font-medium">{s.name}</span>
                          <span className="ml-1 text-xs text-muted-foreground/50">{s.code}</span>
                          {s.dimension && <span className="ml-2 rounded-full bg-danger/10 px-2 py-0.5 text-xs text-danger">{s.dimension}</span>}
                          {s.tracking_days && s.tracking_days > 1 && <span className="ml-2 text-xs text-warning">追踪{s.tracking_days}天</span>}
                        </div>
                        <span className={cn("whitespace-nowrap font-mono", s.today_pct != null ? pctColor(s.today_pct) : "text-muted-foreground")}>
                          {s.today_pct != null ? `${s.today_pct > 0 ? "+" : ""}${s.today_pct}%` : "—"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* 今日核心标的录入 */}
            <div>
              <div className="mb-3 flex items-center gap-2">
                <h4 className="text-sm font-semibold">今日核心标的</h4>
                {coreStocks.today.is_user_calibrated ? (
                  <span className="rounded-full bg-primary/15 px-2.5 py-0.5 text-[11px] font-medium text-primary">用户校准版</span>
                ) : (
                  <span className="rounded-full bg-muted/40 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">系统推荐版（未校准）</span>
                )}
              </div>
              <div className="mb-3 flex flex-wrap gap-2">
                <input
                  value={coreInput.code}
                  onChange={(e) => setCoreInput({ ...coreInput, code: e.target.value })}
                  placeholder="代码"
                  className="w-28 rounded-lg border border-border bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary/50"
                />
                <input
                  value={coreInput.name}
                  onChange={(e) => setCoreInput({ ...coreInput, name: e.target.value })}
                  placeholder="名称"
                  className="w-28 rounded-lg border border-border bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary/50"
                />
                <input
                  value={coreInput.dimension}
                  onChange={(e) => setCoreInput({ ...coreInput, dimension: e.target.value })}
                  placeholder="维度（连板龙头/炸板王/反核等）"
                  className="min-w-[180px] flex-1 rounded-lg border border-border bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary/50"
                />
                <div className="flex gap-0">
                  <button
                    onClick={() => setCoreInput({ ...coreInput, side: "bull" })}
                    className={cn("rounded-l-lg border border-border bg-black/20 px-3 py-2 text-sm", coreInput.side === "bull" ? "bg-danger/15 text-danger" : "text-muted-foreground")}
                  >
                    多方
                  </button>
                  <button
                    onClick={() => setCoreInput({ ...coreInput, side: "bear" })}
                    className={cn("rounded-r-lg border border-l-0 border-border bg-black/20 px-3 py-2 text-sm", coreInput.side === "bear" ? "bg-success/15 text-success" : "text-muted-foreground")}
                  >
                    空方
                  </button>
                </div>
              </div>
              <textarea
                value={coreInput.reason}
                onChange={(e) => setCoreInput({ ...coreInput, reason: e.target.value })}
                placeholder="入选理由（选填）"
                className="mb-3 w-full rounded-lg border border-border bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary/50"
                rows={2}
              />
              <button
                onClick={addCoreStock}
                disabled={coreSaving || !coreInput.code || !coreInput.name}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-4 py-2 text-sm font-medium text-primary shadow-glow hover:bg-primary/25 disabled:opacity-50"
              >
                {coreSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                添加核心标的
              </button>

              {/* 今日核心标的列表（merged：用户录入优先，未录入则默认系统推荐） */}
              {(coreStocks.today.merged_bulls.length > 0 || coreStocks.today.merged_bears.length > 0) && (
                <div className="mt-6">
                  <p className="mb-2 text-xs text-muted-foreground">
                    {coreStocks.today.is_user_calibrated ? "今日核心标的（用户校准 + 系统补充）" : "今日核心标的（系统推荐，未校准）"}
                  </p>
                  <div className="grid gap-4 md:grid-cols-2">
                    {/* 多方 */}
                    <div>
                      <p className="mb-2 text-xs text-muted-foreground">多方（{coreStocks.today.merged_bulls.length}）</p>
                      {coreStocks.today.merged_bulls.map((s) => {
                        const isUser = coreStocks.today.user_bulls.some((u) => u.code === s.code);
                        return (
                          <div key={s.code} className={cn("mb-2 flex items-center justify-between rounded-lg p-3 text-sm", isUser ? "bg-primary/5 ring-1 ring-primary/20" : "bg-muted/20")}>
                            <div className="min-w-0">
                              <div className="flex items-center gap-1">
                                <span className="font-medium">{s.name}</span>
                                <span className="text-xs text-muted-foreground/50">{s.code}</span>
                                {s.dimension && <span className="ml-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">{s.dimension}</span>}
                                <span className={cn("rounded px-1.5 py-0.5 text-[10px]", isUser ? "bg-primary/15 text-primary" : "bg-muted/30 text-muted-foreground/60")}>
                                  {isUser ? "我的" : "系统"}
                                </span>
                              </div>
                              {s.reason && <p className="mt-1 text-[11px] text-muted-foreground/60">{s.reason}</p>}
                            </div>
                            {isUser && (
                              <button onClick={() => removeCoreStock("bull", s.code)} className="text-muted-foreground hover:text-danger">
                                <X className="h-4 w-4" />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    {/* 空方 */}
                    <div>
                      <p className="mb-2 text-xs text-muted-foreground">空方（{coreStocks.today.merged_bears.length}）</p>
                      {coreStocks.today.merged_bears.map((s) => {
                        const isUser = coreStocks.today.user_bears.some((u) => u.code === s.code);
                        return (
                          <div key={s.code} className={cn("mb-2 flex items-center justify-between rounded-lg p-3 text-sm", isUser ? "bg-danger/5 ring-1 ring-danger/20" : "bg-muted/20")}>
                            <div className="min-w-0">
                              <div className="flex items-center gap-1">
                                <span className="font-medium">{s.name}</span>
                                <span className="text-xs text-muted-foreground/50">{s.code}</span>
                                {s.dimension && <span className="ml-1 rounded-full bg-danger/10 px-2 py-0.5 text-xs text-danger">{s.dimension}</span>}
                                <span className={cn("rounded px-1.5 py-0.5 text-[10px]", isUser ? "bg-danger/15 text-danger" : "bg-muted/30 text-muted-foreground/60")}>
                                  {isUser ? "我的" : "系统"}
                                </span>
                              </div>
                              {s.reason && <p className="mt-1 text-[11px] text-muted-foreground/60">{s.reason}</p>}
                            </div>
                            {isUser && (
                              <button onClick={() => removeCoreStock("bear", s.code)} className="text-muted-foreground hover:text-danger">
                                <X className="h-4 w-4" />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              {/* 系统推荐明细（折叠对比） */}
              {(coreStocks.today.system_bulls.length > 0 || coreStocks.today.system_bears.length > 0) && (
                <div className={cn("mt-4 rounded-lg p-3", coreStocks.today.is_user_calibrated ? "bg-muted/10 opacity-60" : "bg-muted/10")}>
                  <p className="mb-2 text-xs text-muted-foreground/60">
                    系统推荐明细{coreStocks.today.is_user_calibrated ? "（已被用户校准的部分已替换，仅作参考）" : "（未录入则默认使用）"}
                  </p>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div>
                      <p className="mb-1.5 text-[11px] text-muted-foreground/50">系统多方</p>
                      <div className="flex flex-wrap gap-1.5">
                        {coreStocks.today.system_bulls.length > 0 ? (
                          coreStocks.today.system_bulls.map((s) => (
                            <span key={s.code} className="rounded-full bg-muted/30 px-2.5 py-1 text-xs">
                              {s.name} <span className="text-muted-foreground/50">{s.dimension}</span>
                            </span>
                          ))
                        ) : <span className="text-[11px] text-muted-foreground/40">—</span>}
                      </div>
                    </div>
                    <div>
                      <p className="mb-1.5 text-[11px] text-muted-foreground/50">系统空方</p>
                      <div className="flex flex-wrap gap-1.5">
                        {coreStocks.today.system_bears.length > 0 ? (
                          coreStocks.today.system_bears.map((s) => (
                            <span key={s.code} className="rounded-full bg-muted/30 px-2.5 py-1 text-xs">
                              {s.name} <span className="text-muted-foreground/50">{s.dimension}</span>
                            </span>
                          ))
                        ) : <span className="text-[11px] text-muted-foreground/40">—</span>}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </GlassCard>

      {/* 8. 复盘计划 */}
      <div className="mb-3 flex items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground"><FileText className="h-4 w-4" /> 复盘计划</h3>
        <Caliber text={
          "每日复盘计划：用户手写的复盘思路和明日计划。\n" +
          "AI 复盘时会自动读取历史复盘计划，学习用户的复盘思路、关注维度和表达方式。\n" +
          "保存的计划会永久存储，供 AI 学习和回看使用。"
        } />
        <span className="text-[11px] text-muted-foreground/50">AI 自动学习你的复盘风格</span>
      </div>
      <GlassCard className="mb-6">
        {/* 录入区 */}
        <div className="mb-4">
          <textarea
            value={planText}
            onChange={(e) => setPlanText(e.target.value)}
            placeholder="今日复盘计划：情绪判断、资金流向、题材分析、个股追踪、风险提示、明日计划…"
            className="w-full rounded-lg border border-border bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary/50"
            rows={4}
          />
          {/* 标签区：chip 形式，自动提取的带×可删，手动添加的也可删 */}
          <div className="mt-2">
            <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-black/20 px-2 py-2 min-h-[40px]">
              {planTagItems.map((item) => (
                <span
                  key={item.text}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px]",
                    item.isAuto
                      ? "bg-primary/10 text-primary/70"
                      : "bg-primary/20 text-primary"
                  )}
                  title={item.isAuto ? "自动提取（点×删除，AI会学习不再提取）" : "手动添加"}
                >
                  {item.isAuto && <span className="text-[9px] opacity-60">AI</span>}
                  {item.text}
                  <button
                    onClick={() => removeTag(item.text, item.isAuto)}
                    className="ml-0.5 rounded-full hover:bg-primary/30 hover:text-primary"
                    title={item.isAuto ? "删除并加入排除（AI学习）" : "删除"}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === "," || e.key === "，") {
                    e.preventDefault();
                    addTag();
                  }
                }}
                placeholder={planTagItems.length === 0 ? "输入标签后回车添加，保存后自动提取关键词…" : "添加标签…"}
                className="min-w-[120px] flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/40"
              />
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground/50">
                {planTagItems.length > 0 && `${planTagItems.length} 个标签`}
                {planTagItems.some((t) => t.isAuto) && ` · AI 自动提取${planTagItems.filter((t) => t.isAuto).length}个`}
                {excludeCount > 0 && ` · 已学习排除${excludeCount}个关键词`}
              </span>
              <button
                onClick={savePlan}
                disabled={planSaving || !planText.trim()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-4 py-2 text-sm font-medium text-primary shadow-glow hover:bg-primary/25 disabled:opacity-50"
              >
                {planSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                保存复盘计划
              </button>
            </div>
          </div>
        </div>

        {/* 历史计划 */}
        {reviewPlans.length > 0 ? (
          <div>
            <p className="mb-3 text-xs text-muted-foreground">最近复盘计划（{reviewPlans.length}）</p>
            <div className="space-y-2">
              {reviewPlans.slice(0, 5).map((p) => {
                const pAutoSet = new Set(p.auto_tags || []);
                return (
                <div key={p.date} className="rounded-lg bg-muted/20 p-3 text-sm">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">{p.date}</span>
                    {p.tags?.map((t) => (
                      <span key={t} className={cn(
                        "rounded-full px-2 py-0.5 text-[10px]",
                        pAutoSet.has(t) ? "bg-primary/10 text-primary/60" : "bg-primary/20 text-primary"
                      )}>{t}</span>
                    ))}
                    {p.saved_at && <span className="ml-auto text-[10px] text-muted-foreground/40">{p.saved_at}</span>}
                  </div>
                  <p className="line-clamp-3 whitespace-pre-wrap text-muted-foreground">{p.plan_text}</p>
                </div>
                );
              })}
            </div>
          </div>
        ) : (
          <p className="py-3 text-center text-sm text-muted-foreground/50">还没有保存过复盘计划，录入后 AI 会自动学习你的复盘风格</p>
        )}
      </GlassCard>

      <Disclaimer />
    </div>
  );
}
