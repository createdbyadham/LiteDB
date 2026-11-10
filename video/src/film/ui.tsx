// LiteDB's UI in its light theme, drawn for the film. Copy matches the app:
// AgentApprovalDialog.tsx, AuditLogView.tsx, agents-panel.tsx.
import React from "react";
import { AbsoluteFill } from "remotion";
import { Caret, E, headline, mono, p, P, sans, typed, typedEnd } from "./kit";

/** Dark title card: line 1 sits there, line 2 types in grey with the blue caret. */
export const TitleCard: React.FC<{ t: number; l1: string; l2: string; cps?: number; start?: number; size?: number; bg?: string }> = ({
  t,
  l1,
  l2,
  cps = 11,
  start = 0.05,
  size = 128,
  bg = P.card,
}) => {
  const shown = typed(l2, t, start, cps);
  const end = typedEnd(l2, start, cps);
  return (
    <AbsoluteFill style={{ background: bg, alignItems: "center", justifyContent: "center" }}>
      <div style={{ ...headline, fontSize: size, textAlign: "center" }}>
        <div style={{ color: P.fg }}>{l1}</div>
        <div style={{ color: P.muted }}>
          {shown}
          <Caret t={t} idleFrom={end} />
        </div>
      </div>
    </AbsoluteFill>
  );
};

/** A word that arrives small and blue, then settles white and full size. */
export const PopWord: React.FC<{ t: number; at: number; text: string; color?: string; accent?: string; flash?: number }> = ({
  t,
  at,
  text,
  color = P.fg,
  accent = P.key,
  flash = 0,
}) => {
  if (t < at) return null;
  const grow = p(t, at, at + 0.22, E.out);
  const settle = p(t, at + 0.12, at + 0.42, E.inOut);
  const tint = Math.max(1 - settle, flash);
  return (
    <span
      style={{
        display: "inline-block",
        fontSize: `${0.62 + 0.38 * grow}em`,
        transform: `translateY(${(1 - grow) * 0.12}em)`,
        color: tint > 0.5 ? accent : color,
        opacity: 0.4 + 0.6 * grow,
        transition: "none",
      }}
    >
      {text}
    </span>
  );
};

/** The prompt bar: plus, typed text, then something on the right, then send. */
export const PromptBar: React.FC<{
  t: number;
  text: string;
  start: number;
  cps: number;
  width?: number;
  scale?: number;
  right?: React.ReactNode;
  press?: number;
  placeholder?: string;
}> = ({ t, text, start, cps, width = 1344, scale = 1, right, press = 0, placeholder }) => {
  const shown = typed(text, t, start, cps);
  return (
    <div
      style={{
        width,
        height: 138,
        background: P.white,
        borderRadius: 38,
        display: "flex",
        alignItems: "center",
        padding: "0 22px 0 52px",
        boxShadow: "0 2px 0 rgba(0,0,0,0.02), 0 18px 50px rgba(24,24,27,0.06)",
        transform: `scale(${scale})`,
        fontFamily: sans,
      }}
    >
      <span style={{ fontSize: 60, fontWeight: 300, color: P.textSoft, width: 70 }}>+</span>
      <span style={{ fontSize: 46, letterSpacing: "-0.02em", color: shown ? P.text : P.textFaint, flex: 1, whiteSpace: "nowrap", overflow: "hidden" }}>
        {shown || placeholder}
        {shown.length < text.length || !placeholder ? <Caret t={t} idleFrom={typedEnd(text, start, cps)} h={1.05} w={0.04} color={P.text} /> : null}
      </span>
      {right}
      <div
        style={{
          width: 90,
          height: 90,
          borderRadius: 22,
          background: P.text,
          display: "grid",
          placeItems: "center",
          marginLeft: 20,
          transform: `scale(${1 - press * 0.08})`,
        }}
      >
        <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#111113" strokeWidth="1.8" strokeLinejoin="round">
          <path d="M21 3 3 10.5l7.2 2.6L13 21z" />
          <path d="M21 3 10.2 13.1" />
        </svg>
      </div>
    </div>
  );
};

/** Agent names as text chips (no third-party logos). */
export const AgentChip: React.FC<{ name: string; dot?: string; size?: number; style?: React.CSSProperties }> = ({ name, dot = P.key, size = 26, style }) => (
  <div
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: size * 0.4,
      padding: `${size * 0.42}px ${size * 0.7}px`,
      borderRadius: size * 0.6,
      background: P.white,
      border: `1.5px solid ${P.line}`,
      fontFamily: sans,
      fontSize: size,
      fontWeight: 500,
      letterSpacing: "-0.01em",
      color: P.text,
      whiteSpace: "nowrap",
      boxShadow: "0 8px 24px rgba(24,24,27,0.06)",
      ...style,
    }}
  >
    <span style={{ width: size * 0.42, height: size * 0.42, borderRadius: size, background: dot }} />
    {name}
  </div>
);

export type Row = { id: number; email: string; hit?: string };

/** Highlights `hit` inside the email, the film's one overlay on real app UI. */
const Email: React.FC<{ row: Row; mark: number }> = ({ row, mark }) => {
  if (!row.hit || mark <= 0) return <>{row.email}</>;
  const i = row.email.indexOf(row.hit);
  return (
    <>
      {row.email.slice(0, i)}
      <span style={{ background: `rgba(229,72,77,${0.22 * mark})`, color: mark > 0.5 ? "#b42318" : undefined, borderRadius: 4, padding: "0 2px" }}>{row.hit}</span>
      {row.email.slice(i + row.hit.length)}
    </>
  );
};

/** AgentApprovalDialog.tsx in the light theme. */
export const ApprovalCard: React.FC<{
  t: number;
  sql: string;
  affected: string;
  of: string;
  rows: Row[];
  rowsFrom?: number;
  markFrom?: number;
  expires?: string;
  hot?: "decline" | "approve";
  width?: number;
}> = ({ t, sql, affected, of, rows, rowsFrom = 0, markFrom = Infinity, expires = "4:58", hot, width = 1000 }) => (
  <div
    style={{
      width,
      background: P.white,
      borderRadius: 22,
      border: `1.5px solid ${P.line}`,
      boxShadow: "0 40px 90px rgba(24,24,27,0.14)",
      padding: "34px 38px 30px",
      fontFamily: sans,
      color: P.text,
      display: "grid",
      gap: 18,
    }}
  >
    <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 30, fontWeight: 600, letterSpacing: "-0.02em" }}>
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={P.keyDeep} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="8" width="16" height="12" rx="2" />
        <path d="M12 8V4M8 4h8M9 13v2M15 13v2" />
      </svg>
      Claude Code wants to change shop
    </div>
    <div style={{ fontSize: 21, color: P.textSoft, marginTop: -8 }}>Removes rows in users matching the WHERE clause. Nothing runs until you approve it here.</div>
    <div style={{ fontFamily: mono, fontSize: 22, background: P.soft, padding: "16px 20px", borderRadius: 12, whiteSpace: "nowrap" }}>{sql}</div>
    <div style={{ fontSize: 26, fontWeight: 500 }}>
      Affects {affected} of {of} rows in users
    </div>
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ fontSize: 18, color: P.textSoft }}>
        Rows it deletes, the first 20 of {affected}
      </div>
      <div style={{ border: `1.5px solid ${P.line}`, borderRadius: 12, overflow: "hidden", fontFamily: mono, fontSize: 20 }}>
        <div style={{ display: "flex", background: P.soft, color: P.textSoft, padding: "10px 16px", fontSize: 17 }}>
          <span style={{ width: 110 }}>id</span>
          <span>email</span>
        </div>
        {rows.map((r, i) => {
          const a = p(t, rowsFrom + i * 0.07, rowsFrom + i * 0.07 + 0.3);
          const m = p(t, markFrom + i * 0.12, markFrom + i * 0.12 + 0.25);
          return (
            <div key={r.id} style={{ display: "flex", padding: "11px 16px", borderTop: `1.5px solid ${P.line}`, opacity: a, transform: `translateY(${(1 - a) * 10}px)` }}>
              <span style={{ width: 110, color: P.textFaint }}>{r.id}</span>
              <span>
                <Email row={r} mark={m} />
              </span>
            </div>
          );
        })}
      </div>
    </div>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 4 }}>
      <span style={{ fontSize: 18, color: P.textSoft }}>Claude Code is waiting · expires in {expires}</span>
      <div style={{ display: "flex", gap: 12 }}>
        <span
          style={{
            fontSize: 22,
            fontWeight: 600,
            padding: "13px 26px",
            borderRadius: 12,
            border: `1.5px solid ${P.line}`,
            boxShadow: hot === "decline" ? `0 0 0 5px rgba(79,140,255,0.5)` : undefined,
          }}
        >
          Decline
        </span>
        <span
          style={{
            fontSize: 22,
            fontWeight: 600,
            padding: "13px 26px",
            borderRadius: 12,
            background: P.text,
            color: P.white,
            boxShadow: hot === "approve" ? `0 0 0 5px rgba(79,140,255,0.5)` : undefined,
          }}
        >
          Approve
        </span>
      </div>
    </div>
  </div>
);

export const BAD_ROWS: Row[] = [
  { id: 1042, email: "contest.winner@orbitmail.net", hit: "test" },
  { id: 2210, email: "latest.orders@kettlebrew.co", hit: "test" },
  { id: 3318, email: "giulia.testa@casaverde.it", hit: "test" },
  { id: 5121, email: "protest.signs@inkwell.org", hit: "test" },
  { id: 6034, email: "qa+test@test.local", hit: "test" },
];

export const GOOD_ROWS: Row[] = [
  { id: 48102, email: "qa+checkout@test.local", hit: "@test.local" },
  { id: 48103, email: "qa+refunds@test.local", hit: "@test.local" },
  { id: 48107, email: "seed-user-07@test.local", hit: "@test.local" },
  { id: 48110, email: "load-test-3@test.local", hit: "@test.local" },
];

/** One audit entry, labels from AuditLogView.tsx. */
export const AuditEntry: React.FC<{ who: string; kind: "write" | "read"; decision: string; sql?: string; note?: string; undo?: boolean; style?: React.CSSProperties }> = ({
  who,
  kind,
  decision,
  sql,
  note,
  undo,
  style,
}) => (
  <div style={{ padding: "20px 24px", borderBottom: `1.5px solid ${P.line}`, display: "grid", gap: 10, fontFamily: sans, color: P.text, ...style }}>
    <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 21 }}>
      <span style={{ fontWeight: 600, background: P.soft, padding: "5px 12px", borderRadius: 8 }}>{who}</span>
      <span
        style={{
          fontFamily: mono,
          fontSize: 17,
          padding: "4px 10px",
          borderRadius: 7,
          background: kind === "write" ? "rgba(240,136,66,0.16)" : P.soft,
          color: kind === "write" ? "#c2410c" : P.textSoft,
        }}
      >
        {kind}
      </span>
      <span style={{ color: P.textSoft }}>{decision}</span>
      {undo ? <span style={{ marginLeft: "auto", fontWeight: 600, border: `1.5px solid ${P.line}`, borderRadius: 9, padding: "5px 13px" }}>↶ Undo</span> : null}
    </div>
    {sql ? <div style={{ fontFamily: mono, fontSize: 18, background: P.soft, padding: "10px 14px", borderRadius: 9 }}>{sql}</div> : null}
    {note ? <div style={{ fontSize: 18, color: P.textSoft }}>{note}</div> : null}
  </div>
);
