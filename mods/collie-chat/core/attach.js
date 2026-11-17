// The pure part of the Coordinator chat's attachments (attach.js does the clipboard, hc put and the viewer's links):
// what counts as an image, what a message carries when it names files, and how images are cropped for a tile or fitted
// in a row. No herdr here, so these run anywhere (bun test).
// Ported from shepherdr's chat attach.js and core/chat-view.js (cover, fitThumbs).

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic)$/i;
export const base = (p) => String(p).split("/").filter(Boolean).pop() ?? p;
export const isImage = (p) => IMAGE.test(String(p ?? ""));

// Dropped or pasted file paths as attachments.
export const paths = (list) => (list ?? []).filter(Boolean).map((p) => ({ path: p, name: base(p), image: isImage(p), temp: false }));

// The tiles above the box: TILE px squares, TILE_GAP apart.
export const THUMB = 56, THUMB_GAP = 6;
// Thumbnails under a message: one image up to THUMB_ONE, several up to THUMB_MANY each.
export const THUMB_ONE = [320, 220], THUMB_MANY = [200, 140];

// A w×h image covering a size×size square: its drawn size and offset (the middle shows).
export function cover(w, h, size) {
  const k = size / Math.min(w, h);
  const dw = Math.round(w * k), dh = Math.round(h * k);
  return { w: dw, h: dh, left: Math.round((size - dw) / 2), top: Math.round((size - dh) / 2) };
}

// Thumbnails under a message: each image whole, its shape kept, fitted in THUMB_ONE (one image) or THUMB_MANY (several),
// never above its own size, all shrunk together when the row would pass the column. sizes: [{ w, h } | null] (null: not
// read yet). -> { boxes: [{ w, h }], h: the row's height }.
export function fitThumbs(sizes, width = Infinity) {
  const [mw, mh] = sizes.length > 1 ? THUMB_MANY : THUMB_ONE;
  let boxes = sizes.map((v) => {
    if (!v?.w || !v?.h) return { w: Math.round((mh * 4) / 3), h: mh };
    const k = Math.min(1, mw / v.w, mh / v.h);
    return { w: Math.max(24, Math.round(v.w * k)), h: Math.max(24, Math.round(v.h * k)) };
  });
  const total = boxes.reduce((n, b) => n + b.w, 0) + THUMB_GAP * (boxes.length - 1);
  const k = Math.min(1, width / Math.max(1, total));
  if (k < 1) boxes = boxes.map((b) => ({ w: Math.floor(b.w * k), h: Math.floor(b.h * k) }));
  return { boxes, h: Math.max(24, ...boxes.map((b) => b.h)) };
}

// The message the agent reads: the words, then a file's path on its own line each (a picture becomes an image there).
// The paths are where the agent is, so a remote agent's are the copies hc put landed.
export function messageText(text, paths = []) {
  return [String(text ?? "").trim(), ...paths.filter(Boolean)].filter(Boolean).join("\n\n");
}

// The files a message carries that aren't pictures, by name (shown under the message's words).
export const names = (files) => (files ?? []).filter((f) => !f.image).map((f) => f.name);
// The pictures' paths here (shown as thumbnails until the log says which ones the agent read).
export const imagePaths = (files) => (files ?? []).filter((f) => f.image).map((f) => f.path);
