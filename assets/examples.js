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
    id: "github-lib",
    name: "A library from GitHub",
    description: "build.hxml pulls hxmath straight from its GitHub repository, pinned to a tag.",
    tags: ["Haxe", "build.hxml"],
    accent: "green",
    files: {
      "Main.hx": `import hxmath.math.Vector2;

class Main {
    static function main() {
        var a = new Vector2(3, 4);
        var b = new Vector2(1, -2);

        trace('a = $a, length \${a.length}');
        trace('a + b = \${Vector2.add(a, b)}');
        trace('a . b = \${Vector2.dot(a, b)}');
        trace('a turned left = \${a.rotatedLeft}');
        trace('halfway from a to b = \${Vector2.lerp(a, b, 0.5)}');
    }
}
`,
      "build.hxml": `# Libraries and flags for this playground, as in any hxml file.
# Any haxelib on GitHub works, pinned to a tag, branch or commit:
-lib hxmath:git:https://github.com/tbrosman/hxmath#0.16.0
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
    id: "piratepig",
    name: "Pirate Pig",
    description: "The OpenFL match-three demo, unchanged, with its images, sounds and font loaded through assets.json.",
    tags: ["OpenFL", "Game", "Assets"],
    accent: "amber",
    files: {
      "build.hxml": `# From openfl-samples/demos/PiratePig: its project.xml, as build.hxml and assets.json.
-lib openfl
-lib actuate
-main piratepig.PiratePig
`,
      "assets.json": `{
  "rootPath": "examples/piratepig/",
  "assets": {
    "images/background_tile.png": {
      "path": "images/background_tile.png",
      "size": 16510
    },
    "images/center_bottom.png": {
      "path": "images/center_bottom.png",
      "size": 157449
    },
    "images/cursor.png": {
      "path": "images/cursor.png",
      "size": 15520
    },
    "images/cursor_highlight.png": {
      "path": "images/cursor_highlight.png",
      "size": 15530
    },
    "images/game_bear.png": {
      "path": "images/game_bear.png",
      "size": 1249
    },
    "images/game_bunny_02.png": {
      "path": "images/game_bunny_02.png",
      "size": 1062
    },
    "images/game_carrot.png": {
      "path": "images/game_carrot.png",
      "size": 1310
    },
    "images/game_lemon.png": {
      "path": "images/game_lemon.png",
      "size": 1499
    },
    "images/game_panda.png": {
      "path": "images/game_panda.png",
      "size": 969
    },
    "images/game_piratePig.png": {
      "path": "images/game_piratePig.png",
      "size": 1737
    },
    "images/logo.png": {
      "path": "images/logo.png",
      "size": 19199
    },
    "fonts/FreebooterUpdated.ttf": {
      "path": "fonts/FreebooterUpdated.ttf",
      "size": 102764
    },
    "sound3": {
      "path": "sounds/3.mp3",
      "type": "sound",
      "size": 2115
    },
    "sound4": {
      "path": "sounds/4.mp3",
      "type": "sound",
      "size": 12982
    },
    "sound5": {
      "path": "sounds/5.mp3",
      "type": "sound",
      "size": 80692
    },
    "soundTheme": {
      "path": "sounds/theme.mp3",
      "type": "music",
      "size": 160522
    }
  }
}
`,
      "piratepig/PiratePig.hx": `package piratepig;

import openfl.display.Bitmap;
import openfl.display.BitmapData;
import openfl.display.Sprite;
import openfl.events.Event;
import openfl.events.KeyboardEvent;
import openfl.system.Capabilities;
import openfl.Assets;
import openfl.Lib;

class PiratePig extends Sprite
{
	private var Background:Bitmap;
	private var Footer:Bitmap;
	private var Game:PiratePigGame;

	public function new()
	{
		super();

		initialize();
		construct();

		resize(stage.stageWidth, stage.stageHeight);
		stage.addEventListener(Event.RESIZE, stage_onResize);
	}

	private function construct():Void
	{
		Footer.smoothing = true;

		addChild(Background);
		addChild(Footer);
		addChild(Game);
	}

	private function initialize():Void
	{
		Background = new Bitmap(Assets.getBitmapData("images/background_tile.png"));
		Footer = new Bitmap(Assets.getBitmapData("images/center_bottom.png"));
		Game = new PiratePigGame();
	}

	private function resize(newWidth:Int, newHeight:Int):Void
	{
		Background.width = newWidth;
		Background.height = newHeight;

		Game.resize(newWidth, newHeight);

		Footer.scaleX = Game.currentScale;
		Footer.scaleY = Game.currentScale;
		Footer.x = newWidth / 2 - Footer.width / 2;
		Footer.y = newHeight - Footer.height;
	}

	private function stage_onResize(event:Event):Void
	{
		resize(stage.stageWidth, stage.stageHeight);
	}
}
`,
      "piratepig/PiratePigGame.hx": `package piratepig;

import motion.easing.Quad;
import motion.Actuate;
import openfl.display.Bitmap;
import openfl.display.Sprite;
import openfl.events.Event;
import openfl.events.MouseEvent;
import openfl.filters.BlurFilter;
import openfl.filters.DropShadowFilter;
import openfl.geom.Point;
import openfl.media.Sound;
import openfl.text.TextField;
import openfl.text.TextFormat;
import openfl.text.TextFormatAlign;
import openfl.Assets;
import openfl.Lib;
#if (!flash || enable_gamepad_support)
import openfl.events.GameInputEvent;
import openfl.ui.GameInput;
import openfl.ui.GameInputDevice;
import openfl.ui.GameInputControl;
#end

class PiratePigGame extends Sprite
{
	private static var NUM_COLUMNS = 8;
	private static var NUM_ROWS = 8;
	private static var tileImages = [
		"images/game_bear.png",
		"images/game_bunny_02.png",
		"images/game_carrot.png",
		"images/game_lemon.png",
		"images/game_panda.png",
		"images/game_piratePig.png"
	];

	private var Background:Sprite;
	private var Cursor:Bitmap;
	private var CursorHighlight:Bitmap;
	private var IntroSound:Sound;
	private var Logo:Bitmap;
	private var Score:TextField;
	private var Sound3:Sound;
	private var Sound4:Sound;
	private var Sound5:Sound;
	private var TileContainer:Sprite;

	public var currentScale:Float;
	public var currentScore:Int;

	private var cacheMouse:Point;
	private var cursorPosition:Point;
	private var gamepads:Array<GamepadWrapper>;
	private var needToCheckMatches:Bool;
	private var selectedTile:Tile;
	private var tiles:Array<Array<Tile>>;
	private var usedTiles:Array<Tile>;
	#if (!flash || enable_gamepad_support)
	private var gameInput:GameInput;
	#end

	public function new()
	{
		super();

		initialize();
		construct();

		newGame();
	}

	private function addTile(row:Int, column:Int, animate:Bool = true):Void
	{
		var tile = null;
		var type = Math.round(Math.random() * (tileImages.length - 1));

		for (usedTile in usedTiles)
		{
			if (usedTile.removed && usedTile.parent == null && usedTile.type == type)
			{
				tile = usedTile;
			}
		}

		if (tile == null)
		{
			tile = new Tile(tileImages[type]);
		}

		tile.initialize();

		tile.type = type;
		tile.row = row;
		tile.column = column;
		tiles[row][column] = tile;

		var position = getPosition(row, column);

		if (animate)
		{
			var firstPosition = getPosition(-1, column);

			tile.alpha = 0;
			tile.x = firstPosition.x;
			tile.y = firstPosition.y;

			tile.moveTo(0.15 * (row + 1), position.x, position.y);
			Actuate.tween(tile, 0.3, {alpha: 1}).delay(0.15 * (row - 2)).ease(Quad.easeOut);
		}
		else
		{
			tile.x = position.x;
			tile.y = position.y;
		}

		TileContainer.addChild(tile);
		needToCheckMatches = true;
	}

	private function construct():Void
	{
		Logo.smoothing = true;
		addChild(Logo);

		var font = Assets.getFont("fonts/FreebooterUpdated.ttf");
		var defaultFormat = new TextFormat(font.fontName, 60, 0x000000);
		defaultFormat.align = TextFormatAlign.RIGHT;

		var contentWidth = 75 * NUM_COLUMNS;

		Score.x = contentWidth - 200;
		Score.width = 200;
		Score.y = 12;
		Score.selectable = false;
		Score.defaultTextFormat = defaultFormat;
		Score.embedFonts = true;
		addChild(Score);

		Background.y = 85;
		Background.graphics.beginFill(0xFFFFFF, 0.4);
		Background.graphics.drawRect(0, 0, contentWidth, 75 * NUM_ROWS);
		Background.filters = [new BlurFilter(10, 10)];
		addChild(Background);

		TileContainer.x = 14;
		TileContainer.y = Background.y + 14;
		TileContainer.addEventListener(MouseEvent.MOUSE_DOWN, TileContainer_onMouseDown);
		Lib.current.stage.addEventListener(MouseEvent.MOUSE_UP, stage_onMouseUp);
		addChild(TileContainer);

		IntroSound = Assets.getSound("soundTheme");
		Sound3 = Assets.getSound("sound3");
		Sound4 = Assets.getSound("sound4");
		Sound5 = Assets.getSound("sound5");

		Cursor.visible = false;
		Cursor.alpha = 0.7;
		CursorHighlight.visible = false;
		CursorHighlight.alpha = 0.7;

		TileContainer.addChild(Cursor);
		TileContainer.addChild(CursorHighlight);

		#if (!flash || enable_gamepad_support)
		gameInput = new GameInput();
		gameInput.addEventListener(GameInputEvent.DEVICE_ADDED, gameInput_onDeviceAdded);
		gameInput.addEventListener(GameInputEvent.DEVICE_REMOVED, gameInput_onDeviceRemoved);
		#end
	}

	private function dropTiles():Void
	{
		for (column in 0...NUM_COLUMNS)
		{
			var spaces = 0;

			for (row in 0...NUM_ROWS)
			{
				var index = (NUM_ROWS - 1) - row;
				var tile = tiles[index][column];

				if (tile == null)
				{
					spaces++;
				}
				else
				{
					if (spaces > 0)
					{
						var position = getPosition(index + spaces, column);
						tile.moveTo(0.15 * spaces, position.x, position.y);

						tile.row = index + spaces;
						tiles[index + spaces][column] = tile;
						tiles[index][column] = null;

						needToCheckMatches = true;
					}
				}
			}

			for (i in 0...spaces)
			{
				var row = (spaces - 1) - i;
				addTile(row, column);
			}
		}
	}

	private function findMatches(byRow:Bool, accumulateScore:Bool = true):Array<Tile>
	{
		var matchedTiles = new Array<Tile>();

		var max:Int;
		var secondMax:Int;

		if (byRow)
		{
			max = NUM_ROWS;
			secondMax = NUM_COLUMNS;
		}
		else
		{
			max = NUM_COLUMNS;
			secondMax = NUM_ROWS;
		}

		for (index in 0...max)
		{
			var matches = 0;
			var foundTiles = new Array<Tile>();
			var previousType = -1;

			for (secondIndex in 0...secondMax)
			{
				var tile:Tile;

				if (byRow)
				{
					tile = tiles[index][secondIndex];
				}
				else
				{
					tile = tiles[secondIndex][index];
				}

				if (tile != null && !tile.moving)
				{
					if (previousType == -1)
					{
						previousType = tile.type;
						foundTiles.push(tile);
						continue;
					}
					else if (tile.type == previousType)
					{
						foundTiles.push(tile);
						matches++;
					}
				}

				if (tile == null || tile.moving || tile.type != previousType || secondIndex == secondMax - 1)
				{
					if (matches >= 2 && previousType != -1)
					{
						if (accumulateScore)
						{
							if (matches > 3)
							{
								Sound5.play();
							}
							else if (matches > 2)
							{
								Sound4.play();
							}
							else
							{
								Sound3.play();
							}

							currentScore += Std.int(Math.pow(matches, 2) * 50);
						}

						matchedTiles = matchedTiles.concat(foundTiles);
					}

					matches = 0;
					foundTiles = new Array<Tile>();

					if (tile == null || tile.moving)
					{
						needToCheckMatches = true;
						previousType = -1;
					}
					else
					{
						previousType = tile.type;
						foundTiles.push(tile);
					}
				}
			}
		}

		return matchedTiles;
	}

	private function getPosition(row:Int, column:Int):Point
	{
		return new Point(column * (57 + 16), row * (57 + 16));
	}

	private function initialize():Void
	{
		currentScale = 1;
		currentScore = 0;

		tiles = new Array<Array<Tile>>();
		usedTiles = new Array<Tile>();
		gamepads = new Array();

		for (row in 0...NUM_ROWS)
		{
			tiles[row] = new Array<Tile>();

			for (column in 0...NUM_COLUMNS)
			{
				tiles[row][column] = null;
			}
		}

		Background = new Sprite();
		Logo = new Bitmap(Assets.getBitmapData("images/logo.png"));
		Score = new TextField();
		TileContainer = new Sprite();
		Cursor = new Bitmap(Assets.getBitmapData("images/cursor.png"));
		CursorHighlight = new Bitmap(Assets.getBitmapData("images/cursor_highlight.png"));
	}

	private function moveCursor(x:Int, y:Int, aPressed:Bool):Void
	{
		if (cursorPosition == null) cursorPosition = new Point();

		var oldTile = tiles[Std.int(cursorPosition.y)][Std.int(cursorPosition.x)];

		cursorPosition.x += x;
		cursorPosition.y += y;

		if (cursorPosition.y > tiles.length - 1) cursorPosition.y = tiles.length - 1;
		if (cursorPosition.x > tiles[0].length - 1) cursorPosition.x = tiles[0].length - 1;
		if (cursorPosition.y < 0) cursorPosition.y = 0;
		if (cursorPosition.x < 0) cursorPosition.x = 0;

		var tile = tiles[Std.int(cursorPosition.y)][Std.int(cursorPosition.x)];

		if (tile != null)
		{
			var targetTilePosition = getPosition(Std.int(cursorPosition.y), Std.int(cursorPosition.x));

			Cursor.x = targetTilePosition.x;
			Cursor.y = targetTilePosition.y;
			CursorHighlight.x = Cursor.x;
			CursorHighlight.y = Cursor.y;

			if (aPressed && oldTile != tile && oldTile != null)
			{
				swapTile(oldTile, Std.int(cursorPosition.y), Std.int(cursorPosition.x));
			}
		}
	}

	public function newGame():Void
	{
		currentScore = 0;
		Score.text = "0";

		for (row in 0...NUM_ROWS)
		{
			for (column in 0...NUM_COLUMNS)
			{
				removeTile(row, column, false);
			}
		}

		for (row in 0...NUM_ROWS)
		{
			for (column in 0...NUM_COLUMNS)
			{
				addTile(row, column, false);
			}
		}

		IntroSound.play();

		removeEventListener(Event.ENTER_FRAME, this_onEnterFrame);
		addEventListener(Event.ENTER_FRAME, this_onEnterFrame);
	}

	public function removeTile(row:Int, column:Int, animate:Bool = true):Void
	{
		var tile = tiles[row][column];

		if (tile != null)
		{
			tile.remove(animate);
			usedTiles.push(tile);
		}

		tiles[row][column] = null;
	}

	public function resize(newWidth:Int, newHeight:Int):Void
	{
		var maxWidth = newWidth * 0.90;
		var maxHeight = newHeight * 0.86;

		currentScale = 1;
		scaleX = 1;
		scaleY = 1;

		var currentWidth = width;
		var currentHeight = height;

		var maxScaleX = maxWidth / currentWidth;
		var maxScaleY = maxHeight / currentHeight;

		if (maxScaleX < maxScaleY)
		{
			currentScale = maxScaleX;
		}
		else
		{
			currentScale = maxScaleY;
		}

		scaleX = currentScale;
		scaleY = currentScale;

		x = newWidth / 2 - (currentWidth * currentScale) / 2;
	}

	private function swapTile(tile:Tile, targetRow:Int, targetColumn:Int):Void
	{
		if (targetColumn >= 0 && targetColumn < NUM_COLUMNS && targetRow >= 0 && targetRow < NUM_ROWS)
		{
			var targetTile = tiles[targetRow][targetColumn];

			if (targetTile != null && !targetTile.moving)
			{
				tiles[targetRow][targetColumn] = tile;
				tiles[tile.row][tile.column] = targetTile;

				if (findMatches(true, false).length > 0 || findMatches(false, false).length > 0)
				{
					targetTile.row = tile.row;
					targetTile.column = tile.column;
					tile.row = targetRow;
					tile.column = targetColumn;
					var targetTilePosition = getPosition(targetTile.row, targetTile.column);
					var tilePosition = getPosition(tile.row, tile.column);

					targetTile.moveTo(0.3, targetTilePosition.x, targetTilePosition.y);
					tile.moveTo(0.3, tilePosition.x, tilePosition.y);

					needToCheckMatches = true;
				}
				else
				{
					tiles[targetRow][targetColumn] = targetTile;
					tiles[tile.row][tile.column] = tile;
				}
			}
		}
	}

	private function updateGamepadInput():Void
	{
		#if (!flash || enable_gamepad_support)
		for (gamepad in gamepads)
		{
			gamepad.update();
		}

		if (gamepads.length > 0)
		{
			var aPressed = gamepads[0].a.pressed;

			if (gamepads[0].up.justPressed)
			{
				moveCursor(0, -1, aPressed);
			}
			else if (gamepads[0].down.justPressed)
			{
				moveCursor(0, 1, aPressed);
			}
			else if (gamepads[0].left.justPressed)
			{
				moveCursor(-1, 0, aPressed);
			}
			else if (gamepads[0].right.justPressed)
			{
				moveCursor(1, 0, aPressed);
			}

			Cursor.visible = !aPressed;
			CursorHighlight.visible = aPressed;
		}
		else
		{
			Cursor.visible = false;
			CursorHighlight.visible = false;
		}
		#end
	}

	// Event Handlers
	#if (!flash || enable_gamepad_support)
	private function gameInput_onDeviceAdded(event:GameInputEvent):Void
	{
		var device = event.device;
		device.enabled = true;

		gamepads.push(new GamepadWrapper(device));
	}

	private function gameInput_onDeviceRemoved(event:GameInputEvent):Void
	{
		var device = event.device;
		device.enabled = false;

		for (gamepad in gamepads)
		{
			if (gamepad.device == device)
			{
				gamepad.destroy();
				gamepads.remove(gamepad);
				return;
			}
		}
	}
	#end

	private function stage_onMouseUp(event:MouseEvent):Void
	{
		if (cacheMouse != null && selectedTile != null && !selectedTile.moving)
		{
			var differenceX = event.stageX - cacheMouse.x;
			var differenceY = event.stageY - cacheMouse.y;

			if (Math.abs(differenceX) > 10 || Math.abs(differenceY) > 10)
			{
				var swapToRow = selectedTile.row;
				var swapToColumn = selectedTile.column;

				if (Math.abs(differenceX) > Math.abs(differenceY))
				{
					if (differenceX < 0)
					{
						swapToColumn--;
					}
					else
					{
						swapToColumn++;
					}
				}
				else
				{
					if (differenceY < 0)
					{
						swapToRow--;
					}
					else
					{
						swapToRow++;
					}
				}

				swapTile(selectedTile, swapToRow, swapToColumn);
			}
		}

		selectedTile = null;
		cacheMouse = null;
	}

	private function this_onEnterFrame(event:Event):Void
	{
		updateGamepadInput();

		if (needToCheckMatches)
		{
			var matchedTiles = new Array<Tile>();

			matchedTiles = matchedTiles.concat(findMatches(true));
			matchedTiles = matchedTiles.concat(findMatches(false));

			for (tile in matchedTiles)
			{
				removeTile(tile.row, tile.column);
			}

			if (matchedTiles.length > 0)
			{
				Score.text = Std.string(currentScore);
				dropTiles();
			}
		}
	}

	private function TileContainer_onMouseDown(event:MouseEvent):Void
	{
		if (#if (haxe_ver >= 4.2) Std.isOfType #else Std.is #end(event.target, Tile))
		{
			selectedTile = cast event.target;
			cacheMouse = new Point(event.stageX, event.stageY);
		}
		else
		{
			cacheMouse = null;
			selectedTile = null;
		}
	}
}
`,
      "piratepig/Tile.hx": `package piratepig;

import motion.easing.Quad;
import motion.Actuate;
import openfl.display.Bitmap;
import openfl.display.Sprite;
import openfl.Assets;

class Tile extends Sprite
{
	public var column:Int;
	public var moving:Bool;
	public var removed:Bool;
	public var row:Int;
	public var type:Int;

	public function new(imagePath:String)
	{
		super();

		var image = new Bitmap(Assets.getBitmapData(imagePath));
		image.smoothing = true;
		addChild(image);

		mouseChildren = false;
		buttonMode = true;

		graphics.beginFill(0x000000, 0);
		graphics.drawRect(-5, -5, 66, 66);
	}

	public function initialize():Void
	{
		moving = false;
		removed = false;

		mouseEnabled = true;
		buttonMode = true;

		scaleX = 1;
		scaleY = 1;
		alpha = 1;
	}

	public function moveTo(duration:Float, targetX:Float, targetY:Float):Void
	{
		moving = true;

		Actuate.tween(this, duration, {x: targetX, y: targetY}).ease(Quad.easeOut).onComplete(this_onMoveToComplete);
	}

	public function remove(animate:Bool = true):Void
	{
		if (!removed)
		{
			if (animate)
			{
				mouseEnabled = false;
				buttonMode = false;

				parent.addChildAt(this, 0);
				Actuate.tween(this, 0.6,
					{
						alpha: 0,
						scaleX: 2,
						scaleY: 2,
						x: x - width / 2,
						y: y - height / 2
					}).onComplete(this_onRemoveComplete);
			}
			else
			{
				this_onRemoveComplete();
			}
		}

		removed = true;
	}

	// Event Handlers

	private function this_onMoveToComplete():Void
	{
		moving = false;
	}

	private function this_onRemoveComplete():Void
	{
		parent.removeChild(this);
	}
}
`,
      "piratepig/GamepadWrapper.hx": `package piratepig;

import openfl.ui.GameInputControl;
import openfl.ui.GameInputDevice;

class GamepadWrapper
{
	public var a:ButtonState;
	public var b:ButtonState;
	public var down:ButtonState;
	public var device:GameInputDevice;
	public var left:ButtonState;
	public var right:ButtonState;
	public var up:ButtonState;
	public var x:ButtonState;
	public var y:ButtonState;

	public function new(device:GameInputDevice)
	{
		this.device = device;

		up = new ButtonState();
		down = new ButtonState();
		left = new ButtonState();
		right = new ButtonState();

		a = new ButtonState();
		b = new ButtonState();
		x = new ButtonState();
		y = new ButtonState();
	}

	public function destroy():Void
	{
		device = null;
	}

	public function update():Void
	{
		for (i in 0...device.numControls)
		{
			var control:GameInputControl = device.getControlAt(i);

			var state:ButtonState = switch (control.id)
			{
				case "BUTTON_11": up;
				case "BUTTON_12": down;
				case "BUTTON_13": left;
				case "BUTTON_14": right;
				case "BUTTON_0": a;
				case "BUTTON_1": b;
				case "BUTTON_2": x;
				case "BUTTON_3": y;
				default: null;
			}

			if (state != null)
			{
				if (control.value <= 0)
				{
					state.release();
				}
				else
				{
					state.press();
				}
			}
		}
	}
}

class ButtonState
{
	public var pressed(default, null):Bool;
	public var justPressed(default, null):Bool;
	public var justReleased(default, null):Bool;

	public function new():Void
	{
		pressed = false;
		justPressed = false;
		justReleased = false;
	}

	public function press():Void
	{
		if (!pressed)
		{
			justPressed = true;
		}
		else
		{
			justPressed = false;
		}

		pressed = true;
		justReleased = false;
	}

	public function release():Void
	{
		if (pressed)
		{
			justReleased = true;
		}
		else
		{
			justReleased = false;
		}

		pressed = false;
		justPressed = false;
	}

	public function update():Void
	{
		justPressed = false;
		justReleased = false;
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
