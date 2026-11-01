package com.yuri.app;

import android.content.pm.ActivityInfo;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "YuriOrientation")
public class YuriOrientationPlugin extends Plugin {
    @PluginMethod
    public void lock(PluginCall call) {
        boolean landscape = "landscape".equals(call.getString("orientation"));
        getActivity().runOnUiThread(() -> {
            getActivity().setRequestedOrientation(landscape
                ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE : ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
            call.resolve();
        });
    }

    @Override protected void handleOnDestroy() {
        getActivity().setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
    }
}
