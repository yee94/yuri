package com.longbridge.nsh;

/** Compile-only stand-in for the `nsh.aar` component contract. Never shipped. */
public interface NshComponent {
    android.view.View view();

    void setProp(String name, Object value);

    default void destroy() {}

    interface Factory {
        NshComponent create(NshComponentContext context);
    }
}
