/*
 * hxc-mainthread.js -- runs the hxc WebAssembly compiler on the MAIN THREAD.
 *
 * Thin adapter over hxc-core.js, exposing the same Worker-shaped interface
 * app.js speaks (postMessage in, onmessage out, plus a one-time { ready: true }):
 *
 *     var fallback = new HxcMainThread({ wasmModule, data });
 *
 * This is no longer the primary compiler. It exists as the fallback for the one
 * case a Worker genuinely cannot handle: a compile that exhausts the Worker's
 * native call stack, which is about half the main thread's (6,355 vs 12,453
 * frames measured here) and is not configurable from a page. Those compiles
 * freeze the UI for their duration, which is the price of answering at all.
 *
 * It reuses the WebAssembly.Module the page already compiled, so standing this
 * up costs an instantiate rather than another 36 MB download.
 */
(function (global) {
  "use strict";

  // Loads assets/hxc.js (which defines the global factory createHxc) once.
  var scriptPromise = null;
  function loadScript() {
    if (scriptPromise) return scriptPromise;
    scriptPromise = new Promise(function (resolve, reject) {
      if (global.createHxc) return resolve();
      var s = document.createElement("script");
      s.src = "assets/hxc.js";
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error("failed to load assets/hxc.js")); };
      document.head.appendChild(s);
    });
    return scriptPromise;
  }

  function HxcMainThread(assets) {
    var self = this;
    this.onmessage = null;
    this.onerror = null;
    this._engine = null;
    this._pending = [];

    loadScript().then(function () {
      self._engine = new HxcCore.Engine({
        wasmModule: assets.wasmModule,
        data: assets.data,
        locateFile: function (p) { return "assets/" + p; },
        emit: function (data) { self._emit(data); }
      });
      var q = self._pending;
      self._pending = [];
      q.forEach(function (m) { self._engine.handle(m); });
    }).catch(function (err) {
      self._emit({ fatal: "compiler failed to start: " + (err && err.message || err) });
    });
  }

  HxcMainThread.prototype._emit = function (data) {
    if (this.onmessage) this.onmessage({ data: data });
  };

  HxcMainThread.prototype.terminate = function () { /* nothing to tear down */ };

  HxcMainThread.prototype.postMessage = function (msg) {
    if (this._engine) this._engine.handle(msg || {});
    else this._pending.push(msg || {});
  };

  global.HxcMainThread = HxcMainThread;
})(this);
