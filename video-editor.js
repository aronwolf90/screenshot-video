// Flameshot GNOME - video editor.
//
// Opens a recording and lets you annotate it with the screenshot tools. A
// drawing appears at the moment it is drawn and stays until it is removed:
// pause, draw an arrow, play on, press Delete where the arrow should go away,
// continue. The timeline shows every drawing's time span, and its ends can be
// dragged. Annotations are kept per video in ~/.cache/flameshot-gnome, and
// Export renders them into a new MP4, WebM or GIF with ffmpeg.
//
// GNOME Shell cannot show GTK windows, so the extension starts this file as a
// separate process: gjs -m video-editor.js [VIDEO]

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Gsk from 'gi://Gsk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import System from 'system';

import {
    COLORS, MAX_SIZE, MIN_SIZE, TOOLS, drawSelectionOutline, drawShape,
    isShapeTooSmall, nextCounter, normalizeRect, pixelateBlock,
    setShapeGeometry, shapeAt, shapeGeometry, translateGeometry,
} from './drawing.js';
import {EDITABLE, FORMATS, exportVideo, formatForPath} from './editor/export.js';
import {Decoder, haveFfmpeg, probe, readAnnotations} from './editor/media.js';
import {Timeline, formatTime} from './editor/timeline.js';

const APP_ID = 'io.github.aronwolf90.FlameshotGnome.VideoEditor';
const SCHEMA_ID = 'org.gnome.shell.extensions.flameshot-gnome';
const DIR = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const MIN_DRAG = 3;

Gio._promisify(Gtk.FileDialog.prototype, 'open', 'open_finish');
Gio._promisify(Gtk.FileDialog.prototype, 'save', 'save_finish');
Gio._promisify(Gtk.FileLauncher.prototype, 'open_containing_folder', 'open_containing_folder_finish');
Gio._promisify(Gdk.Clipboard.prototype, 'read_text_async', 'read_text_finish');
Gio._promisify(Adw.AlertDialog.prototype, 'choose', 'choose_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

const CSS = `
.fsg-canvas { background-color: #000; }
.fsg-swatch {
  min-width: 18px; min-height: 18px; padding: 0; margin: 4px 2px;
  border-radius: 99px; border: 1px solid alpha(white, 0.3);
}
.fsg-swatch:checked { box-shadow: 0 0 0 2px @window_bg_color, 0 0 0 4px @accent_color; }
.fsg-size { min-width: 26px; font-weight: bold; font-feature-settings: "tnum"; }
.fsg-time { font-feature-settings: "tnum"; min-width: 130px; }
.fsg-timeline { background-color: @view_bg_color; }
${COLORS.map((c, i) => `.fsg-color-${i} { background: ${c}; }`).join('\n')}
`;

function loadSettings() {
    const source = Gio.SettingsSchemaSource.new_from_directory(
        GLib.build_filenamev([DIR, 'schemas']), Gio.SettingsSchemaSource.get_default(), false);
    const schema = source.lookup(SCHEMA_ID, false);
    return schema ? new Gio.Settings({settings_schema: schema}) : null;
}

function rect(x, y, w, h) {
    return new Graphene.Rect().init(x, y, w, h);
}

function uniqueFile(dir, name) {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let file = Gio.File.new_for_path(GLib.build_filenamev([dir, name]));
    for (let i = 2; file.query_exists(null); i++)
        file = Gio.File.new_for_path(GLib.build_filenamev([dir, `${stem} ${i}${ext}`]));
    return file;
}

/** Drawing without the cached text measurements, for saving and undo. */
function cleanShape(s) {
    const {_bounds, ...rest} = s;
    return rest;
}

// ==================================================================== canvas

const VideoCanvas = GObject.registerClass(
class VideoCanvas extends Gtk.Widget {
    _init(editor) {
        super._init({hexpand: true, vexpand: true, focusable: true, css_classes: ['fsg-canvas']});
        this.set_size_request(320, 240);
        this._editor = editor;
        this._pixCache = {frame: null, map: new Map()};
        this.set_overflow(Gtk.Overflow.HIDDEN);
    }

    /** Where the video sits inside the widget. */
    layout() {
        const {info} = this._editor;
        const W = this.get_width(), H = this.get_height();
        const scale = Math.min(W / info.width, H / info.height);
        const w = info.width * scale, h = info.height * scale;
        return {scale, ox: (W - w) / 2, oy: (H - h) / 2, w, h};
    }

    toVideo(x, y) {
        const {scale, ox, oy} = this.layout();
        return {x: Math.round((x - ox) / scale), y: Math.round((y - oy) / scale)};
    }

    vfunc_snapshot(snapshot) {
        const ed = this._editor;
        const W = this.get_width(), H = this.get_height();
        if (W <= 0 || H <= 0 || !ed.info)
            return;
        const L = this.layout();
        snapshot.append_color(new Gdk.RGBA({red: 0, green: 0, blue: 0, alpha: 1}), rect(0, 0, W, H));
        if (ed.frame)
            snapshot.append_scaled_texture(ed.frame, Gsk.ScalingFilter.LINEAR, rect(L.ox, L.oy, L.w, L.h));

        const shapes = ed.visibleShapes();
        if (ed.drag?.kind === 'shape')
            shapes.push(ed.drag.shape);

        // Pixelate regions first, other drawings on top (as in the export).
        if (ed.frame) {
            for (const s of shapes.filter(sh => sh.type === 'pixelate'))
                this._snapshotPixelate(snapshot, s, L);
        }

        const cr = snapshot.append_cairo(rect(0, 0, W, H));
        cr.rectangle(L.ox, L.oy, L.w, L.h);
        cr.clip();
        cr.translate(L.ox, L.oy);
        cr.scale(L.scale, L.scale);
        for (const s of shapes) {
            if (s.type !== 'pixelate')
                drawShape(cr, s);
        }
        if (ed.textEdit)
            drawShape(cr, ed.textEdit.shape, {editing: true});
        if (ed.selected && ed.isVisible(ed.selected))
            drawSelectionOutline(cr, ed.selected, 1 / L.scale);
        cr.$dispose();
    }

    /**
     * Shows a pixelate region the way ffmpeg renders it on export: the video
     * shrunk so each block is one pixel, then enlarged without smoothing.
     */
    _snapshotPixelate(snapshot, s, L) {
        const {info, frame} = this._editor;
        const renderer = this.get_native()?.get_renderer();
        if (!renderer)
            return;
        const x1 = Math.max(0, Math.min(s.from.x, s.to.x));
        const y1 = Math.max(0, Math.min(s.from.y, s.to.y));
        const x2 = Math.min(info.width, Math.max(s.from.x, s.to.x) + 1);
        const y2 = Math.min(info.height, Math.max(s.from.y, s.to.y) + 1);
        if (x2 - x1 < 1 || y2 - y1 < 1)
            return;
        const block = pixelateBlock(s);
        const sw = Math.max(1, Math.ceil((x2 - x1) / block));
        const sh = Math.max(1, Math.ceil((y2 - y1) / block));

        if (this._pixCache.frame !== frame)
            this._pixCache = {frame, map: new Map()};
        const key = `${x1},${y1},${sw},${sh},${block}`;
        let small = this._pixCache.map.get(key);
        if (!small) {
            const snap = new Gtk.Snapshot();
            snap.append_scaled_texture(frame, Gsk.ScalingFilter.TRILINEAR,
                rect(-x1 / block, -y1 / block, info.width / block, info.height / block));
            const node = snap.to_node();
            if (!node)
                return;
            small = renderer.render_texture(node, rect(0, 0, sw, sh));
            this._pixCache.map.set(key, small);
        }
        const k = L.scale;
        snapshot.push_clip(rect(L.ox + x1 * k, L.oy + y1 * k, (x2 - x1) * k, (y2 - y1) * k));
        snapshot.append_scaled_texture(small, Gsk.ScalingFilter.NEAREST,
            rect(L.ox + x1 * k, L.oy + y1 * k, sw * block * k, sh * block * k));
        snapshot.pop();
    }
});

// ==================================================================== window

const EditorWindow = GObject.registerClass(
class EditorWindow extends Adw.ApplicationWindow {
    /** `info` is the probed video, or an Error if it could not be read. */
    _init(app, path, info) {
        super._init({application: app, title: 'Video editor', ...EditorWindow.sizeFor(info)});
        this._settings = app.settings;
        this.path = path;
        this.info = null;
        this.fps = this._settings?.get_int('record-framerate') ?? 30;
        this.duration = 0;
        this.time = 0;
        this.frame = null;
        this.shapes = [];
        this.selected = null;
        this.tool = 'arrow';
        this.drag = null;
        this.textEdit = null;
        this._color = this._settings?.get_string('default-color') ?? '#ff2b2b';
        this._size = this._settings?.get_int('default-thickness') ?? 3;
        // Video pixels per thickness step, so drawings on big videos are not hair-thin.
        this._unit = 1;
        this._undo = [];
        this._redo = [];
        this._nextId = 1;
        this._dirty = false;
        this._playing = false;
        this._playToken = 0;
        this._decoder = null;
        this._seekTarget = null;
        this._seeking = null;
        this._exporting = null;
        this._closeAfterExport = false;

        this._buildUI();
        this.connect('close-request', () => this._onCloseRequest());
        if (info instanceof Error)
            this._fatal(info);
        else
            this._load(info).catch(e => this._fatal(e));
    }

    static sizeFor(info) {
        const size = {default_width: 1100, default_height: 760};
        const monitor = Gdk.Display.get_default().get_monitors().get_item(0);
        if (!monitor || info instanceof Error || !info)
            return size;
        const geo = monitor.get_geometry();
        const chrome = 260;
        const scale = Math.min(1, geo.width * 0.85 / info.width, (geo.height * 0.85 - chrome) / info.height);
        return {
            default_width: Math.max(900, Math.round(info.width * scale)),
            default_height: Math.max(560, Math.round(info.height * scale) + chrome),
        };
    }

    // ---------------------------------------------------------------- UI

    _iconButton(icon, tooltip, callback) {
        const button = new Gtk.Button({icon_name: icon, tooltip_text: tooltip, focus_on_click: false});
        button.connect('clicked', callback);
        return button;
    }

    _buildUI() {
        const view = new Adw.ToolbarView();
        this.set_content(view);

        // Header bar.
        const header = new Adw.HeaderBar();
        this._title = new Adw.WindowTitle({title: GLib.path_get_basename(this.path)});
        header.set_title_widget(this._title);
        header.pack_start(this._iconButton('document-open-symbolic', 'Open another video (Ctrl+O)',
            () => this.application.chooseAndOpen(this)));
        const history = new Gtk.Box({css_classes: ['linked']});
        this._undoButton = this._iconButton('edit-undo-symbolic', 'Undo (Ctrl+Z)', () => this.undo());
        this._redoButton = this._iconButton('edit-redo-symbolic', 'Redo (Ctrl+Shift+Z)', () => this.redo());
        history.append(this._undoButton);
        history.append(this._redoButton);
        header.pack_start(history);

        const exportMenu = new Gio.Menu();
        exportMenu.append('Export as…', 'win.export-as');
        const editableSection = new Gio.Menu();
        editableSection.append('Save editable video…', 'win.save-editable');
        exportMenu.append_section(null, editableSection);
        const exportAs = new Gio.SimpleAction({name: 'export-as'});
        exportAs.connect('activate', () => this.export({ask: true}));
        this.add_action(exportAs);
        const saveEditable = new Gio.SimpleAction({name: 'save-editable'});
        saveEditable.connect('activate', () => this.export({editable: true}));
        this.add_action(saveEditable);
        this._exportButton = new Adw.SplitButton({
            label: 'Export',
            menu_model: exportMenu,
            tooltip_text: 'Save the video with the drawings (Ctrl+E)',
            css_classes: ['suggested-action'],
        });
        this._exportButton.connect('clicked', () => this.export());
        header.pack_end(this._exportButton);
        view.add_top_bar(header);

        // Tool bar.
        const tools = new Gtk.Box({spacing: 6, margin_start: 6, margin_end: 6, margin_top: 2, margin_bottom: 4});
        const toolBox = new Gtk.Box({css_classes: ['linked']});
        this._toolButtons = {};
        const addTool = (id, icon, tooltip) => {
            const button = new Gtk.ToggleButton({icon_name: icon, tooltip_text: tooltip, focus_on_click: false});
            if (Object.keys(this._toolButtons).length > 0)
                button.set_group(Object.values(this._toolButtons)[0]);
            button.connect('toggled', () => {
                if (button.active && this.tool !== id)
                    this.setTool(id);
            });
            this._toolButtons[id ?? 'select'] = button;
            toolBox.append(button);
        };
        addTool(null, 'fsg-select-symbolic', 'Select and move drawings (V)');
        for (const t of TOOLS)
            addTool(t.id, `${t.icon}-symbolic`, `${t.label} (${t.key.toUpperCase()})`);
        tools.append(toolBox);

        const colorBox = new Gtk.Box();
        this._colorButtons = {};
        COLORS.forEach((c, i) => {
            const button = new Gtk.ToggleButton({
                css_classes: ['fsg-swatch', `fsg-color-${i}`],
                tooltip_text: `Colour ${i + 1}`,
                focus_on_click: false,
                valign: Gtk.Align.CENTER,
            });
            if (i > 0)
                button.set_group(this._colorButtons[COLORS[0]]);
            button.connect('toggled', () => {
                if (button.active)
                    this.setColor(c);
            });
            this._colorButtons[c] = button;
            colorBox.append(button);
        });
        tools.append(colorBox);

        const sizeBox = new Gtk.Box({css_classes: ['linked'], tooltip_text: 'Thickness (mouse wheel, [ ])'});
        sizeBox.append(this._iconButton('list-remove-symbolic', 'Thinner ([)', () => this.setSize(this._size - 1)));
        this._sizeLabel = new Gtk.Label({css_classes: ['fsg-size']});
        const sizeFrame = new Gtk.Box({css_classes: ['card'], margin_start: 0});
        sizeFrame.append(this._sizeLabel);
        sizeBox.append(sizeFrame);
        sizeBox.append(this._iconButton('list-add-symbolic', 'Thicker (])', () => this.setSize(this._size + 1)));
        tools.append(sizeBox);

        this._removeButton = this._iconButton('fsg-trash-symbolic',
            'Remove the selected drawing from this point on (Delete). Shift+Delete removes it completely.',
            () => this.removeSelected(false));
        tools.append(this._removeButton);

        this._hint = new Gtk.Label({
            css_classes: ['dim-label', 'caption'],
            hexpand: true,
            xalign: 1,
            ellipsize: Pango.EllipsizeMode.END,
        });
        tools.append(this._hint);
        view.add_top_bar(tools);

        // Video.
        this._canvas = new VideoCanvas(this);
        this._setupCanvasInput();
        this._toasts = new Adw.ToastOverlay({child: this._canvas});
        this._stack = new Gtk.Stack({vhomogeneous: false, hhomogeneous: false});
        this._stack.add_named(this._toasts, 'video');
        this._status = new Adw.StatusPage({icon_name: 'video-x-generic-symbolic', title: 'Loading…'});
        this._stack.add_named(this._status, 'status');
        this._stack.set_visible_child_name('status');
        view.set_content(this._stack);

        // Bottom: export progress, transport and timeline.
        const bottom = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        this._progressRevealer = new Gtk.Revealer();
        const progressBox = new Gtk.Box({spacing: 12, margin_start: 12, margin_end: 12, margin_top: 6, margin_bottom: 6});
        this._progress = new Gtk.ProgressBar({hexpand: true, valign: Gtk.Align.CENTER, show_text: true});
        progressBox.append(this._progress);
        progressBox.append(this._iconButton('process-stop-symbolic', 'Cancel export', () => this._exporting?.cancel()));
        this._progressRevealer.set_child(progressBox);
        bottom.append(this._progressRevealer);

        const transport = new Gtk.Box({spacing: 6, margin_start: 6, margin_end: 6, margin_top: 6, margin_bottom: 2});
        const nav = new Gtk.Box({css_classes: ['linked']});
        nav.append(this._iconButton('media-skip-backward-symbolic', 'Start (Home)', () => this.seek(0, true)));
        nav.append(this._iconButton('go-previous-symbolic', 'Previous frame (Left, Shift: 1 s)', () => this.step(-1)));
        this._playButton = this._iconButton('media-playback-start-symbolic', 'Play / pause (Space)', () => this.togglePlay());
        nav.append(this._playButton);
        nav.append(this._iconButton('go-next-symbolic', 'Next frame (Right, Shift: 1 s)', () => this.step(1)));
        nav.append(this._iconButton('media-skip-forward-symbolic', 'End (End)', () => this.seek(this.duration, true)));
        transport.append(nav);
        this._timeLabel = new Gtk.Label({css_classes: ['fsg-time', 'monospace'], xalign: 0});
        transport.append(this._timeLabel);
        bottom.append(transport);

        this._timeline = new Timeline(this);
        this._timeline.add_css_class('fsg-timeline');
        const scroller = new Gtk.ScrolledWindow({
            child: this._timeline,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            propagate_natural_height: true,
            max_content_height: 150,
            margin_bottom: 6,
        });
        bottom.append(scroller);
        view.add_bottom_bar(bottom);

        // Keys are handled before any button sees them.
        const keys = new Gtk.EventControllerKey({propagation_phase: Gtk.PropagationPhase.CAPTURE});
        keys.connect('key-pressed', (_c, keyval, _code, state) => this._onKey(keyval, state));
        this.add_controller(keys);
        this._syncUI();
    }

    _setupCanvasInput() {
        const drag = new Gtk.GestureDrag({button: 0});
        drag.connect('drag-begin', (g, x, y) => {
            g.set_state(Gtk.EventSequenceState.CLAIMED);
            this._onPress(g, x, y);
        });
        drag.connect('drag-update', (g, dx, dy) => this._onMotion(g, dx, dy));
        drag.connect('drag-end', (g, dx, dy) => this._onRelease(g, dx, dy));
        this._canvas.add_controller(drag);

        const motion = new Gtk.EventControllerMotion();
        motion.connect('motion', (_m, x, y) => this._updateCursor(x, y));
        this._canvas.add_controller(motion);

        const scroll = new Gtk.EventControllerScroll({flags: Gtk.EventControllerScrollFlags.VERTICAL});
        scroll.connect('scroll', (_s, _dx, dy) => {
            this._scrollAccum = (this._scrollAccum ?? 0) - dy;
            const steps = Math.trunc(this._scrollAccum);
            if (steps !== 0) {
                this._scrollAccum -= steps;
                this.setSize(this._size + steps);
            }
            return true;
        });
        this._canvas.add_controller(scroll);
    }

    _syncUI() {
        for (const [id, button] of Object.entries(this._toolButtons)) {
            const active = (id === 'select' ? null : id) === this.tool;
            if (button.active !== active)
                button.active = active;
        }
        for (const [color, button] of Object.entries(this._colorButtons)) {
            const active = color.toLowerCase() === this._color.toLowerCase();
            if (button.active !== active)
                button.active = active;
        }
        this._sizeLabel.label = `${this._size}`;
        this._undoButton.sensitive = this._undo.length > 0;
        this._redoButton.sensitive = this._redo.length > 0;
        this._removeButton.sensitive = this.selected !== null;
        this._exportButton.sensitive = !this._exporting && this.info !== null;
        this._playButton.icon_name = this._playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._timeLabel.label = `${formatTime(this.time)} / ${formatTime(this.duration)}`;

        const tool = TOOLS.find(t => t.id === this.tool);
        if (this.selected)
            this._hint.label = 'Delete: remove from here on  ·  Shift+Delete: remove completely  ·  drag to move';
        else if (tool)
            this._hint.label = `${tool.label}  ·  shown from the current frame until you remove it`;
        else
            this._hint.label = 'Click a drawing to select it  ·  Space: play / pause';
        this._timeline.refresh();
        this._canvas.queue_draw();
    }

    _fatal(e) {
        logError(e, 'Flameshot GNOME video editor');
        this._status.title = 'Could not open the video';
        this._status.description = GLib.markup_escape_text(e.message, -1);
        this._status.icon_name = 'dialog-error-symbolic';
        this._stack.set_visible_child_name('status');
    }

    // ---------------------------------------------------------------- loading

    async _load(info) {
        this.info = info;
        this.duration = this.info.duration;
        this._unit = Math.max(1, Math.min(info.width / 1280, info.height / 720));
        this._title.subtitle = `${this.info.width} × ${this.info.height}  ·  ${formatTime(this.duration, false)}`;
        if (!this._loadProject() && info.hasAnnotations)
            await this._loadEmbedded();
        this._stack.set_visible_child_name('video');
        this._canvas.grab_focus();
        this._syncUI();
        await this.seek(0);
    }

    // ---------------------------------------------------------------- project

    _projectFile() {
        const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'flameshot-gnome', 'video-projects']);
        const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, this.path, -1);
        return {dir, path: GLib.build_filenamev([dir, `${hash}.json`])};
    }

    _fileStamp() {
        const fi = Gio.File.new_for_path(this.path).query_info('standard::size,time::modified',
            Gio.FileQueryInfoFlags.NONE, null);
        return `${fi.get_size()}:${fi.get_attribute_uint64('time::modified')}`;
    }

    /** Restores the autosaved drawings; returns whether there were any saved. */
    _loadProject() {
        try {
            const {path} = this._projectFile();
            if (!GLib.file_test(path, GLib.FileTest.EXISTS))
                return false;
            const [, data] = GLib.file_get_contents(path);
            const project = JSON.parse(new TextDecoder().decode(data));
            if (project.path !== this.path || project.stamp !== this._fileStamp())
                return false;
            this.shapes = project.shapes ?? [];
            this._nextId = Math.max(0, ...this.shapes.map(s => s.id ?? 0)) + 1;
            this._dirty = project.dirty ?? false;
            if (this.shapes.length > 0)
                this.toast(`Restored ${this.shapes.length} drawing${this.shapes.length === 1 ? '' : 's'} from last time`);
            return true;
        } catch (e) {
            logError(e, 'Could not load saved annotations');
            return false;
        }
    }

    /** Loads the drawings stored inside an editable video. */
    async _loadEmbedded() {
        try {
            const project = await readAnnotations(this.path);
            this.shapes = project.shapes ?? [];
            this._nextId = Math.max(0, ...this.shapes.map(s => s.id ?? 0)) + 1;
            this._dirty = false;
            this.toast(`Opened ${this.shapes.length} editable drawing${this.shapes.length === 1 ? '' : 's'}`);
        } catch (e) {
            logError(e, 'Could not read the drawings in the video');
            this.toast('Could not read the drawings stored in this video');
        }
    }

    _scheduleSave() {
        if (this._saveId)
            return;
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._saveId = 0;
            this._saveProject();
            return GLib.SOURCE_REMOVE;
        });
    }

    _saveProject() {
        if (!this.info)
            return;
        try {
            const {dir, path} = this._projectFile();
            GLib.mkdir_with_parents(dir, 0o700);
            const json = JSON.stringify({
                path: this.path,
                stamp: this._fileStamp(),
                dirty: this._dirty,
                shapes: this.shapes.map(cleanShape),
            });
            GLib.file_set_contents(path, json);
        } catch (e) {
            logError(e, 'Could not save annotations');
        }
    }

    // ---------------------------------------------------------------- playback

    toast(title, button = null, callback = null) {
        const toast = new Adw.Toast({title, timeout: 4});
        if (button) {
            toast.button_label = button;
            toast.connect('button-clicked', callback);
        }
        this._toasts.add_toast(toast);
    }

    _snapTime(t) {
        const maxT = Math.max(0, Math.floor((this.duration - 1e-6) * this.fps) / this.fps);
        return Math.max(0, Math.min(maxT, Math.round(t * this.fps) / this.fps));
    }

    _showFrame(f) {
        this.frame = f.texture;
        this.time = f.time;
        this._timeLabel.label = `${formatTime(this.time)} / ${formatTime(this.duration)}`;
        this._timeline.queue_draw();
        this._canvas.queue_draw();
    }

    /**
     * Shows the frame at time t. Rapid calls (scrubbing) are coalesced: only
     * the latest target is decoded once the current seek finishes.
     */
    seek(t, pause = false) {
        if (pause)
            this.pause();
        if (this.textEdit)
            this._commitText();
        this._seekTarget = this._snapTime(t);
        // Move the playhead right away; the frame follows.
        this.time = this._seekTarget;
        this._syncUI();
        if (!this._seeking)
            this._seeking = this._runSeeks().finally(() => (this._seeking = null));
        return this._seeking;
    }

    async _runSeeks() {
        while (this._seekTarget !== null) {
            const t = this._seekTarget;
            this._seekTarget = null;
            this._decoder?.close();
            const decoder = new Decoder(this.path, this.info, this.fps, t);
            this._decoder = decoder;
            // eslint-disable-next-line no-await-in-loop
            const f = await decoder.next();
            if (this._decoder !== decoder)
                continue;
            if (f && this._seekTarget === null)
                this._showFrame(f);
        }
    }

    step(frames) {
        this.seek(this.time + frames / this.fps, true);
    }

    togglePlay() {
        if (this._playing)
            this.pause();
        else
            this.play();
    }

    async play() {
        if (this._playing || !this.info)
            return;
        if (this.textEdit)
            this._commitText();
        if (this.time >= this._snapTime(this.duration))
            await this.seek(0);
        this._playing = true;
        const token = ++this._playToken;
        this._syncUI();
        await this._seeking;
        // Continue from the displayed frame; restart the decoder if it was
        // left somewhere else (e.g. a frame was read and dropped on pause).
        if (!this._decoder || Math.abs(this._decoder.nextTime - (this.time + 1 / this.fps)) > 1e-6)
            await this.seek(this.time);
        if (token !== this._playToken)
            return;

        const decoder = this._decoder;
        const wallStart = GLib.get_monotonic_time();
        const timeStart = this.time;
        while (this._playing && token === this._playToken && decoder === this._decoder) {
            // eslint-disable-next-line no-await-in-loop
            const f = await decoder.next();
            if (!f) {
                this.pause();
                break;
            }
            const due = wallStart + (f.time - timeStart) * 1e6;
            const wait = (due - GLib.get_monotonic_time()) / 1000;
            if (wait > 1) {
                // eslint-disable-next-line no-await-in-loop
                await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_HIGH, Math.round(wait), () => {
                    resolve();
                    return GLib.SOURCE_REMOVE;
                }));
            }
            if (!this._playing || token !== this._playToken || decoder !== this._decoder) {
                // This frame was read but not shown; the decoder is now ahead.
                if (this._decoder === decoder) {
                    this._decoder = null;
                    decoder.close();
                }
                break;
            }
            this._showFrame(f);
        }
    }

    pause() {
        if (!this._playing)
            return;
        this._playing = false;
        this._playToken++;
        this._syncUI();
    }

    // ---------------------------------------------------------------- drawings

    isVisible(s, t = this.time) {
        const eps = 0.5 / this.fps;
        return t >= s.start - eps && (s.end === null || t < s.end - eps);
    }

    visibleShapes(t = this.time) {
        return this.shapes.filter(s => this.isVisible(s, t));
    }

    /** Records the current drawings for undo. Call before changing them. */
    checkpoint() {
        this._undo.push(this._snapshotState());
        this._redo = [];
        if (this._undo.length > 200)
            this._undo.shift();
    }

    _snapshotState() {
        return {shapes: JSON.stringify(this.shapes.map(cleanShape)), selected: this.selected?.id ?? null};
    }

    _restoreState(state) {
        this.shapes = JSON.parse(state.shapes);
        this.selected = this.shapes.find(s => s.id === state.selected) ?? null;
    }

    undo() {
        if (this.textEdit) {
            this._cancelText();
            return;
        }
        const state = this._undo.pop();
        if (!state)
            return;
        this._redo.push(this._snapshotState());
        this._restoreState(state);
        this.shapesChanged();
    }

    redo() {
        const state = this._redo.pop();
        if (!state)
            return;
        this._undo.push(this._snapshotState());
        this._restoreState(state);
        this.shapesChanged();
    }

    /** Called after any change to the drawings. */
    shapesChanged() {
        this._dirty = true;
        if (this.selected && !this.shapes.includes(this.selected))
            this.selected = null;
        this._scheduleSave();
        this._syncUI();
    }

    selectShape(shape) {
        if (this.selected === shape)
            return;
        this.selected = shape;
        this._syncUI();
    }

    setTool(id) {
        if (this.textEdit)
            this._commitText();
        this.tool = id;
        this.selected = null;
        this._syncUI();
    }

    setColor(color) {
        this._color = color;
        if (this.textEdit)
            this.textEdit.shape.color = color;
        if (this.selected && !this.textEdit && this.selected.color !== color) {
            this.checkpoint();
            this.selected.color = color;
            this.shapesChanged();
        }
        this._syncUI();
    }

    setSize(size) {
        this._size = Math.max(MIN_SIZE, Math.min(MAX_SIZE, size));
        if (this.textEdit)
            this.textEdit.shape.size = this._size * this._unit;
        this._syncUI();
    }

    _addShape(shape) {
        this.checkpoint();
        shape.id = this._nextId++;
        shape.start = this.time;
        shape.end = null;
        this.shapes.push(shape);
        this.shapesChanged();
    }

    /**
     * Removes the drawing from the current frame on. At the frame where it
     * appears (or with `completely`) it is deleted altogether.
     */
    removeShape(shape, completely = false) {
        if (!shape)
            return;
        this.checkpoint();
        if (completely || this.time <= shape.start + 0.5 / this.fps) {
            this.shapes.splice(this.shapes.indexOf(shape), 1);
            this.toast('Drawing deleted');
        } else {
            shape.end = this.time;
            this.selected = null;
            this.toast(`Drawing hidden from ${formatTime(this.time)}`);
        }
        this.shapesChanged();
    }

    removeSelected(completely) {
        this.removeShape(this.selected, completely);
    }

    _beginShape(p, shift) {
        const base = {type: this.tool, color: this._color, size: this._size * this._unit};
        switch (this.tool) {
        case 'pencil':
        case 'marker':
            this.drag = {kind: 'shape', shape: {...base, points: [p]}};
            break;
        case 'line':
        case 'arrow':
            this.drag = {kind: 'shape', shape: {...base, from: p, to: p}};
            break;
        case 'rect':
        case 'ellipse':
        case 'pixelate':
            this.drag = {kind: 'shape', shape: {...base, from: p, to: p, filled: shift}};
            break;
        case 'counter':
            this._addShape({...base, at: p, n: nextCounter(this.shapes)});
            break;
        case 'text':
            this.textEdit = {shape: {...base, at: p, text: ''}};
            break;
        default:
            break;
        }
        this._canvas.queue_draw();
    }

    _commitText() {
        const edit = this.textEdit;
        this.textEdit = null;
        if (edit && edit.shape.text.trim().length > 0)
            this._addShape(edit.shape);
        else
            this._canvas.queue_draw();
    }

    _cancelText() {
        this.textEdit = null;
        this._canvas.queue_draw();
    }

    // ---------------------------------------------------------------- canvas input

    _inVideo(p) {
        return p.x >= 0 && p.y >= 0 && p.x < this.info.width && p.y < this.info.height;
    }

    _hitSlack() {
        // Hit tolerances are in screen pixels; convert to video pixels.
        return 1 / Math.max(0.05, this._canvas.layout().scale);
    }

    _updateCursor(x, y) {
        if (!this.info)
            return;
        const p = this._canvas.toVideo(x, y);
        let cursor = 'default';
        if (this.drag?.kind === 'move')
            cursor = 'move';
        else if (this.textEdit && this.tool === 'text')
            cursor = 'text';
        else if (shapeAt(this.visibleShapes(), p, this._hitSlack()))
            cursor = 'pointer';
        else if (this.tool && this._inVideo(p))
            cursor = this.tool === 'text' ? 'text' : 'crosshair';
        this._canvas.set_cursor_from_name(cursor);
    }

    _onPress(gesture, x, y) {
        if (!this.info)
            return;
        this._canvas.grab_focus();
        const p = this._canvas.toVideo(x, y);
        const button = gesture.get_current_button();
        const shift = (gesture.get_current_event_state() & Gdk.ModifierType.SHIFT_MASK) !== 0;
        this._pressPoint = {x, y};

        if (this.textEdit) {
            this._commitText();
            if (button === Gdk.BUTTON_PRIMARY && this.tool === 'text' && this._inVideo(p)) {
                this._beginShape(p, shift);
                return;
            }
        }

        const hit = shapeAt(this.visibleShapes(), p, this._hitSlack());
        if (button === Gdk.BUTTON_SECONDARY) {
            // Right click: remove the drawing under the pointer from here on,
            // otherwise drop the tool.
            if (hit)
                this.removeShape(hit, shift);
            else if (this.tool)
                this.setTool(null);
            else
                this.selectShape(null);
            return;
        }
        if (button !== Gdk.BUTTON_PRIMARY)
            return;

        if (hit) {
            this.pause();
            this.selectShape(hit);
            this.drag = {kind: 'move', shape: hit, start: p, from: shapeGeometry(hit), moved: false};
            this._canvas.set_cursor_from_name('move');
            return;
        }
        this.selectShape(null);
        if (this.tool && this._inVideo(p)) {
            // Drawings start at a frame; stop the video to draw on it.
            this.pause();
            this._beginShape(p, shift);
        }
    }

    _onMotion(gesture, dx, dy) {
        const drag = this.drag;
        if (!drag || !this._pressPoint)
            return;
        const p = this._canvas.toVideo(this._pressPoint.x + dx, this._pressPoint.y + dy);
        const shift = (gesture.get_current_event_state() & Gdk.ModifierType.SHIFT_MASK) !== 0;
        if (drag.kind === 'shape') {
            const {shape} = drag;
            if (shape.points) {
                const last = shape.points[shape.points.length - 1];
                if (last.x !== p.x || last.y !== p.y)
                    shape.points.push(p);
            } else {
                shape.to = p;
                if ('filled' in shape)
                    shape.filled = shift;
            }
        } else if (drag.kind === 'move') {
            const mx = p.x - drag.start.x, my = p.y - drag.start.y;
            if (!drag.moved && Math.hypot(dx, dy) < MIN_DRAG)
                return;
            if (!drag.moved) {
                drag.moved = true;
                this.checkpoint();
            }
            setShapeGeometry(drag.shape, translateGeometry(drag.from, mx, my));
        }
        this._canvas.queue_draw();
    }

    _onRelease(_gesture, dx, dy) {
        const drag = this.drag;
        this.drag = null;
        if (!drag)
            return;
        if (drag.kind === 'shape') {
            if (!isShapeTooSmall(drag.shape))
                this._addShape(drag.shape);
            else
                this._canvas.queue_draw();
        } else if (drag.kind === 'move' && drag.moved) {
            this.shapesChanged();
        }
        if (this._pressPoint)
            this._updateCursor(this._pressPoint.x + dx, this._pressPoint.y + dy);
    }

    // ---------------------------------------------------------------- keys

    _onKey(keyval, state) {
        if (!this.info || this.get_visible_dialog?.())
            return false;
        // Leave menus alone.
        if (this.get_focus()?.get_ancestor(Gtk.Popover.$gtype))
            return false;
        const ctrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
        const shift = (state & Gdk.ModifierType.SHIFT_MASK) !== 0;

        if (this.textEdit)
            return this._onTextKey(keyval, ctrl, shift);

        switch (keyval) {
        case Gdk.KEY_space:
            this.togglePlay();
            return true;
        case Gdk.KEY_Left:
            this.step(shift ? -this.fps : -1);
            return true;
        case Gdk.KEY_Right:
            this.step(shift ? this.fps : 1);
            return true;
        case Gdk.KEY_Home:
            this.seek(0, true);
            return true;
        case Gdk.KEY_End:
            this.seek(this.duration, true);
            return true;
        case Gdk.KEY_Delete:
        case Gdk.KEY_KP_Delete:
        case Gdk.KEY_BackSpace:
            if (this.selected)
                this.removeSelected(shift);
            return true;
        case Gdk.KEY_Escape:
            if (this.selected)
                this.selectShape(null);
            else if (this.tool)
                this.setTool(null);
            return true;
        case Gdk.KEY_bracketleft:
        case Gdk.KEY_minus:
            this.setSize(this._size - 1);
            return true;
        case Gdk.KEY_bracketright:
        case Gdk.KEY_plus:
        case Gdk.KEY_equal:
            this.setSize(this._size + 1);
            return true;
        default:
            break;
        }

        const ch = String.fromCodePoint(Gdk.keyval_to_unicode(Gdk.keyval_to_lower(keyval)) || 32).trim();
        if (ctrl) {
            switch (ch) {
            case 'z':
                if (shift)
                    this.redo();
                else
                    this.undo();
                return true;
            case 'y': this.redo(); return true;
            case 'e': this.export({ask: shift}); return true;
            case 's': this.export({editable: true}); return true;
            case 'o': this.application.chooseAndOpen(this); return true;
            case 'w': this.close(); return true;
            default: return false;
            }
        }
        if (state & (Gdk.ModifierType.ALT_MASK | Gdk.ModifierType.SUPER_MASK))
            return false;
        if (ch === 'v') {
            this.setTool(null);
            return true;
        }
        const tool = TOOLS.find(t => t.key === ch);
        if (tool) {
            this.setTool(this.tool === tool.id ? null : tool.id);
            return true;
        }
        if (ch >= '1' && ch <= '9' && COLORS[Number(ch) - 1]) {
            this.setColor(COLORS[Number(ch) - 1]);
            return true;
        }
        return false;
    }

    _onTextKey(keyval, ctrl, shift) {
        const shape = this.textEdit.shape;
        switch (keyval) {
        case Gdk.KEY_Escape:
            this._commitText();
            return true;
        case Gdk.KEY_Return:
        case Gdk.KEY_KP_Enter:
            if (shift)
                shape.text += '\n';
            else
                this._commitText();
            break;
        case Gdk.KEY_BackSpace:
            shape.text = Array.from(shape.text).slice(0, -1).join('');
            break;
        case Gdk.KEY_Tab:
            shape.text += '    ';
            break;
        default: {
            const code = Gdk.keyval_to_unicode(keyval);
            if (ctrl) {
                if (code && String.fromCodePoint(code).toLowerCase() === 'v') {
                    this.get_display().get_clipboard().read_text_async(null).then(text => {
                        if (text && this.textEdit) {
                            this.textEdit.shape.text += text;
                            this._canvas.queue_draw();
                        }
                    }).catch(() => {});
                }
                return true;
            }
            if (code >= 0x20)
                shape.text += String.fromCodePoint(code);
            break;
        }
        }
        this._canvas.queue_draw();
        return true;
    }

    // ---------------------------------------------------------------- export

    _videoDirectory() {
        const configured = this._settings?.get_string('video-directory');
        if (configured)
            return configured.replace(/^~/, GLib.get_home_dir());
        const videos = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS) ??
            GLib.build_filenamev([GLib.get_home_dir(), 'Videos']);
        return GLib.build_filenamev([videos, 'Screencasts']);
    }

    _defaultExportName(editable = false) {
        const base = GLib.path_get_basename(this.path);
        // Saving an editable video again updates it by default.
        if (editable && this.info.hasAnnotations)
            return base;
        const dot = base.lastIndexOf('.');
        const stem = (dot > 0 ? base.slice(0, dot) : base).replace(/ \((annotated|editable)\)( \d+)?$/, '');
        return editable ? `${stem} (editable).${EDITABLE.ext}` : `${stem} (annotated).mp4`;
    }

    async _askExportFile(editable) {
        const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
        const formats = editable ? {[EDITABLE.ext]: EDITABLE} : FORMATS;
        for (const [ext, fmt] of Object.entries(formats)) {
            const filter = new Gtk.FileFilter({name: `${fmt.label} (.${ext})`});
            filter.add_suffix(ext);
            filters.append(filter);
        }
        const dialog = new Gtk.FileDialog({
            title: editable ? 'Save editable video' : 'Export video',
            modal: true,
            initial_name: this._defaultExportName(editable),
            filters,
            default_filter: filters.get_item(0),
        });
        const dir = GLib.path_get_dirname(this.path);
        dialog.set_initial_folder(Gio.File.new_for_path(dir));
        try {
            const file = await dialog.save(this, null);
            let path = file.get_path();
            if (editable && !path.toLowerCase().endsWith(`.${EDITABLE.ext}`))
                path += `.${EDITABLE.ext}`;
            else if (!editable && !formatForPath(path))
                path += '.mp4';
            return Gio.File.new_for_path(path);
        } catch (e) {
            return null;
        }
    }

    /**
     * Renders the video with the drawings. `ask` shows a file chooser;
     * `editable` saves an editable video (always asks where).
     */
    async export({ask = false, editable = false} = {}) {
        if (this._exporting || !this.info)
            return false;
        if (this.textEdit)
            this._commitText();
        this.pause();

        let file;
        if (ask || editable) {
            file = await this._askExportFile(editable);
            if (!file)
                return false;
        } else {
            // Next to the recording, or in the video folder if that is not writable.
            let dir = GLib.path_get_dirname(this.path);
            if (!Gio.File.new_for_path(dir).query_info('access::can-write', 0, null).get_attribute_boolean('access::can-write'))
                dir = this._videoDirectory();
            GLib.mkdir_with_parents(dir, 0o755);
            file = uniqueFile(dir, this._defaultExportName());
        }

        const cancellable = new Gio.Cancellable();
        this._exporting = cancellable;
        this._progress.fraction = 0;
        this._progress.text = `Exporting ${GLib.path_get_basename(file.get_path())}…`;
        this._progressRevealer.reveal_child = true;
        this._syncUI();
        try {
            await exportVideo({
                source: this.path,
                info: this.info,
                shapes: this.shapes,
                output: file.get_path(),
                fps: this.fps,
                editable,
                cancellable,
                onProgress: f => {
                    this._progress.fraction = f;
                },
            });
            this._dirty = false;
            this._saveProject();
            if (!editable && (this._settings?.get_boolean('copy-on-save') ?? true))
                this._copyFile(file);
            this.toast(`${editable ? 'Saved' : 'Exported'} ${GLib.path_get_basename(file.get_path())}`, 'Show in Files', () => {
                new Gtk.FileLauncher({file}).open_containing_folder(this, null).catch(() => {});
            });
            return true;
        } catch (e) {
            if (!cancellable.is_cancelled()) {
                logError(e, 'Export failed');
                const dialog = new Adw.AlertDialog({heading: 'Export failed', body: e.message});
                dialog.add_response('ok', 'OK');
                dialog.present(this);
            }
            return false;
        } finally {
            this._exporting = null;
            this._progressRevealer.reveal_child = false;
            this._syncUI();
        }
    }

    /** Puts the exported file on the clipboard, so it can be pasted into chats or file managers. */
    _copyFile(file) {
        const uri = file.get_uri();
        const encoder = new TextEncoder();
        const provider = Gdk.ContentProvider.new_union([
            Gdk.ContentProvider.new_for_bytes('x-special/gnome-copied-files',
                new GLib.Bytes(encoder.encode(`copy\n${uri}`))),
            Gdk.ContentProvider.new_for_bytes('text/uri-list', new GLib.Bytes(encoder.encode(`${uri}\r\n`))),
        ]);
        this.get_display().get_clipboard().set_content(provider);
    }

    // ---------------------------------------------------------------- closing

    _onCloseRequest() {
        if (this._forceClose || !this._dirty || this.shapes.length === 0) {
            this._shutdown();
            return false;
        }
        this._askBeforeClose();
        return true;
    }

    async _askBeforeClose() {
        const dialog = new Adw.AlertDialog({
            heading: 'Export the annotated video?',
            body: 'Your drawings are kept and come back when you open this recording again, ' +
                'but they are not in a video file yet.',
            close_response: 'cancel',
            default_response: 'export',
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('close', 'Close Without Exporting');
        dialog.add_response('export', 'Export');
        dialog.set_response_appearance('close', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_response_appearance('export', Adw.ResponseAppearance.SUGGESTED);
        const response = await dialog.choose(this, null);
        if (response === 'close' || (response === 'export' && await this.export())) {
            this._forceClose = true;
            this.close();
        }
    }

    _shutdown() {
        this._playing = false;
        this._playToken++;
        this._exporting?.cancel();
        this._decoder?.close();
        this._decoder = null;
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
            this._saveProject();
        }
    }
});

// ==================================================================== app

const EditorApp = GObject.registerClass(
class EditorApp extends Adw.Application {
    _init() {
        super._init({
            application_id: APP_ID,
            flags: Gio.ApplicationFlags.HANDLES_OPEN | Gio.ApplicationFlags.NON_UNIQUE,
        });
        this.settings = loadSettings();
    }

    vfunc_startup() {
        super.vfunc_startup();
        Adw.StyleManager.get_default().color_scheme = Adw.ColorScheme.PREFER_DARK;
        const display = Gdk.Display.get_default();
        Gtk.IconTheme.get_for_display(display).add_search_path(GLib.build_filenamev([DIR, 'icons']));
        const css = new Gtk.CssProvider();
        css.load_from_string(CSS);
        Gtk.StyleContext.add_provider_for_display(display, css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    }

    vfunc_activate() {
        this.chooseAndOpen(null);
    }

    vfunc_open(files) {
        for (const file of files)
            this.openPath(file.get_path());
    }

    async openPath(path) {
        this.hold();
        let info;
        try {
            if (!haveFfmpeg())
                throw new Error('The video editor needs ffmpeg and ffprobe. Install the "ffmpeg" package.');
            info = await probe(path);
        } catch (e) {
            info = e;
        } finally {
            this.release();
        }
        new EditorWindow(this, path, info).present();
    }

    async chooseAndOpen(parent) {
        this.hold();
        try {
            const filter = new Gtk.FileFilter({name: 'Videos'});
            filter.add_mime_type('video/*');
            filter.add_mime_type('image/gif');
            const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
            filters.append(filter);
            const dialog = new Gtk.FileDialog({title: 'Open a video to annotate', modal: true, filters});
            const videos = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS);
            if (videos)
                dialog.set_initial_folder(Gio.File.new_for_path(videos));
            const file = await dialog.open(parent, null);
            this.openPath(file.get_path());
        } catch (e) {
            // Cancelled.
        } finally {
            this.release();
        }
    }
});

new EditorApp().run([System.programInvocationName, ...ARGV]);
