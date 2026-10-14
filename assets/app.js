/* haxe.run playground front end.
 * Talks to the compiler only through the Worker messages in WORKER_CONTRACT.md:
 * the real one is assets/hxc-worker.js, and ?worker=stub swaps in
 * assets/compiler-stub.js so the UI can be worked on without it.
 */
(function () {
  "use strict";

  var MONACO_CDN = "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min";

  // User-facing name of the compiler. One place to change it.
  var COMPILER_NAME = "hx+ compiler";

  // Dev override: ?worker=stub loads the instant stub Worker instead of the
  // real wasm compiler, so the front end can be worked on in isolation.
  var USE_STUB = /[?&]worker=stub\b/.test(location.search);

  // The only codegen the playground shows is JavaScript, because it is the only
  // target whose output can actually run in a browser tab (directly, and for
  // OpenFL through Lime's html5 backend). The native/source targets
  // (cpp, hl, python, php, lua) compile but can't run here, so offering them
  // would only mislead.
  var TARGETS = [
    { id: "js", label: "JavaScript", lang: "javascript", codegen: true }
  ];

  function targetById(id) {
    return TARGETS.filter(function (t) { return t.id === id; })[0] || TARGETS[0];
  }

  var LS = {
    theme:    "hxr-theme",
    options:  "hxr-options",
    draft:    "hxr-draft",
    saved:    "hxr-saved",
    layout:   "hxr-layout",
    target:   "hxr-target"
  };

  var DEFAULT_OPTIONS = {
    dce: "std", analyzer: true, debug: false,
    noInline: false, noOpt: false, nullSafety: false, defines: {}
  };

  var state = {
    target: "js",
    view: "code",        // code | preview | console | log
    files: {},
    models: {},
    active: null,
    options: clone(DEFAULT_OPTIONS),
    editor: null,
    monaco: null,
    fallback: null,
    lastResult: null,
    project: { id: null, name: null, kind: null },  // kind: example | saved | draft
    ready: false,
    queue: [],
    seq: 0,
    pending: {},
    compileTimer: null,
    draftTimer: null,
    dirty: false,        // source changed since the last successful compile
    manual: false,       // this project compiles on Run only (too heavy for live)
    compiling: false,
    lastCompileMs: 0
  };

  // A compile slower than this promotes the project to manual (compile-on-Run),
  // so heavy projects (OpenFL) don't re-run a long compile on every keystroke
  // or on load while the compiler runs on the main thread.
  var HEAVY_COMPILE_MS = 1500;

  var $ = function (id) { return document.getElementById(id); };
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function store(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
  function recall(key, dflt) {
    try { var v = localStorage.getItem(key); return v === null ? dflt : JSON.parse(v); }
    catch (e) { return dflt; }
  }

  /* ------------------------------------------------------------ worker glue
   *
   * The compiler (assets/hxc-mainthread.js, or the ?worker=stub Worker) may take
   * seconds to become usable: the wasm/Emscripten build downloads several
   * megabytes and sets up a filesystem before it can answer anything. So it is
   * treated as async-boot:
   *
   *   worker -> { ready: true }                 // may answer requests now
   *   worker -> { progress, loaded, total, phase, note }   // optional, pre-ready
   *   worker -> { fatal: "message" }            // init failed, unrecoverable
   *
   * Requests made before "ready" are queued and flushed on ready. Each request
   * carries a timeout so a wedged worker surfaces instead of spinning forever.
   * The reference stub answers instantly and posts { ready: true } on load, so
   * the same gate works for both.
   */

  var REQUEST_TIMEOUT_MS = 45000;
  var BOOT_TIMEOUT_MS = 60000;
  var ASSET_VERSION = "24";

  /* Light mode, for phones and tablets, very low-memory devices, and any tab
   * that died here before. Mobile browsers kill a tab that uses too much memory
   * without an error, so in light mode the compiler starts only when a
   * playground opens, and runs as one instance: no warm-up compile and no
   * completion worker. A crash is noticed by a marker in sessionStorage that is
   * set while the compiler starts or compiles and cleared when it answers; if a
   * page load finds it still set, the last attempt died. */
  var BUSY_KEY = "hxr-busy", CRASHES_KEY = "hxr-crashes", STAGE_KEY = "hxr-crash-stage";
  // The marker holds what was happening, so a crash can be reported by stage.
  var crashStage = "";
  var crashes = (function () {
    try {
      var n = +(sessionStorage.getItem(CRASHES_KEY) || 0);
      var busy = sessionStorage.getItem(BUSY_KEY);
      if (busy) {
        sessionStorage.removeItem(BUSY_KEY);
        sessionStorage.setItem(CRASHES_KEY, String(++n));
        sessionStorage.setItem(STAGE_KEY, busy);
      }
      crashStage = sessionStorage.getItem(STAGE_KEY) || "";
      return n;
    } catch (e) { return 0; }
  })();
  var LIGHT = /[?&]light\b/.test(location.search) || crashes > 0 ||
    (!!window.matchMedia && matchMedia("(pointer: coarse)").matches &&
     Math.min(screen.width, screen.height) < 900) ||
    (!!navigator.deviceMemory && navigator.deviceMemory <= 2);

  function markBusy(on, stage) {
    try {
      if (on) sessionStorage.setItem(BUSY_KEY, stage || "working");
      else sessionStorage.removeItem(BUSY_KEY);
    } catch (e) {}
  }

  var worker = null;      // primary: the Worker, where compiles normally run
  var fallback = null;    // main-thread engine, built on demand (see retryOnFallback)
  var assets = null;      // { wasmModule, data }, fetched and compiled once
  var bootTimer = null;
  var retriedOnce = false;
  // Set once an OpenFL-sized build has overflowed the Worker. Some browsers
  // (Firefox among them) give Workers too small a stack for those builds every
  // time, so later ones go straight to the main thread instead of spending a
  // failed attempt and a Worker restart first.
  var heavyOnMainThread = false;
  var warmedUp = false;
  var warmupTries = 0;
  var WARMUP_MAX_TRIES = 5;
  var WARMUP_RETRY_MS = 800;   // optimization runs on background threads; give it time
  var WARMUP_SRC = 'class Main { static function main() { trace("hi"); } }';

  /* Boot: fetch and compile the binaries once, then hand them to a Worker.
   * Owning the assets here (rather than letting each emscripten instance fetch
   * its own) is what makes both recovery paths below affordable, since a second
   * instance costs an instantiate instead of another 36 MB. */
  function startCompiler() {
    state.ready = false;
    // do not clear state.queue: requests made before the (possibly deferred)
    // compiler boots are parked there and must survive until they can be flushed.
    setCompilerStatus("booting", "starting " + COMPILER_NAME);

    if (USE_STUB) {
      try { worker = new Worker("assets/compiler-stub.js"); }
      catch (err) { return bootFailed("could not start the " + COMPILER_NAME); }
      wireWorker();
      return;
    }

    armBootTimer();
    markBusy(true, "downloading the compiler");
    HxcAssets.load(showBootProgress).then(function (a) {
      assets = a;
      spawnWorker();
    }, function (err) {
      bootFailed("could not load the compiler: " + (err && err.message || err));
    });
  }

  function armBootTimer() {
    clearTimeout(bootTimer);
    bootTimer = setTimeout(function () {
      if (!state.ready) bootFailed("compiler took too long to start");
    }, BOOT_TIMEOUT_MS);
  }

  // The build id keeps the hxc.js glue matched to the wasm and data it describes.
  function workerUrl() {
    return "assets/hxc-worker.js?v=" + ASSET_VERSION + "&b=" + encodeURIComponent(HxcAssets.build || "");
  }

  function spawnWorker() {
    try {
      worker = new Worker(workerUrl());
    } catch (err) {
      return bootFailed("could not start the " + COMPILER_NAME);
    }
    wireWorker();
    // Structured clone, not transfer: `assets.data` has to stay usable here for
    // the next instance we stand up.
    worker.postMessage({ kind: "init", wasmModule: assets.wasmModule, data: assets.data });
  }

  function wireWorker() {
    worker.onmessage = onWorkerMessage;
    worker.onerror = function (e) {
      bootFailed((e && e.message) ? e.message : "compiler crashed");
    };
  }

  function onWorkerMessage(e) {
    var msg = e.data || {};

    if (msg.fatal) { bootFailed(msg.fatal); return; }

    // The Worker ran out of native call stack on this compile. It is not a
    // property of the input, it is a property of the thread: a Worker gets
    // about half the main thread's budget. Re-run this one request there.
    if (msg.retry) { retryOnFallback(msg); return; }

    // This build cannot restore the wasm stack pointer after an abnormal
    // unwind, so an instance that failed a compile has permanently lost that
    // stack. Replace it before the loss accumulates.
    if (msg.recycle) { recycleWorker(msg.reason); return; }

    if (msg.progress !== undefined || msg.phase !== undefined) {
      showBootProgress(msg);
      return;
    }

    if (msg.ready) {
      onWorkerReady();
      return;
    }

    resolvePending(msg);
  }

  function onFallbackMessage(e) {
    var msg = e.data || {};
    if (msg.fatal) {
      // The fallback is the last resort; fail only the requests it owns.
      Object.keys(state.pending).forEach(function (id) {
        var entry = state.pending[id];
        if (entry.via !== "fallback") return;
        clearTimeout(entry.timer);
        delete state.pending[id];
        entry.resolve({ id: +id, ok: false, error: msg.fatal, diagnostics: [], outputs: {} });
      });
      return;
    }
    if (msg.ready || msg.phase !== undefined || msg.recycle) return;
    resolvePending(msg);
  }

  function resolvePending(msg) {
    var entry = state.pending[msg.id];
    if (!entry) return;
    clearTimeout(entry.timer);
    delete state.pending[msg.id];
    if (!Object.keys(state.pending).length) markBusy(false);
    entry.resolve(msg);
  }

  /* A compile the Worker could not finish, re-run on the main thread. This
   * freezes the UI for the duration, which is why it is not the default path,
   * but answering slowly beats not answering. */
  function retryOnFallback(msg) {
    var entry = state.pending[msg.id];
    if (!entry) return;
    clearTimeout(entry.timer);
    // A warm-up compile is ours, not the user's: never freeze the page for it.
    // The recycle notice that follows stands up a fresh Worker, whose ready
    // handler tries the warm-up again.
    if (entry.req.warmup) {
      delete state.pending[msg.id];
      entry.resolve({ id: msg.id, ok: false, warmupFailed: msg.retry });
      return;
    }
    // Reassign ownership synchronously: a recycle notice arrives immediately
    // after this one, and must not also re-send this request to the new Worker.
    entry.via = "fallback";

    if (entry.req.openfl || HxcCore.usesOpenFL(entry.req.files || {})) heavyOnMainThread = true;
    noteMainThread();
    // Keep the last few so a failure can be inspected after the fact.
    window.HXR_FAILURES = (window.HXR_FAILURES || []).slice(-4);
    window.HXR_FAILURES.push(msg);
    if (window.console) {
      console.warn("hxc: compile " + msg.id + " exhausted the worker call stack after " +
                   (msg.timeMs || "?") + "ms; retrying on the main thread", msg.stack);
    }

    ensureFallback().then(function () {
      dispatch(entry.req, "fallback");
    }, function (err) {
      delete state.pending[msg.id];
      entry.resolve({ id: msg.id, ok: false, diagnostics: [{
        severity: "error", file: "", line: 1, column: 1, endLine: 1, endColumn: 1,
        message: "this input is too deeply recursive for the compiler to finish here",
        code: "overflow"
      }], outputs: {}, runnable: false, timeMs: 0, log: [], stats: {} });
    });
  }

  function noteMainThread() {
    if (retriedOnce) return;
    retriedOnce = true;
    toast("This build is too deep for a background thread in this browser, so it runs " +
          "on the page itself. The page will pause until it finishes.", 7000);
  }

  var fallbackPromise = null;
  function ensureFallback() {
    if (fallbackPromise) return fallbackPromise;
    if (!assets) return Promise.reject(new Error("compiler assets unavailable"));
    fallbackPromise = new Promise(function (resolve, reject) {
      try {
        fallback = new HxcMainThread(assets);
      } catch (err) { return reject(err); }
      var settled = false;
      var prior = onFallbackMessage;
      fallback.onmessage = function (e) {
        var msg = e.data || {};
        if (!settled && msg.ready) { settled = true; resolve(); return; }
        if (!settled && msg.fatal) { settled = true; reject(new Error(msg.fatal)); return; }
        prior(e);
      };
      setTimeout(function () {
        if (!settled) { settled = true; reject(new Error("main-thread compiler timed out")); }
      }, BOOT_TIMEOUT_MS);
    });
    return fallbackPromise;
  }

  /* Terminate a Worker whose wasm stack has been permanently eaten and stand up
   * a fresh one. Cheap because the compiled module is already in hand. Requests
   * the old Worker still owed go back on the queue and flush on ready. */
  function recycleWorker(reason) {
    if (USE_STUB || !assets) return;
    if (worker) { try { worker.terminate(); } catch (e) {} }
    worker = null;

    Object.keys(state.pending).forEach(function (id) {
      var entry = state.pending[id];
      if (entry.via !== "worker") return;
      clearTimeout(entry.timer);
      delete state.pending[id];
      state.queue.push(entry.req);
    });

    state.ready = false;
    setCompilerStatus("booting", "restarting " + COMPILER_NAME);
    if (window.console) console.warn("hxc: recycling the compiler worker (" + reason + ")");
    armBootTimer();
    spawnWorker();
  }

  function onWorkerReady() {
    if (state.ready) return;
    state.ready = true;
    clearTimeout(bootTimer);
    hideBootOverlay();
    setCompilerStatus("ready", COMPILER_NAME + " ready");

    var q = state.queue;
    state.queue = [];
    if (!q.length) markBusy(false);   // started fine; a compile sets it again
    // Right after page load the compiler runs as unoptimized wasm, which is
    // slower and uses much bigger stack frames: even a hello world can exhaust
    // a Worker's stack on its first compile. Spend that on throwaway compiles
    // rather than on the user's first Run. One that overflows is dropped
    // quietly (see retryOnFallback) and tried again on the fresh Worker; every
    // attempt pushes the browser toward optimizing the compiler, and optimized
    // code is shared by every instance of the module.
    if (!q.length && !warmedUp && warmupTries < WARMUP_MAX_TRIES && !USE_STUB && !LIGHT) {
      setTimeout(warmUp, warmupTries ? WARMUP_RETRY_MS : 0);
    }
    q.forEach(function (req) { dispatch(req); });
  }

  function warmUp() {
    // Only on an idle compiler: the user's own work always goes first.
    if (warmedUp || !state.ready || state.queue.length || Object.keys(state.pending).length) return;
    warmupTries++;
    ask("compile", { files: { "Main.hx": WARMUP_SRC }, main: "Main", target: "js",
                     options: DEFAULT_OPTIONS, warmup: true })
      .then(function (res) {
        if (res && res.ok) warmedUp = true;
        state.warmup = { tries: warmupTries, ok: warmedUp };   // for inspection
      });
  }

  function bootFailed(message) {
    clearTimeout(bootTimer);
    state.ready = false;
    setCompilerStatus("error", "compiler failed");
    showBootError(message);
    // reject anything waiting so the UI never hangs
    Object.keys(state.pending).forEach(function (id) {
      clearTimeout(state.pending[id].timer);
      state.pending[id].resolve({ id: +id, ok: false, error: message, diagnostics: [], outputs: {} });
      delete state.pending[id];
    });
    state.queue.forEach(function (req) {
      req._resolve({ id: req.id, ok: false, error: message, diagnostics: [], outputs: {} });
    });
    state.queue = [];
  }

  // `via` is "worker" (default) or "fallback". The request itself is kept so a
  // compile the Worker cannot finish can be re-sent to the main thread under
  // the same id, resolving the original promise exactly once.
  function dispatch(req, via) {
    via = via || "worker";
    var target = via === "fallback" ? fallback : worker;
    if (!target) { state.queue.push(req); return; }   // recycling; flushes on ready
    if (req.kind === "compile") {
      markBusy(true, (req.openfl || HxcCore.usesOpenFL(req.files || {}) ? "compiling an OpenFL project" :
                     "compiling a Haxe project") + (req.warmup ? " (warm-up)" : ""));
    }

    state.pending[req.id] = {
      req: req,
      via: via,
      resolve: req._resolve,
      timer: setTimeout(function () {
        if (state.pending[req.id]) {
          delete state.pending[req.id];
          req._resolve({ id: req.id, ok: false, error: "timed out",
                         diagnostics: [], outputs: {} });
        }
      }, req.timeoutMs || REQUEST_TIMEOUT_MS)
    };
    // req carries a _resolve callback that structured-clone cannot serialize;
    // post a clean copy so the message actually reaches the worker.
    var wire = {};
    for (var k in req) if (k !== "_resolve") wire[k] = req[k];
    target.postMessage(wire);
  }

  /* A project's libraries and flags come from its build.hxml, and Feathers UI
   * from an import alone (libs.js). They are resolved here, fetched once, and
   * sent along with each request; each compiler instance writes a library into
   * its filesystem once. */
  var LIB_TIMEOUT_MS = 180000;   // OpenFL-sized builds type a whole framework from source

  var HXML_TEMPLATE = [
    "# Libraries and flags for this playground, as in any hxml file.",
    "# Read here: -lib, -D, --macro, -cp, -main, -dce, --no-inline, --no-opt, -debug.",
    "#",
    "# A library haxe.run serves itself (see the Docs page for the list):",
    "#   -lib feathersui",
    "# Any haxelib on GitHub, pinned to a tag, branch or commit:",
    "#   -lib tink_core:git:https://github.com/haxetink/tink_core#2.1.1",
    "",
    ""
  ].join("\n");

  // A module path from a file path, minus whichever -cp folder holds it.
  function stripClassPath(main, args) {
    for (var i = 0; i + 1 < args.length; i++) {
      if (args[i] !== "-cp") continue;
      var prefix = args[i + 1].replace(/\//g, ".") + ".";
      if (main.indexOf(prefix) === 0) return main.slice(prefix.length);
    }
    return main;
  }

  // The payload plus what its build.hxml asks for. Never rejects: problems come
  // back as diagnostics against build.hxml, merged into the result by ask().
  function withProject(payload) {
    var fetching = false;
    function restore() { if (fetching && state.ready) setCompilerStatus("ready", COMPILER_NAME + " ready"); }
    return HxrLibs.resolve(payload.files, function (name) {
      fetching = true;
      setCompilerStatus("booting", "loading " + name);
    }).then(function (r) {
      restore();
      var p = {};
      for (var k in payload) p[k] = payload[k];
      p.libs = r.bundles;
      p.extraArgs = r.args;
      p.openfl = r.openfl;
      if (r.main) p.main = r.main;
      else if (p.main) p.main = stripClassPath(p.main, r.args);
      if (r.bundles.length || r.openfl) p.timeoutMs = LIB_TIMEOUT_MS;
      p.projectDiagnostics = r.diagnostics;
      return p;
    }, function (err) {
      restore();
      var p = {};
      for (var k in payload) p[k] = payload[k];
      p.libs = [];
      p.projectDiagnostics = [{ severity: "error", file: HxrLibs.HXML, line: 1, column: 1, endLine: 1, endColumn: 2,
                                message: "could not read the project's libraries: " + (err && err.message || err), code: "hxml" }];
      return p;
    });
  }

  function ask(kind, payload) {
    if (kind === "compile" && !payload.libs) {
      return withProject(payload).then(function (p) {
        return ask(kind, p).then(function (res) {
          // The instance that ran out is being replaced right now; one retry
          // lands on the fresh one (recycleWorker re-queues it).
          if (res && res.outOfMemory && !p.memoryRetry) {
            p.memoryRetry = true;
            return ask(kind, p);
          }
          return res;
        }).then(function (res) {
          var extra = p.projectDiagnostics || [];
          if (res && extra.length) {
            res.diagnostics = extra.concat(res.diagnostics || []);
            if (extra.some(function (d) { return d.severity === "error"; })) { res.ok = false; res.runnable = false; }
          }
          return res;
        });
      });
    }
    return new Promise(function (resolve) {
      var id = ++state.seq;
      var req = { id: id, kind: kind };
      for (var k in payload) req[k] = payload[k];
      req._resolve = resolve;

      if (kind === "compile" && heavyOnMainThread && !req.warmup && (req.openfl || HxcCore.usesOpenFL(req.files || {}))) {
        noteMainThread();
        // Let the notice and the "compiling" state paint before the page blocks.
        ensureFallback().then(function () { setTimeout(function () { dispatch(req, "fallback"); }, 60); },
                              function () { if (state.ready) dispatch(req); else state.queue.push(req); });
        return;
      }
      ensureCompiler();
      if (state.ready) dispatch(req);
      else state.queue.push(req);   // flushed on ready
    });
  }

  /* Completion, hover and signature help run on a Worker of their own, so a
   * Run never waits behind keystrokes. It is also disposable: if a request is
   * ever slow, the instance is replaced, which only costs an instantiate of the
   * module already in hand. (The July 2026 compiler build slowed down sharply
   * after a handful of display requests; current hxc answers each in ~10 ms.)
   *
   * Requests are coalesced per kind: while one is in flight, a newer request
   * of the same kind replaces the waiting one, which resolves empty. Fast
   * typing only ever costs the latest keystroke. */
  var DISPLAY_RECYCLE_AFTER = Infinity;
  var DISPLAY_SLOW_MS = 800;
  var DISPLAY_TIMEOUT_MS = 8000;
  var DISPLAY_ORDER = ["complete", "signature", "hover"];
  // Each instance holds its own ~270 MB heap; skip the second one on phones.
  var DISPLAY_ENABLED = !USE_STUB && !LIGHT;

  var display = { worker: null, ready: false, served: 0, busy: null, waiting: {}, dead: false };

  function emptyDisplay(kind) {
    if (kind === "complete") return { items: [] };
    if (kind === "hover") return { value: null };
    return { label: "", params: [], activeParam: 0 };
  }

  function askDisplay(kind, payload) {
    if (USE_STUB) return ask(kind, payload);
    if (!DISPLAY_ENABLED || display.dead || !assets) return Promise.resolve(emptyDisplay(kind));
    // Completion needs the project's libraries too; they are cached after the first fetch.
    return withProject(payload).then(function (p) {
      if (p.openfl) return emptyDisplay(kind);   // see _display in hxc-core.js
      return new Promise(function (resolve) {
        var prev = display.waiting[kind];
        if (prev) prev.resolve(emptyDisplay(kind));
        display.waiting[kind] = { kind: kind, payload: p, resolve: resolve };
        pumpDisplay();
      });
    });
  }

  function pumpDisplay() {
    if (display.busy) return;
    if (!display.worker) { spawnDisplayWorker(); return; }
    if (!display.ready) return;

    var next = null;
    for (var i = 0; i < DISPLAY_ORDER.length && !next; i++) {
      next = display.waiting[DISPLAY_ORDER[i]] || null;
      if (next) delete display.waiting[DISPLAY_ORDER[i]];
    }
    if (!next) return;

    var id = ++state.seq;
    display.busy = {
      id: id, kind: next.kind, resolve: next.resolve,
      timer: setTimeout(function () { recycleDisplay(); }, DISPLAY_TIMEOUT_MS)
    };
    var wire = { id: id, kind: next.kind };
    for (var k in next.payload) wire[k] = next.payload[k];
    display.worker.postMessage(wire);
  }

  function spawnDisplayWorker() {
    try {
      display.worker = new Worker(workerUrl());
    } catch (err) {
      display.dead = true;
      return;
    }
    display.ready = false;
    display.served = 0;
    display.worker.onmessage = function (e) {
      var msg = e.data || {};
      if (msg.fatal) { display.dead = true; recycleDisplay(); return; }
      if (msg.ready) { display.ready = true; pumpDisplay(); return; }
      if (msg.recycle) { recycleDisplay(); return; }
      if (msg.phase !== undefined || msg.note !== undefined) return;
      finishDisplay(msg);
    };
    display.worker.onerror = function () { recycleDisplay(); };
    display.worker.postMessage({ kind: "init", wasmModule: assets.wasmModule, data: assets.data });
  }

  function finishDisplay(msg) {
    var b = display.busy;
    if (!b || msg.id !== b.id) return;
    clearTimeout(b.timer);
    display.busy = null;
    b.resolve(msg);
    display.served++;
    if (display.served >= DISPLAY_RECYCLE_AFTER || msg.timeMs > DISPLAY_SLOW_MS) recycleDisplay();
    else pumpDisplay();
  }

  // Throw the instance away and stand up the next one straight away, so it is
  // ready by the next keystroke.
  function recycleDisplay() {
    if (display.worker) { try { display.worker.terminate(); } catch (e) {} }
    display.worker = null;
    display.ready = false;
    if (display.busy) {
      clearTimeout(display.busy.timer);
      display.busy.resolve(emptyDisplay(display.busy.kind));
      display.busy = null;
    }
    if (display.dead) {
      DISPLAY_ORDER.forEach(function (k) {
        if (display.waiting[k]) display.waiting[k].resolve(emptyDisplay(k));
      });
      display.waiting = {};
      return;
    }
    spawnDisplayWorker();
  }

  function displayPayload(model, position) {
    return {
      files: allFiles(),
      file: model.uri.path.replace(/^\//, ""),
      offset: model.getOffsetAt(position),
      main: entryModule(),
      target: state.target,
      options: state.options
    };
  }

  /* ------------------------------------------------------- boot / status UI */

  function setCompilerStatus(kind, text) {
    var el = $("compilerStatus");
    if (!el) return;
    el.className = "compiler-status status-" + kind;
    $("compilerStatusText").textContent = text;
  }

  function showBootProgress(msg) {
    if (msg.phase === "compiling") markBusy(true, "compiling the compiler's WebAssembly");
    else if (msg.phase === "instantiating") markBusy(true, "starting the compiler");
    var sub = $("bootSub"), bar = $("bootBar"), hint = $("bootHint");
    if (msg.note) sub.textContent = msg.note;
    else if (msg.phase) sub.textContent = msg.phase + "…";

    if (msg.total && bar) {
      var pct = Math.max(0, Math.min(100, Math.round((msg.loaded / msg.total) * 100)));
      bar.style.width = pct + "%";
      bar.parentNode.classList.remove("indeterminate");
      if (msg.total > 1024) {
        hint.textContent = fmtBytes(msg.loaded) + " / " + fmtBytes(msg.total);
      }
    } else if (bar) {
      bar.parentNode.classList.add("indeterminate");
      if (msg.loaded) hint.textContent = fmtBytes(msg.loaded);
    }
    setCompilerStatus("booting", msg.phase ? msg.phase : "loading compiler");
  }

  function fmtBytes(n) {
    if (n > 1048576) return (n / 1048576).toFixed(1) + " MB";
    if (n > 1024) return Math.round(n / 1024) + " KB";
    return n + " B";
  }

  function hideBootOverlay() {
    var o = $("bootOverlay");
    if (o) { o.classList.add("gone"); setTimeout(function () { o.style.display = "none"; }, 320); }
  }

  function showBootError(message) {
    var o = $("bootOverlay");
    if (!o) return;
    o.classList.remove("gone");
    o.style.display = "";
    o.classList.add("boot-error");
    $("bootSub").textContent = "The compiler could not start.";
    $("bootHint").textContent = message || "";
    var bar = $("bootBar"); if (bar) bar.parentNode.classList.add("hidden");
    var retry = $("bootRetry");
    if (retry) {
      retry.classList.remove("hidden");
      retry.onclick = function () { location.reload(); };
    }
  }

  // Start the compiler after the page has finished loading, so its 36 MB of
  // downloads don't compete with Monaco's.
  //
  // (An earlier note here claimed a Worker created mid-load inherits a smaller
  // call stack. That isn't a thing: a thread's stack is fixed when the thread is
  // created and doesn't depend on what the main thread is doing. The real
  // asymmetry is that Workers simply get about half the main thread's budget,
  // which is what the fallback path above exists to handle.)
  // In light mode it waits until something needs it: a playground opening, a
  // request, or haxeRun.ready().
  var compilerStarted = false;
  function ensureCompiler() {
    if (compilerStarted) return;
    compilerStarted = true;
    startCompiler();
  }
  function startCompilerDeferred() { setTimeout(ensureCompiler, 0); }
  if (!LIGHT) {
    if (document.readyState === "complete") startCompilerDeferred();
    else window.addEventListener("load", startCompilerDeferred);
  }

  /* ----------------------------------------------------------- file storage */

  function sourceOf(name) {
    if (state.models[name]) return state.models[name].getValue();
    return state.files[name] || "";
  }

  function allFiles() {
    var out = {};
    fileNames().forEach(function (n) { out[n] = sourceOf(n); });
    return out;
  }

  function fileNames() {
    return Object.keys(state.files).sort(function (a, b) {
      if (a === "Main.hx") return -1;
      if (b === "Main.hx") return 1;
      return a.localeCompare(b);
    });
  }

  function entryModule() {
    var names = fileNames().filter(function (n) { return /\.hx$/i.test(n); });
    var hit = names.filter(function (n) {
      return /\bstatic\s+function\s+main\s*\(/.test(sourceOf(n));
    });
    var pick = hit.indexOf("Main.hx") > -1 ? "Main.hx" : (hit[0] || names[0] || "Main.hx");
    return pick.replace(/\.hx$/, "").replace(/\//g, ".");
  }

  function addFile(name, source, quiet) {
    if (state.files[name] !== undefined) { switchFile(name); return false; }
    state.files[name] = source || "";
    if (state.monaco) {
      state.models[name] = state.monaco.editor.createModel(
        state.files[name], /\.hxml$/i.test(name) ? "hxml" : "haxe", state.monaco.Uri.parse("file:///" + name)
      );
      state.models[name].onDidChangeContent(onEdit);
    }
    if (!quiet) { switchFile(name); onEdit(); }
    return true;
  }

  function closeFile(name) {
    if (fileNames().length <= 1) { toast("A project needs at least one module"); return; }
    delete state.files[name];
    if (state.models[name]) { state.models[name].dispose(); delete state.models[name]; }
    if (state.active === name) switchFile(fileNames()[0]);
    renderFileTabs();
    onEdit();
  }

  function renameFile(oldName, anchor) {
    askText(anchor || $("addFileBtn"),
            { label: "Rename module", value: oldName, confirm: "Rename" })
      .then(function (next) {
        if (!next || next === oldName) return;
        next = normalizeName(next);
        if (state.files[next] !== undefined) { toast(next + " already exists"); return; }
        var src = sourceOf(oldName);
        if (state.models[oldName]) { state.models[oldName].dispose(); delete state.models[oldName]; }
        delete state.files[oldName];
        addFile(next, src, true);
        switchFile(next);
        renderFileTabs();
        onEdit();
      });
  }

  function normalizeName(name) {
    name = String(name).trim().replace(/^\/+/, "");
    if (!/\.hx(ml)?$/i.test(name)) name += ".hx";
    return name.replace(/[^\w./-]/g, "");
  }

  function switchFile(name) {
    if (state.files[name] === undefined) return;
    if (state.active && state.models[state.active])
      state.files[state.active] = state.models[state.active].getValue();
    state.active = name;
    if (state.editor && state.models[name]) {
      state.editor.setModel(state.models[name]);
      state.editor.focus();
    } else if (state.fallback) {
      state.fallback.value = state.files[name];
    }
    renderFileTabs();
  }

  function renderFileTabs() {
    var host = $("fileTabs");
    if (!host) return;
    host.innerHTML = "";
    var entry = entryModule().replace(/\./g, "/") + ".hx";

    fileNames().forEach(function (name, i) {
      var tab = document.createElement("div");
      tab.className = "file-tab" + (name === state.active ? " active" : "");
      tab.setAttribute("role", "tab");
      tab.title = (name === entry ? name + " (entry point)" : name) +
        (i < 9 ? "   Alt+" + (i + 1) : "");

      var label = document.createElement("span");
      label.className = "file-name";
      label.textContent = name;
      tab.appendChild(label);

      if (name === entry) {
        var dot = document.createElement("span");
        dot.className = "entry-dot";
        dot.title = "entry point";
        tab.appendChild(dot);
      }

      var close = document.createElement("button");
      close.className = "file-close";
      close.innerHTML = "&#10005;";
      close.title = "Close module";
      close.onclick = function (e) { e.stopPropagation(); closeFile(name); };
      tab.appendChild(close);

      tab.onclick = function () { switchFile(name); };
      tab.ondblclick = function () { renameFile(name, tab); };
      host.appendChild(tab);
    });
  }

  function loadProject(files, meta) {
    Object.keys(state.models).forEach(function (n) { state.models[n].dispose(); });
    state.models = {};
    state.files = {};
    state.active = null;
    state.project = meta || { id: null, name: null, kind: "draft" };
    // per-project compile state resets; the new project is judged fresh
    state.manual = false;
    state.dirty = false;
    state.lastResult = null;

    Object.keys(files).forEach(function (name) { addFile(name, files[name], true); });
    switchFile(fileNames()[0]);
    renderFileTabs();
    renderProjectName();
  }

  function renderProjectName() {
    var el = $("projectName");
    if (!el) return;
    el.textContent = state.project.name || "untitled";
    el.className = "project-name" + (state.project.kind === "saved" ? " is-saved" : "");
    $("deleteBtn").classList.toggle("hidden", state.project.kind !== "saved");
  }

  /* ---------------------------------------------------------- saved samples */

  function savedProjects() { return recall(LS.saved, {}); }

  function saveProject(promptName) {
    var suggested = state.project.kind === "saved"
      ? state.project.name
      : (state.project.name && state.project.name !== "untitled" ? state.project.name : "my playground");

    if (promptName === false) return commitSave(suggested);
    return askText($("saveBtn"), { label: "Save as", value: suggested, confirm: "Save" })
      .then(function (name) { if (name) commitSave(name); });
  }

  function commitSave(name) {
    var all = savedProjects();
    all[name] = { files: allFiles(), target: state.target, savedAt: Date.now() };
    store(LS.saved, all);
    state.project = { id: name, name: name, kind: "saved" };
    renderProjectName();
    renderPicker();
    if ($("exampleCards")) renderDashboard();
    $("picker").value = "saved:" + name;
    toast('Saved "' + name + '" to this browser');
  }

  function deleteProject() {
    if (state.project.kind !== "saved") return;
    var name = state.project.name;
    askConfirm($("deleteBtn"), 'Delete "' + name + '"?').then(function (yes) {
      if (!yes) return;
      var all = savedProjects();
      delete all[name];
      store(LS.saved, all);
      state.project = { id: null, name: name, kind: "draft" };
      renderProjectName();
      renderPicker();
      if ($("exampleCards")) renderDashboard();
      toast("Deleted");
    });
  }

  function renderPicker() {
    var sel = $("picker");
    var current = sel.value;
    sel.innerHTML = "";

    var gEx = document.createElement("optgroup");
    gEx.label = "Examples";
    (window.HXR_EXAMPLES || []).forEach(function (ex) {
      var o = document.createElement("option");
      o.value = "example:" + ex.id;
      var n = Object.keys(ex.files).length;
      o.textContent = ex.name + (n > 1 ? "  (" + n + " modules)" : "");
      gEx.appendChild(o);
    });
    sel.appendChild(gEx);

    var saved = savedProjects();
    var names = Object.keys(saved).sort(function (a, b) {
      return saved[b].savedAt - saved[a].savedAt;
    });
    if (names.length) {
      var gS = document.createElement("optgroup");
      gS.label = "Saved in this browser";
      names.forEach(function (n) {
        var o = document.createElement("option");
        o.value = "saved:" + n;
        var count = Object.keys(saved[n].files).length;
        o.textContent = n + (count > 1 ? "  (" + count + " modules)" : "");
        gS.appendChild(o);
      });
      sel.appendChild(gS);
    }

    if (current) sel.value = current;
  }

  function onPick() {
    var v = $("picker").value;
    if (!v) return;
    var kind = v.split(":")[0];
    var id = v.slice(kind.length + 1);

    if (kind === "example") {
      var ex = (window.HXR_EXAMPLES || []).filter(function (x) { return x.id === id; })[0];
      if (!ex) return;
      loadProject(ex.files, { id: ex.id, name: ex.name, kind: "example" });
      if (ex.preview) setView("preview"); else setView("code");
    } else {
      var p = savedProjects()[id];
      if (!p) return;
      loadProject(p.files, { id: id, name: id, kind: "saved" });
      if (p.target) state.target = p.target;
      setView("code");
    }
    history.replaceState(null, "", location.pathname);
    maybeAutoCompile();
  }

  /* -------------------------------------------------------------- compiling */

  function onEdit() {
    state.dirty = true;
    clearTimeout(state.draftTimer);
    state.draftTimer = setTimeout(saveDraft, 700);

    if (isHeavy()) {
      // Never live-compile a heavy project: it would freeze the UI on every
      // pause in typing. Wait for an explicit Run.
      clearTimeout(state.compileTimer);
      setEditorStatus("edited", "edited · Run to recompile");
    } else {
      scheduleCompile();
    }
  }

  function saveDraft() {
    store(LS.draft, {
      files: allFiles(), target: state.target,
      project: state.project, active: state.active
    });
  }

  // Heavy = an OpenFL/app project, or one whose last compile was slow enough
  // that we've switched it to compile-on-Run.
  function isHeavy() {
    if (state.manual) return true;
    var src = fileNames().map(sourceOf).join("\n");
    return /\bimport\s+(openfl|lime|flash|feathers)\./.test(src) || hostMode() === "app";
  }

  function setEditorStatus(kind, text) {
    var el = $("editorStatus");
    el.textContent = text || kind;
    el.className = "pane-meta status-" + kind;
  }

  // Compile only when it's cheap to do so live. Heavy projects wait for Run.
  function maybeAutoCompile() {
    if (isHeavy()) {
      state.dirty = true;
      $("runBtn").disabled = false;         // let the user trigger the compile
      setEditorStatus("edited", "Run to compile");
      $("compileMeta").textContent = "press Run to compile this project";
      renderOutput({ outputs: {} });
      return Promise.resolve(null);
    }
    return compile();
  }

  function scheduleCompile() {
    clearTimeout(state.compileTimer);
    setEditorStatus("typing", "typing");
    state.compileTimer = setTimeout(compile, 380);
  }

  // Returns a promise resolving to the compile result (or null if skipped).
  // opts.quiet suppresses the editor status spinner (used when the preview
  // surface is already showing its own "Compiling…" state, so it isn't shown twice).
  function compile(opts) {
    if (state.compiling) return state.compiling;
    store(LS.target, state.target);

    if (!(opts && opts.quiet)) setEditorStatus("compiling", "compiling…");
    $("runBtn").disabled = true;

    // The main-thread compiler blocks the UI, so yield once (setTimeout, not rAF
    // which pauses when unfocused) to let the "compiling" state paint first.
    var p = new Promise(function (resolve) {
      setTimeout(function () {
        ask("compile", {
          files: allFiles(),
          main: entryModule(),
          target: state.target,
          options: state.options
        }).then(resolve);
      }, 16);
    }).then(function (res) {
      state.compiling = false;
      state.dirty = false;
      state.lastResult = res;
      state.lastCompileMs = res.timeMs || 0;
      if (state.lastCompileMs > HEAVY_COMPILE_MS) state.manual = true;

      renderDiagnostics(res.diagnostics || []);
      renderOutput(res);
      renderLog(res);
      setEditorStatus(res.ok ? "ok" : "errors", res.ok ? "ok" : "errors");
      $("compileMeta").textContent = res.ok
        ? "compiled " + (res.stats ? res.stats.modules : fileNames().length) +
          " module" + ((res.stats ? res.stats.modules : 1) === 1 ? "" : "s") +
          " in " + res.timeMs + " ms" + (state.manual ? "  · Run to recompile" : "")
        : (res.diagnostics.length + " problem" + (res.diagnostics.length === 1 ? "" : "s"));
      $("runBtn").disabled = !res.runnable;
      return res;
    });

    state.compiling = p;
    return p;
  }

  // hxc emits haxe's "// Generated by Haxe 4.3.x" banner, because its output
  // matches haxe's. Say which compiler actually produced it.
  function rebrand(code) {
    return String(code || "").replace(
      /^\/\/ Generated by Haxe ([\d.]+)/m,
      "// Generated by hxc (Haxe $1 compatible)"
    );
  }

  function renderOutput(res) {
    var names = Object.keys(res.outputs || {});
    var placeholder = (state.dirty && isHeavy())
      ? "// press Run to compile this project"
      : "// fix the errors on the left to see generated output";
    var code = names.length
      ? names.map(function (n) {
          return names.length > 1 ? "// ---- " + n + " ----\n" + rebrand(res.outputs[n]) : rebrand(res.outputs[n]);
        }).join("\n\n")
      : placeholder;

    var host = $("outputCode").querySelector("code");
    host.textContent = code;

    var t = TARGETS.filter(function (x) { return x.id === state.target; })[0];
    $("targetMeta").textContent = names.length
      ? (names.length > 1 ? names.length + " files" : names[0])
      : (t ? t.label : "");

    // Syntax-highlight, but skip it for large output (OpenFL emits ~2.5MB of
    // JS): colorizing that much would jank the UI, and it stays readable as
    // plain text.
    if (state.monaco && names.length && code.length < 200000) {
      state.monaco.editor.colorize(code, (t && t.lang) || "plaintext", {})
        .then(function (html) { host.innerHTML = html; })
        .catch(function () {});
    }
  }

  function renderLog(res) {
    var host = $("logLines");
    host.innerHTML = "";
    (res.log || []).forEach(function (entry) {
      var el = document.createElement("div");
      el.className = "console-line log-" + entry.level;
      el.textContent = entry.text;
      host.appendChild(el);
    });
    var s = res.stats;
    if (!s || !s.modules) { $("logStats").textContent = ""; return; }
    var line = s.modules + " module" + (s.modules === 1 ? "" : "s") +
               ", " + s.types + " type" + (s.types === 1 ? "" : "s");
    if (s.fieldsRemoved) line += ", " + s.fieldsRemoved + " fields removed";
    var ph = s.phases || {};
    if (ph.parse != null) {
      line += "  |  parse " + ph.parse + "ms, type " + ph.type +
              "ms, filter " + ph.filter + "ms, gen " + ph.generate + "ms";
    }
    $("logStats").textContent = line;
  }

  function renderDiagnostics(diags) {
    var list = $("problemsList");
    var count = $("problemsCount");
    var multi = fileNames().length > 1;
    list.innerHTML = "";

    if (!diags.length) {
      count.textContent = "No problems";
      count.className = "";
    } else {
      var errors = diags.filter(function (d) { return d.severity === "error"; }).length;
      var warns = diags.length - errors;
      count.textContent =
        (errors ? errors + " error" + (errors === 1 ? "" : "s") : "") +
        (errors && warns ? ", " : "") +
        (warns ? warns + " warning" + (warns === 1 ? "" : "s") : "");
      count.className = errors ? "has-errors" : "has-warnings";
    }

    diags.forEach(function (d) {
      var li = document.createElement("li");
      li.className = "problem problem-" + d.severity;
      li.innerHTML =
        '<span class="problem-sev">' + (d.severity === "error" ? "&#10005;" : "&#9888;") + "</span>" +
        '<span class="problem-msg"></span><span class="problem-loc"></span>';
      li.querySelector(".problem-msg").textContent = d.message;
      li.querySelector(".problem-loc").textContent =
        (multi ? d.file + " " : "") + d.line + ":" + d.column;
      li.onclick = function () { revealAt(d.file, d.line, d.column); };
      list.appendChild(li);
    });

    if (state.monaco) {
      Object.keys(state.models).forEach(function (n) {
        state.monaco.editor.setModelMarkers(state.models[n], "hxc", []);
      });
      var byFile = {};
      diags.forEach(function (d) { (byFile[d.file] = byFile[d.file] || []).push(d); });
      Object.keys(byFile).forEach(function (n) {
        if (!state.models[n]) return;
        state.monaco.editor.setModelMarkers(state.models[n], "hxc", byFile[n].map(function (d) {
          return {
            severity: d.severity === "error"
              ? state.monaco.MarkerSeverity.Error
              : state.monaco.MarkerSeverity.Warning,
            message: d.message,
            startLineNumber: d.line, startColumn: d.column,
            endLineNumber: d.endLine || d.line,
            endColumn: d.endColumn || d.column + 1
          };
        }));
      });
    }
  }

  function revealAt(file, line, column) {
    if (file && file !== state.active && state.files[file] !== undefined) switchFile(file);
    if (state.editor) {
      state.editor.revealLineInCenter(line);
      state.editor.setPosition({ lineNumber: line, column: column });
      state.editor.focus();
    }
  }

  /* --------------------------------------------------------- run / preview */

  function currentExample() {
    if (state.project.kind !== "example") return null;
    return (window.HXR_EXAMPLES || []).filter(function (x) {
      return x.id === state.project.id;
    })[0] || null;
  }

  function runtimeJs() {
    // Prefer the real compiled output. An example's `emit` is only a stand-in
    // used when there is no runnable compile yet (stub compiler, or a failed or
    // pending compile), so the demo still moves.
    if (state.lastResult && state.lastResult.runnable && state.lastResult.outputs) {
      var n = Object.keys(state.lastResult.outputs)[0];
      if (n) return state.lastResult.outputs[n];
    }
    var ex = currentExample();
    if (ex && ex.emit) return ex.emit;
    return null;
  }

  // How should this project's output be presented when run?
  //   "app"      full-viewport render surface the program owns (OpenFL/Lime, any
  //              app that creates its own canvas and sizes to the window)
  //   "centered" a drawing snippet: centered canvas on a dark stage
  //   "console"  text program: trace output only
  function hostMode() {
    var ex = currentExample();
    if (ex && ex.host) return ex.host;                       // explicit wins
    if (ex && ex.preview) return "centered";

    // Heuristic: does the code look like a display-list app?
    var src = fileNames().map(sourceOf).join("\n");
    if (/\bimport\s+(openfl|lime|flash|feathers)\./.test(src) || HxrLibs.declaresOpenFL(allFiles()) ||
        /\bextends\s+(Sprite|Application|DisplayObject|Bitmap)\b/.test(src) ||
        /\baddChild\s*\(/.test(src)) {
      return "app";
    }
    return "console";
  }

  var STAGE_STYLES = {
    app:      "html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}" +
              "#openfl-content{width:100%;height:100%}canvas{display:block}",
    centered: "html,body{margin:0;height:100%;overflow:hidden;background:#0b0e14;" +
              "display:flex;align-items:center;justify-content:center}" +
              "canvas{max-width:100%;max-height:100%}",
    console:  "html,body{margin:0;background:transparent}"
  };

  function frameDoc(js, mode) {
    // OpenFL/Lime html5 mounts its canvas into an element with this id (matching
    // the standard generated index.html); without it, embed() creates no canvas.
    var mount = mode === "app" ? "<div id='openfl-content'></div>" : "";
    return "<!doctype html><meta charset='utf-8'>" +
      "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
      "<style>" + (STAGE_STYLES[mode] || STAGE_STYLES.console) + "</style><body>" +
      mount +
      "<script>" +
      // Values print the way Haxe's Std.string would (see agent-api.js).
      "var fmt=function(x,d){d=d||0;if(x===null||x===undefined||(typeof x!=='object'&&typeof x!=='function'))return String(x);if(d>4)return '...';try{if(Array.isArray(x))return '['+x.map(function(v){return fmt(v,d+1)}).join(',')+']';if(typeof x.toString==='function'&&x.toString!==Object.prototype.toString)return String(x);if(typeof x==='function')return '<function>';var k=Object.keys(x).filter(function(n){return typeof x[n]!=='function'});return k.length?'{ '+k.map(function(n){return n+' : '+fmt(x[n],d+1)}).join(', ')+' }':'{}'}catch(e){return String(x)}};" +
      "var send=function(k,a){parent.postMessage({__hxr:1,kind:k," +
      "text:Array.prototype.map.call(a,function(x){return fmt(x)}).join(' ')},'*')};" +
      "console.log=function(){send('log',arguments)};" +
      "console.info=console.log;" +
      "console.error=function(){send('error',arguments)};" +
      "console.warn=function(){send('warn',arguments)};" +
      "window.onerror=function(m,s,l,c,e){send('error',[e&&e.stack||m]);return true};" +
      "window.addEventListener('unhandledrejection',function(ev){" +
      "send('error',[(ev.reason&&(ev.reason.stack||ev.reason.message))||ev.reason])});" +
      "try{" + String(js).replace(/<\/script>/gi, "<\\/script>") +
      "}catch(e){send('error',[e&&e.stack||e&&e.message||e])}" +
      "<\/script></body>";
  }

  function run() {
    var needCompile = state.dirty || !state.lastResult;
    var toPreview = hostMode() === "app" || hostMode() === "centered";
    var quiet = false;

    // When the run targets the preview surface, that surface owns the
    // "Compiling…" indication, so the editor spinner is suppressed (no double).
    if (needCompile && toPreview) {
      setView("preview");
      updatePreviewMeta(hostMode());
      showStageMessage("Compiling…");
      quiet = true;
    }

    (needCompile ? compile({ quiet: quiet }) : Promise.resolve(state.lastResult)).then(function (res) {
      if (!res) return;
      if (!res.runnable) {
        if (!res.ok) toast("Fix the errors before running");
        else toast("This target produced nothing to run");
        return;
      }
      executeRun();
    });
  }

  // Replace the stage iframe with a brand-new one carrying `html`. Built from
  // scratch (not cloneNode, which copies the previous srcdoc attribute and can
  // leave the iframe showing stale content like "Compiling…" even after the
  // property is reassigned) so each render is a guaranteed-clean document.
  function setStage(html) {
    var old = $("stage");
    var next = document.createElement("iframe");
    next.id = "stage";
    next.className = old.className;
    next.title = old.title;
    next.setAttribute("sandbox", old.getAttribute("sandbox") || "allow-scripts");
    old.parentNode.replaceChild(next, old);
    next.srcdoc = html;
  }

  function executeRun() {
    var js = runtimeJs();
    var mode = hostMode();
    clearConsole();

    if (mode === "app" || mode === "centered") {
      state.lastRunMode = mode;
      setView("preview");
      updatePreviewMeta(mode);
      setStage(frameDoc(js || "", mode));
      if (!js) toast("Nothing to render yet");
      return;
    }

    setView("console");
    $("sandbox").srcdoc = frameDoc(js, "console");
  }

  function showStageMessage(title, sub) {
    setStage(
      "<!doctype html><meta charset='utf-8'><style>" +
      "html,body{margin:0;height:100%;display:flex;flex-direction:column;" +
      "align-items:center;justify-content:center;background:#0b0e14;" +
      "font-family:system-ui,sans-serif;color:#9aa3b2;gap:8px}" +
      ".t{color:#ff9d2e;font-size:15px}.s{font-size:12px}" +
      "@keyframes p{0%,100%{opacity:1}50%{opacity:.4}}.t{animation:p 1s infinite}" +
      "</style><div class='t'>" + title + "</div>" +
      (sub ? "<div class='s'>" + sub + "</div>" : ""));
  }

  function updatePreviewMeta(mode) {
    var el = $("previewMeta");
    if (!el) return;
    el.innerHTML = mode === "app"
      ? "app render surface, sandboxed"
      : "sandboxed iframe, <code>allow-scripts</code> only";
  }

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (d && d.__hxr) pushConsole(d.text, d.kind);
  });

  function pushConsole(text, kind) {
    var el = document.createElement("div");
    el.className = "console-line console-" + (kind || "log");
    el.textContent = text;
    $("consoleLines").appendChild(el);
    $("consoleLines").scrollTop = $("consoleLines").scrollHeight;
  }

  function clearConsole() { $("consoleLines").innerHTML = ""; }

  /* ------------------------------------------------------------ view tabs */

  function setView(view) {
    state.view = view;
    $("outputCode").classList.toggle("dimmed", view !== "code");
    $("previewView").classList.toggle("hidden", view !== "preview");
    $("consoleView").classList.toggle("hidden", view !== "console");
    $("logView").classList.toggle("hidden", view !== "log");
    renderTabs();
  }

  function renderTabs() {
    var host = $("tabs");
    host.innerHTML = "";

    TARGETS.forEach(function (t) {
      var b = document.createElement("button");
      b.className = "tab" + (state.view === "code" && state.target === t.id ? " active" : "");
      b.textContent = t.label;
      b.setAttribute("role", "tab");
      b.onclick = function () {
        var changed = state.target !== t.id;
        state.target = t.id;
        setView("code");
        // Only recompile when the target actually changes. Clicking the tab for
        // the current target just shows the output we already have (otherwise a
        // heavy/OpenFL project would reset to "press Run" instead of its JS).
        if (changed) maybeAutoCompile();
        else if (state.lastResult) renderOutput(state.lastResult);
        else maybeAutoCompile();
      };
      host.appendChild(b);
    });

    var spacer = document.createElement("span");
    spacer.className = "tab-spacer";
    host.appendChild(spacer);

    [["preview", "Preview"], ["console", "Console"], ["log", "Log"]].forEach(function (v) {
      var b = document.createElement("button");
      b.className = "tab tab-aux" + (state.view === v[0] ? " active" : "");
      b.textContent = v[1];
      b.onclick = function () { setView(v[0]); };
      host.appendChild(b);
    });
  }

  /* ---------------------------------------------------------------- options */

  function readOptions() {
    var defines = {};
    ($("optDefines").value || "").split("\n").forEach(function (line) {
      line = line.trim();
      if (!line) return;
      var eq = line.indexOf("=");
      if (eq > -1) defines[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      else defines[line] = true;
    });

    state.options = {
      dce: $("optDce").value,
      analyzer: $("optAnalyzer").value === "on",
      debug: $("optDebug").checked,
      noInline: $("optNoInline").checked,
      noOpt: $("optNoOpt").checked,
      nullSafety: $("optNullSafety").checked,
      defines: defines
    };
    store(LS.options, state.options);
    renderOptionSummary();
    state.dirty = true;
    maybeAutoCompile();
  }

  function writeOptions() {
    var o = state.options;
    $("optDce").value = o.dce;
    $("optAnalyzer").value = o.analyzer ? "on" : "off";
    $("optDebug").checked = !!o.debug;
    $("optNoInline").checked = !!o.noInline;
    $("optNoOpt").checked = !!o.noOpt;
    $("optNullSafety").checked = !!o.nullSafety;
    $("optDefines").value = Object.keys(o.defines || {}).map(function (k) {
      return o.defines[k] === true ? k : k + "=" + o.defines[k];
    }).join("\n");
    renderOptionSummary();
  }

  function renderOptionSummary() {
    var o = state.options, bits = [];
    if (o.dce !== "std") bits.push("-dce " + o.dce);
    if (!o.analyzer) bits.push("--no-analyzer");
    if (o.debug) bits.push("-debug");
    if (o.noInline) bits.push("--no-inline");
    if (o.noOpt) bits.push("--no-opt");
    if (o.nullSafety) bits.push("null-safety");
    var n = Object.keys(o.defines || {}).length;
    if (n) bits.push(n + " define" + (n === 1 ? "" : "s"));
    $("optSummary").textContent = bits.length ? bits.join("  ") : "defaults";
    $("optionsBtn").classList.toggle("has-changes", bits.length > 0);
  }

  function toggleOptions(force) {
    var panel = $("optionsPanel");
    var open = force !== undefined ? force : panel.classList.contains("hidden");
    panel.classList.toggle("hidden", !open);
    $("optionsBtn").setAttribute("aria-expanded", String(open));
  }

  /* --------------------------------------------------------------- sharing */

  /* --------------------------------------------------------------- sharing
   *
   * A share link carries the whole project in the URL fragment, so there is no
   * server and nothing is uploaded (fragments are never sent in a request).
   *
   * Payloads are deflated before base64url. Base64 alone *inflates* by a third,
   * which put the largest sample near 2k characters, the point where chat
   * clients start truncating links; deflating first roughly halves them.
   *
   * Link forms:
   *   #z=...    a whole project, packed
   *   #p=id     a built-in example
   *   #src=url  a .hx file, or a .json manifest of several
   */

  function b64urlEncode(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64urlDecode(str) {
    var s = str.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function packPayload(json) {
    var cs = new CompressionStream("deflate-raw");
    var w = cs.writable.getWriter();
    w.write(new TextEncoder().encode(json));
    w.close();
    return new Response(cs.readable).arrayBuffer()
      .then(function (buf) { return b64urlEncode(new Uint8Array(buf)); });
  }

  function unpackPayload(packed) {
    var ds = new DecompressionStream("deflate-raw");
    var w = ds.writable.getWriter();
    w.write(b64urlDecode(packed));
    w.close();
    return new Response(ds.readable).text();
  }

  function share() {
    var json = JSON.stringify({
      f: allFiles(), t: state.target, o: state.options, n: state.project.name
    });

    packPayload(json).then(function (packed) {
      var frag = "#z=" + packed;
      var url = location.origin + location.pathname + frag;
      history.replaceState(null, "", frag);
      state.lastHash = frag;

      if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(
          function () { toast("Link copied to clipboard"); },
          function () { toast("Link is in the address bar"); });
      } else toast("Link is in the address bar");
    }).catch(function () {
      toast("Could not build a share link in this browser");
    });
  }

  function hasShareHash() { return /#(z|p|src)=/.test(location.hash); }

  /* Named playgrounds: #p=shapes
   * Curated content does not belong in a URL payload. A short, permanent id
   * keeps links readable and lets an example be corrected without breaking
   * every link that was ever shared to it. */
  function loadNamed(id) {
    var ex = (window.HXR_EXAMPLES || []).filter(function (e) { return e.id === id; })[0];
    if (!ex) return false;
    loadProject(clone(ex.files), { id: ex.id, name: ex.name, kind: "example" });
    return true;
  }

  /* External sources: #src=https://raw.githubusercontent.com/.../Main.hx
   *
   * Lets a repository be the source of truth: an "Open in haxe.run" link next to
   * a sample opens the real file, no copy kept here. Both raw.githubusercontent
   * and gist raw send permissive CORS headers, so this works from a static host.
   *
   * A .json URL may instead supply a whole project: { "files": { path: source } }.
   * Nothing fetched is executed until the visitor presses Run.
   */
  function loadFromSrc(rawUrl) {
    var url;
    try { url = new URL(rawUrl, location.href); } catch (e) { return Promise.resolve(false); }
    if (url.protocol !== "https:" && url.hostname !== "localhost") {
      toast("Only https sources can be loaded");
      return Promise.resolve(false);
    }

    return fetch(url.href, { credentials: "omit" })
      .then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r.text();
      })
      .then(function (text) {
        var name = decodeURIComponent(url.pathname.split("/").pop() || "Main.hx");
        var files;

        if (/\.json$/i.test(name)) {
          var manifest = JSON.parse(text);
          files = manifest.files || manifest;
          if (!files || typeof files !== "object") throw new Error("bad manifest");
        } else {
          if (!/\.hx$/i.test(name)) name = "Main.hx";
          files = {};
          files[name] = text;
        }

        loadProject(files, {
          id: null,
          name: (/\.json$/i.test(name) ? (JSON.parse(text).name || "shared project") : name.replace(/\.hx$/, "")),
          kind: "draft"
        });
        toast("Loaded from " + url.hostname);
        return true;
      })
      .catch(function () {
        toast("Could not load that source");
        return false;
      });
  }

  function applyShared(json) {
    var data = JSON.parse(json);
    var files = data.f || (data.s ? { "Main.hx": data.s } : null);
    if (!files) return false;
    loadProject(files, { id: null, name: data.n || "shared playground", kind: "draft" });
    if (data.t) state.target = data.t;
    if (data.o) { state.options = data.o; writeOptions(); }
    return true;
  }

  // Resolves to true when a shared project was loaded.
  function loadFromHash() {
    var p = /#p=([\w-]+)/.exec(location.hash);
    if (p) return Promise.resolve(loadNamed(p[1]));

    var src = /#src=(.+)$/.exec(location.hash);
    if (src) return loadFromSrc(decodeURIComponent(src[1]));

    var z = /#z=([^&]+)/.exec(location.hash);
    if (z) {
      return unpackPayload(z[1])
        .then(function (json) { return applyShared(json); })
        .catch(function () { return false; });
    }
    return Promise.resolve(false);
  }

  function toast(text, ms) {
    var el = $("toast");
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.remove("show"); }, ms || 2200);
  }

  /* ----------------------------------------------------------------- theme */

  function initTheme() {
    var root = document.documentElement;
    var saved = recall(LS.theme, null);
    if (saved === "light" || saved === "dark") root.setAttribute("data-theme", saved);
    else if (window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches)
      root.setAttribute("data-theme", "light");
    applyMonacoTheme();

    $("themeBtn").onclick = function () {
      var next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
      root.setAttribute("data-theme", next);
      store(LS.theme, next);
      applyMonacoTheme();
      if (state.lastResult) renderOutput(state.lastResult);
    };
  }

  function applyMonacoTheme() {
    if (!state.monaco) return;
    var light = document.documentElement.getAttribute("data-theme") === "light";
    state.monaco.editor.setTheme(light ? "hxplus-light" : "hxplus-dark");
  }

  /* -------------------------------------------------------------- splitter */

  function initSplitter() {
    var sp = $("splitter"), ws = document.querySelector(".workspace"), dragging = false;
    var saved = recall(LS.layout, null);
    if (saved) ws.style.gridTemplateColumns = saved + "% 6px 1fr";

    sp.addEventListener("mousedown", function () {
      dragging = true; document.body.style.cursor = "col-resize";
    });
    window.addEventListener("mouseup", function () {
      if (!dragging) return;
      dragging = false; document.body.style.cursor = "";
      if (state.editor) state.editor.layout();
    });
    window.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      var rect = ws.getBoundingClientRect();
      var pct = Math.max(25, Math.min(75, ((e.clientX - rect.left) / rect.width) * 100));
      ws.style.gridTemplateColumns = pct + "% 6px 1fr";
      store(LS.layout, Math.round(pct));
      if (state.editor) state.editor.layout();
    });
  }

  /* ---------------------------------------------------------------- editor */

  var HAXE_TOKENS = {
    keywords: [
      "abstract","break","case","cast","catch","class","continue","default","do",
      "dynamic","else","enum","extends","extern","false","final","for","function",
      "if","implements","import","in","inline","interface","macro","new","null",
      "operator","overload","override","package","private","public","return",
      "static","super","switch","this","throw","true","try","typedef","untyped",
      "using","var","while","const","finally","defer","record"
    ],
    typeKeywords: ["Int","Float","Bool","String","Void","Dynamic","Array","Map","Null","Any"],
    operators: [
      "=",">","<","!","~","?",":","==","<=",">=","!=","&&","||","++","--",
      "+","-","*","/","&","|","^","%","<<",">>",">>>","+=","-=","*=","/=",
      "&=","|=","^=","%=","<<=",">>=",">>>=","=>","->","..."
    ],
    symbols: /[=><!~?:&|+\-*\/\^%]+/,
    tokenizer: {
      root: [
        [/@[a-zA-Z_:][\w:.]*/, "annotation"],
        [/[A-Z][\w$]*/, { cases: { "@typeKeywords": "keyword.type", "@default": "type.identifier" } }],
        [/[a-z_$][\w$]*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
        { include: "@whitespace" },
        [/[{}()\[\]]/, "@brackets"],
        [/@symbols/, { cases: { "@operators": "operator", "@default": "" } }],
        [/\d*\.\d+([eE][\-+]?\d+)?/, "number.float"],
        [/0[xX][0-9a-fA-F]+/, "number.hex"],
        [/\d+/, "number"],
        [/[;,.]/, "delimiter"],
        [/"([^"\\]|\\.)*$/, "string.invalid"],
        [/"/, { token: "string.quote", bracket: "@open", next: "@string_double" }],
        [/'/, { token: "string.quote", bracket: "@open", next: "@string_single" }]
      ],
      whitespace: [
        [/[ \t\r\n]+/, ""],
        [/\/\*/, "comment", "@comment"],
        [/\/\/.*$/, "comment"]
      ],
      comment: [[/[^\/*]+/, "comment"], [/\*\//, "comment", "@pop"], [/[\/*]/, "comment"]],
      string_double: [
        [/[^\\"]+/, "string"], [/\\./, "string.escape"],
        [/"/, { token: "string.quote", bracket: "@close", next: "@pop" }]
      ],
      string_single: [
        [/\$\{/, { token: "delimiter.bracket", next: "@interp" }],
        [/\$[a-zA-Z_]\w*/, "variable"],
        [/[^\\'$]+/, "string"], [/\\./, "string.escape"],
        [/'/, { token: "string.quote", bracket: "@close", next: "@pop" }]
      ],
      interp: [[/\}/, { token: "delimiter.bracket", next: "@pop" }], { include: "root" }]
    }
  };

  var KIND_MAP = {
    keyword: "Keyword", function: "Function", class: "Class",
    field: "Field", variable: "Variable", module: "Module"
  };

  function initMonaco(monaco) {
    state.monaco = monaco;
    monaco.languages.register({ id: "haxe", extensions: [".hx"] });
    monaco.languages.setMonarchTokensProvider("haxe", HAXE_TOKENS);
    monaco.languages.register({ id: "hxml", extensions: [".hxml"] });
    monaco.languages.setMonarchTokensProvider("hxml", {
      tokenizer: { root: [
        [/#.*$/, "comment"],
        [/^\s*-{1,2}[\w-]+/, "keyword"],
        [/https?:\/\/\S+/, "string"]
      ] }
    });
    monaco.languages.setLanguageConfiguration("hxml", { comments: { lineComment: "#" } });
    monaco.languages.setLanguageConfiguration("haxe", {
      comments: { lineComment: "//", blockComment: ["/*", "*/"] },
      brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
      autoClosingPairs: [
        { open: "{", close: "}" }, { open: "[", close: "]" },
        { open: "(", close: ")" }, { open: '"', close: '"' }, { open: "'", close: "'" }
      ]
    });

    monaco.editor.defineTheme("hxplus-dark", {
      base: "vs-dark", inherit: true,
      rules: [
        { token: "keyword", foreground: "ff9d2e" },
        { token: "keyword.type", foreground: "6fb7ff" },
        { token: "type.identifier", foreground: "6fb7ff" },
        { token: "string", foreground: "5fd39a" },
        { token: "string.quote", foreground: "5fd39a" },
        { token: "comment", foreground: "6b7484" },
        { token: "number", foreground: "6fb7ff" },
        { token: "annotation", foreground: "c792ea" }
      ],
      colors: {
        "editor.background": "#0b0e14",
        "editorGutter.background": "#0b0e14",
        "editorLineNumber.foreground": "#3b4354",
        "editor.lineHighlightBackground": "#131826"
      }
    });

    monaco.editor.defineTheme("hxplus-light", {
      base: "vs", inherit: true,
      rules: [
        { token: "keyword", foreground: "b8500a" },
        { token: "keyword.type", foreground: "1d46b0" },
        { token: "type.identifier", foreground: "1d46b0" },
        { token: "string", foreground: "0f8a55" },
        { token: "string.quote", foreground: "0f8a55" },
        { token: "comment", foreground: "7d8aa0" },
        { token: "number", foreground: "1d46b0" },
        { token: "annotation", foreground: "7a3fb8" }
      ],
      colors: {
        "editor.background": "#ffffff",
        "editorGutter.background": "#ffffff",
        "editorLineNumber.foreground": "#a3aec2",
        "editorLineNumber.activeForeground": "#1d46b0",
        "editor.lineHighlightBackground": "#f3f6fb"
      }
    });

    state.editor = monaco.editor.create($("editor"), {
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      lineHeight: 21,
      fontFamily: '"Cascadia Code", Consolas, "Liberation Mono", Menlo, monospace',
      scrollBeyondLastLine: false,
      renderLineHighlight: "line",
      padding: { top: 14, bottom: 14 },
      tabSize: 4,
      smoothScrolling: true
    });

    monaco.languages.registerCompletionItemProvider("haxe", {
      // Typing a word asks on its own; "." is the one character that should
      // open the list before anything is typed after it.
      triggerCharacters: ["."],
      provideCompletionItems: function (model, position) {
        return askDisplay("complete", displayPayload(model, position)).then(function (res) {
          var word = model.getWordUntilPosition(position);
          var range = {
            startLineNumber: position.lineNumber, endLineNumber: position.lineNumber,
            startColumn: word.startColumn, endColumn: word.endColumn
          };
          return {
            suggestions: (res.items || []).map(function (it) {
              return {
                label: it.label,
                kind: monaco.languages.CompletionItemKind[KIND_MAP[it.kind] || "Text"],
                detail: it.detail, documentation: it.doc,
                insertText: it.insert || it.label, range: range
              };
            })
          };
        });
      }
    });

    monaco.languages.registerHoverProvider("haxe", {
      provideHover: function (model, position) {
        return askDisplay("hover", displayPayload(model, position)).then(function (res) {
          return res.value ? { contents: [{ value: res.value }] } : null;
        });
      }
    });

    monaco.languages.registerSignatureHelpProvider("haxe", {
      signatureHelpTriggerCharacters: ["(", ","],
      provideSignatureHelp: function (model, position) {
        return askDisplay("signature", displayPayload(model, position)).then(function (res) {
          if (!res.label) return null;
          return {
            value: {
              signatures: [{
                label: res.label,
                parameters: (res.params || []).map(function (p) { return { label: p }; })
              }],
              activeSignature: 0, activeParameter: res.activeParam || 0
            },
            dispose: function () {}
          };
        });
      }
    });

    state.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, run);
    state.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, function () {
      saveProject();
    });

    applyMonacoTheme();
    finishBoot();
  }

  function initFallbackEditor() {
    var host = $("editor");
    host.innerHTML = "";
    var ta = document.createElement("textarea");
    ta.className = "fallback-editor";
    ta.spellcheck = false;
    host.appendChild(ta);
    state.fallback = ta;
    ta.addEventListener("input", function () {
      if (state.active) state.files[state.active] = ta.value;
      onEdit();
    });
    toast("Editor running in basic mode (Monaco unavailable)");
    finishBoot();
  }

  function loadMonaco() {
    var loader = document.createElement("script");
    loader.src = MONACO_CDN + "/vs/loader.js";
    loader.onload = function () {
      if (!window.require) return initFallbackEditor();
      window.require.config({ paths: { vs: MONACO_CDN + "/vs" } });
      window.require(["vs/editor/editor.main"], function () {
        try { initMonaco(window.monaco); }
        catch (e) { console.error(e); initFallbackEditor(); }
      }, function () { initFallbackEditor(); });
    };
    loader.onerror = initFallbackEditor;
    document.head.appendChild(loader);
  }

  /* ------------------------------------------------------------ shortcuts */

  function initShortcuts() {
    document.addEventListener("keydown", function (e) {
      var mod = e.ctrlKey || e.metaKey;

      if (mod && e.key === "Enter") { e.preventDefault(); run(); return; }
      if (mod && e.shiftKey && (e.key === "S" || e.key === "s")) {
        e.preventDefault(); share(); return;
      }
      if (mod && (e.key === "s" || e.key === "S")) { e.preventDefault(); saveProject(); return; }
      if (mod && e.altKey && (e.key === "n" || e.key === "N")) {
        e.preventDefault(); newModule(); return;
      }
      if (e.key === "Escape") { toggleOptions(false); return; }

      if (e.altKey && !mod && /^[1-9]$/.test(e.key)) {
        var names = fileNames();
        var idx = parseInt(e.key, 10) - 1;
        if (names[idx]) { e.preventDefault(); switchFile(names[idx]); }
      }
    });
  }

  /* ------------------------------------------------------- inline dialogs
   *
   * Native prompt()/confirm() are avoided: they block the page, look foreign,
   * and browsers silently suppress them once a user ticks "prevent additional
   * dialogs", which made the new-module button appear dead. These are small
   * popovers anchored to whatever was clicked.
   */

  // The dismiss handler is kept on the module so it can actually be removed.
  // (Registering an anonymous listener and then "removing" a different function
  // left every popover's handler attached; the stale ones then saw clicks on the
  // next popover as outside-clicks and tore it down before Create could fire.)
  var popoverDismiss = null;

  function closePopover() {
    var p = document.querySelector(".popover");
    if (p) p.remove();
    if (popoverDismiss) {
      document.removeEventListener("mousedown", popoverDismiss, true);
      popoverDismiss = null;
    }
  }

  function popover(anchor, build) {
    closePopover();
    var el = document.createElement("div");
    el.className = "popover";
    build(el);
    document.body.appendChild(el);

    var r = anchor.getBoundingClientRect();
    var w = el.offsetWidth;
    el.style.top = (r.bottom + 8) + "px";
    el.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 12)) + "px";

    popoverDismiss = function (e) {
      if (!el.contains(e.target)) closePopover();
    };
    setTimeout(function () {
      document.addEventListener("mousedown", popoverDismiss, true);
    }, 0);
    return el;
  }

  function askText(anchor, opts) {
    return new Promise(function (resolve) {
      popover(anchor, function (el) {
        var label = document.createElement("label");
        label.className = "popover-label";
        label.textContent = opts.label;
        el.appendChild(label);

        var input = document.createElement("input");
        input.className = "popover-input";
        input.value = opts.value || "";
        input.spellcheck = false;
        el.appendChild(input);

        var row = document.createElement("div");
        row.className = "popover-row";
        var cancel = document.createElement("button");
        cancel.className = "btn btn-tiny";
        cancel.textContent = "Cancel";
        var ok = document.createElement("button");
        ok.className = "btn btn-tiny btn-primary";
        ok.textContent = opts.confirm || "Create";
        row.appendChild(cancel); row.appendChild(ok);
        el.appendChild(row);

        function done(v) { closePopover(); resolve(v); }
        ok.onclick = function () { done(input.value.trim() || null); };
        cancel.onclick = function () { done(null); };
        input.onkeydown = function (e) {
          if (e.key === "Enter") { e.preventDefault(); done(input.value.trim() || null); }
          if (e.key === "Escape") { e.preventDefault(); done(null); }
        };

        setTimeout(function () {
          input.focus();
          input.setSelectionRange(0, (input.value.replace(/\.hx$/, "") || "").length);
        }, 0);
      });
    });
  }

  function askConfirm(anchor, message, confirmLabel) {
    return new Promise(function (resolve) {
      popover(anchor, function (el) {
        var p = document.createElement("div");
        p.className = "popover-label";
        p.textContent = message;
        el.appendChild(p);

        var row = document.createElement("div");
        row.className = "popover-row";
        var cancel = document.createElement("button");
        cancel.className = "btn btn-tiny";
        cancel.textContent = "Cancel";
        var ok = document.createElement("button");
        ok.className = "btn btn-tiny btn-danger-solid";
        ok.textContent = confirmLabel || "Delete";
        row.appendChild(cancel); row.appendChild(ok);
        el.appendChild(row);

        ok.onclick = function () { closePopover(); resolve(true); };
        cancel.onclick = function () { closePopover(); resolve(false); };
        setTimeout(function () { ok.focus(); }, 0);
      });
    });
  }

  function newModule() {
    askText($("addFileBtn"), { label: "New module", value: "Utils.hx", confirm: "Create" })
      .then(function (name) {
        if (!name) return;
        name = normalizeName(name);
        if (state.files[name] !== undefined) { switchFile(name); renderFileTabs(); return; }
        if (/\.hxml$/i.test(name)) { addFile(name, HXML_TEMPLATE); renderFileTabs(); return; }
        var cls = name.replace(/\.hx$/, "").split("/").pop();
        var pkg = name.indexOf("/") > -1
          ? "package " + name.replace(/\/[^/]+$/, "").replace(/\//g, ".") + ";\n\n" : "";
        addFile(name, pkg + "class " + cls + " {\n    \n}\n");
        renderFileTabs();
      });
  }

  /* ------------------------------------------------------------------ boot */

  /* ------------------------------------------------------------- dashboard */

  function card(opts) {
    var el = document.createElement("button");
    el.className = "card ticks" + (opts.isNew ? " card-new" : "");
    el.type = "button";

    if (!opts.isNew) {
      var accent = document.createElement("div");
      accent.className = "card-accent " + (opts.accent || "amber");
      el.appendChild(accent);
    }

    var title = document.createElement("div");
    title.className = "card-title";
    title.textContent = opts.title;
    el.appendChild(title);

    var desc = document.createElement("div");
    desc.className = "card-desc";
    desc.textContent = opts.description || "";
    el.appendChild(desc);

    if (opts.tags && opts.tags.length) {
      var tags = document.createElement("div");
      tags.className = "card-tags";
      opts.tags.forEach(function (t) {
        var s = document.createElement("span");
        s.className = "card-tag";
        s.textContent = t;
        tags.appendChild(s);
      });
      el.appendChild(tags);
    }

    if (opts.onDelete) {
      var del = document.createElement("button");
      del.className = "card-del";
      del.type = "button";
      del.innerHTML = "&#10005;";
      del.title = "Delete";
      del.onclick = function (e) { e.stopPropagation(); opts.onDelete(del); };
      el.appendChild(del);
    }

    el.onclick = opts.onOpen;
    return el;
  }

  function renderDashboard() {
    var ex = $("exampleCards");
    ex.innerHTML = "";

    ex.appendChild(card({
      isNew: true,
      title: "+  New playground",
      description: "Start from an empty Main.hx.",
      onOpen: function () {
        openProject({ "Main.hx": "class Main {\n    static function main() {\n        trace(\"hello\");\n    }\n}\n" },
                    { id: null, name: "untitled", kind: "draft" });
      }
    }));

    (window.HXR_EXAMPLES || []).forEach(function (e) {
      var count = Object.keys(e.files).length;
      var tags = (e.tags || []).slice();
      if (count > 1 && tags.indexOf(count + " modules") === -1) tags.push(count + " modules");
      ex.appendChild(card({
        title: e.name,
        description: e.description,
        tags: tags,
        accent: e.accent,
        onOpen: function () {
          openProject(clone(e.files), { id: e.id, name: e.name, kind: "example" });
        }
      }));
    });

    var saved = savedProjects();
    var names = Object.keys(saved).sort(function (a, b) { return saved[b].savedAt - saved[a].savedAt; });
    var host = $("savedCards");
    host.innerHTML = "";
    $("savedSection").hidden = names.length === 0;

    names.forEach(function (n) {
      var p = saved[n];
      var count = Object.keys(p.files).length;
      var when = new Date(p.savedAt);
      host.appendChild(card({
        title: n,
        description: "Saved " + when.toLocaleDateString() + " at " +
                     when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        tags: [count + (count === 1 ? " module" : " modules")],
        accent: "blue",
        onOpen: function () {
          openProject(clone(p.files), { id: n, name: n, kind: "saved" });
          if (p.target) state.target = p.target;
        },
        onDelete: function (anchor) {
          askConfirm(anchor, 'Delete "' + n + '"?').then(function (yes) {
            if (!yes) return;
            var all = savedProjects();
            delete all[n];
            store(LS.saved, all);
            renderDashboard();
            renderPicker();
            toast("Deleted");
          });
        }
      }));
    });
  }

  function showDashboard() {
    document.body.classList.remove("in-editor");
    renderDashboard();
    history.replaceState(null, "", location.pathname);
    state.lastHash = "";
  }

  function openProject(files, meta) {
    ensureCompiler();
    document.body.classList.add("in-editor");
    loadProject(files, meta);
    if (meta && meta.id) $("picker").value = (meta.kind === "saved" ? "saved:" : "example:") + meta.id;
    setView("code");
    // The compiler may still be downloading; show its progress rather than a
    // silent, dead-looking editor.
    if (!state.ready) { var o = $("bootOverlay"); if (o) { o.style.display = ""; o.classList.remove("gone"); } }
    if (state.editor) state.editor.layout();
    maybeAutoCompile();
  }

  // Said once, on the dashboard and as a toast, after a crash here.
  function noteLightMode() {
    if (!crashes) return;
    var text = crashes > 1
      ? "This device has run out of memory compiling here more than once. haxe.run is in its " +
        "lightest mode now, but large projects (OpenFL, Feathers UI) may still be too big for it. " +
        "A desktop browser works best."
      : "The last visit ran out of memory, so haxe.run is in light mode: the compiler starts when " +
        "you open a playground, and completion is off.";
    var note = $("lightNote");
    if (note) { note.textContent = text; note.hidden = false; }
    toast(text, 9000);   // for anyone who lands straight in a playground from a link
    // What it was doing and on what, so a crash on someone's phone can be reported.
    deviceSummary().then(function (dev) {
      if (!note) return;
      var d = document.createElement("small");
      d.className = "dash-note-detail";
      d.textContent = "Last stage: " + (crashStage || "unknown") + ". Device: " + dev + ".";
      note.appendChild(document.createElement("br"));
      note.appendChild(d);
    });
  }

  function deviceSummary() {
    var bits = [];
    if (navigator.deviceMemory) bits.push("about " + navigator.deviceMemory + " GB memory");
    var uad = navigator.userAgentData;
    var more = uad && uad.getHighEntropyValues
      ? uad.getHighEntropyValues(["bitness", "architecture", "platformVersion", "fullVersionList"])
          .then(function (h) {
            if (h.bitness) bits.push(h.bitness + "-bit browser");
            if (h.architecture) bits.push(h.architecture);
            var b = (h.fullVersionList || []).filter(function (x) { return !/Not.?A.?Brand/i.test(x.brand); })[0];
            if (b) bits.push(b.brand + " " + b.version);
          }).catch(function () {})
      : Promise.resolve();
    return more.then(function () {
      if (!uad) bits.push(navigator.userAgent.replace(/^Mozilla\/5\.0 /, ""));
      return bits.join(", ") || "unknown";
    });
  }

  function finishBoot() {
    noteLightMode();
    state.target = recall(LS.target, state.target);
    if (!TARGETS.some(function (t) { return t.id === state.target; })) state.target = "js";

    // A shared link goes straight to the code it encodes. Decoding is async
    // (the payload is deflated), so open the editor first, then fill it in.
    state.lastHash = location.hash;
    if (hasShareHash()) {
      document.body.classList.add("in-editor");
      setView("code");
      loadFromHash().then(function (ok) {
        if (ok) maybeAutoCompile();
        else { toast("That share link could not be read"); showDashboard(); }
      });
      return;
    }

    // Otherwise start at the gallery, which also gives the compiler time to
    // finish downloading while the visitor is choosing.
    renderDashboard();
    setView("code");
  }

  function init() {
    state.options = recall(LS.options, clone(DEFAULT_OPTIONS));
    writeOptions();

    renderPicker();
    initSplitter();
    renderTabs();

    // The gallery is the landing view, so the boot overlay stays out of the way;
    // the compiler downloads in the background while the visitor browses. It is
    // only raised if someone enters the editor before the compiler is ready.
    var bo = $("bootOverlay");
    if (bo) bo.style.display = "none";

    // Paint the gallery straight away rather than waiting on the editor bundle.
    renderDashboard();

    // Following a link to a different fragment does not reload the page, so a
    // share link clicked while the playground is already open would otherwise
    // do nothing. Track the fragment we last acted on and honour changes.
    window.addEventListener("hashchange", function () {
      if (location.hash === state.lastHash) return;
      state.lastHash = location.hash;
      if (!hasShareHash()) return;
      document.body.classList.add("in-editor");
      setView("code");
      loadFromHash().then(function (ok) {
        if (ok) maybeAutoCompile();
        else { toast("That link could not be read"); showDashboard(); }
      });
    });

    $("backBtn").onclick = showDashboard;
    document.querySelector(".brand").onclick = function (e) {
      e.preventDefault();
      if (document.body.classList.contains("in-editor")) showDashboard();
    };

    $("picker").onchange = onPick;
    $("runBtn").onclick = run;
    $("shareBtn").onclick = share;
    $("saveBtn").onclick = function () { saveProject(); };
    $("deleteBtn").onclick = deleteProject;
    $("clearConsole").onclick = clearConsole;
    $("addFileBtn").onclick = newModule;
    $("reloadPreview").onclick = run;

    $("optionsBtn").onclick = function (e) { e.stopPropagation(); toggleOptions(); };
    $("optionsPanel").onclick = function (e) { e.stopPropagation(); };
    document.addEventListener("click", function () { toggleOptions(false); });
    ["optDce", "optAnalyzer", "optDebug", "optNoInline", "optNoOpt", "optNullSafety"]
      .forEach(function (id) { $(id).onchange = readOptions; });
    $("optDefines").addEventListener("input", function () {
      clearTimeout($("optDefines")._t);
      $("optDefines")._t = setTimeout(readOptions, 400);
    });
    $("optReset").onclick = function () {
      state.options = clone(DEFAULT_OPTIONS);
      writeOptions(); store(LS.options, state.options);
      state.dirty = true; maybeAutoCompile();
    };
    $("optHxml").onclick = function () {
      toggleOptions(false);
      if (!addFile(HxrLibs.HXML, HXML_TEMPLATE)) switchFile(HxrLibs.HXML);
      renderFileTabs();
    };

    initTheme();
    initShortcuts();
    loadMonaco();
    window.addEventListener("beforeunload", saveDraft);
  }

  // Private bridge for assets/agent-api.js, which builds the public, documented
  // window.haxeRun surface on top of it. Everything here is internal and may
  // change; window.haxeRun is the stable contract. See AGENTS.md.
  window.__hxrInternal = {
    ask: ask,                    // direct compiler request, bypasses the UI
    ensureCompiler: ensureCompiler,
    light: LIGHT,
    state: state,
    allFiles: allFiles,
    entryModule: entryModule,
    loadProject: loadProject,
    openProject: openProject,
    // Bring the editor up from the dashboard without compiling.
    showEditor: function () {
      document.body.classList.add("in-editor");
      setView("code");
      if (state.editor) state.editor.layout();
    },
    switchFile: switchFile,
    addFile: addFile,
    renderFileTabs: renderFileTabs,
    compileUI: compile,
    runUI: run,
    setOptions: function (o) { state.options = o; writeOptions(); },
    defaultOptions: DEFAULT_OPTIONS,
    targets: TARGETS
  };

  init();
})();
