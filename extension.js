// Flameshot GNOME - extension entry point.
//
// Registers the capture and record shortcuts, an optional top-bar indicator
// and a small D-Bus API (org.gnome.Shell.Extensions.FlameshotGnome) so the
// capture can be scripted the way `flameshot gui` can.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {ScreenshotOverlay} from './overlay.js';
import {ScreenRecorder} from './recorder.js';

const DBUS_IFACE = `
<node>
  <interface name="org.gnome.Shell.Extensions.FlameshotGnome">
    <method name="Capture"/>
    <method name="CaptureRegion">
      <arg type="i" name="x" direction="in"/>
      <arg type="i" name="y" direction="in"/>
      <arg type="i" name="width" direction="in"/>
      <arg type="i" name="height" direction="in"/>
      <arg type="s" name="action" direction="in"/>
    </method>
    <method name="IsOpen">
      <arg type="b" name="open" direction="out"/>
    </method>
    <method name="Record"/>
    <method name="RecordRegion">
      <arg type="i" name="x" direction="in"/>
      <arg type="i" name="y" direction="in"/>
      <arg type="i" name="width" direction="in"/>
      <arg type="i" name="height" direction="in"/>
    </method>
    <method name="StopRecording"/>
    <method name="IsRecording">
      <arg type="b" name="recording" direction="out"/>
    </method>
    <method name="EditVideo">
      <arg type="s" name="path" direction="in"/>
    </method>
  </interface>
</node>`;

const DBUS_PATH = '/org/gnome/Shell/Extensions/FlameshotGnome';

export default class FlameshotGnomeExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._overlay = null;
        this.toolState = null;
        this._recorder = new ScreenRecorder(this);

        Main.wm.addKeybinding(
            'capture-shortcut',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this.capture());
        Main.wm.addKeybinding(
            'record-shortcut',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this.toggleRecording());

        this._settingsChangedId = this._settings.connect('changed::show-indicator',
            () => this._syncIndicator());
        this._syncIndicator();

        this._dbus = Gio.DBusExportedObject.wrapJSObject(DBUS_IFACE, this);
        this._dbus.export(Gio.DBus.session, DBUS_PATH);
    }

    disable() {
        Main.wm.removeKeybinding('capture-shortcut');
        Main.wm.removeKeybinding('record-shortcut');

        if (this._dbus) {
            this._dbus.unexport();
            this._dbus = null;
        }
        for (const id of ['_pendingCaptureId', '_pendingRecordId']) {
            if (this[id]) {
                GLib.source_remove(this[id]);
                this[id] = 0;
            }
        }
        this._recorder?.destroy();
        this._recorder = null;
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        this._indicator?.destroy();
        this._indicator = null;
        this._overlay?.close();
        this._overlay = null;
        this._settings = null;
    }

    // ------------------------------------------------------------ capture

    /**
     * Opens the capture overlay. Resolves with the overlay once the screen
     * has been frozen, or null if a capture is already running.
     */
    async capture(options = {}) {
        if (this._overlay || (options.mode === 'record' && this._recorder.isRecording))
            return null;
        const overlay = new ScreenshotOverlay(this, options);
        this._overlay = overlay;
        overlay.connect('closed', () => {
            if (this._overlay === overlay)
                this._overlay = null;
        });
        await overlay.open();
        return overlay.isOpen ? overlay : null;
    }

    _captureAfterDelay(ms, options = {}) {
        if (this._pendingCaptureId)
            GLib.source_remove(this._pendingCaptureId);
        this._pendingCaptureId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._pendingCaptureId = 0;
            this.capture(options).catch(e => logError(e, 'Flameshot GNOME: capture failed'));
            return GLib.SOURCE_REMOVE;
        });
    }

    // ------------------------------------------------------------ recording

    /** Record shortcut: pick an area to record, or stop the running recording. */
    toggleRecording() {
        if (this._recorder.isRecording)
            this._recorder.stop();
        else
            this.capture({mode: 'record'}).catch(e => logError(e, 'Flameshot GNOME: capture failed'));
    }

    /** Starts recording a stage rectangle once the overlay has faded from the screen. */
    startRecording(rect) {
        if (this._pendingRecordId)
            GLib.source_remove(this._pendingRecordId);
        this._pendingRecordId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._pendingRecordId = 0;
            this._recorder.start(rect);
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Opens the video editor (a separate GTK process) for a file, or a file chooser. */
    openVideoEditor(path = '') {
        const argv = ['gjs', '-m', GLib.build_filenamev([this.path, 'video-editor.js'])];
        if (path)
            argv.push(path);
        try {
            const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
            launcher.set_cwd(GLib.get_home_dir());
            launcher.spawnv(argv);
        } catch (e) {
            logError(e, 'Flameshot GNOME: could not start the video editor');
            Main.notify('Flameshot GNOME', `Could not start the video editor: ${e.message}`);
        }
    }

    // ------------------------------------------------------------ D-Bus

    Capture() {
        this.capture().catch(e => logError(e, 'Flameshot GNOME: capture failed'));
    }

    async CaptureRegionAsync([x, y, width, height, action], invocation) {
        try {
            const overlay = await this.capture();
            if (!overlay) {
                invocation.return_error_literal(Gio.DBusError, Gio.DBusError.FAILED,
                    'A capture is already in progress');
                return;
            }
            if (width > 0 && height > 0)
                overlay.selectRegion({x, y, w: width, h: height});
            if (action)
                overlay.runAction(action);
            invocation.return_value(null);
        } catch (e) {
            invocation.return_error_literal(Gio.DBusError, Gio.DBusError.FAILED, e.message);
        }
    }

    IsOpen() {
        return this._overlay !== null;
    }

    Record() {
        this.toggleRecording();
    }

    RecordRegion(x, y, width, height) {
        if (!this._recorder.isRecording && !this._overlay)
            this._recorder.start({x, y, w: width, h: height});
    }

    StopRecording() {
        this._recorder.stop();
    }

    IsRecording() {
        return this._recorder.isRecording;
    }

    EditVideo(path) {
        this.openVideoEditor(path);
    }

    // ------------------------------------------------------------ indicator

    _syncIndicator() {
        const show = this._settings.get_boolean('show-indicator');
        if (show && !this._indicator)
            this._indicator = this._createIndicator();
        else if (!show && this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }

    _createIndicator() {
        const indicator = new PanelMenu.Button(0.0, 'Flameshot GNOME', false);
        indicator.add_child(new St.Icon({
            gicon: Gio.icon_new_for_string(`${this.path}/icons/fsg-camera-symbolic.svg`),
            style_class: 'system-status-icon',
        }));

        const captureItem = new PopupMenu.PopupMenuItem('Take screenshot');
        captureItem.connect('activate', () => {
            // Give the menu time to fade out so it isn't in the frozen image.
            this._captureAfterDelay(250);
        });
        indicator.menu.addMenuItem(captureItem);

        const recordItem = new PopupMenu.PopupMenuItem('Record screen');
        recordItem.connect('activate', () => {
            if (this._recorder.isRecording)
                this._recorder.stop();
            else
                this._captureAfterDelay(250, {mode: 'record'});
        });
        indicator.menu.addMenuItem(recordItem);
        indicator.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                recordItem.label.text = this._recorder.isRecording ? 'Stop recording' : 'Record screen';
        });

        const editItem = new PopupMenu.PopupMenuItem('Edit a video…');
        editItem.connect('activate', () => this.openVideoEditor());
        indicator.menu.addMenuItem(editItem);

        indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const prefsItem = new PopupMenu.PopupMenuItem('Preferences…');
        prefsItem.connect('activate', () => this.openPreferences());
        indicator.menu.addMenuItem(prefsItem);

        Main.panel.addToStatusArea('flameshot-gnome', indicator);
        return indicator;
    }
}
