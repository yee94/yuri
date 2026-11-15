package com.yee94.yuri.nsh;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffColorFilter;
import android.graphics.Rect;
import android.text.Editable;
import android.text.InputType;
import android.text.Spanned;
import android.text.TextWatcher;
import android.text.style.ForegroundColorSpan;
import android.text.style.ReplacementSpan;
import android.util.Base64;
import android.view.View;
import android.view.inputmethod.BaseInputConnection;
import android.widget.EditText;

import com.longbridge.nsh.NshComponent;
import com.longbridge.nsh.NshComponentContext;
import com.longbridge.nsh.NshView;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Inline reference chips over the real Input (iOS ComposerInlineChips.swift).
 *
 * The Input remains the only editor: its logical text, selection, IME,
 * spellcheck, metadata and draft are untouched. A ReplacementSpan replaces
 * each durable reference's stored `@` trigger with its icon and a
 * ForegroundColorSpan tints the label; no character is inserted or moved.
 */
public final class ComposerInlineChipBridge implements NativeHandlers.Bridge {
    private final Activity activity;
    private final HostLeaseProvider leases;
    private final NshView view;

    public ComposerInlineChipBridge(Activity activity, HostLeaseProvider leases, NshView view) {
        this.activity = activity;
        this.leases = leases;
        this.view = view;
    }

    @Override
    public void install() {
        view.registerComponent("yuri.composer.inlineChips", context -> new Owner(activity, context));
    }

    @Override
    public void invalidate() {}

    private static final class Owner implements NshComponent {
        private final NativeHandlers.RegistrationView registration;
        private final NshComponentContext context;
        private ComposerInlineChipPlan.Config config;
        private EditText editor;
        private TextWatcher watcher;
        private final List<ChipSpans> applied = new ArrayList<>();
        private boolean scheduled, removed, retried;

        Owner(Activity activity, NshComponentContext context) {
            this.context = context;
            this.registration = new NativeHandlers.RegistrationView(activity);
            this.registration.changed = this::schedule;
        }

        @Override
        public View view() {
            return registration;
        }

        @Override
        public void setProp(String name, Object value) {
            if (!"config".equals(name) || removed) return;
            config = ComposerInlineChipPlan.parse(value);
            retried = false;
            if (config == null) clear();
            schedule();
        }

        @Override
        public void command(String name, Object args) {
            if (!"retire".equals(name) || removed) return;
            removed = true;
            config = null;
            clear();
            detach();
        }

        private void schedule() {
            if (removed || scheduled) return;
            scheduled = true;
            registration.post(() -> {
                scheduled = false;
                reconcile();
            });
        }

        private void retry() {
            if (retried || removed) return;
            retried = true;
            registration.postDelayed(this::schedule, 16);
        }

        private void reconcile() {
            if (removed) return;
            if (editor == null || editor.getWindowToken() == null) {
                clear();
                editor = null;
                EditText found = resolve();
                if (found == null) {
                    retry();
                    return;
                }
                editor = found;
                attach(found);
            }
            ComposerInlineChipPlan.Config current = config;
            if (current == null || editor == null) return;
            Editable text = editor.getText();
            if (text == null || text.length() != current.textLength) {
                retry();
                return;
            }
            if (BaseInputConnection.getComposingSpanStart(text) >= 0) return;
            retried = false;
            List<ComposerInlineChipPlan.Chip> chips = new ArrayList<>();
            for (ComposerInlineChipPlan.Chip chip : current.chips) {
                if (chip.end <= text.length() && text.charAt(chip.start) == '@') chips.add(chip);
            }
            if (chips.isEmpty() && applied.isEmpty()) return;
            if (same(chips, text)) return;
            clearSpans(text);
            for (ComposerInlineChipPlan.Chip chip : chips) {
                int color = Color.parseColor(chip.color);
                ChipIconSpan icon = new ChipIconSpan(icon(chip.icon, color, editor.getTextSize()), editor.getTextSize());
                ForegroundColorSpan label = new ForegroundColorSpan(color);
                text.setSpan(icon, chip.start, chip.start + 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                if (chip.end > chip.start + 1) text.setSpan(label, chip.start + 1, chip.end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                applied.add(new ChipSpans(chip.start, chip.color, icon, label));
            }
            editor.invalidate();
        }

        private boolean same(List<ComposerInlineChipPlan.Chip> chips, Editable text) {
            if (chips.size() != applied.size()) return false;
            for (int index = 0; index < chips.size(); index++) {
                ComposerInlineChipPlan.Chip chip = chips.get(index);
                ChipSpans spans = applied.get(index);
                if (spans.start != chip.start || !spans.color.equals(chip.color)) return false;
                if (text.getSpanStart(spans.icon) != chip.start) return false;
                if (chip.end > chip.start + 1 && text.getSpanStart(spans.label) != chip.start + 1) return false;
            }
            return true;
        }

        private void attach(EditText target) {
            detach();
            watcher = new TextWatcher() {
                @Override public void beforeTextChanged(CharSequence value, int start, int count, int after) {}
                @Override public void onTextChanged(CharSequence value, int start, int before, int count) {}
                @Override public void afterTextChanged(Editable value) { schedule(); }
            };
            target.addTextChangedListener(watcher);
        }

        private void detach() {
            if (editor != null && watcher != null) editor.removeTextChangedListener(watcher);
            watcher = null;
        }

        private void clear() {
            if (editor != null) {
                Editable text = editor.getText();
                if (text != null) clearSpans(text);
                editor.invalidate();
            }
            applied.clear();
        }

        private void clearSpans(Editable text) {
            for (ChipSpans spans : applied) {
                text.removeSpan(spans.icon);
                text.removeSpan(spans.label);
            }
            applied.clear();
        }

        /** Structural resolution; Android exposes no accessibility identifier for the container. */
        private EditText resolve() {
            View host = NativeHandlers.hostOf(registration);
            View owner = NativeHandlers.ownerOf(registration);
            if (host == null || owner == null || registration.getWindowToken() == null) return null;
            List<View> editors = new ArrayList<>();
            NativeHandlers.collect(owner, host, EditText.class, editors);
            if (editors.size() != 1) return null;
            EditText editor = (EditText) editors.get(0);
            View container = editor.getParent() instanceof View ? (View) editor.getParent() : null;
            if (container == null || container.getParent() != owner) return null;
            if (editor.getWindowToken() != registration.getWindowToken()) return null;
            boolean multiline = (editor.getInputType() & InputType.TYPE_TEXT_FLAG_MULTI_LINE) != 0;
            return multiline ? editor : null;
        }
    }

    private static final class ChipSpans {
        final int start;
        final String color;
        final ChipIconSpan icon;
        final ForegroundColorSpan label;

        ChipSpans(int start, String color, ChipIconSpan icon, ForegroundColorSpan label) {
            this.start = start;
            this.color = color;
            this.icon = icon;
            this.label = label;
        }
    }

    private static final class ChipIconSpan extends ReplacementSpan {
        private final Bitmap bitmap;
        private final int size;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);

        ChipIconSpan(Bitmap bitmap, float textSize) {
            this.bitmap = bitmap;
            this.size = Math.max(1, Math.round(textSize));
        }

        @Override
        public int getSize(Paint base, CharSequence text, int start, int end, Paint.FontMetricsInt metrics) {
            if (metrics != null) {
                Paint.FontMetricsInt source = base.getFontMetricsInt();
                metrics.ascent = source.ascent;
                metrics.descent = source.descent;
                metrics.top = source.top;
                metrics.bottom = source.bottom;
                metrics.leading = source.leading;
            }
            return Math.round(size * 1.2f);
        }

        @Override
        public void draw(Canvas canvas, CharSequence text, int start, int end, float x, int top, int y, int bottom, Paint base) {
            if (bitmap == null) return;
            Paint.FontMetricsInt metrics = base.getFontMetricsInt();
            int iconTop = y + metrics.ascent + (metrics.descent - metrics.ascent - size) / 2;
            canvas.drawBitmap(bitmap, null, new Rect(Math.round(x), iconTop, Math.round(x) + size, iconTop + size), paint);
        }
    }

    private static final Map<String, Bitmap> BASE = new HashMap<>();
    private static final Map<String, Bitmap> TINTED = new HashMap<>();

    private static Bitmap icon(String kind, int color, float textSize) {
        int size = Math.max(1, Math.round(textSize));
        String key = kind + "|" + color + "|" + size;
        Bitmap cached = TINTED.get(key);
        if (cached != null) return cached;
        Bitmap base = BASE.get(kind);
        if (base == null) {
            String encoded = ComposerInlineChipIcons.BASE64.get(kind);
            if (encoded == null) return null;
            byte[] data = Base64.decode(encoded, Base64.DEFAULT);
            base = BitmapFactory.decodeByteArray(data, 0, data.length);
            if (base == null) return null;
            BASE.put(kind, base);
        }
        Bitmap tinted = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(tinted);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
        paint.setColorFilter(new PorterDuffColorFilter(color, PorterDuff.Mode.SRC_IN));
        canvas.drawBitmap(base, null, new Rect(0, 0, size, size), paint);
        TINTED.put(key, tinted);
        return tinted;
    }
}
