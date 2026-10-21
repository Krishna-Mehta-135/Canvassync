const ROOM = [
  {
    n: "01",
    title: "Draw together",
    body: "Live cursors, voice, a room chat, and notes you can pin to any shape. Everyone sees the same board, and the history lets you step back to any earlier version.",
  },
  {
    n: "02",
    title: "Ask your documents",
    body: "Add PDFs, Word, Excel, PowerPoint or plain text. Questions are answered from your files, with the passage they came from shown next to the answer.",
  },
  {
    n: "03",
    title: "Diagrams that line up",
    body: "The assistant decides what is in the diagram; the app decides where it goes. Boxes don't overlap and arrows stay attached when you drag things around.",
  },
];

const DETAILS = [
  ["Present", "Turn a region of the board into slides and walk people through it."],
  ["Templates", "Kanban, retro and sticky-note starts when a blank page is too blank."],
  ["Mermaid", "Paste Mermaid to get shapes, or copy your shapes out as Mermaid."],
  ["Image to shapes", "Photograph a whiteboard and get editable shapes back."],
  ["Share with a link", "Invite editors, or give a read-only view to anyone."],
  ["Export", "PNG, SVG, PDF or JSON, whole board or just the selection."],
];

export function PrinciplesSection() {
  return (
    <>
      <section id="room" className="border-t border-rule px-5 py-24 sm:px-8">
        <div className="mx-auto max-w-6xl">
          <h2 className="max-w-2xl font-display text-[clamp(2rem,5vw,3.4rem)] leading-[1] tracking-tight text-ink">
            What&apos;s in the room
          </h2>
          <div className="mt-14 grid gap-10 md:grid-cols-3 md:gap-0">
            {ROOM.map((item, i) => (
              <div
                key={item.n}
                className={`md:px-8 ${i === 0 ? "md:pl-0" : "md:border-l md:border-rule"} ${i === 2 ? "md:pr-0" : ""}`}
              >
                <p className="font-mono text-[11px] text-signal">{item.n}</p>
                <h3 className="mt-3 font-display text-[28px] leading-tight text-ink">{item.title}</h3>
                <p className="mt-3 text-[15px] leading-[1.6] text-ink-2">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="assistant" className="border-t border-rule bg-paper-2 px-5 py-24 sm:px-8">
        <div className="mx-auto grid max-w-6xl gap-12 md:grid-cols-[1.1fr_1fr] md:gap-20">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-3">The assistant</p>
            <h2 className="mt-4 font-display text-[clamp(2rem,5vw,3.4rem)] leading-[1] tracking-tight text-ink">
              One box. It works out whether you want an answer or a drawing.
            </h2>
          </div>
          <ul className="space-y-6 text-[15px] leading-[1.6] text-ink-2">
            <li>
              <b className="font-semibold text-ink">Ask a question</b> and you get text back, quoting
              the file it used. <i className="font-display text-[17px] italic">&ldquo;Who approves large refunds?&rdquo;</i>
            </li>
            <li>
              <b className="font-semibold text-ink">Describe something</b> and it draws it, using
              the names and numbers from your files rather than generic boxes.
            </li>
            <li>
              <b className="font-semibold text-ink">Press Cmd or Ctrl + K</b> from anywhere on the
              board to switch tools, change the view, or hand it a sentence.
            </li>
            <li>
              <b className="font-semibold text-ink">Your conversation is yours.</b> It is kept
              per person, per canvas, and teammates don&apos;t see it.
            </li>
          </ul>
        </div>
      </section>

      <section id="details" className="border-t border-rule px-5 py-24 sm:px-8">
        <div className="mx-auto max-w-6xl">
          <h2 className="font-display text-[clamp(2rem,5vw,3.4rem)] leading-[1] tracking-tight text-ink">
            Everything else
          </h2>
          <dl className="mt-12 grid border-t border-rule sm:grid-cols-2">
            {DETAILS.map(([term, text], i) => (
              <div
                key={term}
                className={`flex gap-6 border-b border-rule py-5 ${i % 2 === 0 ? "sm:pr-10" : "sm:border-l sm:pl-10"}`}
              >
                <dt className="w-32 shrink-0 text-[15px] font-semibold text-ink">{term}</dt>
                <dd className="text-[15px] leading-[1.55] text-ink-2">{text}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>
    </>
  );
}
