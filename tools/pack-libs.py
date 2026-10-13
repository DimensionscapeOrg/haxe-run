"""Pack haxelib sources the playground loads on demand.

    python tools/pack-libs.py

Writes assets/libs/feathersui.json: Feathers UI plus its runtime dependency
Actuate (hxargs is only used by Feathers UI's command-line tool), taken from
whatever versions `haxelib libpath` reports. The page fetches the bundle the
first time a project uses feathers.*, and each compiler instance writes it
under /libs/<name> once. OpenFL and Lime are not here: they are already packed
into hxc.data.

Each library's license file is included and written next to its sources.

Workaround, remove once the playground's compiler is rebuilt with the fix: hxc's
macro encoder writes an empty `default:` as no default at all, so a switch in a
class that goes through a build macro (every Feathers UI control does) loses
it and fails with "Unmatched patterns". The bundled copy spells those defaults
`default: {}`, which means the same thing and survives the round trip.
"""

import json
import os
import re
import subprocess
import sys

EMPTY_DEFAULT = re.compile(r"default:(\s*\n\s*\})")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUNDLES = {"feathersui": ["feathersui", "actuate"]}


def libpath(name):
    out = subprocess.run(["haxelib", "libpath", name], capture_output=True, text=True, check=True)
    return out.stdout.strip().splitlines()[-1].strip()


def pack(name):
    meta = json.load(open(os.path.join(libpath(name), "haxelib.json"), encoding="utf-8"))
    base = libpath(name)
    src = os.path.join(base, meta.get("classPath", ""))
    files = {}
    for dirpath, _, names in os.walk(src):
        for n in sorted(names):
            if n.endswith(".hx"):
                full = os.path.join(dirpath, n)
                rel = os.path.relpath(full, src).replace(os.sep, "/")
                files[rel] = EMPTY_DEFAULT.sub(r"default: {}\1", open(full, encoding="utf-8").read())
    for lic in ("LICENSE.md", "LICENSE.txt", "LICENSE"):
        p = os.path.join(base, lic)
        if os.path.exists(p):
            files[lic] = open(p, encoding="utf-8").read()
            break
    return {"name": name, "version": meta["version"], "license": meta.get("license", ""), "files": files}


def main():
    os.makedirs(os.path.join(ROOT, "assets", "libs"), exist_ok=True)
    for bundle, names in BUNDLES.items():
        libs = [pack(n) for n in names]
        out = os.path.join(ROOT, "assets", "libs", bundle + ".json")
        with open(out, "w", encoding="utf-8", newline="\n") as f:
            json.dump({"libs": libs}, f, separators=(",", ":"))
        summary = ", ".join("%s %s (%d files)" % (l["name"], l["version"], len(l["files"])) for l in libs)
        print("%s: %s, %d bytes" % (os.path.relpath(out, ROOT), summary, os.path.getsize(out)))


if __name__ == "__main__":
    sys.exit(main())
