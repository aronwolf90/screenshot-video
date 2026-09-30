# Flameshot GNOME

A Flameshot-style screenshot tool built as a **native GNOME Shell extension**.
Because it runs inside the compositor it works on Wayland without the
window-placement, multi-monitor and permission problems that Qt/GTK screenshot
apps hit on GNOME.

Press the shortcut, the screen freezes, drag a region, annotate, then copy,
save, pin or open the result. It can also record the screen and annotate the
recording with the same tools.

## Features

- Frozen full-screen capture on all monitors, with dimmed shade and crosshair
- Drag to select, click a window to select it, Ctrl+A for the whole monitor
- Move the selection by dragging it; resize with the eight handles or arrow keys
- Annotation tools: pencil, line, arrow, rectangle, ellipse, marker
  (highlighter), text, pixelate, numbered counter
- Nine colours, adjustable thickness (mouse wheel), undo / redo
- Click a drawing to select it, drag it around, or delete it
- Actions: copy to clipboard, save (direct or with a file chooser), pin the
  image to the screen as a floating, draggable, zoomable widget, open with the
  default image viewer
- Screen recording of an area, a window or a monitor, with the mouse pointer
  (no audio), followed by a video editor with the same annotation tools
- Top-bar indicator, GSettings preferences, and a D-Bus API for scripting
- HiDPI / fractional scaling aware (exports at native pixel resolution)

## Requirements

GNOME Shell 50 (Wayland or X11). The video editor needs `ffmpeg` (with
`ffprobe`), GTK 4 and libadwaita.

## Install

```sh
make install
```

then log out and back in (GNOME on Wayland cannot load new extensions into a
running session), and enable it:

```sh
gnome-extensions enable flameshot-gnome@aronwolf90.github.io
```

For development, `make link` symlinks this directory into the extensions
folder instead of copying.

## Usage

Default shortcut: **Super+Print**. Change it in the preferences.

If you want plain **Print** like Flameshot, first free it from GNOME's own
screenshot UI:

```sh
gsettings set org.gnome.shell.keybindings show-screenshot-ui "[]"
```

| Key | Action |
| --- | --- |
| Enter | Copy to clipboard and close |
| Ctrl+C / Ctrl+S / Ctrl+Shift+S | Copy / Save / Save as… |
| Ctrl+P / Ctrl+O | Pin to screen / Open with default app |
| Ctrl+R, record button | Record the selected area |
| Ctrl+A | Select the monitor under the pointer (again: all monitors) |
| Click | Select the window under the pointer |
| P L A R E M T B N | Pencil, Line, Arrow, Rectangle, Ellipse, Marker, Text, Pixelate, Counter |
| Shift while drawing | Filled rectangle / ellipse |
| 1 – 9 | Pick a colour |
| Mouse wheel, `[` `]` | Change thickness |
| Click a drawing, or V for the Select tool | Select it (dashed outline); drag to move it |
| Delete / Backspace, trash button, right click | Remove the selected drawing / the drawing under the pointer |
| Ctrl+Z / Ctrl+Shift+Z | Undo / Redo (adding, removing and moving drawings) |
| Arrows (Shift ×10, Ctrl resizes) | Move / resize the selection |
| Space | Hide / show the toolbar |
| Esc, right click | Drop the active tool; Esc again cancels |

Text tool: click to place, type, Enter commits, Shift+Enter inserts a line
break, Ctrl+V pastes.

Pinned images: drag to move, scroll to zoom, right-click or double-click to
close.

## Screen recording

Press **Shift+Super+Print** (or use *Record screen* in the top-bar menu, or
the red record button in the capture toolbar), select an area, a window or
the whole monitor, and press Enter. A red timer appears in the top bar and a
thin frame marks the recorded area; click the timer or press the shortcut
again to stop. Recordings are saved to `~/Videos/Screencasts` and open in the
video editor.

### Video editor

A drawing appears at the frame where you draw it and stays until you remove
it. The intended flow:

1. Go to a point in the video (play, scrub the timeline, or step frames).
2. Draw, for example an arrow. Drawing pauses playback.
3. Play on. At the point where the arrow should go away, select it and press
   **Delete** (or right-click it). It is hidden from that frame on.
4. Continue.

The timeline shows every drawing as a bar. Drag a bar's ends to change when it
appears or disappears, or its middle to shift it in time. Click a bar to
select the drawing.

| Key | Action |
| --- | --- |
| Space | Play / pause |
| Left / Right (Shift: 1 s) | Previous / next frame |
| Home / End | Start / end |
| P L A R E M T B N, V | Tools, as in the screenshot overlay; V selects |
| 1 – 9, wheel, `[` `]` | Colour, thickness (a colour also recolours the selected drawing) |
| Delete, right click | Remove the drawing from the current frame on |
| Shift+Delete | Remove the drawing completely |
| Ctrl+Z / Ctrl+Shift+Z | Undo / Redo |
| Ctrl+E / Ctrl+Shift+E | Export / Export as… |
| Ctrl+S | Save editable video… |
| Ctrl+O | Open another video |

Drawings are saved automatically per video (in
`~/.cache/flameshot-gnome/video-projects`) and come back when the same file
is opened again. **Export** writes `<name> (annotated).mp4` next to the
recording and copies the file to the clipboard; *Export as…* also offers WebM
and animated GIF. Closing the editor with drawings that were not exported
asks first. Any video can be opened with *Edit a video…* in the top-bar menu.

To keep working on a video later (on another machine, or after the cache is
cleared), use **Save editable video…** from the Export menu. It writes one
`.mkv` file that plays in any video player with the drawings shown, and also
contains the untouched recording as a second track plus the drawings as an
attached JSON file. Opening that file in the editor brings back every
drawing, still editable; saving it again updates the same file.

## Scripting (D-Bus)

```sh
# Open the capture UI
gdbus call --session --dest org.gnome.Shell \
  --object-path /org/gnome/Shell/Extensions/FlameshotGnome \
  --method org.gnome.Shell.Extensions.FlameshotGnome.Capture

# Preselect a region and copy it immediately (actions: copy, save, save-as, pin, open, record, or "")
gdbus call --session --dest org.gnome.Shell \
  --object-path /org/gnome/Shell/Extensions/FlameshotGnome \
  --method org.gnome.Shell.Extensions.FlameshotGnome.CaptureRegion 100 100 800 600 copy

# Recording: pick an area (or stop), record a fixed area, stop, open a video in the editor
gdbus call ... --method org.gnome.Shell.Extensions.FlameshotGnome.Record
gdbus call ... --method org.gnome.Shell.Extensions.FlameshotGnome.RecordRegion 0 0 1280 720
gdbus call ... --method org.gnome.Shell.Extensions.FlameshotGnome.StopRecording
gdbus call ... --method org.gnome.Shell.Extensions.FlameshotGnome.EditVideo /path/to/video.mp4
```

## How it works

The extension asks Mutter for a texture of the current stage
(`Shell.Screenshot.screenshot_stage_to_content`), shows it in a full-screen
actor, and draws annotations on a Cairo `St.DrawingArea` positioned over the
selection. On export the image-plus-annotations actor is painted offscreen
(`paint_to_content`) and cropped/encoded to PNG by
`Shell.Screenshot.composite_to_stream`, the same path GNOME's built-in
screenshot UI uses. The clipboard is filled via `St.Clipboard`, so the image
stays available after the overlay closes.

Recording uses GNOME's own screencast service (`org.gnome.Shell.Screencast`),
the one behind the built-in screenshot UI: it records the area through Mutter
and PipeWire, draws the pointer, and picks a hardware or software encoder.

The video editor (`video-editor.js`, a GTK 4 / libadwaita app run as a
separate `gjs` process) shares the drawing code with the overlay
(`drawing.js`). Playback runs an `ffmpeg` process that decodes raw frames at a
constant frame rate into a pipe (`editor/media.js`); seeking restarts it, so
seeking is frame-accurate and no GTK media backend is needed. Export
(`editor/export.js`) renders each drawing to a small PNG with the same Cairo
code and has `ffmpeg` overlay it for its time span; pixelate regions are done
by `ffmpeg` itself so they follow the moving video.

## Development

```sh
make check   # syntax check with node
make link    # symlink into ~/.local/share/gnome-shell/extensions
# run a nested shell for testing without logging out:
dbus-run-session -- env GSETTINGS_BACKEND=memory gnome-shell --headless --wayland \
  --no-x11 --wayland-display=wayland-test --virtual-monitor 1600x900 --unsafe-mode
# the editor can be run on its own:
gjs -m video-editor.js some-video.mp4
```
