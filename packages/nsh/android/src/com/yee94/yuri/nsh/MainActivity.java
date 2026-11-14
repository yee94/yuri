package com.yee94.yuri.nsh;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.TextView;

import com.longbridge.nsh.NshView;

import java.util.Map;

/**
 * The Android shell: one NshView, the runtime, and every Host bridge
 * (iOS main.swift). UIKit navigation/tab appearance has no Android
 * counterpart: NSH renders its own chrome inside the view.
 */
public final class MainActivity extends Activity {
    private static final String TAG = "YuriNsh";
    private NshView nsh;
    private RuntimeBridge runtime;
    private NativeHandlers handlers;
    private String pendingLink;
    private boolean visible;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        nsh = new NshView(this);
        nsh.setErrorListener(this::showFailure);
        setContentView(nsh);
        handlers = new NativeHandlers(this, nsh);
        try {
            runtime = new RuntimeBridge(this, new ConnectionStore(this));
            runtime.install(nsh);
            runtime.setForeground(true);
            runtime.setOnInvalidate(() -> {
                if (handlers != null) handlers.invalidate();
            });
            handlers.install(runtime, runtime);
        } catch (Exception error) {
            Log.w(TAG, "runtime unavailable", error);
            handlers.install(null, null);
            showFailure("无法启动原生运行时");
        }
        if (!nsh.loadAssetBundle("nsh")) showFailure("未找到原生应用资源");
        receive(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        NotificationBridge.receiveTap(intent);
        receive(intent);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (handlers == null || !handlers.onRequestPermissionsResult(requestCode, permissions, grantResults)) {
            super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        visible = true;
        if (handlers != null) handlers.setForeground(true);
        if (runtime != null) {
            runtime.setForeground(true);
            new Thread(runtime::retryAuthorizationRetirements, "yuri-retirement").start();
        }
        confirmLinkIfReady();
    }

    @Override
    protected void onPause() {
        visible = false;
        if (handlers != null) handlers.setForeground(false);
        if (runtime != null) runtime.setForeground(false);
        super.onPause();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (handlers == null || !handlers.onActivityResult(requestCode, resultCode, data)) {
            super.onActivityResult(requestCode, resultCode, data);
        }
    }

    @Override
    protected void onDestroy() {
        if (handlers != null) handlers.shutdown();
        if (runtime != null) runtime.stop();
        if (nsh != null) nsh.destroy();
        super.onDestroy();
    }

    private void showFailure(String message) {
        View existing = findViewById(android.R.id.content);
        if (!(existing instanceof ViewGroup)) return;
        ViewGroup root = (ViewGroup) existing;
        TextView text = new TextView(this);
        text.setText(message == null ? "" : message);
        text.setTextColor(0xFFB3261E);
        text.setBackgroundColor(0xFFFAFAFA);
        int padding = NativeHandlers.dp(nsh, 24);
        text.setPadding(padding, padding, padding, padding);
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        root.addView(text, params);
    }

    /** yuri://connect — buffered until visible, then confirmed before redemption. */
    private void receive(Intent intent) {
        if (intent == null || intent.getData() == null) return;
        Uri url = intent.getData();
        if (!"yuri".equals(url.getScheme()) || !"connect".equals(url.getHost())
            || url.toString().length() > 16384) {
            return;
        }
        pendingLink = url.toString();
        confirmLinkIfReady();
    }

    private void confirmLinkIfReady() {
        if (!visible || pendingLink == null || isFinishing()) return;
        String link = pendingLink;
        pendingLink = null;
        new AlertDialog.Builder(this)
            .setTitle("导入配对链接？")
            .setMessage("请确认链接来自你的 Yuri Host。导入后仍需在连接页点击连接，才会兑换授权。")
            .setNegativeButton("取消", (dialog, which) -> confirmLinkIfReady())
            .setPositiveButton("导入", (dialog, which) -> {
                nsh.send("connection.link", Map.of("url", link));
                confirmLinkIfReady();
            })
            .show();
    }
}
