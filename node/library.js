// Where Live's User Library is. Live keeps it in Library.cfg of its newest
// preferences folder; without one, Live uses ~/Music/Ableton/User Library.
// The device's settings and logs live in <User Library>/Google Docs, because
// a frozen device runs node from Max's cache, not from the User Library.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function findUserLibrary(home = os.homedir()) {
  const prefs = path.join(home, 'Library', 'Preferences', 'Ableton');
  let versions = [];
  try {
    versions = fs.readdirSync(prefs).filter((d) => /^Live \d/.test(d));
  } catch {
    // No Live preferences.
  }
  versions.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  for (const dir of versions.reverse()) {
    let cfg;
    try {
      cfg = fs.readFileSync(path.join(prefs, dir, 'Library.cfg'), 'utf8');
    } catch {
      continue;
    }
    const block = cfg.match(/<UserLibrary>([\s\S]*?)<\/UserLibrary>/)?.[1];
    const projectPath = block?.match(/<ProjectPath Value="([^"]*)"/)?.[1];
    const projectName = block?.match(/<ProjectName Value="([^"]*)"/)?.[1];
    if (projectPath && projectName) return path.join(projectPath, projectName);
  }
  return path.join(home, 'Music', 'Ableton', 'User Library');
}

module.exports = { findUserLibrary };
