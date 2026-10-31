// The editor page as text. A development install reads it from ui/; the
// release bundle (tools/build-release.mjs) puts the text in its place,
// because a frozen device carries only the files that Max knows about.
const fs = require('node:fs');
const path = require('node:path');

module.exports = () => fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
