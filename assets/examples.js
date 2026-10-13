// Curated playgrounds. Every entry compiles and runs as-is on the real compiler.
window.HXR_EXAMPLES = [
  {
    id: "hello",
    name: "Hello world",
    description: "The smallest useful program: traces, a loop, and string interpolation.",
    tags: ["Haxe"],
    accent: "green",
    files: {
      "Main.hx": `class Main {
    static function main() {
        trace("Hello from haxe.run");

        var sum = 0;
        for (i in 1...11) sum += i;
        trace('sum 1..10 = $sum');
    }
}
`
    }
  },

  {
    id: "modules",
    name: "Multiple modules",
    description: "A project split across packages, with an enum and pattern matching.",
    tags: ["Haxe", "3 modules"],
    accent: "blue",
    files: {
      "Main.hx": `import geom.Shape;
import geom.Area;

class Main {
    static function main() {
        var shapes:Array<Shape> = [
            Circle(2),
            Rect(3, 4),
            Group([Circle(1), Rect(10, 0.5)])
        ];

        for (s in shapes) {
            trace(Area.describe(s) + " -> " + Area.of(s));
        }
    }
}
`,
      "geom/Shape.hx": `package geom;

enum Shape {
    Circle(radius:Float);
    Rect(w:Float, h:Float);
    Group(shapes:Array<Shape>);
}
`,
      "geom/Area.hx": `package geom;

class Area {
    public static function of(s:Shape):Float {
        return switch s {
            case Circle(r): Math.PI * r * r;
            case Rect(w, h): w * h;
            case Group(items):
                var total = 0.0;
                for (item in items) total += of(item);
                total;
        }
    }

    public static function describe(s:Shape):String {
        return switch s {
            case Circle(_): "circle";
            case Rect(_, _): "rect";
            case Group(items): 'group of \${items.length}';
        }
    }
}
`
    }
  },

  {
    id: "shapes",
    name: "Drawing shapes",
    description: "OpenFL vector graphics: fills, curves, and generated polygons.",
    tags: ["OpenFL", "Graphics"],
    accent: "amber",
    files: {
      "Main.hx": `import openfl.display.Graphics;
import openfl.display.Sprite;

class Main extends Sprite {
    public function new() {
        super();

        var fill = 0x24AFC4;
        var shapes:Array<Sprite -> Void> = [
            g -> g.graphics.drawRect(0, 0, 100, 100),
            g -> g.graphics.drawRoundRect(0, 0, 120, 100, 40, 40),
            g -> g.graphics.drawCircle(50, 50, 50),
            g -> g.graphics.drawEllipse(0, 0, 120, 100)
        ];

        var x = 20;
        for (draw in shapes) {
            var s = new Sprite();
            s.graphics.beginFill(fill);
            draw(s);
            s.x = x;
            s.y = 20;
            addChild(s);
            x += 150;
        }

        for (sides in 3...9) {
            var poly = new Sprite();
            poly.graphics.beginFill(fill);
            drawPolygon(poly.graphics, 50, 50, 50, sides);
            poly.x = 20 + (sides - 3) * 125;
            poly.y = 160;
            addChild(poly);
        }
    }

    function drawPolygon(g:Graphics, cx:Float, cy:Float, r:Float, sides:Int):Void {
        var step = (Math.PI * 2) / sides;
        var start = 0.5 * Math.PI;
        g.moveTo(Math.cos(start) * r + cx, -Math.sin(start) * r + cy);
        for (i in 0...sides + 1) {
            g.lineTo(Math.cos(start + step * i) * r + cx, -Math.sin(start + step * i) * r + cy);
        }
    }
}
`
    }
  },

  {
    id: "motion",
    name: "Motion",
    description: "An animation loop driven by ENTER_FRAME, sized to the stage.",
    tags: ["OpenFL", "Animation"],
    accent: "amber",
    files: {
      "Main.hx": `import openfl.display.Sprite;
import openfl.events.Event;

class Main extends Sprite {
    final dots:Array<Sprite> = [];
    var t:Float = 0;

    public function new() {
        super();

        for (i in 0...24) {
            var dot = new Sprite();
            dot.graphics.beginFill(0x24AFC4);
            dot.graphics.drawCircle(0, 0, 8);
            addChild(dot);
            dots.push(dot);
        }

        addEventListener(Event.ENTER_FRAME, onFrame);
    }

    function onFrame(_):Void {
        t += 0.03;
        var w = stage.stageWidth;
        var h = stage.stageHeight;
        for (i in 0...dots.length) {
            var dot = dots[i];
            var p = i / dots.length;
            dot.x = w * p;
            dot.y = h / 2 + Math.sin(t + p * Math.PI * 4) * (h / 3);
            dot.scaleX = dot.scaleY = 0.6 + Math.sin(t * 2 + p * 6) * 0.4;
        }
    }
}
`
    }
  },

  {
    id: "feathersui",
    name: "Feathers UI components",
    description: "Buttons, text input, a slider, toggles and a list, styled by Feathers UI's default theme.",
    tags: ["Feathers UI", "OpenFL"],
    accent: "blue",
    files: {
      "Main.hx": `import feathers.controls.Application;
import feathers.controls.Button;
import feathers.controls.Check;
import feathers.controls.HSlider;
import feathers.controls.Label;
import feathers.controls.LayoutGroup;
import feathers.controls.ListView;
import feathers.controls.TextInput;
import feathers.controls.ToggleSwitch;
import feathers.data.ArrayCollection;
import feathers.events.TriggerEvent;
import feathers.layout.HorizontalLayout;
import feathers.layout.VerticalLayout;
import feathers.skins.RectangleSkin;
import openfl.events.Event;

class Main extends Application {
    public function new() {
        super();

        // The default theme draws dark text, so give the app a light page.
        backgroundSkin = new RectangleSkin(SolidColor(0xF4F5F7));

        var layout = new VerticalLayout();
        layout.gap = 14;
        layout.setPadding(24);
        this.layout = layout;

        var title = new Label("Feathers UI on haxe.run");
        title.variant = Label.VARIANT_HEADING;
        addChild(title);

        // A text input and a button that reads it.
        var name = new TextInput("", "Your name");
        var greeting = new Label("Type a name and press the button.");
        var hello = new Button("Say hello", (_:TriggerEvent) -> {
            var who = name.text.length > 0 ? name.text : "world";
            greeting.text = 'Hello, $who!';
        });
        addChild(row([name, hello]));
        addChild(greeting);

        // A slider, a check that enables it, and a label that follows it.
        var amount = new Label("Value: 40");
        var slider = new HSlider(40, 0, 100);
        slider.addEventListener(Event.CHANGE, _ -> amount.text = 'Value: \${Math.round(slider.value)}');
        var enabled = new Check("Slider enabled", true);
        enabled.addEventListener(Event.CHANGE, _ -> slider.enabled = enabled.selected);
        addChild(row([enabled, slider, amount]));

        // A toggle switch.
        var status = new Label("Notifications off");
        var toggle = new ToggleSwitch();
        toggle.addEventListener(Event.CHANGE, _ -> {
            status.text = toggle.selected ? "Notifications on" : "Notifications off";
        });
        addChild(row([toggle, status]));

        // A list backed by a collection; selecting an item updates the label.
        var picked = new Label("Pick a language");
        var list = new ListView(new ArrayCollection([
            { text: "Haxe" }, { text: "hx+" }, { text: "OpenFL" }, { text: "Lime" }, { text: "Feathers UI" }
        ]));
        list.itemToText = item -> item.text;
        list.height = 180;
        list.addEventListener(Event.CHANGE, _ -> picked.text = 'Picked: \${list.selectedItem.text}');
        addChild(row([list, picked]));
    }

    static function row(items:Array<openfl.display.DisplayObject>):LayoutGroup {
        var group = new LayoutGroup();
        var layout = new HorizontalLayout();
        layout.gap = 12;
        layout.verticalAlign = MIDDLE;
        group.layout = layout;
        for (item in items) group.addChild(item);
        return group;
    }
}
`
    }
  },

  {
    id: "diagnostics",
    name: "Diagnostics",
    description: "Deliberately broken code, to see how errors are reported inline.",
    tags: ["Haxe", "Has errors"],
    accent: "red",
    files: {
      "Main.hx": `class Main {
    static function main() {
        var count:Int = "not a number";
        trace(total);
        missing();
    }
}
`
    }
  }
];
