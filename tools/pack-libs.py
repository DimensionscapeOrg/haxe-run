"""Pack haxelib sources the playground serves itself.

    python tools/pack-libs.py

Writes one assets/libs/<name>.json per library, taken from whatever version
`haxelib libpath` reports, plus assets/libs/index.json listing them. A project
gets one with `-lib <name>` in its build.hxml (or, for OpenFL, Lime and Feathers
UI, just by importing them); dependencies named in haxelib.json are pulled in
the same way. Each compiler instance writes a library under /libs/<name> once.
hxc.data carries only the standard library, so plain Haxe never downloads these.

Each library's license file is included and written next to its sources, and
its extraParams.hxml, if any, is applied wherever it is used. Sources are packed
exactly as haxelib has them.

The JavaScript an include.xml embeds in html5 builds (Lime's Howler, pako and
so on) is packed too, under its own path, and listed in "embed" so the compiler
can put it in front of the output as lime's tools do.
"""

import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIBS = ["feathersui", "actuate", "openfl", "lime"]


def libpath(name):
    out = subprocess.run(["haxelib", "libpath", name], capture_output=True, text=True, check=True)
    return out.stdout.strip().splitlines()[-1].strip()


# Conditions an html5 build here satisfies; a dependency needing anything else
# (webgl-debug, stats) is left out, as lime's tools would leave it out by default.
HTML5_DEFINES = {"html5", "howlerjs"}


def embedded_scripts(base):
    path = os.path.join(base, "include.xml")
    if not os.path.exists(path):
        return []
    found = []
    for tag in re.findall(r"<dependency\b[^>]*>", open(path, encoding="utf-8").read()):
        attrs = dict(re.findall(r'([\w-]+)="([^"]*)"', tag))
        dep = attrs.get("path", "")
        if attrs.get("embed") != "true" or not dep.endswith(".js") or "unless" in attrs:
            continue
        if not set(attrs.get("if", "").split()) <= HTML5_DEFINES or "html5" not in attrs.get("if", ""):
            continue
        full = os.path.join(base, dep)
        if os.path.exists(full):
            found.append({"path": dep, "allowWebWorkers": attrs.get("allow-web-workers") == "true",
                          "source": open(full, encoding="utf-8", newline="").read()})
    return found


def pack(name):
    base = libpath(name)
    meta = json.load(open(os.path.join(base, "haxelib.json"), encoding="utf-8"))
    src = os.path.join(base, meta.get("classPath", ""))
    files = {}
    for dirpath, _, names in os.walk(src):
        for n in sorted(names):
            if n.endswith(".hx"):
                full = os.path.join(dirpath, n)
                rel = os.path.relpath(full, src).replace(os.sep, "/")
                files[rel] = open(full, encoding="utf-8", newline="").read()
    for lic in ("LICENSE.md", "LICENSE.txt", "LICENSE"):
        p = os.path.join(base, lic)
        if os.path.exists(p):
            files[lic] = open(p, encoding="utf-8", newline="").read()
            break
    extra = os.path.join(base, "extraParams.hxml")
    lib = {
        "name": name,
        "version": meta["version"],
        "license": meta.get("license", ""),
        "dependencies": meta.get("dependencies", {}),
        "extraParams": open(extra, encoding="utf-8", newline="").read() if os.path.exists(extra) else "",
        "files": files,
    }
    embed = embedded_scripts(base)
    if embed:
        lib["embed"] = embed
    return lib


def main():
    out_dir = os.path.join(ROOT, "assets", "libs")
    os.makedirs(out_dir, exist_ok=True)
    index = {}
    for name in LIBS:
        lib = pack(name)
        out = os.path.join(out_dir, name + ".json")
        with open(out, "w", encoding="utf-8", newline="\n") as f:
            json.dump({"libs": [lib]}, f, separators=(",", ":"))
        index[name] = {"version": lib["version"], "license": lib["license"]}
        print("%s: %s %s, %d files, %d bytes" % (os.path.relpath(out, ROOT), name, lib["version"],
                                                len(lib["files"]), os.path.getsize(out)))
    with open(os.path.join(out_dir, "index.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(index, f, indent=2)
        f.write("\n")


if __name__ == "__main__":
    sys.exit(main())
