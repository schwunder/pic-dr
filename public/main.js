/* main.js – DR runner + thumbnail viewer (all-in-one)
   Multiple pre-rendered zoom levels with quadtree-based tiles + live thumbs
   Hi-DPI aware, smooth zoom & pan, optimized rendering               */
/* Requires D3.js and the d3-quadtree extension                      */

(() => {
  /* ────────────────────────────────────────────────────────────
     0)  Constants
  ──────────────────────────────────────────────────────────── */
  const THUMB_ROOT        = "http://localhost:3001/thumbnails";
  const RESIZED_ROOT      = "http://localhost:3001/resized";
  const IMAGE_SIZE        = 150;          // thumbnails are 75×75 (AVIF)
  const MAX_BITMAP_SIZE   = 8_192;      // baked bitmap edge (full)
  const THUMB_CONCURRENCY = 32;          // parallel thumb downloads (increased for faster loading)
  const QUADTREE_MIN_SIZE = 1024;       // min size for quadtree tiles
  const QUADTREE_DEPTH    = 3;          // max depth of quadtree (0=root, 1=4 tiles, 2=16 tiles, 3=64 tiles)
  const DEBUG_QUADTREE    = false;      // draw quadtree bounds for debugging
  const RETRY_ATTEMPTS    = 3;          // number of retries for failed image loads
  const RETRY_DELAY       = 500;        // delay between retries in ms

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
  async function loadImage(url, retryAttempts = RETRY_ATTEMPTS) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous"; // CORS
      
      // Track retry attempts
      let attempts = 0;
      
      function attemptLoad() {
        attempts++;
        img.src = url + (url.includes('?') ? '&' : '?') + `cache=${Date.now()}`; // Cache busting
      }
      
      img.onload = () => resolve(img);
      
      img.onerror = () => {
        if (attempts < retryAttempts) {
          // Retry with exponential backoff
          console.warn(`Retrying image load (${attempts}/${retryAttempts}): ${url}`);
          setTimeout(attemptLoad, RETRY_DELAY * Math.pow(2, attempts-1));
        } else {
          const msg = `Failed to load image after ${retryAttempts} attempts: ${url}`;
          console.error(msg);
          reject(new Error(msg));
        }
      };
      
      // Start first attempt
      attemptLoad();
    });
  }

  async function addThumbnails(points, root = THUMB_ROOT) {
    // Show progress status
    showStatus("Loading thumbnails...");
    console.log('addThumbnails: start', { pointsCount: points.length, root });
    
    // Define the thumbnail sizes we need
    const PRIMARY_SIZE = 125;
    const ALL_SIZES = [125, 250, 300, 400, 500, 600, 700, 800];
    
    // Track overall progress
    let loadedCount = 0;
    let totalToLoad = points.length;
    let startTime = performance.now();
    let errors = [];
    
    // Prioritize points based on position (center points first)
    // This helps improve perceived loading speed
    const centerX = d3.mean(points, d => d.x);
    const centerY = d3.mean(points, d => d.y);
    
    // Sort points by distance from center
    const sortedPoints = [...points].map(p => ({
      point: p,
      distSq: Math.pow(p.x - centerX, 2) + Math.pow(p.y - centerY, 2)
    }));
    
    // First load the center points, then outer points
    sortedPoints.sort((a, b) => a.distSq - b.distSq);
    
    // Use a queue with controlled concurrency
    const queue = sortedPoints.map(sp => sp.point);
    const activePromises = new Set();
    const results = [];
    
    // Helper to update loading progress
    const updateProgress = () => {
      const percent = Math.round((loadedCount / totalToLoad) * 100);
      const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
      const pointsPerSecond = Math.round(loadedCount / (elapsed / 1000));
      
      showStatus(`Loading thumbnails: ${percent}% (${loadedCount}/${totalToLoad}, ${pointsPerSecond} pts/sec)`);
      
      // Update HTML element with more detailed progress if available
      const progressEl = $("#loading-progress");
      if (progressEl) {
        progressEl.innerHTML = `
          <div class="progress-bar" style="width:${percent}%"></div>
          <div class="progress-text">
            Loading images: ${loadedCount}/${totalToLoad} (${percent}%)<br>
            Time: ${elapsed}s (${pointsPerSecond} imgs/sec)
          </div>
        `;
      }
    };
    
    // Process a single point
    const processPoint = async (p) => {
      try {
        // Load the primary thumbnail first
        try {
          p[`thumb${PRIMARY_SIZE}`] = await loadImage(`${root}/${PRIMARY_SIZE}/${p.filename}`);
        } catch (primaryErr) {
          // Try fallback path
          try {
            p[`thumb${PRIMARY_SIZE}`] = await loadImage(`${root.replace(/\/125$/, '')}/${p.filename}`);
          } catch (fallbackErr) {
            errors.push({
              filename: p.filename,
              error: `Failed to load primary thumbnail: ${fallbackErr.message}`
            });
            // Create an emergency placeholder (red square with filename)
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = PRIMARY_SIZE;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = 'darkred';
            ctx.fillRect(0, 0, PRIMARY_SIZE, PRIMARY_SIZE);
            ctx.fillStyle = 'white';
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(p.filename.slice(0, 15), PRIMARY_SIZE/2, PRIMARY_SIZE/2);
            
            // Convert to image
            const placeholder = new Image();
            placeholder.src = canvas.toDataURL();
            await new Promise(resolve => {
              placeholder.onload = resolve;
            });
            p[`thumb${PRIMARY_SIZE}`] = placeholder;
          }
        }
        
        // Assign the primary thumbnail as fallback for all other sizes
        for (const size of ALL_SIZES) {
          if (!p[`thumb${size}`]) {
            p[`thumb${size}`] = p[`thumb${PRIMARY_SIZE}`];
          }
        }
        
        loadedCount++;
        // Only update progress every 5 images or for multiples of 10%
        if (loadedCount % 5 === 0 || loadedCount / totalToLoad * 100 % 10 === 0) {
          updateProgress();
        }
        
        return true;
      } catch (err) {
        console.error(`Failed to process thumbnails for ${p.filename}:`, err);
        errors.push({ filename: p.filename, error: err.message });
        loadedCount++;
        updateProgress();
        return false;
      }
    };
    
    // Process the queue with controlled concurrency
    while (queue.length > 0 || activePromises.size > 0) {
      // Fill up to concurrency limit
      while (queue.length > 0 && activePromises.size < THUMB_CONCURRENCY) {
        const point = queue.shift();
        const promise = processPoint(point).finally(() => {
          activePromises.delete(promise);
        });
        activePromises.add(promise);
        results.push(promise);
      }
      
      // Wait for at least one promise to complete before continuing
      if (activePromises.size >= THUMB_CONCURRENCY || queue.length === 0) {
        await Promise.race(Array.from(activePromises));
      }
    }
    
    // Wait for all remaining promises to complete
    await Promise.all(results);
    
    // Summarize results
    const endTime = performance.now();
    const durationSec = ((endTime - startTime) / 1000).toFixed(1);
    const successCount = totalToLoad - errors.length;
    
    if (errors.length > 0) {
      console.warn(`Completed with ${errors.length} errors. First 5 errors:`, errors.slice(0, 5));
      showStatus(`Loaded ${successCount}/${totalToLoad} thumbnails in ${durationSec}s (${errors.length} errors)`);
    } else {
      console.log(`Successfully loaded all ${totalToLoad} thumbnails in ${durationSec}s`);
      showStatus(`Loaded all ${totalToLoad} thumbnails in ${durationSec}s`);
    }
    
    // Verify all points have at least a primary or fallback thumbnail
    const missingThumbs = points.filter(p => !p[`thumb${PRIMARY_SIZE}`]);
    if (missingThumbs.length > 0) {
      const filenames = missingThumbs.map(p => p.filename).join(', ');
      console.error(`Still missing thumbnails for: ${filenames}`);
      // Continue anyway - we've done our best with placeholders
    }
    
    return { 
      success: successCount, 
      total: totalToLoad, 
      duration: parseFloat(durationSec),
      errors: errors 
    };
  }

  /* ────────────────────────────────────────────────────────────
     6)  Bitmap bakery (1 full + 4 quadrants)
  ───────────────────────────────────────────────────────────── */
  // Create prerender canvases for quadtree-based rendering
  function createPrerenderCanvases() {
    try {
      console.log('Creating prerender canvases for quadtree rendering');
      // Canvas size at each depth level
      const sizes = [];
      for (let depth = 0; depth <= QUADTREE_DEPTH; depth++) {
        // Size halves at each level deeper (8192, 4096, 2048, 1024, ...)
        sizes.push(MAX_BITMAP_SIZE / Math.pow(2, depth));
      }
      
      // Calculate total number of canvases needed for complete quadtree
      let totalCanvases = 0;
      for (let depth = 0; depth <= QUADTREE_DEPTH; depth++) {
        // At each depth we have 4^depth canvases (1, 4, 16, 64, ...)
        totalCanvases += Math.pow(4, depth);
      }
      
      console.log(`Creating ${totalCanvases} canvases for quadtree (max depth: ${QUADTREE_DEPTH})`);
      
      // Create all canvases with appropriate IDs
      const canvases = {};
      for (let depth = 0; depth <= QUADTREE_DEPTH; depth++) {
        const size = sizes[depth];
        const count = Math.pow(4, depth);
        
        if (size < QUADTREE_MIN_SIZE) {
          console.warn(`Skipping depth ${depth} with size ${size} (smaller than min ${QUADTREE_MIN_SIZE})`);
          continue;
        }
        
        canvases[depth] = [];
        for (let i = 0; i < count; i++) {
          const c = document.createElement('canvas');
          c.width = size;
          c.height = size;
          c.dataset.quadId = `${depth}-${i}`;
          
          // Fill with debug color
          const ctx = c.getContext('2d');
          const hue = (depth * 60) % 360;
          ctx.fillStyle = `hsl(${hue}, 20%, 90%)`;
          ctx.fillRect(0, 0, c.width, c.height);
          
          // Debug text showing quadtree coordinates
          if (DEBUG_QUADTREE) {
            ctx.fillStyle = `hsl(${hue}, 70%, 30%)`;
            ctx.font = `${size/20}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.fillText(`Quad ${depth}-${i}`, size/2, size/2);
          }
          
          canvases[depth].push(c);
        }
        console.log(`Created ${count} canvases for depth ${depth} (size: ${size}x${size})`);
      }
      
      return canvases;
    } catch (err) {
      const msg = `ERROR: Failed to create quadtree canvases: ${err.message}`;
      console.error(msg, err);
      throw new Error(msg);
    }
  }

  async function bakeBitmap(points, w, h, boundsKey) {
    // DEMO: create the 5 prerender canvases (will log in console)
    createPrerenderCanvases();
    console.log('bakeBitmap: start', { pointsCount: points.length, w, h, boundsKey });
    const off = document.createElement("canvas");
    off.width = w;
    off.height = h;
    const offCtx = off.getContext("2d");

    const sc = createScales(points, 40, { width: w, height: h });

    points.forEach((p) => {
      const cx = sc.x(p.x);
      const cy = sc.y(p.y);
      p[boundsKey] = { x: cx - IMAGE_SIZE / 2, y: cy - IMAGE_SIZE / 2, width: IMAGE_SIZE, height: IMAGE_SIZE };
      if (!p.thumb125) {
        // Explicitly throw for timing/race condition
        const msg = `ERROR: Timing/race: thumb125 for ${p.filename} not loaded when needed in bakeBitmap.`;
        console.error(msg);
        throw new Error(msg);
      }
      offCtx.drawImage(p.thumb125, p[boundsKey].x, p[boundsKey].y, IMAGE_SIZE, IMAGE_SIZE);
      console.log(`bakeBitmap: drew thumb125 for ${p.filename} at (${p[boundsKey].x}, ${p[boundsKey].y})`);
    });

    return createImageBitmap(off);
  }

  async function makeBitmaps(points) {
    try {
      console.log('Creating bitmap tiles using quadtree partitioning...');
      // Create spatial index using D3's quadtree
      const quadtree = d3.quadtree()
        .x(d => d.x)
        .y(d => d.y)
        .addAll(points);
      
      // Store the quadtree in state for reuse in hit testing and rendering
      state.quadtree = quadtree;
      
      // Create the quadtree bitmap tiles at various depths
      const quadBitmaps = {};
      const canvases = createPrerenderCanvases();
      
      // Bake the full bitmap (depth 0 with 1 canvas)
      console.log('Baking full-size bitmap...');
      const full = await bakeBitmap(points, MAX_BITMAP_SIZE, MAX_BITMAP_SIZE, "fullBounds");
      quadBitmaps.full = full;
      console.log('Created full bitmap');
      
      console.log('Baking 4 quadrant bitmaps (4096x4096 each)...');
      const quadSize = MAX_BITMAP_SIZE / 2;
      
      const quadrantDefs = {
        topLeft: { x1: 0, y1: 0, x2: 0.5, y2: 0.5, key: "topLeftBounds" },
        topRight: { x1: 0.5, y1: 0, x2: 1, y2: 0.5, key: "topRightBounds" },
        bottomLeft: { x1: 0, y1: 0.5, x2: 0.5, y2: 1, key: "bottomLeftBounds" },
        bottomRight: { x1: 0.5, y1: 0.5, x2: 1, y2: 1, key: "bottomRightBounds" }
      };
      
      quadBitmaps.quadrants = {};
      
      for (const [name, bounds] of Object.entries(quadrantDefs)) {
        console.log(`Baking ${name} quadrant bitmap...`);
        const quadrantPoints = points.filter(p => {
          return p.x >= bounds.x1 && p.x <= bounds.x2 && 
                 p.y >= bounds.y1 && p.y <= bounds.y2;
        });
        
        if (quadrantPoints.length > 0) {
          const quadBitmap = await bakeQuadBitmap(
            quadrantPoints, 
            quadSize, 
            quadSize, 
            bounds.key,
            {
              x1: bounds.x1, y1: bounds.y1, 
              x2: bounds.x2, y2: bounds.y2
            }
          );
          quadBitmaps.quadrants[name] = quadBitmap;
          console.log(`Created ${name} quadrant bitmap with ${quadrantPoints.length} points`);
        } else {
          console.log(`${name} quadrant is empty, skipping`);
          quadBitmaps.quadrants[name] = null;
        }
      }
      
      if (QUADTREE_DEPTH > 1) {
        quadBitmaps.quads = {};
        
        // For each depth level (starting from depth 2)
        for (let depth = 2; depth <= QUADTREE_DEPTH; depth++) {
          if (!canvases[depth]) continue; // Skip if we don't have canvases for this depth
          
          const tileSize = MAX_BITMAP_SIZE / Math.pow(2, depth);
          if (tileSize < QUADTREE_MIN_SIZE) continue; // Skip if tile size is too small
          
          console.log(`Baking ${canvases[depth].length} quadtree tiles at depth ${depth} (${tileSize}x${tileSize})`);
          
          quadBitmaps.quads[depth] = [];
          
          // For each quadrant at this depth
          for (let i = 0; i < canvases[depth].length; i++) {  
            // Calculate quadrant bounds
            const quadBounds = calculateQuadBounds(depth, i);
            
            // Find points that fall within this quadrant
            const quadPoints = [];
            quadtree.visit((node, x1, y1, x2, y2) => {
              // Skip if this node doesn't intersect with our quadrant
              if (!node.length && !node.data) return true; // Empty node, skip
              if (x1 > quadBounds.x2 || y1 > quadBounds.y2 || x2 < quadBounds.x1 || y2 < quadBounds.y1) return true; // No intersection
              
              // If this is a leaf node with data
              if (node.data) {
                const px = node.data.x;
                const py = node.data.y;
                if (px >= quadBounds.x1 && px <= quadBounds.x2 && py >= quadBounds.y1 && py <= quadBounds.y2) {
                  quadPoints.push(node.data);
                }
              }
              
              // Continue traversal
              return false;
            });
            
            // Only proceed if we have points in this quadrant
            if (quadPoints.length > 0) {
              console.log(`Quadrant ${depth}-${i} has ${quadPoints.length} points`);
              try {
                const quadBitmap = await bakeQuadBitmap(quadPoints, tileSize, tileSize, `quad${depth}_${i}Bounds`, quadBounds);
                quadBitmaps.quads[depth][i] = quadBitmap;
              } catch (err) {
                console.error(`Failed to bake quadrant ${depth}-${i}:`, err);
                quadBitmaps.quads[depth][i] = null;
              }
            } else {
              console.log(`Quadrant ${depth}-${i} is empty, skipping`);
              quadBitmaps.quads[depth][i] = null;
            }
          }
        }
      }
      
      return quadBitmaps;
    } catch (err) {
      const msg = `ERROR: Failed to create quadtree bitmaps: ${err.message}`;
      console.error(msg, err);
      throw new Error(msg);
    }
  }
  
  // Helper function to calculate quadrant bounds for a given depth and index
  function calculateQuadBounds(depth, index) {
    // For a given depth and quadrant index, calculate the bounding box in data space
    // This maps from quadrant coordinates to data coordinates
    
    // At depth 0, we have the full space
    // At depth 1, we have 4 quadrants (0=top-left, 1=top-right, 2=bottom-left, 3=bottom-right)
    // At depth 2, we have 16 quadrants, and so on
    
    const fullExtent = {
      x1: d3.min(state.points, d => d.x),
      y1: d3.min(state.points, d => d.y),
      x2: d3.max(state.points, d => d.x),
      y2: d3.max(state.points, d => d.y)
    };
    
    if (depth === 0) return fullExtent;
    
    const width = fullExtent.x2 - fullExtent.x1;
    const height = fullExtent.y2 - fullExtent.y1;
    const cols = Math.pow(2, depth);
    const rows = cols;
    const cellWidth = width / cols;
    const cellHeight = height / rows;
    
    // Calculate the row and column for this index
    const row = Math.floor(index / cols);
    const col = index % cols;
    
    return {
      x1: fullExtent.x1 + col * cellWidth,
      y1: fullExtent.y1 + row * cellHeight,
      x2: fullExtent.x1 + (col + 1) * cellWidth,
      y2: fullExtent.y1 + (row + 1) * cellHeight
    };
  }
  
  // Specialized bitmap baker for quadtree tiles
  async function bakeQuadBitmap(points, w, h, boundsKey, quadBounds) {
    if (!points || points.length === 0) {
      console.warn(`No points to bake for ${boundsKey}`);
      return null;
    }
    
    try {
      console.log(`Baking quad bitmap for ${boundsKey} with ${points.length} points`);
      const off = document.createElement("canvas");
      off.width = w;
      off.height = h;
      const offCtx = off.getContext("2d");
      
      // Map the quadrant bounds to canvas coordinates
      const xScale = d3.scaleLinear()
        .domain([quadBounds.x1, quadBounds.x2])
        .range([0, w]);
        
      const yScale = d3.scaleLinear()
        .domain([quadBounds.y1, quadBounds.y2])
        .range([0, h]);
      
      // Draw debug quadrant bounds if enabled
      if (DEBUG_QUADTREE) {
        offCtx.strokeStyle = 'rgba(0,100,255,0.5)';
        offCtx.lineWidth = 4;
        offCtx.strokeRect(2, 2, w-4, h-4);
      }
      
      // Draw each point
      let drawnCount = 0;
      for (const p of points) {
        // Skip points outside our quadrant (extra safety check)
        if (p.x < quadBounds.x1 || p.x > quadBounds.x2 || p.y < quadBounds.y1 || p.y > quadBounds.y2) {
          continue;
        }
        
        if (!p.thumb125) {
          const msg = `ERROR: Missing thumb125 for ${p.filename} in quadrant ${boundsKey}`;
          console.error(msg);
          throw new Error(msg);
        }
        
        // Map point to canvas coordinates
        const cx = xScale(p.x);
        const cy = yScale(p.y);
        
        // Store bounds for later hit testing
        p[boundsKey] = { 
          x: cx - IMAGE_SIZE/2, 
          y: cy - IMAGE_SIZE/2, 
          width: IMAGE_SIZE, 
          height: IMAGE_SIZE,
          quadrant: boundsKey
        };
        
        // Draw the thumbnail
        offCtx.drawImage(p.thumb125, 
                        cx - IMAGE_SIZE/2, 
                        cy - IMAGE_SIZE/2, 
                        IMAGE_SIZE, IMAGE_SIZE);
        drawnCount++;
      }
      
      console.log(`Drew ${drawnCount} points in quadrant ${boundsKey}`);
      return drawnCount > 0 ? await createImageBitmap(off) : null;
    } catch (err) {
      const msg = `ERROR: Failed to bake quad bitmap for ${boundsKey}: ${err.message}`;
      console.error(msg, err);
      throw new Error(msg);
    }
  }

  /* ────────────────────────────────────────────────────────────
     7)  Adaptive renderer with quadtree (zoom-aware)
  ──────────────────────────────────────────────────────────── */
  function chooseBitmap(k) {
    try {
      if (!state.bitmaps) {
        const msg = 'ERROR: Bitmaps not initialized';
        console.error(msg);
        throw new Error(msg);
      }
      
      // Validate the full bitmap - it's our primary fallback
      if (!state.bitmaps.full || !(state.bitmaps.full instanceof ImageBitmap)) {
        console.error('ERROR: Full bitmap not available or invalid, falling back to dynamic rendering. This is likely due to a failure in the bitmap creation process.');
        return { type: 'dynamic', error: 'missing_full_bitmap' };
      }
      
      // Choose the appropriate bitmap level based on zoom
      
      // Far out - use full bitmap (zoom level 0.5 and below)
      if (k < 0.5) return { bitmap: state.bitmaps.full, type: 'full' };
      
      // Medium/close distance - use appropriate quadrant bitmap based on position
      if (k < 1.5) {
        // Check if we have the quadrants available
        if (state.bitmaps.quadrants) {
          // Determine which quadrant is currently in view based on the transform
          // This is a simplified approach - in a real implementation, you would
          // determine which quadrant is most visible in the current view
          
          // Get the center of the view in normalized coordinates (0-1)
          const tx = -state.transform.x / (MAX_BITMAP_SIZE * state.transform.k);
          const ty = -state.transform.y / (MAX_BITMAP_SIZE * state.transform.k);
          
          // Determine which quadrant contains this point
          let quadrant;
          if (tx < 0.5) {
            quadrant = ty < 0.5 ? 'topLeft' : 'bottomLeft';
          } else {
            quadrant = ty < 0.5 ? 'topRight' : 'bottomRight';
          }
          
          // Use that quadrant's bitmap if available and valid
          const quadBitmap = state.bitmaps.quadrants[quadrant];
          if (quadBitmap && quadBitmap instanceof ImageBitmap) {
            return { 
              bitmap: quadBitmap, 
              type: 'quadrant', 
              quadrant: quadrant 
            };
          }
        }
        
        // If quadrants aren't available or the one we need is missing, fall back to full
        return { bitmap: state.bitmaps.full, type: 'full' };
      }
      
      // For deeper zoom levels, check if we have additional quadtree depth
      if (state.bitmaps.quads) {
        // Calculate which depth is appropriate for this zoom level
        // Higher k means we want higher depth (smaller tiles)
        const targetDepth = Math.min(
          Math.floor(Math.log2(k) + 2),  // Logarithmic depth selection
          QUADTREE_DEPTH
        );
        
        // Find the deepest available depth that's not deeper than our target
        for (let d = targetDepth; d >= 2; d--) {
          const quads = state.bitmaps.quads[d];
          if (quads && Array.isArray(quads) && quads.some(q => q instanceof ImageBitmap)) {
            return { 
              bitmap: quads, 
              type: 'quad', 
              depth: d 
            };
          }
        }
      }
      
      // Very close or no quads available - use dynamic thumbnails
      return { type: 'dynamic' };
    } catch (err) {
      console.error('ERROR: Failed to choose bitmap:', err);
      return { type: 'dynamic' }; // Fallback to dynamic rendering
    }
  }

  function renderView(ctx, dims, transform) {
    try {
      const { width, height, dpr } = dims;
      const viewInfo = chooseBitmap(transform.k);
      
      // Performance metrics tracking
      const startTime = performance.now();
      
      // Clear in device pixels
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, width * dpr, height * dpr);
      
      // Base DPR scale then user transform
      ctx.scale(dpr, dpr);
      ctx.translate(transform.x, transform.y);
      ctx.scale(transform.k, transform.k);
      
      // Track what type of rendering we're using for debugging
      window._lastRenderType = viewInfo.type;
      
      // Handle specific error conditions
      if (viewInfo.error === 'missing_full_bitmap') {
        // Log the error once per session to avoid console spam
        if (!window._bitmapErrorLogged) {
          console.error('ERROR: Bitmap rendering failed - full bitmap is missing or invalid');
          window._bitmapErrorLogged = true;
        }
      }
      
      // Calculate visible viewport in data coordinates (for culling)
      const visibleViewport = {
        x0: -transform.x / transform.k,
        y0: -transform.y / transform.k,
        x1: (-transform.x + width) / transform.k,
        y1: (-transform.y + height) / transform.k,
        // Add a margin to prevent popping at edges
        get xMin() { return this.x0 - (this.x1 - this.x0) * 0.1; },
        get yMin() { return this.y0 - (this.y1 - this.y0) * 0.1; },
        get xMax() { return this.x1 + (this.x1 - this.x0) * 0.1; },
        get yMax() { return this.y1 + (this.y1 - this.y0) * 0.1; },
        // Test if a rectangle is visible
        isVisible(rect) {
          return !(rect.x2 < this.xMin || rect.x1 > this.xMax ||
                 rect.y2 < this.yMin || rect.y1 > this.yMax);
        }
      };
      
      // Choose rendering strategy based on view info
      if (viewInfo.type === 'full' && viewInfo.bitmap instanceof ImageBitmap) {
        // For full-size bitmap
        ctx.imageSmoothingEnabled = transform.k < 1;
        try {
          ctx.drawImage(viewInfo.bitmap, 0, 0);
          if (DEBUG_QUADTREE) console.log(`Rendered full bitmap, zoom level: ${transform.k.toFixed(2)}`);
        } catch (err) {
          console.error('Failed to render full bitmap:', err);
          // Fallback to simple background
          ctx.fillStyle = '#f0f0f0';
          ctx.fillRect(0, 0, MAX_BITMAP_SIZE, MAX_BITMAP_SIZE);
        }
      } else if (viewInfo.type === 'quadrant' && viewInfo.bitmap instanceof ImageBitmap) {
        // For quadrant bitmap (topLeft, topRight, bottomLeft, bottomRight)
        ctx.imageSmoothingEnabled = transform.k < 1;
        
        // Each quadrant covers 1/4 of the full area
        const quadSize = MAX_BITMAP_SIZE / 2;
        const quadrant = viewInfo.quadrant;
        
        // Calculate position based on which quadrant this is
        let x = 0, y = 0;
        if (quadrant === 'topRight' || quadrant === 'bottomRight') x = quadSize;
        if (quadrant === 'bottomLeft' || quadrant === 'bottomRight') y = quadSize;
        
        // Draw the quadrant bitmap at the correct position in the full space
        try {
          ctx.drawImage(viewInfo.bitmap, x, y, quadSize, quadSize);
          if (DEBUG_QUADTREE) console.log(`Rendered ${quadrant} quadrant bitmap, zoom level: ${transform.k.toFixed(2)}`);
        } catch (err) {
          console.error(`Failed to render ${quadrant} quadrant:`, err);
          // Fallback to simple rectangle with quadrant name
          ctx.fillStyle = '#e0e0e0';
          ctx.fillRect(x, y, quadSize, quadSize);
          ctx.fillStyle = '#999';
          ctx.font = '24px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(quadrant, x + quadSize/2, y + quadSize/2);
        }
      } else if (viewInfo.type === 'quad' && Array.isArray(viewInfo.bitmap)) {
        // For quadtree bitmap tiles at a specific depth
        const depth = viewInfo.depth;
        const quadBitmaps = viewInfo.bitmap;
        
        if (DEBUG_QUADTREE) console.log(`Rendering quadtree at depth ${depth}, zoom level: ${transform.k.toFixed(2)}`);
        ctx.imageSmoothingEnabled = false;
        
        // Draw visible quadrants
        let visibleQuads = 0;
        let skippedQuads = 0;
        let errorQuads = 0;
        
        // Cache the full extent calculation
        const fullExtent = calculateQuadBounds(0, 0);
        const dataWidth = fullExtent.x2 - fullExtent.x1;
        const dataHeight = fullExtent.y2 - fullExtent.y1;
        
        for (let i = 0; i < quadBitmaps.length; i++) {
          // Validate bitmap before processing
          if (!quadBitmaps[i] || !(quadBitmaps[i] instanceof ImageBitmap)) {
            skippedQuads++;
            continue; // Skip invalid quadrants
          }
          
          // Calculate this quadrant's bounds
          const quadBounds = calculateQuadBounds(depth, i);
          
          // Improved visibility check using our viewport helper
          if (!visibleViewport.isVisible(quadBounds)) {
            skippedQuads++;
            continue; // Quadrant not visible
          }
          
          // Calculate the position to draw this quadrant
          // Map from data space to screen space
          const x = (quadBounds.x1 - fullExtent.x1) / dataWidth * MAX_BITMAP_SIZE;
          const y = (quadBounds.y1 - fullExtent.y1) / dataHeight * MAX_BITMAP_SIZE;
          const w = (quadBounds.x2 - quadBounds.x1) / dataWidth * MAX_BITMAP_SIZE;
          const h = (quadBounds.y2 - quadBounds.y1) / dataHeight * MAX_BITMAP_SIZE;
          
          try {
            // Draw the quadrant's bitmap
            ctx.drawImage(quadBitmaps[i], x, y, w, h);
            visibleQuads++;
            
            // Debug quadrant bounds
            if (DEBUG_QUADTREE) {
              ctx.strokeStyle = 'rgba(255,0,0,0.5)';
              ctx.lineWidth = 2 / transform.k; // Scale with zoom
              ctx.strokeRect(x, y, w, h);
              
              // Quadrant ID
              ctx.fillStyle = 'rgba(255,0,0,0.8)';
              ctx.font = `${12 / transform.k}px sans-serif`;
              ctx.fillText(`Q${depth}-${i}`, x + w/2, y + h/2);
            }
          } catch (err) {
            console.error(`Failed to draw quadrant ${depth}-${i}:`, err);
            errorQuads++;
            
            // Draw fallback rectangle for the quadrant
            ctx.fillStyle = '#f0e0e0';
            ctx.fillRect(x, y, w, h);
            if (w > 40 && h > 40) {
              ctx.fillStyle = '#999';
              ctx.font = `${Math.max(10, Math.min(20, w/10))}px sans-serif`;
              ctx.textAlign = 'center';
              ctx.fillText(`Quad ${i}`, x + w/2, y + h/2);
            }
          }
        }
        
        if (DEBUG_QUADTREE) {
          console.log(`Rendered ${visibleQuads} visible quadrants, skipped ${skippedQuads} at depth ${depth}`);
        }
      } else {
        // Dynamic multi-res rendering when zoomed in close
        if (DEBUG_QUADTREE) console.log(`Rendering dynamically, zoom level: ${transform.k.toFixed(2)}`);
        ctx.imageSmoothingEnabled = false;
        
        // Enhanced adaptive resolution buckets with smoother transitions
        const buckets = [
          { maxK: 1.5, res: 250, size: 100 },
          { maxK: 2.5, res: 300, size: 120 },
          { maxK: 4.0, res: 400, size: 140 },
          { maxK: 6.0, res: 500, size: 160 },
          { maxK: 8.0, res: 600, size: 180 },
          { maxK: 12.0, res: 700, size: 200 },
          { maxK: Infinity, res: 800, size: 220 }
        ];
        
        // Find the appropriate resolution bucket for current zoom level
        const bucket = buckets.find(b => transform.k <= b.maxK);
        const halfSize = bucket.size / 2;
        
        // Use the visible viewport for improved culling
        let renderedCount = 0;
        let culledCount = 0;
        
        // First pass: sort points by distance from center for better visual hierarchy
        const centerX = visibleViewport.x0 + (visibleViewport.x1 - visibleViewport.x0) / 2;
        const centerY = visibleViewport.y0 + (visibleViewport.y1 - visibleViewport.y0) / 2;
        
        const visiblePoints = state.points
          .filter(p => {
            const b = p.fullBounds;
            if (!b) return false;
            
            // Enhanced culling using our viewport helper
            const pointRect = {
              x1: b.x - halfSize,
              y1: b.y - halfSize,
              x2: b.x + b.width + halfSize,
              y2: b.y + b.height + halfSize
            };
            
            const isVisible = visibleViewport.isVisible(pointRect);
            if (!isVisible) culledCount++;
            return isVisible;
          })
          .map(p => ({
            point: p,
            distSq: Math.pow(p.x - centerX, 2) + Math.pow(p.y - centerY, 2)
          }))
          .sort((a, b) => b.distSq - a.distSq); // Furthest first (drawn first, closest on top)
        
        // Second pass: render the visible points
        for (const { point: p } of visiblePoints) {
          const b = p.fullBounds;
          const img = p[`thumb${bucket.res}`];
          
          if (!img) {
            // More graceful error handling - try to substitute with a different size if available
            const fallbackSizes = [250, 300, 400, 500, 600, 700, 800];
            let fallbackImg = null;
            
            for (const size of fallbackSizes) {
              if (p[`thumb${size}`]) {
                fallbackImg = p[`thumb${size}`];
                console.warn(`Using fallback thumb${size} for ${p.filename} due to missing thumb${bucket.res}`);
                break;
              }
            }
            
            if (fallbackImg) {
              ctx.drawImage(fallbackImg, b.x - halfSize, b.y - halfSize, bucket.size, bucket.size);
              renderedCount++;
            } else {
              console.error(`ERROR: Missing thumb${bucket.res} for ${p.filename} and no fallbacks available`);
            }
          } else {
            ctx.drawImage(img, b.x - halfSize, b.y - halfSize, bucket.size, bucket.size);
            renderedCount++;
          }
        }
        
        if (DEBUG_QUADTREE) {
          console.log(`Rendered ${renderedCount} thumbnails, culled ${culledCount} out-of-view (${Math.round(culledCount/(culledCount+renderedCount)*100)}%)`);
        }
      }
      
      // Performance monitoring
      const endTime = performance.now();
      window._lastRenderTime = endTime - startTime;
      
      // Display performance stats in debug mode
      if (DEBUG_QUADTREE) {
        const fps = 1000 / window._lastRenderTime;
        ctx.setTransform(1, 0, 0, 1, 0, 0); // Reset transform for UI text
        ctx.font = '12px monospace';
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(5, 5, 200, 60);
        ctx.fillStyle = 'white';
        ctx.fillText(`Render: ${window._lastRenderTime.toFixed(1)}ms (${fps.toFixed(1)} FPS)`, 10, 20);
        ctx.fillText(`Zoom: ${transform.k.toFixed(2)}x`, 10, 35);
        ctx.fillText(`Mode: ${window._lastRenderType}`, 10, 50);
      }
      
    } catch (err) {
      console.error('ERROR: Failed to render view:', err);
    } finally {
      // Always reset transform for hit-tests, even if rendering failed
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
  }

  function getFitScale(dims, bmpW, bmpH) {
    try {
      return Math.min(dims.width / bmpW, dims.height / bmpH);
    } catch (err) {
      console.error('ERROR: Failed to calculate fit scale:', err);
      return 0.5; // Fallback to a reasonable default
    }
  }

  function setupZoom(canvas, onZoom) {
    // Throttle zoom events to improve performance
    let lastZoomCall = 0;
    const THROTTLE_DELAY = 16; // ~60fps
    
    // For smooth animation during continuous zooming
    let pendingTransform = null;
    let animationFrameId = null;
    
    // Throttled handler processes zoom events at a controlled rate
    const throttledZoom = (transform) => {
      pendingTransform = transform;
      
      const now = performance.now();
      if (now - lastZoomCall >= THROTTLE_DELAY) {
        // Enough time has passed, process immediately
        lastZoomCall = now;
        onZoom(transform);
        pendingTransform = null;
      } else if (!animationFrameId) {
        // Schedule processing in next frame if not already scheduled
        animationFrameId = requestAnimationFrame(() => {
          if (pendingTransform) {
            lastZoomCall = performance.now();
            onZoom(pendingTransform);
            pendingTransform = null;
          }
          animationFrameId = null;
        });
      }
    };
    
    return d3.zoom()
      .scaleExtent([0.01, 20])
      .on("zoom", (e) => throttledZoom(e.transform))
      .on("end", (e) => {
        // Ensure we render the final state after zooming ends
        if (pendingTransform) {
          onZoom(pendingTransform);
          pendingTransform = null;
        }
      });
  }

  function resetZoom(canvas, scale) {
    const t = d3.zoomIdentity.scale(scale);
    d3.select(canvas).call(d3.zoom().transform, t);
    return t;
  }
  
  // Smooth zoom to a specific scale (centered)
  function smoothZoom(canvas, targetScale, duration = 300) {
    // Get center of view
    const dims = dimensions(canvas);
    const centerX = dims.width / 2;
    const centerY = dims.height / 2;
    
    return smoothZoomToPoint(canvas, targetScale, centerX, centerY, duration);
  }
  
  // Smooth zoom to a point
  function smoothZoomToPoint(canvas, targetScale, x, y, duration = 300) {
    const selection = d3.select(canvas);
    const currentTransform = state.transform;
    const startTransform = d3.zoomIdentity
      .translate(currentTransform.x, currentTransform.y)
      .scale(currentTransform.k);
      
    // Calculate ending transform
    // For targeting a specific point, we need to adjust the translation
    // Factor 1: How much the point moves due to scaling
    const startX = (x - currentTransform.x) / currentTransform.k;
    const startY = (y - currentTransform.y) / currentTransform.k;
    
    // Determine target position
    const targetX = currentTransform.x - (startX * (targetScale - currentTransform.k));
    const targetY = currentTransform.y - (startY * (targetScale - currentTransform.k));
    
    const endTransform = d3.zoomIdentity
      .translate(targetX, targetY)
      .scale(targetScale);
      
    // Create transition
    selection
      .transition()
      .duration(duration)
      .ease(d3.easeCubicOut)
      .call(
        d3.zoom().transform,
        endTransform
      )
      .on('end', () => {
        // Update state after transition is complete
        state.transform = endTransform;
        updateView(); // Final render with completed transform
      });
      
    // Also update state immediately so UI is responsive
    state.transform = endTransform;
    
    return endTransform;
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
    bitmaps   : { 
      full: null,
      quadrants: {
        topLeft: null,
        topRight: null,
        bottomLeft: null,
        bottomRight: null
      }
    },
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

    /* Clear previous state and hydrate new viewer state */
    state.bitmaps = null; // Clear previous bitmaps to prevent mixing with new data
    state.transition(AppState.LOADING_IMAGES);
    state.points = points;  // {x, y, filename, artist}
    
    // Show initial rendering with empty state while loading
    setupInteractions();  // idempotent - set up interactions early
    
    try {
      console.log('Starting thumbnail loading for all points...');
      const thumbResult = await addThumbnails(state.points);
      console.log(`All thumbnails loaded: ${thumbResult.success}/${thumbResult.total} in ${thumbResult.duration}s`);
      
      // Now create bitmaps
      showStatus("Creating visualization bitmaps...");
      state.transition(AppState.CREATING_BITMAPS);
      
      // Create a proper loading indicator in the canvas
      const ctx = canvas.getContext("2d");
      const dims = dimensions(canvas);
      ctx.clearRect(0, 0, dims.width * dims.dpr, dims.height * dims.dpr);
      ctx.fillStyle = "#f5f5f5";
      ctx.fillRect(0, 0, dims.width, dims.height);
      ctx.fillStyle = "#333";
      ctx.font = "16px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Creating bitmap visualization...", dims.width/2, dims.height/2 - 20);
      
      // Use a progress bar
      ctx.fillStyle = "#eee";
      ctx.fillRect(dims.width/2 - 100, dims.height/2 + 10, 200, 20);
      ctx.fillStyle = "#4CAF50";
      
      // Update loading animation using requestAnimationFrame
      let progress = 0;
      const startTime = performance.now();
      const animateLoading = () => {
        progress = (performance.now() - startTime) / 50 % 100;
        ctx.clearRect(dims.width/2 - 100, dims.height/2 + 10, 200, 20);
        ctx.fillStyle = "#eee";
        ctx.fillRect(dims.width/2 - 100, dims.height/2 + 10, 200, 20);
        ctx.fillStyle = "#4CAF50";
        ctx.fillRect(dims.width/2 - 100, dims.height/2 + 10, progress * 2, 20);
        
        if (state.current === AppState.CREATING_BITMAPS) {
          requestAnimationFrame(animateLoading);
        }
      };
      requestAnimationFrame(animateLoading);
      
      // Create bitmaps in the background
      state.bitmaps = await makeBitmaps(state.points);
      
      // Verify bitmaps were created successfully
      if (!state.bitmaps || !state.bitmaps.full || !(state.bitmaps.full instanceof ImageBitmap)) {
        console.error('ERROR: Bitmap creation failed - full bitmap not available or invalid');
        showStatus("Bitmap creation failed. Using dynamic rendering.", true);
        
        // Add diagnostic information to help troubleshoot
        if (!state.bitmaps) {
          console.error('  - state.bitmaps is null or undefined');
        } else if (!state.bitmaps.full) {
          console.error('  - state.bitmaps.full is null or undefined');
        } else {
          console.error(`  - state.bitmaps.full is not an ImageBitmap, it's a ${typeof state.bitmaps.full}`);
        }
      } else {
        showStatus(`Visualization ready: ${points.length} points`);
      }
      
      // Transition to viewing state and show the visualization
      state.transition(AppState.VIEWING);
    } catch (err) {
      console.error('Error during visualization preparation:', err);
      showStatus(`Visualization preparation failed: ${err.message}`, true);
      
      // Still transition to viewing state with whatever we have
      state.transition(AppState.VIEWING);
    }
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
      
      // Determine which bounds key to use based on current view
      let bKey = "fullBounds";
      
      if (state.current === AppState.DETAIL) {
        // In detail view, if we're using a quadrant bitmap, use that quadrant's bounds
        const viewInfo = chooseBitmap(state.transform.k);
        if (viewInfo.type === 'quadrant') {
          bKey = `${viewInfo.quadrant}Bounds`;
        } else {
          // Fallback to using full bounds if no specific quadrant
          bKey = "fullBounds";
        }
      }
      
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

    /* Enhanced keyboard shortcuts */
    document.addEventListener("keydown", (e) => {
      // Don't capture keyboard events when user is typing in a form field
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
        return;
      }
      
      switch (e.key) {
        case "Escape":
          // Esc closes detail + resets zoom
          if (state.current === AppState.DETAIL) state.transition(AppState.VIEWING);
          const dims = dimensions(canvas);
          const s = getFitScale(dims, MAX_BITMAP_SIZE, MAX_BITMAP_SIZE);
          smoothZoom(canvas, s, 500); // Smooth zoom to fit
          e.preventDefault();
          break;
          
        case "+":
        case "=": // Usually on same key as + without shift
          // Zoom in
          zoomByFactor(1.2);
          e.preventDefault();
          break;
          
        case "-":
          // Zoom out
          zoomByFactor(0.8);
          e.preventDefault();
          break;
          
        case "0":
          // Reset to 1:1 zoom
          smoothZoom(canvas, 1.0, 500);
          e.preventDefault();
          break;
          
        case "f":
          // Reset to fit zoom
          const fitDims = dimensions(canvas);
          const fitScale = getFitScale(fitDims, MAX_BITMAP_SIZE, MAX_BITMAP_SIZE);
          smoothZoom(canvas, fitScale, 500);
          e.preventDefault();
          break;
          
        case "h":
          // Show help overlay
          toggleHelpOverlay();
          e.preventDefault();
          break;
      }
    });
    
    // Helper function for zoom by factor
    function zoomByFactor(factor) {
      const newScale = state.transform.k * factor;
      // Get center of view
      const dims = dimensions(canvas);
      const centerX = dims.width / 2;
      const centerY = dims.height / 2;
      // Zoom centered on middle of view
      smoothZoomToPoint(canvas, newScale, centerX, centerY, 300);
    }
    
    // Help overlay toggle
    function toggleHelpOverlay() {
      let helpOverlay = $("#help-overlay");
      if (!helpOverlay) {
        helpOverlay = document.createElement("div");
        helpOverlay.id = "help-overlay";
        helpOverlay.className = "overlay";
        helpOverlay.innerHTML = `
          <div class="overlay-content">
            <h2>Keyboard Shortcuts</h2>
            <table>
              <tr><td><kbd>+</kbd> / <kbd>=</kbd></td><td>Zoom in</td></tr>
              <tr><td><kbd>-</kbd></td><td>Zoom out</td></tr>
              <tr><td><kbd>0</kbd></td><td>Reset to 1:1 zoom</td></tr>
              <tr><td><kbd>f</kbd></td><td>Fit to screen</td></tr>
              <tr><td><kbd>Esc</kbd></td><td>Close detail view / Reset zoom</td></tr>
              <tr><td><kbd>h</kbd></td><td>Toggle this help</td></tr>
            </table>
            <p>Click anywhere to close</p>
          </div>
        `;
        document.body.appendChild(helpOverlay);
        
        // Add style for the overlay if not already in the document
        if (!$("#help-overlay-style")) {
          const style = document.createElement("style");
          style.id = "help-overlay-style";
          style.textContent = `
            .overlay {
              position: fixed;
              top: 0;
              left: 0;
              width: 100%;
              height: 100%;
              background: rgba(0,0,0,0.8);
              z-index: 1000;
              display: flex;
              align-items: center;
              justify-content: center;
              opacity: 0;
              transition: opacity 0.3s ease;
            }
            .overlay.visible {
              opacity: 1;
            }
            .overlay-content {
              background: white;
              padding: 2rem;
              border-radius: 8px;
              max-width: 80%;
              max-height: 80%;
              overflow: auto;
            }
            .overlay-content h2 {
              margin-top: 0;
            }
            .overlay-content table {
              border-collapse: collapse;
              margin: 1rem 0;
            }
            .overlay-content td {
              padding: 0.5rem 1rem;
              border-bottom: 1px solid #eee;
            }
            .overlay-content td:first-child {
              text-align: right;
              font-weight: bold;
            }
            kbd {
              background: #f5f5f5;
              border: 1px solid #ccc;
              border-radius: 4px;
              padding: 2px 6px;
              font-family: monospace;
            }
          `;
          document.head.appendChild(style);
        }
        
        // Handle click to close
        helpOverlay.addEventListener("click", toggleHelpOverlay);
      }
      
      // Toggle visibility
      if (helpOverlay.classList.contains("visible")) {
        helpOverlay.classList.remove("visible");
        setTimeout(() => {
          helpOverlay.style.display = "none";
        }, 300); // Match transition duration
      } else {
        helpOverlay.style.display = "flex";
        // Trigger reflow
        helpOverlay.offsetHeight;
        helpOverlay.classList.add("visible");
      }
    }

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
