UNDOK — Homey App

Control your UNDOK / Frontier Silicon internet radio directly from Homey.

This app is not affiliated with, endorsed by, or connected to Frontier Silicon Ltd.
or the UNDOK brand. UNDOK is a trademark of Frontier Silicon Ltd. This app uses
the local FSAPI protocol to communicate directly with compatible devices on your
local network.


SUPPORTED DEVICES

Any internet radio based on the Frontier Silicon chipset that supports the FSAPI
protocol and is compatible with the UNDOK app. This includes radios from brands
such as Kenwood, Hama, Medion, Revo, Roberts, Ruark, and many others.


FEATURES

- Automatic discovery of radios on your local network via SSDP
- Control multiple radios independently
- Turn on/off
- Select source (Internet Radio, DAB+, FM, CD, USB)
- Select preset (internet radio station)
- Volume control (set, up, down, mute, unmute)
- Playback control (play, pause, next, previous track)
- Now playing information: source, station name, song and artist
- Full Flow integration with trigger, condition and action cards


FLOW CARDS

When: Radio turned on · Radio turned off · Volume changed · Preset changed
And: Radio is on · Radio is off · Radio is muted · Current preset is equal to · Current volume is
Then: Turn on · Turn off · Select source · Select preset · Set volume · Volume up · Volume down · Mute · Unmute · Play · Pause · Next track · Previous track · Turn on with source + preset + volume


SETUP

1. Install the app
2. Go to Add Device and select UNDOK
3. Your radio will be discovered automatically
4. If your radio uses a non-default PIN, change it in the device settings after pairing
   (default PIN: 1234)


NOTES

- The radio must be on the same local network as your Homey
- Playback controls (play, pause, next, previous) only work when an applicable source
  is selected (CD or USB)
- Radio status is polled every 5 seconds


SUPPORT

For questions or issues, please visit:
https://github.com/TimdeBruinNL/com.timdebruin.undok/issues
