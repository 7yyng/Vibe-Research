import { useState, useEffect, useCallback } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { GlassCard } from "@/components/ui/GlassCard";
import { Bot, RefreshCw, ExternalLink, AlertCircle, Loader2 } from "lucide-react";

const VIBE_ASTOCK_URL = "http://localhost:8910";

export function AstockAnalysis() {
  const [loading, setLoading] = useState(true);
  const [online, setOnline] = useState<boolean | null>(null);

  const checkHealth = useCallback(async () => {
    try {
      const res = await fetch(`${VIBE_ASTOCK_URL}/api/review/status`, { cache: "no-store" });
      setOnline(res.ok);
    } catch {
      setOnline(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkHealth();
    const timer = setInterval(checkHealth, 10000);
    return () => clearInterval(timer);
  }, [checkHealth]);

  return (
    <div>
      <PageHeader
        title="短线复盘看板"
        subtitle="涨停池 · 连板梯队 · 龙虎榜 · 板块资金 · 赚钱效应/晋级率/情绪周期 · 基于 Vibe-Astock"
        actions={
          <a
            href={VIBE_ASTOCK_URL}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 rounded-lg border border-border/50 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" /> 新窗口打开
          </a>
        }
      />

      {/* 服务状态提示 */}
      {loading && (
        <GlassCard className="mb-4 flex items-center gap-3 border-primary/20">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          <span className="text-sm text-muted-foreground">正在连接短线复盘服务...</span>
        </GlassCard>
      )}

      {!loading && online === false && (
        <GlassCard glow className="mb-4 border-amber-500/30 bg-amber-500/[0.04]">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
            <div className="flex-1">
              <h3 className="font-semibold text-sm text-amber-500">短线复盘服务未启动</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Vibe-Astock 后端服务（端口 8910）尚未运行。请在终端执行以下命令启动：
              </p>
              <div className="mt-2 rounded-lg bg-black/40 px-3 py-2 font-mono text-xs text-primary/80">
                cd vibe-astock && python server.py
              </div>
              <button
                onClick={checkHealth}
                className="mt-3 flex items-center gap-1.5 rounded-lg bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
              >
                <RefreshCw className="h-3.5 w-3.5" /> 重新检测
              </button>
            </div>
          </div>
        </GlassCard>
      )}

      {/* iframe 嵌入 Vibe-Astock */}
      {online !== false && (
        <GlassCard className="overflow-hidden p-0" glow>
          <div className="relative" style={{ height: "calc(100vh - 180px)" }}>
            {(loading || online === null) && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80">
                <div className="flex flex-col items-center gap-2">
                  <Bot className="h-8 w-8 animate-pulse text-primary" />
                  <span className="text-sm text-muted-foreground">复盘看板加载中...</span>
                </div>
              </div>
            )}
            <iframe
              src={VIBE_ASTOCK_URL}
              className="h-full w-full border-0"
              title="Vibe-Astock 短线复盘"
              onLoad={() => setLoading(false)}
            />
          </div>
        </GlassCard>
      )}
    </div>
  );
}
