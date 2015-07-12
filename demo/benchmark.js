(function() {
  var bm = window.bm = {
    active: false,
    ticks: 0,
    fps: 0,
    timeout: 0,
    fps_timeout: 0,
    update: function(c) {
      bm.active = true;
      if (c === 'q') {
        clear();
        demo.redraw();
        ongetch(demo.update);
        ungetch(bm.update);
        clearTimeout(bm.timeout);
        clearTimeout(bm.fps_timeout);
        bm.active = false;
        return;
      }
    },
    redraw: function() {
      if (! bm.active)
        return;
      clear();
      var y, x;
      for (y = 0; y < 29; y++) {
        for (x = 0; x < 60; x++) {
          var k = Math.round(Math.random() 
                             * ('Z'.charCodeAt(0) - 'A'.charCodeAt(0)));
          k += 'A'.charCodeAt(0);
          var c = String.fromCharCode(k);
          var attrs = 0;
          if (Math.round(Math.random())) {
            attrs |= A_BOLD;
          }
          if (Math.round(Math.random())) {
            attrs |= A_REVERSE;
          }
	  if (Math.round(Math.random())) {
	    attrs |= A_UNDERLINE;
	  }
          attrs |= COLOR_PAIR(Math.round(Math.random() * 6));
          addstr(y, x, c, attrs);
        }
      }
      addstr(29, 0, 'press q to quit', A_BOLD | A_REVERSE);
      if (bm.fps) {
        var msg = bm.fps + ' FPS';
        var n = msg.length;
        addstr(29, 60 - n, msg, A_BOLD | A_REVERSE);
      }
      refresh();
      window.postMessage('message', window.location);
      bm.ticks++;
    },
    count_fps: function() {
      bm.fps = bm.ticks;
      bm.ticks = 0;
      clearTimeout(bm.fps_timeout);
      bm.fps_timeout = setTimeout(bm.count_fps, 1000);
    }
  };
  window.addEventListener('message', bm.redraw, false);
})();
