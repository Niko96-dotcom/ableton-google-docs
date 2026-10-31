// Runs in Max's js object inside the device (ES5: js is not node).
// Reads the Live set for node/main.js and answers out of its outlet:
//   stamp            -> stamp <bar> <locator name, may be empty>
//                       or stamp_error <reason>
// The bar is where the playhead (or, when stopped, the start marker) is,
// counted with the set's time signature. The locator is the last one at or
// before that point.
autowatch = 0;
inlets = 1;
outlets = 1;

function stamp() {
  var song = new LiveAPI('live_set');
  if (!song || Number(song.id) === 0) {
    outlet(0, 'stamp_error', 'Live is not ready');
    return;
  }
  var beats = song.get('current_song_time')[0];
  var beatsPerBar = (song.get('signature_numerator')[0] * 4) / song.get('signature_denominator')[0];
  var bar = Math.floor(beats / beatsPerBar + 1e-9) + 1;

  var ids = song.get('cue_points');
  var best = -1;
  var name = '';
  for (var i = 0; i + 1 < ids.length; i += 2) {
    var cue = new LiveAPI('id ' + ids[i + 1]);
    var time = cue.get('time')[0];
    if (time <= beats + 1e-6 && time > best) {
      best = time;
      name = cue.get('name').join(' ');
    }
  }
  outlet(0, 'stamp', bar, name);
}
