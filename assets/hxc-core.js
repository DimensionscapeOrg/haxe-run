/*
 * hxc-core.js -- the compiler engine, shared by the Worker and the main-thread
 * adapter. Loads in either scope (importScripts or <script>).
 *
 * This file used to exist twice, copy-pasted into hxc-worker.js and
 * hxc-mainthread.js, and the copies had already drifted (only one of them
 * recognised a stack overflow). There is one copy now; the adapters are thin.
 *
 * Two things worth knowing about the wasm build, both measured from the binary:
 *
 * 1. The shadow stack (hxc's own stack, in linear memory) is ~64 MB: the
 *    __stack_pointer global starts at 68,762,640 and static data ends at
 *    1,623,250. It is the same size in a Worker and on the main thread, so it
 *    can never explain a Worker-only failure.
 *
 * 2. The engine's native call stack is per-thread, and a Worker gets about half
 *    the main thread's (measured here: 6,355 vs 12,453 frames). It is not
 *    configurable from a page. This is the one that raises
 *    "Maximum call stack size exceeded", and the only one that differs by thread.
 *
 * The build never exported stackSave/stackRestore, so emscripten's callMain
 * cannot restore the stack pointer: every compile permanently consumes the
 * ~1 KB it allocates for argv, and a compile that *traps* leaks however deep it
 * was, forever. We can't fix that without a rebuild, but because we instantiate
 * the module ourselves we can hold the raw wasm exports and *watch* it:
 * _emscripten_stack_alloc(0) returns the current __stack_pointer. Every compile
 * result carries a `stack` block, and an instance that has leaked is reported
 * as poisoned so the caller can recycle it.
 */
(function (global) {
  "use strict";

  var TARGETS = {
    js:     { flag: "-js",     ext: "js",   single: true,  runnable: true  },
    cpp:    { flag: "-cpp",    ext: "cpp",  single: false, runnable: false },
    python: { flag: "-python", ext: "py",   single: true,  runnable: false },
    lua:    { flag: "-lua",    ext: "lua",  single: true,  runnable: false },
    php:    { flag: "-php",    ext: "php",  single: false, runnable: false },
    hl:     { flag: "-hl",     ext: "hl",   single: true,  runnable: false }
  };

  var DIAG_RE = /^(.+\.hx):(\d+):(?:\s*(?:lines?\s+\d+-\d+|character[s]?\s+(\d+)(?:-(\d+))?)\s*:)?\s*(.*)$/;

  var OPENFL_VERSION = "9.5.2";
  var LIME_VERSION = "8.4.0";

  // A compile that leaks more than this much shadow stack has almost certainly
  // died mid-recursion rather than returning cleanly (a clean compile leaks the
  // ~1 KB argv allocation and nothing else).
  var POISON_LEAK_BYTES = 65536;

  // A wasm instance's memory only grows, up to 2 GB. hxc releases each
  // compilation now, and OpenFL builds level off around 1 GB; past this much an
  // instance answers and is then replaced, before a compile can run out.
  var HEAP_RECYCLE_BYTES = 1536 * 1024 * 1024;

  function parseDiags(lines) {
    var diags = [];
    lines.forEach(function (ln) {
      var m = DIAG_RE.exec(ln.text);
      if (!m) return;
      var file = m[1], line = parseInt(m[2], 10);
      var c1 = m[3] ? parseInt(m[3], 10) : 1;
      var c2 = m[4] ? parseInt(m[4], 10) : c1;
      var message = m[5] || "", severity = "error";
      var mm = /^(Warning|Error|Info)\s*:\s*(.*)$/i.exec(message);
      if (mm) {
        var kind = mm[1].toLowerCase();
        severity = kind === "warning" ? "warning" : (kind === "info" ? "info" : "error");
        message = mm[2];
      } else if (ln.stream === "out") {
        return;
      }
      diags.push({ severity: severity, file: file, line: line, column: c1,
                   endLine: line, endColumn: c2, message: message, code: "" });
    });
    return diags;
  }

  // Feathers UI is built on OpenFL, and an app written against it may never
  // name openfl itself (it extends feathers.controls.Application).
  function usesOpenFL(files) {
    return Object.keys(files).some(function (n) {
      return /(^|[^\w.])(openfl|feathers)\./.test(files[n]);
    });
  }

  // OpenFL and Lime sources are packed into the wasm filesystem at /libs/openfl
  // and /libs/lime. A project that imports openfl gets those class paths plus
  // the init macros that `-lib openfl -lib lime` would contribute via haxelib.
  function openflArgs() {
    return [
      "--macro", "lime._internal.macros.DefineMacro.run()",
      "--macro", 'haxe.macro.Compiler.addMetadata("@:autoBuild(lime._internal.macros.AssetsMacro.embedBytes())","haxe.io.Bytes")',
      "-cp", "/libs/lime", "-D", "lime=" + LIME_VERSION,
      "--macro", "openfl.utils._internal.ExtraParamsMacro.include()",
      "-cp", "/libs/openfl", "-D", "openfl=" + OPENFL_VERSION,
      // Platform + renderer defines that lime's tooling normally injects for an
      // `openfl build html5`. Without a renderer define the html5 backend is
      // #if'd out, so the app boots and traces but never draws (a black stage).
      //
      // Both renderer backends are compiled in; the bootstrap requests
      // hardware:false so OpenFL runs on the Canvas renderer, which is reliable
      // inside the sandboxed iframe (WebGL was glitchy here).
      "-D", "html5",
      "-D", "web",
      "-D", "openfl-html5",
      "-D", "lime-html5",
      "-D", "lime-webgl",
      "-D", "lime-canvas",
      "--remap", "flash:openfl",
      "-D", "disable_preloader_assets"
    ];
  }

  function buildArgs(msg, openfl) {
    var tinfo = TARGETS[msg.target] || TARGETS.js;
    var opts = msg.options || {};
    var entry = openfl ? "ApplicationMain" : msg.main;

    var args = ["-main", entry, tinfo.flag, "out." + tinfo.ext,
                "-D", "message.reporting=classic", "-D", "message.no-color"];
    if (openfl) args = args.concat(openflArgs());
    // Libraries the page loaded on demand (assets/libs/*.json), written under
    // /libs/<name> by _writeLibs; the same class path and define -lib would add.
    (msg.libs || []).forEach(function (bundle) {
      (bundle.libs || []).forEach(function (lib) {
        args.push("-cp", "/libs/" + lib.name, "-D", lib.name + "=" + lib.version);
        if (lib.args) args = args.concat(lib.args);   // its extraParams.hxml
      });
    });
    if (opts.dce && opts.dce !== "std") args.push("-dce", opts.dce);
    if (opts.debug)    args.push("-debug");
    if (opts.noInline) args.push("--no-inline");
    if (opts.noOpt)    args.push("--no-opt");
    if (opts.analyzer === true) args.push("-D", "analyzer-optimize");
    if (opts.nullSafety) {
      // Only the user's code: top-level modules by name, packages recursively.
      // Pointing it at "" would hold the standard library to strict mode too.
      var roots = {};
      Object.keys(msg.files || {}).forEach(function (p) {
        var first = p.replace(/\.hx$/, "").split("/")[0];
        if (/^[A-Za-z_]\w*$/.test(first)) roots[first] = true;
      });
      Object.keys(roots).forEach(function (r) {
        args.push("--macro", "nullSafety('" + r + "', Strict)");
      });
    }
    Object.keys(opts.defines || {}).forEach(function (d) {
      var v = opts.defines[d];
      args.push("-D", v === true ? d : (d + "=" + v));
    });
    // The project's build.hxml, already reduced to flags that apply here (libs.js).
    return args.concat(msg.extraArgs || []);
  }

  /* ----------------------------------------------------------------- display
   * Completion, hover and signature help use the compiler's display mode
   * (`--display file@byteOffset[@mode]`), the same protocol editors use with
   * haxe. Results come back as XML (fields, toplevel, type) or JSON
   * (signature) on stderr. */

  var DISPLAY_KINDS = { complete: true, hover: true, signature: true };

  // Hovering these would only show the type of the enclosing expression.
  var NO_HOVER = /^(var|final|function|class|interface|enum|abstract|typedef|static|public|private|inline|override|extern|macro|dynamic|return|if|else|for|while|do|switch|case|default|break|continue|try|catch|throw|new|import|using|package|extends|implements|in|cast|untyped|true|false|null|this|super)$/;

  function emptyDisplay(msg) {
    if (msg.kind === "complete") return { id: msg.id, items: [] };
    if (msg.kind === "hover") return { id: msg.id, value: null };
    return { id: msg.id, label: "", params: [], activeParam: 0 };
  }

  function unescapeXml(s) {
    return String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");
  }

  function attr(attrs, name) {
    var m = new RegExp("\\b" + name + '="([^"]*)"').exec(attrs);
    return m ? unescapeXml(m[1]) : "";
  }

  var FIELD_KINDS = { "var": "field", method: "function", type: "class", "package": "module" };

  // Doc comments come back as written in the source: CRLF, and indented with it.
  function cleanDoc(doc) {
    var lines = unescapeXml(doc).replace(/\r/g, "").split("\n");
    var indent = null;
    lines.forEach(function (l) {
      if (!l.trim()) return;
      var n = /^[ \t]*/.exec(l)[0].length;
      if (indent === null || n < indent) indent = n;
    });
    return lines.map(function (l) { return l.slice(indent || 0); }).join("\n").trim();
  }

  function toplevelKind(k, type) {
    if (k === "local" || k === "global") return "variable";
    if (k === "member" || k === "static") return /->/.test(type) ? "function" : "field";
    if (k === "enum" || k === "enumabstract") return "field";
    if (k === "type") return "class";
    if (k === "package") return "module";
    if (k === "literal") return "keyword";
    return "variable";
  }

  function parseCompletion(text) {
    var items = [], seen = {}, m;
    if (text.indexOf("<list>") >= 0) {
      var re = /<i n="([^"]*)" k="([^"]*)"[^>]*>\s*<t>([\s\S]*?)<\/t>\s*<d>([\s\S]*?)<\/d>\s*<\/i>/g;
      while ((m = re.exec(text))) {
        var name = unescapeXml(m[1]);
        if (seen[name]) continue;
        seen[name] = true;
        items.push({ label: name, kind: FIELD_KINDS[m[2]] || "field",
                     detail: unescapeXml(m[3]), doc: cleanDoc(m[4]) });
      }
    } else if (text.indexOf("<il>") >= 0) {
      var tre = /<i k="([^"]*)"([^>]*)>([^<]*)<\/i>/g;
      while ((m = tre.exec(text))) {
        var label = unescapeXml(m[3]), type = attr(m[2], "t");
        if (!label || seen[label]) continue;
        seen[label] = true;
        items.push({ label: label, kind: toplevelKind(m[1], type),
                     detail: type || attr(m[2], "p"), doc: "" });
      }
    }
    return items;
  }

  // Haxe positions are UTF-8 byte offsets; the editor counts UTF-16 units.
  function byteOffset(src, charOffset) {
    var n = 0;
    for (var i = 0; i < charOffset; i++) {
      var c = src.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xD800 && c <= 0xDBFF) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }

  Engine.prototype._display = function (msg) {
    var t0 = Date.now();
    var files = msg.files || {};
    var src = files[msg.file];
    var empty = emptyDisplay(msg);
    // OpenFL projects type the whole framework from source on every request,
    // which is far too slow to answer keystrokes.
    if (typeof src !== "string" || msg.openfl || usesOpenFL(files)) return empty;

    var offset = Math.max(0, Math.min(src.length, msg.offset | 0));
    var at = offset, mode = "";
    var wordStart = offset;
    while (wordStart > 0 && /\w/.test(src.charAt(wordStart - 1))) wordStart--;

    if (msg.kind === "complete") {
      // Ask at the start of the word being typed and let the editor filter:
      // the compiler reports `s.ind` as an error, not as a completion.
      at = wordStart;
      if (!(wordStart > 0 && src.charAt(wordStart - 1) === ".")) mode = "@toplevel";
    } else if (msg.kind === "hover") {
      var wordEnd = offset;
      while (wordEnd < src.length && /\w/.test(src.charAt(wordEnd))) wordEnd++;
      var word = src.slice(wordStart, wordEnd);
      if (!word || /^\d/.test(word) || NO_HOVER.test(word)) return empty;
      mode = "@type";
    } else {
      mode = "@signature";
    }

    var args = buildArgs(msg, false).concat([
      "--no-output", "--display", msg.file + "@" + byteOffset(src, at) + mode
    ]);
    var m = this._mod;
    this._out.length = 0;
    this._writeLibs(msg.libs);
    this._writeFiles(files, false);
    var saved = typeof m.stackSave === "function" && typeof m.stackRestore === "function" ? m.stackSave() : null;
    try { m.callMain(args.slice()); } catch (err) {
      if (saved !== null) m.stackRestore(saved);
      if (classify(err, "")) { this.poisoned = true; return empty; }
    }
    if (saved !== null) m.stackRestore(saved);
    var text = this._out.map(function (l) { return l.text; }).join("\n");
    var res = { id: msg.id, timeMs: Date.now() - t0 };

    if (msg.kind === "complete") {
      res.items = parseCompletion(text);
    } else if (msg.kind === "hover") {
      var tm = /<type[^>]*>\s*([\s\S]*?)\s*<\/type>/.exec(text);
      var type = tm ? unescapeXml(tm[1]).trim() : "";
      res.value = type ? "```haxe\n" + type + "\n```" : null;
    } else {
      res.label = ""; res.params = []; res.activeParam = 0;
      var j = text.indexOf('{"signatures"');
      if (j >= 0) {
        try {
          var sig = JSON.parse(text.slice(j, text.lastIndexOf("}") + 1));
          var s = (sig.signatures || [])[sig.activeSignature || 0];
          if (s) {
            res.label = s.label || "";
            res.params = (s.parameters || []).map(function (p) { return p.label; });
            res.activeParam = sig.activeParameter || 0;
          }
        } catch (e) {}
      }
    }
    return res;
  };

  // Which stack died. "native" is recoverable by retrying on a thread with a
  // bigger call stack; "trap" is not, but both poison the instance.
  // Engines word these differently. Chromium: RangeError "Maximum call stack
  // size exceeded", "memory access out of bounds". Firefox: InternalError "too
  // much recursion", "index out of bounds". Safari: RangeError "Maximum call
  // stack size exceeded", "Out of bounds memory access".
  function classify(err, text) {
    var s = String((err && (err.message || err)) || "") + "\n" + (text || "");
    if (err instanceof RangeError || (err && err.name === "InternalError") ||
        /maximum call stack|call stack size exceeded|too much recursion/i.test(s)) {
      return "native";
    }
    if (/memory access out of bounds|out of bounds memory access|index out of bounds|unreachable executed|unreachable code/i.test(s)) {
      return "trap";
    }
    return null;
  }

  /* ------------------------------------------------------------------ engine */

  function Engine(cfg) {
    // cfg: { wasmModule, data, locateFile, emit, canRetry }
    var self = this;
    this._cfg = cfg;
    this._out = [];
    this._mod = null;
    this._exports = null;
    this._stackTop = 0;
    this.poisoned = false;

    var out = this._out;

    this.ready = global.createHxc({
      noInitialRun: true,
      locateFile: cfg.locateFile,
      // We instantiate from a WebAssembly.Module the caller already compiled.
      // That makes respawning an instance cheap (no refetch, no recompile of
      // 21 MB) and, just as importantly, hands us the raw exports so we can
      // read __stack_pointer.
      instantiateWasm: function (imports, receive) {
        WebAssembly.instantiate(cfg.wasmModule, imports).then(function (inst) {
          self._exports = inst.exports;
          receive(inst, cfg.wasmModule);
        }, function (err) {
          cfg.emit({ fatal: "could not instantiate the compiler: " + (err && err.message || err) });
        });
        return {};   // tells emscripten the instantiation is async
      },
      getPreloadedPackage: function () { return cfg.data; },
      print:    function (s) { out.push({ stream: "out", text: s }); },
      printErr: function (s) { out.push({ stream: "err", text: s }); },
      preRun: [function (m) {
        try { m.FS.mkdir("/work"); } catch (e) {}
        m.FS.chdir("/work");
        m.ENV.HAXE_STD_PATH = "/std";
      }]
    }).then(function (m) {
      self._mod = m;
      // Nothing has run yet, so this is the top of the shadow stack. Reading it
      // rather than hardcoding it keeps this correct across compiler rebuilds.
      self._stackTop = self.sp();
      cfg.emit({ ready: true });
      return m;
    }, function (err) {
      cfg.emit({ fatal: "compiler failed to start: " + (err && err.message || err) });
      throw err;
    });
  }

  // _emscripten_stack_alloc(0) is (sp - 0) & ~15 stored back, so this reads the
  // stack pointer at a cost of at most 15 bytes.
  Engine.prototype.sp = function () {
    return this._exports ? (this._exports._emscripten_stack_alloc(0) >>> 0) : 0;
  };

  Engine.prototype.handle = function (msg) {
    var self = this;
    msg = msg || {};

    if (DISPLAY_KINDS[msg.kind]) {
      this.ready.then(function () { self._cfg.emit(self._display(msg)); })
        .catch(function () { self._cfg.emit(emptyDisplay(msg)); });
      return;
    }
    if (msg.kind !== "compile")   { this._cfg.emit({ id: msg.id, error: "unknown request: " + msg.kind }); return; }

    this.ready.then(function () { self._cfg.emit(self._compile(msg)); })
      .catch(function (err) {
        self._cfg.emit({
          id: msg.id, ok: false, outputs: {},
          diagnostics: [{ severity: "error", file: "", line: 1, column: 1,
                          endLine: 1, endColumn: 1,
                          message: "compiler error: " + (err && err.message || err), code: "" }],
          runnable: false, timeMs: 0, log: [], stats: {}
        });
      });
  };

  // /work holds exactly the files of this request. Anything left over from an
  // earlier compile would still resolve, so a module the user deleted or
  // renamed would keep compiling.
  Engine.prototype._writeFiles = function (files, openfl) {
    var FS = this._mod.FS;
    (function clear(dir) {
      FS.readdir(dir).forEach(function (name) {
        if (name === "." || name === "..") return;
        var p = dir + "/" + name;
        if (FS.isDir(FS.stat(p).mode)) { clear(p); FS.rmdir(p); }
        else FS.unlink(p);
      });
    })("/work");

    Object.keys(files).forEach(function (path) {
      var full = "/work/" + path;
      var parts = full.slice(0, full.lastIndexOf("/")).split("/").filter(Boolean), cur = "";
      parts.forEach(function (p) { cur += "/" + p; try { FS.mkdir(cur); } catch (e) {} });
      FS.writeFile(full, files[path]);
    });
    if (openfl && global.HXR_OPENFL_BOOT) {
      FS.writeFile("/work/ApplicationMain.hx", global.HXR_OPENFL_BOOT);
    }
  };

  // On-demand libraries are written once per instance: /libs survives between
  // compiles, unlike /work.
  Engine.prototype._writeLibs = function (bundles) {
    var FS = this._mod.FS, done = this._libs || (this._libs = {});
    function clear(dir) {
      FS.readdir(dir).forEach(function (n) {
        if (n === "." || n === "..") return;
        var p = dir + "/" + n;
        if (FS.isDir(FS.stat(p).mode)) { clear(p); FS.rmdir(p); } else FS.unlink(p);
      });
    }
    (bundles || []).forEach(function (bundle) {
      (bundle.libs || []).forEach(function (lib) {
        // OpenFL and Lime come with hxc.data and are never replaced.
        if (lib.name === "openfl" || lib.name === "lime") return;
        var key = lib.key || (lib.name + "@" + lib.version);
        if (done[lib.name] === key) return;
        var root = "/libs/" + lib.name;
        // Another source or version of the same library: start from an empty folder.
        if (done[lib.name]) { try { clear(root); } catch (e) {} }
        Object.keys(lib.files).forEach(function (rel) {
          var full = root + "/" + rel;
          var parts = full.slice(0, full.lastIndexOf("/")).split("/").filter(Boolean), cur = "";
          parts.forEach(function (p) { cur += "/" + p; try { FS.mkdir(cur); } catch (e) {} });
          FS.writeFile(full, lib.files[rel]);
        });
        done[lib.name] = key;
      });
    });
  };

  Engine.prototype._compile = function (msg) {
    var t0 = Date.now();
    var files = msg.files || {};
    var tinfo = TARGETS[msg.target] || TARGETS.js;
    var outName = "out." + tinfo.ext;

    // An OpenFL project has no static main: it is a document class instantiated
    // by ApplicationMain, which lime tooling normally generates. Inject that
    // bootstrap and compile it instead of the user's module.
    var openfl = !!msg.openfl || usesOpenFL(files);
    var args = buildArgs(msg, openfl);

    var m = this._mod;
    this._out.length = 0;
    this._writeLibs(msg.libs);
    this._writeFiles(files, openfl);

    var spBefore = this.sp();
    // Builds that export stackSave/stackRestore can give back whatever callMain
    // leaves on the shadow stack, including after an abnormal unwind.
    var saved = typeof m.stackSave === "function" && typeof m.stackRestore === "function" ? m.stackSave() : null;
    var exitCode = 0, threw = null;
    try {
      m.callMain(args.slice());
    } catch (err) {
      exitCode = (err && typeof err.status === "number") ? err.status : 1;
      threw = err;
    }
    var spAfter = this.sp();
    if (saved !== null) m.stackRestore(saved);

    var rawText = this._out.map(function (l) { return l.text; }).join("\n");
    var failure = threw ? classify(threw, rawText) : null;
    var leaked = spBefore - spAfter;

    // A clean compile leaks only emscripten's argv allocation. Anything larger
    // means callMain unwound abnormally and left the stack pointer buried, which
    // only a build without stackRestore can't undo. A compile that died on the
    // native stack or trapped is retired either way: whatever state it was in
    // the middle of changing is not trusted.
    if (failure || (saved === null && leaked > POISON_LEAK_BYTES)) this.poisoned = true;
    var heapBytes = m.HEAP8 ? m.HEAP8.length : 0;
    var outOfMemory = /Memory Exhausted/i.test(rawText);
    if (outOfMemory || heapBytes > HEAP_RECYCLE_BYTES) {
      this.poisoned = true;
      this.poisonReason = "memory";
    }

    var diags = parseDiags(this._out);
    var hadError = diags.some(function (d) { return d.severity === "error"; });
    var ok = exitCode === 0 && !hadError;

    if (!ok && !hadError) {
      diags.push({
        severity: "error", file: (Object.keys(files)[0] || ""),
        line: 1, column: 1, endLine: 1, endColumn: 1,
        message: failure === "native"
          ? "the compiler ran out of call stack on this input"
          : (failure === "trap"
              ? "the compiler hit a fault on this input"
              : (rawText.trim() || ("compilation failed (exit " + exitCode + ")"))),
        code: failure ? "overflow" : ""
      });
    }

    var outputs = {};
    if (ok && tinfo.single) {
      try { outputs[outName] = m.FS.readFile("/work/" + outName, { encoding: "utf8" }); } catch (e) {}
    }

    var log = this._out.map(function (l) {
      return { level: l.stream === "err" ? "info" : "trace", text: l.text };
    });
    var names = Object.keys(files), typeCount = 0;
    names.forEach(function (n) {
      typeCount += (files[n].match(/\b(class|enum|interface|typedef|abstract)\s+\w/g) || []).length;
    });

    return {
      id: msg.id, ok: ok, outputs: outputs, diagnostics: diags,
      runnable: ok && tinfo.runnable === true && !!outputs[outName],
      timeMs: Date.now() - t0, log: log,
      stats: { modules: names.length, types: typeCount, fieldsRemoved: 0, phases: {} },
      failure: failure,
      poisoned: this.poisoned,
      poisonReason: this.poisonReason || null,
      outOfMemory: outOfMemory,
      heapBytes: heapBytes,
      threwMessage: threw ? String(threw && (threw.message || threw)) : null,
      threwName: threw && threw.name,
      stackHead: (threw && threw.stack) ? String(threw.stack).split("\n").slice(0, 15).join("\n") : null,
      argsUsed: args,
      stack: {
        top: this._stackTop, before: spBefore, after: spAfter,
        leaked: leaked, used: this._stackTop - spAfter
      }
    };
  };

  global.HxcCore = {
    Engine: Engine,
    TARGETS: TARGETS,
    usesOpenFL: usesOpenFL,
    parseDiags: parseDiags,
    classify: classify
  };
})(typeof self !== "undefined" ? self : this);
