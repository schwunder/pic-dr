/* main.js – DR runner + thumbnail viewer (all-in-one)
   Two pre-rendered zoom levels (full + half) + live thumbs
   Hi-DPI aware, smooth zoom & pan                                  */
/* Requires <script src="https://d3js.org/d3.v7.min.js"></script>   */

(() => {
  /* ────────────────────────────────────────────────────────────
     0)  Constants
  ──────────────────────────────────────────────────────────── */
  const THUMB_ROOT        = "http://localhost:3001/thumbnails";
  const RESIZED_ROOT      = "http://localhost:3001/resized";
  const IMAGE_SIZE        = 150;          // thumbnails are 75×75 (AVIF)
  const MAX_BITMAP_SIZE   = 8_192;      // baked bitmap edge (full)
  const THUMB_CONCURRENCY = 16;          // parallel thumb downloads

  /* ────────────────────────────────────────────────────────────
     1)  Quick DOM helpers
  ──────────────────────────────────────────────────────────── */
  const $ = (sel) => document.querySelector(sel);

  function showStatus(msg, err = false) {
    statusSpan.textContent = msg;
    statusSpan.style.color = err ? "crimson" : "#555";
  }

  async function fetchJSON(path, opts = {}) {
    const res = await fetch(path, opts);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  /* ────────────────────────────────────────────────────────────
     2)  UI refs
  ──────────────────────────────────────────────────────────── */
  const methodSel   = $("#method");
  const stratSel    = $("#strategy");
  const subsetIn    = $("#subset");
  const paramsDiv   = $("#params");
  const runBtn      = $("#run");
  const statusSpan  = $("#status");
  const metaPre     = $("#meta");

  const canvas      = $("#canvas");
  const ctx         = canvas.getContext("2d");

  const html        = document.documentElement;
  const resizedPane = $("#resized");

  /* ────────────────────────────────────────────────────────────
     3)  Hi-DPI-aware canvas sizing
  ──────────────────────────────────────────────────────────── */
  function dimensions(c) {
    const dpr  = window.devicePixelRatio || 1;
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;

    // Resize backing store (device pixels)
    c.width  = Math.round(cssW * dpr);
    c.height = Math.round(cssH * dpr);

    // Keep element visually the same size
    c.style.width  = cssW + "px";
    c.style.height = cssH + "px";

    return { width: cssW, height: cssH, dpr };
  }

  /* ────────────────────────────────────────────────────────────
     4)  Scales helper (for baking)
  ──────────────────────────────────────────────────────────── */
  function createScales(points, margin, dims) {
    const xExt = d3.extent(points, (p) => p.x);
    const yExt = d3.extent(points, (p) => p.y);

    const dataW = xExt[1] - xExt[0];
    const dataH = yExt[1] - yExt[0];
    const aspect = dataW / dataH;
    const size = Math.min(dims.width, dims.height) - 2 * margin;

    const x = d3.scaleLinear().domain(xExt).range([margin, margin + size * aspect]);
    const y = d3.scaleLinear().domain(yExt).range([margin + size, margin]); // flip Y

    return { x, y };
  }

  /* ────────────────────────────────────────────────────────────
     5)  Thumbnail loader
  ──────────────────────────────────────────────────────────── */
  function loadImage(url) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => res(img);
      img.onerror = () => rej(new Error("failed to load " + url));
      img.src = url;
    });
  }

  async function addThumbnails(points, root = THUMB_ROOT) {
    const q = [...points];
    const inFlight = new Set();

    async function next() {
      if (!q.length) return;
      const p = q.pop();
      const task = loadImage(`${root}/${p.filename}`)
        .then((img) => (p.thumb = img))
        .catch(() => (p.thumb = null))
        .finally(() => {
          inFlight.delete(task);
          next();
        });
      inFlight.add(task);
      if (inFlight.size < THUMB_CONCURRENCY) next();
    }

    for (let i = 0; i < THUMB_CONCURRENCY && i < q.length; i++) next();
    await Promise.all(inFlight);
  }

  /* ────────────────────────────────────────────────────────────
     6)  Bitmap bakery (full + half)
  ──────────────────────────────────────────────────────────── */
  async function bakeBitmap(points, w, h, boundsKey) {
    const off = document.createElement("canvas");
    off.width = w;
    off.height = h;
    const offCtx = off.getContext("2d");

    const sc = createScales(points, 40, { width: w, height: h });

    points.forEach((p) => {
      const cx = sc.x(p.x);
      const cy = sc.y(p.y);
      p[boundsKey] = { x: cx - IMAGE_SIZE / 2, y: cy - IMAGE_SIZE / 2, width: IMAGE_SIZE, height: IMAGE_SIZE };
      if (p.thumb) offCtx.drawImage(p.thumb, p[boundsKey].x, p[boundsKey].y, IMAGE_SIZE, IMAGE_SIZE);
    });

    return createImageBitmap(off);
  }

  async function makeBitmaps(points) {
    const full = await bakeBitmap(points, MAX_BITMAP_SIZE, MAX_BITMAP_SIZE, "fullBounds");
    const half = await bakeBitmap(points, MAX_BITMAP_SIZE / 2, MAX_BITMAP_SIZE / 2, "halfBounds");
    return { full, half };
  }

  /* ────────────────────────────────────────────────────────────
     7)  Adaptive renderer (zoom-aware)
  ──────────────────────────────────────────────────────────── */
  function chooseBitmap(k) {
    if (k < 0.5) return state.bitmaps.half;  // far out
    if (k < 1.0) return state.bitmaps.full;  // medium
    return null;                             // close-up → live thumbs
  }

  function renderView(ctx, dims, transform) {
    const { width, height, dpr } = dims;
    const bmp = chooseBitmap(transform.k);

    // Clear in device pixels
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width * dpr, height * dpr);

    // Base DPR scale then user transform
    ctx.scale(dpr, dpr);
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.k, transform.k);

    if (bmp) {
      ctx.imageSmoothingEnabled = transform.k < 1;
      ctx.drawImage(bmp, 0, 0);
    } else {
      ctx.imageSmoothingEnabled = false;
      const view = {
        x0: -transform.x / transform.k,
        y0: -transform.y / transform.k,
        x1: (-transform.x + width)  / transform.k,
        y1: (-transform.y + height) / transform.k,
      };
      for (const p of state.points) {
        const b = p.fullBounds;
        if (!b) continue;
        if (b.x + b.width  < view.x0 || b.x > view.x1 ||
            b.y + b.height < view.y0 || b.y > view.y1) continue;
        if (p.thumb) ctx.drawImage(p.thumb, b.x, b.y, IMAGE_SIZE, IMAGE_SIZE);
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0); // reset for hit-tests
  }

  function getFitScale(dims, bmpW, bmpH) {
    return Math.min(dims.width / bmpW, dims.height / bmpH);
  }

  function setupZoom(canvas, onZoom) {
    return d3.zoom().scaleExtent([0.01, 20]).on("zoom", (e) => onZoom(e.transform));
  }

  function resetZoom(canvas, scale) {
    const t = d3.zoomIdentity.scale(scale);
    d3.select(canvas).call(d3.zoom().transform, t);
    return t;
  }

  function hitTest(points, clientX, clientY, rect, transform, boundsKey) {
    const x = (clientX - rect.left - transform.x) / transform.k;
    const y = (clientY - rect.top  - transform.y) / transform.k;
    const tol = 20;
    return points.find((p) => {
      const b = p[boundsKey];
      return b && x >= b.x - tol && x <= b.x + b.width + tol &&
             y >= b.y - tol && y <= b.y + b.height + tol;
    });
  }

  /* ────────────────────────────────────────────────────────────
     8)  Artist info panel
  ──────────────────────────────────────────────────────────── */
  async function loadArtist(name) {
    try {
      const data = await fetchJSON("/api/artists");
      return data.find((a) => a.name === name);
    } catch {
      return null;
    }
  }

  function showArtistInfo(point) {
    const imageEl = $("#image");
    imageEl.innerHTML = "<p>Loading…</p>";

    Promise.all([
      loadImage(`${RESIZED_ROOT}/${point.filename}`),
      loadArtist(point.artist),
    ]).then(([img, artist]) => {
      imageEl.innerHTML = "";
      imageEl.appendChild(img);
      if (artist) {
        ["bio", "genre", "name", "nationality",
         "paintings", "wikipedia", "years"].forEach((key) => {
          const el = $("#" + key);
          if (el) el.textContent = artist[key] || "";
        });
      }
    });
  }

  /* ────────────────────────────────────────────────────────────
     9)  State machine
  ──────────────────────────────────────────────────────────── */
  const AppState = {
    LOADING_DATA     : "loading_data",
    LOADING_IMAGES   : "loading_images",
    CREATING_BITMAPS : "creating_bitmaps",
    VIEWING          : "viewing",
    DETAIL           : "detail",
  };

  const state = {
    current   : AppState.LOADING_DATA,
    points    : [],
    bitmaps   : { full: null, half: null },
    transform : d3.zoomIdentity,
    selectedPoint: null,

    transition(to, payload = {}) {
      this.current = to;
      if (to === AppState.DETAIL) {
        this.selectedPoint = payload.point;
        html.classList.add("show-resized");
      } else if (to === AppState.VIEWING) {
        html.classList.remove("show-resized");
      }
      updateView();
    },
  };

  function updateView() {
    const dims = dimensions(canvas);
    renderView(ctx, dims, state.transform);
  }

  /* ────────────────────────────────────────────────────────────
     10)  DR runner + viewer initialise
  ──────────────────────────────────────────────────────────── */
  function collectParams() {
    return Object.fromEntries([...paramsDiv.querySelectorAll("[data-p]")].map((i) => {
      let v;
      if (i.type === "checkbox") v = i.checked;
      else if (i.tagName === "SELECT") v = i.value;
      else v = parseFloat(i.value);
      return [i.dataset.p, v];
    }));
  }

  async function runDR() {
    const payload = {
      method          : methodSel.value,
      subset_strategy : stratSel.value,
      subset_size     : Math.min(500, +subsetIn.value || 250),
      params          : collectParams(),
    };

    let resp;
    try {
      showStatus("running …");
      resp = await fetch("/", {
        method  : "POST",
        headers : { "Content-Type": "application/json" },
        body    : JSON.stringify(payload),
      });
    } catch (e) {
      console.error(e);
      return showStatus("network error", true);
    }

    if (!resp.ok) {
      console.error(await resp.text());
      return showStatus("DR failed", true);
    }

    const { config, points } = await resp.json();
    metaPre.textContent = JSON.stringify(config, null, 2);
    showStatus(`✔️ #${config.config_id}: ${points.length} pts in ${config.runtime.toFixed(2)} s`);

    /* hydrate viewer state */
    state.transition(AppState.LOADING_IMAGES);
    state.points = points;  // {x, y, filename, artist}
    await addThumbnails(state.points);

    state.transition(AppState.CREATING_BITMAPS);
    state.bitmaps = await makeBitmaps(state.points);

    setupInteractions();  // idempotent
    state.transition(AppState.VIEWING);
  }

  /* ────────────────────────────────────────────────────────────
     11)  Interactions
  ──────────────────────────────────────────────────────────── */
  let interactionsReady = false;
  function setupInteractions() {
    if (interactionsReady) return;
    interactionsReady = true;

    const onZoom = (t) => {
      console.log("zoom!", t);          // <-- add

      state.transform = t;
      updateView();
    };

    const zoomBehavior = setupZoom(canvas, onZoom);
    console.log("zoomBehaviour", zoomBehavior); // <-- add

    const dims = dimensions(canvas);
    const startScale = getFitScale(dims, MAX_BITMAP_SIZE, MAX_BITMAP_SIZE);
    state.transform = d3.zoomIdentity.scale(startScale);
    d3.select(canvas)
      .call(zoomBehavior)                       // <— installs wheel / drag
      .call(zoomBehavior.transform, state.transform); // sets start view

    /* hit-test on click */
    canvas.addEventListener("click", (e) => {
      const rect = canvas.getBoundingClientRect();
      const bKey = state.current === AppState.DETAIL ? "halfBounds" : "fullBounds";
      const p = hitTest(state.points, e.clientX, e.clientY, rect, state.transform, bKey);
      if (p) {
        state.transition(AppState.DETAIL, { point: p });
        showArtistInfo(p);
      }
    });

    /* click outside to close */
    resizedPane.addEventListener("click", (e) => {
      if (e.target === resizedPane) state.transition(AppState.VIEWING);
    });

    /* Esc closes detail + resets zoom */
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (state.current === AppState.DETAIL) state.transition(AppState.VIEWING);
        const dims = dimensions(canvas);
        const s = getFitScale(dims, MAX_BITMAP_SIZE, MAX_BITMAP_SIZE);
        state.transform = resetZoom(canvas, s);
        updateView();
      }
    });

    /* resize handler */
    window.addEventListener("resize", updateView);
  }

  /* ────────────────────────────────────────────────────────────
     12)  DR params form helpers
  ──────────────────────────────────────────────────────────── */
  async function initSelectors() {
    const [methods, subsets] = await Promise.all([
      fetchJSON("/api/methods"),
      fetchJSON("/api/subsets"),
    ]);
    methods.forEach((m) => methodSel.add(new Option(m, m)));
    subsets.forEach((s) => stratSel.add(new Option(s, s)));
  }

  async function renderParams(method) {
    const defs = await fetchJSON(`/api/params?method=${method}`);
    paramsDiv.innerHTML = "";
    defs.forEach((def) => {
      const row = document.createElement("div");
      row.className = "param-row";
      const lbl = document.createElement("label");
      lbl.textContent = def.name;
      row.append(lbl);

      let inp;
      if (def.type === "select") {
        inp = document.createElement("select");
        def.options.forEach((o) => inp.add(new Option(o, o)));
        inp.value = def.value;
      } else if (def.type === "checkbox") {
        inp = document.createElement("input");
        inp.type = "checkbox";
        inp.checked = def.value;
      } else {
        inp = document.createElement("input");
        inp.type = "range";
        Object.assign(inp, {
          min  : def.min,
          max  : def.max,
          step : def.step,
          value: def.value,
        });
        const out = document.createElement("output");
        out.textContent = inp.value;
        inp.oninput = () => (out.textContent = inp.value);
        row.append(out);
      }

      inp.dataset.p = def.name;
      row.append(inp);
      paramsDiv.append(row);
    });
  }

  /* ────────────────────────────────────────────────────────────
     13)  Boot
  ──────────────────────────────────────────────────────────── */
  window.addEventListener("DOMContentLoaded", async () => {
    await initSelectors();
    await renderParams(methodSel.value);

    methodSel.onchange = () => renderParams(methodSel.value);
    runBtn.onclick     = () => runDR();

    /* optional: auto-run once at boot */
    runDR();
  });
})();
