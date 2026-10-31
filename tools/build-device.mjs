#!/usr/bin/env node
// Generates the Google Docs device. Never edit the .amxd by hand.
// Usage: node tools/build-device.mjs <out.amxd> <node script> [<live script>]
// A script with a "/" is a path (a development install: max/live.js next to
// node/, as tools/install.mjs lays it out); without, a name that the frozen
// device carries (tools/build-release.mjs).
//
// Device view: a title, an "Open editor" button and a status line.
// The editor is a subpatcher with a jweb that fills its window; the window
// floats above Live. node.script loads the page into the jweb and talks to it.
// A js object reads the playhead and locators from Live for stamps, and a
// hidden parameter keeps the set's doc in the Live set.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Patch, encodeAmxd } from './amxd.mjs';

const [out, script, liveArg] = process.argv.slice(2);
const isPath = (s) => s?.includes('/');
if (!out || !script || (!isPath(script) && !liveArg)) {
  console.error('usage: node tools/build-device.mjs <out.amxd> <node script> [<live script>]');
  process.exit(2);
}
const ref = (s) => (isPath(s) ? path.resolve(s) : s);
const liveScript = liveArg ?? path.join(path.dirname(path.resolve(script)), '..', 'max', 'live.js');

const WIDTH = 168;
const EDITOR = { w: 560, h: 760 };
const TEXT = { fontname: 'Ableton Sans Medium', fontsize: 9.5 };
const theme = (colors) => ({
  saved_attribute_attributes: Object.fromEntries(Object.entries(colors).map(([attr, name]) => [attr, { expression: `themecolor.${name}` }])),
});

// ---- editor window: messages that start with "win" go to thispatcher,
// everything else goes to the page.
const editor = new Patch({
  rect: [120, 80, EDITOR.w, EDITOR.h],
  openinpresentation: 1,
  toolbarvisible: 0,
  statusbarvisible: 0,
  enablehscroll: 0,
  enablevscroll: 0,
});
const editorIn = editor.add({ maxclass: 'inlet', numinlets: 0, numoutlets: 1, outlettype: [''], comment: 'win <thispatcher message>, or a message for the page' });
const winRoute = editor.obj('route win', { outlets: 2 });
const thispatcher = editor.obj('thispatcher', { outlets: 2 });
const jweb = editor.add({
  maxclass: 'jweb',
  numinlets: 1,
  numoutlets: 1,
  outlettype: [''],
  rendermode: 0,
  url: '',
  patching_rect: [220, 20, EDITOR.w, EDITOR.h],
  presentation: 1,
  presentation_rect: [0, 0, EDITOR.w, EDITOR.h],
});
const editorOut = editor.add({ maxclass: 'outlet', numinlets: 1, numoutlets: 0, comment: 'page and load messages from jweb' });
editor.connect(editorIn, 0, winRoute, 0);
editor.connect(winRoute, 0, thispatcher, 0);
editor.connect(winRoute, 1, jweb, 0);
editor.connect(jweb, 0, editorOut, 0);

// ---- device
const p = new Patch({
  openrect: [0, 0, WIDTH, 169],
  openinpresentation: 1,
  bglocked: 0,
  statusbarvisible: 2,
  toolbarvisible: 1,
  devicewidth: WIDTH,
  description: 'Google Docs — shows and edits a Google Doc inside Live',
  dependency_cache: [],
  latency: 0,
  is_mpe: 0,
  minimum_live_version: '',
  minimum_max_version: '',
  platform_compatibility: 0,
  autosave: 0,
});

// Audio passes through unchanged.
const plugin = p.obj('plugin~', { inlets: 2, outlets: 2, outlettype: ['signal', 'signal'] });
const plugout = p.obj('plugout~', { inlets: 2, outlets: 2, outlettype: ['signal', 'signal'] });
p.connect(plugin, 0, plugout, 0);
p.connect(plugin, 1, plugout, 1);

const node = p.obj(`node.script "${ref(script)}" @autostart 1`, { outlets: 2, saved_object_attributes: { autostart: 1, watch: 0 } });
// The first word of every message from node/main.js picks the outlet.
const FROM_NODE = ['page', 'window', 'status', 'live', 'setdoc', 'ready'];
const fromNode = p.obj(`route ${FROM_NODE.join(' ')}`, { outlets: FROM_NODE.length + 1 });
const OUT = Object.fromEntries(FROM_NODE.map((name, i) => [name, i]));
p.connect(node, 0, fromNode, 0);

// ---- Live: playhead, time signature and locators for stamps
const liveJs = p.obj(`js "${ref(liveScript)}"`, { outlets: 1 });
p.connect(fromNode, OUT.live, liveJs, 0);
const fromLive = p.obj('prepend fromLive');
p.connect(liveJs, 0, fromLive, 0);
p.connect(fromLive, 0, node, 0);

// ---- the set's doc: a hidden parameter, so Live saves it with the set.
// node sends "setdoc <value>"; on "ready" the patch sends the stored value,
// because Live restores parameters before node runs.
const storedDoc = p.add({
  maxclass: 'newobj',
  text: 'pattr doc',
  varname: 'doc',
  numinlets: 1,
  numoutlets: 3,
  outlettype: ['', '', ''],
  saved_attribute_attributes: {
    valueof: { parameter_longname: 'Google Doc', parameter_shortname: 'Doc', parameter_type: 3, parameter_invisible: 1, parameter_initial_enable: 0 },
  },
  saved_object_attributes: { parameter_enable: 1, parameter_mappable: 0 },
});
p.connect(fromNode, OUT.setdoc, storedDoc, 0);
p.connect(fromNode, OUT.ready, storedDoc, 0);
const toNodeDoc = p.obj('prepend storeddoc');
p.connect(storedDoc, 0, toNodeDoc, 0);
p.connect(toNodeDoc, 0, node, 0);

const editorBox = p.sub('Google Docs', editor);
p.connect(fromNode, OUT.page, editorBox, 0);
const fromPage = p.obj('prepend fromPage');
p.connect(editorBox, 0, fromPage, 0);
p.connect(fromPage, 0, node, 0);

p.add({ maxclass: 'live.comment', numinlets: 1, numoutlets: 0, text: 'Google Docs', presentation: 1, presentation_rect: [6, 4, 156, 18], ...TEXT, fontsize: 11 });
const open = p.add({
  maxclass: 'textbutton',
  varname: 'open',
  numinlets: 1,
  numoutlets: 3,
  outlettype: ['', '', 'int'],
  mode: 0,
  text: 'Open editor',
  ...TEXT,
  rounded: 3,
  ...theme({ bgcolor: 'live_control_bg', textcolor: 'live_control_fg_off' }),
  parameter_enable: 0,
  presentation: 1,
  presentation_rect: [6, 28, 156, 22],
  annotation: 'Opens the editor in a window that stays above Live.',
});
const status = p.add({
  maxclass: 'live.comment',
  numinlets: 1,
  numoutlets: 0,
  text: 'Starting…',
  linecount: 3,
  presentation: 1,
  presentation_rect: [6, 58, 156, 48],
  ...TEXT,
  ...theme({ textcolor: 'live_control_fg_off' }),
});
const setStatus = p.obj('prepend set');
p.connect(fromNode, OUT.status, setStatus, 0);
p.connect(setStatus, 0, status, 0);

// Open the window, make it float, then tell node (for the log). The button
// and node's "window open" take the same path. trigger fires right to left.
const openTrigger = p.obj('t b b b', { outlets: 3 });
const pcontrol = p.obj('pcontrol');
const openMsg = p.msg('open');
const floatMsg = p.msg('win window flags float, win window flags nogrow, win window exec, win front');
const openedMsg = p.msg('opened');
p.connect(openTrigger, 2, openMsg, 0);
p.connect(openMsg, 0, pcontrol, 0);
p.connect(pcontrol, 0, editorBox, 0);
p.connect(openTrigger, 1, floatMsg, 0);
p.connect(floatMsg, 0, editorBox, 0);
p.connect(openTrigger, 0, openedMsg, 0);
p.connect(openedMsg, 0, node, 0);
p.connect(open, 0, openTrigger, 0);
const windowRoute = p.obj('route open', { outlets: 2 });
p.connect(fromNode, OUT.window, windowRoute, 0);
p.connect(windowRoute, 0, openTrigger, 0);

await writeFile(out, encodeAmxd(p.toPatcher(), 'audio'));
console.log(`wrote ${out}`);
