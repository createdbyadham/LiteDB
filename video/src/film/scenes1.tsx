// 0:00 to 0:32.5 of the launch film: hook, logo, the catch, the fix, the record.
import React from "react";
import { AbsoluteFill } from "remotion";
import { AppIcon } from "../launch/art";
import { AppFrame, ApprovalDialog, AuditItem, dialogAnim, DIALOG_BUTTONS, DiffRow, GridRow, Toast, UNDO_BUTTON, UndoAlert } from "./app";
import { perchDialog, perchHome, speech, starAt } from "./rig";
import { BrandGlyph, BrandId } from "./brands";
import {
  Caret,
  clamp01,
  Cam,
  Holds,
  unwarp,
  warp,
  DotField,
  E,
  H,
  headline,
  lerp,
  mono,
  P,
  p,
  PixelPill,
  pressAt,
  sans,
  spr,
  Stage,
  typed,
  typedEnd,
  useT,
  W,
} from "./kit";
import { ClaudeDesktop, DESKTOP, DESKTOP_FULL, DESKTOP_READ, Line } from "./desktop";
import { CursorState, over } from "./cursor";
import { CLICK, glide, glideEase, punchIn } from "./motion";
import { PopWord, TitleCard } from "./ui";

const AGENTS: { id: BrandId; name: string; bg: string }[] = [
  { id: "claude", name: "Claude Code", bg: "#f6ae31" },
  { id: "cursor", name: "Cursor", bg: "#9fd8d8" },
  { id: "vscode", name: "VS Code", bg: "#b9b2f2" },
  { id: "opencode", name: "OpenCode", bg: "#a6e3b8" },
  { id: "claude", name: "Claude Desktop", bg: "#f2a07b" },
];
const AgentPill: React.FC<{ i: number }> = ({ i }) => {
  const a = AGENTS[i % AGENTS.length];
  return (
    <div style={{ position: "relative" }}>
      <PixelPill bg={a.bg} w={250} h={58} label="" />
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: 9, fontFamily: sans, fontWeight: 600, fontSize: 25, color: "#141416", letterSpacing: "-0.02em" }}>
        <BrandGlyph id={a.id} size={26} color="#141416" />
        {a.name}
      </div>
    </div>
  );
};

/** Text that types left to right in place: the full line holds the space so nothing shifts. */
const InPlace: React.FC<{ full: string; children: React.ReactNode }> = ({ full, children }) => (
  <span style={{ position: "relative", display: "inline-block" }}>
    <span style={{ visibility: "hidden" }}>{full}</span>
    <span style={{ position: "absolute", left: 0, top: 0 }}>{children}</span>
  </span>
);

const commas = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const HOOK_ASK = "delete the test accounts";
const HOOK_HITS = ["contest.winner@orbitmail.net", "latest.orders@kettlebrew.co", "giulia.testa@casaverde.it", "protest.signs@inkwell.org", "attestation@lumenpost.de"];
const HOOK_B = 1.7;
const HOOK_C = 3.2;
const HOOK_D = 5.4;
export const NEAR_MISS_LEN = 7.4;

const Q1 = "Would you give an AI agent";
const Q2 = "write access to prod?";
const A1 = "What if it had to";
const A2 = "ask you first?";
// paced to the voiceover: the question, "Didn't think so.", the turn
const Q2_AT = 1.85;
const HOOK_2 = 3.3;
const HOOK_3 = 4.45;
export const HOOK_LEN = 6.3;

/**
 * 0:00 The hook in the reference's type: the question typed two-tone with the
 * blue caret, the answer popped in, then the turn with its last words in blue.
 */
export const Opener: React.FC = () => {
  const t = useT();
  const center: React.CSSProperties = { background: P.ink, alignItems: "center", justifyContent: "center" };
  if (t < HOOK_2) {
    // typed along with the voice: line 1 over "Would you give an AI agent", line 2 from "write"
    const e2 = typedEnd(Q2, Q2_AT, 19);
    return (
      <AbsoluteFill style={center}>
        <DotField t={t} color="#ffffff" opacity={0.07} />
        <div style={{ ...headline, fontSize: 132, textAlign: "center" }}>
          <div style={{ color: P.fg }}>
            <InPlace full={Q1}>
              {typed(Q1, t, 0.12, 16)}
              {t < Q2_AT ? <Caret t={t} idleFrom={9} /> : null}
            </InPlace>
          </div>
          <div style={{ color: P.muted }}>
            <InPlace full={Q2}>
              {typed(Q2, t, Q2_AT, 19)}
              {t >= Q2_AT ? <Caret t={t} idleFrom={e2} /> : null}
            </InPlace>
          </div>
        </div>
      </AbsoluteFill>
    );
  }
  if (t < HOOK_3) {
    const b = t - HOOK_2;
    return (
      <AbsoluteFill style={center}>
        <DotField t={t} color="#ffffff" opacity={0.07} />
        <div style={{ ...headline, fontSize: 150, display: "flex", gap: "0.24em", alignItems: "baseline" }}>
          <PopWord t={b} at={0.04} text="Didn't" />
          <PopWord t={b} at={0.3} text="think" />
          <PopWord t={b} at={0.52} text="so." color={P.muted} />
        </div>
      </AbsoluteFill>
    );
  }
  const c = t - HOOK_3;
  const e = typedEnd(A2, 0.95, 18);
  return (
    <AbsoluteFill style={center}>
      <DotField t={t} color="#ffffff" opacity={0.07} />
      <div style={{ ...headline, fontSize: 140, textAlign: "center" }}>
        <div style={{ color: P.fg, display: "flex", gap: "0.24em", justifyContent: "center" }}>
          {A1.split(" ").map((w, i) => (
            <PopWord key={i} t={c} at={0.05 + i * 0.17} text={w} />
          ))}
        </div>
        <div style={{ color: P.key }}>
          <InPlace full={A2}>
            {typed(A2, c, 0.95, 18)}
            <Caret t={c} idleFrom={e} />
          </InPlace>
        </div>
      </div>
    </AbsoluteFill>
  );
};

/**
 * Spare hook, not in the cut: the near miss without LiteDB. The ask, the SQL it
 * turns into, what that matches, and what it costs.
 */
export const NearMiss: React.FC = () => {
  const t = useT();
  const pill = (at: number) => (
    <div style={{ transform: `scale(${1.4 * Math.max(0, spr(t, at, 0.42, 0.7))})`, transformOrigin: "0 100%", marginBottom: 44, width: 250 }}>
      <AgentPill i={0} />
    </div>
  );
  if (t < HOOK_C) {
    const sql = t >= HOOK_B;
    const b = t - HOOK_B;
    const lit = p(b, 0.8, 1.0);
    const tok = (at: number, text: string) => <PopWord t={b} at={at} text={text} />;
    return (
      <AbsoluteFill style={{ background: P.ink, alignItems: "center", justifyContent: "center" }}>
        <DotField t={t} color="#ffffff" opacity={0.07} />
        <div style={{ width: 1460 }}>
          {pill(0.05)}
          {sql ? (
            <div style={{ fontFamily: mono, fontSize: 96, fontWeight: 500, letterSpacing: "-0.03em", lineHeight: 1.2, color: P.fg, whiteSpace: "pre" }}>
              <div>
                {tok(0, "DELETE")} {tok(0.08, "FROM")} {tok(0.16, "users")}
              </div>
              <div>
                {tok(0.3, "WHERE")} {tok(0.38, "email")} {tok(0.46, "LIKE")}{" "}
                <span style={{ background: `rgba(229,72,77,${0.35 * lit})`, color: lit > 0.5 ? "#ffb4b6" : undefined, borderRadius: 10 }}>{tok(0.56, "'%test%'")}</span>
              </div>
            </div>
          ) : (
            <div style={{ ...headline, fontSize: 124, color: P.fg }}>
              <span style={{ color: P.textFaint }}>{"> "}</span>
              <InPlace full={HOOK_ASK}>
                {typed(HOOK_ASK, t, 0.3, 24)}
                <Caret t={t} idleFrom={typedEnd(HOOK_ASK, 0.3, 24)} />
              </InPlace>
            </div>
          )}
        </div>
      </AbsoluteFill>
    );
  }
  if (t < HOOK_D) {
    const c = t - HOOK_C;
    const more = p(c, 0.8, 1.05);
    return (
      <AbsoluteFill style={{ background: P.ink, alignItems: "center", justifyContent: "center" }}>
        <DotField t={t} color="#ffffff" opacity={0.07} />
        <div style={{ width: 1180 }}>
          <div style={{ ...headline, fontSize: 72, color: P.muted, marginBottom: 36 }}>
            <span style={{ color: P.fg }}>{commas(Math.round(1204 * p(c, 0.05, 0.85)))}</span> rows match
          </div>
          {HOOK_HITS.map((e, i) => {
            const at = 0.12 + i * 0.12;
            const a = p(c, at, at + 0.22);
            const m = p(c, at + 0.18, at + 0.38);
            const k = e.indexOf("test");
            return (
              <div key={e} style={{ fontFamily: mono, fontSize: 62, lineHeight: 1.5, color: P.fg, opacity: a, transform: `translateY(${(1 - a) * 18}px)`, whiteSpace: "pre" }}>
                {e.slice(0, k)}
                <span style={{ background: `rgba(229,72,77,${0.35 * m})`, color: m > 0.5 ? "#ffb4b6" : undefined, borderRadius: 8 }}>test</span>
                {e.slice(k + 4)}
              </div>
            );
          })}
          <div style={{ ...headline, fontSize: 48, color: P.textFaint, marginTop: 22, opacity: more }}>and 1,199 more</div>
        </div>
      </AbsoluteFill>
    );
  }
  return <TitleCard t={t - HOOK_D} l1="1,167 of them" l2="are real customers." cps={24} start={0.1} />;
};

/** Amber bloom drifting on black, the reference's lavender bloom. */
const Bloom: React.FC<{ t: number }> = ({ t }) => (
  <AbsoluteFill style={{ background: "#0b0b0c", overflow: "hidden" }}>
    {[
      [0.2, 0.15, 1000, 0.55],
      [0.85, 0.2, 900, 0.45],
      [0.55, 0.95, 1100, 0.5],
      [0.05, 0.9, 800, 0.4],
    ].map(([x, y, r, a], i) => (
      <div
        key={i}
        style={{
          position: "absolute",
          left: x * W + Math.sin(t * 0.9 + i) * 60 - r / 2,
          top: y * H + Math.cos(t * 0.7 + i * 2) * 50 - r / 2,
          width: r,
          height: r,
          borderRadius: "50%",
          background: `radial-gradient(circle, rgba(79,140,255,${a}) 0%, rgba(79,140,255,0) 65%)`,
          filter: "blur(30px)",
        }}
      />
    ))}
  </AbsoluteFill>
);

/**
 * 0:04.6 "Meet|" typed huge on the bloom. The caret grows into the app icon
 * where it stood, "Meet" comes down to logo size beside it, "LiteDB" types
 * after the icon, then "Meet" shrinks away and the logo settles in the centre.
 * One shot, on the film's glide curve.
 */
export const MEET = { typeAt: 0.08, blinkOff: 0.55, blinkOn: 0.75, morph: 0.9, morphDur: 0.55, word: 1.45, out: 2.1, outDur: 0.5, fade: 3.9, len: 4.2 };
export const Meet: React.FC = () => {
  const t = useT();
  const M = MEET;
  const m = glideEase(clamp01((t - M.morph) / M.morphDur));
  const gone = glideEase(clamp01((t - M.out) / M.outDur));
  const dark = p(t, M.morph, M.word + 0.3, E.inOut);
  const end = p(t, M.fade, M.len, E.in);
  // "Meet": 330 px alone, 168 px beside the icon, then shrinks to nothing
  const F = lerp(330, 168, m) * (1 - gone);
  // the caret, then the icon: a white bar the caret's size grows into a 150 px tile
  const caretOn = t < M.blinkOff || t >= M.blinkOn;
  const cw = 0.07 * 330;
  const ch = 330;
  const bw = lerp(cw, 150, m);
  const bh = lerp(ch, 150, m);
  const icon = p(m, 0.35, 0.9, (x) => x);
  const word = typed("LiteDB", t, M.word, 16);
  return (
    <AbsoluteFill style={{ background: "#0b0b0c" }}>
      <AbsoluteFill style={{ opacity: 1 - dark }}>
        <Bloom t={t} />
      </AbsoluteFill>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: 1 - end, filter: end ? `blur(${end * 14}px)` : undefined }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <div style={{ ...headline, fontSize: F, lineHeight: 1, fontWeight: 600, color: "rgba(255,255,255,0.94)", opacity: 1 - gone, filter: gone ? `blur(${gone * 10}px)` : undefined, whiteSpace: "pre", marginRight: lerp(0.06 * 330, 40, m) * (1 - gone) }}>
            {typed("Meet", t, M.typeAt, 10)}
          </div>
          <div style={{ position: "relative", width: bw, height: bh, opacity: caretOn || m > 0 ? 1 : 0 }}>
            <div style={{ position: "absolute", inset: 0, background: "rgba(255,255,255,0.95)", borderRadius: lerp(0, 150 * 0.225, m), opacity: 1 - icon }} />
            {icon > 0 ? (
              <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", opacity: icon }}>
                <AppIcon size={Math.min(bw, bh)} />
              </div>
            ) : null}
          </div>
          {word ? <div style={{ ...headline, fontSize: 168, lineHeight: 1, fontWeight: 600, color: P.fg, letterSpacing: "-0.05em", marginLeft: 30 }}>{word}</div> : null}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** 0:06 Logo: the app icon sharpens out of a blur, then "LiteDB" types beside it. */
export const H_LOGO: Holds = [[1.6, 0.4]];
export const Logo: React.FC = () => {
  const t = warp(useT(), H_LOGO);
  const sharp = p(t, 0, 0.45, E.out);
  const word = typed("LiteDB", t, 0.5, 16);
  const out = p(t, 2.3, 2.6, E.in);
  return (
    <AbsoluteFill style={{ background: "#0b0b0c", alignItems: "center", justifyContent: "center" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 30, opacity: 1 - out, filter: out ? `blur(${out * 14}px)` : undefined }}>
        <div style={{ transform: `scale(${lerp(2.3, 1, sharp)})`, filter: `blur(${(1 - sharp) * 26}px)`, opacity: 0.4 + 0.6 * sharp }}>
          <AppIcon size={150} />
        </div>
        {word ? <div style={{ ...headline, fontSize: 168, fontWeight: 600, color: P.fg, letterSpacing: "-0.05em" }}>{word}</div> : null}
      </div>
    </AbsoluteFill>
  );
};


// The users table as the app shows it.
const NAMES = ["Maria Lopez", "Kenji Ono", "Ana Reyes", "Tom Becker", "Lena Fischer", "Omar Haddad", "Priya Nair", "Jonas Berg", "Sofia Rossi", "Liam Walsh", "Chen Wei", "Nora Ali", "Ivan Petrov", "Zoe Martin", "Sam Okafor", "Eva Novak", "Raj Mehta", "Yuki Sato"];
const MAILS = ["maria.lopez@orbitmail.net", "kenji.ono@pinecrest.jp", "ana.reyes@mailhouse.org", "tom.becker@lumenpost.de", "lena.f@orbitmail.net", "omar.h@fastlane.io", "priya.nair@mailhouse.org", "jonas@bergstudio.se", "sofia.rossi@casaverde.it", "liam.walsh@pinecrest.ie", "chen.wei@orbitmail.net", "nora.ali@mailhouse.org", "ivan.p@lumenpost.de", "zoe.martin@orbitmail.net", "sam.okafor@fastlane.io", "eva.novak@pinecrest.cz", "raj.mehta@mailhouse.org", "yuki.sato@orbitmail.net"];
export const USERS: GridRow[] = NAMES.map((n, i) => ({ id: 1001 + i * 7, name: n, email: MAILS[i], created: `2026-0${(i % 9) + 1}-${10 + (i % 18)}` }));

const BAD: DiffRow[] = [
  { id: 1042, email: "contest.winner@orbitmail.net", hit: "test" },
  { id: 2210, email: "latest.orders@kettlebrew.co", hit: "test" },
  { id: 3318, email: "giulia.testa@casaverde.it", hit: "test" },
  { id: 5121, email: "protest.signs@inkwell.org", hit: "test" },
  { id: 6034, email: "qa+test@test.local", hit: "test" },
  { id: 7781, email: "attestation@lumenpost.de", hit: "test" },
];
const GOOD: DiffRow[] = [
  { id: 48102, email: "qa+checkout@test.local", hit: "@test.local" },
  { id: 48103, email: "qa+refunds@test.local", hit: "@test.local" },
  { id: 48107, email: "seed-user-07@test.local", hit: "@test.local" },
  { id: 48110, email: "load-test-3@test.local", hit: "@test.local" },
  { id: 48114, email: "e2e-signup@test.local", hit: "@test.local" },
  { id: 48119, email: "qa+admin@test.local", hit: "@test.local" },
];
const BAD_SQL = "DELETE FROM users WHERE email LIKE '%test%'";
const GOOD_SQL = "DELETE FROM users WHERE email LIKE '%@test.local'";

// Camera and cursor follow the second reference (./motion.ts): each shot holds
// still, a punch-in cut (x2.48) lands just before the cursor does, the cursor
// rests 0.33 s before a click, and the next shot cuts back wide.
// Pauses only where nothing important is moving, each long enough to read.

// --- Claude, shot as the reference shoots its prompt box ---
const CHAT_CLOSE: Cam = { x: 748, y: 640, s: 1.35 };
const CHAT_REST = { x: 1012, y: 606 };
const SEND_BOX = { x: DESKTOP.send.x - 14, y: DESKTOP.send.y - 14, w: 28, h: 28 };
const SEND = { x: DESKTOP.send.x - 2, y: DESKTOP.send.y + 2 };
/** Close on the input while typing; wide on the conversation once it is sent. */
const chatCam = (close: boolean) => (close ? CHAT_CLOSE : DESKTOP_FULL);
/** The cursor sending a message: resting, a glide onto Send, the hand over it, and away once it has clicked. */
const sendCursor = (rt: number, U: (a: number) => number, glideAt: number): CursorState => {
  // on real time, so a reading pause never freezes it mid-glide
  const leave = glideAt + 0.4 + CLICK.dwell + CLICK.after;
  const p = rt < U(leave) ? glide(rt, U(glideAt), 0.4, CHAT_REST, SEND) : glide(rt, U(leave), 0.6, SEND, CHAT_REST);
  return { ...p, hand: over(p, SEND_BOX) };
};

// --- the app ---
const WIDE: Cam = { x: 640, y: 400, s: 1.25 };
const CARD: Cam = { x: 640, y: 380, s: 1.6 };
const btnBox = (c: { x: number; y: number }, w: number) => ({ x: c.x - w / 2, y: c.y - 20, w, h: 40 });

// Catch, on its own clock (authored seconds; holds stretch them in real time).
const C = {
  typeAt: 0.15,
  glideAt: 1.85,
  sendAt: 1.85 + 0.4 + CLICK.dwell, // 2.58
  wideAt: 2.58 + CLICK.after, // 2.88: cut to the whole conversation
  appAt: 3.5, // wall transition into LiteDB happens here
  openAt: 3.95,
  rowsAt: 4.8, // punch-in on the rows
  cardAt: 5.75, // cut back to the card as the cursor comes in
  punchAt: 6.1, // punch-in on Decline, 0.2 s before the cursor lands
  landAt: 6.3,
  declineAt: 6.3 + CLICK.dwell, // 6.63
  wide2At: 6.63 + CLICK.after, // 6.93
  chatAt: 7.2, // wall transition back to Claude
  nextType: 7.7,
  nextGlide: 8.7,
  nextSend: 8.7 + 0.4 + CLICK.dwell, // 9.43
  nextWide: 9.43 + CLICK.after, // 9.73
};
export const CATCH_LEN = 9.95;
/** follow: where the follow-up (typing it, sending it) starts; the film plays that part after the "1,204 rows matched" card. */
export const CATCH_SWITCH = { toApp: C.appAt, toChat: C.chatAt, follow: 7.6 };
export const H_CATCH: Holds = [
  [3.4, 1.4], // Claude is waiting on LiteDB
  [4.75, 2.3], // the card: what it would run, and how many rows
  [5.6, 2.0], // "These aren't test accounts."
  [7.0, 1.6], // Star home again: "Stopped Claude Code..."
  [7.5, 1.4], // back in Claude: declined, nothing ran
  [9.8, 2.0], // the follow-up is sent: time to read the whole exchange
];
const PENDING = "Claude Code wants to run DELETE on users. It's waiting for your approval";
const STOPPED = "Stopped Claude Code: DELETE on users isn't allowed here";

/** 0:10.6 The ask in Claude, the card in LiteDB, the decline. */
export const Catch: React.FC = () => {
  const rt = useT();
  const t = warp(rt, H_CATCH);
  const U = (a: number) => unwarp(a, H_CATCH);
  const ASK = "delete the test accounts from users";
  const asked: Line[] = [
    { kind: "user", text: ASK },
    ...(t >= 3.0 ? ([{ kind: "say", text: "I'll remove the test accounts from users." }] as Line[]) : []),
  ];

  // --- Claude: type, send ---
  if (t < C.appAt) {
    const sent = t >= C.sendAt;
    const close = t < C.wideAt;
    const lines: Line[] = sent ? [...asked, ...(t >= 3.3 ? ([{ kind: "tool", text: "Run SQL", state: "run" }] as Line[]) : [])] : [];
    const cam = chatCam(close);
    return (
      <AbsoluteFill style={{ background: P.paper }}>
        <ClaudeDesktop
          cam={cam}
          lines={lines}
          input={sent ? "" : typed(ASK, t, C.typeAt, 21)}
          caret={!sent || Math.floor(rt * 2) % 2 === 0}
          running={sent}
          press={pressAt(t, C.sendAt)}
          cursor={sendCursor(rt, U, C.glideAt)}
        />
      </AbsoluteFill>
    );
  }

  // --- LiteDB: the card, the rows, Decline ---
  if (t < C.chatAt) {
    const btn = DIALOG_BUTTONS(BAD.length).decline;
    const box = btnBox(btn, 83);
    const f = starAt("catch", rt, U(C.chatAt), [
      { at: 0, place: perchHome(760, 776) },
      { at: U(C.openAt) + 0.03, jump: perchDialog(960, 158) },
      { at: U(C.openAt) + 0.03, look: { x: 640, y: 300 } },
      { at: U(C.rowsAt), look: { x: 560, y: 430 } },
      { at: U(C.cardAt), look: btn },
      { at: U(C.declineAt), gesture: "shake" },
      { at: U(C.declineAt) + 0.03, jump: perchHome(760, 776) },
      { at: U(C.declineAt) + 0.03, look: null },
    ]);
    const say = speech(rt, [
      [PENDING, U(C.openAt) + 0.9, U(C.declineAt)],
      [STOPPED, U(C.declineAt), U(C.declineAt) + 3.2],
    ]);
    const anchor: "right" | "center" = rt >= U(C.openAt) + 0.03 && rt < U(C.declineAt) + 0.03 ? "right" : "center";
    const dlg = dialogAnim(t, C.openAt, C.declineAt);
    // the shots: wide, the rows, then straight to a punch-in on Decline (no step back out to the card), wide again
    const rowsFocus = { x: 560, y: 440 };
    let cam: Cam;
    if (t < C.rowsAt) cam = WIDE;
    // the rows are a wide target, so this punch-in stops at 2.6x rather than the button punch of 2.48x
    else if (t < C.cardAt) cam = punchIn(WIDE, rowsFocus, 2.6 / WIDE.s);
    else if (t < C.wide2At) cam = punchIn(CARD, btn);
    else cam = WIDE;
    // the cursor comes in from below the card, lands on Decline, rests, clicks
    const cur = t >= C.cardAt ? glide(rt, U(C.cardAt), C.landAt - C.cardAt, { x: 1010, y: 790 }, { x: btn.x + 6, y: btn.y + 4 }) : null;
    const cap = p(t, 5.05, 5.2) * (1 - p(t, 5.6, 5.72));
    return (
      <AbsoluteFill style={{ background: P.paper }}>
        <Stage cam={cam}>
          <AppFrame
            view="table"
            table={{ table: "users", count: "48,213", rows: USERS }}
            rig={{ f, say, anchor }}
            scrim={dlg.o}
            cursor={cur ? { ...cur, hand: over(cur, box) } : null}
          >
            {dlg.o > 0 ? (
              <ApprovalDialog
                sql={BAD_SQL}
                affected="1,204"
                rows={BAD}
                rowShow={(i) => p(t, 4.25 + i * 0.06, 4.5 + i * 0.06)}
                mark={(i) => p(t, 4.85 + i * 0.1, 5.1 + i * 0.1)}
                expires="4:56"
                hot={cur && over(cur, box) && t < C.declineAt + 0.05 ? "decline" : undefined}
                press={{ decline: pressAt(t, C.declineAt) }}
                o={dlg.o}
                s={dlg.s}
                dy={dlg.dy * 500}
              />
            ) : null}
          </AppFrame>
        </Stage>
        {cap > 0 ? (
          <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: 110, background: `linear-gradient(to top, rgba(5,5,6,${0.92 * cap}) 0%, rgba(5,5,6,${0.75 * cap}) 28%, rgba(5,5,6,0) 52%)` }}>
            <div style={{ ...headline, fontSize: 96, color: P.fg, display: "flex", gap: "0.24em", opacity: cap }}>
              <PopWord t={t} at={5.02} text="These" />
              <PopWord t={t} at={5.06} text="aren't" />
              <PopWord t={t} at={5.1} text="test" color={P.key} />
              <PopWord t={t} at={5.14} text="accounts." />
            </div>
          </AbsoluteFill>
        ) : null}
      </AbsoluteFill>
    );
  }

  // --- Claude again: declined, the follow-up ---
  const NEXT = "only the ones on @test.local";
  const sent = t >= C.nextSend;
  const close = t >= CATCH_SWITCH.follow && t < C.nextWide;
  const lines: Line[] = [
    { kind: "user", text: ASK },
    { kind: "say", text: "I'll remove the test accounts from users." },
    { kind: "tool", text: "Run SQL", state: "fail" },
    ...(t >= 7.45 ? ([{ kind: "say", text: "You declined it in LiteDB, so nothing ran. Which accounts should go?" }] as Line[]) : []),
    ...(sent ? ([{ kind: "user", text: NEXT }, { kind: "tool", text: "Run SQL", state: "run" }] as Line[]) : []),
  ];
  const cam = close ? CHAT_CLOSE : DESKTOP_READ;
  return (
    <AbsoluteFill style={{ background: P.paper }}>
      <ClaudeDesktop
        cam={cam}
        lines={lines}
        input={sent ? "" : typed(NEXT, t, C.nextType, 24)}
        caret={!sent || Math.floor(rt * 2) % 2 === 0}
        running={sent}
        press={pressAt(t, C.nextSend)}
        cursor={sendCursor(rt, U, C.nextGlide)}
      />
    </AbsoluteFill>
  );
};

/** The matched rows drifting around the numbers: real customers '%test%' caught, and one real test account. */
const ROW_CHIPS: { x: number; y: number; id: number; email: string; hit: string; test?: boolean }[] = [
  { x: 150, y: 175, id: 1042, email: "contest.winner@orbitmail.net", hit: "test" },
  { x: 700, y: 52, id: 5121, email: "protest.signs@inkwell.org", hit: "test" },
  { x: 1210, y: 140, id: 2210, email: "latest.orders@kettlebrew.co", hit: "test" },
  { x: 240, y: 820, id: 3318, email: "giulia.testa@casaverde.it", hit: "test" },
  { x: 1180, y: 830, id: 48102, email: "qa+checkout@test.local", hit: "@test.local", test: true },
];

const RowChip: React.FC<{ id: number; email: string; hit: string; test?: boolean; mark: number }> = ({ id, email, hit, test, mark }) => {
  const at = email.indexOf(hit);
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 22, padding: "14px 22px", background: "#18181b", border: "1.5px solid #2a2a2c", borderRadius: 12, fontFamily: mono, fontSize: 24, fontWeight: 600, color: P.text, whiteSpace: "nowrap", boxShadow: "0 18px 40px rgba(0,0,0,0.45)" }}>
      <span style={{ color: P.textFaint, fontWeight: 500 }}>{id}</span>
      <span>
        {email.slice(0, at)}
        <span
          style={{
            background: test ? `rgba(76,195,138,${0.28 * mark})` : `rgba(229,72,77,${0.35 * mark})`,
            color: mark > 0.5 ? (test ? "#a6f0c9" : "#ffb4b6") : undefined,
            borderRadius: 4,
          }}
        >
          {hit}
        </span>
        {email.slice(at + hit.length)}
      </span>
    </div>
  );
};

const ROWS_L2 = "Only 37 were tests.";
/** The pause starts once the second line has finished typing. */
export const H_TITLE_ROWS: Holds = [[typedEnd(ROWS_L2, 0.05, 11) + 0.12, 0.9]];

/** 0:19.6 The numbers behind the decline, with the rows they count drifting around them. */
export const TitleRows: React.FC = () => {
  const rt = useT();
  const t = warp(rt, H_TITLE_ROWS);
  return (
    <AbsoluteFill style={{ background: P.ink }}>
      {/* the intro's dot grid, under the card's text */}
      <DotField t={rt} color="#ffffff" opacity={0.07} />
      <TitleCard t={t} l1="1,204 rows matched." l2={ROWS_L2} size={120} bg="transparent" />
      {ROW_CHIPS.map((c, i) => (
        <div
          key={c.id}
          style={{
            position: "absolute",
            left: c.x + Math.sin(rt * 1.3 + i) * 18,
            top: c.y + Math.cos(rt * 1.1 + i * 1.7) * 14,
            transform: `scale(${Math.max(0, spr(t, 0.05 + i * 0.07, 0.5, 0.8))})`,
            transformOrigin: "50% 50%",
          }}
        >
          <RowChip {...c} mark={p(t, 0.35 + i * 0.07, 0.6 + i * 0.07)} />
        </div>
      ))}
    </AbsoluteFill>
  );
};

const auditList = (t: number, from: number, extra?: Partial<AuditItem>): AuditItem[] =>
  [
    { who: "Claude Code", kind: "write", decision: "Approved", policy: "guarded", time: "10:14 AM", sql: GOOD_SQL, foot: "sqlite:shop.db", footMid: "37 rows changed", right: "undo", ...extra },
    { who: "Claude Code", kind: "write", decision: "Declined", policy: "guarded", time: "10:13 AM", sql: BAD_SQL, foot: "sqlite:shop.db", footMid: "~1,204 rows predicted", right: "did not run" },
    { who: "Cursor", kind: "read", decision: "Ran without a prompt", policy: "guarded", time: "10:09 AM", sql: "SELECT count(*) FROM orders WHERE status = 'open'", foot: "sqlite:shop.db", footMid: "1 row" },
  ].map((e, i) => {
    const a = p(t, from + i * 0.15, from + 0.35 + i * 0.15);
    return { ...(e as AuditItem), opacity: a, dy: (1 - a) * -14 };
  });

// Fix, on its own clock.
const F = {
  openAt: 0.1,
  cursorAt: 1.05,
  punchAt: 1.4, // punch-in on Approve, 0.2 s before the cursor lands
  landAt: 1.6,
  approveAt: 1.6 + CLICK.dwell, // 1.93
  wideAt: 1.93 + CLICK.after, // 2.23
  chatAt: 2.4, // wall transition to Claude
  auditAt: 3.0, // wall transition to the audit log
};
export const FIX_LEN = 4.6;
export const FIX_SWITCH = { toChat: F.chatAt, toAudit: F.auditAt };
export const H_FIX: Holds = [
  [1.0, 1.8], // the card: 37 rows, every one on @test.local
  [2.3, 1.0], // Star lands home
  [2.7, 1.4], // Claude: done, 37 rows
  [3.8, 0.8], // the audit log
];

/** 0:22 The fix: 37 rows, approve, executed, the audit entry. */
export const Fix: React.FC = () => {
  const rt = useT();
  const t = warp(rt, H_FIX);
  const U = (a: number) => unwarp(a, H_FIX);
  if (t < F.chatAt) {
    const btn = DIALOG_BUTTONS(GOOD.length).approve;
    const box = btnBox(btn, 89);
    let cam: Cam;
    if (t < F.punchAt) cam = WIDE;
    else if (t < F.wideAt) cam = punchIn(WIDE, btn);
    else cam = WIDE;
    const dlg = dialogAnim(t, F.openAt, F.approveAt);
    const f = starAt("fix", rt, U(F.chatAt), [
      { at: 0, place: perchHome(760, 776) },
      { at: U(F.openAt) + 0.03, jump: perchDialog(960, 158) },
      { at: U(F.openAt) + 0.03, look: { x: 560, y: 420 } },
      { at: U(F.cursorAt), look: btn },
      { at: U(F.approveAt), gesture: "nod" },
      { at: U(F.approveAt) + 0.03, jump: perchHome(760, 776) },
      { at: U(F.approveAt) + 0.03, look: null },
    ]);
    const say = speech(rt, [[PENDING, U(F.openAt) + 0.9, U(F.approveAt)]]);
    const anchor: "right" | "center" = rt >= U(F.openAt) + 0.03 && rt < U(F.approveAt) + 0.03 ? "right" : "center";
    const cur = t >= F.cursorAt ? glide(rt, U(F.cursorAt), F.landAt - F.cursorAt, { x: 1110, y: 790 }, { x: btn.x + 6, y: btn.y + 4 }) : null;
    return (
      <AbsoluteFill style={{ background: P.paper }}>
        <Stage cam={cam}>
          <AppFrame
            view="table"
            table={{ table: "users", count: "48,213", rows: USERS }}
            rig={{ f, say, anchor }}
            scrim={dlg.o}
            cursor={cur ? { ...cur, hand: over(cur, box) } : null}
          >
            {dlg.o > 0 ? (
              <ApprovalDialog
                sql={GOOD_SQL}
                affected="37"
                rows={GOOD}
                rowShow={(i) => p(t, 0.3 + i * 0.06, 0.55 + i * 0.06)}
                mark={(i) => p(t, 0.5 + i * 0.04, 0.7 + i * 0.04)}
                expires="4:58"
                hot={cur && over(cur, box) && t < F.approveAt + 0.05 ? "approve" : undefined}
                press={{ approve: pressAt(t, F.approveAt) }}
                o={dlg.o}
                s={dlg.s}
                dy={dlg.dy * 330}
              />
            ) : null}
          </AppFrame>
        </Stage>
      </AbsoluteFill>
    );
  }
  if (t < F.auditAt) {
    const lines: Line[] = [
      { kind: "user", text: "only the ones on @test.local" },
      { kind: "tool", text: "Run SQL", state: "ok" },
      ...(t >= 2.55 ? ([{ kind: "say", text: "Done. 37 rows changed, every one on @test.local." }] as Line[]) : []),
    ];
    return (
      <AbsoluteFill style={{ background: P.paper }}>
        <ClaudeDesktop cam={DESKTOP_READ} lines={lines} input="" caret={Math.floor(rt * 2) % 2 === 0} cursor={{ ...CHAT_REST }} />
      </AbsoluteFill>
    );
  }
  // The audit log, on the clock this part had before.
  const tt = t + 1.4;
  const V = (a: number) => U(a - 1.4);
  const cam = { x: 960, y: 450, s: 1.45 };
  const f = starAt("fix-audit", rt, V(6.0) + 3, [
    { at: 0, place: perchHome(760, 776) },
    { at: V(4.5), look: { x: 1100, y: 300 } },
    { at: V(4.6), gesture: "nod" },
  ]);
  const say = speech(rt, [["Claude Code changed 37 rows in users", V(4.6), V(4.6) + 3.2]]);
  return (
    <AbsoluteFill style={{ background: P.paper }}>
      <Stage cam={cam}>
        <AppFrame view="sql" sql={{ code: "SELECT * FROM users LIMIT 10;", audit: auditList(tt, 4.45) }} rig={{ f, say }} />
      </Stage>
    </AbsoluteFill>
  );
};

// Split, on its own clock: the audit entry's Undo, then the dialog's Undo.
const S = {
  second: 2.1, // "Changed your mind?"
  entryIn: 2.1, // the cursor heads for the audit entry's Undo
  entryPunch: 2.35,
  entryLand: 2.55,
  entryClick: 2.55 + CLICK.dwell, // 2.88: the Undo dialog opens
  alertAt: 2.88 + CLICK.after, // 3.18: cut to the dialog
  undoIn: 3.2,
  undoPunch: 3.45,
  undoLand: 3.65,
  undoClick: 3.65 + CLICK.dwell, // 3.98: the rows come back
  wideAt: 3.98, // on the click: straight to the wide shot as the rows come back
};
export const SPLIT_LEN = 5.1;
export const H_SPLIT: Holds = [
  [1.6, 1.0], // "Every write. Logged."
  [3.2, 1.2], // "Undo this write? Puts back 37 rows..."
  [4.4, 1.4], // the rows are back
];
const AUDIT_UNDO = { x: 1225, y: 417 };
const AUDIT_UNDO_BOX = { x: 1195, y: 405, w: 60, h: 24 };
const UNDO_BOX = { x: 746, y: 394, w: 90, h: 40 };

/** 0:28 Split: dark title on the left third, the app on the right. */
export const Split: React.FC = () => {
  const rt = useT();
  const t = warp(rt, H_SPLIT);
  const U = (a: number) => unwarp(a, H_SPLIT);
  const second = t >= S.second;
  const lt = second ? t - S.second : t;
  const l2 = second ? "Undo." : "Logged.";
  const end = typedEnd(l2, 0.05, 9);
  const RX = 640 + 640;
  const undoDlg = dialogAnim(t, S.entryClick, S.undoClick);
  const restored = t >= S.undoClick;
  // Star stays home under the overlay; it glances at the Undone toast when it appears.
  const splitStar = starAt("split", rt, U(SPLIT_LEN), [
    { at: 0, place: perchHome(760, 776) },
    { at: U(S.undoClick) + 0.1, look: { x: 640, y: 73 } },
    { at: U(S.undoClick) + 1.0, look: null },
  ]);
  // the shots: the audit panel, a punch-in on the entry's Undo, the dialog, a punch-in on its Undo, wide
  const camA: Cam = { x: 1110, y: 360, s: 1.7 };
  const camAlert: Cam = { x: 640, y: 400, s: 1.45 };
  const camB: Cam = { x: 640, y: 380, s: 1.18 };
  let cam: Cam;
  if (t < S.entryPunch) cam = camA;
  else if (t < S.alertAt) cam = punchIn(camA, AUDIT_UNDO);
  else if (t < S.undoPunch) cam = camAlert;
  else if (t < S.wideAt) cam = punchIn(camAlert, UNDO_BUTTON);
  else cam = camB;
  // the cursor
  let cur: CursorState | null = null;
  if (t >= S.entryIn && t < S.alertAt) {
    const q = glide(rt, U(S.entryIn), S.entryLand - S.entryIn, { x: 1210, y: 700 }, { x: AUDIT_UNDO.x + 4, y: AUDIT_UNDO.y + 3 });
    cur = { ...q, hand: over(q, AUDIT_UNDO_BOX) };
  } else if (t >= S.alertAt && t < S.wideAt) {
    const q = t < S.undoIn ? { x: 1010, y: 560 } : glide(rt, U(S.undoIn), S.undoLand - S.undoIn, { x: 1010, y: 560 }, { x: UNDO_BUTTON.x + 4, y: UNDO_BUTTON.y + 3 });
    cur = { ...q, hand: over(q, UNDO_BOX) };
  }
  const washFrom = U(4.75);
  const rows: GridRow[] = USERS.slice(0, 4).concat(
    ["qa+checkout@test.local", "qa+refunds@test.local", "seed-user-07@test.local", "load-test-3@test.local", "e2e-signup@test.local"].map((m, i) => {
      const e = p(rt, U(4.05) + i * 0.07, U(4.05) + 0.35 + i * 0.07);
      return { id: 48102 + i * 4, name: "Test User", email: m, created: "2026-10-02", enter: e, tint: `rgba(76,195,138,${0.16 * (1 - p(rt, washFrom, washFrom + 0.6))})` };
    }),
    USERS.slice(4, 14),
  );
  return (
    <AbsoluteFill style={{ background: P.paper }}>
      <div style={{ position: "absolute", left: 640, top: 0, right: 0, bottom: 0, overflow: "hidden" }}>
        <div style={{ position: "absolute", left: -640 }}>
          <Stage cam={cam} cx={RX}>
            {restored ? (
              <AppFrame view="table" table={{ table: "users", count: "48,213", rows }} rig={{ f: splitStar }} cursor={cur}>
                <Toast title="Undone" body="Puts back 37 rows deleted from users." o={p(t, 4.0, 4.2) * (1 - p(t, 4.95, 5.1))} />
              </AppFrame>
            ) : (
              <AppFrame
                view="sql"
                sql={{ code: "SELECT * FROM users LIMIT 10;", audit: auditList(t, 0.1, { hotUndo: !!cur && over(cur, AUDIT_UNDO_BOX) }) }}
                rig={{ f: splitStar }}
                scrim={undoDlg.o}
                cursor={cur}
              >
                {undoDlg.o > 0 ? <UndoAlert o={undoDlg.o} hot={!!cur && over(cur, UNDO_BOX)} press={pressAt(t, S.undoClick)} /> : null}
              </AppFrame>
            )}
          </Stage>
        </div>
      </div>
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 640, background: P.card, display: "grid", placeItems: "center" }}>
        <div style={{ ...headline, fontSize: 96, textAlign: "center" }}>
          {second ? (
            <>
              <div style={{ color: P.fg }}>Changed</div>
              <div style={{ color: P.fg }}>your mind?</div>
            </>
          ) : (
            <div style={{ color: P.fg }}>Every write.</div>
          )}
          <div style={{ color: P.muted }}>
            {typed(l2, lt, 0.05, 9)}
            <Caret t={lt} idleFrom={end} />
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
