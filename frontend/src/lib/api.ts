// Vibe-Research 后端 API 客户端。/api → vite 代理到本地 FastAPI（默认 8900）。
// 后端未启动或数据源异常时抛 ApiError，页面据此优雅降级。

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// 后端访问密钥（对应后端部署时的 VR_API_KEY，公网部署防蹭用）。只存本地浏览器。
const ACCESS_KEY = "vr-access-key";

export function loadAccessKey(): string {
  try {
    return localStorage.getItem(ACCESS_KEY) || "";
  } catch {
    return "";
  }
}

export function saveAccessKey(key: string) {
  try {
    if (key) localStorage.setItem(ACCESS_KEY, key);
    else localStorage.removeItem(ACCESS_KEY);
  } catch {
    /* 隐私模式等场景 localStorage 不可用 */
  }
}

export function authHeaders(): Record<string, string> {
  const k = loadAccessKey();
  return k ? { Authorization: `Bearer ${k}` } : {};
}

export interface MyReport {
  id: string; name: string; industry: string; size: number; ext: string; ts: number;
}

// 下载/预览研报：带鉴权头 fetch → blob → 触发浏览器下载（<a download> 无法带 Authorization，故走 blob）。
export async function downloadReport(id: string, name: string): Promise<void> {
  const resp = await fetch(`/api/myreports/file/${id}`, { headers: authHeaders() });
  if (!resp.ok) throw new ApiError(`下载失败 HTTP ${resp.status}`, resp.status);
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function request<T>(path: string, method: "GET" | "POST" | "DELETE" = "GET", body?: unknown, timeoutMs?: number): Promise<T> {
  let resp: Response;
  const headers: Record<string, string> = { ...authHeaders() };
  const opts: RequestInit = { method };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  if (Object.keys(headers).length > 0) opts.headers = headers;
  // 超时控制：默认 8 秒，核心标的等慢接口可通过 timeoutMs 自定义
  const controller = new AbortController();
  opts.signal = controller.signal;
  const timeout = setTimeout(() => controller.abort(), timeoutMs ?? 8000);
  try {
    resp = await fetch(`/api${path}`, opts);
  } catch (e) {
    throw new ApiError(e instanceof DOMException && e.name === "AbortError" ? `请求超时：${path}` : "连接不到后端，请先启动 backend（uvicorn app:app --port 8900）", 0);
  } finally {
    clearTimeout(timeout);
  }
  let payload: any = null;
  try {
    payload = await resp.json();
  } catch {
    /* 非 JSON 响应 */
  }
  if (!resp.ok) {
    if (resp.status === 401) {
      throw new ApiError("后端开启了访问鉴权（VR_API_KEY）：请在「接入 AI」页底部填写后端访问密钥", 401);
    }
    throw new ApiError(payload?.detail || `HTTP ${resp.status}`, resp.status);
  }
  return (payload?.data ?? payload) as T;
}

const get = <T>(path: string, timeoutMs?: number) => request<T>(path, "GET", undefined, timeoutMs);

export interface Quote {
  name: string; price: number; last_close: number; change_pct: number;
  pe_ttm: number; pb: number; mcap_yi: number; turnover_pct: number;
  limit_up: number; limit_down: number;
}

export interface Valuation {
  name: string; code: string; price: number; mcap_yi: number;
  pe_ttm: number; pb: number;
  eps_26e: number | null; eps_27e: number | null; pe_26e: number | null;
  cagr_pct: number | null; peg: number | null; digest_years: number | null;
  analyst_count: number; forecast_note?: string;
}

export interface Report {
  title: string; publishDate: string; orgSName: string;
  emRatingName?: string; indvInduName?: string; pdfUrl?: string | null;
}

export interface ValMetric {
  current: number; percentile: number; min: number; max: number;
  p20: number; p50: number; p80: number; n: number;
}
export interface ValPercentile {
  period: string; metrics: { pe_ttm?: ValMetric; pb?: ValMetric };
}

export interface Announcement {
  date: string; title: string; type: string; url: string;
}

export interface Financials {
  period: string | null;
  revenue: string | null; revenue_yoy: string | null;
  net_profit: string | null; net_profit_yoy: string | null;
  eps: string | null; bvps: string | null; roe: string | null;
  gross_margin: string | null; net_margin: string | null; op_cf_ps: string | null;
}

export interface NewsItem {
  新闻标题?: string; 发布时间?: string; 文章来源?: string; 新闻链接?: string;
}

export interface IndexQuote {
  name: string; price: number; change_pct: number; change_amt: number;
}

export interface MarketSentiment {
  up: number; down: number; flat: number; zt: number; zt_real: number; dt: number; dt_real: number;
  active: string; breadth: string; speculation: string; date: string;
}
export interface SectorFlow {
  name: string; pct: number; net: number; inflow: number; outflow: number; firms: number;
}
export interface MarketOverview {
  sentiment: MarketSentiment; sectors: SectorFlow[]; updated: string;
}

// 短线情绪：连板梯队 / 最高连板 / 炸板率 / 封板率 / 晋级率 / 涨跌停家数 + 连板/首板清单（客观公开榜单）
export interface EmotionTier { boards: number; count: number; plus: boolean }
export interface LianbanStock {
  code: string; name: string; boards: number;
  price: number; pct: number; amount: number | null; float_cap: number | null; industry: string;
  reason?: string;              // 涨停原因（同花顺）
  first_seal_time?: string;     // 首次封板时间
  last_seal_time?: string;      // 最后封板时间
  break_count?: number;         // 炸板次数
  pattern?: string;             // 涨停形态
  seal_fund?: number | null;    // 封板资金
}
export interface ShortTermEmotion {
  date: string;
  zt_count: number; dt_count: number; zb_count: number;
  max_boards: number; lianban_count: number; shouban_count?: number;
  ladder: EmotionTier[];
  lianban_stocks: LianbanStock[];
  shouban_stocks?: LianbanStock[];
  seal_rate: number | null; break_rate: number | null; promotion_rate: number | null;
  yzt_count: number;
}

// 全市场成交额榜（客观公开榜单）
export interface TurnoverStock {
  code: string; name: string;
  price: number | null; pct: number | null;
  amount: number | null; mcap: number | null; float_cap: number | null; industry: string;
}
export interface TurnoverTop {
  stocks: TurnoverStock[];
  updated: string;
  is_historical?: boolean;
  historical_date?: string;
  historical_note?: string;
}

export interface RadarItem {
  title: string; url: string; time: string; source: string; summary?: string; zh?: string;
}
export interface Industry {
  key: string; name: string; accent: string; total: number; items: RadarItem[];
}
export interface RadarData {
  generated_at: string | null; recent_days: number; industries: Industry[];
  stats: { industries: number; total_sources: number; failed_sources?: number };
}

export interface Holding {
  code: string; name: string; price: number; shares: number; cost: number;
  market_value: number; pnl: number; pnl_pct: number;
}
export interface ClosedPosition {
  code: string; name: string; date: string; price: number; shares: number; cost: number;
  pnl: number; pnl_pct: number;
}
export interface PortfolioData {
  holdings: Holding[];
  totals: { market_value: number; cost: number; pnl: number; pnl_pct: number };
  closed: ClosedPosition[];
  realized_pnl: number;
  updated: string; last_refresh: string | null;
}

// 资金面 / 筹码 / 信号（v3.3 并入，均为「用户查的那只股」的公开数据）
export interface MarginRow { date: string; rzye: number; rzmre: number; rzche: number; rqye: number; rqmcl: number; rzrqye: number }
export interface BlockTradeRow { date: string; price: number; close: number; premium_pct: number; vol: number; amount: number; buyer: string; seller: string }
export interface HolderRow { date: string; holder_num: number; change_ratio: number; avg_shares: number }
export interface DividendRow { date: string; bonus_rmb: number; transfer_ratio: number; bonus_ratio: number | null; plan: string }
export interface FundFlowRow { date: string; main_net: number; small_net: number; mid_net: number; large_net: number; super_net: number }
export interface DtSeat { name: string; buy_amt: number; sell_amt: number; net: number }
export interface DragonTiger {
  records: { date: string; reason: string; net_buy: number; turnover: number }[];
  seats: { buy: DtSeat[]; sell: DtSeat[] };
  institution: { buy_amt: number; sell_amt: number; net_amt: number };
}
export interface LockupRow { date: string; type: string; shares: number; able_shares: number; ratio: number }
export interface Lockup { history: LockupRow[]; upcoming: LockupRow[] }
export interface Board { name: string; code: string; change_pct: number | string; lead_stock: string }
export interface Blocks { total: number; boards: Board[]; concept_tags: string[] }
export interface HotConcept { concept: string; bk: string; hit: number }
export interface QaRow { company: string; question: string; answer: string | null; answerer: string; ask_time: string }
export interface IndustryRow { rank: number; name: string; change_pct: number; code: string; up_count: number; down_count: number }
export interface IndustryData { top: IndustryRow[]; bottom: IndustryRow[]; total: number }

// 全球市场（美股 / 港股，移植自 global-stock-data · 东财域内源）
export interface GlobalIndex {
  key: string; name: string; region: string;
  price: number | null; change_pct: number | null;
}

// 交易时段判断
export interface MarketSession {
  now: string;
  today: string;
  quotes_of: string | null;
  is_today: boolean;
  phase: string;
  label: string;
}

// 今日实时打板情绪（盘中随盘变化，与 ShortTermEmotion 分开）
export interface LiveEmotion {
  available: boolean;
  reason?: string;
  date?: string;
  as_of?: string;
  phase?: string;
  zt_count?: number;
  dt_count?: number | null;
  zb_count?: number | null;
  max_boards?: number;
  lianban_count?: number;
  seal_rate?: number | null;
  break_rate?: number | null;
  promotion_rate?: number | null;
  promotion_base?: number | null;
  promotion_base_date?: string | null;
}
export interface GlobalQuote {
  code: string; name: string;
  price: number | null; open: number | null; high: number | null; low: number | null;
  prev_close: number | null; amount: number | null; mcap: number | null; change_pct: number | null;
}
export interface GlobalMetrics {
  report_date: string;
  revenue: number | null; revenue_yoy: number | null; net_profit: number | null;
  eps: number | null; roe: number | null; gross_margin: number | null;
  net_margin: number | null; debt_ratio: number | null;
}
export interface GlobalStock {
  code: string; name: string; market: string;
  quote: GlobalQuote; metrics: GlobalMetrics | null;
}

// ── Vibe-Astock 派生情绪指标 ──
export interface DerivedEmotion {
  date: string;
  prev_date?: string;
  money_effect?: {
    available: boolean; avg?: number; median?: number;
    positive_rate?: number; limit_up_again_rate?: number; source?: string;
  };
  promotion?: {
    available: boolean; overall?: { base: number; promoted: number; rate: number | null };
    tiers?: Record<string, { base: number; promoted: number; rate: number | null }>;
  };
  consec_premium?: {
    available: boolean; avg?: number; median?: number; positive_rate?: number;
  };
  ladder_gap?: {
    available: boolean; highest?: number; continuous?: boolean; gaps?: number[];
    tiers?: Record<string, number>;
  };
  cycle?: {
    available: boolean; day_n?: number; rising?: boolean; trend?: string;
    pctile?: number; trough_date?: string;
  };
}

// ── 市场情绪温度（含昨日对比 + 权重体系 + 学习进度）──
export interface TemperatureView {
  date: string;
  system: { temperature: number | null; state?: string | null };
  prev: { date?: string; temperature: number | null; state?: string | null; diff?: number | null };
  user: { temperature: number | null; notes?: string; diff?: number | null };
  weights: Record<string, number>;
  learning: { record_count: number; avg_diff: number | null; trend: string };
}

// ── 明日验证条件 ──
export interface VerificationItem {
  metric: string; label?: string; direction: string; reason?: string;
  unit?: string; eps?: number; base_value?: number | null; higher_is_hotter?: boolean;
}
export interface VerificationData {
  available: boolean;
  review_date?: string;
  emotion_phase?: string;
  items?: VerificationItem[];
  reason?: string;
  is_historical?: boolean;
  historical_note?: string;
}

// ── T+1 命中回看 ──
export interface ReflectionData {
  available: boolean;
  prediction_date?: string; eval_date?: string; emotion_phase?: string;
  overall_next_ret?: number | null; direction_hit_rate?: number | null;
  direction_hits?: number; direction_samples?: number;
  phase_eval?: { phase: string; hit: boolean | null; provisional?: boolean };
  verification?: Array<{
    metric: string; label: string; expect: string; actual: string | null;
    verified: boolean | null; prev_value: number | null; cur_value: number | null;
  }>;
  reason?: string;
}

// ── 累计战绩 ──
export interface Scoreboard {
  phase?: {
    decided: number; hits: number; flat: number;
    next_day_direction_rate?: number | null; enough_samples: boolean;
    by_phase?: Record<string, { n: number; hit: number; hit_rate?: number }>;
  };
  stock?: { days: number; samples: number; hits: number; hit_rate?: number | null };
  recent?: Array<{ prediction_date: string; eval_date: string; phase?: string; hit?: boolean | null }>;
}

// ── 复盘存档（结构化 AI 研判） ──
export interface FocusDirection {
  direction: string;
  logic: string;
  risk: string;
  leader_candidates?: string[];
}
export interface TomorrowFocus {
  emotion_phase: string;
  market_oneliner: string;
  focus_directions: FocusDirection[];
  risk_alerts: string[];
  verification_items?: VerificationItem[];
}
export interface ReviewData {
  available: boolean;
  reason?: string;
  target_date?: string;
  trade_date?: string;
  generated_at?: string;
  focus: TomorrowFocus | null;
  focus_md?: string;
  warnings?: string[];
  // 历史模式：存档里的市场事实 + 情绪指标
  market_facts?: MarketFacts;
  emotion_metrics?: Record<string, unknown>;
}

// ── 市场事实（历史存档用）──
export interface MarketFacts {
  breadth?: {
    available?: boolean; date?: string;
    up?: number; down?: number; flat?: number; amount_yi?: number;
    up_down_scope?: string; universe?: number;
    deep_up_5_incl?: number; deep_down_5?: number;
  };
  seal_quality?: {
    available?: boolean; total?: number; never_broken?: number; never_broken_rate?: number;
    opening_seconds?: number; late_seal?: number; reopened?: number; avg_broken_times?: number;
  };
  loss_effect?: {
    available?: boolean; prev_date?: string; sample?: number;
    deep_loss_5_count?: number; deep_loss_5_rate?: number;
    deep_loss_7_count?: number; limit_down_count?: number;
    worst?: number; market_limit_down?: number;
  };
  feedback_matrix?: {
    available?: boolean; matrix?: Record<string, Record<string, number | undefined>>;
  };
  theme_structure?: {
    available?: boolean; total_themes?: number; themes?: Array<{ name?: string; count?: number; pct?: number }>;
  };
  by_board?: {
    available?: boolean; boards?: Array<{ board?: string; count?: number; zt?: number }>;
  };
}

// ── 核心标的（多空三炮） ──
export interface CoreStock {
  code: string; name: string;
  dimension?: string;   // 维度（地天板/反核/核按钮/连续跌停等）
  reason?: string;      // 理由
  pct?: number;         // 当日涨跌幅
  today_price?: number;
  today_pct?: number;
  today_open?: number;
  today_high?: number;
  today_low?: number;
  today_amount_wan?: number;
  today_turnover?: number;
  today_amplitude?: number;
  tracking_days?: number;
  history?: Array<{ date: string; side: string; dimension?: string; reason?: string; pct?: number }>;
}
export interface CoreStocksData {
  today_date: string;
  yesterday: {
    date: string; bulls: CoreStock[]; bears: CoreStock[];
    has_data: boolean; note?: string;
  };
  today: {
    date: string;
    system_bulls: CoreStock[]; system_bears: CoreStock[];
    user_bulls: CoreStock[]; user_bears: CoreStock[];
    merged_bulls: CoreStock[]; merged_bears: CoreStock[];
    is_user_calibrated: boolean; note?: string;
  };
}

// ── 复盘计划 ──
export interface ReviewPlan {
  date: string;
  plan_text: string;
  tags: string[];
  auto_tags?: string[];
  user_tags?: string[];
  saved_at?: string;
}
export interface ReviewPlansData {
  plans: ReviewPlan[];
  total: number;
}
export interface ReviewPlansForAI {
  recent_plans: ReviewPlan[];
  total: number;
  user_style_summary: string;
}

// ── AI 盘面研判（可编辑+对话调教）──
export interface AiChatMsg {
  role: "user" | "assistant";
  content: string;
  ts?: string;
}
export interface AiReviewRecord {
  date: string;
  focus: TomorrowFocus | null;
  raw_text?: string;
  source?: string;             // auto/manual/edited/chat
  edited_text?: string;        // 用户修改后的研判
  chat_history?: AiChatMsg[];  // 对话调教记录
  generated_at?: string;
  edited_at?: string;
}

export const api = {
  health: () => get<{ ok: boolean }>("/health"),
  indices: () => get<IndexQuote[]>("/indices"),
  marketOverview: () => get<MarketOverview>("/market/overview"),
  emotion: () => get<ShortTermEmotion>("/market/emotion"),
  marketSession: () => get<MarketSession>("/market/session"),
  liveEmotion: () => get<LiveEmotion>("/market/live-emotion"),
  turnoverTop: () => get<TurnoverTop>("/market/turnover-top"),
  globalIndices: () => get<GlobalIndex[]>("/global/indices"),
  globalStock: (symbol: string) => get<GlobalStock>(`/global/stock?symbol=${encodeURIComponent(symbol)}`),
  radar: () => get<RadarData>("/radar"),
  radarRefresh: () => request<RadarData>("/radar/refresh", "POST"),
  portfolio: () => get<PortfolioData>("/portfolio"),
  addHolding: (code: string, shares: number, cost: number) => request<PortfolioData>("/portfolio/holding", "POST", { code, shares, cost }),
  removeHolding: (code: string) => request<PortfolioData>(`/portfolio/holding?code=${code}`, "DELETE"),
  refreshPortfolio: () => request<PortfolioData>("/portfolio/refresh", "POST"),
  closePosition: (code: string, date: string, price: number, shares: number, cost: number) =>
    request<PortfolioData>("/portfolio/close", "POST", { code, date, price, shares, cost }),
  removeClosed: (index: number) => request<PortfolioData>(`/portfolio/close?index=${index}`, "DELETE"),
  valuation: (code: string) => get<Valuation>(`/valuation?code=${code}`),
  percentile: (code: string) => get<ValPercentile>(`/valuation/percentile?code=${code}`),
  financials: (code: string) => get<Financials>(`/financials?code=${code}`),
  announcements: (code: string) => get<Announcement[]>(`/announcements?code=${code}`),
  quote: (codes: string) => get<Record<string, Quote>>(`/quote?codes=${codes}`),
  reports: (code: string) => get<Report[]>(`/reports?code=${code}`),
  news: (code: string) => get<NewsItem[]>(`/news?code=${code}`),
  margin: (code: string) => get<MarginRow[]>(`/margin?code=${code}`),
  blockTrade: (code: string) => get<BlockTradeRow[]>(`/block-trade?code=${code}`),
  holders: (code: string) => get<HolderRow[]>(`/holders?code=${code}`),
  dividend: (code: string) => get<DividendRow[]>(`/dividend?code=${code}`),
  fundFlow: (code: string) => get<FundFlowRow[]>(`/fund-flow?code=${code}`),
  dragonTiger: (code: string) => get<DragonTiger>(`/dragon-tiger?code=${code}`),
  lockup: (code: string) => get<Lockup>(`/lockup?code=${code}`),
  blocks: (code: string) => get<Blocks>(`/blocks?code=${code}`),
  hotConcepts: (code: string) => get<HotConcept[]>(`/hot-concepts?code=${code}`),
  investorQa: (code: string) => get<QaRow[]>(`/investor-qa?code=${code}`),
  industry: (top = 20) => get<IndustryData>(`/industry?top=${top}`),
  myReports: () => get<MyReport[]>("/myreports"),
  uploadReport: (name: string, contentB64: string) =>
    request<MyReport>("/myreports", "POST", { name, content_b64: contentB64 }),
  deleteReport: (id: string) => request<{ ok: boolean }>(`/myreports/${id}`, "DELETE"),
  // Vibe-Astock 派生指标 / 验证 / 回看
  derivedEmotion: (date?: string) => get<DerivedEmotion>(`/market/derived-emotion${date ? `?date=${date}` : ""}`),
  // 历史市场数据（从 vibe-astock 缓存读取某天的涨跌家数/封板质量等）
  marketHistory: (date: string) => get<MarketFacts>(`/market/history?date=${date}`),
  // 市场情绪温度（今日+昨日对比+权重体系+学习进度）
  temperatureView: (date?: string) => get<TemperatureView>(`/sentiment/view${date ? `?date=${date}` : ""}`),
  saveTemperature: (date: string, temperature: number, notes = "") =>
    request<{ ok: boolean; date: string }>("/sentiment/user-input", "POST", { date, temperature, notes }),
  temperatureHistory: (days = 15) => get<{ rows: any[] }>(`/sentiment/temperature-history?days=${days}`),
  verification: (date?: string) => get<VerificationData>(`/review/verification${date ? `?date=${date}` : ""}`),
  reflection: () => get<ReflectionData>("/review/reflection"),
  scoreboard: () => get<Scoreboard>("/review/scoreboard"),
  // 复盘存档（按日期）
  reviewDates: () => get<{ dates: string[] }>("/review/dates"),
  reviewLatest: (date?: string) => get<ReviewData>(`/review/latest${date ? `?date=${date}` : ""}`),
  // 核心标的（多空三炮）—— 支持 date 参数查看历史，30秒超时（历史日期调东财API较慢）
  coreStocks: (date?: string) => get<CoreStocksData>(date ? `/core-stocks?date=${date}` : "/core-stocks", 30000),
  saveCoreStocks: (date: string, bulls: CoreStock[], bears: CoreStock[]) =>
    request<{ ok: boolean; date: string }>("/core-stocks/user-input", "POST", { date, bulls, bears }),
  coreStocksHistory: () => get<{ history: any[]; record_count: number }>("/core-stocks/history"),
  // 复盘计划 —— latestReviewPlan 支持 date 参数获取指定日期的计划
  reviewPlans: (limit = 30) => get<ReviewPlansData>(`/review-plans?limit=${limit}`),
  latestReviewPlan: (date?: string) => get<ReviewPlan>(`/review-plans/latest${date ? `?date=${date}` : ""}`),
  saveReviewPlan: (date: string, plan_text: string, tags: string[] = []) =>
    request<{ ok: boolean; date: string; tags: string[]; auto_tags: string[]; exclude_count: number }>("/review-plans/save", "POST", { date, plan_text, tags }),
  removePlanTag: (date: string, tag: string, exclude = true) =>
    request<{ ok: boolean; date: string; tags: string[]; auto_tags: string[] }>("/review-plans/remove-tag", "POST", { date, tag, exclude }),
  keywordPreferences: () => get<{ excludes: string[]; user_added: string[]; exclude_count: number }>("/review-plans/keyword-preferences"),
  restoreKeyword: (keyword: string) =>
    request<{ ok: boolean }>("/review-plans/restore-keyword", "POST", { keyword }),
  // AI 盘面研判（自动生成/存储/编辑/对话调教）
  aiReviewLatest: (date?: string) => get<AiReviewRecord>(`/ai-reviews/latest${date ? `?date=${date}` : ""}`),
  saveAiReview: (date: string, focus: TomorrowFocus, raw_text = "", source = "manual") =>
    request<{ ok: boolean; date: string }>("/ai-reviews/save", "POST", { date, focus, raw_text, source }),
  editAiReview: (date: string, edited_text: string) =>
    request<{ ok: boolean; date: string }>("/ai-reviews/edit", "POST", { date, edited_text }),
};
