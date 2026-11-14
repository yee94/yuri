package com.yee94.yuri.nsh;

import android.app.Application;

/**
 * Process entry point. It owns no Host state: the NSH engine lives in
 * MainActivity's NshView, and every credential stays in ConnectionStore's
 * app-private storage. No global singleton is introduced, so a second
 * embedded NshView would still be independent.
 */
public final class YuriApplication extends Application {
}
