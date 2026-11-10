// The Claude desktop app (Code tab) on Windows, dark mode, copied from the app:
// colours, sizes and spacing measured from a screenshot of the desktop app and
// from the same UI's live styles, laid out in CSS px at 1280x720 and drawn at
// the app's 150% display scale (1920x1080). Text is Segoe UI and code Cascadia
// Mono, which is what the desktop app renders on Windows. Icons are lucide
// stand-ins for the app's own icon font. Session names and the account are
// made up for the film.
import React from "react";
import { useCurrentFrame } from "remotion";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  CornerDownLeft,
  Diff,
  Ellipsis,
  Folder,
  Globe,
  List,
  Menu,
  MessageCircle,
  Mic,
  Minus,
  PanelLeft,
  Plus,
  Search,
  Settings,
  Terminal,
  X,
  Code,
} from "lucide-react";
import { CURSOR_H, CursorState, MacCursor } from "./cursor";

const D = {
  main: "#191919",
  side: "#1f1f1f",
  sideLine: "#303030",
  topLine: "#353535",
  pill: "#2a2a2a",
  active: "#404040",
  input: "#303030",
  inputEdge: "#404040",
  bubble: "rgba(255,255,255,0.05)",
  code: "#2a2a2a",
  text: "rgba(255,255,255,0.93)",
  muted: "rgba(255,255,255,0.57)",
  placeholder: "#878787",
  head: "#959595",
  avatar: "#363636",
  ring: "#5858e2",
};
const SANS = '"Segoe UI", system-ui, sans-serif';
export const CODE_FONT = '"Cascadia Mono", Consolas, ui-monospace, monospace';
const I = { strokeWidth: 1.6 };
const HAIR = 1 / 1.5; // one device pixel at 150%

export type Line =
  | { kind: "user"; text: string }
  | { kind: "say"; text: React.ReactNode }
  /** A tool call as the transcript shows it: one grey summary line. */
  | { kind: "tool"; text: string; state: "run" | "ok" | "fail" };

const At: React.FC<{ x: number; y: number; children: React.ReactNode }> = ({ x, y, children }) => (
  <div style={{ position: "absolute", left: x, top: y, transform: "translate(-50%, -50%)", display: "grid", placeItems: "center" }}>{children}</div>
);

const TitleBar: React.FC<{ title: string }> = ({ title }) => (
  <>
    <At x={25.3} y={18.7}>
      <Menu size={16} {...I} color={D.text} />
    </At>
    <At x={58} y={18.7}>
      <PanelLeft size={16} {...I} color={D.text} />
    </At>
    <At x={90} y={18.7}>
      <ChevronLeft size={16} {...I} color={D.text} />
    </At>
    <At x={119.3} y={18.7}>
      <ChevronRight size={16} {...I} color={D.muted} />
    </At>
    <div style={{ position: "absolute", left: 139, top: 5.3, width: 69, height: 26.7, borderRadius: 8, background: D.pill }} />
    <div style={{ position: "absolute", left: 173, top: 6, width: 34, height: 25, borderRadius: 6, background: D.active }} />
    <At x={155.3} y={18.7}>
      <span style={{ position: "relative", display: "grid" }}>
        <MessageCircle size={15} {...I} color={D.text} />
        <Search size={8} strokeWidth={2.4} color={D.text} style={{ position: "absolute", right: -3, bottom: -2, background: D.pill, borderRadius: 4 }} />
      </span>
    </At>
    <At x={190} y={18.7}>
      <Code size={16} {...I} color={D.text} />
    </At>
    <div style={{ position: "absolute", left: 240, top: 8.7, height: 20, display: "flex", alignItems: "center", gap: 6, fontSize: 14, lineHeight: "20px", color: D.text }}>
      {title} <ChevronDown size={14} {...I} />
    </div>
    {(
      [
        [958.7, List],
        [993.3, Terminal],
        [1023.3, Diff],
        [1053.3, Globe],
        [1084, Folder],
        [1114, Ellipsis],
        [1165.3, Minus],
        [1211.3, Copy],
        [1257.3, X],
      ] as [number, React.ElementType][]
    ).map(([x, C]) => (
      <At key={x} x={x} y={18.7}>
        <C size={x === 1211.3 ? 13 : 16} {...I} color={D.text} />
      </At>
    ))}
    <div style={{ position: "absolute", left: 215.3, top: 36, right: 0, height: HAIR, background: D.topLine }} />
  </>
);

const GROUPS: [string, string[]][] = [
  ["shop", ["Clean up test accounts", "Orders dashboard", "Checkout bug"]],
  ["docs", ["Release notes", "API reference"]],
];

const Side: React.FC = () => {
  const rows: React.ReactNode[] = [];
  let y = 62;
  GROUPS.forEach(([g, items], gi) => {
    rows.push(
      <div key={g} style={{ position: "absolute", left: 18, top: y - 10, height: 20, display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: D.head }}>
        {g} <ChevronDown size={12} strokeWidth={2} />
      </div>,
    );
    y += 34;
    items.forEach((s, i) => {
      const on = gi === 0 && i === 0;
      rows.push(
        <div key={s} style={{ position: "absolute", left: 9.3, top: y - 16.5, width: 195, height: 33, borderRadius: 8, background: on ? D.active : undefined, display: "flex", alignItems: "center", paddingLeft: 8.7, boxSizing: "border-box", fontSize: 14, color: D.text, whiteSpace: "nowrap" }}>
          {s}
        </div>,
      );
      y += 34;
    });
    y += 18;
  });
  return (
    <div style={{ position: "absolute", left: 0, top: 0, width: 215.3, height: 720, background: D.side, borderRight: `${HAIR}px solid ${D.sideLine}`, boxSizing: "border-box" }}>
      {rows}
      <At x={25.3} y={697.7}>
        <span style={{ width: 18.7, height: 18.7, borderRadius: 10, background: D.avatar, display: "grid", placeItems: "center", fontSize: 10, color: D.text }}>S</span>
      </At>
      <div style={{ position: "absolute", left: 44, top: 687.7, height: 20, display: "flex", alignItems: "center", gap: 4, fontSize: 14.5, color: D.text }}>
        Sam <span style={{ fontSize: 12, color: D.head }}>· Pro</span>
        <ChevronDown size={12} strokeWidth={2} color={D.head} style={{ marginLeft: 2 }} />
      </div>
      <At x={191.3} y={697.7}>
        <Settings size={16} {...I} color={D.text} />
      </At>
    </div>
  );
};

/** In-progress text: the summary with a light sweeping across it. */
const Shimmer: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const t = useCurrentFrame() / 60;
  const pos = ((t * 0.9) % 1.6) * 100 - 30;
  return (
    <span
      style={{
        color: "transparent",
        backgroundImage: `linear-gradient(90deg, ${D.muted} ${pos - 20}%, rgba(255,255,255,0.9) ${pos}%, ${D.muted} ${pos + 20}%)`,
        WebkitBackgroundClip: "text",
        backgroundClip: "text",
      }}
    >
      {children}
    </span>
  );
};

const Transcript: React.FC<{ lines: Line[]; bottom: number }> = ({ lines, bottom }) => (
  <div style={{ position: "absolute", left: 380, width: 716, top: 60, height: bottom - 60, display: "flex", flexDirection: "column", justifyContent: "flex-start", gap: 20, overflow: "hidden" }}>
    {lines.map((l, i) =>
      l.kind === "user" ? (
        <div key={i} style={{ alignSelf: "flex-end", maxWidth: 560, background: D.bubble, borderRadius: 12, padding: "12px 16px", fontSize: 15, lineHeight: "21px", color: D.text }}>
          {l.text}
        </div>
      ) : l.kind === "say" ? (
        <div key={i} style={{ padding: "0 56px 0 4px", fontSize: 15, lineHeight: "21px", color: D.text }}>
          {l.text}
        </div>
      ) : (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 4, padding: "3.5px 0 3.5px 4px", fontSize: 15, lineHeight: "21px", color: D.muted, margin: "-4px 0" }}>
          {l.state === "run" ? <Shimmer>{l.text}</Shimmer> : <span>{l.state === "fail" ? `${l.text}, 1 failed` : l.text}</span>}
          <ChevronRight size={12} strokeWidth={2} color={D.muted} />
        </div>
      ),
    )}
  </div>
);

/** Inline code as the transcript draws it. */
export const InlineCode: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span style={{ fontFamily: CODE_FONT, fontWeight: 700, fontSize: 13, background: D.code, borderRadius: 4, padding: "1px 4px" }}>{children}</span>
);

const InputBox: React.FC<{ input: string; caret: boolean; running: boolean; press: number }> = ({ input, caret, running, press }) => {
  const h = 44;
  const top = 720 - 40 - h;
  const caretEl = <span style={{ display: "inline-block", width: 1, height: 18, background: D.text, verticalAlign: -4 }} />;
  return (
    <>
      <div style={{ position: "absolute", left: 364.7, top, width: 766.7, height: h, borderRadius: 14, background: D.input, boxShadow: `inset 0 0 0 ${HAIR}px ${D.inputEdge}` }}>
        <At x={22} y={22}>
          <Plus size={16} {...I} color={D.text} />
        </At>
        <div style={{ position: "absolute", left: 44, top: 11.5, right: 80, height: 21, fontSize: 15, lineHeight: "21px", whiteSpace: "nowrap", overflow: "hidden", color: input ? D.text : D.placeholder }}>
          {input ? (
            <>
              {input}
              {caret ? caretEl : null}
            </>
          ) : (
            <>
              {caret ? <span style={{ marginRight: -1 }}>{caretEl}</span> : null}
              {running ? "Enter to send, Ctrl+Enter to queue for later" : "Type / for commands"}
            </>
          )}
        </div>
        {input ? (
          <At x={766.7 - 58} y={22}>
            <span style={{ transform: `scale(${1 - press * 0.12})`, display: "grid" }}>
              <CornerDownLeft size={16} {...I} color={D.text} />
            </span>
          </At>
        ) : running ? (
          <At x={766.7 - 58} y={22}>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: D.text }} />
          </At>
        ) : null}
        <At x={766.7 - 22} y={22}>
          <Mic size={16} {...I} color={D.text} />
        </At>
      </div>
      <div style={{ position: "absolute", right: 1280 - 1131.3, top: 690, height: 20, display: "flex", alignItems: "center", gap: 0, fontSize: 13, lineHeight: "20px", color: D.text, whiteSpace: "pre" }}>
        <span>Opus 5.5</span>
        <span style={{ color: D.muted, marginLeft: 4 }}>Extra</span>
        <span style={{ marginLeft: 22 }}>Auto</span>
        <span style={{ marginLeft: 18, marginRight: 15, width: 10, height: 10, borderRadius: 6, boxShadow: `inset 0 0 0 1.4px ${D.ring}` }} />
      </div>
    </>
  );
};

/** Camera on the window: the point (CSS px) at the centre of the frame, and zoom. */
export type DeskCam = { x: number; y: number; s: number };

/** The whole window at 1920x1080: the app at 1280x720 CSS px, drawn at 150%. */
export const ClaudeDesktop: React.FC<{
  lines: Line[];
  input: string;
  caret: boolean;
  /** Claude is working: the input shows the queue hint and a stop button. */
  running?: boolean;
  press?: number;
  title?: string;
  /** The system cursor, in the window's CSS pixels. */
  cursor?: CursorState | null;
  /** Camera on the window: the point (CSS px) at the centre of the frame, and zoom over the full-window view. */
  cam?: DeskCam;
}> = ({ lines, input, caret, running = false, press = 0, title = "Clean up test accounts", cursor, cam = DESKTOP_FULL }) => {
  const k = 1.5 * cam.s;
  return (
    <div style={{ position: "absolute", left: 0, top: 0, width: 1920, height: 1080, overflow: "hidden", background: D.main }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: 1280,
          height: 720,
          transform: `translate(${960 - cam.x * k}px, ${540 - cam.y * k}px) scale(${k})`,
          transformOrigin: "0 0",
          background: D.main,
          fontFamily: SANS,
          color: D.text,
          WebkitFontSmoothing: "antialiased",
        }}
      >
        <Side />
        <TitleBar title={title} />
        <Transcript lines={lines} bottom={720 - 40 - 44 - 16} />
        <InputBox input={input} caret={caret} running={running} press={press} />
        {cursor ? <MacCursor c={cursor} h={CURSOR_H.desktop} /> : null}
      </div>
    </div>
  );
};

/** The whole window in frame. */
export const DESKTOP_FULL: DeskCam = { x: 640, y: 360, s: 1 };
/** Close on a short conversation: the chat column centred with even margins, the window's top edge on the frame's. */
export const DESKTOP_READ: DeskCam = { x: 740, y: 225, s: 1.6 };
/** Where things are in the window, CSS px. */
export const DESKTOP = {
  send: { x: 1073, y: 658, w: 28, h: 28 },
  input: { x: 748, y: 658 },
};
