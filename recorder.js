// Flameshot GNOME - screen recording.
//
// Recording is delegated to GNOME's own screencast service
// (org.gnome.Shell.Screencast), which records a region through Mutter and
// PipeWire, draws the pointer, and picks a hardware or software encoder.
// While it runs, a red stop button with a timer sits in the top bar and a
// thin frame marks the recorded area. When the recording stops, the video is
// opened in the editor (video-editor.js, a separate GTK process).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const SCREENCAST_IFACE = `
<node>
  <interface name="org.gnome.Shell.Screencast">
    <property name="ScreencastSupported" type="b" access="read"/>
    <method name="ScreencastArea">
      <arg type="i" direction="in" name="x"/>
      <arg type="i" direction="in" name="y"/>
      <arg type="i" direction="in" name="width"/>
      <arg type="i" direction="in" name="height"/>
      <arg type="s" direction="in" name="file_template"/>
      <arg type="a{sv}" direction="in" name="options"/>
      <arg type="b" direction="out" name="success"/>
      <arg type="s" direction="out" name="filename_used"/>
    </method>
    <method name="StopScreencast">
      <arg type="b" direction="out" name="success"/>
    </method>
    <signal name="Error">
      <arg type="s" name="name"/>
      <arg type="s" name="message"/>
    </signal>
  </interface>
</node>`;

const ScreencastProxy = Gio.DBusProxy.makeProxyWrapper(SCREENCAST_IFACE);

// Frame drawn just outside the recorded area, so it is not in the video.
const FRAME_WIDTH = 2;

const RecordingIndicator = GObject.registerClass(
class RecordingIndicator extends PanelMenu.Button {
    _init(onStop) {
        super._init(0.5, 'Flameshot GNOME recording', true);
        this.add_style_class_name('screen-recording-indicator');
        this.accessible_name = 'Stop recording';

        const box = new St.BoxLayout();
        this._label = new St.Label({text: '0:00', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._label);
        box.add_child(new St.Icon({icon_name: 'screencast-stop-symbolic'}));
        this.add_child(box);

        // PanelMenu.Button's own gesture only toggles a menu, and we have none.
        const click = new Clutter.ClickGesture();
        click.set_recognize_on_press(true);
        click.connect('recognize', () => onStop());
        this.add_action(click);

        this._start = GLib.get_monotonic_time();
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._updateLabel();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _updateLabel() {
        const secs = Math.floor((GLib.get_monotonic_time() - this._start) / 1e6);
        this._label.text = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    }

    destroy() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        super.destroy();
    }
});

export class ScreenRecorder {
    constructor(extension) {
        this._extension = extension;
        this._settings = extension.getSettings();
        this._proxy = null;
        this._state = 'idle'; // idle | starting | recording | stopping
        this._path = null;
        this._indicator = null;
        this._frame = null;
    }

    get isRecording() {
        return this._state !== 'idle';
    }

    destroy() {
        if (this._state === 'recording' || this._state === 'starting')
            this._proxy?.StopScreencastAsync().catch(() => {});
        this._cleanupUI();
        if (this._proxy && this._errorId)
            this._proxy.disconnectSignal(this._errorId);
        this._proxy = null;
        this._state = 'idle';
    }

    async _getProxy() {
        if (this._proxy)
            return this._proxy;
        // Creating the proxy synchronously can hang the shell while the
        // service is being activated.
        const proxy = await new Promise((resolve, reject) => {
            const p = new ScreencastProxy(Gio.DBus.session,
                'org.gnome.Shell.Screencast', '/org/gnome/Shell/Screencast',
                (_p, error) => (error ? reject(error) : resolve(p)));
        });
        this._errorId = proxy.connectSignal('Error', (_p, _sender, [, message]) => {
            if (this._state === 'idle')
                return;
            this._failed(`Recording stopped: ${message}`);
        });
        this._proxy = proxy;
        return proxy;
    }

    /** Starts recording a rectangle given in stage coordinates. */
    async start(rect) {
        if (this._state !== 'idle')
            return;
        this._state = 'starting';

        // H.264 needs even dimensions; the service rounds down otherwise.
        const r = {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.max(2, Math.round(rect.w) & ~1),
            h: Math.max(2, Math.round(rect.h) & ~1),
        };

        try {
            const proxy = await this._getProxy();
            if (this._state !== 'starting')
                return;
            if (proxy.ScreencastSupported === false)
                throw new Error('Screen recording is not supported on this system');

            const dir = this.videoDirectory();
            GLib.mkdir_with_parents(dir, 0o755);
            // The service appends the extension (.mp4 or .webm) itself.
            const template = GLib.build_filenamev([dir, 'Screencast from %d %t']);
            const options = {
                'draw-cursor': new GLib.Variant('b', this._settings.get_boolean('record-cursor')),
                'framerate': new GLib.Variant('i', this._settings.get_int('record-framerate')),
            };
            const [success, path] = await proxy.ScreencastAreaAsync(r.x, r.y, r.w, r.h, template, options);
            if (!success)
                throw new Error('The screencast service refused to start');
            this._path = path;
            if (this._state !== 'starting') {
                // Stopped (or disabled) while the service was starting up.
                await proxy.StopScreencastAsync().catch(() => {});
                return;
            }
            this._state = 'recording';
            this._showUI(r);
        } catch (e) {
            logError(e, 'Flameshot GNOME: could not start recording');
            this._failed(`Could not start recording: ${e.message}`);
        }
    }

    async stop() {
        if (this._state === 'starting') {
            this._state = 'idle';
            return;
        }
        if (this._state !== 'recording')
            return;
        this._state = 'stopping';
        this._cleanupUI();
        try {
            const [success] = await this._proxy.StopScreencastAsync();
            if (!success)
                throw new Error('The screencast service was not recording');
        } catch (e) {
            logError(e, 'Flameshot GNOME: could not stop recording');
        }
        this._state = 'idle';

        const path = this._path;
        this._path = null;
        if (!path || !GLib.file_test(path, GLib.FileTest.EXISTS)) {
            Main.notify('Flameshot GNOME', 'The recording could not be saved.');
            return;
        }
        if (this._settings.get_boolean('play-sound'))
            global.display.get_sound_player().play_from_theme('screen-capture', 'Recording finished', null);
        if (this._settings.get_boolean('open-editor-after-recording'))
            this._extension.openVideoEditor(path);
        else if (this._settings.get_boolean('show-notification'))
            Main.notify('Recording saved', GLib.filename_display_name(path));
    }

    _failed(message) {
        this._state = 'idle';
        this._path = null;
        this._cleanupUI();
        Main.notify('Flameshot GNOME', message);
    }

    videoDirectory() {
        const configured = this._settings.get_string('video-directory');
        if (configured)
            return configured.replace(/^~/, GLib.get_home_dir());
        const videos = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS) ??
            GLib.build_filenamev([GLib.get_home_dir(), 'Videos']);
        return GLib.build_filenamev([videos, 'Screencasts']);
    }

    _showUI(r) {
        this._indicator = new RecordingIndicator(() => this.stop());
        Main.panel.addToStatusArea('flameshot-gnome-recording', this._indicator, 0, 'right');

        // Skip the frame when a whole monitor is recorded: it would be off-screen.
        const fullMonitor = Main.layoutManager.monitors.some(m =>
            m.x === r.x && m.y === r.y && m.width === r.w && m.height === r.h);
        if (fullMonitor)
            return;
        this._frame = new St.Widget({style_class: 'fsg-recording-frame'});
        this._frame.set_position(r.x - FRAME_WIDTH, r.y - FRAME_WIDTH);
        this._frame.set_size(r.w + FRAME_WIDTH * 2, r.h + FRAME_WIDTH * 2);
        Shell.util_set_hidden_from_pick(this._frame, true);
        Main.uiGroup.add_child(this._frame);
        Main.uiGroup.set_child_above_sibling(this._frame, null);
    }

    _cleanupUI() {
        this._indicator?.destroy();
        this._indicator = null;
        this._frame?.destroy();
        this._frame = null;
    }
}
