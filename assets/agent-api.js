/*
 * agent-api.js -- window.haxeRun
 *
 * The programmatic surface of haxe.run. Humans use the editor; programs and AI
 * agents use this. It is the stable contract: assets/app.js internals may move,
 * this does not.
 *
 * Design rules, because the consumer may not be a person:
 *   - Everything is awaitable. Never poll, never sleep, never scrape the DOM.
 *   - compile() and run() are stateless: pass files, get a result. They do not
 *     read or disturb what is open in the editor.
 *   - Results are structured data, never rendered text. Diagnostics carry
 *     file/line/column so a caller can repair code without parsing prose.
 *   - The API describes itself at runtime: haxeRun.help() and haxeRun.schema().
 *
 * Quick start:
 *   await haxeRun.ready();
 *   const r = await haxeRun.run({ files: { "Main.hx":
 *     'class Main { static function main() { trace("hi"); } }' } });
 *   r.output;   // [{ level: "log", text: "Main.hx:1: hi" }]
 */
(function (global) {
  "use strict";

  var VERSION = "1.0";
  var internal = null;
  var runSeq = 0;

  function need() {
    if (!internal) internal = global.__hxrInternal;
    if (!internal) throw new Error("haxe.run is still loading; await haxeRun.ready() first");
    return internal;
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ------------------------------------------------------------- lifecycle */

  var readyPromise = null;

  // Resolves when the compiler can accept work. Safe to call repeatedly.
  function ready(timeoutMs) {
    if (readyPromise) return readyPromise;
    var limit = timeoutMs || 120000;
    readyPromise = new Promise(function (resolve, reject) {
      var t0 = Date.now();
      (function poll() {
        var i = global.__hxrInternal;
        if (i && i.state && i.state.ready) {
          internal = i;
          return resolve({
            version: VERSION,
            compiler: "hxc",
            language: "Haxe 4.3",
            targets: i.targets.map(function (t) { return t.id; })
          });
        }
        if (Date.now() - t0 > limit) return reject(new Error("compiler did not become ready in " + limit + "ms"));
        setTimeout(poll, 100);
      })();
    });
    return readyPromise;
  }

  /* --------------------------------------------------------------- compile */

  function normalizeFiles(files) {
    var shape = 'files must be an object of { path: source }, e.g. { "Main.hx": "class Main {...}" }';
    if (!files || typeof files !== "object" || Array.isArray(files)) throw new TypeError(shape);
    var names = Object.keys(files);
    if (!names.length) throw new TypeError("files is empty; " + shape);
    var out = {};
    names.forEach(function (n) {
      if (typeof files[n] !== "string") {
        throw new TypeError('files["' + n + '"] is ' + typeof files[n] + ", not source text; " + shape);
      }
      var path = String(n).replace(/^\/+/, "");
      if (!/\.hx$/i.test(path)) path += ".hx";
      out[path] = files[n];
    });
    return out;
  }

  // Entry module: the one declaring `static function main`, preferring Main.hx.
  function inferMain(files) {
    var names = Object.keys(files);
    var withMain = names.filter(function (n) {
      return /\bstatic\s+function\s+main\s*\(/.test(files[n]);
    });
    var pick = withMain.indexOf("Main.hx") > -1 ? "Main.hx" : (withMain[0] || names[0]);
    return pick.replace(/\.hx$/, "").replace(/\//g, ".");
  }

  function mergeOptions(o) {
    var base = clone(need().defaultOptions);
    if (o) Object.keys(o).forEach(function (k) { base[k] = o[k]; });
    return base;
  }

  /**
   * compile({ files, main?, target?, options? }) -> Promise<CompileResult>
   * Stateless. Does not touch the editor.
   */
  function compile(req) {
    req = req || {};
    return ready().then(function () {
      var files = normalizeFiles(req.files);
      return need().ask("compile", {
        files: files,
        main: req.main || inferMain(files),
        target: req.target || "js",
        options: mergeOptions(req.options)
      });
    }).then(function (res) {
      return {
        ok: !!res.ok,
        outputs: res.outputs || {},
        diagnostics: res.diagnostics || [],
        errors: (res.diagnostics || []).filter(function (d) { return d.severity === "error"; }),
        warnings: (res.diagnostics || []).filter(function (d) { return d.severity === "warning"; }),
        runnable: !!res.runnable,
        timeMs: res.timeMs || 0,
        stats: res.stats || null,
        log: res.log || []
      };
    });
  }

  /* ------------------------------------------------------------------- run */

  // Executes compiled JS in a throwaway sandboxed iframe and captures output.
  // Never touches the visible preview surface.
  function execute(js, opts) {
    opts = opts || {};
    var timeoutMs = opts.timeoutMs == null ? 5000 : opts.timeoutMs;
    var quietMs = opts.quietMs == null ? 250 : opts.quietMs;
    var token = "hxr_run_" + (++runSeq) + "_" + Date.now();

    return new Promise(function (resolve) {
      var output = [];
      var frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.style.cssText = "position:absolute;width:640px;height:480px;left:-10000px;top:0;border:0";

      var quietTimer = null, hardTimer = null, done = false;
      var t0 = Date.now();

      function finish(reason) {
        if (done) return;
        done = true;
        clearTimeout(quietTimer); clearTimeout(hardTimer);
        global.removeEventListener("message", onMsg);
        try { frame.remove(); } catch (e) {}
        resolve({
          output: output,
          stdout: output.filter(function (l) { return l.level === "log"; })
                        .map(function (l) { return l.text; }).join("\n"),
          errors: output.filter(function (l) { return l.level === "error"; }),
          timedOut: reason === "timeout",
          timeMs: Date.now() - t0
        });
      }

      function bumpQuiet() {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(function () { finish("quiet"); }, quietMs);
      }

      function onMsg(e) {
        var d = e.data;
        if (!d || d.__hxrToken !== token) return;
        output.push({ level: d.level, text: d.text });
        bumpQuiet();
      }

      global.addEventListener("message", onMsg);
      document.body.appendChild(frame);

      frame.srcdoc =
        "<!doctype html><meta charset='utf-8'><style>html,body{margin:0;background:#0b0e14}" +
        "#openfl-content{width:100%;height:100%}</style><body><div id='openfl-content'></div><script>" +
        "var T=" + JSON.stringify(token) + ";" +
        "var send=function(l,a){parent.postMessage({__hxrToken:T,level:l," +
        "text:Array.prototype.map.call(a,function(x){try{return typeof x==='object'?JSON.stringify(x):String(x)}" +
        "catch(e){return String(x)}}).join(' ')},'*')};" +
        "console.log=function(){send('log',arguments)};console.info=console.log;" +
        "console.warn=function(){send('warn',arguments)};" +
        "console.error=function(){send('error',arguments)};" +
        "window.onerror=function(m,s,l,c,e){send('error',[e&&e.stack||m]);return true};" +
        "window.addEventListener('unhandledrejection',function(ev){" +
        "send('error',[(ev.reason&&(ev.reason.stack||ev.reason.message))||ev.reason])});" +
        "try{" + String(js).replace(/<\/script>/gi, "<\\/script>") +
        "}catch(e){send('error',[e&&e.stack||e&&e.message||e])}" +
        "<\/script></body>";

      // A program may render forever (OpenFL). Resolve on a quiet gap or the cap.
      bumpQuiet();
      hardTimer = setTimeout(function () { finish("timeout"); }, timeoutMs);
    });
  }

  /**
   * run({ files, main?, options?, timeoutMs?, quietMs? }) -> Promise<RunResult>
   * Compiles to JS and executes it, returning captured output. This is the
   * generate -> compile -> observe loop in one call.
   */
  function run(req) {
    req = req || {};
    var started = Date.now();
    return compile({
      files: req.files, main: req.main, target: "js", options: req.options
    }).then(function (c) {
      if (!c.ok || !c.runnable) {
        return {
          ok: false, compiled: false,
          diagnostics: c.diagnostics, errors: c.errors, warnings: c.warnings,
          output: [], stdout: "", compileMs: c.timeMs, timeMs: Date.now() - started
        };
      }
      var name = Object.keys(c.outputs)[0];
      return execute(c.outputs[name], req).then(function (r) {
        return {
          ok: r.errors.length === 0,
          compiled: true,
          diagnostics: c.diagnostics, errors: c.errors, warnings: c.warnings,
          output: r.output, stdout: r.stdout, runtimeErrors: r.errors,
          timedOut: r.timedOut,
          compileMs: c.timeMs, timeMs: Date.now() - started
        };
      });
    });
  }

  /* ---------------------------------------------------------------- editor */

  var editor = {
    getFiles: function () { return need().allFiles(); },

    // Replace everything open in the editor. Does not compile.
    setFiles: function (files) {
      var f = normalizeFiles(files);
      need().loadProject(f, { id: null, name: "agent session", kind: "draft" });
      need().showEditor();
      return f;
    },

    open: function (path) { need().switchFile(path); return path; },

    samples: function () {
      return (global.HXR_EXAMPLES || []).map(function (e) {
        return { id: e.id, name: e.name, files: Object.keys(e.files) };
      });
    },

    load: function (id) {
      var ex = (global.HXR_EXAMPLES || []).filter(function (e) { return e.id === id; })[0];
      if (!ex) throw new Error("no such sample: " + id + " (see haxeRun.editor.samples())");
      need().openProject(clone(ex.files), { id: ex.id, name: ex.name, kind: "example" });
      return { id: ex.id, name: ex.name, files: Object.keys(ex.files) };
    },

    // Compile whatever is currently open, updating the visible UI.
    compile: function () { return ready().then(function () { return need().compileUI(); }); },

    // Run whatever is open, rendering to the visible preview surface.
    run: function () { return ready().then(function () { return need().runUI(); }); },

    getOptions: function () { return clone(need().state.options); },
    setOptions: function (o) { need().setOptions(mergeOptions(o)); return this.getOptions(); }
  };

  /* ------------------------------------------------------ self-description */

  function schema() {
    return {
      version: VERSION,
      description: "Programmatic access to the haxe.run Haxe/hx+ playground. " +
                   "Compiles and runs Haxe entirely in this browser tab; nothing is sent to a server.",
      compiler: { name: "hxc", language: "Haxe 4.3", runsIn: "WebAssembly" },
      conventions: {
        files: "object mapping path to source, e.g. { 'Main.hx': 'class Main {...}' }. " +
               "Subdirectories are package paths: 'geom/Shape.hx' is package geom.",
        entryPoint: "inferred as the module declaring `static function main`, preferring Main.hx; override with `main`",
        async: "every method returns a Promise; await ready() once before the first call",
        errors: "compile/run resolve (they do not reject) with ok:false and structured diagnostics"
      },
      methods: {
        "ready()": { returns: "{version, compiler, language, targets}", note: "resolves when the compiler is usable" },
        "compile({files, main?, target?, options?})": {
          returns: "{ok, outputs, diagnostics, errors, warnings, runnable, timeMs, stats, log}",
          note: "stateless; does not touch the editor"
        },
        "run({files, main?, options?, timeoutMs?, quietMs?})": {
          returns: "{ok, compiled, stdout, output, errors, runtimeErrors, timedOut, compileMs, timeMs}",
          note: "compiles to JS and executes in a hidden sandbox, capturing console output. " +
                "Long-running programs resolve after quietMs of silence or timeoutMs (default 5000)."
        },
        "editor.getFiles() / setFiles(files) / open(path)": { returns: "files | path" },
        "editor.samples() / load(id)": { returns: "[{id,name,files}] | {id,name,files}" },
        "editor.compile() / run()": { note: "acts on what is open, updates the visible UI" },
        "editor.getOptions() / setOptions(o)": { returns: "options" },
        "schema() / help()": { note: "this description" }
      },
      options: {
        dce: "'no' | 'std' | 'full'",
        analyzer: "boolean",
        debug: "boolean (-debug)",
        noInline: "boolean (--no-inline)",
        noOpt: "boolean (--no-opt)",
        nullSafety: "boolean",
        defines: "object, e.g. { my_flag: true, level: '3' }"
      },
      diagnostic: {
        severity: "'error' | 'warning' | 'info'",
        file: "string, matches a key in files",
        line: "1-based", column: "1-based",
        endLine: "1-based", endColumn: "1-based",
        message: "string"
      },
      targets: {
        js: "JavaScript. The only target that can be executed here; also what OpenFL renders through.",
        note: "other hxc targets exist but produce output this page cannot run"
      },
      openfl: "Importing openfl.* switches the build to an OpenFL/Lime html5 app automatically " +
              "(the ApplicationMain bootstrap is injected). Such a project has no static main; " +
              "it is a Sprite subclass. Compiles take appreciably longer than plain Haxe.",
      examples: [
        { title: "compile and read diagnostics",
          code: "const r = await haxeRun.compile({ files: { 'Main.hx': src } });\nif (!r.ok) console.log(r.errors);" },
        { title: "run and capture output",
          code: "const r = await haxeRun.run({ files: { 'Main.hx': src } });\nconsole.log(r.stdout);" },
        { title: "multi-module project",
          code: "await haxeRun.run({ files: { 'Main.hx': a, 'geom/Shape.hx': b } });" },
        { title: "drive the visible editor",
          code: "haxeRun.editor.setFiles({ 'Main.hx': src });\nawait haxeRun.editor.run();" }
      ]
    };
  }

  function help() {
    var s = schema();
    var lines = [
      "haxe.run agent API v" + s.version,
      s.description,
      "",
      "Await ready() once, then compile() or run(). Both take { files: { path: source } }.",
      "Results are structured objects; diagnostics carry file/line/column.",
      "",
      "Methods:"
    ];
    Object.keys(s.methods).forEach(function (m) {
      var d = s.methods[m];
      lines.push("  " + m + (d.returns ? "  -> " + d.returns : ""));
      if (d.note) lines.push("      " + d.note);
    });
    lines.push("", "Example:", "  " + s.examples[1].code.replace(/\n/g, "\n  "));
    lines.push("", "Full detail: haxeRun.schema(), or /AGENTS.md on this site.");
    return lines.join("\n");
  }

  global.haxeRun = {
    version: VERSION,
    ready: ready,
    compile: compile,
    run: run,
    editor: editor,
    schema: schema,
    help: help,
    toString: function () { return help(); }
  };

  // Leaves a breadcrumb an agent can find by inspecting the page.
  try {
    var meta = document.createElement("meta");
    meta.name = "ai-api";
    meta.content = "window.haxeRun (v" + VERSION + "); call haxeRun.help() or fetch /llms.txt";
    document.head.appendChild(meta);
  } catch (e) {}
})(typeof window !== "undefined" ? window : self);
