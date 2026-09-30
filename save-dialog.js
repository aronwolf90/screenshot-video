// Flameshot GNOME - "Save as…" helper.
//
// GNOME Shell cannot show GTK dialogs itself, so the extension runs this
// script in a separate gjs process. It prints the chosen path on stdout, or
// nothing if the dialog was cancelled.
//
// Usage: gjs -m save-dialog.js <initial-folder> <initial-name>

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

const [initialFolder, initialName] = System.programArgs;

Gtk.init();

const pngFilter = new Gtk.FileFilter({name: 'PNG image'});
pngFilter.add_mime_type('image/png');
const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
filters.append(pngFilter);

const dialog = new Gtk.FileDialog({
    title: 'Save screenshot',
    modal: true,
    initial_name: initialName || 'Screenshot.png',
    filters,
    default_filter: pngFilter,
});
if (initialFolder && GLib.file_test(initialFolder, GLib.FileTest.IS_DIR))
    dialog.set_initial_folder(Gio.File.new_for_path(initialFolder));

const loop = new GLib.MainLoop(null, false);
dialog.save(null, null, (source, result) => {
    try {
        const file = source.save_finish(result);
        let path = file.get_path();
        if (!path.toLowerCase().endsWith('.png'))
            path += '.png';
        print(path);
    } catch (e) {
        // Cancelled or failed: print nothing.
    }
    loop.quit();
});
loop.run();
