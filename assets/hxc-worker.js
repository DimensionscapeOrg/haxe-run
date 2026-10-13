/*
 * hxc-worker.js -- runs the hxc WebAssembly compiler inside a Web Worker.
 *
 * Thin adapter over hxc-core.js, which holds all the actual compiler logic and
 * is shared with the main-thread adapter.
 *
 * The Worker is where compiles belong: the main thread stays free, so the UI
 * never freezes mid-compile and a wedged compile can be recovered by
 * terminating the Worker. The catch is that a Worker gets roughly half the main
 * thread's native call stack (6,355 vs 12,453 frames measured here), and hxc's
 * typer recurses deeply enough that some inputs overflow here and not there.
 * When that happens this adapter reports `retry: "native"` instead of an error,
 * and app.js re-runs that one compile on the main thread.
 *
 * Boot is driven by the page: it sends { kind: "init", wasmModule, data } with
 * an already-compiled WebAssembly.Module, so respawning after a failure does
 * not re-download or re-compile 21 MB. See WORKER_CONTRACT.md.
 */

// Carry this worker's ?v= through, so a deploy never pairs a fresh worker
// with a cached engine.
importScripts("hxc.js", "openfl-boot.js", "hxc-core.js" + self.location.search);

var engine = null;

// Sits between the engine and the page. A compile that died on the call stack
// is turned into a retry request rather than an error, because the main thread
// has roughly twice the budget and will very likely succeed. Either way the
// instance is now poisoned: this build never exported stackRestore, so
// emscripten's callMain cannot put the stack pointer back after an abnormal
// unwind, and the leak is permanent. Ask the page to recycle us.
function emit(data) {
  if (data && data.failure) {
    self.postMessage({ id: data.id, retry: data.failure,
                       stack: data.stack, timeMs: data.timeMs,
                       threwMessage: data.threwMessage, threwName: data.threwName,
                       stackHead: data.stackHead, argsUsed: data.argsUsed,
                       log: data.log });
    self.postMessage({ recycle: true, reason: data.failure });
    return;
  }
  self.postMessage(data);
  if (data && data.poisoned) {
    self.postMessage({ recycle: true, reason: "leak" });
  }
}

self.onmessage = function (e) {
  var msg = e.data || {};

  if (msg.kind === "init") {
    if (engine) return;
    self.postMessage({ phase: "instantiating" });
    engine = new HxcCore.Engine({
      wasmModule: msg.wasmModule,
      data: msg.data,
      locateFile: function (p) { return p; },   // resolves next to this worker
      emit: emit
    });
    return;
  }

  if (!engine) {
    self.postMessage({ id: msg.id, error: "compiler not initialised" });
    return;
  }

  engine.handle(msg);
};
