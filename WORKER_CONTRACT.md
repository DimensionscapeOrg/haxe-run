# haxe.run compiler worker contract

The front end (`assets/app.js`) talks to the compiler through a Web Worker at
`assets/hxc-worker.js`. It knows nothing else about the compiler. Any worker
that honors the messages below drops in with no UI changes. The reference stub
is `assets/compiler-stub.js`.

## Who owns what

- `assets/hxc-core.js` is the engine: arg building, the emscripten instance,
  diagnostics parsing, stack accounting. It runs unchanged in either scope.
- `assets/hxc-worker.js` and `assets/hxc-mainthread.js` are thin adapters over
  it. (They used to be two copies of the whole engine, and had already drifted.)
- `assets/hxc-assets.js` downloads `hxc.wasm`/`hxc.data` once and compiles the
  `WebAssembly.Module` once. `app.js` owns the result and hands it to every
  instance it creates, so standing up a second one costs an instantiate rather
  than another 36 MB.

## Why there are two threads

A Worker gets roughly half the main thread's native call stack: measured in
Chrome here, **6,355 frames in a Worker vs 12,453 on the main thread**. It is
fixed when the thread is created and there is no web API to change it. hxc's
parser and typer recurse deeply enough that some inputs (deeply nested
expressions, for one) overflow in a Worker and compile fine on the main thread.

So: compiles run in the Worker, which keeps the UI responsive and makes a hung
compile recoverable. The rare compile that exhausts the Worker's stack is
re-run once on the main thread, which freezes the UI for its duration but
answers. If the main thread fails too, the user gets a normal diagnostic.

Note this is **not** the 64 MB shadow stack in linear memory (`__stack_pointer`
starts at 68,762,640; static data ends at 1,623,250). That one is identical on
both threads and can never explain a Worker-only failure.

## Boot handshake

Boot is driven by the page, because the page owns the binaries:

```
page -> worker   { kind: "init", wasmModule, data }
```

`wasmModule` is an already-compiled `WebAssembly.Module` and `data` is the
`hxc.data` ArrayBuffer. Both are structured-**cloned**, never transferred, so
the page can reuse them for the next instance.

The worker MUST post, unprompted, once it can answer requests:
```
{ ready: true }
```

Optionally, before ready, it MAY post progress so the overlay isn't a blank spinner:
```
{ phase: "downloading", loaded: 12000000, total: 21000000 }   // bytes -> progress bar
{ phase: "instantiating" }                                     // no total -> indeterminate
{ note: "loading standard library" }                          // free-text status line
```

If initialization fails unrecoverably:
```
{ fatal: "message shown to the user" }
```

Notes:
- Send `{ ready: true }` exactly once. Extra ones are ignored.
- The front end has a 60s boot timeout; if no `ready` arrives it shows a reload prompt.
- Each request also has a 45s response timeout, after which the UI reports "timed out"
  rather than hanging. Long first compiles (cold caches) should still finish well under that.
- The reference stub posts `{ ready: true }` immediately on load, so the same gate
  works for both the stub and the real worker.

## Transport

- The worker is created with `new Worker("assets/compiler.js")` (classic worker).
  If hxc-on-JS needs ES modules, create it with `{ type: "module" }` and update
  that one line in `app.js`.
- Communication is `postMessage` both directions.
- **Every request carries a unique `id`; every response must echo the same `id`.**
  The front end matches responses to requests by `id` and ignores unmatched ones.
- Requests may arrive faster than they complete (one per keystroke for completion).
  Out-of-order responses are fine because of `id`. If you can cancel superseded
  work, do; if not, just answer them all.

## Requests the front end sends

### compile
```
{ id, kind: "compile",
  files:  { "Main.hx": "...", "geom/Shape.hx": "..." },  // all modules, path -> source
  main:   "Main",            // dotted entry type, e.g. "Main" or "pkg.Main"
  target: "js",              // js | cpp | wasm | python | php | cs | jvm | hxia
  options: {
    dce: "std",              // "no" | "std" | "full"
    analyzer: true,          // bool
    debug: false,            // bool  (-debug)
    noInline: false,         // bool  (--no-inline)
    noOpt: false,            // bool  (--no-opt)
    nullSafety: false,       // bool
    defines: { my_flag: true, level: "3" }   // name -> true | string
  }
}
```

Expected response:
```
{ id,
  ok: true,                              // false if any diagnostic is severity "error"
  outputs: { "Main.js": "..." },         // path -> generated source; {} when !ok
  diagnostics: [ Diag, ... ],            // may be empty
  runnable: true,                        // may the front end execute this? (JS target, ok)
  timeMs: 42,                            // number, for the status line
  log: [ { level, text }, ... ],         // optional; shown in the Log tab
  stats: {                               // optional; shown in the Log tab footer
    modules: 3, types: 4, fieldsRemoved: 6,
    phases: { parse: 4, type: 9, filter: 4, generate: 3 }  // ms
  }
}
```

`log[].level` is one of `"info" | "trace" | "warn" | "error"`.

Every compile response also carries a `stack` block, which is how the
accounting below is observable at all:
```
stack: { top: 68762640, before: ..., after: ..., leaked: ..., used: ... }
```

### Instead of a compile response: retry

If the compile died because the thread ran out of call stack, answer with this
rather than a failed compile. The front end re-sends the identical request to
the main-thread engine under the same `id`, and the original promise resolves
once, from whichever engine answers.
```
{ id, retry: "native", stack, timeMs }
```
`retry: "trap"` reports a wasm fault instead. Both are re-tried; only "native"
is expected to succeed.

### Unprompted: recycle

```
{ recycle: true, reason: "native" | "trap" | "leak" }
```

Means: this instance is spent, replace me. The front end terminates the worker,
spawns a fresh one from the cached module, and re-queues anything the old one
still owed.

This exists because of a build limitation. `stackSave`/`stackRestore` were never
exported from the wasm, so emscripten's `callMain` cannot restore the stack
pointer. A clean compile therefore leaks about 1 KB permanently (the argv
allocation), and **a compile that dies mid-recursion leaks however deep it got:
2.06 MB was measured for a single failed compile.** Against a 64 MB shadow stack
that is roughly 30 failures before it is gone, and since the build has no
`STACK_OVERFLOW_CHECK`, exhausting it corrupts static data silently rather than
trapping. Recycling keeps the leak bounded to one compile.

The proper fix is a rebuild: export `stackSave`/`stackRestore` and wrap
`callMain` in save/restore. See "Rebuild wishlist" below.

### complete
```
{ id, kind: "complete", files, file: "Main.hx", offset: 123 }   // offset is char index into `file`
```
```
{ id, items: [ { label, kind, detail, doc, insert }, ... ] }
```
`kind` is one of `"keyword" | "function" | "class" | "field" | "variable" | "module"`
(anything else maps to a plain text item). `insert` defaults to `label`.

### hover
```
{ id, kind: "hover", files, file, offset }
```
```
{ id, value: "markdown string" | null }
```

### signature
```
{ id, kind: "signature", files, file, offset }
```
```
{ id, label: "trace(v:Dynamic, ?infos:PosInfos):Void",
      params: ["v:Dynamic", "?infos:PosInfos"], activeParam: 0 }
```

## The Diag shape

```
{ severity: "error" | "warning" | "info",
  file:    "Main.hx",   // must match a key in files; routes the marker to the right editor
  line:    3,           // 1-based
  column:  9,           // 1-based
  endLine: 3,           // optional; defaults to line
  endColumn: 21,        // optional; defaults to column + 1
  message: "String should be Int",
  code:    "unify"      // optional short slug
}
```

Positions are 1-based line/column (not byte offsets). If hxc reports byte offsets,
convert before sending. `file` must exactly equal the `files` key so the marker
lands in the correct module.

## Notes for the real compiler

- **Warm state.** Completion/hover fire on nearly every keystroke. Keep a
  persistent compiler context and invalidate incrementally rather than cold-starting.
- **Std library.** The worker owns the standard library; the front end never sends it.
  Preload it into your virtual filesystem, keyed so `files` (the user modules) layer on top.
- **`runnable`.** Only the JS target output is executed, in a sandboxed iframe. Return
  `runnable: true` only for a JS target that compiled cleanly. Other targets show source only.
- **Non-JS run.** When the wasm target lands, we can add a `run` capability; until then
  leave `runnable` false for everything but JS.
- **Errors vs throw.** Report compile errors as `diagnostics`, not by rejecting. A thrown
  worker error surfaces as an unhandled rejection and the UI will look hung.
- **Big payloads.** `files` values can be large; avoid copying them per keystroke inside
  the worker if you can hold the models.

## Rebuild wishlist

Three link-time changes would let most of the machinery above be deleted. None
of them need compiler source changes.

1. **`-sEXPORTED_RUNTIME_METHODS=[...,'stackSave','stackRestore']`**, then wrap
   the call in `hxc-core.js`:
   ```js
   var sp = m.stackSave();
   try { m.callMain(args); } finally { m.stackRestore(sp); }
   ```
   This ends the leak and makes the whole `recycle` path unnecessary. The
   binary currently exports only `_emscripten_stack_alloc`, which is why the
   engine can read the stack pointer but not put it back.

2. **`--profiling-funcs`** (or `-g2`) to keep the wasm name section. The binary
   is stripped today, so a `RangeError` carries a stack trace with no function
   names, and there is no way to see *which* hxc recursion is deep. With names,
   one failure names the culprit. Set `Error.stackTraceLimit` high and read
   `stackHead` off the compile result.

3. **Check the hxcpp build is release.** If `HXCPP_DEBUG` / `HXCPP_STACK_TRACE`
   / `HXCPP_STACK_LINE` are on, every Haxe function carries stack-frame
   bookkeeping locals, which inflates native frame size and so divides the
   maximum recursion depth. That alone could account for the entire Worker
   deficit. (Exceptions are already the efficient kind: the binary has a wasm
   `tag` section and no `invoke_*` trampolines, so `-fwasm-exceptions` is in
   use. Nothing to do there.)

Longer term, on the hxc side: make module loading an explicit worklist rather
than recursion, and add a depth guard that emits a normal diagnostic instead of
letting the engine raise `RangeError`.

## Swapping the stub for the real compiler

`?worker=stub` in the URL loads `assets/compiler-stub.js` instead of the wasm
compiler, so the front end can be worked on in isolation.
Keep `compiler-stub.js` in the repo as the offline/dev fallback and as the living
description of this contract.
