package com.yee94.yuri.nsh;

import android.app.Activity;
import android.content.Context;
import android.content.res.Configuration;
import android.view.View;
import android.widget.CalendarView;
import android.widget.FrameLayout;

import com.longbridge.nsh.NshComponent;
import com.longbridge.nsh.NshComponentContext;
import com.longbridge.nsh.NshView;

import java.text.ParsePosition;
import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Date;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;

/**
 * Inline single-date calendar, the Android counterpart of the iOS inline
 * UIDatePicker (DatePicker.swift). It owns one date only; range, custom
 * disabled days and time editing stay with the TSX DatePicker, which never
 * mounts this component on Android.
 */
public final class DatePickerBridge implements NativeHandlers.Bridge {
    private final Activity activity;
    private final HostLeaseProvider leases;
    private final NshView view;

    public DatePickerBridge(Activity activity, HostLeaseProvider leases, NshView view) {
        this.activity = activity;
        this.leases = leases;
        this.view = view;
    }

    @Override
    public void install() {
        view.registerComponent("yuri.datePicker", context -> new Owner(activity, context));
    }

    @Override
    public void invalidate() {}

    private static final class Configuration_ {
        String localeIdentifier = Locale.getDefault().toString();
        Integer firstDayOfWeek;
        String minimumDate;
        String maximumDate;

        boolean set(String name, Object value) {
            boolean cleared = value == null;
            switch (name) {
                case "firstDayOfWeek":
                    if (cleared) {
                        firstDayOfWeek = null;
                        return true;
                    }
                    if (!(value instanceof Number)) return false;
                    double day = ((Number) value).doubleValue();
                    if (day != Math.rint(day) || day < 0 || day > 6) return false;
                    firstDayOfWeek = (int) day;
                    return true;
                case "localeIdentifier":
                    if (cleared) {
                        localeIdentifier = Locale.getDefault().toString();
                        return true;
                    }
                    if (!(value instanceof String) || ((String) value).isEmpty()
                        || ((String) value).getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 128) {
                        return false;
                    }
                    localeIdentifier = (String) value;
                    return true;
                case "minimumDate":
                case "maximumDate":
                    String text;
                    if (cleared) text = null;
                    else {
                        if (!(value instanceof String) || Owner.date((String) value) == null) return false;
                        text = (String) value;
                    }
                    if ("minimumDate".equals(name)) minimumDate = text;
                    else maximumDate = text;
                    return true;
                default:
                    return false;
            }
        }
    }

    private static final class Owner implements NshComponent {
        private final Context base;
        private final NshComponentContext context;
        private final FrameLayout container;
        private final Configuration_ configuration = new Configuration_();
        private CalendarView calendar;
        private String selected;
        private String appliedLocale;
        private boolean applying;

        Owner(Activity activity, NshComponentContext context) {
            this.context = context;
            this.base = activity;
            this.container = new FrameLayout(activity);
        }

        @Override
        public View view() {
            return container;
        }

        @Override
        public void setProp(String name, Object value) {
            if ("value".equals(name)) {
                if (!(value instanceof String) || date((String) value) == null) return;
                selected = (String) value;
            } else if (!configuration.set(name, value)) {
                return;
            }
            rebuild();
        }

        private void rebuild() {
            String locale = configuration.localeIdentifier;
            if (calendar == null || !locale.equals(appliedLocale)) {
                appliedLocale = locale;
                Configuration config = new Configuration(base.getResources().getConfiguration());
                config.setLocale(Locale.forLanguageTag(locale.replace('_', '-')));
                Context localized = base.createConfigurationContext(config);
                CalendarView next = new CalendarView(localized);
                next.setOnDateChangeListener((widget, year, month, day) -> {
                    if (applying) return;
                    selected = format(year, month + 1, day);
                    context.emit("change", Map.of("value", selected));
                });
                container.removeAllViews();
                container.addView(next, new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
                calendar = next;
            }
            if (configuration.firstDayOfWeek != null) {
                calendar.setFirstDayOfWeek(configuration.firstDayOfWeek + 1);
            }
            Date minimum = configuration.minimumDate == null ? null : date(configuration.minimumDate);
            Date maximum = configuration.maximumDate == null ? null : date(configuration.maximumDate);
            calendar.setMinDate(minimum == null ? Long.MIN_VALUE : minimum.getTime());
            calendar.setMaxDate(maximum == null ? Long.MAX_VALUE : maximum.getTime());
            if (selected != null) {
                Date value = date(selected);
                if (value != null) {
                    applying = true;
                    try {
                        calendar.setDate(value.getTime(), false, true);
                    } finally {
                        applying = false;
                    }
                }
            }
        }

        private static String format(int year, int month, int day) {
            Calendar calendar = Calendar.getInstance();
            calendar.clear();
            calendar.set(year, month - 1, day, 12, 0, 0);
            return new SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).format(calendar.getTime());
        }

        /** Strict yyyy-MM-dd in the current timezone, round-tripped. */
        static Date date(String text) {
            SimpleDateFormat formatter = new SimpleDateFormat("yyyy-MM-dd", Locale.ROOT);
            formatter.setLenient(false);
            formatter.setTimeZone(TimeZone.getDefault());
            ParsePosition position = new ParsePosition(0);
            Date value = formatter.parse(text, position);
            if (value == null || position.getIndex() != text.length()) return null;
            return formatter.format(value).equals(text) ? value : null;
        }
    }
}
