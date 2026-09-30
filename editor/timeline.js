// Flameshot GNOME video editor - timeline.
//
// A time ruler with the playhead, and one lane per drawing showing when it
// is visible. Click or drag the ruler to seek; click a bar to select its
// drawing; drag a bar's ends to change when it appears or disappears, or
// its middle to shift it in time. Edges snap to the playhead.

import Gdk from 'gi://Gdk?version=4.0';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

import {TOOLS, hexToRgb} from '../drawing.js';

const PAD = 12;
const RULER_H = 24;
const LANE_H = 18;
const BAR_H = 14;
const EDGE = 6;
const SNAP = 6;
const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

export function formatTime(t, precise = true) {
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return precise
        ? `${m}:${s.toFixed(2).padStart(5, '0')}`
        : `${m}:${String(Math.floor(s)).padStart(2, '0')}`;
}

export const Timeline = GObject.registerClass(
class Timeline extends Gtk.DrawingArea {
    /**
     * `editor` provides: duration, time, fps, shapes, selected, and the
     * callbacks seek(t), selectShape(s), checkpoint(), shapesChanged().
     */
    _init(editor) {
        super._init({hexpand: true, focusable: false});
        this._editor = editor;
        this._drag = null;
        this.set_draw_func((_a, cr, w, h) => this._draw(cr, w, h));

        const drag = new Gtk.GestureDrag({button: Gdk.BUTTON_PRIMARY});
        drag.connect('drag-begin', (g, x, y) => {
            // Bottom bars double as window handles; keep the drag for ourselves.
            g.set_state(Gtk.EventSequenceState.CLAIMED);
            this._onBegin(x, y);
        });
        drag.connect('drag-update', (_g, dx, dy) => this._onUpdate(dx, dy));
        drag.connect('drag-end', (_g, dx, dy) => this._onEnd(dx, dy));
        this.add_controller(drag);

        const motion = new Gtk.EventControllerMotion();
        motion.connect('motion', (_m, x, y) => this._updateCursor(x, y));
        this.add_controller(motion);
    }

    refresh() {
        this.set_content_height(RULER_H + Math.max(1, this._editor.shapes.length) * LANE_H + 6);
        this.queue_draw();
    }

    // ---------------------------------------------------------------- mapping

    _x(t) {
        const w = this.get_width() - PAD * 2;
        return PAD + (this._editor.duration > 0 ? t / this._editor.duration : 0) * w;
    }

    _t(x) {
        const w = Math.max(1, this.get_width() - PAD * 2);
        return Math.max(0, Math.min(this._editor.duration, (x - PAD) / w * this._editor.duration));
    }

    _end(s) {
        return s.end ?? this._editor.duration;
    }

    _hit(x, y) {
        if (y < RULER_H)
            return {kind: 'ruler'};
        const index = Math.floor((y - RULER_H) / LANE_H);
        const shape = this._editor.shapes[index];
        if (!shape)
            return {kind: 'ruler'};
        const x1 = this._x(shape.start);
        const x2 = this._x(this._end(shape));
        if (Math.abs(x - x1) <= EDGE && x < x2 - 2)
            return {kind: 'start', shape};
        if (Math.abs(x - x2) <= EDGE)
            return {kind: 'end', shape};
        if (x > x1 && x < x2)
            return {kind: 'move', shape};
        return {kind: 'lane', shape};
    }

    _updateCursor(x, y) {
        const hit = this._hit(x, y);
        const name = {start: 'col-resize', end: 'col-resize', move: 'grab'}[hit.kind] ?? 'default';
        this.set_cursor_from_name(name);
    }

    // ---------------------------------------------------------------- input

    _onBegin(x, y) {
        const ed = this._editor;
        const hit = this._hit(x, y);
        this._drag = {...hit, x0: x, y0: y, moved: false};
        if (hit.shape) {
            this._drag.orig = {start: hit.shape.start, end: hit.shape.end};
            ed.selectShape(hit.shape);
        }
        if (hit.kind === 'ruler' || hit.kind === 'lane')
            ed.seek(this._t(x), true);
    }

    _snap(t) {
        const ed = this._editor;
        if (Math.abs(this._x(t) - this._x(ed.time)) <= SNAP)
            return ed.time;
        if (Math.abs(this._x(t) - this._x(ed.duration)) <= SNAP)
            return ed.duration;
        if (Math.abs(this._x(t) - this._x(0)) <= SNAP)
            return 0;
        // Keep boundaries on frame times.
        return Math.round(t * ed.fps) / ed.fps;
    }

    _onUpdate(dx, _dy) {
        const drag = this._drag;
        if (!drag)
            return;
        const ed = this._editor;
        const x = drag.x0 + dx;
        if (drag.kind === 'ruler' || drag.kind === 'lane') {
            ed.seek(this._t(x), true);
            return;
        }
        if (!drag.moved) {
            if (Math.abs(dx) < 3)
                return;
            drag.moved = true;
            ed.checkpoint();
        }
        const s = drag.shape;
        const minLen = 1 / ed.fps;
        const origEnd = drag.orig.end ?? ed.duration;
        if (drag.kind === 'start') {
            s.start = Math.max(0, Math.min(this._snap(this._t(x)), origEnd - minLen));
        } else if (drag.kind === 'end') {
            const end = Math.max(this._snap(this._t(x)), s.start + minLen);
            s.end = end >= ed.duration - minLen / 2 ? null : end;
        } else if (drag.kind === 'move') {
            const len = origEnd - drag.orig.start;
            let start = this._snap(drag.orig.start + this._t(x) - this._t(drag.x0));
            start = Math.max(0, Math.min(start, ed.duration - len));
            s.start = start;
            s.end = drag.orig.end === null && start + len >= ed.duration - minLen / 2 ? null : start + len;
        }
        ed.shapesChanged();
    }

    _onEnd(dx, _dy) {
        const drag = this._drag;
        this._drag = null;
        if (!drag)
            return;
        // Clicking a bar that is not visible right now jumps to it.
        if (!drag.moved && drag.kind === 'move' && Math.abs(dx) < 3) {
            const ed = this._editor;
            const s = drag.shape;
            if (ed.time < s.start || ed.time >= this._end(s))
                ed.seek(s.start, true);
        }
    }

    // ---------------------------------------------------------------- drawing

    _draw(cr, w, h) {
        const ed = this._editor;
        const fg = this.get_color();
        const setFg = a => cr.setSourceRGBA(fg.red, fg.green, fg.blue, fg.alpha * a);

        // Ruler.
        setFg(0.06);
        cr.rectangle(0, 0, w, RULER_H);
        cr.fill();
        if (ed.duration > 0) {
            const pxPerSec = (w - PAD * 2) / ed.duration;
            const step = TICK_STEPS.find(s => s * pxPerSec >= 70) ?? 600;
            const layout = PangoCairo.create_layout(cr);
            layout.set_font_description(Pango.FontDescription.from_string('Sans 8'));
            cr.setLineWidth(1);
            for (let t = 0; t <= ed.duration + 1e-6; t += step) {
                const x = Math.round(this._x(t)) + 0.5;
                setFg(0.35);
                cr.moveTo(x, RULER_H - 7);
                cr.lineTo(x, RULER_H);
                cr.stroke();
                layout.set_text(step < 1 ? formatTime(t).replace(/0$/, '') : formatTime(t, false), -1);
                const [tw] = layout.get_pixel_size();
                setFg(0.7);
                cr.moveTo(Math.min(w - tw - 2, Math.max(2, x - tw / 2)), 3);
                PangoCairo.show_layout(cr, layout);
                // Minor ticks.
                for (let i = 1; i < 5; i++) {
                    const mx = Math.round(this._x(t + step * i / 5)) + 0.5;
                    if (t + step * i / 5 > ed.duration)
                        break;
                    setFg(0.2);
                    cr.moveTo(mx, RULER_H - 4);
                    cr.lineTo(mx, RULER_H);
                    cr.stroke();
                }
            }
        }

        // Lanes.
        const layout = PangoCairo.create_layout(cr);
        layout.set_font_description(Pango.FontDescription.from_string('Sans 8'));
        ed.shapes.forEach((s, i) => {
            const y = RULER_H + i * LANE_H + (LANE_H - BAR_H) / 2 + 2;
            if (i % 2 === 1) {
                setFg(0.03);
                cr.rectangle(0, RULER_H + i * LANE_H + 2, w, LANE_H);
                cr.fill();
            }
            const x1 = this._x(s.start);
            const x2 = Math.max(x1 + 3, this._x(this._end(s)));
            const [r, g, b] = hexToRgb(s.color);
            roundedRect(cr, x1, y, x2 - x1, BAR_H, 4);
            cr.setSourceRGBA(r, g, b, 0.85);
            cr.fillPreserve();
            if (s === ed.selected) {
                cr.setLineWidth(2);
                setFg(1);
                cr.stroke();
            } else {
                cr.setLineWidth(1);
                cr.setSourceRGBA(0, 0, 0, 0.35);
                cr.stroke();
            }
            const tool = TOOLS.find(t => t.id === s.type);
            let label = tool?.label.replace(/ \(.*\)$/, '') ?? s.type;
            if (s.type === 'text')
                label = `“${s.text.split('\n')[0]}”`;
            else if (s.type === 'counter')
                label = `${label} ${s.n}`;
            layout.set_text(label, -1);
            const [tw, th] = layout.get_pixel_size();
            if (tw + 8 <= x2 - x1) {
                const lum = 0.299 * r + 0.587 * g + 0.114 * b;
                const c = lum > 0.6 ? 0 : 1;
                cr.setSourceRGBA(c, c, c, 0.9);
                cr.moveTo(x1 + 5, y + (BAR_H - th) / 2);
                PangoCairo.show_layout(cr, layout);
            }
        });

        if (ed.shapes.length === 0) {
            layout.set_text('Drawings appear here. Pause, draw, play on, and press Delete where a drawing should disappear.', -1);
            const [, th] = layout.get_pixel_size();
            setFg(0.5);
            cr.moveTo(PAD, RULER_H + (LANE_H - th) / 2 + 2);
            PangoCairo.show_layout(cr, layout);
        }

        // Playhead.
        const px = Math.round(this._x(ed.time)) + 0.5;
        cr.setSourceRGBA(0.93, 0.2, 0.23, 1);
        cr.setLineWidth(2);
        cr.moveTo(px, 0);
        cr.lineTo(px, h);
        cr.stroke();
        cr.moveTo(px - 6, 0);
        cr.lineTo(px + 6, 0);
        cr.lineTo(px, 8);
        cr.closePath();
        cr.fill();
        cr.$dispose();
    }
});

function roundedRect(cr, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}
