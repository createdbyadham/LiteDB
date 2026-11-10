// The system cursor from the second reference: the black arrow with a thick
// white rim, and the white pointing hand over anything clickable. Both are
// traced from the reference (the hand from the frame you picked, the arrow from
// the 13.9 s close-up), so they are those exact shapes. The cursor lives inside
// the screen it points at (app space), so it grows and shrinks with the camera
// the way a recorded cursor does; the arrow is about 0.9 of a button's height
// and the hand 1.05x the arrow, as in the reference.
import React from "react";

export type CursorState = { x: number; y: number; hand?: boolean; press?: number; o?: number };

/** Outer height of the arrow, in the screen's own pixels. */
export const CURSOR_H = { app: 34, desktop: 25 };

const ARROW = {
  w: 79.0,
  h: 95.0,
  hot: [3.0, 3.0],
  rim: "M22.5 92.2 L21.2 92.0 L20.2 90.2 L15.1 66.8 L2.1 5.8 L2.3 4.0 L3.2 3.2 L17.7 11.4 L74.5 48.3 L76.3 50.3 L75.2 51.7 L58.8 55.2 L56.5 56.8 L58.3 60.5 L65.3 69.0 L69.6 75.8 L69.7 83.7 L67.0 88.2 L60.7 90.7 L54.8 90.4 L40.7 73.2 L37.7 71.3 L35.5 73.0 L22.5 92.2Z",
  fill: "M59.3 84.5 L56.0 83.3 L37.7 61.2 L35.5 62.6 L26.3 76.7 L24.8 77.5 L23.7 76.8 L13.1 29.8 L10.5 16.7 L10.8 15.1 L12.2 15.1 L17.6 18.3 L60.7 46.7 L60.9 47.8 L60.0 48.7 L47.2 52.0 L45.8 53.3 L64.1 77.3 L64.4 79.3 L63.5 81.5 L59.3 84.5Z",
};
const HAND = {
  w: 169.0,
  h: 179.0,
  hot: [43.7, 3.5],
  outline: "M69.3 177.8 L66.5 177.2 L64.2 175.3 L63.8 167.2 L62.1 162.7 L52.6 155.0 L46.0 148.7 L43.8 147.2 L41.8 144.3 L35.9 138.3 L22.2 118.8 L12.2 108.6 L7.5 102.8 L3.3 96.5 L2.0 92.7 L2.0 84.5 L3.5 80.0 L5.8 76.6 L9.0 73.5 L16.7 70.1 L21.5 70.0 L29.3 72.2 L36.6 76.3 L40.7 79.8 L42.7 80.7 L43.6 80.2 L43.7 78.7 L40.6 68.5 L33.1 48.2 L27.9 25.8 L28.0 21.5 L28.8 18.7 L29.1 15.0 L32.0 7.8 L33.0 6.5 L36.2 4.4 L40.3 3.0 L43.3 2.6 L48.2 3.0 L51.0 4.0 L55.8 7.3 L61.3 14.0 L68.6 30.5 L72.0 45.3 L72.8 46.3 L74.0 46.2 L77.8 43.5 L81.6 42.2 L86.3 41.0 L90.0 40.9 L94.3 42.2 L98.2 44.1 L102.5 47.9 L103.8 48.4 L107.2 45.3 L113.3 42.3 L122.5 41.0 L128.5 42.3 L133.9 45.5 L135.6 47.3 L138.8 53.4 L140.2 53.0 L143.5 50.2 L148.0 48.1 L154.3 48.0 L158.2 49.2 L162.4 52.2 L164.6 55.5 L165.8 59.2 L166.0 69.2 L166.9 73.0 L166.9 84.0 L167.9 88.3 L167.9 97.8 L167.0 101.7 L166.8 108.5 L163.4 120.0 L159.6 127.5 L152.1 138.7 L148.1 147.7 L146.9 154.0 L147.9 158.5 L148.0 162.7 L148.9 165.7 L148.9 169.3 L148.3 170.8 L147.0 171.7 L141.3 172.9 L130.7 172.7 L126.6 171.0 L121.0 165.5 L118.7 162.2 L116.8 161.3 L115.3 162.3 L110.7 169.7 L107.0 173.2 L104.3 174.7 L100.2 175.9 L92.7 176.0 L88.7 176.9 L72.8 176.9 L69.3 177.8Z",
  fill: "M76.5 169.8 L73.3 169.8 L71.7 169.0 L71.0 167.7 L70.7 163.6 L68.2 157.8 L65.3 154.8 L57.7 149.1 L49.5 142.0 L44.0 136.5 L27.2 112.8 L18.2 103.6 L16.1 100.7 L12.7 97.2 L9.1 90.8 L9.1 87.0 L10.9 82.5 L14.7 79.1 L20.3 77.3 L26.4 79.2 L30.5 81.3 L35.0 84.6 L50.0 100.3 L52.8 100.8 L54.6 99.3 L54.8 93.3 L50.7 75.8 L46.7 62.7 L42.1 50.2 L36.0 27.3 L36.0 19.5 L37.3 14.2 L39.1 11.5 L43.0 10.1 L46.0 10.1 L49.2 11.7 L53.2 15.8 L56.4 21.0 L59.6 28.5 L62.7 37.7 L64.1 45.0 L71.1 73.0 L72.0 74.5 L73.5 75.6 L76.3 75.6 L77.8 73.7 L77.9 64.8 L77.0 61.5 L76.9 58.3 L78.2 53.5 L81.0 50.5 L85.2 49.0 L91.0 49.1 L95.6 51.7 L97.6 55.3 L99.7 61.7 L101.3 70.5 L102.5 72.5 L104.5 73.5 L107.2 72.6 L108.7 70.2 L109.0 59.7 L110.3 53.3 L112.3 51.3 L117.0 49.1 L124.8 49.1 L129.3 52.0 L132.6 59.5 L135.2 70.2 L136.8 71.7 L139.7 71.8 L141.3 70.8 L145.1 59.7 L147.3 57.0 L149.5 55.6 L152.0 55.1 L156.2 57.1 L157.6 58.3 L158.8 61.0 L158.9 74.0 L159.9 78.3 L159.8 105.7 L156.4 117.0 L153.6 122.5 L146.1 133.7 L142.3 141.1 L141.1 144.7 L139.9 149.2 L139.9 159.0 L140.9 162.7 L140.5 164.2 L138.5 164.9 L131.3 164.5 L126.0 159.5 L122.2 154.2 L118.3 152.2 L115.7 152.0 L112.8 153.0 L111.0 154.4 L105.4 163.8 L101.3 167.6 L96.3 168.0 L93.0 168.9 L79.7 169.0 L76.5 169.8ZM131.1 141.7 L133.3 139.8 L133.9 137.3 L133.9 130.7 L132.9 126.8 L132.9 116.7 L131.9 113.0 L131.9 101.8 L130.4 97.5 L129.0 96.5 L127.7 96.3 L125.3 97.5 L124.0 100.3 L124.0 102.5 L124.9 105.8 L124.9 117.0 L125.9 120.7 L125.9 130.0 L126.9 133.5 L127.1 138.8 L128.8 141.2 L131.1 141.7ZM109.5 142.8 L111.4 141.7 L111.9 139.2 L111.9 131.7 L110.9 127.8 L110.9 115.8 L109.9 112.0 L109.9 102.7 L108.2 98.8 L107.0 98.1 L105.5 98.0 L103.0 99.3 L102.0 101.7 L102.9 105.8 L102.9 116.8 L103.9 120.7 L104.0 130.2 L104.9 133.5 L105.3 140.7 L106.8 142.6 L109.5 142.8ZM87.1 144.7 L88.8 143.5 L89.8 141.7 L89.9 131.8 L89.0 128.2 L88.9 119.0 L88.0 115.2 L87.8 105.2 L86.4 100.5 L85.0 99.5 L83.7 99.3 L81.2 100.7 L79.9 103.8 L80.9 108.8 L81.0 118.3 L81.9 121.8 L81.9 133.0 L82.8 136.3 L83.2 142.3 L85.2 144.4 L87.1 144.7Z",
};

const Sprite: React.FC<{ s: typeof ARROW | typeof HAND; height: number; back: string; front: string; dBack: string; dFront: string }> = ({ s, height, back, front, dBack, dFront }) => {
  const k = height / s.h;
  return (
    <svg
      width={s.w * k}
      height={height}
      viewBox={`0 0 ${s.w} ${s.h}`}
      style={{ position: "absolute", left: -s.hot[0] * k, top: -s.hot[1] * k, overflow: "visible", filter: `drop-shadow(0 ${2 * (height / 34)}px ${3 * (height / 34)}px rgba(0,0,0,0.35))` }}
    >
      <path d={dBack} fill={back} fillRule="evenodd" />
      <path d={dFront} fill={front} fillRule="evenodd" />
    </svg>
  );
};

/** The cursor with its hotspot at (x, y). The hand does not change on a click in the reference; the button does. */
export const MacCursor: React.FC<{ c: CursorState; h: number }> = ({ c, h }) =>
  (c.o ?? 1) <= 0 ? null : (
    <div style={{ position: "absolute", left: c.x, top: c.y, width: 0, height: 0, zIndex: 100, opacity: c.o ?? 1, pointerEvents: "none" }}>
      {c.hand ? (
        <Sprite s={HAND} height={h * 1.05} back="#000" front="#fff" dBack={HAND.outline} dFront={HAND.fill} />
      ) : (
        <Sprite s={ARROW} height={h} back="#fff" front="#000" dBack={ARROW.rim} dFront={ARROW.fill} />
      )}
    </div>
  );

/** Is a point inside a box (for turning the arrow into a hand over a button)? */
export const over = (p: { x: number; y: number }, box: { x: number; y: number; w: number; h: number }) =>
  p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h;
