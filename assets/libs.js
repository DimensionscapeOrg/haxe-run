/*
 * libs.js -- libraries for a playground project, declared the way a Haxe
 * project declares them: a build.hxml file next to the sources.
 *
 *   -lib feathersui                                   a library haxe.run serves itself
 *   -lib tink_core:git:https://github.com/haxetink/tink_core#2.1.1
 *                                                     any haxelib on GitHub, at a tag,
 *                                                     branch or commit
 *   -D my_flag  --macro ...  -cp src  -main pkg.Main  -dce full  --no-inline  --no-opt  -debug
 *
 * GitHub sources come through jsDelivr, which serves repositories with CORS
 * (lib.haxe.org does not, so a page cannot download from it). A library's
 * haxelib.json gives its class path and dependencies, which are resolved the
 * same way, and its extraParams.hxml is applied as haxelib would.
 *
 * resolve(files) returns { bundles, args, main, openfl, diagnostics }: bundles
 * go to the compiler as `libs` (see WORKER_CONTRACT.md), diagnostics point at
 * lines of build.hxml.
 */
(function (global) {
  "use strict";

  var HXML = "build.hxml";
  var VERSION = "6";

  // Dependencies a library has but doesn't declare in haxelib.json: OpenFL
  // names Lime in its include.xml, which only Lime's tools read.
  var IMPLIED = { openfl: ["lime"] };
  // Dependencies with nothing to compile for this target.
  var NOT_NEEDED = { hxargs: true, hxcpp: true, "hxcpp-debug-server": true };
  // Libraries whose presence means an OpenFL app, for callers that need to know
  // before anything is fetched.
  var OPENFL_LIBS = { openfl: true, lime: true, feathersui: true };

  var MAX_FILES = 2500;
  var MAX_BYTES = 24 * 1024 * 1024;
  var CONCURRENCY = 12;
  // Non-Haxe files under a class path that macros may read (includeFile,
  // resources, shaders), fetched when small.
  var RESOURCE = /\.(js|mjs|json|txt|xml|html|css|glsl|vert|frag|csv|md)$/i;
  var MAX_RESOURCE_BYTES = 512 * 1024;

  var TARGET_FLAGS = /^(-js|--js|-cpp|--cpp|-cppia|--cppia|-cs|--cs|-java|--java|--jvm|-python|--python|-lua|--lua|-php|--php|-hl|--hl|-neko|--neko|-swf|--swf|-as3|--as3|--interp|-x|--run|--xml|-xml)$/;
  var IGNORED_FLAGS = /^(--cwd|-C|-cmd|--cmd|-resource|--resource|-r|-v|--verbose|--times|--connect|--wait|--server-listen|--server-connect|--display|--json|--each|--next|-prompt|--prompt|-swf-header|--swf-header|-swf-lib|--swf-lib|--remap|--no-output|--no-traces|--debug-port)$/;

  /* ------------------------------------------------------------------ hxml */

  // One entry per flag, keeping its line for diagnostics. A line holds one flag
  // and its value, as in any hxml file; `#` starts a comment.
  function parseHxml(text) {
    var entries = [];
    String(text || "").split(/\r?\n/).forEach(function (raw, i) {
      var line = raw.replace(/^\s+|\s+$/g, "");
      if (!line || line.charAt(0) === "#") return;
      var m = /^(\S+)\s*(.*)$/.exec(line);
      entries.push({ line: i + 1, flag: m[1], value: m[2].replace(/^(["'])(.*)\1$/, "$2"), text: raw });
    });
    return entries;
  }

  function diag(severity, line, text, message) {
    return { severity: severity, file: HXML, line: line || 1, column: 1,
             endLine: line || 1, endColumn: Math.max(2, (text || "").length + 1), message: message, code: "hxml" };
  }

  function safeRelative(path) {
    path = String(path || "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (!path || /^\//.test(path) || /^[a-zA-Z]:/.test(path) || /(^|\/)\.\.(\/|$)/.test(path)) return null;
    return path;
  }

  // Turns hxml entries into compiler arguments, library requests and a main.
  function interpret(entries, ctx) {
    var out = { args: [], libs: [], main: null, diagnostics: [] };
    entries.forEach(function (e) {
      var f = e.flag, v = e.value;
      if (f === "-lib" || f === "-L" || f === "--library") {
        if (!v) out.diagnostics.push(diag("error", e.line, e.text, f + " needs a library name"));
        else out.libs.push({ value: v, line: e.line, text: e.text });
      } else if (f === "-D" || f === "--define") {
        if (v) out.args.push("-D", v);
      } else if (f === "--macro") {
        if (v) out.args.push("--macro", v);
      } else if (f === "-cp" || f === "-p" || f === "--class-path") {
        var cp = safeRelative(v);
        if (ctx && ctx.inLibrary) out.diagnostics.push(diag("warning", e.line, e.text, "class paths in a library's extraParams.hxml are ignored"));
        else if (cp === null) out.diagnostics.push(diag("error", e.line, e.text, "class paths must be folders inside this project"));
        else out.args.push("-cp", cp);
      } else if (f === "-main" || f === "-m" || f === "--main") {
        if (v) out.main = v;
      } else if (f === "-dce" || f === "--dce") {
        if (/^(no|std|full)$/.test(v)) out.args.push("-dce", v);
        else out.diagnostics.push(diag("error", e.line, e.text, "-dce takes no, std or full"));
      } else if (f === "--no-inline" || f === "--no-opt") {
        out.args.push(f);
      } else if (f === "-debug" || f === "--debug") {
        out.args.push("-debug");
      } else if (TARGET_FLAGS.test(f)) {
        out.diagnostics.push(diag("info", e.line, e.text, "JavaScript is the only target here, so " + f + " is ignored"));
      } else if (IGNORED_FLAGS.test(f)) {
        out.diagnostics.push(diag("warning", e.line, e.text, f + " has no effect here and is ignored"));
      } else if (f.charAt(0) !== "-") {
        out.diagnostics.push(diag("warning", e.line, e.text, "only flags are read from build.hxml; this line is ignored"));
      } else {
        out.diagnostics.push(diag("warning", e.line, e.text, f + " is not supported here and is ignored"));
      }
    });
    return out;
  }

  // name | name:version | name:git:https://github.com/owner/repo[.git][#ref]
  function parseLibSpec(value) {
    var m = /^([A-Za-z0-9_.\-]+)(?::(.*))?$/.exec(String(value).trim());
    if (!m) return { error: "\"" + value + "\" is not a library name" };
    var name = m[1].toLowerCase(), rest = m[2] || "";
    if (!rest) return { name: name };
    if (/^git:/.test(rest)) {
      var url = rest.slice(4), ref = null;
      var hash = url.indexOf("#");
      if (hash >= 0) { ref = url.slice(hash + 1) || null; url = url.slice(0, hash); }
      var g = /^(?:https?:\/\/|git@)?(?:www\.)?github\.com[\/:]([\w.\-]+)\/([\w.\-]+?)(?:\.git)?\/?$/.exec(url);
      if (!g) return { name: name, error: "only GitHub repositories can be fetched here (" + url + ")" };
      return { name: name, git: { owner: g[1], repo: g[2], ref: ref } };
    }
    if (/^(hg|svn|dev):/.test(rest)) return { name: name, error: rest.split(":")[0] + " sources are not supported here; use a GitHub repository" };
    return { name: name, version: rest };
  }

  /* --------------------------------------------------------------- loading */

  var cache = {};
  var indexPromise = null;

  function getJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url.replace(/\?.*$/, "") + ": HTTP " + r.status);
      return r.json();
    });
  }

  function getText(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + ": HTTP " + r.status);
      return r.text();
    });
  }

  function packedIndex() {
    if (!indexPromise) {
      indexPromise = getJson("assets/libs/index.json?v=" + VERSION)
        .catch(function () { indexPromise = null; return {}; });
    }
    return indexPromise;
  }

  function loadPacked(name) {
    var key = "pack:" + name;
    if (!cache[key]) {
      cache[key] = getJson("assets/libs/" + name + ".json?v=" + VERSION).then(function (b) {
        var lib = b.libs[0];
        lib.key = key + "@" + lib.version;
        return lib;
      });
      cache[key].catch(function () { delete cache[key]; });
    }
    return cache[key];
  }

  function pool(items, limit, fn) {
    var i = 0, results = new Array(items.length);
    function next() {
      if (i >= items.length) return Promise.resolve();
      var at = i++;
      return fn(items[at]).then(function (r) { results[at] = r; return next(); });
    }
    var runners = [];
    for (var k = 0; k < Math.min(limit, items.length); k++) runners.push(next());
    return Promise.all(runners).then(function () { return results; });
  }

  function loadGit(name, git) {
    var refs = git.ref ? [git.ref] : ["main", "master"];
    var key = "gh:" + git.owner + "/" + git.repo + "@" + refs.join("|");
    if (cache[key]) return cache[key];

    function listing(ref) {
      return getJson("https://data.jsdelivr.com/v1/packages/gh/" + git.owner + "/" + git.repo + "@" +
                     encodeURIComponent(ref) + "?structure=flat")
        .then(function (l) {
          var sizes = {};
          var names = (l.files || []).map(function (f) {
            var n = f.name.replace(/^\//, "");
            sizes[n] = f.size || 0;
            return n;
          });
          return { ref: ref, files: names, sizes: sizes };
        });
    }
    function firstListing(k) {
      return listing(refs[k]).catch(function (err) {
        if (k + 1 < refs.length) return firstListing(k + 1);
        throw new Error("could not read github.com/" + git.owner + "/" + git.repo +
                        (git.ref ? " at " + git.ref : " (tried main and master; add #tag to pin a version)") +
                        ": " + err.message);
      });
    }

    cache[key] = firstListing(0).then(function (l) {
      var base = "https://cdn.jsdelivr.net/gh/" + git.owner + "/" + git.repo + "@" + l.ref + "/";
      // haxelib.json at the root, or the shallowest one if the repository nests it.
      var metaPath = l.files.filter(function (f) { return /(^|\/)haxelib\.json$/.test(f); })
        .sort(function (a, b) { return a.split("/").length - b.split("/").length; })[0];
      if (!metaPath) throw new Error("github.com/" + git.owner + "/" + git.repo + " has no haxelib.json");
      var root = metaPath.slice(0, metaPath.length - "haxelib.json".length);
      return getJson(base + metaPath).then(function (meta) {
        var cp = String(meta.classPath || "").replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/?$/, "/");
        if (cp === "/") cp = "";
        var prefix = root + cp;
        var sources = l.files.filter(function (f) {
          return f.indexOf(prefix) === 0 &&
                 (/\.hx$/.test(f) || (RESOURCE.test(f) && l.sizes[f] <= MAX_RESOURCE_BYTES));
        });
        if (sources.length > MAX_FILES) throw new Error(name + " has " + sources.length + " source files; the limit here is " + MAX_FILES);
        var extraPath = l.files.indexOf(root + "extraParams.hxml") >= 0 ? root + "extraParams.hxml" : null;
        var license = l.files.filter(function (f) { return f.indexOf(root) === 0 && /^LICEN[CS]E(\.\w+)?$/i.test(f.slice(root.length)); })[0];
        var bytes = 0, files = {};
        return pool(sources, CONCURRENCY, function (f) {
          return getText(base + f).then(function (t) {
            bytes += t.length;
            if (bytes > MAX_BYTES) throw new Error(name + " is larger than " + (MAX_BYTES >> 20) + " MB of source");
            files[f.slice(prefix.length)] = t;
          });
        }).then(function () {
          return Promise.all([
            extraPath ? getText(base + extraPath) : "",
            license ? getText(base + license).catch(function () { return ""; }) : ""
          ]);
        }).then(function (extra) {
          if (license) files[license.slice(root.length)] = extra[1];
          return {
            name: name,
            // jsDelivr serves a repository without its git submodules.
            submodules: l.files.indexOf(".gitmodules") >= 0,
            version: /^\d+\.\d+/.test(meta.version || "") ? meta.version : "0.0.0",
            license: meta.license || "",
            dependencies: meta.dependencies || {},
            extraParams: extra[0],
            source: "github.com/" + git.owner + "/" + git.repo + "@" + l.ref,
            key: "gh:" + git.owner + "/" + git.repo + "@" + l.ref,
            files: files
          };
        });
      });
    });
    cache[key].catch(function () { delete cache[key]; });
    return cache[key];
  }

  /* -------------------------------------------------------------- resolve */

  function sourcesOf(files) {
    return Object.keys(files || {}).filter(function (n) { return /\.hx$/i.test(n); })
      .map(function (n) { return files[n]; }).join("\n");
  }

  // Quick, synchronous: does this project make an OpenFL app? Used to pick how
  // the output is shown before anything has been fetched.
  function declaresOpenFL(files) {
    var hxml = files && files[HXML];
    if (!hxml) return false;
    return interpret(parseHxml(hxml)).libs.some(function (l) {
      var s = parseLibSpec(l.value);
      return s.name && OPENFL_LIBS[s.name];
    });
  }

  function resolve(files, onProgress) {
    files = files || {};
    var top = interpret(parseHxml(files[HXML] || ""));
    var result = { bundles: [], args: top.args, main: top.main, openfl: false, diagnostics: top.diagnostics };

    var requests = top.libs.map(function (l) {
      var s = parseLibSpec(l.value);
      s.line = l.line; s.text = l.text;
      return s;
    });
    // OpenFL, Lime and Feathers UI are used often enough to work from an import
    // alone. Feathers UI brings OpenFL, and OpenFL brings Lime.
    var named = function (n) { return requests.some(function (r) { return r.name === n; }); };
    var src = sourcesOf(files);
    if (!named("feathersui") && /(^|[^\w.])feathers\./.test(src)) {
      requests.push({ name: "feathersui", implicit: true });
    } else if (!named("openfl") && !named("lime") && /(^|[^\w.])(openfl|lime)\./.test(src)) {
      requests.push({ name: "openfl", implicit: true });
    }
    if (!requests.length) return Promise.resolve(result);

    var seen = {}, libs = [];
    return packedIndex().then(function (index) {
      function one(req, from) {
        if (req.error) {
          result.diagnostics.push(diag("error", req.line, req.text, req.error));
          return Promise.resolve();
        }
        if (seen[req.name]) return Promise.resolve();
        seen[req.name] = true;
        if (NOT_NEEDED[req.name]) return Promise.resolve();

        var where = from ? " (needed by " + from.name + ")" : "";
        var line = from ? from.line : req.line, text = from ? from.text : req.text;
        var p;
        if (req.git) {
          p = loadGit(req.name, req.git);
        } else if (index[req.name]) {
          if (req.version && req.version !== index[req.name].version) {
            result.diagnostics.push(diag("warning", line, text, req.name + " " + req.version +
              " is not available here; using " + index[req.name].version));
          }
          p = loadPacked(req.name);
        } else {
          result.diagnostics.push(diag("error", line, text, "no library called " + req.name + " is available here" + where +
            ". Point at its source instead: -lib " + req.name + ":git:https://github.com/<owner>/<repo>#<tag>"));
          return Promise.resolve();
        }
        if (onProgress) onProgress(req.name);
        return p.then(function (lib) {
          if (lib.submodules) {
            result.diagnostics.push(diag("warning", line, text, lib.source + " uses git submodules, which " +
              "can't be fetched here; anything " + lib.name + " needs from them will be missing"));
          }
          if (OPENFL_LIBS[lib.name]) result.openfl = true;
          // A library's extraParams.hxml applies wherever it is used, as with haxelib.
          if (lib.extraParams) {
            var x = interpret(parseHxml(lib.extraParams), { inLibrary: true });
            lib.args = x.args;
          }
          var parent = { name: lib.name, line: line, text: text };
          var deps = Object.keys(lib.dependencies || {}).map(function (dep) {
            var v = String(lib.dependencies[dep] || "");
            return parseLibSpec(dep.toLowerCase() + (/^git:/.test(v) ? ":" + v : ""));
          }).concat((IMPLIED[lib.name] || []).map(function (n) { return { name: n }; }));
          // Dependencies go first, as haxelib orders them: their class paths and
          // init macros come before the library that needs them.
          return deps.reduce(function (chain, spec) {
            spec.line = line; spec.text = text;
            return chain.then(function () { return one(spec, parent); });
          }, Promise.resolve()).then(function () { libs.push(lib); });
        }, function (err) {
          result.diagnostics.push(diag("error", line, text, "could not load " + req.name + where + ": " + err.message));
        });
      }
      return requests.reduce(function (chain, req) {
        return chain.then(function () { return one(req, null); });
      }, Promise.resolve());
    }).then(function () {
      // One bundle per library keeps each one writable by itself in the compiler.
      result.bundles = libs.map(function (lib) { return { libs: [lib] }; });
      return result;
    });
  }

  global.HxrLibs = {
    HXML: HXML,
    parseHxml: parseHxml,
    parseLibSpec: parseLibSpec,
    declaresOpenFL: declaresOpenFL,
    resolve: resolve
  };
})(this);
