// Flameshot GNOME - "pin" a screenshot as a floating, draggable image.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const MIN_SCALE = 0.1;
const MAX_SCALE = 4;

export const PinnedScreenshot = GObject.registerClass(
class PinnedScreenshot extends St.Widget {
    _init(pixbuf, scale, rect) {
        super._init({
            style_class: 'fsg-pinned',
            reactive: true,
            can_focus: true,
            track_hover: true,
        });

        const coglContext = global.stage.context.get_backend().get_cogl_context();
        const content = St.ImageContent.new_with_preferred_size(pixbuf.width, pixbuf.height);
        content.set_bytes(
            coglContext,
            pixbuf.read_pixel_bytes(),
            pixbuf.has_alpha ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
            pixbuf.width,
            pixbuf.height,
            pixbuf.rowstride);

        this._image = new St.Widget({content, x_expand: true, y_expand: true});
        this.add_child(this._image);

        this._baseWidth = pixbuf.width / scale;
        this._baseHeight = pixbuf.height / scale;
        this._zoom = 1;
        this._drag = null;

        this.set_position(rect.x, rect.y);
        this._applySize();

        Main.layoutManager.addChrome(this, {affectsInputRegion: true, trackFullscreen: false});
        Main.uiGroup.set_child_above_sibling(this, null);
    }

    _applySize() {
        this._image.set_size(
            Math.round(this._baseWidth * this._zoom),
            Math.round(this._baseHeight * this._zoom));
    }

    vfunc_button_press_event(event) {
        const button = event.get_button();
        if (button === 3 || (button === 1 && event.get_click_count?.() === 2)) {
            this.destroy();
            return Clutter.EVENT_STOP;
        }
        if (button === 1) {
            const [x, y] = event.get_coords();
            this._drag = {dx: x - this.x, dy: y - this.y};
            this._grab = global.stage.grab(this);
            this.set_cursor_type(Clutter.CursorType.MOVE);
        }
        return Clutter.EVENT_STOP;
    }

    vfunc_motion_event(event) {
        if (!this._drag)
            return Clutter.EVENT_STOP;
        const [x, y] = event.get_coords();
        this.set_position(Math.round(x - this._drag.dx), Math.round(y - this._drag.dy));
        return Clutter.EVENT_STOP;
    }

    vfunc_button_release_event() {
        if (this._drag) {
            this._drag = null;
            this._grab?.dismiss();
            this._grab = null;
            this.set_cursor_type(Clutter.CursorType.DEFAULT);
        }
        return Clutter.EVENT_STOP;
    }

    vfunc_scroll_event(event) {
        // A wheel notch arrives both as a discrete event and as an emulated
        // smooth one; only count it once.
        if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED)
            return Clutter.EVENT_STOP;
        const dir = event.get_scroll_direction();
        let notches = 0;
        if (dir === Clutter.ScrollDirection.SMOOTH)
            notches = -event.get_scroll_delta()[1];
        else if (dir === Clutter.ScrollDirection.UP)
            notches = 1;
        else if (dir === Clutter.ScrollDirection.DOWN)
            notches = -1;
        this._zoom = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this._zoom * 1.1 ** notches));
        this._applySize();
        return Clutter.EVENT_STOP;
    }

    vfunc_key_press_event(event) {
        if (event.get_key_symbol() === Clutter.KEY_Escape) {
            this.destroy();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    destroy() {
        this._grab?.dismiss();
        this._grab = null;
        if (this.get_parent())
            Main.layoutManager.removeChrome(this);
        super.destroy();
    }
});
