// Generated from the verified OpenFL bootstrap. hxc writes this into /work
// when a project imports openfl, standing in for the ApplicationMain that
// lime tooling would normally generate from assets/templates/haxe.
// ::MAIN:: is replaced with the project's entry class.
self.HXR_OPENFL_BOOT = "package;\n\n#if macro\nimport haxe.macro.Compiler;\nimport haxe.macro.Context;\nimport haxe.macro.Expr;\n#end\n\n// Minimal hand-filled version of openfl's assets/templates/haxe/ApplicationMain.hx.\n// The stock template is processed by lime's tooling to substitute ::VARS::; this\n// version hard-codes the playground's values so a plain\n//   haxe -main ApplicationMain -js out.js -lib openfl -lib lime -D html5\n// works without a project.xml.\n@:access(lime.app.Application)\n@:access(lime.system.System)\n@:access(openfl.display.Stage)\n@:access(openfl.events.UncaughtErrorEvents)\n@:dox(hide)\nclass ApplicationMain\n{\n\t#if !macro\n\tpublic static function main()\n\t{\n\t\tlime.system.System.__registerEntryPoint(\"HaxeRun\", create);\n\t\t#if (js && html5)\n\t\t// self-start: attach to the document body at the preview size\n\t\tlime.system.System.embed(\"HaxeRun\", \"openfl-content\", 0, 0);\n\t\t#else\n\t\tcreate(null);\n\t\t#end\n\t}\n\n\tpublic static function create(config):Void\n\t{\n\t\tvar app = new openfl.display.Application();\n\n\t\t#if !disable_preloader_assets\n\t\tManifestResources.init(config);\n\t\t#end\n\n\t\tapp.meta[\"build\"] = \"1\";\n\t\tapp.meta[\"company\"] = \"haxe.run\";\n\t\tapp.meta[\"file\"] = \"HaxeRun\";\n\t\tapp.meta[\"name\"] = \"haxe.run\";\n\t\tapp.meta[\"packageName\"] = \"run.haxe\";\n\t\tapp.meta[\"version\"] = \"1.0.0\";\n\n\t\tvar attributes:lime.ui.WindowAttributes = {\n\t\t\tallowHighDPI: true,\n\t\t\talwaysOnTop: false,\n\t\t\tborderless: false,\n\t\t\telement: null,\n\t\t\tframeRate: 60,\n\t\t\theight: 600,\n\t\t\thidden: false,\n\t\t\tmaximized: false,\n\t\t\tminimized: false,\n\t\t\tparameters: {},\n\t\t\tresizable: true,\n\t\t\ttitle: \"haxe.run\",\n\t\t\twidth: 800,\n\t\t\tx: null,\n\t\t\ty: null,\n\t\t};\n\n\t\tattributes.context = {\n\t\t\tantialiasing: 0,\n\t\t\tbackground: 0x000000,\n\t\t\tcolorDepth: 32,\n\t\t\tdepth: true,\n\t\t\thardware: false,\n\t\t\tstencil: true,\n\t\t\ttype: null,\n\t\t\tvsync: false\n\t\t};\n\n\t\tif (app.window == null && config != null)\n\t\t{\n\t\t\tfor (field in Reflect.fields(config))\n\t\t\t{\n\t\t\t\tif (Reflect.hasField(attributes, field))\n\t\t\t\t{\n\t\t\t\t\tReflect.setField(attributes, field, Reflect.field(config, field));\n\t\t\t\t}\n\t\t\t\telse if (Reflect.hasField(attributes.context, field))\n\t\t\t\t{\n\t\t\t\t\tReflect.setField(attributes.context, field, Reflect.field(config, field));\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\n\t\tapp.createWindow(attributes);\n\n\t\tvar preloader = getPreloader();\n\t\tapp.preloader.onProgress.add(function(loaded, total)\n\t\t{\n\t\t\t@:privateAccess preloader.update(loaded, total);\n\t\t});\n\t\tapp.preloader.onComplete.add(function()\n\t\t{\n\t\t\t@:privateAccess preloader.start();\n\t\t});\n\n\t\tpreloader.onComplete.add(start.bind((cast app.window : openfl.display.Window).stage));\n\n\t\t#if !disable_preloader_assets\n\t\tfor (library in ManifestResources.preloadLibraries)\n\t\t{\n\t\t\tapp.preloader.addLibrary(library);\n\t\t}\n\n\t\tfor (name in ManifestResources.preloadLibraryNames)\n\t\t{\n\t\t\tapp.preloader.addLibraryName(name);\n\t\t}\n\t\t#end\n\n\t\tapp.preloader.load();\n\n\t\tapp.exec();\n\t}\n\n\tpublic static function start(stage:openfl.display.Stage):Void\n\t{\n\t\tif (stage.__uncaughtErrorEvents.__enabled)\n\t\t{\n\t\t\ttry\n\t\t\t{\n\t\t\t\tApplicationMain.getEntryPoint();\n\t\t\t\tstage.dispatchEvent(new openfl.events.Event(openfl.events.Event.RESIZE, false, false));\n\t\t\t}\n\t\t\tcatch (e:Dynamic)\n\t\t\t{\n\t\t\t\t#if !display\n\t\t\t\tstage.__handleError(e);\n\t\t\t\t#end\n\t\t\t}\n\t\t}\n\t\telse\n\t\t{\n\t\t\tApplicationMain.getEntryPoint();\n\t\t\tstage.dispatchEvent(new openfl.events.Event(openfl.events.Event.RESIZE, false, false));\n\t\t}\n\t}\n\t#end\n\n\tmacro public static function getEntryPoint()\n\t{\n\t\tvar hasMain = false;\n\n\t\tswitch (Context.follow(Context.getType(\"::MAIN::\")))\n\t\t{\n\t\t\tcase TInst(t, params):\n\t\t\t\tvar type = t.get();\n\t\t\t\tfor (method in type.statics.get())\n\t\t\t\t{\n\t\t\t\t\tif (method.name == \"main\")\n\t\t\t\t\t{\n\t\t\t\t\t\thasMain = true;\n\t\t\t\t\t\tbreak;\n\t\t\t\t\t}\n\t\t\t\t}\n\n\t\t\t\tif (hasMain)\n\t\t\t\t{\n\t\t\t\t\treturn Context.parse(\"@:privateAccess ::MAIN::.main()\", Context.currentPos());\n\t\t\t\t}\n\t\t\t\telse if (type.constructor != null)\n\t\t\t\t{\n\t\t\t\t\treturn macro\n\t\t\t\t\t{\n\t\t\t\t\t\tvar current = stage.getChildAt(0);\n\n\t\t\t\t\t\tif (current == null || !(current is openfl.display.DisplayObjectContainer))\n\t\t\t\t\t\t{\n\t\t\t\t\t\t\tcurrent = new openfl.display.MovieClip();\n\t\t\t\t\t\t\tstage.addChild(current);\n\t\t\t\t\t\t}\n\n\t\t\t\t\t\tnew DocumentClass(cast current);\n\t\t\t\t\t};\n\t\t\t\t}\n\t\t\t\telse\n\t\t\t\t{\n\t\t\t\t\tContext.fatalError(\"Main class \\\"::MAIN::\\\" has neither a static main nor a constructor.\", Context.currentPos());\n\t\t\t\t}\n\n\t\t\tdefault:\n\t\t\t\tContext.fatalError(\"Main class \\\"::MAIN::\\\" isn't a class.\", Context.currentPos());\n\t\t}\n\n\t\treturn null;\n\t}\n\n\tmacro public static function getPreloader()\n\t{\n\t\treturn macro\n\t\t{\n\t\t\tnew openfl.display.Preloader(new openfl.display.Preloader.DefaultPreloader());\n\t\t};\n\t}\n\n\t#if !macro\n\t@:noCompletion @:dox(hide) public static function __init__()\n\t{\n\t\tvar init = lime.app.Application;\n\t}\n\t#end\n}\n\n#if !macro\n@:build(DocumentClass.build())\n@:keep @:dox(hide) class DocumentClass extends ::MAIN:: {}\n#else\nclass DocumentClass\n{\n\tmacro public static function build():Array<Field>\n\t{\n\t\tvar classType = Context.getLocalClass().get();\n\t\tvar searchTypes = classType;\n\n\t\twhile (searchTypes != null)\n\t\t{\n\t\t\tif (searchTypes.module == \"openfl.display.DisplayObject\" || searchTypes.module == \"flash.display.DisplayObject\")\n\t\t\t{\n\t\t\t\tvar fields = Context.getBuildFields();\n\n\t\t\t\tvar method = macro\n\t\t\t\t{\n\t\t\t\t\tcurrent.addChild(this);\n\t\t\t\t\tsuper();\n\t\t\t\t\tdispatchEvent(new openfl.events.Event(openfl.events.Event.ADDED_TO_STAGE, false, false));\n\t\t\t\t}\n\n\t\t\t\tfields.push({\n\t\t\t\t\tname: \"new\",\n\t\t\t\t\taccess: [APublic],\n\t\t\t\t\tkind: FFun({\n\t\t\t\t\t\targs: [{name: \"current\", opt: false, type: macro :openfl.display.DisplayObjectContainer, value: null}],\n\t\t\t\t\t\texpr: method,\n\t\t\t\t\t\tparams: [],\n\t\t\t\t\t\tret: macro :Void\n\t\t\t\t\t}),\n\t\t\t\t\tpos: Context.currentPos()\n\t\t\t\t});\n\n\t\t\t\treturn fields;\n\t\t\t}\n\n\t\t\tif (searchTypes.superClass != null)\n\t\t\t{\n\t\t\t\tsearchTypes = searchTypes.superClass.t.get();\n\t\t\t}\n\t\t\telse\n\t\t\t{\n\t\t\t\tsearchTypes = null;\n\t\t\t}\n\t\t}\n\n\t\treturn null;\n\t}\n}\n#end\n";

// A project's assets.json stands in for the <assets> of a project.xml: asset
// ids mapped to URLs. From it this builds what lime's tools would generate, a
// ManifestResources class that registers the default asset library for the
// preloader, plus a class and an @font-face rule per font. A relative URL
// resolves against the page, since the preview frame shares its base URL.
self.HXR_OPENFL_ASSETS = (function () {
  var FILE = "assets.json";
  var TYPES = {
    png: "IMAGE", jpg: "IMAGE", jpeg: "IMAGE", gif: "IMAGE", webp: "IMAGE", bmp: "IMAGE", svg: "TEXT",
    mp3: "SOUND", ogg: "SOUND", wav: "SOUND", m4a: "SOUND", aac: "SOUND",
    ttf: "FONT", otf: "FONT", woff: "FONT", woff2: "FONT",
    txt: "TEXT", json: "TEXT", xml: "TEXT", csv: "TEXT", html: "TEXT", glsl: "TEXT", frag: "TEXT", vert: "TEXT"
  };
  var KNOWN = { BINARY: 1, FONT: 1, IMAGE: 1, MUSIC: 1, SOUND: 1, TEXT: 1 };

  function at(text, index) {
    var before = text.slice(0, index).split("\n");
    return { line: before.length, column: before[before.length - 1].length + 1 };
  }

  function diag(severity, text, key, message) {
    var pos = { line: 1, column: 1 }, width = 1;
    var i = key == null ? -1 : text.indexOf(JSON.stringify(key));
    if (i >= 0) { pos = at(text, i); width = JSON.stringify(key).length; }
    return { severity: severity, file: FILE, line: pos.line, column: pos.column, endLine: pos.line,
             endColumn: pos.column + width, message: message, code: "assets" };
  }

  // Haxe accepts JSON's string escapes, so a JSON string is a Haxe string literal.
  function hx(s) { return JSON.stringify(String(s)); }

  function flatName(id) {
    var n = String(id).toLowerCase().replace(/[^a-z0-9]/g, "_");
    return /^[0-9]/.test(n) ? "_" + n : n;
  }

  function generate(text) {
    var diagnostics = [], data;
    try { data = JSON.parse(text); }
    catch (err) {
      var d = diag("error", text, null, "assets.json is not valid JSON: " + err.message);
      var m = /position (\d+)/.exec(err.message);
      if (m) {
        var pos = at(text, +m[1]);
        d.line = d.endLine = pos.line;
        d.column = pos.column;
        d.endColumn = pos.column + 1;
      }
      return { source: null, diagnostics: [d], count: 0 };
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { source: null, count: 0,
               diagnostics: [diag("error", text, null, "assets.json should be an object of asset ids mapped to URLs")] };
    }

    var root = typeof data.rootPath === "string" ? data.rootPath : "";
    if (root && !/\/$/.test(root)) root += "/";
    var entries = data.assets && typeof data.assets === "object" ? data.assets : data;

    var assets = [], fonts = [], used = {};
    Object.keys(entries).forEach(function (id) {
      if (entries === data && id === "rootPath") return;
      var e = entries[id];
      if (typeof e === "string") e = { path: e };
      if (!e || typeof e !== "object" || typeof e.path !== "string" || !e.path) {
        diagnostics.push(diag("warning", text, id, "\"" + id + "\" needs a URL, or an object with a path"));
        return;
      }
      var url = /^([a-z][a-z0-9+.-]*:|\/)/i.test(e.path) ? e.path : root + e.path;
      var ext = (/\.([a-z0-9]+)(?:[?#].*)?$/i.exec(url) || [])[1];
      var type = e.type ? String(e.type).toUpperCase() : (ext && TYPES[ext.toLowerCase()]) || "BINARY";
      if (!KNOWN[type]) {
        diagnostics.push(diag("warning", text, id, "unknown asset type \"" + e.type + "\"; use image, sound, music, font, text or binary"));
        type = "BINARY";
      }
      var asset = { id: id, path: url, type: type, preload: e.preload !== false };
      if (typeof e.size === "number") asset.size = e.size;
      if (type === "SOUND" || type === "MUSIC") asset.pathGroup = [url];
      if (type === "FONT") {
        var base = flatName(id), flat = base, n = 1;
        while (used[flat]) flat = base + "_" + (++n);
        used[flat] = true;
        var family = typeof e.fontName === "string" && e.fontName ? e.fontName
          : url.replace(/[?#].*$/, "").split("/").pop().replace(/\.[^.]*$/, "");
        family = family.replace(/['"\\<>]/g, "");
        asset.className = "__ASSET__" + flat;
        fonts.push({ flat: flat, family: family, url: url });
      }
      assets.push(asset);
    });

    if (!assets.length) return { source: null, diagnostics: diagnostics, count: 0 };

    var css = fonts.map(function (f) {
      return "@font-face { font-family: '" + f.family + "'; src: url(" + JSON.stringify(f.url) + "); }";
    }).join("\n");
    var manifest = JSON.stringify({ name: "default", assets: assets });

    var src = [
      "package;",
      "",
      "import lime.utils.AssetLibrary;",
      "import lime.utils.AssetManifest;",
      "import lime.utils.Assets;",
      "",
      "// Generated by haxe.run from assets.json, in place of the ManifestResources",
      "// that lime's tools generate from a project.xml.",
      "@:access(lime.utils.Assets)",
      "@:keep @:dox(hide) class ManifestResources",
      "{",
      "\tpublic static var preloadLibraries:Array<AssetLibrary>;",
      "\tpublic static var preloadLibraryNames:Array<String>;",
      "\tpublic static var rootPath:String;",
      "",
      "\tpublic static function init(config:Dynamic):Void",
      "\t{",
      "\t\tpreloadLibraries = new Array();",
      "\t\tpreloadLibraryNames = new Array();",
      "\t\trootPath = \"\";",
      ""
    ];
    if (fonts.length) {
      src.push(
        "\t\t#if (js && html5)",
        "\t\tvar style = js.Browser.document.createStyleElement();",
        "\t\tstyle.textContent = " + hx(css) + ";",
        "\t\tjs.Browser.document.head.appendChild(style);",
        "\t\t#end",
        "");
      fonts.forEach(function (f) { src.push("\t\topenfl.text.Font.registerFont(__ASSET__OPENFL__" + f.flat + ");"); });
      src.push("");
    }
    src.push(
      "\t\tvar manifest = AssetManifest.parse(" + hx(manifest) + ", rootPath);",
      "\t\tvar library = AssetLibrary.fromManifest(manifest);",
      "\t\tAssets.registerLibrary(\"default\", library);",
      "",
      "\t\tlibrary = Assets.getLibrary(\"default\");",
      "\t\tif (library != null) preloadLibraries.push(library);",
      "\t\telse preloadLibraryNames.push(\"default\");",
      "\t}",
      "}",
      "");
    fonts.forEach(function (f) {
      src.push(
        "@:keep @:noCompletion class __ASSET__" + f.flat + " extends lime.text.Font { public function new() { super(" + hx(f.family) + "); } }",
        "@:keep @:noCompletion class __ASSET__OPENFL__" + f.flat + " extends openfl.text.Font { public function new() { super(" + hx(f.family) + "); } }");
    });
    return { source: src.join("\n") + "\n", diagnostics: diagnostics, count: assets.length };
  }

  return { FILE: FILE, generate: generate };
})();
