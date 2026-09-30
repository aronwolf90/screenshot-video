import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const ShortcutDialog = GObject.registerClass(
class ShortcutDialog extends Adw.Window {
    _init(parent, onAccel) {
        super._init({
            transient_for: parent,
            modal: true,
            title: 'Set shortcut',
            default_width: 360,
            default_height: 180,
            resizable: false,
        });

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 24,
            margin_bottom: 24,
            margin_start: 24,
            margin_end: 24,
            valign: Gtk.Align.CENTER,
        });
        box.append(new Gtk.Label({label: 'Press the new shortcut', css_classes: ['title-2']}));
        box.append(new Gtk.Label({
            label: 'Escape cancels · Backspace clears',
            css_classes: ['dim-label'],
        }));
        this.set_content(box);

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (_c, keyval, keycode, state) => {
            const mods = state & Gtk.accelerator_get_default_mod_mask();
            if (keyval === Gdk.KEY_Escape && mods === 0) {
                this.close();
                return Gdk.EVENT_STOP;
            }
            if (keyval === Gdk.KEY_BackSpace && mods === 0) {
                onAccel('');
                this.close();
                return Gdk.EVENT_STOP;
            }
            if (this._isModifier(keyval))
                return Gdk.EVENT_STOP;
            if (!Gtk.accelerator_valid(keyval, mods) && !this._isSpecial(keyval))
                return Gdk.EVENT_STOP;
            onAccel(Gtk.accelerator_name_with_keycode(null, keyval, keycode, mods));
            this.close();
            return Gdk.EVENT_STOP;
        });
        this.add_controller(controller);
    }

    _isModifier(keyval) {
        return [
            Gdk.KEY_Shift_L, Gdk.KEY_Shift_R, Gdk.KEY_Control_L, Gdk.KEY_Control_R,
            Gdk.KEY_Alt_L, Gdk.KEY_Alt_R, Gdk.KEY_Super_L, Gdk.KEY_Super_R,
            Gdk.KEY_Meta_L, Gdk.KEY_Meta_R, Gdk.KEY_Hyper_L, Gdk.KEY_Hyper_R,
            Gdk.KEY_ISO_Level3_Shift, Gdk.KEY_Caps_Lock, Gdk.KEY_Num_Lock,
        ].includes(keyval);
    }

    _isSpecial(keyval) {
        // Keys like Print are valid shortcuts on their own even though GTK
        // considers them "invalid" without a modifier.
        return [Gdk.KEY_Print, Gdk.KEY_Menu, Gdk.KEY_Pause, Gdk.KEY_Scroll_Lock].includes(keyval);
    }
});

export default class FlameshotGnomePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(620, 720);

        const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});
        window.add(page);

        // ---------------------------------------------------------- shortcut
        const shortcutGroup = new Adw.PreferencesGroup({
            title: 'Shortcut',
            description: 'GNOME already binds Print and Shift+Print to its own screenshot tool. ' +
                'To use Print here, clear those bindings first:\n' +
                'gsettings set org.gnome.shell.keybindings show-screenshot-ui "[]"',
        });
        page.add(shortcutGroup);

        shortcutGroup.add(this._shortcutRow(window, settings, 'capture-shortcut', 'Start capture'));
        shortcutGroup.add(this._shortcutRow(window, settings, 'record-shortcut',
            'Start / stop screen recording'));

        const indicatorRow = new Adw.SwitchRow({
            title: 'Show icon in top bar',
            subtitle: 'Adds a camera icon with a menu to capture, record or edit a video',
        });
        settings.bind('show-indicator', indicatorRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        shortcutGroup.add(indicatorRow);

        // ---------------------------------------------------------- saving
        const saveGroup = new Adw.PreferencesGroup({title: 'Saving'});
        page.add(saveGroup);

        saveGroup.add(this._folderRow(window, settings, 'save-directory', 'Save folder',
            'Choose screenshot folder', GLib.UserDirectory.DIRECTORY_PICTURES, 'Pictures'));

        const patternRow = new Adw.EntryRow({title: 'File name pattern'});
        settings.bind('filename-pattern', patternRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        saveGroup.add(patternRow);

        const patternHint = new Adw.ActionRow({
            title: 'Placeholders',
            subtitle: '%Y year · %m month · %d day · %H hour · %M minute · %S second (strftime format)',
            activatable: false,
        });
        patternHint.add_css_class('property');
        saveGroup.add(patternHint);

        const askRow = new Adw.SwitchRow({
            title: 'Ask where to save',
            subtitle: 'Open a file chooser on Save (Ctrl+Shift+S always asks)',
        });
        settings.bind('ask-where-to-save', askRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        saveGroup.add(askRow);

        const copyOnSaveRow = new Adw.SwitchRow({
            title: 'Copy to clipboard when saving',
        });
        settings.bind('copy-on-save', copyOnSaveRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        saveGroup.add(copyOnSaveRow);

        // ---------------------------------------------------------- capture
        const captureGroup = new Adw.PreferencesGroup({title: 'Capture'});
        page.add(captureGroup);

        for (const [key, title, subtitle] of [
            ['include-cursor', 'Include mouse pointer', ''],
            ['show-size-label', 'Show selection size', ''],
            ['show-notification', 'Show notification', 'After copying or saving'],
            ['play-sound', 'Play shutter sound', ''],
        ]) {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            captureGroup.add(row);
        }

        // ---------------------------------------------------------- recording
        const recordGroup = new Adw.PreferencesGroup({
            title: 'Screen recording',
            description: 'Recordings are made by GNOME\'s screencast service and open in the ' +
                'video editor, where annotations can be shown for a part of the video. ' +
                'Exporting needs ffmpeg.',
        });
        page.add(recordGroup);

        recordGroup.add(this._folderRow(window, settings, 'video-directory', 'Video folder',
            'Choose video folder', GLib.UserDirectory.DIRECTORY_VIDEOS, 'Videos'));

        for (const [key, title, subtitle] of [
            ['record-cursor', 'Show mouse pointer', ''],
            ['open-editor-after-recording', 'Open editor after recording', 'Otherwise only a notification is shown'],
        ]) {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            recordGroup.add(row);
        }

        const fpsRow = new Adw.SpinRow({
            title: 'Frame rate',
            subtitle: 'Frames per second',
            adjustment: new Gtk.Adjustment({lower: 5, upper: 60, step_increment: 5}),
        });
        settings.bind('record-framerate', fpsRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        recordGroup.add(fpsRow);

        // ---------------------------------------------------------- drawing
        const drawGroup = new Adw.PreferencesGroup({title: 'Drawing'});
        page.add(drawGroup);

        const colorRow = new Adw.ActionRow({title: 'Default colour'});
        const rgba = new Gdk.RGBA();
        rgba.parse(settings.get_string('default-color'));
        const colorButton = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({with_alpha: false}),
            rgba,
            valign: Gtk.Align.CENTER,
        });
        colorButton.connect('notify::rgba', () => {
            const c = colorButton.rgba;
            const hex = '#' + [c.red, c.green, c.blue]
                .map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
            settings.set_string('default-color', hex);
        });
        colorRow.add_suffix(colorButton);
        drawGroup.add(colorRow);

        const thicknessRow = new Adw.SpinRow({
            title: 'Default thickness',
            subtitle: 'Mouse wheel or [ ] changes it while capturing',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 40, step_increment: 1}),
        });
        settings.bind('default-thickness', thicknessRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        drawGroup.add(thicknessRow);

        const rememberRow = new Adw.SwitchRow({
            title: 'Remember colour and thickness',
            subtitle: 'Keep the last used values until the shell restarts',
        });
        settings.bind('remember-tool-state', rememberRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        drawGroup.add(rememberRow);

        // ---------------------------------------------------------- keys
        const keysGroup = new Adw.PreferencesGroup({title: 'Keyboard while capturing'});
        page.add(keysGroup);
        const keys = [
            ['Enter', 'Copy to clipboard and close'],
            ['Ctrl+C / Ctrl+S / Ctrl+Shift+S', 'Copy / Save / Save as…'],
            ['Ctrl+P / Ctrl+O', 'Pin to screen / Open with default app'],
            ['Ctrl+R', 'Record the selected area'],
            ['Ctrl+A', 'Select whole monitor (again: all monitors)'],
            ['Click', 'Select window under pointer'],
            ['P L A R E M T B N', 'Pencil, Line, Arrow, Rectangle, Ellipse, Marker, Text, Pixelate, Counter'],
            ['Shift while drawing', 'Filled rectangle / ellipse'],
            ['1 – 9', 'Pick colour'],
            ['Wheel, [ ]', 'Stroke thickness'],
            ['Click a drawing, V, Delete', 'Select a drawing (dashed outline), drag to move, Delete / trash button / right click removes it'],
            ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / Redo'],
            ['Arrows (Shift: ×10, Ctrl: resize)', 'Move or resize the selection'],
            ['Space', 'Hide or show the toolbar'],
            ['Esc / Right click', 'Drop tool, then cancel'],
        ];
        for (const [combo, what] of keys) {
            const row = new Adw.ActionRow({title: what, subtitle: combo});
            row.add_css_class('property');
            keysGroup.add(row);
        }
    }

    _shortcutRow(window, settings, key, title) {
        const row = new Adw.ActionRow({title});
        const label = new Gtk.ShortcutLabel({
            disabled_text: 'Disabled',
            valign: Gtk.Align.CENTER,
        });
        const updateLabel = () => {
            label.accelerator = settings.get_strv(key)[0] ?? '';
        };
        updateLabel();
        settings.connect(`changed::${key}`, updateLabel);
        row.add_suffix(label);
        row.activatable_widget = label;
        row.activatable = true;
        row.connect('activated', () => {
            const dialog = new ShortcutDialog(window, accel => {
                settings.set_strv(key, accel ? [accel] : []);
            });
            dialog.present();
        });
        return row;
    }

    _folderRow(window, settings, key, title, dialogTitle, specialDir, fallback) {
        const subtitle = () => {
            const dir = settings.get_string(key);
            if (dir)
                return dir;
            const base = GLib.get_user_special_dir(specialDir) ??
                GLib.build_filenamev([GLib.get_home_dir(), fallback]);
            const sub = specialDir === GLib.UserDirectory.DIRECTORY_VIDEOS ? 'Screencasts' : 'Screenshots';
            return `${GLib.build_filenamev([base, sub])} (default)`;
        };
        const row = new Adw.ActionRow({title, subtitle: subtitle()});
        const button = new Gtk.Button({icon_name: 'folder-open-symbolic', valign: Gtk.Align.CENTER});
        button.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: dialogTitle});
            const current = settings.get_string(key);
            if (current)
                dialog.set_initial_folder(Gio.File.new_for_path(current));
            dialog.select_folder(window, null, (d, res) => {
                try {
                    const folder = d.select_folder_finish(res);
                    settings.set_string(key, folder.get_path());
                } catch (e) {
                    // cancelled
                }
            });
        });
        const reset = new Gtk.Button({icon_name: 'edit-clear-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Use default'});
        reset.connect('clicked', () => settings.set_string(key, ''));
        row.add_suffix(reset);
        row.add_suffix(button);
        settings.connect(`changed::${key}`, () => {
            row.subtitle = subtitle();
        });
        return row;
    }
}
