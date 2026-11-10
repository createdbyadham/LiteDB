// Real brand marks for the agents and databases LiteDB works with
// (Simple Icons; VS Code from Simple Icons 8, before it was removed).
import React from "react";
import { siClaude, siCursor, siOllama, siOpencode, siPostgresql, siSqlite } from "simple-icons";
import { siVisualstudiocode } from "si8";

export type BrandId = "claude" | "cursor" | "vscode" | "opencode" | "ollama" | "sqlite" | "postgres";

const ICONS: Record<BrandId, { path: string; hex: string; name: string }> = {
  claude: { path: siClaude.path, hex: "#D97757", name: "Claude" },
  cursor: { path: siCursor.path, hex: "#EDEDED", name: "Cursor" },
  vscode: { path: siVisualstudiocode.path, hex: "#2F9BEF", name: "VS Code" },
  opencode: { path: siOpencode.path, hex: "#EDEDED", name: "OpenCode" },
  ollama: { path: siOllama.path, hex: "#EDEDED", name: "Ollama" },
  sqlite: { path: siSqlite.path, hex: "#4AA3D8", name: "SQLite" },
  postgres: { path: siPostgresql.path, hex: "#5B8DEF", name: "PostgreSQL" },
};

export const brandName = (id: BrandId) => ICONS[id].name;
export const brandHex = (id: BrandId) => ICONS[id].hex;

/** The bare mark in its brand colour (dark brands drawn light on our dark UI). */
export const BrandGlyph: React.FC<{ id: BrandId; size: number; color?: string }> = ({ id, size, color }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: "block", flexShrink: 0 }}>
    <path d={ICONS[id].path} fill={color ?? ICONS[id].hex} />
  </svg>
);

/** An app-icon tile: the mark on a dark rounded square. */
export const BrandTile: React.FC<{ id: BrandId; size: number; bg?: string; style?: React.CSSProperties }> = ({ id, size, bg = "#1c1c1f", style }) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: size * 0.24,
      background: bg,
      border: "1.5px solid rgba(255,255,255,0.08)",
      display: "grid",
      placeItems: "center",
      boxShadow: "0 18px 40px rgba(0,0,0,0.45)",
      ...style,
    }}
  >
    <BrandGlyph id={id} size={size * 0.56} />
  </div>
);
