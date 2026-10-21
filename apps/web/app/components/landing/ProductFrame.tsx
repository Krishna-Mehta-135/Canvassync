/*
 * A static, faithful rendition of the product (canvas + assistant + room chat),
 * built from the same tokens as the real UI, so the landing page shows what you
 * actually get rather than an illustration of something else.
 */

const TONES = {
  blue: { fill: "#3B82F6", stroke: "#1E40AF", text: "#fff" },
  amber: { fill: "#F59E0B", stroke: "#B45309", text: "#2b1d03" },
  green: { fill: "#10B981", stroke: "#047857", text: "#fff" },
  red: { fill: "#EF4444", stroke: "#991B1B", text: "#fff" },
} as const;

type Tone = keyof typeof TONES;

function Node({ x, y, w, h, label, tone, kind = "rect" }: { x: number; y: number; w: number; h: number; label: string; tone: Tone; kind?: "rect" | "rhombus" | "circle" }) {
  const t = TONES[tone];
  return (
    <g>
      {kind === "rect" && <rect x={x} y={y} width={w} height={h} rx={10} fill={t.fill} stroke={t.stroke} strokeWidth={2} />}
      {kind === "rhombus" && (
        <polygon points={`${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`} fill={t.fill} stroke={t.stroke} strokeWidth={2} />
      )}
      {kind === "circle" && <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} fill={t.fill} stroke={t.stroke} strokeWidth={2} />}
      <text x={x + w / 2} y={y + h / 2 + 5} textAnchor="middle" fontSize={15} fill={t.text} style={{ fontFamily: "var(--font-ui)" }}>
        {label}
      </text>
    </g>
  );
}

function Arrow({ d, label, lx, ly }: { d: string; label?: string; lx?: number; ly?: number }) {
  return (
    <g>
      <path d={d} fill="none" stroke="#7d8799" strokeWidth={2} markerEnd="url(#head)" />
      {label && (
        <text x={lx} y={ly} fontSize={13} fill="var(--ink-3)" style={{ fontFamily: "var(--font-ui)" }}>
          {label}
        </text>
      )}
    </g>
  );
}

export function ProductFrame() {
  return (
    <figure
      className="relative overflow-hidden rounded-[12px] border border-rule-strong bg-paper shadow-[0_1px_0_var(--rule),0_40px_70px_-40px_rgba(0,0,0,0.5)]"
      aria-label="Screenshot-style preview of the canvas, assistant and room chat"
    >
      <div className="flex items-center justify-between border-b border-rule bg-surface px-4 py-2.5">
        <div className="flex items-baseline gap-3">
          <span className="font-display text-[19px] leading-none text-ink">launch/checkout</span>
          <span className="font-mono text-[10.5px] text-ink-3">3 here</span>
        </div>
        <span className="rounded-[5px] bg-ink px-2.5 py-1 text-[11px] font-medium text-paper">Share</span>
      </div>

      <div
        className="relative h-[420px] sm:h-[500px]"
        style={{
          backgroundImage: "radial-gradient(var(--rule-strong) 1.1px, transparent 1.2px)",
          backgroundSize: "24px 24px",
        }}
      >
        <svg viewBox="0 0 760 420" className="absolute left-0 top-6 hidden h-auto w-[62%] sm:block" role="img" aria-label="Checkout flow diagram">
          <defs>
            <marker id="head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M1 1 L9 5 L1 9" fill="none" stroke="#7d8799" strokeWidth="1.6" />
            </marker>
          </defs>
          <text x="40" y="52" fontSize="26" fill="var(--ink)" style={{ fontFamily: "var(--font-display)" }}>
            Checkout, as the spec describes it
          </text>
          <Node x={40} y={150} w={140} h={60} label="Cart Service" tone="blue" />
          <Node x={250} y={150} w={160} h={60} label="Payments Gateway" tone="blue" />
          <Node x={480} y={136} w={170} h={88} label="Risk score > 80?" tone="amber" kind="rhombus" />
          <Node x={500} y={300} w={130} h={60} label="Stripe charge" tone="blue" />
          <Node x={300} y={300} w={140} h={60} label="Risk Team review" tone="red" />
          <Node x={80} y={290} w={100} h={80} label="Ledger" tone="green" kind="circle" />
          <Arrow d="M180 180 L248 180" />
          <Arrow d="M410 180 L478 180" />
          <Arrow d="M565 224 L565 298" label="No" lx={574} ly={266} />
          <Arrow d="M502 214 C 470 250 450 270 442 304" label="Yes" lx={452} ly={246} />
          <Arrow d="M500 330 C 380 400 220 400 182 340" />
        </svg>

        {/* Assistant */}
        <aside className="absolute right-3 top-4 w-[min(21rem,calc(100%-1.5rem))] rounded-[10px] border border-rule-strong bg-surface p-3.5 shadow-[0_1px_0_var(--rule),0_24px_40px_-26px_rgba(0,0,0,0.55)] sm:right-5 sm:top-5">
          <div className="mb-3 flex items-center gap-2">
            <span className="grid h-6 w-6 place-items-center rounded-[6px] bg-ink text-paper">
              <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12.5 4.5l3 3L7 16H4v-3z" />
              </svg>
            </span>
            <span className="font-display text-[19px] leading-none text-ink">Assistant</span>
            <span className="ml-auto rounded-[4px] border border-rule px-1.5 py-px font-mono text-[10px] text-ink-3">payments-spec.pdf</span>
          </div>
          <p className="ml-auto max-w-[85%] rounded-[10px] rounded-br-[3px] bg-ink px-3 py-2 text-[12.5px] leading-snug text-paper">
            When does an order get held for manual review?
          </p>
          <p className="mt-2 max-w-[92%] rounded-[10px] rounded-bl-[3px] bg-paper-2 px-3 py-2 text-[12.5px] leading-[1.5] text-ink ring-1 ring-rule">
            When the Fraud Engine returns a risk score above 80. The Risk Team reviews it before the
            charge is authorized.
          </p>
          <div className="mt-1.5 flex gap-1.5">
            <span className="rounded-[4px] border border-rule-strong bg-paper-2 px-2 py-0.5 font-mono text-[10px] text-ink-2">
              <b className="text-signal">1</b> payments-spec.pdf
            </span>
            <span className="rounded-[5px] border border-rule-strong bg-paper-2 px-2 py-0.5 text-[10.5px] text-ink-2">✎ Draw this</span>
          </div>
        </aside>

        {/* Room chat */}
        <aside className="absolute bottom-4 right-3 hidden w-[19rem] rounded-[8px] border border-rule-strong bg-surface p-3 shadow-[0_1px_0_var(--rule),0_24px_40px_-26px_rgba(0,0,0,0.55)] sm:block sm:right-5">
          <div className="flex gap-2.5">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-[5px] bg-[#4f7a54] font-mono text-[10px] font-semibold text-white">M</span>
            <div className="min-w-0">
              <p className="flex items-baseline gap-2">
                <span className="text-[12px] font-semibold text-ink">Maya</span>
                <span className="font-mono text-[9.5px] text-ink-3">6:38 PM</span>
              </p>
              <p className="text-[12.5px] leading-snug text-ink">Pinned a note on the risk check: who owns the threshold?</p>
            </div>
          </div>
          <p className="mt-2 flex items-center gap-1.5 pl-[34px] font-mono text-[10px] text-ink-3">
            <span className="flex gap-0.5">
              <i className="inline-block h-1 w-1 rounded-full bg-ink-3" />
              <i className="inline-block h-1 w-1 rounded-full bg-ink-3" />
              <i className="inline-block h-1 w-1 rounded-full bg-ink-3" />
            </span>
            Jonas is typing
          </p>
        </aside>
      </div>
    </figure>
  );
}
