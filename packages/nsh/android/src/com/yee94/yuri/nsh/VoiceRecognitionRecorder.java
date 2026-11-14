package com.yee94.yuri.nsh;

import android.Manifest;
import android.app.Activity;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;

import java.io.ByteArrayOutputStream;
import java.util.Arrays;

/**
 * Ported from VoiceRecognitionRecorder in ios/VoiceRecognitionBridge.swift. Capture runs on its own
 * thread away from the caller; only validated, incremental PCM16LE reaches the core.
 *
 * <p>AVAudioRecorder needs a protected temporary WAV file; AudioRecord yields PCM directly, so the
 * bounded session audio stays in memory (at most {@link VoiceRecognitionCore#MAXIMUM_BYTES}) and no
 * temporary artifact exists to protect or delete.
 */
public final class VoiceRecognitionRecorder implements VoiceRecognitionAudio {
    private final Activity activity;
    private final Object lock = new Object();
    private final ByteArrayOutputStream pcm = new ByteArrayOutputStream();
    private AudioRecord record;
    private Thread writer;
    private boolean stopRequested;
    private int consumed;

    public VoiceRecognitionRecorder(Activity activity) {
        this.activity = activity;
    }

    @Override public boolean permission() {
        if (VoiceRecognitionPermissions.granted(activity, Manifest.permission.RECORD_AUDIO)) return true;
        return VoiceRecognitionPermissions.request(activity, Manifest.permission.RECORD_AUDIO);
    }

    @Override public void start() throws VoiceRecognitionFailure {
        synchronized (lock) {
            if (record != null) throw VoiceRecognitionFailure.of("audio");
        }
        int minimum = AudioRecord.getMinBufferSize(VoiceRecognitionCore.SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (minimum <= 0) throw VoiceRecognitionFailure.of("audio");
        int buffer = Math.max(minimum, 16_000);
        AudioRecord created;
        try {
            created = new AudioRecord(MediaRecorder.AudioSource.MIC, VoiceRecognitionCore.SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, buffer * 2);
        } catch (RuntimeException error) {
            throw VoiceRecognitionFailure.of("audio");
        }
        if (created.getState() != AudioRecord.STATE_INITIALIZED) {
            created.release();
            throw VoiceRecognitionFailure.of("audio");
        }
        try {
            created.startRecording();
        } catch (RuntimeException error) {
            created.release();
            throw VoiceRecognitionFailure.of("audio");
        }
        if (created.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
            created.release();
            throw VoiceRecognitionFailure.of("audio");
        }
        Thread capture;
        synchronized (lock) {
            pcm.reset();
            consumed = 0;
            stopRequested = false;
            record = created;
            capture = new Thread(this::capture, "yuri-voice-capture");
            capture.setDaemon(true);
            writer = capture;
        }
        capture.start();
    }

    private void capture() {
        byte[] buffer = new byte[3_200];
        while (true) {
            AudioRecord source;
            synchronized (lock) {
                source = record;
                if (source == null || stopRequested) return;
            }
            int read;
            try {
                read = source.read(buffer, 0, buffer.length);
            } catch (RuntimeException error) {
                return;
            }
            if (read <= 0) {
                if (read == AudioRecord.ERROR_INVALID_OPERATION || read == AudioRecord.ERROR_BAD_VALUE) return;
                continue;
            }
            synchronized (lock) {
                if (record != source || stopRequested) return;
                if (pcm.size() + read > VoiceRecognitionCore.MAXIMUM_BYTES) return;
                pcm.write(buffer, 0, read);
            }
        }
    }

    @Override public byte[] readPCM() throws VoiceRecognitionFailure {
        synchronized (lock) {
            AudioRecord source = record;
            if (source == null && !stopRequested) throw VoiceRecognitionFailure.of("audio");
            int total = pcm.size();
            if (consumed > total) throw VoiceRecognitionFailure.of("audio");
            int available = total - consumed;
            if (available > VoiceRecognitionCore.MAXIMUM_BYTES - consumed) throw VoiceRecognitionFailure.of("limit");
            if (available % 2 != 0) {
                // A partial final sample is only tolerated while capture is still running.
                if (stopRequested) throw VoiceRecognitionFailure.of("audio");
                available -= available % 2;
            }
            if (available <= 0) return new byte[0];
            byte[] data = Arrays.copyOfRange(pcm.toByteArray(), consumed, consumed + available);
            consumed += data.length;
            return data;
        }
    }

    @Override public void stop() throws VoiceRecognitionFailure {
        Thread pending;
        synchronized (lock) {
            if (record == null) throw VoiceRecognitionFailure.of("audio");
            stopRequested = true;
            pending = writer;
            writer = null;
        }
        if (pending != null) {
            try {
                pending.join(1_500);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
            }
        }
        synchronized (lock) {
            release();
        }
    }

    @Override public void cancel() throws VoiceRecognitionFailure {
        Thread pending;
        synchronized (lock) {
            stopRequested = true;
            pending = writer;
            writer = null;
        }
        if (pending != null) {
            try {
                pending.join(1_000);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
            }
        }
        synchronized (lock) {
            release();
            pcm.reset();
            consumed = 0;
            stopRequested = false;
        }
    }

    private void release() {
        AudioRecord source = record;
        record = null;
        if (source == null) return;
        try {
            if (source.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) source.stop();
        } catch (RuntimeException ignored) {
            // Releasing below still frees the microphone.
        }
        try {
            source.release();
        } catch (RuntimeException ignored) {
            // The source may already be gone with the audio service.
        }
    }
}
