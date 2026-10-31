#!/usr/bin/env node
// Writes a Live set for tests that cannot click: Live's default audio track
// set with the device on its audio track. The template must be in the file
// format of the installed Live: a 12.4 device element inside the 12.1
// DefaultLiveSet.als crashed Live 12.4.7 while it opened the set.
// Usage: node tools/make-test-set.mjs <device.amxd> <out.als> [--live-app <path>]
//   [--playhead <beats>] [--locator <beats>:<name>]... [--stored <value>]
// --stored puts a value into the device's hidden "doc" parameter, as if a
// saved set held it.
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

const args = process.argv.slice(2);
const [device, out] = args;
if (!device || !out) {
  console.error('usage: node tools/make-test-set.mjs <device.amxd> <out.als> [--live-app <path>]');
  process.exit(2);
}
const option = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const options = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const liveApp = option('--live-app') ?? '/Applications/Ableton Live 12 Suite.app';
const template = path.join(liveApp, 'Contents', 'App-Resources', 'Core Library', 'Defaults', 'Creating Tracks', 'Audio Track', 'Default Audio Track.als');

const xmlText = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let xml = gunzipSync(await readFile(template)).toString('utf8');

// Ids that other elements point to must be new: take them from NextPointeeId.
const next = Number(xml.match(/<NextPointeeId Value="(\d+)" \/>/)?.[1]);
if (!Number.isInteger(next)) throw new Error('no NextPointeeId in the template');
xml = xml.replace(/<NextPointeeId Value="\d+" \/>/, `<NextPointeeId Value="${next + 2}" />`);

// RelativePathType 0: no relative path, Live uses the absolute Path.
// The blob holds the device's stored values as JSON plus a NUL byte. Live
// writes one for every Max device; an empty <BlobSlot><Value /> crashed it.
// Which key Live uses for a pattr (scripting name or long name) is not
// known yet, so a stored value goes under both.
const stored = option('--stored');
const blob = stored ? { doc: [stored], 'Google Doc': [stored] } : {};
const absolute = path.resolve(device);
const { size } = await stat(absolute);
// The device's extra audio input and output (sidechain), both unused.
const routable = (tag, target) =>
  `<${tag} Id="0"><Routable><Target Value="${target}" /><UpperDisplayString Value="No Output" /><LowerDisplayString Value="" /><MpeSettings><ZoneType Value="0" /><FirstNoteChannel Value="1" /><LastNoteChannel Value="15" /></MpeSettings><MpePitchBendUsesTuning Value="true" /></Routable><LomId Value="0" /></${tag}>`;
const mxDevice = `<Devices>
<MxDeviceAudioEffect Id="0">
<LomId Value="0" /><LomIdView Value="0" /><IsExpanded Value="true" /><BreakoutIsExpanded Value="false" />
<On><LomId Value="0" /><Manual Value="true" /><AutomationTarget Id="${next}"><LockEnvelope Value="0" /></AutomationTarget><MidiCCOnOffThresholds><Min Value="64" /><Max Value="127" /></MidiCCOnOffThresholds></On>
<ModulationSourceCount Value="0" /><ParametersListWrapper LomId="0" /><Pointee Id="${next + 1}" />
<LastSelectedTimeableIndex Value="0" /><LastSelectedClipEnvelopeIndex Value="0" /><LastPresetRef><Value /></LastPresetRef><LockedScripts />
<IsFolded Value="false" /><ShouldShowPresetName Value="true" /><UserName Value="" /><Annotation Value="" /><SourceContext><Value /></SourceContext>
<MpePitchBendUsesTuning Value="true" /><ViewData Value="{}" /><OverwriteProtectionNumber Value="3077" />
<AudioOutputsListWrapper LomId="0" /><AudioInputsListWrapper LomId="0" /><MidiOutputsListWrapper LomId="0" /><MidiInputsListWrapper LomId="0" />
<PatchSlot><Value><MxPatchRef Id="0"><FileRef><RelativePathType Value="0" /><RelativePath Value="" /><Path Value="${xmlText(absolute)}" /><Type Value="2" /><LivePackName Value="" /><LivePackId Value="" /><OriginalFileSize Value="${size}" /><OriginalCrc Value="0" /><SourceHint Value="" /></FileRef><LastModDate Value="0" /><SourceContext /><SampleUsageHint Value="0" /></MxPatchRef></Value></PatchSlot>
<ParameterList><ParameterList /></ParameterList><FileDropList><FileDropList /></FileDropList><IdRefList><IdRefList /></IdRefList>
<BlobSlot><Value><MxDBlob Id="0"><Blob>${Buffer.from(`${JSON.stringify(blob, null, '\t')}\n\0`).toString('hex').toUpperCase()}</Blob><HasData Value="true" /></MxDBlob></Value></BlobSlot>
<Routables><InRoutings>${routable('MxDInRoutable', 'AudioIn/None')}</InRoutings><OutRoutings>${routable('MxDOutRoutable', 'AudioOut/None')}</OutRoutings><MidiInRoutings /><MidiOutRoutings /></Routables>
<MpeEnabled Value="false" /><MpeTuningEnabled Value="false" />
</MxDeviceAudioEffect>
</Devices>`;

const track = xml.indexOf('<AudioTrack ');
const devices = xml.indexOf('<Devices />', track);
if (track === -1 || devices === -1) throw new Error('no audio track with an empty device chain in the template');
xml = xml.slice(0, devices) + mxDevice + xml.slice(devices + '<Devices />'.length);

const playhead = option('--playhead');
if (playhead) xml = xml.replace(/<CurrentTime Value="[^"]*" \/>/, `<CurrentTime Value="${Number(playhead)}" />`);
const locators = options('--locator').map((spec, i) => {
  const [beats, ...name] = spec.split(':');
  return `<Locator Id="${i}"><LomId Value="0" /><Time Value="${Number(beats)}" /><Name Value="${xmlText(name.join(':'))}" /><Annotation Value="" /><IsSongStart Value="false" /></Locator>`;
});
if (locators.length) xml = xml.replace(/<Locators>\s*<Locators \/>\s*<\/Locators>/, `<Locators><Locators>${locators.join('')}</Locators></Locators>`);

await writeFile(out, gzipSync(Buffer.from(xml, 'utf8')));
console.log(`wrote ${out} (device on the first audio track: ${absolute})`);
