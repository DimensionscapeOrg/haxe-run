/*
 * compiler-stub.js
 *
 * A stand-in for hxc compiled to JS, running in a Web Worker.
 * It implements the request/response contract the real compiler must satisfy,
 * so the front end can be built and finished before the compiler is ready.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT (postMessage in, postMessage out; every message carries `id`)
 *
 *   -> { id, kind: "compile", files: {path: source}, main, target, options }
 *        options = { dce: "no"|"std"|"full", analyzer: bool, debug: bool,
 *                    noInline: bool, noOpt: bool, nullSafety: bool,
 *                    defines: {name: value} }
 *   <- { id, ok, outputs: {path: source}, diagnostics: [Diag], runnable,
 *        timeMs, log: [{level, text}], stats: {modules, types, fieldsRemoved, phases} }
 *
 *   -> { id, kind: "complete", files, file, offset }
 *   <- { id, items: [{label, kind, detail, doc, insert}] }
 *
 *   -> { id, kind: "hover",    files, file, offset }
 *   <- { id, value: string | null }
 *
 *   -> { id, kind: "signature", files, file, offset }
 *   <- { id, label, params: [string], activeParam }
 *
 *   Diag = { severity: "error"|"warning"|"info",
 *            file, line, column, endLine, endColumn, message, code }
 *
 * Replace this file with the real hxc worker; keep the message shapes.
 * ---------------------------------------------------------------------------
 */

var TARGETS = {
  js:     { label: "JavaScript", ext: "js",   runnable: true  },
  cpp:    { label: "C++",        ext: "cpp",  runnable: false },
  wasm:   { label: "WebAssembly",ext: "wat",  runnable: false },
  python: { label: "Python",     ext: "py",   runnable: false },
  php:    { label: "PHP",        ext: "php",  runnable: false },
  cs:     { label: "C#",         ext: "cs",   runnable: false },
  jvm:    { label: "Java",       ext: "java", runnable: false },
  hxia:   { label: "hxia",       ext: "hxia", runnable: false }
};

var KEYWORDS = [
  "abstract","break","case","cast","catch","class","continue","default","do",
  "dynamic","else","enum","extends","extern","false","final","for","function",
  "if","implements","import","in","inline","interface","macro","new","null",
  "operator","overload","override","package","private","public","return",
  "static","super","switch","this","throw","true","try","typedef","untyped",
  "using","var","while",
  // hx+ additions
  "const","finally","defer","record"
];

var STD_COMPLETIONS = [
  { label: "trace",       kind: "function", detail: "(v:Dynamic, ?infos:PosInfos):Void", doc: "Prints a value to the output." },
  { label: "Std",         kind: "class",    detail: "class Std",        doc: "Conversions and runtime checks." },
  { label: "Math",        kind: "class",    detail: "class Math",       doc: "Mathematical constants and functions." },
  { label: "String",      kind: "class",    detail: "class String",     doc: "The string type." },
  { label: "Array",       kind: "class",    detail: "class Array<T>",   doc: "A growable collection." },
  { label: "Map",         kind: "class",    detail: "class Map<K, V>",  doc: "A key/value container." },
  { label: "StringBuf",   kind: "class",    detail: "class StringBuf",  doc: "Efficient string building." },
  { label: "haxe.Json",   kind: "class",    detail: "class haxe.Json",  doc: "JSON encoding and decoding." },
  { label: "Sys",         kind: "class",    detail: "class Sys",        doc: "System interaction (sys targets)." }
];

var MEMBERS = {
  Math: [
    { label: "PI",     kind: "field",    detail: "Float" },
    { label: "abs",    kind: "function", detail: "(v:Float):Float" },
    { label: "sin",    kind: "function", detail: "(v:Float):Float" },
    { label: "cos",    kind: "function", detail: "(v:Float):Float" },
    { label: "floor",  kind: "function", detail: "(v:Float):Int" },
    { label: "random", kind: "function", detail: "():Float" }
  ],
  Std: [
    { label: "string",   kind: "function", detail: "(s:Dynamic):String" },
    { label: "parseInt", kind: "function", detail: "(x:String):Null<Int>" },
    { label: "int",      kind: "function", detail: "(x:Float):Int" },
    { label: "isOfType", kind: "function", detail: "(v:Dynamic, t:Dynamic):Bool" }
  ],
  StringBuf: [
    { label: "add",      kind: "function", detail: "(x:Dynamic):Void" },
    { label: "addChar",  kind: "function", detail: "(c:Int):Void" },
    { label: "toString", kind: "function", detail: "():String" }
  ]
};

function indent(src, pad) {
  return src.split("\n").map(function (l) { return l.length ? pad + l : l; }).join("\n");
}

/* ---------------------------------------------------------------- diagnostics
 * Deliberately shallow pattern matching. The real compiler replaces this
 * wholesale; the point is that the shapes are right.
 */
function analyze(source, file, opts) {
  opts = opts || {};
  var diags = [];
  var lines = source.split("\n");
  var declared = {};
  var re;

  lines.forEach(function (line, i) {
    var m;
    re = /\b(?:var|final|const)\s+([A-Za-z_]\w*)/g;
    while ((m = re.exec(line))) declared[m[1]] = true;
    re = /\bfunction\s+([A-Za-z_]\w*)/g;
    while ((m = re.exec(line))) declared[m[1]] = true;
    re = /\bfor\s*\(\s*([A-Za-z_]\w*)\s+in\b/g;
    while ((m = re.exec(line))) declared[m[1]] = true;
  });

  lines.forEach(function (line, i) {
    var m;

    // Int assigned a string literal
    m = /\b(?:var|final)\s+([A-Za-z_]\w*)\s*:\s*Int\s*=\s*("[^"]*")/.exec(line);
    if (m) {
      var col = line.indexOf(m[2]) + 1;
      diags.push({
        severity: "error",
        file: file, line: i + 1, column: col,
        endLine: i + 1, endColumn: col + m[2].length,
        message: "String should be Int",
        code: "unify"
      });
    }

    // unknown identifier passed to trace
    m = /\btrace\(\s*([A-Za-z_]\w*)\s*\)/.exec(line);
    if (m && !declared[m[1]] && KEYWORDS.indexOf(m[1]) === -1) {
      var c2 = line.indexOf(m[1], line.indexOf("trace")) + 1;
      diags.push({
        severity: "error",
        file: file, line: i + 1, column: c2,
        endLine: i + 1, endColumn: c2 + m[1].length,
        message: "Unknown identifier : " + m[1],
        code: "resolve"
      });
    }

    // call to something never declared in this file
    m = /^\s*([A-Za-z_]\w*)\s*\(\s*\)\s*;/.exec(line);
    if (m && !declared[m[1]] && KEYWORDS.indexOf(m[1]) === -1) {
      var c3 = line.indexOf(m[1]) + 1;
      diags.push({
        severity: "error",
        file: file, line: i + 1, column: c3,
        endLine: i + 1, endColumn: c3 + m[1].length,
        message: "Unknown identifier : " + m[1],
        code: "resolve"
      });
    }

    // strict null safety surfaces nullable access
    if (opts.nullSafety) {
      m = /\bNull<\w+>\s+\w+|:\s*Null<\w+>/.exec(line);
      if (m) {
        var c5 = line.indexOf(m[0]) + 1;
        diags.push({
          severity: "warning",
          file: file, line: i + 1, column: c5,
          endLine: i + 1, endColumn: c5 + m[0].length,
          message: "Nullable value requires a null check under strict null safety",
          code: "nullsafety"
        });
      }
    }

    if (/\buntyped\b/.test(line)) {
      var c4 = line.indexOf("untyped") + 1;
      diags.push({
        severity: "warning",
        file: file, line: i + 1, column: c4,
        endLine: i + 1, endColumn: c4 + 7,
        message: "untyped bypasses the type system",
        code: "style"
      });
    }
  });

  return diags;
}

/* ------------------------------------------------------------------- codegen
 * Produces plausible-looking output per target. Not real compilation.
 */
function generate(target, source, main, opts, moduleNames) {
  opts = opts || {};
  var flags = [];
  if (opts.dce && opts.dce !== "std") flags.push("-dce " + opts.dce);
  if (opts.analyzer === false) flags.push("--no-analyzer");
  if (opts.debug) flags.push("-debug");
  if (opts.noInline) flags.push("--no-inline");
  if (opts.noOpt) flags.push("--no-opt");
  Object.keys(opts.defines || {}).forEach(function (d) {
    flags.push("-D " + (opts.defines[d] === true ? d : d + "=" + opts.defines[d]));
  });

  var note = "generated by hxc (stub) for target: " + target +
    (flags.length ? "  [" + flags.join(" ") + "]" : "") +
    (moduleNames && moduleNames.length > 1 ? "  from " + moduleNames.length + " modules" : "");
  var banner = "// " + note;

  switch (target) {
    case "js":
      return banner + "\n" +
        '(function ($global) { "use strict";\n' +
        'var ' + main + ' = function() {};\n' +
        main + '.main = function() {\n' +
        indent(translateBodyJs(source), "    ") + "\n" +
        "};\n" +
        indent(main + ".main();", "") + "\n" +
        "})(typeof globalThis != \"undefined\" ? globalThis : this);\n";

    case "cpp":
      return banner + "\n" +
        '#include <hxcpp.h>\n#include <' + main + '.h>\n\n' +
        "void " + main + "_obj::main() {\n" +
        indent("// hxcpp emits reference-counted, GC-aware C++", "    ") + "\n" +
        indent(commentize(source), "    ") + "\n}\n";

    case "wasm":
      return ";; " + note + "\n(module\n" +
        '  (import "env" "trace" (func $trace (param i32)))\n' +
        "  (memory (export \"memory\") 1)\n" +
        "  (func (export \"main\")\n" +
        "    ;; WasmGC structs for classes, host GC, direct JS interop\n" +
        "    call $trace_init)\n)\n";

    case "python":
      return "# " + note + "\n\nclass " + main + ":\n" +
        indent("@staticmethod\ndef main():\n" + indent(commentize(source, "#"), "    "), "    ") + "\n\n" +
        main + ".main()\n";

    case "php":
      return "<?php\n" + banner + "\n\nclass " + main + " {\n" +
        indent("public static function main() {\n" +
               indent(commentize(source), "    ") + "\n}", "    ") + "\n}\n\n" +
        main + "::main();\n";

    case "cs":
      return banner + "\n\npublic sealed class " + main + " {\n" +
        indent("public static void main() {\n" + indent(commentize(source), "    ") + "\n}", "    ") +
        "\n}\n";

    case "jvm":
      return banner + "\n\npublic final class " + main + " {\n" +
        indent("public static void main(String[] args) {\n" +
               indent(commentize(source), "    ") + "\n}", "    ") + "\n}\n";

    case "hxia":
      return "HXIA 1\n; " + note + "\n; portable typed assembly, host-linked by name\n\n" +
        "CLASS " + main + " hx.Object\n" +
        "  FUNCTION main 0 1\n" +
        "    CALLGLOBAL trace 1\n" +
        "      CONST.STR \"...\"\n" +
        "  END\n" +
        "END\n";

    default:
      return banner + "\n";
  }
}

function commentize(src, marker) {
  marker = marker || "//";
  return src.split("\n").slice(0, 14).map(function (l) {
    return marker + " " + l;
  }).join("\n");
}

// Very small subset translation so the JS output looks like it came from the source.
function translateBodyJs(source) {
  var out = [];
  var re = /trace\((.+?)\);/g;
  var m;
  while ((m = re.exec(source))) {
    out.push("console.log(" + m[1].replace(/'/g, '"') + ");");
  }
  if (!out.length) out.push("// no observable statements in this snippet");
  return out.join("\n");
}

/* -------------------------------------------------------------------- lookup */

function wordBefore(text, offset) {
  var i = offset - 1;
  while (i >= 0 && /[\w.]/.test(text.charAt(i))) i--;
  return text.slice(i + 1, offset);
}

function completionsFor(text, offset) {
  var prefix = wordBefore(text, offset);
  var dot = prefix.lastIndexOf(".");

  if (dot > -1) {
    var owner = prefix.slice(0, dot);
    var members = MEMBERS[owner];
    if (members) {
      return members.map(function (m) {
        return {
          label: m.label, kind: m.kind, detail: m.detail,
          doc: owner + "." + m.label, insert: m.label
        };
      });
    }
    return [];
  }

  var typed = prefix.toLowerCase();
  var items = [];

  KEYWORDS.forEach(function (k) {
    if (!typed || k.indexOf(typed) === 0) {
      items.push({ label: k, kind: "keyword", detail: "keyword", doc: "", insert: k });
    }
  });

  STD_COMPLETIONS.forEach(function (c) {
    if (!typed || c.label.toLowerCase().indexOf(typed) === 0) {
      items.push({ label: c.label, kind: c.kind, detail: c.detail, doc: c.doc, insert: c.label });
    }
  });

  return items;
}

function hoverFor(text, offset) {
  var word = wordBefore(text, offset + 1).replace(/^.*\./, "");
  var hit = STD_COMPLETIONS.filter(function (c) { return c.label === word; })[0];
  if (hit) return "```haxe\n" + hit.label + " : " + hit.detail + "\n```\n\n" + hit.doc;
  if (KEYWORDS.indexOf(word) > -1) return "**" + word + "** _(keyword)_";
  return null;
}

/* ------------------------------------------------------------------ dispatch */

// Announce readiness the same way the real (async) worker must. The stub is
// instant, so this fires right away; the wasm worker fires it after its module
// instantiates and its filesystem/std are in place.
self.postMessage({ ready: true });

self.onmessage = function (e) {
  var msg = e.data || {};
  var t0 = Date.now();

  if (msg.kind === "compile") {
    var opts = msg.options || {};
    var names = Object.keys(msg.files || {});
    var diags = [];

    names.forEach(function (n) {
      diags = diags.concat(analyze(msg.files[n], n, opts));
    });

    var ok = !diags.some(function (d) { return d.severity === "error"; });
    var outputs = {};
    var entryFile = msg.main.replace(/\./g, "/") + ".hx";
    var source = msg.files[entryFile] || msg.files[names[0]] || "";

    if (ok) {
      var info = TARGETS[msg.target] || TARGETS.js;
      outputs[msg.main.split(".").pop() + "." + info.ext] =
        generate(msg.target, source, msg.main.split(".").pop(), opts, names);
    }

    // Plausible pipeline accounting so the log and stats have something to show.
    var typeCount = 0;
    names.forEach(function (n) {
      typeCount += (msg.files[n].match(/\b(class|enum|interface|typedef|abstract)\s+\w/g) || []).length;
    });
    var fieldCount = 0;
    names.forEach(function (n) {
      fieldCount += (msg.files[n].match(/\bfunction\s+\w/g) || []).length;
    });
    var removed = opts.dce === "no" ? 0
      : Math.round(fieldCount * (opts.dce === "full" ? 0.55 : 0.3));

    var log = [];
    log.push({ level: "info", text: "target: " + msg.target + ", main: " + msg.main });
    log.push({ level: "info", text: "class path: /std, /src (" + names.length + " module" +
      (names.length === 1 ? "" : "s") + ")" });
    names.forEach(function (n) { log.push({ level: "trace", text: "parsed " + n }); });
    log.push({ level: "info", text: "typed " + typeCount + " type" + (typeCount === 1 ? "" : "s") });

    if (opts.nullSafety) log.push({ level: "info", text: "null safety: strict" });
    log.push({ level: "info", text: "filters: " +
      (opts.noInline ? "inline disabled, " : "") +
      (opts.noOpt ? "optimizer off, " : "reduce_expression, ") +
      (opts.analyzer === false ? "analyzer off" : "analyzer (ssa, const-prop, local-dce)") });

    if (opts.dce === "no") log.push({ level: "warn", text: "dce: disabled, nothing eliminated" });
    else log.push({ level: "info", text: "dce (" + (opts.dce || "std") + "): removed " +
      removed + " unused field" + (removed === 1 ? "" : "s") });

    if (opts.debug) log.push({ level: "info", text: "debug: position info and stack traces retained" });

    var defineNames = Object.keys(opts.defines || {});
    if (defineNames.length) {
      log.push({ level: "info", text: "defines: " + defineNames.map(function (d) {
        return opts.defines[d] === true ? d : d + "=" + opts.defines[d];
      }).join(", ") });
    }

    if (!ok) log.push({ level: "error", text: diags.filter(function (d) {
      return d.severity === "error";
    }).length + " error(s), generation skipped" });
    else log.push({ level: "info", text: "generated " + Object.keys(outputs).join(", ") });

    var elapsed = Math.max(9, Date.now() - t0 + Math.round(Math.random() * 30));

    self.postMessage({
      id: msg.id,
      ok: ok,
      outputs: outputs,
      diagnostics: diags,
      runnable: ok && (TARGETS[msg.target] || {}).runnable === true,
      timeMs: elapsed,
      log: log,
      stats: {
        modules: names.length,
        types: typeCount,
        fieldsRemoved: removed,
        phases: {
          parse: Math.max(1, Math.round(elapsed * 0.18)),
          type: Math.max(1, Math.round(elapsed * 0.44)),
          filter: Math.max(1, Math.round(elapsed * 0.22)),
          generate: Math.max(1, Math.round(elapsed * 0.16))
        }
      }
    });
    return;
  }

  if (msg.kind === "complete") {
    self.postMessage({
      id: msg.id,
      items: completionsFor(msg.files[msg.file] || "", msg.offset)
    });
    return;
  }

  if (msg.kind === "hover") {
    self.postMessage({
      id: msg.id,
      value: hoverFor(msg.files[msg.file] || "", msg.offset)
    });
    return;
  }

  if (msg.kind === "signature") {
    self.postMessage({
      id: msg.id,
      label: "trace(v:Dynamic, ?infos:PosInfos):Void",
      params: ["v:Dynamic", "?infos:PosInfos"],
      activeParam: 0
    });
    return;
  }

  self.postMessage({ id: msg.id, error: "unknown request: " + msg.kind });
};
