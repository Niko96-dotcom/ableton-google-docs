// The OAuth client built into the device: { id, secret } or null. The source
// has none; the release bundle (tools/build-release.mjs) puts the device's
// public client in its place. A client.json in SECRETS_DIR wins over it.
// Google treats a desktop app's client secret as public, so the release may
// carry it; it never goes into git.
module.exports = null;
