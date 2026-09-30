// Flameshot GNOME video editor - reading videos with ffmpeg.
//
// GTK's own media backend is an optional package, so playback is driven by
// an ffmpeg process that decodes raw RGB frames at a constant frame rate into
// a pipe. Seeking restarts the process at the new position, which makes
// seeking frame-accurate. Screencasts are recorded with a variable frame
// rate (a frame only when something changed); the constant-rate output fills
// the gaps, so frame k of a decoder started at t is at time t + k / fps.

import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(Gio.BufferedInputStream.prototype, 'fill_async', 'fill_finish');

// Largest preview frame; bigger videos are scaled down while decoding.
const MAX_PREVIEW_W = 1920;
const MAX_PREVIEW_H = 1200;

export function haveFfmpeg() {
    return GLib.find_program_in_path('ffmpeg') !== null && GLib.find_program_in_path('ffprobe') !== null;
}

// Editable videos (see export.js) carry the untouched recording as a second
// video track with this title, and the drawings as an attached JSON file.
export const ORIGINAL_TRACK_TITLE = 'Flameshot original';
export const ANNOTATIONS_FILENAME = 'flameshot-annotations.json';

/**
 * Width, height and duration (seconds) of the video to edit, plus `stream`,
 * the ffmpeg stream specifier to read it from (the original track of an
 * editable video, otherwise the first video track), and `hasAnnotations`.
 */
export async function probe(path) {
    const proc = Gio.Subprocess.new([
        'ffprobe', '-v', 'error',
        '-show_entries', 'stream=codec_type,width,height,duration:stream_tags=title,filename:format=duration',
        '-of', 'json', path,
    ], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    const [stdout, stderr] = await proc.communicate_utf8_async(null, null);
    if (!proc.get_successful())
        throw new Error(stderr.trim().split('\n').pop() || 'ffprobe failed');
    const info = JSON.parse(stdout);
    const streams = info.streams ?? [];
    const videos = streams.filter(s => s.codec_type === 'video');
    let index = videos.findIndex(s => s.tags?.title === ORIGINAL_TRACK_TITLE);
    if (index < 0)
        index = 0;
    const stream = videos[index];
    if (!stream)
        throw new Error('The file contains no video');
    const hasAnnotations = streams.some(s =>
        s.codec_type === 'attachment' && s.tags?.filename === ANNOTATIONS_FILENAME);
    const spec = `v:${index}`;
    let duration = parseFloat(info.format?.duration ?? stream.duration);
    if (!Number.isFinite(duration) || duration <= 0)
        duration = await measureDuration(path, spec);
    return {width: stream.width, height: stream.height, duration, stream: spec, hasAnnotations};
}

/** Reads the drawings embedded in an editable video. */
export async function readAnnotations(path) {
    const tmpDir = GLib.dir_make_tmp('flameshot-annotations-XXXXXX');
    const json = GLib.build_filenamev([tmpDir, ANNOTATIONS_FILENAME]);
    try {
        // Only the attachment is wanted: -t 0 stops before decoding any video.
        const proc = Gio.Subprocess.new([
            'ffmpeg', '-nostdin', '-v', 'error', '-y', `-dump_attachment:m:filename:${ANNOTATIONS_FILENAME}`, json,
            '-i', path, '-t', '0', '-f', 'null', '-',
        ], Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        await new Promise(resolve => proc.wait_async(null, () => resolve()));
        const [, data] = GLib.file_get_contents(json);
        return JSON.parse(new TextDecoder().decode(data));
    } finally {
        GLib.unlink(json);
        GLib.rmdir(tmpDir);
    }
}

/** Decodes the whole file to find its length (files without a duration header). */
async function measureDuration(path, spec) {
    const proc = Gio.Subprocess.new([
        'ffmpeg', '-nostdin', '-v', 'error', '-i', path, '-map', `0:${spec}`,
        '-f', 'null', '-progress', 'pipe:1', '-',
    ], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    const [stdout] = await proc.communicate_utf8_async(null, null);
    const matches = [...stdout.matchAll(/out_time_us=(\d+)/g)];
    const us = matches.length > 0 ? Number(matches[matches.length - 1][1]) : 0;
    if (us <= 0)
        throw new Error('Could not determine the length of the video');
    return us / 1e6;
}

/** Size the preview frames are decoded at (even numbers, aspect kept). */
export function previewSize(info) {
    const scale = Math.min(1, MAX_PREVIEW_W / info.width, MAX_PREVIEW_H / info.height);
    return {
        width: Math.max(2, Math.round(info.width * scale / 2) * 2),
        height: Math.max(2, Math.round(info.height * scale / 2) * 2),
    };
}

/**
 * One ffmpeg process producing frames from `start` onwards. Call next()
 * repeatedly; it resolves to {texture, time} or null at the end.
 */
export class Decoder {
    constructor(path, info, fps, start) {
        const {width, height} = previewSize(info);
        this.width = width;
        this.height = height;
        this.fps = fps;
        this.start = start;
        this._index = 0;
        this._frameSize = width * height * 3;
        this._cancellable = new Gio.Cancellable();

        this._proc = Gio.Subprocess.new([
            'ffmpeg', '-nostdin', '-v', 'error',
            '-ss', start.toFixed(6), '-i', path, '-map', `0:${info.stream}`,
            '-vf', `fps=${fps},scale=${width}:${height}:flags=bilinear`,
            '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
        ], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        this._stream = new Gio.BufferedInputStream({
            base_stream: this._proc.get_stdout_pipe(),
            buffer_size: this._frameSize,
        });
    }

    /** Time of the frame the next call to next() returns. */
    get nextTime() {
        return this.start + this._index / this.fps;
    }

    async next() {
        if (!this._stream)
            return null;
        try {
            while (this._stream.get_available() < this._frameSize) {
                const want = this._frameSize - this._stream.get_available();
                // eslint-disable-next-line no-await-in-loop
                const n = await this._stream.fill_async(want, GLib.PRIORITY_DEFAULT, this._cancellable);
                if (n <= 0)
                    return null;
            }
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return null;
            throw e;
        }
        if (!this._stream)
            return null;
        const bytes = this._stream.read_bytes(this._frameSize, null);
        const texture = Gdk.MemoryTexture.new(this.width, this.height,
            Gdk.MemoryFormat.R8G8B8, bytes, this.width * 3);
        const time = this.nextTime;
        this._index++;
        return {texture, time};
    }

    close() {
        this._cancellable.cancel();
        this._proc?.force_exit();
        this._proc = null;
        this._stream = null;
    }
}
