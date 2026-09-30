// Flameshot GNOME video editor - exporting the annotated video with ffmpeg.
//
// Every drawing is rendered with the same Cairo code the editor uses into a
// small transparent PNG covering just its bounding box, and ffmpeg overlays
// it while `start <= t < end`. Pixelate regions are done by ffmpeg itself
// (crop, shrink, enlarge without smoothing) so they follow the moving video.
// Pixelate regions are applied first and the other drawings on top, in
// drawing order, which is also how the editor shows them.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Cairo from 'cairo';

import {drawShape, normalizeRect, pixelateBlock, shapeBounds} from '../drawing.js';
import {ANNOTATIONS_FILENAME, ORIGINAL_TRACK_TITLE} from './media.js';

export const FORMATS = {
    mp4: {label: 'MP4 video (H.264)', mime: 'video/mp4'},
    webm: {label: 'WebM video (VP9)', mime: 'video/webm'},
    gif: {label: 'Animated GIF', mime: 'image/gif'},
};

// GIFs get large quickly; limit their size and frame rate.
const GIF_MAX_WIDTH = 1280;
const GIF_FPS = 15;

// An "editable video" is a Matroska file that plays like a normal export (the
// first track has the drawings burned in) but also carries the untouched
// recording as a second track and the drawings as an attached JSON file, so
// the editor can open it again with everything still editable.
export const EDITABLE = {label: 'Editable video (Matroska)', ext: 'mkv'};
export const ANNOTATIONS_VERSION = 1;

export function formatForPath(path) {
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    return FORMATS[ext] ? ext : null;
}

function enableExpr(s, info, eps) {
    const parts = [];
    if (s.start > eps)
        parts.push(`gte(t,${(s.start - eps).toFixed(4)})`);
    if (s.end !== null && s.end < info.duration)
        parts.push(`lt(t,${(s.end - eps).toFixed(4)})`);
    return parts.length > 0 ? `:enable='${parts.join('*')}'` : '';
}

function clipRect(r, info) {
    const x1 = Math.max(0, Math.floor(r.x));
    const y1 = Math.max(0, Math.floor(r.y));
    const x2 = Math.min(info.width, Math.ceil(r.x + r.w));
    const y2 = Math.min(info.height, Math.ceil(r.y + r.h));
    if (x2 - x1 < 1 || y2 - y1 < 1)
        return null;
    return {x: x1, y: y1, w: x2 - x1, h: y2 - y1};
}

/** Renders one drawing into a PNG; returns its position, or null if off-screen. */
function renderShapePng(shape, info, file) {
    if (shape.type === 'text' && !shape._bounds) {
        // Text bounds are measured while drawing.
        const probe = new Cairo.ImageSurface(Cairo.Format.ARGB32, 1, 1);
        const cr = new Cairo.Context(probe);
        drawShape(cr, shape);
        cr.$dispose();
        probe.finish();
    }
    const b = shapeBounds(shape);
    if (!b)
        return null;
    const margin = Math.ceil(shape.size) + 4;
    const r = clipRect({x: b.x - margin, y: b.y - margin, w: b.w + margin * 2, h: b.h + margin * 2}, info);
    if (!r)
        return null;
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, r.w, r.h);
    const cr = new Cairo.Context(surface);
    cr.translate(-r.x, -r.y);
    drawShape(cr, shape);
    cr.$dispose();
    surface.flush();
    surface.writeToPNG(file);
    surface.finish();
    return r;
}

/**
 * Builds the ffmpeg command line. Returns {argv, tmpDir}; the caller deletes
 * tmpDir afterwards.
 */
function buildCommand(source, info, shapes, output, format, fps, editable) {
    const tmpDir = GLib.dir_make_tmp('flameshot-export-XXXXXX');
    const eps = 0.5 / fps;
    const inputs = ['-i', source];
    const filters = [`[0:${info.stream}]setpts=PTS-STARTPTS,fps=${fps},format=gbrp[v0]`];
    let last = 'v0';
    let n = 0;
    const next = () => `v${++n}`;

    const ordered = [
        ...shapes.filter(s => s.type === 'pixelate'),
        ...shapes.filter(s => s.type !== 'pixelate'),
    ];
    let inputIndex = 1;
    for (const shape of ordered) {
        if (shape.end !== null && shape.end <= shape.start)
            continue;
        const enable = enableExpr(shape, info, eps);
        if (shape.type === 'pixelate') {
            const r = clipRect(normalizeRect(shape.from.x, shape.from.y, shape.to.x, shape.to.y), info);
            if (!r)
                continue;
            const block = pixelateBlock(shape);
            const sw = Math.max(1, Math.ceil(r.w / block));
            const sh = Math.max(1, Math.ceil(r.h / block));
            const a = `a${n}`, p = `p${n}`, out = next();
            filters.push(`[${last}]split[${a}][${p}0]`);
            filters.push(`[${p}0]crop=${r.w}:${r.h}:${r.x}:${r.y},scale=${sw}:${sh}:flags=area,` +
                `scale=${sw * block}:${sh * block}:flags=neighbor,crop=${r.w}:${r.h}:0:0[${p}]`);
            filters.push(`[${a}][${p}]overlay=${r.x}:${r.y}:format=rgb${enable}[${out}]`);
            last = out;
        } else {
            const file = GLib.build_filenamev([tmpDir, `shape-${inputIndex}.png`]);
            const r = renderShapePng(shape, info, file);
            if (!r)
                continue;
            inputs.push('-i', file);
            const out = next();
            filters.push(`[${last}][${inputIndex}:v]overlay=${r.x}:${r.y}:format=rgb${enable}[${out}]`);
            inputIndex++;
            last = out;
        }
    }

    const argv = ['ffmpeg', '-nostdin', '-y', '-v', 'error', '-progress', 'pipe:1', ...inputs];
    if (editable) {
        const json = GLib.build_filenamev([tmpDir, ANNOTATIONS_FILENAME]);
        GLib.file_set_contents(json, JSON.stringify({
            version: ANNOTATIONS_VERSION,
            fps,
            shapes: shapes.map(({_bounds, ...rest}) => rest),
        }));
        filters.push(`[${last}]pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p[out]`);
        argv.push('-filter_complex', filters.join(';'),
            '-map', '[out]', '-map', `0:${info.stream}`,
            '-c:v:0', 'libx264', '-preset', 'veryfast', '-crf', '20',
            '-c:v:1', 'copy',
            '-metadata:s:v:0', 'title=Annotated',
            '-metadata:s:v:1', `title=${ORIGINAL_TRACK_TITLE}`,
            '-disposition:v:0', 'default', '-disposition:v:1', '0',
            '-attach', json,
            '-metadata:s:t:0', 'mimetype=application/json',
            '-metadata:s:t:0', `filename=${ANNOTATIONS_FILENAME}`,
            '-an', output);
        return {argv, tmpDir};
    }
    switch (format) {
    case 'gif': {
        const w = Math.min(GIF_MAX_WIDTH, info.width);
        filters.push(`[${last}]fps=${Math.min(GIF_FPS, fps)},scale=${w}:-2:flags=lanczos,split[g0][g1]`);
        filters.push('[g0]palettegen=stats_mode=diff[pal]');
        filters.push('[g1][pal]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle[out]');
        argv.push('-filter_complex', filters.join(';'), '-map', '[out]', '-loop', '0');
        break;
    }
    case 'webm':
        filters.push(`[${last}]format=yuv420p[out]`);
        argv.push('-filter_complex', filters.join(';'), '-map', '[out]',
            '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-row-mt', '1',
            '-deadline', 'good', '-cpu-used', '4');
        break;
    default:
        // H.264 in yuv420p needs even dimensions.
        filters.push(`[${last}]pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p[out]`);
        argv.push('-filter_complex', filters.join(';'), '-map', '[out]',
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-movflags', '+faststart');
        break;
    }
    argv.push('-an', output);
    return {argv, tmpDir};
}

function removeDir(path) {
    const dir = Gio.File.new_for_path(path);
    try {
        const children = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = children.next_file(null)))
            children.get_child(info).delete(null);
        dir.delete(null);
    } catch (e) {
        logError(e, 'Could not clean up export files');
    }
}

/**
 * Exports the video. `onProgress(fraction)` is called while encoding.
 * Resolves when done; rejects on failure or cancellation.
 */
export async function exportVideo({source, info, shapes, output, fps, onProgress, cancellable, editable = false}) {
    const format = formatForPath(output) ?? 'mp4';
    const {argv, tmpDir} = buildCommand(source, info, shapes, output, format, fps, editable);
    // Write to a temporary name so a failed export never leaves a broken file.
    const dot = output.lastIndexOf('.');
    const partial = `${output.slice(0, dot)}.part${output.slice(dot)}`;
    argv[argv.length - 1] = partial;

    try {
        const proc = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        const cancelId = cancellable?.connect(() => proc.force_exit()) ?? 0;

        const stdout = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()});
        const readLines = async () => {
            for (;;) {
                // eslint-disable-next-line no-await-in-loop
                const [line] = await new Promise((resolve, reject) => {
                    stdout.read_line_async(GLib.PRIORITY_DEFAULT, null, (s, res) => {
                        try {
                            resolve(s.read_line_finish_utf8(res));
                        } catch (e) {
                            reject(e);
                        }
                    });
                });
                if (line === null)
                    return;
                const m = line.match(/^out_time_us=(\d+)/);
                if (m && info.duration > 0)
                    onProgress?.(Math.min(1, Number(m[1]) / 1e6 / info.duration));
            }
        };
        const stderrStream = new Gio.DataInputStream({base_stream: proc.get_stderr_pipe()});
        const readErr = new Promise(resolve => {
            stderrStream.read_upto_async('\0', 1, GLib.PRIORITY_DEFAULT, null, (s, res) => {
                try {
                    resolve(s.read_upto_finish(res)[0] ?? '');
                } catch (e) {
                    resolve('');
                }
            });
        });

        await readLines();
        const errText = await readErr;
        await new Promise(resolve => proc.wait_async(null, () => resolve()));
        if (cancelId)
            cancellable.disconnect(cancelId);

        if (cancellable?.is_cancelled())
            throw new Error('Export cancelled');
        if (!proc.get_successful())
            throw new Error(errText.trim().split('\n').slice(-3).join('\n') || 'ffmpeg failed');

        Gio.File.new_for_path(partial).move(Gio.File.new_for_path(output),
            Gio.FileCopyFlags.OVERWRITE, null, null);
    } finally {
        removeDir(tmpDir);
        try {
            Gio.File.new_for_path(partial).delete(null);
        } catch (e) {
            // Already moved into place.
        }
    }
}
