(function() {
"use strict()";

// functions, variables, etc. that should be exported, will be exported in the
// `exports` object (by default, the global namespace)
var exports = window;

// milliseconds between cursor blinks
var BLINK_DELAY = 500;

// default value for the character on 'empty' space
var EMPTY_CHAR = ' ';

/**
 * Named constants for colors: COLOR_WHITE, COLOR_RED, COLOR_GREEN, etc.
 **/
var colors = {
  WHITE: '#CCCCCC',
  RED: '#CC4444',
  GREEN: '#44CC44',
  YELLOW: '#CCCC44',
  BLUE: '#4444CC',
  MAGENTA: '#CC44CC',
  CYAN: '#44CCCC',
  BLACK: '#222222'
};

var construct_color_table = function() {
  for (var k in colors) {
    exports['COLOR_' + k] = colors[k];
  }
};
construct_color_table();

// default window: will be used as a default object for all curses functions,
// such as print(), addch(), move(), etc., if called directly instead of using
// scr.print(), scr.addch(), scr.move(), etc.
var default_screen = null;

// curses window
// TODO: implement creating other windows, sub-wdinows (not just the global 
// 'stdscr' window)
var window_t = function() {
  // cursor position
  this.y = 0;
  this.x = 0;
  // window position
  this.win_y = 0;
  this.win_x = 0;
  // width and height, in characters
  this.width = 0;
  this.height = 0;
  // parent window, if any
  this.parent = null;
  // 2-D array for tiles (see tile_t)
  this.tiles = [];
  // character used for filling empty tiles
  // TODO: implement empty characters
  this.empty_char = EMPTY_CHAR;
  this.empty_attrs = A_NORMAL | COLOR_PAIR(0);
  // current attributes (bold, italics, color, etc.) being used for text that
  // is being added
  this.current_attrs = A_NORMAL | COLOR_PAIR(0);
  // map of changes since last refresh: maps a [y,x] pair to a 'change' object
  // that describes what new 'value' a character should have
  this.changes = {};
  // list of subwindows that exist
  this.subwindows = [];
};

// curses screen display; can contain subwindows
var screen_t = function() {
  window_t.call(this);
  // font used for rendering
  // TODO: support a default font
  this.font = {
    type: 'ttf',
    name: 'monospace',
    size: 12,
    char_width: -1,
    char_height: -1,
    line_spacing: 0
  };
  // default values for some input flags
  this._echo = false;   // do not print all keyboard input
  this._raw = false; // allow Ctl+<char> to be used for normal things, like
                        // copy/paste, select all, etc., and allow browser
                        // keyboard shortcuts
  this._blink = true;   // make the cursor blink
  this._blinkTimeout = 0;
  // wrapper element
  this.container = null;
  // canvas and its rendering context
  this.canvas = null;
  this.context = null;
  // maps a character (and its attributes) to an already-drawn character
  // on a small canvas. this allows very fast rendering, but makes the
  // application use more memory to save all the characters
  this.char_cache = {};
  this.canvas_pool = {
    normal: {
      x: 0,
      canvases: []
    },
    bold: {
      x: 0,
      canvases: []
    }
  };
  // event listeners
  this.listeners = {
    keydown: []
  };
};

// tile on a window, used for keeping track of each character's state on the
// screen
var tile_t = function() {
  // true iff this tile has no content
  this.empty = true;
  // content character
  this.content = EMPTY_CHAR;
  // attributes (bold, italics, color, etc.)
  this.attrs = A_NORMAL | COLOR_PAIR(0);
  // true iff this tile is not hidden by a subwindow that is "over" it
  this.exposed = true;
};


// when called with a function, return that function, wrapped so that
// it can be used directly by being applied on `default_screen'.
//
// i.e., the call:
//   default_screen.addstr('hello world');
//
// can be shortened to:
//   addstr('hello world');
//
// if you define:
//   addstr = simplify(screen_t.prototype.addstr);
// when called with function name `function_name' that is defined in
// screen_t.prototype, will create a function with the same name in `exports'
// that calls this function using `default_screen'
var simplify = function(f) {
  return function() {
    return f.apply(default_screen, arguments);
  };
};

// similar to simplify, but convert the call so it can be done as in C with
// ncurses.
//
// for instance, the call:
//   scr.addstr('hello world');
//
// can be rewritten:
//   waddstr(scr, 'hello world');
//
// if you define:
//   waddstr = generalize(f);
var generalize = function(f) {
  return function() {
    return f.apply(arguments, [].slice.call(arguments, 1));
  };
};

// similar to simplify, but instead of allowing to call without supplying a
// `screen_t' object, allows calling by supplying a position for inserting
// text.
//
// for instance, the function call:
//   scr.addstr(10, 10, 'hello world');
//
// will expand to:
//   scr.move(10, 10);
//   scr.addstr('hello world');
//
// if you define:
//   screen_t.prototype.addstr = shortcut_move(screen_t.prototype.addstr);
var shortcut_move = function(f) {
  return function(y, x) {
    var args = arguments;
    if (typeof y === "number" && typeof x === "number") {
      this.move(y, x);
      args = [].slice.call(arguments, 2);
    }
    return f.apply(this, args);
  };
};

// similar to simplify, but allows the caller to specify text attributes
// (as per attron() and attroff()) as the last argument to the call.
// 
// for instance, the function call:
//   scr.addstr('hello world', A_BOLD | COLOR_PAIR(3));
//
// will expand to:
//   scr.attron(A_BOLD | COLOR_PAIR(3));
//   scr.addstr('hello world');
//   scr.attroff(A_BOLD | COLOR_PAIR(3));
//
// if you define:
//   screen_t.prototype.addstr = attributify(screen_t.prototype.addstr);
var attributify = function(f) {
  return function() {
    var args = arguments;
    var attrs = null;
    var prev_attrs = this.attrs;
    if (arguments.length !== 0) {
      attrs = arguments[arguments.length - 1];
      if (typeof attrs === "number") {
        args = [].slice.call(arguments, 0, arguments.length - 1);
        this.attron(attrs);
      }
    }
    var return_value = f.apply(this, args);
    if (typeof attrs === "number") {
      this.attrset(prev_attrs);
    }
    return return_value;
  };
};


/**
 * Some flags that can be used for attron(), attroff(), and attrset().
 **/
var A_NORMAL = exports.A_NORMAL = 0;
var A_STANDOUT = exports.A_STANDOUT = 0x10000; // TODO
var A_UNDERLINE = exports.A_UNDERLINE = A_STANDOUT << 1; // TODO
var A_REVERSE = exports.A_REVERSE = A_STANDOUT << 2;
var A_BLINK = exports.A_BLINK = A_STANDOUT << 3; // TODO
var A_DIM = exports.A_DIM = A_STANDOUT << 4; // TODO
var A_BOLD = exports.A_BOLD = A_STANDOUT << 5;

/**
 * Use this as a flag for attron(), attroff(), and attrset().
 *
 * Returns a bit mask that corresponds to the attribute for a given color pair.
 * Color pairs are defined as a (foreground,background) pair of colors using
 * the init_pair() function.
 *
 * Color pair 0 is always the default colors.
 *
 * @param {Integer} n The index of the color pair to use.
 * @return {Attrlist} Attribute that corresponds to color pair n.
 **/
var COLOR_PAIR = exports.COLOR_PAIR = function(n) {
  return n * 0x100;
};

// used for only getting the 'color pair' part of an attrlist
var COLOR_MASK = 0xFFFF;

// used for getting the number (n the 0 to COLOR_PAIRS range) of a color
// pair, from an attrlist
var pair_number = function(n) {
  return (n & COLOR_MASK) >> 8;
};

// table of color pairs used for the application
var color_pairs = {
  0: {
    fg: exports.COLOR_WHITE,
    bg: exports.COLOR_BLACK
  }
};

/**
 * Initialize a color pair so it can be used with COLOR_PAIR to describe a
 * given (foreground,background) pair of colours.
 *
 * Color pair 0 is always the default colors.
 *
 * Example:
 *     // define these colors for the rest of the program
 *     init_pair(1, COLOR_RED, COLOR_GREEN);
 *     init_pair(2, COLOR_GREEN, COLOR_RED);
 *     // red foreground, green background
 *     addstr(10, 10, "it's a christmas", COLOR_PAIR(1));
 *     // green foreground, red background
 *     addstr(11, 10, "miracle!", COLOR_PAIR(2));
 *
 * @param {Integer} pair_index Index for the pair to be created.
 * @param {String} foreground Foreground color to be used; must be supported by
 *   the canvas element.
 * @param {String} background Background color to be used; must be supported by
 *   the canvas element.
 **/
// initialize a color pair so it can be used with COLOR_PAIR(n) to describe
// a given (fg,bg) pair of colors.
var init_pair = exports.init_pair = function(pair_index,
                                            foreground, background) {
  color_pairs[pair_index] = {
    fg: foreground,
    bg: background
  };
};


/**
 * Set the new attrlist for the screen to the specified attrlist. Any previous
 * attributes are overwrittent completely.
 *
 * @param {Attrlist} attrs New attributes' values.
 **/
screen_t.prototype.attrset = window_t.prototype.attrset = function(attrs) {
  this.attrs = attrs;
};
exports.attrset = simplify(screen_t.prototype.attrset);

/**
 * Turn on an attribute (or multiple attributes, if you use a binary OR).
 *
 * Example:
 *     // add these attributes
 *     attron(A_BOLD | A_REVERSE | COLOR_PAIR(3));
 *     // in bold, with color pair 3, and foreground/background swapped
 *     addstr("hello world");
 *
 * @param {Attrlist} attrs Attributes to be added.
 **/
screen_t.prototype.attron = window_t.prototype.attron = function(attrs) {
  var color_pair = attrs & COLOR_MASK;
  if (color_pair === 0) {
    color_pair = this.attrs & COLOR_MASK;
  }
  var other_attrs = ((attrs >> 16) << 16);
  other_attrs = other_attrs | ((this.attrs >> 16) << 16);
  var new_attrs = other_attrs | color_pair;
  this.attrset(new_attrs);
};
exports.attron = simplify(screen_t.prototype.attron);

/**
 * Turn off an attribute (or multiple attributes, if you use a binary OR).
 *
 * Example:
 *     // add these attributes
 *     attron(A_BOLD | COLOR_PAIR(1));
 *     addstr("i am bold, and red);
 *     // remove only the color attribute
 *     attroff(COLOR_PAIR(1));
 *     addstr("i am not red, but I am still bold");
 *     // remove the bold attribute
 *     attroff(A_BOLD);
 *     addstr("i am neither red, nor bold");
 *
 * @param {Attrlist} attrs Attributes to be removed.
 **/
screen_t.prototype.attroff = window_t.prototype.attroff = function(attrs) {
  var color_pair = this.attrs & COLOR_MASK;
  var new_attrs = ((attrs >> 16) << 16);
  new_attrs = ~new_attrs & this.attrs;
  if (attrs & COLOR_MASK) {
    new_attrs = new_attrs & ~COLOR_MASK;
  }
  this.attrset(new_attrs);
};
exports.attroff = simplify(screen_t.prototype.attroff);


/**
 * Name constants for keys. Useful for commonly-used keycodes, especially the
 * non-alphanumeric keys. All of their names start with `KEY_`. For instance,
 * there are `KEY_LEFT`, `KEY_UP`, `KEY_ESC`, `KEY_ENTER`, etc.
 *
 * There is also a constant for each letter of the alphabet (`KEY_A`, `KEY_B`,
 * etc.)
 **/
var keys = {
  LEFT: 37,
  UP: 38,
  RIGHT: 39,
  DOWN: 40,
  ESC: 27,
  TAB: 9,
  BACKSPACE: 8,
  HOME: 36,
  END: 35,
  ENTER: 13,
  PAGE_UP: 33,
  PAGE_DOWN: 34
};

var construct_key_table = function() {
  for (var k in keys) {
    exports['KEY_' + k] = keys[k];
  }
  for (k = 'A'.charCodeAt(0); k <= 'Z'.charCodeAt(0); k++) {
    var c = String.fromCharCode(k);
    exports['KEY_' + c] = k;
  }
};
construct_key_table();

// called by initscr() to add keyboard support
var handle_keyboard = function(scr, container, require_focus) {
  // grab keyboard events for the whole page, or the container, depending
  // on the require_focus argument
  var keyboard_target = require_focus ? container : $('body');
  if (require_focus) {
    // apply tabindex="0" so this element can actually receive focus
    container.attr('tabindex', 0);
  }
  keyboard_target.keydown(function(event) {
    if (is_key_press(event)) {
      scr.trigger('keydown', event.which, event, scr);
    }
    // disable most browser shortcuts if the _raw flag is on for the window
    return ! scr._raw;
  });
};

/**
 * Disable most browser shortcuts, allowing your application to use things like
 * Ctrl+C and Ctrl+T as keybindings within the application. 
 *
 * You may want to use the `require_focus` option in initscr() if you use this
 * function.
 **/
screen_t.prototype.raw = function() {
  this._raw = true;
};
exports.raw = simplify(screen_t.prototype.raw);

/**
 * Enables most browser shortcuts; undoes a previous call to raw(). This is
 * the default behaviour.
 **/
screen_t.prototype.noraw = function() {
  this._raw = false;
};
exports.noraw = simplify(screen_t.prototype.nowraw);

/**
 * All characters typed by the user are printed at the cursor's position.
 *
 * TODO
 **/
var echo = exports.echo = function() {
  this._echo = true;
};

/**
 * All characters not typed by the user are printed at the cursor's position.
 * Undoes a previous call to echo(). This is the default behaviour.
 **/
var noecho = exports.noecho = function() {
  this._echo = false;
};

/**
 * Enables non-printable characters to also be grabbed as keyboard events
 * (especially arrow keys, among others).
 *
 * TODO
 **/
var keypad = exports.keypad = function() {};


/**
 * Create a new screen, set is at the default screen, and return it.
 *
 * A screen uses an HTML Canvas element as its display in order to render
 * characters on-screen; it needs to have a specified, fixed, height and width,
 * and a specified, fixed, font and font size.
 *
 * The created screen is set as the "default screen". This allows calling
 * all js-curses in a C-style way, without explicitly specifying the screen
 * most method calls apply to, assuming initscr() is called only once for the
 * webpage. For instance, the following are legal:
 *
 *     // creating the screen
 *     var screen = initscr({
 *       container: '#container',
 *       height: 30,
 *       width: 30,
 *       font: {
 *         type: 'ttf',
 *         name: 'Oxygen Mono',
 *         height: 14
 *       },
 *       require_focus: true
 *     });
 *     // explicitly calling screen.move() and screen.addstr()
 *     screen.move(10, 10);
 *     screen.addstr("hello world");
 *     // implicitly calling screen.move() and screen.addstr()
 *     move(11, 10);
 *     screen.addstr("bonjour world");
 *     // updating the display
 *     refresh(); // or screen.refresh()
 *
 * The created screen is contained within the DOM element `container`; if
 * `container` is a string, it is used as a CSS selector with jQuery; if it
 * is undefined, a DOM element is created to hold the screen.
 *
 * The dimensions of the screen, in columns and rows (character-wise), are
 * specified by the `height` and `width` arguments.
 *
 * The font to use must be specified by the `font_name` and `font_size`
 * arguments. See load_ttf_font() and load_bmp_font() for more information on
 * font loading.
 *
 * If `require_focus` is true, the screen will only grab keyboard events when
 * it receives focus; additionally, it will make sure that it has a way to
 * grab the keyboard focus, by setting the HTML "tabindex" attribute for its
 * container. If `require_focus` is false or unspecified, then the screen
 * will grab all keyboard events on the webpage, which may get in the way
 * of the web browser's shortcuts, and a lot of other things.
 *
 * Examples:
 *     // ttf font:
 *     initscr({
 *       container: '#container',
 *       height: 60,
 *       width: 80,
 *       font: {
 *         type: 'ttf',
 *         name: 'Source Code Pro',
 *         height: 12
 *       },
 *       require_focus: true
 *     });
 *     // bitmap font:
 *     var char_table = [
 *       'abcdefghijklmnopqrstuvwxyz', // each line corresponds to a line inside
 *       'ABCDEFGHIJKLMNOPQRSTUVWXYZ', // the image to be loaded
 *       ' ,.!@#$%?&*()[]{}'
 *     ];
 *     initscr({
 *       container: '#canvas',
 *       height: 30,
 *       width: 40,
 *       font: {
 *         type: 'bmp',
 *         name: 'my_image.png',
 *         height: 16,
 *         width: 8
 *       },
 *       require_focus: true
 *     });
 * 
 * @param {Object} opts Options object for the initscr() function.
 * @param {String|HTMLElement|jQuery} [opts.container=$('<pre></pre>')] HTML
 * element or CSS selector for the element that will wrap the <canvas> element
 * used for drawing.
 * @param {Integer} opts.height Height of the screen, in characters.
 * @param {Integer} opts.width Width of the screen, in chracters.
 * @param {Boolean} [opts.require_focus=false] Whether focus is required for
 * keyboard events to be registered; if `true`, forces `opts.container` to be
 * able to receive keyboard focus, by setting its `tabindex` HTML attribute.
 * @param {Object} opts.font Object describing the font to use.
 * @param {String} [opts.font.type="ttf"] Either "ttf" or "bmp"; says which type
 * of font should be loaded. "ttf" indicates that it is a font name, and "bmp"
 * indicates that the font should be loaded from an image.
 * @param {String} opts.font.name For a TTF, indicates the name of the font. The
 * filetype should not be added to the end for TTF fonts. For a BMP font,
 * indicates the path for downloading the .png image for the font. The image
 * should be composed of characters with set height and width, in a grid
 * disposition, and starting from pixel (0,0) in the image. In any case, the
 * font that you want to load should already have been preloaded by the browser
 * before `initscr()` is called.
 * @param {Integer} opts.font.height Height, in pixels, of a character from the
 * loaded font.
 * @param {Integer} opts.font.width Width, in pixels, of a character from the
 * loaded font. Only relevant if a BMP font is loaded, and must be supplied if a
 * BMP font is loaded.
 * @param {Integer} [opts.font.line_spacing=0] Number of pixels between two
 * lines of text.
 * @param {Array[String]} opts.font.chars Each array element describes a line in
 * the image for the BMP font being loaded. Each element should be a string that
 * describes the contiguous characters on that line. See the example code.
 **/
var initscr = exports.initscr = function(opts) {
  // check arg validity
  check_initscr_args.apply(this, arguments);
  // set some default values for arguments
  opts.require_focus |= false;
  opts.font.type = /^bmp$/i.test(opts.font.type) ? "bmp" : "ttf";
  opts.font.line_spacing |= 0;
  // `container` can either be a DOM element, or an ID for a DOM element
  if (opts.container !== undefined) {
    opts.container = $(opts.container);
  }
  else {
    opts.container = $('<pre></pre>');
  }
  // clear the container
  opts.container.html('');
  // create a new screen_t object
  var scr = new screen_t();
  scr.container = opts.container;
  // set the height, in characters
  scr.height = opts.height;
  scr.width = opts.width;
  // create the canvas
  scr.canvas = $('<canvas></canvas>');
  scr.container.append(scr.canvas);
  scr.context = scr.canvas[0].getContext('2d');
  // load the specified font
  // TODO: specify sane default values
  if (opts.font.type === "ttf") {
    load_ttf_font(scr, opts.font.name, opts.font.height, opts.font.line_spacing);
  }
  else {
    load_bitmap_font(scr, opts.font.name, opts.font.height, opts.font.width,
		     opts.font.chars, opts.font.line_spacing);
  }
  // initialize the character tiles to default values
  var y, x;
  for (y = 0; y < opts.height; y++) {
    scr.tiles[y] = [];
    for (x = 0; x < opts.width; x++) {
      scr.tiles[y][x] = new tile_t();
    }
  }
  // set the created window as the default window for most operations
  // (so you can call functions like addstr(), getch(), etc. directly)
  default_screen = scr;
  // draw a background
  scr.clear();
  // add keyboard hooks
  handle_keyboard(scr, opts.container, opts.require_focus);
  // make a blinking cursor
  // TODO: reimplement blinking
  // startBlink(scr);
  // return the created window
  return scr;
};

// helper function for checking the type & validity of arguments to initscr()
var check_initscr_args = function(opts) {
  if (typeof opts !== "object") {
    throw new TypeError("opts is not an object");
  }
  if (typeof opts.height !== "number") {
    throw new TypeError("height is not a number");
  }
  if (opts.height < 0) {
    throw new RangeError("height is negative");
  }
  if (typeof opts.width !== "number") {
    throw new TypeError("width is not a number");
  }
  if (opts.width < 0) {
    throw new RangeError("width is negative");
  }
  if (typeof opts.font !== "object") {
    throw new TypeError("font is not an object");
  }
  if (typeof opts.font.name !== "string" ) {
    throw new TypeError("font.name is not a string");
  }
  if (typeof opts.font.height !== "number") {
    throw new TypeError("font.height is not a number");
  }
  if (/^bmp$/i.test(opts.font.name)) {
    if (typeof opts.font.width !== "number") {
      throw new TypeError("font.width is not a number, for a BMP font");
    }
    if (! (opts.font.chars instanceof Array)) {
      throw new TypeError("font.chars is not an array");
    }
  }
  if (opts.font.line_spacing && typeof opts.font.line_spacing !== "number") {
    throw new TypeError("font.line_spacing is not a number");
  }
  if (opts.font.line_spacing && opts.font.line_spacing < 0) {
    throw new TypeError("font.line_spacing is negative");
  }
};

/**
 * Enable a blinking cursor.
 *
 * TODO
 **/
screen_t.prototype.blink = function() {
  if (! this._blink) {
    startBlink(this);
  }
  this._blink = true;
};
exports.blink = simplify(screen_t.prototype.blink);

/**
 * Disable a blinking cursor.
 *
 * TODO
 **/
screen_t.prototype.noblink = function() {
  if (this._blink) {
    this.tiles[this.y][this.x].element.addClass('a-reverse');
    clearTimeout(this._blinkTimeout);
    this._blinkTimeout = 0;
  }
  this._blink = false;
};
exports.noblink = simplify(screen_t.prototype.noblink);

/**
 * Quit js-curses.
 * 
 * TODO
 **/
screen_t.prototype.endwin = function() {
};
exports.endwin = simplify(screen_t.prototype.endwin);


// keys that are to be ignored for the purposes of events
// TODO
var ignoreKeys = {
  Control: true,
  Shift: true,
  Alt: true,
  AltGraph: true,
  Unidentified: true
};

// return true iff the KeyboardEvent `event' is an actual keypress of a
// printable character, not just a modifier key (like Ctrl, Shift, or Alt)
var is_key_press = function(event) {
  // TODO
  return ! ignoreKeys[event.key];
};

// used for making a blinking cursor
// TODO: rewrite for canvas
var startBlink = function(scr) {
  var do_blink = function() {
    scr.tiles[scr.y][scr.x].element.addClass('a-reverse');
    scr._blinkTimeout = setTimeout(do_unblink, BLINK_DELAY);
  };
  var do_unblink = function() {
    scr.tiles[scr.y][scr.x].element.removeClass('a-reverse');
    scr._blinkTimeout = setTimeout(do_blink, BLINK_DELAY);
  };
  scr._blinkTimeout = setTimeout(do_blink, BLINK_DELAY);
};

/**
 * Move the cursor to a given position on the screen. If the position is outside
 * of the screen's bound, a RangeError is thrown.
 *
 * All output from addch() and addstr() is done at the position of the cursor.
 *
 * @param {Integer} y y position of the new position.
 * @param {Integer} x x position of the new position.
 * @throws RangeError
 **/
screen_t.prototype.move = window_t.prototype.move = function(y, x) {
  if (y < 0 || y >= this.height || x < 0 || x >= this.width) {
    throw new RangeError("coordinates out of range");
  }
  // var tile = this.tiles[this.y][this.x];
  // TODO: handle blinking/unblinking on move
  this.y = y;
  this.x = x;
};
exports.move = simplify(screen_t.prototype.move);


// number of chars saved per off-screen canvas
var CHARS_PER_CANVAS = 256;

// Load a font with given attributes `font_name` and `font_size`. You should
// ensure that the font has already been loaded by the browser before calling
// `load_font`. The bold variant of the font should already have been loaded,
// if you intend to use it. The usual way to do this is to insert an element
// that uses that font in your webpage's HTML. This function is automatically
// called by `initscr`.
//
// Print warning messages to the web console when the font does not appear to
// be a monospace font.
//
// @param {String} font_name Name of the font to be loaded.
// @param {Integer} font_size Size of the font to be loaded.
// @param {Integer} line_spacing Number of pixels between two lines of text.
var load_ttf_font = function(scr, font_name, font_size, line_spacing) {
  scr.context.font = 'Bold ' + font_size + 'px ' + font_name;
  scr.context.textAlign = 'left';
  var c = 'm';
  // calculate the probable font metrics
  var metrics = scr.context.measureText(c);
  var height = Math.round(font_size + line_spacing);
  var width = Math.round(metrics.width);
  // check that it's (probably) a monospace font
  var testChars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ" + 
    "_-+*@ ()[]{}/\\|~`,.0123456789";
  var i;
  for (i = 0; i < testChars.length; i++) {
    c = testChars[i];
    metrics = scr.context.measureText(c);
    if (Math.round(metrics.width) !== width) {
      console.warn(font_name + ' does not seem to be a monospace font');
    }
  }
  // resize the canvas
  scr.canvas.attr({
    height: Math.round(scr.height * height),
    width: Math.round(scr.width * width)
  });
  // save the currently used font
  scr.font = {
    type: "ttf",
    name: font_name,
    size: font_size,
    char_height: height,
    char_width: width,
    line_spacing: line_spacing
  };
  // create the canvas pool for drawing offscreen characters
  scr.canvas_pool = {
    normal: {
      x: 0,
      canvases: null
    },
    bold: {
      x: 0,
      canvases: null
    }
  };
  var offscreen = make_offscreen_canvas(scr.font);
  offscreen.ctx.font = font_size + 'px ' + font_name;
  scr.canvas_pool.normal.canvases = [offscreen];
  offscreen = make_offscreen_canvas(scr.font);
  offscreen.ctx.font = 'Bold ' + font_size + 'px ' + font_name;
  scr.canvas_pool.bold.canvases = [offscreen];
};

// last arguments are slurped for the char map (to know which
// character is where in the image)
//
// @param {String|HTMLImageElement} bitmap The image to use for
//   drawing
// @param {Integer} char_height Height of a character in the bitmap.
// @param {Integer} char_width Width of a character in the bitmap.
// @param {Array[String]} chars A string for each line in the bitmap
//   file; each character in the string corresponds to a character on
//   that line in the bitmap file.
// @param {Integer} line_spacing Number of pixels between two lines of text.
var load_bitmap_font = function(scr, bitmap, char_height, char_width, chars,
			        line_spacing) {
  if (typeof bitmap === "string") {
    bitmap = $('<img src="' + bitmap + '" />')[0];
  }
  char_height += line_spacing;
  var char_map = {};
  var y, x;
  for (y = 0; y < chars.length; y++) {
    for (x = 0; x < chars[y].length; x++) {
      if (! char_map[chars[y][x]]) {
	char_map[chars[y][x]] = [y, x];
      }
    }
  }
  scr.canvas.attr({
    height: Math.round(scr.height * char_height),
    width: Math.round(scr.width * char_width)
  });
  scr.font = {
    type: "bmp",
    bitmap: bitmap,
    char_height: char_height,
    char_width: char_width,
    char_map: char_map,
    line_spacing: line_spacing
  };
  // create the canvas pool for drawing offscreen characters
  scr.canvas_pool = {
    normal: {
      x: 0,
      canvases: null
    }
  };
  var offscreen = make_offscreen_canvas(scr.font);
  scr.canvas_pool.normal.canvases = [offscreen];
  // a very small, very temporary, canvas, for drawing the characters before
  // changing their color
  var small_offscreen = $('<canvas></canvas>');
  small_offscreen.attr({
    height: char_height,
    width: char_width
  });
  scr.small_offscreen = small_offscreen[0];
};

/**
 * Clear the whole window immediately, without waiting for the next refresh. Use
 * this sparingly, as this can cause very bad performance if used too many
 * times per second.
 **/
screen_t.prototype.clear = function() {
  // window height and width
  var height = this.height * this.font.char_height;
  var width = this.width * this.font.char_width;
  // clear the window
  this.context.fillStyle = color_pairs[0].bg;
  this.context.fillRect(0, 0, width, height);
  // reset all the character tiles
  var y, x;
  for (y = 0; y < this.height; y++) {
    for (x = 0; x < this.width; x++) {
      var tile = this.tiles[y][x];
      tile.content = this.empty_char;
      tile.empty = true;
      tile.attrs = A_NORMAL;
    }
  }
};
exports.clear = simplify(screen_t.prototype.clear);

/**
 * Push the changes made to the buffer, such as those made with addstr() and
 * addch(). The canvas is updated to reflect the new state of the window. Uses
 * differential display to optimally update only the parts of the screen that
 * have actually changed.
 *
 * Note that functions like addstr() and addch() will not do anything until
 * refresh() is called.
 **/
screen_t.prototype.refresh = function() {
  // for each changed character
  var scr = this;
  var drawfunc = function(y, x, c, attrs) {
    draw_char(scr, y, x, c, attrs);
  };
  refresh_window(this, 0, 0, drawfunc);
  this.changes = {};
};
exports.refresh = simplify(screen_t.prototype.refresh);

// refresh a window
var refresh_window = function(win, dy, dx, drawfunc) {
  var i;
  for (i = 0; i < win.subwindows.length; i++) {
    var subwin = win.subwindows[i];
    refresh_window(subwin, dy + win.win_y, dx + win.win_x, drawfunc);
  }
  var k;
  for (k in win.changes) {
    var change = win.changes[k];
    var pos = change.at;
    if (win.tiles[pos.y][pos.x].exposed) {
      drawfunc(pos.y + win.win_y + dy, pos.x + win.win_x + dx, 
               change.value, change.attrs);
    }
  }
};

window_t.prototype.expose =
  screen_t.prototype.expose = function(y, x, height, width) {
  var j, i;
  for (j = y; j < y + height; j++) {
    for (i = x; i < x + width; i++) {
      var tile = this.tiles[y][x];
      tile.exposed = true;
      this.addch(y, x, tile.content, tile.attrs);
    }
  }
};

window_t.prototype.unexpose = 
  screen_t.prototype.unexpose =function(y, x, height, width) {
  var j, i;
  for (j = y; j < y + height; j++) {
    for (i = x; i < x + width; i++) {
      this.tiles[j][i].exposed = false;
    }
  }
};

/**
 * Output a single character to the console, at the current position, as
 * specified by `move` (or move to the given position, and then output the
 * given character).
 *
 * The cursor is moved one position to the right. If the end of the line is
 * reached, the cursor moves to the next line and returns to column 0.
 *
 * All current attributes (see attron(), attroff(), and attrset()) are applied
 * to the output. You may also supply a temporary attrlist as a last argument
 * to this function.
 *
 * Note that the visual display (the canvas) is not updated until the
 * refresh() function is called.
 *
 * TODO: implement tab and newline characters
 *
 * @param {Integer} [y] y position for output.
 * @param {Integer} [x] x position for output.
 * @param {Character} c Character to be drawn.
 * @param {Attrlist} [attrs] Temporary attributes to be applied.
 **/
screen_t.prototype.addch = window_t.prototype.addch = function(c) {
  if (typeof c !== "string") {
    throw new TypeError("c is not a string");
  }
  if (c.length !== 1) {
    throw new RangeError("c is not a character");
  }
  if (this.x >= this.width || this.x < 0) {
    throw new RangeError("invalid coordinates");
  }
  // treat all whitespace as a single space character
  if (c === '\t' || c === '\n' || c === '\r') {
    c = this.empty_char;
  }
  var tile = this.tiles[this.y][this.x];
  // only do this if the content (or attrlist) changed
  if (c !== tile.content || this.attrs !== tile.attrs) {
    // update the tile
    tile.content = c;
    tile.empty = false;
    tile.attrs = this.attrs;
    // add an instruction to the 'changes queue'
    this.changes[this.y + ','  + this.x] = {
      at: {
        y: this.y,
        x: this.x
      },
      value: c,
      attrs: this.attrs
    };
  }
  // move to the right
  if (this.x < this.width - 1) {
    this.move(this.y, this.x + 1);
  }
  else if (this.y < this.height - 1) {
    // or continue to next line if the end of the line was reached
    this.move(this.y + 1, 0);
  }
}; 
// allow calling as addch(y, x, c);
screen_t.prototype.addch = shortcut_move(screen_t.prototype.addch);
screen_t.prototype.addch = attributify(screen_t.prototype.addch);
window_t.prototype.addch = shortcut_move(window_t.prototype.addch);
window_t.prototype.addch = attributify(window_t.prototype.addch);
exports.addch = simplify(screen_t.prototype.addch);

/**
 * Output a string to the console, at the current position, as specified by
 * `move` (or move to the given position, and then output the
 * given character).
 *
 * The cursor is moved to the end of the text. If the end of the line is
 * reached, the cursor moves to the next line, the cursor returns to column 0,
 * and text output continues on the next line.
 *
 * All current attributes (see attron(), attroff(), and attrset()) are applied
 * to the output. You may also supply a temporary attrlist as a last argument
 * to this function.
 *
 * Note that the visual display (the canvas) is not updated until the
 * refresh() function is called.
 *
 * TODO: implement tab and newline characters
 * TODO: correctly handle end of line errors
 *
 * @param {Integer} [y] y position for output.
 * @param {Integer} [x] x position for output.
 * @param {Character} str Character to be drawn.
 * @param {Attrlist} [attrs] Temporary attributes to be applied.
 **/
screen_t.prototype.addstr = window_t.prototype.addstr = function(str) {
  var i;
  for (i = 0; i < str.length && this.x < this.width; i++) {
    this.addch(str[i]);
  }
  if (i !== str.length) {
    throw new RangeError("not enough room to add the whole string");
  }
}; 
// allow calling as addstr(y, x, str);
screen_t.prototype.addstr = shortcut_move(screen_t.prototype.addstr);
screen_t.prototype.addstr = attributify(screen_t.prototype.addstr);
window_t.prototype.addstr = shortcut_move(window_t.prototype.addstr);
window_t.prototype.addstr = attributify(window_t.prototype.addstr);
exports.addstr = simplify(screen_t.prototype.addstr);

// used for creating an off-screen canvas for pre-rendering characters
var make_offscreen_canvas = function(font) {
  var canvas = $('<canvas></canvas>');
  canvas.attr({
    height: font.char_height,
    width: CHARS_PER_CANVAS * font.char_width
  });
  canvas.ctx = canvas[0].getContext('2d');
  canvas.ctx.textBaseline = 'hanging';
  return canvas;
};

// draw a character at pixel-pos (x,y) on window `scr`
//
// the character drawn is `c`, with attrlist `attrs`, and may be pulled
// from the canvas cache ̀`char_cache`
//
// draw_char() is used by refresh() to redraw characters where necessary
var draw_char = function(scr, y, x, c, attrs) {
  var offscreen = find_offscreen_char(scr, c, attrs);
  if (! offscreen) {
    // silently fail, and return false
    return false;
  }
  // apply the drawing onto the visible canvas
  y = Math.round(y * scr.font.char_height);
  x = Math.round(x * scr.font.char_width);
  scr.context.drawImage(offscreen.src,
                        offscreen.sx, offscreen.sy,
                        scr.font.char_width, scr.font.char_height,
                        x, y,
                        scr.font.char_width, scr.font.char_height);
  // return true for success
  return true;
};

// used by draw_char for finding (or creating) a canvas where the character
// `c` is drawn with attrlist `attrs`
//
// the return value is an object of the format:
// {
//   src: (canvas element),
//   sy: (Y position of the character on the canvas element),
//   sx: (X position of the character on the canvas element)
// }
var find_offscreen_char = function(scr, c, attrs) {
  // check if it's a (c,attrs) pair that's already been drawn before;
  // if it is, use the same character as before
  var found = find_in_cache(scr, c, attrs);
  if (found) {
    return found;
  }
  // not found, draw the character on an offscreen canvas, and add it
  // to the cache
  grow_canvas_pool(scr);
  if (scr.font.type === "ttf") {
    // TTF font
    return draw_offscreen_char_ttf(scr, c, attrs);
  }
  else if (scr.font.type === "bmp") {
    // bitmap font
    return draw_offscreen_char_bmp(scr, c, attrs);
  }
  else {
    // unrecognized font-type
    throw new Error("invalid font");
  }
};

// return an object describing where the character is if it can be
// found in the `char_cache`. if it cannot be found, return null.
var find_in_cache = function(scr, c, attrs) {
  var char_cache = scr.char_cache;
  if (char_cache[c] && char_cache[c][attrs]) {
    // found, return an object describing where the character is
    return char_cache[c][attrs];
  }
  // not found, return a value indicating that
  return null;
};

// add a canvas to the canvas pool if necessary, so that an offscreen
// character never ends up being drawn outside of its corresponding
// offscreen canvas (by being drawn too far to the right)
var grow_canvas_pool = function(scr) {
  var k;
  for (k in scr.canvas_pool) {
    var pool = scr.canvas_pool[k];
    if (pool.x >= CHARS_PER_CANVAS - 1) {
      pool.x = 0;
      var canvas = make_offscreen_canvas(scr.font);
      canvas.ctx.font = pool.canvases[pool.canvases.length - 1].ctx.font;
      pool.canvases.push(canvas);
    }
  }
};

var draw_offscreen_char_bmp = function(scr, c, attrs) {
  // used for storing the drawn character in case it has to be redrawn
  // (for better performacne)
  var char_cache = scr.char_cache;
  // calculate the colours for everything
  var color_pair = pair_number(attrs);
  var bg = color_pairs[color_pair].bg;
  var fg = color_pairs[color_pair].fg;
  // calculate where to draw the character
  var pool = scr.canvas_pool.normal;
  var canvas = pool.canvases[pool.canvases.length - 1];
  var ctx = canvas.ctx;
  var sy = 0;
  var sx = Math.round(pool.x * scr.font.char_width);
  // save info in the char cache
  if (! char_cache[c]) {
    char_cache[c] = {};
  }
  scr.char_cache[c][attrs] = {
    src: canvas[0],
    sy: sy,
    sx: sx
  };
  if (! scr.font.char_map[c]) {
    // silently fail if we don't know where to find the character on
    // the original bitmap image
    return null;
  }
  // calculate coordinates from the source image
  var bitmap_y = scr.font.char_map[c][0] *
	(scr.font.char_height - scr.font.line_spacing);
  bitmap_y = Math.round(bitmap_y);
  var bitmap_x = scr.font.char_map[c][1] * scr.font.char_width;
  bitmap_x = Math.round(bitmap_x);
  // draw a background
  ctx.fillStyle = (attrs & A_REVERSE) ? fg : bg;
  ctx.fillRect(sx, sy, scr.font.char_width, scr.font.char_height);
  // draw the character on a separate, very small, offscreen canvas
  var small = scr.small_offscreen.getContext('2d');
  var height = scr.font.char_height;
  var width = scr.font.char_width;
  small.clearRect(0, 0, width, height);
  small.drawImage(scr.font.bitmap,
		  bitmap_x, bitmap_y,
		  width, height,
		  0, 0,
		  width, height);
  // for each non-transparent pixel on the small canvas, draw the pixel
  // at the same position onto the 'main' offscreen canvas
  var pixels = small.getImageData(0, 0, width, height).data;
  ctx.fillStyle = (attrs & A_REVERSE) ? bg : fg;
  var y, x;
  for (y = 0; y < height - scr.font.line_spacing; y++) {
    for (x = 0; x < width; x++) {
      var alpha = pixels[(y * width + x) * 4 + 3];
      if (alpha !== 0) {
	// TODO: use putImageData() to improve performance in some
	// browsers
	// ctx.putImageData(dot, sx + x, sy + y);
	var dst_x = Math.round(sx + x);
	var dst_y = Math.round(sy + y + scr.font.line_spacing / 2);
	ctx.fillRect(dst_x, dst_y, 1, 1);
      }
    }
  }
  // increment the canvas pool's counter: move to the next character
  pool.x++;
  // return an object telling where to find the offscreen character
  return char_cache[c][attrs];
};

var draw_offscreen_char_ttf = function(scr, c, attrs) {
  // used for storing the drawn character in case it has to be redrawn
  // (for better performance)
  var char_cache = scr.char_cache;
  // calculate the colours for everything
  var color_pair = pair_number(attrs);
  var bg = color_pairs[color_pair].bg;
  var fg = color_pairs[color_pair].fg;
  // calculate where to draw the character
  var pool = (attrs & A_BOLD) ? scr.canvas_pool.bold : scr.canvas_pool.normal;
  var canvas = pool.canvases[pool.canvases.length - 1];
  var ctx = canvas.ctx;
  var sy = 0;
  var sx = Math.round(pool.x * scr.font.char_width);
  // save info in the char cache
  if (! char_cache[c]) {
    char_cache[c] = {};
  }
  scr.char_cache[c][attrs] = {
    src: canvas[0],
    sy: sy,
    sx: sx
  };
  // draw a background
  ctx.fillStyle = (attrs & A_REVERSE) ? fg : bg;
  ctx.fillRect(sx, sy, scr.font.char_width, scr.font.char_height);
  // draw the character
  ctx.fillStyle = (attrs & A_REVERSE) ? bg : fg;
  ctx.fillText(c, sx, Math.round(sy + scr.font.line_spacing / 2));
  // increment the canvas pool's counter: move to the next character
  pool.x++;
  // return an object telling where to find the offscreen character
  return char_cache[c][attrs];
};



/**
 * Create a new window at position (y,x), with height `height` and width
 * `width`. The parent window is the object newwin() is applied on (or the
 * default screen, it applicable). The child window is returned by this 
 * function.
 *
 * The child window is always drawn over the content of the parent window,
 * even if the child window is empty (it will simply draw empty chars, most
 * likely empty space, unless bkgd() is called).
 *
 * The created window starts being drawn on the next refresh() call.
 *
 * @param {Integer} y y position of the window, in characters.
 * @param {Integer} x x position of the window, in characters.
 * @param {Integer} height height of the window, in characters.
 * @param {Integer} width width of the window, in characters.
 * @return {window_t} The created child window.
 **/
window_t.prototype.newwin = 
  screen_t.prototype.newwin = function(y, x, height, width) {
  if (typeof y !== "number") {
    throw new TypeError("y is not a number");
  }
  if (y < 0) {
    throw new RangeError("y is negative");
  }
  if (typeof x !== "number") {
    throw new TypeError("x is not a number");
  }
  if (x < 0) {
    throw new RangeError("x is negative");
  }
  if (typeof height !== "number") {
    throw new TypeError("height is not a number");
  }
  if (height < 0) {
    throw new RangeError("height is negative");
  }
  if (typeof width !== "number") {
    throw new TypeError("width is not a number");
  }
  if (width < 0) {
    throw new RangeError("width is negative");
  }
  // create the window
  var win = new window_t();
  win.win_y = y;
  win.win_x = x;
  win.height = height;
  win.width = width;
  win.parent = this;
  // add to parent's subwindows
  this.subwindows.push(win);
  // create the 2D array of tiles
  for (j = 0; j < height; j++) {
    win.tiles[j] = [];
    for (i = 0; i < width; i++) {
      win.tiles[j][i] = new tile_t();
    }
  }
  // draw each tile
  for (j = 0; j < height; j++) {
    for (i = 0; i < width; i++) {
      win.addch(j, i, win.empty_char);
      win.tiles[j][i].empty = true;
    }
  }
  // undraw each 'covered' tile in the parent
  this.unexpose(y, x, height, width);
  // return the created window
  return win;
};
exports.newwin = simplify(screen_t.prototype.newwin);

/**
 * Draw the background character `c`, using attrlist `attrs`, as the new
 * background character for the window. All the places that are already filled
 * with the current background character are replaced with the new one on
 * next refresh() call.
 *
 * @param {Character} c New background character.
 * @param {Attrlist} attrs New attrlist for the background.
 **/
window_t.prototype.bkgd = function(c, attrs) {
  attrs |= 0;
  var y, x;
  for (y = 0; y < this.height; y++) {
    for (x = 0; x < this.width; x++) {
      if (this.tiles[y][x].empty) {
        this.addch(y, x, c, attrs);
        this.tiles[y][x].empty = true;
      }
    }
  }
  this.empty_char = c;
  this.empty_attrs = attrs;
};

/**
 * Draw a box around the window, using the border() function, but in a simpler
 * way. Use box() instead of border() when all corners use the same character,
 * all vertical borders use the same character, and all horizontal borders use
 * the same character.
 *
 * `corner` is the character used to draw the four corners of the box;
 * `vert` is the character used to draw the left and right borders; and
 * `horiz` is the character used to draw the top and bottom borders.
 *
 * You can call this function specifying only character arguments, in which
 * case the window's current default attributes are used for the characters.
 * You can also specify an attrlist argument after each character argument
 * in order to force each character's attributes to the specified values.
 *
 * For instance, you can call box() by doing:
 *     win.box('+', '|', '-'); // default attributes for everything
 *     win.box('+', A_BOLD, '|', '-', A_BOLD); // corners and top/bottom borders
 *                                             // are bold; left/right borders
 *                                             // are normal
 *
 * @param {ChType} [corner='+'] One, or two arguments, that describe the 
 *   character for the corners, and its attributes.
 * @param {ChType} [vert='|'] One, or two arguments, that describe the character
 *   for the left and right borders, and its attributes.
 * @param {ChType} [horiz='-'] One, or two arguments, that describe the
 *   character for the left and right borders, and its attributes.
 **/
window_t.prototype.box = function(corner, vert, horiz) {
  var defaults = ['+', '|', '-'];
  var chars = parse_chtypes(arguments, defaults, this);
  corner = chars[0];
  vert = chars[1];
  horiz = chars[2];
  this.border(vert.value, vert.attrs, vert.value, vert.attrs,
              horiz.value, horiz.attrs, horiz.value, horiz.attrs,
              corner.value, corner.attrs, corner.value, corner.attrs,
              corner.value, corner.attrs, corner.value, corner.attrs);
};

window_t.prototype.border = function(ls, rs, ts, bs, tl, tr, bl, br) {
  var defaults = ['│', '│', '─', '─', '┌', '┐', '└', '┘'];
  var chars = parse_chtypes(arguments, defaults, this);
  // draw corners
  console.log(arguments);
  console.log(chars);
  this.addch(0, 0, chars[4].value, chars[4].attrs);
  this.addch(0, this.width - 1, chars[5].value, chars[5].attrs);
  this.addch(this.height - 1, 0, chars[6].value, chars[6].attrs);
  this.addch(this.height - 1, this.width - 1, chars[7].value, chars[7].attrs);
  // draw borders
  var y, x;
  for (y = 1; y < this.height - 1; y++) {
    this.addch(y, 0, chars[0].value, chars[0].attrs);
    this.addch(y, this.width - 1, chars[1].value, chars[1].attrs);
  }
  for (x = 1; x < this.width - 1; x++) {
    this.addch(0, x, chars[2].value, chars[2].attrs);
    this.addch(this.height - 1, x, chars[3].value, chars[3].attrs);
  }
};

// helper function for passing arguments to box() and border()
var parse_chtypes = function(arglist, defaults, win) {
  var chars = [];
  var i, j;
  for (i = 0, j = 0; i < arglist.length; i++, j++) {
    if (typeof arglist[i] === "string" || arglist[i].length !== 1) {
      var ch = {
        value: arglist[i]
      };
      if (typeof arglist[i + 1] === "number") {
        ch.attrs = arglist[i + 1];
        i++;
      }
      else {
        ch.attrs = win.attrs;
      }
      chars.push(ch);
    }
    else {
      throw new TypeError("expected a character for argument " + (i + 1));
    }
  }
  while (j < defaults.length) {
    chars.push({
      value: defaults[j],
      attrs: win.attrs
    });
    j++;
  }
  return chars;
};

/**
 * Delete a window, and remove it from its parent window. Force a redraw
 * on the part of the parent window that was being covered by this window.
 * The redraw only happens when refresh() is next called.
 * 
 * TODO
 **/
window_t.prototype.delwin = function() {
  // force a redraw on the parent, in the area corresponding to this window
  this.parent.expose(this.win_y, this.win_x, this.height, this.width);
  // remove from the parent's subwindows
  var i;
  for (i = 0; i < this.parent.subwindows.length; i++) {
    if (this.parent.subwindows[i] === this) {
      break;
    }
  }
  if (i !== this.parent.subwindows.length) {
    this.parent.subwindows.splice(i, 1);
  }
};


/**
 * Trigger an event on the window, with name `event_name`.
 *
 * Call all the event handlers bound to that event, and pass any other arguments
 * given to trigger() to each even handler.
 *
 * @param {String} event_name Name of the event to be fired.
 **/
screen_t.prototype.trigger = function(event_name) {
  if (this.listeners[event_name]) {
    var args = [].slice.call(arguments, 1);
    var i;
    for (i = 0; i < this.listeners[event_name].length; i++) {
      this.listeners[event_name][i].apply(this, args);
    }
  }
};

/**
 * Add an event handler for the event with name `event_name`.
 *
 * @param {String} event_name Name of the event to listen to.
 * @param {Function} callback Function that will be called when the event is
 *   fired.
 **/
screen_t.prototype.on = function(event_name, callback) {
  if (! this.listeners[event_name]) {
    this.listeners[event_name] = [];
  }
  this.listeners[event_name].push(callback);
};

/**
 * Remove an event handler for the event with name `event_name`. This removes
 * an event handler that was previously added with on().
 *
 * @param {String} event_name Name of the event the handler was bound to.
 * @param {Function} callback Function that was passed to on() previously.
 **/
screen_t.prototype.off = function(event_name, callback) {
  if (! this.listeners[event_name]) {
    this.listeners[event_name] = [];
  }
  var i;
  for (i = 0; i < this.listeners[event_name].length; i++) {
    if (this.listeners[event_name][i] == callback) {
      break;
    }
  }
  if (i !== this.listeners[event_name].length) {
    this.listeners[event_name].splice(i, 1);
  }
};

/**
 * Add an event handler for the event with name `event_name`. The event handler
 * is removed after executing once.
 *
 * @param {String} event_name Name of the event to listen to.
 * @param {Function} callback Function that will be called when the event is
 *   fired.
 **/
screen_t.prototype.one = function(event_name, callback) {
  var scr = this;
  var f = function() {
    callback.apply(this, arguments);
    scr.off(event_name, f);
  };
  this.on(event_name, f);
};

/**
 * Call function `callback` only once, when a key is entered by the user (if
 * the screen has focus). `callback` will receive an event object as its first
 * argument.
 *
 * The description of the event object is still subject to change.
 *
 * @param {Function} callback Function to be called when a key is pressed.
 **/
screen_t.prototype.getch = function(callback) {
  this.one('keydown', callback);
};
exports.getch = simplify(screen_t.prototype.getch);

/**
 * Call function `callback` when a key is entered by the user (if the screen
 * has focus). `callback` will receive an event object as its first argument.
 *
 * The description of the event object is still subject to change.
 *
 * @param {Function} callback Function to be called when a key is pressed.
 **/
screen_t.prototype.ongetch = function(callback) {
  this.on('keydown', callback);
};
exports.ongetch = simplify(screen_t.prototype.ongetch);

/**
 * Stop listening to keyboard events; undoes a previous call to getch() or
 * ongetch(). The `callback` argument must be the same as in a previous call to
 * getch() or ongetch().
 *
 * @param {Function} callback Function that should not be called anymore when a
 *   key is pressed.
 **/
screen_t.prototype.ungetch = function(callback) {
  this.off('keydown', callback);
};
exports.ungetch = simplify(screen_t.prototype.ungetch);

})();