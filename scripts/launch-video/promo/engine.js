// Hunk's release-promo style kit: a timeline page for @hunk/term-video/timeline.
//
// The look is fixed here (brand palette, the assembling 3D mark, h-shaped
// zoom transitions, offset-outline extrusions, keycaps, stickers, flat-mark
// progress pips); everything that changes per release comes from
// window.PROMO, which render.mjs fills from a storyboard and the computed
// contributor list. Every frame is a pure function of t, so renders are
// deterministic and any frame can be rendered on its own.
//
// Storyboard shape (see storyboards/*.mjs):
//   version          "0.24" — badge, hook, montage tag, outro
//   tagline?         sting tagline; defaults to the brand eyebrow
//   hook?            { sub } — the line under "N new things in hunk X"
//   chapters         [{ label, title[], sub, cmd, winTitle, frames[], cameras[],
//                       captions[], highlights?[], labels?[], bodyH? }]
//   montage?         { items: [{ big, small }], fixes?: { count, label } }
//   contributors?    { thanks } — people come from contributors.json
//   outro?           { headline, install, foot, site }
const {
  storyboard: SB,
  contributors: PEOPLE = [],
  framesUrl: FRAMES,
  avatarsUrl: AVATARS,
} = window.PROMO;
const BRAND = {
  tagline: "TERMINAL DIFFS · MADE FOR REVIEW",
  hookSub: "every frame below is the real terminal UI",
  install: "curl -fsSL https://hunk.dev/install.sh | sh",
  foot: 'or <span class="hl">npm i -g hunkdiff</span> · already have it? <span class="hl">hunk update</span>',
  site: "hunk.dev",
};
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const seg = (t, a, b) => clamp((t - a) / (b - a));
const lerp = (a, b, p) => a + (b - a) * p;
const E = {
  out3: (p) => 1 - Math.pow(1 - p, 3),
  out5: (p) => 1 - Math.pow(1 - p, 5),
  inOut3: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  in3: (p) => p * p * p,
  outBack: (p) => {
    const c1 = 1.9;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
  },
  outExpo: (p) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p)),
  inOutExpo: (p) =>
    p <= 0
      ? 0
      : p >= 1
        ? 1
        : p < 0.5
          ? Math.pow(2, 20 * p - 10) / 2
          : (2 - Math.pow(2, -20 * p + 10)) / 2,
};
const el = (tag, cls, html) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (html !== undefined) node.innerHTML = html;
  return node;
};
const stage = document.getElementById("stage");

// Deterministic pseudo-random numbers for textures.
function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// ------------------------------------------------------------------
// Logo geometry (from website/public/brand): the 3D mark's face and
// extrusion strokes, the wordmark letters, and the flat mark's h cut-out.
// The strokes follow the brand mark's clean geometry: the base outline is one
// mitred line through the stem-gap peak, and each end is cut flush with the
// face edge it leaves from (clip rects below) instead of ending in a cap.
// ------------------------------------------------------------------
const MARK_FACE = "M0.35 0.5H30.35V17H66.66V66.31H36.52V48.98H30.49V66.31H0.35Z";
const MARK_STROKES = [
  {
    // Base outline: bottom-left diagonal, base, stem-gap peak, right side.
    d: "M-0.3536 65.9766L0.353516 66.6837L14.6698 81H44.8093V74.9524L51.214 81H81.3535V42.5L66.6605 17.0509L66.1605 16.1849",
    clip: { x: 0.353516, y: 17, w: 90, h: 90 },
  },
  {
    // Stem diagonal: flush with the stem's top edge, ending inside the face.
    d: "M29.993 -0.48929L30.493 0.37674L43.5438 22.9814",
    clip: { x: 0, y: 0.5, w: 90, h: 90 },
  },
];
let clipSeq = 0;
const WORDMARK = [
  "M0 37.23V0H6.380167V9.18L6.230987 14.535H7.94589L6.230987 16.023706Q6.230987 12.559525 8.249823 10.614763Q10.268659 8.67 13.757823 8.67Q17.901314 8.67 20.385396 11.420181Q22.869478 14.170361 22.869478 18.807542V37.23H16.489311V19.466722Q16.489311 16.9351 15.151336 15.546125Q13.813361 14.157151 11.447231 14.157151Q9.068609 14.157151 7.724388 15.599035Q6.380167 17.04092 6.380167 19.678361V37.23Z",
  "M40.432575 37.74Q35.110197 37.74 32.039099 34.754074Q28.968 31.768147 28.968 26.612294V9.18H35.348167V26.582458Q35.348167 29.26708 36.681806 30.728219Q38.015445 32.189358 40.432575 32.189358Q42.841033 32.189358 44.200172 30.728219Q45.559311 29.26708 45.559311 26.582458V9.18H51.939478V26.612294Q51.939478 31.797983 48.832298 34.768992Q45.725117 37.74 40.432575 37.74Z",
  "M58.14 37.23V9.18H64.370987V14.535H66.08589L64.370987 16.023706Q64.370987 12.559525 66.389823 10.614763Q68.408659 8.67 71.897823 8.67Q76.041314 8.67 78.525396 11.420181Q81.009478 14.170361 81.009478 18.807542V37.23H74.629311V19.466722Q74.629311 16.9351 73.291336 15.567289Q71.953361 14.199478 69.587231 14.199478Q67.208609 14.199478 65.864388 15.620199Q64.520167 17.04092 64.520167 19.678361V37.23Z",
  "M87.363 37.23V0H93.743167V20.190114H98.194411L105.011786 9.18H112.174298L103.694054 22.750853L112.327298 37.23H105.03295L98.185739 25.600247H93.743167V37.23Z",
];
const FLAT_MARK = "M0 0h100v99H0zM6 5H46V28H94V93H54V70H46V93H6z";
const H_CUTOUT = "M6 5H46V28H94V93H54V70H46V93H6z";

/** Build an animatable 3D mark + wordmark lockup SVG. */
function buildLockup({ wordmark = true, faceColor = "#f4f1ea", strokeColor = "#5dd06a" } = {}) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", wordmark ? "-2 -2 215 86" : "-2 -2 86 86");
  svg.style.overflow = "visible";
  const face = document.createElementNS(ns, "path");
  face.setAttribute("d", MARK_FACE);
  face.setAttribute("fill", faceColor);
  const faceG = document.createElementNS(ns, "g");
  faceG.appendChild(face);
  // Strokes sit beneath the face, as in the logo, so the stem's diagonal
  // stops where it meets the face instead of crossing it.
  const defs = document.createElementNS(ns, "defs");
  svg.appendChild(defs);
  const strokes = MARK_STROKES.map(({ d, clip }) => {
    const id = `promo-mark-clip-${(clipSeq += 1)}`;
    const clipPath = document.createElementNS(ns, "clipPath");
    clipPath.setAttribute("id", id);
    clipPath.setAttribute("clipPathUnits", "userSpaceOnUse");
    const rect = document.createElementNS(ns, "rect");
    rect.setAttribute("x", clip.x);
    rect.setAttribute("y", clip.y);
    rect.setAttribute("width", clip.w);
    rect.setAttribute("height", clip.h);
    clipPath.appendChild(rect);
    defs.appendChild(clipPath);
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", d);
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", strokeColor);
    p.setAttribute("stroke-width", "1.4");
    p.setAttribute("stroke-linejoin", "miter");
    p.setAttribute("stroke-miterlimit", "8");
    p.setAttribute("clip-path", `url(#${id})`);
    svg.appendChild(p);
    return p;
  });
  svg.appendChild(faceG);
  const letters = [];
  if (wordmark) {
    const wg = document.createElementNS(ns, "g");
    wg.setAttribute("transform", "translate(101.25 24.5) scale(.979)");
    for (const d of WORDMARK) {
      const lg = document.createElementNS(ns, "g");
      const p = document.createElementNS(ns, "path");
      p.setAttribute("d", d);
      p.setAttribute("fill", faceColor);
      lg.appendChild(p);
      wg.appendChild(lg);
      letters.push(lg);
    }
    svg.appendChild(wg);
  }
  return { svg, faceG, strokes, letters };
}

/** Animate a lockup: face pops, extrusion draws, letters rise. */
function animateLockup(lk, t, { face = 0, strokes = 0.35, letters = 0.75 } = {}) {
  const pf = seg(t, face, face + 0.45);
  const s = pf <= 0 ? 0.001 : E.outBack(pf);
  lk.faceG.setAttribute("transform", `translate(33.5 33.4) scale(${s}) translate(-33.5 -33.4)`);
  lk.faceG.style.opacity = pf > 0 ? 1 : 0;
  lk.strokes.forEach((p, i) => {
    const len = p.getTotalLength();
    const ps = E.out3(seg(t, strokes + i * 0.08, strokes + 0.5 + i * 0.08));
    p.style.strokeDasharray = `${len}`;
    p.style.strokeDashoffset = `${len * (1 - ps)}`;
    p.style.opacity = ps > 0 ? 1 : 0;
  });
  lk.letters.forEach((g, i) => {
    const pl = E.out5(seg(t, letters + i * 0.07, letters + 0.45 + i * 0.07));
    g.setAttribute("transform", `translate(${(1 - pl) * -30} 0)`);
    g.style.opacity = pl;
  });
}

function flatMarkSvg(fill, stroke) {
  const strokeAttr = stroke ? `stroke="${stroke}" stroke-width="7" fill="none"` : `fill="${fill}"`;
  return `<svg viewBox="-4 -4 108 107"><path ${strokeAttr} fill-rule="evenodd" d="${stroke ? H_CUTOUT : FLAT_MARK}"/></svg>`;
}

// ------------------------------------------------------------------
// Shared scene pieces.
// ------------------------------------------------------------------
function buildDiffStream(parent, seed, colors) {
  const wrap = el("div", "diffstream");
  const r = rng(seed);
  const rows = [];
  for (let i = 0; i < 70; i += 1) {
    const kind = r();
    const row = el("div", "row");
    const y = i * 22;
    const indent = 60 + Math.floor(r() * 8) * 40;
    const width = 160 + r() * 820;
    const lane = r() < 0.5 ? 0 : 960;
    row.style.left = `${lane + indent}px`;
    row.style.top = `${y}px`;
    row.style.width = `${Math.min(width, 900 - indent)}px`;
    row.style.background = kind < 0.22 ? colors.add : kind < 0.36 ? colors.del : colors.ctx;
    wrap.appendChild(row);
    rows.push(row);
  }
  parent.appendChild(wrap);
  return (t) => {
    wrap.style.transform = `translateY(${-((t * 36) % 440)}px)`;
  };
}

function buildPips(parent, active, onInk) {
  const pips = el("div", "pips");
  for (let i = 1; i <= SB.chapters.length; i += 1) {
    const color = onInk ? "#f4f1ea" : "#16140f";
    let html;
    if (i < active) html = flatMarkSvg(color);
    else if (i === active) html = flatMarkSvg("#5dd06a");
    else html = flatMarkSvg(null, onInk ? "rgba(244,241,234,0.35)" : "rgba(22,20,15,0.3)");
    pips.appendChild(el("div", "", html));
  }
  parent.appendChild(pips);
  return pips;
}

/** Staggered word-rise text. Returns an animator for local time. */
function buildWords(parent, lines, cls) {
  const box = el("div", cls);
  const words = [];
  for (const line of lines) {
    const ln = el("span", "word-line");
    for (const [i, w] of line.split(" ").entries()) {
      const isHl = w.startsWith("*");
      const span = el("span", `word${isHl ? " hl" : ""}`, w.replace(/^\*/, ""));
      ln.appendChild(span);
      if (i < line.split(" ").length - 1) ln.appendChild(document.createTextNode(" "));
      words.push(span);
    }
    box.appendChild(ln);
  }
  parent.appendChild(box);
  return (t, start = 0, stagger = 0.06, dur = 0.5) => {
    words.forEach((w, i) => {
      const p = E.out5(seg(t, start + i * stagger, start + i * stagger + dur));
      w.style.transform = `translateY(${(1 - p) * 110}%)`;
    });
  };
}

// ------------------------------------------------------------------
// Scenes.
// ------------------------------------------------------------------
const scenes = [];
function addScene(def) {
  const root = el("div", `scene ${def.theme ?? "ink"}`);
  stage.appendChild(root);
  const scene = { ...def, root };
  scene.render = def.build(root, scene);
  scenes.push(scene);
  return scene;
}

// --- Sting: the mark assembles, the wordmark slides out, the version stamps.
function buildSting(root) {
  const stream = buildDiffStream(root, 7, {
    add: "rgba(93,208,106,0.10)",
    del: "rgba(239,107,91,0.08)",
    ctx: "rgba(244,241,234,0.035)",
  });
  root.appendChild(el("div", "vignette"));
  const lk = buildLockup();
  const holder = el("div", "abs");
  holder.style.left = "450px";
  holder.style.top = "330px";
  holder.style.width = "1020px";
  lk.svg.style.width = "1020px";
  holder.appendChild(lk.svg);
  root.appendChild(holder);
  const stamp = el("div", "abs");
  stamp.innerHTML = `<div style="font-size:84px;font-weight:800;padding:6px 26px;background:#5dd06a;color:#16140f;border:5px solid #f4f1ea;border-radius:8px;box-shadow:12px 12px 0 #f4f1ea">${SB.version}</div>`;
  stamp.style.left = "1270px";
  stamp.style.top = "232px";
  root.appendChild(stamp);
  const tagline = el("div", "abs");
  tagline.style.left = "0";
  tagline.style.right = "0";
  tagline.style.top = "800px";
  tagline.style.textAlign = "center";
  tagline.style.fontSize = "40px";
  tagline.style.fontWeight = "600";
  tagline.style.letterSpacing = "0.32em";
  tagline.style.color = "#9aa4af";
  tagline.textContent = SB.tagline ?? BRAND.tagline;
  root.appendChild(tagline);
  return (t) => {
    stream(t);
    animateLockup(lk, t, { face: 0, strokes: 0.32, letters: 0.6 });
    const ps = seg(t, 1.25, 1.6);
    const s = lerp(2.6, 1, E.out5(ps));
    stamp.style.opacity = ps > 0 ? 1 : 0;
    stamp.style.transform = `rotate(${lerp(-14, -5, E.out3(ps))}deg) scale(${s})`;
    // A short shake when the stamp lands.
    const shake = t > 1.6 ? Math.sin((t - 1.6) * 70) * 9 * Math.exp(-(t - 1.6) * 9) : 0;
    holder.style.transform = `translate(${shake}px, ${shake * 0.6}px) scale(${1 + seg(t, 0, 3.2) * 0.04})`;
    const pt = E.out3(seg(t, 1.75, 2.3));
    tagline.style.opacity = pt;
    tagline.style.letterSpacing = `${lerp(0.6, 0.32, pt)}em`;
  };
}

// --- Hook: "N new things in hunk X", counting the storyboard's chapters.
function buildHook(root) {
  root.appendChild(el("div", "dots"));
  const count = SB.chapters.length;
  const five = el("div", "chap-num");
  five.style.left = "180px";
  five.style.top = "150px";
  five.style.fontSize = "640px";
  five.innerHTML = `<span class="extrude" style="-webkit-text-stroke:6px #1f7a35">${count}</span><span class="face" style="color:#16140f">${count}</span>`;
  root.appendChild(five);
  const extrude = five.querySelector(".extrude");
  const words = buildWords(
    root,
    [count === 1 ? "new thing" : "new things", `in *hunk *${SB.version}`],
    "abs",
  );
  const box = root.lastChild;
  box.style.left = "760px";
  box.style.top = "330px";
  box.style.fontSize = "120px";
  box.style.fontWeight = "800";
  box.style.letterSpacing = "-0.035em";
  box.querySelectorAll(".hl").forEach((n) => (n.style.color = "#1f7a35"));
  const sub = el("div", "abs");
  sub.style.left = "770px";
  sub.style.top = "640px";
  sub.style.fontSize = "38px";
  sub.style.fontWeight = "600";
  sub.style.color = "#6b6557";
  sub.textContent = SB.hook?.sub ?? BRAND.hookSub;
  root.appendChild(sub);
  return (t) => {
    const p = seg(t, 0.15, 0.7);
    five.style.transform = `translateY(${(1 - E.outBack(p)) * -260}px) rotate(${(1 - E.out3(p)) * -12}deg)`;
    five.style.opacity = p > 0 ? 1 : 0;
    const pe = E.out3(seg(t, 0.55, 0.95));
    extrude.style.transform = `translate(${pe * 22}px, ${pe * 22}px)`;
    words(t, 0.35, 0.09, 0.5);
    const ps = E.out3(seg(t, 1.05, 1.5));
    sub.style.opacity = ps;
    sub.style.transform = `translateX(${(1 - ps) * -40}px)`;
  };
}

// --- Chapter title card on ink.
function buildChapterTitle(spec) {
  return (root) => {
    const stream = buildDiffStream(root, spec.num * 13, {
      add: "rgba(93,208,106,0.07)",
      del: "rgba(239,107,91,0.05)",
      ctx: "rgba(244,241,234,0.025)",
    });
    root.appendChild(el("div", "vignette"));
    buildPips(root, spec.num, true);
    const num = el("div", "chap-num");
    const label = String(spec.num).padStart(2, "0");
    num.innerHTML = `<span class="extrude">${label}</span><span class="face">${label}</span>`;
    root.appendChild(num);
    const extrude = num.querySelector(".extrude");
    const rule = el("div", "chap-rule");
    root.appendChild(rule);
    const text = el("div", "chap-text");
    root.appendChild(text);
    const words = buildWords(text, spec.title, "title");
    const sub = el("div", "sub", spec.sub);
    text.appendChild(sub);
    const cmd = el("div", "cmdline");
    cmd.innerHTML = `<span class="mono-chip"><span class="p">❯</span><span class="typed"></span></span>`;
    text.appendChild(cmd);
    const typed = cmd.querySelector(".typed");
    return (t) => {
      stream(t);
      const pn = seg(t, 0.0, 0.45);
      num.style.transform = `translateX(${(1 - E.out5(pn)) * -220}px)`;
      num.style.opacity = E.out3(pn);
      const pe = E.out3(seg(t, 0.25, 0.6));
      extrude.style.transform = `translate(${pe * 18}px, ${pe * 18}px)`;
      rule.style.width = `${E.out5(seg(t, 0.1, 0.55)) * 260}px`;
      words(t, 0.12, 0.07, 0.45);
      const psub = E.out3(seg(t, 0.45, 0.8));
      sub.style.opacity = psub;
      const n = Math.round(seg(t, 0.55, 0.55 + spec.cmd.length * 0.035) * spec.cmd.length);
      typed.textContent = spec.cmd.slice(0, n) || "​";
      cmd.style.opacity = t > 0.5 ? 1 : 0;
      const drift = seg(t, 0, 1.6);
      text.style.transform = `translateX(${-drift * 16}px)`;
    };
  };
}

// --- Chapter terminal scene on paper.
const SRC_W = 2688;
const SRC_H = 1536;
const WIN_W = 1520;
const BODY_W = WIN_W - 6;
const BODY_H = 909 - 40 - 6;
const IMG_SCALE = BODY_W / SRC_W;

function projectCamera(cam, srcHeight, bodyH = BODY_H) {
  const sw = BODY_W * cam.scale;
  const sh = srcHeight * IMG_SCALE * cam.scale;
  const axis = (view, size, focus) => {
    if (size <= view) return 0;
    return Math.min(0, Math.max(view - size, view / 2 - focus * size));
  };
  return { tx: axis(BODY_W, sw, cam.x), ty: axis(bodyH, sh, cam.y), s: cam.scale };
}

function interpKeyed(keys, t, interp) {
  // keys: [[time, value, ease?, dur?]]: each value eases in over dur from the previous.
  let prev = keys[0][1];
  let out = prev;
  for (let i = 0; i < keys.length; i += 1) {
    const [kt, v, dur = 0.7] = keys[i];
    if (t < kt) break;
    const p = i === 0 ? 1 : E.inOut3(seg(t, kt, kt + dur));
    out = interp(prev, v, p);
    prev = out;
  }
  return out;
}

const lerpCam = (a, b, p) => ({
  x: lerp(a.x, b.x, p),
  y: lerp(a.y, b.y, p),
  scale: lerp(a.scale, b.scale, p),
});

const bgCache = new Map();
function sampleBg(img) {
  if (bgCache.has(img.src)) return bgCache.get(img.src);
  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = 4;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 2, img.naturalHeight - 8, 4, 4, 0, 0, 4, 4);
  const d = ctx.getImageData(2, 2, 1, 1).data;
  const c = `rgb(${d[0]}, ${d[1]}, ${d[2]})`;
  bgCache.set(img.src, c);
  return c;
}

function buildChapterTerm(spec) {
  return (root, scene) => {
    const dots = el("div", "dots");
    root.appendChild(dots);
    buildPips(root, spec.num, false);

    const wrap = el("div", "win-wrap");
    root.appendChild(wrap);
    // Compact windows fit short shell output instead of a full screen.
    const winH = spec.bodyH ? spec.bodyH + 46 : 909;
    const bodyH = winH - 46;
    const winTop = spec.bodyH ? Math.round((1080 - winH) / 2) - 30 : 62;
    wrap.style.height = `${winH}px`;
    wrap.style.top = `${winTop}px`;
    // The logo's offset-outline extrusion, applied to the window.
    const ex = 20;
    wrap.innerHTML = `<svg class="win-extrude" width="${WIN_W + ex + 6}" height="${winH + ex + 6}" viewBox="0 0 ${WIN_W + ex + 6} ${winH + ex + 6}">
      <path d="M${WIN_W - 2} 2 L${WIN_W - 2 + ex} ${2 + ex} V${winH - 2 + ex} H${2 + ex} L2 ${winH - 2}" fill="none" stroke="#16140f" stroke-width="3"/>
    </svg>`;
    const win = el("div", "win");
    wrap.appendChild(win);
    const bar = el(
      "div",
      "win-bar",
      `<div class="lights"><i></i><i></i><i></i></div><div class="win-title">${spec.winTitle}</div>`,
    );
    win.appendChild(bar);
    const body = el("div", "win-body");
    win.appendChild(body);
    const visual = el("div", "win-visual");
    body.appendChild(visual);
    const imgA = el("img");
    const imgB = el("img", "next");
    visual.appendChild(imgA);
    visual.appendChild(imgB);
    const callout = el("div", "callout");
    body.appendChild(callout);
    const labels = [];

    const chap = el(
      "div",
      "sticker chap-sticker",
      `${String(spec.num).padStart(2, "0")} — ${spec.label}`,
    );
    root.appendChild(chap);
    const cap = el("div", "sticker cap-sticker");
    root.appendChild(cap);
    const key = el("div", "keycap", `<span class="k"></span>`);
    root.appendChild(key);
    if (spec.bodyH) {
      chap.style.top = `${winTop - 28}px`;
      cap.style.top = `${winTop + winH - 40}px`;
      key.style.top = `${winTop + winH - 52}px`;
    }
    const keyLabel = key.querySelector(".k");

    // Frame schedule.
    const sched = [];
    let acc = spec.lead ?? 0;
    for (const f of spec.frames) {
      sched.push({ ...f, t0: acc, t1: acc + f.dur });
      acc += f.dur;
    }
    scene.termDuration = acc;

    let shownCap = null;
    let capT0 = 0;
    return async (t) => {
      dots.style.transform = `translateY(${-t * 14}px)`;
      // Window rises in with a tilt.
      const pin = seg(t, 0, 0.75);
      const rise = E.out5(pin);
      wrap.style.transform = `perspective(1800px) translateY(${(1 - rise) * 700}px) rotateX(${(1 - rise) * 24}deg) scale(${lerp(0.92, 1, rise)})`;
      const pchap = E.outBack(seg(t, 0.35, 0.75));
      chap.style.transform = `rotate(-2deg) scale(${pchap})`;
      chap.style.opacity = pchap > 0.01 ? 1 : 0;

      // Current frame and image.
      let idx = sched.findIndex((f) => t < f.t1);
      if (idx < 0) idx = sched.length - 1;
      const f = sched[Math.max(0, idx)];
      const src = `${FRAMES}/${f.img}.png`;
      if (imgA.getAttribute("src") !== src) {
        imgA.setAttribute("src", src);
        await imgA.decode();
        imgA.style.width = `${BODY_W}px`;
        body.style.background = sampleBg(imgA);
      }
      // Optional crossfade from the previous frame for big layout changes.
      if (f.fade && idx > 0 && t - f.t0 < f.fade) {
        const prevSrc = `${FRAMES}/${sched[idx - 1].img}.png`;
        if (imgB.getAttribute("src") !== prevSrc) {
          imgB.setAttribute("src", prevSrc);
          await imgB.decode();
          imgB.style.width = `${BODY_W}px`;
        }
        imgB.style.opacity = String(1 - E.inOut3((t - f.t0) / f.fade));
      } else {
        imgB.style.opacity = "0";
      }
      const srcH = imgA.naturalHeight || SRC_H;

      // Camera.
      const cam = interpKeyed(spec.cameras, t, lerpCam);
      const pr = projectCamera(cam, srcH, bodyH);
      visual.style.transform = `translate(${pr.tx}px, ${pr.ty}px) scale(${pr.s})`;

      // Callout box in source coordinates.
      const hl = (spec.highlights ?? []).find((h) => t >= h.t0 && t < h.t1);
      if (hl) {
        const a = E.out3(seg(t, hl.t0, hl.t0 + 0.35));
        const sx = BODY_W * pr.s;
        const sy = srcH * IMG_SCALE * pr.s;
        callout.style.display = "block";
        callout.style.left = `${pr.tx + hl.x * sx}px`;
        callout.style.top = `${pr.ty + hl.y * sy}px`;
        callout.style.width = `${hl.w * sx}px`;
        callout.style.height = `${hl.h * sy}px`;
        callout.style.opacity = a;
        callout.style.transform = `scale(${lerp(1.06, 1, a)})`;
      } else {
        callout.style.display = "none";
      }

      // Floating labels pinned to source coordinates.
      for (const [i, lb] of (spec.labels ?? []).entries()) {
        if (!labels[i]) {
          labels[i] = el("div", "callout-label", lb.text);
          body.appendChild(labels[i]);
        }
        const node = labels[i];
        const vis = t >= lb.t0 && t < lb.t1;
        const a = vis ? E.outBack(seg(t, lb.t0, lb.t0 + 0.35)) : 0;
        const sx = BODY_W * pr.s;
        const sy = srcH * IMG_SCALE * pr.s;
        node.style.left = `${pr.tx + lb.x * sx}px`;
        node.style.top = `${pr.ty + lb.y * sy}px`;
        node.style.opacity = a > 0.01 ? 1 : 0;
        node.style.transform = `translateY(-50%) scale(${a})`;
        node.style.transformOrigin = "0 50%";
      }

      // Caption sticker.
      const c = [...spec.captions].reverse().find(([ct]) => t >= ct);
      if (c && c[1] !== shownCap) {
        shownCap = c[1];
        capT0 = c[0];
        cap.innerHTML = c[1];
      }
      const pc = c ? E.outBack(seg(t, capT0, capT0 + 0.35)) : 0;
      cap.style.opacity = pc > 0.01 ? 1 : 0;
      cap.style.transform = `rotate(-1deg) scale(${pc})`;

      // Keycap: visible while the recent frames came from keypresses.
      const keyFrame = [...sched].reverse().find((k) => k.key && k.t0 <= t);
      const since = keyFrame ? t - keyFrame.t0 : 99;
      const show = keyFrame && since < Math.max(0.9, keyFrame.dur + 0.3);
      const vis = show ? E.outBack(seg(t, keyFrame.t0 - 0.0, keyFrame.t0 + 0.2)) : 0;
      const appear =
        show &&
        !sched.some((k) => k.key && k.t1 <= keyFrame.t0 + 0.0001 && k.t1 > keyFrame.t0 - 0.9);
      keyLabel.textContent = keyFrame ? keyFrame.key : "";
      const press = show && since < 0.11 ? 1 : 0;
      key.style.opacity = show ? 1 : 0;
      key.style.boxShadow = `0 ${press ? 2 : 9}px 0 #16140f`;
      key.style.transform = `translateY(${press ? 7 : 0}px) scale(${appear ? vis : 1})`;
    };
  };
}

// --- Montage of smaller wins, ending on an optional fixes counter.
const MONTAGE_SLOT = 0.62;
const FIXES_DUR = 1.35;

function buildMontage({ items, fixes }) {
  return (root) => {
    const nodes = items.map((it, i) => {
      const onInk = i % 2 === 0;
      const node = el("div", "mont-item");
      node.style.background = onInk ? "#0c0e10" : "#5dd06a";
      node.style.color = onInk ? "#f4f1ea" : "#16140f";
      node.innerHTML = `<div class="mont-tag" style="color:${onInk ? "#5dd06a" : "#16140f"}">ALSO IN ${SB.version}</div><div class="big">${it.big}</div><div class="small">${it.small}</div>`;
      root.appendChild(node);
      return node;
    });
    const counter = el("div", "mont-item");
    counter.style.background = "#f4f1ea";
    counter.style.color = "#16140f";
    counter.innerHTML = `<div class="big" style="font-size:300px"><span class="n">0</span><span class="plus" style="color:#1f7a35">+</span></div><div class="small" style="border:none;margin-top:0">${fixes?.label ?? "fixes &amp; polish"}</div>`;
    root.appendChild(counter);
    const n = counter.querySelector(".n");
    const plus = counter.querySelector(".plus");
    const SLOT = MONTAGE_SLOT;
    return (t) => {
      const i = Math.floor(t / SLOT);
      nodes.forEach((node, j) => {
        node.style.display = j === i ? "flex" : "none";
        if (j === i) {
          const p = E.out5(seg(t, j * SLOT, j * SLOT + 0.3));
          const big = node.querySelector(".big");
          big.style.transform = `scale(${lerp(1.5, 1, p)})`;
          big.style.filter = `blur(${(1 - p) * 10}px)`;
          const small = node.querySelector(".small");
          small.style.opacity = E.out3(seg(t, j * SLOT + 0.12, j * SLOT + 0.35));
        }
      });
      const ct = t - items.length * SLOT;
      counter.style.display = fixes && ct >= 0 ? "flex" : "none";
      if (fixes && ct >= 0) {
        n.textContent = String(Math.round(E.out3(seg(ct, 0, 0.8)) * fixes.count));
        const pp = E.outBack(seg(ct, 0.75, 1.0));
        plus.style.display = "inline-block";
        plus.style.transform = `scale(${pp})`;
      }
    };
  };
}

// --- Contributors: avatar tiles fly in and assemble into a block h.
const avatarLoads = [];

/**
 * Lay out the smallest block h that holds n tiles, in the flat mark's
 * proportions: a stem about 40% of the width, a shoulder a third of the way
 * down, and a one-column gap between the legs for the bottom third.
 * 22 people fill a 5x6 h exactly; leftover cells become filler tiles.
 */
function blockH(n) {
  for (let cols = 3; cols < 24; cols += 1) {
    const rows = Math.round(cols * 1.2);
    const stem = Math.max(1, Math.round(cols * 0.4));
    const shoulder = Math.max(1, Math.round(rows / 3));
    const legs = Math.max(1, Math.round(rows / 3));
    const cells = [];
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        const inStem = x < stem;
        const inGap = x === stem && y >= rows - legs;
        if (inStem || (y >= shoulder && !inGap)) cells.push([x, y]);
      }
    }
    if (cells.length >= n) return { cols, rows, stem, shoulder, legs, cells };
  }
  throw new Error(`too many contributors for the h layout: ${n}`);
}

function buildContributors(root) {
  const stream = buildDiffStream(root, 222, {
    add: "rgba(93,208,106,0.08)",
    del: "rgba(239,107,91,0.06)",
    ctx: "rgba(244,241,234,0.03)",
  });
  root.appendChild(el("div", "vignette"));
  const h = blockH(PEOPLE.length);
  const C = Math.floor(Math.min(744 / h.rows, 640 / h.cols));
  const G = Math.max(6, Math.round(C * 0.1));
  const T = C - G;
  const W = h.cols * C - G;
  const H = h.rows * C - G;
  const ox = 230 + Math.round((640 - W) / 2);
  const oy = Math.round((1080 - H) / 2);
  const ex = Math.round(C * 0.15);
  // The h silhouette, offset like the logo's outline extrusion.
  const stemR = h.stem * C - G;
  const gapR = (h.stem + 1) * C;
  const legTop = (h.rows - h.legs) * C - G;
  const outline = `M0 0H${stemR}V${h.shoulder * C}H${W}V${H}H${gapR}V${legTop}H${stemR}V${H}H0Z`;
  const exSvg = el("div", "abs");
  exSvg.style.left = `${ox + ex}px`;
  exSvg.style.top = `${oy + ex}px`;
  exSvg.innerHTML = `<svg width="${W + 10}" height="${H + 10}" style="overflow:visible"><path d="${outline}" fill="none" stroke="#5dd06a" stroke-width="5" stroke-linejoin="miter"/></svg>`;
  root.appendChild(exSvg);
  const exPath = exSvg.querySelector("path");

  const r = rng(4242);
  const stagger = Math.min(0.055, 1.25 / Math.max(1, h.cells.length));
  const tiles = h.cells.map(([cx, cy], i) => {
    const who = PEOPLE[i];
    const tile = el("div", "abs");
    tile.style.width = `${T}px`;
    tile.style.height = `${T}px`;
    tile.style.borderRadius = "6px";
    tile.style.overflow = "hidden";
    if (who?.avatar) {
      tile.style.border = "4px solid #f4f1ea";
      const img = el("img");
      img.src = `${AVATARS}/${who.avatar}`;
      img.style.width = "100%";
      img.style.height = "100%";
      img.style.display = "block";
      avatarLoads.push(img.decode().catch(() => {}));
      tile.appendChild(img);
    } else if (who) {
      tile.style.border = "4px solid #f4f1ea";
      tile.style.background = "#5dd06a";
      tile.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:${Math.round(T * 0.42)}px;font-weight:800;color:#16140f">${who.initials}</div>`;
    } else {
      // Filler cell: completes the h without claiming another contributor.
      tile.style.border = "3px solid rgba(244,241,234,0.25)";
      tile.innerHTML = `<div style="padding:24%;opacity:0.35">${flatMarkSvg("#f4f1ea")}</div>`;
    }
    root.appendChild(tile);
    const angle = r() * Math.PI * 2;
    const dist = 900 + r() * 500;
    return {
      tile,
      real: Boolean(who),
      tx: ox + cx * C,
      ty: oy + cy * C,
      sx: 960 + Math.cos(angle) * dist - T / 2,
      sy: 540 + Math.sin(angle) * dist * 0.7 - T / 2,
      rot: (r() - 0.5) * 120,
      delay: 0.1 + i * stagger + r() * 0.05,
    };
  });
  const assembled = Math.max(...tiles.map((tl) => tl.delay)) + 0.55;

  const plural = PEOPLE.length === 1 ? "contributor" : "contributors";
  const handle = (who) => (who.login ? `@${who.login}` : who.name);
  const text = el("div", "abs");
  text.style.left = "1000px";
  text.style.top = "250px";
  text.style.width = "860px";
  text.innerHTML = `
    <div style="font-size:250px;font-weight:800;line-height:0.9;letter-spacing:-0.05em"><span class="n">0</span></div>
    <div class="lbl" style="font-size:88px;font-weight:800;letter-spacing:-0.03em;color:#5dd06a">${plural}</div>
    <div class="sub" style="margin-top:22px;font-size:36px;font-weight:600;color:#c3c9cf">${SB.contributors?.thanks ?? `shipped ${SB.version} together. thank you.`}</div>
    <div class="names" style="margin-top:34px;font-size:${PEOPLE.length > 30 ? 18 : 22}px;line-height:1.6;color:#9aa4af">${PEOPLE.map((who) => `<span style="white-space:nowrap">${handle(who)}</span>`).join(" · ")}</div>
  `;
  root.appendChild(text);
  const count = text.querySelector(".n");
  const lbl = text.querySelector(".lbl");
  const sub = text.querySelector(".sub");
  const names = text.querySelector(".names");

  return (t) => {
    stream(t);
    let landed = 0;
    for (const tl of tiles) {
      const p = seg(t, tl.delay, tl.delay + 0.55);
      const m = E.out5(p);
      const x = lerp(tl.sx, tl.tx, m);
      const y = lerp(tl.sy, tl.ty, m);
      const s = p >= 1 ? 1 : lerp(0.5, 1, E.outBack(p));
      tl.tile.style.transform = `translate(${x}px, ${y}px) rotate(${(1 - m) * tl.rot}deg) scale(${s})`;
      tl.tile.style.left = "0";
      tl.tile.style.top = "0";
      tl.tile.style.opacity = p > 0 ? 1 : 0;
      if (tl.real && p >= 0.92) landed += 1;
    }
    count.textContent = String(landed);
    const len = exPath.getTotalLength();
    const pe = E.out3(seg(t, assembled - 0.1, assembled + 0.45));
    exPath.style.strokeDasharray = `${len}`;
    exPath.style.strokeDashoffset = `${len * (1 - pe)}`;
    const pl = E.out3(seg(t, 0.2, 0.6));
    lbl.style.opacity = pl;
    const ps = E.out3(seg(t, assembled - 0.05, assembled + 0.35));
    sub.style.opacity = ps;
    sub.style.transform = `translateY(${(1 - ps) * 20}px)`;
    names.style.opacity = E.out3(seg(t, assembled + 0.25, assembled + 0.75));
    // Pop the count once the h is complete.
    const pop = seg(t, assembled - 0.2, assembled + 0.1);
    count.parentElement.style.transform = `scale(${1 + Math.sin(pop * Math.PI) * 0.08})`;
    count.parentElement.style.transformOrigin = "0 70%";
    count.parentElement.style.color = landed === PEOPLE.length ? "#f4f1ea" : "#c3c9cf";
  };
}

/** Seconds the contributors scene needs to assemble, credit everyone, and hold. */
function contributorsDuration() {
  const cells = blockH(PEOPLE.length).cells.length;
  const stagger = Math.min(0.055, 1.25 / Math.max(1, cells));
  return 0.1 + cells * stagger + 0.55 + 2.4;
}

// --- Outro: lockup, install command typed out.
function buildOutro(root) {
  const stream = buildDiffStream(root, 99, {
    add: "rgba(93,208,106,0.08)",
    del: "rgba(239,107,91,0.06)",
    ctx: "rgba(244,241,234,0.03)",
  });
  root.appendChild(el("div", "vignette"));
  const lk = buildLockup();
  const holder = el("div", "abs");
  holder.style.left = "560px";
  holder.style.top = "190px";
  lk.svg.style.width = "800px";
  holder.appendChild(lk.svg);
  root.appendChild(holder);
  const out = el("div", "abs");
  out.style.left = "0";
  out.style.right = "0";
  out.style.top = "560px";
  out.style.textAlign = "center";
  out.style.fontSize = "46px";
  out.style.fontWeight = "700";
  out.innerHTML = `<span style="background:#5dd06a;color:#16140f;padding:4px 16px;border-radius:4px">${SB.version}</span>&nbsp; ${SB.outro?.headline ?? "is out now"}`;
  root.appendChild(out);
  const install = el("div", "install");
  root.appendChild(install);
  const foot = el("div", "outro-foot", SB.outro?.foot ?? BRAND.foot);
  root.appendChild(foot);
  const site = el("div", "abs");
  site.style.left = "0";
  site.style.right = "0";
  site.style.top = "950px";
  site.style.textAlign = "center";
  site.style.fontSize = "40px";
  site.style.fontWeight = "800";
  site.style.letterSpacing = "0.1em";
  site.textContent = SB.outro?.site ?? BRAND.site;
  root.appendChild(site);
  const CMD = SB.outro?.install ?? BRAND.install;
  return (t) => {
    stream(t);
    animateLockup(lk, t, { face: 0.05, strokes: 0.3, letters: 0.5 });
    const po = E.out3(seg(t, 0.9, 1.3));
    out.style.opacity = po;
    out.style.transform = `translateY(${(1 - po) * 30}px)`;
    const pi = E.out5(seg(t, 1.2, 1.6));
    install.style.opacity = pi;
    install.style.transform = `translateX(-50%) translateY(${(1 - pi) * 40}px)`;
    const n = Math.round(seg(t, 1.5, 1.5 + CMD.length * 0.028) * CMD.length);
    const blink = Math.floor(t * 2.4) % 2 === 0 || n < CMD.length;
    install.innerHTML = `<span class="p">❯</span> ${CMD.slice(0, n)}<span class="caret" style="opacity:${blink ? 1 : 0}"></span>`;
    const pf = E.out3(seg(t, 2.9, 3.3));
    foot.style.opacity = pf;
    const ps = E.out3(seg(t, 3.2, 3.6));
    site.style.opacity = ps;
    site.style.color = "#5dd06a";
  };
}

// ------------------------------------------------------------------
// Transitions. The incoming scene is drawn over the outgoing one.
// ------------------------------------------------------------------
const H_MASK = `url("data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 99'><path d='${H_CUTOUT}' fill='black'/></svg>`,
)}")`;
const hEdge = el("div", "abs");
hEdge.style.inset = "0";
hEdge.style.pointerEvents = "none";
hEdge.style.zIndex = "50";
hEdge.innerHTML = `<svg width="1920" height="1080" style="position:absolute;left:0;top:0;overflow:visible"><path d="${H_CUTOUT}" fill="none" stroke="#5dd06a" vector-effect="non-scaling-stroke" stroke-width="10"/></svg>`;
stage.appendChild(hEdge);
const hEdgePath = hEdge.querySelector("path");

/** Reveal the scene through an h-shaped window that grows past the frame. */
function hZoom(root, p) {
  const k0 = 2.2;
  const k1 = 70;
  const k = k0 * Math.pow(k1 / k0, E.inOutExpo(p));
  const cx = 26;
  const cy = 60;
  const x = 960 - cx * k;
  const y = 540 - cy * k;
  root.style.webkitMaskImage = H_MASK;
  root.style.webkitMaskRepeat = "no-repeat";
  root.style.webkitMaskSize = `${100 * k}px ${99 * k}px`;
  root.style.webkitMaskPosition = `${x}px ${y}px`;
  hEdge.style.display = "block";
  hEdgePath.setAttribute("transform", `translate(${x} ${y}) scale(${k})`);
}

/** Slanted wipe whose edge echoes the mark's 30° extrusion. */
function slantWipe(root, p) {
  const e = E.inOut3(p);
  const x = lerp(-500, 2420, e);
  root.style.clipPath = `polygon(0 0, ${x}px 0, ${x - 420}px 1080px, 0 1080px)`;
  hEdge.style.display = "none";
}

function riseIn(root, p) {
  root.style.transform = `translateY(${(1 - E.out5(p)) * 1080}px)`;
}

function clearTransition(root) {
  root.style.webkitMaskImage = "";
  root.style.clipPath = "";
  root.style.transform = "";
}

// ------------------------------------------------------------------
// Timeline: sting, hook, one title + terminal pair per chapter, montage,
// contributors, outro. Durations follow the storyboard's content.
// ------------------------------------------------------------------
const TITLE_DUR = 1.45;
let cursor = 0;
const timeline = [];
function push(def, dur) {
  const scene = addScene(def);
  scene.start = cursor;
  scene.dur = dur;
  cursor += dur;
  timeline.push(scene);
  return scene;
}

push({ build: buildSting, theme: "ink" }, 2.75);
push({ build: buildHook, theme: "paper", trans: slantWipe, transDur: 0.45 }, 2.3);
for (const [i, chapter] of SB.chapters.entries()) {
  const spec = { ...chapter, num: i + 1 };
  push(
    {
      build: buildChapterTitle(spec),
      theme: "ink",
      trans: i === 0 ? hZoom : slantWipe,
      transDur: i === 0 ? 0.75 : 0.45,
    },
    TITLE_DUR,
  );
  const termScene = addScene({
    build: buildChapterTerm(spec),
    theme: "paper",
    trans: riseIn,
    transDur: 0.5,
  });
  termScene.start = cursor;
  termScene.dur = termScene.termDuration + 0.25;
  cursor += termScene.dur;
  timeline.push(termScene);
}
if (SB.montage?.items?.length || SB.montage?.fixes) {
  const items = SB.montage.items ?? [];
  push(
    {
      build: buildMontage({ items, fixes: SB.montage.fixes }),
      theme: "ink",
      trans: slantWipe,
      transDur: 0.4,
    },
    items.length * MONTAGE_SLOT + (SB.montage.fixes ? FIXES_DUR : 0),
  );
}
if (PEOPLE.length > 0) {
  push(
    { build: buildContributors, theme: "ink", trans: slantWipe, transDur: 0.4 },
    contributorsDuration(),
  );
}
push({ build: buildOutro, theme: "ink", trans: hZoom, transDur: 0.8 }, 5.2);
window.TIMELINE_DURATION = cursor;

window.renderAt = async function renderAt(t) {
  let ci = timeline.findIndex((s) => t < s.start + s.dur);
  if (ci < 0) ci = timeline.length - 1;
  const cur = timeline[ci];
  const prev = timeline[ci - 1];
  const inTrans = cur.trans && prev && t - cur.start < cur.transDur;
  for (const s of timeline) {
    const visible = s === cur || (inTrans && s === prev);
    s.root.style.display = visible ? "block" : "none";
    s.root.style.zIndex = s === cur ? 2 : 1;
  }
  hEdge.style.display = "none";
  if (inTrans) {
    await prev.render(t - prev.start);
    clearTransition(prev.root);
    cur.trans(cur.root, (t - cur.start) / cur.transDur);
  } else {
    clearTransition(cur.root);
  }
  await cur.render(t - cur.start);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return true;
};

window.timelineReady = document.fonts.ready.then(async () => {
  await document.fonts.load('800 40px "JBM"');
  await document.fonts.load('400 40px "JBM Nerd"');
  await Promise.all(avatarLoads);
  return true;
});
