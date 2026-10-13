/*
 * hxc-assets.js -- fetches and compiles the compiler's binaries exactly once.
 *
 * Previously each hxc instance let emscripten fetch hxc.wasm and hxc.data
 * itself, so standing up a second instance (a main-thread fallback, or a fresh
 * Worker after a failed compile) meant another 36 MB of download and another
 * 21 MB wasm compile. Doing it here instead means:
 *
 *   - the WebAssembly.Module is compiled once and structured-cloned into any
 *     Worker, so respawning one costs an instantiate rather than a compile;
 *   - hxc.data is fetched once and handed over via getPreloadedPackage;
 *   - boot progress covers both files instead of just the data package.
 *
 * The ArrayBuffer is cloned (never transferred) into Workers, so it stays
 * usable here for the next instance.
 */
(function (global) {
  "use strict";

  var WASM_URL = "assets/hxc.wasm";
  var DATA_URL = "assets/hxc.data";

  var cached = null;

  // Streams a response, reporting bytes as they arrive. Falls back to a plain
  // arrayBuffer() read when the body isn't streamable or has no length.
  function fetchWithProgress(url, onBytes) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error(url + ": HTTP " + res.status);
      var total = +(res.headers.get("content-length") || 0);
      if (!res.body || !res.body.getReader) {
        return res.arrayBuffer().then(function (b) { onBytes(b.byteLength, b.byteLength); return b; });
      }
      var reader = res.body.getReader();
      var chunks = [], loaded = 0;
      return (function pump() {
        return reader.read().then(function (r) {
          if (r.done) {
            var buf = new Uint8Array(loaded), at = 0;
            chunks.forEach(function (c) { buf.set(c, at); at += c.length; });
            return buf.buffer;
          }
          chunks.push(r.value);
          loaded += r.value.length;
          onBytes(loaded, total);
          return pump();
        });
      })();
    });
  }

  function load(onProgress) {
    if (cached) return cached;

    var wasmLoaded = 0, wasmTotal = 0, dataLoaded = 0, dataTotal = 0;
    function report(phase) {
      if (!onProgress) return;
      onProgress({
        phase: phase,
        loaded: wasmLoaded + dataLoaded,
        total: (wasmTotal + dataTotal) || 0
      });
    }

    cached = Promise.all([
      fetchWithProgress(WASM_URL, function (l, t) {
        wasmLoaded = l; wasmTotal = t; report("downloading");
      }).then(function (buf) {
        report("compiling");
        return WebAssembly.compile(buf);
      }),
      fetchWithProgress(DATA_URL, function (l, t) {
        dataLoaded = l; dataTotal = t; report("downloading");
      })
    ]).then(function (parts) {
      report("instantiating");
      return { wasmModule: parts[0], data: parts[1] };
    }).catch(function (err) {
      cached = null;   // let a retry re-attempt the download
      throw err;
    });

    return cached;
  }

  global.HxcAssets = { load: load };
})(this);
