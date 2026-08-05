// 「AI 深入分析」共享单元：行内展开的流式分析面板（涨停板分析共用）。
// useDeepDive 管理展开态 + 流式请求 + 本地存档 + 一键全部分析；DeepDivePanel 渲染表格内的展开行。
// 存档只存本地 localStorage，按「日期|页面|代码」为键，自动清理只保留最近 5 个交易日。
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { SaveNoteButton } from "@/components/ui/SaveNoteButton";
import { hasLlm, chatStream } from "@/lib/llm";

const TOOL_LABEL: Record<string, string> = {
  query_quote: "查行情",
  query_valuation: "查估值",
  query_reports: "查研报",
  query_news: "查新闻",
  query_global_stock: "查外盘",
};

// ---------- 本地存档 ----------
const STORE_KEY = "vr-deepdive";
const KEEP_DAYS = 5;

interface DiveRecord {
  text: string;
  tools: string[];
  ts: number;
}

type Store = Record<string, DiveRecord>;

function loadStore(): Store {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function persistStore(store: Store) {
  const dates = [...new Set(Object.keys(store).map((k) => k.split("|")[0]))].sort().reverse();
  const keep = new Set(dates.slice(0, KEEP_DAYS));
  const next: Store = {};
  for (const [k, v] of Object.entries(store)) {
    if (keep.has(k.split("|")[0])) next[k] = v;
  }
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    /* 容量超限等：放弃本次持久化 */
  }
}

const normDate = (d: string) => d.split("-").join("");

// ---------- hook ----------
export interface DiveItem {
  key: string;
  prompt: string;
  context: string;
}

export interface DeepDiveState {
  open: string | null;
  analysis: Record<string, string>;
  tools: Record<string, string[]>;
  running: string | null;
  aiErr: string | null;
  needConfig: boolean;
  batch: { done: number; total: number; current: string } | null;
  toggle: (item: DiveItem) => void;
  rerun: (item: DiveItem) => void;
  runAll: (items: DiveItem[]) => void;
  stopAll: () => void;
}

export function useDeepDive(ns: string, date: string): DeepDiveState {
  const [open, setOpen] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<Record<string, string>>({});
  const [tools, setTools] = useState<Record<string, string[]>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [aiErr, setAiErr] = useState<string | null>(null);
  const [needConfig, setNeedConfig] = useState(false);
  const [batch, setBatch] = useState<DeepDiveState["batch"]>(null);
  const acRef = useRef<AbortController | null>(null);
  const batchStopRef = useRef(false);
  const day = normDate(date);

  useEffect(() => {
    if (!day) return;
    const store = loadStore();
    const prefix = `${day}|${ns}|`;
    const a: Record<string, string> = {};
    const t: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(store)) {
      if (k.startsWith(prefix)) {
        const code = k.slice(prefix.length);
        a[code] = v.text;
        t[code] = v.tools;
      }
    }
    setAnalysis(a);
    setTools(t);
  }, [ns, day]);

  useEffect(() => () => { batchStopRef.current = true; acRef.current?.abort(); }, []);

  const saveRecord = (code: string, text: string, toolList: string[]) => {
    if (!day || !text.trim()) return;
    const store = loadStore();
    store[`${day}|${ns}|${code}`] = { text, tools: toolList, ts: Date.now() };
    persistStore(store);
  };

  const start = async (item: DiveItem, expand: boolean): Promise<boolean> => {
    setAiErr(null);
    setNeedConfig(false);
    if (expand) setOpen(item.key);
    if (!hasLlm()) {
      setNeedConfig(true);
      if (!expand) setOpen(item.key);
      return false;
    }
    acRef.current?.abort();
    const ac = new AbortController();
    acRef.current = ac;
    setRunning(item.key);
    setAnalysis((m) => ({ ...m, [item.key]: "" }));
    setTools((m) => ({ ...m, [item.key]: [] }));
    let text = "";
    let toolList: string[] = [];
    try {
      await chatStream([{ role: "user", content: item.prompt }], item.context, {
        onDelta: (t) => {
          text += t;
          setAnalysis((m) => ({ ...m, [item.key]: (m[item.key] || "") + t }));
        },
        onTool: (tool) => {
          const label = TOOL_LABEL[tool] || tool;
          if (!toolList.includes(label)) toolList = [...toolList, label];
          setTools((m) => ({ ...m, [item.key]: toolList }));
        },
      }, ac.signal);
      saveRecord(item.key, text, toolList);
      return true;
    } catch (e) {
      if (!ac.signal.aborted) setAiErr(e instanceof Error ? e.message : "分析失败");
      return false;
    } finally {
      setRunning((r) => (r === item.key ? null : r));
    }
  };

  const toggle = (item: DiveItem) => {
    if (open === item.key) {
      if (running === item.key) acRef.current?.abort();
      setOpen(null);
      return;
    }
    setAiErr(null);
    setNeedConfig(false);
    if (analysis[item.key]) {
      setOpen(item.key);
      return;
    }
    void start(item, true);
  };

  const runAll = async (items: DiveItem[]) => {
    if (batch) return;
    const todo = items.filter((it) => !analysis[it.key]);
    if (todo.length === 0) return;
    if (!hasLlm()) {
      setNeedConfig(true);
      if (todo[0]) setOpen(todo[0].key);
      return;
    }
    batchStopRef.current = false;
    let done = 0;
    for (const it of todo) {
      if (batchStopRef.current) break;
      setBatch({ done, total: todo.length, current: it.key });
      const ok = await start(it, false);
      if (!ok && batchStopRef.current) break;
      done += 1;
      setBatch({ done, total: todo.length, current: "" });
    }
    setBatch(null);
  };

  const stopAll = () => {
    batchStopRef.current = true;
    acRef.current?.abort();
    setBatch(null);
    setRunning(null);
  };

  return {
    open, analysis, tools, running, aiErr, needConfig, batch,
    toggle,
    rerun: (item) => void start(item, true),
    runAll: (items) => void runAll(items),
    stopAll,
  };
}

// ---------- 表格内展开行 ----------
interface PanelProps {
  dd: DeepDiveState;
  stockKey: string;
  colSpan: number;
  noteTitle: string;
  onRerun: () => void;
}

export function DeepDivePanel({ dd, stockKey, colSpan, noteTitle, onRerun }: PanelProps) {
  const text = dd.analysis[stockKey] || "";
  const isRunning = dd.running === stockKey;
  return (
    <tr className="border-b border-border/30 bg-primary/[0.03]">
      <td colSpan={colSpan} className="px-3 py-3">
        {dd.needConfig ? (
          <p className="text-sm text-muted-foreground">
            还没接入 AI —— 先去 <Link to="/settings" className="text-primary underline">接入 AI</Link> 页配置一次，回来即可一键深入分析。
          </p>
        ) : (
          <div>
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              AI 深入分析（由你配置的模型给出，非本产品观点，不构成投资建议）
              {(dd.tools[stockKey] || []).map((t) => (
                <span key={t} className="rounded-full border border-secondary/40 bg-secondary/10 px-2 py-0.5">{t}</span>
              ))}
              {isRunning && <Loader2 className="h-3 w-3 animate-spin" />}
              {!isRunning && text && (
                <>
                  <button
                    onClick={onRerun}
                    className="inline-flex items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 hover:text-foreground"
                  >
                    <RefreshCw className="h-3 w-3" /> 重新分析
                  </button>
                  <SaveNoteButton kind="问AI" title={noteTitle} content={text} />
                </>
              )}
            </div>
            {dd.aiErr && dd.open === stockKey && <p className="mb-1 text-xs text-danger">{dd.aiErr}</p>}
            <div className="prose prose-sm prose-invert max-w-none text-foreground">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {text || (isRunning ? "正在调工具、组织分析…" : "")}
              </ReactMarkdown>
            </div>
          </div>
        )}
      </td>
    </tr>
  );
}

// ---------- 一键全部分析按钮 ----------
interface RunAllProps {
  dd: DeepDiveState;
  items: DiveItem[];
  nameOf?: (key: string) => string;
}

export function RunAllButton({ dd, items, nameOf }: RunAllProps) {
  const remaining = items.filter((it) => !dd.analysis[it.key]).length;
  if (dd.batch) {
    return (
      <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
        批量分析中 {dd.batch.done}/{dd.batch.total}
        {dd.batch.current && <>· {nameOf ? nameOf(dd.batch.current) : dd.batch.current}</>}
        <button
          onClick={dd.stopAll}
          className="rounded border border-border/60 px-1.5 py-0.5 hover:text-foreground"
        >
          停止
        </button>
      </span>
    );
  }
  return (
    <button
      onClick={() => dd.runAll(items)}
      disabled={remaining === 0}
      className="inline-flex items-center gap-1 rounded-lg border border-primary/50 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Sparkles className="h-3 w-3" />
      {remaining === 0 ? "已全部分析" : `一键全部分析（剩 ${remaining} 只）`}
    </button>
  );
}
