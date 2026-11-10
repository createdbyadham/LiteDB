// The Schema Visualizer (src/components/SchemaVisualizer), laid out from the real
// app at 1280x800: the Schema sidebar, the React Flow canvas with its table
// nodes, smoothstep edges, Layout menu, legend and minimap. Node positions come
// from the app's own Default and Pyramid layout code for the film's shop.db.
import React from "react";
import { ArrowDownUp, ChevronDown, ChevronLeft, Circle, CircleDot, Diamond, Key, LayoutGrid, Link2, Search, Table2, TableOfContents, Workflow } from "lucide-react";
import { mono } from "./kit";

const C = {
  bg: "#141415",
  card: "#19191b",
  muted: "#232325",
  border: "#28282a",
  fg: "#ededed",
  mf: "#a1a1a6",
  key: "#f6ae31",
  input: "#2a2a2c",
};
const I = { strokeWidth: 1.8 };

type Col = { name: string; type: string; pk?: boolean; fk?: boolean; notnull?: boolean };
type Table = { name: string; cols: Col[] };
const T: Table[] = [
  { name: "big_orders", cols: [{ name: "id", type: "int4" }, { name: "customer_id", type: "int4" }, { name: "total", type: "float4" }, { name: "status", type: "TEXT" }, { name: "meta", type: "TEXT" }] },
  { name: "customers", cols: [{ name: "id", type: "int4", pk: true }, { name: "name", type: "TEXT", notnull: true }, { name: "email", type: "TEXT" }, { name: "country", type: "TEXT" }, { name: "created_at", type: "TEXT" }] },
  { name: "order_items", cols: [{ name: "order_id", type: "int4", pk: true, fk: true }, { name: "product_id", type: "int4", pk: true, fk: true }, { name: "qty", type: "int4", notnull: true }] },
  { name: "orders", cols: [{ name: "id", type: "int4", pk: true }, { name: "customer_id", type: "int4", fk: true, notnull: true }, { name: "total", type: "float4" }, { name: "status", type: "TEXT" }, { name: "meta", type: "TEXT" }] },
  { name: "products", cols: [{ name: "id", type: "int4", pk: true }, { name: "name", type: "TEXT", notnull: true }, { name: "price", type: "float4", notnull: true }, { name: "tags", type: "TEXT" }] },
  { name: "users", cols: [{ name: "id", type: "int4", pk: true }, { name: "name", type: "TEXT", notnull: true }, { name: "email", type: "TEXT" }, { name: "created_at", type: "TEXT" }] },
];
const FKS: { from: string; col: string; to: string; toCol: string }[] = [
  { from: "orders", col: "customer_id", to: "customers", toCol: "id" },
  { from: "order_items", col: "order_id", to: "orders", toCol: "id" },
  { from: "order_items", col: "product_id", to: "products", toCol: "id" },
];

const NODE_W = 220;
const HEAD = 37;
const ROW = 29.2;
const nodeH = (t: Table) => HEAD + t.cols.length * ROW;

/** calculateLayout() in SchemaVisualizer/index.tsx, for these tables. */
const POS: Record<"default" | "pyramid", Record<string, { x: number; y: number }>> = {
  // Default: orders is a level above the rest; nodes 300 wide with 80 gaps, rows 260 apart.
  default: { orders: { x: -40, y: 0 }, big_orders: { x: -800, y: 260 }, customers: { x: -420, y: 260 }, order_items: { x: -40, y: 260 }, products: { x: 340, y: 260 }, users: { x: 720, y: 260 } },
  // Pyramid: most referenced first, 1, 2, 3 per row, centred on a 1000 wide bottom row.
  pyramid: { customers: { x: 350, y: 0 }, orders: { x: 175, y: 240 }, products: { x: 525, y: 240 }, big_orders: { x: 0, y: 480 }, order_items: { x: 350, y: 480 }, users: { x: 700, y: 480 } },
};

export type Viewport = { x: number; y: number; z: number };
const CANVAS = { x: 480, y: 84, w: 800, h: 692 };
/** fitView({ padding: 0.2 }) for a layout. */
export const fitView = (layout: "default" | "pyramid"): Viewport => {
  const ps = T.map((t) => ({ ...POS[layout][t.name], h: nodeH(t) }));
  const x0 = Math.min(...ps.map((p) => p.x));
  const x1 = Math.max(...ps.map((p) => p.x + NODE_W));
  const y0 = Math.min(...ps.map((p) => p.y));
  const y1 = Math.max(...ps.map((p) => p.y + p.h));
  const z = Math.min(2, CANVAS.w / ((x1 - x0) * 1.2), CANVAS.h / ((y1 - y0) * 1.2));
  return { x: (CANVAS.w - (x1 - x0) * z) / 2 - x0 * z, y: (CANVAS.h - (y1 - y0) * z) / 2 - y0 * z, z };
};
/** d3-zoom's transition from one viewport to another (800 ms, cubic in-out), sampled at k. */
export const lerpViewport = (a: Viewport, b: Viewport, k: number): Viewport => {
  const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
  // interpolate the visible centre and the zoom (log), as interpolateZoom does in effect
  const ca = { x: (CANVAS.w / 2 - a.x) / a.z, y: (CANVAS.h / 2 - a.y) / a.z };
  const cb = { x: (CANVAS.w / 2 - b.x) / b.z, y: (CANVAS.h / 2 - b.y) / b.z };
  const z = Math.exp(Math.log(a.z) + (Math.log(b.z) - Math.log(a.z)) * e);
  const c = { x: ca.x + (cb.x - ca.x) * e, y: ca.y + (cb.y - ca.y) * e };
  return { x: CANVAS.w / 2 - c.x * z, y: CANVAS.h / 2 - c.y * z, z };
};

/** Where each table node sits, in app px, under a viewport: for the hand-off out of the schema. */
export const schemaNodes = (layout: "default" | "pyramid", vp: Viewport) =>
  T.map((t) => ({ name: t.name, x: CANVAS.x + vp.x + POS[layout][t.name].x * vp.z, y: CANVAS.y + vp.y + POS[layout][t.name].y * vp.z, w: NODE_W * vp.z, h: nodeH(t) * vp.z, z: vp.z }));
export const SCHEMA_CARD_BG = C.card;
/** A table node as the canvas draws it, at its own 1:1 size, for the hand-off. */
export const SchemaNode: React.FC<{ name: string }> = ({ name }) => <Node t={T.find((t) => t.name === name)!} x={0} y={0} />;
export const SCHEMA_CARD_BORDER = C.border;

/** App coordinates of things the cursor clicks. */
export const SCHEMA_LAYOUT_BUTTON = { x: 1197, y: 117 };
export const SCHEMA_PYRAMID_ITEM = { x: 1100, y: 265 };
export const SCHEMA_ITEM = (name: string) => ({ x: 330, y: 265 + T.findIndex((t) => t.name === name) * 36 });

const ColIcon: React.FC<{ c: Col }> = ({ c }) =>
  c.pk ? (
    <span style={{ display: "flex", gap: 4 }}>
      <Key size={12} {...I} color={C.key} />
      {c.fk ? <Link2 size={12} {...I} color={C.key} /> : null}
    </span>
  ) : c.fk ? (
    <Link2 size={12} {...I} color={C.key} />
  ) : c.notnull ? (
    <Circle size={12} {...I} color="rgba(161,161,166,0.5)" fill="rgba(161,161,166,0.5)" />
  ) : (
    <Diamond size={12} {...I} color="rgba(161,161,166,0.5)" />
  );

const Node: React.FC<{ t: Table; x: number; y: number; selected?: boolean }> = ({ t, x, y, selected }) => (
  <div style={{ position: "absolute", left: x, top: y, width: NODE_W, background: C.card, border: `1px solid ${selected ? "rgba(246,174,49,0.6)" : C.border}`, borderRadius: 8, boxShadow: "0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1)", overflow: "visible", boxSizing: "border-box" }}>
    <div style={{ height: HEAD - 1, background: "rgba(35,35,37,0.5)", borderBottom: `1px solid ${C.border}`, borderRadius: "8px 8px 0 0", display: "flex", alignItems: "center", gap: 8, padding: "0 12px", boxSizing: "border-box" }}>
      <span style={{ width: 6, height: 6, borderRadius: 3, background: "rgba(161,161,166,0.5)" }} />
      <span style={{ fontSize: 14, fontWeight: 500, color: C.fg }}>{t.name}</span>
      <svg style={{ marginLeft: "auto" }} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.mf} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <polyline points="15 3 21 3 21 9" />
        <line x1="10" x2="21" y1="14" y2="3" />
      </svg>
    </div>
    {t.cols.map((c, i) => (
      <div key={c.name} style={{ position: "relative", height: ROW, display: "flex", alignItems: "center", padding: "0 12px", borderTop: i ? "1px solid rgba(40,40,42,0.5)" : undefined, boxSizing: "border-box", fontSize: 12 }}>
        {c.pk ? <span style={{ position: "absolute", left: -4, top: ROW / 2 - 4, width: 8, height: 8, borderRadius: 4, background: C.key }} /> : null}
        {c.fk ? <span style={{ position: "absolute", right: -4, top: ROW / 2 - 4, width: 8, height: 8, borderRadius: 4, background: C.key }} /> : null}
        <span style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
          <ColIcon c={c} />
          <span style={{ color: c.pk ? C.fg : C.mf, fontWeight: c.pk ? 500 : 400 }}>{c.name}</span>
        </span>
        <span style={{ fontFamily: mono, fontSize: 11, color: "rgba(161,161,166,0.7)" }}>{c.type}</span>
      </div>
    ))}
  </div>
);

/** A smoothstep edge from a right-hand source handle to a left-hand target handle, corners rounded 5. */
const edgePath = (sx: number, sy: number, tx: number, ty: number) => {
  const pts: [number, number][] =
    tx - 20 >= sx + 20
      ? [[sx, sy], [(sx + tx) / 2, sy], [(sx + tx) / 2, ty], [tx, ty]]
      : [[sx, sy], [sx + 20, sy], [sx + 20, (sy + ty) / 2], [tx - 20, (sy + ty) / 2], [tx - 20, ty], [tx, ty]];
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1];
    const [x, y] = pts[i];
    const [nx, ny] = pts[i + 1];
    const r = Math.min(5, Math.hypot(x - px, y - py) / 2, Math.hypot(nx - x, ny - y) / 2);
    const ax = x - Math.sign(x - px) * r;
    const ay = y - Math.sign(y - py) * r;
    const bx = x + Math.sign(nx - x) * r;
    const by = y + Math.sign(ny - y) * r;
    d += ` L${ax} ${ay} Q${x} ${y} ${bx} ${by}`;
  }
  d += ` L${pts[pts.length - 1][0]} ${pts[pts.length - 1][1]}`;
  const mid = pts.length === 4 ? { x: (sx + tx) / 2, y: (sy + ty) / 2 } : { x: (sx + tx) / 2, y: (sy + ty) / 2 };
  return { d, mid };
};

const Canvas: React.FC<{ layout: "default" | "pyramid"; vp: Viewport; selected?: string; menu: number; hotPyramid?: boolean; hotLayout?: boolean; hideNodes?: boolean }> = ({ layout, vp, selected, menu, hotPyramid, hotLayout, hideNodes }) => {
  const pos = POS[layout];
  const byName = Object.fromEntries(T.map((t) => [t.name, t]));
  const rowY = (t: string, col: string) => pos[t].y + HEAD + byName[t].cols.findIndex((c) => c.name === col) * ROW + ROW / 2;
  const gap = 20 * vp.z;
  return (
    <div style={{ position: "absolute", left: CANVAS.x, top: CANVAS.y, width: CANVAS.w, height: CANVAS.h, overflow: "hidden", background: C.bg }}>
      <svg width={CANVAS.w} height={CANVAS.h} style={{ position: "absolute", inset: 0 }}>
        <defs>
          <pattern id="dots" x={vp.x % gap} y={vp.y % gap} width={gap} height={gap} patternUnits="userSpaceOnUse">
            <circle cx={gap / 2} cy={gap / 2} r={0.5 * vp.z} fill="rgba(161,161,166,0.2)" />
          </pattern>
        </defs>
        <rect width={CANVAS.w} height={CANVAS.h} fill="url(#dots)" />
      </svg>
      <div style={{ position: "absolute", left: 0, top: 0, transformOrigin: "0 0", transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.z})` }}>
        <svg style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }} width={1} height={1}>
          {FKS.map((e) => {
            const sx = pos[e.from].x + NODE_W + 4;
            const sy = rowY(e.from, e.col);
            const tx = pos[e.to].x - 4;
            const ty = rowY(e.to, e.toCol);
            const { d, mid } = edgePath(sx, sy, tx, ty);
            return (
              <g key={e.from + e.col}>
                <path d={d} fill="none" stroke="#ffffff" strokeWidth={2} />
                <path d={`M${tx - 12} ${ty - 7} L${tx} ${ty} L${tx - 12} ${ty + 7} Z`} fill="#ffffff" />
                <rect x={mid.x - e.col.length * 2.9 - 3} y={mid.y - 7} width={e.col.length * 5.8 + 6} height={14} fill="#19191b" fillOpacity={0.8} />
                <text x={mid.x} y={mid.y + 3.5} fontSize={10} fill="#ffffff" textAnchor="middle" fontFamily="Inter, sans-serif">
                  {e.col}
                </text>
              </g>
            );
          })}
        </svg>
        {hideNodes ? null : T.map((t) => (
          <Node key={t.name} t={t} x={pos[t.name].x} y={pos[t.name].y} selected={selected === t.name} />
        ))}
      </div>
      {/* Layout, top right */}
      <div style={{ position: "absolute", right: 15, top: 15, width: 135, height: 36, boxSizing: "border-box", background: hotLayout ? "#232325" : C.card, border: `1px solid ${C.input}`, borderRadius: 8, display: "flex", alignItems: "center", padding: "0 12px", gap: 8, fontSize: 14, fontWeight: 500, color: C.fg }}>
        <LayoutGrid size={16} {...I} /> Layout <ChevronDown size={12} {...I} style={{ marginLeft: "auto", opacity: 0.5 }} />
      </div>
      {menu > 0 ? (
        <div style={{ position: "absolute", right: 15, top: 55, width: 224, boxSizing: "border-box", background: C.card, border: `1px solid ${C.input}`, borderRadius: 8, padding: 4, color: C.fg, fontSize: 14, opacity: menu, transform: `scale(${0.95 + 0.05 * menu})`, transformOrigin: "100% 0", boxShadow: "0 10px 30px rgba(0,0,0,0.4)" }}>
          <div style={{ padding: "6px 8px", fontWeight: 600 }}>Layout Strategy</div>
          <div style={{ height: 1, background: C.input, margin: "4px -4px" }} />
          {(
            [
              ["Default", <Workflow key="w" size={16} {...I} color={C.mf} />, layout === "default"],
              ["Grid", <LayoutGrid key="g" size={16} {...I} color={C.mf} />, false],
              ["Pyramid", <ArrowDownUp key="p" size={16} {...I} color={C.mf} />, layout === "pyramid"],
            ] as [string, React.ReactNode, boolean][]
          ).map(([label, icon, on]) => (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 4, background: label === "Pyramid" && hotPyramid ? C.muted : undefined }}>
              {icon}
              {label}
              {on ? <CircleDot size={12} {...I} style={{ marginLeft: "auto" }} /> : null}
            </div>
          ))}
        </div>
      ) : null}
      {/* Legend, bottom left */}
      <div style={{ position: "absolute", left: 15, bottom: 15, width: 115, boxSizing: "border-box", background: C.card, border: `1px solid ${C.input}`, borderRadius: 8, padding: 12, fontSize: 12, boxShadow: "0 10px 15px -3px rgba(0,0,0,0.1)" }}>
        <div style={{ fontWeight: 500, color: C.fg, marginBottom: 8 }}>Legend</div>
        <div style={{ display: "grid", gap: 8, color: C.mf }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Key size={12} {...I} color={C.key} /> Primary Key
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Link2 size={12} {...I} color={C.key} /> Foreign Key
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 12, height: 2, background: "#fff" }} /> Relationship
          </span>
        </div>
      </div>
      {/* Minimap, bottom right */}
      <MiniMap layout={layout} vp={vp} />
    </div>
  );
};

const MiniMap: React.FC<{ layout: "default" | "pyramid"; vp: Viewport }> = ({ layout, vp }) => {
  const pos = POS[layout];
  const W = 200;
  const H = 150;
  const nodes = T.map((t) => ({ ...pos[t.name], w: NODE_W, h: nodeH(t) }));
  const view = { x: -vp.x / vp.z, y: -vp.y / vp.z, w: CANVAS.w / vp.z, h: CANVAS.h / vp.z };
  const x0 = Math.min(view.x, ...nodes.map((n) => n.x));
  const y0 = Math.min(view.y, ...nodes.map((n) => n.y));
  const x1 = Math.max(view.x + view.w, ...nodes.map((n) => n.x + n.w));
  const y1 = Math.max(view.y + view.h, ...nodes.map((n) => n.y + n.h));
  const s = Math.max((x1 - x0) / W, (y1 - y0) / H);
  const ox = x0 - (W * s - (x1 - x0)) / 2;
  const oy = y0 - (H * s - (y1 - y0)) / 2;
  return (
    <svg width={W + 2} height={H + 2} viewBox={`${ox} ${oy} ${W * s} ${H * s}`} style={{ position: "absolute", right: 15, bottom: 15, background: C.card, border: `1px solid ${C.input}` }}>
      {nodes.map((n, i) => (
        <rect key={i} x={n.x} y={n.y} width={n.w} height={n.h} rx={5 * s} fill="#232325" />
      ))}
      <path fillRule="evenodd" fill="rgba(20,20,21,0.8)" d={`M${ox - 10 * s} ${oy - 10 * s} h${(W + 20) * s} v${(H + 20) * s} h${-(W + 20) * s} z M${view.x} ${view.y} h${view.w} v${view.h} h${-view.w} z`} />
    </svg>
  );
};

const SchemaSidebar: React.FC<{ hot?: string; selected?: string }> = ({ hot, selected }) => (
  <div style={{ position: "absolute", left: 240, top: 84, width: 240, height: 692, background: C.bg, borderRight: `1px solid ${C.border}`, boxSizing: "border-box", color: C.fg }}>
    <div style={{ height: 52, borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 12px", boxSizing: "border-box" }}>
      <span style={{ fontSize: 12, fontWeight: 500, color: C.mf }}>Schema</span>
      <ChevronLeft size={16} {...I} color={C.mf} style={{ marginRight: 6 }} />
    </div>
    <div style={{ height: 41, borderBottom: `1px solid ${C.border}`, display: "grid", gridTemplateColumns: "1fr 1fr", alignItems: "center", padding: "0 12px", fontSize: 12, color: C.mf, boxSizing: "border-box" }}>
      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Table2 size={14} {...I} /> 6 tables
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Link2 size={14} {...I} /> 3 relations
      </span>
    </div>
    <div style={{ height: 61, borderBottom: `1px solid ${C.border}`, padding: 12, boxSizing: "border-box" }}>
      <div style={{ height: 36, border: `1px solid ${C.input}`, borderRadius: 6, display: "flex", alignItems: "center", gap: 8, paddingLeft: 10, fontSize: 14, color: C.mf, boxSizing: "border-box" }}>
        <Search size={16} strokeWidth={1.5} /> Search tables
      </div>
    </div>
    <div style={{ padding: 8 }}>
      {T.map((t) => {
        const fk = FKS.some((f) => f.from === t.name);
        return (
          <div key={t.name} style={{ height: 36, borderRadius: 6, display: "flex", alignItems: "center", gap: 10, padding: "0 12px", fontSize: 14, background: selected === t.name ? C.muted : hot === t.name ? "rgba(35,35,37,0.5)" : undefined }}>
            <TableOfContents size={16} {...I} color={C.mf} />
            <span style={{ flex: 1 }}>{t.name}</span>
            <span style={{ fontFamily: mono, fontSize: 12, color: C.mf, width: 12, textAlign: "right" }}>{t.cols.length}</span>
            <span style={{ width: 12, display: "flex", justifyContent: "center" }}>{fk ? <Link2 size={12} {...I} color={C.key} /> : null}</span>
          </div>
        );
      })}
    </div>
  </div>
);

export const SchemaView: React.FC<{ layout: "default" | "pyramid"; vp: Viewport; menu?: number; hotPyramid?: boolean; hotLayout?: boolean; hot?: string; selected?: string; hideNodes?: boolean }> = ({ layout, vp, menu = 0, hotPyramid, hotLayout, hot, selected, hideNodes }) => (
  <>
    <SchemaSidebar hot={hot} selected={selected} />
    <Canvas layout={layout} vp={vp} menu={menu} hotPyramid={hotPyramid} hotLayout={hotLayout} selected={selected} hideNodes={hideNodes} />
  </>
);
