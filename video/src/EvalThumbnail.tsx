import React from "react";
import { AbsoluteFill } from "remotion";
import { Background, BrandMark } from "./components/Chrome";
import { mono, sans } from "./fonts";
import { colors } from "./theme";

const ROWS = [
  { id: "st-01", q: "List customers in Germany", pass: true },
  { id: "jn-04", q: "Products that have never been ordered", pass: true },
  { id: "ag-04", q: "Customers who spent more than 500", pass: true },
  { id: "wf-04", q: "Two most expensive products per category", pass: false },
  { id: "wf-14", q: "Each product and how many share its category", pass: false },
];

export const EvalThumbnail: React.FC = () => {
  return (
    <AbsoluteFill>
      <Background />
      <BrandMark />
      <div
        style={{
          position: "absolute",
          right: 56,
          top: 48,
          fontFamily: mono,
          fontSize: 18,
          color: colors.dim,
        }}
      >
        109 cases · 7B local
      </div>
      <div
        style={{
          position: "absolute",
          left: 56,
          right: 56,
          top: 118,
          fontFamily: sans,
          fontSize: 64,
          fontWeight: 800,
          color: colors.text,
          letterSpacing: -2,
          lineHeight: 1.1,
        }}
      >
        Evaluation
      </div>
      <div
        style={{
          position: "absolute",
          left: 56,
          right: 56,
          top: 220,
          background: colors.bgElevated,
          border: `1px solid ${colors.border}`,
          borderRadius: 20,
          overflow: "hidden",
        }}
      >
        {ROWS.map((row, i) => (
          <div
            key={row.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 16,
              padding: "14px 22px",
              borderBottom: i === ROWS.length - 1 ? "none" : `1px solid ${colors.border}`,
              background: row.pass ? "transparent" : colors.redDim,
            }}
          >
            <div style={{ width: 72, fontFamily: mono, fontSize: 16, color: colors.dim }}>
              {row.id}
            </div>
            <div style={{ flex: 1, fontFamily: sans, fontSize: 22, color: colors.text }}>
              {row.q}
            </div>
            <div
              style={{
                fontFamily: mono,
                fontSize: 16,
                fontWeight: 700,
                color: row.pass ? colors.green : colors.red,
              }}
            >
              {row.pass ? "PASS" : "FAIL"}
            </div>
          </div>
        ))}
      </div>
      <div
        style={{
          position: "absolute",
          left: 56,
          right: 56,
          bottom: 48,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
        }}
      >
        <div>
          <div style={{ fontFamily: sans, fontSize: 20, color: colors.muted }}>
            Overall on the 7B
          </div>
          <div
            style={{
              fontFamily: sans,
              fontSize: 64,
              fontWeight: 800,
              color: colors.text,
              letterSpacing: -2,
            }}
          >
            77%
          </div>
        </div>
        <div
          style={{
            fontFamily: sans,
            fontSize: 24,
            color: colors.amber,
            fontWeight: 600,
            maxWidth: 480,
            textAlign: "right",
          }}
        >
          The failures were all window functions.
        </div>
      </div>
    </AbsoluteFill>
  );
};
