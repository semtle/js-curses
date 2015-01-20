// when called with a function, return that function, wrapped so that
// it can be used directly by being applied on `default_window'.
//
// i.e., the call:
//   default_window.addstr('hello world');
//
// can be shortened to:
//   addstr('hello world');
//
// if you define:
//   addstr = simplify(window_t.prototype.addstr);
// when called with function name `function_name' that is defined in
// window_t.prototype, will create a function with the same name in `exports'
// that calls this function using `default_window'
var simplify = function(f) {
  return function() {
    return f.apply(default_window, arguments);
  };
};

// similar to simplify, but convert the call so it can be done as in C with
// ncurses.
//
// for instance, the call:
//   win.addstr('hello world');
//
// can be rewritten:
//   waddstr(win, 'hello world');
//
// if you define:
//   waddstr = generalize(f);
var generalize = function(f) {
  return function() {
    return f.apply(arguments, [].slice.call(arguments, 1));
  };
};

// similar to simplify, but instead of allowing to call without supplying a
// `window_t' object, allows calling by supplying a position for inserting
// text.
//
// for instance, the function call:
//   win.addstr(10, 10, 'hello world');
//
// will expand to:
//   win.move(10, 10);
//   win.addstr('hello world');
//
// if you define:
//   window_t.prototype.addstr = shortcut_move(window_t.prototype.addstr);
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
//   win.addstr('hello world', A_BOLD | COLOR_PAIR(3));
//
// will expand to:
//   win.attron(A_BOLD | COLOR_PAIR(3));
//   win.addstr('hello world');
//   win.attroff(A_BOLD | COLOR_PAIR(3));
//
// if you define:
//   window_t.prototype.addstr = attributify(window_t.prototype.addstr);
var attributify = function(f) {
  return function() {
    var args = arguments;
    var attrs = null;
    if (arguments.length !== 0) {
      attrs = arguments[arguments.length - 1];
      if (typeof attrs === "number") {
        args = [].slice.call(arguments, 0, arguments.length - 1);
        this.attron(attrs);
      }
    }
    var return_value = f.apply(this, args);
    if (typeof attrs === "number") {
      this.attroff(attrs);
    }
    return return_value;
  };
};