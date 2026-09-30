// Flameshot GNOME - annotation shapes shared by the screenshot overlay (runs
// inside GNOME Shell) and the video editor (a separate GTK process).
//
// A shape is a plain object: {type, color, size, ...geometry}. Geometry is
// either `points` (pencil, marker), `from`/`to` (line, arrow, rect, ellipse,
// pixelate) or `at` (counter, text). All coordinates share one space; the
// caller sets up the Cairo transform.

import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import Cairo from 'cairo';

export const TOOLS = [
    {id: 'pencil', icon: 'fsg-pencil', label: 'Pencil', key: 'p'},
    {id: 'line', icon: 'fsg-line', label: 'Line', key: 'l'},
    {id: 'arrow', icon: 'fsg-arrow', label: 'Arrow', key: 'a'},
    {id: 'rect', icon: 'fsg-rect', label: 'Rectangle (Shift: filled)', key: 'r'},
    {id: 'ellipse', icon: 'fsg-ellipse', label: 'Ellipse (Shift: filled)', key: 'e'},
    {id: 'marker', icon: 'fsg-marker', label: 'Marker', key: 'm'},
    {id: 'text', icon: 'fsg-text', label: 'Text', key: 't'},
    {id: 'pixelate', icon: 'fsg-pixelate', label: 'Pixelate', key: 'b'},
    {id: 'counter', icon: 'fsg-counter', label: 'Counter', key: 'n'},
];

export const COLORS = [
    '#ffffff', '#000000', '#ff2b2b', '#ff8c00', '#ffd500',
    '#2ecc40', '#1e90ff', '#8e44ad', '#ff3fb4',
];

export const MIN_SIZE = 1;
export const MAX_SIZE = 40;

export function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return [
        parseInt(h.slice(0, 2), 16) / 255,
        parseInt(h.slice(2, 4), 16) / 255,
        parseInt(h.slice(4, 6), 16) / 255,
    ];
}

export function normalizeRect(x1, y1, x2, y2) {
    return {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        w: Math.abs(x2 - x1) + 1,
        h: Math.abs(y2 - y1) + 1,
    };
}

export function pointInRect(p, r) {
    return p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h;
}

/** Block size, in shape coordinates, used by the pixelate tool. */
export function pixelateBlock(s) {
    return 4 + s.size * 2;
}

/** Number for the next counter bubble. */
export function nextCounter(shapes) {
    const counters = shapes.filter(sh => sh.type === 'counter').map(sh => sh.n);
    return counters.length > 0 ? Math.max(...counters) + 1 : 1;
}

// ---------------------------------------------------------------- geometry

export function shapeGeometry(s) {
    return {
        points: s.points?.map(pt => ({...pt})),
        from: s.from ? {...s.from} : undefined,
        to: s.to ? {...s.to} : undefined,
        at: s.at ? {...s.at} : undefined,
    };
}

export function setShapeGeometry(s, g) {
    if (g.points) s.points = g.points.map(pt => ({...pt}));
    if (g.from) s.from = {...g.from};
    if (g.to) s.to = {...g.to};
    if (g.at) s.at = {...g.at};
    delete s._bounds;
}

export function translateGeometry(g, dx, dy) {
    const mv = pt => (pt ? {x: pt.x + dx, y: pt.y + dy} : undefined);
    return {points: g.points?.map(mv), from: mv(g.from), to: mv(g.to), at: mv(g.at)};
}

/** Bounding box of a drawing, or null if unknown (text not drawn yet). */
export function shapeBounds(s) {
    switch (s.type) {
    case 'pencil':
    case 'marker': {
        const pad = s.type === 'marker' ? Math.max(8, s.size * 4) / 2 : s.size / 2;
        const xs = s.points.map(pt => pt.x);
        const ys = s.points.map(pt => pt.y);
        const x = Math.min(...xs) - pad, y = Math.min(...ys) - pad;
        return {x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y};
    }
    case 'line':
    case 'arrow': {
        const pad = s.size / 2 + (s.type === 'arrow' ? (10 + s.size * 3) * 0.5 : 0);
        const r = normalizeRect(s.from.x, s.from.y, s.to.x, s.to.y);
        return {x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2};
    }
    case 'rect':
    case 'ellipse':
    case 'pixelate':
        return normalizeRect(s.from.x, s.from.y, s.to.x, s.to.y);
    case 'counter': {
        const r = 10 + s.size * 2;
        return {x: s.at.x - r, y: s.at.y - r, w: r * 2, h: r * 2};
    }
    case 'text':
        return s._bounds ?? null;
    default:
        return null;
    }
}

function distanceToSegment(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Whether the point hits the drawing. `slack` widens the tolerance, for
 * callers whose coordinates are finer than screen pixels.
 */
export function shapeContains(s, p, slack = 1) {
    const tol = Math.max(6 * slack, s.size / 2 + 3 * slack);
    switch (s.type) {
    case 'pencil':
    case 'marker': {
        const t = s.type === 'marker' ? Math.max(8, s.size * 4) / 2 + 2 * slack : tol;
        if (s.points.length === 1)
            return Math.hypot(p.x - s.points[0].x, p.y - s.points[0].y) <= t;
        for (let i = 1; i < s.points.length; i++) {
            if (distanceToSegment(p, s.points[i - 1], s.points[i]) <= t)
                return true;
        }
        return false;
    }
    case 'line':
    case 'arrow':
        return distanceToSegment(p, s.from, s.to) <= tol + (s.type === 'arrow' ? 4 * slack : 0);
    case 'rect':
    case 'pixelate': {
        const r = normalizeRect(s.from.x, s.from.y, s.to.x, s.to.y);
        const inOuter = p.x >= r.x - tol && p.x <= r.x + r.w + tol && p.y >= r.y - tol && p.y <= r.y + r.h + tol;
        if (s.filled || s.type === 'pixelate')
            return inOuter;
        const inInner = p.x > r.x + tol && p.x < r.x + r.w - tol && p.y > r.y + tol && p.y < r.y + r.h - tol;
        return inOuter && !inInner;
    }
    case 'ellipse': {
        const r = normalizeRect(s.from.x, s.from.y, s.to.x, s.to.y);
        const rx = Math.max(1, r.w / 2), ry = Math.max(1, r.h / 2);
        const nx = (p.x - (r.x + rx)) / rx, ny = (p.y - (r.y + ry)) / ry;
        const d = Math.hypot(nx, ny);
        if (s.filled)
            return d <= 1 + tol / Math.min(rx, ry);
        return Math.abs(d - 1) * Math.min(rx, ry) <= tol;
    }
    case 'counter':
        return Math.hypot(p.x - s.at.x, p.y - s.at.y) <= 10 + s.size * 2 + 2 * slack;
    case 'text': {
        const b = s._bounds;
        const m = 4 * slack;
        return !!b && p.x >= b.x - m && p.x <= b.x + b.w + m && p.y >= b.y - m && p.y <= b.y + b.h + m;
    }
    default:
        return false;
    }
}

/** Topmost drawing under the point, or null. */
export function shapeAt(shapes, p, slack = 1) {
    for (let i = shapes.length - 1; i >= 0; i--) {
        if (shapeContains(shapes[i], p, slack))
            return shapes[i];
    }
    return null;
}

/** Whether a finished drag produced something worth keeping. */
export function isShapeTooSmall(s) {
    if (!s.from || !s.to || s.type === 'line' || s.type === 'arrow')
        return false;
    return Math.abs(s.to.x - s.from.x) < 2 && Math.abs(s.to.y - s.from.y) < 2;
}

// ---------------------------------------------------------------- painting

/**
 * Paints one drawing. `pixelate(cr, shape)` paints pixelate regions; without
 * it they are shown as a grey placeholder. `editing` adds the text caret.
 */
export function drawShape(cr, s, {editing = false, pixelate = null} = {}) {
    const [r, g, b] = hexToRgb(s.color);
    cr.save();
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    cr.setSourceRGBA(r, g, b, 1);
    cr.setLineWidth(s.size);

    switch (s.type) {
    case 'pencil':
        pathPoints(cr, s.points);
        cr.stroke();
        break;
    case 'marker':
        cr.setSourceRGBA(r, g, b, 0.4);
        cr.setLineWidth(Math.max(8, s.size * 4));
        cr.setLineCap(Cairo.LineCap.SQUARE);
        pathPoints(cr, s.points);
        cr.stroke();
        break;
    case 'line':
        cr.moveTo(s.from.x + 0.5, s.from.y + 0.5);
        cr.lineTo(s.to.x + 0.5, s.to.y + 0.5);
        cr.stroke();
        break;
    case 'arrow':
        drawArrow(cr, s);
        break;
    case 'rect': {
        const rc = normalizeRect(s.from.x, s.from.y, s.to.x, s.to.y);
        if (s.filled) {
            cr.rectangle(rc.x, rc.y, rc.w, rc.h);
            cr.fill();
        } else {
            const o = s.size / 2;
            cr.rectangle(rc.x + o, rc.y + o, Math.max(1, rc.w - s.size), Math.max(1, rc.h - s.size));
            cr.stroke();
        }
        break;
    }
    case 'ellipse': {
        const rc = normalizeRect(s.from.x, s.from.y, s.to.x, s.to.y);
        const inset = s.filled ? 0 : s.size / 2;
        const rx = Math.max(0.5, rc.w / 2 - inset);
        const ry = Math.max(0.5, rc.h / 2 - inset);
        cr.save();
        cr.translate(rc.x + rc.w / 2, rc.y + rc.h / 2);
        cr.scale(rx, ry);
        cr.arc(0, 0, 1, 0, 2 * Math.PI);
        cr.restore();
        if (s.filled)
            cr.fill();
        else
            cr.stroke();
        break;
    }
    case 'pixelate':
        if (pixelate) {
            pixelate(cr, s);
        } else {
            const rc = normalizeRect(s.from.x, s.from.y, s.to.x, s.to.y);
            cr.setSourceRGBA(0.5, 0.5, 0.5, 0.6);
            cr.rectangle(rc.x, rc.y, rc.w, rc.h);
            cr.fill();
        }
        break;
    case 'counter':
        drawCounter(cr, s, r, g, b);
        break;
    case 'text':
        drawText(cr, s, editing);
        break;
    default:
        break;
    }
    cr.restore();
}

/** Dashed outline marking the selected drawing. `px` is one screen pixel. */
export function drawSelectionOutline(cr, s, px = 1) {
    const b = shapeBounds(s);
    if (!b)
        return;
    const m = 4.5 * px;
    cr.save();
    cr.setLineWidth(px);
    for (const [color, offset] of [[[0, 0, 0, 0.6], 0], [[1, 1, 1, 0.9], 4 * px]]) {
        cr.rectangle(b.x - m, b.y - m, b.w + 2 * m, b.h + 2 * m);
        cr.setSourceRGBA(...color);
        cr.setDash([4 * px, 4 * px], offset);
        cr.stroke();
    }
    cr.restore();
}

function pathPoints(cr, points) {
    if (points.length === 0)
        return;
    cr.moveTo(points[0].x + 0.5, points[0].y + 0.5);
    if (points.length === 1)
        cr.lineTo(points[0].x + 0.5, points[0].y + 0.5);
    for (let i = 1; i < points.length; i++)
        cr.lineTo(points[i].x + 0.5, points[i].y + 0.5);
}

function drawArrow(cr, s) {
    const dx = s.to.x - s.from.x;
    const dy = s.to.y - s.from.y;
    const len = Math.hypot(dx, dy);
    const headLen = Math.min(len, 10 + s.size * 3);
    const angle = Math.atan2(dy, dx);
    const tipX = s.to.x + 0.5;
    const tipY = s.to.y + 0.5;
    const baseX = tipX - Math.cos(angle) * headLen;
    const baseY = tipY - Math.sin(angle) * headLen;

    if (len > headLen) {
        cr.moveTo(s.from.x + 0.5, s.from.y + 0.5);
        cr.lineTo(baseX, baseY);
        cr.stroke();
    }
    const spread = 0.45;
    cr.moveTo(tipX, tipY);
    cr.lineTo(tipX - Math.cos(angle - spread) * headLen, tipY - Math.sin(angle - spread) * headLen);
    cr.lineTo(tipX - Math.cos(angle + spread) * headLen, tipY - Math.sin(angle + spread) * headLen);
    cr.closePath();
    cr.fill();
}

function drawCounter(cr, s, r, g, b) {
    const radius = 10 + s.size * 2;
    cr.arc(s.at.x, s.at.y, radius, 0, 2 * Math.PI);
    cr.fill();
    const layout = PangoCairo.create_layout(cr);
    layout.set_font_description(Pango.FontDescription.from_string(`Sans Bold ${Math.round(radius * 1.1)}px`));
    layout.set_text(`${s.n}`, -1);
    const [tw, th] = layout.get_pixel_size();
    // Contrast text against the fill colour.
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const c = lum > 0.6 ? 0 : 1;
    cr.setSourceRGBA(c, c, c, 1);
    cr.moveTo(s.at.x - tw / 2, s.at.y - th / 2);
    PangoCairo.show_layout(cr, layout);
}

function drawText(cr, s, editing) {
    const px = 12 + s.size * 3;
    const layout = PangoCairo.create_layout(cr);
    layout.set_font_description(Pango.FontDescription.from_string(`Sans Bold ${px}px`));
    layout.set_text(s.text.length > 0 ? s.text : ' ', -1);
    cr.moveTo(s.at.x, s.at.y);
    PangoCairo.show_layout(cr, layout);
    const [tw, th] = layout.get_pixel_size();
    s._bounds = {x: s.at.x, y: s.at.y, w: tw, h: th};

    if (editing) {
        const lines = s.text.split('\n');
        const lastLine = lines[lines.length - 1];
        const lineHeight = th / lines.length;
        const probe = PangoCairo.create_layout(cr);
        probe.set_font_description(layout.get_font_description());
        probe.set_text(lastLine, -1);
        const [lw] = lastLine.length > 0 ? probe.get_pixel_size() : [0];
        cr.setLineWidth(2);
        cr.moveTo(s.at.x + lw + 1, s.at.y + lineHeight * (lines.length - 1) + 2);
        cr.lineTo(s.at.x + lw + 1, s.at.y + lineHeight * lines.length - 2);
        cr.stroke();
        // Dashed frame so an empty text box is visible.
        cr.setSourceRGBA(1, 1, 1, 0.7);
        cr.setLineWidth(1);
        cr.setDash([4, 4], 0);
        cr.rectangle(s.at.x - 3.5, s.at.y - 3.5, Math.max(tw, lw) + 8, th + 8);
        cr.stroke();
    }
}
