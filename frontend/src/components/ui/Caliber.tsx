import { useEffect, useId, useState } from "react";
import { HelpCircle } from "lucide-react";

/** 数据口径提示气泡：点「口径」按钮弹出说明文字，点空白/Esc 关闭。 */
export function Caliber({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title="这个数怎么算的"
        className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
      >
        <HelpCircle className="h-3 w-3" />
        口径
      </button>
      {open && (
        <>
          <span className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <span
            id={panelId}
            role="note"
            aria-label="口径说明"
            className="absolute left-0 top-full z-50 mt-1 block w-[min(30rem,80vw)] whitespace-pre-line rounded-lg border border-border bg-background p-3 text-[11px] leading-relaxed text-foreground shadow-xl ring-1 ring-black/5"
          >
            {text}
          </span>
        </>
      )}
    </span>
  );
}
