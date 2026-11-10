// LiteDB's window, dark theme, laid out pixel for pixel from the app at 1280×800
// (docs/assets/demo.mp4 and src/components). Icons are the app's own lucide icons.
import React from "react";
import { Easing, Img, staticFile, useCurrentFrame } from "remotion";
import { PEEK, speech, STAR_H, STAR_W, StarFrame } from "./rig";
import { CURSOR_H, CursorState, MacCursor } from "./cursor";
import {
  ArrowLeft,
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Database,
  Download,
  Eye,
  Filter,
  GitBranch,
  HardDrive,
  KeyRound,
  Lightbulb,
  ListChecks,
  Loader2,
  Minus,
  Moon,
  PanelRight,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Table2,
  TableOfContents,
  Terminal,
  Undo2,
  Upload,
  User,
  X,
} from "lucide-react";
import { mono, sans, starBlink } from "./kit";
import { StarMascot } from "../launch/art";

export const APP_W = 1280;
export const APP_H = 800;

export const A = {
  chrome: "#0f0f0f",
  main: "#141414",
  raised: "#1b1b1b",
  active: "#1f1f1f",
  line: "#232325",
  input: "#2a2a2c",
  dialog: "#18181b",
  status: "#181719",
  fg: "#ededed",
  muted: "#a0a0a6",
  faint: "#6b6b72",
  key: "#f6ae31",
  warning: "#f08842",
  red: "#e5484d",
  green: "#10b981",
};

const I = { strokeWidth: 1.8 };
const abs = (x: number, y: number, w?: number, h?: number): React.CSSProperties => ({ position: "absolute", left: x, top: y, width: w, height: h });

const OutlineBtn: React.FC<{ x: number; y: number; w: number; h?: number; children: React.ReactNode; hot?: boolean; style?: React.CSSProperties }> = ({ x, y, w, h = 40, children, hot, style }) => (
  <div
    style={{
      ...abs(x, y, w, h),
      border: `1px solid ${A.input}`,
      borderRadius: 8,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 9,
      fontSize: 15,
      fontWeight: 500,
      // hover:bg-accent, as the app's outline buttons do
      background: hot ? "#232325" : undefined,
      ...style,
    }}
  >
    {children}
  </div>
);

const SolidBtn: React.FC<{ x: number; y: number; w: number; h?: number; children: React.ReactNode; hot?: boolean; press?: number }> = ({ x, y, w, h = 40, children, hot, press = 0 }) => (
  <div
    style={{
      ...abs(x, y, w, h),
      // hover:bg-primary/90, as the app's primary buttons do
      background: hot ? "rgba(237,237,237,0.9)" : A.fg,
      color: "#111113",
      borderRadius: 8,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 9,
      fontSize: 15,
      fontWeight: 500,
      transform: `scale(${1 - press * 0.05})`,
    }}
  >
    {children}
  </div>
);

const Check0: React.FC<{ x: number; y: number }> = ({ x, y }) => <div style={{ ...abs(x, y, 15, 15), border: `1.5px solid ${A.muted}`, borderRadius: 3 }} />;

export type GridRow = { id: number; name: string; email: string; created: string; tint?: string; enter?: number };

export type TableState = {
  table: string;
  count: string;
  rows: GridRow[];
  tables?: string[];
};

export type AuditItem = {
  who: string;
  you?: boolean;
  kind: "write" | "read";
  decision: string;
  policy?: string;
  time: string;
  sql: string;
  foot: string;
  footMid?: string;
  right?: "undo" | "undone" | string;
  opacity?: number;
  dy?: number;
  hotUndo?: boolean;
};

export type SqlState = {
  tab?: string;
  code: React.ReactNode;
  results?: { cols: string[]; rows: string[][]; meta: string } | null;
  audit?: AuditItem[] | null;
  hot?: "askai" | "run";
};

const TitleBar: React.FC = () => (
  <div style={{ ...abs(0, 0, APP_W, 36), background: A.chrome, borderBottom: `1px solid ${A.line}` }}>
    <div style={{ ...abs(8, 6, 100, 30), background: A.main, borderRadius: "8px 8px 0 0", display: "flex", alignItems: "center", gap: 7, paddingLeft: 10, fontSize: 13 }}>
      <HardDrive size={12} {...I} color={A.muted} />
      shop.db
    </div>
    <Plus size={15} {...I} color={A.muted} style={abs(117, 11)} />
    <div style={{ ...abs(943, 7, 122, 22), whiteSpace: "nowrap", border: `1px solid ${A.input}`, borderRadius: 7, display: "flex", alignItems: "center", gap: 6, padding: "0 8px", fontSize: 12, color: A.fg }}>
      <Search size={12} {...I} color={A.muted} /> Search <span style={{ color: A.faint, marginLeft: 2 }}>Ctrl P</span>
    </div>
    <Moon size={15} {...I} color={A.muted} style={abs(1079, 10)} />
    <SlidersHorizontal size={15} {...I} color={A.muted} style={abs(1119, 10)} />
    <Minus size={15} {...I} color={A.muted} style={abs(1162, 10)} />
    <Copy size={13} {...I} color={A.muted} style={abs(1207, 11)} />
    <X size={15} {...I} color={A.muted} style={abs(1251, 10)} />
  </div>
);

const NAV: [string, React.ReactNode][] = [
  ["Table Editor", <Table2 key="t" size={16} {...I} />],
  ["Schema Visualizer", <GitBranch key="g" size={16} {...I} />],
  ["SQL Editor", <Terminal key="s" size={16} {...I} />],
];

const Sidebar: React.FC<{ active: number }> = ({ active }) => (
  <div style={{ ...abs(0, 36, 240, APP_H - 36), background: A.chrome, borderRight: `1px solid ${A.line}` }}>
    <div style={{ ...abs(16, 12), display: "flex", alignItems: "center", gap: 9 }}>
      <Img src={staticFile("titlebaricon2.png")} style={{ width: 24, height: 24, borderRadius: 6 }} />
      <span style={{ fontSize: 15, fontWeight: 600 }}>LiteDB</span>
    </div>
    <div style={{ ...abs(20, 62), display: "flex", alignItems: "center", gap: 12, fontSize: 15, color: A.muted }}>
      <ArrowLeft size={16} {...I} /> Back
    </div>
    <div style={{ ...abs(16, 94, 208, 1), background: A.line }} />
    {NAV.map(([label, icon], i) => (
      <div
        key={label}
        style={{
          ...abs(8, 97 + i * 38, 222, 36),
          borderRadius: 8,
          background: i === active ? A.active : undefined,
          display: "flex",
          alignItems: "center",
          gap: 12,
          paddingLeft: 12,
          fontSize: 15,
          fontWeight: i === active ? 600 : 500,
          color: i === active ? A.fg : A.muted,
        }}
      >
        {icon}
        {label}
      </div>
    ))}
    <div style={{ ...abs(20, 728), fontSize: 13, color: A.muted }}>Collapse</div>
    <ChevronLeft size={15} {...I} color={A.muted} style={abs(203, 730)} />
  </div>
);

const StatusBar: React.FC = () => (
  <div style={{ ...abs(240, 776, APP_W - 240, 24), background: A.status, borderTop: `1px solid ${A.line}`, display: "flex", alignItems: "center", fontSize: 13, color: A.muted, padding: "0 13px", gap: 20 }}>
    <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
      <span style={{ width: 7, height: 7, borderRadius: 4, background: A.green }} /> Connected
    </span>
    <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
      <HardDrive size={12} {...I} /> <span style={{ color: A.fg }}>shop.db</span> SQLite 3.53.4
    </span>
    <span>6 tables</span>
    <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
      <ShieldCheck size={13} {...I} /> Guarded
    </span>
    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <Plug size={13} {...I} /> MCP
    </span>
  </div>
);

const Header: React.FC<{ title: string }> = ({ title }) => (
  <div style={{ ...abs(240, 36, APP_W - 240, 48), borderBottom: `1px solid ${A.line}` }}>
    <div style={{ ...abs(16, 14), fontSize: 15, fontWeight: 600 }}>{title}</div>
    <RefreshCw size={16} {...I} color={A.muted} style={abs(779, 16)} />
    <OutlineBtn x={816} y={4} w={100}>
      <Upload size={16} {...I} /> Import
    </OutlineBtn>
    <OutlineBtn x={924} y={4} w={100}>
      <Download size={16} {...I} /> Export
    </OutlineBtn>
  </div>
);

const TablesPanel: React.FC<{ tables: string[]; active: string }> = ({ tables, active }) => (
  <div style={{ ...abs(240, 84, 240, 692), background: A.main, borderRight: `1px solid ${A.line}` }}>
    <div style={{ ...abs(15, 18), fontSize: 13, color: A.muted }}>Tables</div>
    <ChevronLeft size={15} {...I} color={A.muted} style={abs(206, 18)} />
    <div style={{ ...abs(0, 52, 240, 1), background: A.line }} />
    <div style={{ ...abs(15, 66), display: "flex", alignItems: "center", gap: 7, fontSize: 13, color: A.muted }}>
      <Table2 size={13} {...I} /> {tables.length} tables
    </div>
    <div style={{ ...abs(12, 106, 214, 36), border: `1px solid ${A.input}`, borderRadius: 8, display: "flex", alignItems: "center", gap: 9, paddingLeft: 12, fontSize: 15, color: A.muted }}>
      <Search size={15} {...I} /> Search tables
    </div>
    <div style={{ ...abs(0, 155, 240, 1), background: A.line }} />
    {tables.map((t, i) => (
      <div
        key={t}
        style={{
          ...abs(8, 163 + i * 36, 222, 36),
          borderRadius: 8,
          background: t === active ? A.active : undefined,
          display: "flex",
          alignItems: "center",
          gap: 11,
          paddingLeft: 12,
          fontSize: 15,
          fontWeight: 500,
        }}
      >
        {t.startsWith("big_") ? <Eye size={15} {...I} color={A.muted} /> : <TableOfContents size={15} {...I} color={A.muted} />}
        {t}
        {t === active ? <ChevronRight size={15} {...I} color={A.muted} style={{ marginLeft: "auto", marginRight: 12 }} /> : null}
      </div>
    ))}
  </div>
);

const COLS = [
  { key: "id", x: 528, w: 57 },
  { key: "name", x: 593, w: 109 },
  { key: "email", x: 702, w: 238 },
  { key: "created_at", x: 948, w: 124 },
];

const Grid: React.FC<{ state: TableState }> = ({ state }) => (
  <div style={{ ...abs(480, 84, 800, 692), background: A.main }}>
    <div style={{ ...abs(16, 14), display: "flex", alignItems: "center", gap: 10 }}>
      <Database size={16} {...I} color={A.muted} />
      <span style={{ fontSize: 15, fontWeight: 600 }}>{state.table}</span>
      <span style={{ fontFamily: mono, fontSize: 12, color: A.muted }}>{state.count} rows</span>
    </div>
    <div style={{ ...abs(300, 8, 223, 32), border: `1px solid ${A.input}`, borderRadius: 8, display: "flex", alignItems: "center", gap: 9, paddingLeft: 11, fontSize: 15, color: A.muted }}>
      <Search size={15} {...I} /> Search rows
    </div>
    <OutlineBtn x={533} y={8} w={83} h={32}>
      <Filter size={14} {...I} /> <span style={{ fontSize: 13 }}>Filter</span>
    </OutlineBtn>
    <OutlineBtn x={625} y={8} w={40} h={32}>
      <Upload size={14} {...I} />
    </OutlineBtn>
    <SolidBtn x={674} y={8} w={110} h={32}>
      <Plus size={15} {...I} /> <span style={{ fontSize: 13 }}>Insert row</span>
    </SolidBtn>
    <div style={{ ...abs(0, 48, 800, 36), borderTop: `1px solid ${A.line}`, borderBottom: `1px solid ${A.line}` }}>
      <Check0 x={13} y={10} />
      {COLS.map((c) => (
        <div key={c.key} style={{ ...abs(c.x - 480, 0, c.w, 36), display: "flex", alignItems: "center", gap: 4, fontSize: 13, color: A.muted, borderLeft: `1px solid ${A.line}`, paddingLeft: 8 }}>
          {c.key}
          {c.key === "id" ? <KeyRound size={12} {...I} color={A.key} /> : null}
        </div>
      ))}
    </div>
    {state.rows.map((r, i) => {
      const enter = r.enter ?? 1;
      return (
        <div
          key={r.id}
          style={{
            ...abs(0, 84 + i * 32, 800, 32),
            borderBottom: `1px solid ${A.line}`,
            background: r.tint,
            opacity: enter,
            transform: `translateX(${(1 - enter) * 60}px)`,
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          <Check0 x={13} y={8} />
          <div style={{ ...abs(COLS[0].x - 480, 8, COLS[0].w - 8), textAlign: "right", paddingRight: 0 }}>{r.id}</div>
          <div style={{ ...abs(COLS[1].x - 472, 8) }}>{r.name}</div>
          <div style={{ ...abs(COLS[2].x - 472, 8) }}>{r.email}</div>
          <div style={{ ...abs(COLS[3].x - 472, 8), fontFamily: mono, fontSize: 12.5 }}>{r.created}</div>
        </div>
      );
    })}
    <div style={{ ...abs(0, 656, 800, 36), borderTop: `1px solid ${A.line}`, display: "flex", alignItems: "center", gap: 14, padding: "0 16px", fontSize: 13, color: A.muted }}>
      <span style={{ color: A.fg }}>1–100 of {state.count}</span>
      Double-click a cell to edit · Enter saves · Esc cancels
      <span style={{ marginLeft: "auto", border: `1px solid ${A.input}`, borderRadius: 8, padding: "5px 12px", color: A.fg }}>100 per page</span>
      <span>Page 1 of 483</span>
    </div>
  </div>
);

const SqlView: React.FC<{ s: SqlState }> = ({ s }) => {
  const side = !!s.audit;
  const edW = side ? 700 : 1040;
  return (
    <div style={{ ...abs(240, 84, 1040, 692), background: A.main }}>
      <div style={{ ...abs(8, 4, 76, 30), background: A.raised, borderRadius: 8, display: "flex", alignItems: "center", gap: 7, paddingLeft: 10, fontSize: 13, fontWeight: 500 }}>
        {s.tab ?? "Query 1"} <X size={12} {...I} color={A.muted} />
      </div>
      <Plus size={15} {...I} color={A.muted} style={abs(94, 12)} />
      <div style={{ ...abs(388, 4), display: "flex", alignItems: "center", gap: 18, fontSize: 13, fontWeight: 500 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6, background: s.hot === "run" ? "#232325" : A.raised, color: A.fg, padding: "6px 12px", borderRadius: 7 }}>
          <Play size={13} {...I} /> Run
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <ListChecks size={14} {...I} /> Run all
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 6, background: s.hot === "askai" ? "#232325" : undefined, borderRadius: 7, padding: "4px 6px" }}>
          <Sparkles size={14} {...I} color={A.key} /> Ask AI
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Lightbulb size={14} {...I} /> Explain
        </span>
        <span style={{ border: `1px solid ${A.input}`, borderRadius: 8, padding: "6px 12px" }}>1,000 rows ⌄</span>
        <span style={{ display: "flex", alignItems: "center", gap: 8, color: A.muted }}>
          <span style={{ width: 32, height: 18, borderRadius: 9, background: A.fg, position: "relative" }}>
            <span style={{ position: "absolute", right: 2, top: 2, width: 14, height: 14, borderRadius: 7, background: "#111" }} />
          </span>
          Transaction
        </span>
        <Save size={15} {...I} color={A.faint} />
        <PanelRight size={15} {...I} color={A.muted} />
      </div>
      <div style={{ ...abs(0, 40, edW, 328), borderTop: `1px solid ${A.line}`, fontFamily: mono, fontSize: 13, lineHeight: "20px" }}>
        <div style={{ ...abs(17, 12), color: A.faint, textAlign: "right", width: 12 }}>
          {[1, 2, 3, 4, 5, 6, 7].map((n) => (
            <div key={n}>{n}</div>
          ))}
        </div>
        <pre style={{ ...abs(56, 12), margin: 0, whiteSpace: "pre", color: A.fg }}>{s.code}</pre>
      </div>
      <div style={{ ...abs(0, 368, edW, 324), borderTop: `1px solid ${A.line}` }}>
        {s.results ? (
          <div style={{ fontSize: 13 }}>
            <div style={{ display: "flex", gap: 14, padding: "10px 16px", color: A.muted }}>
              <Check size={14} {...I} color={A.green} /> {s.results.meta}
            </div>
            <div style={{ display: "flex", borderTop: `1px solid ${A.line}`, borderBottom: `1px solid ${A.line}`, color: A.muted }}>
              {s.results.cols.map((c) => (
                <div key={c} style={{ width: 240, padding: "9px 16px", borderRight: `1px solid ${A.line}` }}>
                  {c}
                </div>
              ))}
            </div>
            {s.results.rows.map((r, i) => (
              <div key={i} style={{ display: "flex", borderBottom: `1px solid ${A.line}`, fontWeight: 500 }}>
                {r.map((v, j) => (
                  <div key={j} style={{ width: 240, padding: "8px 16px", fontFamily: j ? mono : sans, fontSize: j ? 12.5 : 13 }}>
                    {v}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ ...abs(0, 150, edW), textAlign: "center", fontSize: 13, color: A.muted }}>Results appear here. Run the statement under the cursor, or the whole script.</div>
        )}
      </div>
      {side ? (
        <div style={{ ...abs(700, 40, 340, 652), borderLeft: `1px solid ${A.line}`, borderTop: `1px solid ${A.line}` }}>
          <div style={{ ...abs(9, 8, 182, 30), background: A.raised, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "space-around", fontSize: 13, color: A.muted }}>
            <span>History</span>
            <span>Saved</span>
            <span style={{ background: A.input, color: A.fg, padding: "3px 9px", borderRadius: 6 }}>Audit</span>
          </div>
          <X size={15} {...I} color={A.muted} style={abs(312, 15)} />
          <div style={{ ...abs(11, 50), fontSize: 14, fontWeight: 500 }}>Statement audit</div>
          <RefreshCw size={14} {...I} color={A.muted} style={abs(305, 51)} />
          <div style={{ ...abs(11, 74, 312), fontSize: 12, lineHeight: "19px", color: A.muted }}>Every generated statement, and every change you made by hand. Kept on this machine, never sent anywhere.</div>
          <div style={{ ...abs(11, 136, 312), fontFamily: mono, fontSize: 11, color: A.faint, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{"<app data>/audit/sql-audit.jsonl"}</div>
          <div style={{ ...abs(9, 162, 316), display: "grid", gap: 8 }}>
            {(s.audit ?? []).map((e, i) => (
              <AuditCard key={i} e={e} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
};

export const AuditCard: React.FC<{ e: AuditItem }> = ({ e }) => (
  <div
    style={{
      border: `1px solid ${A.line}`,
      borderRadius: 6,
      padding: 10,
      display: "grid",
      gap: 8,
      fontSize: 11,
      color: A.muted,
      opacity: e.opacity ?? 1,
      transform: `translateY(${e.dy ?? 0}px)`,
      background: A.main,
      whiteSpace: "nowrap",
    }}
  >
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ display: "flex", alignItems: "center", gap: 4, background: "#232325", borderRadius: 6, padding: "2px 8px", color: A.fg }}>
        {e.you ? <User size={12} {...I} /> : <Bot size={12} {...I} />} {e.who}
      </span>
      <span style={{ fontFamily: mono, borderRadius: 6, padding: "2px 8px", background: e.kind === "write" ? "rgba(240,136,66,0.15)" : "#232325", color: e.kind === "write" ? A.warning : A.muted }}>{e.kind}</span>
      <span style={{ marginLeft: "auto", fontVariantNumeric: "tabular-nums" }}>{e.time}</span>
    </div>
    <div>
      {e.decision}
      {e.policy ? <span style={{ color: A.faint }}> · {e.policy}</span> : null}
    </div>
    <div style={{ background: "rgba(35,35,37,0.5)", borderRadius: 4, padding: "6px 8px", fontFamily: mono, fontSize: 11, color: A.fg, lineHeight: "18px", whiteSpace: "pre-wrap" }}>{e.sql}</div>
    <div style={{ display: "flex", alignItems: "center", gap: 8, height: 24 }}>
      <span>{e.foot}</span>
      {e.footMid ? <span>{e.footMid}</span> : null}
      {e.right === "undo" ? (
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4, height: 24, boxSizing: "border-box", border: `1px solid ${A.input}`, borderRadius: 6, padding: "0 8px", color: A.fg, background: e.hotUndo ? "#232325" : undefined }}>
          <Undo2 size={12} {...I} /> Undo
        </span>
      ) : e.right ? (
        <span>{e.right}</span>
      ) : null}
    </div>
  </div>
);

export type StarPose = {
  x: number;
  y: number;
  peek?: number;
  gazeX?: number;
  gazeY?: number;
  joy?: number;
  dy?: number;
  angle?: number;
  spin?: number;
  say?: string;
  sayO?: number;
  anchor?: "center" | "right";
};

/** Star perches here: on the status bar, and on the dialogs it hops onto. */
export const PERCH = {
  home: { x: 760, y: 776 },
  approval: { x: 960 - 72 - 32, y: 158 },
  ai: { x: 880 - 72 - 32, y: 210 },
};

/** Star as the app draws it: 64px, peeking 44px over its edge, a speech bubble above. */
export const StarInApp: React.FC<{ pose: StarPose }> = ({ pose }) => {
  const rt = useCurrentFrame() / 60;
  const peek = pose.peek ?? 44;
  const right = pose.anchor === "right";
  return (
    <div style={{ position: "absolute", left: pose.x - 32, top: pose.y - peek + (pose.dy ?? 0), width: 64, zIndex: 5 }}>
      {pose.say ? (
        <div
          style={{
            position: "absolute",
            bottom: peek + 10,
            left: right ? undefined : 32,
            right: right ? 0 : undefined,
            transform: `${right ? "" : "translateX(-50%) "}translateY(${(1 - (pose.sayO ?? 1)) * 6}px) scale(${0.9 + 0.1 * (pose.sayO ?? 1)})`,
            transformOrigin: right ? "100% 100%" : "50% 100%",
            opacity: pose.sayO ?? 1,
            width: "max-content",
            maxWidth: 280,
            background: A.dialog,
            border: `1px solid ${A.input}`,
            borderRadius: 12,
            padding: "6px 12px",
            fontSize: 12,
            lineHeight: 1.6,
            color: A.fg,
            boxShadow: "0 10px 30px rgba(0,0,0,0.4)",
            textWrap: "balance",
          } as React.CSSProperties}
        >
          {pose.say}
        </div>
      ) : null}
      <div style={{ transform: `rotate(${pose.angle ?? 0}deg)`, transformOrigin: "50% 100%" }}>
        <StarMascot size={64} peek={peek} gazeX={pose.gazeX ?? 0} gazeY={pose.gazeY ?? 0} blink={starBlink(rt)} joy={pose.joy ?? 0} spin={pose.spin ?? 0} hands={peek < 64} />
      </div>
    </div>
  );
};

/** Star driven by the film's port of the app's rig (./rig.ts). */
export type RigStar = { f: StarFrame; say?: ReturnType<typeof speech>; anchor?: "center" | "right" };

/** The body, clipped at the edge it peeks over, with its speech bubble (Star.tsx). */
const RigBody: React.FC<{ r: RigStar }> = ({ r }) => {
  const rt = useCurrentFrame() / 60;
  const { f, say } = r;
  const right = r.anchor === "right";
  return (
    <div style={{ position: "absolute", left: f.x, top: f.y, width: STAR_W, height: STAR_H, clipPath: `inset(-200px -320px ${f.hidden.toFixed(2)}px -320px)` }}>
      {say ? (
        <div
          style={{
            position: "absolute",
            bottom: STAR_H + 10,
            left: right ? undefined : STAR_W / 2,
            right: right ? 0 : undefined,
            transform: `${right ? "" : "translateX(-50%) "}translateY(${say.dy}px) scale(${say.s})`,
            transformOrigin: right ? "100% 100%" : "50% 100%",
            opacity: say.o,
            width: "max-content",
            maxWidth: 280,
            background: "#19191b",
            border: `1px solid ${A.line}`,
            borderRadius: 12,
            padding: "6px 12px",
            fontSize: 12,
            lineHeight: 1.625,
            color: A.fg,
            boxShadow: "0 10px 30px rgba(0,0,0,0.4)",
            textWrap: "balance",
          } as React.CSSProperties}
        >
          {say.text}
        </div>
      ) : null}
      <div style={{ transform: `rotate(${f.angle.toFixed(2)}deg) scale(${f.sx.toFixed(4)}, ${f.sy.toFixed(4)})`, transformOrigin: "50% 100%" }}>
        <StarMascot size={64} peek={64} eyes={[f.ex, f.ey]} blink={f.joy > 0.5 ? 0 : starBlink(rt)} joy={f.joy} />
      </div>
    </div>
  );
};

/** Fingertips on the edge, in front of it; they let go to hop. */
const RigHands: React.FC<{ f: StarFrame }> = ({ f }) => (
  <div style={{ position: "absolute", left: f.handsX, top: f.handsY, width: STAR_W, height: STAR_H, opacity: f.grip }}>
    {[12.1, 51.9].map((x) => (
      <div key={x} style={{ position: "absolute", left: x - 4.5, top: PEEK - 4, width: 9, height: 5.5, borderRadius: 3, background: "#ededed", boxShadow: "0 1px 1.5px rgba(0,0,0,0.45)" }} />
    ))}
  </div>
);

export const AppFrame: React.FC<{
  view: "table" | "sql" | "schema";
  table?: TableState;
  sql?: SqlState;
  schema?: React.ReactNode;
  star?: StarPose | null;
  rig?: RigStar;
  /** The dialog overlay's opacity; Star at home sits under it, Star on a dialog above it. */
  scrim?: number;
  /** The system cursor, in app pixels: drawn inside the screen so it scales with the camera. */
  cursor?: CursorState | null;
  children?: React.ReactNode;
}> = ({ view, table, sql, schema, star, rig, scrim = 0, cursor, children }) => {
  const home = rig?.f.home ?? true;
  return (
    <div style={{ position: "relative", width: APP_W, height: APP_H, background: A.main, color: A.fg, fontFamily: sans, overflow: "hidden", borderRadius: 12 }}>
      <TitleBar />
      <Sidebar active={view === "table" ? 0 : view === "schema" ? 1 : 2} />
      <Header title={view === "table" ? "Table editor" : view === "schema" ? "Schema" : "SQL editor"} />
      {view === "table" && table ? (
        <>
          <TablesPanel tables={table.tables ?? ["big_orders", "customers", "order_items", "orders", "products", "users"]} active={table.table} />
          <Grid state={table} />
        </>
      ) : null}
      {view === "sql" && sql ? <SqlView s={sql} /> : null}
      {view === "schema" ? schema : null}
      <StatusBar />
      {rig && home ? (
        <>
          <RigBody r={rig} />
          <RigHands f={rig.f} />
        </>
      ) : null}
      {scrim > 0 ? <Scrim o={scrim} /> : null}
      {rig && !home ? <RigBody r={rig} /> : null}
      {children}
      {rig && !home ? <RigHands f={rig.f} /> : null}
      {!rig && star !== null ? <StarInApp pose={star ?? { ...PERCH.home }} /> : null}
      {cursor ? <MacCursor c={cursor} h={CURSOR_H.app} /> : null}
    </div>
  );
};

/** Dim layer the app draws behind a dialog: bg-black/80. */
export const Scrim: React.FC<{ o: number }> = ({ o }) => <div style={{ ...abs(0, 0, APP_W, APP_H), background: `rgba(0,0,0,${0.8 * o})` }} />;

/** CSS `ease`, which the dialogs' animate-in and animate-out use. */
const cssEase = Easing.bezier(0.25, 0.1, 0.25, 1);
/**
 * DialogContent's enter and exit (ui/dialog.tsx): 200 ms of fade, zoom from 95%
 * and a slide from 48% to 50% of its height; the overlay fades with it.
 * Returns opacity, scale and the slide as a fraction of the dialog's height.
 */
export const dialogAnim = (t: number, openAt: number, closeAt = Infinity) => {
  if (t < openAt) return { o: 0, s: 0.95, dy: 0.02 };
  if (t < closeAt) {
    const k = cssEase(Math.min(1, (t - openAt) / 0.2));
    return { o: k, s: 0.95 + 0.05 * k, dy: 0.02 * (1 - k) };
  }
  const k = cssEase(Math.min(1, (t - closeAt) / 0.2));
  return { o: 1 - k, s: 1 - 0.05 * k, dy: 0.02 * k };
};

export type DiffRow = { id: number; email: string; hit?: string };

/** AgentApprovalDialog.tsx, at the size and place the app draws it. */
export const ApprovalDialog: React.FC<{
  sql: string;
  affected: string;
  rows: DiffRow[];
  rowShow?: (i: number) => number;
  mark?: (i: number) => number;
  expires: string;
  hot?: "decline" | "approve";
  press?: { decline?: number; approve?: number };
  o?: number;
  dy?: number;
  s?: number;
}> = ({ sql, affected, rows, rowShow = () => 1, mark = () => 0, expires, hot, press = {}, o = 1, dy = 0, s }) => (
  <div
    style={{
      ...abs(320, 158, 640),
      background: A.dialog,
      border: `1px solid ${A.input}`,
      borderRadius: 12,
      padding: "24px 24px 22px",
      boxSizing: "border-box",
      opacity: o,
      transform: `translateY(${dy}px) scale(${s ?? 0.97 + 0.03 * o})`,
      boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
    }}
  >
    <X size={16} {...I} color={A.muted} style={abs(606, 20)} />
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 17, fontWeight: 600 }}>
      <Bot size={16} {...I} color={A.key} /> Claude Code wants to change shop.db
    </div>
    <div style={{ fontSize: 15, color: A.muted, marginTop: 6, lineHeight: "20px" }}>
      Generated SQL contains a write: removes rows in users matching the WHERE clause. Nothing runs until you approve it here.
    </div>
    <div style={{ background: A.line, borderRadius: 6, padding: "8px 12px", fontFamily: mono, fontSize: 12, fontWeight: 700, marginTop: 16 }}>{sql}</div>
    <div style={{ fontSize: 15, fontWeight: 500, marginTop: 16 }}>Affects {affected} of 48,213 rows in users</div>
    <div style={{ fontSize: 13, color: A.muted, marginTop: 8 }}>Rows it deletes, the first 20 of {affected}</div>
    <div style={{ border: `1px solid ${A.line}`, borderRadius: 6, marginTop: 6, overflow: "hidden", fontFamily: mono, fontSize: 11.5, fontWeight: 700 }}>
      <div style={{ display: "flex", background: A.raised, color: A.muted, padding: "7px 9px", fontWeight: 500 }}>
        <span style={{ width: 186 }}>id</span>email
      </div>
      {rows.map((r, i) => {
        const s = rowShow(i);
        const m = mark(i);
        const at = r.hit ? r.email.indexOf(r.hit) : -1;
        return (
          <div key={r.id} style={{ display: "flex", padding: "6px 9px", borderTop: `1px solid ${A.line}`, opacity: s }}>
            <span style={{ width: 186 }}>{r.id}</span>
            {at >= 0 && m > 0 ? (
              <span>
                {r.email.slice(0, at)}
                <span style={{ background: `rgba(229,72,77,${0.35 * m})`, color: m > 0.5 ? "#ffb4b6" : undefined, borderRadius: 3 }}>{r.hit}</span>
                {r.email.slice(at + (r.hit?.length ?? 0))}
              </span>
            ) : (
              r.email
            )}
          </div>
        );
      })}
    </div>
    <div style={{ display: "flex", alignItems: "center", marginTop: 18, height: 40 }}>
      <span style={{ fontSize: 13, color: A.muted }}>Claude Code is waiting · expires in {expires}</span>
      <div style={{ position: "relative", marginLeft: "auto", width: 182, height: 40 }}>
        <OutlineBtn x={0} y={0} w={83} hot={hot === "decline"} style={{ transform: `scale(${1 - (press.decline ?? 0) * 0.06})`, fontWeight: 600 }}>
          Decline
        </OutlineBtn>
        <SolidBtn x={92} y={0} w={89} hot={hot === "approve"} press={press.approve}>
          Approve
        </SolidBtn>
      </div>
    </div>
  </div>
);

/** Where the dialog's buttons land in app coordinates (centre points). */
export const DIALOG_BUTTONS = (rows: number) => {
  const y = 158 + 24 + 20 + 6 + 40 + 16 + 31 + 16 + 20 + 8 + 16 + 6 + 30 + rows * 29 + 18 + 20;
  return { decline: { x: 960 - 24 - 182 + 41, y }, approve: { x: 960 - 24 - 45, y } };
};

/** The app's toast, top centre. */
export const Toast: React.FC<{ title: string; body: string; o: number }> = ({ title, body, o }) => (
  <div
    style={{
      ...abs(431, 41, 418, 64),
      background: A.dialog,
      border: `1px solid ${A.input}`,
      borderRadius: 10,
      padding: "11px 16px 0 42px",
      boxSizing: "border-box",
      opacity: o,
      transform: `translateY(${(1 - o) * -16}px)`,
      boxShadow: "0 16px 40px rgba(0,0,0,0.5)",
    }}
  >
    <Check size={15} {...I} color={A.green} style={abs(17, 15)} />
    <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
    <div style={{ fontSize: 14, color: A.muted, marginTop: 2 }}>{body}</div>
  </div>
);

/** The AlertDialog Undo opens. */
export const UndoAlert: React.FC<{ o: number; hot?: boolean; press?: number }> = ({ o, hot, press = 0 }) => (
  <div style={{ ...abs(420, 300, 440), background: A.dialog, border: `1px solid ${A.input}`, borderRadius: 12, padding: 24, boxSizing: "border-box", opacity: o, transform: `scale(${0.97 + 0.03 * o})`, boxShadow: "0 30px 80px rgba(0,0,0,0.6)" }}>
    <div style={{ fontSize: 17, fontWeight: 600 }}>Undo this write?</div>
    <div style={{ fontSize: 15, color: A.muted, marginTop: 8 }}>Puts back 37 rows deleted from users.</div>
    <div style={{ position: "relative", height: 40, marginTop: 22 }}>
      <OutlineBtn x={208} y={0} w={86}>
        Cancel
      </OutlineBtn>
      <SolidBtn x={302} y={0} w={90} hot={hot} press={press}>
        Undo
      </SolidBtn>
    </div>
  </div>
);
export const UNDO_BUTTON = { x: 420 + 24 + 302 + 45, y: 300 + 24 + 20 + 8 + 20 + 22 + 20 };

/** The Text to SQL dialog (AiQueryDialog.tsx). */
export const TTS_TOP = 139;
export const TTS_H = 522;
export const TextToSql: React.FC<{ prompt: string; caret: boolean; o: number; s?: number; dy?: number; hot?: boolean; press?: number; loading?: boolean }> = ({
  prompt,
  caret,
  o,
  s = 1,
  dy = 0,
  hot,
  press = 0,
  loading,
}) => (
  <div
    style={{
      ...abs(400, TTS_TOP, 480, TTS_H),
      background: "#19191b",
      border: `1px solid ${A.line}`,
      borderRadius: 16,
      padding: 24,
      boxSizing: "border-box",
      opacity: o,
      transform: `translateY(${dy * TTS_H}px) scale(${s})`,
      boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
    }}
  >
    <X size={16} {...I} color={A.muted} style={abs(446, 17)} />
    <div style={{ ...abs(24, 25), fontSize: 16, fontWeight: 500, lineHeight: "16px" }}>Text to SQL</div>
    <div style={{ ...abs(24, 47), fontSize: 14, lineHeight: "20px", color: A.muted }}>Describe what you want in plain words, and I'll write the SQL.</div>
    <div
      style={{
        ...abs(24, 90, 432, 102),
        border: `1px solid ${A.input}`,
        borderRadius: 8,
        padding: "8px 12px",
        boxSizing: "border-box",
        fontSize: 14,
        lineHeight: "20px",
        color: prompt ? A.fg : A.faint,
        boxShadow: "0 0 0 2px #19191b, 0 0 0 3px rgba(237,237,237,0.3)",
      }}
    >
      {caret && !prompt ? <span style={{ display: "inline-block", width: 1.5, height: 17, background: A.fg, verticalAlign: -3, marginRight: -1.5 }} /> : null}
      {prompt || "e.g. customers who signed up in the last month"}
      {caret && prompt ? <span style={{ display: "inline-block", width: 1.5, height: 17, background: A.fg, verticalAlign: -3, marginLeft: 1 }} /> : null}
    </div>
    <ContextMeter question={4 + Math.ceil(prompt.length / 4)} />
    <div style={{ ...abs(24, 458, 432, 40), opacity: prompt && !loading ? 1 : 0.5 }}>
      <SolidBtn x={0} y={0} w={432} hot={hot} press={press}>
        {loading ? <Spinner /> : null}
        Generate SQL
      </SolidBtn>
    </div>
  </div>
);

/** ContextMeter.tsx: what the prompt to the model is made of. */
const ContextMeter: React.FC<{ question: number }> = ({ question }) => {
  const hatch = "repeating-linear-gradient(-55deg, #6b6b72 0 2px, transparent 2px 5px)";
  const chip = (sw: React.ReactNode, label: string, n: string, dim?: boolean) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, height: 26, padding: "0 8px", background: "#1f1f22", borderRadius: 6, fontSize: 13, color: dim ? A.faint : A.fg }}>
      {sw}
      {label} <span style={{ fontFamily: mono, fontSize: 12, color: dim ? A.faint : A.muted }}>{n}</span>
    </span>
  );
  const sq = (c: string) => <span style={{ width: 8, height: 8, borderRadius: 2, background: c }} />;
  return (
    <div style={{ ...abs(25, 208, 430, 232), border: `1px solid ${A.line}`, borderRadius: 12, boxSizing: "border-box" }}>
      <div style={{ ...abs(16, 21), fontSize: 14, fontWeight: 600 }}>Context</div>
      <div style={{ ...abs(336, 16, 76, 28), border: `1px solid ${A.input}`, borderRadius: 6, fontSize: 13, display: "grid", placeItems: "center", boxSizing: "border-box" }}>Compact</div>
      <div style={{ ...abs(16, 58), display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.02em" }}>1.6K</span>
        <span style={{ fontSize: 14, color: A.muted }}>of 4K tokens</span>
      </div>
      <div style={{ ...abs(380, 69), fontFamily: mono, fontSize: 12, color: A.muted }}>38%</div>
      <div style={{ ...abs(16, 101, 396, 8), background: "#232325", borderRadius: 4, overflow: "hidden", display: "flex", gap: 1 }}>
        <span style={{ width: 19, background: "#5a5a5e" }} />
        <span style={{ width: 24, background: A.fg }} />
        <span style={{ width: 6, background: "#8a8a90" }} />
        <span style={{ width: 2, background: A.fg }} />
        <span style={{ width: 96, background: hatch }} />
      </div>
      <div style={{ ...abs(16, 123), display: "flex", gap: 6 }}>
        {chip(sq("#5a5a5e"), "Instructions", "201")}
        {chip(sq(A.fg), "Schema", "262")}
        {chip(sq("#8a8a90"), "Sample values", "100")}
      </div>
      <div style={{ ...abs(16, 157), display: "flex", gap: 6 }}>
        {chip(sq("#3a3a3e"), "Examples", "0", true)}
        {chip(sq(A.fg), "Question", String(question))}
        {chip(<span style={{ width: 8, height: 8, background: hatch }} />, "Reply", "1K")}
      </div>
      <div style={{ ...abs(16, 197), fontSize: 13, color: A.muted }}>llama3 · 4K window, assumed Ollama default</div>
    </div>
  );
};
const Spinner: React.FC = () => {
  const rt = useCurrentFrame() / 60;
  return <Loader2 size={16} {...I} style={{ transform: `rotate(${(rt * 360) % 360}deg)` }} />;
};
export const GENERATE_BUTTON = { x: 640, y: TTS_TOP + 478 };
