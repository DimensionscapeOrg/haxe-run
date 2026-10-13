# haxe.run for programs and agents

haxe.run compiles and runs Haxe in the browser tab, with no build server. The
editor is one consumer of that capability; `window.haxeRun` is the other. This
document is the reference for driving it from code.

The API also describes itself at runtime. `haxeRun.help()` returns a printable
summary and `haxeRun.schema()` returns the same reference as structured data, so
a caller that arrives without this document can still discover the contract.

## Contract

`window.haxeRun` is stable. Anything else on the page (including
`window.__hxrInternal`) is private and will change.

Version with `haxeRun.version`; the current contract is `"1.0"`.

## Getting ready

```js
const info = await haxeRun.ready();
// { version: "1.0", compiler: "hxc", language: "Haxe 4.3", targets: ["js"] }
```

The compiler is about 8 MB compressed (35 MB unpacked) and takes a few seconds to
download and instantiate on first load; it is cached afterwards. `ready()`
resolves when it can accept work, and is safe to call any number of times. Every other method awaits it internally, so
calling `compile()` immediately also works; `ready()` just lets you observe the
boot separately.

## compile

```js
const result = await haxeRun.compile({
  files: {
    "Main.hx": "class Main { static function main() { trace(Greeter.hello()); } }",
    "Greeter.hx": "class Greeter { public static function hello() return 'hi'; }"
  }
  // main:    "Main"     optional, inferred
  // target:  "js"       optional, default
  // options: { ... }    optional, see below
});
```

Returns:

| field | meaning |
|---|---|
| `ok` | `false` if any diagnostic is an error |
| `outputs` | `{ path: source }` of generated code, `{}` when `ok` is false |
| `diagnostics` | every diagnostic, structured |
| `errors` / `warnings` | the same list, pre-filtered |
| `runnable` | whether `run()` could execute this output |
| `timeMs` | compile duration |
| `stats`, `log` | compiler accounting and raw output, may be absent |

`compile()` is stateless. It does not read or modify what is open in the editor,
so it is safe to call while a human is using the page.

## run

```js
const r = await haxeRun.run({
  files: { "Main.hx": src }
  // options, main as above
  // timeoutMs: 5000   hard cap
  // quietMs:   250    resolve after this much silence
});

r.stdout;   // "Main.hx:3: hello"
r.output;   // [{ level: "log" | "warn" | "error", text }]
r.ok;       // compiled and produced no runtime errors
```

`run()` compiles to JavaScript and executes it in a hidden sandboxed iframe,
capturing everything the program prints. This is the whole generate → compile →
observe loop in one call.

Because a program may render forever (an OpenFL app, an animation loop), `run()`
resolves when output goes quiet for `quietMs`, or at `timeoutMs`, whichever comes
first, and reports `timedOut` accordingly. Whatever was captured up to that point
is returned.

If compilation fails, `run()` resolves with `compiled: false` and the diagnostics;
it does not throw.

## Diagnostics

```js
{
  severity: "error",       // "error" | "warning" | "info"
  file: "Main.hx",         // matches a key in the files you passed
  line: 3, column: 25,     // both 1-based
  endLine: 3, endColumn: 37,
  message: "String should be Int"
}
```

Positions are 1-based line and column, not byte offsets, and `file` always
matches a key you supplied, so a diagnostic can be mapped back to a source range
without guessing.

## Options

```js
{
  dce: "std",          // "no" | "std" | "full"
  analyzer: true,
  debug: false,        // -debug
  noInline: false,     // --no-inline
  noOpt: false,        // --no-opt
  nullSafety: false,
  defines: { my_flag: true, level: "3" }
}
```

Anything you omit keeps its default.

## Files and packages

`files` maps path to source. Subdirectories are package paths:

```js
{
  "Main.hx":        "import geom.Shape; class Main { ... }",
  "geom/Shape.hx":  "package geom; class Shape { ... }"
}
```

The entry point is inferred as the module declaring `static function main`,
preferring `Main.hx`. Pass `main` (a dotted type path, e.g. `"pkg.Main"`) to
override.

## OpenFL

Importing anything from `openfl.*` switches the build to an OpenFL/Lime html5
application automatically; the `ApplicationMain` bootstrap is injected for you.
Two consequences worth planning for:

- An OpenFL project has no `static function main`. It is a `Sprite` subclass, and
  the class is instantiated as the document class.
- These compiles are much slower than plain Haxe, because the whole framework is
  typed from source. Raise `timeoutMs` accordingly.

OpenFL renders to a canvas, so `run()` will usually return only whatever the
program `trace`s, not a picture. To see it rendered, drive the visible editor
instead (below).

## Driving the visible editor

Use these when you want a human to see the result, rather than just consuming it.

```js
haxeRun.editor.setFiles({ "Main.hx": src });  // replaces what is open
await haxeRun.editor.run();                   // renders to the preview surface

haxeRun.editor.samples();                     // [{ id, name, files }]
haxeRun.editor.load("shapes");                // load a built-in sample
haxeRun.editor.getFiles();
haxeRun.editor.open("geom/Shape.hx");
haxeRun.editor.getOptions();
haxeRun.editor.setOptions({ dce: "full" });
```

## A repair loop

The pattern this API exists to support:

```js
let src = generateHaxe(task);

for (let attempt = 0; attempt < 3; attempt++) {
  const r = await haxeRun.run({ files: { "Main.hx": src } });

  if (r.ok) return { src, output: r.stdout };

  // errors are structured: file, line, column, message
  src = await repair(src, r.errors.length ? r.errors : r.runtimeErrors);
}
```

## Opening code by link

The playground can be opened on specific code with a URL fragment. Fragments are
never sent to the server, so shared code stays between the people holding the
link. All four forms work on a static host.

| Form | Meaning |
|---|---|
| `#p=shapes` | a built-in example, by id |
| `#src=<url>` | fetch a `.hx` file and open it |
| `#src=<url.json>` | fetch a multi-file project: `{ "name": "...", "files": { path: source } }` |
| `#z=…` | a whole project packed into the link (what Share produces) |

`#src` requires https (or localhost) and a source that permits cross-origin
reads. `raw.githubusercontent.com` and gist raw URLs both do, so a repository can
stay the source of truth and link to the playground rather than copying code
into it:

```
https://haxe.run/#src=https://raw.githubusercontent.com/you/repo/main/Source/Main.hx
```

Single-file URLs only carry one module. A sample that spans several files needs
the `.json` manifest form, or it will fail with "Type not found" for its
siblings.

Nothing fetched is executed until Run is pressed.

## Notes and limits

- Everything runs in the visitor's tab. Nothing is uploaded, and there is no rate
  limit, quota, or API key.
- `js` is the only target that can be executed here. hxc supports others, but
  this page cannot run their output.
- Compiles are serialized; overlapping calls queue rather than run in parallel.
- Very large output (an OpenFL build is a few megabytes) is returned in full but
  not syntax-highlighted in the UI.
- Each compile sees exactly the files you pass. Nothing carries over from earlier
  calls, so a module you leave out is gone, not cached.

## Discovery

- `/llms.txt` — short machine-readable summary of this site
- `/AGENTS.md` — this document
- `haxeRun.schema()` — the same reference as structured data, at runtime
- `<meta name="ai-api">` in the page head points here
