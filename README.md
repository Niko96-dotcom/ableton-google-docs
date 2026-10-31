# ableton-google-docs

A Max for Live device that shows and edits a Google Doc inside Ableton Live, so lyrics and session notes never need a switch to the browser.

- Schedule: none. This is a device, not a job.
- Output: a `.amxd` device that you drop on a track in Live. Nothing runs in the background when the device is not in a set.
- Turn off: delete the device from the track.

**Beta, macOS only.** Tested by its author on two Macs (Live 12.4 and Live 12 Beta). Found a bug or an idea? [Open an issue](https://github.com/Niko96-dotcom/ableton-google-docs/issues).

## Install

1. Download `Google-Docs.zip` from the [latest GitHub release](https://github.com/Niko96-dotcom/ableton-google-docs/releases/latest) and open it. Copy `Google Docs.amxd` into `<User Library>/Presets/Audio Effects/Max Audio Effect/`. It is the whole device; nothing else to install. Needs macOS and Live 12 with Max for Live (Max 9).
2. Sign in once (see "Use"). The token stays on that Mac.

The released device has its own OAuth client built in. Google has not verified it, so the first sign-in shows "Google hasn't verified this app", and at most 100 Google accounts can sign in with it. To use a client of your own Google Cloud project instead, see "Your own Google client". What the device accesses and stores: [PRIVACY.md](PRIVACY.md).

## Use

1. In Live: Browser → User Library → Presets → Audio Effects → Max Audio Effect → **Google Docs**. Drag it onto any track. Audio passes through unchanged.
2. Click **Open editor** on the device. The editor window opens above Live.
3. Click **Sign in with Google**. The browser opens Google's consent page. Choose your account. Google shows "Google hasn't verified this app": choose Advanced, then continue. Allow access to Docs and to the names of your Drive files. The browser then says "Signed in", and the editor shows your docs. This happens once. (A sign-in from the first version asks once more: **Sign in again**.)
4. Click a doc in the list, or type in the search field. A pasted doc link opens that doc. **+ New** makes a new doc in your Drive: type a title, then **Create**.
5. Type in the doc. The toolbar has the paragraph style (Normal text, Title, Subtitle, Heading 1–3), bold, italic, underline, strikethrough, bulleted and numbered list, undo and redo. Everything saves one second after the last change ("Saving…", then "Saved"). **← Docs** saves and goes back to the list. **Reload** reads the doc again from Google Docs.
6. **⌖ Stamp** inserts where you are in the song: the last locator at or before the playhead and the bar, for example `[Chorus · bar 33] `. Then type your note. The stamp goes to the cursor; without a cursor in the doc, it starts a new line at the end. When the song is stopped, the bar is where playback would start.

The set remembers its doc: the last doc you open in a set is stored in the set. Save the set (Cmd+S). When you open the set again, the device opens that doc by itself, even before you open the editor.

Working together: while a doc is open, the device looks for changes in Google Docs every 3 seconds. Other people's changes show up by themselves ("Updated"), and the cursor stays in its line. While you type, an update waits until your text is saved, one second after you stop. Your saves are merged with other people's changes; nobody's text is overwritten. Only when you and someone else change the same line within those seconds does the save stop: your text stays in the editor, the message says so, and **Reload** shows the doc as it is in Google.

After a new deploy, a device that is already in a set still runs the old code: delete it from the track and drag it in again, or close and open the set.

Editing limits:
- Only what changed is written: the changed text, then the formatting that differs. Everything else in the doc stays, also formatting the editor does not show (fonts, sizes, colours, links).
- New text takes the style of the text before it, as in Google Docs. Pasted text comes in as plain text.
- The editor does not change the level of a nested list item. A new list item is on the first level.
- Tables and tab titles are read-only here (grey). A change there is refused; undo it or press Reload.
- A doc that your account can only view opens as "View only". A doc that the editor cannot show exactly also opens read-only, with a message, so a save can never change parts that nobody touched.
- If you and someone else change the same line at the same time, your save stops (see "Working together"). Reload drops your unsaved text, so copy it first if you need it.
- Formatting is merged per line: if you and someone else change the formatting of the same line at the same time, yours wins for the characters you changed.
- Images, smart chips and comments do not show. Deleting text around them deletes them too.

- The token: `~/Library/Application Support/ableton-google-docs/token.json` (0600). **Sign out** in the editor deletes it and revokes it at Google.
- If something fails: `<User Library>/Google Docs/logs/device.log`. The log never holds tokens, doc names or doc text.

## Status

All four phases are done: a doc list, editing, formatting tools, new docs, live updates from other people, stamps from Live, the doc stored in the Live set, and a frozen one-file device (`dist/Google Docs.amxd`, published as a GitHub release). The M5 runs the frozen device since 27.10.2026. The decisions below are made (27.10.2026).

Proven:
- In Live 12.4.7 on the Studio (log proof, see "Testing"): the device loads, `node.script` starts, the editor window path runs, `jweb` loads the page, and messages go both ways. Live gives back the doc stored in a set, and `max/live.js` reads the playhead and the locators (`[Chorus · bar 18]` for a locator at beat 64 and the playhead at beat 70).
- On the M5 in Live 12 Beta, by Niko (27.10.2026): sign-in, the doc list (50 docs), opening a doc, typing and saving, a new doc, formatting, a change made in Google Docs that showed up in the editor by itself (log: changed, offered, applied within 16 ms), the Stamp button with real locators (`[4. CHORUS · bar 23]`), and a saved set that opened its doc by itself (log: stored doc, then doc read 1 s after the device started; the set was not marked as changed).
- On the M5 with the frozen device (27.10.2026): it runs from Max's cache, the stamp, the editor page and the doc list work, and a fresh load logs no Max errors.
- Real Docs and Drive API with the device's own token on the M5 (`tools/edit-check.cjs`): a new doc; insert, replace, delete the last line, add lines at the end; heading, bold, italic, underline, strikethrough, bullets and numbers come back exactly as sent; a bold word that was not touched stays bold; a doc changed elsewhere is not overwritten.
- Working together, against the real API on the M5 with a scripted buddy: a buddy change the device has not seen yet is merged by Google; one it has seen is kept while the device moves its own change; the buddy's formatting stays; both changing the same line is refused and the buddy's text stays.
- The editor page in headless Chrome (`test/page.test.mjs`): a doc with every kind of content survives the editor's round trip exactly; typing, the toolbar, Return, Shift+Return and paste give the right blocks; an update replaces only changed paragraphs and keeps the cursor in its line; an update that comes while you type waits.
- Sign-in, token refresh, the doc list, the edit, merge and style requests, the change check, stamps, the stored doc and the packets: unit tests against a fake Google. The generated patch and `node/main.js` agree on every message (`test/device.test.mjs`). No credential and no home folder path is in the repo (`test/secrets.test.mjs`). 66 tests in all.

Not proven yet:
- a save that is merged with a buddy's change inside Live (the merge itself is proven against the real API, see above),
- that Cmd+B, Cmd+I, Cmd+U and Cmd+Z reach the editor and not Live,
- that the editor window floats above Live,
- the Google login inside `jweb` (expected to be blocked; not needed by this design).
- a fresh install from the release zip on another Mac, by someone other than the author.

## Your own Google client

A development build has no client built in, so it needs one of its own. A release can use one too.

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project.
2. APIs & Services → Library: enable the **Google Docs API** and the **Google Drive API**.
3. Google Auth Platform → Branding: an app name and a support email. Audience: **External**, then **Publish app** ("In production"). In "Testing", Google ends each sign-in after 7 days.
4. Data Access: add the scopes `documents`, `drive.file` and `drive.metadata.readonly`.
5. Clients → Create client → **Desktop app**. Download the JSON file.
6. Store it as `client.json` next to the token:

   ```sh
   mkdir -m 700 -p ~/Library/Application\ Support/ableton-google-docs
   install -m 600 ~/Downloads/client_secret_*.json ~/Library/Application\ Support/ableton-google-docs/client.json
   ```

A `client.json` there wins over the client built into the release. Without either, the editor says "Google client missing". A token works only with the client that made it: after a change of client, click **Sign out**, then sign in again.

## Releases

The release carries a public OAuth client from a Google Cloud project that is used only for this device. Google treats the client secret of a desktop app as public ("not treated as a secret", [OAuth 2.0 for Desktop Apps](https://developers.google.com/identity/protocols/oauth2/native-app)), so the release may carry it. It never goes into git: `dist/` is in `.gitignore`, and `test/secrets.test.mjs` fails when a client ID, a client secret, a token or a home folder path is in a file that git tracks or would add.

1. Make the client as in "Your own Google client", steps 1–5. Store the JSON file as `~/Library/Application Support/ableton-google-docs/release-client.json` (0600), or name it with `RELEASE_CLIENT=<file>`.
2. `npm test`, then `node tools/build-release.mjs`. It must print "with the built-in Google client".
3. Zip the device, so it keeps its name (GitHub replaces spaces in file names): `(cd dist && COPYFILE_DISABLE=1 zip -X Google-Docs.zip "Google Docs.amxd")`, then `gh release create v<version> dist/Google-Docs.zip`.

Limits of an unverified app: the warning at sign-in, and at most 100 accounts. `drive.metadata.readonly` (the doc list) is a restricted scope: for more accounts, Google requires a verification with a yearly security assessment (CASA). With `drive.file` alone, verification is easier, but the device then sees only the docs it made or the docs picked in Google's file picker.

## Why not just show docs.google.com inside Ableton

Max for Live has a built-in browser object (`jweb`, based on Chromium Embedded Framework). It can show any web page inside a device window. But Google blocks Google-account sign-in from embedded browser frameworks since January 2021 ("This browser or app may not be secure"). So the full Google Docs page inside Ableton will most likely stop at the login screen.

The only way to show the real Google Docs page without a login is a doc shared as "anyone with the link can edit". That makes the doc readable by anyone who gets the link, so it is not the default here.

## Plan: own editor, real Google Doc behind it

```
Ableton Live 12 (Max 9 inside)
└── Max for Live device "Google Docs"
    ├── jweb          the editor UI (local HTML), opens in a floating window that stays on top
    ├── node.script   Node for Max: talks to the Google Docs API
    ├── js            max/live.js: reads locators (cue points) and the playhead (Live API)
    └── pattr doc     hidden parameter (blob): the set's doc, saved with the Live set
```

- **Sign-in:** once, in the normal system browser (OAuth for desktop apps, loopback on 127.0.0.1 only during sign-in). The token stays on the Mac. After that, everything happens inside Ableton.
- **One doc per set:** link a doc once (paste the doc link or create a new one named after the song). The device saves the doc ID with the set. Open the set, the doc is there.
- **Features for version 1:**
  1. Show the doc text. Refresh on open and on a button.
  2. Append a note with a stamp from Live: `[Chorus · bar 33]` from the nearest locator and the playhead.
  3. Edit the doc as plain text. Only the changed part is written back, so formatting elsewhere stays (built 27.10.2026).
- **Later:** jump the playhead to a locator from a heading in the doc, one doc per song with tabs, offline cache.

What version 1 does not do: rich formatting, comments, live cursors of other people. That needs the real Google Docs page, see above.

## Where it runs

Music is made on a MacBook Pro M5. The code is developed on a Mac Studio, which also has Live 12.4.7 Suite with Max 9.1.5 and Node for Max for testing. The finished device is copied to the M5, which runs Live 12 Beta (its Max has Node 22.18.0, the same as the Studio's).

## Decisions

1. **The Google token lives on each Mac that runs Live.** It is made once at the first sign-in, with the client built into the release or a `client.json` (see "Your own Google client"). Scopes: `documents` (read and write any doc by link), `drive.file` (create new docs) and `drive.metadata.readonly` (names and dates of Drive files for the doc list, not their content; added 27.10.2026). No service, no new way into the network. The token is stored outside the User Library and outside git: `~/Library/Application Support/ableton-google-docs/` (0700) holds `token.json` (0600) and, if there is one, `client.json` (0600).
2. **Own editor, not the full Google Docs page** (see above).
3. **Install in the User Library** (internal disk):
   - device: `Presets/Audio Effects/Max Audio Effect/Google Docs.amxd`
   - settings and logs: `Google Docs/`
   Deploy from the Studio over SSH with `tools/deploy-macbook.sh`.
4. **No Testing mode.** The OAuth app is "In production", so refresh tokens do not expire after 7 days. The app is not verified by Google: the first sign-in shows "Google hasn't verified this app". Choose Advanced, then continue. This happens once.

## Reference: Console Bridge

Console Bridge is an earlier Max for Live device with Node for Max, built with Claude. This device reuses its approach, not its code:

- The `.amxd` is generated by a script (`tools/build-device.mjs`, `tools/amxd.mjs`), never edited by hand.
- Development install: `tools/install.mjs` (this Mac), `tools/deploy-macbook.sh` (M5).
- Release: one Node file built with esbuild, then the device is frozen in Max by hand. This project writes the frozen format itself instead (`tools/amxd.mjs`): rebuilt from its parts, Console Bridge's frozen file comes out byte for byte the same.

## Phases

1. **Spike (Studio):** device with a floating `jweb` window and `node.script`, local HTML loads, messages go both ways. Done 27.10.2026 (log proof). Still open: look at the window, and try the Google login in `jweb` once to confirm the block.
2. **Google:** sign-in in the system browser, read a doc by link, show its text. Done 27.10.2026, with a doc list and editing added the same day.
3. **Write:** append notes with locator and bar stamps. Store the doc ID in the set. Done 27.10.2026, checked by Niko on the M5.
4. **Ship:** freeze the device, test on the M5 in a real session. Done 27.10.2026: `tools/build-release.mjs` writes the frozen device without Max; it works in Live on the Studio (Node and the Live script run from inside it) and is installed on the M5.

## Development

| Path | What it is |
|---|---|
| `tools/build-device.mjs` | Generates the `.amxd`. Never edit the device by hand. |
| `tools/amxd.mjs` | Writes the `.amxd` file format and the patcher JSON. |
| `node/main.js` | The script that `node.script` runs inside the device: page messages, sign-in, doc reading. |
| `node/google.js` | Google sign-in (OAuth for desktop apps, loopback and PKCE), the doc list, reading and editing docs, without npm packages. |
| `node/client.js` | The OAuth client built into the device: none in the source, the public client in the release bundle. |
| `node/library.js` | Finds the User Library through Live's `Library.cfg`; the device's settings and logs live in `<User Library>/Google Docs`. |
| `node/page.js` | The editor page as text: read from `ui/` in a development install, built into the release bundle. |
| `ui/index.html` | The editor page that `jweb` shows. |
| `max/live.js` | Runs in Max's `js` object: reads the playhead, the time signature and the locators for stamps (Live API). |
| `tools/build-release.mjs` | Writes the frozen device `dist/Google Docs.amxd`: the patch, the Node code, the page and the public OAuth client (`RELEASE_CLIENT`) bundled by esbuild as `google-docs-node.js`, and `max/live.js` as `google-docs-live.js`. |
| `dist/Google Docs.amxd` | The frozen device, the one file to install or share. Not in git: it goes to a GitHub release (see "Releases"). |
| `tools/install.mjs` | Installs a development build into the User Library of this Mac. |
| `tools/deploy-macbook.sh` | Copies the device to the M5 over SSH: `--release` the frozen device as `Google Docs.amxd`; without, a development build as `Google Docs (dev).amxd`. With `CLIENT=<file>`, copies an OAuth client once. |
| `tools/make-test-set.mjs` | Writes a Live set with the device on the first audio track, for tests without clicks. |
| `tools/studio-test.sh` | Loads the device in Live on this Mac and checks the round trip, a stamp and the stored doc; `--release` with the frozen device (see "Testing"). |
| `tools/api-check.mjs` | Lists docs and reads one with a given access token, through the device's code (see "Testing"). |
| `tools/edit-check.cjs` | Creates, edits and formats a scratch doc with the device's own token and checks the result (see "Testing"). |
| `test/` | Unit tests: `main.js` with stand-ins for `max-api` and Google, `google.js` with a fake Google; `device.test.mjs` checks the generated patch against `main.js`; `secrets.test.mjs` checks that no credential and no home folder path is in the repo. `page.test.mjs` runs `ui/index.html` in headless Google Chrome (needs Chrome installed; `playwright-core` drives it). |

```sh
npm install    # playwright-core for the page tests
npm test
node tools/install.mjs                 # add --open-on-load to open the editor when the device loads
node tools/make-test-set.mjs "$HOME/Music/Ableton/User Library/Presets/Audio Effects/Max Audio Effect/Google Docs.amxd" scratch/spike-test.als
```

The device writes its log to `<User Library>/Google Docs/logs/device.log`. Settings: `<User Library>/Google Docs/settings.json` (`openOnLoad`: open the editor when the device loads; `checkSeconds`: how often to look for other people's changes, default 3). Max console messages also land in Live's `Log.txt` as `Message from Max`.

How saving and updates work: `node/main.js` keeps `latest` (the newest doc read from Google) and `base` (what the page shows as saved). A save sends the page's blocks. `saveDoc` takes the one changed text range between base and page, moves it to its place in latest (lines matched by longest common subsequence; refused when someone changed the same lines), writes it with `targetRevisionId` (Google merges changes the device has not seen), then writes only the formatting the page changed against base. Every `checkSeconds`, node reads Drive's version number; when it changed, node reads the doc and offers it to the page (`update`). The page takes it when it has nothing unsaved and answers `synced <id>`, which makes it the new base.

## Testing

`node tools/build-release.mjs` then `tools/studio-test.sh --release` checks the frozen device in Live: on 27.10.2026, Node ran from Max's cache (`…/Max 9/Settings/temp64-live/mxt/Google Docs_coll_…`), not from the development files, and the page, the stamp and the stored doc worked. `test/release.test.mjs` checks the frozen format and that the device names exactly the files it carries.

`tools/studio-test.sh` loads the device in Live on this Mac without clicks: it installs a build with `--open-on-load`, writes `scratch/studio-test.als` (a locator "Chorus" at beat 64, the playhead at beat 70, a stored doc), starts Live with it, waits for `round trip ok` in the device log, checks the stamp `[Chorus · bar 18]` and the stored doc, prints the logs, and quits Live with SIGTERM (a clean quit: no crash flag). It takes about 30 s. Run it only when Live is not in use on this Mac.

To check the Drive and Docs API part without a sign-in, list docs and read Google's public sample doc with a short-lived access token that has the scopes above, for example from Google's [OAuth 2.0 Playground](https://developers.google.com/oauthplayground):

```sh
GOOGLE_ACCESS_TOKEN=<token> node tools/api-check.mjs 195j9eDD3ccgjQRttHhJPymLJUCOUjs-jmwTrekvdjFE
```

To check editing for real, run `tools/edit-check.cjs` where the device signed in. It creates a scratch doc in Drive, edits and formats it through `saveDoc` the way the page does, plays a buddy who edits at the same time, checks the result in Google's own data, and moves the doc to the Drive trash:

```sh
ssh macbook "cd ~/'Music/Ableton/User Library/Google Docs/app/node' && GOOGLE_JS=./google.js '/Applications/Ableton Live 12 Beta.app/Contents/App-Resources/Max/Max.app/Contents/Resources/C74/packages/Node for Max/source/bin/osx/node/node' -" < tools/edit-check.cjs
```

Learned on 27.10.2026 (Live 12.4.7):
- An agent session cannot see or click the Studio screen (no screen capture, no accessibility permission). The logs are the proof.
- A hand-written set needs a `<MxDBlob>` in the device's `<BlobSlot>`, even for a device without stored values (`{}` plus a NUL byte). An empty `<BlobSlot><Value />` crashed Live 12.4.7 right after Max started (EXC_BAD_ACCESS at 0x30). Ableton's own LFO crashed the same way, so it was the set, not the device.
- After a crash, Live asks to restore the set at the next start. Nobody can answer that here, so the script refuses when `CrashRecoveryInfo.cfg` exists.
- Opening a set into a running Live with a changed set waits on a save question. The script always starts Live with the test set.
- Once, Live started with its empty default set instead of the test set (log: `Default App: Begin OnNew`) and then did not quit cleanly. The script now stops with that message; run it again.
- Replacing the device file while Live has the device loaded makes Live swap it at once and carry its state over. When the development device turned into the frozen one this way (M5, Live 12.4.15b7), Live logged 10 `_MxDCore` errors "SendMessage … Fehler 2: Falscher Parameterwert" in that moment; the device worked, and a fresh load of the frozen device logged none.

## Sources

- Google: [Guidance for our effort to block less secure browsers and apps](https://developers.googleblog.com/2020/08/guidance-for-our-effort-to-block-less-secure-browser-and-apps.html)
- Cycling '74: [Web Browser and jweb](https://docs.cycling74.com/userguide/web_browser/), [jweb MaxBridge API](https://docs.cycling74.com/apiref/jweb/)
