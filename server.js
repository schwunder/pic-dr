// server.js – corrected: remove cwd so spawnSync can locate python3 via PATH

import { spawnSync } from "bun";
import { Database }  from "bun:sqlite";
import { join }        from "path";

// Try to read poetry env from `poetry env info --path --full-path`
let PY = join(process.cwd(), "venv", "bin", "python");
console.log(`Using Python interpreter: ${PY}`);
const DB = new Database(process.env.DR_DB || "art.sqlite", { readonly: true });

Bun.serve({
  port: 3000,
  fetch: async (req) => {
    const url = new URL(req.url);
    const { pathname, searchParams } = url;

    // ─── GET /api/methods ────────────────────────────────────────
    if (req.method === "GET" && pathname === "/api/methods") {
      const out = spawnSync({ cmd: [PY, "dr.py", "--list-methods"], stdout: "pipe" }).stdout;
      try {
        // Extract JSON part if there are warnings or other text before it
        const stdoutStr = out.toString();
        let jsonStr = stdoutStr;
        
        // Find the first '[' character which likely starts the JSON array
        const jsonStartIndex = stdoutStr.indexOf('[');
        if (jsonStartIndex > 0) {
          console.log(`Found non-JSON text before position ${jsonStartIndex}, extracting JSON part only`);
          jsonStr = stdoutStr.substring(jsonStartIndex);
        }
        
        // Parse and stringify to ensure valid JSON
        const jsonOutput = JSON.parse(jsonStr);
        return new Response(JSON.stringify(jsonOutput), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        console.error("Error parsing methods JSON:", e);
        return new Response(`Error parsing methods: ${e.message}\n\nOutput: ${out}`, {
          status: 500,
          headers: { "Content-Type": "text/plain" }
        });
      }
    }

    // ─── GET /api/subsets ────────────────────────────────────────
    if (req.method === "GET" && pathname === "/api/subsets") {
      const out = spawnSync({ cmd: [PY, "dr.py", "--list-subsets"], stdout: "pipe" }).stdout;
      try {
        // Extract JSON part if there are warnings or other text before it
        const stdoutStr = out.toString();
        let jsonStr = stdoutStr;
        
        // Find the first '[' character which likely starts the JSON array
        const jsonStartIndex = stdoutStr.indexOf('[');
        if (jsonStartIndex > 0) {
          console.log(`Found non-JSON text before position ${jsonStartIndex}, extracting JSON part only`);
          jsonStr = stdoutStr.substring(jsonStartIndex);
        }
        
        // Parse and stringify to ensure valid JSON
        const jsonOutput = JSON.parse(jsonStr);
        return new Response(JSON.stringify(jsonOutput), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        console.error("Error parsing subsets JSON:", e);
        return new Response(`Error parsing subsets: ${e.message}\n\nOutput: ${out}`, {
          status: 500,
          headers: { "Content-Type": "text/plain" }
        });
      }
    }

    // ─── GET /api/params?method=XXX ──────────────────────────────
    if (req.method === "GET" && pathname === "/api/params") {
      const m = searchParams.get("method");
      if (!m) return new Response("Missing method", { status: 400 });
      const out = spawnSync({ cmd: [PY, "dr.py", "--list-params", m], stdout: "pipe" }).stdout;
      try {
        // Extract JSON part if there are warnings or other text before it
        const stdoutStr = out.toString();
        let jsonStr = stdoutStr;
        
        // Find the first '[' character which likely starts the JSON array
        const jsonStartIndex = stdoutStr.indexOf('[');
        if (jsonStartIndex > 0) {
          console.log(`Found non-JSON text before position ${jsonStartIndex}, extracting JSON part only`);
          jsonStr = stdoutStr.substring(jsonStartIndex);
        }
        
        // Parse and stringify to ensure valid JSON
        const jsonOutput = JSON.parse(jsonStr);
        return new Response(JSON.stringify(jsonOutput), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        console.error(`Error parsing params for method ${m}:`, e);
        return new Response(`Error parsing params: ${e.message}\n\nOutput: ${out}`, {
          status: 500,
          headers: { "Content-Type": "text/plain" }
        });
      }
    }

    // ─── POST / (run DR) ─────────────────────────────────────────
    if (req.method === "POST" && pathname === "/") {
      let body;
      try { body = await req.json(); }
      catch { return new Response("Invalid JSON", { status: 400 }); }

      const argv = [
        PY, "dr.py",
        "--method",           body.method          || "umap",
        "--subset-strategy",  body.subset_strategy || "random",
        "--subset-size",      String(Math.max(1, Math.min(500, body.subset_size || 250)))
      ];
      if (body.config_id != null) {
        argv.push("--config-id", String(body.config_id));
      }
      for (const [k, v] of Object.entries(body.params || {})) {
        // Ensure proper JSON serialization for all value types
        // Use a safer approach to handle booleans, numbers, and strings
        let serializedValue;
        if (typeof v === 'boolean') {
          serializedValue = v ? 'true' : 'false';
        } else if (typeof v === 'number') {
          serializedValue = v.toString();
        } else {
          serializedValue = JSON.stringify(v);
        }
        argv.push("--param", `${k}=${serializedValue}`);
      }

      // removed cwd so spawnSync uses process.cwd() and can find python3 on PATH
      const proc = spawnSync({ cmd: argv, stdout: "pipe", stderr: "pipe" });

      if (proc.exitCode === 0) {
        // Check if the output is valid JSON before returning
        try {
          // Extract the JSON part from the output
          // This handles cases where warnings or other text appears before the JSON
          const stdoutStr = proc.stdout.toString();
          let jsonStr = stdoutStr;
          
          // Find the first '{' character which likely starts the JSON
          const jsonStartIndex = stdoutStr.indexOf('{');
          if (jsonStartIndex > 0) {
            // If there's text before the JSON, extract only the JSON part
            console.log(`Found non-JSON text before position ${jsonStartIndex}, extracting JSON part only`);
            jsonStr = stdoutStr.substring(jsonStartIndex);
          }
          
          // Parse and stringify to ensure valid JSON
          const jsonOutput = JSON.parse(jsonStr);
          return new Response(JSON.stringify(jsonOutput), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        } catch (e) {
          console.error("Python script returned invalid JSON:", e);
          console.error("Output was:", proc.stdout.toString());
          console.error("Stderr was:", proc.stderr.toString());
          return new Response(`Error parsing JSON output: ${e.message}\n\nOutput: ${proc.stdout}\n\nStderr: ${proc.stderr}`, {
            status: 500,
            headers: { "Content-Type": "text/plain" }
          });
        }
      } else {
        return new Response(proc.stderr, {
          status: 500,
          headers: { "Content-Type": "text/plain" }
        });
      }
    }

    // ─── GET /api/configs?method=XXX ──────────────────────────────
    if (req.method === "GET" && pathname === "/api/configs") {
      const method = searchParams.get("method") || "umap";
      const rows = DB.query(
        `SELECT config_id, subset_strategy, subset_size, runtime, created_at
           FROM configs WHERE method = ? ORDER BY created_at DESC`
      ).all(method);
      return Response.json(rows);
    }

    // ─── GET /api/points?method=XXX&config_id=NN ─────────────────
    if (req.method === "GET" && pathname === "/api/points") {
      const id = Number(searchParams.get("config_id"));
      if (!id) return new Response("Missing config_id", { status: 400 });
      const method = searchParams.get("method") || "umap";
      const pts = DB.query(
        `SELECT p.filename, p.artist, p.x, p.y
           FROM projection_points AS p
           JOIN configs USING(config_id)
          WHERE method = ? AND config_id = ?
          ORDER BY p.id`
      ).all(method, id);
      return Response.json(pts);
    }

    // ─── GET /api/artists ──────────────────────────────────────────
    if (req.method === "GET" && pathname === "/api/artists") {
      const list = DB.query(
        `SELECT artist, nationality, years, bio FROM artists ORDER BY artist`
      ).all();
      return Response.json(list);
    }

    // ─── Static file fallback ────────────────────────────────────
    let filePath = pathname === "/" ? "/index.html" : pathname;
    try {
      return new Response(Bun.file(`public${filePath}`));
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }
});
