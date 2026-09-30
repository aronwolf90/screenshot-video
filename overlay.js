// Flameshot GNOME - capture overlay
//
// Flow: freeze the screen into a texture, show it full-screen with a dark
// shade, let the user drag a region, annotate it with Cairo on top of the
// frozen image, then paint the (image + annotations) actor offscreen and
// crop it to the selection for copy / save / pin / open.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Cairo from 'cairo';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    COLORS, MAX_SIZE, MIN_SIZE, TOOLS, drawSelectionOutline, drawShape,
    isShapeTooSmall, nextCounter, normalizeRect, pixelateBlock, pointInRect,
    setShapeGeometry, shapeAt, shapeGeometry, translateGeometry,
} from './drawing.js';
import {PinnedScreenshot} from './pinned.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot_stage_to_content');
Gio._promisify(Shell.Screenshot, 'composite_to_stream');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const HANDLE_MARGIN = 7;
const MIN_DRAG = 3;

function monitorRect(mon) {
    return {x: mon.x, y: mon.y, w: mon.width, h: mon.height};
}

export const ScreenshotOverlay = GObject.registerClass({
    Signals: {'closed': {}},
}, class ScreenshotOverlay extends St.Widget {
    _init(extension, {mode = 'screenshot'} = {}) {
        super._init({
            name: 'fsg-overlay',
            reactive: true,
            can_focus: true,
            visible: false,
            opacity: 0,
        });
        this.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL,
        }));

        this._extension = extension;
        this._settings = extension.getSettings();
        this._path = extension.path;

        this._selection = null;
        this._drag = null;
        this._tool = null;
        this._shapes = [];
        this._undoStack = [];
        this._redoStack = [];
        this._selectedShape = null;
        this._textEdit = null;
        this._counter = 1;
        this._grab = null;
        this._pixels = null;
        this._pixelsPromise = Promise.resolve();
        this._cursorScale = 1;
        this._scale = 1;
        this._closed = false;
        this._busy = false;
        this._toolbarHiddenByUser = false;
        // 'record' only selects an area to record; no annotation tools.
        this._mode = mode;

        const state = extension.toolState ?? {};
        this._color = state.color ?? this._settings.get_string('default-color');
        this._size = state.size ?? this._settings.get_int('default-thickness');

        this._buildImageLayer();
        this._buildSelectionLayer();
        this._buildToolbar();

        Main.layoutManager.screenshotUIGroup.add_child(this);
    }

    // ---------------------------------------------------------------- build

    _buildImageLayer() {
        // Everything inside _shotContainer ends up in the exported image.
        this._shotContainer = new St.Widget();
        this._shotContainer.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL,
        }));
        this.add_child(this._shotContainer);

        this._shot = new St.Widget();
        this._shot.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL,
        }));
        this._shotContainer.add_child(this._shot);

        this._cursorActor = new St.Widget({visible: false});
        this._shotContainer.add_child(this._cursorActor);

        this._canvas = new St.DrawingArea({visible: false});
        this._canvas.connect('repaint', area => this._paintCanvas(area));
        this._shotContainer.add_child(this._canvas);
    }

    _buildSelectionLayer() {
        this._shades = [];
        for (let i = 0; i < 4; i++) {
            const shade = new St.Widget({style_class: 'fsg-shade'});
            this.add_child(shade);
            this._shades.push(shade);
        }

        this._selBorder = new St.Widget({style_class: 'fsg-selection', visible: false});
        this.add_child(this._selBorder);

        this._handles = {};
        for (const id of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
            const handle = new St.Widget({style_class: 'fsg-handle', visible: false});
            this.add_child(handle);
            this._handles[id] = handle;
        }

        this._sizeLabel = new St.Label({style_class: 'fsg-size-label', visible: false});
        this.add_child(this._sizeLabel);

        this._hint = new St.Label({
            style_class: 'fsg-hint',
            text: this._mode === 'record'
                ? 'Drag to select the area to record  ·  Click a window  ·  Ctrl+A whole screen  ·  Esc to cancel'
                : 'Drag to select an area  ·  Click a window  ·  Ctrl+A whole screen  ·  Esc to cancel',
        });
        this.add_child(this._hint);
    }

    _icon(name) {
        return Gio.icon_new_for_string(`${this._path}/icons/${name}-symbolic.svg`);
    }

    _makeButton(iconName, callback, {toggle = false, styleClass = ''} = {}) {
        const button = new St.Button({
            style_class: `fsg-tool-button ${styleClass}`,
            child: new St.Icon({gicon: this._icon(iconName)}),
            toggle_mode: toggle,
            can_focus: false,
            reactive: true,
            track_hover: true,
        });
        button.connect('clicked', callback);
        return button;
    }

    _separator() {
        return new St.Widget({style_class: 'fsg-toolbar-separator', y_expand: true});
    }

    _buildToolbar() {
        this._toolbar = new St.BoxLayout({
            style_class: 'fsg-toolbar',
            reactive: true,
            track_hover: true,
            visible: false,
        });
        this._toolbar.connect('scroll-event', (_a, event) => this._onScroll(event));
        this._toolbar.connect('enter-event', () => {
            this.set_cursor_type(Clutter.CursorType.DEFAULT);
            return Clutter.EVENT_PROPAGATE;
        });
        this._toolbar.connect('leave-event', () => {
            const [px, py] = global.get_pointer();
            this._updateCursor({x: px, y: py});
            return Clutter.EVENT_PROPAGATE;
        });
        this.add_child(this._toolbar);

        // Annotation tools and image actions are hidden in record mode.
        const recordMode = this._mode === 'record';
        const annotationBox = new St.BoxLayout({style: 'spacing: 2px;', visible: !recordMode});
        this._toolbar.add_child(annotationBox);

        this._selectButton = this._makeButton('fsg-select', () => this._setTool(null), {toggle: true});
        annotationBox.add_child(this._selectButton);

        this._toolButtons = {};
        for (const tool of TOOLS) {
            const button = this._makeButton(tool.icon, () => {
                this._setTool(this._toolButtons[tool.id].checked ? tool.id : null);
            }, {toggle: true});
            this._toolButtons[tool.id] = button;
            annotationBox.add_child(button);
        }

        annotationBox.add_child(this._separator());

        this._colorButtons = {};
        for (const color of COLORS) {
            const button = new St.Button({
                style_class: 'fsg-color-button',
                style: `background-color: ${color};`,
                toggle_mode: true,
                can_focus: false,
                reactive: true,
                track_hover: true,
            });
            button.connect('clicked', () => this._setColor(color));
            this._colorButtons[color] = button;
            annotationBox.add_child(button);
        }

        const sizeBox = new St.BoxLayout({style_class: 'fsg-size-box', y_align: Clutter.ActorAlign.CENTER});
        this._sizeValue = new St.Label({style_class: 'fsg-size-value', y_align: Clutter.ActorAlign.CENTER});
        sizeBox.add_child(this._sizeValue);
        annotationBox.add_child(sizeBox);

        annotationBox.add_child(this._separator());

        this._undoButton = this._makeButton('fsg-undo', () => this._undo());
        this._redoButton = this._makeButton('fsg-redo', () => this._redo());
        annotationBox.add_child(this._undoButton);
        annotationBox.add_child(this._redoButton);
        this._trashButton = this._makeButton('fsg-trash', () => {
            if (this._selectedShape)
                this._removeShape(this._selectedShape);
        });
        annotationBox.add_child(this._trashButton);

        annotationBox.add_child(this._separator());

        this._toolbar.add_child(this._makeButton('fsg-fullscreen', () => this._selectMonitorUnderPointer()));
        this._toolbar.add_child(this._separator());

        this._toolbar.add_child(this._makeButton('fsg-record', () => this._record(),
            {styleClass: 'fsg-action-button fsg-record-button'}));
        if (!recordMode) {
            this._toolbar.add_child(this._makeButton('fsg-pin', () => this._pin(), {styleClass: 'fsg-action-button'}));
            this._toolbar.add_child(this._makeButton('fsg-open', () => this._open(), {styleClass: 'fsg-action-button'}));
            this._toolbar.add_child(this._makeButton('fsg-save', () => this._save(), {styleClass: 'fsg-action-button'}));
            this._toolbar.add_child(this._makeButton('fsg-copy', () => this._copy(), {styleClass: 'fsg-action-button'}));
        }
        this._toolbar.add_child(this._makeButton('fsg-close', () => this.close(), {styleClass: 'fsg-action-button'}));

        this._status = new St.Label({style_class: 'fsg-status', y_align: Clutter.ActorAlign.CENTER});
        this._toolbar.add_child(this._status);

        this._syncToolbarState();
    }

    _syncToolbarState() {
        for (const [id, button] of Object.entries(this._toolButtons))
            button.checked = id === this._tool;
        for (const [color, button] of Object.entries(this._colorButtons))
            button.checked = color.toLowerCase() === this._color.toLowerCase();
        this._sizeValue.text = `${this._size}`;
        this._undoButton.reactive = this._undoStack.length > 0;
        this._undoButton.opacity = this._undoStack.length > 0 ? 255 : 100;
        this._redoButton.reactive = this._redoStack.length > 0;
        this._redoButton.opacity = this._redoStack.length > 0 ? 255 : 100;

        this._selectButton.checked = this._tool === null;
        this._trashButton.reactive = this._selectedShape !== null;
        this._trashButton.opacity = this._selectedShape !== null ? 255 : 100;

        const tool = TOOLS.find(t => t.id === this._tool);
        if (this._mode === 'record')
            this._status.text = 'Enter: start recording';
        else if (this._selectedShape)
            this._status.text = 'Selected  ·  Delete removes  ·  drag to move';
        else if (tool)
            this._status.text = `${tool.label}  ·  click a drawing to select it`;
        else if (this._shapes.length > 0)
            this._status.text = 'Click a drawing to select it  ·  Enter: copy';
        else
            this._status.text = 'Enter: copy  ·  Ctrl+S: save';
    }

    // ---------------------------------------------------------------- open/close

    async open() {
        const shooter = new Shell.Screenshot();
        let content, scale, cursorContent, cursorPoint, cursorScale;
        try {
            [content, scale, cursorContent, cursorPoint, cursorScale] =
                await shooter.screenshot_stage_to_content();
        } catch (e) {
            logError(e, 'Flameshot GNOME: failed to capture the screen');
            Main.notify('Flameshot GNOME', 'Could not capture the screen.');
            this._finish();
            return;
        }

        this._shot.set_content(content);
        this._scale = scale;
        this._texture = content.get_texture();

        if (cursorContent && this._settings.get_boolean('include-cursor')) {
            this._cursorActor.set_content(cursorContent);
            this._cursorActor.set_position(cursorPoint.x, cursorPoint.y);
            let [, w, h] = cursorContent.get_preferred_size();
            this._cursorActor.set_size(w * cursorScale, h * cursorScale);
            this._cursorScale = cursorScale;
            this._cursorActor.show();
        }

        // Close any open popup menus (they are already in the frozen image).
        Main.layoutManager.emit('system-modal-opened');
        const group = Main.layoutManager.screenshotUIGroup;
        group.get_parent().set_child_above_sibling(group, null);

        this._grab = Main.pushModal(this, {actionMode: Shell.ActionMode.POPUP});
        // Clutter.GrabState / Grab.get_seat_state() were removed in GNOME 50.
        const grabFailed = Clutter.GrabState && this._grab?.get_seat_state &&
            this._grab.get_seat_state() === Clutter.GrabState.NONE;
        if (!this._grab || grabFailed) {
            this._finish();
            return;
        }

        this.show();
        this.opacity = 255;
        this.grab_key_focus();
        this.set_cursor_type(Clutter.CursorType.CROSSHAIR);
        this._updateSelectionUI();

        // Pixel data for the pixelate tool, decoded in the background.
        this._pixelsPromise = this._loadPixels().catch(e => logError(e, 'Flameshot GNOME: pixel decode failed'));
    }

    async _loadPixels() {
        const stream = Gio.MemoryOutputStream.new_resizable();
        const pixbuf = await Shell.Screenshot.composite_to_stream(
            this._texture, 0, 0, -1, -1, this._scale, null, 0, 0, 1, stream);
        stream.close(null);
        if (this._closed)
            return;
        this._pixels = {
            data: pixbuf.read_pixel_bytes().toArray(),
            width: pixbuf.get_width(),
            height: pixbuf.get_height(),
            stride: pixbuf.get_rowstride(),
            channels: pixbuf.get_n_channels(),
        };
        if (this._shapes.some(s => s.type === 'pixelate'))
            this._canvas.queue_repaint();
    }

    close() {
        if (this._closed)
            return;
        this._closed = true;
        if (this._settings.get_boolean('remember-tool-state'))
            this._extension.toolState = {color: this._color, size: this._size};
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this.set_cursor_type(Clutter.CursorType.DEFAULT);
        this._finish();
    }

    _finish() {
        this._closed = true;
        this._shot.set_content(null);
        this._cursorActor.set_content(null);
        this._pixels = null;
        this._texture = null;
        this.emit('closed');
        this.destroy();
    }

    // ---------------------------------------------------------------- public API

    get isOpen() {
        return !this._closed && this._grab !== null;
    }

    /** Programmatically set the selection (stage coordinates). */
    selectRegion(rect) {
        if (this._closed)
            return;
        this._setSelection({x: rect.x, y: rect.y, w: rect.w, h: rect.h});
    }

    /** Run one of the export actions: copy, save, save-as, pin, open. */
    runAction(action) {
        if (this._closed)
            return;
        switch (action) {
        case 'copy': this._copy(); break;
        case 'save': this._save(false); break;
        case 'save-as': this._save(true); break;
        case 'pin': this._pin(); break;
        case 'open': this._open(); break;
        case 'record': this._record(); break;
        default: throw new Error(`Unknown action "${action}"`);
        }
    }

    // ---------------------------------------------------------------- selection

    _setSelection(rect) {
        if (rect) {
            const stage = {x: 0, y: 0, w: global.stage.width, h: global.stage.height};
            const x1 = Math.max(stage.x, Math.min(rect.x, stage.w - 1));
            const y1 = Math.max(stage.y, Math.min(rect.y, stage.h - 1));
            const x2 = Math.max(x1 + 1, Math.min(rect.x + rect.w, stage.w));
            const y2 = Math.max(y1 + 1, Math.min(rect.y + rect.h, stage.h));
            rect = {x: x1, y: y1, w: x2 - x1, h: y2 - y1};
        }
        this._selection = rect;
        this._updateSelectionUI();
    }

    _updateSelectionUI() {
        const sel = this._selection;
        const W = global.stage.width;
        const H = global.stage.height;

        if (!sel) {
            this._shades[0].set_position(0, 0);
            this._shades[0].set_size(W, H);
            for (let i = 1; i < 4; i++)
                this._shades[i].hide();
            this._shades[0].show();
            this._selBorder.hide();
            for (const h of Object.values(this._handles))
                h.hide();
            this._sizeLabel.hide();
            this._canvas.hide();
            this._toolbar.hide();
            this._hint.show();
            this._placeHint();
            return;
        }

        this._hint.hide();

        const [top, bottom, left, right] = this._shades;
        top.set_position(0, 0);
        top.set_size(W, sel.y);
        bottom.set_position(0, sel.y + sel.h);
        bottom.set_size(W, H - sel.y - sel.h);
        left.set_position(0, sel.y);
        left.set_size(sel.x, sel.h);
        right.set_position(sel.x + sel.w, sel.y);
        right.set_size(W - sel.x - sel.w, sel.h);
        for (const s of this._shades)
            s.show();

        this._selBorder.set_position(sel.x - 1, sel.y - 1);
        this._selBorder.set_size(sel.w + 2, sel.h + 2);
        this._selBorder.show();

        this._canvas.set_position(sel.x, sel.y);
        this._canvas.set_size(sel.w, sel.h);
        this._canvas.show();
        this._canvas.queue_repaint();

        const dragging = this._drag && ['select', 'move', 'resize'].includes(this._drag.kind);
        const cx = sel.x + sel.w / 2;
        const cy = sel.y + sel.h / 2;
        const positions = {
            nw: [sel.x, sel.y], n: [cx, sel.y], ne: [sel.x + sel.w, sel.y],
            e: [sel.x + sel.w, cy], se: [sel.x + sel.w, sel.y + sel.h],
            s: [cx, sel.y + sel.h], sw: [sel.x, sel.y + sel.h], w: [sel.x, cy],
        };
        for (const [id, handle] of Object.entries(this._handles)) {
            const [hx, hy] = positions[id];
            const hw = handle.width || 10;
            const hh = handle.height || 10;
            handle.set_position(Math.round(hx - hw / 2), Math.round(hy - hh / 2));
            handle.visible = !dragging;
        }

        if (this._settings.get_boolean('show-size-label')) {
            this._sizeLabel.text = `${sel.w} × ${sel.h}`;
            const [, lw] = this._sizeLabel.get_preferred_width(-1);
            const [, lh] = this._sizeLabel.get_preferred_height(-1);
            let lx = sel.x;
            let ly = sel.y - lh - 6;
            if (ly < 0)
                ly = sel.y + 6;
            lx = Math.max(0, Math.min(lx, W - lw));
            this._sizeLabel.set_position(Math.round(lx), Math.round(ly));
            this._sizeLabel.show();
        }

        if (dragging || this._toolbarHiddenByUser)
            this._toolbar.hide();
        else
            this._placeToolbar();
    }

    _placeHint() {
        const mon = this._monitorUnderPointer();
        const [, hw] = this._hint.get_preferred_width(-1);
        this._hint.set_position(
            Math.round(mon.x + (mon.width - hw) / 2),
            Math.round(mon.y + mon.height * 0.08));
    }

    _placeToolbar() {
        const sel = this._selection;
        const mon = this._monitorForRect(sel);
        this._toolbar.show();
        const [, tw] = this._toolbar.get_preferred_width(-1);
        const [, th] = this._toolbar.get_preferred_height(-1);
        const margin = 8;

        let x = sel.x + sel.w / 2 - tw / 2;
        x = Math.max(mon.x + margin, Math.min(x, mon.x + mon.width - tw - margin));

        let y = sel.y + sel.h + margin;
        if (y + th > mon.y + mon.height - margin) {
            y = sel.y - th - margin;
            if (y < mon.y + margin)
                y = sel.y + sel.h - th - margin;
        }
        this._toolbar.set_position(Math.round(x), Math.round(y));
    }

    _monitorUnderPointer() {
        const [px, py] = global.get_pointer();
        return this._monitorForRect({x: px, y: py, w: 1, h: 1});
    }

    _monitorForRect(rect) {
        const cx = rect.x + rect.w / 2;
        const cy = rect.y + rect.h / 2;
        for (const mon of Main.layoutManager.monitors) {
            if (cx >= mon.x && cx < mon.x + mon.width && cy >= mon.y && cy < mon.y + mon.height)
                return mon;
        }
        return Main.layoutManager.primaryMonitor;
    }

    _selectMonitorUnderPointer() {
        const mon = this._monitorUnderPointer();
        const r = monitorRect(mon);
        // Second press (or single monitor already selected) selects everything.
        const sel = this._selection;
        if (sel && sel.x === r.x && sel.y === r.y && sel.w === r.w && sel.h === r.h)
            this._setSelection({x: 0, y: 0, w: global.stage.width, h: global.stage.height});
        else
            this._setSelection(r);
    }

    _windowUnderPoint(p) {
        const workspace = global.workspace_manager.get_active_workspace();
        const actors = global.get_window_actors().slice().reverse();
        for (const actor of actors) {
            const win = actor.meta_window;
            if (!win || !actor.visible || win.minimized)
                continue;
            if (!win.located_on_workspace(workspace) && !win.is_on_all_workspaces())
                continue;
            const type = win.get_window_type();
            if (type === Meta.WindowType.DESKTOP || type === Meta.WindowType.DOCK)
                continue;
            const f = win.get_frame_rect();
            const r = {x: f.x, y: f.y, w: f.width, h: f.height};
            if (pointInRect(p, r))
                return r;
        }
        return null;
    }

    _hitTest(p) {
        const sel = this._selection;
        if (!sel)
            return 'outside';
        const m = HANDLE_MARGIN;
        const nearL = Math.abs(p.x - sel.x) <= m;
        const nearR = Math.abs(p.x - (sel.x + sel.w)) <= m;
        const nearT = Math.abs(p.y - sel.y) <= m;
        const nearB = Math.abs(p.y - (sel.y + sel.h)) <= m;
        const inX = p.x >= sel.x - m && p.x <= sel.x + sel.w + m;
        const inY = p.y >= sel.y - m && p.y <= sel.y + sel.h + m;

        if (nearT && nearL) return 'nw';
        if (nearT && nearR) return 'ne';
        if (nearB && nearL) return 'sw';
        if (nearB && nearR) return 'se';
        if (nearT && inX) return 'n';
        if (nearB && inX) return 's';
        if (nearL && inY) return 'w';
        if (nearR && inY) return 'e';
        if (pointInRect(p, sel)) return 'inside';
        return 'outside';
    }

    _cursorForHit(hit) {
        const C = Clutter.CursorType;
        switch (hit) {
        case 'nw': return C.NW_RESIZE;
        case 'ne': return C.NE_RESIZE;
        case 'sw': return C.SW_RESIZE;
        case 'se': return C.SE_RESIZE;
        case 'n': return C.N_RESIZE;
        case 's': return C.S_RESIZE;
        case 'w': return C.W_RESIZE;
        case 'e': return C.E_RESIZE;
        case 'inside': return this._tool ? C.CROSSHAIR : C.MOVE;
        default: return C.CROSSHAIR;
        }
    }

    _updateCursor(p) {
        if (this._textEdit && this._tool === 'text')
            this.set_cursor_type(Clutter.CursorType.TEXT);
        else if (this._hitTest(p) === 'inside' && !this._drag && shapeAt(this._shapes, p))
            this.set_cursor_type(Clutter.CursorType.POINTER);
        else
            this.set_cursor_type(this._cursorForHit(this._hitTest(p)));
    }

    // ---------------------------------------------------------------- tools

    _setTool(id) {
        if (this._textEdit)
            this._commitText();
        this._tool = id;
        this._selectShape(null);
        this._syncToolbarState();
        const [px, py] = global.get_pointer();
        this._updateCursor({x: px, y: py});
    }

    _setColor(color) {
        this._color = color;
        if (this._textEdit) {
            this._textEdit.shape.color = color;
            this._canvas.queue_repaint();
        }
        this._syncToolbarState();
    }

    _setSize(size) {
        this._size = Math.max(MIN_SIZE, Math.min(MAX_SIZE, size));
        if (this._textEdit) {
            this._textEdit.shape.size = this._size;
            this._canvas.queue_repaint();
        }
        this._syncToolbarState();
    }

    // Edits are recorded as operations so that adding, removing and moving
    // drawings can all be undone.
    _applyOp(op, reverse) {
        switch (op.type) {
        case 'add':
            if (reverse)
                this._shapes.splice(this._shapes.indexOf(op.shape), 1);
            else
                this._shapes.splice(op.index, 0, op.shape);
            break;
        case 'remove':
            if (reverse)
                this._shapes.splice(op.index, 0, op.shape);
            else
                this._shapes.splice(this._shapes.indexOf(op.shape), 1);
            break;
        case 'move':
            setShapeGeometry(op.shape, reverse ? op.from : op.to);
            break;
        default:
            break;
        }
    }

    _do(op) {
        this._applyOp(op, false);
        this._undoStack.push(op);
        this._redoStack = [];
        this._afterEdit();
    }

    _afterEdit() {
        this._counter = nextCounter(this._shapes);
        if (this._selectedShape && !this._shapes.includes(this._selectedShape))
            this._selectedShape = null;
        this._syncToolbarState();
        this._canvas.queue_repaint();
    }

    _pushShape(shape) {
        this._do({type: 'add', shape, index: this._shapes.length});
    }

    _removeShape(shape) {
        const index = this._shapes.indexOf(shape);
        if (index < 0)
            return;
        this._do({type: 'remove', shape, index});
    }

    _selectShape(shape) {
        if (this._selectedShape === shape)
            return;
        this._selectedShape = shape;
        this._syncToolbarState();
        this._canvas.queue_repaint();
    }

    _undo() {
        if (this._textEdit) {
            this._cancelText();
            return;
        }
        const op = this._undoStack.pop();
        if (!op)
            return;
        this._applyOp(op, true);
        this._redoStack.push(op);
        this._afterEdit();
    }

    _redo() {
        const op = this._redoStack.pop();
        if (!op)
            return;
        this._applyOp(op, false);
        this._undoStack.push(op);
        this._afterEdit();
    }

    _beginShape(p, shift) {
        const base = {type: this._tool, color: this._color, size: this._size};
        switch (this._tool) {
        case 'pencil':
        case 'marker':
            this._drag = {kind: 'shape', shape: {...base, points: [p]}};
            break;
        case 'line':
        case 'arrow':
            this._drag = {kind: 'shape', shape: {...base, from: p, to: p}};
            break;
        case 'rect':
        case 'ellipse':
        case 'pixelate':
            this._drag = {kind: 'shape', shape: {...base, from: p, to: p, filled: shift}};
            break;
        case 'counter':
            this._pushShape({...base, at: p, n: this._counter++});
            break;
        case 'text':
            if (this._textEdit)
                this._commitText();
            this._textEdit = {shape: {...base, at: p, text: ''}};
            this._canvas.queue_repaint();
            break;
        default:
            break;
        }
    }

    _updateShape(p, shift) {
        const {shape} = this._drag;
        if (shape.points) {
            const last = shape.points[shape.points.length - 1];
            if (last.x !== p.x || last.y !== p.y)
                shape.points.push(p);
        } else {
            shape.to = p;
            if ('filled' in shape)
                shape.filled = shift;
        }
        this._canvas.queue_repaint();
    }

    _endShape() {
        const {shape} = this._drag;
        this._drag = null;
        if (isShapeTooSmall(shape)) {
            this._canvas.queue_repaint();
            return;
        }
        this._pushShape(shape);
    }

    _commitText() {
        const edit = this._textEdit;
        this._textEdit = null;
        if (edit && edit.shape.text.trim().length > 0)
            this._pushShape(edit.shape);
        else
            this._canvas.queue_repaint();
    }

    _cancelText() {
        this._textEdit = null;
        this._canvas.queue_repaint();
    }

    // ---------------------------------------------------------------- drawing

    _paintCanvas(area) {
        const sel = this._selection;
        if (!sel)
            return;
        const cr = area.get_context();
        cr.translate(-sel.x, -sel.y);
        for (const shape of this._shapes)
            this._drawShape(cr, shape);
        if (this._drag?.kind === 'shape')
            this._drawShape(cr, this._drag.shape);
        if (this._textEdit)
            this._drawShape(cr, this._textEdit.shape, true);
        if (this._selectedShape)
            drawSelectionOutline(cr, this._selectedShape);
        cr.$dispose();
    }

    _drawShape(cr, shape, editing = false) {
        drawShape(cr, shape, {editing, pixelate: (c, s) => this._drawPixelate(c, s)});
    }

    _drawPixelate(cr, s) {
        const rc = normalizeRect(s.from.x, s.from.y, s.to.x, s.to.y);
        const block = pixelateBlock(s);
        const px = this._pixels;
        if (!px) {
            cr.setSourceRGBA(0.5, 0.5, 0.5, 0.6);
            cr.rectangle(rc.x, rc.y, rc.w, rc.h);
            cr.fill();
            return;
        }
        const scale = this._scale;
        for (let by = rc.y; by < rc.y + rc.h; by += block) {
            const bh = Math.min(block, rc.y + rc.h - by);
            for (let bx = rc.x; bx < rc.x + rc.w; bx += block) {
                const bw = Math.min(block, rc.x + rc.w - bx);
                const [r, g, b] = this._averageColor(px, bx * scale, by * scale, bw * scale, bh * scale);
                cr.setSourceRGBA(r, g, b, 1);
                cr.rectangle(bx, by, bw, bh);
                cr.fill();
            }
        }
    }

    _averageColor(px, x0, y0, w, h) {
        const x1 = Math.max(0, Math.floor(x0));
        const y1 = Math.max(0, Math.floor(y0));
        const x2 = Math.min(px.width, Math.ceil(x0 + w));
        const y2 = Math.min(px.height, Math.ceil(y0 + h));
        if (x2 <= x1 || y2 <= y1)
            return [0.5, 0.5, 0.5];
        const step = Math.max(1, Math.floor(Math.max(x2 - x1, y2 - y1) / 5));
        let r = 0, g = 0, b = 0, n = 0;
        for (let y = y1; y < y2; y += step) {
            let idx = y * px.stride + x1 * px.channels;
            for (let x = x1; x < x2; x += step, idx += step * px.channels) {
                r += px.data[idx];
                g += px.data[idx + 1];
                b += px.data[idx + 2];
                n++;
            }
        }
        return [r / n / 255, g / n / 255, b / n / 255];
    }

    // ---------------------------------------------------------------- events

    _keyChar(event) {
        // GJS maps gunichar to a one-character string; be tolerant of numbers too.
        const u = event.get_key_unicode();
        if (typeof u === 'string')
            return u;
        return u ? String.fromCodePoint(u) : '';
    }

    _point(event) {
        const [x, y] = event.get_coords();
        return {x: Math.floor(x), y: Math.floor(y)};
    }

    /**
     * Whether a pointer event started on the toolbar. Such events must be
     * left alone: since GNOME 50 St.Button clicks are Clutter.ClickGestures,
     * and returning EVENT_STOP from any actor in the chain cancels them.
     */
    _isToolbarEvent(event) {
        const actor = global.stage.get_event_actor(event);
        return !!actor && this._toolbar.contains(actor);
    }

    vfunc_button_press_event(event) {
        if (this._isToolbarEvent(event))
            return Clutter.EVENT_PROPAGATE;
        if (this._busy)
            return Clutter.EVENT_STOP;
        const p = this._point(event);
        const button = event.get_button();
        const shift = (event.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0;

        if (this._textEdit) {
            this._commitText();
            if (button === 1 && this._tool === 'text' && this._hitTest(p) === 'inside') {
                this._beginShape(p, shift);
                return Clutter.EVENT_STOP;
            }
        }

        if (button === 3) {
            // Right click: drop the active tool; with no tool, delete the
            // drawing under the pointer.
            const shape = shapeAt(this._shapes, p);
            if (shape)
                this._removeShape(shape);
            else if (this._tool)
                this._setTool(null);
            else
                this._selectShape(null);
            return Clutter.EVENT_STOP;
        }
        if (button !== 1)
            return Clutter.EVENT_STOP;

        if (this._selection) {
            const hit = this._hitTest(p);
            if (hit !== 'inside' && hit !== 'outside') {
                this._drag = {kind: 'resize', handle: hit, start: p, orig: {...this._selection}};
                this._updateSelectionUI();
                return Clutter.EVENT_STOP;
            }
            const shape = hit === 'inside' ? shapeAt(this._shapes, p) : null;
            if (shape) {
                this._selectShape(shape);
                this._drag = {kind: 'shape-move', shape, start: p, from: shapeGeometry(shape), moved: false};
                this.set_cursor_type(Clutter.CursorType.MOVE);
                return Clutter.EVENT_STOP;
            }
            if (this._tool) {
                this._selectShape(null);
                this._beginShape(p, shift);
                return Clutter.EVENT_STOP;
            }
            if (hit === 'inside') {
                this._selectShape(null);
                this._drag = {kind: 'move', start: p, orig: {...this._selection}};
                this.set_cursor_type(Clutter.CursorType.MOVE);
                this._updateSelectionUI();
                return Clutter.EVENT_STOP;
            }
        }

        this._drag = {kind: 'select', start: p, moved: false};
        return Clutter.EVENT_STOP;
    }

    vfunc_motion_event(event) {
        const p = this._point(event);
        const drag = this._drag;
        if (!drag && this._isToolbarEvent(event))
            return Clutter.EVENT_PROPAGATE;
        if (!drag) {
            this._updateCursor(p);
            return Clutter.EVENT_STOP;
        }
        const shift = (event.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0;

        switch (drag.kind) {
        case 'select':
            if (!drag.moved && Math.abs(p.x - drag.start.x) < MIN_DRAG && Math.abs(p.y - drag.start.y) < MIN_DRAG)
                break;
            drag.moved = true;
            this._setSelection(normalizeRect(drag.start.x, drag.start.y, p.x, p.y));
            break;
        case 'move': {
            const o = drag.orig;
            const nx = Math.max(0, Math.min(o.x + p.x - drag.start.x, global.stage.width - o.w));
            const ny = Math.max(0, Math.min(o.y + p.y - drag.start.y, global.stage.height - o.h));
            this._setSelection({x: nx, y: ny, w: o.w, h: o.h});
            break;
        }
        case 'resize': {
            const o = drag.orig;
            let l = o.x, t = o.y, r = o.x + o.w - 1, b = o.y + o.h - 1;
            const dx = p.x - drag.start.x;
            const dy = p.y - drag.start.y;
            if (drag.handle.includes('w')) l += dx;
            if (drag.handle.includes('e')) r += dx;
            if (drag.handle.includes('n')) t += dy;
            if (drag.handle.includes('s')) b += dy;
            this._setSelection(normalizeRect(l, t, r, b));
            break;
        }
        case 'shape':
            this._updateShape(p, shift);
            break;
        case 'shape-move': {
            const dx = p.x - drag.start.x;
            const dy = p.y - drag.start.y;
            if (!drag.moved && Math.abs(dx) < MIN_DRAG && Math.abs(dy) < MIN_DRAG)
                break;
            drag.moved = true;
            setShapeGeometry(drag.shape, translateGeometry(drag.from, dx, dy));
            this._canvas.queue_repaint();
            break;
        }
        default:
            break;
        }
        return Clutter.EVENT_STOP;
    }

    vfunc_button_release_event(event) {
        const drag = this._drag;
        if (!drag && this._isToolbarEvent(event))
            return Clutter.EVENT_PROPAGATE;
        if (!drag || event.get_button() !== 1)
            return Clutter.EVENT_STOP;
        const p = this._point(event);

        switch (drag.kind) {
        case 'select':
            this._drag = null;
            if (!drag.moved) {
                const win = this._windowUnderPoint(p);
                this._setSelection(win ?? monitorRect(this._monitorUnderPointer()));
            } else {
                this._setSelection(normalizeRect(drag.start.x, drag.start.y, p.x, p.y));
            }
            break;
        case 'move':
        case 'resize':
            this._drag = null;
            this._updateSelectionUI();
            break;
        case 'shape':
            this._endShape();
            break;
        case 'shape-move':
            this._drag = null;
            if (drag.moved)
                this._do({type: 'move', shape: drag.shape, from: drag.from, to: shapeGeometry(drag.shape)});
            break;
        default:
            this._drag = null;
        }
        this._updateCursor(p);
        return Clutter.EVENT_STOP;
    }

    vfunc_scroll_event(event) {
        return this._onScroll(event);
    }

    _onScroll(event) {
        // A wheel notch arrives both as a discrete event and as an emulated
        // smooth one; only count it once.
        if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED)
            return Clutter.EVENT_STOP;
        const dir = event.get_scroll_direction();
        if (dir === Clutter.ScrollDirection.SMOOTH) {
            // Touchpads send many small deltas; one unit equals a wheel notch.
            const [, dy] = event.get_scroll_delta();
            this._scrollAccum = (this._scrollAccum ?? 0) - dy;
            const steps = Math.trunc(this._scrollAccum);
            if (steps !== 0) {
                this._scrollAccum -= steps;
                this._setSize(this._size + steps);
            }
        } else if (dir === Clutter.ScrollDirection.UP) {
            this._setSize(this._size + 1);
        } else if (dir === Clutter.ScrollDirection.DOWN) {
            this._setSize(this._size - 1);
        }
        return Clutter.EVENT_STOP;
    }

    vfunc_key_press_event(event) {
        if (this._busy)
            return Clutter.EVENT_STOP;
        const sym = event.get_key_symbol();
        const state = event.get_state();
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;

        if (this._textEdit) {
            this._handleTextKey(event, sym, ctrl, shift);
            return Clutter.EVENT_STOP;
        }

        switch (sym) {
        case Clutter.KEY_Escape:
            if (this._selectedShape)
                this._selectShape(null);
            else if (this._tool)
                this._setTool(null);
            else
                this.close();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Delete:
        case Clutter.KEY_KP_Delete:
        case Clutter.KEY_BackSpace:
            if (this._selectedShape)
                this._removeShape(this._selectedShape);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
            if (this._mode === 'record')
                this._record();
            else
                this._copy();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_space:
            this._toolbarHiddenByUser = !this._toolbarHiddenByUser;
            this._updateSelectionUI();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Left:
        case Clutter.KEY_Right:
        case Clutter.KEY_Up:
        case Clutter.KEY_Down:
            this._nudgeSelection(sym, ctrl, shift);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_bracketleft:
        case Clutter.KEY_minus:
            this._setSize(this._size - 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_bracketright:
        case Clutter.KEY_plus:
        case Clutter.KEY_equal:
            this._setSize(this._size + 1);
            return Clutter.EVENT_STOP;
        default:
            break;
        }

        const ch = this._keyChar(event).toLowerCase();
        if (this._mode === 'record') {
            if (ctrl && ch === 'a')
                this._selectMonitorUnderPointer();
            return Clutter.EVENT_STOP;
        }
        if (ctrl) {
            switch (ch) {
            case 'r': this._record(); break;
            case 'c': this._copy(); break;
            case 's': this._save(shift); break;
            case 'z': shift ? this._redo() : this._undo(); break;
            case 'y': this._redo(); break;
            case 'a': this._selectMonitorUnderPointer(); break;
            case 'p': this._pin(); break;
            case 'o': this._open(); break;
            default: break;
            }
            return Clutter.EVENT_STOP;
        }

        if (ch === 'v') {
            this._setTool(null);
            return Clutter.EVENT_STOP;
        }
        const tool = TOOLS.find(t => t.key === ch);
        if (tool)
            this._setTool(this._tool === tool.id ? null : tool.id);
        else if (ch >= '1' && ch <= '9' && COLORS[Number(ch) - 1])
            this._setColor(COLORS[Number(ch) - 1]);
        return Clutter.EVENT_STOP;
    }

    _handleTextKey(event, sym, ctrl, shift) {
        const shape = this._textEdit.shape;
        switch (sym) {
        case Clutter.KEY_Escape:
            this._commitText();
            return;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
            if (shift)
                shape.text += '\n';
            else
                this._commitText();
            break;
        case Clutter.KEY_BackSpace:
            shape.text = Array.from(shape.text).slice(0, -1).join('');
            break;
        case Clutter.KEY_Tab:
            shape.text += '    ';
            break;
        default: {
            if (ctrl) {
                const ch = this._keyChar(event).toLowerCase();
                if (ch === 'v') {
                    St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_c, text) => {
                        if (text && this._textEdit) {
                            this._textEdit.shape.text += text;
                            this._canvas.queue_repaint();
                        }
                    });
                }
                return;
            }
            const ch = this._keyChar(event);
            if (ch && ch.codePointAt(0) >= 0x20)
                shape.text += ch;
            break;
        }
        }
        this._canvas.queue_repaint();
    }

    _nudgeSelection(sym, ctrl, shift) {
        const sel = this._selection;
        if (!sel)
            return;
        const step = shift ? 10 : 1;
        let dx = 0, dy = 0;
        if (sym === Clutter.KEY_Left) dx = -step;
        if (sym === Clutter.KEY_Right) dx = step;
        if (sym === Clutter.KEY_Up) dy = -step;
        if (sym === Clutter.KEY_Down) dy = step;
        if (ctrl)
            this._setSelection({x: sel.x, y: sel.y, w: Math.max(1, sel.w + dx), h: Math.max(1, sel.h + dy)});
        else
            this._setSelection({x: sel.x + dx, y: sel.y + dy, w: sel.w, h: sel.h});
    }

    // ---------------------------------------------------------------- export

    async _render() {
        const sel = this._selection;
        if (!sel)
            return null;
        if (this._textEdit)
            this._commitText();

        const cursor = this._cursorActor.visible
            ? {
                texture: this._cursorActor.content.get_texture(),
                x: this._cursorActor.x * this._scale,
                y: this._cursorActor.y * this._scale,
                scale: this._cursorScale,
            }
            : {texture: null, x: 0, y: 0, scale: 1};

        // composite_to_stream crops in texture pixels, not stage coordinates.
        const s = this._scale;
        const stream = Gio.MemoryOutputStream.new_resizable();
        let pixbuf = await Shell.Screenshot.composite_to_stream(
            this._texture,
            Math.round(sel.x * s), Math.round(sel.y * s),
            Math.round(sel.w * s), Math.round(sel.h * s), s,
            cursor.texture, cursor.x, cursor.y, cursor.scale, stream);
        stream.close(null);
        let bytes = stream.steal_as_bytes();

        if (this._shapes.length > 0) {
            if (this._shapes.some(sh => sh.type === 'pixelate'))
                await this._pixelsPromise;
            [bytes, pixbuf] = this._burnAnnotations(bytes, sel);
        }
        return {bytes, pixbuf, scale: this._scale, rect: {...sel}};
    }

    /**
     * Draws the annotations onto the PNG-encoded region. GJS's Cairo binding
     * can only read and write PNGs through files, so this round-trips via a
     * temporary file in the cache directory.
     */
    _burnAnnotations(bytes, sel) {
        const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'flameshot-gnome']);
        GLib.mkdir_with_parents(dir, 0o700);
        const tmp = GLib.build_filenamev([dir, `render-${GLib.get_monotonic_time()}.png`]);
        try {
            GLib.file_set_contents(tmp, bytes.toArray());
            const surface = Cairo.ImageSurface.createFromPNG(tmp);
            const cr = new Cairo.Context(surface);
            cr.scale(this._scale, this._scale);
            cr.translate(-sel.x, -sel.y);
            for (const shape of this._shapes)
                this._drawShape(cr, shape);
            cr.$dispose();
            surface.flush();
            surface.writeToPNG(tmp);
            surface.finish();

            const [, data] = GLib.file_get_contents(tmp);
            const pixbuf = GdkPixbuf.Pixbuf.new_from_file(tmp);
            return [new GLib.Bytes(data), pixbuf];
        } finally {
            GLib.unlink(tmp);
        }
    }

    async _withResult(fn) {
        if (this._busy || !this._selection)
            return;
        this._busy = true;
        try {
            const result = await this._render();
            if (result)
                await fn(result);
        } catch (e) {
            logError(e, 'Flameshot GNOME: export failed');
            Main.notify('Flameshot GNOME', `Export failed: ${e.message}`);
            this._busy = false;
            if (!this._closed)
                this.close();
        }
    }

    _playSound() {
        if (this._settings.get_boolean('play-sound'))
            global.display.get_sound_player().play_from_theme('screen-capture', 'Screenshot taken', null);
    }

    _notify(title, body) {
        if (this._settings.get_boolean('show-notification'))
            Main.notify(title, body);
    }

    _toClipboard(bytes) {
        St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, 'image/png', bytes);
    }

    _copy() {
        this._withResult(async ({bytes, rect}) => {
            this._toClipboard(bytes);
            this._playSound();
            this.close();
            this._notify('Screenshot copied', `${rect.w} × ${rect.h} pixels copied to the clipboard.`);
        });
    }

    _save(forceDialog = false) {
        this._withResult(async ({bytes, rect}) => {
            if (this._settings.get_boolean('copy-on-save'))
                this._toClipboard(bytes);
            this._playSound();
            this.close();

            let file;
            if (forceDialog || this._settings.get_boolean('ask-where-to-save'))
                file = await this._askSaveLocation();
            else
                file = this._uniqueFile(this._saveDirectory(), this._fileName());
            if (!file)
                return;

            GLib.mkdir_with_parents(file.get_parent().get_path(), 0o755);
            await file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            this._notify('Screenshot saved', `${rect.w} × ${rect.h} saved to ${GLib.filename_display_name(file.get_path())}`);
        });
    }

    /** Closes the overlay and records the selected area. */
    _record() {
        const sel = this._selection;
        if (this._busy || !sel || this._closed)
            return;
        this.close();
        // Let the stage repaint without the overlay before recording starts.
        this._extension.startRecording({...sel});
    }

    _pin() {
        this._withResult(async ({pixbuf, scale, rect}) => {
            this._playSound();
            this.close();
            new PinnedScreenshot(pixbuf, scale, rect);
        });
    }

    _open() {
        this._withResult(async ({bytes}) => {
            this._playSound();
            this.close();
            const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'flameshot-gnome']);
            GLib.mkdir_with_parents(dir, 0o755);
            const file = this._uniqueFile(dir, this._fileName());
            await file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            const context = global.create_app_launch_context(0, -1);
            Gio.AppInfo.launch_default_for_uri(file.get_uri(), context);
        });
    }

    _saveDirectory() {
        const configured = this._settings.get_string('save-directory');
        if (configured)
            return configured.replace(/^~/, GLib.get_home_dir());
        const pictures = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) ??
            GLib.build_filenamev([GLib.get_home_dir(), 'Pictures']);
        return GLib.build_filenamev([pictures, 'Screenshots']);
    }

    _fileName() {
        const pattern = this._settings.get_string('filename-pattern') || 'Screenshot from %Y-%m-%d %H-%M-%S.png';
        let name = GLib.DateTime.new_now_local().format(pattern) ?? 'Screenshot.png';
        if (!name.toLowerCase().endsWith('.png'))
            name += '.png';
        return name.replace(/\//g, '-');
    }

    _uniqueFile(dir, name) {
        const dot = name.lastIndexOf('.');
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : '';
        let file = Gio.File.new_for_path(GLib.build_filenamev([dir, name]));
        for (let i = 1; file.query_exists(null); i++)
            file = Gio.File.new_for_path(GLib.build_filenamev([dir, `${stem}-${i}${ext}`]));
        return file;
    }

    async _askSaveLocation() {
        const helper = GLib.build_filenamev([this._path, 'save-dialog.js']);
        const proc = Gio.Subprocess.new(
            ['gjs', '-m', helper, this._saveDirectory(), this._fileName()],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        const [stdout] = await proc.communicate_utf8_async(null, null);
        const path = stdout.trim();
        if (!path)
            return null;
        return Gio.File.new_for_path(path);
    }
});
