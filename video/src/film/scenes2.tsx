// 0:32.5 to 1:08.5 of the launch film: connect, schema, ask, the system, the end card.
import React from "react";
import { AbsoluteFill } from "remotion";
import { AppIcon } from "../launch/art";
import { APP_H, APP_W, AppFrame, ApprovalDialog, dialogAnim, GENERATE_BUTTON, TextToSql, TTS_TOP } from "./app";
import { perchDialog, perchHome, speech, starAt, StarEvent } from "./rig";
import { fitView, lerpViewport, SCHEMA_CARD_BG, SCHEMA_CARD_BORDER, SCHEMA_LAYOUT_BUTTON, SCHEMA_PYRAMID_ITEM, SchemaNode, SchemaView, schemaNodes } from "./schema";
import { over } from "./cursor";
import { CLICK, glide, glideEase, punchIn } from "./motion";
import { BrandGlyph, BrandId, brandName, BrandTile } from "./brands";
import {
  Caret,
  Cam,
  Holds,
  typedEnd,
  unwarp,
  warp,
  DotField,
  dotted,
  E,
  H,
  hash,
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
  toScreen,
  useT,
  W,
} from "./kit";
import { ClaudeDesktop, DESKTOP_READ, Line } from "./desktop";
import { PopWord, TitleCard } from "./ui";
import { USERS } from "./scenes1";

const Snippet: React.FC<{ title: string; body: string }> = ({ title, body }) => (
  <div style={{ width: 380, background: "#141414", borderRadius: 16, border: "1px solid #2a2a2c", boxShadow: "0 18px 40px rgba(0,0,0,0.5)", overflow: "hidden" }}>
    <div style={{ fontFamily: sans, fontSize: 18, padding: "11px 16px", color: P.textSoft, borderBottom: "1px solid #2a2a2c" }}>{title}</div>
    <pre style={{ margin: 0, padding: "13px 16px", fontFamily: mono, fontSize: 16, lineHeight: 1.5, color: P.text }}>{body}</pre>
  </div>
);
const Note: React.FC<{ text: string }> = ({ text }) => (
  <div style={{ width: 172, height: 172, background: "#f7e27a", boxShadow: "0 14px 24px rgba(0,0,0,0.45)", display: "grid", placeItems: "center", fontFamily: "'Segoe Print', 'Comic Sans MS', cursive", fontSize: 21, color: "#2a2a2a", textAlign: "center", padding: 16, boxSizing: "border-box", transform: "rotate(-3deg)" }}>
    {text}
  </div>
);
const Chip: React.FC<{ id: BrandId; label?: string }> = ({ id, label }) => (
  <div style={{ display: "inline-flex", alignItems: "center", gap: 11, padding: "12px 18px", borderRadius: 14, background: "#18181b", border: "1px solid #2a2a2c", fontFamily: sans, fontSize: 24, fontWeight: 500, color: P.text, boxShadow: "0 14px 30px rgba(0,0,0,0.45)" }}>
    <BrandGlyph id={id} size={26} />
    {label ?? brandName(id)}
  </div>
);

// Nothing sits in the headline's band (y 440 to 640), so the words never cross an icon.
const CLOUD: { x: number; y: number; z: number; node: React.ReactNode }[] = [
  { x: 430, y: 120, z: 1.0, node: <BrandTile id="claude" size={170} /> },
  { x: 90, y: 350, z: 0.8, node: <Chip id="claude" label="Claude Code" /> },
  { x: 70, y: 120, z: 1.1, node: <Note text="no Node needed" /> },
  { x: 1460, y: 40, z: 1.2, node: <Snippet title="claude_desktop_config.json" body={'{\n  "mcpServers": {\n    "litedb": {\n      "command": "LiteDB",\n      "args": ["--mcp"]'} /> },
  { x: 1700, y: 250, z: 0.9, node: <BrandTile id="cursor" size={150} /> },
  { x: 1620, y: 760, z: 1.1, node: <BrandTile id="vscode" size={160} /> },
  { x: -20, y: 700, z: 1.0, node: <Snippet title="Terminal" body={"claude mcp add litedb \\\n  -- LiteDB --mcp"} /> },
  { x: 520, y: 860, z: 0.9, node: <BrandTile id="opencode" size={140} /> },
  { x: 1050, y: 880, z: 1.0, node: <Chip id="vscode" /> },
  { x: 1120, y: 110, z: 0.8, node: <Chip id="claude" label="Claude Desktop" /> },
  { x: 1290, y: 720, z: 1.0, node: <Chip id="cursor" /> },
  { x: 790, y: 70, z: 0.9, node: <AppIcon size={130} /> },
  { x: 1400, y: 900, z: 1.2, node: <Note text="writes wait for Approve" /> },
  { x: 800, y: 950, z: 0.8, node: <Chip id="opencode" /> },
];

/** 0:57 "Connect Claude Code. / Cursor. / VS Code. / your agents." in a drifting cloud of real icons. */
// Each name flips in like a box doing a backflip, as the voice says it:
// "It works with Claude Code, Cursor, VS Code, and the agents you already use."
const AGENT_WORDS = ["Claude Code.", "Cursor.", "VS Code.", "your agents."];
const FLIPS = [0.8, 1.72, 2.36, 3.28];
const FLIP_DUR = 0.42;

/** The word slot: a box that turns over backwards to show the next name. */
const FlipWord: React.FC<{ t: number }> = ({ t }) => {
  let i = -1;
  for (let k = 0; k < FLIPS.length; k++) if (t >= FLIPS[k]) i = k;
  const k = i < 0 ? 0 : glideEase(Math.min(1, (t - FLIPS[i]) / FLIP_DUR));
  const h = 1.15; // em, the box's height
  const face = (word: string, angle: number, key: string) => (
    <div
      key={key}
      style={{
        gridArea: "1 / 1",
        justifySelf: "start",
        whiteSpace: "nowrap",
        backfaceVisibility: "hidden",
        // flat once it has landed: a 3D transform at rest renders soft
        transform: angle === 0 ? undefined : `translateZ(-${h / 2}em) rotateX(${angle}deg) translateZ(${h / 2}em)`,
        opacity: Math.abs(angle) >= 89.5 ? 0 : 1 - Math.abs(angle) / 140,
      }}
    >
      {word}
    </div>
  );
  return (
    <span style={{ display: "inline-grid", verticalAlign: "top", perspective: "6em", transformStyle: "preserve-3d", height: `${h}em`, lineHeight: `${h}em` }}>
      {/* every name, unseen, so the slot is as wide as the longest and "Connect" never moves */}
      {AGENT_WORDS.map((w) => (
        <div key={"m" + w} style={{ gridArea: "1 / 1", visibility: "hidden", whiteSpace: "nowrap" }}>
          {w}
        </div>
      ))}
      {i >= 1 ? face(AGENT_WORDS[i - 1], k * 90, "out") : null}
      {i >= 0 ? face(AGENT_WORDS[i], (k - 1) * 90, "in") : null}
    </span>
  );
};

export const Connect: React.FC = () => {
  const t = useT();
  const gather = p(t, 6.1, 6.8, E.in);
  return (
    <AbsoluteFill style={{ background: P.paper, overflow: "hidden" }}>
      {CLOUD.map((f, i) => {
        const z = 1 + t * 0.022 * f.z;
        const appear = spr(t, 0.05 + i * 0.05, 0.5, 0.8);
        const x = lerp(W / 2 + (f.x - W / 2) * z, W / 2 - 80, gather);
        const y = lerp(H / 2 + (f.y - H / 2) * z, H / 2 - 80, gather);
        return (
          <div key={i} style={{ position: "absolute", left: x, top: y, transform: `scale(${appear * (1 - 0.7 * gather)})`, opacity: 1 - gather, filter: f.z < 0.85 ? "blur(1.5px)" : undefined }}>
            {f.node}
          </div>
        );
      })}
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: 1 - p(t, 6.0, 6.3, E.in) }}>
        <div style={{ ...headline, fontSize: 150, color: P.text, textShadow: "0 0 40px #0b0b0c, 0 0 80px #0b0b0c", display: "flex", alignItems: "flex-start", gap: "0.24em" }}>
          <span style={{ lineHeight: "1.15em" }}>Connect</span>
          <FlipWord t={t} />
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** 0:39.3 "Schema becomes context" in dot-matrix letters, then it dissolves to blue. */
export const PixelWords: React.FC = () => {
  const t = useT();
  const inA = p(t, 0, 0.35);
  const out = p(t, 1.7, 2.2, E.in);
  const color = out > 0.3 ? P.key : "#8a8a92";
  const dots: React.ReactNode[] = [];
  for (let i = 0; i < 70; i++) {
    const a = hash(i) * Math.PI * 2;
    const r = 380 + hash(i + 9) * 420;
    dots.push(
      <div key={i} style={{ position: "absolute", left: W / 2 + Math.cos(a) * r * 1.3, top: H / 2 + Math.sin(a) * r * 0.55, width: 9, height: 9, background: color, opacity: hash(i * 3 + Math.floor(t * 6)) < 0.75 ? inA * 0.6 : 0 }} />,
    );
  }
  return (
    <AbsoluteFill style={{ background: P.paper, alignItems: "center", justifyContent: "center" }}>
      {dots}
      <div
        style={{
          ...headline,
          ...dotted(color, 11),
          fontFamily: mono,
          fontWeight: 500,
          letterSpacing: "-0.02em",
          fontSize: 210,
          lineHeight: 0.98,
          textAlign: "center",
          opacity: inA * (1 - out),
          transform: `scale(${1 - out * 0.5})`,
          filter: inA < 1 ? `blur(${(1 - inA) * 8}px)` : undefined,
        }}
      >
        {"Schema\nbecomes\ncontext"}
      </div>
    </AbsoluteFill>
  );
};

/** 0:41.5 The Schema Visualizer, then the agents that can see it. */
export const H_TABLES: Holds = [[2.75, 0.3], [4.1, 0.8]];
export const TABLES_LEN = 4.25;
/** The hand-off: the table nodes lift off the schema and fly into the agent tiles. */
const HANDOFF = 0.85;
// Schema, on its own clock: Layout, Pyramid, and the view glides to fit (fitView, 800 ms).
const SCH = {
  punchAt: 0.35, // punch-in on Layout, 0.2 s before the cursor lands
  landAt: 0.55,
  layoutClick: 0.55 + CLICK.dwell, // 0.88: the menu opens
  toPyramid: 0.88 + CLICK.after, // 1.18
  pyramidLand: 1.58,
  pyramidClick: 1.58 + CLICK.dwell, // 1.91: Pyramid; the nodes move and the view glides
  wideAt: 1.91 + CLICK.after, // 2.21
  cardAt: 3.0,
};
const LAYOUT_BOX = { x: 1130, y: 99, w: 135, h: 36 };
const PYRAMID_BOX = { x: 1045, y: 249, w: 216, h: 32 };
const SCHEMA_WIDE: Cam = { x: 780, y: 420, s: 1.5 };
export const Tables: React.FC = () => {
  const rt = useT();
  const t0 = warp(rt, H_TABLES);
  const U = (a: number) => unwarp(a, H_TABLES);
  const schemaShot = (t: number, hideNodes = false) => {
    const L = SCHEMA_LAYOUT_BUTTON;
    let cam: Cam;
    if (t < SCH.punchAt) cam = SCHEMA_WIDE;
    else if (t < SCH.wideAt) cam = punchIn(SCHEMA_WIDE, L);
    else cam = { x: 760, y: 430, s: 1.55 };
    const pyramid = t >= SCH.pyramidClick;
    const g0 = U(SCH.pyramidClick) + 0.01;
    const vp = pyramid ? lerpViewport(fitView("default"), fitView("pyramid"), p(rt, g0, g0 + 0.8, (x) => x)) : fitView("default");
    const menu = t < SCH.layoutClick ? 0 : t < SCH.pyramidClick ? p(t, SCH.layoutClick, SCH.layoutClick + 0.15, (x) => x) : 1 - p(t, SCH.pyramidClick, SCH.pyramidClick + 0.15, (x) => x);
    const P_PT = SCHEMA_PYRAMID_ITEM;
    let q: { x: number; y: number };
    if (t < SCH.toPyramid) q = glide(rt, U(0), SCH.landAt, { x: 980, y: 520 }, { x: L.x + 6, y: L.y + 4 });
    else if (t < SCH.wideAt) q = glide(rt, U(SCH.toPyramid), SCH.pyramidLand - SCH.toPyramid, { x: L.x + 6, y: L.y + 4 }, { x: P_PT.x + 10, y: P_PT.y - 6 });
    else q = glide(rt, U(SCH.wideAt), 0.6, { x: P_PT.x + 10, y: P_PT.y - 6 }, { x: 1010, y: 470 });
    const onLayout = over(q, LAYOUT_BOX);
    const onPyramid = menu > 0.5 && over(q, PYRAMID_BOX);
    const f = starAt("schema", rt, U(SCH.cardAt), [
      { at: 0, place: perchHome(760, 776) },
      { at: 0.1, look: L },
      { at: U(SCH.toPyramid), look: P_PT },
      { at: U(SCH.pyramidClick), look: { x: 880, y: 360 } },
    ]);
    return (
      <AbsoluteFill style={{ background: P.paper }}>
        <Stage cam={cam}>
          <AppFrame
            view="schema"
            schema={<SchemaView layout={pyramid ? "pyramid" : "default"} vp={vp} menu={menu} hotPyramid={onPyramid} hotLayout={onLayout} hideNodes={hideNodes} />}
            rig={{ f }}
            // the same hand that clicked Layout clicks Pyramid
            cursor={{ ...q, hand: onLayout || onPyramid }}
          />
        </Stage>
      </AbsoluteFill>
    );
  };
  if (t0 < SCH.cardAt) return schemaShot(t0);
  const h = t0 - SCH.cardAt;
  if (h < HANDOFF) {
    // the schema falls back and fades while its nodes fly to the card
    const bg = p(h, 0.05, 0.4);
    return (
      <AbsoluteFill style={{ background: P.paper }}>
        <AbsoluteFill style={{ opacity: 1 - bg, transform: `scale(${1 - 0.06 * bg})` }}>{schemaShot(SCH.cardAt - 0.001, true)}</AbsoluteFill>
        <AgentsCard a={p(h, 0.25, 0.5)} more={0} tiles={false} />
        {HAND_OFF.map(({ name, slot, keep }, i) => (
          <Flyer key={name} name={name} slot={slot} keep={keep} h={h} at={0.04 + i * 0.035} />
        )).sort((x, y) => Number(x.props.keep) - Number(y.props.keep))}
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill style={{ background: P.paper }}>
      <AgentsCard a={1} more={p(h - HANDOFF, 0, 0.2)} tiles />
    </AbsoluteFill>
  );
};

// The card, in screen px, laid out absolutely so the flying nodes land exactly on its tiles.
const CARD = { x: 210, y: 280, w: 1500, h: 520 };
const TILE = 150;
const AGENT_IDS: BrandId[] = ["claude", "cursor", "vscode", "opencode"];
const slotAt = (i: number) => ({ x: 90 + i * (TILE - 26), y: 231 });
/** Six tables into four tiles: four become the tiles, two merge into a neighbour on the way. Left to right, so they leave in order. */
const HAND_OFF: { name: string; slot: number; keep: boolean }[] = [
  { name: "big_orders", slot: 0, keep: true },
  { name: "orders", slot: 1, keep: true },
  { name: "customers", slot: 1, keep: false },
  { name: "order_items", slot: 2, keep: true },
  { name: "products", slot: 2, keep: false },
  { name: "users", slot: 3, keep: true },
];
const SCHEMA_END_CAM: Cam = { x: 760, y: 430, s: 1.55 };
const TILE_BG = "#1f1f22";

const AgentsCard: React.FC<{ a: number; more: number; tiles: boolean }> = ({ a, more, tiles }) => (
  <div style={{ position: "absolute", left: CARD.x, top: CARD.y, width: CARD.w, height: CARD.h, boxSizing: "border-box", background: "#141414", border: "1px solid #232325", borderRadius: 60, fontFamily: sans, opacity: a, transform: `scale(${0.96 + 0.04 * a})` }}>
    <div style={{ position: "absolute", left: 90, top: 70, fontSize: 76, lineHeight: "91px", color: P.textFaint, letterSpacing: "-0.03em" }}>Agents</div>
    {tiles
      ? AGENT_IDS.map((id, i) => (
          <div key={id} style={{ position: "absolute", left: slotAt(i).x, top: slotAt(i).y }}>
            <BrandTile id={id} size={TILE} bg={TILE_BG} />
          </div>
        ))
      : null}
    <span style={{ position: "absolute", left: slotAt(3).x + TILE + 40, top: slotAt(0).y + TILE / 2 - 45.5, fontSize: 76, lineHeight: "91px", color: P.textSoft, opacity: more, letterSpacing: "-0.03em", whiteSpace: "nowrap" }}>+ Claude Desktop</span>
  </div>
);

/** One table node on its way from the schema to a tile. */
const Flyer: React.FC<{ name: string; slot: number; keep: boolean; h: number; at: number }> = ({ name, slot, keep, h, at }) => {
  const n = schemaNodes("pyramid", fitView("pyramid")).find((q) => q.name === name)!;
  const s0 = toScreen(SCHEMA_END_CAM, n.x, n.y);
  const S = { x: s0.x, y: s0.y, w: n.w * SCHEMA_END_CAM.s, h: n.h * SCHEMA_END_CAM.s };
  const sl = slotAt(slot);
  const T_ = { x: CARD.x + 1 + sl.x, y: CARD.y + 1 + sl.y, w: TILE, h: TILE };
  // the film's cursor glide: quick off the mark, long settle
  const k = Math.min(1, Math.max(0, (h - at) / 0.6));
  const e = glideEase(k);
  const lift = 0;
  const w = S.w + (T_.w - S.w) * e;
  const hh = S.h + (T_.h - S.h) * e;
  const x = S.x + (T_.x - S.x) * e;
  const y = S.y + (T_.y - S.y) * e - 40 * Math.sin(Math.PI * e);
  const zoom = n.z * SCHEMA_END_CAM.s;
  const r = 8 * zoom + (TILE * 0.24 - 8 * zoom) * e;
  const label = 1 - p(k, 0.05, 0.4, (v) => v);
  const glyph = p(k, 0.55, 1, (v) => v);
  const o = keep ? 1 : 1 - p(k, 0.55, 0.95, (v) => v);
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: w,
        height: hh,
        boxSizing: "border-box",
        borderRadius: r,
        background: e < 0.5 ? SCHEMA_CARD_BG : TILE_BG,
        border: `${1 + 0.5 * e}px solid ${e < 0.5 ? SCHEMA_CARD_BORDER : "rgba(255,255,255,0.08)"}`,
        boxShadow: `0 ${4 + 14 * Math.max(lift, e)}px ${6 + 34 * Math.max(lift, e)}px rgba(0,0,0,${0.1 + 0.35 * Math.max(lift, e)})`,
        transform: `scale(${1 + 0.04 * lift * (1 - e)})`,
        opacity: o,
        overflow: "hidden",
      }}
    >
      <div style={{ position: "absolute", left: -1, top: -1, transformOrigin: "0 0", transform: `scale(${zoom})`, opacity: label, fontFamily: sans, color: "#fafafa" }}>
        <SchemaNode name={name} />
      </div>
      {keep ? (
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", opacity: glyph }}>
          <BrandGlyph id={AGENT_IDS[slot]} size={Math.min(w, hh) * 0.56} />
        </div>
      ) : null}
    </div>
  );
};

const ASK_L2 = "Your database answers.";
/** The pause starts once the second line has finished typing. */
export const TitleAsk: React.FC = () => <TitleCard t={warp(useT(), [[typedEnd(ASK_L2, 0.05, 11) + 0.12, 0.9]])} l1="Ask anything." l2={ASK_L2} />;

const Q = "top 5 customers by revenue last month";
const SQL = [
  "SELECT c.name, sum(o.total) AS revenue",
  "FROM orders o",
  "JOIN customers c ON c.id = o.customer_id",
  "WHERE o.created_at >= date('now', 'start of month', '-1 month')",
  "GROUP BY c.name",
  "ORDER BY revenue DESC",
  "LIMIT 5;",
].join("\n");
const RESULTS = {
  cols: ["name", "revenue"],
  rows: [
    ["Maria Lopez", "18,240.00"],
    ["Kenji Ono", "15,910.50"],
    ["Ana Reyes", "12,077.25"],
    ["Omar Haddad", "11,402.00"],
    ["Priya Nair", "9,860.75"],
  ],
  meta: "5 rows · 38 ms · read-only",
};

const STEPS = ["Reading the schema...", "Finding customers", "Joining orders", "Checking created_at", "Writing SQL", "Running read-only", "Counting rows", "Sorting by revenue", "Checking the plan", "Building the result"];

/** 0:46 Ask AI in the app: the question, the SQL, the result, how, where it runs. */
// Where things are in the app (measured from the film's own layout).
const ASK_AI = { x: 828, y: 103 };
const ASK_AI_BOX = { x: 792, y: 91, w: 72, h: 24 };
const RUN = { x: 662, y: 103 };
const RUN_BOX = { x: 628, y: 90, w: 69, h: 26 };
const GEN_BOX = { x: 424, y: TTS_TOP + 458, w: 432, h: 40 };
// Ask, on its own clock (authored seconds; holds stretch them in real time).
const A = {
  askPunch: 0.3, // punch-in on Ask AI, 0.2 s before the cursor lands
  askLand: 0.5,
  open: 0.5 + CLICK.dwell, // 0.83: Ask AI clicked, the dialog opens
  dialogAt: 0.83 + CLICK.after, // 1.13: cut to the dialog
  type: 1.9, // typing starts, once Star has landed
  genIn: 3.25,
  genPunch: 3.5,
  genLand: 3.7,
  gen: 3.7 + CLICK.dwell, // 4.03: Generate SQL clicked
  thinkAt: 4.03 + CLICK.after, // 4.33: cut back to the dialog, Star reading
  done: 4.6, // the SQL arrives: the dialog closes, Star hops home
  wideAt: 4.75, // cut wide as Star leaves the dialog
  runIn: 5.4,
  runPunch: 5.75,
  runLand: 5.95,
  run: 5.95 + CLICK.dwell, // 6.28: Run clicked
  resultsAt: 6.28 + CLICK.after, // 6.58: cut to the results
  laterAt: 8.0,
};
export const ASK_LEN = 14.5;
export const H_ASK: Holds = [[typedEnd(Q, A.type, 28), 0.8], [4.4, 1.0], [6.8, 1.3], [11.0, 0.9], [13.85, 1.4]];
const WIDE_SQL: Cam = { x: 640, y: 400, s: 1.25 };
const DIALOG: Cam = { x: 640, y: 355, s: 1.6 };
const RESULT_CAM: Cam = { x: 560, y: 560, s: 1.75 };

export const Ask: React.FC = () => {
  const rt = useT();
  const t = warp(rt, H_ASK);
  const U = (a: number) => unwarp(a, H_ASK);
  if (t < A.laterAt) {
    // the shots
    const G = GENERATE_BUTTON;
    let cam: Cam;
    if (t < A.askPunch) cam = WIDE_SQL;
    else if (t < A.dialogAt) cam = punchIn(WIDE_SQL, ASK_AI);
    else if (t < A.genPunch) cam = DIALOG;
    else if (t < A.thinkAt) cam = punchIn(DIALOG, G);
    else if (t < A.wideAt) cam = DIALOG;
    else if (t < A.runPunch) cam = WIDE_SQL;
    else if (t < A.resultsAt) cam = punchIn(WIDE_SQL, RUN);
    else cam = RESULT_CAM;
    // the cursor: Ask AI, out of the way, Generate SQL, out of the way, Run
    const REST_D = { x: 940, y: 560 };
    const REST_W = { x: 900, y: 330 };
    const off = (q: { x: number; y: number }) => ({ x: q.x + 5, y: q.y + 3 });
    let q: { x: number; y: number };
    if (t < A.dialogAt) q = glide(rt, U(0), A.askLand, { x: 880, y: 330 }, off(ASK_AI));
    else if (t < A.genIn) q = glide(rt, U(A.dialogAt), 0.6, off(ASK_AI), REST_D);
    else if (t < A.thinkAt) q = glide(rt, U(A.genIn), A.genLand - A.genIn, REST_D, off(G));
    else if (t < A.runIn) q = glide(rt, U(A.thinkAt), 0.6, off(G), REST_W);
    else if (t < A.resultsAt) q = glide(rt, U(A.runIn), A.runLand - A.runIn, REST_W, off(RUN));
    else q = glide(rt, U(A.resultsAt), 0.6, off(RUN), { x: 820, y: 330 });
    const dlg = dialogAnim(t, A.open, A.done);
    const onGen = dlg.o > 0.5 && over(q, GEN_BOX);
    const hand = over(q, ASK_AI_BOX) || over(q, RUN_BOX) || onGen;
    const typedQ = typed(Q, t, A.type, 28);
    const typedEndAt = typedEnd(Q, A.type, 28);
    const caret = (n: number) => ({ x: 436 + Math.min(408, n * 7.4), y: TTS_TOP + 108 + (n * 7.4 > 408 ? 20 : 0) });
    const events: StarEvent[] = [
      { at: 0, place: perchHome(760, 776) },
      { at: 0, look: ASK_AI },
      { at: U(A.open) + 0.03, jump: perchDialog(880, TTS_TOP) },
      { at: U(A.open) + 0.03, look: { x: 640, y: TTS_TOP + 140 } },
      ...Array.from({ length: 8 }, (_, i) => ({ at: U(A.type) + i * 0.17, look: caret(Math.round(i * 0.17 * 28)) })),
      { at: U(typedEndAt), look: caret(Q.length) },
      { at: U(A.genIn), look: G },
      { at: U(A.gen), mood: "thinking" as const },
      { at: U(A.done), mood: "happy" as const, forS: 1.6 },
      { at: U(A.done), look: null },
      { at: U(A.done) + 0.03, jump: perchHome(760, 776) },
      { at: U(A.runIn), look: RUN },
      { at: U(A.run) + 0.1, mood: "happy" as const, forS: 60 }, // smiling through the results shot
      { at: U(A.run) + 0.1, look: { x: 480, y: 560 } },
    ];
    const f = starAt("ask", rt, U(A.laterAt), events);
    const say = speech(rt, [
      ["Reading 6 tables", U(A.gen), U(A.done)],
      ["Here is your SQL", U(A.done), U(A.done) + 1.8],
    ]);
    const anchor = rt >= U(A.open) + 0.03 && rt < U(A.done) + 0.03 ? "right" : "center";
    const done = t >= A.done;
    const res = t >= A.run + 0.1;
    return (
      <AbsoluteFill style={{ background: P.paper }}>
        <Stage cam={cam}>
          <AppFrame
            view="sql"
            sql={{ code: done ? SQL : "", results: res ? RESULTS : null, hot: over(q, ASK_AI_BOX) ? "askai" : over(q, RUN_BOX) ? "run" : undefined }}
            rig={{ f, say, anchor }}
            scrim={dlg.o}
            cursor={{ ...q, hand }}
          >
            {dlg.o > 0 ? (
              <TextToSql
                prompt={typedQ}
                caret={t < typedEndAt || Math.floor(rt * 2) % 2 === 0}
                o={dlg.o}
                s={dlg.s}
                dy={dlg.dy}
                hot={onGen && t < A.gen}
                press={pressAt(t, A.gen)}
                loading={t >= A.gen}
              />
            ) : null}
          </AppFrame>
        </Stage>
      </AbsoluteFill>
    );
  }
  return <AskLater t={t - 2.0} rt={rt} U={(a) => U(a + 2.0)} />;
};

/** The rest of Ask, on the clock it had before the Text to SQL shot grew by 2.0 s. */
const AskLater: React.FC<{ t: number; rt: number; U: (a: number) => number }> = ({ t, rt, U }) => {
  if (t < 7.7) {
    const scroll = (t - 6.0) * 120;
    const cam = { x: 600, y: 330, s: 1.3 };
    return (
      <AbsoluteFill style={{ background: P.paper }}>
        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 900, overflow: "hidden" }}>
          <div style={{ position: "absolute", left: 0, width: 900, top: 170 - scroll, textAlign: "center", fontFamily: sans, fontSize: 60, letterSpacing: "-0.03em", lineHeight: 1.08 }}>
            {STEPS.map((s, i) => (
              <div key={s} style={{ color: i === Math.min(STEPS.length - 1, Math.floor((t - 6.0) * 6)) ? P.text : "#3a3a3e" }}>
                {s}
              </div>
            ))}
          </div>
        </div>
        <div style={{ position: "absolute", left: 960, top: 0, right: 0, bottom: 0, overflow: "hidden" }}>
          <div style={{ position: "absolute", left: -960 }}>
            <Stage cam={cam} cx={960 + 480}>
              <AppFrame view="sql" sql={{ code: SQL, results: RESULTS }} />
            </Stage>
          </div>
        </div>
      </AbsoluteFill>
    );
  }
  if (t < 9.6) {
    const lt = t - 7.7;
    const ids: BrandId[] = ["ollama", "sqlite", "postgres"];
    return (
      <AbsoluteFill style={{ background: P.stage }}>
        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 1060, background: P.paper, display: "grid", placeItems: "center" }}>
          <div style={{ ...headline, fontSize: 104, color: P.text, textAlign: "center" }}>
            <div>Runs on</div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 16 }}>
              <PopWord t={lt} at={0.05} text="your" color={P.text} />
              {ids.map((id, i) => (
                <span key={id} style={{ display: "inline-block", transform: `scale(${Math.max(0, spr(lt, 0.3 + i * 0.1, 0.4, 0.7))})` }}>
                  <BrandTile id={id} size={84} bg="#1f1f22" />
                </span>
              ))}
              <PopWord t={lt} at={0.65} text="machine." color={P.text} />
            </div>
          </div>
        </div>
        {/* Sized to its three rows, centred on the frame. */}
        <div style={{ position: "absolute", left: 1180, top: "50%", width: 600, background: "#141414", border: "1px solid #232325", borderRadius: 44, padding: "14px 44px", boxSizing: "border-box", fontFamily: sans, transform: `translateY(calc(-50% + ${(1 - spr(lt, 0.1, 0.6, 0.85)) * 120}px))` }}>
          {(
            [
              ["ollama", "Ollama", "llama3, on this machine"],
              ["sqlite", "SQLite", "shop.db, opened in place"],
              ["postgres", "PostgreSQL", "over SSH, read-only for agents"],
            ] as [BrandId, string, string][]
          ).map(([id, a, b], i) => (
            <div key={a} style={{ display: "flex", gap: 22, alignItems: "center", padding: "30px 0", borderBottom: i < 2 ? "1px solid #232325" : undefined, opacity: p(lt, 0.3 + i * 0.15, 0.6 + i * 0.15) }}>
              <BrandTile id={id} size={76} bg="#1f1f22" />
              <div>
                <div style={{ fontSize: 30, fontWeight: 600, color: P.text }}>{a}</div>
                <div style={{ fontSize: 22, color: P.textSoft }}>{b}</div>
              </div>
            </div>
          ))}
        </div>
      </AbsoluteFill>
    );
  }
  const lt = t - 9.6;
  const lrt = rt - U(9.6);
  const lines: Line[] = [
    { kind: "user", text: "only the ones on @test.local" },
    { kind: "tool", text: "Run SQL", state: "ok" },
    ...(lt > 0.5 ? ([{ kind: "say", text: typed("Done. 37 test accounts removed, every one on @test.local. You can undo it from LiteDB's audit log.", lt, 0.5, 60) }] as Line[]) : []),
  ];
  return (
    <AbsoluteFill style={{ background: P.stage }}>
      <ClaudeDesktop cam={DESKTOP_READ} lines={lines} input="" caret={Math.floor(lrt * 2) % 2 === 0} />
    </AbsoluteFill>
  );
};

/** The approval dialog as a small card, for "You didn't just [card] run a query." */
const MiniDialog: React.FC<{ scale: number }> = ({ scale }) => (
  <div style={{ width: 640 * scale, height: 360 * scale, overflow: "hidden", borderRadius: 14, border: "1px solid #2a2a2c", background: "#18181b" }}>
    <div style={{ transform: `scale(${scale}) translate(-320px, -158px)`, transformOrigin: "0 0", width: APP_W, height: APP_H, position: "relative" }}>
      <ApprovalDialog sql="DELETE FROM users WHERE email LIKE '%@test.local'" affected="37" rows={[{ id: 48102, email: "qa+checkout@test.local" }, { id: 48103, email: "qa+refunds@test.local" }]} expires="4:58" />
    </div>
  </div>
);

/** 0:58.5 "You didn't just [the card] run a query." */
export const TitleQuery: React.FC = () => {
  const t = warp(useT(), [[1.0, 0.8]]);
  const s = Math.max(0, spr(t, 0.3, 0.5, 0.8));
  return (
    <AbsoluteFill style={{ background: P.card, alignItems: "center", justifyContent: "center" }}>
      <div style={{ ...headline, fontSize: 64, color: P.fg, display: "flex", alignItems: "center", gap: 40 }}>
        <span>You didn't just</span>
        <div style={{ width: 300 * s, height: 170, position: "relative" }}>
          <div style={{ position: "absolute", left: "50%", top: "50%", transform: `translate(-50%, -50%) scale(${s})` }}>
            <MiniDialog scale={0.47} />
          </div>
        </div>
        <span>run a query.</span>
      </div>
    </AbsoluteFill>
  );
};

/** 1:01 The system: the app at the centre of orbiting agents and databases, a pull back, "You stayed in control." */
export const Orbit: React.FC = () => {
  const t = useT();
  const pull = p(t, 0.3, 2.0, E.inOut);
  const scale = lerp(1, 0.38, pull);
  const blur = p(t, 1.9, 2.3);
  const close = p(t, 3.6, 4.0, E.in);
  const ORBITERS: BrandId[] = ["claude", "cursor", "vscode", "opencode", "sqlite", "postgres", "ollama"];
  const ring = (cx: number, cy: number, s: number, seed: number) => (
    <div key={seed} style={{ position: "absolute", left: cx, top: cy, transform: `translate(-50%, -50%) scale(${s})` }}>
      {[260, 420].map((r) => (
        <div key={r} style={{ position: "absolute", left: -r, top: -r, width: r * 2, height: r * 2, borderRadius: "50%", border: "2px dashed rgba(255,255,255,0.12)" }} />
      ))}
      {Array.from({ length: 10 }).map((_, i) => {
        const r = i % 2 ? 420 : 260;
        // five to a ring, evenly spaced, the outer ring offset by half a step so no two bunch up
        const k = Math.floor(i / 2);
        const a = hash(seed * 13) * Math.PI * 2 + (k * 2 * Math.PI) / 5 + (i % 2 ? Math.PI / 5 : 0) + t * (i % 2 ? 0.25 : -0.35);
        return (
          <div key={i} style={{ position: "absolute", left: Math.cos(a) * r - 30, top: Math.sin(a) * r - 30 }}>
            <BrandTile id={ORBITERS[(i + seed) % ORBITERS.length]} size={60} bg="#1f1f22" />
          </div>
        );
      })}
      <div style={{ position: "absolute", left: -160, top: -100, width: 320, height: 200, borderRadius: 10, overflow: "hidden", boxShadow: "0 0 0 1px rgba(255,255,255,0.1)" }}>
        <div style={{ transform: "scale(0.25)", transformOrigin: "0 0" }}>
          <AppFrame view="table" table={{ table: "users", count: "48,213", rows: USERS }} />
        </div>
      </div>
    </div>
  );
  return (
    <AbsoluteFill style={{ background: P.ink, overflow: "hidden" }}>
      <DotField t={t} color="#ffffff" opacity={0.05} seed={4} />
      <div style={{ position: "absolute", inset: 0, filter: `blur(${blur * 14}px)`, opacity: 1 - blur * 0.45 }}>
        {ring(W / 2, H / 2, scale, 0)}
        {pull > 0.2
          ? [
              [W / 2 - 700, H / 2 - 330],
              [W / 2 + 680, H / 2 - 300],
              [W / 2 - 620, H / 2 + 360],
              [W / 2 + 640, H / 2 + 380],
            ].map(([x, y], i) => (
              <div key={i} style={{ opacity: p(t, 0.6 + i * 0.1, 1.0 + i * 0.1) }}>
                {ring(x, y, scale, i + 1)}
              </div>
            ))
          : null}
      </div>
      {t > 2.1 ? (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
          <div style={{ ...headline, fontSize: 104, color: P.fg, display: "flex", gap: "0.24em", alignItems: "baseline", textShadow: "0 0 50px #050506" }}>
            <PopWord t={t} at={2.1} text="You" accent={P.fg} />
            <PopWord t={t} at={2.25} text="stayed" accent={P.fg} />
            <PopWord t={t} at={2.4} text="in" accent={P.fg} />
            <PopWord t={t} at={2.55} text="control." color={P.key} accent={P.key} />
          </div>
        </AbsoluteFill>
      ) : null}
      {close > 0 ? <AbsoluteFill style={{ background: `radial-gradient(circle at 50% 50%, transparent ${lerp(120, 0, close)}%, ${P.ink} ${lerp(140, 2, close)}%)` }} /> : null}
    </AbsoluteFill>
  );
};

/** 1:05 End card: a dot becomes the app icon, "LiteDB" types, the pixel pill. */
export const End: React.FC = () => {
  const rt = useT();
  const t = warp(rt, [[3.0, 1.5]]);
  const grow = Math.max(0, spr(t, 0.15, 0.5, 0.8));
  const word = typed("LiteDB", t, 0.45, 16);
  const pill = p(t, 0.95, 1.25);
  return (
    <AbsoluteFill style={{ background: "#0b0b0c", alignItems: "center", justifyContent: "center" }}>
      <DotField t={rt} color="#ffffff" opacity={0.05} seed={7} />
      <div style={{ display: "grid", justifyItems: "center", gap: 90, marginTop: 60 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 30 }}>
          {t < 0.15 ? <div style={{ width: 22, height: 22, borderRadius: 11, background: P.fg }} /> : <div style={{ transform: `scale(${grow})` }}><AppIcon size={150} /></div>}
          {word ? <div style={{ ...headline, fontSize: 168, fontWeight: 600, color: P.fg, letterSpacing: "-0.05em" }}>{word}</div> : null}
        </div>
        <div style={{ opacity: pill, transform: `translateY(${(1 - pill) * 12}px)` }}>
          <div style={{ fontFamily: mono, fontWeight: 500, fontSize: 21, letterSpacing: "-0.02em", color: P.fg, whiteSpace: "nowrap", lineHeight: "58px" }}>FREE AND OPEN SOURCE · GITHUB.COM/CREATEDBYADHAM/LITEDB</div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
