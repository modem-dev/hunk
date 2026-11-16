# hunk song

Hunk's synthwave theme for product videos: 12 bars in E minor at 99.25 BPM, 30.2 s with its ring-out.
This folder is the DAW-neutral source, so the song can be rebuilt or re-cut in any DAW.

| File                | What it holds                                                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hunk-song.mid`     | Standard MIDI File (type 1, 960 PPQ): a conductor track with tempo, 4/4 and section markers, then one named track per part, tick-for-tick from the original session. |
| `hunk-song-60s.mid` | A 59.4 s cut for minute-long videos, as MIDI.                                                                                                                        |
| `sound.json`        | Everything MIDI cannot carry: each part's synth patch, effects chain, fader, pan and automation, the master chain, chords, sections, and the bar spans of each cut.  |
| `reference.mp3`     | The original session's mixdown, for A/B checks while rebuilding.                                                                                                     |

## Rebuilding in a DAW

1. Set the project to 99.25 BPM, 4/4, then import `hunk-song.mid` at bar 1. Most DAWs read the
   tempo, track names and markers from the file.
2. Give each track the instrument and effects in `sound.json`. The original used REAPER's stock
   plugins (ReaSynth, ReaVerbate, ReaDelay, JS chorus/saturation) and Apple's built-in GM synth, so
   any subtractive synth, reverb, delay and chorus can match them from the listed settings.
3. Set faders and pans from `sound.json`, and draw the pad's volume pump.
4. Compare against `reference.mp3`; the mix sits at -18.2 LUFS integrated.

Each track also carries a General MIDI channel and program (808 kit on channel 10, synth bass, warm
pad, saw and square leads), so the MIDI plays recognisably in any GM player before you add patches.

## Cutting to picture

The song is built from 3-bar chord cycles, so it lengthens or shortens on bar lines without a
tempo change. Bars are 0-based and one bar is 2.418 s. Every cut keeps the intro (bar 0) under the
title card and the break and final bar (10 and 11) under the end card, and repeats the B and C
cycles (bars 4-9, which carry the lead hook) to fill the middle. `sound.json` lists each cut's
spans as `[sourceStartBar, sourceEndBar, destinationBar]`.

Audio cuts work the same way: splice the reference render on the bar lines with short (about 12 ms)
crossfades, then fade the last second under the video's end.

## Notes

- Swing is already in the MIDI timing; do not add groove quantize on top.
- The Pad fader is 0 dB in the final session, 4 dB above the level it was first generated at.
- Offline renders of Apple's DLSMusicDevice crashed REAPER 7.81 on macOS in November 2026. If yours
  does too, render the two drum tracks with a different GM or 808 instrument.
