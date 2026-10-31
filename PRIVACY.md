# Privacy policy

"Docs for Ableton Live" is the Google sign-in of the Max for Live device in this repository. The device runs on your Mac inside Ableton Live. There is no server: the device talks only to Google, and the developer receives none of your data.

## What the device accesses

After you sign in, the device asks Google for these permissions:

- `documents`: read and edit the Google Docs you open in the device.
- `drive.file`: create new docs in your Drive.
- `drive.metadata.readonly`: the names and dates of your Drive files, for the doc list. Not their content.

The device uses this access only to show, edit and create docs on your request, and to show changes other people make to the open doc.

## What stays on your Mac

- The Google sign-in (OAuth token): `~/Library/Application Support/ableton-google-docs/token.json`, readable only by your user account.
- The ID of the doc a Live set uses: inside that Live set.
- A log file: `<User Library>/Google Docs/logs/device.log`. It never holds tokens, doc names or doc text.

Nothing else is stored, sent to anyone other than Google, sold or used for ads.

## How to remove access

Click **Sign out** in the editor: the device deletes the token and revokes it at Google. You can also remove the access in your Google Account under Security → Third-party apps & services.

## Google API Services User Data Policy

The use and transfer of information received from Google APIs to any other app adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

## Contact

Open an issue in this repository.
